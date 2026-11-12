import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { database as fixtureDatabase, unflaggedAlias, unflaggedCanary, missingAlias, missingCanary } from './notion-integration-fixture.mjs';
import { decodeCatalogText, measuredConsumptionArgs, projectedResourceRef } from './notion-integration-hosts.mjs';

const helper = fileURLToPath(import.meta.url);
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async path => { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const count = (value, marker) => JSON.stringify(value).split(marker).length - 1;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Only argument arrays are executed. The HTTP ledger consumes the engine's bounded
// metadata, never raw paths, payloads, environment, stdin or diagnostic stderr.
export function safeRequestMetrics(value) {
  if (!value || value.trace_enabled !== true || !Array.isArray(value.trace) || value.trace.length > 10000 ||
      !Number.isSafeInteger(value.total_requests) || value.total_requests < 0 ||
      !Number.isSafeInteger(value.trace_dropped) || value.trace_dropped < 0) return undefined;
  const finite = number => typeof number === 'number' && Number.isFinite(number) && number >= 0;
  const nullableNumber = number => number === null || finite(number);
  const safeLabel = label => label === null || typeof label === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(label);
  const safeTarget = value => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) return undefined;
    const uuid = id => typeof id === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id);
    const keys = Object.keys(value);
    for (const field of ['page_id', 'block_id']) if (keys.length === 1 && uuid(value[field])) return { [field]: value[field] };
    if (uuid(value.data_source_id) && keys.every(key => ['data_source_id', 'entity_ids'].includes(key))) {
      if (value.entity_ids === undefined) return { data_source_id: value.data_source_id };
      if (Array.isArray(value.entity_ids) && value.entity_ids.length > 0 && value.entity_ids.length <= 100 &&
          value.entity_ids.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) &&
          new Set(value.entity_ids).size === value.entity_ids.length)
        return { data_source_id: value.data_source_id, entity_ids: [...value.entity_ids] };
    }
    return undefined;
  };
  const trace = [];
  for (const event of value.trace) {
    if (!event || typeof event !== 'object') return undefined;
    if (event.event === 'wait' && ['queue', 'retry'].includes(event.kind) && finite(event.milliseconds)) {
      trace.push({ event: 'wait', kind: event.kind, milliseconds: event.milliseconds });
    } else if (event.event === 'attempt' && Number.isSafeInteger(event.attempt) && event.attempt > 0 &&
        ['notion_metadata', 'notion_body', 'notion_write', 'provider'].includes(event.kind) &&
        ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'].includes(event.method) &&
        ['success', 'failure', 'cancelled'].includes(event.outcome) && finite(event.started_ms) && finite(event.duration_ms) &&
        [event.request_bytes, event.response_bytes, event.http_status, event.retry_after_seconds].every(nullableNumber) &&
        [event.request_id, event.rate_limit_reason].every(safeLabel)) {
      const target = safeTarget(event.target);
      if (target === undefined || event.kind === 'provider' && target !== null) return undefined;
      trace.push({ event: 'attempt', attempt: event.attempt, request_kind: event.kind, method: event.method, target,
        body_kind: ['current_body', 'retained_body', 'unclassified_body'].includes(event.body_kind) ? event.body_kind : null,
        started_ms: event.started_ms, duration_ms: event.duration_ms, outcome: event.outcome,
        request_bytes: event.request_bytes, response_bytes: event.response_bytes, http_status: event.http_status,
        request_id: event.request_id, rate_limit_reason: event.rate_limit_reason, retry_after_seconds: event.retry_after_seconds });
    } else return undefined;
  }
  const attempts = trace.filter(event => event.event === 'attempt');
  const complete = value.trace_dropped === 0 && attempts.length === value.total_requests &&
    new Set(attempts.map(event => event.attempt)).size === value.total_requests &&
    attempts.every(event => event.attempt <= value.total_requests);
  return { trace, complete, total_requests: value.total_requests, trace_dropped: value.trace_dropped };
}
export async function runLedger(configPath, args) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const requestId = `${process.pid}-${Date.now()}`;
  const safe = { kind: 'cli', command: args[0], ref: args[1]?.startsWith('skill://') || args[1]?.startsWith('s_') ? args[1] : null, policy: args.includes('--refresh') ? 'refresh' : args.includes('--max-age') ? args[args.indexOf('--max-age') + 1] : 'default' };
  const log = (phase, details = {}) => appendFile(config.ledger, JSON.stringify({ ...safe, requestId, pid: process.pid, phase, ...details, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  await log('started');
  const measured = measuredConsumptionArgs(args);
  const child = spawn(config.command[0], [...config.command.slice(1), ...measured], { env: { ...process.env, NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000' }, shell: false, stdio: ['inherit', 'pipe', 'inherit'] });
  const chunks = [];
  let bytes = 0;
  child.stdout.on('data', chunk => { process.stdout.write(chunk); bytes += chunk.length; if (bytes <= 16 * 1024 * 1024) chunks.push(chunk); });
  const signals = [];
  const handlers = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, () => {
    const forwarded = child.kill(signal);
    signals.push(log('signal-forwarded', { signal, childPid: child.pid, forwarded }));
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  await log('child-started', { childPid: child.pid });
  const result = await closed;
  await Promise.all(signals);
  let metrics;
  if (bytes <= 16 * 1024 * 1024) {
    try { metrics = safeRequestMetrics(JSON.parse(Buffer.concat(chunks).toString('utf8')).request_metrics); } catch { /* Absence is unknown, not zero requests. */ }
  }
  if (metrics) for (const event of metrics.trace) await log(event.event, { ...event, ...(event.event === 'wait' ? { wait_kind: event.kind } : {}), kind: 'http' });
  await log('metrics', { kind: 'metrics', observed: metrics !== undefined, complete: metrics?.complete ?? false,
    total_requests: metrics?.total_requests ?? null, trace_dropped: metrics?.trace_dropped ?? null });
  await log('completed', { ...result, childPid: child.pid });
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  process.exitCode = result.code ?? 1;
}

export async function createRequestLedger({ scratch, evidence, command }) {
  const ledger = join(evidence, 'safe-source-requests.jsonl');
  const config = join(scratch, 'source-ledger.json');
  await appendFile(ledger, '', { mode: 0o600 });
  await save(config, { kind: 'cli', command, ledger });
  return { command: [process.execPath, helper, '--request-ledger', config], ledger };
}

const textContent = content => typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
/** Pi replays system content and named section patches before serialization.
 * Ignore receipts/tool schemas and retire replaced or removed section values. */
export function providerSystemText(context) {
  const content = [], sections = new Map();
  for (const message of context.messages ?? []) {
    if (message.role !== 'system') continue;
    const text = textContent(message.content); if (text) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name); else sections.set(name, value);
    }
  }
  return [...content, ...sections.values()].filter(Boolean).join('\n\n');
}

function catalogCardAttributes(raw) {
  return Object.fromEntries([...raw.matchAll(/([a-z]+)="([^"]*)"/g)].map(match => [match[1],
    decodeCatalogText(match[2].replaceAll('&#13;', '\r').replaceAll('&#10;', '\n').replaceAll('&#9;', '\t'))]));
}

export function catalogCards(text) {
  const grouped = [...text.matchAll(/<catalog-cards>([\s\S]*?)<\/catalog-cards>/g)].flatMap(block =>
    [...block[1].matchAll(/<group\b([^>]*)>([\s\S]*?)<\/group>/g)].flatMap(group => {
      const header = catalogCardAttributes(group[1]);
      return [...group[2].matchAll(/<card\b([^>]*?)\/>|<card\b([^>]*)>([\s\S]*?)<\/card>/g)].map(card => {
        const self = card[1] !== undefined, fields = catalogCardAttributes(self ? card[1] : card[2]);
        return { kind: header.kind, name: fields.name, location: fields.location, ref: fields.ref,
          source: fields.source ?? header.source, description: self ? undefined : decodeCatalogText(card[3]) };
      });
    }));
  const legacySkills = [...text.matchAll(/<skill>([\s\S]*?)<\/skill>/g)].flatMap(match => {
    const name = /<name>\s*([^<]*)\s*<\/name>/.exec(match[1])?.[1];
    const location = /<location>\s*([^<]*)\s*<\/location>/.exec(match[1])?.[1];
    if (name === undefined || location === undefined) return [];
    const description = /<description>([\s\S]*?)<\/description>/.exec(match[1]);
    const source = /<source>\s*([^<]*)\s*<\/source>/.exec(match[1])?.[1];
    const ref = /<ref>\s*([^<]*)\s*<\/ref>/.exec(match[1])?.[1];
    return [{ kind: 'skill', name: decodeCatalogText(name), location: decodeCatalogText(location),
      ...(description ? { description: decodeCatalogText(description[1]) } : {}), ...(source !== undefined ? { source: decodeCatalogText(source) } : {}),
      ...(ref !== undefined ? { ref: decodeCatalogText(ref) } : {}) }];
  });
  const legacyRouters = [...text.matchAll(/<router\b([^>]*)>([\s\S]*?)<\/router>/g)].map(match => {
    const ref = /\bref="([^"]*)"/.exec(match[1])?.[1];
    const name = /<name>\s*([^<]*)\s*<\/name>/.exec(match[2])?.[1] ?? '';
    const description = /<description>([\s\S]*?)<\/description>/.exec(match[2]);
    return { kind: 'router', name: decodeCatalogText(name), ...(ref !== undefined ? { ref: decodeCatalogText(ref) } : {}),
      ...(description ? { description: decodeCatalogText(description[1]) } : {}) };
  });
  return [...grouped, ...legacySkills, ...legacyRouters];
}

