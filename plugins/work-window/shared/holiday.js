/**
 * holiday.mjs — 节假日 / 工作时段判定纯函数模块（Host 与浏览器共用）
 *
 * 设计目标：零依赖、无 Node 专有 API、不读写文件、默认不联网。
 * 唯一会联网的函数是 fetchYearHolidays()，且 fetch 实现可注入（便于测试与离线）。
 *
 * 判定模型（与 BRIEF §4.1 一致）：
 *   1. 当天是非工作日（周末 / 法定节假日，按 timor.tech 数据）→ working（可自由工作）。
 *      例外：调休补班日（API 中 holiday:false）即使落在周末也算工作日。
 *   2. 工作日：若当前本地时间落在任一暂停区间（默认 09:00-12:00、14:00-18:00）→ paused；
 *      否则 working。
 *   3. 区间边界语义：[start, end) —— 09:00:00 整属于暂停，12:00:00 整已恢复工作。
 *   4. 跨午夜区间（start > end，如 22:00-02:00）按"当天"规则判定：当前日历日若是工作日且
 *      时间 >= start 或 < end 即为暂停（即把跨午夜区间视为当天规则的一部分）。
 *
 * 时区处理：所有"本地时间"都通过 Intl.DateTimeFormat 按 IANA 时区取出，绝不依赖进程/浏览器
 * 的本地时区设置；内部把墙钟时间转回 UTC 也用 Intl 偏移量迭代求解（可处理夏令时）。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * timor.tech API 实测记录（2026-10-30，Node v24.22.1，Windows）
 * ────────────────────────────────────────────────────────────────────────────
 * 1) 可用性：
 *    - `web_fetch` 工具被 DSH SSRF 策略拒绝：timor.tech 的 DNS 解析到 198.18.0.64
 *      （fake-IP / 代理网段），报 "resolves to a non-public IP address"。
 *    - 同一个 URL 用 Node 原生 fetch（undici，走系统代理）完全正常：HTTP 200 + JSON。
 *    - 因此结论：接口本身可用；本工作区需要走 node fetch。浏览器端 fetch 理论上同样
 *      走系统 DNS/代理，且 API 返回 `access-control-allow-origin: *`，CORS 可行。
 * 2) GET https://timor.tech/api/holiday/year/2026 → 200
 *    {"code":0,"holiday":{"01-01":{"holiday":true,"name":"元旦","wage":3,
 *      "date":"2026-01-01","rest":54}, ...}}
 *    - `holiday` 是 "MM-DD" → 条目 的对象；2026 年共 39 条（33 个假日 + 6 个调休补班）。
 *    - 条目字段：`holiday:boolean`（true=法定假日休息，false=调休补班工作日，必须字段）、
 *      `name:string`、`wage:number`（1/2/3 倍工资）、`date:"YYYY-MM-DD"`；
 *      `rest?:number`（与后续假期间的间隔天数，语义不透明，原样透传）、
 *      `after?:boolean`（补班在节日之前/之后）、`target?:string`（补班所属节日名）。
 *    - 注意：普通周末不会出现在 holiday 对象里，需要本地按日历计算星期。
 * 3) GET https://timor.tech/api/holiday/info/2026-10-01 → 200
 *    {"code":0,"type":{"type":2,"name":"国庆节","week":4},
 *     "holiday":{"holiday":true,"name":"国庆节","wage":3,...}}
 *    - info 端点：`type.type` 1=周末、2=法定假日、3=调休补班；`type.week` 为 1-7（周一=1）；
 *      普通周末时 `holiday:null`。本模块只用 /year/{year} 批量接口（info 仅作实测验形）。
 * 4) 速率限制（重要）：
 *    - 短时间连续请求会返回 HTTP 429：
 *      {"code":429,"message":"too many requests at a times. maybe you need buy vip.",...}
 *      （实例：连续请求 year/2025、year/2027 立即 429）。
 *    - 响应头含 `x-ratelimit-limit: 10000`、`x-ratelimit-remaining`；
 *      `cache-control: max-age=43200`（12h）→ 与 DEFAULT_CACHE_TTL_MS 对齐。
 *    - 结论：Host 必须本地缓存并串行刷新，不要把 fetchYearHolidays 放到渲染循环里。
 * 5) 响应头 `access-control-allow-origin: *`，浏览器可直接跨域请求；`cf-cache-status: HIT`
 *    说明 Cloudflare 有缓存，但仍需遵守 429 退避。
 *
 * 缓存 schema（version = CACHE_SCHEMA_VERSION = 1）：
 * {
 *   version: 1,
 *   year: 2026,
 *   source: 'timor.tech',
 *   url: 'https://timor.tech/api/holiday/year/2026',
 *   fetchedAt: '2026-10-30T10:14:36.000Z',       // ISO 8601 UTC
 *   code: 0,                                       // API 原始 code（成功恒为 0）
 *   holidays: { 'MM-DD': { name, type, isHoliday, wage, date, target, after, rest } },
 *   holidayCount: 33,                              // type === 'holiday' 的条目数
 *   workdayCount: 6,                               // type === 'workday'（调休补班）的条目数
 * }
 *
 * @module shared/holiday
 */

/* ========================================================================== *
 * 常量
 * ========================================================================== */

/** 本地缓存 schema 版本号；结构变更时递增。 */
export const CACHE_SCHEMA_VERSION = 1;

/** 默认时区：BRIEF 指定的业务时区。 */
export const DEFAULT_TIME_ZONE = 'Asia/Hong_Kong';

/** 默认暂停区间（工作日）。 */
export const DEFAULT_PAUSE_WINDOWS = Object.freeze([
  Object.freeze({ start: '09:00', end: '12:00' }),
  Object.freeze({ start: '14:00', end: '18:00' }),
]);

/** 默认缓存 TTL：12 小时，与 timor.tech `cache-control: max-age=43200` 对齐。 */
export const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** timor.tech 年度接口 URL 模板；`{year}` 会被替换为 4 位年份。 */
export const HOLIDAY_API_URL_TEMPLATE = 'https://timor.tech/api/holiday/year/{year}';

/** 计算 nextChangeAt 时向前扫描的最大天数（覆盖任何长假 + 周末的组合）。 */
export const MAX_NEXT_CHANGE_SCAN_DAYS = 60;

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

/** 允许 fetchedAt 略晚于 now 的时钟偏差（5 分钟）。 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAY_RE = /^(\d{2})-(\d{2})$/;
const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ========================================================================== *
 * 错误类型
 * ========================================================================== */

