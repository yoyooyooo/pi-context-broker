import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectEpisode, collectRuntimeTools, notionMetadataEvidence, verifiedNotionListRuntime } from './collect.mjs';
import { loadCurrentSourceViews } from './current-source-views.mjs';
import { readSubjectTurnControl } from './execute.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const ref = { artifact_id: 'metadata-fixture', sha256: sha('metadata'), pointer: '' };
const indexSha = '292fc3c967cb2d4235eaf8412f582b18391250d46c332a1c67ea2934e1602d63';
const hostSha = 'c24c6d08799dfa1e353b9bc282e16b44a8ad141229b681a51ef2bad84f6d6ae1';
const candidateIndexSha = 'e76e3c3ac75e5c6f1ca9668e60f5addc625471ce68cb3a7cec20b02f4ea60482';
const candidateHostSha = 'eb9153cdc6e3b6665633d80e6bca804bb72df7447eccd5ab98510640798da205';
const localIdentityIndexSha = 'bfbf2d32db29c53a09f933ee657e467ef7132bcaf65becb4d19fac3c8efd8bd9';
const localIdentityHostSha = 'ddfd7abf4d501c97c69d3d8baf4d3b4656fe9878361735f42d86e1742c5d9f59';
const refreshGuidanceIndexSha = '6b08741c97d84ffe34741ce6cebe16c99c6e27834e2d27d2dea4e9e7f39770d2';
const refreshGuidanceHostSha = 'd359e2919bc6a259eba2201c808683b04107bdeca249663b304560eaf816a36d';
const producers = [{ indexSha, hostSha }, { indexSha: candidateIndexSha, hostSha: candidateHostSha },
  { indexSha: localIdentityIndexSha, hostSha: localIdentityHostSha },
  { indexSha: refreshGuidanceIndexSha, hostSha: refreshGuidanceHostSha }];
function producerFixture({ indexSha, hostSha } = producers[0], mode = 'directory') {
  const suffix = mode === 'packed' ? '/installed/broker/node_modules/pi-context-broker' : '/broker';
  const view = root => {
    const path = root + suffix + '/src/index.ts';
    return { entry_kind: 'pi-sdk', mode: 'broker', build: { path: root + '/build.json' },
      launch_profile: { extensions: [{ role: 'broker', path, sha256: indexSha }] },
      extensions: [{ resolved_path: path, tools: ['notion_list'], entry: { path, realpath: path, sha256: indexSha } }],
      tools: { all: [{ name: 'notion_list', exposure: 'direct', sourceInfo: { path, source: 'cli' } }] } };
  };
  const candidate = { snapshot: view('/build'), projection: view('$BUILD') };
  const build = { root: '/build', packages: { broker: { files: [{ path: 'src/index.ts', sha256: indexSha }] } },
    candidate: mode === 'packed' ? { mode, root: '/build/installed', packages: { broker: {
      name: 'pi-context-broker', root: '/build' + suffix, entry: '/build' + suffix + '/src/index.ts',
      closure: { root: '/build' + suffix, files: [{ path: 'src/index.ts', sha256: indexSha }] },
    } } } : { mode } };
  return { build, candidate, expected: { projection: structuredClone(candidate.projection) }, admission: { differences: [] },
    files: [{ name: 'src/index.ts', sha256: indexSha }, { name: 'src/host-skills.ts', sha256: hostSha }] };
}
for (const mode of ['directory', 'packed']) for (const [index, producer] of producers.entries())
test('metadata exemption needs reviewed Broker tuple ' + index + ', ' + mode + ' package and matching admission', () => {
  assert.equal(verifiedNotionListRuntime(producerFixture(producer, mode)), true);
  for (const change of [
    f => { f.candidate.snapshot.tools.all[0].sourceInfo.path = '/other/index.ts'; },
    f => { f.candidate.snapshot.tools.all[0].sourceInfo.source = 'builtin'; },
    f => { f.candidate.snapshot.extensions[0].entry.sha256 = sha('another extension'); },
    f => { f.candidate.snapshot.extensions.push(f.candidate.snapshot.extensions[0]); },
    f => { f.candidate.snapshot.tools.all.push(f.candidate.snapshot.tools.all[0]); },
    f => { f.candidate.snapshot.launch_profile.extensions[0].path = '/different.ts'; },
    f => { f.files[1].sha256 = sha('same tool name, different body'); },
    f => { f.files.push(f.files[1]); },
    f => { f.expected.projection.mode = 'native'; },
    f => { f.admission.differences.push('drift'); },
  ]) { const f = producerFixture(producer, mode); change(f); assert.equal(verifiedNotionListRuntime(f), false); }
});
test('packed metadata ownership rejects an unbound package, entry, archive or declared role', () => {
  for (const change of [
    f => { f.build.candidate.packages.broker.entry = '/other/index.ts'; },
    f => { f.build.candidate.packages.broker.entry = '/build/installed/broker/node_modules/pi-context-broker/../other/index.ts'; },
    f => { f.build.candidate.packages.broker.closure.files[0].sha256 = sha('different archive bytes'); },
    f => { f.build.packages.broker.files[0].sha256 = sha('different built bytes'); },
    f => { f.candidate.snapshot.launch_profile.extensions[0].role = 'common'; },
    f => { f.build.candidate.mode = 'unknown'; },
    f => { delete f.build; },
  ]) { const f = producerFixture(producers[2], 'packed'); change(f); assert.equal(verifiedNotionListRuntime(f), false); }
});

