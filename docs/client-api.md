# Client（浏览器半区）API 调研 — 侧栏入口 / 面板 slot / locale / Host↔Client 通道

> 调研者：`client-api`（task-2）。所有结论均给证据（路径:行号+片段）。证据全部来自 `<workspace>\.scratch\asar\`（asar 解包，只读参考）。
> 下文路径统一以工作区为根，省略前缀 `.scratch/asar/dsh/node_modules/@deepseek-ai/`，写成 `dsh-client-ui-sidebar/lib/client.js:226` 这类形式。
> 标注 **未验证** 的条目表示：解包内容里找不到直接证据，或需要在运行中的应用上实测才能确认。

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 | 证据 |
|---|---|---|
| 侧栏入口怎么写 | `ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name:"sidebar.panellist", id:<面板ID>, order:<number>, locale:<NS>, label: () => t("panel") }, IconComponent))` | `dsh-client-ui-plugin-manager/lib/client.js:4484-4490`；`dsh-client-ui-schedule/lib/client.js:7484-7490`；`dsh-client-ui-sidebar/README.md:38` |
| 面板怎么写 | `ctx.slots.inject("main", () => ctx.slots.register({ name:"main", key:<同一个面板ID>, locale:<NS>, inject: () => ({...}) }, PageComponent))` | `dsh-client-ui-plugin-manager/lib/client.js:4411-4461`；`dsh-client-ui-schedule/lib/client.js:7473-7483` |
| 两个 ID 的关系 | panellist 用 `id`，main 用 `key`，**值必须相同**；`ctx.layout.selectPanel(id)` 只接受在 `main` 中注册过的 key，否则抛错且不改变选中态 | `dsh-client-ui-plugin-manager/lib/client.js:4354-4355`（`PANEL_ID="plugins"`），`dsh-client-ui-layout/lib/client.js:617`，`dsh-client-ui-sidebar/README.md:38` |
| 图标是什么 | **React 组件**（不是字符串/图片），侧栏直接渲染它，props 为 `{ size: 16|18, active: boolean }` | `dsh-client-ui-sidebar/lib/client.js:226-229`；`dsh-client-ui-plugin-manager/lib/client.js:4289-4291` |
| React 怎么拿 | 工厂函数收到 `require`：`const React = require("react")`（也可 `require("react/jsx-runtime")`）。**不要 require 其他 Harness 客户端包**（如 ui-primitives） | `dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js:4`；`references/ui-plugin.md:9`；`references/practices.md:35` |
| locale 文案 | 运行时字典必须在 `client.js` 里内联注册：`ctx.effect(() => ctx.locale.register(NS, { zh, en }), "label")`，然后 `const t = ctx.locale.bind(NS)`；注册项上的 `locale: NS` 会让框架给组件注入 `t` prop。`locale/*.json` **只放 `meta.title/description` 供插件管理页显示**，不参与运行时文案 | `dsh-client-ui-entry-customization/lib/client.js:103-107`；`dsh-client-ui-plugin-manager/lib/client.js:4373-4377`；`dsh-client-ui-plugin-manager/locale/en.json`（只有 `meta`）；`dsh-client-locale/README.md:38` |
| Host↔Client 通道 | **没有**给第三方插件新增远程命名空间的公开路径（客户端 `remote` 的命名空间集合在编译期固定）。唯一官方推荐的 UI→Host 调用是 **session command**：Host 用 `ctx.commands.register()` 注册命令，Client 用 `ctx.remote.commands.execute(sessionId, line, attachments)` 调用；要求存在一个活的 agent/session。降级方案：面板纯前端计算 + 只读展示 | `dsh-agent-preset/.../references/user-actions.md:8`；`dsh-api-remotes/README.md:77-79`；`dsh-api-remotes/README.md:43`；`dsh-client-ui-commands/lib/client.js:1718` |
| client.js 打包格式 | `window.__ModuleLoader__.load({ id: "<包名>", factory(require) { ... return { apply, inject } } })`；`id` 必须等于 `package.json` 的 `name` | `templates/decoration/client.js:1-22`；`references/ui-plugin.md:9`；`dsh-client-ui-entry-customization/lib/client.js:1-4` |
| package.json | `exports["./client"]` 必填（缺失时 Host 直接报错），`dsh.client = { platform:"web", immediately?:true, inject?:["<客户端包id>"], external?:[...] }` | `dsh-client-modules/lib/index.js:738`；`dsh-client-modules/README.md:34,50`；`templates/decoration/package.json:6-20`；`dsh-client-ui-plugin-manager/package.json:16-47` |
| 主题 | 只用 `--dsw-alias-*` token，禁止硬编码颜色；可照抄 plugin-manager 页面的容器 CSS | `references/practices.md:34`；`dsh-client-ui-plugin-manager/lib/client.js:1913`（页面 CSS 字符串） |
| 骨架 | 可运行最小骨架：`<workspace>\prototype\client.js` | 本文件 §9 |

---

## 1. 证据与环境

- asar：`<DSH-install-dir>\resources\app.asar`；解包目录 `<workspace>\.scratch\asar\`。
- 本次新增解包（只解包、未改动已有内容）：`dsh-api-remotes`、`dsh-client-locale`、`dsh-commands`、`dsh-client-ui-commands`、`dsh-client-shortcuts`、`dsh-typert-protocol`、`dsh-client-modules`、`dsh-client-ui-theme`、`dsh-client-ui-schedule`、`dsh-client-ui-jobs`、`dsh-client-ui-settings`、`dsh-client-ui-settings-plugins`、`dsh-web-frontend/dist/assets/index-BXV-oxvX.js`。
- `@deepseek-ai/dsh-client-ui-slots` 包**不在** asar 内（`slots` 服务由 Web 前端 shell 提供），因此 `ctx.slots.*` 的完整类型签名无法直接引用，本文件里的注册参数表是从**真实注册代码**反推的（下表逐项标注出处）。用 `Slots.listSubTree` 的官方探查（skill 里提到）本会话不可用。

---

## 2. 侧栏入口（`sidebar.panellist`）+ 主面板（`main`）

### 2.1 两个 slot 由谁声明

`main` 是 **keyed / root scope**，由 layout 的根注册声明（`dsh-client-ui-layout/lib/client.js:623-653`）：

```js
const disposeRegistration = ctx.slots.register({
    name: "root",
    locale: "common",
    children: {
        "sidebar":      { kind: "single", scope: "root" },
        "main":         { kind: "keyed",  scope: "root" },   // ← 我们的面板注册进这里
        "rightbar":     { kind: "single", scope: "root" },
        ...
    },
    store
}, AppFrame);
```

渲染方（`dsh-client-ui-layout/lib/client.js:118-119`）：

```js
function MainPanel({ usePanelInfo, renderSlot }) {
    return renderSlot("main", {}, { entryKey: usePanelInfo((info) => info.activePanelId) ?? "conversation" });
}
```

`sidebar.panellist` 是 **list / root scope**，由 sidebar 的根注册声明（`dsh-client-ui-sidebar/lib/client.js:611-649`）：

```js
ctx.slots.inject("sidebar", () => ctx.slots.register({
    name: "sidebar",
    locale: NS,
    children: {
        ...
        "sidebar.panellist":         { kind: "list", scope: "root" },
        "sidebar.panellist.actions": { kind: "list", scope: "root" },
        ...
    },
    inject: injectProps
}, SidebarRoot));
```

侧栏自己维护的面板元数据台账（`dsh-client-ui-sidebar/lib/client.js:566-584`）——注意它只读 `id / order / label`，**图标不在台账里**，是渲染时 `renderSlot` 取的：

```js
const syncPanels = () => {
    const next = ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => {
        const id = options.id;
        return {
            id,
            order: options.order ?? 0,
            label: (0, _deepseek_ai_dsh_client_ui_slots.resolveSlotLabel)(options.label) ?? id
        };
    }).sort((a, b) => a.order - b.order);
    ...
};
```

### 2.2 plugin-manager 的**真实**注册代码（`plugins` 入口与主面板）

常量与注入（`dsh-client-ui-plugin-manager/lib/client.js:4352-4366`）：

```js
/** Dictionary namespace owned by this plugin. */
const NS = "pluginManager";
/** The id shared by the sidebar entry and the main panel it opens. */
const PANEL_ID = "plugins";
const inject = ["slots","locale","remote","remote.pluginManager","remote.pluginInventory",
                "remote.pluginRegistryProbe","configForms","layout"];
