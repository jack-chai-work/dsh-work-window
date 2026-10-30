/**
 * holiday-cache.js — Host 半区的节假日本地缓存。
 *
 * 职责：
 *   1. 把 timor.tech 的年度数据落盘到本地 JSON（默认 `$DSH_HOME/cache/work-window/holidays-<year>.json`）；
 *   2. 同步读取（启动时）与后台刷新（TTL 过期/首次缺失）分离，保证 `agent/pre-step` 门禁判定永远是
 *      同步、非阻塞的——网络慢不能拖住 agent；
 *   3. 单飞（single-flight）刷新：同一年的并发请求只发一次 HTTP；失败只记录，不抛给门禁；
 *   4. 原子写盘（先写 .tmp 再 rename），损坏的缓存文件会被忽略并重新拉取。
 *
 * 该模块只被 Host 半区使用；浏览器半区有自己的 localStorage 缓存（见 client.template.js）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_TTL_MS,
  fetchYearHolidays,
  isCacheFresh,
  parseCache,
  serializeCache,
} from './holiday.js';

/** 缓存目录：优先 `config.cacheDir`，否则 `$DSH_HOME/cache/work-window`（无 DSH_HOME 时退回 ~/.dsh）。 */
export function defaultCacheDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'cache', 'work-window');
}

/** 一个年份对应一个文件，便于人工检查与删除。 */
export function cacheFilePath(dir, year) {
  return path.join(dir, `holidays-${year}.json`);
}

export class HolidayStore {
  /**
   * @param {object} options
   * @param {string} [options.dir]
   * @param {string} [options.apiUrl]
   * @param {number} [options.ttlMs]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.retries]
   * @param {{info:Function, warn:Function, debug?:Function}} [options.logger]
   */
  constructor(options = {}) {
    this.dir = options.dir ?? defaultCacheDir();
    this.apiUrl = options.apiUrl;
    this.ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.retries = options.retries ?? 2;
    this.logger = options.logger;
    /** @type {Map<number, object>} */
    this.caches = new Map();
    /** @type {Map<number, Promise<object|null>>} */
    this.inFlight = new Map();
    this.disposed = false;
  }

  log(level, message) {
    try {
      this.logger?.[level]?.(`work-window: ${message}`);
    } catch {
      /* logging must never break the gate */
    }
  }

  /** 同步读取某年缓存；文件缺失/损坏一律返回 null（并记录一条 warn）。 */
  loadYear(year) {
    const file = cacheFilePath(this.dir, year);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.log('warn', `读取节假日缓存失败 ${file}: ${error.message}`);
      return null;
    }
    try {
      const cache = parseCache(text);
      this.caches.set(year, cache);
      return cache;
    } catch (error) {
      this.log('warn', `节假日缓存 ${file} 无效，将重新拉取: ${error.message}`);
      return null;
    }
  }

  /** 内存中的缓存（没有则 null）。 */
  get(year) {
    return this.caches.get(year) ?? null;
  }

  /** 已加载的全部年份缓存，供 statusAt 做跨年判定。 */
  all() {
    return [...this.caches.values()];
  }

  fresh(cache) {
    return cache !== null && isCacheFresh(cache, this.ttlMs, Date.now());
  }

  /** 原子写盘。 */
  writeYear(cache) {
    if (this.disposed) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = cacheFilePath(this.dir, cache.year);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${serializeCache(cache)}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      this.log('warn', `写入节假日缓存失败: ${error.message}`);
    }
  }

  /** 只读磁盘（启动预热用），不联网。 */
  warmup(years) {
    let loaded = 0;
    for (const year of years) {
      if (this.caches.has(year)) continue;
      if (this.loadYear(year) !== null) loaded += 1;
    }
    return loaded;
  }

  /**
   * 确保某年缓存可用：命中且未过期直接返回；否则后台/前台拉取。
   * 永不 reject；网络失败时返回旧缓存或 null。
   * @param {number} year
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<object|null>}
   */
  async ensure(year, options = {}) {
    if (this.disposed) return this.get(year);
    const current = this.get(year);
    if (!options.force && this.fresh(current)) return current;
    const existing = this.inFlight.get(year);
    if (existing !== undefined) return existing;
    const task = (async () => {
      try {
        const cache = await fetchYearHolidays({
          year,
          url: this.apiUrl,
          timeoutMs: this.timeoutMs,
          retries: this.retries,
        });
        if (this.disposed) return cache;
        this.caches.set(year, cache);
        this.writeYear(cache);
        this.log('info', `${year} 年节假日已更新（${cache.holidayCount} 个假日 / ${cache.workdayCount} 个补班，来源 ${cache.source}）`);
        return cache;
      } catch (error) {
        this.log('warn', `${year} 年节假日拉取失败（使用缓存/周末兜底）: ${error?.message ?? error}`);
        return this.get(year);
      } finally {
        this.inFlight.delete(year);
      }
    })();
    this.inFlight.set(year, task);
    return task;
  }

  /** 依次确保多个年份（串行，避免 timor.tech 429）。 */
  async ensureYears(years, options = {}) {
    for (const year of years) {
      if (this.disposed) return;
      await this.ensure(year, options);
    }
  }

  /** 丢弃不在保留集合中的内存缓存（长时间运行避免无界增长）。 */
  pruneMemory(keepYears) {
    const keep = new Set(keepYears);
    for (const year of [...this.caches.keys()]) if (!keep.has(year)) this.caches.delete(year);
  }

  dispose() {
    this.disposed = true;
    this.caches.clear();
    this.inFlight.clear();
  }
}

export { CACHE_SCHEMA_VERSION };
