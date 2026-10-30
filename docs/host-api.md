# Host 侧 API 调研（工作时段插件 / Work Window Plugin）

> 调研者：host-api（task-1）。所有结论均来自安装包内的**已解包**代码或 README，并给出行号。
> 未运行验证的推断会显式标注「未验证」。
>
> **路径简写**（下文所有 `ASAR/...` 均指从 `<DSH-install-dir>\resources\app.asar` 解包出的
> `<workspace>\.scratch\asar\`，原始 asar 内路径为 `dsh/node_modules/...`）：
>
> - `ASAR/@deepseek-ai/<pkg>/...` = `.scratch\asar\dsh\node_modules\@deepseek-ai\<pkg>\...`
> - 解包命令：`$env:ASAR_OUT='<workspace>\.scratch\asar'; node .scratch/asar-tool.mjs "<DSH-install-dir>\resources\app.asar" extract "dsh/node_modules/@deepseek-ai/<pkg>"`
>
> 本次额外解包（原 BRIEF 未列）：`@deepseek-ai/cordis`、`cordis-plugin-timer`、`dsh-scope`、`dsh-session`、
> `dsh-goal`、`dsh-goal-round-driver`、`dsh-api-gateway`、`dsh-cordis-host-runner`、`dsh-sandbox`、`dsh`。

---

## 0. 结论速查（可直接采用）

| # | 问题 | 结论 |
|---|---|---|
| 1 | `agent/pre-step` 能否拦截 | 能。`waterfall` 模式，监听器 `async (payload, next) => decision`；返回 `{kind:'reject'}` 即阻止该 step（`turn/end` reason = `blocked`），不产生模型请求。 |
| 2 | reject 后消息是否保留 | **不保留**。事件到达时消息已被 `inbox.claim()` 用「纯删除 splice」从 inbox 投影中消费掉；不会自动回队，也没有内置重试/timer。要「下个窗口再跑」必须插件自己保存并重新 `agent.followup(msg)`/`agent.steer(msg)`。 |
| 3 | 谁唤醒 agent | 只有带 `wakeup=true` 的 `send`（`followup`/`steer`），或维护/轮次结束时的 latch。**没有基于时间的自动唤醒**。 |
| 4 | pre-step 时 turn 是否 open | **是**。`turn()` 先 `session.append('turn/start')`，再调 `preStep()`。因此 `ctx.approval.request()` 的「必须处于 turn 内」前置条件天然满足。 |
| 5 | 用户确认通道 | 首选 `ctx.userQuestions.ask({agent, questions, signal})`（会话内问题卡片，多选项+自定义文本）；次选 `ctx.approval.request({agent, toolName, reason, displayReason, signal})`（二元 允许一次/拒绝，但文案是「工具请求越权执行」，语义偏）。两者都是 forwarded waterfall：**需要已连接的 owner Web 客户端**才能作答；无客户端时**两者都会一直挂起**（pending 直到 signal 中止 / agent 上下文释放），不会快速失败 —— 必须先 `hasLiveClient()` 守卫 + 超时（见 §2.4/§2.5）。 |
| 6 | systemPrompt | `ctx.systemPrompt.section({name, order, text})`，`text` 可为 `(context)=>string`，`context.agent` 是本次组装的目标 agent；每个 step 都会重新 assemble，所以动态状态文案自动刷新。返回 disposer，随 fiber 清理。 |
| 7 | Config | **不是 JSON Schema**，是 Standard Schema（`Config["~standard"].validate`）。DSH 自带包全部用 `@deepseek-ai/schemastery`（`z.object`）。配置目录/表单只认 native schemastery（否则 `Config is not a native Schemastery schema`）。 |
| 8 | 定时器 | `ctx.timeout/interval`（`@deepseek-ai/cordis-plugin-timer`，dsh-base 已挂载）；`ctx.setTimeout` 是同义但**已废弃**的别名。都绑定到创建它的 fiber，插件卸载自动清理。 |
| 9 | 消息来源 | `MessageSourceMap` 中用户来源是 `kind:'user'`（含 `user-rpc`，Web 输入）；自动来源是 `kind:'goal'`、`'schedule'`、`'agent-message'`、`'team-message'`、`'subagent-settled'`、`'webhook'` 等。 |

---

## 1. `agent/pre-step` 事件（waterfall）

### 1.1 分发点与 payload（权威代码）

`ASAR/@deepseek-ai/dsh-agent-loop/lib/index.js:902-927`：

```js
async preStep(target, position) {
    if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": pre-step outside running phase`);
    const signal = this.phase.abort.signal;
    const claimed = this.inbox.claim(target, position.turn);          // ① 先消费消息
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
    signal.throwIfAborted();
    const decision = await this.dispatch.waterfall("agent/pre-step", { // ② 再跑 waterfall
        messages: claimed,
        ...position,                                                  //    turn, step
        signal
    }, () => {
        const sections = renderContextSections(assembly);
        const context = this.runtimeContext.project(joinContextSections(sections), sections);
        return Promise.resolve({
            kind: "enter",
            messages: context === void 0 ? claimed : [...claimed, context]
        });
    });
    signal.throwIfAborted();
    if (decision.kind === "reject") return decision;
    return { ...decision, assembly };
}
```

- 事件名：`agent/pre-step`，dispatch 模式 **waterfall**（`dsh-agent/README.md:67`：
  “`agent/pre-step` can reject a proposed step or replace the messages entering it”）。
- 监听器签名：`async ({ agent, messages, turn, step, signal }, next) => decision`。
  - `agent` 由 `agentEvents()` 的 fused 逻辑注入（`ASAR/@deepseek-ai/dsh-agent/lib/types/dispatch.js:31-74`，`fused = (payload) => ({ ...payload, agent })`）。
  - `messages`：本 step 被领取的 `UserMessage[]`（`next-step` 全部 + `target==='next-turn'` 时再带 1 条 `next-turn`）。
  - `turn` / `step`：来自 `position`。
  - `signal`：本 turn 的 `AbortSignal`。
- **是 async**：`dispatch.waterfall` 是 `await` 的，返回值来自监听器 Promise；`cordis` 的 waterfall 逐个 await
  （`ASAR/@deepseek-ai/cordis/lib/index.js:317-325`）。
- 返回值词汇：`{kind:'enter', messages}`（放行，可换消息）或 `{kind:'reject'}`（拒绝）。
  另可携带 `startsRequestSeries: true` 等字段，改写时必须 `{...decision, messages}` 展开保留
  （`ASAR/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:16`）。
- **不调用 `next()` 且返回非 decision 值 = 破坏行为**：cordis waterfall 的 `next()` 会把后续监听器当 `next`，
  若最后一个监听器不回调也不返回决定，`preStep` 里的 `decision.kind` 会因 `decision === undefined` 抛 TypeError。
  所以「不拥有决定」时必须 `return next()`（同上 practices.md:16）。

### 1.2 真实监听器范例（可直接照抄形状）

同仓库里有两处真实用法：

**(a) 只观察不改写** — `ASAR/@deepseek-ai/dsh-agent/lib/index.js:193-204`：

```js
const disposeNotice = agentCtx.on("agent/pre-step", async ({ agent, messages, signal, step }, next) => {
    const decision = await next();
    if (decision.kind === "reject" || signal.aborted) return decision;
    ...
    return { ...decision, messages: [...decision.messages, modelSwitchNotice(previous, selected)] };
}, { prepend: true });
```

**(b) 真正 reject + 恢复同一批里别人的消息** — `ASAR/@deepseek-ai/dsh-goal-round-driver/lib/index.js:291-352`
（**这是本插件最值得抄的骨架**）：

```js
ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const submitted = messages.find((message) => isGoalRoundSource(message.source));
    if (submitted === void 0) return next();          // 不管的消息：必须 next()
    ...
    if (!valid) {
        restoreOtherClaimed(agent, messages, submitted.id);  // 把同批中“非自己”的消息还回 next-step
        requestDrive(state);
        return { kind: "reject" };
    }
    const decision = await next();
    if (signal.aborted) { ...          return decision; }
    if (decision.kind === "reject") { ... return decision; }
    ...
    return { ...decision, startsRequestSeries: true };
});
```

它恢复消息的具体实现（`同文件:99-106`）：

```js
function restoreOtherClaimed(agent, messages, messageId) {
    const retained = messages.filter((message) => message.id !== messageId && !(...));
    for (const message of retained.toReversed()) {
        if (agent.inbox.nextStep.some((c) => c.id === message.id) || agent.inbox.nextTurn.some((c) => c.id === message.id)) continue;
        agent.inbox.prepend("next-step", message);   // 反向 prepend 恢复原顺序
    }
}
```

> 注意：这段先例只恢复「别人的消息」，把自己那条丢掉。说明 framework 认为 **被 claim 的消息由监听器负责善后**。

### 1.3 reject 之后到底发生什么（逐行）

1. `turn()` 里 `turn/start` 已经写入，然后才调用 `preStep`（`ASAR/@deepseek-ai/dsh-agent-loop/lib/index.js:937-968`）：

```js
const turn = phase.turn + 1;
this.session.append("turn/start", { turn });        // 944-945
...
while (true) {
    const step = phase.step + 1;
    const decision = await this.preStep(target, { turn, step });   // 956-959
    if (decision.kind === "reject") {
        turnEnds = { kind: "blocked" };             // 960-961
        return false;                                // 962
    }
    ...
}
```

2. `return false` 让 `kick()` 的 `while (await this.turn())` 退出（`同文件:887-901`），phase 回到 `idle`；
   `turn/end` 在 `finally` 中写入 `{reason: {kind:'blocked'}}`（`同文件:1027-1036`）。
3. **该批消息不会被放回 inbox**：`claim()` 是「纯删除 splice」，没有 `outcome: 'canceled'`（`同文件:103-111`）：

```js
claim(target, turn) {
    const claimed = this.mutate("next-step", 0, this.nextStep.length, [], false);
    if (target === "next-turn") claimed.push(...this.mutate("next-turn", 0, 1, [], false));
    for (const message of claimed) this.dispatch.emit("agent/inbox/claimed", { message, turn });
    return claimed;
}
```

   `mutate(..., discardRemoved=false)` 只在 `discardRemoved && removedCount>0` 时写 `outcome:'canceled'`
   （`同文件:179-208`）；claim 走的是不带 outcome 的分支。README 也明确：
   “claiming uses pure deletions with no outcome and emits `agent/inbox/claimed`”
   （`ASAR/@deepseek-ai/dsh-agent-loop/README.md:71`）。
4. 消息内容仍留在 session 日志里（最初入队时写过一条 `agent/inbox/spliced` 且 `inserted:[message]`），
   但 **inbox 投影里没有了**，agent 不会再自动看到它。
5. README 对「rejected decision」的官方描述：`ASAR/@deepseek-ai/dsh-agent-loop/README.md:120`
   “A rejected decision or empty first batch opens no step.”

### 1.4 什么会再次唤醒 agent（无重试 / 无 timer）

- 入队并唤醒：`agent.followup(msg)` / `agent.steer(msg)` → `send(msg, target, wakeup=true)`
  （`ASAR/@deepseek-ai/dsh-agent-loop/lib/index.js:800-814`）：

```js
send(message, target, wakeup) {
    const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
    const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
    this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
    if (wakeup) this.wakeDriver(wakingAfterAbort);
}
followup(input) { this.send(input, "next-turn", true); }
steer(input)    { this.send(input, "next-step", true); }
inject(input)   { this.send(input, "next-step", false); }   // 不唤醒
```

- `wakeDriver()` 只在 `phase.kind === 'idle'` 时真正起 driver（`同文件:854-869`）；另外维护任务/latch 结束时会补一次
  （`同文件:841`、`898`）。
- **没有任何 `setTimeout` 重新驱动业务逻辑的重试机制**；被 reject 的 turn 结束后 agent 就是 idle。
- `agent.inject()` **不唤醒**（practices.md:29：“`agent.inject()` does not wake it”），适合「等待其他输入时再带上」的上下文，
  不适合「到点自动开工」。到点开工必须用插件自己的 `ctx.interval`/`ctx.timeout` + `agent.followup()`。

### 1.5 结论（给本插件）

- 门禁点就是 `agent/pre-step`，拿 `messages`、`agent`、`signal`，判暂停就 `return {kind:'reject'}`，否则 `return next()`。
- **reject 前必须自己决定 how to 善后**（这是官方 goal-round-driver 也在做的事）：
  1. 想「本批里非用户来源的消息立即重跑」→ 照抄 `restoreOtherClaimed` 放回 `next-step`；
  2. 想「延后到可工作时段」→ 在内存里按 agent 保存这批 `UserMessage`，起 timer 到时间再 `agent.followup(message)`；
     不要指望 framework 帮忙。
- 若恢复后立刻有 pending，`turn()` 返回 `true` 会马上开下一个 turn（`同文件:1037-1041`，`if (!this.inbox.hasPending) return false;`）——
  **这是「恢复消息会立刻重跑」而不是「等到窗口结束」的原因**，所以要延后就必须等 timer，不能在 reject 当时就放回。

---

## 2. 在 pre-step 内让用户确认

### 2.1 前置事实：pre-step 时 turn 已打开

`turn()` 的顺序是 `session.append('turn/start')`（`ASAR/@deepseek-ai/dsh-agent-loop/lib/index.js:944-945`）→
`preStep()`（`同文件:956`）。而 approval 的检查就是「日志最后一条 turn 事件是 `turn/start`」
（`ASAR/@deepseek-ai/dsh-user-approval/lib/index.js:49-56`）：

```js
function hasOpenTurn(session) {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
        const type = session.eventAt(SessionSeq(seq))?.type;
        if (type === "turn/start") return true;
        if (type === "turn/end") return false;
    }
    return false;
}
```

⇒ **pre-step 内调用 `ctx.approval.request()` 不会触发 “outside an open turn” 异常**（该异常见
`同文件:128-130`）。这是本次调研明确回答的疑点。

### 2.2 方案 A：`ctx.userQuestions.ask()`（推荐做主确认）

**签名**（`ASAR/@deepseek-ai/dsh-user-questions/lib/typert.host.js:287-292` 的声明；实现
`ASAR/@deepseek-ai/dsh-user-questions/lib/index.js:668-691`）：

```ts
// 请求
export interface AskUserQuestionRequestEvent {
    questions: AskUserQuestionItem[];
    agent?: Agent;                 // 传 agent 才会转发到该会话的 Web UI
    signal?: AbortSignal;
    wait?: { callId: ToolCallId; timed?: boolean };   // 可选；不传也能弹卡片
}
// 单题（typert.host.js:279-285）
export interface AskUserQuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: AskUserQuestionOption[];   // { label: string; description?: string }
    multiSelect?: boolean;
    intent?: AskUserQuestionIntent;
}
// 答案（typert.host.js:267-273）
export interface AskUserQuestionAnswer {
    answers: { id: string; selected: string[]; custom?: string }[];
}
// 方法签名（typert.host.js:220）
async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
```

**行为/限制**（README `ASAR/@deepseek-ai/dsh-user-questions/README.md:27,33,35` + 代码）：

- 传了 `agent` 时必须在 `AgentRegistry` 里是**同一个 live 实例**，且必须是 **runtime root**，否则
  `CALLER_NOT_LIVE` / `DELEGATED_CALLER`（`lib/index.js:531-535`）。pre-step payload 里的 `agent` 正好满足。
- 传了 agent 时 waterfall 按 agent scope 分发 `user-questions/request`（`lib/index.js:681-684`），
  `dsh-api-remotes` 把它列入 forwarded waterfall（`ASAR/@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js:44`），
  Web 客户端 `ctx.remote.$on("user-questions/request", ...)` 接收（`ASAR/@deepseek-ai/dsh-client-ui-user-questions/lib/client.js:1932-1934`）。
- 客户端不需要真实 tool call：`const callId = request.wait?.callId;`，无 callId 时照样建卡片，settle 后 `card.remove()`
  （`client.js:1765-1766, 1814`）。
- 无任何 answerer 时立刻 `NO_PROVIDER`（`lib/index.js:679`：“no user-questions answerer accepted the request”）；
  但**有 forwarded 通道、没有已连接客户端**时会 pending，见 §2.5 的风险。

**最小调用（pre-step 内）**：

```js
const uq = ctx.get('userQuestions');                   // 可选服务，缺省时降级
const answer = await uq.ask({
  agent,
  signal,                                              // 传 pre-step 的 signal：turn 被取消时会中止提问
  questions: [{
    id: 'work-window',
    header: '工作时段',
    question: `现在是暂停时段（${state.reason}）。是否仍要执行本次任务？`,
    options: [
      { label: '本次放行', description: '只放行这一次；不修改时段配置' },
      { label: '不执行', description: '暂不执行，等到可工作时段' }
    ]
  }]
});
const allow = answer.answers[0]?.selected.includes('本次放行');
```

### 2.3 方案 B：`ctx.approval.request()`（备选二元授权通道）

**签名与调用形状**（真实生产用法：`ASAR/@deepseek-ai/dsh-sandbox/lib/index.js:99-122`）：

```js
const outcome = await approval.approver.request({
    agent,                    // Agent（必需，决定路由到哪个会话）
    toolName,                 // string（必需；UI 文案「工具 {toolName} 请求越权执行」）
    callId,                   // 可选 ToolCallId（关联 tool 卡片）
    reason: `...`,            // 可选 string，写入 approval/asked 审计
    displayReason: { en: '...', zh: '...' },   // 可选，本地化展示文案（不写日志）
    ...signal ? { signal } : {}
});
switch (outcome) {
    case "allowed-once": ...
    case "rejected": ...
    case "cancelled": ...
    case "unavailable": ...
}
```

- 服务实现：`ASAR/@deepseek-ai/dsh-user-approval/lib/index.js:128-144`；`request()` 先写
  `approval/asked`、再 `approval/decided`，**要求 turn 已打开**（§2.1）。
- 结果词汇唯一：`'allowed-once'|'rejected'|'cancelled'|'unavailable'`（`同文件:30-35`）。
- `unavailable` = 没有可用应答者/应答者抛错/非词汇返回，**fail closed**（`同文件:172-189`）。
- Web UI 证据：`approval/request` 在 forwarded waterfall 白名单
  （`ASAR/@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js:18`），客户端
  `ctx.remote.$on("approval/request", ...)`（`ASAR/@deepseek-ai/dsh-client-ui-approval/lib/client.js:355-357`），
  面板注册在 `conversation.composer`（`client.js:344-354`）。
- **语义风险**：approval 是「工具越权执行」的二元授权（允许一次/拒绝），文案写死
  （`client.js:260-270`：`escalation: "工具 {toolName} 请求越权执行"`），用于「工作时段确认」会误导用户；
  且 `allowed-once` 的语义是「一次性放行」，与本插件需求恰好吻合。**如果只是要一个二元确认，可用；否则用 A。**

### 2.4 通道可用性守卫（避免弹窗无人应答时卡死）

`ctx.typertGateway.hasLiveClient()` 存在且含义明确（`ASAR/@deepseek-ai/dsh-api-gateway/lib/index.js:837-844`：

```js
/** Check for an active owner Client event stream, the only kind that can answer forwarded waterfalls. */
hasLiveClient() {
    for (const client of this.remoteEventClients.values()) if (client.answers && !client.signal.aborted) return true;
    return false;
}
```

README 也提到 “`hasLiveClient()` checks uncancelled owner answering streams”（`ASAR/@deepseek-ai/dsh-api-gateway/README.md:49`）。
但它不是 `@Remote` 生成的业务 API（属于 gateway 内部方法），**升级稳定性未验证**。

**推荐守卫写法**：

```js
function hasAnswerer(ctx) {
  try {
    const gw = ctx.get('typertGateway');
    if (gw !== undefined && typeof gw.hasLiveClient === 'function') return gw.hasLiveClient();
  } catch {}
  return true;   // 拿不到该服务时不阻断（由下面的超时兜底）
}
```

### 2.5 失败/边界行为汇总

> 关键机制：`dsh-api-remotes` 在注册时**一次性**创建 queue 并把 `approval/request`、`user-questions/request`
> 两个 waterfall 监听器挂到 queue 上（`ASAR/@deepseek-ai/dsh-api-remotes/lib/index.js:146-181`）。
> 监听器收到请求后 `forwardWaterfall()` 把 dispatch 放进 `pendingRemoteEvents` 并返回一个 Promise
> （`同文件:233-250`）；该 Promise 只在三种情况 settle：
> ① 有 owner 客户端作答；② `request.signal` abort（`gateway/lib/index.js:1081-1085`）；
> ③ 该 Agent 的 `agent.ctx` 被释放 / 事件源关闭（`同文件:1069-1076, 1156-1159`）。
> **没有「无客户端 → 立刻 fail closed」的分支**：无客户端时 dispatch 会一直停在 pending，直到客户端连上
> 再补投递（`同文件:1014`：`if (client.answers) for (const pending of this.pendingRemoteEvents.values()) this.deliverRemoteEvent(pending, client)`）。
> README 所说的 “缺少应答者 → unavailable” 只适用于「event source 未注册（没有 web bundle）」的情况。
> 因此 **A、B 两条通道在没有在线客户端时都会卡住 turn**，这是本插件最大的运行时风险（R4）。

| 场景 | userQuestions.ask | approval.request |
|---|---|---|
| 没有该服务（profile 未装） | `ctx.get()` 为 undefined → 插件降级（直接 reject 或放行，按配置） | 同上 |
| 有服务、event source 正常、**无已连接 owner 客户端** | 请求进入 `pendingRemoteEvents`，**无限挂起**，直到客户端连上或 signal 中止（推断自 gateway 代码，未实测） | 同样进入 pending，**不会**立刻返回 `unavailable` |
| 客户端中途断开 | gateway 对「0 个 delivery」的 pending 回 `{kind:'next'}` → 走到 `NO_PROVIDER` 异常（推断自 `gateway/index.js:1124-1125`） | 同上 → `decide()` 的 next 是 `'unavailable'` |
| 有客户端、用户点「拒绝」 | 返回 `answers`，按内容拒绝 | `'rejected'` |
| turn 被取消（用户点停止） | `signal` abort → `ASK_ABORTED` 抛错，**需 try/catch** | 返回 `'cancelled'` |
| 子 agent（被委派） | `DELEGATED_CALLER` 抛错（不要给子 agent 弹窗） | `user-approval` 不校验 root，但对子 agent 弹窗用户体验差 |

**因此推荐**：先 `hasAnswerer()`，无客户端就直接 reject（不耗 token、不弹窗）；有客户端才 `ask`，
并**同时**用「组合 AbortSignal + 超时」兜底：超时后 abort 提问信号，让 `ask` 以 `ASK_ABORTED` 结算，
避免 pending 事件残留（代码见 §7）。

---

## 3. `ctx.systemPrompt.section()`（提示词注入）

### 3.1 签名与作用域

README（`ASAR/@deepseek-ai/dsh-system-prompt/README.md:54-68`）：

```text
ctx.systemPrompt.section({
  name: 'tool:bash',
  order: 100,
  text: 'Prefer bash for file and process operations.',
})
```

代码（`ASAR/@deepseek-ai/dsh-system-prompt/lib/index.js:245-256`）：

```js
/**
 * Register an ordered prompt section in the calling context's scope. A scoped
 * section shadows a global section with the same name; duplicates within one
 * layer and non-finite orders throw. Registration and disposal emit `system-prompt/change`.
 * @returns the exact Cordis effect disposer.
 */
