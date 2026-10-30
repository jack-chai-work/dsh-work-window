/**
 * build-client.mjs — 把浏览器半区模板 + 共享纯函数 + 离线节假日快照合成为 `client.js`。
 *
 * 浏览器 bundle 必须自包含（不能跨包 import、不能 import 工作区文件），所以这里做一次
 * 轻量构建：把 `shared/status-client.mjs` 的源码去掉 `export ` 前缀后内联进工厂函数，
 * 并把 `shared/offline-holidays.json` 作为常量注入。
 *
 * 输出是确定性的（不含时间戳）；改了模板/纯函数/离线数据后重新运行本脚本即可。
 *
 * 用法：node tools/build-client.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');

const templateFile = path.join(pluginRoot, 'client.template.js');
const statusFile = path.join(pluginRoot, 'shared', 'status-client.mjs');
const offlineFile = path.join(pluginRoot, 'shared', 'offline-holidays.json');
const outFile = path.join(pluginRoot, 'client.js');

function inlineStatusModule(source) {
  const lines = source.split(/\r?\n/u);
  const out = [];
  for (const line of lines) {
    // 只处理行首的 `export `（本模块没有 default export，也没有跨行导出）。
    if (/^export\s+(?:async\s+)?(?:function|const|let|class)\b/u.test(line)) {
      out.push(line.replace(/^export\s+/u, ''));
    } else {
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

const template = fs.readFileSync(templateFile, 'utf8');
const statusSource = inlineStatusModule(fs.readFileSync(statusFile, 'utf8'));
const offline = JSON.parse(fs.readFileSync(offlineFile, 'utf8'));

if (!template.includes('/*__STATUS_SOURCE__*/')) throw new Error('client.template.js 缺少 /*__STATUS_SOURCE__*/ 标记');
if (!template.includes('/*__OFFLINE_HOLIDAYS__*/ []')) throw new Error('client.template.js 缺少 /*__OFFLINE_HOLIDAYS__*/ [] 标记');

const built = template
  .replace('/*__STATUS_SOURCE__*/', () => statusSource)
  .replace('/*__OFFLINE_HOLIDAYS__*/ []', () => JSON.stringify(offline, null, 2));

const banner = [
  '/* ⚠️ 本文件为生成产物，不要手改：源文件是 client.template.js + shared/status-client.mjs +',
  ' * shared/offline-holidays.json；修改后运行 `node tools/build-client.mjs`。 */',
  '',
].join('\n');

fs.writeFileSync(outFile, `${banner}${built}`, 'utf8');
console.log(`built ${outFile} (${(built.length / 1024).toFixed(1)} KiB)`);
