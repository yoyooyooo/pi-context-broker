import { nativeSkillId } from '../packages/context-broker/src/native-reference.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, appendFile, chmod, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAgentFixtureRecipe } from './notion-agent-scenarios.mjs';
import { NATIVE_MAIN_EXACT_RESOURCES, agentFixtureCreateArgs, assertAgentFixtureImportCreation,
  agentFixtureRelationArgs as relationArgs, agentFixtureUsesNativeMarkdown } from './notion-agent-authoring.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = path => access(path).then(() => true, () => false);
const inside = (base, path) => { const part = relative(base, path); return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(value);
const pageId = value => typeof value === 'string' && /^[a-f0-9-]{32,36}$/iu.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const clock = () => ({ at: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString() });
const artifact = async path => { const bytes = await readFile(path); return { path, sha256: sha(bytes), bytes: bytes.length }; };
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const rich = value => [{ type: 'text', text: { content: value } }];
const propertiesText = (row, name) => (row.properties?.[name]?.rich_text ?? row.properties?.[name]?.title ?? []).map(part => part.plain_text ?? part.text?.content ?? '').join('');
const pick = (row, ids, name) => Object.values(row.properties ?? {}).find(value => value.id === ids[name]) ?? row.properties?.[name];
const propertyText = (row, ids, name) => { const value = pick(row, ids, name); return value?.select?.name ?? value?.status?.name ?? (value?.rich_text ?? value?.title ?? []).map(part => part.plain_text ?? part.text?.content ?? '').join(''); };
const withoutFrontmatter = value => value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').replace(/\r\n/g, '\n').trimEnd();

function fail(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

async function processCommand(file, args, { cwd, env, timeoutMs = 600000, binaryOutput = false }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let timedOut = false; const chunks = [], errors = [];
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdin.end();
    child.stdout.on('data', data => { chunks.push(data); });
    child.stderr.on('data', data => { errors.push(data); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, timedOut, stdout: binaryOutput ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') }); });
  });
}

/** Only public CLI actions assembled by this module are executable. No shell or command field is accepted. */
async function cli(context, args, label, { allowedFailure } = {}) {
  assert.ok(id(label));
  const started = clock(), path = join(context.root, 'commands', label + '-' + randomUUID() + '.json');
  const env = { ...process.env, ...context.env }; delete env.NTN_SKILLS_DEV_ROOT;
  const result = await processCommand(context.node, [context.cli, ...args], { cwd: context.root, env });
  let value;
  try { value = JSON.parse(result.stdout.trim()); } catch { /* retain exact output before rejecting */ }
  const receipt = { command: [context.node, context.cli, ...args], started, completed: clock(), ...result };
  await save(path, receipt);
  if (allowedFailure && result.code !== 0 && !result.timedOut && value?.ok === false && value.error?.code === allowedFailure)
    return { value, artifact: await artifact(path) };
  if (result.code !== 0 || result.timedOut || !value || value.ok !== true)
    throw fail('AGENT_FIXTURE_CLI_FAILED', 'The public CLI did not complete ' + label + '.', { artifact: await artifact(path), code: result.code, error: value?.error });
  return { value, artifact: await artifact(path) };
}

async function assertOwnership(context) {
  assert.equal(context.version, 1); assert.ok(id(context.runId) && isAbsolute(context.root));
  assert.equal(await realpath(context.root), context.root, 'Fixture root cannot be a symlink');
  const ownership = await json(join(context.root, 'ownership.json'));
  assert.equal(ownership.runId, context.runId); assert.equal(ownership.token, context.ownership.token);
  assert.equal(ownership.root, context.root);
  if (ownership.temporaryRoot !== undefined || context.ownership.temporaryRoot !== undefined) {
    assert.equal(ownership.temporaryRoot, join(context.root, 'temporary'), 'Temporary evidence must stay under its fixture root');
    assert.equal(context.ownership.temporaryRoot, ownership.temporaryRoot);
    assert.equal(await realpath(ownership.temporaryRoot), ownership.temporaryRoot, 'Temporary evidence cannot be a symlink');
    assert.ok((await lstat(ownership.temporaryRoot)).isDirectory());
  }
  return ownership;
}

async function persist(bindings, path) {
  const context = bindings.private.fixture; await assertOwnership(context);
  const target = path ?? join(context.root, 'bindings.json');
  assert.equal(resolve(target), join(context.root, 'bindings.json'), 'Keep bindings under their owned root');
  const temporary = join(context.root, '.bindings-' + randomUUID() + '.json');
  await save(temporary, bindings); await rename(temporary, target);
  return artifact(target);
}

async function request(context, path, { method = 'GET', body, fixtureMutation = false } = {}) {
  assert.ok(/^v1\/(?:pages|blocks|data_sources)\//u.test(path) || path === 'v1/pages' || /^v1\/views(?:\/|\?|$)/u.test(path));
  const isQuery = method === 'POST' && (/^v1\/data_sources\/[a-f0-9-]+\/query$/iu.test(path) || /^v1\/views\/[a-f0-9-]+\/queries$/iu.test(path));
  assert.ok(method === 'GET' || isQuery || fixtureMutation, 'The independent reader cannot perform product writes');
  const configRoot = process.env.NTN_SKILLS_CONFIG_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ntn-skills');
  const token = process.env.NOTION_API_TOKEN ?? (await json(join(configRoot, 'config.json'))).token;
  assert.ok(typeof token === 'string' && token.length > 0, 'Notion credentials are unavailable');
  const readOnly = method === 'GET' || isQuery, maximumAttempts = 3;
  const deadline = performance.now() + 180000;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw fail('AGENT_FIXTURE_NOTION_BUDGET', 'Independent Notion request exceeded its total retry budget.', { method, path, attempt, readOnly });
    const started = clock(); let result, value, failure;
    try {
      result = await fetch('https://api.notion.com/' + path, {
        method, signal: AbortSignal.timeout(Math.min(60000, remaining)),
        headers: { authorization: 'Bearer ' + token, 'Notion-Version': context.apiVersion, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      value = await result.json();
    } catch (error) { failure = error; }
    const rejected = failure === undefined && result?.status === 429 && value?.code === 'rate_limited';
    const transient = failure !== undefined || result?.status === 429 || result?.status >= 500;
    const retryAfter = result?.headers.get('retry-after');
    const seconds = retryAfter == null || retryAfter.trim() === '' ? NaN : Number(retryAfter);
    const date = retryAfter == null ? NaN : Date.parse(retryAfter);
    const delay = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000)
      : Number.isFinite(date) ? Math.max(0, date - Date.now()) : attempt * 250;
    // A rate-limit rejection establishes that a fixture write was not accepted.
    // Transport/5xx failures do not, so only read-only requests may replay those.
    const retry = (rejected || readOnly && transient) && attempt < maximumAttempts && delay < deadline - performance.now();
    await appendFile(join(context.root, 'network-attempts.jsonl'), JSON.stringify({
      method, path, attempt, maximumAttempts, started, completed: clock(), readOnly, retry,
      retryDelayMs: retry ? delay : null, rateLimitRejected: rejected,
      status: result?.status ?? null, ...(failure ? { error: { name: failure.name, message: failure.message, cause: failure.cause?.code } } : {}),
    }) + '\n', { mode: 0o600 });
    if (retry) {
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    if (failure) throw fail('AGENT_FIXTURE_NOTION_TRANSPORT', 'Independent Notion request transport failed.', {
      method, path, attempt, readOnly, outcome: readOnly ? 'unobserved' : 'unknown-no-automatic-replay',
      cause: failure.cause?.code, message: failure.message,
    });
    if (!result.ok) throw fail('AGENT_FIXTURE_NOTION_READBACK', 'Independent Notion request failed.', {
      method, path, status: result.status, code: value.code, message: value.message, attempt,
    });
    return value;
  }
}

function normalizedNotionId(value) {
  assert.ok(typeof value === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(value),
    'Projection trash requires an exact Notion ID');
  return value.replaceAll('-', '').toLowerCase();
}

function assertProjectionTrashIdentity(context, target, row) {
  assert.equal(row?.object, target.kind, 'Projection trash readback changed object kind');
  assert.equal(normalizedNotionId(row.id), normalizedNotionId(target.id), 'Projection trash readback changed identity');
  if (target.kind === 'block') {
    assert.equal(row.parent?.type, target.parent.type, 'Projection trash readback changed parent kind');
    assert.equal(normalizedNotionId(row.parent[target.parent.type]), normalizedNotionId(target.parent[target.parent.type]),
      'Projection trash readback changed parent identity');
  } else assert.equal(propertyText(row, context.library.skills.property_ids, 'Skill ID'), target.skillId,
    'Projection trash readback changed stable Skill identity');
}

/** Only this fixture precondition may establish the desired state after a lost trash acknowledgement. */
async function trashProjectionObject(context, target, confirmations) {
  const path = 'v1/' + (target.kind === 'block' ? 'blocks/' : 'pages/') + target.id;
  try {
    await request(context, path, { method: 'PATCH', body: { in_trash: true }, fixtureMutation: true });
  } catch (error) {
    if (error.code !== 'AGENT_FIXTURE_NOTION_TRANSPORT' || error.details?.method !== 'PATCH' || error.details.path !== path
      || error.details.readOnly !== false || error.details.outcome !== 'unknown-no-automatic-replay') throw error;
    const confirmation = { target, started: clock(), acknowledgement: 'unknown',
      originalError: { code: error.code, message: error.message, details: error.details } };
    confirmations.push(confirmation);
    try {
      // One logical read, using the existing bounded read-only retry policy. Never replay the PATCH.
      const row = await request(context, path); confirmation.readback = row;
      assertProjectionTrashIdentity(context, target, row);
      assert.ok(row.in_trash === true || row.archived === true, 'Projection trash readback is not trashed');
      confirmation.status = 'observed-state';
      return row;
    } catch (readError) {
      confirmation.status = 'failed';
      confirmation.error = { code: readError.code, message: readError.message, details: readError.details };
      throw error;
    } finally { confirmation.completed = clock(); }
  }
}

async function pages(context, section, filter) {
  const output = []; let cursor;
  do {
    const page = await request(context, 'v1/data_sources/' + context.library[section].data_source_id + '/query', {
      method: 'POST', body: { page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) },
    });
    assert.ok(Array.isArray(page.results)); output.push(...page.results);
    if (page.has_more) assert.ok(typeof page.next_cursor === 'string' && page.next_cursor !== cursor);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return output;
}

async function children(context, blockId) {
  const output = []; let cursor;
  do {
    const page = await request(context, 'v1/blocks/' + blockId + '/children?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''));
    assert.ok(Array.isArray(page.results)); output.push(...page.results);
    if (page.has_more) assert.ok(typeof page.next_cursor === 'string' && page.next_cursor !== cursor);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return output;
}

async function tree(context, blockId) {
  const output = [];
  for (const block of await children(context, blockId)) output.push({ ...block, ...(block.has_children ? { children: await tree(context, block.id) } : {}) });
  return output;
}

export function blockShape(blocks) {
  return blocks.map(block => {
    assert.ok(typeof block.type === 'string' && block[block.type] && typeof block[block.type] === 'object', 'Unknown reading-projection block');
    const content = structuredClone(block[block.type]); delete content.children;
    return { type: block.type, content, ...(block.children ? { children: blockShape(block.children) } : {}) };
  });
}

/** Use the same selected package's current-writer semantics, never a second Markdown normalizer. */
async function nativeMarkdownComparator(context) {
  const entry = await realpath(context.cli);
  let root = dirname(entry);
  while (!(await exists(join(root, 'package.json')))) {
    const parent = dirname(root); assert.notEqual(parent, root, 'Selected fixture CLI has no package manifest'); root = parent;
  }
  const manifestPath = join(root, 'package.json'), manifest = await json(manifestPath);
  assert.equal(manifest.name, 'ntn-skills', 'Native comparison requires the selected ntn-skills package');
  assert.equal(typeof manifest.bin?.['ntn-skills'], 'string');
  assert.equal(await realpath(resolve(root, manifest.bin['ntn-skills'])), entry, 'Selected fixture CLI differs from its public package bin');
  const exported = manifest.exports?.['./sdk'], target = typeof exported === 'string' ? exported : exported?.import;
  assert.equal(typeof target, 'string', 'Selected fixture CLI has no public SDK export');
  const sdkPath = await realpath(resolve(root, target));
  assert.ok(inside(root, sdkPath), 'Selected fixture SDK must stay inside its CLI package');
  const binding = { cli: await artifact(entry), manifest: await artifact(manifestPath), sdk: await artifact(sdkPath) };
  if (context.nativeMarkdownSdk) assert.deepEqual(binding, context.nativeMarkdownSdk, 'Selected fixture CLI/SDK build identity changed');
  const sdk = await import(pathToFileURL(sdkPath).href);
  if (sdk.SDK_VERSION !== 3 || sdk.PACKAGE_VERSION !== manifest.version || typeof sdk.compareNativeMarkdown !== 'function')
    throw fail('AGENT_FIXTURE_NATIVE_COMPARISON_UNAVAILABLE', 'The selected CLI SDK must export its current Native Markdown comparator.', { sdk: binding.sdk });
  context.nativeMarkdownSdk ??= binding;
  return sdk.compareNativeMarkdown;
}

function fileBytes(file) { return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'); }

function effectiveFile(file, object, name) {
  let bytes = fileBytes(file);
  if (file.path === 'SKILL.md' && file.encoding !== 'base64') {
    const body = withoutFrontmatter(bytes.toString('utf8'));
    bytes = Buffer.from('---\nname: ' + name + '\ndescription: ' + JSON.stringify(object.description) + '\n---\n\n' + body + '\n');
  }
  return bytes;
}

async function prepareVersionInputs(context, object, name) {
  const versions = {};
  for (const [version, value] of Object.entries(object.versions ?? {})) {
    const directory = join(context.root, 'inputs', object.id, version); await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = [];
    for (const file of value.files) {
      const path = resolve(directory, file.path); assert.ok(inside(directory, path));
      const expanded = file.encoding === 'base64' ? file : { ...file, content: file.content.replaceAll(/\{\{([A-Za-z0-9_.-]+)\}\}/gu, (_match, key) => {
        const names = new Map(context.recipe.objects.map(item => [item.id + '.name', item.placement === 'builtin' ? item.name : item.name + '-' + sha(context.runId).slice(0, 8)]));
        const value = names.get(key) ?? context.recipe.public?.[key];
        assert.equal(typeof value, 'string', 'Unknown public content substitution ' + key); return value;
      }) };
      const bytes = object.placement === 'source' ? fileBytes(expanded) : effectiveFile(expanded, object, name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o700 : 0o600 });
      files.push({ path: file.path, input: path, sha256: sha(bytes), bytes: bytes.length, mode: file.mode ?? '100644' });
    }
    versions[version] = { directory, files, requires: value.requires ?? [], members: value.members ?? [],
      ...(value.enabled === undefined ? {} : { enabled: value.enabled }), ...(value.defaultContext === undefined ? {} : { defaultContext: value.defaultContext }) };
  }
  return versions;
}

async function capture(context, path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await save(path, value); return artifact(path);
}

async function freezeObservedBytes(context, bytes) {
  const directory = join(context.root, 'oracles'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, sha(bytes));
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(sha(await readFile(path)), sha(bytes), 'Frozen oracle bytes changed'); }
  return path;
}

async function sealReadback(context, key, result) {
  const rawEvidence = result.artifact, receipt = { ...result, rawEvidence }; delete receipt.artifact;
  const path = join(context.root, 'readbacks', key.replaceAll(/[^a-zA-Z0-9_-]/g, '_') + '-receipt-' + randomUUID() + '.json');
  await save(path, receipt);
  const sealed = { ...receipt, artifact: await artifact(path) }; context.observedReadbacks[key] = sealed;
  return sealed;
}

async function actualSkill(context, owned) {
  if (owned.pageId) return request(context, 'v1/pages/' + owned.pageId);
  let rows = await pages(context, 'skills', { property: context.library.skills.property_ids['Skill ID'], rich_text: { equals: owned.skillId } });
  if (rows.length === 0 && owned.pendingIdentity) {
    rows = await pages(context, 'skills', { property: context.library.skills.property_ids.Name, title: { equals: owned.name } });
    assert.ok(rows.length <= 1, 'The user-visible fixture name is ambiguous');
    if (rows[0]) assert.ok(Date.parse(rows[0].created_time) >= Date.parse(context.ownership.createdAt) - 60000, 'A pre-existing page cannot be adopted as test output');
  }
  assert.ok(rows.length <= 1, 'Fixture stable ID identifies multiple pages');
  if (!rows[0]) return null;
  owned.pageId = rows[0].id;
  return rows[0];
}

async function captureReadback(bindings, alias, { version, key = alias, state = 'present', properties, projection, expected = state === 'absent' ? 'absent' : 'live' } = {}) {
  const context = bindings.private.fixture; await assertOwnership(context);
  const owned = context.objects[alias]; assert.ok(owned, 'Unknown owned object: ' + alias);
  const identity = bindings.private.objects[alias], label = version ?? owned.currentVersion;
  const receiptPath = join(context.root, 'readbacks', alias + '-' + randomUUID() + '.json');
  if (owned.placement === 'global' || owned.placement === 'project') {
    const files = [];
    for (const entry of owned.versionInputs[label].files) {
      const path = join(owned.directory, entry.path), bytes = await readFile(path);
      assert.equal(sha(bytes), entry.sha256, 'Local fixture file differs from the chosen version');
      files.push({ ...entry, localPath: path, sha256: sha(bytes), bytes: bytes.length });
      bindings.private.bodies[alias + '@' + label + '/' + entry.path] = { path: await freezeObservedBytes(context, bytes), observedPath: path, sha256: sha(bytes), bytes: bytes.length, object: alias, version: label, resourcePath: entry.path };
    }
    const captured = await capture(context, receiptPath, { kind: 'local', directory: owned.directory, files, observedAt: clock() });
    identity.versions[label] = { bodyKeys: files.map(file => alias + '@' + label + '/' + file.path), readback: key };
    identity.currentVersion = label;
    const result = { status: 'passed', object: { owner: identity.owner }, artifact: captured,
      observed: { state: 'present', files, discovery: 'filesystem-only-not-model-visibility' },
      assertions: [{ id: 'exact-local-files', status: 'passed' }], externalRepair: false };
    bindings.private.readbacks[key] ??= { object: alias, state: expected === 'absent' ? 'absent' : 'present', ...(expected === 'absent' ? {} : { version: label }) }; return sealReadback(context, key, result);
  }

  const row = await actualSkill(context, owned);
  if (expected === 'absent') {
    assert.ok(!row || row.in_trash === true || row.archived === true, 'Skill still live after deletion');
    const retired = [];
    for (const child of owned.knownChildren ?? []) {
      const current = await request(context, 'v1/pages/' + child.pageId);
      assert.ok(current.in_trash === true || current.archived === true, 'An owned child was left live');
      retired.push({ id: child.pageId, kind: child.kind, in_trash: true });
    }
    const captured = await capture(context, receiptPath, { row, retired, observedAt: clock() });
    const result = { status: 'passed', object: { owner: identity.owner }, artifact: captured, observed: { state: 'absent', absent: true, retired },
      assertions: [{ id: 'main-absent', status: 'passed' }, { id: 'known-owned-children-retired', status: 'passed' }], externalRepair: false };
    bindings.private.readbacks[key] ??= { object: alias, state: expected === 'absent' ? 'absent' : 'present', ...(expected === 'absent' ? {} : { version: label }) }; return sealReadback(context, key, result);
  }
  assert.ok(row && row.archived !== true && row.in_trash !== true, 'Owned Skill is not live');
  owned.pageId = row.id; identity.pageId = row.id; identity.owner = 'notion_page:' + row.id;
  identity.url = row.url ?? 'https://www.notion.so/' + row.id.replaceAll('-', '');
  bindings.public[alias + '.url'] = identity.url;
  const ids = context.library.skills.property_ids;
  if (properties) {
    assert.ok(Object.keys(properties).every(key => ['description', 'enabled', 'defaultContext'].includes(key)), 'Unknown metadata readback');
    if (properties.description !== undefined) assert.equal(propertyText(row, ids, 'Description'), properties.description);
    if (properties.enabled !== undefined) assert.equal(pick(row, ids, 'Enabled')?.checkbox, properties.enabled);
    if (properties.defaultContext !== undefined) assert.equal(pick(row, ids, 'Default Context')?.checkbox, properties.defaultContext);
  }
  if (owned.pendingIdentity) {
    const stable = propertyText(row, ids, 'Skill ID'); assert.ok(stable.length > 0, 'Product did not register a stable Skill identity');
    owned.skillId = stable; identity.skillId = stable; owned.pendingIdentity = false;
  }
  assert.equal(propertyText(row, ids, 'Skill ID'), owned.skillId, 'Stable Skill identity changed');
  assert.equal(propertyText(row, ids, 'Current State'), 'ready', 'Product left unfinished content state');
  assert.equal(propertyText(row, ids, 'Operation'), '', 'Product left an operation marker');
  const files = await pages(context, 'files', { property: context.library.files.property_ids.Skill, relation: { contains: row.id } });
  const records = await pages(context, 'records', { property: context.library.records.property_ids.Skill, relation: { contains: row.id } });
  owned.knownChildren = [...files.map(file => ({ pageId: file.id, kind: 'file' })), ...records.map(record => ({ pageId: record.id, kind: 'record' }))];
  if (pick(row, ids, 'Enabled')?.checkbox === false) {
    assert.equal(properties?.enabled, false, 'A disabled body cannot be read as current content');
    assert.equal(version, undefined, 'Metadata-only disabled readback cannot prove a new content version');
    const captured = await capture(context, receiptPath, { row, files, records, observedAt: clock() });
    const result = { status: 'passed', object: { owner: identity.owner }, artifact: captured,
      observed: { state: 'present', ready: true, operationEmpty: true, properties, metadataOnly: true },
      assertions: [{ id: 'independent-live-metadata', status: 'passed' }], externalRepair: false };
    return sealReadback(context, key, result);
  }
  const body = await tree(context, row.id);
  const main = await cli(context, ['read', row.id, '--library', context.libraryId, '--refresh', '--json'], 'read-main');
  assert.equal(main.value.ok, true); assert.equal(main.value.has_more, false); assert.equal(typeof main.value.content, 'string');
  assert.equal(main.value.effects?.remote_writes, 'none', 'A consumption read reported semantic writes');
  assert.equal(main.value.record?.locator?.page_id, owned.pageId, 'Reader returned a different physical owner');
  assert.equal(main.value.record?.locator?.skill_id, owned.skillId, 'Reader returned a different stable owner');
  identity.owner = main.value.record.id; identity.scope = main.value.scope;
  if (owned.placement === 'source') { identity.name = main.value.record.name; bindings.public[alias + '.name'] = main.value.record.name; }
  const expectedVersion = owned.versionInputs[label];
  if (expectedVersion && owned.placement !== 'source' && owned.placement !== 'builtin') {
    for (const [name, aliases] of [['Requires', expectedVersion.requires], ['Members', expectedVersion.members]]) {
      const relation = pick(row, ids, name); assert.ok(relation && relation.has_more !== true, 'Incomplete relation readback');
      assert.deepEqual((relation.relation ?? []).map(item => item.id).sort(), aliases.map(alias => context.objects[alias].pageId).sort(), 'A required relationship differs');
    }
    const metadata = { ...expectedVersion, ...owned.currentProperties, ...properties };
    if (metadata.enabled !== undefined) assert.equal(pick(row, ids, 'Enabled')?.checkbox, metadata.enabled);
    if (metadata.defaultContext !== undefined) assert.equal(pick(row, ids, 'Default Context')?.checkbox, metadata.defaultContext);
  }
  const outputDirectory = join(context.root, 'readbacks', alias + '-' + randomUUID()); await mkdir(outputDirectory, { mode: 0o700 });
  const versionFiles = owned.versionInputs[label]?.files ?? [];
  const fileList = await cli(context, ['files', main.value.snapshot_id], 'read-files');
  const directory = fileList.value.files ?? fileList.value.entries ?? fileList.value.result?.files;
  assert.ok(Array.isArray(directory), 'Public files response omitted the complete directory');
  const observedFiles = [];
  for (const file of directory) {
    const resourcePath = file.path;
    assert.ok(typeof resourcePath === 'string' && resourcePath.length > 0);
    const output = resolve(outputDirectory, resourcePath); assert.ok(inside(outputDirectory, output));
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    let bytes;
    if (resourcePath === main.value.path) bytes = Buffer.from(main.value.content);
    else {
      const outputRead = await cli(context, ['read', resourcePath, '--from', main.value.ref, '--output', output, '--json'], 'read-resource');
      assert.equal(outputRead.value.effects?.remote_writes, 'none'); bytes = await readFile(output);
    }
    if (!(await exists(output))) await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
    const expectedInput = versionFiles.find(item => item.path === resourcePath);
    if (expectedInput && !owned.wasUnmanaged) {
      const planned = await readFile(expectedInput.input);
      if (agentFixtureUsesNativeMarkdown(context.recipe?.objects.find(object => object.id === alias), resourcePath) && owned.placement !== 'source') {
        const compare = await nativeMarkdownComparator(context);
        const meaning = compare({ expected: withoutFrontmatter(planned.toString()), observed: withoutFrontmatter(bytes.toString()) });
        assert.ok(meaning === 'exact' || meaning === 'normalized', 'Native content changed meaning');
      }
      else assert.equal(sha(bytes), sha(planned), 'Exact source/resource bytes changed');
      if (owned.placement === 'source') assert.equal(file.mode, expectedInput.mode, 'Exact upstream file mode changed');
    }
    const bodyKey = alias + '@' + label + '/' + resourcePath;
    bindings.private.bodies[bodyKey] = { path: output, sha256: sha(bytes), bytes: bytes.length, object: alias, version: label, resourcePath };
    observedFiles.push({ path: resourcePath, sha256: sha(bytes), bytes: bytes.length, bodyKey, fileId: file.file_id ?? file.id, mode: file.mode });
  }
  if (versionFiles.length) assert.deepEqual(observedFiles.map(file => file.path).sort(), versionFiles.map(file => file.path).sort(), 'The complete consumption tree differs');
  identity.versions[label] = { ref: main.value.ref, snapshot_id: main.value.snapshot_id, version_id: main.value.version_id,
    bodyKeys: observedFiles.map(file => file.bodyKey), readback: key };
  identity.currentVersion = label; owned.currentVersion = label;
  let observedProjection;
  if (owned.placement === 'source') {
    const projected = [{ path: 'SKILL.md', body: blockShape(body) }];
    for (const file of files) {
      const path = propertyText(file, context.library.files.property_ids, 'Path');
      if (/\.(md|markdown)$/iu.test(path)) projected.push({ path, body: blockShape(await tree(context, file.id)) });
    }
    projected.sort((a, b) => a.path.localeCompare(b.path));
    const hasReadingBody = projected.find(file => file.path === 'SKILL.md')?.body.length > 0;
    if (owned.projectionRequired || owned.projectionBaseline || projection) assert.ok(hasReadingBody, 'The generated main reading projection is empty');
    if (hasReadingBody) {
      observedProjection = { sha256: sha(JSON.stringify(projected)), files: projected };
      if (!owned.projectionBaseline) owned.projectionBaseline = observedProjection;
      if (projection === 'same-as-baseline') assert.equal(observedProjection.sha256, owned.projectionBaseline.sha256, 'Restored reading projection differs from the baseline');
    }
  } else assert.equal(projection, undefined, 'Projection assertions require a source fixture');
  if (owned.wasUnmanaged && owned.unmanagedBodyShape) {
    assert.deepEqual(blockShape(body), owned.unmanagedBodyShape, 'Registration changed author content');
    for (const file of files) {
      const path = propertyText(file, context.library.files.property_ids, 'Path');
      const expectedBody = owned.unmanagedBodyShapes?.[path]; assert.ok(expectedBody, 'Registration introduced an unexpected supporting file');
      assert.deepEqual(blockShape(await tree(context, file.id)), expectedBody, 'Registration changed supporting author content');
    }
  }
  const captured = await capture(context, receiptPath, { row, files, records, body, main: main.value, directory: fileList.value, observedFiles, observedProjection,
    commandArtifacts: [main.artifact, fileList.artifact], observedAt: clock() });
  const result = { status: 'passed', object: { owner: identity.owner, scope: main.value.scope, snapshot_id: main.value.snapshot_id, version_id: main.value.version_id },
    artifact: captured, observed: { state: 'present', ready: true, operationEmpty: true, files: observedFiles, ...(observedProjection ? { projection: observedProjection } : {}), ...(properties ? { properties } : {}) },
    assertions: [{ id: 'independent-live-ready-state', status: 'passed' }, { id: 'complete-current-consumption', status: 'passed' }, { id: 'normal-consumption-zero-writes', status: 'passed' }],
    externalRepair: false };
  bindings.private.readbacks[key] ??= { object: alias, state: expected === 'absent' ? 'absent' : 'present', ...(expected === 'absent' ? {} : { version: label }) }; return sealReadback(context, key, result);
}

async function listViews(context) {
  const output = []; let cursor;
  do {
    const query = new URLSearchParams({ database_id: context.library.skills.database_id, page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) });
    const value = await request(context, 'v1/views?' + query);
    assert.ok(Array.isArray(value.results), 'View inventory must be complete');
    output.push(...value.results);
    assert.ok(!value.has_more || typeof value.next_cursor === 'string' && value.next_cursor !== cursor);
    cursor = value.has_more ? value.next_cursor : undefined;
  } while (cursor);
  return output;
}

/** A complete owned filtered View is different from a failed or partial source observation. */
export async function prepareAgentFilteredView(bindings) {
  const context = bindings.private.fixture; await assertOwnership(context);
  assert.equal(context.viewId, undefined, 'A fixture may own only one View');
  const before = await listViews(context);
  assert.ok(before.length > 0, 'Do not create a test View in a database without an existing user View');
  const selected = Object.values(context.objects).find(object => !object.external && object.pageId && object.placement !== 'global' && object.placement !== 'project');
  const filter = { property: context.library.skills.property_ids['Skill ID'], rich_text: { equals: selected?.skillId ?? 'agent-workflow-empty-' + context.runId } };
  const name = 'Agent workflow ' + context.runId + ' ' + context.ownership.token.slice(0, 8);
  context.view = { name, filter, originalViewIds: before.map(view => view.id), expectedPageIds: selected ? [selected.pageId] : [] };
  await persist(bindings);
  const created = await request(context, 'v1/views', { method: 'POST', fixtureMutation: true, body: {
    database_id: context.library.skills.database_id, data_source_id: context.library.skills.data_source_id,
    name, type: 'table', filter, position: { type: 'end' },
  } });
  assert.ok(pageId(created.id)); context.viewId = created.id; context.view.id = created.id;
  await persist(bindings);
  const actual = await request(context, 'v1/views/' + created.id), after = await listViews(context);
  assert.equal(actual.parent?.database_id?.replaceAll('-', ''), context.library.skills.database_id.replaceAll('-', ''));
  assert.equal(actual.name, name);
  assert.deepEqual(after.filter(view => context.view.originalViewIds.includes(view.id)).map(view => view.id), context.view.originalViewIds, 'Creating the owned View changed existing view order');
  const listed = await cli(context, ['list', '--library', context.libraryId, '--view', created.id, '--refresh', '--limit', '500', '--json'], 'verify-filtered-view');
  assert.equal(listed.value.has_more, false, 'This bounded filtered fixture must be complete');
  assert.equal(listed.value.coverage?.exhaustive, true); assert.deepEqual(listed.value.coverage?.failed_sources, []);
  assert.deepEqual(listed.value.records.map(record => record.locator.page_id).sort(), context.view.expectedPageIds.slice().sort(), 'The owned filtered View has unexpected members');
  context.view.receipt = await capture(context, join(context.root, 'readbacks', 'filtered-view-created.json'), { before, created, actual, after, filter, selection: listed.value, command: listed.artifact, at: clock() });
  await persist(bindings);
  return { id: created.id, status: 'passed', artifact: context.view.receipt };
}

async function cleanupFilteredView(context) {
  if (!context.view || context.view.cleaned) return null;
  const before = await listViews(context);
  if (!context.viewId) {
    const matches = before.filter(view => view.name === context.view.name);
    assert.ok(matches.length <= 1, 'Uncertain View creation produced ambiguous ownership');
    if (!matches.length) return { action: 'view-creation-had-no-effect', status: 'passed' };
    context.viewId = matches[0].id;
  }
  assert.ok(!context.view.originalViewIds.includes(context.viewId), 'Never delete a pre-existing View');
  const actual = await request(context, 'v1/views/' + context.viewId);
  assert.equal(actual.name, context.view.name); assert.equal(actual.parent?.database_id?.replaceAll('-', ''), context.library.skills.database_id.replaceAll('-', ''));
  // Independent fixtures may finish between preparation and teardown. Protect the inventory present at this deletion.
  const otherViewIds = before.filter(view => view.id !== context.viewId).map(view => view.id);
  const removed = await request(context, 'v1/views/' + context.viewId, { method: 'DELETE', fixtureMutation: true });
  assert.equal(removed.id, context.viewId);
  const after = await listViews(context);
  assert.equal(after.some(view => view.id === context.viewId), false, 'The owned View is still present');
  assert.deepEqual(after.map(view => view.id), otherViewIds, 'View cleanup changed another View or its order');
  context.view.cleaned = true;
  const receipt = await capture(context, join(context.root, 'readbacks', 'filtered-view-cleaned.json'), { before, actual, removed, after, at: clock() });
  return { action: 'owned-filtered-view-delete', status: 'passed', artifact: receipt };
}


async function prepareSourceDeclaration(context, object, owned) {
  const declaration = structuredClone(object.source.declaration);
  declaration.definition.source_id = 'agent-workflow-' + context.runId + '-' + object.id; declaration.definition.name = owned.name;
  declaration.contributions = [{ member_key: object.source.memberKey, skill_id: owned.skillId, mount_path: '', mapping: {}, exclude: [] }];
  assert.deepEqual(declaration.definition.selection.roots, [object.source.memberKey], 'Select exactly one reviewed upstream member');
  const path = join(context.root, 'inputs', object.id + '-source.json'); await save(path, declaration);
  owned.declarationPath = path; owned.sourceId = declaration.definition.source_id;
  return declaration;
}

/** Freeze fixed upstream bytes in private control storage; never seed the subject Store. */
async function prepareAbsentSourceOracle(bindings, object, declaration) {
  const context = bindings.private.fixture, owned = context.objects[object.id], identity = bindings.private.objects[object.id];
  const adapter = declaration.definition.adapter, url = new URL(adapter.url), member = object.source.memberKey;
  assert.equal(adapter.type, 'git'); assert.equal(url.protocol, 'https:'); assert.equal(url.username + url.password, '');
  assert.match(adapter.ref, /^[a-f0-9]{40}$/u, 'An absent Source oracle requires one exact pinned commit');
  assert.ok(member && !member.startsWith('/') && !member.includes('\\') && member.split('/').every(part => part && part !== '.' && part !== '..'));
  const version = Object.keys(owned.versionInputs)[0], input = owned.versionInputs[version];
  assert.equal(Object.keys(owned.versionInputs).length, 1, 'Initial interrupted Source fixtures declare one frozen version');
  assert.equal(input.files.length, 0, 'Hydrate an absent Source from its exact provider tree');
  const repository = join(context.root, 'inputs', object.id + '-git'), env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const git = async (args, binaryOutput = false) => {
    const result = await processCommand('/usr/bin/git', args, { cwd: context.root, env, timeoutMs: 120000, binaryOutput });
    assert.equal(result.code, 0, 'Private upstream acquisition failed: ' + result.stderr);
    assert.equal(result.timedOut, false); return result.stdout;
  };
  await git(['init', '--bare', repository]);
  await git(['--git-dir', repository, 'fetch', '--depth=1', '--filter=blob:none', '--no-tags', url.href, adapter.ref]);
  assert.equal((await git(['--git-dir', repository, 'rev-parse', 'FETCH_HEAD'])).trim(), adapter.ref);
  const entries = (await git(['--git-dir', repository, 'ls-tree', '-r', '-z', adapter.ref + ':' + member])).split('\0').filter(Boolean);
  assert.ok(entries.length > 0 && entries.length <= 1000, 'The bounded upstream fixture has an invalid file count');
  let totalBytes = 0;
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry);
    assert.ok(match, 'Only exact regular Git files can be fixture oracles');
    const [, mode, objectId, resourcePath] = match, target = resolve(input.directory, resourcePath);
    assert.ok(inside(input.directory, target) && !resourcePath.includes('\\') && resourcePath.split('/').every(part => part && part !== '.' && part !== '..'));
    const size = Number((await git(['--git-dir', repository, 'cat-file', '-s', objectId])).trim());
    assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 32 * 1024 * 1024);
    totalBytes += size; assert.ok(totalBytes <= 128 * 1024 * 1024);
    const bytes = await git(['--git-dir', repository, 'cat-file', 'blob', objectId], true);
    assert.equal(bytes.length, size); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: mode === '100755' ? 0o700 : 0o600 });
    const file = { path: resourcePath, input: target, sha256: sha(bytes), bytes: bytes.length, mode, gitObject: objectId };
    input.files.push(file);
    const key = object.id + '@' + version + '/' + resourcePath;
    bindings.private.bodies[key] = { path: await freezeObservedBytes(context, bytes), sha256: file.sha256, bytes: file.bytes, object: object.id, version, resourcePath, source: 'fixed-upstream-control-oracle' };
  }
  assert.ok(input.files.some(file => file.path === 'SKILL.md'), 'Upstream oracle has no main Skill');
  identity.versions[version] = { bodyKeys: input.files.map(file => object.id + '@' + version + '/' + file.path) };
  owned.upstreamOracle = await capture(context, join(context.root, 'readbacks', object.id + '-upstream-oracle.json'), {
    url: url.href, commit: adapter.ref, member, files: input.files, totalBytes, subjectStoreSeeded: false, at: clock(),
  });
}