section(section) {
    if (!Number.isFinite(section.order)) throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
    return this.layers.effect(this.ctx, (layer) => layer.sections.insert(section.name, section), { label: "systemPrompt.section()" });
}
```

- 注册上下文 **决定作用域**：在插件根 ctx（unscoped）上注册 = **全局**，对所有 agent 生效；
  在某个 `agent.ctx` 上注册 = 只影响该 agent，并 shadow 同名全局（README:28、112-114：`Scoping`）。
- 外部贡献可以用任意有限 `order`；`getSectionOrder(name)` 只服务仓内集中分配的名字
  （`lib/index.js:262-264`，`SECTION_ORDERS[name]` 未命中 → `undefined` → 上面 `Number.isFinite` 抛错）。
- 返回 disposer（`ctx.effect`），随插件 fiber 卸载自动清理；也可手动调用。

### 3.2 动态文案：`text` 可以是函数

组装时对每个 section 求值（`lib/index.js:380-397`）：

```js
const sectionDefinitions = [...sectionByName.values()].sort(comparePromptSections);
...
const assembly = {
    sections: sectionDefinitions.map((section) => ({
        name: section.name,
        text: typeof section.text === "function" ? section.text(context) : section.text,
        ...
    })),
    ...
};
```

而 `context` 来自 `assembleContextFor(agent, signal)`（`ASAR/@deepseek-ai/dsh-agent/lib/types/dispatch.js:82-94`）：

```js
export function assembleContextFor(agent, signal) {
    return { agent, scope: agent, ...signal === undefined ? {} : { signal } };
}
```

⇒ **全局 section 的 `text(context)` 也能拿到 `context.agent`**，可以按 agent/会话计算文案。
loop 每个 step 都会重新 `assemble()`（`ASAR/@deepseek-ai/dsh-agent-loop/lib/index.js:907`），
所以「当前是否暂停 / 下一个可工作时段」这类时间文案会在**每个新 step 自动重新计算**，无需手动刷新。

> 注意：`refreshContext()`（`lib/index.js:324-346`）只刷新 *context*（runtime-context），不会重跑 section 的
> `text`；但每个 step 的新 `assemble()` 会。状态变化本身**不会唤醒 idle agent**（见 §1.4）。

### 3.3 其它相关 API（同一服务）

- `ctx.systemPrompt.context({name, order, text})`：动态 runtime context（user-role 快照），每个 step 前由
  `refreshContext` 重取（README:66-68）；示例实现见 `ASAR/@deepseek-ai/dsh-user-approval/lib/index.js:79-89`。
- `ctx.systemPrompt.variable(name, provider)`：`{{name}}` 插值（README:70-78），名字必须 `[a-z][a-z0-9_]*`。
- `ctx.systemPrompt.getSectionOrder('NAME')` / `getContextOrder('NAME')`。
- 只加文本，**不要**在 `system-prompt/assemble` 里改 text/tools（practices.md:17）；也不要用它改工具集。

### 3.4 与本插件相关的示例

```js
const dispose = ctx.systemPrompt.section({
  name: 'work-window:policy',
  order: 15_000,                          // 外部贡献可用任意有限 order
  text: (context) => {
    const agent = context.agent;
    const state = statusNow();            // 纯函数：现在是否暂停、下一窗口
    return [
      '## 工作时段策略',
      `当前状态：${state.state === 'paused' ? `暂停中（${state.reason}）` : '可工作'}`,
      `暂停区间（工作日）：${config.pauseWindows.map((w) => `${w.start}-${w.end}`).join('、')}`,
      state.state === 'paused'
        ? `暂停期间不要主动开始新的工作；用户下达任务时先请求确认。下一个可工作时刻：${state.nextWorkAt}。`
        : '当前可自由工作。'
    ].join('\n');
  }
});
// 卸载时：dispose()；或依赖 fiber 自动清理
```

---

## 4. `Config`（插件配置）

### 4.1 机制：Cordis 只认 Standard Schema

`ASAR/@deepseek-ai/cordis/lib/index.js:956-962`：

```js
function resolveConfig(runtime, config) {
    if (!runtime.Config) return config;
    const result = runtime.Config["~standard"].validate(config);
    if ("then" in result) throw new TypeError("Async config validation is not supported");
    if (result.issues) throw new ValidationError(result.issues);
    else return result.value;
}
```

- `runtime.Config = plugin.Config`（`同文件:1619-1635`），所以模块上 `export const Config = ...`
  会被 loader 自动取用（`plugin` 就是模块导出对象 / `{apply}` 对象）。
- 失败抛 `ValidationError`（`cordis` 932-947），插件不会激活。
- **不是 JSON Schema**；配置目录/表单工具额外要求 native schemastery：
  `ASAR/@deepseek-ai/dsh-app-boot/lib/index.js:3402-3408`：

```js
const schema = configOf(plugin);
if (schema !== void 0 && schema !== null) if (!isNativeConfigSchema(schema)) {
    entry.status = "unsupported";
    report(path, "Config is not a native Schemastery schema");
} else {
    entry.status = "schema";
    entry.native = schema;
}
```

⇒ 想让 `Config.listConfigs` / 配置表单展示字段，必须用 schemastery 写。

### 4.2 真实 Config 例子（3 个，均为自带包）

**(1) 简单 union + default** — `ASAR/@deepseek-ai/dsh-user-approval/lib/index.js:74`：

```js
static Config = z.object({ policy: z.union(["ask", "never"]).default("ask") });
```

**(2) 标量 + 数组 + default** — `ASAR/@deepseek-ai/dsh-system-prompt/lib/index.js:214-220`：

```js
static Config = z.object({
    includeHarnessIdentity: z.boolean().default(true),
    includeRuntimeContext: z.boolean().default(true),
    personaPrefix: z.string().default(""),
    personaSuffix: z.string().default(""),
    toolOrder: z.array(z.string()).default(void 0)
});
```

**(3) number 约束 + 对象数组（可作为 pauseWindows 的写法参考）** —
`ASAR/@deepseek-ai/dsh-agent-loop/lib/index.js:1553-1565`：

```js
static Config = z.object({
    maxParallelToolCalls: z.number().step(1).min(1).default(10).volatile(),
    agents: z.array(z.object({
        id: z.string().required(),
        sessionId: z.string().min(1),
        provider: z.string(),
        model: z.string(),
        reasoningEffort: z.string().min(1),
        maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
        cwd: z.string(),
        resumeSessionId: z.string()
    })).default([])
});
```

另见 `ASAR/@deepseek-ai/dsh-schedule/lib/index.js:1976-1979`（`z.number().step(1).min(1).max(3650).default(...)`）。

### 4.3 插件里怎么写 + 依赖声明

自带包能 `import z from "@deepseek-ai/schemastery"` 是因为它们位于安装包自己的 node_modules。
本地 bundle 想 import 安装里的 schemastery，需要让 DSH 的包解析拦截层把裸说明符路由到 installation：

- profile/链接包的解析表来自 `createRuntimeResolution()` / `ProfileRuntimeResolution`
  （`ASAR/@deepseek-ai/dsh-app-boot/lib/index.js:766-799`），安装 scope 的包表来自
  `collectInstallationScopePackages()`（`同文件:716-759`，遍历 app manifest 的 dependencies；
  `@deepseek-ai/dsh` 的 `dependencies` 里确实有 `@deepseek-ai/schemastery`）。
- linked root（工作区目录软链进 profile）的裸 import 走 `routeLinked()`（`同文件:1676-1730`）：
  **只有插件自己的 `package.json` 在 `peerDependencies` 里声明了该名字**，才会路由到 installation 的副本
  （`readPeerNames(directory).has(name)`，`同文件:1682-1689`）；否则落到原生 Node 解析（会失败）。
- profile 内直接复制的包走 `routeScoped()`，installation entry 命中即用（`同文件:1664-1674`）。

因此对**工作区软链安装**方式，务必在插件 `package.json` 加：

```json
"peerDependencies": { "@deepseek-ai/schemastery": "*" }
```

（这是根据 app-boot 解析代码推出来的必要条件，**安装方式确定后需实测**——未验证。）

**Config 写法（推荐）**：

```js
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  timeZone: z.string().default('Asia/Hong_Kong'),
  pauseWindows: z.array(z.object({
    start: z.string().pattern(/^\d{2}:\d{2}$/).default('09:00'),
    end: z.string().pattern(/^\d{2}:\d{2}$/).default('12:00')
  })).default([
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' }
  ]),
  holidayApiUrl: z.string().default('https://timor.tech/api/holiday/year'),
  cacheTtlHours: z.number().step(1).min(1).max(720).default(24),
  confirmationMode: z.union(['ask', 'reject']).default('ask'),
  timeoutMs: z.number().step(1000).min(5000).default(120000)
});
```

**零依赖兜底写法**（不能 import schemastery 时；`Config.listConfigs` 会显示 `unsupported`，但**激活校验仍然工作**，
因为 cordis 只要求 `~standard`）：

```js
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'work-window',
    validate(value) {
      const v = value && typeof value === 'object' ? value : {};
      const out = { ...defaults, ...v };
      const issues = [];
      if (typeof out.timeZone !== 'string') issues.push({ message: 'timeZone must be a string', path: ['timeZone'] });
      if (!Array.isArray(out.pauseWindows)) issues.push({ message: 'pauseWindows must be an array', path: ['pauseWindows'] });
      return issues.length > 0 ? { issues } : { value: out };
    }
  }
};
```

> `ValidationError` 期望 `issues[].message` + 可选 `path`（`cordis` 940-945），所以 issue 形状要匹配。

### 4.4 配置如何到达插件

- `cordis.patch.yml` 的 `config:` 在激活时经 `resolveConfig` 校验后作为 `apply(ctx, config)` 第二参传入
  （`cordis` 1619-1635；`host-plugin.md:59-64`）。
- patch 覆盖是「整行 config 替换」而不是合并（`host-plugin.md:3`），所以插件默认值应写在 `Config` 的 `.default()` 里。

---

## 5. `ctx.on` / `ctx.effect` / 定时器

### 5.1 `ctx.on(name, listener, options)`

`ASAR/@deepseek-ai/cordis/lib/index.js:360-380`：

```js
/**
 * Register an event listener owned by the current fiber.
 * The listener is removed automatically when the fiber unloads. Throws
 * `CordisError('INACTIVE_EFFECT')` if the fiber is already disposed.
 * @returns a disposer removing the listener; `true` if it was still registered.
 */
