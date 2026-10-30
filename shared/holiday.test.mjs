#!/usr/bin/env node
/**
 * holiday.test.mjs — holiday.mjs 的断言测试脚本（node 直接运行，零依赖）
 *
 * 运行：
 *   node shared/holiday.test.mjs                     # 离线确定性测试（默认）
 *   $env:HOLIDAY_LIVE='1'; node shared/holiday.test.mjs   # 额外跑一次 timor.tech 实测（可被 429 跳过）
 *
 * 覆盖：
 *   - API 响应规范化（使用 2026-10-30 实测的真实 JSON 夹具：33 假日 + 6 调休补班）
 *   - fetchYearHolidays 的 URL/请求头/超时/HTTP 错误/JSON 错误/429/重试/取消
 *   - evaluateDay：法定节假日、调休补班、普通周末、普通工作日、缺失数据兜底、跨年、时区
 *   - statusAt：默认暂停区间边界（09:00:00 / 12:00:00 / 14:00:00 / 18:00:00）、
 *     调休补班、节假日、周末、跨午夜区间、UTC/HK/NY 夏令时时区、nextChangeAt 精确值
 *   - parseWindows / formatWindow 校验
 *   - serializeCache / parseCache / isCacheFresh
 */

import assert from 'node:assert/strict';
import {
  CACHE_SCHEMA_VERSION,
  DEFAULT_TIME_ZONE,
  DEFAULT_PAUSE_WINDOWS,
  DEFAULT_CACHE_TTL_MS,
  HOLIDAY_API_URL_TEMPLATE,
  MAX_NEXT_CHANGE_SCAN_DAYS,
  HolidayApiError,
  HolidayCacheError,
  buildHolidayApiUrl,
  fetchYearHolidays,
  normalizeYearData,
  evaluateDay,
  statusAt,
  parseWindows,
  formatWindow,
  serializeCache,
  parseCache,
  isCacheFresh,
  getZonedParts,
} from './holiday.mjs';

/* ========================================================================== *
 * 测试迷你框架
 * ========================================================================== */

let passed = 0;
let failed = 0;
/** @type {{name:string, error:unknown}[]} */
const failures = [];

function group(title) {
  console.log(`\n${title}`);
}

/** @param {string} name @param {() => void} fn */
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
    console.log(String(error?.message ?? error).split('\n').map((line) => `       ${line}`).join('\n'));
  }
}

/** @param {string} name @param {() => Promise<void>} fn */
async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
    console.log(String(error?.message ?? error).split('\n').map((line) => `       ${line}`).join('\n'));
  }
}

function eq(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
}

function ok(value, message) {
  assert.ok(value, message);
}

/** 只校验对象的部分字段，便于断言 statusAt 结果。 */
function match(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    eq(actual[key], value, `${label}: 字段 ${key}`);
  }
}

/** @param {() => unknown} fn @param {string} code @param {string} label */
function throwsCode(fn, code, label) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  ok(caught, `${label}: 期望抛出错误，但没有`);
  eq(caught.code, code, `${label}: 期望 code=${code}，实际 ${caught.code} (${caught.message})`);
  return caught;
}

/** @param {() => Promise<unknown>} fn @param {string} code @param {string} label */
async function rejectsCode(fn, code, label) {
  let caught = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  ok(caught, `${label}: 期望抛出错误，但没有`);
  eq(caught.code, code, `${label}: 期望 code=${code}，实际 ${caught.code} (${caught.message})`);
  return caught;
}

/* ========================================================================== *
 * 夹具：2026 年真实 API 数据（2026-10-30 实测抓取，原样嵌入）
 * ========================================================================== */

const API_2026_JSON = String.raw`{"code":0,"holiday":{"01-01":{"holiday":true,"name":"元旦","wage":3,"date":"2026-01-01","rest":54},"01-02":{"holiday":true,"name":"元旦","wage":2,"date":"2026-01-02","rest":1},"01-03":{"holiday":true,"name":"元旦","wage":2,"date":"2026-01-03","rest":1},"01-04":{"holiday":false,"name":"元旦后补班","wage":1,"after":true,"target":"元旦","date":"2026-01-04","rest":1},"02-14":{"holiday":false,"name":"春节前补班","wage":1,"after":false,"target":"春节","date":"2026-02-14","rest":34},"02-15":{"holiday":true,"name":"春节","wage":2,"date":"2026-02-15","rest":35},"02-16":{"holiday":true,"name":"除夕","wage":3,"date":"2026-02-16","rest":1},"02-17":{"holiday":true,"name":"初一","wage":3,"date":"2026-02-17","rest":1},"02-18":{"holiday":true,"name":"初二","wage":3,"date":"2026-02-18","rest":1},"02-19":{"holiday":true,"name":"初三","wage":3,"date":"2026-02-19","rest":1},"02-20":{"holiday":true,"name":"初四","wage":2,"date":"2026-02-20","rest":1},"02-21":{"holiday":true,"name":"初五","wage":2,"date":"2026-02-21","rest":1},"02-22":{"holiday":true,"name":"初六","wage":2,"date":"2026-02-22","rest":1},"02-23":{"holiday":true,"name":"初七","wage":2,"date":"2026-02-23","rest":1},"02-28":{"holiday":false,"name":"春节后补班","wage":1,"target":"春节","after":true,"date":"2026-02-28","rest":5},"04-04":{"holiday":true,"name":"清明节","wage":2,"date":"2026-04-04","rest":4},"04-05":{"holiday":true,"name":"清明节","wage":3,"date":"2026-04-05","rest":1},"04-06":{"holiday":true,"name":"清明节","wage":2,"date":"2026-04-06","rest":1},"05-01":{"holiday":true,"name":"劳动节","wage":3,"date":"2026-05-01","rest":17},"05-02":{"holiday":true,"name":"劳动节","wage":3,"date":"2026-05-02","rest":1},"05-03":{"holiday":true,"name":"劳动节","wage":2,"date":"2026-05-03","rest":1},"05-04":{"holiday":true,"name":"劳动节","wage":2,"date":"2026-05-04","rest":1},"05-05":{"holiday":true,"name":"劳动节","wage":2,"date":"2026-05-05","rest":1},"05-09":{"holiday":false,"name":"劳动节后补班","wage":1,"after":true,"target":"劳动节","date":"2026-05-09","rest":1},"06-19":{"holiday":true,"name":"端午节","wage":3,"date":"2026-06-19","rest":14},"06-20":{"holiday":true,"name":"端午节","wage":2,"date":"2026-06-20","rest":1},"06-21":{"holiday":true,"name":"端午节","wage":2,"date":"2026-06-21","rest":1},"09-20":{"holiday":false,"name":"中秋节前补班","after":false,"wage":1,"target":"中秋节","date":"2026-09-20","rest":50},"09-25":{"holiday":true,"name":"中秋节","wage":3,"date":"2026-09-25","rest":55},"09-26":{"holiday":true,"name":"中秋节","wage":2,"date":"2026-09-26","rest":1},"09-27":{"holiday":true,"name":"中秋节","wage":2,"date":"2026-09-27","rest":1},"10-01":{"holiday":true,"name":"国庆节","wage":3,"date":"2026-10-01","rest":1},"10-02":{"holiday":true,"name":"国庆节","wage":3,"date":"2026-10-02","rest":1},"10-03":{"holiday":true,"name":"国庆节","wage":3,"date":"2026-10-03","rest":1},"10-04":{"holiday":true,"name":"国庆节","wage":2,"date":"2026-10-04","rest":1},"10-05":{"holiday":true,"name":"国庆节","wage":2,"date":"2026-10-05","rest":1},"10-06":{"holiday":true,"name":"国庆节","wage":2,"date":"2026-10-06","rest":1},"10-07":{"holiday":true,"name":"国庆节","wage":2,"date":"2026-10-07","rest":1},"10-10":{"holiday":false,"after":true,"wage":1,"name":"国庆节后补班","target":"国庆节","date":"2026-10-10"}}}`;