/** Resolve physical relation prerequisites before preparation can make any remote changes. */
export function planAgentFixturePreparation(recipe) {
  validateAgentFixtureRecipe(recipe);
  const objects = new Map(recipe.objects.map(object => [object.id, object]));
  const initial = object => object.versions[object.initial] ?? {};
  for (const object of recipe.objects) {
    for (const field of ['requires', 'members']) for (const alias of initial(object)[field] ?? []) {
      const target = objects.get(alias);
      if (object.placement !== 'notion' || alias === object.id)
        throw fail('AGENT_FIXTURE_RELATION_INVALID', 'Initial relations need a native Notion owner and a different target.', { object: object.id, field, target: alias });
      if (!['notion', 'source', 'builtin'].includes(target.placement) || ['absent', 'unmanaged'].includes(target.initial) || initial(target).enabled === false)
        throw fail('AGENT_FIXTURE_RELATION_INVALID', 'An initial relation target must become an enabled, ready Notion Skill.', { object: object.id, field, target: alias });
    }
  }
  const orderFor = fields => {
    const remaining = new Set(objects.keys()), completed = new Set(), order = [];
    while (remaining.size) {
      const before = remaining.size;
      for (const object of recipe.objects) {
        if (!remaining.has(object.id)) continue;
        const targets = fields.flatMap(field => initial(object)[field] ?? []);
        if (!targets.every(alias => completed.has(alias))) continue;
        order.push(object.id); completed.add(object.id); remaining.delete(object.id);
      }
      if (remaining.size === before) return null;
    }
    return order;
  };
  const requiredOrder = orderFor(['requires']);
  if (!requiredOrder) throw fail('AGENT_FIXTURE_RELATION_CYCLE', 'Initial Requires must form an acyclic dependency graph.');
  const ordered = orderFor(['requires', 'members']);
  if (ordered) return { order: ordered, deferredMembers: [] };
  // Members may form cycles. Create ready pages in Requires order, then attach only
  // the complete Members sets whose targets were not ready at their owner's creation.
  const positions = new Map(requiredOrder.map((alias, index) => [alias, index]));
  return { order: requiredOrder, deferredMembers: requiredOrder.filter(alias =>
    (initial(objects.get(alias)).members ?? []).some(target => positions.get(target) > positions.get(alias))) };
}

