# 本地 bundle 安装与热加载方案（desktop profile）

> 调研者：install-plan（task-4）。只做只读调研与 scratch 复现；**没有**修改真实 profile（`C:\Users\chai_\.dsh\profiles\desktop` 各文件 mtime 仍为 2026-10-23/26/10-30 17:57 应用启动时，见 §8）。
> 结论证据来自 `.scratch/asar` 内已解包的 `dsh-plugin-manager`、`dsh-hmr`、`dsh-client-hmr`、`dsh-client-modules`、`dsh-app-boot`、`@deepseek-ai/dsh`（CLI/desktop-host）源码与 README，以及本机实测（§8）。
> 目标插件包：`D:\program\dsh\plugins\work-window`，包名 `@local/dsh-work-window`（`package.json` / `cordis.patch.yml` / `index.js` / `client.js` / locale / icon 在调研末已齐备；其中 `client.js` 是 `tools/build-client.mjs` 的生成物、仍在迭代，**安装前必须重跑 §6.0 预检**）。

---

## 0. 给 Lead 的一句话结论

**推荐用 GUI「插件」页的「添加插件 → 安装第三方插件 → 填本地绝对目录」安装，装完点「立即启用」；在当前 desktop profile 上 HMR 已启用，新装 bundle 会热重组生效，不需要重启应用，也不需要刷新浏览器页面；profile 文件由 Electron Host 自己写，agent 侧 0 次工作区外写入批准。**

- 重启需求：**推荐路径 = 0 次重启**（若 GUI 弹出「请重启 DSH 使更改生效」才需 1 次重启，会中断本会话）。
- 工作区外写入批准：GUI 路径 **0 次**（用户点鼠标，Host 进程自行写 profile）；若要 agent/脚本手动改 profile，则每次命令都要一次批准（本会话审批已禁用，实际只能由用户执行），见 §5.3。
- 生效证据：`curl http://127.0.0.1:49729/plugins/events` 的图里出现 `@local/dsh-work-window` 行 + 侧栏出现「工作时段」入口；进程 StartTime 不变。

---

## 1. 环境现状（只读核实）

### 1.1 desktop profile 文件

`C:\Users\chai_\.dsh\profiles\desktop\package.json`（311 B，mtime 2026-10-26 10:21:54，实测内容）：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@deepseek-ai/dsh-experimental-plugin-market-bundle"
      ]
    }
  }
}
```

- **没有 `dependencies` 字段**；bundle 全部由 DSH 安装包提供（安装锚点 = app.asar 里的 `dsh/package.json`）。
- `cordis.patch.yml`（836 B，mtime 2026-10-23 11:36:16）只有 4 条 config override（agent-default-model / ui-settings-account / ui-chat / ui-settings），**没有任何 insert 行，也没有覆盖 `hmr` 行**。
- `node_modules/@deepseek-ai` 为空目录；`node_modules` 里是 pnpm 的 `.pnpm`、`.modules.yaml` 等（`nodeLinker: hoisted`，`pnpm-workspace.yaml` 已存在）。
- `.plugin-manager/logs/` 下有两个历史 operation 日志，证明该 profile 的包操作确实走 app 自带 pnpm：
  - `operation-2CM0z5/pnpm.log:28-31`：`+ @deepseek-ai/dsh-subagent-claude-code 0.2.1-rc.2`（安装）；
  - `operation-qZQF7s/pnpm.log:4-6`：`- @deepseek-ai/dsh-subagent-claude-code ...`（卸载）。

### 1.2 当前运行态

- 两个 `DeepSeek Harness.exe` 进程（Main + Host），启动于 2026-10-30 17:57:58/59；Web GUI `http://127.0.0.1:49729`。
- 本会话 shell 环境已带 `DSH_HOME=C:\Users\chai_\.dsh`、`DSH_PROFILE=desktop`、`DSH_PROFILE_DIR=C:\Users\chai_\.dsh\profiles\desktop`；按 skill 文档，这表示 Harness 是 profile 启动的（`.scratch/asar/.../cordis-plugin-development/SKILL.md:34`）。
- `curl http://127.0.0.1:49729/plugins/events`（SSE，非破坏）首帧返回完整 client graph；`release: {version: "0.2.1-rc.5", commit: "d4db512"}`，entries 中包含 `@deepseek-ai/dsh-client-hmr`、`@deepseek-ai/dsh-client-modules`、`@deepseek-ai/dsh-client-ui-plugin-manager`。这是 **client HMR 通道已在线**的直接运行证据（`/` 返回 401，但 `/plugins/events` 可匿名只读连接）。

### 1.3 Host 侧 HMR 是否启用的证据链

1. `dsh-base` 的 bundle patch 同时插入 `plugin-manager` 与 `hmr`，二者都受同一个 `profileContext` 门控：`.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:20-32`：

```yaml
- id: plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager'
  disabled: !!js "!ctx.get('profileContext')"
...
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js "!ctx.get('profileContext')"
  config:
    root: []
```

2. desktop 启动链一定提供 `profileContext`：`dsh-desktop-host/lib/index.js:218-250` 用 `runProfile({profile:'desktop', resolvedProfile:{profile, installAnchor}, ...})`；`@deepseek-ai/dsh` 的 `profile-boot-C14i-8IN.js:289-306` 在 boot 时 `hostCtx.provide("profileContext", profileContext)`。因此 `hmr` 行 `disabled: false`，**desktop 是 live profile（HMR 开）**。
3. 当前 profile 的 `cordis.patch.yml` 与各 bundle 的 patch（base / web-app / 两个 experimental）都没有覆盖 `hmr` 行（已逐个 grep），所以没有被关掉。
4. `dsh-hmr` README 明确：base 在 launcher 提供 `profileContext` 时以 `root: []` 启用 HMR（`.scratch/asar/.../dsh-hmr/README.md:27`）；`root: []` = 不做源码目录 watch，但 **profile manifest / 两份用户 patch 的配置 watch 仍然注册**（同文件 :59、:61；中文版 README.zh.md:27、:59、:61）。
5. `dsh-web-app` 的 patch 把 `client-hmr` 作为 always-mounted 行插入：`.scratch/asar/.../dsh-web-app/cordis.patch.yml:214-219`（“The client-plugin reload chain, always mounted”）。

> 结论：desktop profile 处于 **HMR 启用 + client 图在线** 状态；新装 bundle 的 Host 行和 Client 半区都能在不重启进程的情况下生效。

---

## 2. 官方 `install_bundle`（本地目录）到底做什么

### 2.1 调用链（GUI 与 agent 工具同源）

GUI「插件」页的安装按钮调的是同一个 Host 服务：

