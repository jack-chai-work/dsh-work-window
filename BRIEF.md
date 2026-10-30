# BRIEF — DSH 工作时段插件（Work Window Plugin）

> 本文件是给所有协作者的唯一背景说明。请先读完再动手。所有路径均为 Windows 原生路径。

## 1. 目标

为当前 DeepSeek Harness (DSH) 桌面应用开发一个**带左侧栏入口的插件**：

- 插件给 agent 设定「可工作时段」，并**指示 agent 只在允许的时段工作**；不允许的时段 agent 工作暂停，不发起模型请求（不消耗 token）。
- 时间段（用户原话）：`9:00 - 12:00`、`14:00 - 18:00` 是**不工作时段**；其余时段（以及非工作日：周末、法定节假日）agent 可以自由工作。
  - 即：工作日 9:00-12:00 与 14:00-18:00 **暂停**；工作日午休 12:00-14:00、夜间、以及周末/节假日 **可工作**。
- 在不工作时段给 agent 下达任务时，要**提醒用户并要求确认**；确认后本次放行。
- 节假日数据参考 `https://timor.tech/api/holiday`（节假日 API），并**存储到本地**（缓存文件 / localStorage）。
- UI：左侧栏（sidebar）入口 + 插件面板页面，显示当前状态（工作中 / 暂停中 / 下一个可工作时段 / 节假日信息），并提供配置与手动确认。

## 2. 环境事实（已核实）

- 工作区（可写）：`D:\program\dsh`，沙箱模式 workspace-write。**不要写工作区以外的文件。**
- DSH 安装包（打包在 asar，只读参考）：`D:\software\DeepSeek Harness\resources\app.asar`
  - 直接读取 asar 内的文件不可行，已解包到：`D:\program\dsh\.scratch\asar\`
  - 解包工具：`D:\program\dsh\.scratch\asar-tool.mjs`
    - 列目录：`node .scratch/asar-tool.mjs "<asar>" list "<substring>"`
    - 解包前缀：`$env:ASAR_OUT='D:\program\dsh\.scratch\asar'; node .scratch/asar-tool.mjs "<asar>" extract "dsh/node_modules/@deepseek-ai/<pkg>"`
    - asar 路径：`D:\software\DeepSeek Harness\resources\app.asar`
- 已解包的包：`dsh-agent-preset`(插件开发 skill，见 `skills/cordis-plugin-development/`)、`dsh-agent`、`dsh-agent-loop`、`dsh-web-app`、`dsh-base`、`dsh-experimental-agent-team-profile`、`dsh-client-ui-*`(sidebar/layout/conversation/chat/plugin-manager/approval/user-questions)、`dsh-user-questions`、`dsh-user-approval`、`dsh-system-prompt`、`dsh-schedule`、`dsh-plugin-manager`、`dsh-client-ui-entry-customization`。
  - 如需更多包（如 `dsh-session`、`dsh-commands`、`dsh-client-ui-commands`、`dsh-api-remotes`、`dsh-cordis-plugin-loader` 等），用上面的 extract 命令自行解包。**不要修改 `.scratch` 下已解包内容。**
- 运行中的应用：DSH 桌面端，Web GUI `http://127.0.0.1:49729`，当前 profile：`desktop`。
- profile 目录（**不可由我们写，由 Electron 独占管理**）：`C:\Users\chai_\.dsh\profiles\desktop`
  - 结构：`package.json`（`dsh.profile.bundles` 列出组合包）、`cordis.patch.yml`（用户 patch 层）、`node_modules`（profile 安装的包）、`.plugin-manager/`。
- **本会话没有 `plugin_manager` / `cordis_inspect_*` 工具**（当前 preset 不提供）。因此不能调用官方安装工具；安装方案见 §5。
- 工具链：`node v24.22.1`、`pnpm`、`pwsh` 可用；工作区可联网（待验证，`web_fetch` 工具可用）。
- 插件开发官方文档（**必读**）：
  - `D:\program\dsh\.scratch\asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\cordis-plugin-development\SKILL.md`
  - 同目录 `references/host-plugin.md`、`references/ui-plugin.md`、`references/practices.md`、`references/verification.md`、`references/user-actions.md`
  - 模板：`templates/decoration/`（package.json / cordis.patch.yml / index.js / client.js / locale/en.json / icon.svg）

