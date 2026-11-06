import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { observeGraphGate, GRAPH_GATE_TOOLS } from './notion-skill-graph-model.mjs';
import { verifyPublicReadBoundary, parseGraphObserverOptions, copySdkDiscoveryFixture } from './notion-skill-graph-observer-smoke.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { parseNativeReference } from '../packages/context-broker/src/native-reference.ts';
import { compileSkillPreparation } from '../packages/context-broker/src/skill-context-projection.ts';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

for (const mode of ['full-cards', 'on-demand-cards']) test('controlled SDK discovery smoke accepts the explicit ' + mode + ' arm', () => {
  const options = parseGraphObserverOptions(['--extension', '/installed/broker/src/index.ts', '--cli-entry', '/installed/cli/ntn-skills.js',
    '--evidence-root', '/owned/evidence', '--discovery-only', 'true', '--package-path', '/owned/broker.tgz', '--sdk-fixture', '/owned/fixture.json', '--discovery-mode', mode]);
  assert.equal(options['discovery-mode'], mode); assert.equal(options['sdk-fixture'], '/owned/fixture.json');
  assert.equal(options['discovery-only'], 'true'); assert.equal(options.model, undefined);
});

test('controlled SDK discovery smoke rejects implicit arms and mixed scenarios', () => {
  const base = ['--discovery-only', 'true', '--sdk-fixture', '/owned/fixture.json', '--package-path', '/owned/broker.tgz', '--discovery-mode', 'full-cards'];
  for (const invalid of [base.slice(0, -2), base.filter((_, i) => i !== 2 && i !== 3),
    ['--sdk-fixture', '/owned/fixture.json', '--discovery-mode', 'full-cards'],
    [...base.slice(0, -1), 'unknown'], [...base, '--matrix', 'true'], [...base, '--public-boundaries', 'true'],
    [...base, '--large-body', 'true'], [...base, '--host-index-resource', 'true'],
    [...base, '--model', 'magpie/group/flash-free']]) assert.throws(() => parseGraphObserverOptions(invalid));
  assert.deepEqual(parseGraphObserverOptions(['--discovery-only', 'true']), { 'discovery-only': 'true' });
});

test('controlled SDK discovery clones only validated offline source roots and independent body evidence', async () => {
  const directory = await mkdtemp(path.join(await systemTempRoot(), 'graph-discovery-sdk-'));
  const source = path.join(directory, 'source'), target = path.join(directory, 'clone'), body = 'Original controlled main.\n';
  await mkdir(path.join(source, 'state', 'objects'), { recursive: true }); await mkdir(path.join(source, 'config'));
  const file = path.join(source, 'fixture.json'), env = path.join(source, 'env.json'), object = path.join(source, 'state', 'objects', hash(body));
  await writeFile(object, body); await writeFile(path.join(source, 'config', 'config.json'), '{}\n');
  const environment = { NOTION_API_BASE_URL: 'http://127.0.0.1:1/v1', NTN_SKILLS_HOME: 'state', NTN_SKILLS_CONFIG_HOME: 'config', NTN_SKILLS_CACHE_HOME: 'cache' };
  await symlink(directory, path.join(source, 'outside-cache'), 'dir');
  await save(env, environment);
  const record = { id: 'shared_skill:fixture:a', name: 'a', ref: 'skill://shared_skill%3Afixture%3Aa/SKILL.md', entrypoint: 'SKILL.md' };
  const input = { version: 1, catalog: true, cwd: source, env, scope: 'a'.repeat(64), database: 'controlled-database',
    default_view: { database_id: 'controlled-database', source_cache: 'complete-metadata-only', records: [{ id: record.id, name: record.name, ref: record.ref }] },
    snapshots: [{ scope: 'a'.repeat(64), record, entrypoint: 'SKILL.md', files: [{ path: 'SKILL.md', sha256: hash(body), bytes: Buffer.byteLength(body) }] }] };
  await save(file, input);
  const copied = await copySdkDiscoveryFixture(file, target);
  assert.equal(fs.existsSync(path.join(source, 'cache')), false, 'A configured cache root can be created later by the real SDK');
  assert.equal(copied.graph.nodes[0].body, body); assert.equal(copied.identity.sha256, hash(await readFile(file)));
  for (const [key, subdir] of [['NTN_SKILLS_HOME', 'state'], ['NTN_SKILLS_CONFIG_HOME', 'config'], ['NTN_SKILLS_CACHE_HOME', 'cache']])
    assert.equal(copied.environment[key], path.join(target, subdir));
  await writeFile(path.join(target, 'state', 'objects', hash(body)), 'changed clone'); assert.equal(await readFile(object, 'utf8'), body);
  for (const [name, mutate] of [
    ['production-origin', (_value, env) => { env.NOTION_API_BASE_URL = 'https://api.notion.com/v1'; }],
    ['escaping-state', (_value, env) => { env.NTN_SKILLS_HOME = directory; }],
    ['escaping-missing-cache', (_value, env) => { env.NTN_SKILLS_CACHE_HOME = 'outside-cache/future'; }],
    ['missing-directory', value => { value.default_view.source_cache = 'missing'; }],
    ['wrong-scope', value => { value.snapshots[0].scope = 'b'.repeat(64); }],
    ['wrong-body', value => { value.snapshots[0].files[0].bytes++; }],
    ['ambiguous-fixture', value => { value.ambiguous_names = true; }],
  ]) {
    const bad = structuredClone(input), badEnv = { ...environment }; mutate(bad, badEnv);
    await save(file, bad); await save(env, badEnv);
    await assert.rejects(copySdkDiscoveryFixture(file, path.join(directory, name)));
    assert.equal(fs.existsSync(path.join(directory, name)), false, 'Invalid source input must fail before copying');
  }
  await save(file, input); await save(env, environment);
  await assert.rejects(copySdkDiscoveryFixture(file, path.join(source, 'nested-clone')));
});

