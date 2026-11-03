#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemTempRoot, verificationCliEnvironment } from './verification-paths.mjs';

export const CONTRACT_VERSION = 1;
export const TASK = '请为这个项目建立一套可重复执行的验收流程，覆盖用户入口、正常路径、失败反例、证据保存与清理边界。先读取已选择能力提供的目录和所需参考，再说明怎样证明功能真的完成；只输出方案，不执行项目或远端写入。';
export const EVIDENCE_COLUMNS = ['controlled', 'real_service', 'real_model', 'real_ui', 'installed_package'];
const brokerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const within = (base, target) => { const part = relative(resolve(base), resolve(target)); return part === '' || (!part.startsWith('..' + '/') && part !== '..' && !isAbsolute(part)); };
const disjoint = (a, b) => !within(a, b) && !within(b, a);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export function frozenPrompt(gate, selection) {
  check(gate === 'A' || gate === 'B', 'GATE', 'Gate must be A or B');
  check(/^\$[A-Za-z0-9][A-Za-z0-9_@.:-]*$/.test(selection ?? ''), 'ROOT_SELECTION', 'Pass exactly one native root selection');
  check(gate !== 'A' || !/poteto/i.test(selection), 'ROOT_SELECTION', 'Gate A cannot select the ordinary Skill');
  check(gate !== 'B' || !/pstack/i.test(selection), 'ROOT_SELECTION', 'Gate B cannot select the Router');
  const text = selection + ' ' + TASK;
  return { version: CONTRACT_VERSION, gate, selection, text, sha256: sha(text) };
}

