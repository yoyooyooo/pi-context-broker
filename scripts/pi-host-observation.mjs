import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { identifySourcePackageEntry } from './skill-consumption-source-observer.mjs';

// Shared passive observation and validation. This module has no CLI dispatch or
// top-level run, so public drivers can load each other without an await cycle.
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const local = relative(root, path); return local === '' || (!local.startsWith('..' + sep) && local !== '..' && !isAbsolute(local)); };

function validateHostFile(identity) {
  assert.ok(identity && isAbsolute(identity.path) && isAbsolute(identity.realpath)
    && Number.isSafeInteger(identity.bytes) && identity.bytes > 0, 'An actual host file identity is required');
  assert.match(identity.sha256 ?? '', /^[a-f0-9]{64}$/);
}

export function validateDailyHostProcess(proof, host, owned, args, { complete = true } = {}) {
  validateHostFile(host?.launcher);
  assert.ok(Number.isSafeInteger(host.parent_pid) && host.parent_pid > 0 && Array.isArray(host.prefix));
  assert.equal(host.launcher.path, host.path);
  assert.equal(host.launcher.realpath, host.identity);
  assert.ok(Array.isArray(owned) && owned.length === 1, 'One owned ordinary Pi process is required');
  const child = owned[0];
  assert.ok(proof && Number.isSafeInteger(proof.pid) && proof.pid > 0 && proof.pid === child.pid
    && proof.parent_pid === host.parent_pid, 'The actual Pi must be the owned launcher process');
  assert.equal(child.file, host.file);
  assert.deepEqual(child.args, [...host.prefix, ...args]);
  assert.equal(proof.args_sha256, hash(JSON.stringify(args)), 'The actual Pi arguments differ from the ordinary launch');
  validateHostFile(proof.entry); validateHostFile(proof.node); validateHostFile(proof.package?.manifest);
  assert.match(proof.node.version ?? '', /^\d+\.\d+\.\d+(?:[-+].+)?$/);
  assert.equal(proof.package.name, '@earendil-works/pi-coding-agent', 'The observed entry is not the Pi package');
  assert.ok(typeof proof.package.version === 'string' && proof.package.version);
  assert.equal(proof.package.bin, 'pi');
  assert.equal(proof.package.entry_realpath, proof.entry.realpath, 'The observed entry differs from the package pi bin');
  assert.ok(inside(proof.package.root, proof.entry.realpath));
  assert.equal(proof.package.manifest.realpath, join(proof.package.root, 'package.json'));
  if (complete) {
    assert.equal(proof.observed_exit, true, 'The actual Pi process must have a witnessed exit');
    assert.equal(proof.exit_code, 0, 'The actual Pi process did not exit successfully');
    assert.equal(child.observed_close, true); assert.equal(child.exit_code, 0); assert.equal(child.signal, null);
  }
  return proof;
}

export function observedDailyHostProcess(host, owned, observed, args, options) {
  const starts = observed.filter(row => row.event === 'process_start' && owned.some(child => child.pid === row.pid));
  assert.equal(starts.length, 1, 'The owned ordinary Pi process must report its actual entry');
  const start = starts[0];
  assert.ok(start.host_identity, 'The owned process did not report a valid Pi package bin');
  const exits = observed.filter(row => row.event === 'process_exit' && row.pid === start.pid);
  assert.ok(exits.length <= 1, 'Ambiguous actual Pi exit evidence');
  return validateDailyHostProcess({ ...start.host_identity, pid: start.pid, parent_pid: start.ppid,
    args_sha256: start.args_sha256, observed_exit: exits.length === 1, exit_code: exits[0]?.code ?? null }, host, owned, args, options);
}


