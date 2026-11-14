import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as candidate from './verify-pi-daily-candidate.mjs';
import { candidatePlan, candidateProjectSettings, candidateSourceConfig, candidateProjectInspection, guardCandidateProject, candidatePayloadBodies, observeCandidateTask, validateCandidateTurn, candidateTransportCoverage, containsProof, inspectCandidatePrintSession, reviewCandidateCliCommand, candidateCliGuard } from './verify-pi-daily-candidate.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const body = 'complete source <tag> & "quoted"\nlast line';
const file = { sha256: sha(body), bytes: Buffer.byteLength(body), text: body };

const printSession = () => [
  { type: 'session', id: 'fresh-session', version: 3 },
  { type: 'model_change', id: 'model', parentId: null, provider: 'magpie', modelId: 'group/worker' },
  { type: 'message', id: 'user', parentId: 'model', message: { role: 'user', content: [{ type: 'text', text: 'Read the selected reference.' }] } },
  { type: 'context_edit', id: 'projection', parentId: 'user', targetId: 'user', replacement: { content: 'Original task and complete selected body' } },
  { type: 'message', id: 'call', parentId: 'projection', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'sr:Rissued-reference' } }] } },
  { type: 'message', id: 'result', parentId: 'call', message: { role: 'toolResult', toolName: 'read', toolCallId: 'read-1', isError: false, content: [{ type: 'text', text: 'Full reference' }], details: { contextBrokerResource: { snapshotId: 'fixed' } } } },
  { type: 'message', id: 'answer', parentId: 'result', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'stop', content: [{ type: 'text', text: 'The requested facts.' }] } },
];
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const expectedPrintModel = { provider: 'magpie', model: 'group/worker' };

test('native print inspection binds actual model, tool-call/result IDs and context projections to session lines', () => {
  const source = jsonl(printSession()), inspected = inspectCandidatePrintSession(source, expectedPrintModel);
  assert.equal(inspected.sha256, sha(source)); assert.equal(inspected.lines, 7);
  assert.deepEqual(inspected.userLines, [3]);
  assert.equal(inspected.calls[0].callLine, 5); assert.equal(inspected.calls[0].resultLine, 6);
  assert.deepEqual(inspected.calls[0].proofKinds, ['contextBrokerResource']);
  assert.equal(inspected.projections[0].targetId, 'user'); assert.deepEqual(inspected.errors, []);
});

test('native print inspection does not accept fallback models, orphan results, partial JSONL or branched history', () => {
  const rows = printSession();
  for (const mutate of [
    value => { value[1].modelId = 'group/flash'; },
    value => { value[6].message.model = 'another-model'; },
    value => { value[5].message.toolCallId = 'unrelated'; },
    value => { value[5].message.toolName = 'bash'; },
    value => { value[3].parentId = 'model'; },
    value => { value[3].targetId = 'not-in-session'; },
    value => { value[6].message.stopReason = 'error'; },
    value => { value[6].message.stopReason = 'length'; },
    value => { value[0].parentSession = '/old/session.jsonl'; },
    value => { value.splice(5, 1); value[5].parentId = 'call'; },
  ]) { const changed = structuredClone(rows); mutate(changed); assert.throws(() => inspectCandidatePrintSession(jsonl(changed), expectedPrintModel)); }
  assert.throws(() => inspectCandidatePrintSession(jsonl(rows).trimEnd(), expectedPrintModel));
});

test('owned print continuation requires the frozen submission count and keeps earlier call identities', () => {
  const rows = printSession();
  rows.push({ type: 'message', id: 'followup', parentId: 'answer', message: { role: 'user', content: [{ type: 'text', text: 'Use the same pinned content.' }] } });
  rows.push({ type: 'message', id: 'followup-answer', parentId: 'followup', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'stop', content: [{ type: 'text', text: 'The original fixed version.' }] } });
  assert.throws(() => inspectCandidatePrintSession(jsonl(rows), expectedPrintModel));
  const review = inspectCandidatePrintSession(jsonl(rows), { ...expectedPrintModel, expectedUserMessages: 2 });
  assert.deepEqual(review.userLines, [3, 8]); assert.equal(review.calls[0].id, 'read-1');
  assert.throws(() => inspectCandidatePrintSession(jsonl(rows), { ...expectedPrintModel, expectedUserMessages: 3 }));
  assert.throws(() => inspectCandidatePrintSession(jsonl(rows), { ...expectedPrintModel, expectedUserMessages: 0 }));
});

test('an explicit retraction of a failed partial model response stays distinct from executed tools', () => {
  const rows = printSession();
  const failed = { ...structuredClone(rows[4]), id: 'partial', parentId: 'projection' };
  failed.message.stopReason = 'error'; failed.message.content[0].id = 'partial-call';
  const retract = { type: 'context_edit', id: 'retract', parentId: 'partial', targetId: 'partial', replacement: null };
  rows[4].parentId = 'retract'; rows.splice(4, 0, failed, retract);
  const review = inspectCandidatePrintSession(jsonl(rows), expectedPrintModel);
  assert.equal(review.calls.length, 1); assert.equal(review.retractedCalls.length, 1);
  assert.equal(review.retractedCalls[0].id, 'partial-call');
  assert.equal(review.retractedCalls[0].retractedLine, 6);
  assert.equal(review.finals[0].stopReason, 'error');
  const noRetraction = structuredClone(rows); noRetraction.splice(5, 1); noRetraction[5].parentId = 'partial';
  assert.throws(() => inspectCandidatePrintSession(jsonl(noRetraction), expectedPrintModel));
});

test('candidate package override changes only the reviewed local package slot', () => {
  assert.deepEqual(candidateProjectSettings('/old/broker', '/candidate/broker'), { packages: [{ source: '/old/broker', extensions: [] }, '/candidate/broker'] });
  assert.throws(() => candidateProjectSettings('/old/broker', '/old/broker'));
  assert.throws(() => candidateProjectSettings('npm:broker', '/candidate/broker'));
});

test('candidate source preserves local discovery and refuses ambiguous daily source changes', () => {
  const original = { skillRoots: ['/real/skills'], ruleRoots: ['/real/rules'], discoveryCatalogs: ['/real/catalog.yaml'], sources: [{ id: 'local', type: 'filesystem', roots: ['/real/other'] }, { id: 'notion', type: 'notion', database: 'old', prefetch: false }] };
  const input = { sourceId: 'notion', database: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cacheDir: '/owned/cache' };
  const candidate = candidateSourceConfig(original, input);
  assert.deepEqual(candidate.skillRoots, original.skillRoots); assert.deepEqual(candidate.sources[0], original.sources[0]);
  assert.equal(original.sources[1].database, 'old'); assert.equal(candidate.sources[1].database, input.database);
  assert.equal(candidateSourceConfig(original, { ...input, noNotion: true }).sources[1].enabled, false);
  assert.throws(() => candidateSourceConfig({ ...original, ruleRoots: ['./relative'] }, input));
  assert.throws(() => candidateSourceConfig({ ...original, sources: [...original.sources, { id: 'extra', type: 'notion' }] }, input));
  assert.throws(() => candidateSourceConfig({ ...original, sources: [{ ...original.sources[1], command: ['fake'] }] }, input));
});

const publicCli = { mode: 'original-create-recovery', operationId: 'original-operation', entry: { path: '/frozen/ntn-skills.js' }, database: 'owned-library', target: 'original-page',
  originalPlan: { path: '/evidence/original-plan.json' }, refPrefix: 'skill://original-owner/', outputRoot: '/evidence/agent-output',
  inputFiles: ['/evidence/original-plan.json', '/evidence/original-error.json'] };
const cliCommand = 'node /frozen/ntn-skills.js';
const reviewCommand = cliCommand + ' ctl library create recovery review /evidence/original-plan.json --entry owned-library --target original-page --output /evidence/agent-output/review.json';

test('public CLI task permits help and only the bound original recovery and strict reads', () => {
  assert.equal(reviewCandidateCliCommand(cliCommand + ' --help', publicCli).kind, 'help');
  assert.equal(reviewCandidateCliCommand(cliCommand + ' ctl library create recovery apply --help', publicCli).kind, 'help');
  assert.equal(reviewCandidateCliCommand(cliCommand + ' schema ctl operation show', publicCli).kind, 'schema');
  assert.equal(reviewCandidateCliCommand(cliCommand + ' ctl operation show original-operation', publicCli).kind, 'operation-show');
  assert.equal(reviewCandidateCliCommand(reviewCommand, publicCli).kind, 'review');
  assert.equal(reviewCandidateCliCommand(reviewCommand.replace(' /evidence/original-plan.json', '') + ' /evidence/original-plan.json', publicCli).kind, 'review');
  const apply = cliCommand + ' ctl library create recovery apply /evidence/original-plan.json --entry owned-library --review /evidence/agent-output/review.json --review-id create-restore-' + 'a'.repeat(64);
  assert.equal(reviewCandidateCliCommand(apply + ' --dry-run', publicCli).dryRun, true);
  assert.equal(reviewCandidateCliCommand(apply, publicCli).dryRun, false);
  assert.equal(reviewCandidateCliCommand(cliCommand + ' ctl library create recovery reconcile --entry owned-library --target original-page /evidence/original-plan.json', publicCli).kind, 'reconcile');
  assert.equal(reviewCandidateCliCommand(reviewCommand + ' --max-requests 100 --duration-ms 60000', publicCli).kind, 'review');
  const read = cliCommand + " read 'skill://original-owner/references/policy.md?snapshot=fixed&file_id=original-file' --database owned-library --read-only --json --metrics";
  assert.equal(reviewCandidateCliCommand(read, publicCli).kind, 'read');
  assert.equal(reviewCandidateCliCommand(read, publicCli).argv[3], 'skill://original-owner/references/policy.md?snapshot=fixed&file_id=original-file');
  assert.equal(reviewCandidateCliCommand(cliCommand + ' read --json --metrics --read-only --database owned-library --path references/policy.md original-page', publicCli).kind, 'read');
  assert.equal(reviewCandidateCliCommand(cliCommand + " read references/policy.md --from 'skill://original-owner/SKILL.md?snapshot=fixed&file_id=original-file' --database owned-library --read-only --json --metrics", publicCli).kind, 'read');
  assert.equal(reviewCandidateCliCommand(cliCommand + " files 'skill://original-owner/SKILL.md?snapshot=s_" + 'a'.repeat(64) + "&file_id=original-file' --database owned-library --metrics", publicCli).kind, 'files');
});