on(name, listener, options) { ... }
```

- `options`：`{ prepend?: boolean, global?: boolean }`；`true` 是 `{prepend:true}` 的简写。
- listener 若需要继续 waterfall，必须 `return next()`（或 `await next()` 后加工）。
- 作用域：在插件根 ctx 上注册 = **对每个 agent 的 agent-scoped 事件都可见**。依据
  `ASAR/@deepseek-ai/dsh-scope/lib/index.js:315-338` 的 `scopeTarget()`：

```js
carrier = { [Context.filter](ctx) {
    if (baseFilter !== undefined && !baseFilter.call(base, ctx)) return false;
    const tag = scopeOf(ctx);
    if (tag === undefined) return true;                       // ← 未打 scope 标签的监听器全局可见
    for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;
    return false;
} };
```

  即「注册在 agent 自身 scope 上的监听器只收该 agent；注册在根（无 tag）的收所有 agent」。
  真实先例：`dsh-goal-round-driver` 在根 ctx 上 `ctx.on("agent/pre-step", ...)`（`lib/index.js:291`），
  同时在根 ctx 上处理 `agent/created` / `agent/status` / `agent/inbox/*`（`同文件:210-284`）。
- **per-agent 注册**：`agent/created` 事件（serial）里拿到 `agent.ctx`，在该 ctx 上注册，agent 销毁自动清理；
  但按 practices.md:19，需要 `agent.ctx.effect()` 包一层并在插件侧再持有 disposer（插件卸载不会自动清 agent.ctx 注册）：

```js
const disposers = new Map();            // agent -> dispose
ctx.on('agent/created', async ({ agent }) => {
  const dispose = agent.ctx.effect(function* () {
    const off = agent.ctx.on('agent/pre-step', handler);
    yield () => off();
    // 其它 per-agent 注册...
  }, 'work-window: agent gate');
  disposers.set(agent, dispose);
}, { global: true });
ctx.on('agent/disposed', ({ agent }) => { disposers.get(agent)?.(); disposers.delete(agent); });
```

  `agent/created` payload：`{ agent, source, signal? }`（`ASAR/@deepseek-ai/dsh-agent/lib/index.js:574-590`）。
  注意 `agent/created` 监听器**不得 await `agent.whenIdle()`/自身 owner dispose**（`dsh-agent/README.md:176`）。

> 本插件更简单：只需一个根 ctx 的 `agent/pre-step`，不用 per-agent 注册。

### 5.2 `ctx.effect(execute, label)`

`cordis` 1169-1210 起；支持：
- 返回 disposer 函数 → 收集（`runner.collect`）；
- 返回 generator（`function*`）→ 先 yield 一个或多个 disposer，最后 `yield` 清理（`cordis:1146-1153`）；
- 返回 Promise → 异步清理（`cordis:1145`）；
- 返回 `undefined`/`null` → 无清理。

返回值是 disposer，可手动调用；fiber 卸载时自动按反序执行。
本仓库真实例子：`ASAR/@deepseek-ai/dsh-schedule/lib/index.js:2008-2030`（异步初始化 + 嵌套 effect 清理）、
`dsh-goal-round-driver/lib/index.js:210-374`（`ctx.effect(function*(){...ctx.on...; yield async()=>{卸载逻辑}})`）。

### 5.3 定时器（`ctx.timeout` / `ctx.interval`）

`ctx.setTimeout`/`ctx.setInterval` 由 timer 服务 mixin 提供（`ASAR/@deepseek-ai/cordis-plugin-timer/lib/index.js:4-23`）：

```js
var TimerService = class extends Service {
    constructor(ctx) {
        super(ctx, "timer");
        ctx.mixin("timer", ["timeout","interval","throttle","debounce","setTimeout","setInterval"]);
    }
    /** @deprecated use `ctx.timeout()` instead */
    setTimeout(callback, delay) { return this.timeout(callback, delay); }
    ...
};
```

- 该插件在 base 层**已挂载**：`ASAR/@deepseek-ai/dsh-base/cordis.patch.yml:24-25`（`id: timer` / `name: '@deepseek-ai/cordis-plugin-timer'`）。
  所以 Host 插件可直接用，无需 inject（但稳妥起见可 `ctx.inject(['timer'], ...)`）。
- 语义（`cordis-plugin-timer/README.md:14-18,25-36`）：

```ts
const dispose = root.timeout(() => { ... }, 1000);   // 一次性，返回 disposer
await root.timeout(1000);                            // Promise
const stop = ctx.interval(() => { ... }, 30_000);    // 重复，返回 disposer
// setTimeout/setInterval 是 deprecated aliases
```

- 关键：timer 注册在**当前 fiber** 的 effect 上，插件卸载自动 `clearTimeout`（`lib/index.js:28-45,51-54`）。
  **不要**用裸 `globalThis.setTimeout`（不会随卸载清理，违反 BRIEF §4.4）。

**本插件轮询唤醒示例**：

```js
// 每 config.idlePollMs 检查一次：若当前可工作且有延后消息，则唤醒对应 agent
ctx.interval(() => {
  const state = statusNow();
  if (state.state !== 'working') return;
  for (const [agent, messages] of deferred) {
    if (messages.length === 0) continue;
    deferred.set(agent, []);
    for (const message of messages) {
      // 消息已被 claim 掉、不再 pending，可以安全复用原对象重新入队
      try { agent.followup(message); } catch (error) { ctx.logger.warn('...'); }
    }
  }
}, config.idlePollMs);
// 插件卸载时该 interval 由 fiber effect 自动清理，无需手动调用
```

> 想精确在 `nextWorkAt` 触发，也可用 `ctx.timeout(delayMs)` + 重新计算，但注意 24h 内的 DST/配置变更需重算；
> 轮询版本更简单、不易漏。

---

## 6. 消息来源判定（用户 vs 自动）

### 6.1 权威类型声明

`MessageSourceMap` / `MessageSource`（生成声明，`ASAR/@deepseek-ai/dsh-commands/lib/typert.host.js:604` 起；
同一声明也出现在 `dsh-user-questions/lib/typert.host.js:688` 附近，属同一 SessionEventMap 类型面）：

```ts
export interface MessageSourceMap {
    user: { kind: 'user'; };
    model: ModelMessageSource;
    tool: ToolMessageSource;
    'system-prompt': SystemPromptMessageSource;
    'model-selection': { kind: 'model-selection'; } & ContextFormed;
    'runtime-context': { kind: 'runtime-context'; } & ContextFormed;
    'working-directory': { kind: 'working-directory'; };
    'user-approval': { kind: 'user-approval'; } & ContextFormed;
    'ptc-mode': { kind: 'ptc-mode'; };
    'tool-registry': { kind: 'tool-registry'; };
    'user-rpc': { kind: 'user'; rpcId: SessionRequestId; clientTimeZone?: string; principal?: Principal; };
    'agent-message': AgentMessageSource;
    'subagent-settled': SubagentSettledMessageSource;
    'skill-invocation': SkillInvocationSource;
    'compact-checkpoint': CompactionCheckpointSource;
    'cordis-host-runner': { kind: 'cordis-host-runner'; };
    'team-message': TeamMessageSource;
    'user-question-reply': { kind: 'user-question-reply'; callId: ToolCallId; outcome: 'answered'; };
    goal: GoalMessageSource;
    'plan-mode': { kind: 'plan-mode'; } & ContextFormed;
    schedule: { kind: 'schedule'; } & ContextFormed;
    'session-reference': SessionReferenceSource;
    webhook: { readonly kind: 'webhook'; readonly provider: string; ... };
}
```

要点：**Web UI 输入是 `user-rpc`，其 `kind` 仍是 `'user'`**，所以判用户不能只比 source 全等，要看 `source.kind`。

相关的自动来源字段：

```ts
// dsh-commands/lib/typert.host.js
interface GoalMessageSource { kind: 'goal'; goalId: GoalId; revision: number; round: number; }
interface AgentMessageSource { kind: 'agent-message'; form: 'relay'; senderSessionId: SessionId; }
interface TeamMessageSource { kind: 'team-message'; teamId; messageId; senderId; senderName; }
interface SubagentSettledMessageSource { kind: 'subagent-settled'; form: 'notice'; summary: string; senderSessionId; }
schedule: { kind: 'schedule' } & ContextFormed
webhook: { kind: 'webhook'; provider; ... }
```

### 6.2 发送方证据（谁在什么时候产生这些来源）

- **schedule**：`dsh-schedule` 用 `agent.followup(message)`，`source: { kind: 'schedule' }`
  （`ASAR/@deepseek-ai/dsh-schedule/lib/index.js:1586-1596`）；随后 `await ctx.sessions.flush(...)` 并写 delivery 回执
  （`同文件:1597-1626`）——**注意：它在投递后立即记为 delivered，不等待该 turn 是否被接受**。
- **goal**：`dsh-goal-round-driver` 用 `agent.followup(message)`，`source: { kind:'goal', goalId, revision, round }`
  （`ASAR/@deepseek-ai/dsh-goal-round-driver/lib/index.js:142-164`）。
- **用户**：session README 的示例 `source: { kind: 'user' }`（`ASAR/@deepseek-ai/dsh-session/README.md:45-47`）。

### 6.3 判定函数（建议直接放进 Host）

```js
/** 人类主动输入（含 Web rpc）；用户对提问的回答也算人类交互。 */
function isHumanSource(source) {
  return source?.kind === 'user' || source?.kind === 'user-question-reply';
}

