// Read-only supplementary evidence for an observed retained-source bundle.
// Run with Node 24 against the same CLI source tree used by the installed CLI.
// This collector never prepares a Skill, downloads chunks, or writes Notion.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const helper = fileURLToPath(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const identity = async path => { const bytes = await readFile(path); return { path, bytes: bytes.length, sha256: hash(bytes) }; };
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const unique = values => [...new Set(values)].sort();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const bundle = /^bundle-[0-9a-f]{64}$/u;
const chunk = /^chunk-[0-9a-f]{64}$/u;

export function sourceProofSelection(input) {
  assert.equal(input.version, 1);
  assert.ok(Array.isArray(input.runs) && input.runs.length > 0 && input.runs.length <= 10);
  const owners = new Map(), selections = new Map(), bundles = new Set();
  const scopes = new Set(), libraries = new Set(), entries = new Set(), recordSources = new Set();
  for (const run of input.runs) {
    assert.ok(Array.isArray(run.owners) && run.owners.length > 0 && run.owners.length <= 80);
    assert.ok(Array.isArray(run.bundle_ids) && run.bundle_ids.length > 0 && run.bundle_ids.length <= 80);
    assert.equal(new Set(run.bundle_ids).size, run.bundle_ids.length);
    for (const id of run.bundle_ids) { assert.match(id, bundle); bundles.add(id); }
    assert.ok(Array.isArray(run.records_data_source_ids) && run.records_data_source_ids.length === 1);
    assert.match(run.records_data_source_ids[0], uuid); recordSources.add(run.records_data_source_ids[0]);
    for (const owner of run.owners) {
      assert.match(owner.page_id, uuid); assert.match(owner.database_id, uuid);
      assert.match(owner.scope, /^[0-9a-f]{64}$/u);
      assert.ok(typeof owner.library_id === 'string' && owner.id.startsWith('shared_skill:' + owner.library_id + ':'));
      const previous = owners.get(owner.page_id);
      if (previous) for (const field of ['id', 'scope', 'library_id', 'database_id']) assert.equal(previous[field], owner[field]);
      owners.set(owner.page_id, owner);
      selections.set(owner.page_id, unique([...(selections.get(owner.page_id) ?? []), ...run.bundle_ids]));
      scopes.add(owner.scope); libraries.add(owner.library_id); entries.add(owner.database_id);
    }
    assert.ok(Array.isArray(run.unattributed_retained_attempts));
    for (const attempt of run.unattributed_retained_attempts) {
      assert.equal(attempt.transport, 'direct_http'); assert.equal(attempt.kind, 'body');
      assert.equal(attempt.bodyKind, 'retained_body'); assert.equal(attempt.status, 200);
      assert.equal(attempt.target?.data_source_id, run.records_data_source_ids[0]);
      assert.ok(Array.isArray(attempt.target.entity_ids) && attempt.target.entity_ids.length > 0 && attempt.target.entity_ids.length <= 80);
      for (const id of attempt.target.entity_ids) assert.match(id, chunk);
    }
  }
  for (const values of [scopes, libraries, entries, recordSources]) assert.equal(values.size, 1, 'Collect one exact authorization scope and library at a time');
  assert.ok(owners.size <= 80 && bundles.size <= 80);
  return {
    scope: [...scopes][0], library_id: [...libraries][0], entry: [...entries][0],
    records_data_source_id: [...recordSources][0], bundle_ids: [...bundles].sort(),
    queries: [...owners].sort(([a], [b]) => a.localeCompare(b)).map(([page, owner]) => ({ owner, bundle_ids: selections.get(page) })),
  };
}

