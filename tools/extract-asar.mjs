import fs from 'node:fs';
import path from 'node:path';

const asarPath = process.argv[2];
const cmd = process.argv[3] || 'list';
const arg = process.argv[4];

const fd = fs.openSync(asarPath, 'r');
const pre = Buffer.alloc(16);
fs.readSync(fd, pre, 0, 16, 0);
const jsonLen = pre.readUInt32LE(12);
const headerBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, headerBuf, 0, jsonLen, 16);
const header = JSON.parse(headerBuf.toString('utf8'));
const base = 16 + jsonLen + ((4 - (jsonLen % 4)) % 4);

function walk(node, prefix, cb) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (entry.files) walk(entry, p, cb);
    else cb(p, entry);
  }
}

if (cmd === 'list') {
  const filter = arg || '';
  const rows = [];
  walk(header, '', (p, e) => {
    if (!filter || p.includes(filter)) rows.push([p, e.size, e.unpacked ? 'U' : '']);
  });
  console.log('TOTAL ' + rows.length);
  for (const r of rows.slice(0, 4000)) console.log(r[0] + '\t' + r[1] + '\t' + r[2]);
} else if (cmd === 'stat') {
  const top = {};
  walk(header, '', (p, e) => {
    const t = p.split('/')[0];
    top[t] = (top[t] || 0) + (e.size || 0);
  });
  for (const [k, v] of Object.entries(top).sort((a, b) => b[1] - a[1])) console.log(k, v);
} else if (cmd === 'read') {
  const e = lookup(header, arg);
  if (!e) { console.error('NOT FOUND ' + arg); process.exit(2); }
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd, buf, 0, e.size, base + Number(e.offset));
  process.stdout.write(buf);
} else if (cmd === 'extract') {
  const filter = (arg || '').replace(/\/$/, '');
  const outRoot = process.env.ASAR_OUT;
  let count = 0;
  walk(header, '', (p, e) => {
    if (filter && !(p === filter || p.startsWith(filter + '/'))) return;
    if (e.unpacked) return;
    const dest = path.join(outRoot, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = Buffer.alloc(e.size);
    if (e.size > 0) fs.readSync(fd, buf, 0, e.size, base + Number(e.offset));
    fs.writeFileSync(dest, buf);
    count++;
  });
  console.log('EXTRACTED ' + count + ' to ' + outRoot);
}

function lookup(node, p) {
  const parts = p.split('/').filter(Boolean);
  let cur = node;
  for (let i = 0; i < parts.length; i++) {
    const entry = (cur.files || {})[parts[i]];
    if (!entry) return null;
    if (i === parts.length - 1) return entry.files ? null : entry;
    cur = entry;
  }
  return null;
}
fs.closeSync(fd);