/** Prepare one owned real fixture. The library is never replaced and global configuration is never edited. */
export async function prepareAgentFixtures({ recipe, runId, root, libraryId, cli: cliPath, node = process.execPath, globalSkillsRoot = join(homedir(), '.agents/skills'), apiVersion = '2026-03-11' }) {
  const preparationPlan = planAgentFixturePreparation(recipe);
  for (const object of recipe.objects) if (['global', 'project'].includes(object.placement))
    assert.ok(/^[a-z0-9][a-z0-9-]*$/u.test(object.name), 'Native fixture names must be safe lowercase invocation names');
  assert.ok(isAbsolute(globalSkillsRoot), 'Use an absolute native global Skill root');
  assert.ok(id(runId) && pageId(libraryId) && isAbsolute(root) && isAbsolute(cliPath) && isAbsolute(node));
  assert.ok(!(await exists(root)), 'Use a fresh fixture root; resume from its bindings instead');
  await mkdir(root, { recursive: true, mode: 0o700 }); root = await realpath(root);
  const context = { version: 1, runId, root, libraryId, cli: await realpath(cliPath), node: await realpath(node), apiVersion, recipe, preparationPlan,
    env: { NTN_SKILLS_HOME: join(root, 'state'), NTN_SKILLS_CONFIG_HOME: join(root, 'config'),
      NTN_SKILLS_CACHE_HOME: join(root, 'cache'), NTN_SKILLS_DATA_HOME: join(root, 'data'), NTN_SKILLS_SCHEDULER_ROOT: join(root, 'scheduler') },
    objects: {}, projectRoot: join(root, 'project'), observedReadbacks: {}, ownership: { runId, root, token: randomUUID(), createdAt: new Date().toISOString(), globalDirectories: [], temporaryRoot: join(root, 'temporary') } };
  await save(join(root, 'ownership.json'), context.ownership);
  for (const path of ['commands', 'readbacks', 'inputs', 'quarantine', 'temporary', 'project/.agents/skills']) await mkdir(join(root, path), { recursive: true, mode: 0o700 });
  if (recipe.objects.some(object => object.placement === 'notion')) await nativeMarkdownComparator(context);
  const inspect = await cli(context, ['ctl', 'library', 'inspect', '--library', libraryId], 'inspect-library'); context.library = inspect.value.library;
  assert.equal(context.library.library_id.replaceAll('-', ''), libraryId.replaceAll('-', ''));
  const bindings = { version: 1, public: { ...(recipe.public ?? {}) }, private: { fixture: context, objects: {}, bodies: {}, facts: recipe.facts ?? {}, readbacks: structuredClone(recipe.readbacks ?? {}) } };
  const captureInitialReadback = async (alias, version) => {
    const owned = context.objects[alias], input = owned.versionInputs[version];
    const options = owned.placement === 'notion' && input?.enabled === false
      ? { properties: { enabled: false, ...(input.defaultContext === undefined ? {} : { defaultContext: input.defaultContext }) } }
      : { version };
    return captureReadback(bindings, alias, options);
  };
  try {
    for (const object of recipe.objects) {
      const suffix = sha(runId).slice(0, 8), name = object.placement === 'builtin' ? object.name : object.name + '-' + suffix;
      assert.ok(name.length <= 64, 'Fixture native names must remain bounded');
      const owned = { id: object.id, name, placement: object.placement, skillId: 'agent-workflow-' + runId + '-' + object.id,
        currentVersion: object.initial, pendingIdentity: ['absent', 'unmanaged'].includes(object.initial), wasUnmanaged: object.initial === 'unmanaged', versionInputs: await prepareVersionInputs(context, object, name), knownChildren: [] };
      context.objects[object.id] = owned;
      bindings.public[object.id + '.name'] = name;
      bindings.public[object.id + '.path'] = owned.versionInputs[object.initial]?.directory ?? Object.values(owned.versionInputs)[0]?.directory;
      bindings.private.objects[object.id] = { kind: ['global', 'project'].includes(object.placement) ? 'local' : 'notion', name, skillId: owned.skillId, versions: {}, currentVersion: object.initial };
      for (const [version, input] of Object.entries(owned.versionInputs)) {
        const bodyKeys = [];
        for (const file of input.files) {
          const key = object.id + '@' + version + '/' + file.path;
          bindings.private.bodies[key] = { path: file.input, sha256: file.sha256, bytes: file.bytes, object: object.id, version, resourcePath: file.path };
          bodyKeys.push(key);
        }
        bindings.private.objects[object.id].versions[version] = { bodyKeys };
      }
    }
    const deferredMembers = new Set(preparationPlan.deferredMembers), finalReadbacks = [];
    for (const alias of preparationPlan.order) {
      const object = recipe.objects.find(object => object.id === alias);
      const owned = context.objects[object.id], identity = bindings.private.objects[object.id];
      if (['global', 'project'].includes(object.placement)) {
        assert.ok(owned.versionInputs[object.initial], 'Local fixture requires a concrete initial version');
        const directory = object.placement === 'global' ? join(globalSkillsRoot, owned.name) : join(root, 'project/.agents/skills', owned.name);
        assert.ok(isAbsolute(directory) && !(await exists(directory)), 'Do not replace an existing local Skill');
        await mkdir(directory, { recursive: true, mode: 0o700 }); owned.directory = await realpath(directory);
        if (object.placement === 'global') { context.ownership.globalDirectories.push(owned.directory); await persist(bindings); }
        for (const file of owned.versionInputs[object.initial].files) {
          const path = join(directory, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, await readFile(file.input), { flag: 'wx', mode: file.mode === '100755' ? 0o700 : 0o600 });
        }
        await save(join(directory, '.agent-workflow-owner.json'), { runId, token: context.ownership.token, root });
        identity.path = join(directory, 'SKILL.md'); identity.owner = 'local:' + identity.path;
        bindings.public[object.id + '.path'] = identity.path;
        await captureReadback(bindings, object.id, { version: object.initial });
        continue;
      }
      if (object.placement === 'builtin') {
        const found = []; let cursor;
        do {
          const listed = await cli(context, ['list', '--library', libraryId, '--query', object.name, '--refresh', '--limit', '500', '--json', ...(cursor ? ['--cursor', cursor] : [])], 'find-builtin');
          assert.equal(listed.value.coverage?.exhaustive, true, 'Builtin binding requires a complete explicit-library observation');
          assert.deepEqual(listed.value.coverage?.failed_sources, [], 'Builtin binding cannot hide partial discovery');
          const records = listed.value.records;
          assert.ok(Array.isArray(records), 'Builtin discovery omitted records');
          found.push(...records.filter(record => record.name === object.name || record.alias === object.name));
          assert.ok(!listed.value.has_more || typeof listed.value.next_cursor === 'string');
          cursor = listed.value.has_more ? listed.value.next_cursor : undefined;
        } while (cursor);
        assert.equal(found.length, 1, 'The connected builtin is absent or ambiguous');
        const selected = found[0]; assert.equal(selected.locator?.type, 'shared_skill'); assert.ok(pageId(selected.locator.page_id));
        owned.pageId = selected.locator.page_id; owned.skillId = selected.locator.skill_id; owned.external = true; owned.readOnly = true;
        identity.external = true; identity.readOnly = true; identity.skillId = owned.skillId; identity.name = selected.name;
        const packagedGuidance = join(dirname(dirname(context.cli)), 'skills/notion/ntn-skills-maintain/SKILL.md');
        assert.ok(await exists(packagedGuidance), 'The paired CLI package guidance path is unavailable');
        bindings.private.facts['package-maintenance-path'] = { anyOf: [await realpath(packagedGuidance)] };
        await captureReadback(bindings, object.id, { version: object.initial });
        continue;
      }
      if (object.placement === 'source') {
        const declaration = await prepareSourceDeclaration(context, object, owned); identity.sourceId = owned.sourceId;
        if (object.initial === 'absent') await prepareAbsentSourceOracle(bindings, object, declaration);
      }
      if (object.initial === 'absent') {
        const matches = await pages(context, 'skills', { property: context.library.skills.property_ids.Name, title: { equals: owned.name } });
        assert.equal(matches.length, 0, 'The creation fixture name already exists');
        continue;
      }
      if (object.initial === 'unmanaged') {
        const input = owned.versionInputs[Object.keys(owned.versionInputs)[0]], main = input.files.find(file => file.path === 'SKILL.md');
        assert.ok(main, 'Unmanaged fixture needs its main content');
        for (const file of input.files) {
          assert.match(file.path, /\.(md|markdown)$/iu, 'Unmanaged registration fixtures must retain native authority');
          assert.ok(withoutFrontmatter((await readFile(file.input)).toString()).length <= 1900, 'Use bounded unmanaged prose fixtures');
        }
        const content = withoutFrontmatter((await readFile(main.input)).toString());
        assert.ok(content.length <= 1900, 'Use a bounded unmanaged prose fixture');
        const row = await request(context, 'v1/pages', { method: 'POST', fixtureMutation: true, body: {
          parent: { type: 'data_source_id', data_source_id: context.library.skills.data_source_id },
          properties: { [context.library.skills.property_ids.Name]: { title: rich(owned.name) }, [context.library.skills.property_ids.Description]: { rich_text: rich(object.description) } },
          children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(content) } }],
        } });
        owned.pageId = row.id; identity.pageId = row.id; identity.owner = 'notion_page:' + row.id;
        identity.url = row.url; bindings.public[object.id + '.url'] = row.url;
        const unmanagedBody = await tree(context, row.id); owned.unmanagedBodyShape = blockShape(unmanagedBody);
        owned.unmanagedBodyShapes = { 'SKILL.md': owned.unmanagedBodyShape };
        const unmanagedFiles = [];
        for (const file of input.files.filter(file => file.path !== 'SKILL.md')) {
          const content = withoutFrontmatter((await readFile(file.input)).toString()), ids = context.library.files.property_ids;
          const supporting = await request(context, 'v1/pages', { method: 'POST', fixtureMutation: true, body: {
            parent: { type: 'data_source_id', data_source_id: context.library.files.data_source_id },
            properties: { [ids.Name]: { title: rich(file.path) }, [ids.Path]: { rich_text: rich(file.path) }, [ids.Skill]: { relation: [{ id: row.id }] } },
            children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(content) } }],
          } });
          const originalBody = await tree(context, supporting.id);
          owned.unmanagedBodyShapes[file.path] = blockShape(originalBody);
          owned.knownChildren.push({ pageId: supporting.id, kind: 'file' });
          unmanagedFiles.push({ path: file.path, row: supporting, body: originalBody });
        }
        await capture(context, join(root, 'readbacks', object.id + '-unmanaged.json'), { row, body: unmanagedBody, files: unmanagedFiles, source: 'explicit-unmanaged-test-fixture' });
        continue;
      }
      if (object.placement === 'source') {
        const path = owned.declarationPath;
        const applied = await cli(context, ['ctl', 'library', 'source', 'apply', path, '--library', libraryId], 'source-apply');
        const selected = applied.value.targets?.filter(target => target.skill_id === owned.skillId);
        assert.equal(selected?.length, 1); assert.equal(applied.value.targets.length, 1, 'Source discovery exceeded owned scope');
        owned.pageId = selected[0].page_id; owned.sourcePageId = applied.value.source_page_id;
        owned.declarationPath = path; identity.sourceId = owned.sourceId;
        await cli(context, ['ctl', 'library', 'projection', owned.pageId, '--library', libraryId], 'projection'); owned.projectionRequired = true;
      } else {
        const input = owned.versionInputs[object.initial]; assert.ok(input);
        const selected = deferredMembers.has(object.id) ? { ...input, members: [] } : input;
        const creation = { libraryId, object, owned, input: selected, objects: context.objects };
        const args = agentFixtureCreateArgs(creation);
        if (object.authoring === NATIVE_MAIN_EXACT_RESOURCES) {
          const preflight = await cli(context, [...args, '--dry-run'], 'create-preflight');
          assertAgentFixtureImportCreation(preflight.value, creation);
        }
        const created = await cli(context, args, 'create');
        owned.pageId = created.value.page_id; assert.ok(pageId(owned.pageId));
      }
      if (deferredMembers.size) finalReadbacks.push({ object: object.id, version: object.initial });
      else await captureInitialReadback(object.id, object.initial);
      await persist(bindings);
    }
    for (const alias of preparationPlan.deferredMembers) {
      const owned = context.objects[alias], input = owned.versionInputs[owned.currentVersion];
      await cli(context, ['ctl', 'library', 'skill', 'update', owned.pageId, '--library', libraryId,
        ...relationArgs(context, { requires: [], members: input.members })], 'bind-initial-members');
      await persist(bindings);
    }
    // Freeze versions only after every deferred relation is attached.
    for (const readback of finalReadbacks) await captureInitialReadback(readback.object, readback.version);
    if (recipe.environment?.catalog === 'filtered-view') await prepareAgentFilteredView(bindings);
    await persist(bindings);
    return bindings;
  } catch (error) {
    await persist(bindings);
    await save(join(root, 'preparation-failed.json'), { code: error.code, message: error.message, details: error.details, at: clock() });
    throw error;
  }
}

