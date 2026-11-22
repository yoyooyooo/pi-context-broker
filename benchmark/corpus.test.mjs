import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat, realpath, rename, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus, validateCorpus, planCaseVariant, materializeLocal, buildFixtureRecipe,
  bindPublicCaseToFixture, verifyMaterialization, writeCorpus, sealCorpus, openCorpus,
  auditVisibleMaterial, gradeEpisode, FAMILY_COUNTS, JOURNEYS, rebindCorpusCatalog } from './corpus/index.mjs';
import { corpusFile, hashBytes, buildJourney } from './corpus/materials.mjs';
import { fingerprint } from './protocol.mjs';
import { planAgentFixturePreparation } from '../scripts/notion-agent-fixtures.mjs';

const corpus = buildCorpus({ seed: 'corpus-tests-20261122', split: 'development' });
const temp = await mkdtemp(join(await realpath(tmpdir()), 'benchmark-corpus-test-'));
// These owned directories are retained for evidence inspection. Cleanup uses system Trash,
// not recursive deletion; CI runners discard their own temporary filesystem after the job.
const caps = ['workspace-files', 'skill-content', 'resource-read'];
const complete = { artifacts: 'complete', selections: 'complete', resource_reads: 'complete', clarifications: 'complete', state_events: 'complete' };
function select(caseId, extras = {}) { return planCaseVariant({ ...corpus, caseId, ...extras }); }
function artifact(path, value, id = 'artifact-1') {
  const content = JSON.stringify(value);
  return { path, content, sha256: hashBytes(content), evidence_id: id };
}
function actualReads(skill, paths) {
  return paths.map(path => {
    const file = skill.versions.v1.files.find(file => file.path === path);
    return { skill_id: skill.id, path, sha256: hashBytes(Buffer.from(file.content, file.encoding)), evidence_id: 'read-' + skill.id + '-' + path };
  });
}
function plainOracle(contracts, caseId = 'outside-batch-case') {
  return { schema_version: 1, case_id: caseId, capability_scope: 'common', required_capabilities: ['workspace-files'], contracts };
}
const business = { id: 'deliverable', kind: 'artifact-json', critical: true, path: 'output/result.json',
  comparison: 'rows-by-key', row_key: 'id', expected: [{ id: 'fresh', score: 17 }] };

test('public generator produces 20 journeys, 40 distinct materials and ten fixed-weight families', () => {
  assert.deepEqual(validateCorpus(corpus), { status: 'valid', case_count: 40, skill_count: 296 });
  assert.equal(new Set(corpus.publicCorpus.cases.map(item => item.journey_id)).size, 20);
  assert.equal(new Set(corpus.publicCorpus.cases.map(item => item.cluster_id)).size, 20);
  assert.equal(new Set(corpus.publicCorpus.cases.map(item => item.material_id)).size, 40);
  assert.equal(new Set(corpus.publicCorpus.cases.map(item => item.seed)).size, 40);
  for (const [family, count] of Object.entries(FAMILY_COUNTS))
    assert.equal(corpus.publicCorpus.cases.filter(item => item.family === family).length, count * 2);
  assert.ok(corpus.publicCorpus.families.every(item => item.weight === 0.1));
  for (const item of corpus.publicCorpus.cases) {
    assert.equal(item.catalog.skill_ids.length, 16);
    assert.ok(item.turns.every(turn => /[\u4e00-\u9fff]/.test(turn.prompt)));
    assert.equal(item.license, 'CC0-1.0');
    assert.ok(!Object.hasOwn(item, 'oracle') && !Object.hasOwn(item, 'expected'));
  }
});

test('same seed reproduces public bytes; independent batches and splits do not reuse material identities', () => {
  assert.deepEqual(buildCorpus({ seed: 'corpus-tests-20261122' }).publicCorpus, corpus.publicCorpus);
  const pilot = buildCorpus({ seed: 'independent-pilot-20261122', split: 'pilot' });
  const confirmation = buildCorpus({ seed: 'independent-confirmation-20261122', split: 'confirmation' });
  for (let i = 0; i < 40; i++) {
    assert.notEqual(pilot.publicCorpus.cases[i].seed, corpus.publicCorpus.cases[i].seed);
    assert.notEqual(confirmation.publicCorpus.cases[i].seed, pilot.publicCorpus.cases[i].seed);
    assert.notEqual(confirmation.publicCorpus.cases[i].material_id, pilot.publicCorpus.cases[i].material_id);
  }
  for (const journey of new Set(corpus.publicCorpus.cases.map(item => item.journey_id))) {
    const pair = corpus.publicCorpus.cases.filter(item => item.journey_id === journey);
    assert.notEqual(fingerprint(pair[0].attachments), fingerprint(pair[1].attachments));
    assert.equal(pair[0].cluster_id, pair[1].cluster_id);
  }
});