const API_2026 = JSON.parse(API_2026_JSON);
const FETCHED_AT = '2026-10-30T10:14:36.000Z';
const API_2026_URL = 'https://timor.tech/api/holiday/year/2026';

const cache2026 = normalizeYearData(2026, API_2026, { fetchedAt: FETCHED_AT, url: API_2026_URL });

// 合成的 2027 缓存：仅标记 2027-01-01 元旦（用于跨年 + 节假日测试；真实数据以 API 为准）。
const API_2027 = {
  code: 0,
  holiday: {
    '01-01': { holiday: true, name: '元旦', wage: 3, date: '2027-01-01', rest: 1 },
  },
};
const cache2027 = normalizeYearData(2027, API_2027, { fetchedAt: FETCHED_AT, url: 'https://timor.tech/api/holiday/year/2027' });

const HK = DEFAULT_TIME_ZONE;
const defaultBase = { timeZone: HK, holidays: cache2026 };

/* ========================================================================== *
 * 0. 夹具与常量自检
 * ========================================================================== */

group('0. 夹具与常量');

test('2026 夹具与原 API 一致：39 条（33 假日 + 6 补班）', () => {
  eq(Object.keys(API_2026.holiday).length, 39);
  eq(cache2026.holidayCount, 33);
  eq(cache2026.workdayCount, 6);
  eq(Object.keys(cache2026.holidays).length, 39);
});

test('常量：schema/时区/默认区间/TTL/URL 模板', () => {
  eq(CACHE_SCHEMA_VERSION, 1);
  eq(DEFAULT_TIME_ZONE, 'Asia/Hong_Kong');
  eq(DEFAULT_PAUSE_WINDOWS.map(formatWindow), ['09:00-12:00', '14:00-18:00']);
  eq(DEFAULT_CACHE_TTL_MS, 12 * 60 * 60 * 1000);
  eq(HOLIDAY_API_URL_TEMPLATE, 'https://timor.tech/api/holiday/year/{year}');
  ok(MAX_NEXT_CHANGE_SCAN_DAYS >= 30, '扫描窗口应足够覆盖长假');
});

/* ========================================================================== *
 * 1. getZonedParts（时区真相来源）
 * ========================================================================== */

group('1. getZonedParts 时区换算');

test('同一时刻在 HK / UTC 下的日历时间不同', () => {
  const instant = '2026-10-12T01:30:00Z';
  const hk = getZonedParts(instant, 'Asia/Hong_Kong');
  eq([hk.year, hk.month, hk.day, hk.hour, hk.minute, hk.second], [2026, 10, 12, 9, 30, 0]);
  eq(hk.weekday, 1); // 周一
  const utc = getZonedParts(instant, 'UTC');
  eq([utc.year, utc.month, utc.day, utc.hour], [2026, 10, 12, 1]);
});

test('午夜 hourCycle 归一为 0 点', () => {
  const p = getZonedParts('2026-10-11T16:00:00Z', 'Asia/Hong_Kong');
  eq([p.day, p.hour], [12, 0]);
});

test('非法时区抛 RangeError', () => {
  assert.throws(() => getZonedParts('2026-10-12T00:00:00Z', 'Not/AZone'), RangeError);
});

test('非法输入抛 TypeError', () => {
  assert.throws(() => getZonedParts('not-a-date', 'UTC'), TypeError);
  assert.throws(() => getZonedParts(Number.NaN, 'UTC'), TypeError);
});

/* ========================================================================== *
 * 2. normalizeYearData（API 响应 → 缓存）
 * ========================================================================== */

group('2. normalizeYearData：实测响应规范化');

test('缓存元数据（version/year/source/url/fetchedAt/code/计数）', () => {
  match(cache2026, {
    version: CACHE_SCHEMA_VERSION,
    year: 2026,
    source: 'timor.tech',
    url: API_2026_URL,
    fetchedAt: FETCHED_AT,
    code: 0,
    holidayCount: 33,
    workdayCount: 6,
  }, 'cache2026');
});

test('法定假日条目：10-01 国庆节（holiday:true → type holiday）', () => {
  eq(cache2026.holidays['10-01'], {
    name: '国庆节',
    type: 'holiday',
    isHoliday: true,
    wage: 3,
    date: '2026-10-01',
    target: null,
    after: null,
    rest: 1,
  });
});

test('调休补班条目：10-10 国庆节后补班（holiday:false → type workday）', () => {
  eq(cache2026.holidays['10-10'], {
    name: '国庆节后补班',
    type: 'workday',
    isHoliday: false,
    wage: 1,
    date: '2026-10-10',
    target: '国庆节',
    after: true,
    rest: null,
  });
});

test('调休补班条目保留 after/target/rest 原始字段', () => {
  match(cache2026.holidays['09-20'], { name: '中秋节前补班', type: 'workday', after: false, target: '中秋节', rest: 50 });
});

test('code=429 → E_RATE_LIMITED 且保留 apiCode', () => {
  const error = throwsCode(
    () => normalizeYearData(2026, { code: 429, message: 'too many requests', website: 'http://timor.tech/api/holiday' }),
    'E_RATE_LIMITED',
    'code=429',
  );
  ok(error instanceof HolidayApiError, '应为 HolidayApiError');
  eq(error.apiCode, 429);
});

test('code≠0 → E_API_CODE 并带上 message', () => {
  const error = throwsCode(() => normalizeYearData(2026, { code: 1, message: 'boom' }), 'E_API_CODE', 'code=1');
  eq(error.apiCode, 1);
  ok(error.message.includes('boom'), 'message 应透传');
});

test('空 holiday 默认抛 E_EMPTY_DATA（不静默返回空缓存）', () => {
  throwsCode(() => normalizeYearData(2027, { code: 0, holiday: {} }), 'E_EMPTY_DATA', '空数据');
});

test('allowEmpty:true 时接受空数据并生成合法缓存', () => {
  const cache = normalizeYearData(2027, { code: 0, holiday: {} }, { allowEmpty: true, fetchedAt: FETCHED_AT });
  eq(cache.holidays, {});
  eq(cache.holidayCount, 0);
  eq(cache.workdayCount, 0);
  eq(cache.year, 2027);
  ok(Number.isFinite(Date.parse(cache.fetchedAt)), 'fetchedAt 应为 ISO 字符串');
});

