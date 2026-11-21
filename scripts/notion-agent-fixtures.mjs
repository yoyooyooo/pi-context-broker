import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, appendFile, chmod, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateAgentFixtureRecipe } from './notion-agent-scenarios.mjs';

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

async function processCommand(file, args, { cwd, env, timeoutMs = 600000 }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdin.end();
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, timedOut, stdout, stderr }); });
  });
}

/** Only public CLI actions assembled by this module are executable. No shell or command field is accepted. */
async function cli(context, args, label) {
  assert.ok(id(label));
  const started = clock(), path = join(context.root, 'commands', label + '-' + randomUUID() + '.json');
  const env = { ...process.env, ...context.env }; delete env.NTN_SKILLS_DEV_ROOT;
  const result = await processCommand(context.node, [context.cli, ...args], { cwd: context.root, env });
  let value;
  try { value = JSON.parse(result.stdout.trim()); } catch { /* retain exact output before rejecting */ }
  const receipt = { command: [context.node, context.cli, ...args], started, completed: clock(), ...result };
  await save(path, receipt);
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
  const readOnly = method === 'GET' || isQuery, maximumAttempts = readOnly ? 3 : 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    const started = clock(); let result, value, failure;
    try {
      result = await fetch('https://api.notion.com/' + path, {
        method, signal: AbortSignal.timeout(60000),
        headers: { authorization: 'Bearer ' + token, 'Notion-Version': context.apiVersion, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      value = await result.json();
    } catch (error) { failure = error; }
    const transient = failure !== undefined || result.status === 429 || result.status >= 500;
    const retry = readOnly && transient && attempt < maximumAttempts;
    await appendFile(join(context.root, 'network-attempts.jsonl'), JSON.stringify({
      method, path, attempt, maximumAttempts, started, completed: clock(), readOnly, retry,
      status: result?.status ?? null, ...(failure ? { error: { name: failure.name, message: failure.message, cause: failure.cause?.code } } : {}),
    }) + '\n', { mode: 0o600 });
    if (retry) {
      const retryAfter = Number(result?.headers.get('retry-after'));
      await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(2000, retryAfter * 1000) : attempt * 250));
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

/** Native text is compared after the CLI's documented Markdown normalization, never as original-byte proof. */
export function fixtureTextMeaning(value) {
  return withoutFrontmatter(value).replace(/\n{3,}/g, '\n\n');
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

function relationArgs(context, version) {
  const args = [];
  for (const [field, aliases] of [['requires', version.requires], ['members', version.members]]) {
    if (!aliases?.length) continue;
    for (const alias of aliases) {
      const target = context.objects[alias];
      assert.ok(target && target.pageId, 'Fixture relation target is not yet live: ' + alias);
      args.push('--' + field, target.pageId);
    }
  }
  if (version.enabled !== undefined) args.push('--enabled', String(version.enabled));
  if (version.defaultContext !== undefined) args.push('--default-context', String(version.defaultContext));
  return args;
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
  const body = await tree(context, row.id);
  if (pick(row, ids, 'Enabled')?.checkbox === false) {
    assert.equal(properties?.enabled, false, 'A disabled body cannot be read as current content');
    assert.equal(version, undefined, 'Metadata-only disabled readback cannot prove a new content version');
    const captured = await capture(context, receiptPath, { row, files, records, body, observedAt: clock() });
    const result = { status: 'passed', object: { owner: identity.owner }, artifact: captured,
      observed: { state: 'present', ready: true, operationEmpty: true, properties, metadataOnly: true },
      assertions: [{ id: 'independent-live-metadata', status: 'passed' }], externalRepair: false };
    return sealReadback(context, key, result);
  }
  const main = await cli(context, ['read', row.id, '--database', context.entry, '--refresh', '--json'], 'read-main');
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
    if (expectedVersion.enabled !== undefined) assert.equal(pick(row, ids, 'Enabled')?.checkbox, expectedVersion.enabled);
    if (expectedVersion.defaultContext !== undefined) assert.equal(pick(row, ids, 'Default Context')?.checkbox, expectedVersion.defaultContext);
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
      if (/\.(md|markdown)$/iu.test(resourcePath) && owned.placement !== 'source')
        assert.equal(fixtureTextMeaning(bytes.toString()), fixtureTextMeaning(planned.toString()), 'Native content changed meaning');
      else assert.equal(sha(bytes), sha(planned), 'Exact source/resource bytes changed');
    }
    const bodyKey = alias + '@' + label + '/' + resourcePath;
    bindings.private.bodies[bodyKey] = { path: output, sha256: sha(bytes), bytes: bytes.length, object: alias, version: label, resourcePath };
    observedFiles.push({ path: resourcePath, sha256: sha(bytes), bytes: bytes.length, bodyKey, fileId: file.file_id ?? file.id, mode: file.mode });
  }
  if (versionFiles.length) assert.deepEqual(observedFiles.map(file => file.path).sort(), versionFiles.map(file => file.path).sort(), 'The complete consumption tree differs');
  identity.versions[label] = { ref: main.value.ref, snapshot_id: main.value.snapshot_id, version_id: main.value.version_id,
    bodyKeys: observedFiles.map(file => file.bodyKey), readback: key };
  identity.currentVersion = label; owned.currentVersion = label;
  owned.knownChildren = [...files.map(file => ({ pageId: file.id, kind: 'file' })), ...records.map(record => ({ pageId: record.id, kind: 'record' }))];
  let observedProjection;
  if (owned.placement === 'source') {
    const projected = [{ path: 'SKILL.md', body: blockShape(body) }];
    for (const file of files) {
      const path = propertyText(file, context.library.files.property_ids, 'Path');
      if (/\.(md|markdown)$/iu.test(path)) projected.push({ path, body: blockShape(await tree(context, file.id)) });
    }
    projected.sort((a, b) => a.path.localeCompare(b.path));
    assert.ok(projected[0] && projected.find(file => file.path === 'SKILL.md')?.body.length > 0, 'The generated main reading projection is empty');
    observedProjection = { sha256: sha(JSON.stringify(projected)), files: projected };
    if (!owned.projectionBaseline) owned.projectionBaseline = observedProjection;
    if (projection === 'same-as-baseline') assert.equal(observedProjection.sha256, owned.projectionBaseline.sha256, 'Restored reading projection differs from the baseline');
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
  assert.equal(actual.parent?.database_id?.replaceAll('-', ''), context.entry.replaceAll('-', ''));
  assert.equal(actual.name, name);
  assert.deepEqual(after.filter(view => context.view.originalViewIds.includes(view.id)).map(view => view.id), context.view.originalViewIds, 'Creating the owned View changed existing view order');
  const listed = await cli(context, ['list', '--database', context.entry, '--view', created.id, '--refresh', '--limit', '500', '--json'], 'verify-filtered-view');
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
  assert.equal(actual.name, context.view.name); assert.equal(actual.parent?.database_id?.replaceAll('-', ''), context.entry.replaceAll('-', ''));
  const removed = await request(context, 'v1/views/' + context.viewId, { method: 'DELETE', fixtureMutation: true });
  assert.equal(removed.id, context.viewId);
  const after = await listViews(context);
  assert.equal(after.some(view => view.id === context.viewId), false, 'The owned View is still present');
  assert.deepEqual(after.filter(view => context.view.originalViewIds.includes(view.id)).map(view => view.id), context.view.originalViewIds, 'View cleanup changed existing view order');
  context.view.cleaned = true;
  const receipt = await capture(context, join(context.root, 'readbacks', 'filtered-view-cleaned.json'), { before, actual, removed, after, at: clock() });
  return { action: 'owned-filtered-view-delete', status: 'passed', artifact: receipt };
}

/** Prepare one owned real fixture. The library is never replaced and global configuration is never edited. */
export async function prepareAgentFixtures({ recipe, runId, root, entry, cli: cliPath, node = process.execPath, globalSkillsRoot = join(homedir(), '.agents/skills'), apiVersion = '2026-03-11' }) {
  validateAgentFixtureRecipe(recipe);
  for (const object of recipe.objects) if (['global', 'project'].includes(object.placement))
    assert.ok(/^[a-z0-9][a-z0-9-]*$/u.test(object.name), 'Native fixture names must be safe lowercase invocation names');
  assert.ok(isAbsolute(globalSkillsRoot), 'Use an absolute native global Skill root');
  assert.ok(id(runId) && pageId(entry) && isAbsolute(root) && isAbsolute(cliPath) && isAbsolute(node));
  assert.ok(!(await exists(root)), 'Use a fresh fixture root; resume from its bindings instead');
  await mkdir(root, { recursive: true, mode: 0o700 }); root = await realpath(root);
  const context = { version: 1, runId, root, entry, cli: await realpath(cliPath), node: await realpath(node), apiVersion, recipe,
    env: { NTN_SKILLS_HOME: join(root, 'state'), NTN_SKILLS_CACHE_HOME: join(root, 'cache'), NTN_SKILLS_DATA_HOME: join(root, 'data') },
    objects: {}, projectRoot: join(root, 'project'), observedReadbacks: {}, ownership: { runId, root, token: randomUUID(), createdAt: new Date().toISOString(), globalDirectories: [] } };
  await save(join(root, 'ownership.json'), context.ownership);
  for (const path of ['commands', 'readbacks', 'inputs', 'quarantine', 'project/.agents/skills']) await mkdir(join(root, path), { recursive: true, mode: 0o700 });
  const inspect = await cli(context, ['ctl', 'library', 'inspect', entry], 'inspect-library'); context.library = inspect.value.library;
  assert.equal(context.library.skills.database_id.replaceAll('-', ''), entry.replaceAll('-', ''));
  const bindings = { version: 1, public: { ...(recipe.public ?? {}) }, private: { fixture: context, objects: {}, bodies: {}, facts: recipe.facts ?? {}, readbacks: structuredClone(recipe.readbacks ?? {}) } };
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
    for (const object of recipe.objects) {
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
          const listed = await cli(context, ['list', '--database', entry, '--query', object.name, '--refresh', '--limit', '500', '--json', ...(cursor ? ['--cursor', cursor] : [])], 'find-builtin');
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
        const declaration = structuredClone(object.source.declaration);
        declaration.definition.source_id = 'agent-workflow-' + runId + '-' + object.id; declaration.definition.name = owned.name;
        declaration.contributions = [{ member_key: object.source.memberKey, skill_id: owned.skillId, mount_path: '', mapping: {}, exclude: [] }];
        assert.deepEqual(declaration.definition.selection.roots, [object.source.memberKey], 'Select exactly one reviewed upstream member');
        const path = join(root, 'inputs', object.id + '-source.json'); await save(path, declaration);
        const applied = await cli(context, ['ctl', 'library', 'source', 'apply', path, '--entry', entry], 'source-apply');
        const selected = applied.value.targets?.filter(target => target.skill_id === owned.skillId);
        assert.equal(selected?.length, 1); assert.equal(applied.value.targets.length, 1, 'Source discovery exceeded owned scope');
        owned.pageId = selected[0].page_id; owned.sourceId = declaration.definition.source_id; owned.sourcePageId = applied.value.source_page_id;
        owned.declarationPath = path; identity.sourceId = owned.sourceId;
        await cli(context, ['ctl', 'library', 'projection', owned.pageId, '--entry', entry], 'projection');
      } else {
        const input = owned.versionInputs[object.initial]; assert.ok(input);
        const created = await cli(context, ['ctl', 'library', 'skill', 'create', input.directory, '--entry', entry, '--skill-id', owned.skillId,
          '--name', owned.name, '--description', object.description, ...relationArgs(context, input)], 'create');
        owned.pageId = created.value.page_id; assert.ok(pageId(owned.pageId));
      }
      await captureReadback(bindings, object.id, { version: object.initial });
      await persist(bindings);
    }
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
  assert.equal(owned.placement, 'notion', 'Version publication uses the native public update command');
  const beforeFiles = owned.versionInputs[owned.currentVersion]?.files ?? [];
  const args = ['ctl', 'library', 'skill', 'update', owned.pageId ?? owned.skillId, '--entry', context.entry];
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
  const readback = await captureReadback(bindings, event.object, { version: event.version, key: event.object + '@' + event.version });
  return { command: result.artifact, readback };
}

async function injectFault(bindings, event, ownedStateRoot) {
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
  await rename(source, target);
  if (event.mode === 'store-unavailable') await save(source, { fixtureFault: context.ownership.token, restoreFrom: target });
  context.faults ??= []; context.faults.push({ mode: event.mode, source, target });
  return { kind: event.mode, source, quarantine: target, verifiedAbsent: event.mode === 'store-unavailable' ? !(await lstat(source)).isDirectory() : !(await exists(source)) };
}

/** Finite control-plane events. RPC lifecycle events belong to the existing Pi runner. */
export async function runAgentFixtureEvent(event, { bindings, bindingsPath, ownedStateRoot }) {
  const context = bindings.private.fixture; await assertOwnership(context);
  assert.ok(event && typeof event === 'object' && !Array.isArray(event));
  const allowed = {
    'publish-version': ['kind', 'object', 'version'],
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
    if (event.kind === 'readback') {
      const declaration = bindings.private.readbacks[event.receipt];
      assert.ok(declaration && declaration.object === event.object, 'Unknown readback declaration');
      record.result = await captureReadback(bindings, event.object, { ...declaration, key: event.receipt });
    }
    if (event.kind === 'set-enabled') {
      assert.equal(typeof event.enabled, 'boolean');
      assert.ok(event.defaultContext === undefined || typeof event.defaultContext === 'boolean');
      const args = ['ctl', 'library', 'skill', 'update', owned.pageId, '--entry', context.entry, '--enabled', String(event.enabled)];
      if (event.defaultContext !== undefined) args.push('--default-context', String(event.defaultContext));
      const result = await cli(context, args, 'set-enabled');
      const row = await request(context, 'v1/pages/' + owned.pageId);
      assert.equal(pick(row, context.library.skills.property_ids, 'Enabled')?.checkbox, event.enabled);
      if (event.defaultContext !== undefined) assert.equal(pick(row, context.library.skills.property_ids, 'Default Context')?.checkbox, event.defaultContext);
      record.result = { command: result.artifact, row };
    }
    if (event.kind === 'remove-owned') {
      assert.equal(owned.placement, 'notion');
      const result = await cli(context, ['ctl', 'library', 'skill', 'remove', owned.pageId ?? owned.skillId, '--entry', context.entry], 'remove');
      if (result.value.status === 'removed') assert.equal(result.value.cleanup_verified, true);
      assert.ok(['removed', 'already_trashed', 'not_found'].includes(result.value.status));
      record.result = { command: result.artifact, receipt: result.value, readback: await captureReadback(bindings, event.object, { key: event.object + '-removed', expected: 'absent' }) };
    }
    if (event.kind === 'trash-projection') {
      assert.equal(owned.placement, 'source'); assert.ok(owned.pageId);
      const before = await captureReadback(bindings, event.object, { key: event.object + '-before-trash' });
      owned.projectionBeforeTrash = before;
      const row = await request(context, 'v1/pages/' + owned.pageId);
      assert.equal(propertyText(row, context.library.skills.property_ids, 'Skill ID'), owned.skillId);
      const blocks = await children(context, owned.pageId);
      for (const block of blocks) await request(context, 'v1/blocks/' + block.id, { method: 'PATCH', body: { in_trash: true }, fixtureMutation: true });
      await request(context, 'v1/pages/' + owned.pageId, { method: 'PATCH', body: { in_trash: true }, fixtureMutation: true });
      const readback = await request(context, 'v1/pages/' + owned.pageId);
      assert.ok(readback.in_trash === true || readback.archived === true);
      record.result = { fixtureMutation: 'clear-owned-generated-main-and-trash-exact-page', before, readback, clearedBlocks: blocks.map(block => block.id) };
    }
    if (event.kind === 'restore-projection') {
      assert.equal(owned.placement, 'source'); assert.ok(owned.projectionBeforeTrash, 'Restoration needs the before-trash comparison');
      const result = await cli(context, ['ctl', 'library', 'projection', owned.pageId, '--restore', '--entry', context.entry], 'restore-projection');
      const readback = await captureReadback(bindings, event.object, { key: event.object + '-restored', projection: 'same-as-baseline' });
      assert.deepEqual(readback.observed.files.map(file => [file.path, file.sha256, file.mode]), owned.projectionBeforeTrash.observed.files.map(file => [file.path, file.sha256, file.mode]));
      record.result = { command: result.artifact, readback };
    }
    if (event.kind === 'fault') record.result = await injectFault(bindings, event, ownedStateRoot);
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
  const result = await captureReadback(bindings, object, options); await persist(bindings); return result;
}

/** Cleanup only declared fixture ownership, after subject processes have exited. Keep all evidence. */
export async function cleanupAgentFixtures(bindings, { subjectExited, trash = '/usr/bin/trash' } = {}) {
  assert.equal(subjectExited, true, 'Stop the owned subject before fixture cleanup');
  const context = bindings.private.fixture; await assertOwnership(context);
  assert.ok(isAbsolute(trash) && await exists(trash), 'A verified system Trash executable is required');
  const results = [];
  const viewCleanup = await cleanupFilteredView(context); if (viewCleanup) results.push(viewCleanup);
  for (const fault of [...(context.faults ?? [])].reverse()) {
    if (!(await exists(fault.target))) continue;
    if (await exists(fault.source)) {
      const marker = await json(fault.source);
      assert.equal(marker.fixtureFault, context.ownership.token);
      await rename(fault.source, join(context.root, 'quarantine', 'fault-marker-' + randomUUID()));
    }
    await mkdir(dirname(fault.source), { recursive: true, mode: 0o700 }); await rename(fault.target, fault.source);
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
    if (!owned.pageId) { const row = await actualSkill(context, owned); if (!row) continue; }
    if (owned.placement === 'source') {
      const sourceBefore = await request(context, 'v1/pages/' + owned.sourcePageId);
      assert.equal(propertyText(sourceBefore, context.library.sources.property_ids, 'Source ID'), owned.sourceId);
      const sourceRecords = await pages(context, 'records', { property: context.library.records.property_ids.Origin, relation: { contains: owned.sourcePageId } });
      owned.sourceRecordIds = [...new Set([...(owned.sourceRecordIds ?? []), ...sourceRecords.map(record => record.id)])];
      await persist(bindings); // Preserve exact retired identities before the first writer may trash them.
      const commands = [];
      if (!(sourceBefore.in_trash || sourceBefore.archived)) {
        const declaration = await json(owned.declarationPath);
        // An empty selected set still needs its original valid discovery root.
        declaration.definition.selection = { ...declaration.definition.selection, include: [], exclude: ['**'], mapping: {} }; declaration.contributions = [];
        const path = join(context.root, 'inputs', owned.id + '-retire-source-' + randomUUID() + '.json'); await save(path, declaration);
        const empty = await cli(context, ['ctl', 'library', 'source', 'apply', path, '--entry', context.entry], 'retire-source-members');
        const removed = await cli(context, ['ctl', 'library', 'source', 'remove', owned.sourceId, '--entry', context.entry], 'remove-source');
        commands.push(empty.artifact, removed.artifact);
      }
      const retired = [];
      for (const id of [...new Set([owned.pageId, owned.sourcePageId, ...(owned.knownChildren ?? []).map(child => child.pageId), ...owned.sourceRecordIds])]) {
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
      const removed = await cli(context, ['ctl', 'library', 'skill', 'remove', owned.pageId, '--entry', context.entry], 'cleanup-owned');
      assert.equal(removed.value.cleanup_verified, true);
      const readback = await captureReadback(bindings, owned.id, { key: owned.id + '-cleanup', expected: 'absent' });
      results.push({ object: owned.id, action: 'native-cleanup', status: 'passed', command: removed.artifact, readback });
    }
  }
  const path = join(context.root, 'cleanup-' + randomUUID() + '.json'); await save(path, { results, at: clock(), semantics: 'owned-fixture-teardown-not-product-repair' });
  await persist(bindings);
  return { results, artifact: await artifact(path) };
}