## 3. 插件形态（官方约定）

- 一个 bundle 是普通 npm 包目录：
  - `package.json`：`dsh.bundle.patch` 指向 `cordis.patch.yml`；若含浏览器半区则加 `dsh.client`（`platform`/`immediately`/`inject`）和 `exports["./client"]`；同时导出 `./locale/*.json` 与 `./icon`。
  - `cordis.patch.yml`：`- insert: [ { id, name: '<包名>', config: {} } ]`；客户端半区的行也需插入（参考模板）。
  - `index.js`：Host 半区，`export function apply(ctx, config) {}`，可选 `export const inject = [...]`、`export const Config`。
  - `client.js`：浏览器半区，注册 lazy factory（id = 包名），从浏览器模块表拿 React。
  - `locale/en.json`、`locale/zh.json`：`meta.title` / `meta.description` 以及面板文案。
  - `icon.svg`：原创图标（≤256KiB）。
- 左侧栏入口机制（`dsh-client-ui-sidebar` README）：
  - 根作用域 list slot `sidebar.panellist`：注册 `{ id, order, label, icon }` 之类条目；
  - 同一 `id` 在 layout 的根作用域 `main` keyed slot 注册面板组件；
  - 具体注册 API/props 需读 `Slots.listSubTree` 等文档或在 `dsh-client-ui-sidebar/lib/client.js`、`dsh-client-ui-layout/lib/client.js` 里找证据。
- Host↔Client 通信用官方现有通道：session command（如 `ctx.remote.commands.execute()`）或 typert remote；不要自造 HTTP 端点。需调研出最小可用做法。

## 4. 功能设计（初稿，可被调研结果修正）

### 4.1 时段判定（核心纯函数，Host/Client 共用）

- 输入：`now`（时区 `Asia/Hong_Kong` 或可配置）、工作日/节假日数据。
- 判定顺序：
  1. 若当天是**非工作日**（周末或法定节假日，按节假日 API/本地缓存）→ `working`（可自由工作）。
  2. 否则是工作日：若当前时间落在任一「暂停区间」（默认 `09:00-12:00`、`14:00-18:00`）→ `paused`；否则 `working`。
- 输出：`{ state: 'working' | 'paused', reason, windowStart/End, nextWorkAt, holidayName? }`。
- 暂停区间、时区、节假日 API URL、缓存 TTL 都进插件 `Config`。允许调休补班（API 的 `workday: true` 覆盖周末）。

### 4.2 Host 半区

- `ctx.systemPrompt.section()` 注入一段「工作时段策略」：说明当前状态、暂停区间、以及暂停时不得主动开始新工作、等待用户确认。
- 用 `agent/pre-step`（waterfall）在**每次 step 准入**时判定：
  - `working` → `next()` 放行。
  - `paused` 且该 step 是用户主动下达的任务（message source 为用户）→ 通过 `ctx.approval.request()` 或 `ctx.userQuestions.ask()` 弹「现在是暂停时段，是否仍要执行？」；允许则放行（本次/本 turn 覆盖），拒绝则 reject。
  - `paused` 且是定时任务/goal 自动续跑等非用户来源 → 直接 reject（不弹窗、不耗 token），待可工作时段再由调度器唤醒（或记录待执行）。
  - 边界情况：turn 运行中跨入暂停时段 → 下一步被拦截（当前流式响应不强行打断，避免浪费已产生 token）。
- 节假日服务：Host 启动/首次需要时拉取 `https://timor.tech/api/holiday/year/<year>`，写入本地缓存文件（放 `$DSH_HOME/cache/` 或插件自管目录；也可放插件包目录外的工作区路径，注意 profile 目录不可写），失败时用内置离线快照兜底。每 N 小时刷新。
- `Config` 用 JSON Schema（cordis 的 `Config` 导出）暴露：`timeZone`、`pauseWindows`、`holidayApiUrl`、`cacheTtlHours`、`confirmationMode` 等。
- 面向 Agent 的工具（可选，加分）：`work_window_status` 让 agent 查询当前状态、下一个可工作时段、节假日信息；`work_window_holidays` 查询/刷新缓存。

