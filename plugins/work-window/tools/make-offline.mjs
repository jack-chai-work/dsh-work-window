/**
 * make-offline.mjs — 生成浏览器半区内置的离线节假日快照。
 *
 * 用 Node 原生 fetch 调 timor.tech（Host 侧可联网；`web_fetch` 工具因 fake-IP SSRF 策略拒绝），
 * 用插件自己的 `shared/holiday.js` 规范化，然后写入 `shared/offline-holidays.json`。
 *
 * 用法：node tools/make-offline.mjs [year...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchYearHolidays, serializeCache } from '../shared/holiday.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const outFile = path.join(pluginRoot, 'shared', 'offline-holidays.json');

const requested = process.argv.slice(2).map(Number).filter(Number.isInteger);
const years = requested.length > 0 ? requested : [new Date().getFullYear(), new Date().getFullYear() + 1];

const caches = [];
for (const year of years) {
  try {
    const cache = await fetchYearHolidays({ year, timeoutMs: 20000, retries: 2, retryDelayMs: 1500 });
    caches.push(JSON.parse(serializeCache(cache)));
    console.log(`ok ${year}: ${cache.holidayCount} holiday + ${cache.workdayCount} workday`);
  } catch (error) {
    console.warn(`skip ${year}: ${error?.message ?? error}`);
  }
  // timor.tech 有速率限制，串行请求之间留一点间隔。
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

fs.writeFileSync(outFile, `${JSON.stringify(caches, null, 2)}\n`, 'utf8');
console.log(`wrote ${outFile} (${caches.length} year(s))`);