```

主面板（`dsh-client-ui-plugin-manager/lib/client.js:4411-4461`，节选）：

```js
ctx.slots.inject("main", function* () {
    const handle = createNavigationStore(), instance = handle.create();
    const store = { ...handle, create: () => instance };
    yield ctx.slots.register({
        name: "main",
        key: PANEL_ID,          // ← "plugins"，与侧栏 id 相同
        locale: NS,
        store,                  // 可选：注册即创建一个 store，组件拿到 useStore/actions
        inject: () => face,     // 可选：任意注入 props（这里把 controller 的 face 传给页面）
        children: {             // 可选：本页面自己声明的子 slot（页面存活期间存在）
            "plugins.add.actions":  { kind: "list",  scope: "root" },
            "plugins.tab":          { kind: "list",  scope: "root" },
            "plugins.item":         { kind: "list",  scope: "root" },
            "plugins.bundle.activation": { kind: "keyed", scope: "root" },
            "plugins.bundle.config":     { kind: "keyed", scope: "root" },
            "plugins.row.config":        { kind: "keyed", scope: "root" },
            "plugins.detail.actions":    { kind: "list",  scope: "root" },
            "plugins.detail.badge":      { kind: "list",  scope: "root" },
            "plugins.detail.section":    { kind: "list",  scope: "root" }
        }
    }, PluginManagerPage);
    ...
});
```

侧栏入口（`dsh-client-ui-plugin-manager/lib/client.js:4484-4490`）：

```js
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,               // ← "plugins"
    order: 0,
    label: () => t("panel"),    // 字体/locale 感知标签：函数返回当前语言文案
    locale: NS
}, PluginsPanelIcon));
```

图标组件（`dsh-client-ui-plugin-manager/lib/client.js:4283-4291`）：

```js
/**
 * Render the plugin glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 */
