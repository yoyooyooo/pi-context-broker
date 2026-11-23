import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const bytes = value => Buffer.from(canonical(value) + '\n');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value);
const within = (root, file) => { const value = relative(root, file); return value === '' || value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value); };
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const publicRoot = runRoot => join(runRoot, 'benchmark/turn-bridge');
const packetName = sequence => String(sequence).padStart(6, '0') + '.json';
const defaults = { wallMs: 360000, waitMs: 90000, pollMs: 25, eventMs: 30000, maxPacketBytes: 65536, maxEvidenceBytes: 64 * 1024 * 1024 };

export class TurnBridgeError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'TurnBridgeError'; this.code = code; this.details = details; }
}
function limits(input = {}) {
  const result = { ...defaults, ...input };
  for (const [key, value] of Object.entries(result)) assert.ok(Number.isSafeInteger(value) && value > 0, 'TURN_BRIDGE_LIMIT: ' + key);
  assert.ok(result.pollMs <= 1000 && result.eventMs <= result.waitMs, 'TURN_BRIDGE_LIMIT_ORDER');
  return result;
}
async function ownedDirectory(directory, { create = false } = {}) {
  assert.ok(isAbsolute(directory) && resolve(directory) === directory, 'TURN_BRIDGE_ABSOLUTE_PATH');
  if (create && !await exists(directory)) {
    await ownedDirectory(dirname(directory), { create: true });
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  assert.ok((await lstat(directory)).isDirectory() && !((await lstat(directory)).isSymbolicLink()), 'TURN_BRIDGE_DIRECTORY_REQUIRED');
  assert.equal(await realpath(directory), directory, 'TURN_BRIDGE_SYMLINK_PATH');
  return directory;
}
async function readOwned(file, roots, maximum) {
  assert.ok(isAbsolute(file) && roots.some(root => within(root, file)), 'TURN_BRIDGE_EVIDENCE_ESCAPE');
  assert.equal(await realpath(file), file, 'TURN_BRIDGE_SYMLINK_PATH');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    assert.ok(before.isFile() && before.size <= maximum, 'TURN_BRIDGE_FILE_LIMIT');
    const value = await handle.readFile(), after = await handle.stat();
    assert.ok(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'TURN_BRIDGE_FILE_CHANGED');
    return value;
  } finally { await handle.close(); }
}
async function readPacket(file, root, maximum) { return JSON.parse(await readOwned(file, [root], maximum)); }

/** Hard-link publication is exclusive and atomic. Staging files are retained as
 * evidence; neither a previous packet nor a partial write is overwritten. */