test('anchor variants have exact unique candidate counts and actual independent turn inputs', () => {
  for (const candidateCount of [16, 64, 256]) for (const roundCount of [1, 2, 4, 8]) {
    const plan = select('implicit-01-a', { candidateCount, roundCount });
    assert.equal(plan.skills.length, candidateCount);
    assert.equal(new Set(plan.skills.map(skill => skill.id)).size, candidateCount);
    assert.equal(plan.publicCase.turns.length, roundCount);
    assert.equal(plan.publicCase.attachments.length, roundCount);
    assert.equal(plan.oracle.contracts.filter(contract => contract.kind === 'artifact-json').length, roundCount);
  }
  assert.throws(() => select('explicit-01-a', { candidateCount: 64 }), /not registered/);
  assert.throws(() => select('implicit-01-a', { roundCount: 3 }), /not registered/);
  const first = select('no-skill-01-a').skills.map(skill => skill.id);
  const second = select('no-skill-02-b').skills.map(skill => skill.id);
  assert.deepEqual(new Set(first), new Set(second), 'Read-only distractor pool should be reusable across cases');
});

test('all forty public local fixtures retain complete bytes, modes and a clean visibility inventory', async () => {
  for (const item of corpus.publicCorpus.cases) {
    const receipt = await materializeLocal({ publicCorpus: corpus.publicCorpus, targetRoot: join(temp, 'forty', item.id), caseId: item.id });
    assert.equal(receipt.contains_private_control, false);
    for (const file of receipt.inventory) {
      assert.equal(hashBytes(await readFile(file.path)), file.sha256);
      assert.equal(Boolean((await lstat(file.path)).mode & 0o111), file.mode === '100755');
    }
    const audited = await auditVisibleMaterial({ roots: [receipt.target_root], canaries: corpus.control.canaries });
    assert.equal(audited.status, 'valid');
    assert.ok(audited.files.every(file => !/oracle|control\.json|corpus\.json/.test(file.path)));
  }
});

test('writer keeps private control outside public and repository trees and can repeat unchanged writes', async () => {
  const args = { corpus, publicRoot: join(temp, 'saved-public'), controlRoot: join(temp, 'saved-control') };
  const written = await writeCorpus(args);
  assert.deepEqual(await writeCorpus(args), written);
  const control = JSON.parse(await readFile(written.control_path, 'utf8'));
  assert.equal(control.canaries[0].value, corpus.control.canaries[0].value);
  const audit = await auditVisibleMaterial({ roots: [args.publicRoot], canaries: control.canaries, forbiddenPaths: [args.controlRoot] });
  assert.equal(audit.status, 'valid');
  await assert.rejects(writeCorpus({ corpus, publicRoot: join(temp, 'bad'), controlRoot: join(temp, 'bad', 'inside') }), /disjoint/);
  await assert.rejects(writeCorpus({ corpus, publicRoot: join(temp, 'public-repo-rejection'), controlRoot: resolve(fileURLToPath(new URL('./corpus/private', import.meta.url))) }), /outside the repository/);
});

test('visibility audit catches an intentionally copied private canary without revealing its value', async () => {
  const receipt = await materializeLocal({ publicCorpus: corpus.publicCorpus, targetRoot: join(temp, 'canary'), caseId: 'no-skill-01-a' });
  await writeFile(join(receipt.target_root, 'accidental-control.txt'), corpus.control.canaries[0].value);
  const audit = await auditVisibleMaterial({ roots: [receipt.target_root], canaries: corpus.control.canaries });
  assert.equal(audit.status, 'invalid');
  assert.ok(audit.violations.some(item => item.kind === 'private-canary-visible'));
  assert.ok(!JSON.stringify(audit).includes(corpus.control.canaries[0].value));
});