export function nativeEntries(host, context) {
  const topLevel = host === 'omp' ? (Array.isArray(context.systemPrompt) ? context.systemPrompt.join('\n') : context.systemPrompt ?? '') : '';
  const text = [topLevel, providerSystemText(context)].filter(Boolean).join('\n');
  const metadata = [...text.matchAll(/<skill>([\s\S]*?)<\/skill>/g)].flatMap(match => {
    const name = /<name>\s*([^<]+)\s*<\/name>/u.exec(match[1])?.[1];
    const location = /<location>\s*([^<]+)\s*<\/location>/u.exec(match[1])?.[1];
    const source = /<source>\s*([^<]+)\s*<\/source>/u.exec(match[1])?.[1];
    return name && location ? [{ name: decodeCatalogText(name.trim()), filePath: decodeCatalogText(location.trim()),
      ...(source ? { source: decodeCatalogText(source.trim()) } : {}), catalog: 'prompt-metadata' }] : [];
  });
  metadata.push(...catalogCards(text).flatMap(card => card.kind === 'skill' && card.name && card.location
    ? [{ name: card.name, filePath: card.location, ...(card.source ? { source: card.source } : {}), catalog: 'prompt-metadata' }] : []));
  const native = host === 'omp' ? (context.tools ?? []).flatMap(tool => tool.tool?.session?.skills ?? []).map(item => ({ ...item, catalog: 'host-native' })) : [];
  return [...new Map([...metadata, ...native].map(item => [JSON.stringify([item.name, item.source ?? '', item.filePath]), item])).values()];
}
const contentRequests = requests => requests.filter(row => row.kind === 'http' && row.phase === 'attempt' && row.request_kind === 'notion_body');
const exportsStarted = requests => requests.filter(row => row.kind === 'cli' && row.phase === 'started' && row.command === 'export');
const preparationCommands = new Set(['prepare', 'read', 'use']);
// This is an explicit verification choice, never the product's default policy.
export const defaultContextVerificationBudget = Object.freeze({ maxNodes: 1, maxBytes: 65536, maxDepth: 0, maxTimeMs: 5000, rateShare: 0.1 });

