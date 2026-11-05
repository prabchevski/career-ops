// Verification-only: execute emitted helper bodies, never POST, a model, or a command.
// This file belongs to the disposable CI branch, not an application contribution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
assert.equal(args.length, 8, 'expected --root ROOT --attestation FILE --proof FILE --variant public|private');
assert.deepEqual(args.filter((_, i) => i % 2 === 0), ['--root', '--attestation', '--proof', '--variant']);
const variant = args[7]; assert.ok(['public', 'private'].includes(variant), 'explicit application variant required');
const root = fs.realpathSync(args[1]);
const attestationFile = path.resolve(args[3]), proofFile = path.resolve(args[5]);
const web = path.join(root, 'web'), next = path.join(web, '.next');
const require = createRequire(path.join(web, 'package.json'));
const { parse } = require('next/dist/compiled/babel/parser');
const traverse = require('next/dist/compiled/babel/traverse').default;
const read = (file, cap = 2 * 1024 * 1024) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    assert.ok(before.isFile() && before.size <= cap, `invalid verification input: ${file}`);
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    const after = fs.fstatSync(fd), leaf = fs.lstatSync(file);
    assert.equal(used, before.size, 'input grew or shrank');
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
    assert.ok(leaf.isFile() && !leaf.isSymbolicLink());
    assert.equal(leaf.dev, before.dev); assert.equal(leaf.ino, before.ino);
    return bytes.subarray(0, used);
  } finally { fs.closeSync(fd); }
};
const attestation = JSON.parse(read(attestationFile, 128 * 1024));
assert.match(attestation.head, /^[a-f0-9]{40}$/);
assert.ok(Object.keys(attestation.files).length >= 6);
const verifySource = () => {
  for (const [file, checksum] of Object.entries(attestation.files)) {
    assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
    assert.equal(sha(read(path.join(root, file))), checksum, file);
  }
};
verifySource();
const buildID = read(path.join(next, 'BUILD_ID'), 256).toString().trim();
assert.ok(buildID);
const entryPath = path.join(next, 'server/app/api/run/route.js');
const entry = read(entryPath, 64 * 1024).toString();
const entryAst = parse(entry, { sourceType: 'script' });
const chunkPaths = [];
traverse(entryAst, { CallExpression(p) {
  const n = p.node;
  if (n.callee.type !== 'MemberExpression' || n.callee.computed || n.callee.property.name !== 'c') return;
  assert.equal(n.arguments.length, 1);
  const name = n.arguments[0];
  assert.equal(name.type, 'StringLiteral');
  assert.match(name.value, /^server\/chunks\/[^/]+\.js$/);
  assert.ok(!name.value.includes('..'));
  chunkPaths.push(name.value);
} });
assert.ok(chunkPaths.length > 0 && chunkPaths.length <= 20);
assert.equal(new Set(chunkPaths).size, chunkPaths.length);
// The shipped runtime accepts a leading strict-factory group, then flat ID/factory pairs.
// Read only actual chunk registrations, never business exports nested in a factory.
function isChunkRegistration(p) {
  const statement = p.parentPath, parent = statement?.parentPath;
  if (!statement?.isExpressionStatement()) return false;
  if (parent?.isProgram()) return true;
  if (!parent?.isBlockStatement()) return false;
  const wrapper = parent.parentPath, call = wrapper?.parentPath;
  return Boolean((wrapper?.isArrowFunctionExpression() || wrapper?.isFunctionExpression())
    && !wrapper.node.async && !wrapper.node.generator && wrapper.node.params.length === 0
    && call?.isCallExpression() && call.node.callee === wrapper.node && call.node.arguments.length === 0
    && call.parentPath?.isExpressionStatement() && call.parentPath.parentPath?.isProgram());
}
function registerCompressedFactories(array, source, chunk, factories, depth = 0) {
  assert.equal(array.type, 'ArrayExpression', 'unsupported Turbopack registration');
  let start = 0;
  if (array.elements[0]?.type === 'ArrayExpression') {
    assert.equal(depth, 0, 'unsupported nested strict-factory group');
    registerCompressedFactories(array.elements[0], source, chunk, factories, depth + 1);
    start = 1;
  }
  let ids = [];
  for (const n of array.elements.slice(start)) {
    if (n?.type === 'NumericLiteral') { ids.push(n.value); continue; }
    assert.ok(ids.length && ['ArrowFunctionExpression', 'FunctionExpression'].includes(n?.type));
    for (const id of ids) {
      const text = source.slice(n.start, n.end), prior = factories.get(id);
      if (prior) assert.equal(prior.text, text, `ambiguous factory ${id}`);
      else factories.set(id, { id, node: n, text, chunk, astPath: null });
    }
    ids = [];
  }
  assert.equal(ids.length, 0);
}
function collectChunkFactories(ast, source, chunk, factories) {
  traverse(ast, { AssignmentExpression(p) {
    const { left, right } = p.node;
    if (left.type !== 'MemberExpression' || left.computed || left.object.name !== 'module' || left.property.name !== 'exports'
        || !isChunkRegistration(p)) return;
    registerCompressedFactories(right, source, chunk, factories);
  } });
}
const chunks = [], factories = new Map();
let totalBytes = 0;
for (const name of chunkPaths) {
  const bytes = read(path.join(next, name)); totalBytes += bytes.length;
  assert.ok(totalBytes <= 12 * 1024 * 1024, 'chunk inventory exceeds approved bound');
  const source = bytes.toString(), ast = parse(source, { sourceType: 'script' });
  const chunk = { name, source, ast, sha256: sha(bytes) }; chunks.push(chunk);
  collectChunkFactories(ast, source, chunk, factories);
}
const factoryByNode = new Map([...factories.values()].map(f => [f.node, f]));
const inside = (candidate, ancestor) => {
  for (let p = candidate; p; p = p.parentPath) if (p === ancestor) return true;
  return false;
};
const container = p => {
  for (let a = p; a; a = a.parentPath) if (factoryByNode.has(a.node)) return factoryByNode.get(a.node);
  return null;
};
const keys = n => n?.type === 'ObjectPattern' ? n.properties.map(p => p.key?.name ?? p.key?.value) : [];
const readers = [], prompts = [];
for (const c of chunks) traverse(c.ast, { Function(p) {
  const f = factoryByNode.get(p.node); if (f) f.astPath = p;
  const k = keys(p.node.params[0]);
  if (p.node.async && ['kind', 'input', 'root', 'signal', 'spawnFn', 'execPath', 'timeoutMs', 'killGraceMs'].every(x => k.includes(x))) readers.push(p);
  if (['kind', 'input', 'memory', 'today', 'postingEvidence'].every(x => k.includes(x))) prompts.push(p);
} });
assert.equal(readers.length, 1, 'missing/ambiguous emitted reader');
assert.equal(prompts.length, 1, 'missing/ambiguous emitted prompt');
const reader = readers[0], prompt = prompts[0], selected = container(reader);
assert.ok(selected && selected === container(prompt));
assert.equal(reader.node.type, 'FunctionDeclaration');
assert.equal(reader.parentPath.node, selected.node.body, 'reader is not module scoped');
assert.match(reader.node.id.name, /^[A-Za-z_$][\w$]*$/);