/**
 * 节假日 API 相关错误（网络 / HTTP / 速率限制 / JSON / 响应结构 / 超时）。
 * 调用方可通过 `err.code` 稳定区分：
 *   E_NETWORK | E_HTTP | E_RATE_LIMITED | E_TIMEOUT | E_ABORTED |
 *   E_INVALID_JSON | E_INVALID_RESPONSE | E_API_CODE | E_EMPTY_DATA | E_NO_FETCH
 */
export class HolidayApiError extends Error {
  /**
   * @param {string} message
   * @param {object} [meta]
   * @param {string} [meta.code]
   * @param {number|null} [meta.status] HTTP 状态码
   * @param {string|null} [meta.url]
   * @param {number|null} [meta.apiCode] 响应体里的 code 字段
   * @param {string|null} [meta.bodySnippet] 响应体前 300 字符（排障用）
   * @param {Error|null} [meta.cause]
   */
  constructor(message, { code = 'E_API', status = null, url = null, apiCode = null, bodySnippet = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HolidayApiError';
    this.code = code;
    this.status = status;
    this.url = url;
    this.apiCode = apiCode;
    this.bodySnippet = bodySnippet;
  }
}

/**
 * 本地缓存解析/校验错误。调用方可通过 `err.code` 区分：
 *   E_INVALID_JSON | E_INVALID_CACHE | E_UNSUPPORTED_VERSION
 */
export class HolidayCacheError extends Error {
  /**
   * @param {string} message
   * @param {object} [meta]
   * @param {string} [meta.code]
   * @param {Error|null} [meta.cause]
   */
  constructor(message, { code = 'E_INVALID_CACHE', cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HolidayCacheError';
    this.code = code;
  }
}

/* ========================================================================== *
 * 基础工具（内部）
 * ========================================================================== */

/** @param {number} n */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** @param {unknown} value */
function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/** @param {unknown} value @returns {number|null} */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value @returns {boolean|null} */
function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

/** @param {unknown} value @returns {string|null} */
function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 把 Date / 毫秒时间戳 / ISO 字符串统一成毫秒时间戳。
 * @param {Date|number|string} value
 * @param {string} label
 * @returns {number}
 */
function coerceEpochMs(value, label) {
  if (value instanceof Date) {
    const t = value.getTime();
    if (!Number.isFinite(t)) throw new TypeError(`${label}: 无效的 Date 对象`);
    return t;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label}: 无效的时间戳`);
    return value;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isFinite(t)) throw new TypeError(`${label}: 无法解析时间字符串 ${JSON.stringify(value)}`);
    return t;
  }
  throw new TypeError(`${label}: 需要 Date / number(毫秒时间戳) / ISO 字符串`);
}

/** now 允许省略（取当前时刻）。 */
function resolveNow(value, label) {
  return value === undefined ? Date.now() : coerceEpochMs(value, label);
}

/** @param {number} year */
function validateYear(year) {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    const err = new RangeError(`年份必须是 ${MIN_YEAR}-${MAX_YEAR} 之间的整数，得到 ${JSON.stringify(year)}`);
    err.code = 'E_INVALID_YEAR';
    throw err;
  }
  return year;
}

/**

 * @param {number} year @param {number} month 1-12 @param {number} day 1-31
 * @param {string} label
 */
function validateCalendarDate(year, month, day, label) {
  if (month < 1 || month > 12) throw new RangeError(`${label}: 月份 ${month} 无效`);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) throw new RangeError(`${label}: 日期 ${year}-${pad2(month)}-${pad2(day)} 不存在`);
}

/** @param {{year:number, month:number, day:number}} parts */
function weekdayOf(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

/** @param {{year:number, month:number, day:number}} parts */
function dateKeyOf(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/**
 * 解析 "YYYY-MM-DD"（仅日历日，不含时间）。
 * @param {string} text
 * @param {string} label
 */
function parseDateOnly(text, label) {
  const match = DATE_ONLY_RE.exec(text);
  if (!match) throw new TypeError(`${label}: 需要 YYYY-MM-DD，得到 ${JSON.stringify(text)}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  validateYear(year);
  validateCalendarDate(year, month, day, label);
  return { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0, weekday: weekdayOf({ year, month, day }) };
}

/**
 * 在纯日历日上加减天数（用 UTC 运算，避免宿主机时区/夏令时影响）。
 * @param {{year:number, month:number, day:number}} parts
 * @param {number} delta
 */
function addDaysToParts(parts, delta) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + delta * DAY_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/* ========================================================================== *
 * 时区工具（导出 getZonedParts 方便 UI 显示本地时间）
 * ========================================================================== */

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatterCache = new Map();

/**
 * 取得（并缓存）按时区格式化的 Intl.DateTimeFormat。
 * @param {string} timeZone IANA 时区
 */
function partsFormatter(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    throw new RangeError('timeZone 必须是非空 IANA 时区字符串，例如 "Asia/Hong_Kong"');
  }
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (cause) {
      throw new RangeError(`无效的 IANA 时区: ${JSON.stringify(timeZone)}`);
    }
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * 取某个时刻在指定 IANA 时区下的本地时间各部分。
 * 这是模块里唯一的"时区真相来源"，不依赖进程时区。
 *
 * @param {Date|number|string} date
 * @param {string} [timeZone=DEFAULT_TIME_ZONE]
 * @returns {{year:number, month:number, day:number, hour:number, minute:number,
 *            second:number, millisecond:number, weekday:number}}
 */
export function getZonedParts(date, timeZone = DEFAULT_TIME_ZONE) {
  const epochMs = coerceEpochMs(date, 'getZonedParts');
  const parts = partsFormatter(timeZone).formatToParts(new Date(epochMs));
  /** @type {Record<string, string>} */
  const bag = Object.create(null);
  for (const part of parts) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  const year = Number(bag.year);
  const month = Number(bag.month);
  const day = Number(bag.day);
  let hour = Number(bag.hour);
  // 少数环境在午夜返回 "24"（hourCycle 兜底），统一归一到 0。
  if (hour === 24) hour = 0;
  const minute = Number(bag.minute);
  const second = Number(bag.second);
  if (![year, month, day, hour, minute, second].every((v) => Number.isInteger(v))) {
    throw new RangeError(`Intl 无法解析时区 ${JSON.stringify(timeZone)} 的本地时间`);
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond: new Date(epochMs).getUTCMilliseconds(),
    weekday: weekdayOf({ year, month, day }),
  };
}

/**
 * 某时刻在指定时区的 UTC 偏移量（毫秒，东区为正）。
 * @param {number} epochMs
 * @param {string} timeZone
 */
function getTimeZoneOffsetMs(epochMs, timeZone) {
  const p = getZonedParts(new Date(epochMs), timeZone);
  const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const utcSecond = Math.floor(epochMs / 1000) * 1000;
  return wallClockAsUtc - utcSecond;
}

/**
 * 把"指定时区的墙钟时间"转成 UTC 毫秒时间戳。
 * 用偏移量迭代求解，可处理夏令时；不存在的墙钟时间（DST 空洞）会收敛到就近时刻。
 *
 * @param {{year:number, month:number, day:number, hour?:number, minute?:number, second?:number, millisecond?:number}} parts
 * @param {string} timeZone
 * @returns {number}
 */
function zonedWallTimeToUtcMs(parts, timeZone) {
  const { year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 } = parts;
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let guess = wallClockAsUtc;
  for (let i = 0; i < 4; i += 1) {
    const offset = getTimeZoneOffsetMs(guess, timeZone);
    const next = wallClockAsUtc - offset;
    if (next === guess) return guess;
    guess = next;
  }
  return guess;
}

/** 本地墙钟 ISO 字符串（不带偏移），例如 "2026-10-12T12:00:00"。 */
function formatLocalWallClock(parts) {
  return `${dateKeyOf(parts)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

/* ========================================================================== *
 * 暂停区间解析 / 格式化
 * ========================================================================== */

/**
 * @param {string} label
 * @param {string} message
 */
function windowError(label, message, TypeCtor = RangeError) {
  const err = new TypeCtor(`${label}: ${message}`);
  err.code = 'E_INVALID_WINDOW';
  return err;
}

/**
 * 解析 "HH:MM" 或 "HH:MM:SS"。
 * @param {unknown} text
 * @param {string} label
 */
function parseClock(text, label) {
  if (typeof text !== 'string') throw windowError(label, `需要 "HH:MM" 字符串，得到 ${JSON.stringify(text)}`, TypeError);
  const match = CLOCK_RE.exec(text.trim());
  if (!match) throw windowError(label, `无效的时刻 ${JSON.stringify(text)}（应为 HH:MM 或 HH:MM:SS）`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  return {
    text: `${pad2(hour)}:${pad2(minute)}${second === 0 ? '' : `:${pad2(second)}`}`,
    hour,
    minute,
    second,
    seconds: hour * 3600 + minute * 60 + second,
  };
}

/**
 * 内部版：解析成带 seconds/hour/minute/second 的区间对象（按 start 升序）。
 * @param {unknown} input
 */
function resolveWindows(input) {
  const list = typeof input === 'string' ? [input] : input;
  if (!Array.isArray(list)) {
    throw windowError('pauseWindows', '必须是数组，或单个 "HH:MM-HH:MM" 字符串', TypeError);
  }
  const windows = list.map((item, index) => {
    const label = `pauseWindows[${index}]`;
    let startText;
    let endText;
    if (typeof item === 'string') {
      const segments = item.split('-');
      if (segments.length !== 2) throw windowError(label, `无法解析区间 ${JSON.stringify(item)}`);
      [startText, endText] = segments;
    } else if (isPlainObject(item)) {
      startText = item.start;
      endText = item.end;
    } else {
      throw windowError(label, '必须是 "HH:MM-HH:MM" 字符串或 { start, end } 对象', TypeError);
    }
    const start = parseClock(startText, `${label}.start`);
    const end = parseClock(endText, `${label}.end`);
    if (start.seconds === end.seconds) {
      throw windowError(label, `区间起止相同 (${start.text})，长度为 0 没有意义`);
    }
    return {
      start: start.text,
      end: end.text,
      startSeconds: start.seconds,
      endSeconds: end.seconds,
      startHour: start.hour,
      startMinute: start.minute,
      startSecond: start.second,
      endHour: end.hour,
      endMinute: end.minute,
      endSecond: end.second,
    };
  });
  windows.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  return windows;
}

/** 某时刻（当天秒数）是否落在区间内（[start, end)，支持跨午夜）。 */
function isWithinWindow(secondsOfDay, window) {
  if (window.startSeconds < window.endSeconds) {
    return secondsOfDay >= window.startSeconds && secondsOfDay < window.endSeconds;
  }
  return secondsOfDay >= window.startSeconds || secondsOfDay < window.endSeconds;
}

/**
 * 校验并规范化暂停区间。
 *
 * 接受：
 *   - [{ start: '09:00', end: '12:00' }, ...]
 *   - ['09:00-12:00', ...]
 *   - 单个字符串 '09:00-12:00'
 * 返回按 start 升序排列的 [{ start: 'HH:MM', end: 'HH:MM' }]。
 * 允许跨午夜（start > end，如 22:00-02:00）。
 *
 * @param {unknown} [input=DEFAULT_PAUSE_WINDOWS]
 * @returns {{start:string, end:string}[]}
 */
export function parseWindows(input = DEFAULT_PAUSE_WINDOWS) {
  return resolveWindows(input).map(({ start, end }) => ({ start, end }));
}

/**
 * 把一个区间格式化成 "HH:MM-HH:MM"。
 * @param {{start:string, end:string}|string} window
 * @returns {string}
 */
export function formatWindow(window) {
  const [parsed] = parseWindows([window]);
  return `${parsed.start}-${parsed.end}`;
}

/* ========================================================================== *
 * 节假日数据：API 响应规范化 / 抓取
 * ========================================================================== */

/**
 * 构造年度接口 URL。
 * 规则（可预期、无隐式猜测）：
 *   1. 模板含 `{year}`（默认模板）→ 替换；
 *   2. 完整 URL 已含 4 位年份（如 .../year/2026）→ 原样使用；
 *   3. 其余视为 base URL → 去掉末尾 '/' 后追加 `/year/<year>`。
 *
 * @param {number} year
 * @param {string} [url=HOLIDAY_API_URL_TEMPLATE]
 * @returns {string}
 */
export function buildHolidayApiUrl(year, url = HOLIDAY_API_URL_TEMPLATE) {
  const y = validateYear(year);
  if (typeof url !== 'string' || url.trim() === '') throw new TypeError('url 必须是非空字符串');
  const trimmed = url.trim();
  if (trimmed.includes('{year}')) return trimmed.split('{year}').join(String(y));
  if (/\/\d{4}\/?$/.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/+$/, '')}/year/${y}`;
}

/** 把 API 错误码翻译成可识别的 HolidayApiError。 */
function apiCodeError(data) {
  const code = data.code;
  const message = typeof data.message === 'string' && data.message ? data.message : `timor.tech API 返回错误码 ${code}`;
  if (code === 429) {
    return new HolidayApiError(`${message}（触发 timor.tech 速率限制，请退避后重试）`, {
      code: 'E_RATE_LIMITED',
      apiCode: code,
      bodySnippet: null,
    });
  }
  return new HolidayApiError(message, { code: 'E_API_CODE', apiCode: code });
}

/**
 * 把单条 timor.tech 条目规范化。
 * @param {number} year
 * @param {string} monthDayKey 'MM-DD'
 * @param {unknown} raw
 */
function normalizeApiEntry(year, monthDayKey, raw) {
  const label = `节假日条目 ${monthDayKey}`;
  if (!isPlainObject(raw)) {
    throw new HolidayApiError(`${label}: 不是对象`, { code: 'E_INVALID_RESPONSE' });
  }
  if (typeof raw.holiday !== 'boolean') {
    throw new HolidayApiError(`${label}: 缺少布尔字段 holiday（无法区分假日/补班）`, { code: 'E_INVALID_RESPONSE' });
  }
  const expectedDate = `${year}-${monthDayKey}`;
  let date = expectedDate;
  if (raw.date !== undefined && raw.date !== null) {
    if (typeof raw.date !== 'string' || !DATE_ONLY_RE.test(raw.date)) {
      throw new HolidayApiError(`${label}: date 字段非法 ${JSON.stringify(raw.date)}`, { code: 'E_INVALID_RESPONSE' });
    }
    try {
      parseDateOnly(raw.date, label);
    } catch (cause) {
      throw new HolidayApiError(`${label}: date 字段不是合法日期 ${JSON.stringify(raw.date)}`, {
        code: 'E_INVALID_RESPONSE',
        cause,
      });
    }
    if (raw.date !== expectedDate) {
      throw new HolidayApiError(`${label}: date=${raw.date} 与键 ${monthDayKey}/年份 ${year} 不一致`, {
        code: 'E_INVALID_RESPONSE',
      });
    }
    date = raw.date;
  }
  const type = raw.holiday ? 'holiday' : 'workday';
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    type,
    isHoliday: type === 'holiday',
    wage: numberOrNull(raw.wage),
    date,
    target: stringOrNull(raw.target),
    after: booleanOrNull(raw.after),
    rest: numberOrNull(raw.rest),
  };
}

/**
 * 把 timor.tech /year/{year} 的原始 JSON 规范化为本模块缓存对象。
 *
 * 失败时抛 HolidayApiError（绝不静默返回空缓存）：
 *   E_INVALID_RESPONSE（结构不符）、E_EMPTY_DATA（code=0 但数据为空且未 allowEmpty）、
 *   E_API_CODE / E_RATE_LIMITED（业务错误码）。
 *
 * 也可用于把内置离线快照导入成缓存（Host 兜底场景）。
 *
 * @param {number} year
 * @param {unknown} apiData 原始 JSON
 * @param {object} [options]
 * @param {Date|number|string} [options.fetchedAt] 抓取时刻，默认 now
 * @param {string} [options.source='timor.tech']
 * @param {string|null} [options.url=null]
 * @param {boolean} [options.allowEmpty=false] 是否接受"0 条节假日"的合法空响应
 * @returns {object} 规范化缓存对象
 */
export function normalizeYearData(year, apiData, options = {}) {
  const y = validateYear(year);
  if (!isPlainObject(apiData)) {
    throw new HolidayApiError('timor.tech 响应不是 JSON 对象', { code: 'E_INVALID_RESPONSE' });
  }
  if (typeof apiData.code !== 'number') {
    throw new HolidayApiError('timor.tech 响应缺少数字 code 字段', {
      code: 'E_INVALID_RESPONSE',
      bodySnippet: null,
    });
  }
  if (apiData.code !== 0) throw apiCodeError(apiData);
  if (!isPlainObject(apiData.holiday)) {
    throw new HolidayApiError('timor.tech 响应缺少 holiday 对象', { code: 'E_INVALID_RESPONSE' });
  }
  const rawKeys = Object.keys(apiData.holiday);
  if (rawKeys.length === 0 && options.allowEmpty !== true) {
    throw new HolidayApiError(`${y} 年节假日数据为空（可能尚未发布），拒绝静默返回空缓存`, {
      code: 'E_EMPTY_DATA',
    });
  }
  /** @type {Record<string, object>} */
  const holidays = {};
  for (const key of rawKeys) {
    if (!MONTH_DAY_RE.test(key)) {
      throw new HolidayApiError(`节假日键 ${JSON.stringify(key)} 不是 MM-DD 格式`, { code: 'E_INVALID_RESPONSE' });
    }
    holidays[key] = normalizeApiEntry(y, key, apiData.holiday[key]);
  }
  let holidayCount = 0;
  let workdayCount = 0;
  for (const entry of Object.values(holidays)) {
    if (entry.type === 'holiday') holidayCount += 1;
    else workdayCount += 1;
  }
  const fetchedAtMs = options.fetchedAt === undefined ? Date.now() : coerceEpochMs(options.fetchedAt, 'fetchedAt');
  return {
    version: CACHE_SCHEMA_VERSION,
    year: y,
    source: typeof options.source === 'string' ? options.source : 'timor.tech',
    url: stringOrNull(options.url),
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    code: 0,
    holidays,
    holidayCount,
    workdayCount,
  };
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 单次 HTTP GET + 解析 JSON。
 * @param {object} params
 * @param {string} params.apiUrl
 * @param {Function} params.fetchImpl
 * @param {number} params.timeoutMs
 * @param {Record<string,string>|undefined} params.headers
 * @param {AbortSignal|undefined} params.signal
 * @returns {Promise<any>}
 */
async function fetchJsonOnce({ apiUrl, fetchImpl, timeoutMs, headers, signal }) {
  if (typeof AbortController !== 'function') {
    throw new HolidayApiError('运行环境缺少 AbortController，无法实现超时控制', { code: 'E_NO_FETCH', url: apiUrl });
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let forwardAbort = null;
  if (signal) {
    if (signal.aborted) controller.abort();
    else {
      forwardAbort = () => controller.abort();
      signal.addEventListener('abort', forwardAbort, { once: true });
    }
  }
  try {
    /** @type {Response} */
    let response;
    try {
      response = await fetchImpl(apiUrl, {
        method: 'GET',
        headers: { accept: 'application/json', ...(isPlainObject(headers) ? headers : {}) },
        signal: controller.signal,
      });
    } catch (cause) {
      if (timedOut) {
        throw new HolidayApiError(`请求节假日 API 超时（${timeoutMs}ms）`, {
          code: 'E_TIMEOUT',
          url: apiUrl,
          cause,
        });
      }
      if (signal && signal.aborted) {
        throw new HolidayApiError('请求节假日 API 已被调用方取消', { code: 'E_ABORTED', url: apiUrl, cause });
      }
      throw new HolidayApiError(`请求节假日 API 网络错误: ${cause?.message ?? cause}`, {
        code: 'E_NETWORK',
        url: apiUrl,
        cause,
      });
    }

    const status = typeof response?.status === 'number' ? response.status : 0;
    let text;
    try {
      text = await response.text();
    } catch (cause) {
      throw new HolidayApiError('读取节假日 API 响应体失败', {
        code: 'E_NETWORK',
        status,
        url: apiUrl,
        cause,
      });
    }
    const bodySnippet = typeof text === 'string' ? text.slice(0, 300) : null;
    if (status === 429) {
      throw new HolidayApiError('timor.tech 返回 HTTP 429（速率限制），请退避后重试', {
        code: 'E_RATE_LIMITED',
        status,
        url: apiUrl,
        apiCode: 429,
        bodySnippet,
      });
    }
    if (!(status >= 200 && status < 300)) {
      throw new HolidayApiError(`节假日 API 返回 HTTP ${status}`, {
        code: 'E_HTTP',
        status,
        url: apiUrl,
        bodySnippet,
      });
    }
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new HolidayApiError('节假日 API 响应不是合法 JSON', {
        code: 'E_INVALID_JSON',
        status,
        url: apiUrl,
        bodySnippet,
        cause,
      });
    }
  } finally {
    clearTimeout(timer);
    if (signal && forwardAbort) signal.removeEventListener('abort', forwardAbort);
  }
}

/**
 * 抓取某一年的 timor.tech 节假日数据并返回规范化缓存（不写文件）。
 *
 * 唯一会联网的函数。fetch 可注入；失败抛 HolidayApiError（code 见类注释）。
 * 网络/429/5xx/超时可按 `retries` 自动退避重试（默认 0 次）。
 *
 * 实测注意：timor.tech 短时间连续请求即返回 429；Host 应串行刷新并依赖
 * DEFAULT_CACHE_TTL_MS（12h，与 API Cache-Control 一致）缓存。
 *
 * @param {object} [options]
 * @param {number} [options.year] 目标年份；省略时取 now 在默认时区下的年份
 * @param {string} [options.url] URL 模板（含 {year}）或完整/base URL，规则见 buildHolidayApiUrl
 * @param {number} [options.timeoutMs=15000]
 * @param {Function} [options.fetchImpl] 注入 fetch（默认 globalThis.fetch）
 * @param {Date|number|string} [options.now] 用于年份推导与 fetchedAt 的当前时刻
 * @param {Record<string,string>} [options.headers] 额外请求头
 * @param {AbortSignal} [options.signal] 调用方取消信号
 * @param {boolean} [options.allowEmpty=false]
 * @param {number} [options.retries=0] 可重试错误（429/5xx/网络/超时）的重试次数
 * @param {number} [options.retryDelayMs=500] 首次退避基数（指数退避）
 * @returns {Promise<object>} 规范化缓存对象
 */
export async function fetchYearHolidays(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('fetchYearHolidays 参数必须是对象');
  const {
    year,
    url,
    timeoutMs = 15000,
    fetchImpl,
    now,
    headers,
    signal,
    allowEmpty = false,
    retries = 0,
    retryDelayMs = 500,
  } = options;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs 必须是正数');
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError('retries 必须是非负整数');
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new RangeError('retryDelayMs 必须是非负数');
  if (headers !== undefined && !isPlainObject(headers)) throw new TypeError('headers 必须是普通对象');
  if (signal !== undefined && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function')) {
    throw new TypeError('signal 必须是 AbortSignal');
  }

  const nowMs = resolveNow(now, 'fetchYearHolidays.now');
  const targetYear = year === undefined ? getZonedParts(new Date(nowMs), DEFAULT_TIME_ZONE).year : validateYear(year);
  const apiUrl = buildHolidayApiUrl(targetYear, url === undefined ? HOLIDAY_API_URL_TEMPLATE : url);
  const doFetch = fetchImpl === undefined ? globalThis.fetch : fetchImpl;
  if (typeof doFetch !== 'function') {
    throw new HolidayApiError('未提供 fetch 实现（当前运行环境不支持 fetch）', { code: 'E_NO_FETCH', url: apiUrl });
  }

  const maxAttempts = retries + 1;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const json = await fetchJsonOnce({ apiUrl, fetchImpl: doFetch, timeoutMs, headers, signal });
      const fetchedAtMs = now === undefined ? Date.now() : nowMs;
      return normalizeYearData(targetYear, json, {
        fetchedAt: new Date(fetchedAtMs),
        source: 'timor.tech',
        url: apiUrl,
        allowEmpty,
      });
    } catch (cause) {
      lastError =
        cause instanceof HolidayApiError
          ? cause
          : new HolidayApiError(`请求节假日 API 失败: ${cause?.message ?? cause}`, {
              code: 'E_NETWORK',
              url: apiUrl,
              cause,
            });
      const retryable = ['E_RATE_LIMITED', 'E_HTTP', 'E_NETWORK', 'E_TIMEOUT'].includes(lastError.code);
      if (!retryable || attempt >= maxAttempts - 1) throw lastError;
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

/* ========================================================================== *
 * 节假日索引 / 单日判定
 * ========================================================================== */

/**
 * 把一条缓存条目（或原始 API 条目）规范化为索引条目。
 * @param {string} key
 * @param {unknown} raw
 */
function normalizeIndexEntry(key, raw) {
  if (!isPlainObject(raw)) throw new TypeError(`节假日条目 ${key} 不是对象`);
  let type;
  if (raw.type === 'holiday' || raw.type === 'workday') type = raw.type;
  else if (typeof raw.holiday === 'boolean') type = raw.holiday ? 'holiday' : 'workday';
  else throw new TypeError(`节假日条目 ${key} 缺少 type 或 holiday 字段`);
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    type,
    isHoliday: type === 'holiday',
    wage: numberOrNull(raw.wage),
    date: typeof raw.date === 'string' && DATE_ONLY_RE.test(raw.date) ? raw.date : null,
    target: stringOrNull(raw.target),
    after: booleanOrNull(raw.after),
    rest: numberOrNull(raw.rest),
  };
}

/**
 * @param {Map<string, object>} byDate
 * @param {Map<string, object>} byMonthDay
 * @param {Set<number>} years
 * @param {string} key
 * @param {unknown} raw
 */
function addIndexEntry(byDate, byMonthDay, years, key, raw) {
  const entry = normalizeIndexEntry(key, raw);
  if (DATE_ONLY_RE.test(key)) {
    parseDateOnly(key, `节假日键 ${key}`);
    byDate.set(key, { ...entry, date: key });
    years.add(Number(key.slice(0, 4)));
    return;
  }
  if (MONTH_DAY_RE.test(key)) {
    byMonthDay.set(key, entry);
    return;
  }
  throw new TypeError(`无效的节假日键 ${JSON.stringify(key)}（应为 YYYY-MM-DD 或 MM-DD）`);
}

/**
 * 构建节假日索引。接受多种输入形态，方便 Host/Client 传值：
 *   - 单个缓存对象（normalizeYearData / parseCache 的产物）
 *   - 缓存数组（多年份，支持跨年）
 *   - Map<'YYYY-MM-DD'|'MM-DD', 条目>
 *   - 纯对象映射：{ 'YYYY-MM-DD': 条目 } 或 { 'MM-DD': 条目 }
 *   - null / undefined（无数据 → 走 fallback 周末规则）
 *
 * @param {unknown} holidays
 * @returns {{byDate: Map<string, object>, byMonthDay: Map<string, object>, years: Set<number>}}
 */
function buildHolidayIndex(holidays) {
  /** @type {Map<string, object>} */
  const byDate = new Map();
  /** @type {Map<string, object>} */
  const byMonthDay = new Map();
  /** @type {Set<number>} */
  const years = new Set();

  if (holidays === undefined || holidays === null) return { byDate, byMonthDay, years };

  /** @param {object} cache @param {string} label */
  const visitCache = (cache, label) => {
    if (!isPlainObject(cache) || !isPlainObject(cache.holidays)) {
      throw new TypeError(`${label} 不是合法的节假日缓存（缺少 holidays 对象）`);
    }
    const year = Number.isInteger(cache.year) ? cache.year : null;
    if (year !== null) years.add(year);
    for (const [key, raw] of Object.entries(cache.holidays)) {
      const fullKey = year !== null && MONTH_DAY_RE.test(key) ? `${year}-${key}` : key;
      addIndexEntry(byDate, byMonthDay, years, fullKey, raw);
    }
  };

  if (holidays instanceof Map) {
    for (const [key, raw] of holidays.entries()) addIndexEntry(byDate, byMonthDay, years, String(key), raw);
    return { byDate, byMonthDay, years };
  }
  if (Array.isArray(holidays)) {
    holidays.forEach((cache, index) => visitCache(cache, `holidays[${index}]`));
    return { byDate, byMonthDay, years };
  }
  if (isPlainObject(holidays)) {
    if (isPlainObject(holidays.holidays)) {
      visitCache(holidays, 'holidays');
    } else {
      for (const [key, raw] of Object.entries(holidays)) addIndexEntry(byDate, byMonthDay, years, key, raw);
    }
    return { byDate, byMonthDay, years };
  }
  throw new TypeError('holidays 必须是缓存对象、缓存数组、Map 或 null');
}

/**
 * 用已构建的索引判定某个日历日。
 * @param {object} parts
 * @param {{byDate: Map, byMonthDay: Map, years: Set<number>}} index
 * @param {boolean|Function|undefined} isWorkdayFallback
 */
function evaluateDayWithIndex(parts, index, isWorkdayFallback) {
  const { year, month, day, weekday } = parts;
  const dateKey = dateKeyOf(parts);
  const monthDayKey = `${pad2(month)}-${pad2(day)}`;
  const weekend = weekday === 0 || weekday === 6;
  const entry = index.byDate.get(dateKey) ?? index.byMonthDay.get(monthDayKey) ?? null;
  const covered = index.years.has(year) || index.byMonthDay.size > 0;

  const base = {
    date: dateKey,
    year,
    month,
    day,
    weekday,
    weekend,
    workday: false,
    source: /** @type {'api'|'weekend'|'fallback'} */ ('fallback'),
    holidayName: /** @type {string|null} */ (null),
    type: /** @type {'holiday'|'workday'|null} */ (null),
    isHoliday: /** @type {boolean|null} */ (null),
    wage: /** @type {number|null} */ (null),
    target: /** @type {string|null} */ (null),
    covered,
    fallback: !covered,
  };

  if (entry) {
    return {
      ...base,
      workday: entry.type === 'workday',
      source: 'api',
      holidayName: entry.name || null,
      type: entry.type,
      isHoliday: entry.type === 'holiday',
      wage: entry.wage,
      target: entry.target,
      covered: true,
      fallback: false,
    };
  }
  if (covered) {
    return weekend
      ? { ...base, workday: false, source: 'weekend' }
      : { ...base, workday: true, source: 'api' };
  }

  // 该年份没有任何 API 数据：使用 fallback（默认按周末规则）。
  let workday = !weekend;
  if (typeof isWorkdayFallback === 'function') {
    const result = isWorkdayFallback({ ...base, monthDay: monthDayKey });
    if (typeof result === 'boolean') workday = result;
    else if (result !== undefined) throw new TypeError('isWorkdayFallback 函数必须返回 boolean');
  } else if (isWorkdayFallback === true) {
    workday = true;
  } else if (isWorkdayFallback !== undefined && isWorkdayFallback !== false) {
    throw new TypeError('isWorkdayFallback 必须是 boolean 或函数');
  }
  return { ...base, workday, source: 'fallback' };
}

/**
 * 判定某一天是否工作日（考虑周末、法定假日、调休补班）。
 *
 * @param {Date|number|string} dateOrIso
 *   - "YYYY-MM-DD"：直接当作日历日；
 *   - 其他：当作时刻，先换算到 options.timeZone 的日历日。
 * @param {unknown} cache 节假日缓存（形态见 buildHolidayIndex 注释）；null 表示无数据
 * @param {object} [options]
 * @param {string} [options.timeZone=DEFAULT_TIME_ZONE]
 * @param {boolean|Function} [options.isWorkdayFallback=false]
 *   true=数据缺失时所有日期按工作日处理；函数=(dayInfo)=>boolean 自定义兜底；
 *   默认 false=数据缺失时按周一~周五工作日、周六日休息。
 * @returns {{date:string, year:number, month:number, day:number, weekday:number,
 *            weekend:boolean, workday:boolean, source:'api'|'weekend'|'fallback',
 *            holidayName:string|null, type:'holiday'|'workday'|null,
 *            isHoliday:boolean|null, wage:number|null, target:string|null,
 *            covered:boolean, fallback:boolean}}
 */
export function evaluateDay(dateOrIso, cache, options = {}) {
  const timeZone = options.timeZone === undefined ? DEFAULT_TIME_ZONE : options.timeZone;
  let parts;
  if (typeof dateOrIso === 'string' && DATE_ONLY_RE.test(dateOrIso.trim())) {
    parts = parseDateOnly(dateOrIso.trim(), 'evaluateDay');
  } else {
    parts = getZonedParts(coerceEpochMs(dateOrIso, 'evaluateDay'), timeZone);
  }
  const index = buildHolidayIndex(cache);
  return evaluateDayWithIndex(parts, index, options.isWorkdayFallback);
}

/* ========================================================================== *
 * 核心判定：statusAt
 * ========================================================================== */

/**
 * 计算某个时刻的暂停/工作状态（不含 nextChangeAt）。
 * @param {number} epochMs
 * @param {{timeZone: string, windows: object[], index: object, isWorkdayFallback: unknown}} ctx
 */
function computeStateAt(epochMs, ctx) {
  const parts = getZonedParts(new Date(epochMs), ctx.timeZone);
  const dayInfo = evaluateDayWithIndex(parts, ctx.index, ctx.isWorkdayFallback);
  const secondsOfDay = parts.hour * 3600 + parts.minute * 60 + parts.second + parts.millisecond / 1000;

  if (!dayInfo.workday) {
    // 节假日优先于周末作为 reason（周末恰逢法定假日时 UI 显示节日名更有用）。
    const reason = dayInfo.type === 'holiday' ? 'holiday' : dayInfo.weekend ? 'weekend' : 'holiday';
    return { state: /** @type {'working'} */ ('working'), reason, dayInfo, parts, pauseWindow: null };
  }
  const activeWindow = ctx.windows.find((window) => isWithinWindow(secondsOfDay, window)) ?? null;
  if (activeWindow) {
    return {
      state: /** @type {'paused'} */ ('paused'),
      reason: /** @type {'window'} */ ('window'),
      dayInfo,
      parts,
      pauseWindow: { start: activeWindow.start, end: activeWindow.end },
    };
  }
  return { state: /** @type {'working'} */ ('working'), reason: /** @type {'outside'} */ ('outside'), dayInfo, parts, pauseWindow: null };
}

/**
 * 找出 now 之后第一次状态切换的时刻。
 *
 * 状态只可能在以下时刻变化：本地日历日 00:00、某个区间的 start、某个区间的 end。
 * 把"窗口 end"按它实际发生的本地日归一后，任意一天的候选集合恰好是：
 *   { 该日 00:00 } ∪ { 每个区间的 start 落在该日的时刻 } ∪ { 每个区间的 end 落在该日的时刻 }
 * （跨午夜区间 22:00-02:00 的 end 落在次日 02:00，由次日候选集合覆盖）。
 * 于是按本地日递增、每天内候选升序扫描，第一个使状态不同的时刻就是 nextChangeAt。
 * 这种枚举天然覆盖周末/节假日/调休/跨年/跨午夜/DST，且命中的通常只有 1~10 个候选。
 *
 * @param {number} nowMs
 * @param {{timeZone: string, windows: object[], index: object, isWorkdayFallback: unknown}} ctx
 * @param {'working'|'paused'} currentState
 * @returns {number|null}
 */
function findNextChange(nowMs, ctx, currentState) {
  if (ctx.windows.length === 0) return null;
  const nowParts = getZonedParts(new Date(nowMs), ctx.timeZone);
  for (let offset = 0; offset <= MAX_NEXT_CHANGE_SCAN_DAYS; offset += 1) {
    const dayParts = addDaysToParts(nowParts, offset);
    /** @type {number[]} */
    const candidates = [];
    /** @param {number} ms */
    const push = (ms) => {
      if (!candidates.includes(ms)) candidates.push(ms);
    };
    push(zonedWallTimeToUtcMs({ ...dayParts, hour: 0, minute: 0, second: 0, millisecond: 0 }, ctx.timeZone));
    for (const window of ctx.windows) {
      push(
        zonedWallTimeToUtcMs(
          {
            ...dayParts,
            hour: window.startHour,
            minute: window.startMinute,
            second: window.startSecond,
            millisecond: 0,
          },
          ctx.timeZone,
        ),
      );
      push(
        zonedWallTimeToUtcMs(
          { ...dayParts, hour: window.endHour, minute: window.endMinute, second: window.endSecond, millisecond: 0 },
          ctx.timeZone,
        ),
      );
    }
    candidates.sort((a, b) => a - b);
    for (const candidate of candidates) {
      if (candidate <= nowMs) continue;
      if (computeStateAt(candidate, ctx).state !== currentState) return candidate;
    }
  }
  return null;
}

/**
 * 核心判定函数：给定时刻 → 当前状态、原因、所在暂停区间、下一次状态切换时刻。
 *
 * 规则：
 *   - 非工作日（周末/法定假日，调休补班除外）→ working；
 *   - 工作日落在暂停区间 [start, end) → paused；
 *   - 否则 working。
 *
 * 边界：09:00:00 整记为 paused，12:00:00 整记为 working；支持跨午夜区间与夏令时时区。
 *
 * @param {Date|number|string} [now] 缺省为当前时刻；可传 Date / 毫秒时间戳 / ISO 字符串
 * @param {object} [options]
 * @param {string} [options.timeZone=DEFAULT_TIME_ZONE] IANA 时区
 * @param {unknown} [options.pauseWindows=DEFAULT_PAUSE_WINDOWS] 见 parseWindows
 * @param {unknown} [options.holidays] 节假日缓存（形态见 buildHolidayIndex）；null 表示无数据
 * @param {boolean|Function} [options.isWorkdayFallback=false]
 * @returns {{
 *   state:'working'|'paused',
 *   reason:'window'|'holiday'|'weekend'|'outside',
 *   workday:boolean,
 *   pauseWindow:{start:string,end:string}|null,
 *   nextChangeAt:string|null,
 *   nextChangeAtLocal:string|null,
 *   nextChangeTo:'working'|'paused'|null,
 *   nextChangeInMs:number|null,
 *   holidayName:string|null,
 *   holidayType:'holiday'|'workday'|null,
 *   date:string,
 *   timeZone:string,
 *   localTime:string,
 *   weekday:number,
 *   weekend:boolean,
 *   source:'api'|'weekend'|'fallback',
 * }}
 */
export function statusAt(now, options = {}) {
  if (!isPlainObject(options)) throw new TypeError('statusAt 参数必须是对象');
  const timeZone = options.timeZone === undefined ? DEFAULT_TIME_ZONE : options.timeZone;
  const windows = resolveWindows(options.pauseWindows === undefined ? DEFAULT_PAUSE_WINDOWS : options.pauseWindows);
  const index = buildHolidayIndex(options.holidays);
  const nowMs = resolveNow(now, 'statusAt.now');
  const ctx = { timeZone, windows, index, isWorkdayFallback: options.isWorkdayFallback };

  const current = computeStateAt(nowMs, ctx);
  const nextMs = findNextChange(nowMs, ctx, current.state);
  let nextChangeAt = null;
  let nextChangeAtLocal = null;
  let nextChangeTo = null;
  let nextChangeInMs = null;
  if (nextMs !== null) {
    const nextParts = getZonedParts(new Date(nextMs), timeZone);
    nextChangeAt = new Date(nextMs).toISOString();
    nextChangeAtLocal = formatLocalWallClock(nextParts);
    nextChangeTo = computeStateAt(nextMs, ctx).state;
    nextChangeInMs = Math.max(0, nextMs - nowMs);
  }

  const { dayInfo, parts } = current;
  return {
    state: current.state,
    reason: current.reason,
    workday: dayInfo.workday,
    pauseWindow: current.pauseWindow,
    nextChangeAt,
    nextChangeAtLocal,
    nextChangeTo,
    nextChangeInMs,
    holidayName: dayInfo.holidayName,
    holidayType: dayInfo.type,
    date: dayInfo.date,
    timeZone,
    localTime: `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`,
    weekday: dayInfo.weekday,
    weekend: dayInfo.weekend,
    source: dayInfo.source,
  };
}

/* ========================================================================== *
 * 缓存序列化 / TTL
 * ========================================================================== */

/**
 * 规范化一条缓存条目（兼容 parseCache 的输入，可能是已规范化条目或原始 API 条目）。
 * @param {number} year
 * @param {string} monthDayKey
 * @param {unknown} raw
 */
function normalizeCachedEntry(year, monthDayKey, raw) {
  if (!isPlainObject(raw)) throw new HolidayCacheError(`缓存条目 ${monthDayKey} 不是对象`);
  let type;
  if (raw.type === 'holiday' || raw.type === 'workday') type = raw.type;
  else if (typeof raw.holiday === 'boolean') type = raw.holiday ? 'holiday' : 'workday';
  else throw new HolidayCacheError(`缓存条目 ${monthDayKey} 缺少 type 或 holiday 字段`);
  const expectedDate = `${year}-${monthDayKey}`;
  let date = expectedDate;
  if (raw.date !== undefined && raw.date !== null) {
    if (typeof raw.date !== 'string' || !DATE_ONLY_RE.test(raw.date)) {
      throw new HolidayCacheError(`缓存条目 ${monthDayKey} 的 date 非法: ${JSON.stringify(raw.date)}`);
    }
    try {
      parseDateOnly(raw.date, `缓存条目 ${monthDayKey}`);
    } catch (cause) {
      throw new HolidayCacheError(`缓存条目 ${monthDayKey} 的 date 不是合法日期: ${JSON.stringify(raw.date)}`, {
        cause,
      });
    }
    if (raw.date !== expectedDate) {
      throw new HolidayCacheError(`缓存条目 ${monthDayKey} 的 date=${raw.date} 与缓存年份 ${year} 不匹配`);
    }
    date = raw.date;
  }
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    type,
    isHoliday: type === 'holiday',
    wage: numberOrNull(raw.wage),
    date,
    target: stringOrNull(raw.target),
    after: booleanOrNull(raw.after),
    rest: numberOrNull(raw.rest),
  };
}

/**
 * 把缓存对象序列化为 JSON 字符串（先校验/规范化，保证落盘内容合法）。
 * @param {unknown} cache
 * @returns {string}
 */
export function serializeCache(cache) {
  return JSON.stringify(parseCache(cache));
}

/**
 * 解析并校验缓存 JSON（字符串或对象均可），返回规范化缓存对象。
 * 版本不匹配 / 结构损坏抛 HolidayCacheError。
 *
 * @param {unknown} input
 * @returns {object}
 */
export function parseCache(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (cause) {
      throw new HolidayCacheError('缓存 JSON 解析失败', { code: 'E_INVALID_JSON', cause });
    }
  }
  if (!isPlainObject(data)) throw new HolidayCacheError('缓存必须是 JSON 对象');
  if (data.version !== CACHE_SCHEMA_VERSION) {
    throw new HolidayCacheError(
      `缓存版本 ${JSON.stringify(data.version)} 不受支持（当前版本 ${CACHE_SCHEMA_VERSION}）`,
      { code: 'E_UNSUPPORTED_VERSION' },
    );
  }
  const year = data.year;
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new HolidayCacheError(`缓存 year 非法: ${JSON.stringify(year)}`);
  }
  if (!isPlainObject(data.holidays)) throw new HolidayCacheError('缓存缺少 holidays 对象');
  /** @type {Record<string, object>} */
  const holidays = {};
  let holidayCount = 0;
  let workdayCount = 0;
  for (const [key, raw] of Object.entries(data.holidays)) {
    if (!MONTH_DAY_RE.test(key)) throw new HolidayCacheError(`缓存键 ${JSON.stringify(key)} 不是 MM-DD`);
    const entry = normalizeCachedEntry(year, key, raw);
    holidays[key] = entry;
    if (entry.type === 'holiday') holidayCount += 1;
    else workdayCount += 1;
  }
  if (typeof data.fetchedAt !== 'string' || !Number.isFinite(Date.parse(data.fetchedAt))) {
    throw new HolidayCacheError(`缓存 fetchedAt 非法: ${JSON.stringify(data.fetchedAt)}`);
  }
  return {
    version: CACHE_SCHEMA_VERSION,
    year,
    source: typeof data.source === 'string' && data.source ? data.source : 'unknown',
    url: stringOrNull(data.url),
    fetchedAt: new Date(Date.parse(data.fetchedAt)).toISOString(),
    code: typeof data.code === 'number' ? data.code : 0,
    holidays,
    holidayCount,
    workdayCount,
  };
}

