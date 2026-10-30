/**
 * host.test.mjs — 在不启动完整 DSH 的前提下验证 Host 半区门禁逻辑。
 *
 * 用最小 fake 实现 cordis ctx / Agent / approval / typertGateway，并用可控的假时钟，
 * 覆盖：
 *   1. 可工作时段：直接放行；
 *   2. 暂停 + 用户任务 + 允许：放行（只放行本次）；
 *   3. 暂停 + 用户任务 + 拒绝/超时：reject，且消息被放回 inbox，并安排唤醒；
 *   4. 暂停 + 定时任务（非用户来源）：静默 reject + 回队，不弹审批；
 *   5. 暂停 + goal 轮次：原地挂起，时段结束后放行（不 reject，避免 goal 被 block）；
 *   6. 无在线客户端：不发起审批，直接回队。
 *
 * 用法：node tools/host.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, Config } from '../index.js';
import { serializeCache } from '../shared/holiday.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const offline = JSON.parse(fs.readFileSync(path.join(here, '..', 'shared', 'offline-holidays.json'), 'utf8'));

/* ------------------------------------------------------------------ *
 * 假时钟
 * ------------------------------------------------------------------ */
const RealDate = globalThis.Date;
let fakeNow = RealDate.parse('2026-10-30T10:30:00+08:00');
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(fakeNow);
    else super(...args);
  }
  static now() {
    return fakeNow;
  }
}
globalThis.Date = FakeDate;

