// Verification-only fictional interop fixture; never invokes a model or real HTTP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2), options = {};
assert.equal(args.length % 2, 0);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--root', '--source', '--archive', '--scratch', '--proof'].includes(args[i]));
  assert.equal(options[args[i]], undefined, 'duplicate argument'); options[args[i]] = args[i + 1];
}
assert.ok(options['--scratch'] && options['--proof']);
const publicMode = Boolean(options['--source'] || options['--archive']);
assert.ok(publicMode ? options['--source'] && options['--archive'] && !options['--root'] : options['--root']);
assert.ok(process.execArgv.every(x => !x.includes('experimental')) && !/experimental/.test(process.env.NODE_OPTIONS ?? ''));
const realDirectory = value => { const p = fs.realpathSync(value); assert.ok(fs.lstatSync(p).isDirectory()); return p; };
const scratch = realDirectory(options['--scratch']); assert.deepEqual(fs.readdirSync(scratch), [], 'scratch must be empty');
const proofFile = path.resolve(options['--proof']); assert.equal(fs.existsSync(proofFile), false);
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (root, ...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const runtimeFiles = ['read-known-jd.mjs', 'browser-extract.mjs', 'lib/evaluation-archive.mjs', 'persist-evaluation-report.mjs'];
const snapshots = new Map();
function snapshot(root) {
  const files = {};
  for (const file of runtimeFiles) if (fs.existsSync(path.join(root, file))) {
    const st = fs.lstatSync(path.join(root, file)); assert.ok(st.isFile() && !st.isSymbolicLink());
    files[file] = sha(fs.readFileSync(path.join(root, file)));
  }
  const out = { root, head: git(root, 'rev-parse', 'HEAD'), files }; snapshots.set(root, out); return out;
}
const checkSnapshots = () => { for (const { root, files } of snapshots.values()) for (const [file, hash] of Object.entries(files)) assert.equal(sha(fs.readFileSync(path.join(root, file))), hash, file); };
const sourceRoot = realDirectory(publicMode ? options['--source'] : options['--root']);
const archiveRoot = realDirectory(publicMode ? options['--archive'] : options['--root']);
assert.ok(![sourceRoot, archiveRoot].some(root => scratch === root || scratch.startsWith(root + path.sep)));
assert.ok(![sourceRoot, archiveRoot].some(root => proofFile === root || proofFile.startsWith(root + path.sep)), 'proof must stay outside source checkouts');
snapshot(sourceRoot); if (archiveRoot !== sourceRoot) snapshot(archiveRoot);
const deniedPreload = path.join(scratch, 'deny-fetch.mjs');
fs.writeFileSync(deniedPreload, "globalThis.fetch=()=>{throw Error('real HTTP forbidden in interop proof')};\n", { mode: 0o600 });
const child = (root, script, argv, input, cwd, preload = deniedPreload) => {
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(root, script), ...argv], {
    cwd, input, encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024,
    env: { ...process.env, CAREER_OPS_ROOT: cwd, CAREER_OPS_DATA_DIR: cwd }, windowsHide: true,
  });
  assert.equal(result.error, undefined, String(result.error)); assert.equal(result.signal, null, result.stderr);
  return result;
};
const dataDir = label => { const p = path.join(scratch, label); fs.mkdirSync(p, { mode: 0o700 }); return p; };
const originalURL = 'https://www.arbeitnow.com/jobs/companies/fictional/fictional-product-manager-123456';
const applyURL = originalURL + '/apply';
const atsURL = 'https://jobs.ashbyhq.com/fictional/11111111-1111-4111-8111-111111111111/application?source=fictional';
const apiURL = 'https://api.ashbyhq.com/posting-api/job-board/fictional';
const jd = 'The product manager owns customer research, roadmap planning, engineering coordination, reliable delivery and documentation. Genuine copyright notices and archive retention duties remain part of this role. '.repeat(8) + '\n```sample\nInert external source text.\n```\n';
const prefix = `# Evaluation: Fictional -- Product Manager\n\n**URL:** ${originalURL}\n**Score:** 3.3/5\n\nAnalysis stays byte-exact.\n\n`;
const posted = 'Posted: 2026-01-01, retained report metadata.';
const payload = markdown => ({ num: '101', today: '2026-01-02', company: 'Fictional', role: 'Product Manager', score: '3.3/5', notes: '', via: null,
  url: originalURL, reportFile: '101-fictional-2026-01-02.md', markdown });