export function verifyPreparedDiagnostic(job, { id, scope, budget = defaultContextVerificationBudget }) {
  assert.equal(job?.purpose, 'prefetch', 'Foreground ready is not a prefetch receipt');
  assert.equal(job.state, 'prepared');
  assert.equal(job.sourceId, 'notion');
  assert.equal(job.loaded, false, 'Prepared is not session delivery');
  assert.deepEqual(job.budget, budget, 'The diagnostic must retain the actual bounded policy');
  assert.ok(Number.isSafeInteger(job.epoch) && job.epoch >= 0);
  assert.ok(Number.isSafeInteger(job.preparedNodes) && job.preparedNodes > 0 && job.preparedNodes <= budget.maxNodes);
  assert.equal(job.records?.length, job.preparedNodes);
  assert.deepEqual(job.records.map(record => record.id), [id], 'Only the selected default root is prepared');
  for (const record of job.records) {
    assert.equal(record.scope, scope, 'Prepared identity must retain the selected authorization scope');
    assert.match(record.snapshotId, /^s_[a-f0-9]{64}$/u);
    assert.match(record.bodySha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(record.bytes) && record.bytes > 0);
  }
  assert.equal(job.instructionBytes, job.records.reduce((sum, record) => sum + record.bytes, 0));
  assert.ok(job.instructionBytes <= budget.maxBytes && Number.isSafeInteger(job.contextBytes) && job.contextBytes >= job.instructionBytes && job.contextBytes <= budget.maxBytes);
  for (const forbidden of ['body', 'content', 'lock', 'graph_lock', 'session_bindings']) assert.equal(Object.hasOwn(job, forbidden), false, 'Diagnostics must remain session-neutral metadata');
  return job.records[0];
}