### 4.3 Client 半区

- `sidebar.panellist` 注册一个「工作时段」入口（图标 + 标题），点击打开主面板页面。
- 面板内容：
  - 大状态徽章：`可工作` / `暂停中`（含原因：工作日 9:00-12:00 或节假日）；
  - 当前本地时间、时区、下一个可工作时刻、倒计时；
  - 节假日/调休信息（今天/明天）；
  - 暂停区间配置展示；
  - 手动「立即放行一次」按钮（若与 Host 通道可行）；
  - 缓存状态（上次同步时间、来源 API/离线）。
- 文案走 Client locale 服务（`locale/zh.json`、`locale/en.json`）；颜色用主题 token（`--dsw-alias-*`），不要硬编码颜色。
- 浏览器半区需自行计算状态（用与 Host 共用的纯函数），但以 Host 提供的权威状态为准（若通道可行）。

### 4.4 关键边界

- 暂停判定必须以**本地时区**为准（浏览器/主机时区都可能是 Asia/Hong_Kong；Config 可覆盖）。
- 节假日 API 失败不得阻塞：用离线兜底 + 明确 UI 提示「使用离线节假日数据」。
- 不产生任何未登记的 session event；不改写 session 日志格式。
- 插件卸载/禁用后不得残留定时器、订阅、slot 注册（`ctx.effect` / `ctx.on` 返回清理）。

## 5. 安装方案（待第 4 位调研者确认）

本会话无 `plugin_manager` 工具，profile 由 Electron 独占。候选方案：

- A. 直接编辑 profile（需用户批准每次工作区外写入）：把插件包放进 `C:\Users\chai_\.dsh\profiles\desktop\node_modules\<包名>`（本地目录通常用 junction/symlink），并把 `cordis.patch.yml` 中追加 insert 行、`package.json` 的 `dsh.profile.bundles` 追加包名。之后确认 Loader 是否 watch 并热加载；否则需重启应用（会中断本会话，需要用户操作）。
- B. 交付插件包 + 让用户在 GUI「插件」页用「从本地目录安装」完成安装（Host 端有正规安装器），我们负责验证插件文件与说明。
- C. 用 `dsh plugin --profile desktop add <path>` CLI（可能被 "managed exclusively by Electron" 拒绝，需验证）。
- 调研者需读 `dsh-plugin-manager` 的 `README.md` 与 `lib/index.js`，给出**准确的**本地目录安装会做的文件操作与热加载条件（是否 watch、是否需重启），以及 A/B/C 的可行性结论。

## 6. 交付物与协作约定

- 最终插件包目录（Lead 汇总）：`D:\program\dsh\plugins\work-window\`。
- 调研笔记（各调研者写自己的文件，互不覆盖）：
  - `D:\program\dsh\docs\host-api.md`（Host 侧 API 证据 + 代码片段 + 文件:行号）
  - `D:\program\dsh\docs\client-api.md`（Client 侧 API 证据 + 可运行的最小 client.js 骨架）
  - `D:\program\dsh\shared\holiday.mjs`（纯函数 + 单测脚本）
  - `D:\program\dsh\docs\install-plan.md`（安装/热加载方案）
- 工作区已清理出 `.scratch/`（asar 解包）与 `docs/`、`shared/`、`plugins/` 目录，请只写自己的文件。
- 代码与注释用中文/英文皆可；对外文案中文为主、英文齐全。
- 不要执行会重启/杀死当前桌面应用的命令；不要写 `C:\Users\chai_\.dsh` 下任何文件（调研只读）。
- 每个结论都要有**证据**：README 段落或 `lib/index.js` 的代码片段（带文件路径与行号），不要凭记忆猜 API。