const fullInline = prefix + '## Job Description (archived verbatim)\n\n' + jd + '\n';
let standaloneSource = null, standaloneArchive = null;
if (publicMode) {
  assert.equal(fs.existsSync(path.join(sourceRoot, 'lib/evaluation-archive.mjs')), false, 'standalone SOURCE must retain the old native writer');
  const root = dataDir('source-legacy-data');
  const cap = child(sourceRoot, 'persist-evaluation-report.mjs', ['--capabilities'], '', root);
  assert.notEqual(cap.status, 0); assert.match(cap.stderr, /unrecognized argument: --capabilities/);
  const baseline = JSON.stringify(payload(fullInline)); assert.equal(Object.hasOwn(JSON.parse(baseline), 'archiveSource'), false);
  const saved = child(sourceRoot, 'persist-evaluation-report.mjs', [], baseline, root);
  assert.equal(saved.status, 0, saved.stderr); assert.deepEqual(JSON.parse(saved.stdout), { ok: true });
  assert.equal(fs.readFileSync(path.join(root, 'reports/101-fictional-2026-01-02.md'), 'utf8'), fullInline);
  standaloneSource = { legacyUnsupportedCapability: true, actualNativeWriterAcceptedNoPacket: true, baselinePayloadSha256: sha(baseline) };
  assert.equal(fs.existsSync(path.join(archiveRoot, 'read-known-jd.mjs')), false, 'standalone ARCHIVE must not vendor SOURCE');
  const archive = await import(pathToFileURL(path.join(archiveRoot, 'lib/evaluation-archive.mjs')));
  assert.deepEqual(archive.archiveSourceCapabilities(), { version: 1, archiveSourcePacketVersions: [] });
  const legacy = dataDir('archive-legacy-data'), invalid = dataDir('archive-invalid-data');
  const accepted = child(archiveRoot, 'persist-evaluation-report.mjs', [], baseline, legacy);
  assert.equal(accepted.status, 0, accepted.stderr);
  const rejected = child(archiveRoot, 'persist-evaluation-report.mjs', [], JSON.stringify({ ...payload(fullInline), archiveSource: { version: 2 } }), invalid);
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /adapter.*unavailable/); assert.deepEqual(fs.readdirSync(invalid), []);
  standaloneArchive = { missingAdapterCapabilityEmpty: true, actualNoPacketWriterAccepted: true, explicitPacketRejectedBeforeWrites: true };
}
let combinedRoot = sourceRoot;
if (publicMode) {
  combinedRoot = path.join(scratch, 'combined-code'); fs.mkdirSync(combinedRoot, { mode: 0o700 });
  git(sourceRoot, 'diff', '--exit-code', 'HEAD', '--'); git(archiveRoot, 'diff', '--exit-code', 'HEAD', '--');
  const { SYSTEM_PATHS } = await import(pathToFileURL(path.join(sourceRoot, 'lib/update-manifest.mjs')));
  const tracked = execFileSync('git', ['-C', sourceRoot, 'ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
  for (const record of tracked) {
    const match = /^(100644|100755|120000) [a-f0-9]{40} 0\t(.+)$/.exec(record); assert.ok(match, 'unsupported tracked mode');
    const [, mode, file] = match; assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
    if (!file.startsWith('web/') && !SYSTEM_PATHS.some(s => s.endsWith('/') ? file.startsWith(s) : s === file)) continue;
    const input = path.join(sourceRoot, file), output = path.join(combinedRoot, file); fs.mkdirSync(path.dirname(output), { recursive: true });
    if (mode === '120000') {
      const target = fs.readlinkSync(input), settled = path.resolve(path.dirname(output), target);
      assert.ok(!path.isAbsolute(target) && settled.startsWith(combinedRoot + path.sep)); fs.symlinkSync(target, output);
    } else { fs.copyFileSync(input, output); fs.chmodSync(output, mode === '100755' ? 0o755 : 0o644); }
  }
  assert.ok(fs.statSync(path.join(sourceRoot, 'node_modules')).isDirectory(), 'declared root dependencies must be installed');
  fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(combinedRoot, 'node_modules'), 'dir');
  for (const file of ['lib/evaluation-archive.mjs', 'persist-evaluation-report.mjs']) {
    fs.mkdirSync(path.dirname(path.join(combinedRoot, file)), { recursive: true });
    fs.copyFileSync(path.join(archiveRoot, file), path.join(combinedRoot, file));
    assert.equal(sha(fs.readFileSync(path.join(combinedRoot, file))), snapshots.get(archiveRoot).files[file]);
  }
}
let unexpectedFetchCalls = 0;
globalThis.fetch = () => { unexpectedFetchCalls++; throw Error('composition import or archive attempted real HTTP'); };
const require = createRequire(path.join(combinedRoot, 'package.json'));
const beforeFetch = globalThis.fetch, adapter = require(path.join(combinedRoot, 'read-known-jd.mjs'));
assert.equal(globalThis.fetch, beforeFetch); assert.equal(typeof adapter.validateArchiveSourcePacket, 'function'); assert.equal(typeof adapter.validateArchiveSourceBinding, 'function');
const imported = await import(pathToFileURL(path.join(combinedRoot, 'read-known-jd.mjs')));
assert.equal(imported.validateArchiveSourcePacket, adapter.validateArchiveSourcePacket); assert.equal(globalThis.fetch, beforeFetch);
const archive = await import(pathToFileURL(path.join(combinedRoot, 'lib/evaluation-archive.mjs')));
assert.deepEqual(archive.archiveSourceCapabilities(), { version: 1, archiveSourcePacketVersions: [2] });
const callsFile = path.join(scratch, 'fictional-fetch-calls.json'), bodiesFile = path.join(scratch, 'fictional-body-use.json');
const fakePreload = path.join(scratch, 'fake-public-responses.mjs');
const html = `<html><a href="${applyURL}">Apply</a></html>`;
const board = { jobs: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Fictional Product Manager', descriptionPlain: jd, isListed: true }] };
fs.writeFileSync(fakePreload, `import fs from 'node:fs';const calls=[],responses=[];globalThis.fetch=async(url,options)=>{const u=String(url);if((options?.method??'GET')!=='GET')throw Error('GET only');let status,body,headers={};if(u===${JSON.stringify(originalURL)}){status=200;body=${JSON.stringify(html)}}else if(u===${JSON.stringify(applyURL)}){status=302;body='redirect body';headers.location=${JSON.stringify(atsURL)}}else if(u===${JSON.stringify(apiURL)}){status=200;body=${JSON.stringify(JSON.stringify(board))};headers['content-type']='application/json'}else throw Error('unexpected endpoint; no network fallback');const r=new Response(body,{status,headers});Object.defineProperty(r,'url',{value:u});calls.push({url:u,method:options?.method??'GET',redirect:options?.redirect,status});responses.push(r);return r};process.on('exit',()=>{fs.writeFileSync(${JSON.stringify(callsFile)},JSON.stringify(calls));fs.writeFileSync(${JSON.stringify(bodiesFile)},JSON.stringify(responses.map(r=>r.bodyUsed)))});\n`, { mode: 0o600 });
const fixtureData = dataDir('combined-data');
const read = child(combinedRoot, 'read-known-jd.mjs', ['--request', '-'], JSON.stringify({ url: originalURL }), fixtureData, fakePreload);
assert.equal(read.status, 0, read.stderr); const packet = JSON.parse(read.stdout);
assert.deepEqual(JSON.parse(fs.readFileSync(callsFile)), [
  { url: originalURL, method: 'GET', redirect: 'manual', status: 200 },
  { url: applyURL, method: 'GET', redirect: 'manual', status: 302 },
  { url: apiURL, method: 'GET', redirect: 'error', status: 200 },
]);
assert.deepEqual(JSON.parse(fs.readFileSync(bodiesFile)), [true, true, true]);
const checked = adapter.validateArchiveSourcePacket(packet, originalURL); assert.equal(checked.ok, true, checked.error);
assert.equal(packet.sourcePostingURL, atsURL); assert.equal(checked.binding.transport.requests[1].location, atsURL);
assert.equal(checked.binding.transport.requests[2].finalURL, apiURL); assert.equal(checked.binding.sourceFacts.isListed, true);
assert.equal(Object.hasOwn(packet, 'open'), false);
const pending = { ...payload(prefix + '## Job Description (archived verbatim)\n\n' + posted + '\n\nFull reproduction is omitted.\n'), archiveSource: packet };
const writer = await import(pathToFileURL(path.join(combinedRoot, 'persist-evaluation-report.mjs')));
let captures = 0; const saved = await writer.persistEvaluationArtifacts(fixtureData, pending, { captureFn: async () => { captures++; throw Error('no post-model capture'); } });
assert.equal(saved.ok, true, saved.error); assert.equal(captures, 0);
const reportPath = path.join(fixtureData, 'reports', pending.reportFile), report = fs.readFileSync(reportPath, 'utf8');
assert.ok(report.startsWith(prefix)); assert.ok(report.includes('## Job Description (archived verbatim)\n\n' + posted + '\n\n'));
assert.equal(report.split(checked.text).length - 1, 1); assert.equal(fs.existsSync(path.join(fixtureData, 'jds')), false);
const provenance = /(`{3,})json\n([\s\S]*?)\n\1(?:\n|$)/.exec(report); assert.ok(provenance);
assert.deepEqual(JSON.parse(provenance[2]).sourceBinding, checked.binding);
assert.equal(archive.validateEvaluationArchive(fixtureData, { ...pending, markdown: report }).ok, true);
const legacy = { ...pending, markdown: report }; delete legacy.archiveSource;
assert.deepEqual(archive.validateEvaluationArchive(fixtureData, legacy), { ok: true, kind: 'embedded' });
const invalidRoot = dataDir('combined-invalid-data'), invalidPacket = structuredClone(packet); invalidPacket.chain.redirectLocation = 'https://jobs.ashbyhq.com/other/22222222-2222-4222-8222-222222222222';
const rejected = await writer.persistEvaluationArtifacts(invalidRoot, { ...pending, markdown: report, archiveSource: invalidPacket }, { captureFn: async () => { captures++; throw Error('no fallback'); } });
assert.equal(rejected.ok, false); assert.deepEqual(fs.readdirSync(invalidRoot), []);
const closed = structuredClone(packet); closed.result.sourceFacts = { type: 'ashby-listing', isListedState: 'boolean', isListed: false };
assert.equal(adapter.validateArchiveSourcePacket(closed, originalURL).ok, false);
assert.equal(unexpectedFetchCalls, 0); assert.equal(captures, 0); checkSnapshots();
const proof = { createdAt: new Date().toISOString(), node: process.version, mode: publicMode ? 'public-standalone-and-runtime-composition' : 'exact-combined-runtime', inputs: [...snapshots.values()],
  standaloneSource, standaloneArchive, combinedRuntime: { fixedRequireImportSameValidators: true, noExperimentalFlags: true, actualNativeReaderCli: true, fakeObservedGets: 3, allResponseBodiesConsumed: true,
    actualSharedValidator: true, actualNativeWriter: true, nativeSourceUtf8Bytes: Buffer.byteLength(checked.text), nativeSourceSha256: sha(checked.text), fullInlineOccurrences: 1, literalPostedPreserved: true,
    analysisPrefixPreserved: true, completeTypedBindingRetained: true, originalPublisherUrlPreserved: true, actualApiSettledUrlDistinct: true, noJds: true, noPacketLegacyParserAccepted: true,
    invalidChainRejectedBeforeWrites: true, structuredFalseRejected: true, postModelCaptures: captures, unexpectedFetchCalls, reportSha256: sha(report) },
  sourceFilesUnchanged: true, realHttpRequests: 0, models: 0, scope: 'fictional native interop only; no employer/open/eligibility inference, no POST, webbuild or deploy; old96 receiver proof is private and separate' };
fs.writeFileSync(proofFile, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ proof: proofFile, sha256: sha(fs.readFileSync(proofFile)), node: process.version, mode: proof.mode, combinedRuntime: proof.combinedRuntime }));
