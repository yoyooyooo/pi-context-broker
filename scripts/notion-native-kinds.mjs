import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const kinds = ['skill', 'prompt', 'router'];
const hash = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async path => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const escapeText = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const decodeAttribute = text => text.replace(/&(amp|lt|gt|quot|apos);/g, (_all, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]);
const attr = (text, name) => decodeAttribute(new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(text)?.[1] ?? '');
const textOf = message => typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
const regexText = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const identity = fixture => JSON.stringify(['notion', fixture.scope, fixture.record.kind, 'shared_skill', fixture.record.id]);
const portable = path => typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') && !/^[A-Za-z]:/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');

/** The caller selects existing objects. This recipe never creates or changes a fixture. */
export function validateNativeKindsConfig(input) {
  assert.deepEqual(Object.keys(input ?? {}).sort(), ['refs', 'version'], 'Native kinds config requires only version and refs');
  assert.equal(input.version, 1);
  assert.deepEqual(Object.keys(input.refs ?? {}).sort(), [...kinds].sort(), 'Select one existing Skill, Prompt and Router');
  for (const kind of kinds) {
    const ref = input.refs[kind];
    const match = typeof ref === 'string' && /^skill:\/\/([^/?#]+)\/(SKILL|PROMPT|ROUTER)\.md$/.exec(ref);
    assert.ok(match && match[2].toLowerCase() === kind && decodeURIComponent(match[1]).startsWith('shared_skill:'), 'Each selection must be an exact unpinned shared public entry ref of the declared kind');
  }
  assert.equal(new Set(Object.values(input.refs)).size, 3, 'The three kinds must be distinct objects');
  return input;
}

async function tree(directory, prefix = '') {
  const files = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'A public export cannot contain symbolic links');
    const name = prefix + entry.name;
    if (entry.isDirectory()) for (const [path, bytes] of await tree(join(directory, entry.name), name + '/')) files.set(path, bytes);
    else {
      assert.ok(entry.isFile(), 'A public export must contain regular files only');
      files.set(name, await readFile(join(directory, entry.name)));
    }
  }
  return files;
}