async function fixture(mutate, options = {}) {
  const directory = await mkdtemp(path.join(await systemTempRoot(), 'graph-host-index-'));
  const cache = path.join(directory, 'cache'), responses = path.join(directory, 'responses'), output = path.join(directory, 'observer.jsonl');
  const body = options.body ?? 'Read [the release checklist](references/checklist.md).\n', resource = 'Exact pinned checklist.\n';
  const owner = options.owner ?? 'shared_skill:controlled:index-root', scope = 'a'.repeat(64), snapshot = 's_' + hash(body), version = hash('version');
  const ref = (file, id) => 'skill://' + encodeURIComponent(owner) + '/' + file + '?snapshot=' + snapshot + '&file_id=' + id;
  const definitions = [['SKILL.md', body, 'main-file'], ...(options.resources ?? [['references/checklist.md', resource, 'checklist-file'], ['references/unmentioned.md', 'Not discovered.\n', 'unmentioned-file']])];
  const files = definitions
    .map(([file, content, id]) => ({ path: file, bytes: Buffer.byteLength(content), sha256: hash(content), ref: ref(file, id) }));
  const bindings = files.map((file, index) => ({ file_id: definitions[index][2], page_id: `${index + 1}1111111-2222-4333-8444-555555555555`, path: file.path }));
  const record = { id: owner, kind: 'skill', entrypoint: 'SKILL.md', ref: 'skill://' + encodeURIComponent(owner) + '/SKILL.md',
    ...(options.name ? { name: options.name, alias: options.alias } : {}) };
  const entry = path.join(cache, 'scopes', scope, 'records', hash(owner), 'entries', snapshot), tree = path.join(entry, 'tree');
  await mkdir(tree, { recursive: true }); await mkdir(responses); await writeFile(output, ''); await writeFile(path.join(tree, 'SKILL.md'), body);
  const manifest = { version: 1, projection: 'entry', manifest_complete: true, scope, id: owner, snapshot_id: snapshot, version_id: version,
    entrypoint: 'SKILL.md', ref: files[0].ref, files, file_bindings: bindings };
  await save(path.join(entry, '.broker-entry.json'), manifest);
  await save(path.join(responses, 'read.json'), { code: 0, command: 'read', response: { ok: true, record, scope, snapshot_id: snapshot,
    version_id: version, ref: files[0].ref, path: 'SKILL.md', content: body, file_bindings: bindings } });
  await save(path.join(responses, 'prepare.json'), { code: 0, command: 'prepare', response: { ok: true, status: 'ready', purpose: 'use', scope, nodes: [{ id: owner,
    state: 'prepared', path: 'SKILL.md', body_sha256: hash(body), binding: { snapshot_id: snapshot, ref: files[0].ref }, files }] } });
  const index = path.join(directory, 'host-index', 'source', 'record'), main = path.join(index, 'SKILL.md'), published = '# Published catalog projection\n';
  await mkdir(index, { recursive: true }); await writeFile(main, published);
  const receipt = { version: 1, projection: 'host_index', loaded: false, scope, id: owner, snapshot_id: snapshot, version_id: version,
    ref: files[0].ref, entrypoint: 'SKILL.md', source: { bytes: Buffer.byteLength(body), sha256: hash(body) },
    published: { path: 'SKILL.md', bytes: Buffer.byteLength(published), sha256: hash(published) }, manifest_id: hash(JSON.stringify(manifest)) };
  if (mutate) mutate(receipt); await save(path.join(index, '.broker-host-index.json'), receipt);
  const originalFetch = globalThis.fetch, handlers = new Map(), ctx = { model: { provider: 'controlled', id: 'fake' } };
  observeGraphGate({ on: (event, handler) => handlers.set(event, handler), setActiveTools: async () => {} },
    { fs, crypto, path, parseNativeReference, cwd: directory, cache, responses, output, rootRef: record.ref, model: 'controlled/fake', prompt: 'controlled task' });
  const system = '<skill><name>root</name><location>' + main + '</location></skill>';
  handlers.get('before_agent_start')({ systemPrompt: system, prompt: 'controlled task' }, ctx);
  handlers.get('before_provider_request')({ payload: { model: 'fake', tools: GRAPH_GATE_TOOLS.map(name => ({ type: 'function', function: { name } })), messages: [{ role: 'system', content: system }] } }, ctx);
  const call = (id, target) => { handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path: target } }] } });
    return handlers.get('tool_call')({ toolName: 'read', toolCallId: id, input: { path: target } }); };
  const result = (id, content) => handlers.get('tool_result')({ toolName: 'read', toolCallId: id, content: [{ type: 'text', text: content }] });
  return { directory, index, main, tree, body, resource, files, call, result, receipt, cache, responses, manifest, record, owner, scope, snapshot, version, handlers, ctx,
    events: async () => (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse), close: () => { globalThis.fetch = originalFetch; } };
}