function PluginsPanelIcon({ size }) {
    return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPluginPinwheelOutlineRegular, { size });
}
```

侧栏渲染入口时的 props（`dsh-client-ui-sidebar/lib/client.js:204-235`，节选）：

```js
function PanelRow({ id, label, wide, usePanelInfo, selectPanel, trackEntryClick, renderSlot }) {
    const active = usePanelInfo((info) => info.activePanelId === id);
    ...
    children: renderSlot("sidebar.panellist", {
        size: wide ? 16 : 18,     // ← 图标必须消费 size，否则尺寸不自适应
        active                    // ← 是否选中（可用于高亮）
    }, { only: id })
```

> **结论**：图标是「React 组件」，会被侧栏以 `{ size, active }` 渲染；点击行只做 `ctx.layout.selectPanel(id)`，面板的挂载由 layout 的 `main` keyed slot 完成。所以**图标组件里不要做数据加载**，任何副作用放到面板组件里。

### 2.3 更简单的官方范例：`schedules` 面板（无 store、无 children）

`dsh-client-ui-schedule/lib/client.js:7473-7490`：

```js
ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,                        // "schedules"
    locale: MANAGER_NS,
    inject: () => ({ ...detail, onNewTask: () => { ctx.uiWorkspace.startSession(); } })
}, TaskManagerPage));
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: 10,
    locale: MANAGER_NS,
    label: () => t("panel")
}, TaskManagerIcon));
```

面板组件签名（`dsh-client-ui-schedule/lib/client.js:6643-6644`）：`function TaskManagerPage(props) { const { useCatalog, onNewTask, onRetry, t } = props; ... }`
→ **`t` 是框架按 `locale: NS` 注入的；`use*` 前缀的 hook props 来自 `inject` / root hooks / store；其余是 `inject` 返回的普通值。**

图标同款（`dsh-client-ui-schedule/lib/client.js:6874-6876`）：`function TaskManagerIcon({ size }) { return jsx(IconClockOutlineRegular, { size }); }`

### 2.4 注册项 options 汇总（从真实代码反推）

| 字段 | 适用 | 含义 | 证据 |
|---|---|---|---|
| `name` | 必填 | 目标 slot 全名（与 `inject` 第一个参数一致） | 全部注册代码 |
| `id` | list slot 必填 | 条目 id（`sidebar.panellist` 用它寻址面板） | `plugin-manager:4486`、`sidebar/lib/client.js:569-573` |
| `key` | keyed slot 必填 | 键（`main` 用面板 id；`plugins.row.config` 用 `<包名>#<row id>`） | `plugin-manager:4419`、`plugin-manager/README.md:76-81` |
| `order` | 可选，默认 0 | 排序，数值小的靠前（sidebar 自己 sort） | `sidebar/lib/client.js:572,575` |
| `label` | 可选（list 建议给） | 字符串或 `() => string`（locale-aware，随语言切换） | `sidebar/lib/client.js:573`；`sidebar/README.md:38`；`plugin-manager:4488` |
| `locale` | 可选（有 `t` 时必须） | 字典命名空间，框架据此给组件注入 `t` | `plugin-manager:4489`、`schedule:7476` |
| `inject` | 可选 | `() => props` 或 `(sessionId) => props`，返回注入给组件的 props | `entry-customization:129-134`、`schedule:7514` |
| `store` | 可选 | 注册即创建 store，组件获得 `useStore/actions` | `plugin-manager:4421`、`layout:610-613` |
| `children` | 可选 | 子 slot 声明（页面存活期间才存在） | `plugin-manager:4423-4460` |

`ctx.slots.inject(ownerKey, cb)` 的语义（官方 README，`dsh-client-ui-entry-customization/README.md:45`）：注册随 owner 声明的生命周期存在——owner 崩溃/卸载时自动 dispose，重新声明时重新注册。**所以永远用 `ctx.slots.inject(..., () => ctx.slots.register(...))`，不要裸 `ctx.slots.register`。**

### 2.5 坑

