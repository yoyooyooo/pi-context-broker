import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCatalogText, measuredConsumptionArgs, projectedResourceRef } from './notion-integration-hosts.mjs';

const helper = fileURLToPath(import.meta.url);
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

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

if (process.argv[2] === '--request-ledger') await runLedger(process.argv[3], process.argv.slice(4));