- `dsh-client-ui-plugin-manager/lib/client.js:1537`：先 `pluginManager.inspect(spec, {registry})`；
- `dsh-client-ui-plugin-manager/lib/client.js:1595-1596`：`pluginManager.installBundle(spec, { enabled: subject.selection ?? false })`——**GUI 安装默认 `enabled: false`（只装依赖，不选 bundle）**，成功后再由「立即启用」按钮调用 `setBundleEnabled(name, true)`（同文件 `:1791-1797`）。
- `dsh-plugin-manager/README.md:40`：bundle toggle 只改 `package.json` 的 `dsh.profile.bundles`；「Installation enables a new bundle by default」是 API 默认，GUI 显式传了 `enabled:false`。

### 2.2 Host 服务 `installBundle` 的文件操作（`dsh-plugin-manager/lib/index.js`）

| 步骤 | 行为 | 证据 |
|---|---|---|
| 1 | 读 profile manifest 现有 dependencies；若 HMR 开启且该包名已声明 → 直接 `already-installed` 拒绝（**不能覆盖安装**） | `lib/index.js:1989-1991` |
| 2 | 快照 `package.json` + `pnpm-lock.yaml`（失败/取消时恢复） | `lib/index.js:1293`（`RESTORED_FILES`）、`:2266-2279` |
| 3 | 在 **profile 目录**里执行 `pnpm add <spec> [--save-exact] [--registry=...]`（不是 `pnpm add link:`；`link:` 是 pnpm 对本地目录的结果） | `lib/index.js:2033-2038` |
| 4 | 读 pnpm 后的 manifest diff，找到新增依赖名；用 `resolveBundleDir` 解析包目录，要求 `dsh.bundle.patch` 存在，否则 `not-bundle` | `lib/index.js:2063-2074` |
| 5 | 做 DSH 版本兼容检查（`engines.dsh` / `@deepseek-ai/dsh*` peer 范围） | `lib/index.js:2075-2077`；`dsh-app-boot/README.md:52` |
| 6 | 失败（pnpm 失败 / 校验失败 / 取消）→ 恢复快照的 `package.json`、`pnpm-lock.yaml`；pnpm 已写入 `node_modules` 的下载文件**可能保留** | `lib/index.js:2080-2083`；`README.md:52`、`:104`、`:155` |
| 7 | `enabled !== false` 时 `selectBundle(name, true)`：把包名 **append** 到 `package.json` 的 `dsh.profile.bundles`（保持数组顺序，不重复），原子写 `package.json` | `lib/index.js:2280-2306`（bundles 在 `:2295`，写盘在 `:2304`；`saveManifest` 在 `:319-321`） |
| 8 | `publishAndReload()`：HMR 存在时走 `hmr.reconcileProfile(requiredIds)` 热重组；无 HMR 时 `composeEntries(...)` + `refreshPackages()`，并返回 `application: "restart-required"` | `lib/index.js:2324-2331`、`:2351-2372`、`:2380-2383` |
| 9 | **不写** `cordis.patch.yml`：bundle 自己的 patch（`dsh.bundle.patch`）提供 insert 行，作为 bundle layer 组合进去 | `dsh-app-boot/README.md:50`；`lib/index.js:2077`（`loadOverlayPatches`）；`README.md:40` |

### 2.3 本地目录会产生什么文件（实测，§8 T4/T6）

在 scratch 副本 profile 上跑 desktop 自带 CLI 的 `plugin add <本地目录>`（与 GUI 走同一 `pnpm add` 语义）后：

```jsonc
// profile/package.json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@deepseek-ai/dsh-experimental-agent-team-profile",
    "@deepseek-ai/dsh-experimental-plugin-market-bundle",
    "@local/dsh-work-window"                  // ← 追加在最后
  ] } },
  "dependencies": {
    "@local/dsh-work-window": "link:D:/program/dsh/plugins/work-window"  // ← pnpm 记录 link: 绝对路径
  }
}
```

- `node_modules/@local/dsh-work-window` 是 **NTFS Junction（目录联接）**，Target = `D:\program\dsh\plugins\work-window`（跨盘可用，无需管理员/开发者模式；符号链接才需要）。实测 `Get-Item -Force` 显示 `LinkType : Junction`。
- `pnpm-lock.yaml` 新增 importer 条目，跨盘时 version 也是绝对 `link:D:/program/dsh/plugins/work-window`。
- `node_modules/.modules.yaml`、`.pnpm-workspace-state-v1.json` 由 pnpm 更新；`.plugin-manager/logs/operation-*/pnpm.log` 新增一次运行日志。
- **`cordis.patch.yml` 不变**（这一点最容易误解：install 不往用户 patch 里写 insert 行）。
- `files` 字段不生效：本地目录安装是“链接 checkout”，不 pack，所以 `files` 漏掉的文件实际也能被读取（`.scratch/.../references/host-plugin.md:35`）。

### 2.4 事务/回滚语义（准确表述）

- 有 **文件级快照回滚**：`package.json` + `pnpm-lock.yaml`；不是完整事务；`node_modules` 里 pnpm 已下载的内容不回滚。
- 安装成功后 **激活失败不回滚**（保留依赖与 bundle 选择，报告 `failed` / `restart-required`）——`README.md:52`、`:155-160`。
- 并发：服务端用 `withFileLock(profile/package.json)` 串行化同一 profile 的包/清单写；HMR 配置写走 `hmr.runExclusive`；pnpm 本身跑在 HMR 队列之外（`README.md:98-104`；`lib/index.js:2373-2400`）。
- 卸载顺序：先从 `dsh.profile.bundles` 移除、卸载运行时贡献、再 `pnpm remove`、最后发布 resolution（`README.md:160`）。

---

## 3. Loader / HMR：手工复刻能否不重启生效

### 3.1 Loader 本身不 watch 文件

- `cordis-plugin-loader/README.md:3-5`：Loader 只负责 EntryTree、按名字 import、与 entry 更新同步；:49 明说 file-backed tree 用 `@cordisjs/plugin-include`。
- `cordis-plugin-loader/src/index.ts:171-173`：`Loader.write()` 是 no-op（根树只在内存）。
- 真正 watch profile 文件的是 `dsh-hmr`（Host 侧）与 `dsh-client-hmr`（浏览器图）。

### 3.2 HMR 的 watch 与“热重组”条件（决定手工改文件是否生效）

