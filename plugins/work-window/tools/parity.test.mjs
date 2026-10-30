/**
 * parity.test.mjs — 校验浏览器半区 `shared/status-client.mjs` 与 Host 半区
 * `shared/holiday.js` 的判定完全一致。
 *
 * 做法：用同一份节假日缓存（shared/offline-holidays.json）与同一组时刻，
 * 分别调用两边的 `statusAt`，比较 state / reason / workday / pauseWindow /
 * nextChangeAt / nextChangeAtLocal / holidayName。
 *
 * 用法：node tools/parity.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { statusAt as referenceStatusAt } from '../shared/holiday.js';
import { statusAt as clientStatusAt } from '../shared/status-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const caches = JSON.parse(fs.readFileSync(path.join(here, '..', 'shared', 'offline-holidays.json'), 'utf8'));

let passed = 0;
const failures = [];
function check(name, actual, expected, context) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText === expectedText) {
    passed += 1;
    return;
  }
  failures.push(`${name}${context === undefined ? '' : ` ${context}`}: 期望 ${expectedText}，实际 ${actualText}`);
}

const WINDOWS = [
  { start: '09:00', end: '12:00' },
  { start: '14:00', end: '18:00' },
];

/** 抽样：2026 年若干关键日期整天、每 17 分钟一个点（含整点边界）。 */
const DAYS = [
  '2026-01-01', // 元旦（周四，节假日）
  '2026-01-04', // 周日补班
  '2026-02-17', // 春节（周二，节假日）
  '2026-02-14', // 周六补班
  '2026-05-09', // 周六补班
  '2026-10-01', // 国庆（周四，节假日）
  '2026-10-10', // 周六补班
  '2026-10-30', // 普通周五
  '2026-10-31', // 普通周六
  '2026-11-01', // 普通周日
  '2026-12-31', // 跨年前一天
];

let comparisons = 0;
for (const day of DAYS) {
  for (let minutes = 0; minutes < 24 * 60; minutes += 17) {
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    const iso = `${day}T${hh}:${mm}:00+08:00`;
    const now = new Date(iso);
    if (Number.isNaN(now.getTime())) throw new Error(`bad sample ${iso}`);

    const reference = referenceStatusAt(now, { timeZone: 'Asia/Hong_Kong', pauseWindows: WINDOWS, holidays: caches });
    const client = clientStatusAt(now, { timeZone: 'Asia/Hong_Kong', pauseWindows: WINDOWS, holidays: caches });

    // 边界 sample 精确对齐整点，其它点也对齐（17 分钟步长会覆盖每个整点与 15 分点）。
    const fields = ['state', 'reason', 'workday', 'pauseWindow', 'nextChangeAt', 'nextChangeAtLocal', 'holidayName'];
    const referencePicked = Object.fromEntries(fields.map((field) => [field, reference[field]]));
    const clientPicked = Object.fromEntries(fields.map((field) => [field, client[field]]));
    check('statusAt', clientPicked, referencePicked, `${iso} (${day} ${hh}:${mm})`);
    comparisons += 1;
  }
}

// 额外：整点边界（09:00 / 12:00 / 14:00 / 18:00 整）与空区间配置。
for (const clock of ['09:00:00', '11:59:59', '12:00:00', '13:59:59', '14:00:00', '17:59:59', '18:00:00']) {
  const iso = `2026-10-30T${clock}+08:00`;
  const reference = referenceStatusAt(new Date(iso), { timeZone: 'Asia/Hong_Kong', pauseWindows: WINDOWS, holidays: caches });
  const client = clientStatusAt(new Date(iso), { timeZone: 'Asia/Hong_Kong', pauseWindows: WINDOWS, holidays: caches });
  check('boundary.state', client.state, reference.state, iso);
  check('boundary.nextChangeAt', client.nextChangeAt, reference.nextChangeAt, iso);
}

// 无节假日数据（-空数组）时，两边都应退回“周末休息”规则。
for (const iso of ['2026-03-04T10:30:00+08:00', '2026-03-07T10:30:00+08:00']) {
  const reference = referenceStatusAt(new Date(iso), { timeZone: 'Asia/Hong_Kong', pauseWindows: WINDOWS, holidays: [] });
  const client = clientStatusAt(new Date(iso), { timeZone: 'Asia/Hong_Kong', pauseWindows: WINDOWS, holidays: [] });
  check('fallback.state', client.state, reference.state, iso);
  check('fallback.reason', client.reason, reference.reason, iso);
}

if (failures.length > 0) {
  console.error(`parity: ${failures.length} failed / ${comparisons} comparisons`);
  for (const failure of failures.slice(0, 20)) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`parity: ${passed} passed, ${comparisons} samples, 0 failed`);
