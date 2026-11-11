import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, symlink, link } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as candidate from './verify-pi-daily-candidate.mjs';
import { createOwnedGraphProject, exerciseReviewedGeneratedHelper } from './notion-skill-graph-project.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const skill = '---\nname: verify-ticket\ndescription: Verify the owned ticket service.\n---\n\n# Verify\n\n[Procedure](references/guide.md)\n[Helper](scripts/check.mjs)\n';
const helper = "import assert from 'node:assert/strict';\nimport { makeServer } from '../../src/tickets.mjs';\nconst server = makeServer();\nawait new Promise(resolve => server.listen(0, '127.0.0.1', resolve));\ntry {\n const origin = 'http://127.0.0.1:' + server.address().port;\n const created = await fetch(origin + '/tickets', { method: 'POST', body: JSON.stringify({ subject: 'Artifact exercise' }) });\n assert.equal(created.status, 201);\n const ticket = await created.json();\n assert.deepEqual(await (await fetch(origin + '/tickets/' + ticket.id)).json(), ticket);\n assert.equal((await fetch(origin + '/tickets', { method: 'POST', body: '{}' })).status, 400);\n console.log(JSON.stringify({ created: 201, retrieved: ticket.subject, invalid: 400 }));\n} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }\n";

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/notion-candidate-artifacts-');
  const evidence = await mkdtemp('/private/tmp/notion-artifact-proof-');
  const projectRoot = await mkdtemp('/private/tmp/notion-candidate-print-');
  const project = await createOwnedGraphProject(projectRoot);
  const stat = fs.statSync(root);
  const policy = { root, dev: stat.dev, ino: stat.ino, projectFiles: project.files.map(file => file.path) };
  t.diagnostic(JSON.stringify({ ownedScratch: [root, evidence, projectRoot], cleanup: 'Retained for evidence-first system Trash cleanup.' }));
  const handlers = new Map(), ledger = join(evidence, 'artifact-guard.jsonl');
  const guard = new Function('return (' + candidate.guardCandidateArtifacts.toString() + ');')();
  guard({ on: (name, fn) => handlers.set(name, fn) }, { fs, crypto: { createHash }, output: ledger,
    policy, projectRoot, inspectProject: candidate.candidateProjectInspection, reviewPath: candidate.reviewCandidateArtifactPath });
  const calls = [];
  const write = async (path, content) => {
    const input = { path: join(root, path), content }, id = 'write-' + calls.length;
    assert.equal(handlers.get('tool_call')({ toolName: 'write', toolCallId: id, input }, { cwd: projectRoot }), undefined);
    await mkdir(dirname(input.path), { recursive: true }); await writeFile(input.path, content);
    handlers.get('tool_result')({ toolName: 'write', toolCallId: id, input, isError: false });
    calls.push({ id, name: 'write', arguments: input, isError: false });
  };
  return { root, evidence, projectRoot, project, policy, handlers, ledger, calls, write,
    rows: async () => (await readFile(ledger, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('file delivery is default-off and restricted to a fresh owned project task', () => {
  assert.equal(candidate.candidateArtifactOutputEnabled({}), false);
  assert.equal(candidate.candidateArtifactOutputEnabled({ artifactOutput: false }), false);
  const config = { artifactOutput: true, project: 'owned-ticket-service' };
  assert.equal(candidate.candidateArtifactOutputEnabled(config), true);
  for (const value of [0, 'true', {}, null]) assert.throws(() => candidate.candidateArtifactOutputEnabled({ ...config, artifactOutput: value }));
  for (const change of [{ project: undefined }, { resumeFrom: {} }, { publicCli: {} }, { existingState: {} }, { forkIntroductionResume: true }])
    assert.throws(() => candidate.candidateArtifactOutputEnabled({ ...config, ...change }));
  assert.equal(candidate.candidateArtifactPrompt('Original task'), 'Original task');
  const prompt = candidate.candidateArtifactPrompt('Original task', '/private/tmp/notion-candidate-artifacts-Ab1234');
  assert.ok(prompt.startsWith('Original task\n\n')); assert.ok(prompt.includes('/private/tmp/notion-candidate-artifacts-Ab1234'));
  assert.ok(!/oracle|poteto|create-verification-skill|skill:\/\//u.test(prompt));
});

test('native write/edit retain the exact authorized file and native call identities', async t => {
  const f = await fixture(t);
  await f.write('verification/SKILL.md', skill);
  const input = { path: join(f.root, 'verification/SKILL.md'), oldText: '# Verify', newText: '# Verify tickets' };
  assert.equal(f.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'edit-1', input }, { cwd: f.projectRoot }), undefined);
  await writeFile(input.path, skill.replace(input.oldText, input.newText));
  f.handlers.get('tool_result')({ toolName: 'edit', toolCallId: 'edit-1', input, isError: false });
  f.calls.push({ id: 'edit-1', name: 'edit', arguments: input, isError: false });
  f.handlers.get('session_shutdown')();
  const files = await candidate.retainCandidateArtifactFiles({ policy: f.policy, evidence: f.evidence });
  assert.equal(files.files[0].sha256, sha(skill.replace(input.oldText, input.newText)));
  assert.equal(await readFile(join(f.evidence, files.files[0].evidencePath), 'utf8'), skill.replace(input.oldText, input.newText));
  const rows = await f.rows();
  assert.deepEqual(candidate.inspectCandidateArtifactGuard({ calls: f.calls }, rows, files), ['write-0', 'edit-1']);
  const changed = structuredClone(f.calls); changed[0].arguments.content += 'changed';
  assert.throws(() => candidate.inspectCandidateArtifactGuard({ calls: changed }, rows, files));
  const drift = structuredClone(files); drift.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => candidate.inspectCandidateArtifactGuard({ calls: f.calls }, rows, drift));
});

test('file guard rejects source, evidence, Store, traversal, aliases, symlinks and hard links before execution', async t => {
  const f = await fixture(t);
  const external = join(f.evidence, 'external.md'); await writeFile(external, 'outside\n');
  await symlink(f.evidence, join(f.root, 'escape'));
  await mkdir(join(f.root, 'links')); await link(external, join(f.root, 'links/hard.md'));
  await symlink(external, join(f.root, 'links/sym.md'));
  for (const path of [join(f.projectRoot, 'src/tickets.mjs'), external, '/Users/yoyo/.local/state/ntn-skills/Store/object',
    f.root + '-other/verification/SKILL.md', f.root + '/../outside.md', f.root + '/verification/../other.md',
    f.root + '//verification/SKILL.md', join(f.root, 'src/tickets.mjs'), join(f.root, '.pi/settings.json'),
    join(f.root, '.git/config'), join(f.root, 'node_modules/pkg/index.js'), join(f.root, 'escape/payload.md'),
    join(f.root, 'links/hard.md'), join(f.root, 'links/sym.md'), join(f.root, 'links'), 'verification/SKILL.md']) {
    assert.equal(f.handlers.get('tool_call')({ toolName: 'write', toolCallId: path, input: { path, content: 'blocked\n' } }, { cwd: f.projectRoot }).block, true, path);
  }
  for (const toolName of ['execute', 'codemode', 'powershell', 'apply_patch', 'notion_ctl', 'delegate'])
    assert.equal(f.handlers.get('tool_call')({ toolName, toolCallId: toolName, input: {} }, { cwd: f.projectRoot }).block, true);
  assert.equal(f.handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'shell', input: { command: 'node src/server.mjs' } }, { cwd: f.projectRoot }).block, true);
  assert.equal(await readFile(external, 'utf8'), 'outside\n');
  assert.equal(sha(await readFile(join(f.projectRoot, 'src/tickets.mjs'))), f.project.files.find(file => file.path === 'src/tickets.mjs').sha256);
  f.handlers.get('session_shutdown')();
  await assert.rejects(() => candidate.retainCandidateArtifactFiles({ policy: f.policy, evidence: f.evidence }), /symlink|ordinary|link/u);
});

