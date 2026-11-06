// Controlled HTTPS service for the installed CLI/Pi multi-node A/B session harness.
// Run with Bun. All cache creation belongs to the installed public CLI consumer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const token = 'controlled-ah577-graph-token';
const hash = value => createHash('sha256').update(value).digest('hex');
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index], value = process.argv[index + 1];
  assert.ok(['--output', '--control', '--cli-repo'].includes(flag) && value && !value.startsWith('--'), 'Expected --output DIR --control FILE [--cli-repo DIR]');
  assert.equal(options[flag], undefined, `Repeated ${flag}`);
  options[flag] = value;
}
assert.ok(options['--output'] && options['--control'], '--output and --control are required');
const output = resolve(options['--output']);
const control = resolve(options['--control']);
const repo = resolve(options['--cli-repo'] ?? join(dirname(fileURLToPath(import.meta.url)), '../../notion-skills-cli'));
assert.ok(isAbsolute(output) && isAbsolute(control));
assert.ok(!process.env.NOTION_API_TOKEN || process.env.NOTION_API_TOKEN === token, 'Launch the controlled service without a production NOTION_API_TOKEN');
await mkdir(output, { recursive: true });
const infoPath = join(output, 'server-info.json');
const ledgerPath = join(output, 'http.jsonl');
await writeFile(ledgerPath, '', { flag: 'wx', mode: 0o600 });

const require = createRequire(pathToFileURL(join(repo, 'package.json')));
const { Effect } = await import(pathToFileURL(require.resolve('effect')).href);
const { Notion } = await import(pathToFileURL(join(repo, 'packages/core/src/notion.ts')).href);
const { nativeGraphFixture } = await import(pathToFileURL(join(repo, 'packages/core/test/graph-prepare-live-fixture.ts')).href);
const { id, library } = await import(pathToFileURL(join(repo, 'packages/core/test/shared-snapshot-fixture.ts')).href);
const { registeredSkillProperties } = await import(pathToFileURL(join(repo, 'packages/core/src/shared-library.ts')).href);
const fixture = nativeGraphFixture({ width: 2, filesPerSkill: 0 });
const [root, required, optional] = fixture.pageIds;
const viewId = id(5000);
fixture.pages[0].properties.requires.relation = [{ id: required }];
fixture.pages[0].properties.requires.has_more = false;
fixture.pages[0].properties.members.relation = [{ id: optional }];
fixture.pages[0].properties.members.has_more = false;
for (const [index, page] of fixture.pages.entries()) page.properties.default.checkbox = index === 0;
const roles = ['root', 'required', 'optional'];
let revision, failRefreshRoot = false, editedAtMs = Date.now() - 2000, sequence = 0;
const applyControl = async () => {
  const value = JSON.parse(await readFile(control, 'utf8'));
  assert.ok(value && !Array.isArray(value) && ['A', 'B'].includes(value.revision), 'control.revision must be A or B');
  assert.ok(Object.keys(value).every(key => ['revision', 'fail_refresh_root'].includes(key)), 'Unknown controlled graph option');
  assert.ok(value.fail_refresh_root === undefined || typeof value.fail_refresh_root === 'boolean', 'control.fail_refresh_root must be boolean');
  failRefreshRoot = value.fail_refresh_root === true;
  if (value.revision !== revision) {
    revision = value.revision;
    editedAtMs = Math.max(Date.now(), editedAtMs + 1);
    for (const [index, page] of fixture.pages.entries()) {
      page.last_edited_time = new Date(editedAtMs).toISOString();
      fixture.bodies.set(page.id, `# Controlled ${roles[index]} revision ${revision}\n\nAH577_${roles[index].toUpperCase()}_${revision}\n`);
    }
  }
};
await applyControl();