test('idempotent materializer refuses overwritten owned bytes and symlink escapes', async () => {
  const args = { publicCorpus: corpus.publicCorpus, targetRoot: join(temp, 'repeat'), caseId: 'explicit-01-a' };
  const receipt = await materializeLocal(args);
  assert.deepEqual(await materializeLocal(args), receipt);
  const input = receipt.inventory.find(file => file.kind === 'input');
  await writeFile(input.path, 'changed');
  await assert.rejects(materializeLocal(args), /bytes changed/);
  const outside = join(temp, 'symlink-protected.txt');
  await writeFile(outside, 'keep');
  await rename(input.path, input.path + '.tampered');
  await symlink(outside, input.path);
  await assert.rejects(materializeLocal(args), /regular file/);
  assert.equal(await readFile(outside, 'utf8'), 'keep');
});

test('real-interface recipes preserve binary files, executable scripts and mixed ownership', () => {
  for (const placement of ['project', 'notion', 'mixed']) {
    const recipe = buildFixtureRecipe({ publicCorpus: corpus.publicCorpus, caseId: 'scripts-assets-01-a', placement, scopeId: 'fixture-test' });
    assert.equal(recipe.recipe.objects.length, 16);
    assert.equal(planAgentFixturePreparation(recipe.recipe).order.length, 16);
    assert.ok(recipe.expected_inventory.some(file => file.path === 'assets/format-marker.bin' && file.encoding === 'base64'));
    assert.ok(recipe.expected_inventory.some(file => file.path === 'scripts/normalize.mjs' && file.mode === '100755'));
    if (placement === 'mixed') assert.deepEqual(new Set(recipe.recipe.objects.map(object => object.placement)), new Set(['project', 'notion']));
    assert.equal(recipe.source_claim, 'no-upstream-claim');
  }
  const graph = buildFixtureRecipe({ publicCorpus: corpus.publicCorpus, caseId: 'complementary-01-a', placement: 'mixed', scopeId: 'graph-test' });
  assert.equal(planAgentFixturePreparation(graph.recipe).order.length, 16);
  const versions = buildFixtureRecipe({ publicCorpus: corpus.publicCorpus, caseId: 'continuation-02-a', placement: 'notion', scopeId: 'revision-test' });
  assert.equal(versions.mutable, true);
  assert.ok(versions.planned_inventory.length > versions.expected_inventory.length);
  assert.ok(versions.expected_inventory.every(file => file.version === 'v1'));
});

test('source recipe rejects an unpinned upstream declaration', () => {
  const plan = select('explicit-01-a'), id = plan.skills.find(skill => skill.id.endsWith('-refund')).id;
  assert.throws(() => buildFixtureRecipe({ publicCorpus: corpus.publicCorpus, caseId: 'explicit-01-a', scopeId: 'bad-source',
    sourceBindings: { [id]: { declaration: { definition: { policy: 'tracking', adapter: { type: 'git', ref: 'main' } } }, memberKey: 'skills/refund' } } }), /pinned/);
});

test('fixture binding changes only public invocation identities', () => {
  const fixture = buildFixtureRecipe({ publicCorpus: corpus.publicCorpus, caseId: 'explicit-01-a', scopeId: 'bind-test' });
  const bindings = { public: {}, private: { objects: {} } };
  for (const mapping of Object.values(fixture.skill_mapping)) {
    bindings.public[mapping.object_id + '.name'] = mapping.name + '-fixture';
    bindings.private.objects[mapping.object_id] = { name: mapping.name + '-fixture', skillId: 'actual-' + mapping.object_id };
  }
  const bound = bindPublicCaseToFixture({ publicCase: select('explicit-01-a').publicCase, skillMapping: fixture.skill_mapping, bindings });
  assert.match(bound.publicCase.turns[0].prompt, /refund-fixture/);
  assert.equal(Object.keys(bound.identity_map).length, 16);
  assert.ok(!Object.hasOwn(bound.publicCase, 'private'));
});