// This recorder observes the real child and HTTP calls without replacing any
// arguments, configuration, response bodies, or source command. It reads no
// credential files and never logs environment values, headers, or raw payloads.
function installPassiveObserver(config, identifyPackageEntry) {
  if (!require('node:worker_threads').isMainThread) return;
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const zlib = require('node:zlib');
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const file = path.join(config.directory, `observer-${process.pid}.jsonl`);
  const write = value => fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + '\n', { mode: 0o600 });
  const canonical = value => { try { return fs.realpathSync(value); } catch { return undefined; } };
  const entry = typeof process.argv[1] === 'string' ? process.argv[1] : undefined;
  let hostIdentity = null;
  if (process.ppid === config.ownerParentPid) {
    try {
      const actual = identifyPackageEntry({ fs, crypto, path, packageName: '@earendil-works/pi-coding-agent', binName: 'pi' });
      if (actual) {
        const realpath = fs.realpathSync(process.execPath), bytes = fs.readFileSync(realpath);
        hostIdentity = { ...actual, node: { path: process.execPath, realpath, bytes: bytes.length, sha256: digest(bytes), version: process.versions.node } };
      }
    } catch { /* Missing actual runtime identity cannot pass the driver. */ }
  }
  write({ event: 'process_start', ppid: process.ppid, executable: process.execPath, entry, real_entry: entry ? canonical(entry) : undefined,
    entry_sha256: entry && canonical(entry) === config.cliEntry ? digest(fs.readFileSync(entry)) : undefined,
    host_identity: hostIdentity, args_sha256: digest(JSON.stringify(process.argv.slice(2))) });
  process.once('exit', code => write({ event: 'process_exit', code }));
  const nativeSpawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function(options) {
    const result = Reflect.apply(nativeSpawn, this, [options]);
    const args = options.args ?? [];
    const script = typeof args[1] === 'string' && path.isAbsolute(args[1]) && /\.[cm]?[jt]s$/u.test(args[1]) ? args[1] : undefined;
    const actual = script ? canonical(script) : undefined;
    const bundled = actual === config.cliEntry;
    const safeArgs = bundled ? args.slice(2).map(value => /^(?:--[a-z-]+|list|views|ctl|doctor|cache|identity|[0-9a-f-]{32,36}|[0-9]+(?:ms|s|m|h)?)$/u.test(value) ? value : '[unrecorded-argument]') : undefined;
    const meta = { child_pid: this.pid, executable: options.file, script, real_script: actual, bundled_cli: bundled, ...(bundled ? { cli_args: safeArgs, script_sha256: digest(fs.readFileSync(script)) } : {}) };
    write({ event: 'spawn', ...meta });
    const output = [];
    let outputBytes = 0;
    if (bundled && this.stdout) this.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes <= 16 * 1024 * 1024) output.push(Buffer.from(chunk)); });
    this.once('error', error => write({ event: 'spawn_error', ...meta, code: error.code }));
    this.once('close', (code, signal) => {
      let receipt;
      if (bundled && outputBytes <= 16 * 1024 * 1024) {
        try {
          const value = JSON.parse(Buffer.concat(output).toString('utf8'));
          receipt = { ok: value.ok, error_code: value.error?.code, transport: value.transport, notion_api_version: value.notion_api_version, authentication: ['available', 'missing', 'unavailable'].includes(value.authentication) ? value.authentication : undefined, record_count: Array.isArray(value.records) ? value.records.length : undefined, view_count: Array.isArray(value.views) ? value.views.length : undefined, skill_read: value.skill_read ? { checked: value.skill_read.checked, available: value.skill_read.available, storage: value.skill_read.storage } : undefined };
        } catch { receipt = { json_parse_failed: true }; }
      }
      write({ event: 'child_close', ...meta, code, signal, ...(bundled ? { stdout_bytes: outputBytes, stdout_sha256: outputBytes <= 16 * 1024 * 1024 ? digest(Buffer.concat(output)) : undefined, receipt } : {}) });
    });
    return result;
  };
  // Observe the actual transport, including SDKs and extensions that retain a
  // fetch reference before this preload. Wrapping globalThis.fetch misses those
  // requests. Diagnostics neither replace fetch nor consume response streams.
  const diagnostics = require('node:diagnostics_channel');
  const requests = new Map(), active = new Set();
  let sequence = 0, observerErrors = 0;
  const subscribe = (name, callback) => diagnostics.subscribe('undici:request:' + name, event => {
    try { callback(event); }
    catch { observerErrors++; write({ event: 'http_observer_error', channel: name }); }
  });
  const requestOf = request => {
    const row = requests.get(request);
    if (!row || !active.has(request)) throw new Error('UNOBSERVED_REQUEST');
    return row;
  };
  const bodyLimit = 16 * 1024 * 1024;
  const bodyIdOrigins = new Set(config.responseRequestIdBodyOrigins ?? ['https://api.notion.com']);
  const validRequestId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
  subscribe('create', ({ request }) => {
    // CONNECT uses an authority-form target (host:port), not a URL path.
    // Keep the proxy endpoint and tunnel target separate from the HTTP request
    // carried inside it; neither can substitute for SDK metadata evidence.
    const connect = request.method === 'CONNECT';
    const url = new URL(connect ? String(request.origin) : String(request.path), String(request.origin));
    let authority;
    if (connect) {
      authority = String(request.path);
      const target = new URL('https://' + authority);
      if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+):[0-9]+$/iu.test(authority)
        || !target.hostname || target.username || target.password || target.pathname !== '/' || target.search || target.hash)
        throw new Error('INVALID_CONNECT_AUTHORITY');
    }
    if (requests.has(request)) throw new Error('DUPLICATE_REQUEST');
    const row = { id: `${process.pid}:${++sequence}`, at: new Date().toISOString(), started_ms: performance.now(),
      method: request.method, origin: url.origin, path: connect ? null : url.pathname,
      ...(connect ? { transport: 'proxy-connect', authority } : {}), bytes: 0,
      hash: crypto.createHash('sha256'), sent: false, status: null, responseId: null,
      responseIdSource: null, encoding: 'identity', json: false, responseBytes: 0, responseChunks: [] };
    requests.set(request, row);
    active.add(request);
    // Creation precedes connection and TLS errors. Retain its identity even if
    // no request body is sent and consequently no response ID can exist.
    write({ event: 'http_created', id: row.id, at: row.at, started_ms: row.started_ms,
      method: row.method, origin: row.origin, path: row.path,
      ...(row.transport ? { transport: row.transport, authority: row.authority } : {}) });
  });
  subscribe('bodyChunkSent', ({ request, chunk }) => {
    const row = requestOf(request);
    if (row.sent) throw new Error('REQUEST_BODY_ALREADY_FINISHED');
    row.bytes += Buffer.byteLength(chunk); row.hash.update(chunk);
  });
  subscribe('bodySent', ({ request }) => {
    const row = requestOf(request);
    if (row.sent) throw new Error('DUPLICATE_REQUEST_BODY');
    row.sent = true;
    write({ event: 'http_start', id: row.id, at: row.at, method: row.method, origin: row.origin, path: row.path,
      ...(row.transport ? { transport: row.transport, authority: row.authority } : {}),
      started_ms: row.started_ms, request_bytes: row.bytes, request_sha256: row.hash.digest('hex'), observation: 'undici-request-body-sent' });
  });
  subscribe('headers', ({ request, response }) => {
    const row = requestOf(request), headers = response.headers;
    if (row.status !== null) throw new Error('DUPLICATE_RESPONSE_HEADERS');
    row.status = response.statusCode;
    for (let i = 0; i + 1 < headers.length; i += 2) {
      const decode = value => ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8') : String(value);
      const name = decode(headers[i]).toLowerCase(), value = decode(headers[i + 1]);
      if (['x-request-id', 'request-id'].includes(name) && validRequestId(value)) { row.responseId = value; row.responseIdSource = 'response-header'; }
      if (name === 'content-type') row.json = bodyIdOrigins.has(row.origin) && /^application\/json(?:\s*;|$)/iu.test(value);
      if (name === 'content-encoding') row.encoding = value.toLowerCase();
    }
  });
  subscribe('bodyChunkReceived', ({ request, chunk }) => {
    const row = requestOf(request);
    row.responseBytes += chunk.byteLength;
    // Only bounded JSON from the exact Notion origin is retained privately.
    // Loopback tests may explicitly inject their own origin. No response body
    // is written to the ledger or substituted for the consumer's stream.
    if (row.json && row.responseId === null && row.responseBytes <= bodyLimit) row.responseChunks.push(Buffer.from(chunk));
    else row.responseChunks.length = 0;
  });
  subscribe('trailers', ({ request }) => {
    const row = requestOf(request);
    if (!row.sent || row.status === null) throw new Error('INCOMPLETE_HTTP');
    active.delete(request);
    if (row.responseId === null && row.json && row.responseBytes <= bodyLimit) {
      try {
        let body = Buffer.concat(row.responseChunks);
        const decode = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync }[row.encoding];
        if (decode) body = decode(body, { maxOutputLength: bodyLimit });
        else if (row.encoding !== 'identity') throw new Error('UNKNOWN_RESPONSE_ENCODING');
        const value = JSON.parse(body.toString('utf8'))?.request_id;
        if (validRequestId(value)) { row.responseId = value; row.responseIdSource = 'response-json'; }
      } catch { /* Missing IDs remain unknown; no heuristic attribution. */ }
    }
    row.responseChunks.length = 0;
    write({ event: 'http_end', id: row.id, status: row.status, response_request_id: row.responseId,
      response_request_id_source: row.responseIdSource, ended_ms: performance.now(), observation: 'undici-response-trailers' });
  });
  subscribe('error', ({ request, error }) => {
    const row = requestOf(request); active.delete(request);
    row.responseChunks.length = 0;
    write({ event: 'http_error', id: row.id, code: error?.code ?? error?.name ?? 'unknown',
      method: row.method, origin: row.origin, path: row.path,
      ...(row.transport ? { transport: row.transport, authority: row.authority } : {}),
      started_ms: row.started_ms, ended_ms: performance.now(),
      request_body_sent: row.sent, sent_request_bytes: row.bytes, status: row.status, response_request_id: row.responseId,
      error: { name: error?.name ?? null, code: error?.code ?? null, message: error?.message ?? null,
        errno: error?.errno ?? null, syscall: error?.syscall ?? null } });
  });
  process.once('exit', () => write({ event: 'http_observer_end', errors: observerErrors,
    complete: observerErrors === 0 && active.size === 0,
    pending: [...active].map(request => requests.get(request).id), method: 'undici-diagnostics-channel' }));
}

export function dailyObserverPreloadSource(config) {
  return `(${installPassiveObserver.toString()})(${JSON.stringify(config)}, (${identifySourcePackageEntry.toString()}));\n`;
}


export async function observedRows(directory) {
  const names = (await readdir(directory)).filter(name => /^observer-[0-9]+\.jsonl$/u.test(name));
  return (await Promise.all(names.map(async name => (await readFile(join(directory, name), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)))).flat();
}
export async function ownedPiProcesses(path) {
  const rows = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  return rows.filter(row => row.event === 'spawn').map(row => {
    const end = rows.find(end => end.event === 'close' && end.pid === row.pid && end.observedExit);
    return { pid: row.pid, file: row.file, args: row.args, cwd: row.cwd,
      observed_close: Boolean(end), exit_code: end?.code ?? null, signal: end?.signal ?? null };
  });
}