test('public CLI scope rejects shell composition, replacement plans, owners and unbounded output', () => {
  for (const command of [
    reviewCommand + '; node other.js', reviewCommand + '\nnode other.js', reviewCommand + ' | cat',
    'python private-store.py', reviewCommand.replace('/frozen/ntn-skills.js', '/other/cli.js'),
    reviewCommand.replace('create recovery review /evidence/original-plan.json', 'create /replacement'),
    reviewCommand.replace('/evidence/original-plan.json', '/evidence/replacement-plan.json'),
    reviewCommand.replace('--entry owned-library', '--entry another-library'),
    reviewCommand.replace('--target original-page', '--target replacement-page'),
    reviewCommand.replace('/evidence/agent-output/review.json', '/evidence/original-plan.json'),
    reviewCommand.replace('/evidence/agent-output/review.json', '/evidence/agent-output/../outside.json'),
    cliCommand + ' --help > /tmp/overwrite', cliCommand + ' --help$(id)',
    cliCommand + ' ctl operation show another-operation', cliCommand + ' ctl operation resume original-operation',
    reviewCommand + ' --json --metrics', reviewCommand + ' --dry-run', reviewCommand + ' --max-requests 2001',
    cliCommand + ' ctl library create recovery apply /evidence/original-plan.json --entry owned-library',
    cliCommand + ' ctl library create recovery reconcile /evidence/original-plan.json --entry owned-library --target original-page --output /evidence/agent-output/unsupported.json',
    cliCommand + ' read original-page --database owned-library --json --metrics',
    cliCommand + ' read another-page --database owned-library --read-only --json --metrics',
    cliCommand + " read references/policy.md --from skill://another-owner/SKILL.md --database owned-library --read-only --json --metrics",
    cliCommand + ' read original-page --path ../outside --database owned-library --read-only --json --metrics',
    cliCommand + ' files original-page --database owned-library --metrics',
    cliCommand + " files 'skill://another-owner/SKILL.md?snapshot=s_" + 'a'.repeat(64) + "' --database owned-library --metrics",
  ]) assert.throws(() => reviewCandidateCliCommand(command, publicCli), command);
});

test('public author update permits one exact Description and rejects every extra mutation', () => {
  const policy = { ...publicCli, mode: 'owned-description-update', description: 'Verified shared author workflow.' };
  const command = cliCommand + ' update original-page --database owned-library --description "Verified shared author workflow."';
  assert.equal(reviewCandidateCliCommand(command + ' --dry-run', policy).dryRun, true);
  assert.equal(reviewCandidateCliCommand(command, policy).kind, 'update');
  assert.equal(reviewCandidateCliCommand(command.replace(' original-page', '') + ' original-page', policy).kind, 'update');
  assert.equal(reviewCandidateCliCommand(cliCommand + ' schema update', policy).kind, 'schema');
  assert.equal(reviewCandidateCliCommand(cliCommand + ' read original-page --database owned-library --json --metrics --read-only', policy).kind, 'read');
  for (const value of [command.replace('original-page', 'another-page'), command.replace('Verified shared', 'Unreviewed'),
    command.replace('owned-library', 'another-library'), command + ' --enabled true', command + ' --default-context', command + ' --clear-requires',
    command + ' --name replacement', command + ' --json --metrics', command + '; node private.js', reviewCommand,
    cliCommand + ' ctl operation show original-operation']) assert.throws(() => reviewCandidateCliCommand(value, policy), value);
  assert.throws(() => reviewCandidateCliCommand(command, publicCli));
});

test('public CLI guard blocks before execution and confines native file reads to disclosed artifacts', () => {
  const handlers = new Map(), records = [];
  candidateCliGuard({ on(name, fn) { handlers.set(name, fn); } }, { fs: { openSync: () => 1, writeSync: (_fd, text) => records.push(JSON.parse(text)), closeSync() {} },
    output: '/evidence/guard.jsonl', policy: publicCli, review: reviewCandidateCliCommand });
  assert.equal(handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'help', input: { command: cliCommand + ' --help' } }), undefined);
  assert.equal(handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'private', input: { command: 'python store.py' } }).block, true);
  assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'plan', input: { path: publicCli.originalPlan.path } }), undefined);
  assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'outside', input: { path: '/unrelated/secret' } }).block, true);
  handlers.get('session_shutdown')({});
  assert.deepEqual(records.map(record => record.allowed ?? record.complete), [true, false, true, false, true]);
});

test('public CLI guard admits only the exact host spill from an approved Bash result', () => {
  const handlers = new Map(), records = [], spill = '/tmp/pi-bash-cbd1aed4d1a765d7.log';
  candidateCliGuard({ on(name, fn) { handlers.set(name, fn); } }, { fs: { openSync: () => 1, writeSync: (_fd, text) => records.push(JSON.parse(text)), closeSync() {} },
    output: '/evidence/guard.jsonl', policy: publicCli, review: reviewCandidateCliCommand });
  const read = path => handlers.get('tool_call')({ toolName: 'read', toolCallId: 'read-' + records.length, input: { path } });
  const result = { toolName: 'bash', toolCallId: 'approved', details: { fullOutputPath: spill, truncation: { truncated: true } } };
  assert.equal(read(spill).block, true);
  handlers.get('tool_result')(result); assert.equal(read(spill).block, true, 'An unmatched result cannot authorize a filesystem read');
  assert.equal(handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'approved', input: { command: reviewCommand } }), undefined);
  handlers.get('tool_result')({ ...result, details: { ...result.details, fullOutputPath: '/unrelated/secret' } });
  assert.equal(read('/unrelated/secret').block, true);
  handlers.get('tool_result')({ ...result, details: { fullOutputPath: spill } }); assert.equal(read(spill).block, true);
  const before = structuredClone(result); assert.equal(handlers.get('tool_result')(result), undefined); assert.deepEqual(result, before);
  assert.equal(read(spill), undefined);
  assert.equal(read('/tmp/pi-bash-0000000000000000.log').block, true);
  assert.deepEqual(records.filter(row => row.phase === 'public-cli-output'), [
    { phase: 'public-cli-output', sourceToolCallId: 'approved', artifactPath: spill, allowed: true },
  ]);
});

const maintenanceCli = { ...publicCli, mode: 'owned-maintenance-readonly', sourceId: 'notion', nodeExecutable: '/frozen/node',
  builtinFiles: ['/frozen/builtin-skills/ntn-skills-maintain/SKILL.md', '/frozen/builtin-skills/ntn-skills-maintain/references/operations.md'] };
const maintenanceBranch = () => {
  const identity = { source: 'notion', id: 'original-owner', ref: 'skill://original-owner',
    locator: { type: 'shared_skill', page_id: 'original-page', database_id: 'owned-library' } };
  return [
    { type: 'custom', customType: 'context-broker-short-ref', data: { version: 1, ref: 'sr:C' + 'A'.repeat(22), target: { kind: 'candidate', identity } } },
    { type: 'custom', customType: 'context-broker-short-ref', data: { version: 1, ref: 'sr:S' + 'A'.repeat(22), target: { kind: 'selected', identity,
      snapshot_id: 's_' + 'a'.repeat(64), ref: 'skill://original-owner/SKILL.md?snapshot=s_' + 'a'.repeat(64) } } },
    { type: 'custom', customType: 'context-broker-short-ref', data: { version: 1, ref: 'sr:R' + 'A'.repeat(22), target: { kind: 'resource',
      owner: 'sr:S' + 'A'.repeat(22), ref: 'skill://original-owner/references/one.md?snapshot=s_' + 'a'.repeat(64) } } },
  ];
};

test('read-only maintenance uses the scoped public audit, original operation and authoring read', () => {
  for (const command of [
    cliCommand + ' --help', cliCommand + ' schema ctl audit run',
    cliCommand + ' ctl audit run --entry owned-library --target original-page --depth history --max-requests 80 --duration-ms 60000 --max-bytes 8388608',
    cliCommand + ' ctl operation show original-operation --target original-page --entry owned-library',
    cliCommand + ' ctl operation reconcile original-operation --entry owned-library --target original-page',
    cliCommand + ' read original-page --database owned-library --authoring --read-only --json --metrics',
    cliCommand + " read 'skill://original-owner/references/one.md?snapshot=s_" + 'a'.repeat(64) + "' --database owned-library --read-only --json --metrics",
  ]) assert.ok(reviewCandidateCliCommand(command, maintenanceCli).kind, command);
  assert.equal(reviewCandidateCliCommand('/frozen/node /frozen/ntn-skills.js --help', maintenanceCli).kind, 'help');
  assert.throws(() => reviewCandidateCliCommand('/other/node /frozen/ntn-skills.js --help', maintenanceCli));
  assert.throws(() => reviewCandidateCliCommand('/frozen/node /frozen/ntn-skills.js --help', publicCli));
});