// This validates an observer contract. A valid document is never by itself a
// live feature pass; the owning runner must retain its native action artifacts.
export function evaluateGraphTrace(trace, oracle) {
  check(trace?.version === CONTRACT_VERSION && oracle?.version === CONTRACT_VERSION, 'VERSION', 'Unknown trace or oracle version');
  check(trace.evidenceKind === 'real_model', 'PROOF_LAYER', 'Controlled evidence cannot claim the real-model gate');
  check(trace.host === 'pi' && trace.nativeEntry === true, 'NATIVE_ENTRY', 'A real Pi native entry receipt is required');
  const root = oracle.roots?.[trace.gate];
  check(root && root.kind === (trace.gate === 'A' ? 'router' : 'skill'), 'ROOT_KIND', 'The selected root kind must match the gate');
  const prompt = frozenPrompt(trace.gate, root.selection);
  check(trace.prompt?.text === prompt.text && trace.prompt?.sha256 === prompt.sha256, 'PROMPT_CHANGED', 'The root-only task must remain frozen');
  check(trace.selectedRoots?.length === 1 && trace.selectedRoots[0] === root.ref, 'ROOT_SELECTION', 'Only the intended root may be selected');
  const target = oracle.target;
  check(target && nonempty(target.ref) && nonempty(target.logicalId) && nonempty(target.scope) && nonempty(target.snapshot), 'ORACLE_INCOMPLETE', 'The private oracle needs stable target identity');
  for (const forbidden of [target.name, target.ref, target.logicalId, target.bodySha256, ...(target.answerTokens ?? [])].filter(nonempty)) {
    check(!trace.prompt.text.includes(forbidden), 'ORACLE_LEAK', 'Private target identity or answer leaked into the user prompt');
  }
  check(trace.gate !== 'A' || !/poteto-mode/i.test(trace.prompt.text), 'GATE_BRIDGE', 'Gate A cannot name or use the ordinary Skill as a bridge');
  check(trace.gate !== 'A' || !trace.reads?.some(row => row.ref === oracle.roots?.B?.ref), 'GATE_BRIDGE', 'Gate A read the ordinary Skill as a bridge');
  check(!trace.requiredRefs?.includes(target.ref), 'FORCED_LEAF', 'An optional member cannot be changed into a required leaf');
  check(trace.toolChoice === 'auto' && trace.forcedToolArguments === false, 'FORCED_LEAF', 'The model must choose its own native read');

  const isolation = trace.isolation;
  check(isolation?.oracleRoots?.length > 0 && isolation.consumerRoots?.length === 3, 'ISOLATION_MISSING', 'Record separate oracle and CLI/Broker/session roots');
  const roots = [...isolation.oracleRoots, ...isolation.consumerRoots];
  check(roots.every(isAbsolute), 'ISOLATION_MISSING', 'Isolation roots must be absolute resolved paths');
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    check(disjoint(roots[i], roots[j]), 'ORACLE_WARMING', 'Oracle and every consumer cache layer must be disjoint');
  }
  check(isolation.resolved === true && isolation.oracleObserverOnly === true, 'ORACLE_WARMING', 'Resolve paths and keep the oracle outside model inputs');
  check(isolation.inventoryComplete === true && Array.isArray(isolation.localSkillInventory), 'LOCAL_INVENTORY', 'Retain the actual local Skill/plugin inventory');
  check(!isolation.localSkillInventory.some(item => /(?:pstack|matt-skills)/i.test([item.path, item.packageId, item.suite, item.source].filter(nonempty).join(' ')) || [target.bodySha256, ...(oracle.resources ?? []).map(row => row.sha256)].includes(item.sha256)), 'LOCAL_COPY', 'A hidden or renamed local Pstack/Matt copy invalidates the gate');
  check(isolation.shellEnabled === false && isolation.contextFiles === false && isolation.promptTemplates === false && isolation.autoExtensions === false, 'LOCAL_FALLBACK', 'Disable unobserved shell, context and plugin fallbacks');
  check(['cold', 'warm'].includes(trace.cacheMode), 'CACHE_MODE', 'Record the actual cache mode');
  check(isolation.prelaunch?.length === 3 && isolation.prelaunch.every(row => isolation.consumerRoots.includes(row.root) && Number.isInteger(row.entries) && row.entries >= 0), 'CACHE_BASELINE', 'Each consumer root needs its prelaunch inventory');
  check(new Set(isolation.prelaunch.map(row => row.root)).size === 3, 'CACHE_BASELINE', 'Prelaunch evidence must cover all three distinct roots');
  if (trace.cacheMode === 'cold') check(isolation.prelaunch.every(row => row.entries === 0), 'ORACLE_WARMING', 'A cold run must start with three empty consumer layers');

  check(Array.isArray(trace.candidates) && trace.candidates.length > 0, 'CATALOG_MISSING', 'The actual root member directory must be observed');
  check(trace.candidates.some(row => row.ref === target.ref && row.logicalId === target.logicalId && row.scope === target.scope && row.available === true), 'CANDIDATE_IDENTITY', 'The target must be discovered with an exact readable identity');
  check(trace.memberBodyReadsBeforeSelection === 0, 'EAGER_MEMBERS', 'Unselected member bodies must remain unread');
  check(Array.isArray(trace.reads) && trace.reads.length > 0, 'READ_MISSING', 'Retain native tool calls and full read receipts');
  const expected = [{ ref: target.ref, logicalId: target.logicalId, scope: target.scope, snapshot: target.snapshot, sha256: target.bodySha256, bytes: target.bodyBytes }, ...(oracle.resources ?? [])];
  check(expected.length > 1, 'ORACLE_INCOMPLETE', 'The oracle must include a feature-map resource');
  for (const item of expected) {
    check(nonempty(item.ref) && nonempty(item.sha256) && Number.isInteger(item.bytes) && item.bytes > 0, 'ORACLE_INCOMPLETE', 'Every expected node needs exact bytes/hash');
    const read = trace.reads.find(row => row.ref === item.ref);
    check(read, 'READ_MISSING', 'The model must actually read every expected node');
    check(read.origin === 'model' && read.tool === 'read' && read.discovered === true && read.sequence > trace.directorySequence, 'NAME_GUESSING', 'Read targets must come from the observed directory or exact links');
    check(read.scope === item.scope && read.logicalId === item.logicalId && read.snapshot === item.snapshot, 'IDENTITY_MISMATCH', 'Scope, stable ID and snapshot must match the private oracle');
    check(read.complete === true && typeof read.content === 'string' && !read.error, 'INCOMPLETE_CONTENT', 'A complete successful body receipt is required');
    check(Buffer.byteLength(read.content) === item.bytes && sha(read.content) === item.sha256 && read.sha256 === item.sha256, 'CONTENT_MISMATCH', 'Observed bytes must match both the receipt and independent oracle');
  }
  check(!trace.reads.some(row => row.error), 'HIDDEN_FAILURE', 'Selected read failures cannot disappear from the trace');
  check(Array.isArray(trace.providerRequests) && trace.providerRequests.length >= 2, 'PROVIDER_MISSING', 'Retain provider inputs before and after model reads');
  const first = trace.providerRequests[0];
  check(!first.contents?.some(row => expected.some(item => item.ref === row.ref || sha(row.content ?? '') === item.sha256)), 'FORCED_LEAF', 'The target/resource cannot be preloaded into the first model request');
  for (const item of expected) {
    check(trace.providerRequests.some(request => request.contents?.some(row => row.ref === item.ref && sha(row.content ?? '') === item.sha256 && Buffer.byteLength(row.content ?? '') === item.bytes)), 'PROVIDER_CONTENT', 'Actual provider input must contain the verified read bytes');
    check(trace.providerRequests.every(request => (request.contents ?? []).filter(row => row.ref === item.ref).length <= 1), 'DUPLICATE_BODY', 'Do not inject the same body twice in one provider request');
  }
  check(trace.httpLedgerObserved === true && Array.isArray(trace.httpAttempts), 'HTTP_LEDGER', 'Retain the actual HTTP ledger even when a warm run makes zero requests');
  check(trace.httpAttempts.every(row => row.transport === 'direct_http'), 'LEGACY_TRANSPORT', 'Every attempt must use the direct request engine');
  check(trace.httpAttempts.every(row => (Number.isInteger(row.status) || (row.status === null && nonempty(row.networkError))) && typeof row.requestIdAvailable === 'boolean' && (row.requestIdAvailable ? nonempty(row.requestId) : row.requestId === null)), 'HTTP_METADATA', 'Preserve actual response/network metadata and never invent a missing request ID');
  check(!trace.httpAttempts.some(row => row.kind === 'write'), 'UNAUTHORIZED_WRITE', 'This read-only gate cannot mutate remote data');
  if (trace.cacheMode === 'cold') check(trace.httpAttempts.some(row => row.kind === 'body'), 'FALSE_COLD', 'An empty consumer must observe a real body request');
  check(['magpie/group/flash-free', 'magpie/group/worker'].includes(trace.model?.selector), 'MODEL_SELECTOR', 'Only the authorized model sequence is valid');
  if (trace.model.selector.endsWith('/worker')) check(trace.model.previousFailures?.some(row => row.selector === 'magpie/group/flash-free' && row.status === 'failed' && nonempty(row.evidenceSha256)), 'MODEL_FALLBACK', 'Worker requires retained failure evidence for flash-free');
  check(trace.model.responseStatus >= 200 && trace.model.responseStatus < 300, 'MODEL_HTTP', 'The provider must return a successful HTTP response');
  const final = trace.model.final;
  check(final?.success === true && ['stop', 'length'].includes(final.stopReason) && nonempty(final.text), 'MODEL_FINAL', 'HTTP success alone does not prove a successful model final');
  check(!/(?:insufficient (?:permission|quota)|not authorized|api key.*(?:invalid|denied)|please upgrade|无权限使用|额度不足|账户.*(?:无权|欠费))/i.test(final.text), 'MODEL_PERMISSION', 'HTTP 200 permission or quota messages do not prove model consumption');
  check(trace.processes?.length > 0 && trace.processes.every(row => row.owned === true && row.closed === true && row.spawnObserved === true && row.closeObserved === true), 'PROCESS_EVIDENCE', 'Owned host processes need observed spawn and close receipts');
  check(trace.unknownWrites?.length === 0 && trace.replayedUnknownWrites === false, 'UNKNOWN_WRITE', 'Preserve unknown write receipts and never replay them');
  return { status: 'contract-valid', version: CONTRACT_VERSION, gate: trace.gate, evidenceKind: trace.evidenceKind, observedNodes: expected.length, productAcceptance: 'not-inferred', proofBoundary: 'Validate this trace against the originating native runner artifacts before claiming a live gate pass.' };
}

