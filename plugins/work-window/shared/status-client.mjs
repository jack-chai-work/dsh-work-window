/**
 * status-client.mjs — 浏览器半区自包含的工作时段判定（零依赖、纯函数）。
 *
 * 为什么单独一份：浏览器 bundle 不能 import Harness 客户端包，也不能跨包 import 工作区文件，
 * 所以这份实现会被 `tools/build-client.mjs` 原样内联进 `client.js`；Host 半区使用
 * `shared/holiday.js`（同一判定规则的完整参考实现）。两者的一致性由
 * `tools/parity.test.mjs` 在构建前做逐点对比（见该文件）。
 *
 * 判定规则与 Host 完全一致：
 *   1. 非工作日（周末 / 法定节假日；调休补班日算工作日）→ working；
 *   2. 工作日落在暂停区间 [start, end) → paused；
 *   3. 其余 → working。
 * 时区一律通过 Intl 按 IANA 时区计算，不依赖浏览器本地时区。
 */

export const DEFAULT_TIME_ZONE = 'Asia/Hong_Kong';
export const DEFAULT_PAUSE_WINDOWS = Object.freeze([
  Object.freeze({ start: '09:00', end: '12:00' }),
  Object.freeze({ start: '14:00', end: '18:00' }),
]);
export const CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_NEXT_CHANGE_DAYS = 10;

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u;
const MONTH_DAY_RE = /^(\d{2})-(\d{2})$/u;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function pad2(value) {
  return String(value).padStart(2, '0');
}

function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

const formatters = new Map();
function partsFormatter(timeZone) {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** 某时刻在目标时区的墙钟分量。 */
export function getZonedParts(dateOrMs, timeZone = DEFAULT_TIME_ZONE) {
  const date = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  const bag = Object.create(null);
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  const year = Number(bag.year);
  const month = Number(bag.month);
  const day = Number(bag.day);
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  const minute = Number(bag.minute);
  const second = Number(bag.second);
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) {
    throw new RangeError(`Intl 无法解析时区 ${JSON.stringify(timeZone)} 的本地时间`);
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond: date.getUTCMilliseconds(),
    weekday: weekdayOf(year, month, day),
  };
}

function offsetMsAt(epochMs, timeZone) {
  const parts = getZonedParts(epochMs, timeZone);
  const wallClockAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const utcSecond = Math.floor(epochMs / 1000) * 1000;
  return wallClockAsUtc - utcSecond;
}

/** 目标时区的墙钟时间 → UTC 毫秒（偏移量迭代求解，可处理夏令时）。 */
export function zonedWallTimeToUtcMs(parts, timeZone = DEFAULT_TIME_ZONE) {
  const { year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 } = parts;
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let guess = wallClockAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = wallClockAsUtc - offsetMsAt(guess, timeZone);
    if (next === guess) return guess;
    guess = next;
  }
  return guess;
}