test('H4 sequence 29: a complete advertised host-index main authorizes only its linked exact manifest resource alias', async () => {
  const f = await fixture(), alias = path.join(f.index, 'references/checklist.md');
  try {
    assert.equal(f.call('too-early', alias).block, true);
    assert.equal(f.call('partial-main', f.main), undefined); f.result('partial-main', f.body.slice(0, 12));
    assert.equal(f.call('still-early', alias).block, true);
    assert.equal(f.call('main', f.main), undefined); f.result('main', f.body);
    assert.equal(f.call('resource', alias), undefined);
    await mkdir(path.join(f.tree, 'references')); await writeFile(path.join(f.tree, 'references/checklist.md'), f.resource);
    f.result('resource', f.resource);
    const read = (await f.events()).find(event => event.phase === 'tool-result' && event.toolCallId === 'resource');
    assert.equal(read.complete, true); assert.equal(read.ref, f.files[1].ref); assert.equal(read.sha256, f.files[1].sha256); assert.equal(read.bytes, f.files[1].bytes);
    assert.equal(f.call('unmentioned', path.join(f.index, 'references/unmentioned.md')).block, true);
    assert.equal(f.call('traversal', f.index + '/references/../references/checklist.md').block, true);
    const outside = path.join(f.directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'checklist.md'), f.resource);
    await symlink(outside, path.join(f.index, 'references'), 'dir');
    assert.equal(f.call('internal-symlink', alias).block, true);
  } finally { f.close(); }
});

const h5Owner = 'shared_skill:library-992754f7-01c1-4ad1-a492-81f6f35d4ed6:import-3ff5636c236e81bb9a46c4b601586df2';
const h5Resources = [
  ['references/feature-map-example/README.md', 'Controlled README resource.\n', 'import-file-110f2d3c405e65cdcbcf167093f51e1d7420214a050c395eb35e2e3bf03fbec0'],
  ['references/feature-map-example/create-note.md', 'Controlled create-note resource.\n', 'import-file-7a8b83bbc601fad8bb6095b900d755ffb5a37fe3ecb898a03d1c0d260b92182b'],
  ['references/feature-map-example/search.md', 'Controlled search resource.\n', 'import-file-b0c3812b0af51fa726845ee4c4830c04daf36cf531963b2f1ff2ba72cc32575a'],
];
const bareRef = (owner, file) => 'skill://' + encodeURIComponent(owner) + '/' + file;
const expectedIdentity = (f, index) => ({ scope: f.scope, ownerId: f.owner, path: f.files[index].path, snapshot: f.snapshot,
  fileId: new URL(f.files[index].ref).searchParams.get('file_id'), sha256: f.files[index].sha256, bytes: f.files[index].bytes });
const readMain = f => { assert.equal(f.call('main', f.main), undefined); f.result('main', f.body); };
async function materialize(f, file, content) {
  await mkdir(path.dirname(path.join(f.tree, file)), { recursive: true }); await writeFile(path.join(f.tree, file), content);
}

for (const [index, [file, content]] of h5Resources.entries()) test('H5 A sequence ' + (69 + index) + ': an actually discovered resource may omit snapshot and File ID', async () => {
  const f = await fixture(undefined, { owner: h5Owner, resources: h5Resources, body: h5Resources.map(([file]) => '[resource](' + file + ')').join('\n') + '\n' });
  const input = bareRef(h5Owner, file);
  try {
    assert.equal(f.call('undiscovered', input).block, true);
    readMain(f);
    assert.equal(f.call('resource', input), undefined, 'The verified pending manifest must resolve the original H5 input without requiring optional query fields');
    await materialize(f, file, content); f.result('resource', content);
    const events = await f.events(), call = events.find(event => event.phase === 'tool-call' && event.toolCallId === 'resource');
    const read = events.find(event => event.phase === 'tool-result' && event.toolCallId === 'resource');
    assert.deepEqual(call.expected, expectedIdentity(f, index + 1));
    assert.equal(read.complete, true); assert.equal(read.ref, f.files[index + 1].ref);
    assert.equal(read.scope, f.scope); assert.equal(read.ownerId, h5Owner); assert.equal(read.snapshot, f.snapshot);
    assert.equal(read.logicalId, new URL(f.files[index + 1].ref).searchParams.get('file_id'));
    assert.equal(read.sha256, hash(content)); assert.equal(read.bytes, Buffer.byteLength(content));
  } finally { f.close(); }
});