export function contractFixture(gate = 'A') {
  const body = 'Verification workflow: launch, drive, observe, retain.';
  const resource = 'Feature map: positive, negative, recovery, ownership.';
  const scope = 'fixture-connection/library';
  const target = { name: 'create-verification-skill', logicalId: 'fixture-leaf', ref: 'skill://fixture-leaf/SKILL.md?snapshot=fixture-v1', scope, snapshot: 'fixture-v1', bodySha256: sha(body), bodyBytes: Buffer.byteLength(body), answerTokens: ['PRIVATE_ORACLE_42'] };
  const file = { logicalId: 'fixture-feature-map', ref: 'skill://fixture-leaf/references/feature-map.md?snapshot=fixture-v1', scope, snapshot: 'fixture-v1', sha256: sha(resource), bytes: Buffer.byteLength(resource) };
  const oracle = { version: CONTRACT_VERSION, roots: { A: { kind: 'router', selection: '$pstack@notion', ref: 'skill://fixture-router/SKILL.md' }, B: { kind: 'skill', selection: '$poteto-mode@notion', ref: 'skill://fixture-ordinary/SKILL.md' } }, target, resources: [file] };
  const consumerRoots = ['/private/tmp/ng-contract-cli', '/private/tmp/ng-contract-broker', '/private/tmp/ng-contract-session'];
  const reads = [{ ...target, sha256: target.bodySha256, content: body }, { ...file, content: resource }].map((row, i) => ({ ...row, tool: 'read', origin: 'model', discovered: true, sequence: i + 2, complete: true }));
  const trace = { version: CONTRACT_VERSION, evidenceKind: 'real_model', host: 'pi', nativeEntry: true, gate, prompt: frozenPrompt(gate, oracle.roots[gate].selection), selectedRoots: [oracle.roots[gate].ref], requiredRefs: [], toolChoice: 'auto', forcedToolArguments: false, cacheMode: 'cold', isolation: { oracleRoots: ['/private/tmp/ng-contract-oracle'], consumerRoots, resolved: true, oracleObserverOnly: true, inventoryComplete: true, localSkillInventory: [], shellEnabled: false, contextFiles: false, promptTemplates: false, autoExtensions: false, prelaunch: consumerRoots.map(root => ({ root, entries: 0 })) }, candidates: [{ ref: target.ref, logicalId: target.logicalId, scope, available: true }], memberBodyReadsBeforeSelection: 0, directorySequence: 1, reads, providerRequests: [{ contents: [] }, { contents: reads.map(row => ({ ref: row.ref, content: row.content })) }], httpLedgerObserved: true, httpAttempts: [{ transport: 'direct_http', kind: 'body', requestIdAvailable: true, requestId: 'controlled-http-fixture', status: 200 }], model: { selector: 'magpie/group/flash-free', responseStatus: 200, final: { text: '验收流程已按读取的步骤与功能地图整理。', success: true, stopReason: 'stop' } }, processes: [{ owned: true, closed: true, spawnObserved: true, closeObserved: true }], unknownWrites: [], replayedUnknownWrites: false };
  return { trace, oracle };
}