test('material comparison detects missing resources, bad bytes, mode and authorization mismatches', () => {
  const fixture = buildFixtureRecipe({ publicCorpus: corpus.publicCorpus, caseId: 'scripts-assets-01-a', scopeId: 'parity' });
  const expected = fixture.expected_inventory, observed = structuredClone(expected);
  assert.equal(verifyMaterialization({ expected, observed }).status, 'valid');
  assert.equal(verifyMaterialization({ expected, observed: observed.slice(1) }).status, 'invalid');
  observed[0].authorized = false;
  observed[1].content += 'corrupted';
  const script = observed.find(file => file.mode === '100755'); script.mode = '100644';
  const result = verifyMaterialization({ expected, observed });
  assert.equal(result.status, 'invalid');
  assert.ok(result.differences.some(diff => diff.field === 'authorization'));
  assert.ok(result.differences.some(diff => diff.field === 'content'));
  assert.ok(result.differences.some(diff => diff.field === 'executable'));
});

test('main Skill name rebinding preserves actual body comparison', () => {
  const fixture = buildFixtureRecipe({ publicCorpus: corpus.publicCorpus, caseId: 'explicit-01-a', scopeId: 'names' });
  const observed = structuredClone(fixture.expected_inventory);
  for (const file of observed.filter(file => file.path === 'SKILL.md')) {
    file.content = file.content.replace(/^name: (.+)$/m, 'name: $1-fixture');
    file.sha256 = hashBytes(file.content);
  }
  assert.equal(verifyMaterialization({ expected: fixture.expected_inventory, observed, skillMapping: fixture.skill_mapping }).status, 'valid');
});

test('actual executable CSV script consumes CRLF, aliases and binary marker and passes business grading', async () => {
  const plan = select('scripts-assets-01-a');
  const receipt = await materializeLocal({ publicCorpus: corpus.publicCorpus, targetRoot: join(temp, 'execute-csv'), caseId: 'scripts-assets-01-a' });
  const s = plan.skills.find(skill => skill.id.endsWith('-manifest'));
  const script = join(receipt.target_root, '.agents/skills', s.name, 'scripts/normalize.mjs');
  const output = join(receipt.target_root, 'output/manifest-clean.json');
  execFileSync(process.execPath, [script, join(receipt.target_root, 'input/manifest.csv'), output], { cwd: receipt.target_root });
  const content = await readFile(output, 'utf8');
  const rows = JSON.parse(content);
  assert.ok(rows.every(row => /^[0-9a-f]{12}$/.test(row.format_marker_hex)));
  const verdict = gradeEpisode({ oracle: plan.oracle, capabilities: caps, evidence: {
    artifacts: [{ path: 'output/manifest-clean.json', content, sha256: hashBytes(content), evidence_id: 'actual-csv-output' }],
    selections: [{ skill_id: s.id, evidence_id: 'actual-csv-selection' }],
    resource_reads: actualReads(s, ['SKILL.md', 'assets/depots.json', 'assets/format-marker.bin']), coverage: complete,
  } });
  assert.equal(verdict.business_outcome, 'pass');
  assert.equal(verdict.verified_success, true);
});

test('actual tariff script and independent formula agree at boundaries across eight real inputs', async () => {
  const plan = select('scripts-assets-02-a', { roundCount: 8 });
  const receipt = await materializeLocal({ publicCorpus: corpus.publicCorpus, targetRoot: join(temp, 'execute-tariff'), caseId: 'scripts-assets-02-a', roundCount: 8 });
  const s = plan.skills.find(skill => skill.id.endsWith('-tariff'));
  const policy = JSON.parse(s.versions.v1.files.find(file => file.path === 'assets/tariff.json').content);
  const artifacts = [];
  for (let round = 1; round <= 8; round++) {
    const input = join(receipt.target_root, 'input/weights-' + round + '.json');
    const path = 'output/fees-' + round + '.json', output = join(receipt.target_root, path);
    execFileSync(process.execPath, [join(receipt.target_root, '.agents/skills', s.name, 'scripts/quote.mjs'), input, output]);
    const content = await readFile(output, 'utf8'), original = JSON.parse(await readFile(input, 'utf8'));
    const independent = original.map(row => {
      let fee = policy.base_cents;
      for (let kg = policy.included_kg; kg < row.weight_kg; kg++) fee += policy.per_extra_kg_cents;
      return { id: row.id, fee_cents: fee };
    });
    assert.deepEqual(JSON.parse(content), independent);
    artifacts.push({ path, content, sha256: hashBytes(content), evidence_id: 'actual-tariff-' + round });
  }
  const verdict = gradeEpisode({ oracle: plan.oracle, capabilities: caps, evidence: { artifacts,
    selections: [{ skill_id: s.id, evidence_id: 'tariff-selection' }],
    resource_reads: actualReads(s, ['SKILL.md', 'assets/tariff.json']), coverage: complete } });
  assert.equal(verdict.verified_success, true);
});