test('discovered resource identity accepts either optional field but rejects explicit mismatches and guessed paths', async () => {
  const f = await fixture(), bare = bareRef('shared_skill:controlled:index-root', 'references/checklist.md');
  try {
    readMain(f);
    for (const [index, input] of [bare + '?snapshot=' + f.snapshot, bare + '?file_id=checklist-file', f.files[1].ref].entries()) {
      assert.equal(f.call('valid-' + index, input), undefined);
    }
    const invalid = [bare + '?snapshot=wrong-pin', bare + '?file_id=wrong-file', bare + '?file_id=', bare + '?snapshot=',
      bare.replace('checklist.md', 'wrong-path.md') + '?file_id=checklist-file', bare.replace(encodeURIComponent(f.owner), 'different-owner'),
      bareRef(f.owner, 'references/unmentioned.md'), path.join(f.directory, 'references/checklist.md'),
      path.join(f.cache, 'scopes', f.scope, 'records', hash(f.owner), 'entries', 's_' + 'b'.repeat(64), 'tree', 'references/checklist.md')];
    for (const [index, input] of invalid.entries()) assert.equal(f.call('invalid-' + index, input).block, true, input);
    await materialize(f, 'references/checklist.md', f.resource);
    for (let index = 0; index < 3; index++) f.result('valid-' + index, f.resource);
    assert.equal((await f.events()).filter(event => event.phase === 'tool-result' && event.toolCallId.startsWith('valid-') && event.complete).length, 3);
  } finally { f.close(); }
});

async function writeVariant(f, { scope = f.scope, snapshot = f.snapshot, fileId = 'checklist-file' }, suffix = 'variant') {
  const manifest = structuredClone(f.manifest); manifest.scope = scope; manifest.snapshot_id = snapshot;
  manifest.file_bindings.find(binding => binding.path === 'references/checklist.md').file_id = fileId;
  for (const file of manifest.files) {
    const id = manifest.file_bindings.find(binding => binding.path === file.path).file_id;
    file.ref = bareRef(f.owner, file.path) + '?snapshot=' + snapshot + '&file_id=' + id;
  }
  manifest.ref = manifest.files[0].ref;
  const entry = path.join(f.cache, 'scopes', scope, 'records', hash(f.owner), 'entries', snapshot);
  await mkdir(path.join(entry, 'tree'), { recursive: true }); await writeFile(path.join(entry, 'tree/SKILL.md'), f.body);
  await save(path.join(entry, '.broker-entry.json'), manifest);
  await save(path.join(f.responses, 'read' + (suffix ? '-' + suffix : '') + '.json'), { code: 0, command: 'read', response: {
    ok: true, record: f.record, scope, snapshot_id: snapshot, version_id: f.version,
    ref: manifest.ref, path: 'SKILL.md', content: f.body, file_bindings: manifest.file_bindings } });
  await save(path.join(f.responses, 'prepare' + (suffix ? '-' + suffix : '') + '.json'), { code: 0, command: 'prepare', response: { ok: true, status: 'ready', purpose: 'use', scope,
    nodes: [{ id: f.owner, state: 'prepared', path: 'SKILL.md', body_sha256: hash(f.body), binding: { snapshot_id: snapshot, ref: manifest.ref }, files: manifest.files }] } });
}

test('an actually discovered stable File ID alias keeps its old display path while rejecting guessed aliases', async () => {
  const input = bareRef('shared_skill:controlled:index-root', 'references/old-checklist.md') + '?file_id=checklist-file';
  const f = await fixture(undefined, { body: 'Read [the checklist](' + input + ').\n' });
  try {
    readMain(f);
    assert.equal(f.call('guessed-alias', input.replace('old-checklist.md', 'unmentioned-alias.md')).block, true);
    assert.equal(f.call('missing-file-id', input.split('?')[0]).block, true);
    assert.equal(f.call('wrong-pin', input + '&snapshot=wrong-pin').block, true);
    for (const [index, alias] of [input, input + '&snapshot=' + f.snapshot].entries()) assert.equal(f.call('alias-' + index, alias), undefined);
    await materialize(f, 'references/checklist.md', f.resource);
    for (let index = 0; index < 2; index++) f.result('alias-' + index, f.resource);
    const events = await f.events(), reads = events.filter(event => event.phase === 'tool-result' && event.toolCallId.startsWith('alias-'));
    assert.equal(reads.length, 2);
    for (const read of reads) {
      assert.equal(read.complete, true); assert.equal(read.ref, f.files[1].ref); assert.equal(read.path, 'references/checklist.md');
      assert.deepEqual(events.find(event => event.phase === 'tool-call' && event.toolCallId === read.toolCallId).expected, expectedIdentity(f, 1));
    }
  }
  finally { f.close(); }
});

for (const [name, change] of [['scope', { scope: 'b'.repeat(64) }], ['snapshot', { snapshot: 's_' + 'b'.repeat(64) }]]) test('an exactly discovered unqualified ref cannot choose between two verified ' + name + ' identities', async () => {
  const input = bareRef('shared_skill:controlled:index-root', 'references/checklist.md');
  const f = await fixture(undefined, { body: 'Read [the checklist](' + input + ').\n' });
  try {
    readMain(f); await writeVariant(f, change);
    assert.equal(f.call('ambiguous', input).block, true, 'Exact prior appearance cannot bypass immutable identity ambiguity');
  } finally { f.close(); }
});

