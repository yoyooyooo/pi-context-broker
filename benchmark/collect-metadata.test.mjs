import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectRuntimeTools, notionMetadataEvidence, verifiedNotionListRuntime } from './collect.mjs';
import { loadCurrentSourceViews } from './current-source-views.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const ref = { artifact_id: 'metadata-fixture', sha256: sha('metadata'), pointer: '' };
const indexSha = '292fc3c967cb2d4235eaf8412f582b18391250d46c332a1c67ea2934e1602d63';
const hostSha = 'c24c6d08799dfa1e353b9bc282e16b44a8ad141229b681a51ef2bad84f6d6ae1';
const candidateIndexSha = 'e76e3c3ac75e5c6f1ca9668e60f5addc625471ce68cb3a7cec20b02f4ea60482';
const candidateHostSha = 'eb9153cdc6e3b6665633d80e6bca804bb72df7447eccd5ab98510640798da205';
const producers = [{ indexSha, hostSha }, { indexSha: candidateIndexSha, hostSha: candidateHostSha }];
function producerFixture({ indexSha, hostSha } = producers[0]) {
  const view = root => {
    const path = root + '/broker/src/index.ts';
    return { entry_kind: 'pi-sdk', mode: 'broker', build: { path: root + '/build.json' },
      launch_profile: { extensions: [{ role: 'broker', path, sha256: indexSha }] },
      extensions: [{ resolved_path: path, tools: ['notion_list'], entry: { path, realpath: path, sha256: indexSha } }],
      tools: { all: [{ name: 'notion_list', exposure: 'direct', sourceInfo: { path, source: 'cli' } }] } };
  };
  const candidate = { snapshot: view('/build'), projection: view('$BUILD') };
  return { candidate, expected: { projection: structuredClone(candidate.projection) }, admission: { differences: [] },
    files: [{ name: 'src/index.ts', sha256: indexSha }, { name: 'src/host-skills.ts', sha256: hostSha }] };
}
for (const [index, producer] of producers.entries()) test('metadata exemption needs reviewed Broker tuple ' + index + ' and matching admission', () => {
  assert.equal(verifiedNotionListRuntime(producerFixture(producer)), true);
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
  ]) { const f = producerFixture(producer); change(f); assert.equal(verifiedNotionListRuntime(f), false); }
});
test('separately reviewed source hashes cannot be mixed into an unreviewed producer', () => {
  for (const producer of [
    { indexSha, hostSha: candidateHostSha },
    { indexSha: candidateIndexSha, hostSha },
    { indexSha: sha('unreviewed index'), hostSha: sha('unreviewed host') },
  ]) assert.equal(verifiedNotionListRuntime(producerFixture(producer)), false);
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

test('retained actual SDK3 run uses the reviewed owner and real directory; no model is called',
  { skip: !process.env.BENCHMARK_METADATA_REAL_RUN }, async () => {
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
    assert.equal(verifiedNotionListRuntime({ candidate, expected, admission, files }), true);
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
  });