1. `id`/`key` 不一致 → 侧栏有行但点击抛错（`sidebar/README.md:38`："selecting a missing main entry throws without changing the current selection"）。
2. `main` 面板是**全局页面**（不属于某个 Session）：`plugin-manager/README.md:119` 明确 "The page is global and belongs to no Session"。不要在面板里默认拿"当前会话"，需要显式获取（见 §5）。
3. 框架会把 `renderSlot` 等运行时 props 传给组件（`PluginManagerPage` 解构 `{ t, ensure, renderSlot, resolveText }`，`plugin-manager/lib/client.js:3830-3831`）；`usePanelInfo` 来自 layout 的 root hook（`layout/lib/client.js:621` `ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })`，sidebar 组件即以 `usePanelInfo` prop 消费，见 `sidebar/lib/client.js:290`）。这些名字是**框架约定**，除 `t` 外未在解包文档里逐项列全，标注**部分未验证**；骨架里只依赖 `t`。

---

## 3. Client locale

### 3.1 运行时文案：内联字典 + bind

`dsh-client-ui-entry-customization/lib/client.js:92-107`：

```js
const inject = ["slots", "locale", "pluginNavigation", "uiWorkspace"];
function apply(ctx) {
    ctx.effect(() => ctx.locale.register("entryCustomization", { en, zh }));
    const t = ctx.locale.bind("entryCustomization");
    ...
}
```

- API：`ctx.locale.register(ns, { zh, en })` 返回 disposer → 必须包在 `ctx.effect(...)` 里；`ctx.locale.bind(ns)` 返回稳定的 `t` 函数（可进 `inject` 面，不破坏 memo）。
- 官方说明：`dsh-client-locale/README.md:38` —— "Call `ctx.locale.register(ns, { zh, en })` … Consumers translate through `ctx.locale.bind(ns)` or the framework-injected `t` seat."
- `t` 是 slot 组件的 prop（`locale: NS` 时注入）；对应 `LocaleFace` 实现见 `dsh-client-locale/README.md:84`。
- 文案语言切换：slot 内渲染的文案会**即时跟随切换**；只有"注册时捕获"的文本会冻结（`dsh-client-locale/README.md:137`）。所以 `label: () => t("panel")` 必须是函数，不能是 `label: t("panel")` 的求值结果。
- 其他：`ctx.locale.resolveText(text)` 用于解析 `LocalizedText`（包标题/描述），`README.md:42`。

### 3.2 `locale/*.json`：只放 `meta`

实测三个官方包的 `locale/*.json` 只有 `meta`：

```json
// dsh-client-ui-plugin-manager/locale/en.json
{ "meta": { "title": "ui-plugin-manager" } }
// dsh-client-ui-plugin-manager/locale/zh.json
{ "meta": { "title": "插件管理界面", "description": "查看和安装插件包，并进行启用、停用和重试等操作。" } }
```

这些文件由 Host / 插件管理页直接读取（不激活插件即可显示清单）：`dsh-agent-preset/.../references/host-plugin.md:31-42`。
**结论**：`locale/*.json` 是"包的显示元数据"，`client.js` 里的字典才是 UI 文案。两边都要有 `meta.title/description`（en + zh 齐全，`host-plugin.md:33`）。注意运行时字典不能从 json 文件 import（浏览器半区是自包含 bundle），必须内联或经构建期打包。

---

## 4. client.js 的包装格式、React、模块表、CSS

### 4.1 外壳（`window.__ModuleLoader__.load`）