async function publish(file, value) {
  const content = bytes(value), directory = dirname(file);
  await ownedDirectory(directory, { create: true });
  const existingMatches = async () => assert.ok((await readOwned(file, [directory], content.length + 1)).equals(content), 'TURN_BRIDGE_IMMUTABLE_PACKET_CHANGED');
  if (await exists(file)) { await existingMatches(); return hash(content); }
  const staging = join(directory, '.staged-' + randomUUID() + '.json');
  const handle = await open(staging, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await chmod(staging, 0o400);
  try { await link(staging, file); }
  catch (error) { if (error.code !== 'EEXIST') throw error; await existingMatches(); }
  const parent = await open(directory, constants.O_RDONLY);
  try { await parent.sync(); } finally { await parent.close(); }
  return hash(content);
}

export async function readTurnBridgeJournal(file) {
  const content = await readFile(file, 'utf8');
  assert.ok(!content || content.endsWith('\n'), 'TURN_BRIDGE_TRUNCATED_JOURNAL');
  const rows = content.trimEnd() ? content.trimEnd().split('\n').map(JSON.parse) : [];
  let previous = null;
  for (const [index, row] of rows.entries()) {
    const { sha256, ...body } = row;
    assert.equal(row.sequence, index + 1); assert.equal(row.previous_sha256, previous);
    assert.equal(sha256, hash(bytes(body)), 'TURN_BRIDGE_JOURNAL_HASH'); previous = sha256;
  }
  return rows;
}
async function journal(file, identity) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  let rows;
  try {
    rows = await readTurnBridgeJournal(file);
    for (const row of rows) for (const [key, value] of Object.entries(identity)) assert.equal(row[key], value, 'TURN_BRIDGE_JOURNAL_IDENTITY');
  } catch (error) { await handle.close(); throw error; }
  return { rows,
    async append(type, data = {}) {
      const body = { version: 1, ...identity, sequence: rows.length + 1, previous_sha256: rows.at(-1)?.sha256 ?? null,
        type, monotonic_ns: process.hrtime.bigint().toString(), wall_time: new Date().toISOString(), data };
      const row = { ...body, sha256: hash(bytes(body)) };
      await handle.write(bytes(row)); await handle.sync(); rows.push(row);
      return { path: file, line: row.sequence, sha256: row.sha256, hash_scope: 'journal-row' };
    },
    async close() { await handle.close(); return { path: file, sha256: hash(await readFile(file)), rows: rows.length }; },
  };
}
async function acquireOwner(directory) {
  const file = join(directory, 'controller.owner.json');
  if (await exists(file)) {
    const previous = await readPacket(file, directory, defaults.maxPacketBytes);
    assert.ok(Number.isSafeInteger(previous.pid) && previous.pid > 0, 'TURN_BRIDGE_OWNER_INVALID');
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) throw new TurnBridgeError('TURN_BRIDGE_CONTROLLER_ALREADY_LIVE', { pid: previous.pid });
    await rename(file, join(directory, 'controller.owner.recovered-' + randomUUID() + '.json'));
  }
  const identity = { version: 1, pid: process.pid, nonce: randomUUID() };
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes(identity)); await handle.sync(); } finally { await handle.close(); }
  return async () => {
    assert.deepEqual(await readPacket(file, directory, defaults.maxPacketBytes), identity, 'TURN_BRIDGE_OWNER_CHANGED');
    await rename(file, join(directory, 'controller.owner.finished-' + identity.nonce + '.json'));
  };
}
function identity(config) {
  assert.ok(validId(config.runId) && validId(config.episodeId), 'TURN_BRIDGE_ID_REQUIRED');
  assert.ok(isAbsolute(config.runRoot) && resolve(config.runRoot) === config.runRoot, 'TURN_BRIDGE_ABSOLUTE_PATH');
  return { run_id: config.runId, episode_id: config.episodeId };
}
function validateTurns(turns) {
  assert.ok(Array.isArray(turns) && turns.length > 0, 'TURN_BRIDGE_TURNS_REQUIRED');
  assert.ok(turns.every(turn => validId(turn.id) && typeof turn.prompt === 'string' && turn.prompt.trim()), 'TURN_BRIDGE_TURN_INVALID');
  assert.equal(new Set(turns.map(turn => turn.id)).size, turns.length, 'TURN_BRIDGE_DUPLICATE_TURN');
}
function checkIdentity(packet, expected) {
  assert.equal(packet.version, 1);
  for (const key of ['bridge_id', 'run_id', 'episode_id']) assert.equal(packet[key], expected[key], 'TURN_BRIDGE_PACKET_IDENTITY');
}
async function boundedCall(callback, milliseconds) {
  const abort = new AbortController(); let timer;
  const operation = Promise.resolve().then(() => callback(abort.signal));
  operation.catch(() => {});
  try {
    return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => {
      abort.abort(new TurnBridgeError('TURN_BRIDGE_EVENT_TIMEOUT'));
      reject(new TurnBridgeError('TURN_BRIDGE_EVENT_TIMEOUT'));
    }, milliseconds); })]);
  } finally { clearTimeout(timer); }
}
async function actualCheckpoint(request, config, sessionId) {
  const file = join(config.runRoot, 'benchmark/runtime/events.jsonl');
  assert.equal(request.ref?.artifact_id, 'events');
  assert.ok(Number.isSafeInteger(request.ref.line) && request.ref.line > 0, 'TURN_BRIDGE_PAUSE_REF_REQUIRED');
  // The runtime is append-only and paused, but unrelated background observations
  // can still append. Bind the immutable observed prefix, not the eventual file.
  assert.equal(await realpath(file), file, 'TURN_BRIDGE_SYMLINK_PATH');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let content;
  try {
    const info = await handle.stat(); assert.ok(info.isFile() && info.size <= config.limits.maxEvidenceBytes, 'TURN_BRIDGE_FILE_LIMIT');
    content = Buffer.alloc(info.size); assert.equal((await handle.read(content, 0, content.length, 0)).bytesRead, content.length);
    let prefixEnd = -1;
    for (let line = 0; line < request.ref.line; line++) {
      prefixEnd = content.indexOf(10, prefixEnd + 1);
      assert.ok(prefixEnd >= 0, 'TURN_BRIDGE_PAUSE_PREFIX_INCOMPLETE');
    }
    const again = Buffer.alloc(prefixEnd + 1); assert.equal((await handle.read(again, 0, again.length, 0)).bytesRead, again.length);
    assert.ok(content.subarray(0, again.length).equals(again), 'TURN_BRIDGE_PAUSE_PREFIX_CHANGED');
    content = again;
  } finally { await handle.close(); }
  const lines = content.toString('utf8').split('\n');
  assert.ok(lines.length > request.ref.line, 'TURN_BRIDGE_PAUSE_PREFIX_INCOMPLETE');
  const prefix = lines.slice(0, request.ref.line).join('\n') + '\n', rows = lines.slice(0, request.ref.line).map(JSON.parse);
  assert.ok(rows.every((row, index) => row.sequence === index + 1), 'TURN_BRIDGE_RUNTIME_SEQUENCE');
  const pause = rows.at(-1), end = rows.findLast(row => row.type === 'user_turn_end' && row.data?.id === request.turn_id);
  for (const row of [pause, end]) {
    assert.ok(row && row.run_id === config.runId && row.episode_id === config.episodeId, 'TURN_BRIDGE_RUNTIME_IDENTITY');
    assert.equal(row.turn_id, request.turn_id, 'TURN_BRIDGE_RUNTIME_TURN');
  }
  assert.equal(pause.type, 'controller_pause_start'); assert.equal(pause.data.turn_id, request.turn_id);
  assert.equal(pause.sequence, request.ref.line);
  assert.ok(end.sequence < pause.sequence && end.data.settled === true && end.data.is_idle === true, 'TURN_BRIDGE_TURN_NOT_SETTLED');
  assert.ok(typeof end.data.session_id === 'string' && end.data.session_id.length > 0, 'TURN_BRIDGE_SESSION_REQUIRED');
  if (sessionId) assert.equal(end.data.session_id, sessionId, 'TURN_BRIDGE_SESSION_CHANGED');
  return { session_id: end.data.session_id, final_text: end.data.final_text ?? null,
    ref: { path: file, prefix_sha256: hash(prefix), through_line: request.ref.line, line: end.sequence } };
}
async function verifiedReceipt(value, config, eventId) {
  if (!value || value.effect_unknown === true || !['applied', 'blocked', 'failed', 'not_applied'].includes(value.status))
    return { status: 'unknown', reason: 'missing-or-unknown-effect', reported: value ?? null };
  const receipt = value.receipt;
  if (value.event_id !== eventId || value.episode_id !== undefined && value.episode_id !== config.episodeId)
    return { status: 'unknown', reason: 'wrong-event-or-episode', reported: value };
  if (!receipt || !isAbsolute(receipt.path) || !/^[a-f0-9]{64}$/.test(receipt.sha256))
    return { status: 'unknown', reason: 'missing-effect-receipt', reported: value };
  try {
    const content = await readOwned(receipt.path, [config.runRoot, config.controllerRoot, ...(config.evidenceRoots ?? [])], config.limits.maxEvidenceBytes);
    assert.equal(hash(content), receipt.sha256, 'TURN_BRIDGE_EFFECT_RECEIPT_CHANGED');
    const actual = JSON.parse(content);
    assert.equal(actual.event_id, value.event_id, 'TURN_BRIDGE_EVENT_RECEIPT_ID');
    assert.equal(actual.episode_id, config.episodeId, 'TURN_BRIDGE_EVENT_RECEIPT_EPISODE');
    assert.equal(actual.status, value.status, 'TURN_BRIDGE_EVENT_RECEIPT_STATUS');
    return structuredClone(value);
  } catch (error) { return { status: 'unknown', reason: error.message, reported: value }; }
}