export const NEGATIVE_CASES = [
  ['oracle-warms-cli', 'ORACLE_WARMING', value => { value.trace.isolation.oracleRoots = [value.trace.isolation.consumerRoots[0]]; }],
  ['nested-oracle-root', 'ORACLE_WARMING', value => { value.trace.isolation.oracleRoots = [value.trace.isolation.consumerRoots[0] + '/oracle']; }],
  ['hidden-plugin-copy', 'LOCAL_COPY', value => { value.trace.isolation.localSkillInventory.push({ path: '/tmp/.agents/plugins/.cache/pstack/skills' }); }],
  ['hidden-matt-copy', 'LOCAL_COPY', value => { value.trace.isolation.localSkillInventory.push({ path: '/tmp/.codex/plugins/matt-skills-curated' }); }],
  ['renamed-plugin-copy', 'LOCAL_COPY', value => { value.trace.isolation.localSkillInventory.push({ path: '/tmp/renamed/skills', packageId: 'pstack-plugin' }); }],
  ['renamed-body-copy', 'LOCAL_COPY', value => { value.trace.isolation.localSkillInventory.push({ path: '/tmp/renamed/skills', sha256: value.oracle.target.bodySha256 }); }],
  ['name-guessed-read', 'NAME_GUESSING', value => { value.trace.reads[0].discovered = false; }],
  ['wrong-reference', 'READ_MISSING', value => { value.trace.reads[0].ref += '-wrong'; }],
  ['wrong-content-hash', 'CONTENT_MISMATCH', value => { value.trace.reads[0].content += ' changed'; }],
  ['wrong-scope', 'IDENTITY_MISMATCH', value => { value.trace.reads[0].scope = 'other-account'; }],
  ['wrong-snapshot', 'IDENTITY_MISMATCH', value => { value.trace.reads[0].snapshot = 'current'; }],
  ['forced-tool-arguments', 'FORCED_LEAF', value => { value.trace.forcedToolArguments = true; }],
  ['leaf-changed-to-required', 'FORCED_LEAF', value => { value.trace.requiredRefs.push(value.oracle.target.ref); }],
  ['http200-permission-message', 'MODEL_PERMISSION', value => { value.trace.model.final.text = 'Insufficient permissions. Please upgrade.'; }],
  ['http200-without-final', 'MODEL_FINAL', value => { value.trace.model.final = null; }],
  ['partial-body', 'INCOMPLETE_CONTENT', value => { value.trace.reads[0].complete = false; }],
  ['missing-resource', 'READ_MISSING', value => { value.trace.reads.pop(); }],
  ['oracle-in-provider', 'FORCED_LEAF', value => { value.trace.providerRequests[0].contents = value.trace.providerRequests[1].contents; }],
  ['oracle-under-wrong-provider-label', 'FORCED_LEAF', value => { value.trace.providerRequests[0].contents = [{ ref: 'root-label', content: value.trace.reads[0].content }]; }],
  ['missing-provider-bytes', 'PROVIDER_CONTENT', value => { value.trace.providerRequests[1].contents = []; }],
  ['duplicate-provider-body', 'DUPLICATE_BODY', value => { value.trace.providerRequests[1].contents.push(value.trace.providerRequests[1].contents[0]); }],
  ['false-cold-cache', 'ORACLE_WARMING', value => { value.trace.isolation.prelaunch[0].entries = 1; }],
  ['false-cold-network', 'FALSE_COLD', value => { value.trace.httpAttempts[0].kind = 'metadata'; }],
  ['official-cli-transport', 'LEGACY_TRANSPORT', value => { value.trace.httpAttempts[0].transport = 'subprocess'; }],
  ['missing-http-ledger', 'HTTP_LEDGER', value => { value.trace.httpLedgerObserved = false; }],
  ['invented-request-id', 'HTTP_METADATA', value => { value.trace.httpAttempts[0].requestIdAvailable = false; }],
  ['missing-process-close', 'PROCESS_EVIDENCE', value => { value.trace.processes[0].closeObserved = false; }],
  ['replayed-unknown-write', 'UNKNOWN_WRITE', value => { value.trace.replayedUnknownWrites = true; }],
  ['unapproved-model', 'MODEL_SELECTOR', value => { value.trace.model.selector = 'another/model'; }],
  ['fallback-without-failure', 'MODEL_FALLBACK', value => { value.trace.model.selector = 'magpie/group/worker'; }],
  ['controlled-as-real', 'PROOF_LAYER', value => { value.trace.evidenceKind = 'controlled'; }],
  ['empty-trace', 'CATALOG_MISSING', value => { value.trace.candidates = []; value.trace.reads = []; }],
  ['gate-a-via-ordinary-skill', 'GATE_BRIDGE', value => { value.trace.reads.push({ ref: value.oracle.roots.B.ref }); }],
  ['ordinary-root-becomes-router', 'ROOT_KIND', value => { value.trace.gate = 'B'; value.oracle.roots.B.kind = 'router'; }],
  ['prompt-leaks-target', 'PROMPT_CHANGED', value => { value.trace.prompt.text += ' create-verification-skill'; }],
];