官方模板 `templates/decoration/client.js:1-22`（完整）：

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Decoration() { ... }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Decoration));
      },
    };
  },
});
```

- `id` **必须等于包名**（`ui-plugin.md:9`："registers a lazy factory whose id equals the package name"）。
- 工厂返回 `{ apply, inject }`（与 Host 半区的导出形态一致）；也可像编译产物那样先 `var module = {exports:{}}` 再 `export`（`dsh-client-ui-entry-customization/lib/client.js:1-8,149-152`），两种都行。
- 工厂只做注册，**不要有副作用**；定时器/订阅/样式一律在 `apply` 里用 `ctx.effect`/`ctx.on` 并返回清理（`ui-plugin.md:13`）。
- 浏览器半区跟随 Host Loader 行：`dsh-client-ui-plugin-manager/README.md:133` —— "`dsh-client-modules` attaches a package's browser half to the Loader row whose specifier is the bare package name, so every page a bundle registers … goes away when that row is switched off"。

### 4.2 React 来源

- `const React = require('react')`（模板 `client.js:4`）；编译产物用 `require("react/jsx-runtime")`（`entry-customization/lib/client.js:7`），两者都在基线模块表里。
- `ui-plugin.md:9`："React comes from the browser module table; no duplicate React installation, CDN script, or UMD search is needed. … declare non-baseline runtime imports in `dsh.client.external`."
- **禁止** `require('@deepseek-ai/dsh-client-ui-primitives')` 或其他 Harness 客户端包（`practices.md:35`）：它们随时会变、无类型检查，组件抛错会直接让 slot 条目变空白（console: `slot entry crashed in '<slot>'`）。需要按钮/徽章就自己写，样式抄官方页面并改类名前缀，只保留 `--dsw-alias-*` token。
- 基线模块表 = `PLATFORM_MODULES`，`dsh.client.external` 只能追加"精确的非基线请求"，每项由动态包行或静态表键应答（`dsh-client-modules/README.md:50`）。所以**我们的 bundle 只需 `{ platform:"web" }`，不要声明 external**。

### 4.3 CSS 注入（组件内自包含）

官方编译产物用 `style[data-plugin-css]` 去重注入（`entry-customization/lib/client.js:10-18`）：

```js
const tagId = "@deepseek-ai/dsh-client-ui-entry-customization/EntryMenu.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-entry-customization";
    tag.dataset.pluginCss = tagId;
    tag.textContent = css;
    document.head.appendChild(tag);
}
```

骨架里沿用这个模式（一次性注入 + `data-plugin` 标记，HMR/卸载由框架负责移除）。

---

## 5. Host ↔ Client 通道（核心结论）

### 5.1 客户端 `remote` 服务的命名空间是**编译期固定**的

`dsh-client-ui-plugin-manager/lib/client.js:4357-4366` 的 `inject` 里可以直接写 `"remote.pluginManager"`；`dsh-client-ui-commands/lib/client.js:1386-1391` 写 `"remote.commands"`。这些 `remote.<ns>` 从哪来？

`dsh-api-remotes/lib/client.js:23753-23789`：

```js
const inject = ["remote"];
async function apply(ctx) {
    const disposers = [];
    for (const contribution of [ TYPERT_REMOTE$25, ..., TYPERT_REMOTE$23 ])
        disposers.push(await ctx.remote.$mount(contribution));
    ...
}
```

即：**客户端可调用的 Host 面 = 这个 assembly 里显式 mount 的 26 个贡献**（实测命名空间：`productAnalytics, agentPresets, userQuestions, commands, account, credentials, settings, officeToPdf, goals, schedule, llm, dynamicCordisRunner, pluginManager, pluginInventory, pluginMarket, messageFeedback, subagents, fileReferences, session, skills, job, directoryPicker, workspace, terminal, workspaceFiles`）。

而 `dsh-api-remotes/README.md:77-79` 明确写死了限制：

> - The capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime.
> - Additional capabilities require an explicit `/remote` value import and mount in this assembly.

同理，Host→Client 的事件也只有 allowlist：`dsh-api-remotes/README.md:43` —— `ctx.remote.$on` 的合法 key 集合由 `API_REMOTE_FORWARDED_EVENTS` 决定，**插件无法把自己的 Host 事件塞进去**。

> **结论 A（通道上限）**：第三方纯 JS 插件**不能**自造 `remote.<myPlugin>` 命名空间，也不能自造 `$on` 事件，除非改写 asar 内的 `dsh-api-remotes`（不可写、不可取）。
> 理论上的手写 Typert 路线也不推荐：Host 侧需要生成式 `./typert` 产物（`dsh-typert-loader/README.md`：由 tsdown/typert generator 产出，`./typert` 导出需重启才被发现），Client 侧要 `ctx.remote.$mount(createTypertRemoteInfo(...))` 且需 `require('@deepseek-ai/dsh-typert-protocol/remote-info')`（违反 §4.2 的"不要 require Harness 客户端包"）。**标注：未验证，不建议尝试。**

### 5.2 官方推荐做法：session command（唯一可用的 UI→Host 通道）

官方 skill 直接给了方案（`references/user-actions.md:5-9`）：

> 1. Implement the operation once as a Host service method. …
> 2. The UI action calls it through a Client-callable Host entry point found with inspection, **such as a session command that `ctx.remote.commands.execute()` runs**, and shows the returned failure.
> 3. Expose the operation through an agent tool with matching parameters and meaning.

**Host 半区**：`ctx.commands.register({ name, description, input?, handler })`（`dsh-commands/README.md:32-46`）：

```js
ctx.commands.register({
  name: 'plan',
  description: 'Enter plan mode',
  input: { hint: '<message>' },
  handler: ({ agent, rawInput }) => {
    return { kind: 'success', text: 'plan mode selected' }
  },
})
```
- 普通注册是**全局**命令；`handler` 直接对 agent 执行、不产生模型消息；返回 `{kind:'success'|'error', text?}`。
- 每次 admitted 执行都会在**接收 agent 的 session log** 里追加 `command/run`/`command/done`（`commands/README.md:88`）——这是副作用，见风险。
- Host 侧是否用 `ctx.commands`（服务名/`inject: ['commands']`）需 host-api 调研确认；本条仅依据 Host 侧 README 的写法。

**Client 半区**：`ctx.remote.commands.execute(sessionId, line, attachments)`（真实调用处 `dsh-client-ui-commands/lib/client.js:1717-1719`）：

```js
async execute(session, line, attachments = []) {
    const result = await this.ctx.remote.commands.execute(session.sessionId, line, attachments);
    if (!result.ok) throw new Error(`command.execute failed: ${result.error.code}: ${result.error.message}`);
    if (result.value === void 0) return { kind: "error", text: `unknown or malformed command: ${line}` };
    ...
}
```

Remote 定义（`dsh-api-remotes/lib/client.js:1256-1265`）：`commands/execute` 是 **agent-scoped**（`scope: { context:"agent", wire:"agentId" }`），参数 `(agentId, line, submittedAttachments)`，返回 `{ commandId, result: { kind:'success'|'error', text? } }` 或 `undefined`（语法错/未知命令）。同命名空间还有 `commands.list(sessionId)`（`dsh-client-ui-commands/lib/client.js:1416`）。

**怎么拿 sessionId（面板是全局页面，没有 session prop）**：

```js
const list = await ctx.remote.session.list({}, signal);      // dsh-api-remotes/lib/client.js:16696-16732
const item = list.ok ? list.value.items.find((i) => i.agentAvailable === true) : undefined;
```
`session/list` 的描述是 "Read all visible Session rows without resuming an Agent"，每项带 `sessionId / agentAvailable / running / blank / updatedAt`（同段）。**注意**：这是"挑一个当前有活 agent 的会话"，不是"当前会话"——语义上不完美。

> **结论 B**：v1 推荐**只读面板 + `/work-window` 斜杠命令**：
> - Host：注册全局命令 `/work-window status|release|config`（handler 操作插件状态），
> - Client：面板纯前端计算状态；"立即放行"按钮可选实现为 `session.list` 找活 agent → `commands.execute`。
> - 用户在输入框里直接敲 `/work-window release` 永远可用（无需会话上下文 hack），面板上也把这条命令写出来。
>
> 副作用风险：命令执行会写入该 session 的 `command/run|done` 日志（`dsh-commands/README.md:88`）；对"误用别的会话"这一点要在 UI 上提示。

### 5.3 另一条（仅配置类）session-free 路径：settings 命名空间（**未完全验证**）

`ctx.remote.settings.describe()` 返回所有已注册命名空间的（脱敏后的）分层值 + 序列化 schema（`dsh-api-remotes/lib/client.js:3147-3151`），`ctx.remote.settings.mutate(ns, ops)` 做 path 寻址写入（`dsh-api-remotes/lib/client.js:3243-3255`，ops 仅 `set/unset`）。
`dsh-settings` 把自己描述成"编辑插件 Config 的 volatile 字段"（`dsh-settings/README.md` Summary + `Use this package`：`Forms identify each plugin by its profile entry id`，`Forms expose only volatile fields from active, uniquely addressed profile entries`）。
**但**：命名空间是否自动包含某个第三方 entry、是否需要 `ctx.settings` 侧注册、volatile 语义如何写作，都需要 host-api 侧确认。**标注：未验证**。不要把它当 v1 依赖；若 host-api 确认可行，它可用来让面板**读写持久配置**（pauseWindows/时区/API URL），比让用户手改 `cordis.patch.yml` 友好。

### 5.4 降级方案（保底，零风险）

面板全部在浏览器内计算与展示：
- 用与 Host 共享的纯函数（`shared/holiday.mjs`）在本地算 `working/paused`、下一个可工作时段；
- 暂停区间等配置**以 `client.js` 内的默认值与 `locale` 文案为准**，和 Host 半区的 `Config` 默认值保持同一份常量（复制，不共享模块）；
- 明确标注"以 Host 为准"的部分降级为"本地计算"，诚实展示"Host 权威状态不可用"；
- 手动放行 = 提示用户在输入框输入 `/work-window release`（Host 命令由 host-api 实现）。

---

## 6. 主题 token 与面板布局

### 6.1 规则

`practices.md:34`：只用 `cordis_inspect_query Theme` 列出的 token（`--dsw-alias-*`）；字面色仅用于 artwork；spacing/字号/行模式照抄同类官方页面（管理列表的参考就是 Plugin Manager 页）。`verification.md:5`：面板必须只用 token、不 import Harness 客户端包、console 不出现 slot crash、明暗主题都正常。

实测 token（定义在 ui-theme 的 token 表里，`dsh-client-ui-theme/lib/client.js` 内 107 个 `--dsw-alias-*`；plugin-manager 页面实际使用的见 `dsh-client-ui-plugin-manager/lib/client.js:1913`）：

| 用途 | token |
|---|---|
| 页面主文字 | `--dsw-alias-label-primary` |
| 次级/三级文字 | `--dsw-alias-label-secondary`、`--dsw-alias-label-tertiary`、`--dsw-alias-label-caption` |
| 卡片/分层底色 | `--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2`、`--dsw-alias-bg-layer-3` |
| 行内 code 底色 | `--dsw-alias-bg-module-platform` |
| 边框 | `--dsw-alias-border-l1`…`-l4` |
| hover | `--dsw-alias-interactive-bg-hover` |
| 状态色（工作中/暂停） | `--dsw-alias-state-success-primary`、`--dsw-alias-state-warn-primary`、`--dsw-alias-state-warn-tertiary`、`--dsw-alias-state-error-primary`、`--dsw-alias-state-business-primary` |
| 字体 | `--dsw-font-mono`（code）、`--ds-font-family-code` |
| 圆角/阴影 | `--dsw-radius-sm/md/lg/xl`、`--dsw-elevation-stroke-color`、`--dsw-elevation-panel` |

### 6.2 可照抄的页面容器 CSS（plugin-manager 的 `.page`，`dsh-client-ui-plugin-manager/lib/client.js:1913`）

```css
.page{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);
      flex-direction:column;align-items:center;gap:32px;
      padding:0 clamp(24px,4vw,48px) 48px;display:flex;overflow:auto}