const cert = join(output, 'cert.pem'), key = join(output, 'key.pem'), certConfig = join(output, 'cert.cnf');
await writeFile(certConfig, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n', { mode: 0o600 });
const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', certConfig], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
assert.equal(certificate.status, 0, certificate.stderr || 'Controlled certificate generation failed');

const view = { id: viewId, name: 'AH577 root only', type: 'table', data_source_id: library.skills.data_source_id, parent: { type: 'database_id', database_id: library.skills.database_id }, url: `https://notion.so/${library.skills.database_id}?v=${viewId}` };
const references = values => ({ results: values, has_more: false, next_cursor: null });
const entityIds = value => {
  if (Array.isArray(value)) return value.flatMap(entityIds);
  if (!value || typeof value !== 'object') return [];
  const own = value.property === 'entity' && typeof value.rich_text?.equals === 'string' ? [value.rich_text.equals] : [];
  return [...own, ...Object.values(value).flatMap(entityIds)];
};
const dispatch = async (method, pathname, path, body) => {
  if (method === 'GET' && pathname === '/v1/users/me') return { object: 'user', id: id(99), type: 'bot', bot: { workspace_id: id(100) } };
  if (method === 'POST' && pathname === '/v1/search') {
    assert.deepEqual(body.filter, { property: 'object', value: 'data_source' });
    assert.equal(body.start_cursor, undefined, 'The controlled search fits one real API page');
    // Cold logical refs use normal Notion metadata discovery. Expose the same
    // fixture Skills data source/parent/properties; the installed CLI still
    // resolves the descriptor through the ordinary database GET below.
    const declarations = registeredSkillProperties(fixture.descriptor.skills);
    const properties = Object.fromEntries(Object.entries(fixture.descriptor.skills.property_ids).map(([name, propertyId]) => {
      const definition = declarations[name], type = Object.keys(definition)[0];
      assert.ok(typeof type === 'string', 'Fixture discovery property has no native type');
      return [name, { id: propertyId, name, type, ...structuredClone(definition) }];
    }));
    return { object: 'list', ...references([{ object: 'data_source', id: library.skills.data_source_id, parent: { type: 'database_id', database_id: library.skills.database_id }, title: [{ type: 'text', plain_text: 'Controlled Skills', text: { content: 'Controlled Skills' } }], database_type: null, in_trash: false, properties }]) };
  }
  if (method === 'GET' && pathname === '/v1/views') {
    assert.equal(new URL(path, 'https://localhost/').searchParams.get('database_id'), library.skills.database_id);
    return references([{ id: viewId, object: 'view' }]);
  }
  if (method === 'GET' && pathname === `/v1/views/${viewId}`) return view;
  if (method === 'POST' && pathname === `/v1/views/${viewId}/queries`) return { ...references([{ id: root, object: 'page' }]), id: randomUUID(), view_id: viewId, expires_at: new Date(Date.now() + 60000).toISOString(), total_count: 1 };
  // nativeGraphFixture's wide-root relation paginator is intentionally replaced
  // with the exact visible one-Required/one-Member relation used by this service.
  const relation = /^\/v1\/pages\/([^/]+)\/properties\/(requires|members)$/u.exec(pathname);
  if (method === 'GET' && relation) {
    const page = fixture.pages.find(value => value.id === relation[1]);
    assert.ok(page, 'Unknown controlled relation owner');
    const name = relation[2];
    const values = page.properties[name].relation.map(value => ({ object: 'property_item', id: name, type: 'relation', relation: value }));
    return { ...references(values), object: 'list', type: 'property_item', property_item: { id: name, type: 'relation', next_url: null } };
  }
  assert.ok(['GET', 'POST', 'PATCH'].includes(method), 'Unsupported controlled method');
  return fixture.run(Effect.flatMap(Notion, api => api.request(path, body, { method })));
};
const handle = async request => {
  const started = performance.now();
  const url = new URL(request.url), method = request.method, path = url.pathname.slice(1) + url.search;
  const raw = method === 'GET' ? '' : await request.text();
  let body, result, status = 200, failure, fault;
  try {
    if (request.headers.get('authorization') !== `Bearer ${token}`) {
      status = 401;
      throw new Error('Controlled service requires its fixed test credential');
    }
    body = raw === '' ? undefined : JSON.parse(raw);
    await applyControl();
    // Current graph preparation obtains the selected root from this complete
    // identity inventory, not from an independent root-page metadata GET.
    if (failRefreshRoot && method === 'POST' && url.pathname === `/v1/data_sources/${library.skills.data_source_id}/query`) {
      status = 404;
      fault = 'refresh-skill-inventory-unavailable';
      result = { object: 'error', status, code: 'object_not_found', message: 'Controlled Skill metadata required by refresh is unavailable' };
    } else result = await dispatch(method, url.pathname, path, body);
  } catch (error) {
    if (status === 200) status = 400;
    failure = error instanceof Error ? error.message : String(error);
    result = { object: 'error', status, code: status === 401 ? 'unauthorized' : 'validation_error', message: failure };
  }
  const serialized = JSON.stringify(result);
  const observed = { sequence: ++sequence, at: new Date().toISOString(), revision, method, path, status, request_bytes: Buffer.byteLength(raw), response_bytes: Buffer.byteLength(serialized), request_body_sha256: hash(raw), response_body_sha256: hash(serialized), entity_ids: [...new Set(entityIds(body))], duration_ms: performance.now() - started, ...(typeof result.markdown === 'string' ? { markdown_sha256: hash(result.markdown), markdown_bytes: Buffer.byteLength(result.markdown), page_id: result.id } : {}), ...(failure ? { failure } : {}), ...(fault ? { fault } : {}) };
  // Never record request headers, credentials, raw Record payloads, or parent env.
  await appendFile(ledgerPath, JSON.stringify(observed) + '\n', { mode: 0o600 });
  return new Response(serialized, { status, headers: { 'Content-Type': 'application/json' } });
};
let pending = Promise.resolve();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) }, fetch(request) {
  const result = pending.then(() => handle(request));
  pending = result.then(() => undefined, () => undefined);
  return result;
} });
const info = { version: 1, kind: 'controlled-notion-native-graph-https', pid: process.pid, origin: server.url.origin, cert, db: library.skills.database_id, database: library.skills.database_id, data_source_id: library.skills.data_source_id, library_id: library.library_id, view: viewId, view_id: viewId, pageIds: fixture.pageIds, pages: { root, required, optional }, logical_ids: { root: `shared_skill:${library.library_id}:a`, required: `shared_skill:${library.library_id}:leaf-0`, optional: `shared_skill:${library.library_id}:leaf-1` }, control, ledger: ledgerPath, cli_repo: repo, token, initial_revision: revision, no_consumer_cache_seed: true, production_requests: 0 };
await writeFile(infoPath, JSON.stringify(info, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ status: 'ready', info: infoPath, origin: server.url.origin }) + '\n');
let stopping = false;
const stop = async signal => {
  if (stopping) return;
  stopping = true;
  server.stop(false);
  await pending;
  await applyControl();
  await writeFile(join(output, 'stopped.json'), JSON.stringify({ signal, requests: sequence, final_revision: revision, fail_refresh_root: failRefreshRoot, at: new Date().toISOString(), production_requests: 0 }) + '\n', { mode: 0o600 });
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