export function selfTest() {
  const cases = [];
  for (const gate of ['A', 'B']) {
    const fixture = contractFixture(gate);
    assert.equal(evaluateGraphTrace(fixture.trace, fixture.oracle).status, 'contract-valid');
    cases.push({ id: 'valid-controlled-contract-' + gate, status: 'passed', evidenceKind: 'controlled', productAcceptance: 'not-inferred' });
  }
  for (const [id, expectedCode, mutate] of NEGATIVE_CASES) {
    const fixture = contractFixture(); mutate(fixture);
    let actualCode;
    try { evaluateGraphTrace(fixture.trace, fixture.oracle); } catch (error) { actualCode = error.code; }
    assert.equal(actualCode, expectedCode, id + ' must reject the intended false positive');
    cases.push({ id, status: 'passed', rejectedWith: actualCode, evidenceKind: 'controlled' });
  }
  assert.ok(cases.length > 0);
  return { version: CONTRACT_VERSION, status: 'passed', tests: cases.length, cases, proofBoundary: 'Only the offline evidence contract was tested. No Notion, Pi, model, UI or installed product acceptance ran.' };
}

async function command(file, args, cwd, env) {
  const startedAt = new Date().toISOString();
  return await new Promise((done, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 15000);
    child.stdout.on('data', value => out.push(value)); child.stderr.on('data', value => err.push(value));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer); const stdout = Buffer.concat(out), stderr = Buffer.concat(err);
      done({ file, args, cwd, pid: child.pid, startedAt, endedAt: new Date().toISOString(), exitCode, signal, timedOut, stdout: stdout.toString('utf8'), stdoutBytes: stdout.length, stdoutSha256: sha(stdout), stderr: { bytes: stderr.length, sha256: sha(stderr), rawRetained: false }, spawnObserved: true, closeObserved: true });
    });
  });
}