- `dsh-hmr/README.md:59` / README.zh.md:59：`watchConfig()` 只 watch 目标路径及必要父目录；`runExclusive()` 串行化配置变更；**manifest 通知只在有序 `dsh.profile.bundles` 列表变化时触发重载**。
- `dsh-hmr/README.md:61` / zh:61：HMR 初始化时注册 **profile manifest + 两份用户 patch**（profile 的 `cordis.patch.yml` 与 `$DSH_HOME/cordis.patch.yml`）的 watch。
- `dsh-hmr/README.md:49` / zh:49：HMR 的 profile 重组和 Plugin Manager 操作都会替换“profile 目录下已加载文件在磁盘上变了”的插件，**包括 `node_modules` 里的包与 linked 包的目标目录**；因此不需要 `root` 源码 watch。
- `dsh-hmr/README.md:47`：直接由 Plugin Manager 发起的操作**不等文件事件**，立即应用。
- `dsh-hmr/README.md:118`：**仅依赖变化的 manifest 变化不会触发重组；在 Plugin Manager 之外做的安装要等下一次重组或重启。**
- `dsh-hmr/README.md:27`：`root: []` 时没有源码 watch；**关闭 HMR 则只能重启生效**。
- 限制：`dsh-hmr/README.md:111`：profile `node_modules` 下每个链接都会扩大比较范围；如果链接的是进程入口静态导入的宿主模块（dsh-app-boot / Cordis / Loader 等）会变成 pending 并报 `restart-required`。**我们的插件包只链接自身，不链接宿主模块，不触发该限制。**

**推论（手工复刻的关键）**：若手工同时改 `package.json` 的 **dependencies** 和 **dsh.profile.bundles**（一次写入），HMR 会因 bundles 列表变化触发重组；重组时 `computeLatestResolution()` 重读 manifest + 重新解析 `node_modules` 链接，新 bundle 的 insert 行被组合、Loader 首次 import 该包（新加载，不是替换旧模块），因此**不需要重启**。单独只加 dependency、不改 bundles → 不触发重组（README.md:118），不生效。

### 3.3 Client 半区：是否需要刷新浏览器 / `window.__DSH_BOOT__` 何时生成

- `window.__DSH_BOOT__` 是 **页面加载时**由 Host 注入 HTML 的启动图（`dsh-client-modules/README.md:68、:84`；`lib/index.js` 中 `SCRIPT_NAME = "__DSH_BOOT__"`、`webServer` index 注入在 :570-571）。它只描述“这次页面加载时”的图。
- 页面打开后，**通过 client-hmr 的 SSE `/plugins/events` 持续接收完整图更新**：`dsh-client-hmr/README.md:10-12`（“keeps open Web pages in sync with the Host plugin graph … ordinary plugin enable/disable changes take effect without reloading the page or restarting the Host”）、`:31-33`（每个新连接先收到当前完整 graph）、`:47`（`/plugins/events`）。
- 浏览器侧 `ClientEntries` 会按图增量创建/删除 Loader entry，新 arrival 用单资源 URL 加载，不会重放启动 batch：`dsh-client-modules/README.md:40-42`（Live plugin composition）、`:76`（增量组合，`internal/plugin` 标脏）、`:88`（Entry ownership）。
- `dsh.client` 声明要求 `platform: 'web'`；非 web 的行直接不进图（`dsh-client-modules/lib/index.js:66-74`、`:733`）。
- 限制：`dsh-client-modules/README.md:136-138`：页面启动 bootstrap 不能热替换（要刷新）；Host release 变化（重启另一个 release）时页面只接受与 boot release 相同的图。当前进程内安装不改变 release（`0.2.1-rc.5/d4db512` 不变），所以能热应用。页面 F5 不是必须，但可作为兜底（只刷新页面，不重启 Host）。
- `dsh-client-hmr` 的已知限制原文是“Electron installation and backend restart handling do not use this SSE path. Entry reconciliation itself is transport-independent.”——指 Electron 的应用安装/更新与后端重启流程不走此 SSE；桌面 GUI 页面本身仍经它同步插件图（本机 `/plugins/events` 实测在线，§8 T8）。

**结论**：新增带 `dsh.client` 的 bundle 后，Host 行热重组 → client-modules 收到新 entry → client-hmr 推图 → 已打开的页面直接出现侧栏入口/面板，**不需要刷新页面**。`__DSH_BOOT__` 下次页面加载时自然包含它。

---

## 4. `dsh plugin --profile desktop add <path>` CLI 是否可用（实测）

### 4.1 两个不同的 CLI 入口

| 入口 | `manageDesktopProfile` | desktop 支持 | 证据 |
|---|---|---|---|
| 普通 npm 安装的 `dsh`（`@deepseek-ai/dsh/lib/bin.js` 直跑） | `false`（默认） | **拒绝** | `bin.js:101-112` 的 `rejectElectronProfile`；`bin.js:119` `if (!manageDesktopProfile) rejectElectronProfile(...)` |
| Desktop 自带启动器 `D:\software\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` | `true` | `plugin` 子命令**允许**（boot/dump 仍拒绝） | `dsh-desktop-host/lib/cli.js:94-108`（`runCli({manageDesktopProfile:true, packageManager: 内置 pnpm})`）；`dsh.cmd` 内容见该目录 |

### 4.2 实测结果

```text
# 1) desktop 自带 CLI：plugin --help 正常，说明 desktop 的 plugin 子命令被放行
> & "D:\software\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop --help
Usage: dsh plugin [options] [args...]
  --profile <name>  the profile whose plugins to manage
  -h, --help        show this help
EXIT=0

# 2) 普通 CLI（直接跑 asar 里的 dsh/bin.js）：plugin add 与 --dump-config 都被硬拒绝
> (ELECTRON_RUN_AS_NODE=1) DeepSeek Harness.exe --expose-internals "...\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" \
    plugin --profile desktop add "D:\nonexistent\work-window"
error: profile "desktop" is managed exclusively by the Electron application
EXIT=1

> ... --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
EXIT=1
```

### 4.3 实测：desktop CLI 真的能装（在 scratch DSH_HOME 上验证，不碰真实 profile）

```text
$env:DSH_HOME = <临时目录>\home        # 复制真实 profile 的 package.json/cordis.patch.yml/pnpm-workspace.yaml
& "D:\software\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "D:\program\dsh\plugins\work-window"

[WARN] The store ... using the store at <temp>\.pnpm-store\v11 instead.
dependencies:
+ @local/dsh-work-window 1.0.0 <- D:\program\dsh\plugins\work-window
Done in 451ms using pnpm v11.28.5
EXIT=0
```

结果与 §2.3 一致（dependency `link:D:/program/dsh/plugins/work-window`、bundles 追加、Junction 指向 D 盘、lock 更新）。**结论：CLI 可用，但仅指 desktop 自带 `dsh.cmd` 的 `plugin` 子命令；普通 `dsh` 不行，--dump-config 对 desktop 永远不行。**