test('either equivalent tax Skill accepts independently computed results and row order', () => {
  const plan = select('equivalent-01-a');
  const input = JSON.parse(plan.publicCase.attachments[0].content);
  for (const s of plan.skills.filter(skill => skill.id.endsWith('-tax-ledger') || skill.id.endsWith('-tax-invoice'))) {
    const rate = JSON.parse(s.versions.v1.files.find(file => file.path === 'references/tax.json').content).tax_percent;
    const rows = input.map(row => {
      const tax = Math.floor((row.net_cents * rate + 50) / 100);
      return { id: row.id, tax_cents: tax, gross_cents: row.net_cents + tax };
    }).reverse();
    const verdict = gradeEpisode({ oracle: plan.oracle, capabilities: caps, evidence: {
      artifacts: [artifact('output/tax-lines.json', rows)], selections: [{ skill_id: s.id, evidence_id: 'selected-equivalent' }],
      resource_reads: actualReads(s, ['SKILL.md', 'references/tax.json']), coverage: complete,
    } });
    assert.equal(verdict.verified_success, true);
  }
});

test('new unseen output schema uses the same grader without case-specific logic', () => {
  const oracle = plainOracle([business], 'unseen-plugin-material-2027');
  const verdict = gradeEpisode({ oracle, capabilities: ['workspace-files'], evidence: {
    artifacts: [artifact('output/result.json', [{ id: 'fresh', score: 17, human_note: 'permitted extra detail' }])], coverage: complete,
  } });
  assert.equal(verdict.verified_success, true);
  const duplicate = gradeEpisode({ oracle, capabilities: ['workspace-files'], evidence: {
    artifacts: [artifact('output/result.json', [{ id: 'fresh', score: 17 }, { id: 'fresh', score: 17 }])], coverage: complete,
  } });
  assert.equal(duplicate.business_outcome, 'fail');
});

test('missing evidence stays unknown; confirmed wrong output fails with critical evidence references', () => {
  const oracle = plainOracle([business]);
  const missing = gradeEpisode({ oracle, capabilities: ['workspace-files'], evidence: {} });
  assert.equal(missing.business_outcome, 'unknown'); assert.equal(missing.verified_success, false); assert.deepEqual(missing.critical_flags, []);
  const wrong = gradeEpisode({ oracle, capabilities: ['workspace-files'], evidence: { artifacts: [artifact('output/result.json', [{ id: 'fresh', score: 18 }])] } });
  assert.equal(wrong.business_outcome, 'fail');
  assert.deepEqual(wrong.critical_flags[0].evidence_ids, ['artifact-1']);
  assert.equal(wrong.readback_refs[0].evidence_id, 'artifact-1');
  const corrupt = artifact('output/result.json', [{ id: 'fresh', score: 17 }]); corrupt.sha256 = '0'.repeat(64);
  assert.equal(gradeEpisode({ oracle, capabilities: ['workspace-files'], evidence: { artifacts: [corrupt] } }).business_outcome, 'unknown');
});

test('no-Skill and clarification contracts require actual negative coverage and causal evidence', () => {
  const selection = { id: 'no-skill', kind: 'selection', critical: false, allowed_sets: [[]] };
  const oracle = plainOracle([business, selection]);
  const evidence = { artifacts: [artifact('output/result.json', [{ id: 'fresh', score: 17 }])], selections: [] };
  assert.equal(gradeEpisode({ oracle, capabilities: ['workspace-files'], evidence }).contracts[1].status, 'unknown');
  assert.equal(gradeEpisode({ oracle, capabilities: ['workspace-files'], evidence: { ...evidence, coverage: complete } }).verified_success, true);
  const clarify = plainOracle([business, { id: 'ask', kind: 'clarification', critical: true, topic_id: 'currency', min: 1, max: 1, before_artifact: true }]);
  const rows = [{ topic_id: 'currency', turn_id: 'turn-1', evidence_id: 'question-1' }];
  assert.equal(gradeEpisode({ oracle: clarify, capabilities: ['workspace-files'], evidence: { ...evidence, clarifications: rows } }).contracts[1].status, 'unknown');
  rows[0].before_completion = true;
  assert.equal(gradeEpisode({ oracle: clarify, capabilities: ['workspace-files'], evidence: { ...evidence, clarifications: rows } }).verified_success, true);
});