test('缺少 holiday 对象 → E_INVALID_RESPONSE', () => {
  throwsCode(() => normalizeYearData(2026, { code: 0 }), 'E_INVALID_RESPONSE', '缺 holiday');
});

test('缺少 code 数字字段 → E_INVALID_RESPONSE', () => {
  throwsCode(() => normalizeYearData(2026, { code: '0', holiday: {} }), 'E_INVALID_RESPONSE', 'code 非数字');
  throwsCode(() => normalizeYearData(2026, null), 'E_INVALID_RESPONSE', '非对象');
});

test('条目缺少布尔 holiday 字段 → E_INVALID_RESPONSE', () => {
  throwsCode(
    () => normalizeYearData(2026, { code: 0, holiday: { '01-01': { name: '元旦' } } }),
    'E_INVALID_RESPONSE',
    '缺 holiday 布尔',
  );
});

test('条目 date 与键/年份不一致 → E_INVALID_RESPONSE', () => {
  throwsCode(
    () => normalizeYearData(2026, { code: 0, holiday: { '01-01': { holiday: true, date: '2025-01-01' } } }),
    'E_INVALID_RESPONSE',
    'date 不一致',
  );
});

test('非法 MM-DD 键 → E_INVALID_RESPONSE', () => {
  throwsCode(
    () => normalizeYearData(2026, { code: 0, holiday: { '1-1': { holiday: true, date: '2026-01-01' } } }),
    'E_INVALID_RESPONSE',
    '非法键',
  );
});

test('非法年份 → RangeError 且 code=E_INVALID_YEAR', () => {
  assert.throws(() => normalizeYearData(1899, API_2026), (error) => error instanceof RangeError && error.code === 'E_INVALID_YEAR');
});

test('fetchedAt 接受 Date / 带偏移 ISO 并统一为 UTC ISO', () => {
  const withDate = normalizeYearData(2026, API_2026, { fetchedAt: new Date(FETCHED_AT) });
  eq(withDate.fetchedAt, FETCHED_AT);
  const withOffset = normalizeYearData(2026, API_2026, { fetchedAt: '2026-10-30T18:14:36+08:00' });
  eq(withOffset.fetchedAt, FETCHED_AT);
});

/* ========================================================================== *
 * 3. buildHolidayApiUrl
 * ========================================================================== */

group('3. buildHolidayApiUrl');

test('默认模板替换 {year}', () => {
  eq(buildHolidayApiUrl(2026), 'https://timor.tech/api/holiday/year/2026');
});

test('自定义模板替换 {year}', () => {
  eq(buildHolidayApiUrl(2027, 'https://example.com/api/holiday/year/{year}'), 'https://example.com/api/holiday/year/2027');
});

test('完整 URL（已含年份）原样使用', () => {
  eq(buildHolidayApiUrl(2026, 'https://timor.tech/api/holiday/year/2026'), 'https://timor.tech/api/holiday/year/2026');
});

test('base URL 追加 /year/<year>（容忍尾斜杠）', () => {
  eq(buildHolidayApiUrl(2026, 'https://timor.tech/api/holiday'), 'https://timor.tech/api/holiday/year/2026');
  eq(buildHolidayApiUrl(2026, 'https://timor.tech/api/holiday/'), 'https://timor.tech/api/holiday/year/2026');
});

test('非法年份抛 RangeError code=E_INVALID_YEAR', () => {
  assert.throws(() => buildHolidayApiUrl(1800), (error) => error.code === 'E_INVALID_YEAR');
});

/* ========================================================================== *
 * 4. fetchYearHolidays（注入 mock fetch，不联网）
 * ========================================================================== */

group('4. fetchYearHolidays（mock fetch）');

/** @param {unknown} payload @param {number} [status] */
function responseOf(payload, status = 200) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { status, text: async () => text };
}

function recordingFetch(handler) {
  /** @type {{url:string, init:any}[]} */
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  impl.calls = calls;
  return impl;
}

await testAsync('默认 URL + Accept 头 + now 作为 fetchedAt', async () => {
  const impl = recordingFetch(() => responseOf(API_2026));
  const cache = await fetchYearHolidays({ year: 2026, fetchImpl: impl, now: FETCHED_AT });
  eq(impl.calls.length, 1);
  eq(impl.calls[0].url, 'https://timor.tech/api/holiday/year/2026');
  eq(impl.calls[0].init.method, 'GET');
  eq(impl.calls[0].init.headers.accept, 'application/json');
  match(cache, { year: 2026, source: 'timor.tech', fetchedAt: FETCHED_AT, holidayCount: 33, workdayCount: 6 }, 'fetch 结果');
});

await testAsync('year 省略时按 now 在默认时区(HK)推导', async () => {
  const impl = recordingFetch(() => responseOf(API_2026));
  const cache = await fetchYearHolidays({ fetchImpl: impl, now: '2026-12-31T20:00:00+08:00' });
  eq(impl.calls[0].url, 'https://timor.tech/api/holiday/year/2026');
  eq(cache.year, 2026);
  // 同一时刻换成 UTC 已跨年（HK 2026-12-31 20:00 = UTC 12:00，仍是 2026；用另一时刻验证跨年）
  const impl2 = recordingFetch(() => responseOf(API_2027));
  const cache2 = await fetchYearHolidays({ fetchImpl: impl2, now: '2026-12-31T20:00:00Z' });
  eq(impl2.calls[0].url, 'https://timor.tech/api/holiday/year/2027');
  eq(cache2.year, 2027);
});

await testAsync('自定义模板 / 完整 URL / base URL', async () => {
  const cases = [
    ['https://example.com/h/{year}', 'https://example.com/h/2026'],
    ['https://example.com/h/2026', 'https://example.com/h/2026'],
    ['https://example.com/api/holiday', 'https://example.com/api/holiday/year/2026'],
  ];
  for (const [url, expected] of cases) {
    const impl = recordingFetch(() => responseOf(API_2026));
    await fetchYearHolidays({ year: 2026, url, fetchImpl: impl, now: FETCHED_AT });
    eq(impl.calls[0].url, expected, `url 模板 ${url}`);
  }
});

await testAsync('自定义请求头与默认 Accept 合并', async () => {
  const impl = recordingFetch(() => responseOf(API_2026));
  await fetchYearHolidays({ year: 2026, fetchImpl: impl, now: FETCHED_AT, headers: { 'x-test': '1' } });
  eq(impl.calls[0].init.headers['x-test'], '1');
  eq(impl.calls[0].init.headers.accept, 'application/json');
});

await testAsync('HTTP 500 → E_HTTP + status + 响应片段', async () => {
  const impl = recordingFetch(() => responseOf('upstream error', 500));
  const error = await rejectsCode(() => fetchYearHolidays({ year: 2026, fetchImpl: impl }), 'E_HTTP', 'HTTP 500');
  eq(error.status, 500);
  eq(error.bodySnippet, 'upstream error');
});

await testAsync('HTTP 429 → E_RATE_LIMITED + status 429', async () => {
  const impl = recordingFetch(() => responseOf('rate limited', 429));
  const error = await rejectsCode(() => fetchYearHolidays({ year: 2026, fetchImpl: impl }), 'E_RATE_LIMITED', 'HTTP 429');
  eq(error.status, 429);
});

