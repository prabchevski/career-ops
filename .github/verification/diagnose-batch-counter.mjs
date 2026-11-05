// Verification-only fictional fixture diagnostic. Never imports application code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
assert.equal(args.length, 4); assert.equal(args[0], '--root'); assert.equal(args[2], '--out');
const root = fs.realpathSync(args[1]), out = path.resolve(args[3]);
const head = '176d63d9eaef73b953ddb0c7dba3279d35aa9f89';
const main = 'cd3793734fcd57693ddd97a20ccf0d3298b7d47e';
const CAP = 64 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const pins = {
  'batch/batch-runner.sh': '86dd41310081a20a74c0a06b16d476f06af4fa4532b0044de69c1dbb2aee2ddc',
  'tests/batch-runner-default-parallel.test.mjs': '0edc730f9a8adca6e0211c6b3332eb43e89269c35967e85532520f366ba44ad5',
  'tests/helpers/batch-runner-fixture.mjs': '03d325675fc4970710336b2f5540991a4f2936733b58280cb244456cd5539662',
  'tests/helpers.mjs': '657fc436edd2789a9e74f508a3fde269241d6a40f6d1a517986f28d6d2d69b4b',
  'tests/data-root-guard.mjs': '90bf205a0bedf37b18fa338289842e914645975414a622e2f05b09aacb0e1661',
  'tests/required-tools.mjs': '8286e6d6d84c3961267c659bb045bd414850a447dfc4a8395290e41712422005',
  'tests/helpers/describe-spawn.mjs': '25b2e0fd24a1114c2e5620fc715cee7b9119e25c3f24615248e84077b1cb9750',
  'lib/mjs-files.mjs': '9ddccffd531c67748d1b48db4657916ebc1c978e8b70b43f52403ed40bc2fb2d',
  'lib/local-today.mjs': '3cc281f77bcae811f8636dc8c67d6b741cfc94cd8216e1fe062a0ed3129377c8',
  'lib/walk-tree.mjs': '889bfe2674c6bea4be9ddb8d4ef233e08760ea63da4113d4253170d22ade2047',
  'lib/scratch-dirs.mjs': '0a513808631e7d0cc23df4ca66712764174f6a7d29662a159b6509724444b21e',
  'path-resolver.mjs': 'ea158b6ac90dd7b821dd47026037990e901b8b89eebade0f4398b27027e494af',
};
const originalFour = [...Object.keys(pins).slice(0, 3), 'reserve-report-num.mjs'];
const allPins = { ...pins, 'reserve-report-num.mjs': 'bbaeafb86baf3b1c96ff04b72dc50ff9935cb3b4e6b331e939e3d36e219f64c6' };
function verifySource() {
  assert.equal(git('rev-parse', 'HEAD'), head);
  git('diff', '--quiet'); git('diff', '--cached', '--quiet');
  for (const [file, expected] of Object.entries(allPins)) {
    const st = fs.lstatSync(path.join(root, file)); assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(sha(fs.readFileSync(path.join(root, file))), expected, file);
  }
  for (const file of originalFour) {
    assert.equal(sha(execFileSync('git', ['show', `${main}:${file}`], { cwd: root })), allPins[file], file);
  }
}
verifySource();
assert.ok(!fs.existsSync(out) && !out.startsWith(root + path.sep));
fs.mkdirSync(out, { recursive: false, mode: 0o700 });
const code = path.join(out, 'code'), records = path.join(out, 'records');
fs.mkdirSync(code, { mode: 0o700 }); fs.mkdirSync(records, { mode: 0o700 });
for (const file of Object.keys(pins)) {
  const dest = path.join(code, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(path.join(root, file)), { flag: 'wx', mode: 0o600 });
}
// Each stderr consumer has its own exclusive file, drains beyond its cap, and
// prints nothing. Its logging failures do not change the allocator's exit code.
const sink = `import fs from 'node:fs';import path from 'node:path';
let fd,kept=0,total=0;try{fd=fs.openSync(path.join(process.env.COUNTER_DIAG_RECORDS,'stderr-'+process.pid+'.log'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);}catch{}
try{for await(const chunk of process.stdin){total+=chunk.length;const part=chunk.subarray(0,Math.max(0,65536-kept));if(fd!==undefined&&part.length){try{kept+=fs.writeSync(fd,part);}catch{}}}}catch{}
try{if(fd!==undefined)fs.closeSync(fd);}catch{}
try{fs.writeFileSync(path.join(process.env.COUNTER_DIAG_RECORDS,'stderr-'+process.pid+'.json'),JSON.stringify({total,kept,truncated:total>kept}),{flag:'wx',mode:0o600});}catch{}
`;
const sinkPath = path.join(out, 'stderr-sink.mjs'); fs.writeFileSync(sinkPath, sink, { flag: 'wx', mode: 0o600 });
const changes = [];
function replaceOne(file, old, replacement) {
  const target = path.join(code, file), text = fs.readFileSync(target, 'utf8');
  assert.equal(text.split(old).length, 2, `single authorized diagnostic site: ${file}`);
  const after = text.replace(old, replacement);
  assert.equal(after.replace(replacement, old), text, 'adapter inverse must restore source');
  fs.writeFileSync(target, after); changes.push({ file, old, replacement });
}
replaceOne('batch/batch-runner.sh',
  'report_num=$(node "$PROJECT_DIR/reserve-report-num.mjs" 2>/dev/null | tr -d \'[:space:]\') || report_num=""',
  'report_num=$(node "$PROJECT_DIR/reserve-report-num.mjs" 2> >(node "$COUNTER_DIAG_SINK") | tr -d \'[:space:]\') || report_num=""');