test('unsupported and undeclared capabilities remain separate from business failures', () => {
  const oracle = plainOracle([business]);
  const unsupported = gradeEpisode({ oracle, capabilities: [{ id: 'workspace-files', supported: false }], evidence: {} });
  assert.equal(unsupported.capability_status, 'unsupported');
  assert.equal(unsupported.business_outcome, 'not_applicable');
  assert.ok(unsupported.contracts.every(contract => contract.status === 'not_applicable'));
  const undeclared = gradeEpisode({ oracle, capabilities: [], evidence: { artifacts: [artifact('output/result.json', [{ id: 'fresh', score: 17 }])] } });
  assert.equal(undeclared.business_outcome, 'pass');
  assert.equal(undeclared.capability_status, 'unknown');
  assert.equal(undeclared.verified_success, false);
});

test('unknown mutation outcomes and missing resource observations cannot pass', () => {
  const oracle = plainOracle([business,
    { id: 'changed', kind: 'state-event', critical: true, event_id: 'version-2', expected_status: 'applied' },
    { id: 'source', kind: 'resources', critical: true, alternatives: [[{ skill_id: 'new-skill', path: 'reference.md', sha256: 'a'.repeat(64) }]] }]);
  const evidence = { artifacts: [artifact('output/result.json', [{ id: 'fresh', score: 17 }])],
    state_events: [{ id: 'version-2', status: 'unknown', evidence_id: 'mutation-ack-lost' }] };
  const verdict = gradeEpisode({ oracle, evidence, capabilities: ['workspace-files'] });
  assert.equal(verdict.contracts[1].status, 'unknown');
  assert.equal(verdict.contracts[2].status, 'unknown');
  assert.equal(verdict.verified_success, false);
  assert.deepEqual(verdict.critical_flags, []);
});

test('private confirmation seals bind contents and require an explicit registration before opening', () => {
  const c = buildCorpus({ seed: 'confirmation-never-used-for-development', split: 'confirmation' });
  const sealed = sealCorpus({ corpus: c, sealedAt: '2026-11-22T12:00:00Z' });
  assert.equal(sealed.control.seal.state, 'sealed');
  assert.equal(c.control.seal.state, 'unsealed');
  const opened = openCorpus({ corpus: sealed, openedAt: '2026-11-22T13:00:00Z', preregistrationSha256: 'b'.repeat(64) });
  assert.equal(opened.control.seal.state, 'opened');
  assert.throws(() => openCorpus({ corpus: sealed, openedAt: '2026-11-22T11:00:00Z', preregistrationSha256: 'b'.repeat(64) }));
  const changed = structuredClone(sealed);
  changed.control.cases[0].oracles['1'].contracts[0].expected.total_cents++;
  assert.throws(() => openCorpus({ corpus: changed, openedAt: '2026-11-22T13:00:00Z', preregistrationSha256: 'b'.repeat(64) }), /Oracle contract fingerprint|oracle was modified/);
});