async function publishVersion(bindings, event) {
  const context = bindings.private.fixture, owned = context.objects[event.object], input = owned?.versionInputs[event.version];
  assert.ok(owned && input, 'Unknown owned version');
  assert.equal(context.recipe?.objects.find(object => object.id === event.object)?.authoring, undefined,
    'Exact-resource authoring does not support version publication');
  assert.equal(owned.placement, 'notion', 'Version publication uses the native public update command');
  const beforeFiles = owned.versionInputs[owned.currentVersion]?.files ?? [];
  const args = ['ctl', 'library', 'skill', 'update', owned.pageId ?? owned.skillId, '--library', context.libraryId];
  for (const file of input.files) args.push('--file', file.path + '=' + file.input);
  for (const file of beforeFiles) if (!input.files.some(next => next.path === file.path)) args.push('--remove-file', file.path);
  for (const field of ['requires', 'members']) {
    const aliases = input[field]; if (aliases.length === 0) args.push('--' + field, '');
    else for (const alias of aliases) { assert.ok(context.objects[alias]?.pageId); args.push('--' + field, context.objects[alias].pageId); }
  }
  if (input.enabled !== undefined) args.push('--enabled', String(input.enabled));
  if (input.defaultContext !== undefined) args.push('--default-context', String(input.defaultContext));
  const result = await cli(context, args, 'publish-version');
  owned.currentVersion = event.version;
  owned.currentProperties = { ...owned.currentProperties, ...Object.fromEntries(['enabled', 'defaultContext']
    .filter(field => input[field] !== undefined).map(field => [field, input[field]])) };
  const readback = await captureReadback(bindings, event.object, { version: event.version, key: event.object + '@' + event.version });
  return { command: result.artifact, readback };
}


