/* ⚠️ 本文件为生成产物，不要手改：源文件是 client.template.js + shared/status-client.mjs +
 * shared/offline-holidays.json；修改后运行 `node tools/build-client.mjs`。 */
/**
 * DSH Work Window —— 浏览器（Client）半区。
 *
 * 这个文件由 `tools/build-client.mjs` 从 `client.template.js` + `shared/status-client.mjs`
 * + `shared/offline-holidays-<year>.json` 生成（把纯函数与离线快照内联进来，保证浏览器
 * bundle 自包含、不依赖任何 Harness 客户端包）。
 *
 * 职责：
 *   1. 左侧栏入口（`sidebar.panellist`）与主面板（`main` keyed slot）：展示当前状态、
 *      倒计时、暂停区间、今日节假日与缓存状态，并可手动同步 timor.tech 数据。
 *   2. 输入框下方的提醒条（`conversation.composer.dock`）：仅在暂停时段显示。
 *   3. 节假日数据缓存在 localStorage（每年一条），同步失败时退回内置离线快照。
 *
 * 说明：真正的「暂停 / 确认」由 Host 半区（index.js）在 `agent/pre-step` 上强制执行；
 * 浏览器半区展示的状态用同一套纯函数在本地计算，因此与 Host 判定一致。
 */