### 4.4 但 CLI 路径“不推荐用于当前运行中的应用”

- `dsh-plugin-manager/README.md:146`：“Desktop package operations remain owned by the Desktop shell.”
- `dsh/lib/plugin-BiveYA7h.js:10-12` 的报错文案要求：desktop profile 要“fully quit it before running `dsh plugin --profile desktop`”。
- 它直接在 profile 目录跑 pnpm、写 package.json / lock / node_modules，与正在运行的 Host 的读取/监听并发；即使理论可行，也违反产品约定，且**集成后仍需重启**（因为要求先退出应用）。
- 因此 CLI 只作为 GUI 不可用时的“停应用 → 装 → 启应用”路径（1 次重启），见 §5.2。

---

## 5. 推荐方案（按优先级）

### 5.1 方案 A（推荐）：GUI「插件」页从本地目录安装 + 立即启用

**重启：0 次。页面刷新：不需要（F5 仅是兜底）。工作区外写入批准：0 次（由用户在 GUI 操作，Electron Host 写 profile）。**

已确认的 UI 文案与位置（`dsh-client-ui-plugin-manager/lib/client.js` 中文 locale `:79、:92-93、:143-144、:170、:224`）：

1. 左侧栏点 **「插件」**（Plugins）。
2. 点 **「添加插件」**主按钮；或点旁边箭头 → **「安装第三方插件」**（支持 npm 包、Git 仓库和本地目录）。
3. 在「包名或地址」输入框填 **`D:\program\dsh\plugins\work-window`**（必须是**绝对路径**；`parseInstallSpec` 要求绝对路径，见 `install-spec.js:58-66`；不要加引号，可省略 `file:`/`link:` 前缀）。
4. Registry 选项对本地路径无影响（不会查 registry），保持默认即可；阅读信任提示后点 **「安装」**。
   - Host 先用 `inspect` 读取该目录的 `package.json`：路径不存在 →「该路径不存在或不是有效的插件包」；没有 `dsh.bundle` →「这个包没有声明组合包，无法作为插件安装」。
   - 安装期间显示「插件安装中…」，pnpm 命令与输出可在「Show install details / 安装详情」里看到；底层是 app 自带 pnpm（实测 pnpm v11.28.5，日志写到 `profile/.plugin-manager/logs/operation-*/pnpm.log`）。
5. 安装完成显示「已安装」（版本 1.0.0）。**这一步只加了 dependency，没有选中 bundle（GUI 传 `enabled:false`）**；点 **「立即启用」**（Enable now）。
   - 该按钮调 `setBundleEnabled(name, true)` → 写 `dsh.profile.bundles` → `publishAndReload()` → HMR `reconcileProfile` 热重组（`lib/index.js:1949-1957、:2090-2095、:2351-2372`）。
6. 无需重启、无需刷新：Host 行激活后，client-modules 标脏 → client-hmr 推图 → 已打开页面出现侧栏 **「工作时段」** 入口与面板。
7. 如果页面没变化：先 **F5 刷新页面**（只刷新浏览器，不重启 Host）。仍不行再看 §7 验证，排查是否 `restart-required`。

**若弹出重启 toast**（文案见 `lib/client.js:94-99、:264`：`请重启 DSH 使更改生效。{reason}` / `已安装，请重启 DSH 加载它。{reason}`）：说明 HMR 没有应用（`no-hmr` / `package-moved` / `host-module` / `unmanaged-plugin` / `module-comparison`），此时需要重启 1 次；本会话会中断。按当前 profile 的配置，正常不会出现。

**GUI 会写的文件**（Host 进程写，不是 agent 写）：

| 文件 | 变化 |
|---|---|
| `C:\Users\chai_\.dsh\profiles\desktop\package.json` | `dependencies["@local/dsh-work-window"] = "link:D:/program/dsh/plugins/work-window"`；`dsh.profile.bundles` 末尾追加 `@local/dsh-work-window` |
| `C:\Users\chai_\.dsh\profiles\desktop\pnpm-lock.yaml` | 新增 link importer 条目 |
| `C:\Users\chai_\.dsh\profiles\desktop\node_modules\@local\dsh-work-window` | 新建 Junction → `D:\program\dsh\plugins\work-window` |
| `...\node_modules\.modules.yaml`、`.pnpm-workspace-state-v1.json` | pnpm 元数据更新 |
| `...\.plugin-manager\logs\operation-*\pnpm.log` | 新增安装日志 |
| `cordis.patch.yml` | **不变** |

**用户批准**：GUI 点击即用户授权；不需要 `plugin_manager` 工具审批（本会话/当前 preset 也没有该工具；GUI 页直接走 Host Remote）。不涉及 agent 的沙箱审批。

### 5.2 方案 B（GUI 不可用时）：停应用 → desktop CLI 安装 → 重启应用

**重启：1 次（必须，先退出 DSH，会中断本会话/当前 GUI）。工作区外写入：CLI/应用进程写，agent 不写。**

```powershell
# 1) 先让用户完全退出 DeepSeek Harness（托盘也退出，确认无 DeepSeek Harness.exe 进程）
Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue   # 期望空

# 2) 使用 Desktop 自带的 CLI（不要用 PATH 里的普通 dsh；若 dsh 指向该启动器可用 dsh）
& "D:\software\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "D:\program\dsh\plugins\work-window"

# 期望输出：dependencies: + @local/dsh-work-window 1.0.0 <- D:\program\dsh\plugins\work-window
#            Done in ... using pnpm v11.28.5   （实测 451ms，跨盘 Junction）

# 3) 重新启动 DSH 桌面应用（用户操作）
```

说明：

- CLI 的 `plugin add` 会通过 `reconcile()` 自动把新 bundle 追加到 `dsh.profile.bundles`（`lib/types/operations.js:96-124`、`:558-560`），所以不需要再手工选 bundle。
- 普通 `dsh plugin --profile desktop ...`（npm 全局 CLI）会硬拒绝（§4.2）。
- 失败时查看命令输出的 diagnostics 路径（`profile/.plugin-manager/logs/operation-*/pnpm.log`）；兼容性拒绝会恢复 `package.json` + `pnpm-lock.yaml`（`operations.js:331-338、:535-556`）。

### 5.3 方案 C（不重启，手写 profile；风险高于 A，仅在 A 不可用时）

**重启：0 次（HMR 应热重组；失败再重启）。工作区外写入：2 个写操作（创建 Junction、原子重写 `package.json`）；分成两条命令 = 2 次批准，合并成一条命令 = 1 次批准；本会话审批已禁用 → 实际只能由用户在自己的终端执行。**