test('a later Skill and material use the existing corpus, local projection and neutral contract', async () => {
  const publicCorpus = structuredClone(corpus.publicCorpus);
  const skill = { id: 'later-stock-count', name: 'bm-later-stock-count', description: '新增盘点差异计算',
    requires: [], initial_version: 'v1', versions: { v1: { files: [
      corpusFile('SKILL.md', '---\nname: bm-later-stock-count\ndescription: 新增盘点差异计算\n---\n读取 references/count.md，输出 id 和 difference。\n'),
      corpusFile('references/count.md', 'difference 为 counted 减 recorded。保留负数。\n'),
    ] } } };
  publicCorpus.skills.push(skill);
  const item = structuredClone(publicCorpus.cases.find(item => item.id === 'no-skill-01-a'));
  item.id = 'later-material-01'; item.journey_id = 'later-count'; item.cluster_id = 'later-count';
  item.material_id = 'later-independent-material'; item.seed = 'outside-original-generator';
  item.title = '新增盘点材料'; item.required_capabilities = [...caps];
  item.catalog.skill_ids[0] = skill.id;
  item.attachments = [corpusFile('input/count.json', JSON.stringify([{ id: 'NEW-01', recorded: 12, counted: 9 }]))];
  item.turns = [{ id: 'turn-1', prompt: '请按新增盘点规则处理 input/count.json，把 id 和 difference 保存到 output/count.json。', attachment_paths: ['input/count.json'] }];
  item.completion = { kind: 'artifacts', paths: ['output/count.json'] };
  const contract = { id: 'count-business', kind: 'artifact-json', critical: true,
    path: 'output/count.json', comparison: 'rows-by-key', row_key: 'id', expected: [{ id: 'NEW-01', difference: -3 }] };
  item.contract_sha256 = fingerprint([contract]);
  delete item.content_sha256; item.content_sha256 = fingerprint(item);
  publicCorpus.cases.push(item);
  delete publicCorpus.content_sha256; publicCorpus.content_sha256 = fingerprint(publicCorpus);
  assert.equal(validateCorpus({ publicCorpus }).case_count, 41);
  const projected = await materializeLocal({ publicCorpus, targetRoot: join(temp, 'later-material'), caseId: item.id });
  const rows = JSON.parse(await readFile(join(projected.target_root, 'input/count.json'), 'utf8'));
  const output = rows.map(row => ({ id: row.id, difference: row.counted - row.recorded }));
  const source = await readFile(join(projected.target_root, '.agents/skills', skill.name, 'references/count.md'), 'utf8');
  assert.match(source, /counted 减 recorded/);
  const oracle = plainOracle([contract], item.id);
  const verdict = gradeEpisode({ oracle, capabilities: caps, evidence: { artifacts: [artifact('output/count.json', output, 'new-material-readback')] } });
  assert.equal(verdict.verified_success, true);
  assert.equal(verdict.case_id, item.id);
});

test('material V2 preserves V1 reproducibility and only changes authored main prose at a fixed material seed', () => {
  assert.equal(buildCorpus({ seed: 'corpus-tests-20261122', materialVersion: '1' }).publicCorpus.content_sha256,
    'f7f4496f92ab66608cbbd94abef70e11a37a2486a9b30d73d37cd3c1064ecc83');
  const v2 = buildCorpus({ seed: 'corpus-tests-20261122', materialVersion: '2' });
  assert.equal(validateCorpus(v2).case_count, 40);
  for (const journey of JOURNEYS) {
    const roundCount = ['continuation', 'task-switch'].includes(journey.family) ? 2 : 1;
    const args = { seed: 'fixed-comparison-seed', material: 'a', roundCount };
    const first = buildJourney(journey, { ...args, materialVersion: '1' });
    const second = buildJourney(journey, { ...args, materialVersion: '2' });
    assert.deepEqual(first.attachments, second.attachments);
    assert.deepEqual(first.turns, second.turns);
    assert.deepEqual(first.contracts.filter(contract => contract.kind === 'artifact-json'),
      second.contracts.filter(contract => contract.kind === 'artifact-json'));
    for (let i = 0; i < first.skills.length; i++) {
      const a = first.skills[i], b = second.skills[i];
      for (const version of Object.keys(a.versions)) {
        assert.deepEqual(a.versions[version].files.filter(file => file.path !== 'SKILL.md'),
          b.versions[version].files.filter(file => file.path !== 'SKILL.md'));
        const main = b.versions[version].files.find(file => file.path === 'SKILL.md').content;
        const body = main.replace(/^---\n[\s\S]*?\n---\n/u, '').trim();
        assert.ok(body.split(/\n{2,}/u).every(paragraph => !paragraph.includes('\n')), 'V2 prose has explicit paragraphs');
      }
    }
  }
  for (const skill of v2.publicCorpus.skills) {
    const main = skill.versions[skill.initial_version].files.find(file => file.path === 'SKILL.md').content;
    const body = main.replace(/^---\n[\s\S]*?\n---\n/u, '').trim();
    assert.ok(body.split(/\n{2,}/u).every(paragraph => !paragraph.includes('\n')));
  }
});

test('public/private fingerprint validation rejects mismatched expected business values', () => {
  const altered = structuredClone(corpus);
  altered.control.cases[0].oracles['1'].contracts[0].expected.total_cents++;
  assert.throws(() => validateCorpus(altered), /Oracle contract fingerprint/);
});