async function observeSourceCheckpoint(bindings, alias) {
  const context = bindings.private.fixture, owned = context.objects[alias], identity = bindings.private.objects[alias];
  const matches = await pages(context, 'sources', { property: context.library.sources.property_ids['Source ID'], rich_text: { equals: owned.sourceId } });
  assert.ok(matches.length <= 1, 'Owned Source identity became ambiguous');
  const source = matches[0];
  if (source) {
    assert.equal(propertyText(source, context.library.sources.property_ids, 'Source ID'), owned.sourceId);
    if (owned.sourcePageId) assert.equal(source.id, owned.sourcePageId, 'Source physical owner changed');
    owned.sourcePageId = source.id;
  }
  const skill = await actualSkill(context, owned);
  if (skill) {
    assert.equal(propertyText(skill, context.library.skills.property_ids, 'Skill ID'), owned.skillId);
    identity.pageId = skill.id; identity.name = propertyText(skill, context.library.skills.property_ids, 'Name');
    identity.owner = nativeSkillId(context.library.library_id, owned.skillId);
    identity.url = skill.url; bindings.public[alias + '.url'] = skill.url; bindings.public[alias + '.name'] = identity.name;
  }
  return { source, skill };
}

async function interruptSourceWrite(bindings, event) {
  const context = bindings.private.fixture, owned = context.objects[event.object], maxRequests = event.maxRequests ?? 40;
  assert.equal(owned.placement, 'source'); assert.equal(owned.currentVersion, 'absent');
  assert.ok(owned.declarationPath && owned.upstreamOracle, 'A cold Source interruption needs frozen provider evidence');
  assert.ok(Number.isSafeInteger(maxRequests) && maxRequests > 0 && maxRequests <= 1000, 'Use a bounded positive request budget');
  assert.equal(owned.sourceOperation, undefined, 'An interrupted intent must be resumed by its exact identity');
  const before = await observeSourceCheckpoint(bindings, event.object);
  assert.equal(before.source, undefined, 'Do not interrupt a pre-existing Source'); assert.equal(before.skill, null, 'Do not replace an existing Skill');
  owned.sourceOperation = { id: randomUUID(), input: await artifact(owned.declarationPath), maxRequests, phase: 'planned' };
  await persist(bindings);
  const interrupted = await cli(context, ['ctl', 'library', 'source', 'apply', owned.declarationPath, '--library', context.libraryId,
    '--operation', owned.sourceOperation.id, '--max-requests', String(maxRequests)], 'source-interrupt', { allowedFailure: 'REQUEST_BUDGET_EXHAUSTED' });
  owned.sourceOperation.command = interrupted.artifact;
  const after = await observeSourceCheckpoint(bindings, event.object);
  const observed = { state: after.source && propertyText(after.source, context.library.sources.property_ids, 'Status'),
    operationId: after.source && propertyText(after.source, context.library.sources.property_ids, 'Operation'),
    skillState: after.skill && propertyText(after.skill, context.library.skills.property_ids, 'Current State'),
    skillOperation: after.skill && propertyText(after.skill, context.library.skills.property_ids, 'Operation') };
  owned.sourceOperation.observation = await capture(context, join(context.root, 'readbacks', event.object + '-source-interrupted-' + randomUUID() + '.json'), {
    before, after, observed, cli: interrupted.value, command: interrupted.artifact, at: clock(),
  });
  assert.equal(interrupted.value.ok, false, 'The writer completed before the bounded interruption');
  assert.equal(interrupted.value.error?.code, 'REQUEST_BUDGET_EXHAUSTED');
  assert.equal(observed.state, 'applying', 'The request limit did not leave the actual Source applying');
  assert.equal(observed.operationId, owned.sourceOperation.id, 'The applying Source belongs to another intent');
  assert.equal(observed.skillState, 'ready', 'Reach a ready child before testing the Source readiness gate');
  assert.equal(observed.skillOperation, '', 'The child must not fail through its own pending operation');
  owned.sourceOperation.phase = 'interrupted';
  return { status: 'passed', observed, sourcePageId: owned.sourcePageId, command: interrupted.artifact, artifact: owned.sourceOperation.observation };
}