export async function baseline(options) {
  for (const key of ['cli', 'cli-root', 'evidence-root']) check(isAbsolute(options[key] ?? ''), 'ARGUMENT', key + ' must be absolute');
  const cli = await realpath(options.cli), cliRoot = await realpath(options['cli-root']);
  await mkdir(options['evidence-root'], { recursive: true, mode: 0o700 });
  const evidenceRoot = await realpath(options['evidence-root']);
  check(disjoint(evidenceRoot, cliRoot) && disjoint(evidenceRoot, brokerRoot), 'EVIDENCE_LOCATION', 'Keep evidence outside both checkouts');
  const evidence = await mkdtemp(join(evidenceRoot, 'skill-graph-ng01-'));
  const scratch = await mkdtemp(join(await systemTempRoot(), 'skill-graph-ng01-'));
  const runId = randomUUID();
  await save(join(scratch, 'ownership.json'), { runId, evidence, purpose: 'offline-skill-graph-baseline' });
  const run = { version: CONTRACT_VERSION, runId, createdAt: new Date().toISOString(), evidence, scratch, cli, cliRoot, brokerRoot, nodeVersion: process.version, cliSha256: sha(await readFile(cli)), runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))), boundary: 'Offline public CLI schema only. No network, model, production write, credential copy or official ntn subprocess.' };
  await save(join(evidence, 'run.json'), run);
  const artifacts = [];
  const record = async (name, value) => { await save(join(evidence, name), value); artifacts.push({ path: name, sha256: sha(await readFile(join(evidence, name))) }); };
  const env = verificationCliEnvironment(join(scratch, 'cli'), { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(scratch, 'home'), TMPDIR: scratch });
  await mkdir(env.HOME, { recursive: true, mode: 0o700 });
  await record('environment.json', { inheritedCredentials: false, environmentKeys: Object.keys(env).sort(), roots: Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'PATH')), scratchPurpose: 'offline-schema-only', persistentSchedulerTouched: false });
  await record('prompts.json', { boundary: 'Frozen task and root-only invocation. The real runner must bind these selections to observed native root identities; this baseline does not claim discovery.', A: frozenPrompt('A', options['router-selection'] ?? '$pstack@notion'), B: frozenPrompt('B', options['ordinary-selection'] ?? '$poteto-mode@notion') });
  let result;
  try {
    await record('contract-tests.json', selfTest());
    const version = await command(process.execPath, [cli, '--version'], scratch, env); await record('cli-version.json', version);
    const prepare = await command(process.execPath, [cli, 'schema', 'prepare'], scratch, env); await record('cli-prepare-schema.json', prepare);
    const update = await command(process.execPath, [cli, 'schema', 'update'], scratch, env); await record('cli-update-schema.json', update);
    const head = await command('git', ['-C', cliRoot, 'rev-parse', 'HEAD'], scratch, env); await record('cli-head.json', head);
    const committed = await command('git', ['-C', cliRoot, 'show', 'HEAD:packages/core/src/notion.ts'], scratch, env);
    await record('request-engine-committed-baseline.json', { commit: head.stdout.trim(), source: 'HEAD:packages/core/src/notion.ts', exitCode: committed.exitCode, sourceSha256: committed.stdoutSha256, legacyMarkers: committed.stdout.split('\n').flatMap((line, index) => /NTN_SKILLS_NTN_BIN|ntn-keychain/.test(line) ? [{ line: index + 1, marker: line.match(/NTN_SKILLS_NTN_BIN|ntn-keychain/)?.[0] }] : []), interpretation: 'Historical committed source only. Concurrent working-tree implementation is recorded separately.' });
    const transportPath = join(cliRoot, 'packages/core/src/notion.ts');
    const transport = await readFile(transportPath, 'utf8');
    const residuals = transport.split('\n').flatMap((line, index) => /NTN_SKILLS_NTN_BIN|ntn-keychain|parseNtn|Command\.make\(.*ntn/.test(line) ? [{ line: index + 1, marker: line.match(/NTN_SKILLS_NTN_BIN|ntn-keychain|parseNtn|Command\.make/)?.[0] }] : []);
    await record('request-engine-baseline.json', { source: transportPath, sha256: sha(transport), legacyMarkers: residuals, interpretation: residuals.length ? 'legacy-transport-present' : 'no-known-marker-observed; source scanning does not prove direct transport' });
    let updateSchema;
    try { updateSchema = JSON.parse(update.stdout); } catch { updateSchema = null; }
    check(version.exitCode === 0 && !version.timedOut && nonempty(version.stdout), 'CLI_BASELINE_FAILED', 'The actual CLI must report its version before interpreting feature absence');
    check(update.exitCode === 0 && updateSchema?.ok === true && Array.isArray(updateSchema.schema?.parameters), 'CLI_BASELINE_FAILED', 'The actual update schema must be usable before interpreting missing Requires');
    let prepareSchema;
    try { prepareSchema = JSON.parse(prepare.stdout); } catch { prepareSchema = null; }
    const prepareAbsent = prepare.exitCode === 2 && prepareSchema?.error?.code === 'INVALID_ARGUMENT' && JSON.stringify(prepareSchema.error.details?.command) === '["prepare"]';
    check(prepareAbsent || (prepare.exitCode === 0 && prepareSchema?.ok === true), 'CLI_BASELINE_FAILED', 'Unexpected CLI failure is not evidence of an unimplemented prepare command');
    const requires = updateSchema?.schema?.parameters?.some(row => ['require', 'requires', 'clear-requires'].includes(row.name)) ?? false;
    result = { version: CONTRACT_VERSION, runId, status: 'baseline-recorded', productAcceptance: 'not-inferred', checks: [{ feature: 'NG-RE-02', status: residuals.length ? 'fail-before' : 'unverified', evidence: 'request-engine-baseline.json' }, { feature: 'NG-SG-06', status: requires ? 'schema-present-unverified' : 'fail-before', evidence: 'cli-update-schema.json' }, { feature: 'NG-SG-12', status: prepareAbsent ? 'fail-before' : 'schema-present-unverified', evidence: 'cli-prepare-schema.json' }, { feature: 'NG-SG-11', status: 'not-run', reason: 'No real Router model trace was executed.' }, { feature: 'NG-SG-14', status: 'not-run', reason: 'No real ordinary-Skill model trace was executed.' }], columns: Object.fromEntries(EVIDENCE_COLUMNS.map(column => [column, column === 'controlled' ? 'offline-contract-only' : 'not-run'])), artifacts };
  } catch (error) {
    result = { version: CONTRACT_VERSION, runId, status: 'failed', productAcceptance: 'not-inferred', error: { code: error.code ?? 'RUN_FAILED', message: error.message }, artifacts };
  }
  await save(join(evidence, 'result.json'), result);
  return { ...result, evidence, scratch };
}

