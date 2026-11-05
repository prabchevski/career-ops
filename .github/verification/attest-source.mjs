// Disposable verification branch only. No deployment, credentials or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [phase, selected, descriptors, output] = process.argv.slice(2);
assert.ok(['before', 'after'].includes(phase));
const axis = JSON.parse(fs.readFileSync(descriptors, 'utf8'))[selected];
assert.ok(axis);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for (const value of [axis.head, axis.base, axis.parent]) assert.match(value, /^[a-f0-9]{40}$/);
assert.equal(git('rev-parse', 'HEAD'), axis.head);
git('merge-base', '--is-ancestor', axis.base, axis.head);
assert.equal(git('rev-parse', `${axis.head}^`), axis.parent);
git('diff', '--quiet'); git('diff', '--cached', '--quiet');
const changed = git('diff', '--name-only', axis.base, axis.head).split('\n').filter(Boolean).sort();
assert.deepEqual(changed, Object.keys(axis.files).sort());
if (axis.scope === 'source-main-merge') {
  assert.equal(git('rev-parse', `${axis.head}^2`), axis.second_parent);
  assert.equal(axis.second_parent, axis.base);
  // This unreferenced tree is reproduced from the two published parents;
  // no merge commit/ref/index change is made by verification.
  const automatic = git('merge-tree', '--write-tree', '--name-only', axis.parent, axis.second_parent).split('\n')[0];
  assert.equal(automatic, axis.automaticMergeTree);
  assert.deepEqual(git('diff', '--name-only', automatic, axis.head).split('\n').filter(Boolean).sort(), [...axis.manualResolutionPaths].sort());
} else if (axis.scope === 'targeted-main-merge') {
  assert.equal(git('rev-parse', `${axis.head}^2`), axis.second_parent);
  assert.equal(axis.second_parent, axis.base);
  assert.deepEqual(Object.keys(axis.files).filter(p => !axis.unchangedFeatureFiles.includes(p)).sort(), [...axis.manualResolutionPaths].sort());
  for (const file of axis.unchangedFeatureFiles) assert.equal(git('rev-parse', `${axis.head}:${file}`), git('rev-parse', `${axis.parent}:${file}`), file);
  // Complete changed-path equality above also proves every outside-PR byte equals main.
} else {
  const incremental = git('diff', '--name-only', axis.parent, axis.head).split('\n').filter(Boolean).sort();
  assert.deepEqual(incremental, [...axis.incremental].sort());
}
if (axis.scope === 'helper-only-main-scope') {
  for (const file of axis.helperPathsEqualParent) assert.equal(git('rev-parse', `${axis.head}:${file}`), git('rev-parse', `${axis.parent}:${file}`), file);
  for (const tree of axis.requireTreesEqualBase) assert.equal(git('rev-parse', `${axis.head}:${tree}`), git('rev-parse', `${axis.base}:${tree}`), tree);
  for (const file of axis.requirePackagesEqualBase) assert.equal(git('rev-parse', `${axis.head}:${file}`), git('rev-parse', `${axis.base}:${file}`), file);
  // Complete four-path equality above proves all other main bytes are retained.
  assert.equal(fs.existsSync('web/node_modules'), false);
}
if (axis.scope === 'targeted-root-only') {
  assert.equal(git('rev-parse', `${axis.head}:web`), git('rev-parse', `${axis.parent}:web`));
  git('diff', '--exit-code', axis.parent, axis.head, '--', 'package.json', 'package-lock.json');
  assert.equal(fs.existsSync('web/node_modules'), false);
}
const native = await import(pathToFileURL(path.resolve('update-system.mjs')));
const { SYSTEM_PATHS } = await import(pathToFileURL(path.resolve('lib/update-manifest.mjs')));
const committed = native.manifestSystemPathsAt(axis.head, {
  has: file => { try { git('cat-file', '-e', `${axis.head}:${file}`); return true; } catch { return false; } },
  show: file => git('show', `${axis.head}:${file}`),
});
assert.deepEqual(committed.paths, SYSTEM_PATHS);
if (axis.registryMainPlus) {
  const main = native.manifestSystemPathsAt(axis.base, {
    has: file => { try { git('cat-file', '-e', `${axis.base}:${file}`); return true; } catch { return false; } },
    show: file => git('show', `${axis.base}:${file}`),
  });
  assert.equal(main.paths.includes(axis.registryMainPlus), false);
  assert.deepEqual([...main.paths, axis.registryMainPlus].sort(), [...SYSTEM_PATHS].sort());
}
const userPaths = native.effectiveUserPaths(process.cwd());
assert.ok(Array.isArray(userPaths) && userPaths.length > 0);
const actual = {};
for (const file of changed) {
  assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
  const st = fs.lstatSync(file); assert.ok(st.isFile() && !st.isSymbolicLink());
  assert.ok(file.startsWith('web/') || SYSTEM_PATHS.some(spec => spec.endsWith('/') ? file.startsWith(spec) : file === spec), `outside native inventory: ${file}`);
  assert.ok(native.isSafeManifestPath(file.replace(/[\[\]]/g, ''), userPaths), file);
  actual[file] = sha(file); assert.equal(actual[file], axis.files[file], file);
}
if (phase === 'before') {
  assert.equal(fs.existsSync('web/node_modules'), false);
  assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(output, JSON.stringify({ head: axis.head, base: axis.base, parent: axis.parent, scope: axis.scope, files: actual, noWebDependenciesAtInitialAttestation: true }) + '\n', { flag: 'wx', mode: 0o600 });
} else {
  const before = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(before.head, axis.head); assert.deepEqual(before.files, actual);
  assert.equal(before.noWebDependenciesAtInitialAttestation, true);
}
console.log(JSON.stringify({ phase, head: axis.head, nativeFiles: changed.length, scope: axis.scope, sourceUnchanged: true }));