export async function collectSourceProof({ inputPath, output, cliRepo }) {
  assert.ok([inputPath, output, cliRepo].every(isAbsolute));
  const input = await json(inputPath), selected = sourceProofSelection(input);
  assert.ok(process.env.NOTION_API_TOKEN, 'Use the existing process NOTION_API_TOKEN; no credential copying or config fallback');
  assert.ok(!process.env.NOTION_API_BASE_URL || process.env.NOTION_API_BASE_URL.replace(/\/$/u, '') === 'https://api.notion.com');
  await mkdir(output, { recursive: false });
  for (const [variable, directory] of [
    ['NTN_SKILLS_CONFIG_HOME', 'oracle-config'], ['NTN_SKILLS_HOME', 'oracle-state'],
    ['NTN_SKILLS_CACHE_HOME', 'oracle-cache'], ['NTN_SKILLS_DATA_HOME', 'oracle-data'],
  ]) process.env[variable] = join(output, directory);
  process.env.NTN_SKILLS_REQUEST_TRACE_LIMIT = '10000';
  const require = createRequire(pathToFileURL(join(cliRepo, 'package.json')));
  const coreImport = path => import(pathToFileURL(join(cliRepo, path)).href);
  const { Effect } = await import(pathToFileURL(require.resolve('effect')).href);
  const { live } = await coreImport('packages/cli/src/command-runtime.ts');
  const { Notion } = await coreImport('packages/core/src/notion.ts');
  const { authScope } = await coreImport('packages/core/src/catalog.ts');
  const { loadSharedLibrary } = await coreImport('packages/core/src/shared-library.ts');
  const { querySharedRecords, canonicalSharedJson } = await coreImport('packages/core/src/shared-records.ts');
  const { validateRetainedSource } = await coreImport('packages/core/src/shared-retained-source.ts');
  const { NOTION_API_VERSION } = await coreImport('packages/core/src/notion-http.ts');
  const effectPackage = await json(require.resolve('effect/package.json'));
  assert.equal(effectPackage.version, '4.0.5');
  const sourceFiles = [
    'packages/cli/src/command-runtime.ts', 'packages/core/src/notion.ts', 'packages/core/src/notion-http.ts',
    'packages/core/src/notion-credential.ts', 'packages/core/src/notion-request-scheduler.ts',
    'packages/core/src/catalog.ts', 'packages/core/src/shared-library.ts', 'packages/core/src/shared-library-model.ts',
    'packages/core/src/shared-records.ts', 'packages/core/src/shared-retained-source.ts', 'packages/core/src/store.ts',
  ];
  const provenance = {
    kind: 'supplementary_read_only_oracle', input: await identity(inputPath), helper: await identity(helper),
    engine: { effect: effectPackage.version, node: process.version, notion_api_version: NOTION_API_VERSION, files: await Promise.all(sourceFiles.map(path => identity(join(cliRepo, path)))) },
    selected, raw_requests: [], library_descriptor: null,
    original_h3_modified: false, consumer_cache_accessed: false, provider_called: false,
    authentication: 'Existing process environment through CLI NotionCredentialProvider; isolated empty project config. Credential values are not saved.',
    accounting: 'All actual HTTP attempts are in request_metrics. Source queries and the entry database response are retained separately. The engine users/me authentication request is counted but its raw personal metadata is not retained.',
  };
  const result = { version: 1, kind: 'retained-source-ownership', status: 'unknown', scope: selected.scope, library_id: selected.library_id, records_data_source_id: selected.records_data_source_id, records: [], request_metrics: null, provenance };
  let api, library, activeQuery, requestNumber = 0;
  try {
    const records = await Effect.runPromise(Effect.gen(function* () {
      api = yield* Notion;
      const observed = { ...api, request: (path, body, options) => Effect.gen(function* () {
        const method = options?.method ?? (body === undefined ? 'GET' : 'POST');
        yield* Effect.sync(() => {
          assert.notEqual(options?.content, 'body', 'Source proof must not acquire body objects');
          if (method === 'GET') {
            assert.equal(path, 'v1/databases/' + selected.entry); assert.equal(body, undefined);
          } else {
            assert.equal(method, 'POST'); assert.ok(library && activeQuery);
            const url = new URL(path, 'https://api.notion.com/');
            assert.equal(url.pathname, '/v1/data_sources/' + selected.records_data_source_id + '/query');
            const ids = library.records.property_ids;
            assert.deepEqual(body, { page_size: 100, filter: { and: [
              { property: ids.Skill, relation: { contains: activeQuery.owner.page_id } },
              { property: ids.Kind, select: { equals: 'source' } },
              { or: activeQuery.bundle_ids.map(id => ({ property: ids['Entity ID'], rich_text: { equals: id } })) },
            ] } });
            assert.equal(activeQuery.requested, false, 'Unexpected pagination; preserve unknown instead of widening the query');
            activeQuery.requested = true;
          }
        });
        const sequence = String(++requestNumber).padStart(3, '0');
        const requestPath = join(output, 'request-' + sequence + '.json');
        yield* Effect.promise(() => save(requestPath, { path, method, ...(body === undefined ? {} : { body }), options: { method, ...(options?.entityPropertyId ? { entityPropertyId: options.entityPropertyId } : {}) } }));
        const response = yield* api.request(path, body, options);
        const responsePath = join(output, 'response-' + sequence + '.json');
        yield* Effect.promise(() => save(responsePath, response));
        provenance.raw_requests.push({ request: yield* Effect.promise(() => identity(requestPath)), response: yield* Effect.promise(() => identity(responsePath)) });
        if (method === 'POST') yield* Effect.sync(() => {
          assert.equal(response.has_more, false, 'Exact source query is unexpectedly incomplete');
          assert.ok(Array.isArray(response.results) && response.results.length <= activeQuery.bundle_ids.length, 'Exact source query returned an unexpected number of rows');
        });
        return response;
      }) };
      return yield* Effect.gen(function* () {
        const scope = yield* authScope;
        assert.equal(scope, selected.scope, 'Current authorization differs from the observed scope');
        library = yield* loadSharedLibrary(selected.entry);
        assert.equal(library.library_id, selected.library_id);
        assert.equal(library.records.data_source_id, selected.records_data_source_id);
        const descriptorPath = join(output, 'library-descriptor.json');
        yield* Effect.promise(() => save(descriptorPath, library));
        provenance.library_descriptor = yield* Effect.promise(() => identity(descriptorPath));
        const collected = [];
        for (const query of selected.queries) {
          activeQuery = { ...query, requested: false };
          const rows = yield* querySharedRecords(library, { skillPageId: query.owner.page_id, kind: 'source', entityIds: query.bundle_ids });
          for (const record of rows) {
            assert.equal(record.kind, 'source'); assert.equal(record.skill_page_id, query.owner.page_id);
            assert.equal(record.record_id, record.entity_id); assert.ok(query.bundle_ids.includes(record.entity_id));
            assert.equal(record.operation_id, 'retain-' + record.record_id);
            const manifest = yield* validateRetainedSource(library, record.payload, record.skill_page_id);
            assert.equal('bundle-' + hash(canonicalSharedJson(manifest)), record.record_id);
            assert.equal(hash(canonicalSharedJson({ version: 1, operation_id: record.operation_id, payload: manifest })), record.hash);
            collected.push(record);
          }
        }
        assert.equal(new Set(collected.map(row => row.record_id)).size, collected.length, 'A bundle has multiple observed owners');
        assert.deepEqual(collected.map(row => row.record_id).sort(), selected.bundle_ids, 'Every observed bundle needs its exact source record');
        return collected.sort((a, b) => a.record_id.localeCompare(b.record_id));
      }).pipe(Effect.provideService(Notion, observed));
    }).pipe(Effect.provide(live)));
    const membership = [];
    for (const run of input.runs) for (const attempt of run.unattributed_retained_attempts) for (const id of attempt.target.entity_ids) {
      const matches = records.filter(row => run.bundle_ids.includes(row.entity_id) && row.payload.archive.chunks.some(part => part.object_id === id));
      assert.equal(matches.length, 1, 'An observed chunk has missing or ambiguous source ownership');
      const record = matches[0], part = record.payload.archive.chunks.find(value => value.object_id === id);
      assert.ok(run.owners.some(owner => owner.page_id === record.skill_page_id));
      membership.push({ gate: run.gate, request_id: attempt.requestId, request_receipt: attempt.requestReceipt, chunk: part, source_record_id: record.record_id, source_record_page_id: record.page_id, owner_page_id: record.skill_page_id });
    }
    result.records = records; result.observed_chunk_membership = membership; result.status = 'verified';
  } catch (error) {
    result.error = { code: error.code ?? 'RETAINED_SOURCE_PROOF_UNRESOLVED', message: String(error.message ?? error).slice(0, 1600) };
  } finally {
    result.request_metrics = api?.requestMetrics?.() ?? null;
    await save(join(output, 'proof.json'), result);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === helper) {
  const [action, ...args] = process.argv.slice(2), options = {};
  assert.ok(['plan', 'collect'].includes(action));
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--input', '--output', '--cli-repo'].includes(args[i]) && args[i + 1] && options[args[i]] === undefined);
    options[args[i]] = resolve(args[i + 1]);
  }
  assert.ok(options['--input'] && options['--output'] && options['--cli-repo']);
  const selected = sourceProofSelection(await json(options['--input']));
  if (action === 'plan') console.log(JSON.stringify({ status: 'planned', selection: selected, output: options['--output'], source_queries: selected.queries.length, metadata_only: true }, null, 2));
  else {
    const result = await collectSourceProof({ inputPath: options['--input'], output: options['--output'], cliRepo: options['--cli-repo'] });
    console.log(JSON.stringify({ status: result.status, proof: join(options['--output'], 'proof.json'), records: result.records.length, error: result.error, request_metrics: result.request_metrics }, null, 2));
    if (result.status !== 'verified') process.exitCode = 1;
  }
}
