# 工作时段插件 —— 安装与验证记录

> 记录时间：2026-10-30 18:30（Asia/Hong_Kong）。当前 profile：`desktop`（`C:\Users\chai_\.dsh\profiles\desktop`）。

## 1. 已安装内容

| 项目 | 值 |
|---|---|
| 插件包 | `@local/dsh-work-window` v1.0.0 |
| 源码目录 | `D:\program\dsh\plugins\work-window` |
| profile 依赖 | `"@local/dsh-work-window": "link:D:/program/dsh/plugins/work-window"`（`package.json.dependencies`） |
| profile bundle | `dsh.profile.bundles` 末尾追加 `@local/dsh-work-window` |
| 链接方式 | `node_modules\@local\dsh-work-window` → **Junction** 指向源码目录 |
| bundle 行 | `cordis.patch.yml` 内 `insert: [{ id: work-window, name: '@local/dsh-work-window', config: … }]` |
| 是否重启 | **否**（进程启动时间 17:57，安装 18:30；HMR 热重组生效） |

安装方式：由于当前 preset 没有 `plugin_manager` 工具、GUI 需要用户手动点击，本次按官方安装器产生的**文件结果**手工复刻：
创建 Junction + 一次原子写 `package.json`（dependencies 与 bundles 同时改动以触发 HMR 重组）。原 `package.json` 备份在工作区 `.scratch\profile-package.json.work-window.bak`。

## 2. 安装后验证证据（均已实测）

1. **Host 半区已激活并工作**：插件自己从 timor.tech 拉取并写入了本地缓存
   `C:\Users\chai_\.dsh\cache\work-window\holidays-2026.json`（2026-10-30 18:30:27，33 个法定假日 + 6 个调休补班，source=timor.tech）。
   这说明 `apply()` 已执行、Config 校验通过、节假日服务正常工作。
2. **Client 半区已进入实时插件图**：`GET http://127.0.0.1:49729/plugins/events` 返回的 graph 中包含
   `{"id":"@local/dsh-work-window","url":"plugins/??@local/dsh-work-window/client.js&rev=94e18dfc2ef7","inject":[…],"immediately":true}`。
3. **Client 产物可被服务**：以 Node fetch 请求该 combo URL 得到 `HTTP 200`、55,592 字节，内容为构建生成的 `client.js`。
4. **未重启**：`Get-Process 'DeepSeek Harness'` 的 `StartTime` 仍为 17:57，早于安装时间。

## 3. 自动化测试

```powershell
cd D:\program\dsh\plugins\work-window
node tools/parity.test.mjs   # 953 passed：浏览器/Host 时段判定逐点一致
node tools/host.test.mjs     #  32 passed：门禁（放行/审批放行/拒绝回队/定时任务/goal 挂起唤醒/无客户端）
node tools/client.test.mjs   #  18 passed：client.js 在 VM 中注册 3 个 slot、渲染面板与提醒条
node --check index.js; node --check client.js
```

另外官方 `shared/holiday.test.mjs`（节假日模块参考实现）：103 passed / 0 failed（`node shared/holiday.test.mjs`）。

## 4. 用户可见验证清单（需在 GUI 页面确认）

1. **左侧栏**：出现「工作时段」入口（时钟 + 暂停条图标，位于「插件」「自动化任务」附近；`order: 20`）。
2. 点击进入面板：状态徽章、本地时间、下一次切换、暂停区间、今日节假日、节假日数据行、「同步节假日数据」按钮。
3. 当前时间（工作日 18:30+）应显示 **可工作**；在 09:00-12:00 / 14:00-18:00（工作日）应显示 **暂停中**，且输入框上方出现提醒条。
4. 若侧栏没有出现：按 **F5** 只刷新页面（不要重启应用）；仍未出现则检查 `/plugins/events` 图与 Host 行状态，见 `docs/install-plan.md §7`。

## 5. 行为验证范围（诚实说明）

- **已由单测覆盖**：时段判定、节假日/调休/周末、暂停时段拒绝与回队、审批允许/拒绝/超时、无客户端、goal 轮次挂起、定时唤醒、三处 slot 注册与面板渲染。
- **已由安装证据覆盖**：Host 激活、节假日 API + 本地缓存、Client 图热加载、无重启。
- **未在真实 GUI 中模拟**：暂停时段真实注入一条用户消息并点击审批弹窗（需要人工操作/在暂停时段观察）；面板的视觉/明暗主题需人工确认。这与官方 skill 的验证要求一致：安装与 slot 注册本身不能证明用户所见。

## 6. 回滚 / 停用

```powershell
# 停用（保留文件）：从 profile package.json 的 dsh.profile.bundles 中删除 @local/dsh-work-window，
# 等 HMR 热重组（约 2-4 秒）；或直接删除下面这个 Junction：
Remove-Item -LiteralPath 'C:\Users\chai_\.dsh\profiles\desktop\node_modules\@local\dsh-work-window' -Force

# 完整卸载：同时从 package.json 删除 dependencies['@local/dsh-work-window'] 与 bundles 中的条目，
# 删除 Junction，并删除缓存 C:\Users\chai_\.dsh\cache\work-window（可选）。
```

> 插件以 Junction 链接到 `D:\program\dsh\plugins\work-window`，**移动/删除该源码目录会让插件失效**。