test('confirmed late clarification fails while absent timing stays unknown', () => {
  const oracle = plainOracle([business, { id: 'ask-first', kind: 'clarification', critical: true,
    topic_id: 'currency', min: 1, max: 1, before_artifact: true }]);
  const verdict = gradeEpisode({ oracle, capabilities: ['workspace-files'], evidence: {
    artifacts: [artifact('output/result.json', [{ id: 'fresh', score: 17 }])],
    clarifications: [{ topic_id: 'currency', before_completion: false, evidence_id: 'late-question' }],
  } });
  assert.equal(verdict.contracts[1].status, 'fail');
  assert.equal(verdict.critical_flags[0].contract_id, 'ask-first');
  assert.deepEqual(verdict.critical_flags[0].evidence_ids, ['late-question']);
});

test('capability observations cannot imply support from a missing or nonboolean supported field', () => {
  for (const value of [undefined, null, 'true', 1]) {
    assert.throws(() => gradeEpisode({ oracle: plainOracle([business]),
      capabilities: [{ id: 'workspace-files', supported: value }] }), /explicit boolean/);
  }
});

test('shared catalog rebinding preserves tasks, answers and lineage for the four-case route gate', () => {
  const v2 = buildCorpus({ seed: 'benchmark-route-gate-v1', materialVersion: '2' });
  const caseIds = ['no-skill-01-a', 'no-skill-02-a', 'no-skill-03-a', 'explicit-01-a'];
  const skillIds = v2.publicCorpus.cases.find(item => item.id === 'explicit-01-a').catalog.skill_ids;
  const args = { corpus: v2, caseIds, skillIds, reason: 'One frozen read-only library before registration' };
  const rebound = rebindCorpusCatalog(args);
  assert.notEqual(rebound.publicCorpus.content_sha256, v2.publicCorpus.content_sha256);
  assert.equal(validateCorpus(rebound).case_count, 40);
  for (const id of caseIds) {
    const before = v2.publicCorpus.cases.find(item => item.id === id), after = rebound.publicCorpus.cases.find(item => item.id === id);
    assert.deepEqual(after.catalog.skill_ids, skillIds);
    assert.deepEqual(after.turns, before.turns); assert.deepEqual(after.attachments, before.attachments);
    assert.equal(after.material_id, before.material_id); assert.equal(after.cluster_id, before.cluster_id);
    assert.equal(after.catalog_lineage.base_case_sha256, before.content_sha256);
    const oldOracle = v2.control.cases.find(item => item.case_id === id).oracles['1'];
    const newOracle = rebound.control.cases.find(item => item.case_id === id).oracles['1'];
    assert.deepEqual(newOracle.contracts, oldOracle.contracts);
    assert.equal(newOracle.public_sha256, after.content_sha256);
  }
  assert.deepEqual(rebindCorpusCatalog({ ...args, corpus: rebound }), rebound);
  assert.equal(rebound.publicCorpus.catalog_rebindings.length, 1);
});

test('shared catalog rebinding rejects missing targets, dependencies, duplicate identities and sealed material', () => {
  const ids = corpus.publicCorpus.cases.find(item => item.id === 'no-skill-01-a').catalog.skill_ids;
  assert.throws(() => rebindCorpusCatalog({ corpus, caseIds: ['explicit-01-a'], skillIds: ids, reason: 'bad' }), /required case Skill/);
  assert.throws(() => rebindCorpusCatalog({ corpus, caseIds: ['no-skill-01-a'], skillIds: Array(16).fill(ids[0]), reason: 'bad' }), /sixteen unique/);
  const dependency = corpus.publicCorpus.skills.find(skill => skill.id === 'complementary-01-a-privacy');
  assert.throws(() => rebindCorpusCatalog({ corpus, caseIds: ['no-skill-01-a'], skillIds: [dependency.id, ...ids.slice(1)], reason: 'bad' }), /dependency/);
  const sealed = sealCorpus({ corpus: buildCorpus({ seed: 'sealed-catalog', split: 'confirmation', materialVersion: '2' }), sealedAt: '2026-11-22T12:00:00Z' });
  const selected = sealed.publicCorpus.cases.find(item => item.id === 'explicit-01-a').catalog.skill_ids;
  assert.throws(() => rebindCorpusCatalog({ corpus: sealed, caseIds: ['no-skill-01-a'], skillIds: selected, reason: 'late' }), /sealed confirmation/);
});