test('file delivery keeps Notion consumption strict and ordinary project inventory read-only', async t => {
  const f = await fixture(t), call = (toolName, input) => f.handlers.get('tool_call')({ toolName, input, toolCallId: JSON.stringify(input) }, { cwd: f.projectRoot });
  assert.equal(call('read', { path: 'README.md' }), undefined);
  assert.equal(call('bash', { command: 'pwd && ls -la src test .pi' }), undefined);
  assert.equal(call('notion_list', { query: 'verification' }), undefined);
  for (const [name, input] of [['read', { path: 'skill://issued/SKILL.md' }], ['read', { paths: ['sr:Rissued'] }], ['notion_use', { ref: 'sr:Cissued' }]]) {
    assert.equal(call(name, input).block, true);
    assert.equal(call(name, { ...input, readOnly: true }), undefined);
  }
  f.handlers.get('session_shutdown')();
});

test('a guard ledger failure blocks writes instead of escaping through host catch-and-continue', () => {
  const handlers = new Map();
  candidate.guardCandidateArtifacts({ on: (name, fn) => handlers.set(name, fn) }, { fs: { openSync: () => { throw new Error('read-only ledger'); } },
    crypto: { createHash }, output: '/no-ledger', policy: { root: '/private/tmp/notion-candidate-artifacts-Ab1234' }, reviewPath: () => { throw new Error('must not run'); } });
  assert.equal(handlers.get('tool_call')({ toolName: 'write', toolCallId: 'blocked', input: { path: '/any', content: 'x' } }, {}).block, true);
});