/** 本地日历日加减天数。 */
export function addDaysToParts(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

export function dateKeyOf(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function parseClock(text, label) {
  const match = typeof text === 'string' ? CLOCK_RE.exec(text.trim()) : null;
  if (match === null) throw new RangeError(`${label}: 无效的时刻 ${JSON.stringify(text)}（应为 HH:MM 或 HH:MM:SS）`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`${label}: 时刻越界 ${JSON.stringify(text)}`);
  }
  return { hour, minute, second, text: `${pad2(hour)}:${pad2(minute)}${second === 0 ? '' : `:${pad2(second)}`}` };
}

/** 解析暂停区间：支持 "HH:MM-HH:MM" 字符串或 {start,end} 对象。 */
export function parseWindows(input = DEFAULT_PAUSE_WINDOWS) {
  if (!Array.isArray(input)) throw new TypeError('pauseWindows 必须是数组');
  return input.map((window, index) => {
    const label = `pauseWindows[${index}]`;
    let start;
    let end;
    if (typeof window === 'string') {
      const match = /^(.+?)\s*[-~]\s*(.+)$/u.exec(window.trim());
      if (match === null) throw new RangeError(`${label}: 需要 "HH:MM-HH:MM" 字符串`);
      start = parseClock(match[1], `${label}.start`);
      end = parseClock(match[2], `${label}.end`);
    } else if (window !== null && typeof window === 'object') {
      start = parseClock(window.start, `${label}.start`);
      end = parseClock(window.end, `${label}.end`);
    } else {
      throw new TypeError(`${label}: 必须是字符串或 {start,end}`);
    }
    if (start.text === end.text) throw new RangeError(`${label}: start 与 end 不能相同`);
    return {
      start: start.text,
      end: end.text,
      startHour: start.hour,
      startMinute: start.minute,
      startSecond: start.second,
      endHour: end.hour,
      endMinute: end.minute,
      endSecond: end.second,
      startSeconds: start.hour * 3600 + start.minute * 60 + start.second,
      endSeconds: end.hour * 3600 + end.minute * 60 + end.second,
      crossesMidnight: start.hour * 3600 + start.minute * 60 + start.second > end.hour * 3600 + end.minute * 60 + end.second,
    };
  });
}

export function formatWindow(window) {
  if (typeof window === 'string') return window;
  const [parsed] = parseWindows([window]);
  return `${parsed.start}-${parsed.end}`;
}

function isWithinWindow(secondsOfDay, window) {
  if (window.crossesMidnight) return secondsOfDay >= window.startSeconds || secondsOfDay < window.endSeconds;
  return secondsOfDay >= window.startSeconds && secondsOfDay < window.endSeconds;
}

function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') throw new TypeError('节假日条目不是对象');
  let type;
  if (raw.type === 'holiday' || raw.type === 'workday') type = raw.type;
  else if (typeof raw.holiday === 'boolean') type = raw.holiday ? 'holiday' : 'workday';
  else throw new TypeError('节假日条目缺少 type/holiday 字段');
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    type,
    isHoliday: type === 'holiday',
    wage: typeof raw.wage === 'number' ? raw.wage : null,
    date: typeof raw.date === 'string' && DATE_ONLY_RE.test(raw.date) ? raw.date : null,
    target: typeof raw.target === 'string' ? raw.target : null,
    after: typeof raw.after === 'boolean' ? raw.after : null,
    rest: typeof raw.rest === 'number' ? raw.rest : null,
  };
}

/** 缓存数组/对象 → 'YYYY-MM-DD' 索引。 */
export function buildHolidayIndex(caches) {
  const byDate = new Map();
  if (caches === null || caches === undefined) return byDate;
  const visit = (cache) => {
    if (cache === null || typeof cache !== 'object' || cache.holidays === null || typeof cache.holidays !== 'object') {
      throw new TypeError('节假日缓存缺少 holidays 对象');
    }
    const year = Number.isInteger(cache.year) ? cache.year : null;
    for (const [key, raw] of Object.entries(cache.holidays)) {
      const entry = normalizeEntry(raw);
      let fullKey;
      if (MONTH_DAY_RE.test(key)) {
        if (year === null) throw new TypeError(`节假日键 ${key} 缺少年份`);
        fullKey = `${year}-${key}`;
      } else if (DATE_ONLY_RE.test(key)) {
        fullKey = key;
      } else {
        throw new TypeError(`无效的节假日键 ${JSON.stringify(key)}`);
      }
      byDate.set(fullKey, { ...entry, date: fullKey });
    }
  };
  if (Array.isArray(caches)) caches.forEach(visit);
  else if (caches instanceof Map) {
    for (const [key, raw] of caches.entries()) byDate.set(String(key), { ...normalizeEntry(raw), date: String(key) });
  } else visit(caches);
  return byDate;
}

function evaluateDayWithIndex(parts, index) {
  const weekend = parts.weekday === 0 || parts.weekday === 6;
  const entry = index.get(dateKeyOf(parts)) ?? null;
  if (entry === null) return { workday: !weekend, weekend, type: null, holidayName: null, source: 'weekend' };
  return {
    workday: entry.type === 'workday',
    weekend,
    type: entry.type,
    holidayName: entry.name || null,
    source: 'api',
  };
}