test('read-only maintenance rejects another owner, library, operation, mutations and unscoped audits', () => {
  for (const command of [
    cliCommand + ' ctl audit run --entry another-library --target original-page',
    cliCommand + ' ctl audit run --entry owned-library --target another-page',
    cliCommand + ' ctl audit run --entry owned-library --all',
    cliCommand + ' ctl audit run --entry owned-library --target original-page --max-requests 501',
    cliCommand + ' ctl operation show another-operation --target original-page --entry owned-library',
    cliCommand + ' ctl operation reconcile original-operation --target another-page --entry owned-library',
    cliCommand + ' ctl operation resume original-operation --target original-page --entry owned-library',
    cliCommand + ' read original-page --database owned-library --authoring --json --metrics',
    cliCommand + ' read another-page --database owned-library --read-only --json --metrics',
    cliCommand + ' update original-page --database owned-library --enabled true',
    cliCommand + ' adopt original-page --database owned-library',
    cliCommand + ' apply original-page --database owned-library --input /tmp/tree',
    cliCommand + ' --help; node /private/store.js',
  ]) assert.throws(() => reviewCandidateCliCommand(command, maintenanceCli), command);
});

test('maintenance public builtin discovery admits the installed local interface and only its protected files', () => {
  for (const suffix of ['ctl builtin list', 'ctl builtin read notion/ntn-skills-maintain',
    'ctl builtin read notion/ntn-skills-maintain --path SKILL.md',
    'ctl builtin read --path references/operations.md notion/ntn-skills-maintain']) {
    assert.ok(reviewCandidateCliCommand(cliCommand + ' ' + suffix, maintenanceCli).kind.startsWith('builtin-'));
    assert.throws(() => reviewCandidateCliCommand(cliCommand + ' ' + suffix, publicCli));
  }
  for (const suffix of [
    'ctl builtin list --agent-dir /another/root', 'ctl builtin list --json',
    'ctl builtin read notion/ntn-skills', 'ctl builtin read notion/ntn-skills-sync',
    'ctl builtin read notion/ntn-skills-maintain --path ../SKILL.md',
    'ctl builtin read notion/ntn-skills-maintain --path /etc/passwd',
    'ctl builtin read notion/ntn-skills-maintain --path references/other.md',
    'ctl builtin read notion/ntn-skills-maintain --path SKILL.md --path SKILL.md',
    'ctl builtin read notion/ntn-skills-maintain --agent-dir /another/root',
    'ctl builtin read notion/ntn-skills-maintain --json',
    'ctl builtin install notion/ntn-skills-maintain', 'ctl builtin status notion/ntn-skills-maintain',
  ]) assert.throws(() => reviewCandidateCliCommand(cliCommand + ' ' + suffix, maintenanceCli), suffix);
});

test('an onboarding inspection reads the setup reference and validates only its existing library', () => {
  for (const suffix of [
    'ctl builtin read notion/ntn-skills-maintain --path references/setup.md',
    'ctl library init --entry owned-library',
    'ctl library inspect owned-library',
    'ctl library sources list --entry owned-library',
    'list --database owned-library --refresh --json',
    'list --database owned-library --query original --limit 10 --json',
  ]) assert.ok(reviewCandidateCliCommand(cliCommand + ' ' + suffix, maintenanceCli).kind, suffix);
  for (const suffix of [
    'ctl library init --parent owned-page', 'ctl library init --entry another-library',
    'ctl library init --entry owned-library --parent owned-page',
    'ctl library sources init --entry owned-library',
    'ctl library sources list --entry another-library',
    'ctl library inspect another-library', 'list --json',
    'list --database another-library --json', 'list --database owned-library --limit 1000 --json',
    'ctl database register skills --database owned-library',
  ]) assert.throws(() => reviewCandidateCliCommand(cliCommand + ' ' + suffix, maintenanceCli), suffix);
});

test('read-only onboarding uses public JSON without turning optional metrics into an authorization rule', () => {
  const command = cliCommand + ' read original-page --database owned-library --read-only --json';
  assert.equal(reviewCandidateCliCommand(command, maintenanceCli).kind, 'read');
  assert.throws(() => reviewCandidateCliCommand(command.replace(' --read-only', ''), maintenanceCli));
  assert.throws(() => reviewCandidateCliCommand(command.replace(' --json', ''), maintenanceCli));
  assert.throws(() => reviewCandidateCliCommand(command.replace('original-page', 'other-page'), maintenanceCli));
});

const auditRunId = 'audit-33a07e13-071b-4071-a6b4-d76c92834a5a';
const auditCommand = cliCommand + ' ctl audit run --entry owned-library --target original-page --depth history';
const auditReportFixture = () => ({ ok: true, report_version: 1, rules_version: 'resource-audit-v3', run_id: auditRunId,
  entry_id: 'owned-library', selector: { kind: 'skill', page_id: 'original-page' }, inspection_scope: 'reachable_target',
  execution: 'completed', coverage: 'partial', severity: { error: 0, warning: 1, info: 0 }, remote_writes: 0,
  next: { state: 'inspect_retained_report', argv: ['ntn-skills', 'ctl', 'audit', 'report', auditRunId], read_only: true } });
const auditGuard = () => {
  const handlers = new Map(), records = [], files = new Map(), reads = [];
  const guard = new Function('return (' + candidateCliGuard.toString() + ')')();
  guard({ on(name, fn) { handlers.set(name, fn); } }, { fs: { openSync: () => 1,
    writeSync: (_fd, value) => records.push(JSON.parse(value)), closeSync() {},
    readFileSync(path) { reads.push(path); if (!files.has(path)) throw new Error('missing original'); return files.get(path); } },
  output: '/evidence/guard.jsonl', policy: maintenanceCli, sha,
  review: new Function('return (' + reviewCandidateCliCommand.toString() + ')')(),
  auditReportBinding: new Function('return (' + candidate.candidateAuditReportBinding.toString() + ')')() });
  return { handlers, records, files, reads,
    call(command, id) { return handlers.get('tool_call')({ toolName: 'bash', toolCallId: id, input: { command } }); } };
};

test('an actual warning exit 4 report binds through its registered complete spill before the next command', () => {
  const value = auditGuard(), spill = '/tmp/pi-bash-' + '1'.repeat(16) + '.log', raw = JSON.stringify(auditReportFixture()) + '\n';
  value.files.set(spill, raw);
  assert.equal(value.call(auditCommand, 'audit-1'), undefined);
  const event = { toolName: 'bash', toolCallId: 'audit-1', isError: true,
    content: [{ type: 'text', text: 'truncated report tail\n\nCommand exited with code 4' }],
    details: { truncation: { truncated: true }, fullOutputPath: spill } };
  value.handlers.get('tool_result')(event);
  assert.deepEqual(value.reads, [spill]);
  const binding = value.records.find(row => row.phase === 'public-cli-audit-report');
  assert.equal(binding.runId, auditRunId); assert.equal(binding.sourceToolCallId, 'audit-1');
  assert.equal(binding.reportSha256, sha(raw)); assert.equal(binding.reportBytes, Buffer.byteLength(raw));
  assert.equal(binding.resultSha256, sha(JSON.stringify(event.content)));
  assert.equal(value.call(cliCommand + ' ctl audit report ' + auditRunId, 'report-1'), undefined);
  const native = { calls: [{ id: 'audit-1', name: 'bash', arguments: { command: auditCommand }, callLine: 3, resultLine: 4,
    resultSha256: sha(JSON.stringify(event.content)) }] };
  const session = jsonl([{ type: 'message', message: { role: 'toolResult', ...event } }]);
  const inspect = (history = session, rows = value.records) => candidate.inspectCandidateAuditReportBindings(maintenanceCli, native, history, rows, file => value.files.get(file));
  assert.deepEqual(inspect(), [binding]);
  assert.throws(() => inspect(session.replace('truncated report tail', 'changed original result')));
  assert.throws(() => inspect(session, value.records.map(row => row === binding ? { ...row, reportSha256: '0'.repeat(64) } : row)));
  value.files.set(spill, JSON.stringify({ ...auditReportFixture(), selector: { kind: 'skill', page_id: 'another-page' } }));
  assert.throws(() => inspect());
});

test('reports cannot be preseeded or escape the actual session audit and no report flags are admitted', () => {
  const value = auditGuard(), command = cliCommand + ' ctl audit report ' + auditRunId;
  assert.equal(value.call(command, 'before-audit').block, true);
  assert.throws(() => reviewCandidateCliCommand(command, { ...maintenanceCli, observedAuditRunIds: [auditRunId] }));
  assert.throws(() => reviewCandidateCliCommand(command, publicCli, [auditRunId]));
  assert.equal(value.call(cliCommand + ' --help', 'not-an-audit'), undefined);
  value.handlers.get('tool_result')({ toolName: 'bash', toolCallId: 'not-an-audit', isError: false,
    content: [{ type: 'text', text: JSON.stringify(auditReportFixture()) }] });
  assert.equal(value.call(command, 'unrelated-command-result').block, true);
  assert.equal(value.call(auditCommand, 'audit-1'), undefined);
  value.handlers.get('tool_result')({ toolName: 'bash', toolCallId: 'audit-1', isError: true,
    content: [{ type: 'text', text: JSON.stringify(auditReportFixture()) + '\n\nCommand exited with code 4' }] });
  assert.equal(value.call(command, 'bound-report'), undefined);
  assert.deepEqual(value.reads, []);
  for (const suffix of [' --entry owned-library', ' --output /owned/report.json', ' --json', ' extra'])
    assert.equal(value.call(command + suffix, 'flag-' + suffix).block, true);
  assert.equal(value.call(cliCommand + ' ctl audit report audit-00000000-0000-0000-0000-000000000000', 'foreign-run').block, true);
  assert.equal(value.call(cliCommand + ' ctl audit resume ' + auditRunId, 'resume').block, true);
});