test('complete native files use the existing independently reviewed helper exercise without treating files as final success', async t => {
  const f = await fixture(t);
  await f.write('verification/SKILL.md', skill);
  await f.write('verification/references/guide.md', '# Procedure\n\nLaunch, doctor, one feature, evidence and owned cleanup remain required.\n');
  await f.write('verification/scripts/check.mjs', helper);
  f.handlers.get('session_shutdown')();
  const files = await candidate.retainCandidateArtifactFiles({ policy: f.policy, evidence: f.evidence });
  candidate.inspectCandidateArtifactGuard({ calls: f.calls }, await f.rows(), files);
  const final = { success: true, stopReason: 'stop', text: 'Three complete files written. Independent exercise is still required.\n' };
  for (const invalid of [undefined, { ...final, success: false }, { ...final, stopReason: 'length' }, { ...final, text: '' }])
    await assert.rejects(() => candidate.retainCandidateFilePlan({ evidence: f.evidence, project: f.project, final: invalid, prompt: { sha256: sha('task') }, artifactFiles: files }));
  const generatedPlan = await candidate.retainCandidateFilePlan({ evidence: f.evidence, project: f.project, final, prompt: { sha256: sha('task') }, artifactFiles: files });
  assert.equal(generatedPlan.artifactStatus, 'complete-skill-files-retained'); assert.equal(generatedPlan.executed, false);
  assert.equal(generatedPlan.delivery.mode, 'owned-files'); assert.equal(generatedPlan.delivery.nativeFinal.sha256, sha(final.text));
  assert.notEqual(generatedPlan.sha256, sha(final.text));
  assert.equal(await readFile(generatedPlan.delivery.nativeFinal.path, 'utf8'), final.text);
  assert.ok((await readFile(generatedPlan.path, 'utf8')).includes(JSON.stringify(final.text)));
  assert.deepEqual(generatedPlan.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), files.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
  const result = { status: 'passed', evidence: f.evidence, project: f.project, generatedPlan };
  const source = JSON.stringify(result) + '\n'; await writeFile(join(f.evidence, 'result.json'), source);
  const reviewRoot = await mkdtemp('/private/tmp/notion-artifact-review-'); t.diagnostic(JSON.stringify({ ownedScratch: [reviewRoot] }));
  const entry = generatedPlan.files.find(file => file.path.endsWith('/check.mjs'));
  const review = { version: 1, purpose: 'generated-helper-exercise', reviewer: 'controlled artifact-route test', approvedForOwnedExercise: true,
    parent: { evidence: f.evidence, resultSha256: sha(source), planSha256: generatedPlan.sha256, projectSha256: f.project.sha256,
      files: generatedPlan.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) },
    entry: { path: entry.path, sha256: entry.sha256 }, command: { executable: fs.realpathSync(process.execPath), args: [entry.path] },
    budget: { timeoutMs: 20000, killGraceMs: 1000 } };
  const reviewPath = join(reviewRoot, 'review.json'); await writeFile(reviewPath, JSON.stringify(review) + '\n');
  const execution = await exerciseReviewedGeneratedHelper(f.evidence, reviewPath);
  assert.equal(execution.status, 'completed'); assert.equal(execution.productAcceptance.status, 'independent-review-required');
  const stdout = await readFile(join(execution.evidence, 'helper.stdout.log'), 'utf8');
  assert.deepEqual(JSON.parse(stdout), { created: 201, retrieved: 'Artifact exercise', invalid: 400 });
  t.diagnostic(JSON.stringify({ exerciseEvidence: execution.evidence, exerciseScratch: execution.scratch }));
});