await testAsync('HTTP 200 但 body code=429 → E_RATE_LIMITED（保留 API 字段）', async () => {
  const impl = recordingFetch(() => responseOf({ code: 429, message: 'too many requests at a times. maybe you need buy vip.' }));
  const error = await rejectsCode(() => fetchYearHolidays({ year: 2026, fetchImpl: impl }), 'E_RATE_LIMITED', 'body 429');
  eq(error.apiCode, 429);
  ok(error.message.includes('too many requests'), 'message 应透传');
});

await testAsync('非法 JSON → E_INVALID_JSON', async () => {
  const impl = recordingFetch(() => responseOf('<html>not json</html>'));
  await rejectsCode(() => fetchYearHolidays({ year: 2026, fetchImpl: impl }), 'E_INVALID_JSON', '坏 JSON');
});

await testAsync('网络错误 → E_NETWORK 且保留 cause', async () => {
  const boom = new Error('socket hang up');
  const impl = async () => {
    throw boom;
  };
  const error = await rejectsCode(() => fetchYearHolidays({ year: 2026, fetchImpl: impl }), 'E_NETWORK', '网络错误');
  eq(error.cause, boom);
});

await testAsync('超时 → E_TIMEOUT', async () => {
  const hangingFetch = (url, init) =>
    new Promise((resolve, reject) => {
      const signal = init?.signal;
      const fail = () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (!signal) return; // 永挂
      if (signal.aborted) return fail();
      signal.addEventListener('abort', fail, { once: true });
    });
  await rejectsCode(() => fetchYearHolidays({ year: 2026, fetchImpl: hangingFetch, timeoutMs: 25 }), 'E_TIMEOUT', '超时');
});

await testAsync('调用方 AbortSignal 取消 → E_ABORTED', async () => {
  const controller = new AbortController();
  controller.abort();
  const hangingFetch = (url, init) =>
    new Promise((resolve, reject) => {
      const fail = () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (init?.signal?.aborted) return fail();
      init?.signal?.addEventListener('abort', fail, { once: true });
    });
  await rejectsCode(
    () => fetchYearHolidays({ year: 2026, fetchImpl: hangingFetch, signal: controller.signal, timeoutMs: 1000 }),
    'E_ABORTED',
    '取消',
  );
});

await testAsync('retries：首次 429 后成功（指数退避）', async () => {
  const impl = recordingFetch((url, init, index) => (index === 0 ? responseOf('rate limited', 429) : responseOf(API_2026)));
  const cache = await fetchYearHolidays({ year: 2026, fetchImpl: impl, now: FETCHED_AT, retries: 1, retryDelayMs: 1 });
  eq(impl.calls.length, 2);
  eq(cache.holidayCount, 33);
});

await testAsync('retries=0（默认）429 直接抛错', async () => {
  const impl = recordingFetch(() => responseOf('rate limited', 429));
  await rejectsCode(() => fetchYearHolidays({ year: 2026, fetchImpl: impl }), 'E_RATE_LIMITED', '不重试');
  eq(impl.calls.length, 1);
});

await testAsync('allowEmpty 透传给规范化：空数据生成空缓存', async () => {
  const impl = recordingFetch(() => responseOf({ code: 0, holiday: {} }));
  const cache = await fetchYearHolidays({ year: 2027, fetchImpl: impl, now: FETCHED_AT, allowEmpty: true });
  eq(cache.holidays, {});
  eq(cache.year, 2027);
});

await testAsync('fetchImpl 非函数 → E_NO_FETCH', async () => {
  await rejectsCode(() => fetchYearHolidays({ year: 2026, fetchImpl: {} }), 'E_NO_FETCH', '无 fetch');
  await rejectsCode(() => fetchYearHolidays({ year: 2026, fetchImpl: null }), 'E_NO_FETCH', 'fetch=null');
});

await testAsync('参数校验：timeoutMs / retries / headers / signal', async () => {
  const impl = recordingFetch(() => responseOf(API_2026));
  await assert.rejects(fetchYearHolidays({ year: 2026, fetchImpl: impl, timeoutMs: 0 }), RangeError);
  await assert.rejects(fetchYearHolidays({ year: 2026, fetchImpl: impl, retries: -1 }), RangeError);
  await assert.rejects(fetchYearHolidays({ year: 2026, fetchImpl: impl, headers: 'x' }), TypeError);
});

/* ========================================================================== *
 * 5. evaluateDay
 * ========================================================================== */

group('5. evaluateDay：节假日 / 补班 / 周末 / 工作日');

test('法定节假日落在工作日：2026-10-01 国庆节（周四）', () => {
  match(evaluateDay('2026-10-01', cache2026), {
    date: '2026-10-01',
    year: 2026,
    weekday: 4,
    weekend: false,
    workday: false,
    source: 'api',
    holidayName: '国庆节',
    type: 'holiday',
    isHoliday: true,
    wage: 3,
    covered: true,
    fallback: false,
  }, '10-01');
});

test('调休补班落在周末：2026-10-10（周六）是工作日', () => {
  match(evaluateDay('2026-10-10', cache2026), {
    weekday: 6,
    weekend: true,
    workday: true,
    source: 'api',
    holidayName: '国庆节后补班',
    type: 'workday',
    isHoliday: false,
  }, '10-10');
});

test('调休补班落在周日：2026-01-04 元旦后补班', () => {
  match(evaluateDay('2026-01-04', cache2026), { weekday: 0, weekend: true, workday: true, source: 'api', holidayName: '元旦后补班' }, '01-04');
});

test('普通周末：2026-10-17（周六）', () => {
  match(evaluateDay('2026-10-17', cache2026), {
    workday: false,
    source: 'weekend',
    holidayName: null,
    weekend: true,
    covered: true,
  }, '10-17');
});

test('普通工作日：2026-10-12（周一）', () => {
  match(evaluateDay('2026-10-12', cache2026), {
    workday: true,
    source: 'api',
    holidayName: null,
    weekend: false,
  }, '10-12');
});

test('跨年数据：2026-12-31 用 2026 缓存、2027-01-01 用 2027 缓存', () => {
  match(evaluateDay('2026-12-31', cache2026), { workday: true, source: 'api', year: 2026 }, '12-31');
  match(evaluateDay('2027-01-01', cache2027), { workday: false, source: 'api', holidayName: '元旦' }, '2027-01-01');
});

test('无数据年份：fallback 周末规则（source=fallback）', () => {
  const weekday = evaluateDay('2028-10-02', cache2026); // 2028-10-02 周一
  match(weekday, { workday: true, source: 'fallback', covered: false, fallback: true }, 'fallback 工作日');
  const weekend = evaluateDay('2028-10-07', cache2026); // 2028-10-07 周六
  match(weekend, { workday: false, source: 'fallback', weekend: true }, 'fallback 周末');
});

test('无缓存(null)：fallback 周末规则', () => {
  eq(evaluateDay('2026-10-01', null).workday, true);
  eq(evaluateDay('2026-10-03', null).workday, false);
  eq(evaluateDay('2026-10-03', null).source, 'fallback');
});