test('incomplete, unregistered, foreign or mutating audit evidence never grants report access', () => {
  const spill = '/tmp/pi-bash-' + '2'.repeat(16) + '.log';
  assert.equal(candidate.candidateAuditReportBinding({ toolName: 'bash', toolCallId: 'audit-1', isError: false,
    content: [{ type: 'text', text: JSON.stringify(auditReportFixture()) }] }, maintenanceCli,
  { registeredPath: spill, readFile() { throw new Error('Must not read an unrelated spill'); }, sha }), undefined);
  for (const mutate of [
    report => { report.ok = false; }, report => { report.execution = 'paused'; }, report => { report.remote_writes = 1; },
    report => { report.entry_id = 'another-library'; }, report => { report.selector.page_id = 'another-page'; },
    report => { report.selector.kind = 'all'; }, report => { report.next.read_only = false; },
    report => { report.next.argv.push('--output', '/owned/file'); }, report => { delete report.run_id; },
  ]) {
    const value = auditGuard(), report = auditReportFixture(); mutate(report);
    value.files.set(spill, JSON.stringify(report)); value.call(auditCommand, 'audit-1');
    value.handlers.get('tool_result')({ toolName: 'bash', toolCallId: 'audit-1', isError: true,
      content: [{ type: 'text', text: 'truncated' }], details: { truncation: { truncated: true }, fullOutputPath: spill } });
    assert.equal(value.call(cliCommand + ' ctl audit report ' + auditRunId, 'report-1').block, true);
  }
  for (const missing of [true, false]) {
    const value = auditGuard(); value.call(auditCommand, 'audit-1');
    if (!missing) value.files.set(spill, '{"ok":true,"run_id":"' + auditRunId);
    value.handlers.get('tool_result')({ toolName: 'bash', toolCallId: 'audit-1', isError: true,
      content: [{ type: 'text', text: JSON.stringify(auditReportFixture()) }],
      details: { truncation: { truncated: true }, fullOutputPath: missing ? '/unregistered/private-report' : spill } });
    assert.equal(value.call(cliCommand + ' ctl audit report ' + auditRunId, 'report-1').block, true);
    if (missing) assert.deepEqual(value.reads, []);
  }
});

test('maintenance guard admits builtin discovery, exact CLI metadata and current owner short refs', () => {
  const handlers = new Map(), records = [], branch = maintenanceBranch();
  candidateCliGuard({ on(name, fn) { handlers.set(name, fn); } }, { fs: { openSync: () => 1, writeSync: (_fd, text) => records.push(JSON.parse(text)), closeSync() {} },
    output: '/evidence/guard.jsonl', policy: maintenanceCli, review: reviewCandidateCliCommand, maintenanceReview: candidate.reviewCandidateMaintenanceTool });
  const ctx = { sessionManager: { getBranch: () => branch } };
  const calls = [
    ['read', { path: maintenanceCli.builtinFiles[0] }],
    ['tool_search', { query: 'Notion management CLI source', limit: 1 }],
    ['tool_search', { query: 'list_mcp_resources ntn skills maintain', limit: 5 }],
    ['tool_search', { query: 'NTN SKILLS MAINTAIN', limit: 1 }],
    ['notion_ctl', { cli_source: 'notion' }],
    ['notion_list', { query: 'owned fixture', source: 'notion', limit: 1 }],
    ['notion_use', { ref: branch[0].data.ref, readOnly: true }],
    ['read', { path: branch[2].data.ref, readOnly: true }],
    ['read', { paths: [branch[2].data.ref], readOnly: true }],
    ['read', { path: 'skill://original-owner/references/one.md', readOnly: true }],
  ];
  for (const [toolName, input] of calls) assert.equal(handlers.get('tool_call')({ toolName, toolCallId: 'call-' + records.length, input }, ctx), undefined);
  handlers.get('session_shutdown')({});
  assert.ok(records.every(row => row.allowed === true || row.complete === true));
});

test('maintenance guard fails before I/O for foreign handles, no readOnly, unrelated files or tools', () => {
  const handlers = new Map(), records = [], branch = maintenanceBranch();
  candidateCliGuard({ on(name, fn) { handlers.set(name, fn); } }, { fs: { openSync: () => 1, writeSync: (_fd, text) => records.push(JSON.parse(text)), closeSync() {} },
    output: '/evidence/guard.jsonl', policy: maintenanceCli, review: reviewCandidateCliCommand, maintenanceReview: candidate.reviewCandidateMaintenanceTool });
  const ctx = { sessionManager: { getBranch: () => branch } };
  for (const [toolName, input] of [
    ['read', { path: '/unrelated/secret', readOnly: true }],
    ['read', { path: 'skill://another-owner/SKILL.md', readOnly: true }],
    ['read', { path: branch[2].data.ref }],
    ['notion_use', { ref: branch[0].data.ref, readOnly: false }],
    ['notion_use', { ref: 'sr:C' + 'B'.repeat(22), readOnly: true }],
    ['notion_ctl', { cli_source: 'another-source' }],
    ['notion_ctl', { refs: [] }],
    ['notion_list', { source: 'another-source' }],
    ['tool_search', { query: 'send email' }],
    ['tool_search', { query: 'ntn skills' }],
    ['tool_search', { query: 'ntn skills sync' }],
    ['tool_search', { query: 'ntn skills maintainers' }],
    ['tool_search', { query: 'notntn skills maintain' }],
    ['tool_search', { query: 'ntn skills maintain', limit: 9 }],
    ['write', { path: '/evidence/new-file', content: 'not authorized' }],
  ]) assert.equal(handlers.get('tool_call')({ toolName, toolCallId: 'blocked-' + records.length, input }, ctx)?.block, true);
  branch[1].data.target.identity = { ...branch[1].data.target.identity, locator: { page_id: 'another-page', database_id: 'owned-library' } };
  assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'foreign-resource', input: { path: branch[2].data.ref, readOnly: true } }, ctx)?.block, true);
  handlers.get('session_shutdown')({});
});

test('maintenance policy survives serialization without product-module or private Store access', () => {
  const review = new Function('return (' + candidate.reviewCandidateMaintenanceTool.toString() + ')')();
  assert.ok(review('notion_use', { ref: maintenanceBranch()[0].data.ref, readOnly: true }, maintenanceCli, maintenanceBranch()));
  assert.throws(() => review('notion_use', { ref: maintenanceBranch()[0].data.ref, readOnly: true }, maintenanceCli, []));
});

test('maintenance builtin allowance does not broaden original author guards', () => {
  const handlers = new Map();
  candidateCliGuard({ on(name, fn) { handlers.set(name, fn); } }, { fs: { openSync: () => 1, writeSync() {}, closeSync() {} },
    output: '/evidence/guard.jsonl', policy: { ...publicCli, builtinFiles: maintenanceCli.builtinFiles }, review: reviewCandidateCliCommand });
  assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'outside-old-task', input: { path: maintenanceCli.builtinFiles[0] } })?.block, true);
});

test('maintenance starts only with the actual candidate native read executor and fails closed on ledger errors', () => {
  const policy = { ...maintenanceCli, readExecutorPath: '/frozen/broker/src/index.ts' };
  const create = (tools, failOpen = false) => {
    const handlers = new Map(), rows = [];
    candidateCliGuard({ on(name, fn) { handlers.set(name, fn); }, getAllTools: () => tools }, {
      fs: { openSync() { if (failOpen) throw new Error('ledger unavailable'); return 1; }, writeSync(_fd, text) { rows.push(JSON.parse(text)); }, closeSync() {} },
      output: '/evidence/guard.jsonl', policy, review: reviewCandidateCliCommand, maintenanceReview: candidate.reviewCandidateMaintenanceTool });
    return { handlers, rows };
  };
  const read = { name: 'read', sourceInfo: { path: policy.readExecutorPath }, parameters: { properties: { readOnly: { type: 'boolean' } } } };
  const good = create([read]); assert.equal(good.handlers.get('input')({}), undefined);
  assert.deepEqual(good.rows, [{ phase: 'maintenance-admission', allowed: true }]);
  for (const item of [create([]), create([{ ...read, sourceInfo: { path: '/other/read.ts' } }]), create([read], true)]) {
    assert.deepEqual(item.handlers.get('input')({}), { action: 'handled' });
    assert.equal(item.handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'blocked', input: { command: cliCommand + ' --help' } })?.block, true);
  }
});

