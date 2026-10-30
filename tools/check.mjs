/**
 * check.mjs — 一键跑完本仓库的构建与全部测试。
 *
 * 用法：node tools/check.mjs
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const buildSteps = [
  { name: '构建浏览器半区 client.js', args: ['plugins/work-window/tools/build-client.mjs'] },
];

const testSteps = [
  { name: '节假日参考实现测试（103 断言）', args: ['shared/holiday.test.mjs'] },
  { name: '时段判定一致性（浏览器 vs Host）', args: ['plugins/work-window/tools/parity.test.mjs'] },
  { name: 'Host 门禁单测', args: ['plugins/work-window/tools/host.test.mjs'] },
  { name: 'Client bundle VM 测试', args: ['plugins/work-window/tools/client.test.mjs'] },
];

const syntaxFiles = [
  'plugins/work-window/index.js',
  'plugins/work-window/client.js',
  'plugins/work-window/client.template.js',
  'plugins/work-window/shared/holiday.js',
  'plugins/work-window/shared/holiday-cache.js',
  'plugins/work-window/shared/status-client.mjs',
  'plugins/work-window/tools/build-client.mjs',
  'plugins/work-window/tools/host.test.mjs',
  'plugins/work-window/tools/parity.test.mjs',
  'plugins/work-window/tools/client.test.mjs',
  'plugins/work-window/tools/make-offline.mjs',
  'shared/holiday.mjs',
  'shared/holiday.test.mjs',
  'tools/check.mjs',
  'tools/extract-asar.mjs',
];

function runNode(args) {
  return spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', WindowsHide: true });
}

let failed = 0;
for (const step of buildSteps) {
  process.stdout.write(`\n== ${step.name} ==\n`);
  const result = runNode(step.args);
  if (result.status !== 0) {
    failed += 1;
    process.stdout.write(`FAIL: ${step.name}\n`);
  }
}

process.stdout.write('\n== 语法检查 ==\n');
for (const file of syntaxFiles) {
  const result = runNode(['--check', file]);
  if (result.status !== 0) {
    failed += 1;
    process.stdout.write(`FAIL: node --check ${file}\n`);
  } else {
    process.stdout.write(`ok  ${file}\n`);
  }
}

for (const step of testSteps) {
  process.stdout.write(`\n== ${step.name} ==\n`);
  const result = runNode(step.args);
  if (result.status !== 0) {
    failed += 1;
    process.stdout.write(`FAIL: ${step.name}\n`);
  }
}

if (failed > 0) {
  process.stdout.write(`\ncheck: ${failed} 项失败\n`);
  process.exit(1);
}
process.stdout.write('\ncheck: 全部通过 ✅\n');