> 方案 A 已验证可行，方案 C 是复刻官方安装的文件结果；官方文档明确要求“不要用 shell 复刻 install_bundle”（`SKILL.md:10`），所以只在 GUI 故障时用。

#### C-1 创建 Junction（不改文件内容）

```powershell
$target = 'D:\program\dsh\plugins\work-window'
$link   = Join-Path $env:DSH_PROFILE_DIR 'node_modules\@local\dsh-work-window'
New-Item -ItemType Directory -Force (Split-Path $link) | Out-Null
if (-not (Test-Path -LiteralPath $link)) {
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
}
(Get-Item -LiteralPath $link -Force) | Select-Object LinkType,Target
# 期望 LinkType=Junction, Target=D:\program\dsh\plugins\work-window
```

#### C-2 一次原子写 `package.json`（同时改 dependencies + bundles，触发 HMR 重组）

```powershell
node -e "const fs=require('fs'),path=require('path');const dir=process.env.DSH_PROFILE_DIR;const p=path.join(dir,'package.json');const m=JSON.parse(fs.readFileSync(p,'utf8'));m.dependencies=Object.assign({},m.dependencies,{'@local/dsh-work-window':'link:D:/program/dsh/plugins/work-window'});m.dsh=m.dsh||{};m.dsh.profile=m.dsh.profile||{};const b=m.dsh.profile.bundles=m.dsh.profile.bundles||[];if(!b.includes('@local/dsh-work-window'))b.push('@local/dsh-work-window');const tmp=p+'.tmp';fs.writeFileSync(tmp,JSON.stringify(m,null,2)+'\n');fs.renameSync(tmp,p);console.log('written',p);"
```

改后的完整期望内容（与 GUI/CLI 实测结果一致）：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@deepseek-ai/dsh-experimental-plugin-market-bundle",
        "@local/dsh-work-window"
      ]
    }
  },
  "dependencies": {
    "@local/dsh-work-window": "link:D:/program/dsh/plugins/work-window"
  }
}
```

#### C-3 `cordis.patch.yml`：**不改**

install 不写用户 patch；bundle 自己的 `plugins/work-window/cordis.patch.yml` 提供 insert 行：

```yaml
- insert:
    - id: work-window
      name: '@local/dsh-work-window'
      config:
        timeZone: Asia/Hong_Kong
        pauseWindows:
          - { start: '09:00', end: '12:00' }
          - { start: '14:00', end: '18:00' }
        holidayApiUrl: https://timor.tech/api/holiday/year/{year}
        cacheTtlHours: 12
        confirmDuringPause: true