function computeStateAt(epochMs, ctx) {
  const parts = getZonedParts(epochMs, ctx.timeZone);
  const dayInfo = evaluateDayWithIndex(parts, ctx.index);
  const secondsOfDay = parts.hour * 3600 + parts.minute * 60 + parts.second + parts.millisecond / 1000;
  if (!dayInfo.workday) {
    const reason = dayInfo.type === 'holiday' ? 'holiday' : 'weekend';
    return { state: 'working', reason, dayInfo, parts, pauseWindow: null };
  }
  const active = ctx.windows.find((window) => isWithinWindow(secondsOfDay, window)) ?? null;
  if (active !== null) {
    return { state: 'paused', reason: 'window', dayInfo, parts, pauseWindow: { start: active.start, end: active.end } };
  }
  return { state: 'working', reason: 'outside', dayInfo, parts, pauseWindow: null };
}

function findNextChange(nowMs, ctx, currentState) {
  if (ctx.windows.length === 0) return null;
  const nowParts = getZonedParts(nowMs, ctx.timeZone);
  const seen = new Set();
  const candidates = [];
  const push = (ms) => {
    if (!seen.has(ms)) {
      seen.add(ms);
      candidates.push(ms);
    }
  };
  for (let offset = -2; offset <= MAX_NEXT_CHANGE_DAYS; offset += 1) {
    const dayParts = addDaysToParts(nowParts, offset);
    push(zonedWallTimeToUtcMs({ ...dayParts, hour: 0, minute: 0, second: 0 }, ctx.timeZone));
    for (const window of ctx.windows) {
      push(zonedWallTimeToUtcMs({ ...dayParts, hour: window.startHour, minute: window.startMinute, second: window.startSecond }, ctx.timeZone));
      push(zonedWallTimeToUtcMs({ ...dayParts, hour: window.endHour, minute: window.endMinute, second: window.endSecond }, ctx.timeZone));
    }
  }
  candidates.sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (candidate <= nowMs) continue;
    if (computeStateAt(candidate, ctx).state !== currentState) return candidate;
  }
  return null;
}

/**
 * 核心判定：与 Host `statusAt` 字段同名同义（这里只保留 UI 需要的字段）。
 * @param {Date|number|string} [now]
 * @param {{timeZone?:string, pauseWindows?:unknown, holidays?:unknown}} [options]
 */
export function statusAt(now, options = {}) {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const windows = parseWindows(options.pauseWindows ?? DEFAULT_PAUSE_WINDOWS);
  const index = buildHolidayIndex(options.holidays ?? null);
  const nowDate = now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new RangeError('statusAt: now 非法');
  const nowMs = nowDate.getTime();
  const ctx = { timeZone, windows, index };
  const current = computeStateAt(nowMs, ctx);
  const nextMs = findNextChange(nowMs, ctx, current.state);
  const nextParts = nextMs === null ? null : getZonedParts(nextMs, timeZone);
  const nextState = nextMs === null ? null : computeStateAt(nextMs, ctx).state;
  const { dayInfo, parts } = current;
  return {
    state: current.state,
    reason: current.reason,
    workday: dayInfo.workday,
    pauseWindow: current.pauseWindow,
    nextChangeAt: nextMs === null ? null : new Date(nextMs).toISOString(),
    nextChangeAtLocal: nextParts === null ? null : `${dateKeyOf(nextParts)}T${pad2(nextParts.hour)}:${pad2(nextParts.minute)}:${pad2(nextParts.second)}`,
    nextChangeTo: nextState,
    nextChangeInMs: nextMs === null ? null : Math.max(0, nextMs - nowMs),
    holidayName: dayInfo.holidayName,
    holidayType: dayInfo.type,
    date: dateKeyOf(parts),
    timeZone,
    localTime: `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`,
    weekday: parts.weekday,
    weekend: dayInfo.weekend,
    source: dayInfo.source,
  };
}

