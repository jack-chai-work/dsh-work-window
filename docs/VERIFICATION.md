# 工作时段插件 —— 安装与验证记录（示例）

> 本文件记录一次真实安装的**可复现结果**（验证环境为 Windows + DSH desktop profile）。
> 现场性信息（进程 ID、安装时刻、combo rev 等）已省略；文件路径使用如下占位符：
>
> - `<workspace>`：本仓库根目录（克隆后的目录）
> - `<plugin-dir>`：`<workspace>/plugins/work-window`
> - `<DSH-install-dir>`：DeepSeek Harness 安装目录
> - `$DSH_HOME`：DSH 配置目录（PowerShell 中为 `$env:DSH_HOME`，通常为 `%USERPROFILE%\.dsh`）

## 1. 安装内容

| 项目 | 值 |
|---|---|
| 插件包 | `@local/dsh-work-window` v1.0.0 |
| 源码目录 | `<plugin-dir>` |
| profile 依赖 | `"@local/dsh-work-window": "link:<plugin-dir>"`（`package.json.dependencies`，`link:` 后为插件目录绝对路径） |
| profile bundle | `dsh.profile.bundles` 末尾追加 `@local/dsh-work-window` |
| 链接方式 | `node_modules\@local\dsh-work-window` → **NTFS Junction** 指向源码目录 |
| bundle 行 | 插件自带 `cordis.patch.yml`：`insert: [{ id: work-window, name: '@local/dsh-work-window', config: … }]` |
| 是否重启 | **否**（profile HMR 热重组；进程启动时间早于安装时间） |

安装方式：官方入口是 GUI「插件」页或 `dsh plugin add`；当环境没有 `plugin_manager` 工具、又不便重启应用时，可按官方安装器产生的**文件结果**复刻：创建 Junction + 一次原子写 `package.json`（`dependencies` 与 `dsh.profile.bundles` 同时改动以触发 HMR 重组）。完整步骤与注意事项见 [install-plan.md](install-plan.md)。

## 2. 验证证据（一次实际安装的结果）

1. **Host 半区已激活并工作**：插件自己从 timor.tech 拉取并写入了本地缓存
   `$DSH_HOME\cache\work-window\holidays-<year>.json`（示例：2026 年 33 个法定假日 + 6 个调休补班，`source=timor.tech`）。
   这说明 `apply()` 已执行、Config 校验通过、节假日服务正常。
2. **Client 半区已进入实时插件图**：`GET http://127.0.0.1:<port>/plugins/events` 返回的 graph 中包含
   `{"id":"@local/dsh-work-window","url":"plugins/??@local/dsh-work-window/client.js&rev=<rev>","inject":[…],"immediately":true}`。
3. **Client 产物可被服务**：请求上述 combo URL 得到 `HTTP 200`，内容为构建生成的 `client.js`（约 54 KiB）。
4. **未重启**：安装前后 `Get-Process 'DeepSeek Harness'` 的 `StartTime` 不变。
5. **HMR 正在推送**：重新构建 `client.js` 后，同一插件图的 `rev` 会变化，说明 client-hmr 将新产物推送给已打开页面。

## 3. 自动化测试

```powershell
# 在仓库根目录一键运行（构建 + 语法检查 + 全部测试）
node tools/check.mjs

# 或分别运行
node shared/holiday.test.mjs                                   # 103 passed：节假日/时段判定参考实现
node plugins/work-window/tools/parity.test.mjs                 # 953 passed：浏览器实现与 Host 实现逐点一致
node plugins/work-window/tools/host.test.mjs                   #  37 passed：Host 门禁
node plugins/work-window/tools/client.test.mjs                 #  18 passed：client.js 在 VM 中加载/注册/渲染
```

Host 门禁单测覆盖：可工作时段放行、暂停时段审批允许/拒绝/超时、定时任务静默回队、goal 轮次挂起后时段结束自动继续、无在线客户端时不弹审批。

其中包含一条**加载期回归断言**：`index.js` 的 `inject` 必须同时声明 `systemPrompt` 与 `timer`。单测里的假 ctx 自带 `interval`/`timeout`，会掩盖真实 cordis 的 inject 要求；漏声明 `timer` 时 `apply()` 会在注册提示词段与门禁之前抛 `cannot get property "timer" without inject`，表现为「插件看着装上了但不生效」。

另覆盖**唤醒消息形状**：暂停恢复时 `agent.steer()` 必须是完整 message（`id`/`role`/`content`）。缺 `role` 的消息会被 session 原样持久化进历史，provider 返回 `INVALID_REQUEST: messages[n]: missing field "role"`，且之后每次重试都失败（2026-11-02 实际触发过，需新建会话绕过）。

## 4. 用户可见验证清单

1. **左侧栏**出现「工作时段」入口（时钟 + 暂停条图标，`order: 20`）。
2. 点击进入面板：状态徽章、本地时间、下一次状态切换、暂停区间、今日节假日、节假日数据行、「同步节假日数据」按钮。
3. 工作日 09:00-12:00 / 14:00-18:00 显示 **暂停中**，输入框上方出现提醒条；其余时间显示 **可工作**。
4. 若侧栏未出现：先 **F5** 刷新页面（只刷新浏览器，不重启应用）；仍未出现则检查 `/plugins/events` 插件图与 Host 行状态，见 [install-plan.md §7](install-plan.md)。

## 5. 行为验证范围（诚实说明）

- **已由单测覆盖**：时段判定、节假日/调休/周末、暂停时段拒绝与回队、审批允许/拒绝/超时、无客户端、goal 轮次挂起、定时唤醒、三处 slot 注册与面板渲染。
- **已由安装证据覆盖**：Host 激活、节假日 API + 本地缓存、Client 图热加载、无重启、HMR 推送。
- **未在真实 GUI 中自动模拟**：暂停时段真实注入一条用户消息并点击审批弹窗（需要人工操作或在暂停时段观察）；面板的视觉/明暗主题需人工确认。安装与 slot 注册本身不能证明用户所见。

## 6. 回滚 / 停用

```powershell
# 停用（保留文件）：从 profile 的 package.json 中删除 dsh.profile.bundles 里的 @local/dsh-work-window，
# 等 HMR 热重组（约 2-4 秒）；或直接删除下面这个 Junction：
Remove-Item -LiteralPath (Join-Path $env:DSH_HOME 'profiles\desktop\node_modules\@local\dsh-work-window') -Force

# 完整卸载：同时删除 package.json 中 dependencies['@local/dsh-work-window'] 与 bundles 条目，
# 删除 Junction，并删除缓存 $env:DSH_HOME\cache\work-window（可选）。
```

> 插件以 Junction 链接到 `<plugin-dir>`，**移动/删除源码目录会让插件失效**。