replaceOne('tests/helpers/batch-runner-fixture.mjs',
  '"import { readFileSync, writeFileSync, existsSync } from \'node:fs\';",',
  '"import { readFileSync, writeFileSync, existsSync, appendFileSync } from \'node:fs\';",');
replaceOne('tests/helpers/batch-runner-fixture.mjs',
  '"  const n = (existsSync(\'counter.txt\') ? parseInt(readFileSync(\'counter.txt\', \'utf8\'), 10) : 0) + 1;",',
  '"  const priorCounter = existsSync(\'counter.txt\') ? readFileSync(\'counter.txt\', \'utf8\') : null;",\n      "  const n = (priorCounter === null ? 0 : parseInt(priorCounter, 10)) + 1;",');
replaceOne('tests/helpers/batch-runner-fixture.mjs',
  '"  writeFileSync(\'counter.txt\', String(n));",',
  '"  writeFileSync(\'counter.txt\', String(n));",\n      "  try { appendFileSync(process.env.COUNTER_DIAG_RECORDS + \'/mock-\' + process.pid + \'.json\', JSON.stringify({ pid: process.pid, priorCounter: priorCounter?.slice(0, 256) ?? null, computedNumber: String(n) }), { mode: 0o600 }); } catch {}",');
// All test assertions, internal worker counts, delays and retries are original.
assert.equal(sha(fs.readFileSync(path.join(code, 'tests/batch-runner-default-parallel.test.mjs'))), pins['tests/batch-runner-default-parallel.test.mjs']);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/batch-runner-default-parallel.test.mjs'], {
  cwd: code, env: { ...process.env, COUNTER_DIAG_RECORDS: records, COUNTER_DIAG_SINK: sinkPath },
  stdio: ['ignore', 'pipe', 'pipe'], timeout: 150_000, maxBuffer: 4 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? Buffer.alloc(0)); process.stderr.write(result.stderr ?? Buffer.alloc(0));
for (const [name, bytes] of [['test.stdout.log', result.stdout], ['test.stderr.log', result.stderr]]) {
  fs.writeFileSync(path.join(out, name), (bytes ?? Buffer.alloc(0)).subarray(0, CAP), { flag: 'wx', mode: 0o600 });
}
verifySource();
const files = fs.readdirSync(records); assert.ok(files.length <= 256);
const recordProof = {};
for (const name of files) {
  assert.match(name, /^(?:mock-\d+\.json|stderr-\d+\.(?:log|json))$/);
  const abs = path.join(records, name), st = fs.lstatSync(abs);
  assert.ok(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= CAP);
  recordProof[name] = { bytes: st.size, sha256: sha(fs.readFileSync(abs)) };
}
const proof = { head, main, originalFourEqualMain: true, copiedFiles: pins,
  adapterSites: changes, adapterLeavesTestAndOriginalExitUnchanged: true,
  fixtureStatus: result.status, fixtureSignal: result.signal, fixtureError: result.error?.code ?? null,
  fixtureFailed: result.status !== 0, causeNotInferredFromExit: true,
  noReproductionDoesNotDisproveRace: result.status === 0,
  mockCaptureCount: files.filter(name => name.startsWith('mock-')).length,
  stderrCaptureCount: files.filter(name => /^stderr-\d+\.log$/.test(name)).length,
  missingCaptureDoesNotProveAllocatorHealth: true,
  stdoutBytes: result.stdout?.length ?? 0, stderrBytes: result.stderr?.length ?? 0,
  recordProof, sinkSha256: sha(sink), sourceUnchanged: true, realModelsOrSourceHTTP: 0 };
const proofBytes = JSON.stringify(proof) + '\n'; assert.ok(Buffer.byteLength(proofBytes) <= CAP);
fs.writeFileSync(path.join(out, 'proof.json'), proofBytes, { flag: 'wx', mode: 0o600 });
process.exitCode = result.status ?? 1;