test('isWorkdayFallback=true：缺失数据时全部视为工作日', () => {
  match(evaluateDay('2026-10-03', null, { isWorkdayFallback: true }), { workday: true, source: 'fallback', weekend: true }, '全工作日');
});

test('isWorkdayFallback 函数：自定义兜底', () => {
  // 2026-10-02 周五（无缓存）→ 自定义周五工作
  const friday = evaluateDay('2026-10-02', null, { isWorkdayFallback: ({ weekday }) => weekday === 5 });
  match(friday, { workday: true, source: 'fallback' }, '函数工作日');
  const saturday = evaluateDay('2026-10-03', null, { isWorkdayFallback: ({ weekday }) => weekday === 5 });
  match(saturday, { workday: false, source: 'fallback' }, '函数休息日');
  // 函数返回非 boolean → TypeError
  assert.throws(() => evaluateDay('2026-10-03', null, { isWorkdayFallback: () => 'yes' }), TypeError);
});

test('多年度缓存数组：2027-01-01 取到元旦假日', () => {
  match(evaluateDay('2027-01-01', [cache2026, cache2027]), { workday: false, holidayName: '元旦', source: 'api' }, '数组跨年');
  // 只有 2026 缓存时 2027-01-01 只能走 fallback（工作日）
  match(evaluateDay('2027-01-01', [cache2026]), { workday: true, source: 'fallback' }, '仅 2026 缓存');
});

test('纯对象 Map 形态输入：YYYY-MM-DD 键 / MM-DD 键 / Map', () => {
  const byDate = { '2026-10-01': { holiday: true, name: '国庆节' } };
  match(evaluateDay('2026-10-01', byDate), { workday: false, source: 'api', holidayName: '国庆节' }, 'YYYY-MM-DD 映射');
  const byMonthDay = { '10-01': { holiday: true, name: '国庆节' } };
  match(evaluateDay('2028-10-01', byMonthDay), { workday: false, source: 'api', holidayName: '国庆节' }, 'MM-DD 映射可跨年');
  const map = new Map([['2026-10-10', { holiday: false, name: '补班' }]]);
  match(evaluateDay('2026-10-10', map), { workday: true, source: 'api' }, 'Map 输入');
});

test('非法缓存形态 / 非法日期抛 TypeError', () => {
  assert.throws(() => evaluateDay('2026-10-01', 42), TypeError);
  assert.throws(() => evaluateDay('2026-10-01', { holidays: 1 }), TypeError);
  assert.throws(() => evaluateDay('not-a-date', cache2026), TypeError);
  assert.throws(() => evaluateDay('2026-02-30', cache2026), RangeError);
});

test('时刻输入按 timeZone 换算日历日（跨日界）', () => {
  // UTC 2026-09-30 16:30 = HK 2026-10-01 00:30（国庆节）
  const instant = '2026-09-30T16:30:00Z';
  match(evaluateDay(instant, cache2026, { timeZone: 'Asia/Hong_Kong' }), { date: '2026-10-01', workday: false, holidayName: '国庆节' }, 'HK 日界');
  match(evaluateDay(instant, cache2026, { timeZone: 'UTC' }), { date: '2026-09-30', workday: true, source: 'api' }, 'UTC 日界');
});

/* ========================================================================== *
 * 6. parseWindows / formatWindow
 * ========================================================================== */

group('6. parseWindows / formatWindow');

test('默认区间', () => {
  eq(parseWindows(), [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ]);
});

test('字符串形态与补零规范化', () => {
  eq(parseWindows(['9:00-12:00', '14:00-18:00']), [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ]);
  eq(parseWindows('9:00-12:00'), [{ start: '09:00', end: '12:00' }]);
});

test('对象形态 / 秒级精度 / 跨午夜 / 按 start 排序', () => {
  eq(parseWindows([{ start: '14:00', end: '18:00' }, { start: '09:00', end: '12:00' }]), [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ]);
  eq(parseWindows([{ start: '09:00:00', end: '09:30:30' }]), [{ start: '09:00', end: '09:30:30' }]);
  eq(parseWindows(['22:00-02:00']), [{ start: '22:00', end: '02:00' }]);
});

test('非法区间：格式 / 范围 / 零长度 / 容器类型', () => {
  for (const bad of ['09:00', '25:00-26:00', '09:00-09:00', 'aa:bb-cc:dd']) {
    throwsCode(() => parseWindows([bad]), 'E_INVALID_WINDOW', `区间 ${bad}`);
  }
  throwsCode(() => parseWindows({ start: '09:00', end: '12:00' }), 'E_INVALID_WINDOW', '容器类型');
  throwsCode(() => parseWindows([42]), 'E_INVALID_WINDOW', '条目类型');
});

test('formatWindow 对象 / 字符串 / 秒级', () => {
  eq(formatWindow({ start: '9:00', end: '12:00' }), '09:00-12:00');
  eq(formatWindow('14:00-18:00'), '14:00-18:00');
  eq(formatWindow({ start: '09:00:00', end: '09:30:30' }), '09:00-09:30:30');
});

/* ========================================================================== *
 * 7. statusAt：默认暂停区间 + 边界 + nextChangeAt
 * ========================================================================== */

group('7. statusAt：默认区间边界（2026-10-12 周一，普通工作日）');

test('09:00:00 整 → paused（进入区间）', () => {
  const s = statusAt('2026-10-12T09:00:00+08:00', defaultBase);
  match(s, {
    state: 'paused',
    reason: 'window',
    workday: true,
    pauseWindow: { start: '09:00', end: '12:00' },
    nextChangeAt: '2026-10-12T04:00:00.000Z',
    nextChangeAtLocal: '2026-10-12T12:00:00',
    nextChangeTo: 'working',
    nextChangeInMs: 3 * 60 * 60 * 1000,
    date: '2026-10-12',
    timeZone: 'Asia/Hong_Kong',
    localTime: '09:00:00',
    weekday: 1,
    source: 'api',
  }, '09:00');
});

test('08:59:59 → working（尚未进入）', () => {
  const s = statusAt('2026-10-12T08:59:59+08:00', defaultBase);
  match(s, {
    state: 'working',
    reason: 'outside',
    nextChangeAt: '2026-10-12T01:00:00.000Z',
    nextChangeAtLocal: '2026-10-12T09:00:00',
    nextChangeTo: 'paused',
    pauseWindow: null,
  }, '08:59:59');
});

test('09:00:00.500 → paused（毫秒级边界）', () => {
  const s = statusAt('2026-10-12T09:00:00.500+08:00', defaultBase);
  match(s, { state: 'paused', localTime: '09:00:00', nextChangeAt: '2026-10-12T04:00:00.000Z' }, '09:00:00.5');
});

test('11:59:59 → paused，nextChangeAt 为 12:00:00', () => {
  const s = statusAt('2026-10-12T11:59:59+08:00', defaultBase);
  match(s, { state: 'paused', nextChangeAt: '2026-10-12T04:00:00.000Z', nextChangeTo: 'working' }, '11:59:59');
});

test('12:00:00 整 → working（退出区间，边界右开）', () => {
  const s = statusAt('2026-10-12T12:00:00+08:00', defaultBase);
  match(s, {
    state: 'working',
    reason: 'outside',
    pauseWindow: null,
    nextChangeAt: '2026-10-12T06:00:00.000Z',
    nextChangeAtLocal: '2026-10-12T14:00:00',
    nextChangeTo: 'paused',
  }, '12:00');
});