```

（用户 patch 只在“想覆盖 bundle 行配置 / 行级开关”时才写，格式是 `- id: <row id>` + `name:` 断言 + `config:` 或 `disabled:`，例如 README.md:40：“A plugin toggle updates only `disabled` in the last matching override … or appends an override”。）

#### C-4 等待并验证热重组

- HMR 配置 watch 默认 `awaitWriteFinish: true`（写稳定窗口 2 s）+ `debounce: 100ms`（`dsh-hmr/README.md:43-47`），因此写完 `package.json` 后 **约 2–4 秒**热重组。
- 用 §7.2 的 SSE 图确认 `@local/dsh-work-window` 出现；或看 GUI「插件」页卡片是否变为启用。
- 若 10 秒后仍未出现且没有重启 toast，先检查：Junction 是否有效、包名是否与 `dsh.bundle` 一致、`dsh.client.platform` 是否 `web`、client.js 是否可加载。
- pnpm-lock 未更新是**已知且可接受**的副作用：运行时解析不读 lockfile（`dsh-app-boot/lib/index.js:766-799`、`:850-853`、`:995-1001`），只有下一次 official 包操作（安装/卸载/更新）时 pnpm 才会顺手把 lockfile 补齐。**不要**为此手工编造 lockfile。

#### C-5 回退

```powershell
# 1) 从 package.json 去掉 bundle 与 dependency（可用 node 脚本，原子写）
# 2) 删除 junction：
Remove-Item -LiteralPath (Join-Path $env:DSH_PROFILE_DIR 'node_modules\@local\dsh-work-window') -Force
# 3) 等 HMR 重组或重启；GUI「插件」页卸载与手工删除等价，但 GUI 还会跑 pnpm remove
```

---

## 6. 安装前预检（必须；`client.js` 是生成物，安装前重跑）

### 6.0 包完整性检查

> 时间线：调研开始时（2026-10-30 18:23）`plugins/work-window` 有 `package.json`、`cordis.patch.yml`、`index.js`、`locale/*.json`、`icon.svg`、`shared/holiday.js`，**没有 `client.js`**；18:27 已由 `tools/build-client.mjs` 生成并通过 `node --check`（58 KB，自包含）。该文件仍在随实现迭代重建——调研中曾抓到一次“生成中间态”的语法错误，说明**必须等构建结束再跑本预检**。若 `client.js` 缺失或语法错：Host 行可能激活但 client 图行加载失败/侧栏不出现；安装成功不代表模块能激活（`dsh-plugin-manager/README.md:52`：“A successful installation does not certify that a module can activate.”）。

```powershell
$pkgDir = 'D:\program\dsh\plugins\work-window'
$pkg = Get-Content "$pkgDir\package.json" -Raw | ConvertFrom-Json
$problems = @()
foreach ($f in @('index.js','client.js','cordis.patch.yml')) {
  if (-not (Test-Path -LiteralPath (Join-Path $pkgDir $f))) { $problems += "missing $f" }
}
if (-not $pkg.dsh.bundle.patch)            { $problems += 'package.json: dsh.bundle.patch missing' }
if ($pkg.dsh.client.platform -ne 'web')     { $problems += "dsh.client.platform must be 'web'" }
if (-not $pkg.exports.'./client')          { $problems += 'exports["./client"] missing' }
if (-not $pkg.exports.'.')                  { $problems += 'exports["."] missing' }
$patch = Get-Content "$pkgDir\cordis.patch.yml" -Raw
if ($patch -notmatch [regex]::Escape($pkg.name)) { $problems += 'cordis.patch.yml does not name the package' }
if (Test-Path "$pkgDir\client.js") { node --check "$pkgDir\client.js"; if ($LASTEXITCODE -ne 0) { $problems += 'client.js syntax error' } }
if (Test-Path "$pkgDir\index.js")  { node --check "$pkgDir\index.js";  if ($LASTEXITCODE -ne 0) { $problems += 'index.js syntax error' } }
if ($problems.Count -eq 0) { 'PREFLIGHT OK' } else { $problems }
```

### 6.1 客户端产物的格式要求

- `client.js` 必须是**单文件浏览器 artifact**：以 `window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ... return { inject: [...], apply(ctx) {} } } })` 注册（模板见 `.scratch/asar/.../templates/decoration/client.js:1-22`）。`id` 必须等于包名（`@local/dsh-work-window`）。
- 不能有顶层 ESM `import`（浏览器不原生解析；共享代码要内联进 factory，或走 `require.async` 的编译产物——手写文件最稳妥是内联）。`shared/holiday.js` 若被 client 使用，需要内联或由 host 提供数据，**不要**在 client.js 里 `import './shared/holiday.js'`。
- `dsh.client.inject` 目前是 `["@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-conversation"]`，这三个 id 都在当前 graph 中（§1.2/§8 T8），OK。
- `dsh.client.immediately: true` 会让页面在新图中立即加载该 entry。
- `platform` 必须是字符串 `"web"`，否则 `client-modules/lib/index.js:733` 直接跳过，不报错但侧栏永远不会出现。
- 当前 `client.js`（18:27 生成）实测只 `require('react')`（baseline 模块表内），无其它非 baseline 依赖，因此不需要 `dsh.client.external`；`loader.load({id: '@local/dsh-work-window', ...})` 与包名一致，满足 client-modules 的 row id 约定（`dsh-client-modules/README.md:34、:76`）。

### 6.2 其他预检

- **不要声明** `engines.dsh` 或 `peerDependencies` 里的 `@deepseek-ai/dsh*` 范围：当前 runtime 是 `0.2.1-rc.5`，范围不匹配会让安装直接 `incompatible-version` 拒绝（`dsh-app-boot/README.md:52`；`lib/index.js:2075-2077`）。`package.json` 不声明就没有约束。
- 不要声明 `dependencies`（插件宿主代码不需要安装任何东西）；若必须引用宿主包，应由 runtime resolution 从安装提供，声明 peer 反而引入兼容检查风险。
- 配置行 `config` 里的字段必须被 `index.js` 导出的 `Config` schema 接受（多余字段/类型错会导致该行 schema 校验失败、保持 inactive；`dsh-app-boot/README.md:102-103`）。最稳妥：`Config` 对这些字段都有默认值且不 `additionalProperties: false`。
- 插件代码里不要产生未处理的 Promise rejection / 同步回调异常：在该应用里它们是 **fatal**，会 dispose 整个应用并退出（`dsh-app-boot/README.md:109-110`），会直接杀掉当前会话。安装前至少跑一遍语法检查与纯函数单测。

---

## 7. 验证方法

### 7.1 文件级验证（无需重启）

```powershell
$m = Get-Content (Join-Path $env:DSH_PROFILE_DIR 'package.json') -Raw | ConvertFrom-Json
$m.dependencies.'@local/dsh-work-window'          # 期望 link:D:/program/dsh/plugins/work-window
$m.dsh.profile.bundles -contains '@local/dsh-work-window'   # 期望 True
$link = Get-Item -LiteralPath (Join-Path $env:DSH_PROFILE_DIR 'node_modules\@local\dsh-work-window') -Force
$link.LinkType; $link.Target                      # 期望 Junction / D:\program\dsh\plugins\work-window
```

### 7.2 运行时验证：client graph 是否包含新行（最可靠，无需重启）

```powershell
$graph = Join-Path $env:TEMP 'dsh-plugins-events.txt'
curl.exe -s -N --max-time 4 http://127.0.0.1:49729/plugins/events > $graph 2>$null
Select-String -Path $graph -Pattern '@local/dsh-work-window' | Select-Object -First 1
# 期望命中形如：
# data: {"type":"graph","graph":{"rev":"...","release":{"version":"0.2.1-rc.5","commit":"d4db512"},
#   "entries":[...,{"id":"@local/dsh-work-window","url":"plugins/??@local/dsh-work-window/client.js&rev=...","rev":"...","inject":[...]}...]}}
```

- 这条命令是只读的；`curl --max-time` 退出码 1 是超时结束，不是失败。每次**新连接**都会拿到当前完整图（`dsh-client-hmr/README.md:31-33`），所以不需要先触发事件。
- 该行出现 = 该 Loader entry 已进入 client 图（bundle 已被选中/启用、包声明了 `dsh.client`）；Host 侧 `apply()` 是否成功还要结合 GUI 行状态/错误提示判断（安装成功不等于激活成功，`dsh-plugin-manager/README.md:52`）。
- 若出现 `@local/dsh-work-window` 但 `url` 为空/报错，说明 client 半区有问题；若完全没有该行，说明 bundle 未启用或 Host entry 未激活（`dsh.client` 只在 enabled Loader entry 上扫描）。
- 还可以看到 `inject` 里的 sidebar/layout/conversation id；若 inject 的目标行不存在，页面 entry 会 pending/报错。

### 7.3 运行时验证：GUI 表现

- 「插件」页出现 `@local/dsh-work-window` 卡片，开关为“启用”，行 `work-window` 的状态标记为 active（行状态来自 Host fiber phase）。
- 左侧栏出现「工作时段」入口，点开面板显示状态/倒计时/节假日；无需 F5。若没出现：F5 一次（仅刷新页面）。
- 面板里的手动「立即放行一次」按钮若通过 Host 通道生效，可作为端到端验证。

### 7.4 “没有重启”的证据

安装前后各记录一次进程信息，确认 PID/StartTime 不变：

```powershell
Get-Process 'DeepSeek Harness' | Select-Object Id,StartTime
```

### 7.5 重启后的验证（仅当真的重启过）

1. `Get-Process 'DeepSeek Harness' | Select Id,StartTime` 是新的 StartTime = 确实重启过。
2. 重复 §7.1（文件仍在）、§7.2（graph 仍包含该行）、§7.3（侧栏入口仍在）。
3. 重启后 graph 的 `release.version/commit` 仍是 `0.2.1-rc.5/d4db512`（同一安装），不能拿 release 判断是否重启，必须看 StartTime。
4. 若重启后插件未出现：`profile/.plugin-manager/logs/` 无新日志很正常（启动不写），看 `$DSH_HOME/logs/startup-*.log`（仅启动失败时生成，`dsh/lib/bin.js:151-194`）以及 profile 的 `cordis.patch.yml` 是否被误改。
5. `--dump-config` 对 desktop 不可用（硬拒绝，§4.2）；不要用它验证 desktop 组合，改用 `/plugins/events` + GUI。

### 7.6 安装失败/未生效的排查顺序

1. GUI 安装对话框显示的失败分类（`not-a-package` / `not-a-bundle` / `network` / `incompatible-version` / build-script 等），或 CLI 的输出；
2. `profile/.plugin-manager/logs/operation-*/pnpm.log`（pnpm 原始输出、恢复说明）；
3. 检查 `package.json` / lock 是否被恢复到安装前（失败时）；
4. 检查 `.plugin-manager/run.json` 是否残留（运行中的 pnpm 记录；`README.md:102`）；
5. GUI「插件」页是否显示 `请重启 DSH` toast 及 reason（见 §5.1 的重启 toast 段）；
6. 若 Host 行 active 但侧栏无：看 `/plugins/events` 图行、client.js 格式（§6.1）、F5。

---

## 8. 实测记录（2026-10-30，均未触碰真实 profile）

| 编号 | 操作 | 结果 |
|---|---|---|
| T1 | `runtime\cli\bin\dsh.cmd plugin --profile desktop --help` | 打印 plugin help，EXIT=0；desktop 自带 CLI 放行 `plugin` 子命令 |
| T2 | 普通 `dsh/lib/bin.js plugin --profile desktop add D:\nonexistent\...` | `error: profile "desktop" is managed exclusively by the Electron application`，EXIT=1；未写任何文件 |
| T3 | 普通 `dsh/lib/bin.js --profile desktop --dump-config` | 同上硬拒绝，EXIT=1；确认 desktop 不能用 dump 验证 |
| T4 | 临时 `DSH_HOME` + scratch `desktop` profile（复制真实 package.json/patch/workspace）+ 本地 mock 插件（C: 盘）→ `dsh.cmd plugin --profile desktop add <mock>` | 999ms 成功；依赖 `link:C:/...`；bundles 追加；`node_modules/@local/work-window-probe` 为 **Junction**；lock 生成 |
| T5 | T4 的 profile 用普通 CLI `--profile probe --dump-config`（复制成 probe 名） | 输出包含 `# == @local/work-window-probe` / `- id: work-window-probe`，无 skipping → 手工 dependency+Junction+bundles 足以让组合解析成功 |
| T6 | 用**真实插件路径** `D:\program\dsh\plugins\work-window` 在另一 scratch desktop profile 安装（跨盘） | 451ms 成功；`@local/dsh-work-window: link:D:/program/dsh/plugins/work-window`；bundles 追加；Junction Target=`D:\program\dsh\plugins\work-window`；lock `version: link:D:/program/dsh/plugins/work-window` |
| T7 | 把 T6 的包复制成 `probe2` 并用普通 CLI `--dump-config` | 输出包含 `- id: work-window` 与完整 config（timeZone/pauseWindows/holidayApiUrl/cacheTtlHours/confirmDuringPause），无 skipping → 跨盘 Junction 解析 OK |
| T8 | `curl -s -N --max-time 4 http://127.0.0.1:49729/plugins/events` | 首帧完整 graph；`release.version=0.2.1-rc.5`、`commit=d4db512`；entries 含 `dsh-client-hmr`、`dsh-client-modules`、`dsh-client-ui-plugin-manager`；`/` 返回 401 |
| T9 | 真实 profile 只读核对 | `package.json` 311B/2026-10-26 10:21:54、`cordis.patch.yml` 836B/2026-10-23 11:36:16、`cordis.yml` 223B/2026-10-30 17:57:59（应用启动时写）、`node_modules/@deepseek-ai` 为空；**调研期间未改真实 profile** |
| T10 | `pnpm --version`（PATH） | 10.15.0（与 app 自带 11.28.5 不同；安装请让 Host/desktop CLI 用其自带 pnpm，不要用 PATH 里的 pnpm 手跑） |