/** Parent-only preparation. The plan and event receipts remain outside the run;
 * creating this object does not create the shared launcher's run directory. */
export async function createTurnBridgeController(input) {
  const config = { ...input, limits: limits(input.limits) }, ids = identity(config);
  validateTurns(config.turns);
  assert.ok(isAbsolute(config.controllerRoot) && !within(config.runRoot, config.controllerRoot) && !within(config.controllerRoot, config.runRoot), 'TURN_BRIDGE_PRIVATE_ROOT_REQUIRED');
  await ownedDirectory(config.controllerRoot, { create: true });
  for (const root of config.evidenceRoots ?? []) await ownedDirectory(root);
  const events = structuredClone(config.events ?? []), clarifications = (config.clarifications ?? []).map(({ topic_id, max_questions, response }) => ({ topic_id, max_questions, response }));
  assert.equal(new Set(events.map(event => event.id)).size, events.length, 'TURN_BRIDGE_DUPLICATE_EVENT');
  for (const event of events) {
    assert.ok(validId(event.id) && typeof event.kind === 'string' && config.turns.slice(1).some(turn => turn.id === event.before_turn), 'TURN_BRIDGE_EVENT_BOUNDARY');
  }
  for (const item of clarifications) assert.ok(validId(item.topic_id) && Number.isSafeInteger(item.max_questions) && item.max_questions > 0 && typeof item.response === 'string' && item.response.trim(), 'TURN_BRIDGE_CLARIFICATION_INVALID');
  assert.equal(new Set(clarifications.map(item => item.topic_id)).size, clarifications.length, 'TURN_BRIDGE_DUPLICATE_TOPIC');
  const plan = { version: 1, ...ids, turns: structuredClone(config.turns), events, clarifications, limits: config.limits, policy: config.policy ?? null };
  const planPath = join(config.controllerRoot, 'plan.json');
  const planSha256 = await publish(planPath, plan), releaseOwner = await acquireOwner(config.controllerRoot);
  let log;
  try { log = await journal(join(config.controllerRoot, 'controller.jsonl'), ids); }
  catch (error) { await releaseOwner(); throw error; }
  const remembered = log.rows.find(row => row.type === 'controller_prepared');
  const bridgeId = remembered?.data.bridge_id ?? randomUUID();
  if (remembered) assert.equal(remembered.data.plan_sha256, planSha256, 'TURN_BRIDGE_PLAN_CHANGED');
  else await log.append('controller_prepared', { bridge_id: bridgeId, plan_sha256: planSha256 });
  let served = false;
  return {
    plan: { path: planPath, sha256: planSha256 },
    publicConfig: { runRoot: config.runRoot, runId: config.runId, episodeId: config.episodeId, limits: config.limits },
    async abandon(reason = 'TURN_BRIDGE_SUBJECT_NOT_LAUNCHED') {
      assert.equal(served, false, 'TURN_BRIDGE_CONTROLLER_ALREADY_SERVED'); served = true;
      const result = { version: 1, ...ids, status: 'stopped', reason, completed_checkpoints: 0, dispatched: false };
      await log.append('controller_end', result);
      result.journal = await log.close(); await releaseOwner(); return result;
    },
    async serve({ subject, executeEvent, reconcileEvent, selectClarification, signal } = {}) {
      assert.equal(served, false, 'TURN_BRIDGE_CONTROLLER_ALREADY_SERVED'); served = true;
      assert.ok(subject && typeof subject.then === 'function', 'TURN_BRIDGE_SUBJECT_PROMISE_REQUIRED');
      let subjectEnded = false, subjectError, sessionId, result, pendingRequest, sequence = 1;
      Promise.resolve(subject).then(() => { subjectEnded = true; }, error => { subjectEnded = true; subjectError = String(error?.message ?? error); });
      const started = performance.now(), queue = [...plan.turns], delivered = new Map(), root = publicRoot(config.runRoot);
      const envelope = { version: 1, bridge_id: bridgeId, ...ids };
      const decisions = new Map(log.rows.filter(row => row.type === 'checkpoint_decided').map(row => [row.data.response.sequence, row.data]));
      const stopReason = () => signal?.aborted ? 'TURN_BRIDGE_CANCELLED' : subjectEnded ? 'TURN_BRIDGE_SUBJECT_ENDED' : performance.now() - started > config.limits.wallMs ? 'TURN_BRIDGE_CONTROLLER_TIMEOUT' : null;
      const awaitPath = async file => {
        const began = performance.now();
        while (!await exists(file)) { const reason = stopReason(); if (reason) throw new TurnBridgeError(reason);
          if (performance.now() - began > config.limits.waitMs) throw new TurnBridgeError('TURN_BRIDGE_CHECKPOINT_TIMEOUT');
          await delay(config.limits.pollMs); }
      };
      // The shared launcher creates run.json before its initial write has
      // completed. Existence is not publication; use one fixed deadline while
      // waiting for stable, parseable bytes. Parsed identity errors are terminal.
      const awaitRunManifest = async () => {
        const file = join(config.runRoot, 'run.json'), began = performance.now();
        let last = null, attempts = 0, recordedPending = false;
        for (;;) {
          const reason = stopReason() ?? (performance.now() - began >= config.limits.waitMs ? 'TURN_BRIDGE_RUN_MANIFEST_TIMEOUT' : null);
          if (reason) {
            if (last) await log.append('run_manifest_unavailable', { reason, elapsed_ms: performance.now() - began, attempts, last_observation: last });
            throw new TurnBridgeError(reason);
          }
          if (await exists(file)) {
            let content;
            attempts++;
            try { content = await readOwned(file, [config.runRoot], config.limits.maxPacketBytes); }
            catch (error) {
              if (error.code !== 'ERR_ASSERTION' || !error.message.includes('TURN_BRIDGE_FILE_CHANGED')) throw error;
              last = { path: file, status: 'changed_during_read' };
            }
            if (content !== undefined) {
              let parsed, incomplete = false;
              try { parsed = JSON.parse(content); }
              catch (error) { if (!(error instanceof SyntaxError)) throw error; incomplete = true; }
              const observed = { path: file, sha256: hash(content), bytes: content.length };
              if (!incomplete) {
                if (recordedPending) await log.append('run_manifest_observed', { ...observed, elapsed_ms: performance.now() - began, attempts });
                return parsed;
              }
              // Do not put JSON parser excerpts (which can contain arbitrary
              // file text) in the journal. The retained path/hash owns the fact.
              last = { ...observed, status: 'json_incomplete_or_invalid' };
            }
            if (!recordedPending) {
              await log.append('run_manifest_pending', { deadline_ms: config.limits.waitMs, observation: last });
              recordedPending = true;
            }
          }
          await delay(Math.min(config.limits.pollMs, Math.max(1, config.limits.waitMs - (performance.now() - began))));
        }
      };
      const eventState = id => log.rows.filter(row => row.data?.event_id === id && ['event_started', 'event_result'].includes(row.type)).at(-1);
      const applyEvent = async event => {
        const prior = eventState(event.id), idempotencyKey = hash(canonical({ ...ids, plan_sha256: planSha256, event_id: event.id }));
        if (prior?.type === 'event_result') return prior.data.result.status === 'unknown' ? prior.data.result : verifiedReceipt(prior.data.result, config, event.id);
        const callContext = { event: structuredClone(event), eventId: event.id, episodeId: config.episodeId, runId: config.runId, idempotencyKey };
        if (prior?.type === 'event_started') {
          let reconciled;
          try { reconciled = await verifiedReceipt(await boundedCall(abortSignal => reconcileEvent ? reconcileEvent({ ...callContext, signal: abortSignal }) : { status: 'unknown' }, config.limits.eventMs), config, event.id); }
          catch (error) { reconciled = { status: 'unknown', reason: error.message }; }
          await log.append('event_reconciled', { event_id: event.id, idempotency_key: idempotencyKey, result: reconciled });
          if (reconciled.status !== 'not_applied') {
            await log.append('event_result', { event_id: event.id, idempotency_key: idempotencyKey, result: reconciled }); return reconciled;
          }
        }
        await log.append('event_started', { event_id: event.id, idempotency_key: idempotencyKey });
        let value;
        try { value = await verifiedReceipt(await boundedCall(abortSignal => executeEvent ? executeEvent({ ...callContext, signal: abortSignal }) : { status: 'unknown' }, config.limits.eventMs), config, event.id); }
        catch (error) { value = { status: 'unknown', reason: error.message }; }
        if (value.event_id !== undefined && value.event_id !== event.id) value = { status: 'unknown', reason: 'event-receipt-wrong-event' };
        await log.append('event_result', { event_id: event.id, idempotency_key: idempotencyKey, result: value }); return value;
      };
      try {
        const shared = await awaitRunManifest(); await ownedDirectory(config.runRoot);
        assert.ok(shared && typeof shared === 'object' && !Array.isArray(shared), 'TURN_BRIDGE_SHARED_RUN_ID');
        assert.equal(shared.run_id, config.runId, 'TURN_BRIDGE_SHARED_RUN_ID');
        await ownedDirectory(root, { create: true });
        await ownedDirectory(join(root, 'requests'), { create: true }); await ownedDirectory(join(root, 'receipts'), { create: true });
        await publish(join(root, 'ready.json'), { ...envelope, kind: 'benchmark-turn-bridge', turn_ids: plan.turns.map(turn => turn.id) });
        for (let index = 0; index < queue.length; index++, sequence++) {
          const file = join(root, 'requests', packetName(sequence)); await awaitPath(file);
          const stopped = stopReason(); if (stopped) throw new TurnBridgeError(stopped);
          const content = await readOwned(file, [root], config.limits.maxPacketBytes), request = JSON.parse(content);
          checkIdentity(request, envelope); assert.equal(request.kind, 'benchmark-turn-checkpoint');
          assert.equal(request.sequence, sequence); assert.equal(request.turn_index, index); assert.equal(request.turn_id, queue[index].id, 'TURN_BRIDGE_UNEXPECTED_TURN');
          const requestSha256 = hash(content), recorded = decisions.get(sequence);
          pendingRequest = { request, requestSha256 };
          let decision;
          if (recorded) {
            assert.equal(recorded.request_sha256, requestSha256, 'TURN_BRIDGE_CHECKPOINT_CHANGED'); decision = recorded;
            sessionId = recorded.session_id;
            const accepted = log.rows.find(row => row.type === 'checkpoint_accepted' && row.data.sequence === sequence && row.data.request_sha256 === requestSha256);
            if (accepted) {
              const observation = await actualCheckpoint(request, config, sessionId);
              assert.equal(observation.ref.prefix_sha256, accepted.data.observation.ref.prefix_sha256, 'TURN_BRIDGE_ACCEPTED_PREFIX_CHANGED');
            }
          } else {
            const observation = await actualCheckpoint(request, config, sessionId); sessionId = observation.session_id;
            await log.append('checkpoint_accepted', { sequence, turn_id: request.turn_id, request_sha256: requestSha256, observation });
            let action = 'continue', reason = null, continuation = null, topicId = null;
            const available = clarifications.filter(item => (delivered.get(item.topic_id) ?? 0) < item.max_questions);
            if (selectClarification && available.length > 0) {
              const selected = await boundedCall(abortSignal => selectClarification({ turn: structuredClone(queue[index]), observation, available: structuredClone(available), signal: abortSignal }), config.limits.eventMs);
              if (selected !== null && selected !== undefined) {
                topicId = typeof selected === 'string' ? selected : selected.topic_id;
                const allowed = available.find(item => item.topic_id === topicId);
                assert.ok(allowed, 'TURN_BRIDGE_UNAPPROVED_CLARIFICATION');
                const count = [...delivered.values()].reduce((a, b) => a + b, 0) + 1;
                continuation = { id: 'clarification-' + count, kind: 'clarification', prompt: allowed.response };
                assert.ok(!queue.some(turn => turn.id === continuation.id), 'TURN_BRIDGE_CLARIFICATION_ID_COLLISION');
              }
            }
            if (!continuation) for (const event of events.filter(event => event.before_turn === queue[index + 1]?.id)) {
              const outcome = await applyEvent(event);
              if (outcome.status !== 'applied') { action = 'stop'; reason = 'CONTROLLER_EVENT_UNVERIFIED'; break; }
            }
            const response = { ...envelope, kind: 'benchmark-turn-receipt', sequence, turn_id: request.turn_id,
              request_sha256: requestSha256, action, reason, ...(continuation ? { continuation } : {}) };
            decision = { request_sha256: requestSha256, session_id: sessionId, topic_id: topicId, response };
            await log.append('checkpoint_decided', decision); decisions.set(sequence, decision);
          }
          await publish(join(root, 'receipts', packetName(sequence)), decision.response);
          pendingRequest = null;
          if (decision.response.continuation) {
            delivered.set(decision.topic_id, (delivered.get(decision.topic_id) ?? 0) + 1);
            queue.splice(index + 1, 0, decision.response.continuation);
          }
          if (decision.response.action === 'stop') { result = { status: 'stopped', reason: decision.response.reason, completed_checkpoints: sequence }; break; }
        }
        result ??= { status: 'completed', completed_checkpoints: sequence - 1 };
      } catch (error) {
        result = { status: 'stopped', reason: error instanceof TurnBridgeError ? error.code : error.message,
          error_code: error.code ?? null, completed_checkpoints: sequence - 1, ...(subjectError ? { subject_error: subjectError } : {}) };
        await log.append('controller_error', { reason: result.reason });
        if (pendingRequest) {
          const { request, requestSha256 } = pendingRequest;
          const response = { ...envelope, kind: 'benchmark-turn-receipt', sequence, turn_id: request.turn_id,
            request_sha256: requestSha256, action: 'stop', reason: 'CONTROLLER_CHECKPOINT_UNVERIFIED' };
          try {
            if (!decisions.has(sequence)) await log.append('checkpoint_decided', { request_sha256: requestSha256, session_id: sessionId ?? null, topic_id: null, response });
            await publish(join(root, 'receipts', packetName(sequence)), response);
          } catch (publicationError) { await log.append('stop_receipt_unpublished', { reason: publicationError.message }); }
        }
      } finally {
        await log.append('controller_end', result);
        result.journal = await log.close(); await releaseOwner();
      }
      return { version: 1, ...ids, ...result, plan: { path: planPath, sha256: planSha256 }, public_root: root };
    },
  };
}