test('12:00:01 / 12:30 / 13:59:59 → working，下一变化 14:00', () => {
  for (const time of ['12:00:01', '12:30:00', '13:59:59']) {
    const s = statusAt(`2026-10-12T${time}+08:00`, defaultBase);
    match(s, { state: 'working', reason: 'outside', nextChangeAt: '2026-10-12T06:00:00.000Z', nextChangeTo: 'paused' }, time);
  }
});

test('14:00:00 整 → paused（进入第二区间）', () => {
  const s = statusAt('2026-10-12T14:00:00+08:00', defaultBase);
  match(s, {
    state: 'paused',
    pauseWindow: { start: '14:00', end: '18:00' },
    nextChangeAt: '2026-10-12T10:00:00.000Z',
    nextChangeAtLocal: '2026-10-12T18:00:00',
    nextChangeTo: 'working',
  }, '14:00');
});

test('17:59:59 → paused，nextChangeAt 为 18:00:00', () => {
  const s = statusAt('2026-10-12T17:59:59+08:00', defaultBase);
  match(s, { state: 'paused', nextChangeAt: '2026-10-12T10:00:00.000Z' }, '17:59:59');
});

test('18:00:00 整 → working，下一变化为次日 09:00', () => {
  const s = statusAt('2026-10-12T18:00:00+08:00', defaultBase);
  match(s, {
    state: 'working',
    reason: 'outside',
    nextChangeAt: '2026-10-13T01:00:00.000Z',
    nextChangeAtLocal: '2026-10-13T09:00:00',
    nextChangeTo: 'paused',
  }, '18:00');
});

test('周五 18:30 → nextChangeAt 为周六调休补班的 09:00', () => {
  const s = statusAt('2026-10-09T18:30:00+08:00', defaultBase);
  match(s, {
    state: 'working',
    nextChangeAt: '2026-10-10T01:00:00.000Z',
    nextChangeAtLocal: '2026-10-10T09:00:00',
    nextChangeTo: 'paused',
  }, '周五 18:30');
});

group('8. statusAt：调休补班 / 节假日 / 周末');

test('周六调休补班 09:30 → paused（补班日按工作日处理）', () => {
  const s = statusAt('2026-10-10T09:30:00+08:00', defaultBase);
  match(s, {
    state: 'paused',
    reason: 'window',
    workday: true,
    holidayName: '国庆节后补班',
    holidayType: 'workday',
    nextChangeAt: '2026-10-10T04:00:00.000Z',
    nextChangeAtLocal: '2026-10-10T12:00:00',
  }, '补班 09:30');
});

test('周六调休补班 18:00 → working，下一变化为周一 09:00', () => {
  const s = statusAt('2026-10-10T18:00:00+08:00', defaultBase);
  match(s, {
    state: 'working',
    workday: true,
    nextChangeAt: '2026-10-12T01:00:00.000Z',
    nextChangeAtLocal: '2026-10-12T09:00:00',
  }, '补班 18:00');
});

test('周日调休补班 09:30 → paused', () => {
  match(statusAt('2026-01-04T09:30:00+08:00', defaultBase), {
    state: 'paused',
    workday: true,
    holidayName: '元旦后补班',
    nextChangeAt: '2026-01-04T04:00:00.000Z',
  }, '01-04 补班');
});

test('节假日 10-01 10:30 → working（reason=holiday），下一变化为 10-08 09:00', () => {
  const s = statusAt('2026-10-01T10:30:00+08:00', defaultBase);
  match(s, {
    state: 'working',
    reason: 'holiday',
    workday: false,
    holidayName: '国庆节',
    holidayType: 'holiday',
    pauseWindow: null,
    nextChangeAt: '2026-10-08T01:00:00.000Z',
    nextChangeAtLocal: '2026-10-08T09:00:00',
    nextChangeTo: 'paused',
  }, '国庆节 10:30');
});

test('节假日恰好是周六：10-03 11:00 → working，reason 优先 holiday', () => {
  match(statusAt('2026-10-03T11:00:00+08:00', defaultBase), {
    state: 'working',
    reason: 'holiday',
    weekend: true,
    holidayName: '国庆节',
    nextChangeAt: '2026-10-08T01:00:00.000Z',
  }, '10-03');
});

test('春节长假中：02-16（除夕，周一）10:30 → 下一变化 02-24（周二）09:00', () => {
  match(statusAt('2026-02-16T10:30:00+08:00', defaultBase), {
    state: 'working',
    reason: 'holiday',
    holidayName: '除夕',
    nextChangeAt: '2026-02-24T01:00:00.000Z',
    nextChangeAtLocal: '2026-02-24T09:00:00',
  }, '除夕');
});

test('普通周末 10-17 10:30 → working（reason=weekend），下一变化周一 09:00', () => {
  const s = statusAt('2026-10-17T10:30:00+08:00', defaultBase);
  match(s, {
    state: 'working',
    reason: 'weekend',
    workday: false,
    holidayName: null,
    weekend: true,
    nextChangeAt: '2026-10-19T01:00:00.000Z',
    nextChangeAtLocal: '2026-10-19T09:00:00',
  }, '周末');
});

test('节假日后的补班周末也会成为 nextChangeAt 目标（10-11 周日 → 10-12 周一）', () => {
  match(statusAt('2026-10-11T12:00:00+08:00', defaultBase), {
    state: 'working',
    reason: 'weekend',
    nextChangeAt: '2026-10-12T01:00:00.000Z',
  }, '10-11');
});

/* ========================================================================== *
 * 9. statusAt：跨年 / 多时区 / 跨午夜 / 自定义区间
 * ========================================================================== */

group('9. statusAt：跨年');

test('2026-12-31 18:30，仅有 2026 缓存 → 2027-01-01 按 fallback 视为工作日', () => {
  match(statusAt('2026-12-31T18:30:00+08:00', defaultBase), {
    state: 'working',
    nextChangeAt: '2027-01-01T01:00:00.000Z',
    nextChangeAtLocal: '2027-01-01T09:00:00',
    source: 'api',
  }, '跨年 fallback');
});

test('2026-12-31 18:30，含 2027 缓存（元旦假日）→ 下一变化 2027-01-04 09:00', () => {
  match(statusAt('2026-12-31T18:30:00+08:00', { timeZone: HK, holidays: [cache2026, cache2027] }), {
    state: 'working',
    nextChangeAt: '2027-01-04T01:00:00.000Z',
    nextChangeAtLocal: '2027-01-04T09:00:00',
  }, '跨年假日');
});

test('2027-01-01（元旦，周五）10:30 → working，下一变化 2027-01-04 周一 09:00', () => {
  match(statusAt('2027-01-01T10:30:00+08:00', { timeZone: HK, holidays: [cache2026, cache2027] }), {
    state: 'working',
    reason: 'holiday',
    holidayName: '元旦',
    date: '2027-01-01',
    nextChangeAt: '2027-01-04T01:00:00.000Z',
  }, '2027 元旦');
});