/** A fresh public read/export is a consumption oracle, not an authoring expectation. */
export async function prepareNativeKinds({ config, database, evidence, invoke }) {
  validateNativeKindsConfig(config);
  const listed = await invoke(['list', '--database', database]);
  assert.equal(listed.ok, true);
  assert.equal(listed.coverage?.exhaustive, true, 'Native kinds require an exhaustive explicit entry catalog');
  assert.deepEqual(listed.coverage?.failed_sources, []);
  assert.ok(listed.coverage?.queried_data_sources?.length > 0);
  assert.match(listed.scope ?? '', /^[a-f0-9]{64}$/);
  const fixtures = {}, files = ['native-kinds-catalog.json', 'native-kinds-selection.json'];
  await save(join(evidence, files[0]), listed);
  await save(join(evidence, files[1]), config);
  for (const kind of kinds) {
    const matches = listed.records.filter(record => record.ref === config.refs[kind]);
    assert.equal(matches.length, 1, 'The configured ref must select one current catalog record');
    const record = matches[0];
    assert.equal(record.kind, kind);
    assert.equal(record.enabled, true);
    assert.equal(record.locator?.type, 'shared_skill');
    assert.equal(record.ref, `skill://${encodeURIComponent(record.id)}/${record.entrypoint}`);
    assert.equal(record.entrypoint, kind.toUpperCase() + '.md');
    assert.match(record.locator.page_id ?? '', /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    const folder = join(evidence, 'native-kinds-oracles', kind);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const read = await invoke(['read', record.ref, '--database', database, '--refresh', '--metrics']);
    assert.equal(read.ok, true);
    assert.deepEqual(read.record, record, 'Current fixture metadata changed after catalog discovery');
    assert.equal(read.scope, listed.scope);
    assert.match(read.snapshot_id ?? '', /^s_[a-f0-9]{64}$/);
    assert.match(read.version_id ?? '', /^[a-f0-9]{64}$/);
    assert.equal(read.ref, `${record.ref}?snapshot=${read.snapshot_id}`);
    assert.equal(read.path, record.entrypoint);
    assert.equal(read.entrypoint, record.entrypoint);
    assert.ok(typeof read.content === 'string' && read.content.trim(), 'The configured native body must be nonempty');
    assert.equal(read.has_more, false, 'A truncated read cannot define the oracle');
    assert.ok(Number.isSafeInteger(read.range?.total_lines) && read.range.total_lines > 0);
    assert.equal(read.range.start, 1);
    assert.equal(read.range.end, read.range.total_lines);
    const listing = await invoke(['files', read.snapshot_id, '--database', database, '--offline']);
    const directory = join(folder, 'export');
    const exported = await invoke(['export', read.snapshot_id, '--database', database, '--offline', '--projection', 'snapshot', '--format', 'directory', '--output', directory]);
    for (const receipt of [listing, exported]) {
      assert.equal(receipt.ok, true);
      assert.deepEqual(receipt.record, record);
      assert.equal(receipt.scope, read.scope);
      assert.equal(receipt.snapshot_id, read.snapshot_id);
      assert.equal(receipt.version_id, read.version_id);
    }
    assert.equal(exported.operation, 'export');
    assert.equal(exported.projection, 'snapshot');
    assert.equal(exported.format, 'directory');
    assert.equal(resolve(exported.output), resolve(directory));
    const allFiles = await tree(directory);
    assert.ok(Array.isArray(exported.files) && Array.isArray(listing.files));
    assert.deepEqual(exported.files.map(file => file.path).sort(), [...allFiles.keys()].sort(), 'The export manifest must cover every byte');
    for (const file of exported.files) {
      assert.ok(portable(file.path));
      const bytes = allFiles.get(file.path);
      assert.equal(bytes.length, file.bytes);
      assert.equal(hash(bytes), file.hash, 'Exported bytes differ from the public checksum');
    }
    assert.ok(allFiles.has('.ntn-skills.json'));
    assert.deepEqual(listing.files.map(file => file.path).sort(), [...allFiles.keys()].filter(path => path !== '.ntn-skills.json').sort());
    for (const file of listing.files) assert.equal(allFiles.get(file.path).length, file.bytes);
    assert.ok(allFiles.get(record.entrypoint)?.equals(Buffer.from(read.content)), 'Public read and exported complete main bytes differ');
    assert.ok(!read.content.includes('</prompt-task>') && !read.content.includes('<context-broker-record '), 'Owned oracle text cannot contain ambiguous verifier wrapper delimiters');
    const oracle = { record, scope: read.scope, snapshotId: read.snapshot_id, versionId: read.version_id, ref: read.ref,
      body: read.content, bodySha256: hash(read.content), escapedBodySha256: hash(escapeText(read.content)),
      selection: `${record.alias}@${record.locator.page_id.replaceAll('-', '')}@notion`,
      origin: 'fresh public read plus complete fixed snapshot export; consumption oracle only',
      files: exported.files.map(({ path, bytes, hash }) => ({ path, bytes, hash })) };
    fixtures[kind] = oracle;
    for (const [name, value] of [['read.json', read], ['files.json', listing], ['export.json', exported], ['oracle.json', oracle]]) {
      await save(join(folder, name), value);
      files.push(`native-kinds-oracles/${kind}/${name}`);
    }
    files.push(...[...allFiles.keys()].map(path => `native-kinds-oracles/${kind}/export/${path}`));
  }
  assert.equal(new Set(kinds.map(kind => fixtures[kind].record.id)).size, 3);
  assert.equal(new Set(kinds.map(kind => fixtures[kind].record.locator.page_id)).size, 3);
  assert.ok(fixtures.router.body.includes(fixtures.skill.record.ref), 'The configured Skill must be a public member reference in this Router');
  assert.ok(!fixtures.router.body.includes(fixtures.skill.body), 'The Router oracle must not already embed its member full body');
  return { fixtures, files, live: { scope: listed.scope, recipe: 'native-kinds', oracle: 'fresh-read-and-fixed-export', records: kinds.map(kind => ({ kind, id: fixtures[kind].record.id, snapshotId: fixtures[kind].snapshotId, bodySha256: fixtures[kind].bodySha256 })) } };
}

/** Inspect the actual provider payload, separating this user submission from history. */
export function inspectNativeKindsContext(context, fixtures, { marker, prompt, persistent }) {
  assert.ok(Array.isArray(context.messages));
  const messages = context.messages, texts = messages.map(textOf);
  const users = messages.filter(message => message.role === 'user' && textOf(message).includes(marker));
  assert.equal(users.length, 1, 'The current submission marker must identify one provider user message');
  const current = textOf(users[0]);
  // The driver creates a fresh marker immediately before this provider request.
  // Hosts may convert injected custom context into later role=user messages;
  // their ordering cannot replace the exact submitted marker as turn identity.
  const tasks = [...current.matchAll(/<prompt-task\b([^>]*)>\n([\s\S]*?)\n<\/prompt-task>/g)];
  assert.equal(tasks.length, prompt ? 1 : 0, 'Prompt expansion must occur exactly once in this submission');
  let invocation;
  if (prompt) {
    const task = tasks[0], fixture = fixtures.prompt;
    assert.equal(attr(task[1], 'identity'), identity(fixture));
    assert.equal(attr(task[1], 'snapshot'), fixture.snapshotId);
    assert.equal(attr(task[1], 'version'), fixture.versionId);
    assert.equal(hash(task[2]), fixture.bodySha256, 'Prompt task differs from the complete frozen public body');
    invocation = attr(task[1], 'invocation');
    assert.ok(invocation && attr(task[1], 'session'), 'Prompt task requires a real invocation and session identity');
    assert.match(attr(task[1], 'generation'), /^\d+$/);
  }
  const blocks = texts.flatMap(text => [...text.matchAll(/<context-broker-record\b([^>]*)>([\s\S]*?)<\/context-broker-record>/g)]);
  const counts = {};
  for (const kind of kinds) {
    const fixture = fixtures[kind];
    const selected = blocks.filter(block => attr(block[1], 'kind') === kind);
    counts[kind] = selected.length;
    assert.equal(selected.length, persistent.includes(kind) ? 1 : 0, 'Only selected Skill/Router bodies may enter persistent provider context');
    for (const block of selected) {
      assert.ok(block[2].includes(`<skill-ref>${escapeText(fixture.ref)}</skill-ref>`));
      assert.ok(block[2].includes(`<snapshot-id>${fixture.snapshotId}</snapshot-id>`));
      const body = /<body>\n([\s\S]*?)\n<\/body>/.exec(block[2]);
      assert.ok(body, 'A loaded record must contain its complete body');
      assert.equal(hash(body[1]), fixture.escapedBodySha256, 'Loaded body differs from the public read/export oracle');
    }
    if (persistent.includes(kind)) {
      const alternatives = [...new Set([fixture.body, escapeText(fixture.body)])].sort((a, b) => b.length - a.length).map(regexText);
      const copies = texts.reduce((total, text) => total + [...text.matchAll(new RegExp(alternatives.join('|'), 'g'))].length, 0);
      assert.equal(copies, 1, 'The complete selected body must occur exactly once across all provider messages, including unwrapped copies');
    }
    if (kind !== 'prompt' && !persistent.includes(kind))
      assert.ok(texts.every(text => !text.includes(fixture.body) && !text.includes(escapeText(fixture.body))), 'An unselected member body leaked through another provider message');
  }
  return { invocation, counts, currentPromptTasks: tasks.length };
}

/** Loaded facts come from native AgentMessages, not converted provider messages. */
export function inspectNativeKindsReceipts(messages, fixtures, persistent) {
  assert.ok(Array.isArray(messages));
  const records = messages.flatMap(message => ['context-broker', 'skill-prompt-message'].includes(message.customType)
    ? Array.isArray(message.details?.records) ? message.details.records : message.details ? [message.details] : [] : []);
  assert.ok(records.every(record => record.kind !== 'prompt' && record.recordId !== fixtures.prompt.record.id), 'Prompt must never masquerade as a persistently loaded Skill');
  const counts = {};
  for (const kind of ['skill', 'router']) {
    const fixture = fixtures[kind], selected = records.filter(record => record.recordId === fixture.record.id || record.kind === kind);
    assert.equal(selected.length, persistent.includes(kind) ? 1 : 0, 'Persistent receipt set differs from the explicit selection');
    counts[kind] = selected.length;
    for (const record of selected) {
      assert.equal(record.loaded, true);
      assert.equal(record.kind, kind);
      assert.equal(record.sourceId, 'notion');
      assert.equal(record.recordId, fixture.record.id);
      assert.equal(record.identity, identity(fixture));
      assert.equal(record.snapshotId, fixture.snapshotId);
      assert.equal(record.versionId, fixture.versionId);
    }
  }
  return counts;
}

export async function runNativeKinds({ host, scratch, evidence, fixture, extension, database, command }) {
  const { isolatedEnv, writeFakeProvider } = await import('../packages/context-broker/scripts/context-broker-e2e-fixture.mjs');
  const { startRpc } = await import('../packages/context-broker/scripts/context-broker-rpc-harness.mjs');
  const base = join(scratch, host + '-native-kinds'), agentDir = join(base, 'agent');
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const config = join(base, 'broker.json');
  await save(config, { sources: [{ id: 'notion', namespace: 'notion', type: 'notion', command, database, cacheDir: join(base, 'source-cache'), requestTimeoutMs: 60000 }] });
  const provider = await writeFakeProvider(base);
  const env = isolatedEnv({ base, agentDir, HOME: process.env.HOME, CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_HOST: host,
    CONTEXT_BROKER_LOG_FILE: join(evidence, host + '-native-kinds-decisions.jsonl') });
  await writeFile(env.CONTEXT_BROKER_LOG_FILE, '', { mode: 0o600 });
  for (const key of ['NOTION_API_TOKEN', 'NTN_API_TOKEN']) if (process.env[key]) env[key] = process.env[key];
  delete env.NTN_SKILLS_NTN_BIN;
  const result = { host, mode: 'live', recipe: 'native-kinds', status: 'running', provider: 'controlled', realModel: false,
    files: [host + '-native-kinds-result.json', host + '-native-kinds-decisions.jsonl'], observations: [],
    boundary: 'Actual host RPC and existing native Notion fixtures with explicit extension/CLI identities frozen in the parent manifest; provider output is controlled. Fresh read/export defines consumption bytes, not an authoring expectation.',
    sourceRequestEvidence: { file: 'safe-source-requests.jsonl', unit: 'CLI invocations', remoteRequests: 'not aggregated; see retained public request_metrics' },
    notRun: ['image payload submission through native RPC', 'native composer Stop while extension preparation is pending', 'real model choice or instruction following'] };
  const invocations = new Set();
  let rpc;
  try {
    for (const recipe of ['prompt', 'router', 'mixed']) {
      const sessions = join(base, recipe, 'sessions');
      await mkdir(sessions, { recursive: true, mode: 0o700 });
      const providerName = `${host}-native-kinds-${recipe}-provider.jsonl`, providerPath = join(evidence, providerName);
      await writeFile(providerPath, '', { mode: 0o600 });
      result.files.push(providerName);
      const args = ['--no-extensions', '--no-skills', '--session-dir', sessions, '--no-tools', '-e', provider, '-e', extension, '--model', 'context-broker-e2e/fake'];
      if (host === 'omp') args.push('--no-ui', '--no-title', '--no-rules');
      else args.push('--no-mcp', '--no-context-files', '--no-prompt-templates');
      const boot = continued => startRpc({ host, cwd: base, env: { ...env, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerPath }, args: [...args, ...(continued ? ['--continue'] : [])] });
      rpc = await boot(false);
      const turn = async (label, selected, persistent, prompt) => {
        const marker = `NATIVE_KINDS_${host}_${recipe}_${label}`, before = (await rows(providerPath)).length;
        await rpc.prompt(selected.map(kind => '$' + fixture.fixtures[kind].selection).join(' ') + ' ' + marker + ' Apply only the explicitly selected instructions.');
        const captures = await rows(providerPath);
        assert.equal(captures.length, before + 1, 'One controlled provider call must complete this submission');
        const observed = inspectNativeKindsContext(captures.at(-1).context, fixture.fixtures, { marker, prompt, persistent });
        if (observed.invocation) {
          assert.equal(invocations.has(observed.invocation), false, 'Every Prompt submission needs a new invocation');
          invocations.add(observed.invocation);
        }
        const messages = (await rpc.command('get_messages')).messages;
        const receipts = inspectNativeKindsReceipts(messages, fixture.fixtures, persistent);
        const name = `${host}-native-kinds-${recipe}-${label}-messages.json`;
        await save(join(evidence, name), messages);
        result.files.push(name);
        result.observations.push({ recipe, label, marker, ...observed, receipts, providerRequests: captures.length });
      };
      if (recipe === 'prompt') {
        await turn('first', ['prompt'], [], true);
        await turn('second', ['prompt'], [], true);
      } else if (recipe === 'router') {
        await turn('index', ['router'], ['router'], false);
        await turn('member', ['skill'], ['router', 'skill'], false);
      } else {
        await turn('first', kinds, ['skill', 'router'], true);
        await turn('second', kinds, ['skill', 'router'], true);
        const original = (await rpc.command('get_state')).sessionFile;
        assert.ok(typeof original === 'string' && isAbsolute(original), 'Resume must identify the exact persisted native session');
        const framesName = `${host}-native-kinds-mixed-before-resume-rpc.json`;
        await save(join(evidence, framesName), rpc.frames);
        result.files.push(framesName);
        await rpc.stop(); rpc = undefined;
        rpc = await boot(true);
        assert.equal((await rpc.command('get_state')).sessionFile, original, 'Continue resumed another native session');
        const beforeResume = (await rpc.command('get_messages')).messages;
        assert.ok(beforeResume.some(message => textOf(message).includes(`NATIVE_KINDS_${host}_mixed_first`)));
        assert.ok(beforeResume.some(message => textOf(message).includes(`NATIVE_KINDS_${host}_mixed_second`)));
        inspectNativeKindsReceipts(beforeResume, fixture.fixtures, ['skill', 'router']);
        await turn('resumed', kinds, ['skill', 'router'], true);
      }
      const rpcName = `${host}-native-kinds-${recipe}-rpc.json`;
      await save(join(evidence, rpcName), rpc.frames);
      result.files.push(rpcName);
      await rpc.stop(); rpc = undefined;
    }
    assert.equal(result.observations.length, 7);
    result.providerRequests = result.observations.length;
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
    if (rpc) {
      const name = `${host}-native-kinds-failed-rpc.json`;
      await save(join(evidence, name), rpc.frames);
      result.files.push(name);
    }
  } finally {
    if (rpc) try { await rpc.stop(); } catch (error) { result.status = 'failed'; result.error ??= error.message; }
    await save(join(evidence, result.files[0]), result);
  }
  if (result.status !== 'passed') throw Object.assign(new Error(`${host} native kinds verification failed: ${result.error}`), { results: [result] });
  return result;
}