test('an unqualified read receipt cannot change its File ID after the call even when the bytes are identical', async () => {
  const input = bareRef('shared_skill:controlled:index-root', 'references/checklist.md');
  const f = await fixture(undefined, { body: 'Read [the checklist](' + input + ').\n' });
  try {
    readMain(f); assert.equal(f.call('resource', input), undefined);
    await writeVariant(f, { fileId: 'replacement-file' }, '');
    await materialize(f, 'references/checklist.md', f.resource); f.result('resource', f.resource);
    const read = (await f.events()).find(event => event.phase === 'tool-result' && event.toolCallId === 'resource');
    assert.equal(read.complete, false, 'Final attribution must retain the call-time expected identity');
  } finally { f.close(); }
});

function authoredTool(f, id, name, input) {
  f.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: input }] } });
  return f.handlers.get('tool_call')({ toolName: name, toolCallId: id, input });
}

test('a disclosed fixed resource accepts only the manifest historical name or alias with the same pin', async () => {
  const f = await fixture(undefined, { name: 'Historical Skill', alias: 'historical-skill' });
  const named = name => 'skill://' + encodeURIComponent(name) + '/references/checklist.md?snapshot=' + f.snapshot;
  try {
    assert.equal(f.call('before-disclosure', named(f.record.name)).block, true);
    readMain(f);
    await save(path.join(f.responses, 'renamed-current.json'), { command: 'list', code: 0, response: { ok: true, scope: f.scope,
      records: [{ ...f.record, name: 'Renamed Current', alias: 'renamed-current' }] } });
    for (const name of [f.record.name, f.record.alias]) assert.equal(f.call(name, named(name)), undefined);
    assert.equal(f.call('current-name-is-not-history', named('renamed-current')).block, true);
    assert.equal(f.call('wrong-pin', named(f.record.name).replace(f.snapshot, 's_' + 'b'.repeat(64))).block, true);
    assert.equal(f.call('unseen-resource', named(f.record.alias).replace('checklist.md', 'unmentioned.md')).block, true);
    await materialize(f, 'references/checklist.md', f.resource);
    for (const name of [f.record.name, f.record.alias]) f.result(name, f.resource);
    const reads = (await f.events()).filter(event => event.phase === 'tool-result' && [f.record.name, f.record.alias].includes(event.toolCallId));
    assert.equal(reads.length, 2);
    for (const read of reads) { assert.equal(read.complete, true); assert.equal(read.ref, f.files[1].ref); assert.equal(read.scope, f.scope); }
  } finally { f.close(); }
});

test('disclosed current names cannot choose between two visible owners or drift scope after admission', async () => {
  const other = 'shared_skill:controlled:other', otherRef = bareRef(other, 'SKILL.md');
  const f = await fixture(undefined, { name: 'Visible Skill', alias: 'visible-skill', body: 'Another disclosed owner: ' + otherRef + '\n' });
  const input = 'skill://visible-skill/SKILL.md';
  try {
    readMain(f);
    assert.equal(f.call('admitted-main', input), undefined);
    await save(path.join(f.responses, 'changed-scope.json'), { command: 'list', code: 0, response: { ok: true, scope: 'b'.repeat(64), records: [f.record] } });
    f.result('admitted-main', f.body);
    assert.equal((await f.events()).find(event => event.phase === 'tool-result' && event.toolCallId === 'admitted-main').complete, false);
    await save(path.join(f.responses, 'changed-scope.json'), { command: 'list', code: 0, response: { ok: true, scope: f.scope,
      records: [{ ...f.record, id: other, ref: otherRef }] } });
    assert.equal(f.call('ambiguous-name', input).block, true);
    assert.equal(authoredTool(f, 'ambiguous-use', 'notion_use', { ref: input }).block, true);
  } finally { f.close(); }
});

test('a disclosed name retains its original scope when source work finishes before observer admission', async () => {
  const f = await fixture(undefined, { name: 'Visible Skill', alias: 'visible-skill' }), input = { path: 'skill://visible-skill/SKILL.md' };
  try {
    readMain(f);
    f.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'pre-admission-scope', name: 'read', arguments: input }] } });
    const authored = (await f.events()).find(event => event.phase === 'authored-tool-call' && event.toolCallId === 'pre-admission-scope');
    assert.equal(authored.nameSelection.expected.scope, f.scope);
    await writeVariant(f, { scope: 'b'.repeat(64) }, 'changed-scope');
    assert.equal(f.handlers.get('tool_call')({ toolName: 'read', toolCallId: 'pre-admission-scope', input }), undefined);
    f.result('pre-admission-scope', f.body);
    const events = await f.events(), call = events.find(event => event.phase === 'tool-call' && event.toolCallId === 'pre-admission-scope');
    assert.deepEqual(call.expected, authored.nameSelection.expected);
    assert.equal(events.find(event => event.phase === 'tool-result' && event.toolCallId === 'pre-admission-scope').complete, false);
  } finally { f.close(); }
});