// Prove route dataflow independently of minified names. No route is executed.
let promptCall;
if (prompt.parentPath.isCallExpression() && prompt.parentPath.node.callee === prompt.node) promptCall = prompt.parentPath;
else if (prompt.isFunctionDeclaration()) {
  const binding = prompt.scope.parent.getBinding(prompt.node.id.name);
  const calls = binding.referencePaths.filter(p => p.parentPath.isCallExpression() && p.parentPath.node.callee === p.node);
  assert.equal(calls.length, 1); promptCall = calls[0].parentPath;
} else assert.fail('unsupported emitted prompt placement');
const property = (n, key) => n?.type === 'ObjectExpression' ? n.properties.find(p => p.type === 'ObjectProperty' && (p.key.name ?? p.key.value) === key)?.value : null;
const evidenceRef = property(promptCall.node.arguments[0], 'postingEvidence');
assert.equal(evidenceRef?.type, 'MemberExpression');
assert.equal(evidenceRef.computed, false); assert.equal(evidenceRef.property.name, 'evidence');
assert.equal(evidenceRef.object.type, 'Identifier');
const resultBinding = promptCall.scope.getBinding(evidenceRef.object.name);
assert.equal(resultBinding?.path.node.type, 'VariableDeclarator');
const awaited = resultBinding.path.node.init;
assert.equal(awaited?.type, 'AwaitExpression'); assert.equal(awaited.argument.type, 'CallExpression');
assert.equal(awaited.argument.callee.type, 'Identifier');
const readerBinding = resultBinding.path.scope.getBinding(awaited.argument.callee.name);
assert.equal(readerBinding?.path.node, reader.node, 'postingEvidence does not come from the emitted reader');
const input1 = property(awaited.argument.arguments[0], 'input'), input2 = property(promptCall.node.arguments[0], 'input');
assert.equal(input1?.type, 'Identifier'); assert.equal(input2?.type, 'Identifier');
assert.equal(resultBinding.path.scope.getBinding(input1.name), promptCall.scope.getBinding(input2.name));