/** 自动/非人类来源：不弹窗、不耗 token，直接拦。 */
const AUTOMATIC_KINDS = new Set([
  'goal', 'schedule', 'webhook',
  'agent-message', 'team-message', 'subagent-settled',
  'session-reference', 'skill-invocation', 'compact-checkpoint', 'cordis-host-runner',
  'system-prompt', 'runtime-context', 'working-directory', 'user-approval',
  'model-selection', 'plan-mode', 'ptc-mode', 'tool-registry'
]);
function isAutomaticSource(source) { return AUTOMATIC_KINDS.has(source?.kind); }
```

> 白名单永远优于黑名单：未来新增 kind 时，`isHumanSource()` 只认 `'user'` 系，最安全。
> 不要只判 `source.kind !== 'user'` 就假定「自动」——`user-rpc` 的 kind 也是 `'user'`，若按 source 对象全等会误判。

---

## 7. 推荐实现骨架（可直接复制到 `plugins/work-window/index.js`）

```js
// @ts-check
import z from '@deepseek-ai/schemastery';
// 纯函数建议随插件包一起交付（例如 plugins/work-window/window.js），
// 由 shared/holiday.mjs 同源复制/生成，避免安装后相对路径失效。
import { evaluateWindow } from './window.js';

export const name = 'work-window';
export const inject = ['systemPrompt'];   // 强依赖；可选服务用 ctx.get()