for (const selector of ['Visible Skill', 'visible-skill']) test('named notion_use preserves its raw input and verifies the complete canonical preparation: ' + selector, async () => {
  const f = await fixture(undefined, { name: 'Visible Skill', alias: 'visible-skill' });
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  try {
    const binding = { scope: f.scope, record: f.record, snapshot_id: f.snapshot, version_id: f.version, body_sha256: hash(f.body), ref: f.files[0].ref };
    const directory = { files: f.files, required: [], candidates: [], references: [] };
    const node = { id: f.owner, state: 'prepared', record: f.record, content: f.body, path: 'SKILL.md', bytes: Buffer.byteLength(f.body),
      body_sha256: hash(f.body), binding, ...directory };
    const vector = { version: 1, scope: f.scope, roots: [f.owner], required: [], bindings: [binding] };
    const graph = { scope: f.scope, roots: [f.owner], graph_lock: { ...vector, sha256: hash(canonical(vector)) }, budget: {}, usage: {} };
    await save(path.join(f.responses, 'prepare.json'), { requestId: 'actual-named-use', code: 0, command: 'prepare', response: {
      ok: true, status: 'ready', purpose: 'use', ...graph, roots: [{ id: f.owner }], nodes: [node] } });
    readMain(f);
    const id = 'named-use', input = { ref: 'skill://' + encodeURIComponent(selector) };
    assert.equal(authoredTool(f, id, 'notion_use', input), undefined);
    const identity = f.scope + '/' + f.owner, compiled = compileSkillPreparation({ purpose: 'use', roots: [f.files[0].ref],
      records: [{ name: f.record.name, kind: f.record.kind, ref: f.files[0].ref, content: f.body,
        source: { identity, sha256: hash(f.body), bytes: Buffer.byteLength(f.body) }, directory }] });
    const proof = { version: 2, toolCallId: id, purpose: 'use', graphs: [graph], projection: compiled.projection,
      records: [{ version: 2, identity, loaded: true, snapshotId: f.snapshot, bodySha256: hash(f.body), bytes: Buffer.byteLength(f.body),
        binding, directory, delivery: compiled.bodySpans[0] }] };
    f.handlers.get('tool_result')({ toolName: 'notion_use', toolCallId: id, content: [{ type: 'text', text: compiled.content }], details: { contextBrokerPreparation: proof } });
    const events = await f.events(), call = events.find(event => event.phase === 'tool-call' && event.toolCallId === id);
    const read = events.find(event => event.phase === 'tool-result' && event.toolCallId === id);
    assert.deepEqual(call.input, input); assert.equal(call.selectedRoots[0].parsed.selector, f.owner);
    assert.equal(read.complete, true); assert.equal(read.ref, f.files[0].ref); assert.equal(read.scope, f.scope);
    assert.deepEqual(read.preparationProof.requestedRefs, [input.ref]); assert.deepEqual(read.preparationProof.roots, [f.files[0].ref]);
    f.handlers.get('before_provider_request')({ payload: { tools: GRAPH_GATE_TOOLS.map(name => ({ type: 'function', function: { name } })),
      messages: [{ role: 'tool', tool_call_id: id, content: compiled.content }] } }, f.ctx);
    const provider = (await f.events()).filter(event => event.phase === 'provider-request').at(-1);
    assert.equal(provider.toolResults.find(result => result.toolCallId === id).records[0].providerCopies, 1);
  } finally { f.close(); }
});

test('H6 B: public main references may omit their path after exact owner discovery', async () => {
  const f = await fixture(), owner = 'skill://' + encodeURIComponent(f.owner);
  try {
    readMain(f);
    for (const [index, ref] of [owner, owner + '/', owner + '?snapshot=' + f.snapshot, owner.replaceAll('%3A', '%3a')].entries()) {
      assert.equal(authoredTool(f, 'prepare-' + index, 'notion_use', { ref }), undefined, ref);
      assert.equal(f.call('read-' + index, ref), undefined, ref);
      f.result('read-' + index, f.body);
    }
    assert.equal((await f.events()).filter(event => event.phase === 'tool-result' && event.toolCallId.startsWith('read-') && event.complete).length, 4);
    for (const ref of [owner + '?snapshot=s_' + 'b'.repeat(64), 'skill://undiscovered-owner', owner + '?file_id=main-file',
      owner + '?extra=field', owner + '/%2e%2e/SKILL.md', owner + '?snapshot=' + f.snapshot + '&snapshot=' + f.snapshot]) {
      assert.equal(authoredTool(f, 'invalid-' + ref, 'notion_use', { ref }).block, true, ref);
    }
  } finally { f.close(); }
});