const allowedGlobals = new Set(['undefined', 'Buffer', 'URL', 'JSON', 'String', 'Boolean', 'Number', 'Object', 'Array', 'Set', 'Map', 'RegExp', 'Error', 'Promise', 'Math', 'Date', 'process', 'performance', 'setTimeout', 'clearTimeout']);
const freeBindings = [];
for (const [label, fn] of [['reader', reader], ['prompt', prompt]]) fn.traverse({ ReferencedIdentifier(p) {
  const binding = p.scope.getBinding(p.node.name);
  if (binding && inside(binding.path, fn)) return;
  if (!binding) { assert.ok(allowedGlobals.has(p.node.name), `unapproved global ${label}:${p.node.name}`); return; }
  assert.ok(binding.scope === selected.astPath.scope, `POST/local capture: ${label}:${p.node.name}`);
  freeBindings.push(`${label}:${p.node.name}`);
} });
const importedId = (fn, key, member) => {
  const prop = fn.node.params[0].properties.find(p => p.key?.name === key);
  const value = prop?.value?.right;
  assert.equal(value?.type, 'MemberExpression'); assert.equal(value.computed, false);
  if (member) assert.equal(value.property.name, member);
  const binding = fn.scope.getBinding(value.object.name), init = binding?.path.node.init;
  assert.equal(init?.type, 'CallExpression'); assert.equal(init.callee.type, 'MemberExpression');
  assert.equal(init.callee.property.name, 'i'); assert.equal(init.arguments[0].type, 'NumericLiteral');
  return init.arguments[0].value;
};
const childID = importedId(reader, 'spawnFn', 'spawn');
const profileID = importedId(prompt, 'profile');
const externalKind = f => {
  if (!f || f.node.body.type !== 'BlockStatement' || f.node.body.body.length !== 1) return null;
  const exp = f.node.body.body[0].expression;
  if (exp?.type !== 'AssignmentExpression' || exp.left.type !== 'MemberExpression' || exp.left.property.name !== 'exports') return null;
  const call = exp.right;
  if (call.type !== 'CallExpression' || call.callee.type !== 'MemberExpression' || call.callee.property.name !== 'x') return null;
  const [name, thunk] = call.arguments;
  if (name?.type !== 'StringLiteral' || thunk?.type !== 'ArrowFunctionExpression' || thunk.body.type !== 'CallExpression' || thunk.body.callee.name !== 'require' || thunk.body.arguments[0]?.value !== name.value) return null;
  return name.value;
};
// Project requested immutable string DATA from direct exports; never execute another factory.
function literalNamespaceExport(factory, key, requested) {
  assert.ok(requested.has(key), 'literal export was not requested by a verified helper');
  assert.equal(factory?.node.body.type, 'BlockStatement');
  const contextName = factory.node.params[0]?.name, matches = [];
  assert.ok(contextName);
  for (const statement of factory.node.body.body) {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    if (call?.type !== 'CallExpression' || call.callee.type !== 'MemberExpression' || call.callee.computed
        || call.callee.object.name !== contextName || call.callee.property.name !== 's') continue;
    assert.equal(call.arguments.length, 1);
    const values = call.arguments[0]; assert.equal(values.type, 'ArrayExpression');
    assert.equal(values.elements.length % 3, 0);
    for (let i = 0; i < values.elements.length; i += 3) {
      assert.equal(values.elements[i]?.type, 'StringLiteral', 'dynamic export keys are unsupported');
      if (values.elements[i].value !== key) continue;
      assert.equal(values.elements[i + 1]?.type, 'NumericLiteral'); assert.equal(values.elements[i + 1].value, 0);
      assert.equal(values.elements[i + 2]?.type, 'StringLiteral', 'requested export is not literal string data');
      matches.push(values.elements[i + 2].value);
    }
  }
  assert.equal(matches.length, 1, 'missing or ambiguous literal string export');
  return matches[0];
}
function collectLiteralNamespaceData(functions, selected, factories, skipIds, externalKind) {
  const requests = new Map(), contextName = selected.node.params[0]?.name;
  for (const fn of functions) fn.traverse({ MemberExpression(p) {
    if (p.node.object.type !== 'Identifier') return;
    const binding = p.scope.getBinding(p.node.object.name), init = binding?.path.node.init;
    if (binding?.scope !== selected.astPath.scope || init?.type !== 'CallExpression'
        || init.callee.type !== 'MemberExpression' || init.callee.computed
        || init.callee.object.name !== contextName || init.callee.property.name !== 'i'
        || init.arguments.length !== 1 || init.arguments[0].type !== 'NumericLiteral') return;
    const id = init.arguments[0].value;
    if (skipIds.has(id) || externalKind(factories.get(id)) === 'node:path') return;
    assert.equal(p.node.computed, false, 'computed namespace access is not literal data');
    assert.equal(p.node.property.type, 'Identifier');
    if (!requests.has(id)) requests.set(id, new Set());
    requests.get(id).add(p.node.property.name);
  } });
  const byModule = new Map(), proof = [];
  for (const [id, keys] of requests) {
    const factory = factories.get(id), values = new Map(); assert.ok(factory);
    for (const key of keys) {
      const value = literalNamespaceExport(factory, key, keys); values.set(key, value);
      proof.push({ moduleID: id, exportKey: key, chunk: factory.chunk.name, chunkSha256: factory.chunk.sha256,
        factorySha256: sha(factory.text), literalSha256: sha(value), literalUtf8Bytes: Buffer.byteLength(value) });
    }
    byModule.set(id, values);
  }
  return { byModule, proof };
}
function immutableLiteralNamespace(entries, denied) {
  const values = new Map(entries), target = Object.create(null);
  for (const [key, value] of values) {
    assert.equal(typeof key, 'string'); assert.equal(typeof value, 'string');
    Object.defineProperty(target, key, { value, enumerable: true });
  }
  Object.freeze(target);
  return new Proxy(target, { get(_target, key) { return values.has(key) ? values.get(key) : denied(key); } });
}
assert.equal(externalKind(factories.get(childID)), 'node:child_process');
const literalData = collectLiteralNamespaceData([reader, prompt], selected, factories, new Set([childID, profileID]), externalKind);
const traps = { nativeCalls: 0, fetchCalls: 0, unexpectedImports: 0 };
const denied = name => (..._args) => { traps.nativeCalls++; throw Error(`native action forbidden: ${name}`); };
const unused = id => immutableLiteralNamespace(literalData.byModule.get(id) ?? [], key => { traps.unexpectedImports++; throw Error(`unapproved dependency access ${id}:${String(key)}`); });
const childNamespace = Object.freeze(Object.fromEntries(['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync'].map(k => [k, denied(k)])));
const globals = {
  Buffer, URL, performance, setTimeout, clearTimeout,
  process: Object.freeze({ execPath: '/fixture/node', env: Object.freeze({}) }),
  fetch: () => { traps.fetchCalls++; throw Error('fetch forbidden'); },
};
const context = vm.createContext(globals, { codeGeneration: { strings: false, wasm: false } });
const namespaces = new Map();
const load = id => {
  if (namespaces.has(id)) return namespaces.get(id);
  const f = factories.get(id), ext = externalKind(f);
  if (ext === 'node:path') return Object.freeze({ default: path, ...path });
  if (id === childID) return childNamespace;
  if (id !== profileID) return unused(id);
  assert.ok(f, 'profile factory missing');
  const exports = Object.create(null); namespaces.set(id, exports);
  const helper = Object.freeze({
    i(other) { assert.equal(externalKind(factories.get(other)), 'node:path'); return load(other); },
    s(values) { assert.equal(values.length % 3, 0); for (let i = 0; i < values.length; i += 3) { assert.equal(values[i + 1], 0); exports[values[i]] = values[i + 2]; } },
  });
  context.__factoryContext = helper;
  new vm.Script(`(${f.text})(__factoryContext)`, { filename: 'compiled-profile-factory.js' }).runInContext(context, { timeout: 1000 });
  return Object.freeze(exports);
};
let exposed;
context.__factoryContext = Object.freeze({ i: load, s() {} });
context.__auditExpose = value => { assert.equal(exposed, undefined); exposed = value; };
const promptText = selected.chunk.source.slice(prompt.node.start, prompt.node.end);
const instrumented = selected.text.slice(0, -1) + `;__auditExpose({reader:${reader.node.id.name},prompt:(${promptText})});}`;
new vm.Script(`(${instrumented})(__factoryContext)`, { filename: 'compiled-route-helper-instrumentation.js' }).runInContext(context, { timeout: 1000 });
assert.equal(typeof exposed?.reader, 'function'); assert.equal(typeof exposed?.prompt, 'function');
context.__auditInvocations = Object.freeze(exposed);
async function invokeReader(input) {
  context.__auditReaderInput = input;
  // This bounds the initial synchronous call, not every later async callback.
  const pending = new vm.Script('__auditInvocations.reader(__auditReaderInput)').runInContext(context, { timeout: 1000 });
  let deadline;
  try {
    return await Promise.race([pending, new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(Error('compiled reader await deadline')), 3000); })]);
  } finally { clearTimeout(deadline); delete context.__auditReaderInput; }
}
function invokePrompt(input) {
  context.__auditPromptInput = input;
  try { return new vm.Script('__auditInvocations.prompt(__auditPromptInput)').runInContext(context, { timeout: 1000 }); }
  finally { delete context.__auditPromptInput; }
}