(function bootWorkWindowClient() {
  'use strict';

  const loader = globalThis.__ModuleLoader__;
  if (loader === undefined || typeof loader.load !== 'function') {
    // 非浏览器环境（静态检查 / node --check）下静默退出。
    return;
  }

  loader.load({
    // ⚠️ 必须等于 package.json 的 name（dsh-client-modules 以裸包名作为模块 id）。
    id: '@local/dsh-work-window',
    factory(require) {
      const React = require('react');
      const h = React.createElement;

      // ---------------------------------------------------------------- //
      // 0. 内联的纯函数（来自 shared/status-client.mjs，构建时注入）
      // ---------------------------------------------------------------- //
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

const DEFAULT_TIME_ZONE = 'Asia/Hong_Kong';
const DEFAULT_PAUSE_WINDOWS = Object.freeze([
  Object.freeze({ start: '09:00', end: '12:00' }),
  Object.freeze({ start: '14:00', end: '18:00' }),
]);
const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_NEXT_CHANGE_DAYS = 10;

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u;
const MONTH_DAY_RE = /^(\d{2})-(\d{2})$/u;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function pad2(value) {
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
function getZonedParts(dateOrMs, timeZone = DEFAULT_TIME_ZONE) {
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
function zonedWallTimeToUtcMs(parts, timeZone = DEFAULT_TIME_ZONE) {
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
function addDaysToParts(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function dateKeyOf(parts) {
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
function parseWindows(input = DEFAULT_PAUSE_WINDOWS) {
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

function formatWindow(window) {
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
function buildHolidayIndex(caches) {
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
function statusAt(now, options = {}) {
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
function normalizeYearData(year, apiData, meta = {}) {
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
function parseCache(input) {
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

function serializeCache(cache) {
  return JSON.stringify(parseCache(cache));
}

function isCacheFresh(cache, ttlMs = DEFAULT_CACHE_TTL_MS, nowMs = Date.now()) {
  if (cache === null || typeof cache !== 'object' || typeof cache.fetchedAt !== 'string') return false;
  const fetchedMs = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(fetchedMs)) return false;
  if (typeof ttlMs !== 'number' || !(ttlMs > 0)) return false;
  const age = nowMs - fetchedMs;
  if (age < -5 * 60 * 1000) return false;
  return age <= ttlMs;
}

      // ---------------------------------------------------------------- //
      // 1. 常量与内置离线节假日快照（构建时注入）
      // ---------------------------------------------------------------- //
      const NS = 'workWindow';
      const PANEL_ID = 'work-window';
      const STORAGE_PREFIX = 'dsh-work-window:holidays:';
      const CACHE_TTL_MS = DEFAULT_CACHE_TTL_MS;
      const YEAR_API = 'https://timor.tech/api/holiday/year/';
      const FETCH_TIMEOUT_MS = 15000;

      const CONFIG = Object.freeze({
        timeZone: DEFAULT_TIME_ZONE,
        pauseWindows: DEFAULT_PAUSE_WINDOWS.map((window) => ({ ...window })),
      });

      /** 构建时注入的离线快照：数组，元素是 normalizeYearData 的产物。 */
      const OFFLINE_HOLIDAYS = [
  {
    "version": 1,
    "year": 2026,
    "source": "timor.tech",
    "url": "https://timor.tech/api/holiday/year/2026",
    "fetchedAt": "2026-10-30T10:26:40.609Z",
    "code": 0,
    "holidays": {
      "01-01": {
        "name": "元旦",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-01-01",
        "target": null,
        "after": null,
        "rest": 54
      },
      "01-02": {
        "name": "元旦",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-01-02",
        "target": null,
        "after": null,
        "rest": 1
      },
      "01-03": {
        "name": "元旦",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-01-03",
        "target": null,
        "after": null,
        "rest": 1
      },
      "01-04": {
        "name": "元旦后补班",
        "type": "workday",
        "isHoliday": false,
        "wage": 1,
        "date": "2026-01-04",
        "target": "元旦",
        "after": true,
        "rest": 1
      },
      "02-14": {
        "name": "春节前补班",
        "type": "workday",
        "isHoliday": false,
        "wage": 1,
        "date": "2026-02-14",
        "target": "春节",
        "after": false,
        "rest": 34
      },
      "02-15": {
        "name": "春节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-02-15",
        "target": null,
        "after": null,
        "rest": 35
      },
      "02-16": {
        "name": "除夕",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-02-16",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-17": {
        "name": "初一",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-02-17",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-18": {
        "name": "初二",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-02-18",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-19": {
        "name": "初三",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-02-19",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-20": {
        "name": "初四",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-02-20",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-21": {
        "name": "初五",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-02-21",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-22": {
        "name": "初六",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-02-22",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-23": {
        "name": "初七",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-02-23",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-28": {
        "name": "春节后补班",
        "type": "workday",
        "isHoliday": false,
        "wage": 1,
        "date": "2026-02-28",
        "target": "春节",
        "after": true,
        "rest": 5
      },
      "04-04": {
        "name": "清明节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-04-04",
        "target": null,
        "after": null,
        "rest": 4
      },
      "04-05": {
        "name": "清明节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-04-05",
        "target": null,
        "after": null,
        "rest": 1
      },
      "04-06": {
        "name": "清明节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-04-06",
        "target": null,
        "after": null,
        "rest": 1
      },
      "05-01": {
        "name": "劳动节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-05-01",
        "target": null,
        "after": null,
        "rest": 17
      },
      "05-02": {
        "name": "劳动节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-05-02",
        "target": null,
        "after": null,
        "rest": 1
      },
      "05-03": {
        "name": "劳动节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-05-03",
        "target": null,
        "after": null,
        "rest": 1
      },
      "05-04": {
        "name": "劳动节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-05-04",
        "target": null,
        "after": null,
        "rest": 1
      },
      "05-05": {
        "name": "劳动节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-05-05",
        "target": null,
        "after": null,
        "rest": 1
      },
      "05-09": {
        "name": "劳动节后补班",
        "type": "workday",
        "isHoliday": false,
        "wage": 1,
        "date": "2026-05-09",
        "target": "劳动节",
        "after": true,
        "rest": 1
      },
      "06-19": {
        "name": "端午节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-06-19",
        "target": null,
        "after": null,
        "rest": 14
      },
      "06-20": {
        "name": "端午节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-06-20",
        "target": null,
        "after": null,
        "rest": 1
      },
      "06-21": {
        "name": "端午节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-06-21",
        "target": null,
        "after": null,
        "rest": 1
      },
      "09-20": {
        "name": "中秋节前补班",
        "type": "workday",
        "isHoliday": false,
        "wage": 1,
        "date": "2026-09-20",
        "target": "中秋节",
        "after": false,
        "rest": 50
      },
      "09-25": {
        "name": "中秋节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-09-25",
        "target": null,
        "after": null,
        "rest": 55
      },
      "09-26": {
        "name": "中秋节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-09-26",
        "target": null,
        "after": null,
        "rest": 1
      },
      "09-27": {
        "name": "中秋节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-09-27",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-01": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-10-01",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-02": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-10-02",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-03": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2026-10-03",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-04": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-10-04",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-05": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-10-05",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-06": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-10-06",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-07": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2026-10-07",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-10": {
        "name": "国庆节后补班",
        "type": "workday",
        "isHoliday": false,
        "wage": 1,
        "date": "2026-10-10",
        "target": "国庆节",
        "after": true,
        "rest": null
      }
    },
    "holidayCount": 33,
    "workdayCount": 6
  },
  {
    "version": 1,
    "year": 2025,
    "source": "timor.tech",
    "url": "https://timor.tech/api/holiday/year/2025",
    "fetchedAt": "2026-10-30T10:26:43.642Z",
    "code": 0,
    "holidays": {
      "01-01": {
        "name": "元旦",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-01-01",
        "target": null,
        "after": null,
        "rest": 55
      },
      "01-26": {
        "name": "春节前补班",
        "type": "workday",
        "isHoliday": false,
        "wage": 1,
        "date": "2025-01-26",
        "target": "春节",
        "after": false,
        "rest": 19
      },
      "01-28": {
        "name": "除夕",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-01-28",
        "target": null,
        "after": null,
        "rest": 21
      },
      "01-29": {
        "name": "初一",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-01-29",
        "target": null,
        "after": null,
        "rest": 1
      },
      "01-30": {
        "name": "初二",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-01-30",
        "target": null,
        "after": null,
        "rest": 1
      },
      "01-31": {
        "name": "初三",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-01-31",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-01": {
        "name": "初四",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-02-01",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-02": {
        "name": "初五",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-02-02",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-03": {
        "name": "初六",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-02-03",
        "target": null,
        "after": null,
        "rest": 1
      },
      "02-04": {
        "name": "初七",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-02-04",
        "target": null,
        "after": null,
        "rest": null
      },
      "02-08": {
        "name": "春节后补班",
        "type": "workday",
        "isHoliday": false,
        "wage": 1,
        "date": "2025-02-08",
        "target": "春节",
        "after": true,
        "rest": 2
      },
      "04-04": {
        "name": "清明节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-04-04",
        "target": null,
        "after": null,
        "rest": 10
      },
      "04-05": {
        "name": "清明节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-04-05",
        "target": null,
        "after": null,
        "rest": 1
      },
      "04-06": {
        "name": "清明节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-04-06",
        "target": null,
        "after": null,
        "rest": 1
      },
      "04-27": {
        "name": "劳动节前补班",
        "type": "workday",
        "isHoliday": false,
        "wage": 1,
        "date": "2025-04-27",
        "target": "劳动节",
        "after": false,
        "rest": 15
      },
      "05-01": {
        "name": "劳动节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-05-01",
        "target": null,
        "after": null,
        "rest": 19
      },
      "05-02": {
        "name": "劳动节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-05-02",
        "target": null,
        "after": null,
        "rest": 1
      },
      "05-03": {
        "name": "劳动节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-05-03",
        "target": null,
        "after": null,
        "rest": 1
      },
      "05-04": {
        "name": "劳动节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-05-04",
        "target": null,
        "after": null,
        "rest": 1
      },
      "05-05": {
        "name": "劳动节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-05-05",
        "target": null,
        "after": null,
        "rest": 1
      },
      "05-31": {
        "name": "端午节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-05-31",
        "target": null,
        "after": null,
        "rest": 4
      },
      "06-01": {
        "name": "端午节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-06-01",
        "target": null,
        "after": null,
        "rest": 1
      },
      "06-02": {
        "name": "端午节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-06-02",
        "target": null,
        "after": null,
        "rest": 1
      },
      "09-28": {
        "name": "国庆节前补班",
        "type": "workday",
        "isHoliday": false,
        "wage": 1,
        "date": "2025-09-28",
        "target": "国庆节",
        "after": false,
        "rest": 27
      },
      "10-01": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-10-01",
        "target": null,
        "after": null,
        "rest": 30
      },
      "10-02": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-10-02",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-03": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 3,
        "date": "2025-10-03",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-04": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-10-04",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-05": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-10-05",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-06": {
        "name": "中秋节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-10-06",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-07": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-10-07",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-08": {
        "name": "国庆节",
        "type": "holiday",
        "isHoliday": true,
        "wage": 2,
        "date": "2025-10-08",
        "target": null,
        "after": null,
        "rest": 1
      },
      "10-11": {
        "name": "国庆节后补班",
        "type": "workday",
        "isHoliday": false,
        "wage": 1,
        "date": "2025-10-11",
        "target": "国庆节",
        "after": true,
        "rest": 2
      }
    },
    "holidayCount": 28,
    "workdayCount": 5
  }
];

      const zh = {
        panel: '工作时段',
        title: '工作时段',
        intro: 'Agent 只在可工作时段发起模型请求；暂停时段下的任务会先请求你确认。',
        'state.working': '可工作',
        'state.paused': '暂停中',
        'period.window': '工作日暂停区间 {window}',
        'period.weekend': '周末，可自由工作',
        'period.holiday': '节假日：{name}',
        'period.offHours': '工作日非暂停时段',
        'row.now': '本地时间',
        'row.change': '下一次切换',
        'row.windows': '暂停区间',
        'row.today': '今日',
        'row.cache': '节假日数据',
        'change.work': '{time} 恢复工作',
        'change.pause': '{time} 进入暂停',
        'countdown': '还有 {time}',
        'holiday.none': '无（普通工作日/周末）',
        'holiday.holiday': '{name}（法定假日）',
        'holiday.workday': '{name}（调休补班）',
        'cache.offline': '内置离线数据（{year}），点「同步」获取最新',
        'cache.missing': '尚未同步，暂按周末规则判断',
        'cache.synced': 'timor.tech · {time} 更新',
        'cache.stale': 'timor.tech · {time} 更新（已过期，建议同步）',
        sync: '同步节假日数据',
        'sync.busy': '正在同步…',
        'sync.ok': '已同步 {count} 条节假日/调休记录',
        'sync.fail': '同步失败：{message}（继续使用缓存/离线数据）',
        notice:
          '暂停时段 Agent 不发起模型请求、不消耗 token。你在暂停时段发送任务时，Host 会先弹出确认；拒绝或超时则任务排队，时段结束后自动继续。',
        'composer.paused': '暂停时段 · {window} · {time} 恢复 · 发送任务会先请求确认',
        'composer.working': '可工作',
        'countdown.short': '{h}小时{m}分',
      };
      const en = {
        panel: 'Work Window',
        title: 'Work Window',
        intro: 'The agent starts model requests only inside working windows; tasks sent during a pause ask you first.',
        'state.working': 'Working',
        'state.paused': 'Paused',
        'period.window': 'Paused window {window} on working days',
        'period.weekend': 'Weekend — free to work',
        'period.holiday': 'Holiday: {name}',
        'period.offHours': 'Working day, outside paused windows',
        'row.now': 'Local time',
        'row.change': 'Next change',
        'row.windows': 'Paused windows',
        'row.today': 'Today',
        'row.cache': 'Holiday data',
        'change.work': 'Work resumes at {time}',
        'change.pause': 'Pause starts at {time}',
        countdown: '{time} left',
        'holiday.none': 'None (ordinary working day / weekend)',
        'holiday.holiday': '{name} (public holiday)',
        'holiday.workday': '{name} (adjusted workday)',
        'cache.offline': 'Built-in offline data ({year}); press Sync for the latest',
        'cache.missing': 'Not synced yet; only weekends are handled',
        'cache.synced': 'timor.tech · updated {time}',
        'cache.stale': 'timor.tech · updated {time} (stale, please sync)',
        sync: 'Sync holiday data',
        'sync.busy': 'Syncing…',
        'sync.ok': 'Synced {count} holiday/adjusted records',
        'sync.fail': 'Sync failed: {message} (keeping cache/offline data)',
        notice:
          'While paused the agent sends no model request and consumes no tokens. A task sent during a pause triggers a confirmation first; rejecting or timing out keeps it queued until the window ends.',
        'composer.paused': 'Paused window · {window} · resumes {time} · sending asks for confirmation',
        'composer.working': 'Working',
        'countdown.short': '{h}h {m}m',
      };

      // ---------------------------------------------------------------- //
      // 2. 小工具
      // ---------------------------------------------------------------- //
      const pad = pad2;

      function interpolate(text, values) {
        if (values === undefined) return text;
        return String(text).replace(/\{(\w+)\}/gu, (match, key) =>
          Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
        );
      }

      function formatDuration(ms, t) {
        const total = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        if (hours > 0) return interpolate(t('countdown.short'), { h: hours, m: minutes });
        return `${pad(minutes)}:${pad(seconds)}`;
      }

      function formatLocalDateTime(iso) {
        if (typeof iso !== 'string' || iso.length < 16) return '—';
        return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
      }

      function localClockOf(dateLike, timeZone) {
        try {
          return new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(dateLike);
        } catch {
          return '';
        }
      }

      // ---------------------------------------------------------------- //
      // 3. localStorage 缓存（每年一条，schema 与 Host 相同）
      // ---------------------------------------------------------------- //
      function storageKey(year) {
        return STORAGE_PREFIX + year;
      }

      function safeStorage() {
        try {
          return globalThis.localStorage ?? null;
        } catch {
          return null;
        }
      }

      function readCache(year) {
        const storage = safeStorage();
        if (storage === null) return null;
        let text;
        try {
          text = storage.getItem(storageKey(year));
        } catch {
          return null;
        }
        if (text === null) return null;
        try {
          return parseCache(text);
        } catch {
          return null;
        }
      }

      function writeCache(cache) {
        const storage = safeStorage();
        if (storage === null) return;
        try {
          storage.setItem(storageKey(cache.year), serializeCache(cache));
        } catch {
          /* 配额/隐私模式：忽略，退回离线数据 */
        }
      }

      function offlineFor(year) {
        return OFFLINE_HOLIDAYS.find((cache) => cache.year === year) ?? null;
      }

      function loadAllCaches() {
        const years = new Set();
        const currentYear = getZonedParts(new Date(), CONFIG.timeZone).year;
        years.add(currentYear);
        years.add(currentYear + 1);
        for (const offline of OFFLINE_HOLIDAYS) years.add(offline.year);
        const caches = [];
        for (const year of years) {
          const cached = readCache(year);
          if (cached !== null) caches.push(cached);
          else {
            const offline = offlineFor(year);
            if (offline !== null) caches.push(offline);
          }
        }
        return caches;
      }

      async function fetchYear(year) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const response = await fetch(`${YEAR_API}${year}`, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const json = await response.json();
          const cache = normalizeYearData(year, json, { fetchedAt: Date.now(), url: `${YEAR_API}${year}` });
          writeCache(cache);
          return cache;
        } finally {
          clearTimeout(timer);
        }
      }

      /** 当前年份（必要时含下一年）的缓存：命中原缓存优先，过期则后台同步。 */
      function useHolidayCaches() {
        const [caches, setCaches] = React.useState(loadAllCaches);
        const [syncState, setSyncState] = React.useState({ busy: false, synced: null, error: null });
        const syncing = React.useRef(false);

        const sync = React.useCallback(async (force) => {
          if (syncing.current) return;
          syncing.current = true;
          setSyncState({ busy: true, synced: null, error: null });
          try {
            const now = new Date();
            const parts = getZonedParts(now, CONFIG.timeZone);
            const years = [parts.year];
            if (parts.month >= 11) years.push(parts.year + 1);
            let total = 0;
            for (const year of years) {
              const cached = readCache(year);
              if (!force && cached !== null && isCacheFresh(cached, CACHE_TTL_MS, now.getTime())) {
                total += Object.keys(cached.holidays).length;
                continue;
              }
              const fetched = await fetchYear(year);
              total += Object.keys(fetched.holidays).length;
            }
            setCaches(loadAllCaches());
            setSyncState({ busy: false, synced: total, error: null });
          } catch (error) {
            const message = error !== null && typeof error === 'object' && 'message' in error ? error.message : String(error);
            setSyncState({ busy: false, synced: null, error: message });
          } finally {
            syncing.current = false;
          }
        }, []);

        React.useEffect(() => {
          // 缓存在 TTL 内就跳过；否则后台同步（失败保持离线数据，不阻塞 UI）。
          const now = Date.now();
          const parts = getZonedParts(new Date(now), CONFIG.timeZone);
          const cached = readCache(parts.year);
          if (cached === null || !isCacheFresh(cached, CACHE_TTL_MS, now)) void sync(false);
        }, [sync]);

        return { caches, syncState, sync };
      }

      // ---------------------------------------------------------------- //
      // 4. 每秒时钟（组件卸载即清理）
      // ---------------------------------------------------------------- //
      function useNowTick(intervalMs) {
        const [now, setNow] = React.useState(() => new Date());
        React.useEffect(() => {
          const timer = setInterval(() => setNow(new Date()), intervalMs);
          return () => clearInterval(timer);
        }, [intervalMs]);
        return now;
      }

      // ---------------------------------------------------------------- //
      // 5. 样式（一次注入，只用主题 token，类名带 ww_ 前缀）
      // ---------------------------------------------------------------- //
      const CSS = [
        '.ww_page{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);',
        'flex-direction:column;align-items:center;gap:24px;display:flex;overflow:auto;',
        'padding:0 clamp(24px,4vw,48px) 48px}',
        '.ww_page>*{width:100%;max-width:960px}',
        '.ww_pageHead{box-sizing:border-box;flex-wrap:wrap;justify-content:space-between;',
        'align-items:flex-start;gap:16px;padding-top:28px;display:flex}',
        '[data-platform=darwin] .ww_pageHead{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}',
        '.ww_pageTitle{margin:0;font-size:20px;font-weight:500;line-height:28px}',
        '.ww_pageIntro{color:var(--dsw-alias-label-secondary);margin:4px 0 0;font-size:13px;line-height:20px}',
        '.ww_badge{box-sizing:border-box;flex:none;align-items:center;gap:8px;display:inline-flex;',
        'border-radius:999px;padding:6px 14px;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap}',
        '.ww_badge-working{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);',
        'color:var(--dsw-alias-state-success-primary)}',
        '.ww_badge-paused{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}',
        '.ww_card{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);',
        'background:var(--dsw-alias-bg-layer-1);flex-direction:column;margin:0;padding:4px 16px;display:flex}',
        '.ww_row{align-items:center;gap:16px;justify-content:space-between;min-height:44px;',
        'border-bottom:.5px solid var(--dsw-alias-border-l2);padding:8px 0;display:flex}',
        '.ww_row:last-child{border-bottom:0}',
        '.ww_rowLabel{color:var(--dsw-alias-label-secondary);flex:none;font-size:13px;line-height:20px}',
        '.ww_rowValue{text-align:end;overflow-wrap:anywhere;min-width:0;margin:0;',
        'font-size:13px;line-height:20px;font-variant-numeric:tabular-nums}',
        '.ww_mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}',
        '.ww_note{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}',
        '.ww_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}',
        '.ww_ok{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}',
        '.ww_actions{flex-wrap:wrap;align-items:center;gap:12px;display:flex}',
        '.ww_button{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);',
        'background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);',
        'cursor:pointer;height:32px;padding:0 12px;font:inherit;font-size:13px;line-height:20px}',
        '.ww_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.ww_button:disabled{cursor:default;opacity:.6}',
        '.ww_button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
        '.ww_notice{box-sizing:border-box;align-items:center;gap:8px;display:flex;flex-wrap:wrap;',
        'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:6px 2px}',
        '.ww_noticeDot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}',
      ].join('');

      const CSS_TAG_ID = '@local/dsh-work-window/WorkWindow.css';
      function ensureStyles() {
        if (typeof document === 'undefined') return;
        if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = '@local/dsh-work-window';
        tag.dataset.pluginCss = CSS_TAG_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }

      // ---------------------------------------------------------------- //
      // 6. 侧栏图标（props: { size, active }；原创 24x24 时钟 + 暂停条）
      // ---------------------------------------------------------------- //
      function WorkWindowIcon({ size }) {
        return h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: size,
            height: size,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          h('circle', { cx: 11, cy: 12, r: 8.25 }),
          h('path', { d: 'M11 7.5v5l2.6 1.4' }),
          h('path', { d: 'M20 9.5v5M22.5 9.5v5' }),
        );
      }

      // ---------------------------------------------------------------- //
      // 7. 主面板
      // ---------------------------------------------------------------- //
      function WorkWindowPage(props) {
        const t = props.t;
        const now = useNowTick(1000);
        const { caches, syncState, sync } = useHolidayCaches();
        const state = statusAt(now, {
          timeZone: CONFIG.timeZone,
          pauseWindows: CONFIG.pauseWindows,
          holidays: caches,
        });
        const paused = state.state === 'paused';
        const windowText = CONFIG.pauseWindows.map(formatWindow).join('、');

        const periodText =
          state.reason === 'window'
            ? interpolate(t('period.window'), { window: state.pauseWindow === null ? '' : formatWindow(state.pauseWindow) })
            : state.reason === 'holiday'
              ? interpolate(t('period.holiday'), { name: state.holidayName ?? '' })
              : state.reason === 'weekend'
                ? t('period.weekend')
                : t('period.offHours');

        const changeRow =
          state.nextChangeAtLocal === null
            ? '—'
            : `${state.nextChangeTo === 'working' ? interpolate(t('change.work'), { time: state.nextChangeAtLocal.slice(11, 16) }) : interpolate(t('change.pause'), { time: state.nextChangeAtLocal.slice(11, 16) })}（${interpolate(t('countdown'), { time: formatDuration(state.nextChangeInMs ?? 0, t) })}）`;

        const todayText =
          state.holidayType === 'holiday'
            ? interpolate(t('holiday.holiday'), { name: state.holidayName ?? '' })
            : state.holidayType === 'workday'
              ? interpolate(t('holiday.workday'), { name: state.holidayName ?? '' })
              : t('holiday.none');

        const cacheText = (() => {
          const year = state.date.slice(0, 4);
          const yearNum = Number(year);
          const cached = readCache(yearNum);
          const offline = offlineFor(yearNum);
          const chosen = cached ?? offline;
          if (chosen === null) return t('cache.missing');
          const label = cached === null
            ? interpolate(t('cache.offline'), { year: yearNum })
            : interpolate(isCacheFresh(cached, CACHE_TTL_MS, now.getTime()) ? t('cache.synced') : t('cache.stale'), {
                time: formatLocalDateTime(cached.fetchedAt),
              });
          return label;
        })();

        const rows = [
          [t('row.now'), `${state.localTime.slice(0, 5)}:${state.localTime.slice(6, 8)} · ${CONFIG.timeZone}`, true],
          [t('row.change'), changeRow, false],
          [t('row.windows'), windowText, false],
          [t('row.today'), `${todayText} · ${periodText}`, false],
          [t('row.cache'), cacheText, false],
        ];

        const syncNow = () => { void sync(true); };

        return h(
          'div',
          { className: 'ww_page' },
          h(
            'header',
            { className: 'ww_pageHead', key: 'head' },
            h(
              'div',
              { key: 'heading' },
              h('h1', { className: 'ww_pageTitle' }, t('title')),
              h('p', { className: 'ww_pageIntro' }, t('intro')),
            ),
            h(
              'div',
              {
                key: 'badge',
                className: `ww_badge ${paused ? 'ww_badge-paused' : 'ww_badge-working'}`,
                role: 'status',
              },
              paused ? t('state.paused') : t('state.working'),
            ),
          ),
          h(
            'section',
            { className: 'ww_card', key: 'facts' },
            rows.map(([label, value, mono]) =>
              h(
                'div',
                { className: 'ww_row', key: label },
                h('span', { className: 'ww_rowLabel' }, label),
                h('span', { className: `ww_rowValue${mono ? ' ww_mono' : ''}` }, value),
              ),
            ),
          ),
          h(
            'div',
            { className: 'ww_actions', key: 'actions' },
            h(
              'button',
              { type: 'button', className: 'ww_button', disabled: syncState.busy, onClick: syncNow },
              syncState.busy ? t('sync.busy') : t('sync'),
            ),
            syncState.busy
              ? null
              : syncState.error !== null
                ? h('p', { className: 'ww_error' }, interpolate(t('sync.fail'), { message: syncState.error }))
                : syncState.synced !== null
                  ? h('p', { className: 'ww_ok' }, interpolate(t('sync.ok'), { count: syncState.synced }))
                  : null,
          ),
          h('p', { className: 'ww_note', key: 'notice' }, t('notice')),
        );
      }

      // ---------------------------------------------------------------- //
      // 8. 输入框下方提醒条（仅在暂停时段显示）
      // ---------------------------------------------------------------- //
      function ComposerNotice(props) {
        const t = props.t;
        const now = useNowTick(15000);
        const caches = React.useMemo(loadAllCaches, []);
        const state = statusAt(now, {
          timeZone: CONFIG.timeZone,
          pauseWindows: CONFIG.pauseWindows,
          holidays: caches,
        });
        if (state.state !== 'paused') return null;
        const window = state.pauseWindow === null ? '' : formatWindow(state.pauseWindow);
        const resume =
          state.nextChangeAtLocal === null
            ? ''
            : localClockOf(new Date(state.nextChangeAt), CONFIG.timeZone);
        return h(
          'div',
          { className: 'ww_notice', role: 'status' },
          h('span', { className: 'ww_noticeDot', 'aria-hidden': 'true' }),
          h('span', {}, interpolate(t('composer.paused'), { window, time: resume })),
        );
      }

      // ---------------------------------------------------------------- //
      // 9. 浏览器插件体
      // ---------------------------------------------------------------- //
      return {
        inject: ['slots', 'locale'],
        apply(ctx) {
          ensureStyles();
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'work-window: dictionaries');
          const t = ctx.locale.bind(NS);

          // 左侧栏入口：id 供 sidebar 寻址；图标是 React 组件。
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 20,
                locale: NS,
                label: () => t('panel'),
              },
              WorkWindowIcon,
            ),
          );

          // 主面板：key 必须与侧栏 id 相同（layout 的 root-scoped keyed slot）。
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              { name: 'main', key: PANEL_ID, locale: NS },
              WorkWindowPage,
            ),
          );

          // 输入框下方提醒：暂停时段给用户一个持续可见的提示。
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'work-window-notice',
                order: 4,
                locale: NS,
              },
              ComposerNotice,
            ),
          );
        },
      };
    },
  });
})();
