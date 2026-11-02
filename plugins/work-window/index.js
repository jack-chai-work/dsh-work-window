/**
 * Work Window — Host 半区。
 *
 * 功能：
 *   1. 系统提示词：告诉 agent 当前的工作时段策略（工作日 09:00-12:00 / 14:00-18:00 暂停，
 *      其余时间以及周末/法定节假日可自由工作）。
 *   2. 准入闸门：在每次模型 step 准入（`agent/pre-step`）时判定当前状态。
 *      - `working`：直接放行。
 *      - `paused` 且是用户主动下达的任务：通过 `ctx.approval.request()` 弹出「提醒 + 确认」；
 *        用户允许（allowed-once）才放行。拒绝/超时/无在线客户端则把消息放回 inbox 排队，
 *        等下一个可工作时刻由定时器唤醒继续。
 *      - `paused` 且是定时任务等自动来源：静默暂停（不弹窗），放回队列并在时段结束唤醒。
 *      - `paused` 且是 goal 连续轮次：把该 turn 原地挂起（不 reject），避免 goal 被永久 block，
 *        时段结束后自动继续（期间不产生模型请求，不消耗 token）。
 *      - 中途 step（没有新消息）放行，让暂停前已开始的 turn 自然收尾，避免中途截断。
 *   3. 节假日：从 timor.tech 拉取年度数据并缓存到本地 JSON（见 shared/holiday-cache.js）；
 *      拉取失败时退回「周末休息」规则，不影响门禁可用性。
 *
 * 设计约束（官方 skill references/practices.md）：
 *   - 每 agent 的监听注册在该 agent 的 `agent.ctx` 上，随 agent 释放；
 *   - 所有注册都用 `ctx.effect` / `ctx.on` 并返回清理；
 *   - 不写 session 事件、不改日志格式；审批审计由 `ctx.approval` 自己写 log-only 事件。
 */
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_PAUSE_WINDOWS,
  DEFAULT_TIME_ZONE,
  formatWindow,
  getZonedParts,
  parseWindows,
  statusAt,
} from './shared/holiday.js';
import { HolidayStore, defaultCacheDir } from './shared/holiday-cache.js';

/** 插件行 id（与 cordis.patch.yml 保持一致）。 */
export const name = 'work-window';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Host 半区 Config：手写 standard-schema（无第三方依赖）。
 * 未声明的字段直接忽略；非法输入抛出带路径的 issue，由 Loader 报错。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-work-window',
    validate(input) {
      const issues = [];
      const raw = input === undefined || input === null ? {} : input;
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: 'config 必须是对象', path: [] }] };
      }

      const config = {
        timeZone: DEFAULT_TIME_ZONE,
        pauseWindows: DEFAULT_PAUSE_WINDOWS.map((window) => ({ ...window })),
        holidayApiUrl: undefined,
        cacheTtlHours: 12,
        holidayTimeoutMs: 15000,
        holidayRetries: 2,
        cacheDir: undefined,
        confirmDuringPause: true,
        confirmTimeoutMs: 10 * MINUTE_MS,
        wakeNotice: '（工作时段已开始，暂停结束：继续执行队列中暂停的任务。）',
        policyText: undefined,
      };

      if (raw.timeZone !== undefined) {
        if (typeof raw.timeZone !== 'string' || raw.timeZone.trim() === '') {
          issues.push({ message: 'timeZone 必须是非空 IANA 时区字符串', path: ['timeZone'] });
        } else {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: raw.timeZone });
            config.timeZone = raw.timeZone;
          } catch {
            issues.push({ message: `timeZone 不是合法 IANA 时区: ${JSON.stringify(raw.timeZone)}`, path: ['timeZone'] });
          }
        }
      }

      if (raw.pauseWindows !== undefined) {
        try {
          config.pauseWindows = parseWindows(raw.pauseWindows).map((window) => ({ start: window.start, end: window.end }));
        } catch (error) {
          issues.push({ message: `pauseWindows 非法: ${error?.message ?? error}`, path: ['pauseWindows'] });
        }
      }

      if (raw.holidayApiUrl !== undefined) {
        if (typeof raw.holidayApiUrl !== 'string' || !/^https?:\/\//u.test(raw.holidayApiUrl)) {
          issues.push({ message: 'holidayApiUrl 必须是 http(s) URL', path: ['holidayApiUrl'] });
        } else {
          config.holidayApiUrl = raw.holidayApiUrl;
        }
      }

      const numberField = (field, min, max) => {
        if (raw[field] === undefined) return;
        const value = raw[field];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
          issues.push({ message: `${field} 必须是 ${min}..${max} 之间的数字`, path: [field] });
        } else {
          config[field] = value;
        }
      };
      numberField('cacheTtlHours', 1, 24 * 30);
      numberField('holidayTimeoutMs', 1000, 120000);
      numberField('holidayRetries', 0, 10);
      numberField('confirmTimeoutMs', 1000, 24 * HOUR_MS);

      if (raw.cacheDir !== undefined) {
        if (typeof raw.cacheDir !== 'string' || raw.cacheDir.trim() === '') {
          issues.push({ message: 'cacheDir 必须是非空字符串', path: ['cacheDir'] });
        } else {
          config.cacheDir = raw.cacheDir;
        }
      }

      if (raw.confirmDuringPause !== undefined) {
        if (typeof raw.confirmDuringPause !== 'boolean') {
          issues.push({ message: 'confirmDuringPause 必须是布尔值', path: ['confirmDuringPause'] });
        } else {
          config.confirmDuringPause = raw.confirmDuringPause;
        }
      }

      for (const field of ['wakeNotice']) {
        if (raw[field] !== undefined) {
          if (typeof raw[field] !== 'string' || raw[field].trim() === '') {
            issues.push({ message: `${field} 必须是非空字符串`, path: [field] });
          } else {
            config[field] = raw[field];
          }
        }
      }

      if (raw.policyText !== undefined) {
        if (typeof raw.policyText !== 'string') {
          issues.push({ message: 'policyText 必须是字符串', path: ['policyText'] });
        } else {
          config.policyText = raw.policyText;
        }
      }

      return issues.length > 0 ? { issues } : { value: config };
    },
  },
};