test('matching entry bytes at another package location cannot borrow the reviewed relative imports', () => {
  const f = producerFixture(producers[2], 'packed');
  const selected = f.build.candidate.packages.broker;
  const moved = { path: 'unreviewed-location/index.ts', sha256: localIdentityIndexSha };
  f.build.packages.broker.files.push(moved, { path: 'src/host-skills.ts', sha256: localIdentityHostSha },
    { path: 'unreviewed-location/host-skills.ts', sha256: sha('unreviewed relative import') });
  selected.closure.files.push({ ...moved }, { path: 'src/host-skills.ts', sha256: localIdentityHostSha },
    { path: 'unreviewed-location/host-skills.ts', sha256: sha('unreviewed relative import') });
  selected.entry = selected.root + '/unreviewed-location/index.ts';
  for (const view of [f.candidate.snapshot, f.candidate.projection]) {
    const path = view.launch_profile.extensions[0].path.replace('/src/index.ts', '/unreviewed-location/index.ts');
    view.launch_profile.extensions[0].path = path;
    view.extensions[0].resolved_path = path;
    view.extensions[0].entry.path = path; view.extensions[0].entry.realpath = path;
    view.tools.all[0].sourceInfo.path = path;
  }
  f.expected.projection = structuredClone(f.candidate.projection);
  assert.equal(verifiedNotionListRuntime(f), false);
});

test('separately reviewed source hashes cannot be mixed into an unreviewed producer', () => {
  for (const index of producers) for (const host of producers) {
    if (index === host) continue;
    assert.equal(verifiedNotionListRuntime(producerFixture({ indexSha: index.indexSha, hostSha: host.hostSha })), false);
  }
  assert.equal(verifiedNotionListRuntime(producerFixture({ indexSha: sha('unreviewed index'), hostSha: sha('unreviewed host') })), false);
});

