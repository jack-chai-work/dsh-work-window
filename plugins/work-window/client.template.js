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
      /*__STATUS_SOURCE__*/

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
      const OFFLINE_HOLIDAYS = /*__OFFLINE_HOLIDAYS__*/ [];

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