/**
 * 硬依赖：`systemPrompt`（注册策略提示词段）+ `timer`。
 *
 * `timer` 不能省：cordis 4 里 `ctx.timeout` / `ctx.interval` 是 cordis-plugin-timer
 * 通过 `ctx.mixin('timer', [...])` 暴露的**服务方法**，未在 `inject` 里声明 `timer`
 * 时读取会抛 `cannot get property "timer" without inject`。本插件在 apply() 里就用
 * `ctx.interval()` 注册节假日刷新循环，漏声明会让 apply 直接抛错、整行加载失败
 * （表现：侧栏/输入框看起来正常，但系统提示词段与 agent/pre-step 闸门都不生效）。
 *
 * approval / typertGateway 是可选依赖（用 ctx.get() 读取），缺失时闸门退回静默暂停。
 */
export const inject = ['systemPrompt', 'timer'];

/** `agent/pre-step` 监听器注册到每个 agent 自己的 ctx 上。 */
export function apply(ctx, config) {
  const cfg = config ?? Config['~standard'].validate(undefined).value;
  const timeZone = cfg.timeZone;
  const pauseWindows = cfg.pauseWindows;
  const cacheTtlMs = cfg.cacheTtlHours * HOUR_MS;

  const holidayStore = new HolidayStore({
    dir: cfg.cacheDir ?? defaultCacheDir(),
    apiUrl: cfg.holidayApiUrl,
    ttlMs: cacheTtlMs,
    timeoutMs: cfg.holidayTimeoutMs,
    retries: cfg.holidayRetries,
    logger: ctx.logger,
  });

  /* ------------------------------------------------------------------ *
   * 1. 节假日缓存：同步预热 + 后台刷新 + 周期检查
   * ------------------------------------------------------------------ */
  const currentYear = () => getZonedParts(new Date(), timeZone).year;
  const ensureYears = async (force = false) => {
    const now = getZonedParts(new Date(), timeZone);
    const years = [now.year];
    // 11-12 月顺带预取下一年的数据，避免跨年后把元旦误判为工作日。
    if (now.month >= 11) years.push(now.year + 1);
    await holidayStore.ensureYears(years, { force });
    holidayStore.pruneMemory([now.year, now.year + 1]);
  };

  holidayStore.warmup([currentYear(), currentYear() + 1]);
  void ensureYears(false);
  ctx.effect(() => {
    const timer = ctx.interval(() => {
      void ensureYears(false);
    }, 6 * HOUR_MS);
    return () => timer?.();
  }, 'work-window: holiday refresh loop');

  /** 当前状态（同步；网络失败时用缓存/周末兜底）。 */
  const stateAt = (now = new Date()) =>
    statusAt(now, { timeZone, pauseWindows, holidays: holidayStore.all() });

  /* ------------------------------------------------------------------ *
   * 2. 系统提示词：把策略告诉 agent（静态文本，避免每步改写提示词前缀）
   * ------------------------------------------------------------------ */
  const windowText = pauseWindows.map(formatWindow).join('、');
  const policyText =
    cfg.policyText ??
    [
      '## Work window policy (enforced by the Harness)',
      'Working days are Monday to Friday except Chinese public holidays and adjusted workdays (调休). Weekends and public holidays are unrestricted.',
      `On working days the Harness PAUSES agent work during ${windowText} (${timeZone}). Outside those windows (12:00-14:00, 18:00-09:00, weekends, public holidays) work is allowed.`,
      'While paused the Harness sends no model request, so no tokens are consumed. A task the user submits during a paused window asks for explicit confirmation first; without confirmation it stays queued and resumes at the next allowed moment.',
      'Do not start long-running autonomous work that will cross into a paused window; checkpoint or finish before the window starts. When a step is held, do not retry it yourself.',
    ].join('\n');

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'work-window:policy',
    order: 700,
    text: policyText,
  }), 'work-window: prompt section');

  /* ------------------------------------------------------------------ *
   * 3. 门禁、暂存与唤醒
   * ------------------------------------------------------------------ */
  /** 仍然存活的 agent（agent/created 登记、agent/disposed 移除）。 */
  const liveAgents = new Set();
  /** agentId -> 该 agent 上 pre-step 监听的 disposer。 */
  const gateDisposers = new Map();
  /** agentId -> 唤醒定时器 disposer。 */
  const wakeTimers = new Map();

  const isRestorableMessage = (message) =>
    message !== null && typeof message === 'object' && typeof message.id === 'string' && Array.isArray(message.content);

  const isHumanMessage = (message) =>
    message !== null &&
    typeof message === 'object' &&
    message.source !== null &&
    typeof message.source === 'object' &&
    message.source.kind === 'user';

  const isGoalMessage = (message) =>
    message !== null &&
    typeof message === 'object' &&
    message.source !== null &&
    typeof message.source === 'object' &&
    message.source.kind === 'goal';

  /**
   * 构造一条**完整**的 user 消息（等价于官方 `createUserMessage()` 的产物）。
   *
   * `agent.steer()`/`followup()` 只把对象塞进 inbox，不校验形状；随后 session 会把消息原样
   * 写入 `user/message` 事件（`dsh-session` 的 `deriveEventMessage` 直接返回 `event.data`），
   * provider 序列化请求时读 `message.role`。缺 `role` 时请求体里就是一条没有 role 的消息，
   * DeepSeek 返回 `INVALID_REQUEST: messages[n]: missing field "role"`，且该坏消息会留在会话
   * 历史里，之后每次重试都失败。所以唤醒通知必须补齐 `id`/`role`/`content`/`source`。
   */
  const createNoticeMessage = (text) => ({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'work-window' },
  });

  /** 把已 claim 的消息放回 inbox，等下一个可工作时刻继续。 */
  const holdMessages = (agent, messages) => {
    const restorable = messages.filter(isRestorableMessage);
    // prepend 逐条插到队首，倒序插入才能保持原顺序。
    for (let index = restorable.length - 1; index >= 0; index -= 1) {
      try {
        agent.inbox.prepend('next-turn', restorable[index]);
      } catch (error) {
        ctx.logger?.warn?.(`work-window: 暂存消息失败（agent ${agent.id}）: ${error?.message ?? error}`);
      }
    }
  };

  const clearWake = (agentId) => {
    const timer = wakeTimers.get(agentId);
    wakeTimers.delete(agentId);
    if (timer === undefined) return;
    try {
      timer();
    } catch {
      /* already fired/disposed */
    }
  };

  /** 在下一个可工作时刻唤醒 agent，让它继续处理排队中的消息。 */
  const scheduleWake = (agent, status) => {
    clearWake(agent.id);
    if (status.nextChangeAt === null) return;
    const target = Date.parse(status.nextChangeAt);
    if (!Number.isFinite(target)) return;
    const delay = Math.max(1000, target - Date.now() + 2000);
    if (delay > 24 * HOUR_MS) return;
    const disposer = ctx.timeout(() => {
      wakeTimers.delete(agent.id);
      if (!liveAgents.has(agent.id)) return;
      const current = stateAt(new Date());
      if (current.state !== 'working') {
        scheduleWake(agent, current);
        return;
      }
      const inbox = agent.inbox;
      if (inbox === undefined || inbox.hasPending !== true) return;
      try {
        agent.steer(createNoticeMessage(cfg.wakeNotice));
        ctx.logger?.info?.(`work-window: 时段恢复，已唤醒 agent ${agent.id} 继续处理暂停期间排队的任务`);
      } catch (error) {
        ctx.logger?.warn?.(`work-window: 唤醒 agent ${agent.id} 失败: ${error?.message ?? error}`);
      }
    }, delay);
    wakeTimers.set(agent.id, disposer);
  };

  /** 可被 abort 打断的等待。 */
  const sleepUntilAborted = (ms, signal) =>
    new Promise((resolve) => {
      let settled = false;
      let disposeTimer = () => {};
      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          disposeTimer();
        } catch {
          /* already fired */
        }
        if (signal !== undefined) signal.removeEventListener('abort', finish);
        resolve();
      };
      if (signal !== undefined) {
        if (signal.aborted) {
          finish();
          return;
        }
        signal.addEventListener('abort', finish, { once: true });
      }
      disposeTimer = ctx.timeout(finish, ms);
    });

  /** 暂停中把当前 step 原地挂起，直到进入可工作时段（不 reject，避免 goal 被 block）。 */
  const parkUntilWorking = async (signal) => {
    for (;;) {
      const status = stateAt(new Date());
      if (status.state === 'working') return true;
      if (signal !== undefined && signal.aborted) return false;
      const target = status.nextChangeAt === null ? null : Date.parse(status.nextChangeAt);
      const remaining = target === null ? 10 * MINUTE_MS : target - Date.now() + 2000;
      // 分段等待：最长 30 分钟检查一次，避免时钟调整/数据刷新后长时间空转。
      await sleepUntilAborted(Math.max(1000, Math.min(remaining, 30 * MINUTE_MS)), signal);
      if (signal !== undefined && signal.aborted) return false;
    }
  };

  const confirmText = (status) => {
    const window = status.pauseWindow === null ? windowText : formatWindow(status.pauseWindow);
    const resume =
      status.nextChangeAtLocal === null || status.nextChangeAtLocal === undefined
        ? ''
        : `，预计 ${status.nextChangeAtLocal.slice(11, 16)} 恢复`;
    const zh =
      `现在是暂停时段（工作日 ${window}，时区 ${timeZone}；当前本地时间 ${status.localTime}${resume}）。` +
      'Agent 已按工作时段策略暂停，不会发起模型请求、也不会消耗 token。' +
      '是否现在就执行这条任务？允许则只放行本次；拒绝则任务继续排队，等时段结束后自动继续。';
    const en =
      `It is a paused work window (${window} on working days, ${timeZone}; local time ${status.localTime}). ` +
      'The agent is paused: no model request and no tokens are consumed. ' +
      'Run this task now? Allow once to run it now; reject to keep it queued until the window ends.';
    return { zh, en };
  };

  const onPreStep = async (payload, next) => {
    const { messages, signal } = payload;
    // 没有新消息的 step 属于暂停前已开始的 turn：放行让该 turn 收尾，避免中途截断。
    if (!Array.isArray(messages) || messages.length === 0) return next();

    const status = stateAt(new Date());
    if (status.state === 'working') return next();

    const agent = payload.agent;

    // goal 连续轮次：原地挂起，避免 goal-round-driver 把 reject 记为永久 block。
    if (messages.some(isGoalMessage)) {
      ctx.logger?.info?.(`work-window: 暂停时段（${status.reason}）挂起 goal 轮次（agent ${agent.id}），等待时段结束`);
      const resumed = await parkUntilWorking(signal);
      if (!resumed) {
        holdMessages(agent, messages);
        return { kind: 'reject' };
      }
      return next();
    }

    const human = messages.some(isHumanMessage);
    if (!human || cfg.confirmDuringPause !== true) {
      holdMessages(agent, messages);
      scheduleWake(agent, status);
      ctx.logger?.info?.(
        `work-window: 暂停时段（${status.reason}）静默暂停一个 step（agent ${agent.id}，${messages.length} 条消息，用户来源=${human}）`,
      );
      return { kind: 'reject' };
    }

    // 用户来源：需要「提醒 + 确认」。没有在线客户端时 approval 会一直 pending，直接排队。
    const gateway = ctx.get('typertGateway');
    const hasLiveClient = gateway === undefined || typeof gateway.hasLiveClient !== 'function'
      ? true
      : gateway.hasLiveClient() === true;
    const approval = ctx.get('approval');
    if (!hasLiveClient || approval === undefined || typeof approval.request !== 'function') {
      holdMessages(agent, messages);
      scheduleWake(agent, status);
      ctx.logger?.warn?.(
        `work-window: approval 通道不可用（liveClient=${hasLiveClient}），暂停时段任务已排队（agent ${agent.id}）`,
      );
      return { kind: 'reject' };
    }

    const controller = new AbortController();
    let timedOut = false;
    const confirmTimer = ctx.timeout(() => {
      timedOut = true;
      controller.abort(new Error('work-window: confirmation timed out'));
    }, cfg.confirmTimeoutMs);
    const forwardAbort = () => {
      try {
        controller.abort(signal === undefined ? undefined : signal.reason);
      } catch {
        /* ignore */
      }
    };
    if (signal !== undefined) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }

    let outcome = 'unavailable';
    try {
      outcome = await approval.request({
        agent,
        toolName: 'work-window',
        reason: `paused-window:${status.pauseWindow === null ? status.reason : formatWindow(status.pauseWindow)}`,
        displayReason: confirmText(status),
        signal: controller.signal,
      });
    } catch (error) {
      ctx.logger?.warn?.(`work-window: 审批请求失败（agent ${agent.id}）: ${error?.message ?? error}`);
      outcome = 'unavailable';
    } finally {
      try {
        confirmTimer();
      } catch {
        /* already fired */
      }
      if (signal !== undefined) signal.removeEventListener('abort', forwardAbort);
    }

    if (outcome === 'allowed-once' && !timedOut) {
      ctx.logger?.info?.(`work-window: 用户在暂停时段放行了 agent ${agent.id} 的本次任务`);
      return next();
    }

    holdMessages(agent, messages);
    scheduleWake(agent, status);
    ctx.logger?.info?.(
      `work-window: 暂停时段任务未执行（agent ${agent.id}，outcome=${outcome}${timedOut ? '，确认超时' : ''}），已放回队列`,
    );
    return { kind: 'reject' };
  };

  const installGate = (agent) => {
    if (agent === null || agent === undefined || gateDisposers.has(agent.id)) return;
    const agentCtx = agent.ctx;
    if (agentCtx === undefined || typeof agentCtx.effect !== 'function') return;
    const dispose = agentCtx.effect(
      () => agentCtx.on('agent/pre-step', onPreStep),
      'work-window: pre-step gate',
    );
    gateDisposers.set(agent.id, dispose);
  };

  const removeGate = (agentId) => {
    const dispose = gateDisposers.get(agentId);
    gateDisposers.delete(agentId);
    if (dispose === undefined) return;
    try {
      dispose();
    } catch {
      /* already unwound with the agent context */
    }
  };

  ctx.on('agent/created', ({ agent }) => {
    if (agent === undefined || agent === null) return;
    liveAgents.add(agent.id);
    installGate(agent);
  });

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent === undefined || agent === null) return;
    liveAgents.delete(agent.id);
    removeGate(agent.id);
    clearWake(agent.id);
  });

  // 插件可能在 agent 已经启动之后才被安装/热加载：给现有 agent 补装门禁。
  const agentsService = ctx.get('agents');
  if (agentsService !== undefined && typeof agentsService.list === 'function') {
    for (const agent of agentsService.list()) {
      liveAgents.add(agent.id);
      installGate(agent);
    }
  }

  ctx.effect(() => () => {
    holidayStore.dispose();
    for (const agentId of [...gateDisposers.keys()]) removeGate(agentId);
    for (const agentId of [...wakeTimers.keys()]) clearWake(agentId);
    liveAgents.clear();
  }, 'work-window: teardown');
}