export async function evidenceStatus(evidence) {
  check(isAbsolute(evidence ?? ''), 'ARGUMENT', 'Evidence directory must be absolute');
  const run = await json(join(evidence, 'run.json')), result = await json(join(evidence, 'result.json'));
  check(run.evidence === await realpath(evidence) && result.runId === run.runId, 'OWNERSHIP', 'Evidence identity mismatch');
  for (const item of result.artifacts) {
    check(!isAbsolute(item.path) && !item.path.split('/').includes('..'), 'ARTIFACT_PATH', 'Artifact paths must remain within this run');
    check(sha(await readFile(join(evidence, item.path))) === item.sha256, 'ARTIFACT_CHANGED', 'An original artifact was changed');
  }
  return { status: 'preserved', functionalStatus: result.status, productAcceptance: result.productAcceptance, runId: run.runId, artifacts: result.artifacts.length, evidence };
}

async function cleanup(evidence) {
  const retained = await evidenceStatus(evidence), run = await json(join(evidence, 'run.json'));
  const previous = join(evidence, 'cleanup.json');
  if (await access(previous).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return { ...(await json(previous)), evidence: retained };
  const owner = await json(join(run.scratch, 'ownership.json'));
  check(owner.runId === run.runId && owner.evidence === evidence && owner.purpose === 'offline-skill-graph-baseline', 'OWNERSHIP', 'Only the owned offline scratch can be cleaned');
  check(disjoint(run.scratch, evidence), 'OWNERSHIP', 'Scratch cannot contain evidence');
  check(process.platform === 'darwin', 'TRASH_UNAVAILABLE', 'Retain scratch until a verified system Trash is available');
  const receipt = await command('/usr/bin/trash', [run.scratch], brokerRoot, process.env);
  check(receipt.exitCode === 0 && !receipt.timedOut, 'CLEANUP_FAILED', 'System Trash did not complete; keep the evidence');
  const value = { status: 'scratch-retired', runId: run.runId, scratch: run.scratch, receipt, remoteWrites: 0, evidenceRetained: true };
  await save(previous, value);
  return { ...value, evidence: await evidenceStatus(evidence) };
}

async function main(args) {
  if (!args.length || args.includes('--help')) return { usage: ['node scripts/verify-skill-graph-contract.mjs self-test', 'node scripts/verify-skill-graph-contract.mjs doctor --cli ABSOLUTE_CLI', 'node scripts/verify-skill-graph-contract.mjs baseline --cli ABSOLUTE_CLI --cli-root ABSOLUTE_CHECKOUT --evidence-root ABSOLUTE_OUTSIDE_CHECKOUT [--router-selection $ROOT --ordinary-selection $ROOT]', 'node scripts/verify-skill-graph-contract.mjs evaluate --trace ABSOLUTE_TRACE --oracle ABSOLUTE_PRIVATE_ORACLE', 'node scripts/verify-skill-graph-contract.mjs evidence|cleanup --evidence ABSOLUTE_RUN'], boundary: 'No live model or production mutations. contract-valid is not product acceptance.' };
  const action = args.shift(), options = {};
  while (args.length) { const flag = args.shift(); check(/^--[a-z-]+$/.test(flag) && args.length && options[flag.slice(2)] === undefined, 'ARGUMENT', 'Invalid or duplicate option'); options[flag.slice(2)] = args.shift(); }
  const allowed = { 'self-test': [], doctor: ['cli'], baseline: ['cli', 'cli-root', 'evidence-root', 'router-selection', 'ordinary-selection'], evaluate: ['trace', 'oracle'], evidence: ['evidence'], cleanup: ['evidence'] };
  check(allowed[action] && Object.keys(options).every(key => allowed[action].includes(key)), 'ARGUMENT', 'Unknown action or option');
  if (action === 'self-test') return selfTest();
  if (action === 'doctor') {
    check(isAbsolute(options.cli ?? ''), 'ARGUMENT', 'CLI path must be absolute');
    const cli = await realpath(options.cli);
    return { status: 'ready', version: CONTRACT_VERSION, nodeVersion: process.version, cli, cliSha256: sha(await readFile(cli)), source: 'offline-artifact-read', credentialsProbed: false, networkCalls: 0, productAcceptance: 'not-inferred' };
  }
  if (action === 'baseline') return baseline(options);
  if (action === 'evaluate') {
    check(isAbsolute(options.trace ?? '') && isAbsolute(options.oracle ?? ''), 'ARGUMENT', 'Trace and oracle must be absolute');
    check(await realpath(options.trace) !== await realpath(options.oracle), 'ORACLE_WARMING', 'Trace and private oracle must be separate files');
    return evaluateGraphTrace(await json(options.trace), await json(options.oracle));
  }
  if (action === 'evidence') return evidenceStatus(options.evidence);
  return cleanup(options.evidence);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await main(process.argv.slice(2)); console.log(JSON.stringify(result, null, 2)); if (result.status === 'failed') process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'RUN_FAILED', message: error.message })); process.exitCode = 1; }
}