export const Config = z.object({
  timeZone: z.string().default('Asia/Hong_Kong'),
  pauseWindows: z.array(z.object({
    start: z.string().default('09:00'),
    end: z.string().default('12:00')
  })).default([{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]),
  holidayApiUrl: z.string().default('https://timor.tech/api/holiday/year'),
  cacheTtlHours: z.number().step(1).min(1).max(720).default(24),
  confirmationMode: z.union(['ask', 'reject']).default('ask'),
  confirmationTimeoutMs: z.number().step(1000).min(5000).default(120000),
  idlePollMs: z.number().step(1000).min(5000).default(20000)
});

export function apply(ctx, config) {
  const deferred = new Map();       // Agent -> UserMessage[]（等待窗口结束）
  const holidayCache = { year: 0, days: null, fetchedAt: 0, source: 'offline' };

  const statusNow = () => evaluateWindow({ now: new Date(), config, holidays: holidayCache.days });

  /** 记录本批稍后重投的消息（去重：同一 MessageId 不重复保存）。 */
  function defer(agent, messages) {
    const pending = deferred.get(agent) ?? [];
    for (const message of messages) if (!pending.some((m) => m.id === message.id)) pending.push(message);
    deferred.set(agent, pending);
  }

  // —— 1) 提示词：全局 section，text 每次 assemble 重算 ——
  ctx.systemPrompt.section({
    name: 'work-window:policy',
    order: 15_000,
    text: (context) => {
      const state = statusNow();
      const lines = [
        '## 工作时段策略',
        `当前状态：${state.state === 'paused' ? `暂停中（${state.reason}）` : '可工作'}`,
        `工作日的暂停区间：${config.pauseWindows.map((w) => `${w.start}-${w.end}`).join('、')}`,
        `节假日数据：${holidayCache.source === 'offline' ? '离线兜底' : '已同步'}`
      ];
      if (state.state === 'paused') {
        lines.push(`暂停期间：不要主动开始新的工作、不要发起模型请求；用户下达任务时先申请确认。下一个可工作时刻：${state.nextWorkAt}。`);
      }
      return lines.join('\n');
    }
  });

  // —— 2) 门禁 ——
  // isHumanSource() 见 §6.3；hasAnswerer/isRuntimeRoot/askUser 见下方。
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const state = statusNow();
    if (state.state === 'working') return next();

    // 先分流：人类消息才可能弹窗
    const human = messages.filter((m) => isHumanSource(m.source));
    if (human.length === 0) {
      defer(agent, messages);
      return { kind: 'reject' };
    }

    // 子 agent 不弹窗（ask 会抛 DELEGATED_CALLER），没有在线客户端也不弹
    const canAsk = config.confirmationMode === 'ask'
      && isRuntimeRoot(ctx, agent)
      && hasAnswerer(ctx);
    const allowed = canAsk
      ? await askUser(ctx, agent, signal, state, config)   // 见下方；内部 try/catch + 组合 signal 超时
      : false;

    if (allowed) {
      // 放行：保留本批消息进入本 step
      return next();
    }
    defer(agent, messages);
    return { kind: 'reject' };
  });

  // —— 3) 到点唤醒（插件卸载自动清理） ——
  ctx.interval(() => {
    if (statusNow().state !== 'working') return;
    for (const [agent, pending] of deferred) {
      if (pending.length === 0) continue;
      deferred.set(agent, []);
      for (const message of pending) {
        try { agent.followup(message); } catch (error) { ctx.logger.warn(`work-window: re-queue failed: ${String(error)}`); }
      }
    }
  }, config.idlePollMs);

  // —— 4) 清理 ——
  ctx.on('agent/disposed', ({ agent }) => { deferred.delete(agent); }, { global: true });
  ctx.effect(() => () => { deferred.clear(); }, 'work-window: state');
  // section / pre-step 监听 / interval 的 disposer 均由各自 fiber effect 自动清理；
  // 若需要热重载可显式保存并调用。
}
```

> 若同一批 `messages` 同时含人类消息与自动消息（例如用户消息与 goal round 被一起 claim），
> 上面的写法在确认通过后会全部放行（`next()` 返回完整批次）；若要更严格，可拆成
> `next()` 后 `{...decision, messages: decision.messages.filter(...)}` 只保留人类消息，其余照 R1 的方式延后。
> 但要注意 filter 掉的消息已从 inbox 消失，必须自己保存重投。

`hasAnswerer` / `isRuntimeRoot` / `askUser` 参考 §2.4 / §2.2：

```js
function hasAnswerer(ctx) {
  try {
    const gw = ctx.get('typertGateway');
    if (gw !== undefined && typeof gw.hasLiveClient === 'function') return gw.hasLiveClient();
  } catch {}
  return true;   // 拿不到 gateway 时交由超时兜底
}