.page>*{width:100%;max-width:960px}
.pageHead{flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:16px;
          padding-top:28px;display:flex}
.pageTitle{margin:0;font-size:20px;font-weight:500;line-height:28px}
.pageIntro{color:var(--dsw-alias-label-secondary);margin:4px 0 0;font-size:13px;line-height:20px}
```

（Darwin 上另有 `[data-platform=darwin] .pageHead{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}`，建议一并抄。）
卡片/行模式：`border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-lg)`；状态徽章用 `color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)` 做底。

---

## 7. `package.json` 的 `dsh.client` / `exports` / `cordis.patch.yml`

### 7.1 精确格式

UI 模板（`templates/decoration/package.json:6-20`）：

```json
{
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

真实官方包（`dsh-client-ui-plugin-manager/package.json:16-47`）：

```json
"exports": {
  ".":          { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
  "./client":   { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
  "./locale/*.json": "./locale/*.json",
  ...
},
"dsh": {
  "client": {
    "inject": ["@deepseek-ai/dsh-api-remotes","@deepseek-ai/dsh-client-locale",
               "@deepseek-ai/dsh-client-ui-layout","@deepseek-ai/dsh-client-ui-sidebar"],
    "platform": "web"
  }
}
```

字段含义与校验：

| 字段 | 必填 | 含义 / 证据 |
|---|---|---|
| `exports["./client"]` | **是** | 缺了 Host 直接抛错：`client-modules: <pkg> declares dsh.client but exports no "./client" bundle`（`dsh-client-modules/lib/index.js:738`） |
| `dsh.client.platform` | 是 | 必须是 `"web"`，否则该包不被当作浏览器插件（`lib/index.js:69` 附近 parse + `platform !== "web"` 返回 null） |
| `dsh.client.immediately` | 可选 bool | `lib/index.js:69` 校验必须是 boolean；模板置 `true`，plugin-manager 省略也能工作。**确切语义未在解包文档中找到 → 未验证**；建议照模板写 `true` |
| `dsh.client.inject` | 可选 string[] | 只做**激活顺序**，不建立 JS import 关系（`ui-plugin.md:9`、`dsh-client-modules/README.md:34`）。我们写 layout + sidebar（+ locale）即可 |
| `dsh.client.external` | 可选 string[] | 非基线模块请求；每项必须被动态包行或静态表键应答，否则 composition 拒绝（`dsh-client-modules/README.md:50`）。我们**留空** |
| `dsh.bundle.patch` | 是（bundle） | 指向 `cordis.patch.yml` |

### 7.2 `cordis.patch.yml`

模板（`templates/decoration/cordis.patch.yml:1-3`）：

```yaml
- insert:
    - id: my-decoration
      name: '@local/my-decoration'
```

**只需插入包自身这一行**（Host 行）。浏览器半区不是独立 Loader 行——它由 `dsh-client-modules` 按 "Loader 行的裸包名" 自动挂到这个 Host 行上（`dsh-client-ui-plugin-manager/README.md:133`、`dsh-client-modules/README.md:34`）。所以**不要**为 client 另插一行。

`index.js`（Host 半区）模板 `templates/decoration/index.js:1-2`：`export function apply() {}`。我们的 Host 半区由 host-api 调研决定内容（systemPrompt section + pre-step + 命令注册 + 节假日缓存）。

---

## 8. 生命周期 / 清理 / 验证清单

- 所有注册包 `ctx.effect`：`ctx.effect(() => ctx.locale.register(...), "work-window: dictionaries")`、`ctx.effect(() => ctx.slots.subscribe(...), "...")`；`apply` 内不要留裸定时器（`ui-plugin.md:13`、`practices.md:36`）。
- React 组件的 `setInterval`/`setTimeout` 放 `useEffect` 返回清理；组件卸载（切到别的面板）时停止 ticking。
- 侧栏/面板注册用 `ctx.slots.inject(ownerKey, cb)`，不要裸 `register`。
- 插件卸载/关闭行后：slot 条目、字典、样式、定时器都必须消失（`dsh-client-ui-plugin-manager/README.md:133` 说明 client 半区随行卸载）。
- 验证（本会话无浏览器控制）：`node --check client.js`、JSON 语法、manifest 字段核对；视觉/明暗主题/console 无 `slot entry crashed` 需在真实页面确认，**不得用 mock 截图代替**（`verification.md:3-5`）。

---

## 9. 可运行最小骨架：`prototype/client.js`

已写入 `<workspace>\prototype\client.js`，内容要点（详细见文件内注释）：

1. `window.__ModuleLoader__.load({ id: '@local/dsh-work-window', factory(require) {...} })`（id 必须与最终包名一致，安装前改）。
2. 只 `require('react')`；用 `React.createElement`，不引入任何 Harness 客户端包。
3. `apply(ctx)`：
   - `ctx.effect(() => ctx.locale.register('workWindow', { zh, en }))`
   - `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name, id:'work-window', order:20, locale:'workWindow', label: () => t('panel') }, WorkWindowIcon))`
   - `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'work-window', locale:'workWindow' }, WorkWindowPage))`
4. `inject: ['slots', 'locale']`（可选再 `'remote'` 用于 §5.2 的放行按钮；骨架默认**降级为纯前端**，`remote` 只在按钮代码块里按需打开）。
5. 面板内容：状态徽章（可工作/暂停中）、本地时间+时区、下一个可工作时刻+倒计时、暂停区间表、节假日/离线标记、`/work-window release` 命令提示。
6. 状态计算 `computeWindowState(now, cfg)`：与 `shared/holiday.mjs` 同一判定顺序的**内联副本**（浏览器 bundle 不能跨包 import）；host-api 的纯函数定稿后同步这一份。
7. 样式一次性注入（`data-plugin-css` 去重），只用 `--dsw-alias-*`；容器 CSS 照抄 §6.2。
8. 定时器只在组件 `useEffect` 里，卸载即清理。

---

## 10. 骨架验证记录（node 内用 vm + React stub 跑通，非视觉验证）

`node --check prototype/client.js` → OK。再用 `node:vm` 注入 `globalThis.__ModuleLoader__` 与 `require('react')` 桩，实测：

| 检查 | 结果 |
|---|---|
| `loader.load` 的 `id` | `@local/dsh-work-window`（= 包名，安装前改名即可） |
| 模块导出 | `inject: ["slots","locale"]`；返回对象含 `apply` |
| locale 注册 | `ctx.locale.register('workWindow', { zh, en })`，zh/en 各 27 个 key，包在 `ctx.effect` 内 |
| 侧栏注册项 | `{"name":"sidebar.panellist","id":"work-window","order":20,"locale":"workWindow"}`，组件 `WorkWindowIcon` |
| 主面板注册项 | `{"name":"main","key":"work-window","locale":"workWindow"}`，组件 `WorkWindowPage` |
| 工作日 10:30（Asia/Hong_Kong） | 徽章 `ww_badge-paused` + `state.paused`；`row.nextWork = 12:00`；倒计时非空 |
| 工作日 18:21 | 徽章 working；`row.nextPause = 09:00`（次日）；`row.now = 18:21 · Asia/Hong_Kong` |

视觉（明暗主题 / 窄宽度 / 图标 16px vs 18px / 折叠态）**仍未验证**，需要在真实 GUI 里装好后确认（`references/verification.md:3-5`）。

---

## 11. 未验证 / 待 host-api 或实测确认

| # | 项 | 说明 |
|---|---|---|
| 1 | `dsh.client.immediately` 语义 | 只知必须是 boolean（`dsh-client-modules/lib/index.js:69`），用途无文档。建议照模板写 `true` |
| 2 | slot 组件除 `t` 外的框架 prop 全集 | `renderSlot`/`usePanelInfo`/`useStore` 等来自实测代码推断（`PluginManagerPage`、`SidebarRoot` 解构），没有类型定义可引 |
| 3 | Host 侧命令注册细节 | `ctx.commands.register` 的服务名/`inject` 名/`Config` 交互需 host-api 用 `dsh-commands` 源码确认；本文件只依据其 README 示例 |
| 4 | `ctx.remote.session.list` 在无 activated session controller 时是否可用 | 客户端已 mount 该命名空间（`dsh-api-remotes`），但运行期是否总返回 `ok` 需实测 |
| 5 | settings 命名空间作为配置读写通道 | §5.3，未验证 |
| 6 | 手写 Typert remote | §5.1，判定"不建议/不可行"，未实测 |
| 7 | 面板视觉（明暗主题、窄宽度） | 需在真实 GUI 验证 |