/** Subject-only public interface. The caller passes the very same turns array to
 * runEpisode; an approved public response is inserted before its next turn. */
export async function connectTurnBridge(input) {
  const config = { ...input, limits: limits(input.limits) }, ids = identity(config);
  validateTurns(config.turns); await ownedDirectory(config.runRoot);
  const root = publicRoot(config.runRoot), started = performance.now();
  let index = 0, busy = false, closed = false, closing;
  const waitFor = async file => {
    const began = performance.now();
    while (!await exists(file)) {
      if (closed || config.signal?.aborted) throw new TurnBridgeError('TURN_BRIDGE_CANCELLED');
      if (performance.now() - began > config.limits.waitMs) throw new TurnBridgeError('TURN_BRIDGE_RECEIPT_TIMEOUT');
      await delay(config.limits.pollMs);
    }
  };
  await waitFor(join(root, 'ready.json')); await ownedDirectory(root);
  const ready = await readPacket(join(root, 'ready.json'), root, config.limits.maxPacketBytes);
  assert.equal(ready.kind, 'benchmark-turn-bridge'); checkIdentity(ready, { ...ids, bridge_id: ready.bridge_id });
  assert.equal(typeof ready.bridge_id, 'string'); assert.deepEqual(ready.turn_ids, config.turns.map(turn => turn.id));
  const log = await journal(join(root, 'subject.jsonl'), { ...ids, bridge_id: ready.bridge_id });
  assert.equal(log.rows.length, 0, 'TURN_BRIDGE_SUBJECT_ALREADY_CONNECTED');
  await log.append('subject_connected', { pid: process.pid, handshake_ms: performance.now() - started });
  const completed = new Map();
  return {
    async afterTurn({ turn_id, ref }) {
      assert.equal(closed, false, 'TURN_BRIDGE_SUBJECT_CLOSED'); assert.equal(busy, false, 'TURN_BRIDGE_CONCURRENT_CHECKPOINT');
      if (completed.has(turn_id)) {
        const prior = completed.get(turn_id); assert.deepEqual(prior.ref, ref, 'TURN_BRIDGE_DUPLICATE_TURN_CHANGED'); return prior.response;
      }
      busy = true;
      try {
        assert.equal(turn_id, config.turns[index]?.id, 'TURN_BRIDGE_UNEXPECTED_TURN');
        assert.ok(ref?.artifact_id === 'events' && Number.isSafeInteger(ref.line) && ref.line > 0, 'TURN_BRIDGE_PAUSE_REF_REQUIRED');
        const sequence = index + 1, request = { version: 1, bridge_id: ready.bridge_id, ...ids, kind: 'benchmark-turn-checkpoint', sequence,
          turn_index: index, turn_id, ref: { artifact_id: 'events', line: ref.line } };
        const requestSha256 = await publish(join(root, 'requests', packetName(sequence)), request);
        await log.append('checkpoint_requested', { sequence, turn_id, request_sha256: requestSha256, ref: request.ref });
        const receiptFile = join(root, 'receipts', packetName(sequence)); await waitFor(receiptFile);
        if (closed || config.signal?.aborted) throw new TurnBridgeError('TURN_BRIDGE_CANCELLED');
        const response = await readPacket(receiptFile, root, config.limits.maxPacketBytes);
        checkIdentity(response, ready); assert.equal(response.kind, 'benchmark-turn-receipt');
        assert.equal(response.sequence, sequence); assert.equal(response.turn_id, turn_id); assert.equal(response.request_sha256, requestSha256);
        assert.ok(['continue', 'stop'].includes(response.action), 'TURN_BRIDGE_ACTION_INVALID');
        await log.append('checkpoint_received', { sequence, turn_id, response_sha256: hash(await readFile(receiptFile)), action: response.action });
        if (response.action === 'stop') throw new TurnBridgeError('TURN_BRIDGE_CONTROLLER_STOP', { reason: response.reason });
        if (response.continuation) {
          const turn = response.continuation;
          assert.deepEqual(Object.keys(turn).sort(), ['id', 'kind', 'prompt']);
          assert.ok(validId(turn.id) && turn.kind === 'clarification' && typeof turn.prompt === 'string' && turn.prompt.trim(), 'TURN_BRIDGE_PUBLIC_TURN_INVALID');
          assert.ok(!config.turns.some(existing => existing.id === turn.id), 'TURN_BRIDGE_DUPLICATE_PUBLIC_TURN');
          config.turns.splice(index + 1, 0, structuredClone(turn));
        }
        completed.set(turn_id, { ref: structuredClone(ref), response }); index++; return response;
      } finally { busy = false; }
    },
    async close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => { while (busy) await delay(config.limits.pollMs);
        await log.append('subject_closed', { completed_checkpoints: index }); return log.close(); })();
      return closing;
    },
  };
}