/** 只对 runtime root 弹窗；子 agent 会 DELEGATED_CALLER（见 §2.2）。 */
function isRuntimeRoot(ctx, agent) {
  const agents = ctx.get('agents');
  if (agents === undefined || typeof agents.roots !== 'function') return true;
  try { return agents.roots().includes(agent); } catch { return true; }
}

async function askUser(ctx, agent, signal, state, config) {
  const uq = ctx.get('userQuestions');
  if (uq === undefined) return false;

  // 超时通过独立 AbortController 中止提问，避免 pending 事件残留（见 §2.5）。
  const timeout = new AbortController();
  const abortOnTimeout = () => timeout.abort(new Error('work-window: confirmation timed out'));
  // ctx.timeout(callback, delay) 返回 disposer；也可用 ctx.timeout(delay) 得到 Promise。
  const disarmTimeout = ctx.timeout(abortOnTimeout, config.confirmationTimeoutMs);
  const combined = signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]);

  try {
    const answer = await uq.ask({
      agent,
      signal: combined,
      questions: [{
        id: 'work-window',
        header: '工作时段',
        question: `现在是暂停时段（${state.reason}）。是否仍要执行本次任务？`,
        options: [
          { label: '本次放行', description: '仅放行这一次' },
          { label: '不执行', description: '等到可工作时段' }
        ]
      }]
    });
    return answer.answers.some((a) => a.selected.includes('本次放行'));
  } catch (error) {
    ctx.logger.warn(`work-window: confirmation unavailable: ${String(error)}`);
    return false;   // fail closed：不执行，本批消息进入 deferred
  } finally {
    disarmTimeout();   // 清除未触发的 timer（disposer 可重复调用）
  }
}
```

> **注意**：`ctx.timeout(callback, delay)` 返回 disposer（`cordis-plugin-timer/lib/index.js:24-35`）；
> `ctx.timeout(delay)` 返回 Promise（`同文件:36-46`），且 fiber 释放时会 reject
> （`"Context has been disposed"`，`同文件:38-45`）。超时用 `AbortController` 中止 `ask`，
> 既让 `ask` 以 `ASK_ABORTED` 结算，也确保 gateway 的 pending 事件被取消
> （`dsh-api-gateway/lib/index.js:1081-1085` 监听 request signal 的 abort）。

---

## 8. 关键风险与建议（Host 侧）

| # | 风险 | 证据 | 建议 |
|---|---|---|---|
| R1 | **reject 会永久消费被 claim 的消息**（不自动回队，无重试），用户任务可能「消失」 | `dsh-agent-loop/lib/index.js:103-111`（纯删除）、`:960-962`、`:179-208`；README:71、120 | 插件必须在拒绝前保存 `messages` 并决定善后：延后 → 内存队列 + timer + `agent.followup()`；立即重跑 → 照 `goal-round-driver:99-106` 放回 `next-step` |
| R2 | **reject 定时/goal 消息会连带产生副作用**：goal-round-driver 在 pre-step 收到 reject 时会把 goal **block**（`prompt-rejected`） | `dsh-goal-round-driver/lib/index.js:326-333` | 对 goal：优先在进入暂停窗口时用 `ctx.goals.disarm()`/`pause()` 主动停续跑（`dsh-goal/README.md:58-68`），reject 只作兜底；兜底后用 `ctx.goals.resume(agent, ref)` 恢复（注意 revision CAS） |
| R3 | **schedule 投递后即记 delivered**，即使该 turn 被 reject，提醒也不会重投 | `dsh-schedule/lib/index.js:1586-1626`（`followup` → `flush` → `commit` delivery，未观察 turn 结果） | 拦截后自己保存原消息，窗口结束 `agent.followup(message)` 重投；或接受「本次提醒作废」的语义并说明 |
| R4 | **确认弹窗无人应答会卡住 turn**（userQuestions pending 仅在 signal abort / agent ctx 释放时取消） | `dsh-api-gateway/lib/index.js:1062-1108`（pending 生命周期）、`:837-844`（hasLiveClient）、`:1124-1125`（无 delivery 时 next） | 先 `hasLiveClient()`；再加 `ctx.timeout` 超时（fail closed）；始终传 pre-step `signal` |
| R5 | approval UI 是「工具越权」文案，语义不匹配 | `dsh-client-ui-approval/lib/client.js:260-270` | 主用 `userQuestions.ask`；approval 仅作二元授权兜底 |
| R6 | 会话内确认卡片只有在对应 session 的 Web 客户端在线时可见；用户切到别的会话可能看不到 | `dsh-client-ui-user-questions/lib/client.js:1762-1766`（`sessions.scopeOf(owner)`） | 同时在插件面板（sidebar）显示「有等待确认」状态；面板上加「立即放行」按钮作为替代入口 |
| R7 | 子 agent / 多 agent 也会走 `agent/pre-step`，会一起被拦 | `dsh-scope/lib/index.js:315-338`（根监听器对所有 agent 生效） | 增加配置 `gateChildAgents`（默认 true）；对子 agent 不弹窗（`ask` 也会抛 `DELEGATED_CALLER`，`dsh-user-questions/lib/index.js:531-535`） |
| R8 | 全局 section `order` 冲突/重复注册名会抛错 | `dsh-system-prompt/lib/index.js:203-206,253-256` | 用带前缀的 `name`（`work-window:policy`）+ 固定有限 order；不要用 `getSectionOrder`（外部名字未分配） |
| R9 | 本地插件 import `@deepseek-ai/schemastery` 需要解析拦截配合 | `dsh-app-boot/lib/index.js:1676-1730`（linked root 需要 `peerDependencies`） | 插件 `package.json` 加 `peerDependencies`，或改用零依赖 Standard Schema（§4.3 兜底） |
| R10 | 语言环境：`displayReason` 需 `{en, zh}`；`ask` 文案由插件自己给（走 Client locale 更好，但 Host 侧无 locale 服务保证） | `dsh-sandbox/lib/index.js:110-113` | approval 用 `{en, zh}`；userQuestions 的选项/问题文案做中英双份或按配置 |

---

## 9. 未验证 / 待实测项

1. **无 Web 客户端时 `userQuestions.ask()` 是否永久挂起**：由 gateway 的 pending 生命周期推断
   （只有 signal abort / agent ctx 释放 / source 关闭会取消，`dsh-api-gateway/lib/index.js:1081-1085, 1069-1076`），
   没有实际跑过「浏览器关闭 + pre-step 提问」场景。**必须实测**，并在实现里加超时。
2. **`hasLiveClient()` 的长期稳定性**：它不是 `@Remote` 生成 API（无 typert 声明），只是 gateway 类方法 +
   README 提及；未来版本可能改名。用 `ctx.get('typertGateway')` + `typeof` 守卫。
3. **本地插件 import `@deepseek-ai/schemastery`**：解析路由逻辑清楚（§4.3），但取决于最终安装方式（软链 vs 复制 vs
   Official installer），需要装完后实测一次 `Config.listConfigs`。
4. **`ctx.goals.disarm/pause/resume` 的精确参数**：只读了 README（`dsh-goal/README.md:56-83`）与 driver 用法
   （`ctx.goals.disarm(agent)`、`ctx.goals.block(agent, ref, reason)`），未逐行读 `dsh-goal/lib/index.js` 的
   `pause/resume` 签名；集成前请复核。
5. **pre-step 期间客户端渲染**：Web UI 在 pre-step 等待时能否正常显示「待确认」状态（turn 已 start、尚无 step/start），
   需要 UI 实测确认；从会话投影角度，turn/start 已经写入，理应可渲染。

---

## 10. 附：本文引用文件与关键行号索引

| 主题 | 文件（`ASAR/` 前缀省略） | 行号 |
|---|---|---|
| pre-step 分发 / payload / fallback | `@deepseek-ai/dsh-agent-loop/lib/index.js` | 902-927 |
| turn/start → preStep → reject→blocked | 同上 | 937-968, 1027-1041 |
| claim 纯删除（消息被消费） | 同上 | 103-111, 179-208 |
| send/followup/steer/inject + wakeDriver | 同上 | 800-814, 854-869, 887-901 |
| 官方 claim 语义说明 | `@deepseek-ai/dsh-agent-loop/README.md` | 71, 120 |
| reject 后“不打开 step”说明 | 同上 | 120 |
| 纯观察型 pre-step 监听器范例 | `@deepseek-ai/dsh-agent/lib/index.js` | 193-204 |
| fused payload（`agent` 注入） | `@deepseek-ai/dsh-agent/lib/types/dispatch.js` | 31-94 |
| `agent/created` serial & payload | `@deepseek-ai/dsh-agent/lib/index.js` | 574-590 |
| `agent/disposed` payload `{agent}` | `@deepseek-ai/dsh-agent/lib/index.js` | 549-562 |
| scope 过滤（根监听器可见全部） | `@deepseek-ai/dsh-scope/lib/index.js` | 226-238, 312-338 |
| **reject + 恢复消息官方先例** | `@deepseek-ai/dsh-goal-round-driver/lib/index.js` | 99-106, 291-352 |
| goal 因 pre-step reject 被 block | 同上 | 326-333 |
| goal followup 消息来源 | 同上 | 142-164 |
| approval.request 实现 + open-turn 检查 | `@deepseek-ai/dsh-user-approval/lib/index.js` | 49-56, 128-144, 172-189 |
| approval request 真实调用形状 | `@deepseek-ai/dsh-sandbox/lib/index.js` | 99-122 |
| approval UI 客户端 | `@deepseek-ai/dsh-client-ui-approval/lib/client.js` | 260-270, 284-309, 344-357 |
| userQuestions.ask 实现/类型 | `@deepseek-ai/dsh-user-questions/lib/index.js` | 531-535, 668-691 |
| userQuestions 类型声明 | `@deepseek-ai/dsh-user-questions/lib/typert.host.js` | 220, 267-292 |
| userQuestions UI 客户端 | `@deepseek-ai/dsh-client-ui-user-questions/lib/client.js` | 1762-1817, 1932-1934 |
| forwarded waterfall 白名单 | `@deepseek-ai/dsh-api-remotes/lib/index.js` | 136-138, 165-175 |
| pending reverse waterfall 生命周期 | `@deepseek-ai/dsh-api-gateway/lib/index.js` | 837-844, 1062-1108, 1124-1125 |
| systemPrompt.section/context/variable | `@deepseek-ai/dsh-system-prompt/lib/index.js` | 214-220, 245-256, 279-313, 356-399 |
| prompt section 用法/scoping | `@deepseek-ai/dsh-system-prompt/README.md` | 54-68, 112-114 |
| Config = Standard Schema | `@deepseek-ai/cordis/lib/index.js` | 932-962, 1619-1635 |
| Config 原生 schemastery 要求 | `@deepseek-ai/dsh-app-boot/lib/index.js` | 3402-3408 |
| 包解析拦截（peerDependencies） | 同上 | 716-799, 1613-1730 |
| ctx.on / ctx.effect / waterfall | `@deepseek-ai/cordis/lib/index.js` | 258-395, 1146-1210 |
| timer 服务与别名 | `@deepseek-ai/cordis-plugin-timer/lib/index.js` | 4-54 |
| timer 在 base 已挂载 | `@deepseek-ai/dsh-base/cordis.patch.yml` | 24-25 |
| MessageSourceMap / UserMessage | `@deepseek-ai/dsh-commands/lib/typert.host.js` | 604 起 |
| schedule 投递即记 delivered | `@deepseek-ai/dsh-schedule/lib/index.js` | 1586-1626 |
| goal 生命周期/暂停恢复 | `@deepseek-ai/dsh-goal/README.md` | 56-83, 99 |
| Host 插件与 Config 官方约定 | `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md` | 59-66 |
| waterfall / per-agent 注册 practices | 同上 `references/practices.md` | 16-19, 29 |