---

## 9. 风险清单（按重要性）

1. **未处理异常会杀掉整个应用**（不仅是插件）：detached async rejection / 同步回调异常是 fatal（`dsh-app-boot/README.md:109-110`）。装之前确保插件 `apply` 内所有异步错误被捕获，`ctx.effect`/`ctx.on` 返回清理。
2. **安装成功 ≠ 激活成功**（`README.md:52`）：Host 行 schema/config 失败会 inactive；client 半区失败只影响侧栏/面板。装完必须按 §7 验证，不能只看「已安装」。
3. **GUI 安装默认 enabled:false**：不点「立即启用」不会生效（这不是失败，是 UI 流程）。CLI 的 `plugin add` 则会自动选中。
4. **不能覆盖安装**：HMR 下同名包已存在时 `installBundle` 直接 `already-installed` 拒绝（`lib/index.js:1991`）。升级/换版本要先 GUI 卸载再装；开发期改 linked 目录代码不需要重装（见 §10）。
5. **手动改 profile 的 `pnpm-lock.yaml` 会过期**：不影响本次加载，下一次 official 包操作会补；手工编造 lockfile 没有必要且容易错。
6. **HMR linked 包限制**：只链接普通插件包没问题；若插件包又链接/依赖进程入口静态导入的宿主模块（dsh-app-boot/cordis/loader），会 pending 并报 `restart-required`（`dsh-hmr/README.md:111`）。本插件的 `package.json` 应保持零 dependencies。
7. **桌面应用独占 profile**：不要用普通 `dsh`/PATH pnpm 在真实 profile 上跑命令；desktop CLI 只在应用退出后使用；GUI 永远是最安全路径。
8. **安全**：Installed Host code 直接在应用进程内、以用户权限运行，在 workspace sandbox 之外（`README.md:31`）；本地目录是链接 checkout，插件代码改动会立即反映到下一次重组。只装可信代码。
9. **HMR 配置 watch 的时机**：手工改 `package.json` 依赖但**不**改 `bundles` 列表不会触发重组（`dsh-hmr/README.md:118`）；手工路径必须保证 bundles 数组真的变化（append 新名字）。
10. **Windows 链接类型**：用 Junction（`New-Item -ItemType Junction`、pnpm 自动用 Junction），不要用 SymbolicLink（需要管理员/开发者模式）；跨盘 Junction 实测可用。
11. **写入竞争**：手工改 `package.json` 时若用户同时在 GUI 里开关插件，两边的 manifest 写可能互相覆盖（GUI 有文件锁，手工没有）。手工路径应“一次原子写”，并避免同时操作 GUI。
12. **client.js 缺失/格式错**：`dsh.client` 已声明但 `exports["./client"]` 文件缺失 → Host 安装可成功、页面侧栏不出现；必须先 §6.0 预检。

---

## 10. 开发迭代（装好之后改代码）