async function resumeSourceWrite(bindings, event) {
  const context = bindings.private.fixture, owned = context.objects[event.object];
  assert.equal(owned.placement, 'source'); assert.equal(owned.sourceOperation?.phase, 'interrupted', 'Resume requires a verified real interruption');
  assert.deepEqual(await artifact(owned.declarationPath), owned.sourceOperation.input, 'Frozen Source intent input changed');
  const resumed = await cli(context, ['ctl', 'library', 'source', 'apply', owned.declarationPath, '--library', context.libraryId,
    '--operation', owned.sourceOperation.id, '--resume'], 'source-resume');
  assert.equal(resumed.value.operation_id, owned.sourceOperation.id);
  const selected = resumed.value.targets?.filter(target => target.skill_id === owned.skillId);
  assert.equal(selected?.length, 1); assert.equal(resumed.value.targets.length, 1, 'Resumed Source exceeded its owned member');
  owned.pageId = selected[0].page_id; owned.sourcePageId = resumed.value.source_page_id;
  const after = await observeSourceCheckpoint(bindings, event.object);
  assert.equal(propertyText(after.source, context.library.sources.property_ids, 'Status'), 'ready');
  assert.equal(propertyText(after.source, context.library.sources.property_ids, 'Operation'), '');
  const version = Object.keys(owned.versionInputs)[0];
  const readback = await captureReadback(bindings, event.object, { version, key: event.object + '-source-resumed' });
  owned.sourceOperation.phase = 'resumed'; owned.sourceOperation.resume = resumed.artifact;
  return { status: 'passed', operationId: owned.sourceOperation.id, command: resumed.artifact, readback };
}

const runtimeStoreRoots = ['NTN_SKILLS_HOME', 'NTN_SKILLS_CONFIG_HOME', 'NTN_SKILLS_CACHE_HOME', 'NTN_SKILLS_DATA_HOME'];

async function storeFaultRead(context, probe, label, runtimeEnv, expectedFailure = false) {
  assert.deepEqual(await artifact(probe.cli.path), probe.cli, 'The Store probe CLI changed');
  assert.deepEqual(await artifact(probe.node.path), probe.node, 'The Store probe Node changed');
  const selected = probe.selected;
  assert.ok(/^s_[a-f0-9]{64}$/u.test(selected.snapshot_id) && digest(selected.version_id));
  const result = await cli({ ...context, cli: probe.cli.path, node: probe.node.path,
    env: { ...runtimeEnv, ...probe.roots } }, ['read', selected.snapshot_id, '--offline', '--json', '--metrics'], label,
  expectedFailure ? { allowedFailure: 'STATE_UNAVAILABLE' } : {});
  if (expectedFailure) {
    assert.equal(result.value.ok, false, 'The faulted public read unexpectedly succeeded');
    assert.equal(result.value.error.code, 'STATE_UNAVAILABLE');
    assert.equal(result.value.error.details?.phase, 'sqlite_state');
    assert.equal(result.value.error.details?.native_code, 'ENOTDIR');
    return { status: 'failed', expected: true, code: result.value.error.code, details: result.value.error.details, command: result.artifact };
  }
  const value = result.value;
  assert.equal(value.record?.id, selected.owner);
  assert.equal(value.scope, selected.scope); assert.equal(value.snapshot_id, selected.snapshot_id); assert.equal(value.version_id, selected.version_id);
  assert.equal(value.path, selected.main.path); assert.equal(typeof value.content, 'string'); assert.equal(value.has_more, false);
  assert.equal(sha(value.content), selected.main.sha256); assert.equal(Buffer.byteLength(value.content), selected.main.bytes);
  assert.equal(value.effects?.remote_writes, 'none');
  assert.equal(value.request_metrics?.total_requests, 0, 'The fixed offline proof must not perform remote reads or writes');
  return { status: 'passed', command: result.artifact, observed: { ...selected, totalRequests: 0, remoteWrites: 'none' } };
}