group('10. statusAt：时区（UTC / HK / 纽约 DST）');

test('同一时刻：HK 09:30 paused，UTC 01:30 working', () => {
  const instant = '2026-10-12T01:30:00Z';
  const hk = statusAt(instant, { ...defaultBase, timeZone: 'Asia/Hong_Kong' });
  match(hk, {
    state: 'paused',
    localTime: '09:30:00',
    nextChangeAt: '2026-10-12T04:00:00.000Z',
  }, 'HK');
  const utc = statusAt(instant, { ...defaultBase, timeZone: 'UTC' });
  match(utc, {
    state: 'working',
    reason: 'outside',
    localTime: '01:30:00',
    nextChangeAt: '2026-10-12T09:00:00.000Z',
    nextChangeAtLocal: '2026-10-12T09:00:00',
  }, 'UTC');
});

test('纽约夏令时（EDT）：2026-07-01 13:30Z = 本地 09:30，下一变化 16:00Z', () => {
  match(statusAt('2026-07-01T13:30:00Z', { timeZone: 'America/New_York' }), {
    state: 'paused',
    localTime: '09:30:00',
    nextChangeAt: '2026-07-01T16:00:00.000Z',
    nextChangeAtLocal: '2026-07-01T12:00:00',
  }, 'EDT');
});

test('纽约冬令时（EST）：2026-12-01 14:30Z = 本地 09:30，下一变化 17:00Z', () => {
  match(statusAt('2026-12-01T14:30:00Z', { timeZone: 'America/New_York' }), {
    state: 'paused',
    localTime: '09:30:00',
    nextChangeAt: '2026-12-01T17:00:00.000Z',
    nextChangeAtLocal: '2026-12-01T12:00:00',
  }, 'EST');
});

group('11. statusAt：跨午夜区间与自定义区间');

test('跨午夜 22:00-02:00：23:30 → paused，次日 02:00 恢复', () => {
  const s = statusAt('2026-10-12T23:30:00+08:00', { timeZone: HK, pauseWindows: ['22:00-02:00'], holidays: cache2026 });
  match(s, {
    state: 'paused',
    reason: 'window',
    pauseWindow: { start: '22:00', end: '02:00' },
    nextChangeAt: '2026-10-12T18:00:00.000Z',
    nextChangeAtLocal: '2026-10-13T02:00:00',
    nextChangeTo: 'working',
  }, '23:30 跨午夜');
});

test('跨午夜 22:00-02:00：次日 01:30 → paused，当日 02:00 恢复', () => {
  match(statusAt('2026-10-13T01:30:00+08:00', { timeZone: HK, pauseWindows: ['22:00-02:00'], holidays: cache2026 }), {
    state: 'paused',
    localTime: '01:30:00',
    nextChangeAt: '2026-10-12T18:00:00.000Z',
    nextChangeAtLocal: '2026-10-13T02:00:00',
  }, '01:30 跨午夜');
});

test('跨午夜 22:00-02:00：02:00 整 → working，下一变化当日 22:00', () => {
  match(statusAt('2026-10-13T02:00:00+08:00', { timeZone: HK, pauseWindows: ['22:00-02:00'], holidays: cache2026 }), {
    state: 'working',
    reason: 'outside',
    nextChangeAt: '2026-10-13T14:00:00.000Z',
    nextChangeAtLocal: '2026-10-13T22:00:00',
  }, '02:00 跨午夜');
});

test('跨午夜区间 + 周末：周日 01:30 working，下一变化为周一 00:00（跨午夜尾部）', () => {
  match(statusAt('2026-10-18T01:30:00+08:00', { timeZone: HK, pauseWindows: ['22:00-02:00'], holidays: cache2026 }), {
    state: 'working',
    reason: 'weekend',
    nextChangeAt: '2026-10-18T16:00:00.000Z',
    nextChangeAtLocal: '2026-10-19T00:00:00',
    nextChangeTo: 'paused',
  }, '周末跨午夜');
});

test('自定义单区间 10:00-11:00：09:30 → working，下一变化 10:00', () => {
  match(statusAt('2026-10-12T09:30:00+08:00', { timeZone: HK, pauseWindows: ['10:00-11:00'], holidays: cache2026 }), {
    state: 'working',
    reason: 'outside',
    nextChangeAt: '2026-10-12T02:00:00.000Z',
    nextChangeAtLocal: '2026-10-12T10:00:00',
  }, '自定义区间');
});

test('秒级区间 09:00:30-09:01:00 的边界', () => {
  const windows = [{ start: '09:00:30', end: '09:01:00' }];
  const base = { timeZone: HK, pauseWindows: windows, holidays: cache2026 };
  match(statusAt('2026-10-12T09:00:29+08:00', base), {
    state: 'working',
    nextChangeAt: '2026-10-12T01:00:30.000Z',
    nextChangeAtLocal: '2026-10-12T09:00:30',
  }, '09:00:29');
  match(statusAt('2026-10-12T09:00:30+08:00', base), {
    state: 'paused',
    nextChangeAt: '2026-10-12T01:01:00.000Z',
    nextChangeAtLocal: '2026-10-12T09:01:00',
  }, '09:00:30');
  match(statusAt('2026-10-12T09:01:00+08:00', base), {
    state: 'working',
    nextChangeAt: '2026-10-13T01:00:30.000Z',
  }, '09:01:00');
});

test('pauseWindows=[] → 永远 working，nextChangeAt 为 null', () => {
  const s = statusAt('2026-10-12T10:30:00+08:00', { timeZone: HK, pauseWindows: [], holidays: cache2026 });
  match(s, { state: 'working', reason: 'outside', nextChangeAt: null, nextChangeAtLocal: null, nextChangeTo: null, nextChangeInMs: null }, '空区间');
});

test('无节假日数据时按 fallback 工作日判定（10-01 10:30 → paused）', () => {
  match(statusAt('2026-10-01T10:30:00+08:00', { timeZone: HK }), {
    state: 'paused',
    reason: 'window',
    workday: true,
    source: 'fallback',
  }, '无数据 fallback');
});

test('now 支持 Date / 毫秒时间戳 / ISO 字符串，结果一致', () => {
  const iso = '2026-10-12T09:30:00+08:00';
  const fromString = statusAt(iso, defaultBase);
  const fromDate = statusAt(new Date(iso), defaultBase);
  const fromNumber = statusAt(Date.parse(iso), defaultBase);
  eq(fromDate.nextChangeAt, fromString.nextChangeAt);
  eq(fromNumber.nextChangeAt, fromString.nextChangeAt);
  eq(fromDate.state, fromString.state);
});

test('非法 timeZone / now / pauseWindows 抛错', () => {
  assert.throws(() => statusAt('2026-10-12T09:30:00+08:00', { timeZone: 'Bad/Zone', holidays: cache2026 }), RangeError);
  assert.throws(() => statusAt('not-a-date', defaultBase), TypeError);
  assert.throws(() => statusAt('2026-10-12T09:30:00+08:00', { ...defaultBase, pauseWindows: 'bad' }), RangeError);
});

/* ========================================================================== *
 * 12. 缓存序列化 / TTL
 * ========================================================================== */

group('12. serializeCache / parseCache / isCacheFresh');

