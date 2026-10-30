/**
 * DSH Work Window —— 浏览器（Client）半区最小可运行骨架
 * ============================================================================
 * 证据与说明见 D:\program\dsh\docs\client-api.md（本文件所有 API 都有 file:line 出处）。
 *
 * 用法：
 *   1. 复制到插件包目录 `plugins/work-window/client.js`；
 *   2. 把下面的 `id` 改成与 package.json 的 `name` **完全一致**（loader 以裸包名作为模块 id）；
 *   3. package.json 必须有 `exports["./client"] = "./client.js"` 与
 *      `dsh.client = { platform: "web", immediately: true, inject: ["@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"] }`；
 *   4. 语法自检：`node --check prototype/client.js`。
 *
 * 约束（来自官方 skill references/practices.md:33-36、ui-plugin.md:9-13）：
 *   - 只用 `require('react')`；**禁止** require 任何 Harness 客户端包（ui-primitives 等）；
 *   - 工厂函数无副作用，一切注册/定时器/样式都在 apply / React 生命周期里并带清理；
 *   - 颜色只用 `--dsw-alias-*` 主题 token；
 *   - 所有注册走 `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`。
 */
(function bootWorkWindowClient() {
  'use strict';

  const loader = globalThis.__ModuleLoader__;
  if (loader === undefined || typeof loader.load !== 'function') {
    // 非浏览器环境（例如只做 node --check / 静态检查）静默退出。
    return;
  }

  loader.load({
    // ⚠️ 必须等于 package.json 的 name。
    id: '@local/dsh-work-window',
    factory(require) {
      const React = require('react');
      const h = React.createElement;

      // ---------------------------------------------------------------------
      // 1. 常量：与 Host 半区 Config 的默认值保持同一份（浏览器 bundle 不能跨包 import，
      //    所以这里是内联副本；Host 侧 Config 定稿后同步这里）。
      // ---------------------------------------------------------------------
      /** locale 字典命名空间（注册项上的 `locale` 字段要用它）。 */
      const NS = 'workWindow';
      /** 侧栏入口 id 与主面板 key —— 两者必须相同。 */
      const PANEL_ID = 'work-window';
      /** Host 半区注册的放行命令（见 docs/client-api.md §5.2）。 */
      const RELEASE_COMMAND = '/work-window release';

      const CONFIG = {
        timeZone: 'Asia/Hong_Kong',
        /** 工作日暂停区间（左闭右开）。 */
        pauseWindows: [
          { start: '09:00', end: '12:00' },
          { start: '14:00', end: '18:00' },
        ],
        /** 节假日覆盖表：dateKey(YYYY-MM-DD) -> { name?, workday? }。
         *  v1 为空（离线）；Host 拉取 timor.tech 并缓存后可通过权威通道下发。 */
        holidays: {},
      };

      /** 一周缩写，用于把 Intl 的 weekday 映射成 0=周日。 */
      const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      // ---------------------------------------------------------------------
      // 2. locale 字典（运行时文案；locale/*.json 只放 meta.title/description）
      // ---------------------------------------------------------------------
      const zh = {
        panel: '工作时段',
        title: '工作时段',
        intro: 'agent 只在可工作时段发起模型请求；暂停时段会先询问你。',
        'state.working': '可工作',
        'state.paused': '暂停中',
        'period.window': '工作日暂停区间 {window}',
        'period.weekend': '周末，可自由工作',
        'period.holiday': '节假日：{name}',
        'period.offHours': '工作日非暂停时段',
        'row.now': '本地时间',
        'row.nextWork': '下一个可工作时刻',
        'row.nextPause': '下一个暂停时刻',
        'row.holidays': '节假日',
        'row.windows': '暂停区间',
        'row.cache': '节假日数据',
        'cache.offline': '离线内置（未同步 timor.tech）',
        'holiday.none': '今天无节假日记录',
        'countdown': '剩余 {time}',
        'release': '立即放行一次',
        'release.busy': '正在请求 Host…',
        'release.hint': '也可以直接在输入框输入 {cmd}。',
        'release.unavailable': 'Host 放行通道不可用（未注入 remote 服务）。',
        'release.noAgent': '当前没有活跃会话，无法通过命令通道放行。',
        'release.ok': '已提交放行请求。',
        'release.failed': '放行失败：{message}',
        'notice.localOnly': '状态由浏览器本地计算（与 Host 共用同一判定逻辑）。',
        'refresh': '刷新',
      };
      const en = {
        panel: 'Work Window',
        title: 'Work Window',
        intro: 'The agent starts model requests only inside the allowed window; paused windows ask you first.',
        'state.working': 'Working',
        'state.paused': 'Paused',
        'period.window': 'Paused window {window}',
        'period.weekend': 'Weekend — free to work',
        'period.holiday': 'Holiday: {name}',
        'period.offHours': 'Outside the paused windows',
        'row.now': 'Local time',
        'row.nextWork': 'Next allowed moment',
        'row.nextPause': 'Next pause',
        'row.holidays': 'Holidays',
        'row.windows': 'Paused windows',
        'row.cache': 'Holiday data',
        'cache.offline': 'Built-in offline snapshot (timor.tech not synced)',
        'holiday.none': 'No holiday recorded today',
        'countdown': '{time} left',
        release: 'Allow once',
        'release.busy': 'Asking the Host…',
        'release.hint': 'You can also type {cmd} in the composer.',
        'release.unavailable': 'Host release channel unavailable (remote service not injected).',
        'release.noAgent': 'No live session to run the command against.',
        'release.ok': 'Release request submitted.',
        'release.failed': 'Release failed: {message}',
        'notice.localOnly': 'Status is computed in the browser with the same rules as the Host.',
        refresh: 'Refresh',
      };

      // ---------------------------------------------------------------------
      // 3. 纯函数：时段判定（与 shared/holiday.mjs 的判定顺序一致的内联副本）
      // ---------------------------------------------------------------------
      function toMinutes(hhmm) {
        const [hh, mm] = String(hhmm).split(':');
        return Number(hh) * 60 + Number(mm);
      }

      /** 把某一时刻投影到目标时区的墙钟分量。 */
      function zonedParts(now, timeZone) {
        const fmt = new Intl.DateTimeFormat('en-US', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          weekday: 'short',
          hourCycle: 'h23',
        });
        const parts = {};
        for (const part of fmt.formatToParts(now)) {
          if (part.type !== 'literal') parts[part.type] = part.value;
        }
        const minutes = Number(parts.hour) * 60 + Number(parts.minute);
        return {
          dateKey: parts.year + '-' + parts.month + '-' + parts.day,
          weekday: WEEKDAYS.indexOf(parts.weekday),
          minutes,
          clock: parts.hour + ':' + parts.minute,
        };
      }

      /** 从 now 出发，把「当天目标分钟数」换算成绝对时刻。 */
      function atMinutes(now, currentMinutes, targetMinutes) {
        return new Date(now.getTime() + (targetMinutes - currentMinutes) * 60000);
      }

      /**
       * 判定顺序（与 BRIEF §4.1 一致）：
       *   1. 非工作日（周末或节假日，且未被 workday:true 调休覆盖）→ working；
       *   2. 否则落在暂停区间内 → paused；
       *   3. 否则 → working。
       */
      function computeWindowState(now, config) {
        const p = zonedParts(now, config.timeZone);
        const holiday = config.holidays[p.dateKey];
        const isWeekend = p.weekday === 0 || p.weekday === 6;
        const isWorkday = holiday !== undefined ? holiday.workday === true : !isWeekend;

        if (!isWorkday) {
          return {
            state: 'working',
            period: holiday !== undefined && holiday.name !== undefined ? 'holiday' : 'weekend',
            holidayName: holiday !== undefined ? holiday.name : undefined,
            now: p,
            nextPauseAt: nextPauseAt(now, p, config),
          };
        }

        const active = config.pauseWindows.find(
          (w) => p.minutes >= toMinutes(w.start) && p.minutes < toMinutes(w.end),
        );
        if (active !== undefined) {
          return {
            state: 'paused',
            period: 'window',
            window: active,
            now: p,
            nextWorkAt: atMinutes(now, p.minutes, toMinutes(active.end)),
          };
        }
        return {
          state: 'working',
          period: 'offHours',
          now: p,
          nextPauseAt: nextPauseAt(now, p, config),
        };
      }

      /** 下一个暂停区间的起点（跨天则取次日第一个区间）。 */
      function nextPauseAt(now, p, config) {
        const upcoming = config.pauseWindows
          .map((w) => toMinutes(w.start))
          .filter((start) => start > p.minutes)
          .sort((a, b) => a - b)[0];
        if (upcoming !== undefined) return atMinutes(now, p.minutes, upcoming);
        const firstStart = config.pauseWindows
          .map((w) => toMinutes(w.start))
          .sort((a, b) => a - b)[0];
        if (firstStart === undefined) return undefined;
        return new Date(now.getTime() + (1440 - p.minutes + firstStart) * 60000);
      }

      function formatClock(date, timeZone) {
        try {
          return new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(date);
        } catch (_error) {
          return date.toTimeString().slice(0, 5);
        }
      }

      function formatDuration(ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        const pad = (n) => (n < 10 ? '0' + n : String(n));
        return hours > 0 ? pad(hours) + ':' + pad(minutes) + ':' + pad(seconds) : pad(minutes) + ':' + pad(seconds);
      }

      /** 极简插值：t('key', { window: '09:00-12:00' })。 */
      function interpolate(text, values) {
        if (values === undefined) return text;
        return String(text).replace(/\{(\w+)\}/gu, (match, name) =>
          Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
        );
      }

      // ---------------------------------------------------------------------
      // 4. 样式：一次注入、只用主题 token、类名带本插件前缀（照抄官方页面的容器规格）
      // ---------------------------------------------------------------------
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
        'border-radius:999px;padding:6px 14px;font-size:13px;font-weight:500;line-height:20px}',
        '.ww_badge-working{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);',
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
        '.ww_windows{color:var(--dsw-alias-label-secondary);margin:0;padding-left:18px;font-size:13px;line-height:22px}',
        '.ww_actions{flex-wrap:wrap;align-items:center;gap:12px;display:flex}',
        '.ww_button{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);',
        'background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);',
        'cursor:pointer;height:32px;padding:0 12px;font:inherit;font-size:13px;line-height:20px}',
        '.ww_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.ww_button:disabled{cursor:default;opacity:.6}',
        '.ww_button:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
        'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
        '.ww_note{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}',
        '.ww_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}',
      ].join('');

      const CSS_TAG_ID = '@local/dsh-work-window/WorkWindow.css';
      function ensureStyles() {
        if (typeof document === 'undefined') return;
        const selector = 'style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']';
        if (document.querySelector(selector) !== null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = '@local/dsh-work-window';
        tag.dataset.pluginCss = CSS_TAG_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }

      // ---------------------------------------------------------------------
      // 5. 组件：侧栏图标（props = { size, active }）
      // ---------------------------------------------------------------------
      function WorkWindowIcon({ size }) {
        // 24x24 viewBox 的原创图标：表盘 + 一条暂停竖条，currentColor 跟随主题。
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
          h('circle', { cx: 12, cy: 12, r: 8.25 }),
          h('path', { d: 'M12 7.5v5l3 1.5' }),
          h('path', { d: 'M11 15.5v2.5M13 15.5v2.5' }),
        );
      }

      // ---------------------------------------------------------------------
      // 6. 每秒刷新一次的时钟 hook（组件卸载即清理，避免残留定时器）
      // ---------------------------------------------------------------------
      function useNowTick(intervalMs) {
        const [now, setNow] = React.useState(() => new Date());
        React.useEffect(() => {
          const timer = setInterval(() => setNow(new Date()), intervalMs);
          return () => clearInterval(timer);
        }, [intervalMs]);
        return now;
      }

      // ---------------------------------------------------------------------
      // 7. 组件：主面板（放在 root-scoped `main` keyed slot）
      //    props: 框架注入的 t，以及注册项 inject 返回的 onRelease。
      // ---------------------------------------------------------------------
      function WorkWindowPage(props) {
        const t = props.t;
        const onRelease = props.onRelease;
        const now = useNowTick(1000);
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState(null);

        const state = computeWindowState(now, CONFIG);
        const paused = state.state === 'paused';

        const periodText =
          state.period === 'window'
            ? interpolate(t('period.window'), { window: state.window.start + '-' + state.window.end })
            : state.period === 'holiday'
              ? interpolate(t('period.holiday'), { name: state.holidayName })
              : state.period === 'weekend'
                ? t('period.weekend')
                : t('period.offHours');

        const rows = [
          [t('row.now'), state.now.clock + ' · ' + CONFIG.timeZone],
          paused
            ? [t('row.nextWork'), formatClock(state.nextWorkAt, CONFIG.timeZone)]
            : [t('row.nextPause'), state.nextPauseAt === undefined ? '—' : formatClock(state.nextPauseAt, CONFIG.timeZone)],
          [
            t('row.countdown'),
            paused
              ? interpolate(t('countdown'), { time: formatDuration(state.nextWorkAt.getTime() - now.getTime()) })
              : '—',
          ],
          [t('row.windows'), CONFIG.pauseWindows.map((w) => w.start + '-' + w.end).join('  ')],
          [t('row.holidays'), CONFIG.holidays[state.now.dateKey] === undefined ? t('holiday.none') : CONFIG.holidays[state.now.dateKey].name],
          [t('row.cache'), t('cache.offline')],
        ];

        const release = async () => {
          if (onRelease === undefined) {
            setNotice({ kind: 'error', text: t('release.unavailable') });
            return;
          }
          setBusy(true);
          setNotice(null);
          try {
            const message = await onRelease();
            setNotice({ kind: 'info', text: message === undefined ? t('release.ok') : message });
          } catch (error) {
            const text = error !== null && typeof error === 'object' && 'message' in error ? error.message : String(error);
            setNotice({ kind: 'error', text: interpolate(t('release.failed'), { message: text }) });
          } finally {
            setBusy(false);
          }
        };

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
                className: 'ww_badge ' + (paused ? 'ww_badge-paused' : 'ww_badge-working'),
                role: 'status',
              },
              paused ? t('state.paused') : t('state.working'),
            ),
          ),
          h(
            'section',
            { className: 'ww_card', key: 'facts' },
            rows.map(([label, value]) =>
              h(
                'div',
                { className: 'ww_row', key: label },
                h('span', { className: 'ww_rowLabel' }, label),
                h('span', { className: 'ww_rowValue' + (label === t('row.now') ? ' ww_mono' : '') }, value),
              ),
            ),
          ),
          h('p', { className: 'ww_note', key: 'period' }, periodText),
          h(
            'div',
            { className: 'ww_actions', key: 'actions' },
            h(
              'button',
              { type: 'button', className: 'ww_button', disabled: busy, onClick: release },
              busy ? t('release.busy') : t('release'),
            ),
            h('span', { className: 'ww_note' }, interpolate(t('release.hint'), { cmd: RELEASE_COMMAND })),
          ),
          notice === null
            ? null
            : h('p', { className: notice.kind === 'error' ? 'ww_error' : 'ww_note', key: 'notice-text' }, notice.text),
          h('p', { className: 'ww_note', key: 'local' }, t('notice.localOnly')),
        );
      }

      // ---------------------------------------------------------------------
      // 8. Host 通道（可选）：session command
      //    Host 半区注册全局命令 `/work-window release`；
      //    Client 用 ctx.remote.commands.execute(sessionId, line, []) 调用。
      //    面板是全局页面、没有 session prop，所以先从 session.list 里挑一个有活 agent 的会话。
      //    通道不可用时返回 undefined，面板降级为纯本地展示。
      // ---------------------------------------------------------------------
      function createRelease(ctx) {
        return async function releaseOnce() {
          const remote = ctx.get('remote');
          if (remote === undefined || remote.session === undefined || remote.commands === undefined) {
            throw new Error('remote.session / remote.commands unavailable');
          }
          const controller = new AbortController();
          try {
            const list = await remote.session.list({}, controller.signal);
            if (list.ok !== true) throw new Error('session.list failed: ' + (list.error?.code ?? 'unknown'));
            const target = list.value.items.find((item) => item.agentAvailable === true);
            if (target === undefined) throw new Error('no live agent');
            const result = await remote.commands.execute(target.sessionId, RELEASE_COMMAND, []);
            if (result.ok !== true) throw new Error('commands.execute failed: ' + (result.error?.code ?? 'unknown'));
            if (result.value === undefined) throw new Error('unknown command (Host half not loaded?)');
            const outcome = result.value.result;
            return outcome.kind === 'error' ? outcome.text : undefined;
          } finally {
            controller.abort();
          }
        };
      }

      // ---------------------------------------------------------------------
      // 9. 浏览器插件体：apply / inject（与 Host 半区导出形态一致）
      // ---------------------------------------------------------------------
      return {
        // 只声明确实需要的客户端服务；`remote` 用 ctx.get 可选获取，避免它在少数部署缺失时让插件整体不激活。
        inject: ['slots', 'locale'],

        apply(ctx) {
          ensureStyles();

          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'work-window: dictionaries');
          const t = ctx.locale.bind(NS);

          // 侧栏入口：id 供 sidebar 寻址，图标是 React 组件，props 为 { size, active }。
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

          // 主面板：key 必须与侧栏 id 相同；keyed / root scope 由 layout 声明。
          const onRelease = createRelease(ctx);
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
                inject: () => ({ onRelease }),
              },
              WorkWindowPage,
            ),
          );
        },
      };
    },
  });
})();