async function injectFault(bindings, event, ownedStateRoot, runtimeEnv) {
  const context = bindings.private.fixture, owned = context.objects[event.object], object = bindings.private.objects[event.object];
  assert.ok(owned && isAbsolute(ownedStateRoot), 'Fault injection requires an owned runtime Store');
  const actualRoot = await realpath(ownedStateRoot);
  assert.equal(actualRoot, ownedStateRoot);
  const marker = await json(join(ownedStateRoot, 'agent-workflow-owner.json'));
  assert.equal(marker.runId, context.runId); assert.equal(marker.fixtureRoot, context.root); assert.equal(marker.token, context.ownership.token);
  const version = object.versions[object.currentVersion];
  let source;
  if (event.mode === 'missing-manifest') {
    assert.ok(/^s_[a-f0-9]{64}$/u.test(version.snapshot_id)); source = join(ownedStateRoot, 'snapshots', version.snapshot_id + '.json');
  } else if (event.mode === 'missing-object') {
    const main = version.bodyKeys.map(key => bindings.private.bodies[key]).find(body => body.resourcePath === 'SKILL.md');
    assert.ok(main && digest(main.sha256)); source = join(ownedStateRoot, 'objects', main.sha256);
  } else if (event.mode === 'store-unavailable') source = ownedStateRoot;
  else throw fail('AGENT_FIXTURE_UNSUPPORTED_EVENT', 'Unsupported owned Store fault');
  assert.ok(await exists(source), 'The selected fault target is absent before injection');
  assert.ok(!(await lstat(source)).isSymbolicLink(), 'Do not fault a symlink');
  const target = join(context.root, 'quarantine', basename(source) + '-' + randomUUID());
  assert.ok(source !== context.root && !inside(source, target), 'Keep quarantine and control evidence outside the faulted Store');
  let probe, before;
  if (event.mode === 'store-unavailable') {
    assert.equal(runtimeEnv?.NTN_SKILLS_HOME, ownedStateRoot, 'Prove the actual subject Store environment before injecting an outage');
    const roots = {};
    for (const name of runtimeStoreRoots) {
      const path = runtimeEnv[name];
      assert.ok(typeof path === 'string' && isAbsolute(path) && inside(dirname(ownedStateRoot), path), 'Keep every runtime Store root inside its owned parent');
      roots[name] = path;
    }
    assert.equal(new Set(Object.values(roots)).size, runtimeStoreRoots.length, 'Runtime state/config/cache/data roots must be separate');
    const sqlite = await lstat(join(ownedStateRoot, 'state.sqlite'));
    assert.ok(sqlite.isFile() && !sqlite.isSymbolicLink(), 'The subject must have an existing regular SQLite Store');
    const main = version.bodyKeys.map(key => bindings.private.bodies[key]).find(body => body.resourcePath === 'SKILL.md');
    assert.ok(main && digest(main.sha256) && Number.isSafeInteger(main.bytes) && main.bytes > 0);
    probe = { cli: await artifact(context.cli), node: await artifact(context.node), roots,
      selected: { owner: object.owner, scope: object.scope, snapshot_id: version.snapshot_id, version_id: version.version_id,
        main: { path: 'SKILL.md', sha256: main.sha256, bytes: main.bytes } } };
    before = await storeFaultRead(context, probe, 'fault-store-before', runtimeEnv);
  }
  await rename(source, target);
  const fault = { mode: event.mode, object: event.object, source, target, status: 'quarantined', ...(probe ? { probe, proof: { before } } : {}) };
  // Journal the completed rename before any proof can fail, so teardown can restore it.
  context.faults ??= []; context.faults.push(fault);
  if (event.mode === 'store-unavailable') {
    await save(source, { fixtureFault: context.ownership.token, restoreFrom: target });
    assert.ok((await lstat(source)).isFile());
    let errorCode;
    try { await readFile(join(source, 'state.sqlite')); } catch (error) { errorCode = error.code; }
    assert.equal(errorCode, 'ENOTDIR', 'The actual subject Store path remained readable');
    const blockerPath = join(context.root, 'readbacks', 'store-fault-marker-' + randomUUID() + '.json');
    await writeFile(blockerPath, await readFile(source), { flag: 'wx', mode: 0o600 });
    const blocker = await artifact(blockerPath);
    assert.equal((await artifact(source)).sha256, blocker.sha256);
    fault.proof.blocker = { kind: 'regular-file', observedPath: source, artifact: blocker, readPath: join(source, 'state.sqlite'), readError: errorCode };
    fault.proof.after = await storeFaultRead(context, probe, 'fault-store-after', runtimeEnv, true);
    fault.status = 'active';
  }
  return { kind: event.mode, source, quarantine: target, status: fault.status,
    verifiedAbsent: event.mode === 'store-unavailable' ? (await lstat(source)).isFile() : !(await exists(source)),
    ...(fault.proof ? { proof: fault.proof } : {}) };
}

/** Finite control-plane events. RPC lifecycle events belong to the existing Pi runner. */
export async function runAgentFixtureEvent(event, { bindings, bindingsPath, ownedStateRoot, runtimeEnv }) {
  const context = bindings.private.fixture; await assertOwnership(context);
  assert.ok(event && typeof event === 'object' && !Array.isArray(event));
  const allowed = {
    'publish-version': ['kind', 'object', 'version'],
    'interrupt-source-write': ['kind', 'object', 'maxRequests'],
    'resume-source-write': ['kind', 'object'],
    'set-enabled': ['kind', 'object', 'enabled', 'defaultContext'],
    'remove-owned': ['kind', 'object'],
    'restore-projection': ['kind', 'object'],
    'trash-projection': ['kind', 'object'],
    readback: ['kind', 'object', 'receipt'],
    fault: ['kind', 'object', 'mode'],
  }[event.kind];
  if (!allowed) throw fail('AGENT_FIXTURE_UNSUPPORTED_EVENT', 'Unsupported fixture event: ' + event.kind);
  assert.ok(Object.keys(event).every(key => allowed.includes(key)), 'Unknown fixture event field');
  const owned = context.objects[event.object]; assert.ok(owned, 'Event must select one owned fixture');
  assert.ok(event.kind === 'readback' || !owned.external, 'External builtin bindings are read-only');
  const started = clock(), record = { event, started, actor: 'fixture-controller' };
  const path = join(context.root, 'event-' + randomUUID() + '.json');
  try {
    if (event.kind === 'publish-version') record.result = await publishVersion(bindings, event);
    if (event.kind === 'interrupt-source-write') record.result = await interruptSourceWrite(bindings, event);
    if (event.kind === 'resume-source-write') record.result = await resumeSourceWrite(bindings, event);
    if (event.kind === 'readback') {
      const declaration = bindings.private.readbacks[event.receipt];
      assert.ok(declaration && declaration.object === event.object, 'Unknown readback declaration');
      record.result = await captureReadback(bindings, event.object, { ...declaration, key: event.receipt });
    }
    if (event.kind === 'set-enabled') {
      assert.equal(typeof event.enabled, 'boolean');
      assert.ok(event.defaultContext === undefined || typeof event.defaultContext === 'boolean');
      const args = ['ctl', 'library', 'skill', 'update', owned.pageId, '--library', context.libraryId, '--enabled', String(event.enabled)];
      if (event.defaultContext !== undefined) args.push('--default-context', String(event.defaultContext));
      const result = await cli(context, args, 'set-enabled');
      const row = await request(context, 'v1/pages/' + owned.pageId);
      assert.equal(pick(row, context.library.skills.property_ids, 'Enabled')?.checkbox, event.enabled);
      if (event.defaultContext !== undefined) assert.equal(pick(row, context.library.skills.property_ids, 'Default Context')?.checkbox, event.defaultContext);
      owned.currentProperties = { ...owned.currentProperties, enabled: event.enabled,
        ...(event.defaultContext === undefined ? {} : { defaultContext: event.defaultContext }) };
      record.result = { command: result.artifact, row };
      if (event.enabled) record.result.readback = await captureReadback(bindings, event.object, {
        version: owned.currentVersion, key: event.object + '-enabled', properties: owned.currentProperties,
      });
    }
    if (event.kind === 'remove-owned') {
      assert.equal(owned.placement, 'notion');
      const result = await cli(context, ['ctl', 'library', 'skill', 'remove', owned.pageId ?? owned.skillId, '--library', context.libraryId], 'remove');
      if (result.value.status === 'removed') assert.equal(result.value.cleanup_verified, true);
      assert.ok(['removed', 'already_trashed', 'not_found'].includes(result.value.status));
      record.result = { command: result.artifact, receipt: result.value, readback: await captureReadback(bindings, event.object, { key: event.object + '-removed', expected: 'absent' }) };
    }
    if (event.kind === 'trash-projection') {
      assert.equal(owned.placement, 'source'); assert.ok(owned.pageId);
      const owner = { kind: 'page', id: owned.pageId, skillId: owned.skillId };
      const before = await captureReadback(bindings, event.object, { key: event.object + '-before-trash' });
      owned.projectionBeforeTrash = before;
      const row = await request(context, 'v1/pages/' + owner.id); assertProjectionTrashIdentity(context, owner, row);
      const blocks = await children(context, owner.id);
      const targets = blocks.map(block => {
        const parent = block.parent;
        assert.ok(parent && ['page_id', 'block_id'].includes(parent.type), 'Projection trash needs a known block parent');
        assert.equal(normalizedNotionId(parent[parent.type]), normalizedNotionId(owner.id), 'Projection trash is limited to owned top-level blocks');
        const target = { kind: 'block', id: block.id, parent: { type: parent.type, [parent.type]: parent[parent.type] } };
        assertProjectionTrashIdentity(context, target, block); return target;
      });
      record.result = { fixtureMutation: 'clear-owned-generated-main-and-trash-exact-page', before, confirmations: [], clearedBlocks: [] };
      for (const target of targets) {
        await trashProjectionObject(context, target, record.result.confirmations);
        record.result.clearedBlocks.push(target.id);
      }
      const confirmed = await trashProjectionObject(context, owner, record.result.confirmations);
      const readback = confirmed ?? await request(context, 'v1/pages/' + owner.id);
      assertProjectionTrashIdentity(context, owner, readback);
      assert.ok(readback.in_trash === true || readback.archived === true);
      record.result.readback = readback;
    }
    if (event.kind === 'restore-projection') {
      assert.equal(owned.placement, 'source'); assert.ok(owned.projectionBeforeTrash, 'Restoration needs the before-trash comparison');
      const result = await cli(context, ['ctl', 'library', 'projection', owned.pageId, '--restore', '--library', context.libraryId], 'restore-projection');
      const readback = await captureReadback(bindings, event.object, { key: event.object + '-restored', projection: 'same-as-baseline' });
      assert.deepEqual(readback.observed.files.map(file => [file.path, file.sha256, file.mode]), owned.projectionBeforeTrash.observed.files.map(file => [file.path, file.sha256, file.mode]));
      record.result = { command: result.artifact, readback };
    }
    if (event.kind === 'fault') record.result = await injectFault(bindings, event, ownedStateRoot, runtimeEnv);
    record.status = 'passed';
  } catch (error) {
    record.status = 'failed'; record.error = { code: error.code, message: error.message, details: error.details };
    throw Object.assign(error, { fixtureEventArtifact: path });
  } finally {
    record.completed = clock(); await save(path, record); await persist(bindings, bindingsPath);
  }
  return { ...record, artifact: await artifact(path) };
}