const ORIGINAL = 'https://fictional.wd1.myworkdayjobs.com/External/job/Remote/Fictional-Manager_R123456';
const API = 'https://fictional.wd1.myworkdayjobs.com/wday/cxs/fictional/External/job/Remote/Fictional-Manager_R123456';
const TEXT = 'Location: Fictional location\nWork model: Remote\n\n' + 'Own discovery, delivery and product measurement with engineering and customers. '.repeat(10);
const packet = facts => ({ version: 2, originalURL: ORIGINAL, sourcePostingURL: ORIGINAL,
  chain: { kind: 'direct-known-ats', apiRequestIndex: 0 }, textCap: 20000,
  result: { url: ORIGINAL, ats: 'workday', title: 'Fictional Manager', text: TEXT, sourceFacts: facts },
  transport: { fetchCallCount: 1, requests: [{ requestURL: API, method: 'GET', requestedAt: '2026-01-01T00:00:00Z', accept: 'application/json', userAgent: 'fictional-client', httpStatus: 200, finalURL: API, redirected: false, respondedAt: '2026-01-01T00:00:01Z', location: null }] } });
const cases = [], commands = [];
async function exercise(label, inputPacket, input = ORIGINAL, expectedFacts = inputPacket.result.sourceFacts) {
  const calls = [];
  const spawnFn = (bin, argv, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.pid = 4321;
    child.stdout.setEncoding = () => {};
    child.kill = () => { throw Error('unexpected fake-child kill'); };
    child.stdin.end = text => { calls.push({ bin, argv, options, text }); queueMicrotask(() => { child.stdout.emit('data', JSON.stringify(inputPacket)); child.emit('close', 0); }); };
    return child;
  };
  const result = await invokeReader({ kind: 'evaluate', input, root: '/fixture/code', spawnFn, execPath: '/fixture/node' });
  assert.equal(calls.length, 1); const call = calls[0];
  assert.equal(call.bin, '/fixture/node'); assert.deepEqual(Array.from(call.argv), ['/fixture/code/read-known-jd.mjs', '--request', '-']);
  assert.equal(call.options.cwd, '/fixture/code'); assert.equal(call.options.shell, false); assert.deepEqual(JSON.parse(call.text), { url: input });
  if (input !== inputPacket.originalURL) { cases.push({ label, fixedArgvAndJsonStdin: true }); return; }
  const original = inputPacket.originalURL, sourcePostingURL = inputPacket.sourcePostingURL ?? original;
  assert.equal(result.outcome, 'available'); assert.equal(result.evidence.originalURL, original);
  if (inputPacket.version === 2) {
    assert.equal(result.evidence.sourcePostingURL, sourcePostingURL);
    assert.deepEqual(JSON.parse(JSON.stringify(result.archiveSource)), inputPacket, 'private source packet is retained outside prompt evidence');
    assert.equal(Object.hasOwn(result.evidence, 'archiveSource'), false);
  } else assert.equal(result.archiveSource, undefined, 'v1 compatibility does not invent a private v2 packet');
  assert.deepEqual(JSON.parse(JSON.stringify(result.evidence.jobData.sourceFacts ?? null)), expectedFacts ?? null);
  for (const forbidden of ['open', 'eligible', 'canApply']) assert.equal(Object.hasOwn(result.evidence, forbidden), false);
  const promptValue = invokePrompt({ kind: 'evaluate', input: original, memory: '', today: '2026-01-01', lang: { output: 'en', modesDir: 'modes', evalModeFile: 'modes/oferta.md' }, codeRoot: '/fixture/code', postingEvidence: result.evidence });
  const line = promptValue.split('\n').find(x => x.startsWith('{"originalURL":'));
  assert.ok(line); const forwarded = JSON.parse(line);
  assert.equal(forwarded.originalURL, original); assert.deepEqual(forwarded.jobData.sourceFacts ?? null, expectedFacts ?? null);
  assert.match(promptValue, /UNTRUSTED SOURCE DATA/); assert.match(promptValue, /HTTP 200 alone is not open status/);
  const binding = /const knownJdStdinCommand = \(([^]*?)\);\n\nThen call tools\.exec_command\((\{cmd: knownJdStdinCommand\(exactATSURL\)[^]*?\})\)\./.exec(promptValue);
  assert.ok(binding, 'actual emitted self-contained binding/call missing');
  const fresh = vm.createContext({ exactATSURL: sourcePostingURL }, { codeGeneration: { strings: false, wasm: false } });
  const command = new vm.Script(`const knownJdStdinCommand = (${binding[1]}); (${binding[2]})`).runInContext(fresh, { timeout: 1000 });
  if (variant === 'public') assert.equal(command.workdir, '/fixture/code');
  else assert.equal(Object.hasOwn(command, 'workdir'), false, 'private V9 literal call remains unchanged; no public workdir backport claimed');
  assert.equal(command.cmd, `printf %s '${JSON.stringify({ url: sourcePostingURL })}' | node read-known-jd.mjs --request -`);
  const hostile = "https://jobs.ashbyhq.com/fictional/o'neil;$(touch-owned);`echo-owned`";
  fresh.exactATSURL = hostile;
  const hostileCommand = new vm.Script(`(${binding[2]})`).runInContext(fresh, { timeout: 1000 });
  assert.equal(hostileCommand.cmd, "printf %s '" + JSON.stringify({ url: hostile }).replaceAll("'", "'\\''") + "' | node read-known-jd.mjs --request -");
  fresh.exactATSURL = 'https://www.linkedin.com/jobs/1';
  assert.throws(() => new vm.Script(`(${binding[2]})`).runInContext(fresh, { timeout: 1000 }), /LinkedIn/);
  commands.push({ bindingSha256: sha(binding[1]), literalCallSha256: sha(binding[2]), generatedCommandExecuted: false, variant, workdir: command.workdir ?? null, legacyPrivateCallWithoutWorkdir: variant === 'private' });
  cases.push({ label, packetVersion: inputPacket.version, outcome: result.outcome, promptPreservedFacts: true, privatePacketRetained: inputPacket.version === 2, originalURL: original, sourcePostingURL, fixedArgvAndJsonStdin: true });
}
for (const [state, value] of [['boolean', true], ['boolean', false], ['absent'], ['invalid']]) {
  const facts = { type: 'workday-cxs', canApplyState: state, jobPostingInfo: { title: 'Fictional Manager', jobReqId: 'R123456', externalPath: '/job/Remote/Renamed-Fictional-Manager_R123456', ...(state === 'boolean' ? { canApply: value } : {}) } };
  await exercise(`${state}:${String(value)}`, packet(facts));
}
await exercise('missing-path-not-synthesized', packet({ type: 'workday-cxs', canApplyState: 'absent', jobPostingInfo: { jobReqId: 'R123456' } }));
for (const [label, mutate] of [['unknown-facts', p => { p.result.sourceFacts.type = 'unrecognized'; }], ['wrong-vendor', p => { p.result.ats = 'ashby'; }], ['invalid-state-cannot-carry-true', p => { p.result.sourceFacts.canApplyState = 'invalid'; p.result.sourceFacts.jobPostingInfo.canApply = true; }]]) {
  const p = packet({ type: 'workday-cxs', canApplyState: 'absent', jobPostingInfo: {} }); mutate(p); await exercise(label, p, ORIGINAL, null);
}
const legacyPacket = packet({ type: 'workday-cxs', canApplyState: 'absent', jobPostingInfo: { jobReqId: 'R123456' } });
legacyPacket.version = 1; delete legacyPacket.sourcePostingURL; delete legacyPacket.chain;
legacyPacket.transport.requests.forEach(request => { delete request.location; });
await exercise('legacy-v1-compatibility-no-private-packet', legacyPacket);
const publisherURL = 'https://www.arbeitnow.com/jobs/companies/fictional/fictional-product-manager-123456';
const ashbyURL = 'https://jobs.ashbyhq.com/fictional/11111111-1111-4111-8111-111111111111/application?source=fictional';
const ashbyAPI = 'https://api.ashbyhq.com/posting-api/job-board/fictional';
const crossPacket = packet({ type: 'ashby-listing', isListedState: 'boolean', isListed: true });
crossPacket.originalURL = publisherURL; crossPacket.sourcePostingURL = crossPacket.result.url = ashbyURL; crossPacket.result.ats = 'ashby';
const transportBase = crossPacket.transport.requests[0];
crossPacket.transport = { fetchCallCount: 3, requests: [
  { ...transportBase, requestURL: publisherURL, finalURL: publisherURL, httpStatus: 200 },
  { ...transportBase, requestURL: publisherURL + '/apply', finalURL: publisherURL + '/apply', httpStatus: 302, location: ashbyURL },
  { ...transportBase, requestURL: ashbyAPI, finalURL: ashbyAPI, httpStatus: 200 },
] };
crossPacket.chain = { kind: 'arbeitnow-apply-redirect', publisherRequestIndex: 0, applyRequestIndex: 1, apiRequestIndex: 2,
  observedApplyHref: publisherURL + '/apply', redirectLocation: ashbyURL };