function maintenancePayloadFixture() {
  const owner = 'shared_skill:owned-library:owned-skill', scope = 'a'.repeat(64), snapshot = 's_' + 'b'.repeat(64), version = 'c'.repeat(64);
  const expectedBodies = ['Main complete authored body.', 'First complete reference.', 'Second complete reference.'].map((text, index) => {
    const path = ['SKILL.md', 'guides/one.md', 'references/two.md'][index], file_id = 'file-' + String(index + 1).repeat(64);
    return { path: '/oracle/' + path, text, sha256: sha(text), bytes: Buffer.byteLength(text), binding: { owner, scope,
      snapshot_id: snapshot, version_id: version, path, file_id, ref: 'skill://' + encodeURIComponent(owner) + '/' + path + '?snapshot=' + snapshot + '&file_id=' + file_id } };
  });
  const config = { requireUse: true, expectedBodies, bodies: expectedBodies.map(body => ({ sha256: body.sha256, occurrences: 1 })),
    publicCli: { ...maintenanceCli, refPrefix: 'skill://' + encodeURIComponent(owner) + '/', bodyCountScope: 'broker-plus-unchanged-cli' },
    proofs: [{ binding: { record: { id: owner }, snapshot_id: snapshot } }, ...expectedBodies.slice(1).map(body => ({ scope, snapshot_id: snapshot, file_id: body.binding.file_id, sha256: body.sha256 }))] };
  const nativeMessages = [], calls = [], tasks = [], guard = [], messages = [];
  const add = (id, name, args, content, details = {}) => {
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const text = parts.map(part => part.text).join('\n');
    nativeMessages.push({ type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: name, content: parts, details, isError: false } });
    calls.push({ id, name, arguments: args, resultSha256: sha(JSON.stringify(parts)), isError: false });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      { role: 'tool', tool_call_id: id, content: text });
    tasks.push({ phase: 'tool_call', toolCallId: id, toolName: name, executionTool: name === 'bash', reviewedReadTool: name !== 'bash' },
      { phase: 'tool_result', toolCallId: id, toolName: name, isError: false });
    const proofs = Object.fromEntries(Object.entries(details).filter(([key]) => key.startsWith('contextBroker')));
    if (Object.keys(proofs).length) tasks.push({ phase: 'receipt', toolCallId: id, toolName: name, content: { sha256: sha(text), bytes: Buffer.byteLength(text) }, proofs });
    guard.push({ toolCallId: id, toolName: name, allowed: true });
  };
  const body = expectedBodies[0], ref = 'sr:S' + 'A'.repeat(22);
  const record = { id: owner, kind: 'skill', locator: { type: 'shared_skill', page_id: config.publicCli.target, database_id: config.publicCli.database } };
  const binding = { record, scope, snapshot_id: snapshot, version_id: version, body_sha256: body.sha256, ref: body.binding.ref };
  const content = JSON.stringify({ ok: true, status: 'ready', purpose: 'use', roots: [ref], records: [{ name: 'Owned', kind: 'skill', ref, content: body.text }] });
  const encoded = JSON.stringify(body.text).slice(1, -1), start = content.indexOf('"content":' + JSON.stringify(body.text)) + '"content":"'.length;
  const delivery = { start, end: start + encoded.length, encoding: 'json' }, identity = JSON.stringify(['notion', scope, 'skill', 'shared_skill', owner]);
  add('use-main', 'notion_use', { ref, readOnly: true }, content, { contextBrokerPreparation: { version: 2, toolCallId: 'use-main', purpose: 'use', graphs: [{}],
    records: [{ version: 2, identity, binding, snapshotId: snapshot, bodySha256: body.sha256, bytes: body.bytes, loaded: true, delivery }],
    projection: { version: 1, compiler: 'context-broker/skill-prepare/v1', sourceProjection: 'source-identity/v1', rendered: { sha256: sha(content), bytes: Buffer.byteLength(content) },
      records: [{ index: 0, ref, source: { identity, sha256: body.sha256, bytes: body.bytes }, rendered: { sha256: sha(encoded), bytes: Buffer.byteLength(encoded) }, delivery, state: 'source' }] } } });
  const effects = { version: 1, remote_writes: 'none', author_content: 'unchanged', retention: [] };
  for (const [index, body] of expectedBodies.slice(1).entries()) {
    const id = 'reference-' + index, b = body.binding;
    add(id, 'read', { path: b.ref, readOnly: true }, [{ type: 'text', text: body.text }, { type: 'text', text: '\n\n<notion-effects>' + JSON.stringify(effects) + '</notion-effects>' }],
      { effects, contextBrokerResource: { version: 2, toolCallId: id, id: owner, scope, snapshot_id: snapshot, version_id: version,
        ref: b.ref, path: b.path, file_id: b.file_id, sha256: body.sha256, bytes: body.bytes, loaded: false, delivered_complete_text: true,
        delivery: { start: 0, end: body.text.length, encoding: 'raw' } } });
  }
  add('cli-read', 'bash', { command: cliCommand + ' read original-page --database owned-library --read-only --json --metrics' },
    JSON.stringify({ main: expectedBodies[0].text, reference: expectedBodies[1].text }));
  return { config, payload: { model: 'group/worker', messages }, nativeAudit: { calls }, nativeMessages, tasks, guard,
    approvedCliCalls: ['cli-read'], add,
    inspect() { return candidate.inspectCandidateMaintenancePayload(this.config, { payload: this.payload, nativeAudit: this.nativeAudit,
      nativeText: this.nativeMessages.map(row => JSON.stringify(row)).join('\n') + '\n', tasks: this.tasks, guard: this.guard, approvedCliCalls: this.approvedCliCalls }); } };
}

test('maintenance counts immutable CLI originals separately from exact Broker receipts', () => {
  const fixture = maintenancePayloadFixture(), result = fixture.inspect();
  assert.deepEqual(result.bodies.map(body => [body.total, body.broker, body.cli]), [[2, 1, 1], [2, 1, 1], [1, 1, 0]]);
  assert.deepEqual(result.cliResults.map(result => result.toolCallId), ['cli-read']);
  assert.equal(result.payloadSha256, sha(JSON.stringify(fixture.payload)));
  const original = fixture.payload.messages.find(message => message.tool_call_id === 'cli-read').content;
  assert.equal(original, fixture.nativeMessages.at(-1).message.content[0].text, 'Observation does not rewrite CLI results');
  const value = observed(), counts = candidate.candidatePayloadBodies(fixture.payload, fixture.config.expectedBodies);
  value.costs[0].payload.verifiedBodyOccurrences = counts;
  value.tasks[0].bodies = counts; value.tasks.push(...fixture.tasks);
  result.payloadSha256 = 'payload';
  const checked = validateCandidateTurn(fixture.config, value, { approvedCliCalls: fixture.approvedCliCalls, maintenanceBodies: result });
  assert.equal(checked.maintenanceBodyAccounting.scope, 'broker-plus-unchanged-cli');
  assert.throws(() => validateCandidateTurn({ ...fixture.config, publicCli: undefined }, value, { approvedCliCalls: fixture.approvedCliCalls, maintenanceBodies: result }), /count|occurrence|strictEqual|outside/iu);
});

test('maintenance accounting rejects missing receipts, duplicate Broker bodies and forged or changed CLI origins', () => {
  for (const mutate of [
    value => { value.tasks = value.tasks.filter(row => row.phase !== 'receipt' || row.toolCallId !== 'reference-0'); },
    value => { value.payload.messages.push({ role: 'user', content: value.config.expectedBodies[0].text }); },
    value => { value.payload.messages.push(structuredClone(value.payload.messages.find(row => row.tool_call_id === 'use-main'))); },
    value => { const original = value.nativeMessages.find(row => row.message.toolCallId === 'use-main').message, details = structuredClone(original.details);
      details.contextBrokerPreparation.toolCallId = 'use-again'; value.add('use-again', 'notion_use', { ref: 'sr:S' + 'A'.repeat(22), readOnly: true }, original.content, details); },
    value => { value.payload.messages = value.payload.messages.filter(row => row.tool_call_id !== 'use-main'); },
    value => { value.payload.messages.find(row => row.tool_call_id === 'cli-read').tool_call_id = 'unobserved-cli'; },
    value => { value.payload.messages.find(row => row.tool_call_id === 'cli-read').content += '\nchanged'; },
    value => { value.payload.messages = value.payload.messages.filter(row => row.tool_call_id !== 'cli-read'); },
    value => { value.approvedCliCalls = []; },
    value => { value.payload.messages.find(row => row.tool_calls?.[0].id === 'cli-read').tool_calls[0].function.arguments = '{}'; },
    value => { value.tasks.find(row => row.phase === 'receipt' && row.toolCallId === 'reference-0').proofs.contextBrokerResource.file_id = 'foreign'; },
    value => { value.tasks.find(row => row.phase === 'receipt' && row.toolCallId === 'reference-0').proofs.contextBrokerResource.delivery.end--; },
    value => { value.tasks.find(row => row.phase === 'receipt' && row.toolCallId === 'reference-0').proofs.contextBrokerResource.delivery.end += 0.5; },
    value => { value.config.bodies = []; },
    value => { value.config.bodies[0].receiptRequired = false; },
    value => { value.config.publicCli.mode = 'owned-description-update'; },
    value => { value.payload.input = value.payload.messages; delete value.payload.messages; },
  ]) { const value = maintenancePayloadFixture(); mutate(value); assert.throws(() => value.inspect()); }
});

test('only a guard-registered exact CLI spill read can explain additional body copies', () => {
  const value = maintenancePayloadFixture(), path = '/tmp/pi-bash-' + '1'.repeat(16) + '.log';
  Object.assign(value.nativeMessages.at(-1).message.details, { fullOutputPath: path, truncation: { truncated: true } });
  value.guard.push({ phase: 'public-cli-output', sourceToolCallId: 'cli-read', artifactPath: path, allowed: true });
  value.add('spill-read', 'read', { path }, value.config.expectedBodies[2].text);
  assert.deepEqual(value.inspect().bodies.map(body => [body.total, body.broker, body.cli]), [[2, 1, 1], [2, 1, 1], [2, 1, 1]]);
  value.guard.find(row => row.phase === 'public-cli-output').sourceToolCallId = 'foreign';
  assert.throws(() => value.inspect());
});