test('serialize→parse 往返一致', () => {
  const roundtrip = parseCache(serializeCache(cache2026));
  eq(roundtrip, cache2026);
});

test('parseCache 接受 JSON 字符串', () => {
  eq(parseCache(JSON.stringify(cache2026)), cache2026);
});

test('parseCache：版本不支持 → E_UNSUPPORTED_VERSION', () => {
  throwsCode(() => parseCache({ ...cache2026, version: 999 }), 'E_UNSUPPORTED_VERSION', '版本');
});

test('parseCache：坏 JSON / 缺 holidays / 坏条目 → 可识别错误', () => {
  throwsCode(() => parseCache('{bad json'), 'E_INVALID_JSON', '坏 JSON');
  throwsCode(() => parseCache({ version: 1, year: 2026, fetchedAt: FETCHED_AT }), 'E_INVALID_CACHE', '缺 holidays');
  throwsCode(
    () => parseCache({ version: 1, year: 2026, fetchedAt: FETCHED_AT, holidays: { '01-01': { name: 'x' } } }),
    'E_INVALID_CACHE',
    '坏条目',
  );
  throwsCode(
    () =>
      parseCache({
        version: 1,
        year: 2026,
        fetchedAt: FETCHED_AT,
        holidays: { '01-01': { type: 'holiday', date: '2025-01-01' } },
      }),
    'E_INVALID_CACHE',
    '日期不匹配',
  );
  throwsCode(
    () => parseCache({ version: 1, year: 2026, fetchedAt: 'not-a-date', holidays: {} }),
    'E_INVALID_CACHE',
    '坏 fetchedAt',
  );
});

test('E_EMPTY_DATA 空缓存可正常序列化/反序列化', () => {
  const empty = normalizeYearData(2027, { code: 0, holiday: {} }, { allowEmpty: true, fetchedAt: FETCHED_AT });
  eq(parseCache(serializeCache(empty)), empty);
});

test('isCacheFresh：TTL 内 fresh，TTL 外 stale', () => {
  ok(isCacheFresh(cache2026, DEFAULT_CACHE_TTL_MS, '2026-10-30T10:14:36Z'), '刚抓取');
  ok(isCacheFresh(cache2026, DEFAULT_CACHE_TTL_MS, '2026-10-30T21:15:00Z'), '11h 后仍新鲜');
  ok(isCacheFresh(cache2026, DEFAULT_CACHE_TTL_MS, '2026-10-30T22:14:36Z'), '恰好 12h 边界仍新鲜');
  eq(isCacheFresh(cache2026, DEFAULT_CACHE_TTL_MS, '2026-10-30T22:14:37Z'), false, '12h 后过期');
  eq(isCacheFresh(cache2026, 0, FETCHED_AT), false, 'ttl=0 视为过期');
  ok(isCacheFresh(cache2026, Infinity, '2030-01-01T00:00:00Z'), 'Infinity 永不过期');
});

test('isCacheFresh：坏缓存 / 时间倒退 / 未来 fetchedAt → false', () => {
  eq(isCacheFresh(null, DEFAULT_CACHE_TTL_MS), false);
  eq(isCacheFresh('{bad', DEFAULT_CACHE_TTL_MS), false);
  eq(isCacheFresh({ ...cache2026, fetchedAt: 'not-a-date' }, DEFAULT_CACHE_TTL_MS, FETCHED_AT), false);
  // fetchedAt 明显在未来（>5min 时钟偏差）
  eq(isCacheFresh(cache2026, DEFAULT_CACHE_TTL_MS, '2026-10-30T09:00:00Z'), false);
  // 5min 内时钟偏差容忍
  ok(isCacheFresh(cache2026, DEFAULT_CACHE_TTL_MS, '2026-10-30T10:12:00Z'), '5min 内偏差容忍');
});

test('serializeCache 对非法缓存抛 HolidayCacheError', () => {
  assert.throws(() => serializeCache({} ), HolidayCacheError);
  assert.throws(() => serializeCache(null), HolidayCacheError);
});

/* ========================================================================== *
 * 13. 可选：timor.tech 实测（HOLIDAY_LIVE=1 时执行）
 * ========================================================================== */

group('13. timor.tech 实测（可选）');

if (process.env.HOLIDAY_LIVE === '1') {
  await await testAsync('真实请求 year/2026（429 时跳过）', async () => {
    let cache;
    try {
      cache = await fetchYearHolidays({ year: 2026, timeoutMs: 20000, retries: 1, retryDelayMs: 1500 });
    } catch (error) {
      if (error.code === 'E_RATE_LIMITED' || error.status === 429) {
        console.log('       [skip] timor.tech 速率限制 429，跳过实测（离线夹具仍全量覆盖）');
        return;
      }
      throw error;
    }
    ok(cache.holidayCount > 0, '应至少有一个法定假日');
    ok(cache.workdayCount >= 1, '应至少有一个调休补班');
    eq(cache.holidays['10-01'].name, '国庆节');
    eq(cache.holidays['10-10'].type, 'workday');
    eq(cache.year, 2026);
    eq(cache.source, 'timor.tech');
    ok(Number.isFinite(Date.parse(cache.fetchedAt)), 'fetchedAt 应为 ISO 时间');
  });
} else {
  console.log('  skip 未设置 HOLIDAY_LIVE=1，跳过真实网络请求（离线夹具已覆盖全部 API 结构）');
}

/* ========================================================================== *
 * 汇总
 * ========================================================================== */

console.log(`\n${'='.repeat(60)}`);
console.log(`结果：${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n失败详情：');
  for (const { name, error } of failures) {
    console.log(`\n- ${name}`);
    console.log(`  ${error?.stack ?? error}`);
  }
  process.exitCode = 1;
} else {
  console.log('全部通过 ✓');
  process.exitCode = 0;
}

/* ========================================================================== *
 * 最近一次实际执行结果（2026-10-30，Node v24.22.1，Windows，<workspace>）
 *
 * 1) 默认离线确定性测试：
 *      $ node shared/holiday.test.mjs
 *      结果：103 passed, 0 failed
 *      全部通过 ✓
 *      EXITCODE=0
 *
 * 2) 进程时区无关性验证（Intl 按 IANA 时区计算，不依赖宿主 TZ）：
 *      $env:TZ='UTC'; node shared/holiday.test.mjs                    → 103 passed, 0 failed, EXITCODE=0
 *      $env:TZ='America/Los_Angeles'; node shared/holiday.test.mjs    → 103 passed, 0 failed, EXITCODE=0
 *
 * 3) 真实 API 实测（可选，带 429 跳过与一次退避重试）：
 *      $env:HOLIDAY_LIVE='1'; node shared/holiday.test.mjs
 *      13. timor.tech 实测（可选）
 *        ok   真实请求 year/2026（429 时跳过）
 *      结果：104 passed, 0 failed
 *      全部通过 ✓
 *      EXITCODE=0
 *
 * 备注：timor.tech 短时间连续请求会 429（实测 year/2025、year/2027 立即触发）；
 * Host 侧必须在本地缓存（DEFAULT_CACHE_TTL_MS = 12h）并串行刷新。
 * ========================================================================== */