test('a discovered unmaterialized metadata owner resolves its declared main path without guessing SKILL.md', async () => {
  const f = await fixture(), owner = 'shared_skill:controlled:metadata-member', ref = bareRef(owner, 'WORKFLOW.md');
  const record = { id: owner, ref, kind: 'skill', entrypoint: 'WORKFLOW.md', name: 'member', description: 'Controlled member.' };
  try {
    await save(path.join(f.responses, 'list.json'), { code: 0, command: 'list', response: { ok: true, scope: f.scope,
      records: [record, { ...record, id: 'shared_skill:controlled:unseen', ref: bareRef('shared_skill:controlled:unseen', 'WORKFLOW.md') }] } });
    const result = { ok: true, state: 'known', count: 1, total_count: 1, has_more: false, next_cursor: null, coverage: { exhaustive: true, sources: [] }, failures: [], records: [{ id: owner, ref, kind: 'skill',
      name: 'member', description: record.description, source: 'notion', scope: f.scope, in_default_view: false, availability: 'available' }] };
    const model = { ...result, records: result.records.map(({ id, scope, ...record }) => record) };
    assert.equal(authoredTool(f, 'search', 'notion_list', { query: 'member' }), undefined);
    f.handlers.get('tool_result')({ toolName: 'notion_list', toolCallId: 'search', content: [{ type: 'text', text: JSON.stringify(model) }], details: result });
    assert.equal(f.call('inspect', 'skill://' + encodeURIComponent(owner)), undefined);
    assert.equal(f.call('unseen', 'skill://' + encodeURIComponent('shared_skill:controlled:unseen')).block, true);
    assert.equal(f.call('guessed-main', bareRef(owner, 'SKILL.md')).block, true);
  } finally { f.close(); }
});

function nativeProvider(f, { location = path.join(f.tree, 'SKILL.md'), reference, body = f.body, proof = true, mutate, assistant = false } = {}) {
  const content = reference === undefined ? '<skill name="controlled" location="' + location + '">\n' + body + '</skill>\nControlled task.'
    : '<context-broker-record kind="skill" ref="' + reference + '"><body>\n' + body + '</body></context-broker-record>';
  const binding = { record: { id: f.owner, kind: 'skill', entrypoint: 'SKILL.md', ref: bareRef(f.owner, 'SKILL.md') },
    scope: f.scope, snapshot_id: f.snapshot, version_id: f.version, body_sha256: hash(f.body), ref: f.files[0].ref };
  if (mutate) mutate(binding);
  const receipt = { version: 2, loaded: true, snapshotId: f.snapshot, bodySha256: hash(f.body), bytes: Buffer.byteLength(f.body),
    delivery: { start: content.indexOf(f.body), end: content.indexOf(f.body) + f.body.length, encoding: 'raw' }, binding };
  const messages = [{ role: assistant ? 'assistant' : 'user', content: [{ type: 'text', text: content }] },
    ...(proof ? [{ role: 'custom', customType: 'context-broker', content: [], details: { records: [receipt] } }] : [])];
  f.handlers.get('context')({ messages }, f.ctx);
  f.handlers.get('before_provider_request')({ payload: { model: 'fake', temperature: undefined, tools: GRAPH_GATE_TOOLS.map(name => ({ type: 'function', function: { name } })),
    messages: [{ role: assistant ? 'assistant' : 'user', content }] } }, f.ctx);
  return content;
}

test('H6 legacy: the actual Pi native skill location binds its complete delivered main before a repeated read', async () => {
  const f = await fixture(), location = path.join(f.tree, 'SKILL.md');
  try {
    nativeProvider(f);
    assert.equal(f.call('native-main', location), undefined);
    f.result('native-main', f.body);
    const events = await f.events(), read = events.find(event => event.phase === 'tool-result' && event.toolCallId === 'native-main');
    assert.equal(read.complete, true); assert.equal(read.ref, f.files[0].ref);
    assert.deepEqual(events.find(event => event.phase === 'tool-call' && event.toolCallId === 'native-main').expected, expectedIdentity(f, 0));
    assert.ok(events.some(event => event.phase === 'provided-native-path' && event.path === location && event.source === 'actual Pi native wrapper'));
  } finally { f.close(); }
});

test('native wrapper discovery requires its actual delivery proof, full body and exact immutable path identity', async () => {
  for (const options of [{ proof: false }, { assistant: true }, { body: 'Partial main.\n' },
    { mutate: binding => { binding.scope = 'b'.repeat(64); } }, { mutate: binding => { binding.snapshot_id = 's_' + 'b'.repeat(64); } },
    { mutate: binding => { binding.record.id = 'another-owner'; } }, { mutate: binding => { binding.ref = binding.ref.replace('main-file', 'other-file'); } }]) {
    const f = await fixture();
    try { nativeProvider(f, options); assert.equal(f.call('invalid-native', path.join(f.tree, 'SKILL.md')).block, true); }
    finally { f.close(); }
  }
  const f = await fixture();
  try {
    nativeProvider(f, { location: path.join(f.directory, 'unadvertised/SKILL.md') });
    assert.equal(f.call('unadvertised-native', path.join(f.tree, 'SKILL.md')).block, true);
    assert.equal(f.call('guessed-native', path.join(f.directory, 'unadvertised/SKILL.md')).block, true);
  } finally { f.close(); }
});