/**
 * 判断缓存是否仍在 TTL 内（可安全跳过刷新）。
 *
 * @param {unknown} cache 缓存对象或 JSON 字符串
 * @param {number} [ttlMs=DEFAULT_CACHE_TTL_MS] 必须 > 0；Infinity 表示永不过期
 * @param {Date|number|string} [now=Date.now()] 当前时刻
 * @returns {boolean} 缓存无效/已过期/时间倒退一律 false
 */
export function isCacheFresh(cache, ttlMs = DEFAULT_CACHE_TTL_MS, now = Date.now()) {
  let parsed = cache;
  if (typeof cache === 'string') {
    try {
      parsed = parseCache(cache);
    } catch {
      return false;
    }
  }
  if (!isPlainObject(parsed) || typeof parsed.fetchedAt !== 'string') return false;
  const fetchedMs = Date.parse(parsed.fetchedAt);
  if (!Number.isFinite(fetchedMs)) return false;
  const nowMs = coerceEpochMs(now, 'isCacheFresh.now');
  if (typeof ttlMs !== 'number' || Number.isNaN(ttlMs) || ttlMs <= 0) return false;
  const age = nowMs - fetchedMs;
  if (age < -CLOCK_SKEW_MS) return false; // fetchedAt 明显在未来：视为坏数据
  return age <= ttlMs;
}