const timers = new Map();
let timerSeq = 0;
function setTimeoutFake(callback, delayMs) {
  const id = ++timerSeq;
  timers.set(id, { id, callback, due: fakeNow + Math.max(0, delayMs) });
  return () => timers.delete(id);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function advanceTo(targetMs) {
  for (;;) {
    let earliest = null;
    for (const timer of timers.values()) {
      if (timer.due <= targetMs && (earliest === null || timer.due < earliest.due)) earliest = timer;
    }
    if (earliest === null) break;
    fakeNow = earliest.due;
    timers.delete(earliest.id);
    earliest.callback();
    for (let index = 0; index < 5; index += 1) await tick();
  }
  fakeNow = targetMs;
  for (let index = 0; index < 5; index += 1) await tick();
}

/* ------------------------------------------------------------------ *
 * 假 ctx / agent
 * ------------------------------------------------------------------ */
let currentScenario = null;
function createHarness(options = {}) {
  const logs = [];
  const listeners = new Map();
  const sections = [];
  const approvalCalls = [];
  const approvalOutcome = options.approvalOutcome ?? 'allowed-once';
  const hasLiveClient = options.hasLiveClient ?? true;
  const agents = [];

  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      debug: (message) => logs.push(['debug', message]),
    },
    effect(fn) {
      const dispose = fn();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    on(name, fn) {
      listeners.set(name, fn);
      return () => listeners.delete(name);
    },
    get(name) {
      if (name === 'approval') return { request: (req) => { approvalCalls.push(req); return Promise.resolve(approvalOutcome); } };
      if (name === 'typertGateway') return { hasLiveClient: () => hasLiveClient };
      if (name === 'agents') return { list: () => [] };
      return undefined;
    },
    interval(fn) {
      return () => {};
    },
    timeout(fn, ms) {
      return setTimeoutFake(fn, ms);
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
  };

  function makeAgent(id) {
    const state = { nextTurn: [], nextStep: [] };
    const agentListeners = new Map();
    const agent = {
      id,
      ctx: {
        effect(fn) {
          const dispose = fn();
          return () => {
            if (typeof dispose === 'function') dispose();
          };
        },
        on(name, fn) {
          agentListeners.set(name, fn);
          return () => agentListeners.delete(name);
        },
      },
      inbox: {
        prepend(target, message) {
          if (target === 'next-turn') state.nextTurn.unshift(message);
          else state.nextStep.unshift(message);
        },
        get nextTurn() {
          return state.nextTurn;
        },
        get nextStep() {
          return state.nextStep;
        },
        get hasPending() {
          return state.nextTurn.length > 0 || state.nextStep.length > 0;
        },
      },
      steers: [],
      steer(message) {
        this.steers.push(message);
        state.nextStep.push(message);
      },
      agentListeners,
      pending: state,
    };
    agents.push(agent);
    return agent;
  }

  currentScenario = { logs, sections, approvalCalls, ctx, makeAgent, listeners };
  return currentScenario;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-window-test-'));
for (const cache of offline) {
  fs.writeFileSync(path.join(tempDir, `holidays-${cache.year}.json`), serializeCache(cache), 'utf8');
}

function startPlugin(overrides = {}, harnessOptions = {}) {
  const harness = createHarness(harnessOptions);
  const validated = Config['~standard'].validate({
    cacheDir: tempDir,
    holidayApiUrl: 'https://invalid.local/{year}',
    holidayTimeoutMs: 1000,
    holidayRetries: 0,
    ...overrides,
  });
  if (validated.issues !== undefined) throw new Error(JSON.stringify(validated.issues));
  apply(harness.ctx, validated.value);
  return harness;
}

function humanMessage(id = 'm-human') {
  return { id, content: [{ type: 'text', text: '跑一下测试' }], source: { kind: 'user' } };
}
function scheduleMessage(id = 'm-schedule') {
  return { id, content: [{ type: 'text', text: '提醒' }], source: { kind: 'schedule' } };
}
function goalMessage(id = 'm-goal') {
  return { id, content: [{ type: 'text', text: 'goal round' }], source: { kind: 'goal', goalId: 'g1', revision: 1, round: 2 } };
}
const enter = async (messages) => ({ kind: 'enter', messages: [...messages] });

function createAgent(harness, id = 'agent-1') {
  const agent = harness.makeAgent(id);
  harness.listeners.get('agent/created')({ agent, source: 'startup' });
  return agent;
}

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const actualText = typeof actual === 'object' ? JSON.stringify(actual) : String(actual);
  const expectedText = typeof expected === 'object' ? JSON.stringify(expected) : String(expected);
  if (actualText === expectedText) {
    passed += 1;
    return;
  }
  failures.push(`${name}: 期望 ${expectedText}，实际 ${actualText}`);
}

function resetClock(iso) {
  fakeNow = RealDate.parse(iso);
  timers.clear();
}

/* ------------------------------------------------------------------ *
 * 1. 可工作时段：直接放行
 * ------------------------------------------------------------------ */
{
  resetClock('2026-10-30T18:30:00+08:00');
  const harness = startPlugin();
  const agent = createAgent(harness);
  let nextCalls = 0;
  const decision = await agent.agentListeners.get('agent/pre-step')(
    { agent, messages: [humanMessage()], turn: 1, step: 1, signal: new AbortController().signal },
    async () => {
      nextCalls += 1;
      return enter([humanMessage()]);
    },
  );
  check('working.nextCalls', nextCalls, 1);
  check('working.decision', decision.kind, 'enter');
  check('working.approvalCalls', harness.approvalCalls.length, 0);
  check('working.promptSection', harness.sections.length, 1);
}

/* ------------------------------------------------------------------ *
 * 2. 暂停 + 用户任务 + 允许 → 放行
 * ------------------------------------------------------------------ */
{
  resetClock('2026-10-30T10:30:00+08:00');
  const harness = startPlugin({}, { approvalOutcome: 'allowed-once', hasLiveClient: true });
  const agent = createAgent(harness);
  let nextCalls = 0;
  const decision = await agent.agentListeners.get('agent/pre-step')(
    { agent, messages: [humanMessage()], turn: 1, step: 1, signal: new AbortController().signal },
    async () => {
      nextCalls += 1;
      return enter([humanMessage()]);
    },
  );
  check('allow.nextCalls', nextCalls, 1);
  check('allow.decision', decision.kind, 'enter');
  check('allow.approvalCalls', harness.approvalCalls.length, 1);
  check('allow.toolName', harness.approvalCalls[0].toolName, 'work-window');
  check('allow.displayReason.hasZh', typeof harness.approvalCalls[0].displayReason?.zh, 'string');
  check('allow.inboxEmpty', agent.pending.nextTurn.length, 0);
}

/* ------------------------------------------------------------------ *
 * 3. 暂停 + 用户任务 + 拒绝 → reject + 回队 + 安排唤醒
 * ------------------------------------------------------------------ */
{
  resetClock('2026-10-30T10:30:00+08:00');
  const harness = startPlugin({}, { approvalOutcome: 'rejected', hasLiveClient: true });
  const agent = createAgent(harness);
  const message = humanMessage('m-rejected');
  let nextCalls = 0;
  const decision = await agent.agentListeners.get('agent/pre-step')(
    { agent, messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
    async () => {
      nextCalls += 1;
      return enter([message]);
    },
  );
  check('reject.nextCalls', nextCalls, 0);
  check('reject.decision', decision.kind, 'reject');
  check('reject.requeued', agent.pending.nextTurn.map((item) => item.id), ['m-rejected']);
  check('reject.timerScheduled', timers.size, 1);
  const timer = [...timers.values()][0];
  check('reject.timerDue', new Date(timer.due).toISOString(), '2026-10-30T04:00:02.000Z'); // 12:00:02 +08:00

  // 到点后应唤醒 agent（steer 一条提示消息），且不产生模型请求。
  await advanceTo(timer.due + 10);
  check('reject.wakeSteer', agent.steers.length, 1);
  check('reject.wakeSource', agent.steers[0]?.source?.kind, 'work-window');
}

/* ------------------------------------------------------------------ *
 * 4. 暂停 + 定时任务（非用户来源）→ 静默回队，不弹审批
 * ------------------------------------------------------------------ */
{
  resetClock('2026-10-30T10:30:00+08:00');
  const harness = startPlugin({}, { approvalOutcome: 'allowed-once', hasLiveClient: true });
  const agent = createAgent(harness);
  const message = scheduleMessage('m-schedule');
  const decision = await agent.agentListeners.get('agent/pre-step')(
    { agent, messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
    async () => enter([message]),
  );
  check('schedule.decision', decision.kind, 'reject');
  check('schedule.approvalCalls', harness.approvalCalls.length, 0);
  check('schedule.requeued', agent.pending.nextTurn.map((item) => item.id), ['m-schedule']);
  check('schedule.timerScheduled', timers.size, 1);
}

/* ------------------------------------------------------------------ *
 * 5. 暂停 + goal 轮次 → 挂起，时段结束后放行（不 reject）
 * ------------------------------------------------------------------ */
{
  resetClock('2026-10-30T10:30:00+08:00');
  const harness = startPlugin({}, { approvalOutcome: 'rejected', hasLiveClient: true });
  const agent = createAgent(harness);
  const message = goalMessage('m-goal');
  let nextCalls = 0;
  const controller = new AbortController();
  const pending = agent.agentListeners.get('agent/pre-step')(
    { agent, messages: [message], turn: 1, step: 1, signal: controller.signal },
    async () => {
      nextCalls += 1;
      return enter([message]);
    },
  );
  await tick();
  check('goal.notYetRejected', nextCalls, 0);
  check('goal.approvalCalls', harness.approvalCalls.length, 0);
  check('goal.noRequeueWhileParked', agent.pending.nextTurn.length, 0);

  // 推进到 12:00:01（暂停结束）后，挂起的 turn 应自动继续。
  await advanceTo(RealDate.parse('2026-10-30T12:00:01+08:00'));
  const decision = await pending;
  check('goal.resumed', nextCalls, 1);
  check('goal.decision', decision.kind, 'enter');
}

/* ------------------------------------------------------------------ *
 * 6. 暂停 + 用户任务 + 无在线客户端 → 不弹审批，回队
 * ------------------------------------------------------------------ */
{
  resetClock('2026-10-30T10:30:00+08:00');
  const harness = startPlugin({}, { approvalOutcome: 'allowed-once', hasLiveClient: false });
  const agent = createAgent(harness);
  const message = humanMessage('m-offline');
  const decision = await agent.agentListeners.get('agent/pre-step')(
    { agent, messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
    async () => enter([message]),
  );
  check('offline.decision', decision.kind, 'reject');
  check('offline.approvalCalls', harness.approvalCalls.length, 0);
  check('offline.requeued', agent.pending.nextTurn.map((item) => item.id), ['m-offline']);
}

/* ------------------------------------------------------------------ *
 * 7. 配置校验
 * ------------------------------------------------------------------ */
{
  const ok = Config['~standard'].validate({
    pauseWindows: ['09:00-12:00', { start: '14:00', end: '18:00' }],
    timeZone: 'Asia/Hong_Kong',
    cacheTtlHours: 6,
  });
  check('config.ok.issues', ok.issues, undefined);
  check('config.ok.windows', ok.value.pauseWindows.length, 2);
  const bad = Config['~standard'].validate({ pauseWindows: ['25:00-26:00'], timeZone: 'Mars/Base' });
  check('config.bad.issues.length', bad.issues?.length, 2);
}

globalThis.Date = RealDate;
fs.rmSync(tempDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`host.test: ${failures.length} failed / ${passed + failures.length}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`host.test: ${passed} passed, 0 failed`);