test('a current source wrapper exposes its exact public main ref only with complete owner delivery in that provider payload', async () => {
  const f = await fixture();
  try {
    nativeProvider(f, { reference: f.files[0].ref });
    const events = await f.events(), provided = events.find(event => event.phase === 'provided-native-reference');
    assert.ok(provided, 'Current Broker source wrappers need an independently verified public reference observation');
    assert.equal(provided.source, 'actual Broker source wrapper'); assert.equal(provided.reference, f.files[0].ref);
    assert.equal(provided.ref, f.files[0].ref); assert.equal(provided.ownerId, f.owner);
    assert.equal(provided.scope, f.scope); assert.equal(provided.snapshot, f.snapshot);
    assert.equal(provided.sha256, hash(f.body)); assert.equal(provided.bytes, Buffer.byteLength(f.body));
    assert.equal(provided.providerPayloadSha256, events.filter(event => event.phase === 'provider-request').at(-1).observedPayloadSha256);
    assert.equal(f.call('source-ref-main', provided.reference), undefined); f.result('source-ref-main', f.body);
    const read = (await f.events()).find(event => event.phase === 'tool-result' && event.toolCallId === 'source-ref-main');
    assert.equal(read.complete, true); assert.equal(read.ref, provided.ref); assert.equal(read.sha256, provided.sha256);
  } finally { f.close(); }
});

test('source wrapper ref observation rejects missing body proof, partial or duplicate body, assistant text and identity mismatch', async () => {
  for (const change of [f => ({ proof: false }), f => ({ body: f.body.slice(0, 8) }), f => ({ body: f.body + f.body }),
    f => ({ assistant: true }), f => ({ reference: f.files[0].ref.replace(encodeURIComponent(f.owner), 'wrong-owner') }),
    f => ({ reference: f.files[0].ref.replace(f.snapshot, 's_' + 'e'.repeat(64)) }),
    f => ({ reference: f.files[0].ref.replace('main-file', 'wrong-file') }),
    f => ({ mutate: binding => { binding.scope = 'f'.repeat(64); } })]) {
    const f = await fixture();
    try { nativeProvider(f, { reference: f.files[0].ref, ...change(f) });
      assert.equal((await f.events()).some(event => event.phase === 'provided-native-reference'), false); }
    finally { f.close(); }
  }
});

test('public metadata selection may precede preparation while complete identity and actual call ordering remain required', () => {
  const expected = { ownerId: 'shared_skill:controlled:member', scope: 'a'.repeat(64), path: 'SKILL.md', snapshot: 's_' + hash('pin'),
    fileId: 'main-member', sha256: hash('Complete main.\n'), bytes: Buffer.byteLength('Complete main.\n') };
  const input = { path: 'sr:Cselected-member' }, argumentsSha256 = hash(JSON.stringify(input));
  const reference = 'skill://' + encodeURIComponent(expected.ownerId) + '/SKILL.md';
  const value = {
    expected,
    authored: { toolCallId: 'call-member', sequence: 1, input, argumentsSha256, discovered: true, at: '2026-11-05T00:00:00.010Z' },
    admitted: { toolCallId: 'call-member', sequence: 2, authoredSequence: 1, input: input.path, argumentsSha256, allowed: true,
      claim: { ownerId: expected.ownerId, scope: expected.scope, path: expected.path }, at: '2026-11-05T00:00:00.020Z' },
    preparation: { command: 'ctl', args: ['ctl', 'prepare', reference, '--purpose', 'inspect'], requestId: 'request-member', at: '2026-11-05T00:00:00.030Z' },
    closed: { requestId: 'request-member', code: 0, at: '2026-11-05T00:00:00.040Z' },
    read: { ...expected, toolCallId: 'call-member', callSequence: 2, complete: true, at: '2026-11-05T00:00:00.050Z',
      ref: reference + '?snapshot=' + expected.snapshot + '&file_id=' + expected.fileId },
  };
  assert.equal(verifyPublicReadBoundary(value).selected.snapshot, undefined, 'Metadata is not promoted to a fixed body proof');
  for (const change of [v => { v.admitted.claim.ownerId = 'other'; }, v => { v.read.snapshot = 'wrong'; }, v => { v.read.sha256 = 'wrong'; },
    v => { v.read.complete = false; }, v => { v.read.ref = v.read.ref.replace('main-member', 'wrong-file'); },
    v => { v.read.toolCallId = 'another-call'; }, v => { v.admitted.authoredSequence = 99; }, v => { v.closed.requestId = 'another-request'; },
    v => { v.preparation.args[2] = 'skill://another/SKILL.md'; }, v => { v.preparation.args[4] = 'use'; },
    v => { v.preparation.at = '2026-11-05T00:00:00.001Z'; }, v => { v.closed.at = '2026-11-05T00:00:00.060Z'; }]) {
    const invalid = structuredClone(value); change(invalid); assert.throws(() => verifyPublicReadBoundary(invalid));
  }
});

test('host-index aliases cannot borrow a mismatched scope, pin, main File ID, main hash or manifest', async () => {
  for (const change of [r => { r.scope = 'b'.repeat(64); }, r => { r.snapshot_id = 's_' + 'b'.repeat(64); },
    r => { r.ref = r.ref.replace('main-file', 'another-file'); }, r => { r.source.sha256 = 'b'.repeat(64); }, r => { r.manifest_id = 'b'.repeat(64); }]) {
    const f = await fixture(change);
    try { assert.equal(f.call('main', f.main)?.block, true, 'An invalid catalog binding cannot authorize even its main file'); f.result('main', f.body);
      assert.equal(f.call('resource', path.join(f.index, 'references/checklist.md')).block, true); }
    finally { f.close(); }
  }
});
