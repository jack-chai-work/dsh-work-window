# DSH 工作时段插件（Work Window）

中文 | [English](README.en.md)

一个 DeepSeek Harness（DSH）桌面端插件：让 agent **只在允许的工作时段发起模型请求**；暂停时段自动停止（不消耗 token），此时用户下发任务会**先提醒并请求确认**；法定节假日数据取自 [timor.tech](https://timor.tech/api/holiday) 并缓存在本地。左侧栏提供「工作时段」入口与状态面板。

> 状态：可在 DSH `desktop` profile 热加载运行（已在 Windows + DSH `0.2.1-rc.5` 上实测安装，无需重启应用）。安装/验证结果见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

**路径占位符**（下文命令中）：`<workspace>` 仓库根目录 · `<plugin-dir>`=`<workspace>/plugins/work-window` · `<DSH-install-dir>` DSH 安装目录 · `$DSH_HOME` DSH 配置目录（PowerShell 中写作 `$env:DSH_HOME`，通常为 `%USERPROFILE%\.dsh`）。

## 行为规则

| 日期类型 | agent 状态 |
|---|---|
| 工作日（周一至周五，扣除法定节假日，含调休补班） | **09:00-12:00、14:00-18:00 暂停**；12:00-14:00、18:00-次日 09:00 可工作 |
| 周末 / 法定节假日 | 全天可工作 |

暂停语义（Host 在 `agent/pre-step` 强制执行）：

1. 暂停时段**不发起任何模型请求** → 不消耗 token；
2. 用户任务（输入框发送）→ 弹出 DSH 原生审批确认（允许一次 / 拒绝）；允许只放行本次，拒绝/超时/无在线客户端则**放回队列**，时段结束自动唤醒继续；
3. 定时任务等自动来源 → 静默排队，不打扰用户；
4. goal 连续轮次 → **原地挂起**（不 reject，避免 goal 被永久 block），时段结束自动继续；
5. 暂停前已开始的 turn 允许自然收尾（只拦新 work，不中途截断）。

## 功能特性

- **零 token 暂停**：`agent/pre-step` 准入拦截，未进入 step 就不会发出模型请求。
- **提醒 + 确认**：复用 `ctx.approval` 的 Web 审批面板，文案说明暂停区间与恢复时间；确认等待有超时（默认 10 分钟）。
- **回队 + 定时唤醒**：被暂停的消息回到 inbox，按 `nextChangeAt` 精确定时唤醒，恢复后自动继续。
- **节假日**：Host 拉取 timor.tech 年度数据落盘（12h TTL、6h 检查、11-12 月预取次年），失败退回周末规则；Client 另有 localStorage 缓存 + 内置离线快照 + 手动同步按钮。
- **左侧栏入口**：`sidebar.panellist` 注册图标入口，`main` 面板展示状态徽章、本地时间、下一次切换倒计时、暂停区间、今日节假日、缓存来源。
- **输入框提醒条**：`conversation.composer.dock` 在暂停时段显示常驻提示。
- **系统提示词策略**：向所有 agent 注入工作时段规则，避免 agent 主动跨时段开启长任务。
- **可配置**：时区、暂停区间、节假日 API、缓存 TTL、确认超时、缓存目录等（见下文）。

## 目录结构

```text
.
├── plugins/work-window/          插件包（可直接安装的 bundle）
│   ├── index.js                  Host 半区：门禁 / 审批确认 / 回队唤醒 / 系统提示词 / 节假日缓存
│   ├── client.template.js        Client 半区源码（侧栏入口 + 面板 + 提醒条）
│   ├── client.js                 ⚠️ 生成产物（由 tools/build-client.mjs 生成，勿手改）
│   ├── shared/holiday.js         节假日 + 时段判定参考实现（Host 使用，1342 行，103 断言测试）
│   ├── shared/holiday-cache.js   Host 侧本地缓存（原子写盘 / 单飞刷新 / TTL）
│   ├── shared/status-client.mjs  浏览器内联用紧凑实现（与 holiday.js 逐点对拍）
│   ├── shared/offline-holidays.json  内置离线节假日快照（2025/2026）
│   ├── cordis.patch.yml          bundle patch（插入 work-window 行与默认配置）
│   ├── locale/{zh,en}.json       插件管理页显示元信息
│   ├── icon.svg                  原创图标
│   └── tools/                    构建与测试脚本（见「开发与测试」）
├── shared/                       节假日模块的独立参考实现与测试（workspace 级）
├── docs/                         调研 / 安装 / 验证文档
│   ├── host-api.md               Host 侧 API 调研（agent/pre-step、approval、systemPrompt、Config…）
│   ├── client-api.md             Client 侧 API 调研（sidebar.panellist、main slot、locale、Host↔Client）
│   ├── install-plan.md           安装与热加载方案（含实测记录、验证手段、风险）
│   └── VERIFICATION.md           安装与验证示例记录（含回滚命令）
├── prototype/                    Client 半区最小可运行骨架（调研产物）
├── tools/
│   ├── check.mjs                 一键构建 + 全部测试 + 语法检查
│   └── extract-asar.mjs          从 DSH 安装包 app.asar 中解包/读取文件的工具
├── BRIEF.md                      项目初始简报（环境事实、目标、协作约定）
├── README.en.md                  English README
├── LICENSE                       MIT
├── .gitignore / .gitattributes   忽略 .scratch/ 与依赖缓存；统一 LF 换行
```

## 快速开始

**环境要求**：DSH 桌面端（Windows/macOS/Linux，`desktop` profile，测试版本 `0.2.1-rc.5`）；仅开发/测试时需要 Node.js 24+。

### 安装

GUI（推荐，自动写 profile 并热加载）：DSH 左侧栏「插件」→「添加插件」→ 填 **`<plugin-dir>` 的绝对路径** →「安装」→ 完成后点「立即启用」。

CLI（需要先完全退出桌面应用）：

```powershell
& "<DSH-install-dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <profile> add "<plugin-dir>"
```

也可以手工复刻安装器产生的文件结果（Junction + 原子写 profile `package.json`），步骤见 [docs/install-plan.md](docs/install-plan.md)。

### 安装后的验证

1. 左侧栏出现 **「工作时段」** 入口（时钟 + 暂停条图标，`order: 20`），点开可见状态面板；
2. 工作日 09:00-12:00 / 14:00-18:00 显示 **暂停中**，输入框上方出现提醒条；其余时间显示 **可工作**；
3. 运行时证据：`GET http://127.0.0.1:<GUI 端口>/plugins/events` 的插件图中包含 `@local/dsh-work-window`；
4. 节假日本地缓存：`$DSH_HOME\cache\work-window\holidays-<year>.json`。

若侧栏未出现：先 **F5** 刷新页面（只刷新浏览器，不重启应用）。

### 卸载 / 回滚

- 停用：从 profile `package.json` 的 `dsh.profile.bundles` 删除 `@local/dsh-work-window`（等 2-4 秒 HMR 热重组）；
- 完整卸载：同时删除 `dependencies["@local/dsh-work-window"]` 与 `node_modules/@local/dsh-work-window` 链接；缓存目录 `$DSH_HOME/cache/work-window` 可选删除；
- 插件以 Junction 链接到本仓库目录，**移动/删除本目录会让插件失效**。

## 配置

在 profile 的 `cordis.patch.yml`（或 bundle 自带的 `plugins/work-window/cordis.patch.yml`）里修改：

```yaml
- id: work-window
  name: '@local/dsh-work-window'
  config:
    timeZone: Asia/Hong_Kong
    pauseWindows:
      - { start: '09:00', end: '12:00' }
      - { start: '14:00', end: '18:00' }
    holidayApiUrl: 'https://timor.tech/api/holiday/year/{year}'
    cacheTtlHours: 12
    confirmDuringPause: true
    confirmTimeoutMs: 600000        # 暂停时段确认弹窗最长等待，超时任务回队
    # cacheDir: 'D:\somewhere\work-window'   # 可选；默认 $DSH_HOME/cache/work-window
    wakeNotice: '（工作时段已开始，暂停结束：继续执行队列中暂停的任务。）'
    policyText: null                # 可选：覆盖注入系统提示词的策略文本
```

`pauseWindows` 也接受 `'09:00-12:00'` 字符串写法；Config 由 `index.js` 导出的 Standard Schema 校验，非法配置会在加载时报错。

## 节假日数据

- 接口：`GET https://timor.tech/api/holiday/year/<year>` → `{ code: 0, holiday: { 'MM-DD': { holiday, name, wage, date, … } } }`。
- `holiday: true` = 法定假日（休息）；`holiday: false` = 调休补班（算工作日）；普通周末由本地日历计算。
- Host 缓存：`$DSH_HOME/cache/work-window/holidays-<year>.json`（原子写盘，TTL 默认 12h，6h 检查一次，11-12 月预取次年）。
- Client 缓存：`localStorage['dsh-work-window:holidays:<year>']`；失败时使用 `shared/offline-holidays.json` 内置快照。
- timor.tech 有速率限制（短时间连续请求会 429），Host 串行刷新并依赖缓存。

## 开发与测试

```powershell
cd <workspace>
node tools/check.mjs                      # 一键：构建 client.js + 全部测试 + 语法检查

# 或单独运行
node plugins/work-window/tools/build-client.mjs   # 由 template + status-client + 离线数据生成 client.js
node shared/holiday.test.mjs                      # 节假日/时段判定参考实现（103 断言）
node plugins/work-window/tools/parity.test.mjs    # 浏览器实现 vs Host 实现逐点一致（953 断言）
node plugins/work-window/tools/host.test.mjs      # Host 门禁单测（34 断言）
node plugins/work-window/tools/client.test.mjs    # client.js VM 加载/注册/渲染（18 断言）
node plugins/work-window/tools/make-offline.mjs   # 重新生成离线节假日快照（需要网络）
```

改动约定：

- 改浏览器逻辑 → 编辑 `plugins/work-window/client.template.js` 与/或 `shared/status-client.mjs`，然后 `node tools/build-client.mjs`（构建是确定性的，可安全提交产物）；
- 客户端产物不能 `import` 任何 Harness 客户端包，只 `require('react')`；
- Host 半区依赖声明：`inject` 必须包含 `systemPrompt` 与 `timer`（`ctx.interval`/`ctx.timeout` 是 timer 服务的 mixin accessor，漏声明会让 `apply()` 抛错、插件「装上了但不生效」）；可选服务用 `ctx.get()`，`host.test.mjs` 有回归断言；
- 不要提交 `.scratch/`（asar 解包产物，可由 `node tools/extract-asar.mjs` 复现：`$env:ASAR_OUT='.scratch\asar'; node tools/extract-asar.mjs '<asar 路径>' extract 'dsh/node_modules/@deepseek-ai/<包名>'`）。

## 已知限制与未验证项

- **暂停前已开始的 turn** 允许收尾（只拦新 turn / 新 step），因此跨入暂停时刻的正在运行的 turn 会继续消耗 token。
- **子 agent 也受限**：subagent/teammate 的 turn 在暂停时段被拦，其父 turn 在等待子结果期间一并暂停。
- **goal 挂起**会占用该 agent 直到时段结束，同会话其它任务排队等待（避免 goal 被 block 的权衡）。
- **无在线 Web 客户端**时不弹确认，任务直接排队（避免审批永久 pending）。
- **GUI 交互未自动模拟**：暂停时段注入用户消息并点击审批、以及面板明暗主题/视觉，需要人工确认；单测与安装证据见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。
- 本插件通过 `agent/pre-step` 强制暂停，属于 Harness 公开扩展点；DSH 升级后若事件/服务签名变化需按 [docs/host-api.md](docs/host-api.md) 重新核对。

## 文档索引

- [插件使用说明](plugins/work-window/README.md)
- [安装与验证记录](docs/VERIFICATION.md)
- [安装与热加载方案](docs/install-plan.md)
- [Host 侧 API 调研](docs/host-api.md)
- [Client 侧 API 调研](docs/client-api.md)
- [项目初始简报 BRIEF](BRIEF.md)
- [English README](README.en.md)

## License

[MIT](LICENSE) © dsh-work-window contributors

## 版本管理

仓库默认分支 `main`；`.scratch/`（从 DSH 安装包解包的调研产物）已通过 `.gitignore` 排除。

```powershell
git log --oneline          # 查看提交
git status                 # 查看工作区状态
```