function metadataFixture() {
  const record = { id: 'skill://policy?library=root', ref: 'sr:C' + 'x'.repeat(22), kind: 'skill', name: 'policy',
    description: 'Routing policy', source: 'notion', scope: sha('scope'), in_default_view: true, availability: 'available' };
  const details = { ok: true, state: 'known', count: 1, has_more: false, total_count: 1, next_cursor: null,
    freshness: { sources: [{ source: 'notion', policy: 'refresh', validated_at: '2026-11-26T13:32:35.531Z', age_ms: 16854, max_age_ms: 60000, stale: false }] },
    coverage: { exhaustive: true, sources: [{ source: 'notion', exhaustive: true }] }, records: [record], failures: [] };
  const { id, scope, ...compact } = record;
  const tool = { id: 'list', name: 'notion_list', args: { query: 'Routing', refresh: true }, status: 'pass', execution: 'observed',
    sequence: 76, end_sequence: 86, refs: [ref], result: { details, content: [{ type: 'text', text: JSON.stringify({ ...details, records: [compact] }) }] } };
  const context = { runtime: { status: 'verified', refs: [ref] }, sources: [{ id: 'notion', type: 'notion', library: 'root' }],
    directories: [{ requestId: 'catalog', end_sequence: 84, ref,
      value: { library_id: 'root', scope: record.scope, records: [{ id: record.id, ref: 'skill://policy/SKILL.md?library=root',
        kind: 'skill', name: record.name, description: record.description, enabled: true }] } }] };
  return { tool, context };
}
test('reviewed metadata output matches captured SDK directory without adding a source selection', () => {
  const f = metadataFixture(), proof = notionMetadataEvidence(f.tool, f.context);
  assert.equal(proof.kind, 'broker-metadata-only'); assert.deepEqual(proof.operation_ids, ['catalog']);
  assert.equal(proof.tool_call_id, 'list'); assert.ok(proof.refs.length > 0);
  assert.equal(Object.hasOwn(proof, 'selections'), false);
  f.tool.result.content[0].text = JSON.stringify(f.tool.result.details);
  assert.ok(notionMetadataEvidence(f.tool, f.context));
});
test('reviewed local-identity producer still requires an actually observed SDK directory', () => {
  assert.equal(verifiedNotionListRuntime(producerFixture(producers[2])), true);
  const f = metadataFixture();
  assert.ok(notionMetadataEvidence(f.tool, f.context));
  // Local routing and a candidate snapshot may know the same records. Neither
  // substitutes for the list receipt consumed by the metadata classifier.
  f.context.localLibrary = { root: 'root', source: f.context.sources[0] };
  f.context.candidates = structuredClone(f.context.directories);
  f.context.directories = [];
  assert.equal(notionMetadataEvidence(f.tool, f.context), null);
});
const refusals = {
  'same name without producer': f => { f.context.runtime.status = 'unverified'; },
  'failed list': f => { f.tool.status = 'fail'; },
  'content search': f => { f.tool.args.search_in = 'content'; },
  'unknown argument': f => { f.tool.args.load = true; },
  'unknown outer shape': f => { f.tool.result.structuredContent = 'untracked body'; },
  'appended body': f => { f.tool.result.content[0].text += '\n# Instructions'; },
  'second body block': f => { f.tool.result.content.push({ type: 'text', text: '# Instructions' }); },
  'body in details': f => { f.tool.result.details.content = '# Instructions'; },
  'body in record': f => { f.tool.result.details.records[0].content = '# Instructions'; },
  'preparation proof': f => { f.tool.result.details.contextBrokerPreparation = { records: [] }; },
  'unknown record shape': f => { f.tool.result.details.records[0].snapshot = 'unrecognized'; },
  'different delivered metadata': f => { f.tool.result.content[0].text = '{}'; },
  'unobserved owner': f => { f.context.directories[0].value.records[0].id = 'skill://other?library=root'; },
  'unobserved description': f => { f.context.directories[0].value.records[0].description = 'Other metadata'; },
  'wrong Library': f => { f.context.directories[0].value.library_id = 'other'; },
  'wrong scope': f => { f.context.directories[0].value.scope = sha('other'); },
  'directory observed only later': f => { f.context.directories[0].end_sequence = 87; },
  'no SDK directory': f => { f.context.directories = []; },
  'unexpected source': f => { f.context.sources[0].id = 'other'; },
  'missing Library binding': f => { delete f.context.sources[0].library; },
  'body hidden in freshness': f => { f.tool.result.details.freshness.sources[0].validated_at = '2026-11-26 (# Body)'; },
  'arbitrary successful shell': f => { f.tool.name = 'bash'; f.tool.args = { command: 'printf metadata' }; },
  'failed shell including rg127': f => { f.tool.name = 'bash'; f.tool.status = 'fail'; f.tool.result.exit_code = 127; },
};
for (const [name, change] of Object.entries(refusals)) test('metadata classification stays opaque for ' + name, () => {
  const f = metadataFixture(); change(f); assert.equal(notionMetadataEvidence(f.tool, f.context), null);
});