test('maintenance resource batches bind every complete span to its frozen file and owner', () => {
  const value = maintenancePayloadFixture(), removed = new Set(['reference-0', 'reference-1']);
  for (const array of [value.nativeMessages, value.nativeAudit.calls, value.tasks, value.guard, value.payload.messages])
    array.splice(0, array.length, ...array.filter(row => !removed.has(row.message?.toolCallId ?? row.toolCallId ?? row.id ?? row.tool_call_id ?? row.tool_calls?.[0].id)));
  const bodies = value.config.expectedBodies.slice(1), files = bodies.map((body, index) => ({ kind: 'text', ref: 'sr:R' + String(index + 1).repeat(22), path: body.binding.path, content: body.text }));
  const content = JSON.stringify({ status: 'ready', files });
  const proof = { version: 2, toolCallId: 'ref-batch', loaded: false,
    selection: { owner: bodies[0].binding.owner, scope: bodies[0].binding.scope, snapshot_id: bodies[0].binding.snapshot_id, version_id: bodies[0].binding.version_id },
    files: bodies.map((body, index) => {
      const encoded = JSON.stringify(body.text).slice(1, -1), start = content.indexOf('"content":' + JSON.stringify(body.text)) + '"content":"'.length;
      return { index, path: body.binding.path, ref: body.binding.ref, model_ref: files[index].ref, file_id: body.binding.file_id, sha256: body.sha256, bytes: body.bytes,
        loaded: false, delivered_complete_text: true, state: 'source', encoding: 'utf8', delivery: { start, end: start + encoded.length, encoding: 'json' } };
    }), projection: { version: 1, compiler: 'context-broker/resource-read/v1', rendered: { sha256: sha(content), bytes: Buffer.byteLength(content) } } };
  value.add('ref-batch', 'read', { paths: bodies.map(body => body.binding.ref), readOnly: true }, content, { contextBrokerResource: proof });
  assert.deepEqual(value.inspect().bodies.map(body => [body.total, body.broker, body.cli]), [[2, 1, 1], [2, 1, 1], [1, 1, 0]]);
  proof.selection.snapshot_id = 's_' + 'f'.repeat(64); assert.throws(() => value.inspect());
});

test('exact body counts exclude tool definitions, details, and call arguments, reject partials, and detect duplicates', () => {
  const payload = { tools: [{ description: body }], messages: [{ role: 'assistant', tool_calls: [{ arguments: body }], details: { body } }, { role: 'tool', content: body }] };
  assert.equal(candidatePayloadBodies(payload, [file])[0].occurrences, 1);
  assert.equal(candidatePayloadBodies({ messages: [{ content: body.slice(0, -1) }] }, [file])[0].occurrences, 0);
  assert.equal(candidatePayloadBodies({ messages: [{ content: body + '\n' + body }] }, [file])[0].occurrences, 2);
  assert.equal(candidatePayloadBodies({ messages: [{ content: JSON.stringify({ content: body }) }] }, [file])[0].occurrences, 1);
});

test('candidate View is explicit, remains in the same source, and cannot leak from a different library', () => {
  const database = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const viewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const original = { sources: [{ id: 'notion', type: 'notion', database, default_view_id: viewId, prefetch: false }] };
  const input = { sourceId: 'notion', database, cacheDir: '/owned/cache' };
  assert.equal(candidateSourceConfig(original, input).sources[0].default_view_id, viewId);
  const selected = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  assert.equal(candidateSourceConfig(original, { ...input, viewId: selected }).sources[0].default_view_id, selected);
  assert.equal(original.sources[0].default_view_id, viewId);
  assert.throws(() => candidateSourceConfig(original, { ...input, database: selected }));
  assert.equal(candidateSourceConfig(original, { ...input, database: selected, viewId }).sources[0].default_view_id, viewId);
  for (const invalid of ['', 'first', null, true]) assert.throws(() => candidateSourceConfig(original, { ...input, viewId: invalid }));
});

test('proof matching cannot combine owner and snapshot from different records', () => {
  const values = [{ owner: 'correct', snapshot: 'wrong' }, { owner: 'wrong', snapshot: 'correct' }];
  assert.equal(containsProof(values, { owner: 'correct', snapshot: 'correct' }), false);
  assert.equal(containsProof(values, { owner: 'correct', snapshot: 'wrong' }), true);
});

function observed() {
  return {
    costs: [{ phase: 'provider_request', payload: { sha256: 'payload', bytes: 100, verifiedBodyOccurrences: [{ sha256: file.sha256, occurrences: 1 }] } }],
    transport: [{ phase: 'request_start', id: 1, category: 'model' }, { phase: 'request_sent', id: 1, requestBodySha256: 'payload', requestBodyBytes: 100 }, { phase: 'request_end', id: 1, category: 'model', status: 200, outcome: 'completed' }],
    tasks: [{ phase: 'provider_payload', sha256: 'payload', bytes: 100, bodies: [{ sha256: file.sha256, occurrences: 1 }] }, { phase: 'receipt', proofs: { one: { owner: 'right', snapshot: 'pin' } } }, { phase: 'assistant_final', success: true, sha256: 'answer', bytes: 10 }],
  };
}

test('a positive verdict binds full body, receipt, final answer, and the actual HTTP payload', () => {
  const turn = { bodies: [{ sha256: file.sha256, occurrences: 1 }], proofs: [{ owner: 'right', snapshot: 'pin' }] };
  assert.equal(validateCandidateTurn(turn, observed()).semanticReview, 'required');
  for (const change of [
    value => { value.transport[1].requestBodySha256 = 'different'; },
    value => { value.transport.at(-1).outcome = 'failure'; },
    value => { value.costs[0].payload.verifiedBodyOccurrences = []; },
    value => { value.tasks[0].bodies[0].occurrences = 2; },
    value => { value.tasks[1].proofs.one.snapshot = 'new-pin'; },
    value => { value.tasks.at(-1).success = false; },
    value => { value.tasks.push({ phase: 'tool_call', executionTool: true }); },
  ]) { const value = observed(); change(value); assert.throws(() => validateCandidateTurn(turn, value)); }
  assert.throws(() => validateCandidateTurn({ ...turn, requireUse: true }, observed()), /notion_use/u);
  const stale = observed();
  stale.tasks.push({ phase: 'tool_call', toolName: 'notion_use', toolCallId: 'new', reviewedReadTool: true },
    { phase: 'tool_result', toolCallId: 'new', isError: true }, { phase: 'receipt', toolCallId: 'old', proofs: { contextBrokerPreparation: { purpose: 'use', toolCallId: 'old' } } });
  assert.throws(() => validateCandidateTurn({ ...turn, requireUse: true }, stale), /notion_use/u);
  assert.equal(validateCandidateTurn({ ...turn, toolCallCount: 0 }, observed()).semanticReview, 'required');
  assert.throws(() => validateCandidateTurn({ ...turn, toolCallCount: 0 }, stale), /frozen turn intent/u);
});

test('only pre-dispatch guarded discovery receives the maintenance read exception', () => {
  const value = observed();
  value.tasks.push({ phase: 'tool_call', toolName: 'notion_ctl', toolCallId: 'cli-scope', executionTool: false, reviewedReadTool: false });
  assert.throws(() => validateCandidateTurn({}, value));
  assert.equal(validateCandidateTurn({}, value, { approvedDiscoveryCalls: ['cli-scope'] }).authorizedMaintenanceDiscoveryCalls, 1);
  value.tasks.at(-1).toolName = 'edit';
  assert.throws(() => validateCandidateTurn({}, value, { approvedDiscoveryCalls: ['cli-scope'] }));
  value.tasks.at(-1).toolName = 'bash'; value.tasks.at(-1).executionTool = true;
  assert.throws(() => validateCandidateTurn({}, value, { approvedDiscoveryCalls: ['cli-scope'] }));
});

test('normal-host transport retains unknown other requests without mistaking them for incomplete model work', () => {
  const events = [
    { phase: 'request_start', id: 1, category: 'model' },
    { phase: 'request_end', id: 1, category: 'model', outcome: 'completed' },
    { phase: 'request_start', id: 2, category: 'other' },
    { phase: 'transport_end', errors: 0, complete: false, incompleteRequestIds: [2] },
  ];
  const original = structuredClone(events);
  assert.deepEqual(candidateTransportCoverage(events), {
    scope: 'selected-model-and-separately-validated-source', allRequestsComplete: false,
    model: { attempts: 1, complete: true }, other: { attempts: 1, complete: false, unknownRequestIds: [2] },
  });
  assert.deepEqual(events, original);
  const pendingModel = structuredClone(events); pendingModel.at(-1).incompleteRequestIds = [1, 2];
  assert.throws(() => candidateTransportCoverage(pendingModel), /selected-model/u);
  const observerError = structuredClone(events); observerError.at(-1).errors = 1;
  assert.throws(() => candidateTransportCoverage(observerError), /observer error/u);
  const unknownId = structuredClone(events); unknownId.at(-1).incompleteRequestIds = [3];
  assert.throws(() => candidateTransportCoverage(unknownId));
});

test('candidate plan is nonexecuting and rejects unfrozen body claims', () => {
  assert.equal(candidatePlan({ version: 1, scope: 'project-scoped-candidate-precheck', turns: [{ id: 'inspect', prompt: 'Original task' }] }).status, 'prepared_not_executed');
  assert.throws(() => candidatePlan({ version: 1, scope: 'project-scoped-candidate-precheck', turns: [{ id: 'inspect', prompt: 'Original task', bodies: [{ sha256: file.sha256, occurrences: 1 }] }] }));
});

