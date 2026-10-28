import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';

const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const inside = (parent, child) => { const path = relative(parent, child); return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); };

// Executed only by the inherited, authorized Pi or OMP host. Provider and source
// bodies stay in memory; evidence retains metadata and sanitized assistant text.
function observe(api, settings) {
  const { appendFileSync, readFileSync, readdirSync, realpathSync, statSync } = settings.fs;
  const { createHash } = settings.crypto;
  const { isAbsolute, join, relative, resolve, sep } = settings.path;
  const { model, provider, id, marker, alias, selected, cache, output } = settings;
  const record = value => appendFileSync(output, JSON.stringify(value) + '\n', { mode: 0o600 });
  const normalize = text => text.replace(/^\s*\d+[:|]\s?/gm, '').replace(/\s+/g, ' ').trim();
  const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  const occurrences = (value, needle) => {
    const target = normalize(needle);
    return target ? strings(value).reduce((sum, text) => sum + normalize(text).split(target).length - 1, 0) : 0;
  };
  const within = (parent, child) => { const path = relative(parent, child); return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); };
  const secretValues = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/i.test(key) && typeof value === 'string' && value.length >= 4).map(([, value]) => value);
  const sanitize = text => {
    let result = String(text);
    for (const value of secretValues) result = result.split(value).join('[redacted]');
    return result.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"')\]]+/gi, '[url withheld]')
      .replace(/\b(?:Bearer|Basic)\s+[a-z0-9+/._=-]+/gi, '[authorization withheld]')
      .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|authorization|cookie)\s*[:=]\s*)[^\n,;]+/gi, '$1[redacted]')
      .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/g, '[credential withheld]');
  };
  const wireAllowed = value => value === id || value === model;
  const assertModel = ctx => {
    if (ctx.model?.provider !== provider || ctx.model?.id !== id) throw new Error('Notion model route rejected unauthorized model');
    if (ctx.model.compactionModel && !wireAllowed(ctx.model.compactionModel)) throw new Error('Notion model route rejected unauthorized compaction model');
  };
  const resources = new Map();
  const advertisedEntries = new Set();
  const calls = new Map();
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const digest = /^[0-9a-f]{64}$/;
  const snapshotId = /^s_[0-9a-f]{64}$/;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const portable = path => typeof path === 'string' && path.length > 0 && !path.includes('\0') && !path.includes('\\') && !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
  const keys = (value, expected) => object(value) && Object.keys(value).sort().join('|') === expected.split(' ').sort().join('|');
  const allowedNames = new Set([alias, ('notion/' + alias).replace(/[^a-z0-9-]/g, '-'), ('notion/' + alias + '@' + selected.selector.replaceAll('-', '')).replace(/[^a-z0-9-]/g, '-'), selected.selector]);
  let activeSnapshot;
  let activeScope;
  const sourceCache = cache;
  const exportedFiles = () => {
    const exports = [];
    const validate = directory => {
      try {
        directory = realpathSync(directory);
        if (!within(cache, directory)) return;
        const receiptPath = join(directory, '.broker-snapshot.json');
        if (realpathSync(receiptPath) !== receiptPath) return;
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        if (!keys(receipt, 'version projection scope record snapshot notionVersion contentId entry files') || receipt.version !== 3 || receipt.projection !== 'snapshot' || !digest.test(receipt.scope) || !snapshotId.test(receipt.snapshot) || typeof receipt.notionVersion !== 'string' || !receipt.notionVersion || receipt.notionVersion.includes('\0') || !digest.test(receipt.contentId)) return;
        const record = receipt.record;
        if (!keys(record, 'id kind locator name alias description default_context entrypoint ref') || !object(record.locator)) return;
        const locator = record.locator;
        const subscription = locator.type === 'notion_subscription';
        if (!keys(locator, subscription ? 'type subscription_id database_id data_source_id target_database_id' : 'type page_id database_id data_source_id')) return;
        const identity = subscription ? locator.subscription_id : locator.page_id;
        if (!['notion_page', 'notion_subscription'].includes(locator.type) || !uuid.test(identity) || !uuid.test(locator.database_id) || !uuid.test(locator.data_source_id) || (subscription && (!uuid.test(locator.target_database_id) || record.kind !== 'router'))) return;
        if (record.id !== locator.type + ':' + identity || record.id !== selected.id || record.kind !== selected.kind || record.entrypoint !== selected.entry || record.ref !== selected.ref || record.alias !== alias || typeof record.name !== 'string' || !/\S/u.test(record.name) || typeof record.description !== 'string' || typeof record.default_context !== 'boolean') return;
        if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(record.name) || Object.values(record).some(value => typeof value === 'string' && value.includes('\0'))) return;
        const expectedDirectory = join(sourceCache, 'scopes', receipt.scope, 'records', hash(record.id), 'snapshots', receipt.snapshot);
        if (directory !== expectedDirectory || realpathSync(expectedDirectory) !== expectedDirectory || receipt.entry !== record.entrypoint || !Array.isArray(receipt.files)) return;
        const files = new Map();
        for (const item of receipt.files) {
          if (!keys(item, 'path bytes hash') || !portable(item.path) || item.path === '.broker-snapshot.json' || files.has(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !digest.test(item.hash)) return;
          const path = join(directory, item.path);
          if (realpathSync(path) !== path || !within(directory, path) || !statSync(path).isFile()) return;
          const bytes = readFileSync(path);
          if (bytes.length !== item.bytes || hash(bytes) !== item.hash) return;
          files.set(item.path, { path, bytes });
        }
        if (!files.has(receipt.entry) || !files.has('.ntn-skills.json')) return;
        const inventory = dir => readdirSync(dir, { withFileTypes: true }).every(entry => {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) return inventory(path);
          return entry.isFile() && (path === receiptPath || files.has(relative(directory, path).split(sep).join('/')));
        });
        if (!inventory(directory)) return;
        exports.push({ directory, receipt, files });
      } catch {}
    };
    const walk = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name === '.broker-snapshot.json') validate(directory);
      }
    };
    walk(cache);
    return exports;
  };
  const targetFor = (exported, entry) => {
    const file = exported.files.get(entry);
    if (!file) return undefined;
    const role = entry === exported.receipt.entry ? 'entrypoint' : entry === '.ntn-skills.json' ? 'manifest' : entry === 'ntn-skills-source.zip' ? 'source_bundle' : 'resource';
    return { kind: role === 'entrypoint' ? 'skill' : role === 'manifest' ? 'metadata' : role === 'source_bundle' ? 'source-bundle' : 'resource', role, path: file.path, snapshot: exported.receipt.snapshot, scope: exported.receipt.scope, recordId: exported.receipt.record.id, entry, fileBody: file.bytes.toString('utf8') };
  };
  const receiptFor = input => {
    if (typeof input !== 'string') return undefined;
    const path = input.replace(/:(?:raw(?::.*)?|img|\d.*|-[0-9].*)$/, '');
    if (/^skill:\/\//.test(path)) {
      const match = /^skill:\/\/([^/?#:]+)(.*)$/.exec(path);
      if (!match || path.includes('#')) return undefined;
      let target;
      let reference;
      try {
        target = decodeURIComponent(match[1]);
        if (match[2] && !/^[/?]/.test(match[2])) return undefined;
        reference = match[2].replace(/^\//, '').split('?');
        if (reference.length > 2) return undefined;
        reference[0] = decodeURIComponent(reference[0]);
        if (reference[1] !== undefined) decodeURIComponent(reference[1]);
      } catch { return undefined; }
      if (!allowedNames.has(target) || /[/?#:]/.test(target.replace(/^upstream:/, ''))) return undefined;
      const entry = reference[0] || selected.entry;
      if (!portable(entry) || /[:?#]/.test(entry) || entry === '.broker-snapshot.json') return undefined;
      const query = new URLSearchParams(reference[1]);
      if ([...query.keys()].some(key => key !== 'snapshot') || query.getAll('snapshot').length > 1) return undefined;
      const snapshot = query.get('snapshot');
      if (snapshot !== null && (!snapshotId.test(snapshot) || (activeSnapshot && snapshot !== activeSnapshot))) return undefined;
      const candidates = exportedFiles().filter(item => (!snapshot || item.receipt.snapshot === snapshot) && (!activeSnapshot || item.receipt.snapshot === activeSnapshot) && (!activeScope || item.receipt.scope === activeScope));
      if (candidates.length === 1) return targetFor(candidates[0], entry);
      return !snapshot && entry === selected.entry && candidates.length === 0 ? { kind: 'skill-uri', path } : undefined;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
    const absolute = resolve(settings.cwd, path);
    let file;
    try { file = realpathSync(absolute); } catch { return undefined; }
    // Default metadata is owned by the live host, outside the source export cache.
    // An advertised path permits only this read; success still requires canonical
    // snapshot receipt verification and complete returned-byte equality below.
    if (advertisedEntries.has(absolute) && statSync(file).isFile()) return { kind: 'metadata', role: 'index', path: absolute, recordId: selected.id };
    if (file !== absolute || !within(cache, file) || !statSync(file).isFile()) return undefined;
    for (const exported of exportedFiles()) {
      if (within(exported.directory, file) && (!activeSnapshot || exported.receipt.snapshot === activeSnapshot) && (!activeScope || exported.receipt.scope === activeScope)) return targetFor(exported, relative(exported.directory, file).split(sep).join('/'));
    }
    // Metadata stubs are the default catalog's read entry before activation.
    const index = relative(sourceCache, file).split(sep);
    if (index.length === 6 && index[0] === 'scopes' && digest.test(index[1]) && index[2] === 'indexes' && uuid.test(index[3]) && index[4] === hash(selected.id) && index[5] === selected.entry && (!activeScope || index[1] === activeScope)) return { kind: 'metadata', role: 'index', path: file, scope: index[1], recordId: selected.id };
    return undefined;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    let body;
    try { if (typeof raw === 'string') body = JSON.parse(raw); } catch {}
    if (body && typeof body.model === 'string') {
      if (!wireAllowed(body.model)) throw new Error('Notion model route rejected unauthorized transport model');
      record({ phase: 'transport', model, wireModel: body.model, skillBodies: occurrences(body, marker) });
    }
    return originalFetch.call(this, input, init);
  };
  api.on('session_start', async (_event, ctx) => {
    assertModel(ctx);
    await api.setActiveTools(['read']);
    record({ phase: 'selected', model, tools: ['read'] });
  });
  api.on('before_agent_start', (event, ctx) => {
    assertModel(ctx);
    for (const entry of strings(event.systemPrompt).join('\n').matchAll(/<skill>[\s\S]*?<\/skill>/g)) {
      const name = /<name>\s*([^<]+)\s*<\/name>/.exec(entry[0])?.[1]?.trim();
      const location = /<location>\s*([^<]+)\s*<\/location>/.exec(entry[0])?.[1]?.trim();
      if (name && allowedNames.has(name) && location) advertisedEntries.add(resolve(settings.cwd, location.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')));
    }
    record({ phase: 'metadata', model, aliases: occurrences(event.systemPrompt, alias), skillBodies: occurrences(event.systemPrompt, marker), advertisedEntries: advertisedEntries.size, catalogLocations: strings(event.systemPrompt).join('\n').match(/<location>/g)?.length ?? 0 });
  });
  api.on('context', (event, ctx) => {
    assertModel(ctx);
    record({ phase: 'context', model, skillBodies: occurrences(event.messages, marker), resourceBodies: [...resources.values()].reduce((sum, body) => sum + occurrences(event.messages, body), 0) });
  });
  api.on('before_provider_request', (event, ctx) => {
    assertModel(ctx);
    const wireModel = event.payload?.model;
    if (wireModel !== undefined && !wireAllowed(wireModel)) throw new Error('Notion model route rejected unauthorized provider model');
    record({ phase: 'request', model, wireModel: wireModel ?? null, aliases: occurrences(event.payload, alias), skillBodies: occurrences(event.payload, marker), resourceBodies: [...resources.values()].reduce((sum, body) => sum + occurrences(event.payload, body), 0) });
  });
  api.on('after_provider_response', event => record({ phase: 'response', status: typeof event.status === 'number' ? event.status : null }));
  api.on('message_end', event => {
    const message = event.message;
    if (message?.role !== 'assistant') return;
    const text = (message.content ?? []).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n');
    if (!text.trim()) return;
    record({ phase: 'assistant_final', success: ['stop', 'length'].includes(message.stopReason), stopReason: message.stopReason ?? null, bytes: Buffer.byteLength(text), textSha256: createHash('sha256').update(text).digest('hex'), text: sanitize(text) });
  });
  api.on('tool_call', event => {
    if (event.toolName !== 'read') return { block: true, reason: 'Notion model route permits only read' };
    const target = receiptFor(event.input?.path);
    if (!target) {
      record({ phase: 'tool_call', tool: 'read', allowed: false, path: sanitize(event.input?.path ?? '') });
      return { block: true, reason: 'Read only the available Notion skill and its exported resources' };
    }
    calls.set(event.toolCallId, target);
    record({ phase: 'tool_call', tool: 'read', path: sanitize(target.path), kind: target.kind, role: target.role ?? null, allowed: true });
  });
  api.on('tool_result', event => {
    if (event.toolName !== 'read') return;
    const previous = calls.get(event.toolCallId);
    calls.delete(event.toolCallId);
    const validated = receiptFor(event.input?.path);
    let target = validated ?? (previous && { ...previous, fileBody: undefined });
    if (!target) return;
    const body = (event.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
    const skillBodies = occurrences(body, marker);
    if (validated?.role === 'index' && !event.isError && skillBodies > 0) {
      const candidates = exportedFiles().filter(item => (validated.scope === undefined || item.receipt.scope === validated.scope) && (!activeScope || item.receipt.scope === activeScope) && (!activeSnapshot || item.receipt.snapshot === activeSnapshot));
      if (candidates.length === 1) target = { ...targetFor(candidates[0], selected.entry), requestedRole: 'index' };
    }
    const bodyMatchesFile = Boolean(target.fileBody?.trim()) && occurrences(body, target.fileBody) > 0;
    const resourceSuccess = target.kind === 'resource' && !event.isError && bodyMatchesFile;
    if (!event.isError && target.kind === 'skill' && bodyMatchesFile) {
      activeSnapshot = target.snapshot;
      activeScope = target.scope;
    }
    if (resourceSuccess) resources.set(target.path, target.fileBody);
    record({ phase: 'tool_result', tool: 'read', path: sanitize(target.path), kind: target.kind, role: target.role ?? null, requestedRole: target.requestedRole ?? null, recordId: target.recordId ?? null, scope: target.scope ?? null, entry: target.entry ?? null, snapshot: target.snapshot ?? null, receiptValidated: Boolean(validated), isError: Boolean(event.isError), skillBodies, bodyMatchesFile, resourceSuccess, bytes: Buffer.byteLength(body), bodySha256: createHash('sha256').update(body).digest('hex') });
  });
}

async function runHostModel(host, { root, scratch, evidence, fixture, options, extension }) {
  assert.ok(typeof options.model === 'string' && /^[^/\s]+\/[^\s]+$/.test(options.model), 'Model mode requires an explicit authorized provider/model');
  const slash = options.model.indexOf('/');
  const provider = options.model.slice(0, slash);
  const id = options.model.slice(slash + 1);
  const prompt = options['model-prompt'];
  assert.ok(typeof prompt === 'string' && prompt.trim(), 'Model mode requires a natural task prompt');
  assert.ok(!/\$|\/skill:|skill:\/\/|\b(?:ntn-skills|notion-skills|command-json|api[_ -]?key|access[_ -]?token|bearer)\b/i.test(prompt), 'Model prompt must not contain invocation tokens, CLI names or credential hints');
  assert.ok(options.database && fixture.command?.length && fixture.alias && fixture.marker && fixture.skillRef?.startsWith('skill://'), 'Model mode requires a complete live Notion fixture');
  const temporaryRoot = await realpath(tmpdir());
  assert.ok(inside(temporaryRoot, await realpath(scratch)), 'Broker model scratch must be under the system temporary directory');
  const base = join(scratch, `${host}-real-model`);
  const sessions = join(base, 'sessions');
  const cache = join(base, 'source-cache');
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const config = join(base, 'broker.json');
  const overlay = join(base, 'host-overlay.yml');
  const observer = join(base, 'observe-model.mjs');
  const files = [`${host}-real-model-observer.jsonl`, `${host}-real-model-result.json`];
  const capture = join(evidence, files[0]);
  await writeFile(capture, '', { mode: 0o600 });
  const reference = /^skill:\/\/([^/?#:]+)\/(SKILL|ROUTER|PROMPT)\.md$/.exec(fixture.skillRef);
  assert.ok(reference, 'Model mode requires a canonical current ContentRecord reference');
  const selector = decodeURIComponent(reference[1]);
  const subscription = selector.startsWith('upstream:');
  const identity = subscription ? selector.slice('upstream:'.length) : selector;
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identity) && (!subscription || reference[2] === 'ROUTER'), 'Model mode requires a canonical ContentRecord locator');
  const selected = { selector, id: (subscription ? 'notion_subscription:' : 'notion_page:') + identity, kind: reference[2].toLowerCase(), entry: reference[2] + '.md', ref: 'skill://' + encodeURIComponent(selector) + '/' + reference[2] + '.md' };
  assert.equal(fixture.skillRef, selected.ref, 'Model mode requires the canonical ContentRecord reference');
  await save(config, { sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command: fixture.command, database: options.database, ...(options.view ? { default_view_id: options.view } : {}), cacheDir: cache, requestTimeoutMs: 30000 }] });
  if (host === 'omp') await writeFile(overlay, 'startup:\n  setupWizard: false\n  checkUpdate: false\ncompaction:\n  enabled: false\n', { mode: 0o600 });
  const settings = { model: options.model, provider, id, marker: fixture.marker, alias: fixture.alias, selected, cache: await realpath(cache), cwd: base, output: capture };
  await writeFile(observer, `import * as fs from 'node:fs';\nimport * as crypto from 'node:crypto';\nimport * as path from 'node:path';\nexport default function(api) { (${observe.toString()})(api, {...${JSON.stringify(settings)}, fs, crypto, path}); }\n`, { mode: 0o600 });
  const boundary = {
    modelConfiguration: `Existing inherited ${host} agentDir/HOME configuration and credentials are consumed in place by the host; the runner does not read or copy credential files.`,
    brokerConfiguration: `Explicit temporary CONTEXT_BROKER_CONFIG; temporary source cache and session directory${host === 'omp' ? ', plus an OMP host overlay' : ''}; no global configuration writes by the runner.`,
    evidence: 'Provider model selectors and metadata/body counts, sanitized selected-source read paths and assistant text, identity, roles, byte counts and hashes; no source bodies, raw provider payload, RPC frames, headers, URLs or credentials.',
  };
  const result = { host, mode: 'model', model: options.model, files, boundary, observations: [], status: 'running' };
  let rpc;
  try {
    const args = ['--no-extensions', '--session-dir', sessions, '--tools', 'read', '-e', extension ?? join(root, 'packages/context-broker/src/index.ts'), '-e', observer, '--model', options.model];
    if (host === 'omp') args.push('--no-ui', '--no-rules', '--no-title', '--config', overlay, '--smol', options.model, '--slow', options.model, '--plan', options.model);
    else args.push('--no-mcp', '--no-context-files', '--no-prompt-templates');
    rpc = await startRpc({ host, cwd: base, env: { ...process.env, CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_HOST: host, CONTEXT_BROKER_LOG_FILE: join(base, 'broker-decisions.jsonl') }, args });
    await rpc.prompt(prompt);
    const rows = (await readFile(capture, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const requests = rows.filter(row => row.phase === 'request');
    const metadata = rows.find(row => row.phase === 'metadata');
    const skillReads = rows.filter(row => row.phase === 'tool_result' && !row.isError && row.skillBodies > 0 && row.kind === 'skill' && row.role === 'entrypoint' && row.receiptValidated && row.bodyMatchesFile);
    const resourceReads = rows.filter(row => row.phase === 'tool_result' && row.resourceSuccess);
    assert.ok(rows.some(row => row.phase === 'selected' && row.model === options.model), `${host} must select the explicitly authorized model`);
    assert.ok(requests.length > 0 && rows.some(row => row.phase === 'response' && row.status >= 200 && row.status < 300), 'A real authorized provider request and successful response must be observed');
    assert.ok(metadata?.aliases > 0 && metadata.skillBodies === 0, 'Default host catalog must advertise the selected skill without its full body');
    assert.ok(rows.some(row => row.phase === 'tool_call' && row.allowed), 'The model must choose a native read tool call');
    assert.ok(skillReads.length > 0, 'The model must actually read the selected Notion skill body');
    assert.ok(resourceReads.length > 0, 'The model must successfully read an exported resource from the selected Notion snapshot');
    assert.ok(requests.some(row => row.skillBodies > 0), 'The provider must consume the actual selected skill body');
    assert.ok(requests.some(row => row.resourceBodies > 0), 'The provider must consume the successfully read resource body');
    assert.ok(rows.some(row => row.phase === 'assistant_final' && row.success && row.bytes > 0), 'The model must produce a nonempty successful final assistant reply');
    Object.assign(result, { status: 'passed', observations: [`real authorized ${host} provider`, 'metadata-only default skill catalog', 'model-selected native read activation', 'successful exported resource read', 'skill and resource bodies consumed by provider', 'nonempty successful final assistant reply'], providerRequests: requests.length, transportRequests: rows.filter(row => row.phase === 'transport').length, skillReads: skillReads.length, resourceReads: resourceReads.length });
  } catch (error) {
    result.status = 'failed';
    // RPC diagnostics can contain provider URLs or secrets stored in host config.
    result.error = error?.code === 'ERR_ASSERTION' ? error.message : `Authorized ${host} model observation did not complete; raw host diagnostics withheld`;
  } finally {
    if (rpc) {
      try { await rpc.stop(); } catch { result.status = 'failed'; result.error ??= `${host} model RPC shutdown failed; raw host diagnostics withheld`; }
    }
    await save(join(evidence, files[1]), result);
  }
  return result;
}

export async function runNotionModel(context) {
  const selected = context.options.host;
  assert.ok(selected === undefined || ['pi', 'omp'].includes(selected), '--host must be pi or omp');
  const results = [];
  for (const host of selected ? [selected] : ['pi', 'omp']) results.push(await runHostModel(host, context));
  const failures = results.filter(result => result.status === 'failed');
  if (failures.length) {
    const error = new Error(`Notion model verification failed: ${failures.map(result => `${result.host}: ${result.error}; see ${result.files[1]}`).join('; ')}`);
    error.results = results;
    throw error;
  }
  return results;
}