test('retained actual SDK3 run passes the full collector, normalization and grade pipeline without a model call',
  { skip: !process.env.BENCHMARK_METADATA_REAL_RUN && 'Set BENCHMARK_METADATA_REAL_RUN and BENCHMARK_METADATA_REAL_PLAN to the retained metadata-only case and its frozen plan.' }, async t => {
    const root = process.env.BENCHMARK_METADATA_REAL_RUN;
    const json = async path => JSON.parse(await readFile(path, 'utf8'));
    const episode = await json(join(root, 'benchmark/runtime/episode-result.json'));
    const candidate = await json(join(root, 'benchmark/runtime/candidate-observed.json'));
    const admission = await json(join(root, 'benchmark/runtime/admission-comparison.json'));
    const expected = await json(admission.expected_file.path), buildRoot = join(candidate.snapshot.build.path, '..');
    const build = await json(candidate.snapshot.build.path), files = [];
    for (const name of ['src/index.ts', 'src/host-skills.ts']) {
      const sha256 = sha(await readFile(join(buildRoot, 'broker', name)));
      assert.equal(build.packages.broker.files.find(file => file.path === name).sha256, sha256);
      files.push({ name, sha256 });
    }
    assert.equal(verifiedNotionListRuntime({ candidate, expected, admission, files, build }), true);
    const sourceViews = await loadCurrentSourceViews({ runRoot: root, buildRoot, candidate });
    const receipts = [], directories = [];
    for (const operation of episode.notion.operations) {
      const artifact = episode.artifacts.find(item => item.id === operation.receipt_ref.artifact_id);
      const bytes = await readFile(artifact.path); assert.equal(sha(bytes), artifact.sha256);
      receipts.push(JSON.parse(bytes));
    }
    for (const entry of sourceViews.graphSourceViews(receipts).directories) {
      const operation = episode.notion.operations.find(item => item.operation_id === entry.requestId);
      directories.push({ ...entry, end_sequence: operation.end_ref.line, ref: operation.receipt_ref });
    }
    const eventArtifact = episode.artifacts.find(item => item.id === 'events');
    const eventBytes = await readFile(eventArtifact.path); assert.equal(sha(eventBytes), eventArtifact.sha256);
    const sessionArtifact = episode.artifacts.find(item => item.id === 'session-entries');
    const sessionBytes = await readFile(sessionArtifact.path); assert.equal(sha(sessionBytes), sessionArtifact.sha256);
    const tools = collectRuntimeTools(eventBytes.toString().trimEnd().split('\n').map(JSON.parse), eventArtifact, JSON.parse(sessionBytes), sessionArtifact);
    assert.equal(tools.complete, true);
    const lists = tools.tools.filter(tool => tool.name === 'notion_list'); assert.equal(lists.length, 1);
    const context = { runtime: { status: 'verified', refs: [ref] }, directories, sources: candidate.snapshot.broker_config.sources };
    assert.ok(notionMetadataEvidence(lists[0], context));
    for (const change of [
      f => { f.context.runtime.status = 'unverified'; },
      f => { f.tool.args.search_in = 'content'; },
      f => { f.tool.result.details.records[0].content = '# Body'; },
      f => { f.tool.result.content[0].text += '\n# Body'; },
      f => { f.tool.result.details.unknown = true; },
      f => { f.context.directories = []; },
      f => { for (const item of f.context.directories) item.value.library_id = 'other'; },
      f => { for (const item of f.context.directories) item.end_sequence = f.tool.end_sequence + 1; },
      f => { f.tool.name = 'bash'; },
    ]) {
      const f = { tool: structuredClone(lists[0]), context: structuredClone(context) };
      change(f);
      assert.equal(notionMetadataEvidence(f.tool, f.context), null);
    }
    const original = await json(join(root, 'benchmark/normalized/readback.json'));
    assert.deepEqual(original.opaque_tools, [lists[0].id]); assert.deepEqual(original.unmatched_reads, []);
    assert.equal(original.evidence.coverage.selections, 'partial');

    // Exercise the complete producer-file collection branch as well as its
    // classifier. A caught ReferenceError must not silently restore unknown.
    assert.ok(process.env.BENCHMARK_METADATA_REAL_PLAN, 'The complete collector regression requires the original frozen plan');
    const plan = await json(process.env.BENCHMARK_METADATA_REAL_PLAN);
    const bindingBytes = await readFile(plan.execution.case_bindings_file);
    assert.equal(sha(bindingBytes), plan.execution.case_bindings_sha256);
    const slot = plan.slots.find(slot => slot.case_id === episode.correlation.task_id && slot.condition_id === episode.correlation.candidate_id);
    assert.ok(slot);
    const binding = JSON.parse(bindingBytes).find(binding => binding.id === slot.case_id);
    const condition = plan.protocol.conditions.find(condition => condition.id === slot.condition_id);
    const model = { ...plan.protocol.models.find(model => model.id === condition.model_id), adapter_evidence_path: plan.execution.adapter_evidence_file };
    const normalizedRoot = join(root, 'benchmark/normalized');
    const preserved = new Map(await Promise.all(['collection.json', 'readback.json', 'grade.json', 'normalized/episode.json']
      .map(async name => [name, sha(await readFile(join(normalizedRoot, name)))])));
    const previous = await json(join(normalizedRoot, 'collection.json'));
    const raw = { root, run_id: episode.correlation.run_id, result_path: join(root, 'benchmark/runtime/episode-result.json'),
      shared: await json(join(root, 'result.json')), episode, status: episode.status };
    const required = binding.public_case.turns.length > 1 || (binding.events?.length ?? 0) > 0 || (binding.clarification?.length ?? 0) > 0;
    raw.turn_control_verification = await readSubjectTurnControl({ controlRoot: plan.execution.control_root, runRoot: root, runId: raw.run_id, required });
    raw.turn_control = raw.turn_control_verification.result;
    const outputDirectory = await mkdtemp(join(plan.execution.environment_root, 'control', 'metadata-collector-regression-'));
    const collected = await collectEpisode({ raw, binding, protocol: plan.protocol, slot, condition, model,
      outputDirectory, environmentRoot: plan.execution.environment_root, reanalysisOf: previous.episode_sha256 });
    t.diagnostic('Retained complete collector regression: ' + outputDirectory);
    for (const [name, expected] of preserved) assert.equal(sha(await readFile(join(normalizedRoot, name))), expected);
    assert.deepEqual(collected.budget_usage, previous.budget_usage);
    assert.equal(collected.readback.metadata_runtime.status, 'verified', collected.readback.metadata_runtime.reason);
    assert.deepEqual(collected.readback.metadata_only_tools.map(tool => tool.tool_call_id), [lists[0].id]);
    assert.deepEqual(collected.readback.opaque_tools, []);
    assert.equal(collected.grade.contracts.find(contract => contract.id === 'legal-selection').status, 'pass');
    assert.equal(collected.grade.business_outcome, 'pass'); assert.equal(collected.validity, 'valid');
    assert.equal(collected.verified_success, true);
    assert.equal(collected.bundle.episode.result.verified_success, true);
    assert.equal(collected.bundle.episode.result.outcome, 'pass');
  });