test('owned project inspection admits only its finite inventory vocabulary and exact cwd', () => {
  const root = '/private/tmp/notion-candidate-print-abc123';
  for (const command of ['pwd', 'ls -la', 'ls -la ' + root, "ls -la '" + root + "'", 'find . -maxdepth 3 -type f', 'ls -la && pwd && find . -maxdepth 3 -type d -o -type f | head -200'])
    assert.equal(candidateProjectInspection({ command }, root, root), true, command);
  for (const command of ['ls /Users/yoyo/.agents/skills', 'find .. -maxdepth 3 -type f', 'ls -la; pwd', 'pwd || ls', 'ls $(pwd)', 'ls `pwd`', 'ls . > output', 'ls -R', 'find . -maxdepth 5 -type f', 'find . -maxdepth 3 -type f -exec node {} \\;', 'find . -maxdepth 3 -type f | head -301', 'node src/server.mjs', 'npm test', 'ntn-skills read target', 'cat README.md', 'pwd\nls', 'ls -la && pwd && pwd && pwd',
    'ls -L src', 'ls -la src ../..', 'ls -la src test .pi .', 'find . -maxdepth 3 -type f -delete',
    "find . -maxdepth 3 -type f -not -path '../*'", "echo '---FILES---'", "echo '$(id)' && ls", "echo '`id`' && ls",
    "echo 'first' && echo 'second' && ls", "echo '" + 'x'.repeat(41) + "' && ls"])
    assert.equal(candidateProjectInspection({ command }, root, root), false, command);
  assert.equal(candidateProjectInspection({ command: 'pwd' }, '/other', root), false);
  assert.equal(candidateProjectInspection({ command: 'pwd', cwd: root }, root, root), false);
  const handlers = new Map(); guardCandidateProject({ on: (key, handler) => handlers.set(key, handler) }, { projectRoot: root, inspectProject: candidateProjectInspection });
  assert.equal(handlers.get('tool_call')({ toolName: 'bash', input: { command: 'pwd' } }, { cwd: root }), undefined);
  assert.equal(handlers.get('tool_call')({ toolName: 'bash', input: { command: 'npm test' } }, { cwd: root }).block, true);
  assert.equal(handlers.get('tool_call')({ toolName: 'bash', input: { command: 'pwd' } }, { cwd: '/other' }).block, true);
});

// Real final-v6 native SHA e3506e3b2afc25982e3b23533738195c11196b77ecf5ff84b82032f1baaab1cb.
// Each original call was refused before Bash execution. These tests only invoke
// the finite classifier and guard; they do not execute the recorded shell text.
for (const [name, command] of [
  ['bounded filters and a literal marker', "ls -la && find . -maxdepth 3 -type d -not -path '*/node_modules*' -not -path '*/.git*' | head -200 && echo '---FILES---' && find . -maxdepth 3 -type f -not -path '*/node_modules*' -not -path '*/.git*' | head -300"],
  ['file and directory type order', 'find . -maxdepth 4 -type f -o -type d'],
  ['the existing fixture directories', 'ls -la src test .pi'],
]) test('owned inventory admits the prior refused ' + name, () => {
  const root = '/private/tmp/notion-candidate-print-abc123', input = { command, timeout: 15 };
  assert.equal(candidateProjectInspection(input, root, root), true);
  assert.equal(candidateProjectInspection(input, '/other', root), false);
  const handlers = new Map(); guardCandidateProject({ on: (key, handler) => handlers.set(key, handler) }, { projectRoot: root, inspectProject: candidateProjectInspection });
  assert.equal(handlers.get('tool_call')({ toolName: 'bash', input }, { cwd: root }), undefined);
});

test('only the owned project task can classify a hash-bound inventory call separately from script execution', () => {
  const root = '/private/tmp/notion-candidate-print-abc123', input = { command: 'ls -la && pwd && find . -maxdepth 3 -type d -o -type f | head -200' };
  const value = observed(); value.tasks.push({ phase: 'tool_call', toolName: 'bash', executionTool: true, reviewedReadTool: true,
    inputSha256: sha(JSON.stringify(input)), ownedProjectInspection: { root, cwd: root, input } });
  assert.throws(() => validateCandidateTurn({}, value));
  assert.equal(validateCandidateTurn({ project: 'owned-ticket-service' }, value).ownedProjectInspectionToolCalls, 1);
  value.tasks.at(-1).ownedProjectInspection.input.command = 'npm test';
  assert.throws(() => validateCandidateTurn({ project: 'owned-ticket-service' }, value));
});

test('task observer does not transform provider input or register tools/providers', () => {
  const handlers = new Map(), writes = [];
  const fs = { openSync: () => 1, readFileSync: () => Buffer.from(body), writeSync: (_fd, line) => writes.push(JSON.parse(line)), closeSync: () => {} };
  observeCandidateTask({ on(name, fn) { handlers.set(name, fn); } }, { fs, crypto: { createHash }, output: '/owned/task.jsonl', bodyFiles: [file], inspectPayload: candidatePayloadBodies });
  const payload = { messages: [{ content: body }] }, before = structuredClone(payload);
  assert.equal(handlers.get('before_provider_request')({ payload }), undefined); assert.deepEqual(payload, before);
  assert.equal(writes.at(-1).bodies[0].occurrences, 1);
  handlers.get('session_shutdown')({}); assert.equal(writes.at(-1).complete, true);
});

test('normal-management state reuses only the existing process roots and never transfers cleanup or resume ownership', async t => {
  const scratch = await mkdtemp('/tmp/notion-existing-state-proof-');
  t.diagnostic(JSON.stringify({ ownedScratch: [scratch], cleanup: 'Retained for evidence-first system Trash cleanup.' }));
  const roots = { NTN_SKILLS_HOME: '/normal/state/ntn-skills', NTN_SKILLS_CONFIG_HOME: '/normal/config/ntn-skills', NTN_SKILLS_CACHE_HOME: '/normal/cache/ntn-skills' };
  const environment = { XDG_STATE_HOME: '/normal/state', XDG_CONFIG_HOME: '/normal/config', XDG_CACHE_HOME: '/normal/cache' };
  const stateRoot = join(scratch, 'run-owned'), selected = [];
  for (const [index, content] of ['before\n', 'edited\n'].entries()) {
    const snapshot_id = 's_' + sha('snapshot-' + index), file_id = 'file-' + sha('reference');
    const ref = 'skill://owner/references/render.md?snapshot=' + snapshot_id + '&file_id=' + file_id;
    const value = { ok: true, record: { id: 'owner', locator: { database_id: 'owned-database' } }, scope: sha('scope'), snapshot_id,
      version_id: sha('version-' + index), path: 'references/render.md', ref, source: 'local_snapshot', freshness: { policy: 'pinned' },
      content, range: { start: 1, end: 2, total_lines: 2 }, has_more: false,
      file_bindings: [{ path: 'references/render.md', file_id }], effects: { version: 1, remote_writes: 'none', author_content: 'unchanged', retention: [] } };
    const path = join(scratch, 'public-read-' + index + '.json'), bytes = JSON.stringify(value);
    await writeFile(path, bytes, { flag: 'wx' }); selected.push({ path, sha256: sha(bytes), body: { bytes: Buffer.byteLength(content), sha256: sha(content) } });
  }
  const config = { database: 'owned-database', toolCallCount: 2, expectedBodies: selected.map(value => value.body),
    existingState: { mode: 'normal-management', roots, managementReads: selected.map(({ path, sha256 }) => ({ path, sha256 })) } };
  const options = { stateRoot, environment, home: '/normal/home' };
  const before = await Promise.all(selected.map(value => readFile(value.path)));
  const normal = await candidate.prepareCandidatePrintState({ ...config, arm: 'normal' }, options);
  const isolated = await candidate.prepareCandidatePrintState({ ...config, arm: 'notion-only' }, options);
  assert.deepEqual(normal, isolated); assert.deepEqual(normal.sourceState.roots, roots);
  assert.equal(normal.sourceState.ownership, 'existing-user'); assert.equal(normal.sourceState.mode, 'normal-management');
  assert.equal(normal.stateRoot, stateRoot); assert.deepEqual(normal.ownedPaths, [stateRoot]);
  assert.deepEqual(normal.env, { ...roots, NTN_SKILLS_DATA_HOME: join(stateRoot, 'ntn/data') });
  assert.equal(normal.sourceState.reads.length, 2);
  const fresh = await candidate.prepareCandidatePrintState({}, options);
  assert.equal(fresh.sourceState, undefined); assert.equal(fresh.env.NTN_SKILLS_HOME, join(stateRoot, 'ntn/state'));
  assert.equal(fresh.env.NTN_SKILLS_CONFIG_HOME, join(stateRoot, 'ntn/config')); assert.equal(fresh.env.NTN_SKILLS_CACHE_HOME, join(stateRoot, 'ntn/cache'));
  await assert.rejects(candidate.prepareCandidatePrintState({ ...config, existingState: { ...config.existingState, roots: { ...roots, NTN_SKILLS_HOME: '/replacement' } } }, options));
  await assert.rejects(candidate.prepareCandidatePrintState(config, { ...options, environment: { ...environment, NTN_SKILLS_HOME: '/different-current-root' } }));
  await assert.rejects(candidate.prepareCandidatePrintState(config, { ...options, stateRoot: '/normal' }));
  await assert.rejects(candidate.prepareCandidatePrintState({ ...config, resumeFrom: { path: '/old/result.json', sha256: sha('old') } }, options));
  await assert.rejects(candidate.prepareCandidatePrintState({}, { ...options, previous: { stateRoot, sourceState: normal.sourceState } }));
  await assert.rejects(candidate.prepareCandidatePrintState({ ...config, publicCli: { mode: 'original-create-recovery' } }, options));
  const wrongReceipt = structuredClone(config); wrongReceipt.existingState.managementReads[0].sha256 = sha('changed receipt');
  await assert.rejects(candidate.prepareCandidatePrintState(wrongReceipt, options));
  assert.deepEqual(await Promise.all(selected.map(value => readFile(value.path))), before);
});