export function verifyPreparedProviderBody(context, name, prepared) {
  const texts = context.messages.map(message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'));
  const records = texts.flatMap(text => [...text.matchAll(/<context-broker-record\b([^>]*)>([\s\S]*?)<\/context-broker-record>/gu)])
    .filter(record => decodeCatalogText(/\bname="([^"]*)"/u.exec(record[1])?.[1] ?? '') === name);
  assert.equal(records.length, 1, 'One complete selected body must reach the actual provider');
  const bodies = [...records[0][2].matchAll(/<body>\n([\s\S]*?)\n<\/body>/gu)];
  assert.equal(bodies.length, 1);
  const body = decodeCatalogText(bodies[0][1]);
  assert.equal(Buffer.byteLength(body), prepared.bytes, 'A marker or partial body cannot prove complete delivery');
  assert.equal(createHash('sha256').update(body).digest('hex'), prepared.bodySha256);
  return { bytes: prepared.bytes, sha256: prepared.bodySha256 };
}

/** The OMP compatibility branch reads its actual advertised directory. Pi copies
 * the issued resource handle; neither route derives files from a catalog stub. */
export function defaultContextResourceEntry(host, context, name, path) {
  if (host === 'pi') return projectedResourceRef(context, name, path);
  assert.equal(host, 'omp');
  assert.ok(path && !isAbsolute(path) && !path.split('/').includes('..'), 'Resource path must stay within its selected owner');
  const text = context.messages.map(message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')).join('\n');
  const records = [...text.matchAll(/<context-broker-record\b([^>]*)>([\s\S]*?)<\/context-broker-record>/gu)]
    .filter(record => decodeCatalogText(/\bname="([^"]*)"/u.exec(record[1])?.[1] ?? '') === name);
  assert.equal(records.length, 1, 'One delivered owner must advertise the OMP resource directory');
  const directories = [...records[0][2].matchAll(/<skill-directory>([^<]+)<\/skill-directory>/gu)];
  assert.equal(directories.length, 1, 'OMP resource reads require the actual delivered directory');
  const directory = decodeCatalogText(directories[0][1].trim());
  assert.ok(isAbsolute(directory) || directory.startsWith('~/'), 'A redacted directory is not a readable path');
  return join(directory, path);
}

// Invoked only by --default-context true. The installed host/extension, public
// RPC, provider boundary and subprocess lifetimes are real. The deterministic
// CLI fixture is a wire contract, not evidence of core cache or Notion traffic.
export async function runDefaultContext({ host, root, scratch, evidence, fixture, extension, database, ledger, scriptedProvider }) {
  const label = `${host}-default-context`;
  const files = ['provider.jsonl', 'rpc.json', 'decisions.jsonl', 'result.json'].map(suffix => `${label}-${suffix}`);
  const [providerFile, rpcFile, decisionsFile, resultFile] = files.map(file => join(evidence, file));
  const lifecycleFile = join(evidence, `${label}-lifecycle.jsonl`);
  files.push(`${label}-lifecycle.jsonl`);
  const result = { host, mode: 'default-context', contract: 'bounded-inspect-prefetch', status: 'running', files, observations: [],
    acceptance: { boundedPrefetchAndLifecycle: 'pending', byteExactResourceDelivery: 'pending' },
    source: fixture.live ? 'owned live CLI' : 'controlled CLI wire fixture',
    retiredAssertions: [
      'Prefetch full-directory export and ready/loaded are retired: bounded inspect warms the CLI cache without a Broker snapshot directory or session selection.',
      'Cold concurrent publication into one Broker cacheDir is retired from this specialty: the current cache owner is the CLI/core; a fake CLI cannot prove its cross-process cache.',
      'Foreground/background shared download is retired: foreground immediately cancels warming; foreground waiter sharing remains a separate runtime contract.',
    ],
    notRun: ['real model', 'Tern UI and detached completion', 'CLI/core cross-process cache reuse and remote request savings', ...(!fixture.live ? ['real Notion HTTP'] : [])] };
  const firstRequest = (await rows(ledger)).length;
  const identity = { id: fixture.record?.id ?? 'notion_page:' + fixture.skillRef.split('/')[2], scope: fixture.scope ?? fixture.live?.scope };
  const catalogName = host === 'pi' ? fixture.record?.name ?? fixture.name : `notion-${fixture.alias}`.replace(/[^a-z0-9-]/g, '-');
  const authorName = fixture.record?.name ?? fixture.name;
  const selection = fixture.selectionToken ?? `${fixture.alias}@notion`;
  const frames = [];
  let rpc, launch, phase = 'startup';
  const captures = () => rows(providerFile);
  const requests = async () => (await rows(ledger)).slice(firstRequest);
  const until = async (label, probe, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await probe(); if (value) return value; await pause(50); }
    assert.fail(`Timed out waiting for ${label}`);
  };
  const observe = (action, details = {}) => result.observations.push({ action, ...details });
  const stop = async () => { if (rpc) { const active = rpc; rpc = undefined; try { await active.stop(); } finally { frames.push(...active.frames); } } };
  const boot = async (name, activation, options = {}) => {
    await stop();
    const base = join(scratch, `${label}-${name}`), agentDir = join(base, 'agent');
    await mkdir(join(agentDir, 'context-broker'), { recursive: true });
    await mkdir(join(base, 'sessions'), { recursive: true });
    const prefetch = Object.hasOwn(options, 'prefetch') ? options.prefetch : defaultContextVerificationBudget;
    const source = { type: 'notion', id: 'notion', namespace: 'notion', command: fixture.command, database: database ?? fixtureDatabase,
      cacheDir: join(base, 'source-cache'), requestTimeoutMs: 30000, ...(activation ? { activation } : {}), ...(prefetch === undefined ? {} : { prefetch }) };
    await save(join(agentDir, 'context-broker', 'config.yml'), { sources: [source] });
    const provider = await scriptedProvider(base), plan = join(base, 'tool-plan.json');
    await save(plan, { trigger: 'NEVER', id: `${label}-${name}`, path: '/nonexistent' });
    const compactMode = join(base, 'compaction-mode.txt');
    await writeFile(compactMode, 'remove', { mode: 0o600 });
    const env = isolatedEnv({ base, agentDir, CONTEXT_BROKER_HOST: host, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerFile, CONTEXT_BROKER_LOG_FILE: decisionsFile, BROKER_NOTION_TOOL_PLAN: plan,
      CONTEXT_BROKER_E2E_COMPACTION_MODE_FILE: compactMode, CONTEXT_BROKER_E2E_LIFECYCLE_FILE: lifecycleFile });
    if (fixture.live) {
      // The parent live-fixture runner has already selected owned mutable roots.
      for (const [key, value] of Object.entries(process.env)) if (/^(NOTION_|NTN_|XDG_)/.test(key)) env[key] = value;
    }
    const args = ['--no-extensions', '--session-dir', join(base, 'sessions'), '--tools', 'read', '-e', provider, '-e', join(root, 'packages/context-broker/scripts/context-broker-lifecycle-fixture.mjs'), '-e', extension, '--model', 'context-broker-e2e/fake', ...(host === 'omp' ? ['--no-title', '--no-rules'] : [])];
    launch = { host, cwd: base, env, args };
    rpc = await startRpc(launch);
    return { plan };
  };
  const diagnostic = async () => {
    const before = rpc.frames.length, beforeProviders = (await captures()).length;
    await rpc.prompt('/context-broker sources');
    assert.equal((await captures()).length, beforeProviders, 'Source diagnostics must never invoke provider');
    const text = rpc.frames.slice(before).map(frame => frame.message ?? '').find(message => message.startsWith('context-broker sources: '));
    assert.ok(text, 'Runtime must expose source preparation diagnostics');
    const value = JSON.parse(text.slice('context-broker sources: '.length));
    assert.ok(Array.isArray(value.prefetch));
    return value.prefetch;
  };
  const waitState = async (expected, { identity: jobIdentity, timeout = 15000 } = {}) => until(`prefetch ${expected}`, async () => {
    const jobs = (await diagnostic()).filter(job => job.purpose === 'prefetch' && job.sourceId === 'notion');
    const job = jobIdentity ? jobs.find(job => job.identity === jobIdentity) : jobs.at(-1);
    if (job?.state === expected) return job;
    if (job?.state === 'error' && expected !== 'error') assert.fail(`Prefetch failed: ${job.error}`);
  }, timeout);
  const baseline = async (expectEmpty = true) => {
    const before = (await captures()).length;
    await rpc.prompt('List available ledger skill names without reading files.');
    const context = (await captures())[before]?.context;
    assert.ok(context, 'Actual provider must capture baseline metadata');
    if (expectEmpty) for (const marker of [fixture.marker, unflaggedCanary, missingCanary]) assert.equal(count(context, marker), 0, 'No source body before activation');
    return context;
  };
  const catalogEntries = context => nativeEntries(host, context).filter(entry => entry.name === catalogName && (host !== 'pi' || entry.source === 'notion'));
  const refreshMetadata = async () => {
    const before = (await captures()).length, frameStart = rpc.frames.length;
    await rpc.prompt('/context-broker refresh');
    assert.equal((await captures()).length, before, 'Metadata refresh must not call the provider');
    assert.ok(rpc.frames.slice(frameStart).some(frame => frame.type === 'extension_ui_request' && frame.method === 'notify' && frame.message === 'context-broker: source metadata refreshed'));
  };
  const setState = async options => fixture.setScenario?.('normal', { includeUnflagged: true, ...options });
  const bodyOnce = () => captures().then(all => assert.equal(count(all.at(-1).context.messages, fixture.marker), 1, 'Selected complete body must reach provider exactly once'));
  const openResource = async (plan, trigger) => {
    const path = defaultContextResourceEntry(host, (await captures()).at(-1).context, authorName, fixture.resourcePath ?? 'references/ledger.md');
    await save(plan, { trigger, id: `${label}-${trigger}`, path });
    await rpc.prompt(`${trigger}: read the linked ledger guide.`);
    const messages = (await captures()).at(-1).context.messages;
    const results = messages.filter(message => message.role === 'toolResult' && message.toolCallId === `${label}-${trigger}`);
    assert.equal(results.length, 1, 'Resource evidence must belong to this outer read call');
    assert.notEqual(results[0].isError, true);
    const text = results[0].content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.equal(count(text, fixture.resourceCanary), 1, 'The native result content must contain the requested resource, independently of details');
    const proof = results[0].details?.contextBrokerResource;
    if (!fixture.live) assert.equal(text, fixture.resourceCanary + (host === 'pi' ? '\n' : ''), host === 'pi'
      ? 'Pi requires every source byte, not a details-only receipt' : 'OMP retains its existing one-line native projection');
    if (host === 'pi') {
      assert.ok(proof?.delivered_complete_text);
      assert.equal(proof.id, identity.id); assert.equal(proof.scope, identity.scope);
      assert.equal(proof.toolCallId, results[0].toolCallId);
      assert.equal(proof.bytes, Buffer.byteLength(text));
      assert.equal(proof.sha256, createHash('sha256').update(text).digest('hex'));
    }
    const byteExact = proof?.delivered_complete_text === true && proof.bytes === Buffer.byteLength(text) && proof.sha256 === createHash('sha256').update(text).digest('hex');
    result.acceptance.byteExactResourceDelivery = byteExact ? 'passed' : 'not_passed';
    return { ref: path, providerBytes: Buffer.byteLength(text), sourceBytes: proof?.bytes ?? null, deliveredCompleteText: proof?.delivered_complete_text ?? null,
      byteExact, ...(host === 'omp' ? { compatibility: 'Native one-line read strips the terminal newline; this is not complete byte delivery.' } : {}) };
  };
  const endedProcess = async (owned, message) => {
    const ended = await until(message, async () => (await requests()).find(row => row.requestId === owned.requestId && row.phase === 'completed'));
    assert.ok(ended.signal || ended.code !== 0, 'Cancelled source must not report successful completion');
    await until('owned source processes exit', async () => [owned.pid, owned.childPid].every(pid => {
      try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    }));
    return { requestId: ended.requestId, pid: owned.pid, childPid: owned.childPid, code: ended.code, signal: ended.signal };
  };
  const ownedPreparation = async start => until('owned preparation child', async () => (await requests()).slice(start).find(row => row.kind === 'cli' && preparationCommands.has(row.command) && row.phase === 'child-started'));
  try {
    await setState({});
    phase = 'default disabled and legacy boolean policy';
    for (const [name, prefetch] of [['omitted', undefined], ['false', false], ['legacy-true', true]]) {
      const begin = (await requests()).length;
      await boot(`disabled-${name}`, undefined, { prefetch });
      await baseline();
      await refreshMetadata();
      const metadata = await baseline();
      assert.equal(catalogEntries(metadata).length, 1, 'A disabled prefetch policy must retain the default metadata directory');
      assert.equal((await diagnostic()).filter(job => job.purpose === 'prefetch').length, 0);
      const calls = (await requests()).slice(begin).filter(row => row.kind === 'cli' && row.phase === 'started');
      assert.equal(calls.filter(row => preparationCommands.has(row.command) || row.command === 'export').length, 0, 'Omitted/boolean policy cannot start body preparation');
      observe(phase, { policy: name, preparationCalls: 0, exports: 0, catalogName });
    }
    phase = 'bounded inspect preparation stays session-neutral';
    const prepareStart = (await requests()).length, fixtureStart = fixture.callsPath ? (await rows(fixture.callsPath)).length : 0;
    const { plan } = await boot('prepared');
    const first = await baseline();
    const beforeProviders = (await captures()).length;
    const prepared = await waitState('prepared');
    const selected = verifyPreparedDiagnostic(prepared, identity);
    assert.equal((await captures()).length, beforeProviders, 'Warming and polling cannot invoke the provider');
    const context = await baseline();
    const entries = nativeEntries(host, context), advertised = catalogEntries(context);
    assert.equal(advertised.length, 1, 'The ready provider directory must advertise the actual author name and source once');
    assert.ok(advertised[0].filePath, 'The catalog must provide a readable entry');
    for (const name of host === 'pi' ? ['UI Beta', 'UI Gamma'] : [`notion-${unflaggedAlias}`, `notion-${missingAlias}`]) assert.ok(!entries.some(item => item.name === name), 'View-excluded records must not appear in the default directory');
    const messages = (await rpc.command('get_messages')).messages;
    assert.equal(count(messages, fixture.marker), 0);
    assert.ok(!JSON.stringify(messages).includes('context-broker-source-read'), 'Background cannot create foreground delivery records');
    const sessionFile = (await rpc.command('get_state')).sessionFile;
    assert.ok(sessionFile);
    const persisted = await readFile(sessionFile, 'utf8'), preparedSession = `${label}-prepared-session.jsonl`;
    await writeFile(join(evidence, preparedSession), persisted, { mode: 0o600 }); files.push(preparedSession);
    assert.ok(!persisted.includes(fixture.marker) && !persisted.includes('context-broker-source-read'));
    const preparedRequests = (await requests()).slice(prepareStart);
    assert.equal(exportsStarted(preparedRequests).length, 0, 'Bounded inspect must not export a full host directory');
    const starts = preparedRequests.filter(row => row.kind === 'cli' && row.phase === 'started' && row.command === 'prepare');
    assert.equal(starts.length, 1, 'One bounded inspect request prepares this root');
    assert.ok(preparedRequests.some(row => row.requestId === starts[0].requestId && row.phase === 'completed' && row.code === 0));
    if (fixture.callsPath) {
      const calls = (await rows(fixture.callsPath)).slice(fixtureStart).filter(call => (call.operation ?? call.command) === 'prepare');
      assert.equal(calls.length, 1);
      for (const [flag, value] of [['--purpose', 'inspect'], ['--priority', 'prefetch'], ['--max-nodes', '1'], ['--max-depth', '0'], ['--max-instruction-bytes', '65536'], ['--max-context-bytes', '65536'], ['--time-budget-ms', '5000'], ['--queue-budget-ms', '1000'], ['--rate-share', '0.1']]) assert.equal(calls[0].args[calls[0].args.indexOf(flag) + 1], value, `Actual prefetch argv must retain ${flag}`);
      assert.ok(!calls[0].args.includes('--session-bindings'));
    }
    observe(phase, { job: prepared, selected, catalog: advertised[0], firstTurnCatalogEntries: catalogEntries(first).length, nextTurnCatalogEntries: advertised.length, providerRequestsDuringPrefetch: 0, exports: 0 });
    phase = 'foreground validates and reads supplied resource';
    const foregroundStart = (await requests()).length;
    await rpc.prompt(`$${selection} Apply the selected ledger contract.`); await bodyOnce();
    const delivered = verifyPreparedProviderBody((await captures()).at(-1).context, authorName, selected);
    const resource = await openResource(plan, 'OPEN_DEFAULT_RESOURCE');
    assert.ok((await requests()).slice(foregroundStart).some(row => row.kind === 'cli' && row.phase === 'started' && preparationCommands.has(row.command)), 'Prepared bytes must not bypass foreground authorization/freshness');
    assert.equal(exportsStarted((await requests()).slice(prepareStart)).length, 0);
    observe(phase, { resource, delivered, completeBody: true, completeResourceBytes: resource.byteExact, exports: 0, cacheSavings: 'not asserted by a wire fixture' });
    if (fixture.setScenario) {
      phase = 'View-excluded records remain explicitly selectable';
      for (const [alias, marker] of [[unflaggedAlias, unflaggedCanary], [missingAlias, missingCanary]]) {
        await rpc.prompt(`$${alias}@notion Apply this available contract.`);
        assert.equal(count((await captures()).at(-1).context.messages, marker), 1);
      }
      observe(phase);
    }
    phase = 'View refresh removes metadata without revoking prior delivery';
    if (fixture.setDefaultContext) await fixture.setDefaultContext(false); else await setState({ defaultContext: false });
    await refreshMetadata();
    assert.equal(catalogEntries(await baseline(false)).length, 0);
    await boot('unchecked-cold', undefined, { prefetch: false });
    await refreshMetadata();
    assert.equal(catalogEntries(await baseline()).length, 0, 'Restart must retain the changed default membership');
    await rpc.prompt(`$${selection} Apply this explicitly selected contract.`); await bodyOnce();
    assert.ok((await requests()).some(row => row.command === 'list' && row.policy === 'refresh'));
    observe(phase);
    if (fixture.setDefaultContext) await fixture.setDefaultContext(true);
    await setState({});
    phase = 'native branch and compaction recovery';
    await boot('lifecycle'); await baseline(); await waitState('prepared'); await baseline();
    const points = await rpc.command(host === 'pi' ? 'get_fork_messages' : 'get_branch_messages');
    const target = points.messages?.at(-1)?.entryId; assert.ok(target);
    await rpc.prompt(`$${selection} Apply the selected lifecycle contract.`); await bodyOnce();
    assert.notEqual((await rpc.command(host === 'pi' ? 'fork' : 'branch', { entryId: target })).cancelled, true);
    assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0);
    await rpc.prompt(`$${selection} Reload after native branch.`); await bodyOnce();
    await rpc.prompt('These ordinary notes discuss the weather and scheduling. '.repeat(2400));
    const compacted = await rpc.command('compact'); assert.ok(compacted.firstKeptEntryId);
    assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0);
    await rpc.prompt(`$${selection} Reload after native compaction.`); await bodyOnce();
    observe(phase, { branchEntryId: target, compactedEntryId: compacted.firstKeptEntryId });
    if (fixture.setScenario) {
      phase = 'foreground cancels warming and rejects late publication';
      await setState({ delayMs: 4000 });
      const begin = (await requests()).length;
      await boot('overlap'); await baseline();
      const warming = await waitState('running'), owned = await ownedPreparation(begin);
      await setState({ revision: 'FOREGROUND_REVISION_61C9' });
      await rpc.prompt(`$${selection} Apply while preparation runs.`); await bodyOnce();
      assert.equal(count((await captures()).at(-1).context.messages, 'FOREGROUND_REVISION_61C9'), 1);
      const cancelled = await waitState('cancelled', { identity: warming.identity });
      assert.equal(cancelled.reason, 'foreground');
      const terminated = await endedProcess(owned, 'cancelled warm subprocess');
      await pause(4100);
      assert.equal((await diagnostic()).find(job => job.identity === warming.identity)?.state, 'cancelled', 'Late warming cannot overwrite the selected foreground version');
      assert.equal(exportsStarted((await requests()).slice(begin)).length, 0);
      observe(phase, { warmIdentity: warming.identity, terminated, observedForegroundRevision: 'FOREGROUND_REVISION_61C9', exports: 0 });
      phase = 'native session boundary cancels pending foreground';
      await setState({ delayMs: 12000 });
      await boot('consumer-session-switch', undefined, { prefetch: false });
      await refreshMetadata(); await baseline();
      const boundaryStart = (await requests()).length, lifecycleStart = (await rows(lifecycleFile)).length, providerStart = (await captures()).length;
      let settled = false;
      const submission = rpc.prompt(`$${selection} CANCEL_DEFAULT_CONTEXT_SELECTION`).then(value => ({ value }), error => ({ error: error.message })).finally(() => { settled = true; });
      await until('native selected input entry', async () => (await rows(lifecycleFile)).slice(lifecycleStart).some(row => row.event === 'selected-input-entered'));
      const pending = await ownedPreparation(boundaryStart);
      assert.equal(settled, false); assert.equal((await captures()).length, providerStart);
      assert.notEqual((await rpc.command('new_session')).cancelled, true); await submission;
      assert.equal((await captures()).length, providerStart);
      assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0);
      const boundaryEnded = await endedProcess(pending, 'session-cancelled foreground subprocess');
      assert.ok((await rows(lifecycleFile)).slice(lifecycleStart).some(row => ['session_shutdown', 'session_switch'].includes(row.event)));
      await setState({});
      await rpc.prompt(`$${selection} Retry after the previous session selection was cancelled.`); await bodyOnce();
      observe(phase, { route: 'new_session', terminated: boundaryEnded, cancelledProviderRequests: 0, retryDelivered: true });
      phase = 'owned graceful EOF cancels warming';
      await setState({ delayMs: 30000 });
      const shutdownStart = (await requests()).length;
      await boot('owned-shutdown'); await baseline(); await waitState('running');
      const shutting = await ownedPreparation(shutdownStart), shutdownEvents = (await rows(lifecycleFile)).length, providerShutdown = (await captures()).length;
      const closing = rpc; await closing.closeInput(); frames.push(...closing.frames); rpc = undefined;
      const shutdownEnded = await endedProcess(shutting, 'EOF-owned warming subprocess');
      assert.ok((await rows(lifecycleFile)).slice(shutdownEvents).some(row => row.event === 'session_shutdown'));
      assert.equal(exportsStarted((await requests()).slice(shutdownStart)).length, 0);
      assert.equal((await captures()).length, providerShutdown);
      observe(phase, { route: 'native RPC stdin EOF', terminated: shutdownEnded, providerRequests: 0, exports: 0 });
      result.notRun.push('Native composer Stop; RPC abort does not cancel a pending extension input hook');
      phase = 'time budget cancels warming without blocking foreground';
      await setState({ delayMs: 2000 });
      await boot('time-budget', undefined, { prefetch: { ...defaultContextVerificationBudget, maxTimeMs: 250 } });
      await baseline(); const limited = await waitState('cancelled'); assert.equal(limited.reason, 'time_budget');
      assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0);
      await setState({}); await rpc.prompt(`$${selection} Apply after warming exceeded its budget.`); await bodyOnce();
      observe(phase, { job: limited, retryDelivered: true });
      phase = 'background permission failure does not poison foreground recovery';
      await setState({ failRead: true }); await boot('failure'); await baseline();
      const failed = await waitState('error'); assert.match(failed.error ?? '', /^[A-Z_]+$/u);
      assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0);
      await setState({}); await rpc.prompt(`$${selection} Retry the selected skill.`); await bodyOnce();
      observe(phase, { code: failed.error });
      phase = 'refresh cancels the old warming generation';
      await setState({ delayMs: 3000 }); const refreshStart = (await requests()).length;
      await boot('cancel'); await baseline(); const old = await waitState('running'), refreshedOwned = await ownedPreparation(refreshStart);
      await setState({ defaultContext: false }); await refreshMetadata();
      await endedProcess(refreshedOwned, 'refreshed warming subprocess'); await pause(3100);
      assert.equal(catalogEntries(await baseline()).length, 0);
      assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0);
      assert.equal((await diagnostic()).find(job => job.identity === old.identity)?.state, 'cancelled');
      observe(phase, { retiredIdentity: old.identity });
      phase = 'expired preparation cannot bypass failed foreground validation';
      await setState({}); await boot('expiry', { maxAge: '0s' }); await baseline();
      verifyPreparedDiagnostic(await waitState('prepared'), identity);
      const expiryStart = (await requests()).length, providerFailure = (await captures()).length;
      await setState({ failRead: true });
      try { await rpc.prompt(`$${selection} Validate expired instructions.`); } catch { /* Host may return an explicit blocked-input error. */ }
      assert.equal((await captures()).length, providerFailure, 'No stale prepared body may cross the provider boundary');
      assert.ok((await requests()).slice(expiryStart).some(row => row.kind === 'cli' && preparationCommands.has(row.command) && row.policy === '0s'));
      observe(phase, { providerRequests: 0, freshnessPolicy: '0s' }); await setState({});
    } else result.notRun.push('Controlled overlap, failure, time budget, cancellation and expiry faults');
    phase = 'process restart repeats bounded validation without activating';
    const restart = await boot('restart'); await baseline();
    const previous = verifyPreparedDiagnostic(await waitState('prepared'), identity);
    await stop(); const restartStart = (await requests()).length; rpc = await startRpc(launch);
    await baseline(); const renewed = verifyPreparedDiagnostic(await waitState('prepared'), identity); await baseline();
    assert.equal(count((await rpc.command('get_messages')).messages, fixture.marker), 0);
    assert.deepEqual(renewed, previous, 'Unchanged controlled source must retain its selected immutable identity');
    await rpc.prompt(`$${selection} Apply after process restart.`); await bodyOnce();
    verifyPreparedProviderBody((await captures()).at(-1).context, authorName, renewed);
    const restartResource = await openResource(restart.plan, 'OPEN_RESTART_RESOURCE');
    assert.ok((await requests()).slice(restartStart).some(row => row.kind === 'cli' && row.phase === 'started' && row.command === 'prepare'));
    assert.equal(exportsStarted((await requests()).slice(restartStart)).length, 0);
    observe(phase, { snapshotId: renewed.snapshotId, resource: restartResource, exports: 0, cacheReuse: 'not inferred from repeated snapshot identity' });
    result.acceptance.boundedPrefetchAndLifecycle = 'passed';
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.failedAction = phase; result.error = error.message; }
  finally {
    try { await stop(); } catch (error) { result.status = 'failed'; result.shutdownError = error.message; }
    await save(rpcFile, frames);
    const all = await requests(), starts = all.filter(row => row.kind === 'cli' && row.phase === 'started'), metrics = all.filter(row => row.kind === 'metrics' && row.phase === 'metrics');
    const complete = starts.length === metrics.length && metrics.every(row => row.observed === true && row.complete === true);
    result.requests = { cli: starts.length, cliCompleted: all.filter(row => row.kind === 'cli' && row.phase === 'completed').length,
      observedRemoteContent: contentRequests(all).length, remoteContent: complete ? contentRequests(all).length : null, sourceMetricsComplete: complete, exports: exportsStarted(all).length };
    result.finishedAt = new Date().toISOString(); await save(resultFile, result);
  }
  if (result.status !== 'passed') { const error = new Error(`${label}: ${result.error ?? result.shutdownError}; see ${files[3]}`); error.results = [result]; throw error; }
  return result;
}

if (process.argv[2] === '--request-ledger') await runLedger(process.argv[3], process.argv.slice(4));
