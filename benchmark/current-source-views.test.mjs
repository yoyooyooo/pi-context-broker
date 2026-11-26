import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { deliveredSourceBodies } from './collect.mjs';
import { CURRENT_SOURCE_CONTRACT, loadCurrentSourceViews } from './current-source-views.mjs';
import { projectSubjectRuntime } from './subject.mjs';
import { RUNTIME_ONLY_SOURCE } from './runtime/episode-visibility.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const measure = text => ({ sha256: sha(text), bytes: Buffer.byteLength(text) });
const pairedBuildRoot = process.env.PAIRED_BUILD_ROOT;

test('current source views reject exposed source before loading an interpreter', async () => {
  const visibility = { source_moved_outside_run: false, projection: { files: [] } };
  await assert.rejects(loadCurrentSourceViews({ runRoot: '/unread-run', buildRoot: '/unread-build',
    candidate: { snapshot: { visibility }, projection: { visibility } } }), { code: 'ERR_ASSERTION' });
});

test('current source views reject a changed projection before reading its files', async () => {
  const visibility = { source_moved_outside_run: true, projection: { files: [{ path: 'unread-file', sha256: 'a'.repeat(64) }] } };
  await assert.rejects(loadCurrentSourceViews({ runRoot: '/unread-run', buildRoot: '/unread-build',
    candidate: { snapshot: { visibility }, projection: { visibility: { ...visibility, projection: { files: [] } } } } }), { code: 'ERR_ASSERTION' });
});

test('current source views reject a changed source disposition even when the projected files match', async () => {
  const visibility = { ...RUNTIME_ONLY_SOURCE, projection: { files: [] } };
  await assert.rejects(loadCurrentSourceViews({ runRoot: '/unread-run', buildRoot: '/unread-build',
    candidate: { snapshot: { visibility }, projection: { visibility: { source_moved_outside_run: true, projection: { files: [] } } } } }), /visibility changed/);
});

test('current collection binds the captured SDK3 parser and resolves Library-qualified prepared resources without SDK2 fallback', {
  skip: !pairedBuildRoot && 'Set PAIRED_BUILD_ROOT to an existing paired build; a CLI entry alone does not identify one.',
}, async t => {
  const buildRoot = await realpath(pairedBuildRoot), buildPath = join(buildRoot, 'build.json');
  const buildBytes = await readFile(buildPath), build = JSON.parse(buildBytes);
  assert.equal(build.version, 1); assert.equal(build.kind, 'paired-build');
  assert.equal(build.root, buildRoot); assert.equal(build.build_id, basename(buildRoot));
  const runRoot = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-current-source-')));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  const projectionRoot = join(runRoot, 'subject-runtime');
  const files = await projectSubjectRuntime({ buildRoot, projectionRoot });
  const visibility = { source_moved_outside_run: true, projection: { files } };
  const candidate = { snapshot: { visibility, build: { path: buildPath, sha256: sha(buildBytes) } }, projection: { visibility } };
  const views = await loadCurrentSourceViews({ runRoot, buildRoot, candidate });
  assert.equal(views.contract, CURRENT_SOURCE_CONTRACT); assert.equal(views.producer.sdk_version, 3);
  const refs = await import(pathToFileURL(join(projectionRoot, 'packages/context-broker/src/native-reference.ts')).href);
  const owner = refs.nativeSkillId('4215636c-236e-81e8-8168-ee2ac696f73a', 'fixture');
  const scope = sha('scope'), snapshot = 's_' + sha('snapshot'), version = sha('version'), body = 'Complete source resource.\n';
  const path = 'references/rules.md', token = 'sr:R' + 'r'.repeat(22), main = 'Use the exact rules.';
  const record = { name: 'fixture', kind: 'skill', ref: 'sr:S' + 's'.repeat(22), content: main,
    directory: { files: [{ path, ref: token, bytes: Buffer.byteLength(body) }], required: [], candidates: [], references: [] } };
  const model = { ok: true, status: 'ready', purpose: 'use', roots: [record.ref], records: [record] }, content = JSON.stringify(model);
  const encoded = JSON.stringify(main).slice(1, -1), start = content.indexOf('"content":') + '"content":"'.length;
  const delivery = { start, end: start + encoded.length, encoding: 'json' }, identity = JSON.stringify(['notion', scope, 'skill', 'shared_skill', owner]);
  const receipt = { version: 2, identity, contentIdentity: JSON.stringify([scope, owner]), loaded: true,
    snapshotId: snapshot, bodySha256: sha(main), bytes: Buffer.byteLength(main), delivery,
    binding: { record: { id: owner, entrypoint: 'SKILL.md' }, scope, snapshot_id: snapshot, version_id: version, body_sha256: sha(main) },
    directory: { ...record.directory, files: [{ path, ref: refs.nativeFileRef(owner, path, snapshot), ...measure(body) }] } };
  const proof = { version: 2, toolCallId: 'prepare', purpose: 'use', records: [receipt], graphs: [{ scope }],
    projection: { version: 1, compiler: 'context-broker/skill-prepare/v1', sourceProjection: 'source-identity/v1', rendered: measure(content),
      records: [{ index: 0, ref: record.ref, source: { identity, ...measure(main) }, rendered: measure(encoded), delivery, state: 'source' }] } };
  const prep = { id: 'prepare', name: 'notion_use', status: 'pass', turn_id: 'turn-1', sequence: 1, end_sequence: 2,
    result: { content: [{ type: 'text', text: content }], details: { contextBrokerPreparation: proof } }, refs: [] };
  const read = { id: 'read', name: 'read', status: 'pass', turn_id: 'turn-1', sequence: 3,
    args: { from: record.ref, path }, result: { content: [{ type: 'text', text: body }], structuredContent: body } };
  assert.equal(deliveredSourceBodies(read, [prep], views)[0]?.body, body);
  assert.deepEqual(deliveredSourceBodies(read, [prep]), [], 'The retained SDK2 interpreter cannot accept the current owner');
  assert.deepEqual(deliveredSourceBodies(read, [prep], null), [], 'Missing current provenance cannot fall back to SDK2');
  receipt.directory.files[0].ref = refs.nativeFileRef(refs.nativeSkillId('11111111-1111-4111-8111-111111111111', 'fixture'), path, snapshot);
  assert.deepEqual(deliveredSourceBodies(read, [prep], views), [], 'Equal text cannot borrow another Library owner');
  await writeFile(join(projectionRoot, 'packages/context-broker/src/ntn-skills-ref.cjs'), 'changed protocol');
  await assert.rejects(loadCurrentSourceViews({ runRoot, buildRoot, candidate }), /evidence changed/);
});