/* ------------------------------------------------------------------------- *
 * 节假日缓存：与 Host 的 `shared/holiday.js` 同 schema（version 1），
 * 浏览器存 localStorage，Host 存 $DSH_HOME/cache/work-window/*.json。
 * ------------------------------------------------------------------------- */

/** timor.tech `/api/holiday/year/<year>` 响应 → 规范化缓存对象。 */
export function normalizeYearData(year, apiData, meta = {}) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new RangeError('normalizeYearData: year 非法');
  if (apiData === null || typeof apiData !== 'object') throw new TypeError('normalizeYearData: 响应不是对象');
  if (apiData.code !== 0) throw new Error(`timor.tech 返回错误码 ${JSON.stringify(apiData.code)}`);
  if (apiData.holiday === null || typeof apiData.holiday !== 'object') throw new TypeError('响应缺少 holiday 对象');
  const holidays = {};
  let holidayCount = 0;
  for (const [key, raw] of Object.entries(apiData.holiday)) {
    if (!MONTH_DAY_RE.test(key)) throw new TypeError(`节假日键 ${JSON.stringify(key)} 不是 MM-DD`);
    const entry = normalizeEntry(raw);
    const expectedDate = `${year}-${key}`;
    if (entry.date !== null && entry.date !== expectedDate) {
      throw new TypeError(`节假日键 ${key} 的 date=${entry.date} 与年份 ${year} 不匹配`);
    }
    holidays[key] = { ...entry, date: expectedDate };
    if (entry.type === 'holiday') holidayCount += 1;
  }
  return {
    version: CACHE_SCHEMA_VERSION,
    year,
    source: meta.source ?? 'timor.tech',
    url: meta.url ?? null,
    fetchedAt: new Date(meta.fetchedAt ?? Date.now()).toISOString(),
    code: 0,
    holidays,
    holidayCount,
    workdayCount: Object.keys(holidays).length - holidayCount,
  };
}

/** 解析并校验缓存（字符串或对象均可）。 */
export function parseCache(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (data === null || typeof data !== 'object') throw new TypeError('缓存必须是对象');
  if (data.version !== CACHE_SCHEMA_VERSION) throw new TypeError(`缓存版本 ${data.version} 不受支持`);
  if (!Number.isInteger(data.year)) throw new TypeError('缓存 year 非法');
  if (data.holidays === null || typeof data.holidays !== 'object') throw new TypeError('缓存缺少 holidays');
  const holidays = {};
  for (const [key, raw] of Object.entries(data.holidays)) {
    if (!MONTH_DAY_RE.test(key)) throw new TypeError(`缓存键 ${JSON.stringify(key)} 不是 MM-DD`);
    holidays[key] = normalizeEntry(raw);
  }
  return {
    version: CACHE_SCHEMA_VERSION,
    year: data.year,
    source: typeof data.source === 'string' ? data.source : 'unknown',
    url: typeof data.url === 'string' ? data.url : null,
    fetchedAt: new Date(data.fetchedAt).toISOString(),
    code: 0,
    holidays,
    holidayCount: Object.values(holidays).filter((entry) => entry.type === 'holiday').length,
    workdayCount: Object.values(holidays).filter((entry) => entry.type === 'workday').length,
  };
}

export function serializeCache(cache) {
  return JSON.stringify(parseCache(cache));
}

export function isCacheFresh(cache, ttlMs = DEFAULT_CACHE_TTL_MS, nowMs = Date.now()) {
  if (cache === null || typeof cache !== 'object' || typeof cache.fetchedAt !== 'string') return false;
  const fetchedMs = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(fetchedMs)) return false;
  if (typeof ttlMs !== 'number' || !(ttlMs > 0)) return false;
  const age = nowMs - fetchedMs;
  if (age < -5 * 60 * 1000) return false;
  return age <= ttlMs;
}