test('existing-state reads block unintended tools before execution and require actual complete none-effects results', () => {
  const refs = ['skill://owner/references/render.md?snapshot=old', 'skill://owner/references/render.md?snapshot=edited'];
  const handlers = new Map(), rows = [];
  let writeFails = false;
  const fs = { openSync: () => 1, writeSync: (_fd, line) => { if (writeFails) throw new Error('receipt unavailable'); rows.push(JSON.parse(line)); }, closeSync: () => {} };
  candidate.guardCandidateExistingReads({ on: (name, fn) => handlers.set(name, fn) }, { fs, output: '/owned/guard.jsonl', refs, review: candidate.reviewCandidatePinnedRead });
  const invoke = (toolName, input, toolCallId = 'rejected') => handlers.get('tool_call')({ toolName, input, toolCallId });
  for (const [toolName, input] of [
    ['notion_use', { ref: refs[0], readOnly: true }], ['bash', { command: 'pwd' }],
    ['read', { path: refs[0] }], ['read', { path: refs[0], readOnly: false }], ['read', { paths: refs, readOnly: true }],
    ['read', { path: refs[0], readOnly: true, limit: 1 }], ['read', { path: '/private/oracle', readOnly: true }],
  ]) assert.equal(invoke(toolName, input).block, true);
  const input = { path: refs[0], readOnly: true }, original = structuredClone(input);
  writeFails = true; assert.equal(invoke('read', input).block, true); writeFails = false;
  assert.equal(invoke('read', input, 'old'), undefined); assert.deepEqual(input, original);
  assert.equal(invoke('read', input).block, true);
  assert.equal(invoke('read', { path: refs[1], readOnly: true }, 'edited'), undefined);
  handlers.get('session_shutdown')(); assert.equal(rows.at(-1).complete, true);
  const reads = refs.map((ref, index) => ({ ref, id: 'owner', scope: sha('scope'), snapshot_id: 'snapshot-' + index,
    version_id: 'version-' + index, path: 'references/render.md', file_id: 'file', bytes: 7, sha256: sha('body-' + index), characters: 7 }));
  const calls = reads.map((read, index) => ({ id: index ? 'edited' : 'old', name: 'read', arguments: { path: read.ref, readOnly: true }, isError: false }));
  const native = reads.map((read, index) => ({ type: 'message', message: { role: 'toolResult', toolName: 'read', toolCallId: calls[index].id, isError: false,
    details: { effects: { version: 1, remote_writes: 'none', author_content: 'unchanged', retention: [] },
      contextBrokerResource: { ...read, version: 2, toolCallId: calls[index].id, delivery: { start: 0, end: 7, encoding: 'raw' }, delivered_complete_text: true, loaded: false } } } }));
  const audit = { calls, retractedCalls: [], errors: [] }, sourceState = { reads };
  const approved = rows.filter(row => row.allowed === true).concat(rows.at(-1));
  assert.equal(candidate.inspectCandidateExistingReads(sourceState, audit, jsonl(native), approved).reads, 2);
  for (const effects of [undefined, { version: 1, remote_writes: 'unknown', author_content: 'unchanged', retention: [] }]) {
    const changed = structuredClone(native); changed[0].message.details.effects = effects;
    assert.throws(() => candidate.inspectCandidateExistingReads(sourceState, audit, jsonl(changed), approved));
  }
  const changed = structuredClone(native); changed[0].message.details.contextBrokerResource.snapshot_id = 'another-pin';
  assert.throws(() => candidate.inspectCandidateExistingReads(sourceState, audit, jsonl(changed), approved));
  assert.throws(() => candidate.inspectCandidateExistingReads(sourceState, audit, jsonl(native), rows));
});

test('paused target audit can resume its original run and report, without replacing scope or counters', () => {
  const value = auditGuard(), rows = [], calls = [];
  const submit = (id, command, report, exit = 0) => {
    assert.equal(value.call(command, id), undefined);
    const event = { role: 'toolResult', toolName: 'bash', toolCallId: id, isError: exit !== 0,
      content: [{ type: 'text', text: JSON.stringify(report) + (exit ? '\n\nCommand exited with code ' + exit : '') }] };
    rows.push({ type: 'message', message: event });
    calls.push({ id, name: 'bash', arguments: { command }, callLine: calls.length * 2 + 1,
      resultLine: calls.length * 2 + 2, resultSha256: sha(JSON.stringify(event.content)) });
    value.handlers.get('tool_result')(event);
  };
  const paused = { ...auditReportFixture(), execution: 'paused', request_totals: { attempts: 3, request_bytes: 20, response_bytes: 30, elapsed_ms: 12, invocations: 1 },
    next: { state: 'audit_paused', read_only: true, argv: ['ntn-skills', 'ctl', 'audit', 'resume', auditRunId] } };
  submit('audit-1', auditCommand, paused, 75);
  const resume = cliCommand + ' ctl audit resume ' + auditRunId + ' --entry owned-library --max-requests 20 --duration-ms 1000';
  submit('resume-1', resume, { ...auditReportFixture(), request_totals: { attempts: 5, request_bytes: 40, response_bytes: 60, elapsed_ms: 20, invocations: 2 } }, 4);
  assert.equal(value.call(cliCommand + ' ctl audit report ' + auditRunId, 'report'), undefined);
  assert.equal(value.call(cliCommand + ' ctl audit resume ' + auditRunId, 'no-longer-paused').block, true);
  const bindings = candidate.inspectCandidateAuditReportBindings(maintenanceCli, { calls }, jsonl(rows), value.records, () => { throw new Error('No spill'); });
  assert.deepEqual(bindings.map(row => row.execution), ['paused', 'completed']);
});

test('paused audit authorizes only its observed read-only next, not another run, scope or budget', () => {
  const value = auditGuard(); value.call(auditCommand, 'audit-1');
  const report = { ...auditReportFixture(), execution: 'paused',
    next: { read_only: true, argv: ['ntn-skills', 'ctl', 'audit', 'resume', auditRunId] } };
  value.handlers.get('tool_result')({ toolName: 'bash', toolCallId: 'audit-1', isError: true,
    content: [{ type: 'text', text: JSON.stringify(report) + '\n\nCommand exited with code 75' }] });
  const resume = cliCommand + ' ctl audit resume ' + auditRunId;
  for (const command of [resume.replace(auditRunId, 'audit-00000000-0000-0000-0000-000000000000'),
    resume + ' --entry other-library', resume + ' --target another-page', resume + ' --all',
    resume + ' --max-requests 501', resume + ' --max-bytes 67108865', resume + ' --duration-ms 120001',
    cliCommand + ' ctl operation resume ' + auditRunId])
    assert.equal(value.call(command, 'deny-' + command).block, true, command);
  assert.equal(auditGuard().call(resume, 'foreign-session').block, true);
  assert.equal(value.call(resume, 'resume-ok'), undefined);
  assert.equal(value.call(resume, 'pending-original').block, true);
});

test('failed execution remains reportable but is not a completed audit or a resume authorization', () => {
  const value = auditGuard(); value.call(auditCommand, 'audit-1');
  value.handlers.get('tool_result')({ toolName: 'bash', toolCallId: 'audit-1', isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ...auditReportFixture(), execution: 'execution_failed' }) + '\n\nCommand exited with code 1' }] });
  assert.equal(value.call(cliCommand + ' ctl audit report ' + auditRunId, 'report-failure'), undefined);
  assert.equal(value.records.find(row => row.phase === 'public-cli-audit-report').execution, 'execution_failed');
  assert.equal(value.call(cliCommand + ' ctl audit resume ' + auditRunId, 'resume-failure').block, true);
});

test('a resumed result cannot substitute a run or reset its cumulative accounting', () => {
  for (const mutation of ['other-run', 'reset']) {
    const value = auditGuard(); value.call(auditCommand, 'audit-1');
    const totals = { attempts: 10, request_bytes: 20, response_bytes: 30, elapsed_ms: 40, invocations: 1 };
    const paused = { ...auditReportFixture(), execution: 'paused', request_totals: totals,
      next: { read_only: true, argv: ['ntn-skills', 'ctl', 'audit', 'resume', auditRunId] } };
    const result = (id, report) => value.handlers.get('tool_result')({ toolName: 'bash', toolCallId: id, isError: true,
      content: [{ type: 'text', text: JSON.stringify(report) + '\n\nCommand exited with code 75' }] });
    result('audit-1', paused);
    assert.equal(value.call(cliCommand + ' ctl audit resume ' + auditRunId, 'resume-1'), undefined);
    const next = { ...auditReportFixture(), request_totals: { ...totals, attempts: mutation === 'reset' ? 1 : 11 } };
    if (mutation === 'other-run') { next.run_id = 'audit-00000000-0000-0000-0000-000000000000'; next.next = { ...next.next, argv: ['ntn-skills', 'ctl', 'audit', 'report', next.run_id] }; }
    result('resume-1', next);
    assert.equal(value.call(cliCommand + ' ctl audit report ' + auditRunId, 'after-invalid').block, true);
    assert.equal(value.records.filter(row => row.phase === 'public-cli-audit-report').length, 1);
  }
});