await exercise('v2-observed-publisher-and-ATS-identities-distinct', crossPacket, publisherURL);
await exercise('hostile-url-is-stdin-data', packet(null), 'https://jobs.ashbyhq.com/fictional/$(touch-owned);`echo-owned`', null);
const skipped = await invokeReader({ kind: 'evaluate', input: 'https://www.linkedin.com/jobs/1', root: '/fixture/code', spawnFn: denied('linkedIn-spawn') });
assert.equal(skipped.outcome, 'skipped');
assert.deepEqual(traps, { nativeCalls: 0, fetchCalls: 0, unexpectedImports: 0 });
verifySource();
for (const c of chunks) assert.equal(sha(read(path.join(next, c.name))), c.sha256);
assert.equal(read(path.join(next, 'BUILD_ID'), 256).toString().trim(), buildID);
const proof = { schema: 1, status: 'passed', variant, scope: 'actual-emitted-helper-and-adapter-functions; compiled POST is NOT invoked', sourceHead: attestation.head, sourceFiles: attestation.files, BUILD_ID: buildID,
  entry: { path: 'server/app/api/run/route.js', sha256: sha(entry) }, chunks: chunks.map(c => ({ path: c.name, sha256: c.sha256 })),
  selectedFactory: selected.id, originalFactorySha256: sha(selected.text), instrumentedFactorySha256: sha(instrumented), readerName: reader.node.id.name,
  promptExpressionSha256: sha(promptText), noPostLocalCaptures: true, routeEvidenceDataflowProvedStatically: true,
  freeBindings: [...new Set(freeBindings)].sort(), literalDependencyData: literalData.proof, cases, adapterChecks: commands, traps,
  executionBounds: { initialSyncCallVmTimeoutMs: 1000, readerAwaitDeadlineMs: 3000, everyAsyncCallbackVmTimed: false, requiredOuterOsHardDeadlineSeconds: 45, outerDeadlineAttestedByThisProof: false },
  generatedCommandsExecuted: false, modelCalls: 0, httpCalls: 0 };
assert.ok(!fs.existsSync(proofFile), 'proof output collision');
fs.writeFileSync(proofFile, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ status: proof.status, variant, sourceHead: proof.sourceHead, cases: cases.length, chunks: chunks.length, noPostLocalCaptures: true, nativeCalls: 0, httpCalls: 0, modelCalls: 0, proofSha256: sha(read(proofFile)) }));
