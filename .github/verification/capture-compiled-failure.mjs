// Retain only bounded generated CODE from this public CI checkout; never load it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const args = process.argv.slice(2);
assert.deepEqual(args.filter((_, i) => i % 2 === 0), ['--root', '--attestation', '--out']);
assert.equal(args.length, 6);
const root = fs.realpathSync(args[1]), next = path.join(root, 'web/.next'), out = path.resolve(args[5]);
assert.ok(out !== root && !out.startsWith(root + path.sep));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = (file, cap) => {
  const before = fs.lstatSync(file); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= cap);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd); assert.ok(st.isFile() && st.nlink === 1 && st.dev === before.dev && st.ino === before.ino && st.size === before.size);
    const bytes = Buffer.alloc(st.size); let used = 0;
    while (used < bytes.length) { const n = fs.readSync(fd, bytes, used, bytes.length - used, null); if (!n) break; used += n; }
    assert.equal(used, st.size); assert.equal(fs.readSync(fd, Buffer.alloc(1), 0, 1, null), 0);
    const after = fs.fstatSync(fd), leaf = fs.lstatSync(file);
    for (const k of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[k], st[k]);
    assert.ok(leaf.isFile() && !leaf.isSymbolicLink() && leaf.dev === st.dev && leaf.ino === st.ino);
    return bytes;
  } finally { fs.closeSync(fd); }
};
const attestation = JSON.parse(read(args[3], 128 * 1024));
assert.equal(attestation.head, '176d63d9eaef73b953ddb0c7dba3279d35aa9f89');
const verifySource = () => { for (const [name, hash] of Object.entries(attestation.files)) {
  assert.ok(!path.isAbsolute(name) && !name.split('/').includes('..'));
  assert.equal(sha(read(path.join(root, name), 2 * 1024 * 1024)), hash);
} };
verifySource();
const entryName = 'server/app/api/run/route.js', entry = read(path.join(next, entryName), 64 * 1024);
const require = createRequire(path.join(root, 'web/package.json'));
const { parse } = require('next/dist/compiled/babel/parser'), traverse = require('next/dist/compiled/babel/traverse').default;
const names = [];
traverse(parse(entry.toString(), { sourceType: 'script' }), { CallExpression(p) {
  const n = p.node;
  if (n.callee.type !== 'MemberExpression' || n.callee.computed || n.callee.property.name !== 'c') return;
  assert.equal(n.arguments.length, 1); assert.equal(n.arguments[0].type, 'StringLiteral');
  const name = n.arguments[0].value; assert.match(name, /^server\/chunks\/[^/]+\.js$/); assert.ok(!name.includes('..')); names.push(name);
} });
const runtime = 'server/chunks/[turbopack]_runtime.js'; if (fs.existsSync(path.join(next, runtime)) && !names.includes(runtime)) names.push(runtime);
assert.ok(names.length > 0 && names.length <= 20 && new Set(names).size === names.length);
const files = new Map([['BUILD_ID', read(path.join(next, 'BUILD_ID'), 256)], [entryName, entry]]);
let total = entry.length;
for (const name of names) { const bytes = read(path.join(next, name), 2 * 1024 * 1024); total += bytes.length; assert.ok(total <= 12 * 1024 * 1024); files.set(name, bytes); }
fs.mkdirSync(out, { mode: 0o700 });
for (const [name, bytes] of files) { const target = path.join(out, name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); }
verifySource();
fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify({ scope: 'generated public CODE ONLY, never executed; failed run retained', sourceHead: attestation.head, totalBytes: total, files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha(bytes)])), sourceUnchanged: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ capturedCodeFiles: files.size, totalBytes: total, sourceUnchanged: true }));