test('file snapshots retain incomplete bytes but cannot silently normalize them into a complete plan', async t => {
  const f = await fixture(t); await f.write('verification/SKILL.md', skill.trimEnd()); await f.write('verification/scripts/check.mjs', helper); f.handlers.get('session_shutdown')();
  const files = await candidate.retainCandidateArtifactFiles({ policy: f.policy, evidence: f.evidence });
  assert.equal(files.files.find(file => file.path === 'verification/SKILL.md').sha256, sha(skill.trimEnd()));
  await assert.rejects(() => candidate.retainCandidateFilePlan({ evidence: f.evidence, project: f.project,
    final: { success: true, stopReason: 'stop', text: 'Finished.' }, prompt: { sha256: sha('task') }, artifactFiles: files }), /newline|LF/u);
  assert.equal(await readFile(join(f.evidence, 'native-artifact-final.md'), 'utf8'), 'Finished.');
  assert.equal(JSON.parse(await readFile(join(f.evidence, 'native-artifact-final.json'), 'utf8')).sha256, sha('Finished.'));
});

test('artifact approval IDs cannot bypass default read-only validation or authorize shell execution', () => {
  const observed = { costs: [{ phase: 'provider_request', payload: { sha256: 'payload', bytes: 100, verifiedBodyOccurrences: [] } }],
    transport: [{ phase: 'request_start', id: 1, category: 'model' }, { phase: 'request_sent', id: 1, requestBodySha256: 'payload', requestBodyBytes: 100 },
      { phase: 'request_end', id: 1, category: 'model', status: 200, outcome: 'completed' }],
    tasks: [{ phase: 'provider_payload', sha256: 'payload', bytes: 100, bodies: [] },
      { phase: 'tool_call', toolName: 'write', toolCallId: 'owned-write', reviewedReadTool: false, executionTool: false },
      { phase: 'assistant_final', success: true, sha256: 'final', bytes: 5 }] };
  const turn = { artifactOutput: true, project: 'owned-ticket-service' }, approved = { approvedArtifactCalls: ['owned-write'] };
  assert.throws(() => candidate.validateCandidateTurn(turn, observed));
  assert.throws(() => candidate.validateCandidateTurn({}, observed, approved));
  assert.throws(() => candidate.validateCandidateTurn(turn, observed, { approvedArtifactCalls: ['unknown'] }));
  assert.equal(candidate.validateCandidateTurn(turn, observed, approved).ownedArtifactWriteToolCalls, 1);
  const shell = structuredClone(observed); shell.tasks[1].toolName = 'bash'; shell.tasks[1].executionTool = true;
  assert.throws(() => candidate.validateCandidateTurn(turn, shell, approved));
});

test('a successful final cannot promote a missing referenced file to a complete generated Skill', async t => {
  const f = await fixture(t); await f.write('verification/SKILL.md', skill); await f.write('verification/scripts/check.mjs', helper);
  f.handlers.get('session_shutdown')();
  const files = await candidate.retainCandidateArtifactFiles({ policy: f.policy, evidence: f.evidence });
  await assert.rejects(() => candidate.retainCandidateFilePlan({ evidence: f.evidence, project: f.project,
    final: { success: true, stopReason: 'stop', text: 'Files ready.' }, prompt: { sha256: sha('task') }, artifactFiles: files }), /Missing Skill or referenced/u);
  const receipt = JSON.parse(await readFile(join(f.evidence, 'generated-plan.json'), 'utf8'));
  assert.equal(receipt.artifactStatus, 'incomplete-generated-files'); assert.equal(receipt.executed, false);
  assert.equal(await readFile(join(f.evidence, 'native-artifact-final.md'), 'utf8'), 'Files ready.');
});