export async function readAgentFixture(bindings, object, options = {}) {
  const { preserveBindings = false, ...readback } = options;
  assert.equal(typeof preserveBindings, 'boolean');
  const result = await captureReadback(bindings, object, readback);
  if (!preserveBindings) await persist(bindings);
  return result;
}

/** Cleanup only declared fixture ownership, after subject processes have exited. Keep all evidence. */
export async function cleanupAgentFixtures(bindings, { subjectExited, trash = '/usr/bin/trash', preserveBindings = false } = {}) {
  assert.equal(subjectExited, true, 'Stop the owned subject before fixture cleanup');
  assert.equal(typeof preserveBindings, 'boolean');
  const context = bindings.private.fixture, ownership = await assertOwnership(context);
  assert.ok(isAbsolute(trash) && await exists(trash), 'A verified system Trash executable is required');
  const results = [], bindingsArtifacts = [];
  const persistCleanup = async () => {
    if (!preserveBindings) return persist(bindings);
    const checkpoint = await capture(context, join(context.root, 'cleanup-bindings-' + randomUUID() + '.json'), bindings);
    bindingsArtifacts.push(checkpoint); return checkpoint;
  };
  const viewCleanup = await cleanupFilteredView(context); if (viewCleanup) results.push(viewCleanup);
  for (const fault of [...(context.faults ?? [])].reverse()) {
    if (await exists(fault.target)) {
      if (await exists(fault.source)) {
        const marker = await json(fault.source);
        assert.equal(marker.fixtureFault, context.ownership.token);
        await rename(fault.source, join(context.root, 'quarantine', 'fault-marker-' + randomUUID()));
      }
      await mkdir(dirname(fault.source), { recursive: true, mode: 0o700 }); await rename(fault.target, fault.source);
    } else if (!(fault.mode === 'store-unavailable' && fault.probe && fault.status !== 'restored')) {
      continue;
    }
    if (fault.mode === 'store-unavailable' && fault.probe) {
      assert.equal(await realpath(fault.source), fault.source);
      assert.ok((await lstat(fault.source)).isDirectory());
      const marker = await json(join(fault.source, 'agent-workflow-owner.json'));
      assert.equal(marker.runId, context.runId); assert.equal(marker.fixtureRoot, context.root); assert.equal(marker.token, context.ownership.token);
      assert.equal(fault.probe.roots.NTN_SKILLS_HOME, fault.source);
      const restored = await storeFaultRead(context, fault.probe, 'fault-store-restored', process.env);
      fault.restoration = { ...restored, restoredAt: clock() }; fault.status = 'restored';
      results.push({ object: fault.object, action: 'restore-owned-store', status: 'passed', readback: restored });
    }
    await persistCleanup();
  }
  for (const owned of Object.values(context.objects).reverse()) {
    if (owned.external) { assert.equal(owned.readOnly, true); results.push({ object: owned.id, action: 'external-read-only-preserved', status: 'passed' }); continue; }
    if (owned.placement === 'global' || owned.placement === 'project') {
      if (!owned.directory || !(await exists(owned.directory))) continue;
      const marker = await json(join(owned.directory, '.agent-workflow-owner.json'));
      assert.equal(marker.runId, context.runId); assert.equal(marker.token, context.ownership.token);
      const result = await processCommand(trash, [owned.directory], { cwd: context.root, env: process.env, timeoutMs: 30000 });
      assert.equal(result.code, 0); assert.equal(await exists(owned.directory), false);
      results.push({ object: owned.id, action: 'local-trash', status: 'passed' }); continue;
    }
    if (!owned.pageId) {
      const row = await actualSkill(context, owned);
      if (!row && owned.placement !== 'source') continue;
    }
    if (owned.placement === 'source') {
      if (!owned.sourcePageId) {
        const observed = await observeSourceCheckpoint(bindings, owned.id); await persistCleanup();
        if (!observed.source && !owned.sourceOperation) continue;
        assert.ok(observed.source, 'An interrupted Source intent needs reconciliation before teardown');
      }
      const sourceBefore = await request(context, 'v1/pages/' + owned.sourcePageId);
      assert.equal(propertyText(sourceBefore, context.library.sources.property_ids, 'Source ID'), owned.sourceId);
      if (!(sourceBefore.in_trash || sourceBefore.archived)) {
        assert.equal(propertyText(sourceBefore, context.library.sources.property_ids, 'Status'), 'ready', 'Resume the exact unfinished Source before teardown');
        assert.equal(propertyText(sourceBefore, context.library.sources.property_ids, 'Operation'), '', 'Preserve unfinished Source evidence');
      }
      const sourceRecords = await pages(context, 'records', { property: context.library.records.property_ids.Origin, relation: { contains: owned.sourcePageId } });
      owned.sourceRecordIds = [...new Set([...(owned.sourceRecordIds ?? []), ...sourceRecords.map(record => record.id)])];
      await persistCleanup(); // Preserve exact retired identities before the first writer may trash them.
      const commands = [];
      if (!(sourceBefore.in_trash || sourceBefore.archived)) {
        const declaration = await json(owned.declarationPath);
        // An empty selected set still needs its original valid discovery root.
        declaration.definition.selection = { ...declaration.definition.selection, include: [], exclude: ['**'], mapping: {} }; declaration.contributions = [];
        const path = join(context.root, 'inputs', owned.id + '-retire-source-' + randomUUID() + '.json'); await save(path, declaration);
        const empty = await cli(context, ['ctl', 'library', 'source', 'apply', path, '--library', context.libraryId], 'retire-source-members');
        const removed = await cli(context, ['ctl', 'library', 'source', 'remove', owned.sourceId, '--library', context.libraryId], 'remove-source');
        commands.push(empty.artifact, removed.artifact);
      }
      const retired = [];
      for (const id of [...new Set([owned.pageId, owned.sourcePageId, ...(owned.knownChildren ?? []).map(child => child.pageId), ...owned.sourceRecordIds].filter(Boolean))]) {
        const current = await request(context, 'v1/pages/' + id);
        assert.ok(current.in_trash || current.archived, 'Source teardown left a known owned page live'); retired.push(current);
      }
      const readback = await capture(context, join(context.root, 'readbacks', owned.id + '-source-cleanup-' + randomUUID() + '.json'), { sourceBefore, sourceRecords, retired, at: clock() });
      owned.cleanupReadback = readback;
      results.push({ object: owned.id, action: 'source-cleanup', status: 'passed', commands, readback });
    } else {
      const row = await request(context, 'v1/pages/' + owned.pageId);
      if (owned.wasUnmanaged && !propertyText(row, context.library.skills.property_ids, 'Current State')) {
        assert.equal(propertyText(row, context.library.skills.property_ids, 'Operation'), '', 'Preserve unfinished registration evidence');
        for (const child of owned.knownChildren ?? []) {
          assert.equal(child.kind, 'file');
          await request(context, 'v1/pages/' + child.pageId, { method: 'PATCH', body: { in_trash: true }, fixtureMutation: true });
        }
        await request(context, 'v1/pages/' + owned.pageId, { method: 'PATCH', body: { in_trash: true }, fixtureMutation: true });
        const retired = await request(context, 'v1/pages/' + owned.pageId);
        assert.ok(retired.in_trash || retired.archived);
        results.push({ object: owned.id, action: 'unmanaged-test-fixture-trash', status: 'passed', productRepair: false });
        continue;
      }
      if (row.in_trash || row.archived) { const readback = await captureReadback(bindings, owned.id, { key: owned.id + '-cleanup', expected: 'absent' }); results.push({ object: owned.id, action: 'already-trashed', status: 'passed', readback }); continue; }
      const removed = await cli(context, ['ctl', 'library', 'skill', 'remove', owned.pageId, '--library', context.libraryId], 'cleanup-owned');
      assert.equal(removed.value.cleanup_verified, true);
      const readback = await captureReadback(bindings, owned.id, { key: owned.id + '-cleanup', expected: 'absent' });
      results.push({ object: owned.id, action: 'native-cleanup', status: 'passed', command: removed.artifact, readback });
    }
  }
  if (preserveBindings) await persistCleanup();
  const retained = preserveBindings ? { bindingsArtifacts } : {};
  const retainedEvidence = { root: context.root, policy: 'retain-inputs-oracles-stores-and-temporary-files',
    ...(ownership.temporaryRoot ? { temporaryRoot: ownership.temporaryRoot } : {}) };
  const path = join(context.root, 'cleanup-' + randomUUID() + '.json'); await save(path, { results, at: clock(), semantics: 'owned-fixture-teardown-not-product-repair', retainedEvidence, ...retained });
  if (!preserveBindings) await persist(bindings);
  return { results, artifact: await artifact(path), retainedEvidence, ...retained };
}
