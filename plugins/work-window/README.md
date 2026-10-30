# 工作时段 Work Window（`@local/dsh-work-window`）

一个 DSH 插件：让 agent 只在**允许的工作时段**发起模型请求；在暂停时段自动停下（不消耗 token），
用户此时下发的任务会先**提醒并请求确认**；法定节假日数据取自
[timor.tech](https://timor.tech/api/holiday) 并缓存在本地。

左侧栏入口：**工作时段**（时钟 + 暂停条图标）。

## 规则

| 日期类型 | agent 状态 |
|---|---|
| 工作日（周一至周五，扣除法定节假日，含调休补班） | **09:00-12:00、14:00-18:00 暂停**；12:00-14:00、18:00-次日 09:00 可工作 |
| 周末 / 法定节假日 | 全天可工作 |

时区默认 `Asia/Hong_Kong`（可在配置里改）。暂停区间、时区、节假日 API 地址、缓存 TTL 都可配置。

暂停的语义：

- **暂停时段不发起任何模型请求** → 不消耗 token；
- 用户来源的任务（输入框发送）在暂停时段会弹出确认（允许一次 / 拒绝）；
  - 允许：只放行本次；
  - 拒绝 / 确认超时 / 没有在线客户端：任务**放回队列**，在下一个可工作时刻由定时器自动唤醒继续；
- 定时任务（schedule）等自动来源的任务在暂停时段**静默排队**，不打扰用户；
- goal 连续轮次在暂停时段**原地挂起**（不 reject，避免 goal 被永久 block），时段结束自动继续；
- 暂停前已开始的 turn 允许自然收尾（只拦新 work，不中途截断）。

## 左侧栏面板

- 当前状态徽章：`可工作` / `暂停中`；
- 本地时间、下一次状态切换与倒计时、暂停区间、今日节假日、节假日缓存来源与更新时间；
- **同步节假日数据**按钮：从 timor.tech 拉取本年度（11-12 月顺带下一年）数据并写入 localStorage；
  失败时继续使用缓存/内置离线快照。
- 输入框下方在暂停时段显示一条提醒条（`暂停时段 · 09:00-12:00 · 12:00 恢复 · 发送任务会先请求确认`）。

## 安装

本插件是标准 DSH bundle：安装进任意 profile 后随 HMR 热加载，无需重启。
安装/验证/回滚的完整记录见 [`docs/VERIFICATION.md`](../../docs/VERIFICATION.md)。
路径占位符（`<plugin-dir>` / `<DSH-install-dir>` / `$DSH_HOME`）含义见仓库根 README。

官方安装方式（任意 profile）：

```powershell
# 或使用 GUI：左侧栏「插件」→ 添加插件 → 填本目录绝对路径 → 安装 → 立即启用
& "<DSH-install-dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <name> add "<plugin-dir>"
```

## 配置（`cordis.patch.yml`）

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
    confirmTimeoutMs: 600000      # 暂停时段确认弹窗最长等待时间，超时任务回队
    cacheDir: C:\somewhere\work-window   # 可选；注释掉则用默认 $DSH_HOME/cache/work-window
    wakeNotice: '（工作时段已开始，暂停结束：继续执行队列中暂停的任务。）'
    policyText: null              # 可选：覆盖注入系统提示词的策略文本
```

`pauseWindows` 也接受 `'09:00-12:00'` 字符串写法。

## 节假日数据

- Host：`$DSH_HOME/cache/work-window/holidays-<year>.json`（每 6 小时检查一次 TTL，默认 12 小时刷新；11-12 月预取次年）。
- Client：`localStorage['dsh-work-window:holidays:<year>']`。
- 离线兜底：`shared/offline-holidays.json` 内置快照（含 2025/2026），随插件发布。
- timor.tech 返回：`holiday:true` = 法定假日；`holiday:false` = 调休补班（算工作日）；普通周末由本地日历计算。

## 开发

```powershell
cd <plugin-dir>
node tools/build-client.mjs      # 由 client.template.js + shared/status-client.mjs 生成 client.js
node tools/parity.test.mjs      # 浏览器/Host 判定一致性（953 断言）
node tools/host.test.mjs        # Host 门禁单测（32 断言，含 goal 挂起/回队/唤醒）
node tools/make-offline.mjs     # 重新生成离线节假日快照（需要网络）
```

## 已知限制

- 「暂停前已开始的 turn」会允许其收尾；只有新 turn / 新 step 会被拦截。
- 若插件在 agent 已运行时才热加载，会给现有 agent 补装门禁（`ctx.agents.list()`）。
- 子 agent（subagent/teammate）同样受门禁约束；父 turn 在等待子结果期间会一并暂停。
- 没有在线 Web 客户端时不会弹确认，任务直接排队（避免审批永久 pending）。