- 本地目录是 **Junction link**，profile 不复制文件；`plugins/work-window` 里的改动就是运行中的代码。
- **Host 半区**（`index.js` / `shared/holiday.js`）：下一次 profile 重组时替换已加载的 linked 文件（`dsh-hmr/README.md:49`）。触发一次重组即可：GUI「插件」页把该 bundle 关再开，或改一次 `cordis.patch.yml`。不需要卸载/重装、不需要重启（除非替换失败或涉及宿主模块）。
- **Client 半区**（`client.js`）：client-hmr 维持页面与 Host 图同步，并对被重建（rebuilt）的 bundle 做模块替换；其 `pollIntervalMs` 默认 500ms（`dsh-client-hmr/README.md:47`），开发用 `pnpm run dev:web` 的构建 watcher 会提供 rebuilt 帧（`dsh-client-hmr/README.md:27-35`）。手写 linked `client.js` 改完后，最稳的是 **F5 刷新页面**（会重新取 index 的 `__DSH_BOOT__`/图与新的 artifact revision）；若下一次 profile 重组恰好更新了该行，也可能自动换掉。刷新页面不重启 Host。
- 若代码改动导致 import 失败：HMR 报告 `failed` 并按错误停留；修好文件后下一次重组会重新 import（`dsh-hmr/README.md:69`），一般仍不需要重启。

---

## 11. 证据索引（路径均相对 `D:\program\dsh`）

- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.md`：14（HMR/重启）、31（profile 持久化、安装代码进程内执行）、40（bundle toggle 只改 bundles；安装默认启用）、44（source spec）、48（inspect）、52（install 行为、restart-required、激活失败不回滚）、60（requestId/日志）、64（build scripts）、69-75（兼容/exemption）、98-104（HMR 队列、文件锁、恢复）、141-146（限制；Desktop 包操作归 shell）、155-162（失败处理表）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.zh.md`：14、50、52、73、100、118、140-141（对应中文表述）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js`：319-321（saveManifest 原子写）、1293（RESTORED_FILES）、1572（inject loader/profileContext）、1989-1991（already-installed）、2033-2038（pnpm add）、2063-2078（校验 bundle/compat）、2080-2083（失败恢复）、2090-2095（select+publish）、2266-2279（快照/恢复）、2280-2306（selectBundle 写 bundles）、2324-2331（HMR runExclusive）、2351-2372（publishAndReload/reload）、2373-2400（文件锁与 application 状态）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js`：92-93（原子写 manifest）、96-124（reconcile 追加新 bundle）、299-318（runProfilePnpm 快照）、331-338（restore）、380（spawn pnpm）、558-560（成功后 reconcile）、591-602（runPluginCommand 锁）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/install-spec.js`：58-66（本地路径必须绝对；file:/link: 前缀）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`：79（侧栏“插件”）、92-93（安装第三方插件/支持本地目录）、143-144（添加插件/路径输入）、170（安装）、224（立即启用）、264/94-99（重启 toast 与 reason）、1537（inspect）、1595-1596（installBundle enabled:false）、1791-1797（enableInstalled→setBundleEnabled）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`：20-32（plugin-manager 与 hmr 同受 profileContext 门控；hmr root: []）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml`：42-43（dsh.client 行即 __DSH_BOOT__ 的来源）、214-219（client-hmr always mounted）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-hmr/README.md`：27（base 启用 HMR 条件/关闭需重启）、43-47（配置/awaitWriteFinish；PM 操作不等文件事件）、49（linked 包文件变化下一次重组生效）、59（watchConfig；manifest 通知仅在 bundles 顺序变化时重载）、61（注册 profile manifest + 两份 patch watch）、69（recompose/失败重试）、108-111（HMR 不重启进程；linked 包比较范围/宿主模块 pending）、118（仅 dependencies 变化不触发重组）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-hmr/README.zh.md`：27、49、59、61、65、118、141（对应中文表述）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-client-hmr/README.md`：10-12（页面同步、无需刷新/重启）、27-35（Web composition 挂载；SSE /plugins/events；新连接拿全图）、47（stat-poll/awaitWriteFinish）、限制（Web transport only）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-client-modules/README.md`：12（Host 组图/browser 加载）、30（web composition 激活）、34（dsh.client 声明要求）、38（启动 combo/懒加载）、40-42（Live plugin composition：新 entry 增量加载）、54（缺 client 产物会报错）、68（__DSH_BOOT__ 是 wire）、76（增量组合，internal/plugin 标脏）、84（index 注入行）、88（Entry ownership）、136-138（bootstrap 需刷新、release 变化）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js`：66-74（dsh.client 校验）、733（platform !== 'web' 跳过）、570-571（webserver index 注入）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/README.md`：50（profiles；web 模板 live reload；Electron 保留 profile 用 loadProfileDirectory）、52（兼容检查）、54（准入边界）、63（HMR watch）、67（runtime resolution）、73（dump）、92-113（reload 失败策略；109-110 fatal 未处理异常）、138（runtime resolution/链接）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`：664-692（linkedProfileRoots）、766-799（createRuntimeResolution）、850-853（installedProfilePackageNames 查 node_modules）、894-898（profile scope 闭包）、995-1001（resolveBundleDir：安装锚点→profile）、1015-1051（loadProfileDirectory：坏 bundle 跳过）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-hmr/…`（同上）；`@deepseek-ai/cordis-plugin-loader/README.md`：3-5、40-49（Loader 只 import/sync，不 watch）；`cordis-plugin-loader/src/index.ts`：171-173（write() no-op）、186-194（locate）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`：35-37（rejectElectronProfile）、63-91（dump 模式）、101-126（boot/plugin 解析与 manageDesktopProfile 门控）、234-237（plugin dispatch）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh/lib/plugin-BiveYA7h.js`：10-12（desktop 需先退出应用的提示）、63-99（runPlugin；desktop 走 withFileLock + runProfilePnpm）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js`：255-327（runProfile）、289-306（profileContext provide）、302-312（boot）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`：218-250（desktop 用 runProfile + loadProfileDirectory）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`：94-108（runDesktopCli：manageDesktopProfile: true + 内置 pnpm）
- `.scratch/asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md`：8-10（用 install_bundle，不要手写 profile/pnpm；每次工作区外写都要批准）、34（DSH_PROFILE 证明 profile 启动）
- `…/references/host-plugin.md`：7-27（Host-only manifest/patch 模板）、31-35（展示资源清单；本地目录安装是链接 checkout，files 不过滤）、57-64（index.js 导出形态/Config）、66-70（安装/观察；新 bundle 可经 HMR 激活，替换包需重启）
- `…/templates/decoration/`（package.json / cordis.patch.yml / client.js / index.js：单行 insert + client half 模板；client.js 的 `__ModuleLoader__.load` 格式）
- 运行态：`C:\Users\chai_\.dsh\profiles\desktop\.plugin-manager\logs\operation-2CM0z5\pnpm.log:28-31`（历史安装 + pnpm 11.28.5）、`operation-qZQF7s\pnpm.log:4-6`（历史卸载）
