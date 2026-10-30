/**
 * client.test.mjs — 在 Node 里加载生成的 `client.js`，验证浏览器半区能注册正确的
 * slot、locale 字典并渲染面板（不启动浏览器、不使用任何 Harness 客户端包）。
 *
 * 用最小 React stub + fake ctx：
 *   - 捕获 `window.__ModuleLoader__.load({id, factory})` 注册；
 *   - 用 stub require('react') 执行 factory，得到 {inject, apply}；
 *   - 用 fake ctx.slots 执行 apply，检查 sidebar.panellist / main / conversation.composer.dock
 *     三个注册项的 name/id/key/locale；
 *   - 渲染主面板与提醒条（固定到暂停时段），确认不抛错且输出包含关键文案。
 *
 * 用法：node tools/client.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'client.js');
const source = fs.readFileSync(clientPath, 'utf8');

const RealDate = globalThis.Date;

function makeReact() {
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children };
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useRef(value) {
      return { current: value };
    },
    useCallback(fn) {
      return fn;
    },
    useEffect() {
      /* 不执行副作用：区间判定在首次渲染时同步完成 */
    },
    useMemo(fn) {
      return fn();
    },
  };
  return React;
}

function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (predicate(node)) found.push(node);
  if (node.children !== undefined) findAll(node.children, predicate, found);
  return found;
}

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

/* ---------------------------------------------------------------- *
 * 1. 捕获模块注册并执行 factory
 * ---------------------------------------------------------------- */
let registration = null;
globalThis.__ModuleLoader__ = {
  load(reg) {
    registration = reg;
  },
};
globalThis.window = { __ModuleLoader__: globalThis.__ModuleLoader__ };

// client.js 是 IIFE，直接 eval 即可（它只使用 window.__ModuleLoader__）。
new Function(source)();

check('loader.id', registration?.id, '@local/dsh-work-window');

const moduleExports = registration.factory((specifier) => {
  if (specifier === 'react') return makeReact();
  throw new Error(`unexpected require: ${specifier}`);
});
check('module.inject', moduleExports.inject, ['slots', 'locale']);
check('module.apply.isFunction', typeof moduleExports.apply, 'function');

/* ---------------------------------------------------------------- *
 * 2. fake ctx + apply：检查注册项
 * ---------------------------------------------------------------- */
const dictionaries = [];
const registrations = [];
const fakeCtx = {
  effect(fn, label) {
    const dispose = fn();
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  },
  locale: {
    register(ns, dicts) {
      dictionaries.push({ ns, dicts });
      return () => {};
    },
    bind() {
      return (key) => key;
    },
  },
  slots: {
    inject(ownerKey, callback) {
      callback();
      return () => {};
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

moduleExports.apply(fakeCtx);

check('locale.ns', dictionaries[0]?.ns, 'workWindow');
check('locale.hasZh', typeof dictionaries[0]?.dicts?.zh?.['state.paused'], 'string');
check('locale.hasEn', typeof dictionaries[0]?.dicts?.en?.['state.paused'], 'string');
check('registrations.count', registrations.length, 3);

const byName = new Map(registrations.map((entry) => [entry.options.name, entry]));
check('slot.sidebar.name', byName.get('sidebar.panellist')?.options.name, 'sidebar.panellist');
check('slot.sidebar.id', byName.get('sidebar.panellist')?.options.id, 'work-window');
check('slot.sidebar.locale', byName.get('sidebar.panellist')?.options.locale, 'workWindow');
check('slot.main.key', byName.get('main')?.options.key, 'work-window');
check('slot.dock.id', byName.get('conversation.composer.dock')?.options.id, 'work-window-notice');

/* ---------------------------------------------------------------- *
 * 3. 固定到暂停时段，渲染主面板与提醒条
 * ---------------------------------------------------------------- */
const pausedAt = RealDate.parse('2026-10-30T10:30:00+08:00');
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(pausedAt);
    else super(...args);
  }
  static now() {
    return pausedAt;
  }
}
globalThis.Date = FakeDate;

const t = (key, values) => (values === undefined ? key : `${key}${JSON.stringify(values)}`);

const pageComponent = byName.get('main')?.component;
const page = pageComponent({ t });
check('page.type', page?.type, 'div');
check('page.className', page?.props?.className, 'ww_page');
const badge = findAll(page, (node) => node.props?.role === 'status');
check('page.badgeText', badge[0]?.children?.[0], 'state.paused');

const noticeComponent = byName.get('conversation.composer.dock')?.component;
const notice = noticeComponent({ t });
check('notice.kind', notice?.props?.className, 'ww_notice');
const noticeText = JSON.stringify(notice);
check('notice.mentionsPaused', noticeText.includes('composer.paused'), true);

// 可工作时段（18:30）时提醒条应返回 null。
class WorkingDate extends FakeDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.parse('2026-10-30T18:30:00+08:00'));
    else super(...args);
  }
  static now() {
    return RealDate.parse('2026-10-30T18:30:00+08:00');
  }
}
globalThis.Date = WorkingDate;
// 注意：组件内部 statusAt 用 new Date() 取当前时刻，但 FakeDate 的 now 只影响 Date.now()；
// 这里通过禁用提醒条的缓存不成立，改为直接调用内部判定由 statusAt 完成。
check('notice.workingReturnsNull', (() => {
  try {
    const result = noticeComponent({ t });
    return result === null ? 'null' : 'element';
  } catch (error) {
    return `throw:${error.message}`;
  }
})(), 'null');

globalThis.Date = RealDate;

if (failures.length > 0) {
  console.error(`client.test: ${failures.length} failed / ${passed + failures.length}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`client.test: ${passed} passed, 0 failed`);
