import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson } from './protocol.mjs';

export const TURN_COLLECTION_VERSION = '1.0.0';
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const within = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const shaPattern = /^[a-f0-9]{64}$/;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const ref = (artifact, pointer = '') => ({ artifact_id: artifact.id, sha256: artifact.sha256, pointer });
const lineRef = (artifact, line) => ({ artifact_id: artifact.id, sha256: artifact.sha256, line });
const packet = sequence => String(sequence).padStart(6, '0') + '.json';

function readJournal(bytes, expected, runId) {
  const text = bytes.toString('utf8');
  assert.ok(text.endsWith('\n'), 'TURN_CONTROL_TRUNCATED_JOURNAL');
  const rows = text.trimEnd().split('\n').map(JSON.parse);
  assert.equal(rows.length, expected.rows, 'TURN_CONTROL_JOURNAL_ROWS');
  let previous = null;
  for (const [index, row] of rows.entries()) {
    const { sha256, ...body } = row;
    assert.equal(row.version, 1); assert.equal(row.sequence, index + 1);
    assert.equal(row.run_id, runId); assert.equal(row.episode_id, runId);
    assert.equal(row.previous_sha256, previous);
    assert.equal(sha256, hash(canonicalJson(body) + '\n'), 'TURN_CONTROL_JOURNAL_HASH');
    previous = sha256;
  }
  return rows;
}

/** Reads only retained facts. Private plan bytes are checked, never registered
 * as analysis/public artifacts. No producer or execution module is imported. */
export async function readTurnControlEvidence({ raw, binding, environmentRoot, runRoot, runId,
  episode, eventArtifact, eventBytes, knownArtifacts = [] }) {
  const verification = raw.turn_control_verification;
  const declaredTurns = binding.public_case?.turns ?? [];
  const bindingRequired = declaredTurns.length > 1 || (binding.events?.length ?? 0) > 0 ||
    (binding.clarification?.length ?? 0) > 0;
  const required = bindingRequired || raw.turn_control != null || verification?.required === true ||
    verification != null && verification.status !== 'absent';
  const sources = [], problems = [];
  const summary = { schema_version: 1, collector_version: TURN_COLLECTION_VERSION, required,
    status: required ? 'unavailable' : 'absent', controller_status: raw.turn_control?.status ?? null,
    verified_completed: false, receipt: null, completed_checkpoints: null, refs: [],
    dispatch_error: raw.dispatch_error ?? null, reason: null,
    scope: 'Controller completion and observed subject checkpoints; private plan content excluded' };
  if (raw.dispatch_error != null) problems.push('subject_dispatch_error');
  if (!required) {
    if (verification && (verification.required !== false || verification.result != null || verification.receipt != null))
      problems.push('turn_control_absent_receipt_inconsistent');
    return { summary, problems, sources, checkpoints: [], control: null };
  }
  let control = null, checkpoints = [];
  try {
    assert.ok(verification && verification.status === 'verified', 'TURN_CONTROL_VERIFICATION_REQUIRED');
    assert.equal(verification.required, true, 'TURN_CONTROL_REQUIRED_FLAG');
    const descriptor = verification.receipt;
    assert.ok(descriptor && isAbsolute(descriptor.path), 'TURN_CONTROL_RECEIPT_REQUIRED');
    const privateRoot = dirname(descriptor.path);
    assert.equal(basename(descriptor.path), 'result.json');
    assert.equal(basename(privateRoot), runId); assert.equal(basename(dirname(privateRoot)), 'turn-control');
    assert.ok(within(environmentRoot, privateRoot) && !within(runRoot, privateRoot), 'TURN_CONTROL_PRIVATE_OWNER');
    const owner = await lstat(environmentRoot);
    const files = new Map();
    async function checkedFile(id, descriptor, { publish = true, kind = 'json', expectedPath } = {}) {
      assert.ok(descriptor && isAbsolute(descriptor.path) && resolve(descriptor.path) === descriptor.path, 'TURN_CONTROL_ABSOLUTE_FILE');
      if (expectedPath) assert.equal(descriptor.path, expectedPath, 'TURN_CONTROL_FILE_OWNER');
      assert.ok(within(environmentRoot, descriptor.path), 'TURN_CONTROL_EVIDENCE_ESCAPE');
      assert.equal(await realpath(descriptor.path), descriptor.path, 'TURN_CONTROL_SYMLINK');
      const info = await lstat(descriptor.path);
      assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024 * 1024, 'TURN_CONTROL_FILE_LIMIT');
      assert.equal(info.uid, owner.uid, 'TURN_CONTROL_FILE_UID');
      const bytes = await readFile(descriptor.path), after = await lstat(descriptor.path);
      assert.equal(after.mtimeMs, info.mtimeMs); assert.equal(after.ctimeMs, info.ctimeMs);
      assert.equal(after.size, info.size);
      const actualHash = hash(bytes);
      if (descriptor.sha256 !== undefined) {
        assert.match(descriptor.sha256, shaPattern); assert.equal(actualHash, descriptor.sha256, 'TURN_CONTROL_FILE_HASH');
      }
      if (descriptor.bytes !== undefined) assert.equal(bytes.length, descriptor.bytes, 'TURN_CONTROL_FILE_BYTES');
      const existing = knownArtifacts.find(artifact => artifact.path === descriptor.path);
      if (existing) { assert.equal(existing.sha256, actualHash, 'TURN_CONTROL_REGISTERED_FILE_CHANGED'); assert.equal(existing.bytes, bytes.length); }
      const artifact = { id: existing?.id ?? id, path: descriptor.path, sha256: actualHash, bytes: bytes.length, kind: existing?.kind ?? kind };
      if (publish) {
        const prior = files.get(artifact.path);
        if (prior) return prior;
        const item = { artifact, bytes }; sources.push(item); files.set(artifact.path, item); return item;
      }
      return { artifact, bytes };
    }
    assert.match(descriptor.sha256, shaPattern);
    assert.ok(nonnegative(descriptor.bytes), 'TURN_CONTROL_RECEIPT_BYTES_REQUIRED');
    const terminal = await checkedFile('collection-turn-control-receipt', descriptor, { publish: false, expectedPath: join(privateRoot, 'result.json') });
    const result = JSON.parse(terminal.bytes);
    const keys = new Set(['version', 'run_id', 'episode_id', 'status', 'reason', 'error_code', 'error',
      'subject_error', 'completed_checkpoints', 'journal', 'plan', 'public_root', 'dispatched']);
    assert.ok(Object.keys(result).every(key => keys.has(key)), 'TURN_CONTROL_TERMINAL_SCHEMA');
    assert.equal(result.version, 1); assert.equal(result.run_id, runId); assert.equal(result.episode_id, runId);
    assert.ok(['completed', 'stopped'].includes(result.status), 'TURN_CONTROL_TERMINAL_STATUS');
    assert.deepEqual(verification.result, result, 'TURN_CONTROL_VERIFIED_RESULT_CHANGED');
    if (raw.turn_control != null) {
      const { receipt: callerReceipt, ...callerResult } = raw.turn_control;
      assert.deepEqual(callerResult, result, 'TURN_CONTROL_CALLER_RESULT_CHANGED');
      if (callerReceipt) {
        assert.equal(callerReceipt.path, descriptor.path); assert.equal(callerReceipt.sha256, descriptor.sha256);
        if (callerReceipt.bytes !== undefined) assert.equal(callerReceipt.bytes, descriptor.bytes);
      }
    }
    assert.equal(result.public_root, join(runRoot, 'benchmark/turn-bridge'), 'TURN_CONTROL_PUBLIC_OWNER');
    assert.ok(nonnegative(result.completed_checkpoints), 'TURN_CONTROL_CHECKPOINT_COUNT');
    assert.deepEqual(Object.keys(result.plan ?? {}).sort(), ['path', 'sha256']);
    assert.deepEqual(Object.keys(result.journal ?? {}).sort(), ['path', 'rows', 'sha256']);
    sources.push(terminal); files.set(terminal.artifact.path, terminal);
    const plan = await checkedFile('private-turn-plan-not-published', result.plan, {
      publish: false, expectedPath: join(privateRoot, 'plan.json') });
    const planValue = JSON.parse(plan.bytes);
    assert.equal(planValue.run_id, runId); assert.equal(planValue.episode_id, runId);
    const journal = await checkedFile('collection-turn-controller-journal', result.journal, {
      expectedPath: join(privateRoot, 'controller.jsonl'), kind: 'jsonl' });
    const rows = readJournal(journal.bytes, result.journal, runId);
    assert.equal(rows[0]?.type, 'controller_prepared'); assert.equal(rows[0]?.data.plan_sha256, result.plan.sha256);
    assert.equal(rows.at(-1)?.type, 'controller_end'); assert.equal(rows.at(-1)?.data.status, result.status);
    assert.equal(rows.at(-1)?.data.completed_checkpoints, result.completed_checkpoints);
    summary.status = 'verified'; summary.controller_status = result.status;
    summary.receipt = { path: terminal.artifact.path, sha256: terminal.artifact.sha256, bytes: terminal.artifact.bytes };
    summary.completed_checkpoints = result.completed_checkpoints;
    summary.plan_sha256 = result.plan.sha256;
    summary.journal = { sha256: journal.artifact.sha256, rows: rows.length };
    summary.refs = [ref(terminal.artifact), lineRef(journal.artifact, 1), lineRef(journal.artifact, rows.length)];
    control = { result, rows, terminal, journal, checkedFile };
    if (result.status !== 'completed') {
      summary.reason = 'turn_control_stopped'; problems.push('turn_control_stopped');
      return { summary, problems, sources, checkpoints, control };
    }

    assert.ok(eventArtifact && eventBytes && eventArtifact.id === 'events', 'TURN_CONTROL_RUNTIME_EVENTS_REQUIRED');
    assert.equal(hash(eventBytes), eventArtifact.sha256, 'TURN_CONTROL_RUNTIME_EVENTS_HASH');
    assert.equal(eventArtifact.path, join(runRoot, 'benchmark/runtime/events.jsonl'), 'TURN_CONTROL_RUNTIME_EVENTS_OWNER');
    const eventText = eventBytes.toString('utf8'); assert.ok(eventText.endsWith('\n'));
    const eventLines = eventText.trimEnd().split('\n'), events = eventLines.map(JSON.parse);
    const accepted = rows.filter(row => row.type === 'checkpoint_accepted');
    const decisions = rows.filter(row => row.type === 'checkpoint_decided');
    assert.equal(accepted.length, result.completed_checkpoints, 'TURN_CONTROL_ACCEPTED_COUNT');
    assert.equal(decisions.length, result.completed_checkpoints, 'TURN_CONTROL_DECIDED_COUNT');
    assert.ok(decisions.every(row => row.data.response.action === 'continue'), 'TURN_CONTROL_UNVERIFIED_RESUME');
    assert.ok(rows.filter(row => row.type === 'event_result').every(row => row.data.result.status === 'applied'), 'TURN_CONTROL_UNKNOWN_EVENT');
    const actualTurns = episode?.turns ?? [];
    assert.equal(actualTurns.length, result.completed_checkpoints, 'TURN_CONTROL_RUNTIME_TURN_COUNT');
    assert.equal(new Set(actualTurns.map(turn => turn.id)).size, actualTurns.length, 'TURN_CONTROL_DUPLICATE_TURN');
    let lastDeclared = -1;
    for (const declared of declaredTurns) {
      const index = actualTurns.findIndex(turn => turn.id === declared.id);
      assert.ok(index > lastDeclared, 'TURN_CONTROL_DECLARED_TURN_MISSING_OR_REORDERED'); lastDeclared = index;
    }

    const publicRoot = result.public_root;
    const subjectReceipt = await checkedFile('collection-turn-subject-result', { path: join(publicRoot, 'subject-result.json') });
    const subjectDescriptor = JSON.parse(subjectReceipt.bytes);
    assert.deepEqual(Object.keys(subjectDescriptor).sort(), ['path', 'rows', 'sha256']);
    const subjectJournal = await checkedFile('collection-turn-subject-journal', subjectDescriptor, {
      expectedPath: join(publicRoot, 'subject.jsonl'), kind: 'jsonl' });
    const subjectRows = readJournal(subjectJournal.bytes, subjectDescriptor, runId);
    assert.equal(subjectRows[0]?.type, 'subject_connected'); assert.equal(subjectRows.at(-1)?.type, 'subject_closed');
    assert.equal(subjectRows.at(-1).data.completed_checkpoints, result.completed_checkpoints);
    const requested = subjectRows.filter(row => row.type === 'checkpoint_requested');
    const received = subjectRows.filter(row => row.type === 'checkpoint_received');
    assert.equal(requested.length, result.completed_checkpoints); assert.equal(received.length, result.completed_checkpoints);
    let sessionId = null;
    for (const [index, acceptedRow] of accepted.entries()) {
      const data = acceptedRow.data, sequence = index + 1, observed = data.observation, prefix = observed.ref;
      assert.equal(data.sequence, sequence); assert.equal(data.turn_id, actualTurns[index].id);
      assert.equal(prefix.path, eventArtifact.path);
      assert.ok(Number.isSafeInteger(prefix.line) && prefix.line > 0 && Number.isSafeInteger(prefix.through_line) &&
        prefix.through_line > prefix.line && prefix.through_line <= eventLines.length, 'TURN_CONTROL_EVENT_PREFIX_RANGE');
      assert.equal(hash(eventLines.slice(0, prefix.through_line).join('\n') + '\n'), prefix.prefix_sha256, 'TURN_CONTROL_EVENT_PREFIX_HASH');
      const ended = events[prefix.line - 1], pause = events[prefix.through_line - 1];
      assert.equal(ended.type, 'user_turn_end'); assert.equal(ended.data.id, data.turn_id);
      assert.equal(ended.data.settled, true); assert.equal(ended.data.is_idle, true);
      assert.equal(pause.type, 'controller_pause_start'); assert.equal(pause.data.turn_id, data.turn_id);
      assert.equal(ended.data.session_id, observed.session_id);
      assert.equal(ended.data.final_text ?? null, observed.final_text);
      assert.ok(typeof observed.session_id === 'string' && observed.session_id);
      if (sessionId !== null) assert.equal(observed.session_id, sessionId, 'TURN_CONTROL_SESSION_CHANGED');
      sessionId = observed.session_id;
      const starts = events.slice(0, prefix.line - 1).filter(row => row.type === 'user_turn_start' && row.data.id === data.turn_id);
      assert.equal(starts.length, 1, 'TURN_CONTROL_START_COUNT');
      const started = starts[0]; assert.equal(started.data.session_id, sessionId);
      const startLine = events.indexOf(started) + 1;
      const decision = decisions[index], response = decision.data.response;
      assert.equal(decision.data.request_sha256, data.request_sha256); assert.equal(decision.data.session_id, sessionId);
      assert.ok(decision.sequence > acceptedRow.sequence);
      for (const [key, value] of Object.entries({ version: 1, run_id: runId, episode_id: runId,
        kind: 'benchmark-turn-receipt', sequence, turn_id: data.turn_id, request_sha256: data.request_sha256 }))
        assert.equal(response[key], value, 'TURN_CONTROL_RESPONSE_IDENTITY:' + key);
      const requestFile = await checkedFile('collection-turn-request-' + sequence, {
        path: join(publicRoot, 'requests', packet(sequence)), sha256: data.request_sha256 });
      const request = JSON.parse(requestFile.bytes);
      assert.equal(request.run_id, runId); assert.equal(request.episode_id, runId); assert.equal(request.turn_id, data.turn_id);
      assert.equal(request.sequence, sequence); assert.equal(request.ref?.artifact_id, 'events');
      assert.equal(request.ref?.line, prefix.through_line);
      const responseFile = await checkedFile('collection-turn-response-' + sequence, {
        path: join(publicRoot, 'receipts', packet(sequence)) });
      assert.deepEqual(JSON.parse(responseFile.bytes), response, 'TURN_CONTROL_RESPONSE_FILE_CHANGED');
      const asked = requested[index], got = received[index];
      assert.equal(asked.data.sequence, sequence); assert.equal(got.data.sequence, sequence);
      assert.equal(asked.data.turn_id, data.turn_id); assert.equal(got.data.turn_id, data.turn_id);
      assert.equal(asked.data.request_sha256, data.request_sha256); assert.equal(got.data.action, 'continue');
      assert.equal(got.data.response_sha256, responseFile.artifact.sha256);
      assert.ok(got.sequence > asked.sequence, 'TURN_CONTROL_RECEIVE_ORDER');
      checkpoints.push({ sequence, turn_id: data.turn_id, session_id: sessionId,
        accepted: acceptedRow, decision, started, ended, start_line: startLine, end_line: prefix.line,
        pause_line: prefix.through_line, response,
        refs: [lineRef(journal.artifact, acceptedRow.sequence), lineRef(journal.artifact, decision.sequence),
          lineRef(subjectJournal.artifact, asked.sequence), lineRef(subjectJournal.artifact, got.sequence),
          lineRef(eventArtifact, startLine), lineRef(eventArtifact, prefix.line), lineRef(eventArtifact, prefix.through_line),
          ref(requestFile.artifact), ref(responseFile.artifact)] });
    }
    summary.verified_completed = raw.dispatch_error == null;
    summary.session_id = sessionId;
    summary.refs.push(ref(subjectReceipt.artifact), lineRef(subjectJournal.artifact, 1), lineRef(subjectJournal.artifact, subjectRows.length));
    summary.reason = raw.dispatch_error == null ? null : 'subject_dispatch_error';
    control.subject = { receipt: subjectReceipt, journal: subjectJournal, rows: subjectRows };
  } catch (error) {
    summary.status = 'unavailable'; summary.verified_completed = false;
    summary.reason = error.message;
    problems.push('turn_control_evidence_unavailable');
    checkpoints = []; control = null;
  }
  return { summary, problems, sources, checkpoints, control };
}


/** Derive only observed callbacks and version bytes. Delivery of a task
 * clarification does not establish complete coverage of all model questions. */
export async function collectTurnFacts({ turnControl, binding, run, episode, initialMaterials, resolveRef, eventArtifact }) {
  const result = { clarifications: [], state_events: [], material_rows: [], evidence_refs: new Map(),
    coverage: { clarifications: 'unavailable', state_events: 'unavailable' }, problems: [], limitations: [] };
  if (!turnControl.summary.verified_completed || !turnControl.control) return result;
  const { checkpoints, control } = turnControl;
  result.coverage.clarifications = 'partial';
  result.limitations.push('Delivered task clarification turns are observed; complete coverage of every actual model question is not established.');
  const completionPaths = new Set(binding.public_case?.completion?.paths ?? []);
  for (const [index, checkpoint] of checkpoints.entries()) {
    const continuation = checkpoint.response.continuation;
    if (!continuation) continue;
    const next = checkpoints[index + 1], topic = checkpoint.decision.data.topic_id;
    const declared = (binding.clarification ?? []).find(item => item.topic_id === topic);
    if (!declared || declared.response !== continuation.prompt) {
      result.problems.push('turn_clarification_binding_mismatch'); continue;
    }
    if (!next || next.turn_id !== continuation.id || continuation.kind !== 'clarification' ||
      next.started.data.kind !== 'clarification' || next.started.data.prompt !== continuation.prompt ||
      episode.turns[index + 1]?.prompt !== continuation.prompt || next.session_id !== checkpoint.session_id) {
      result.limitations.push('A controller clarification decision lacks matching actual runtime kind, prompt or sequence evidence.');
      continue;
    }
    const evidence_id = 'turn-clarification-' + checkpoint.sequence;
    const references = [...checkpoint.refs, ...next.refs];
    let beforeCompletion, snapshotsComplete = completionPaths.size > 0, foundOutput = false;
    for (const turn of episode.turns.slice(0, index + 1)) {
      const snapshot = turn.workspace_manifest_ref ? resolveRef(turn.workspace_manifest_ref) : null;
      if (!Array.isArray(snapshot?.value?.files)) { snapshotsComplete = false; continue; }
      references.push(snapshot.ref);
      if (snapshot.value.files.some(file => completionPaths.has(file.path))) foundOutput = true;
    }
    if (foundOutput) beforeCompletion = false;
    else if (snapshotsComplete) beforeCompletion = true;
    result.clarifications.push({ evidence_id, topic_id: topic, turn_id: checkpoint.turn_id,
      response_turn_id: next.turn_id, response_prompt: continuation.prompt, session_id: checkpoint.session_id,
      observed_question_text: checkpoint.ended.data.final_text ?? null,
      ...(beforeCompletion === undefined ? {} : { before_completion: beforeCompletion }),
      observation_scope: 'actual controller response received in the same runtime session' });
    result.evidence_refs.set(evidence_id, references);
  }
  const declaredEvents = binding.events ?? [], observedEvents = control.rows.filter(row => row.type === 'event_result');
  result.coverage.state_events = 'complete';
  const seen = new Set();
  const projectFiles = files => files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes, mode: file.mode }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const sameDescriptor = (actual, expected) => {
    assert.ok(actual && expected); assert.equal(actual.path, expected.path); assert.equal(actual.sha256, expected.sha256);
    if (actual.bytes !== undefined && expected.bytes !== undefined) assert.equal(actual.bytes, expected.bytes);
  };
  for (const [index, row] of observedEvents.entries()) {
    const eventId = row.data.event_id, declared = declaredEvents.find(event => event.id === eventId);
    const evidence_id = 'turn-state-' + index, references = [lineRef(control.journal.artifact, row.sequence)];
    let state = { evidence_id, id: eventId, status: 'unknown' };
    try {
      assert.ok(declared && !seen.has(eventId), 'TURN_EVENT_NOT_UNIQUELY_DECLARED'); seen.add(eventId);
      assert.equal(declared.kind, 'publish-version', 'TURN_EVENT_KIND_NOT_SUPPORTED_BY_COLLECTOR');
      const value = row.data.result;
      assert.equal(value.status, 'applied'); assert.equal(value.effect_verified, true); assert.equal(value.effect_unknown, false);
      assert.equal(value.event_id, eventId); assert.equal(value.episode_id, run.run_id);
      assert.equal(value.logical_operation?.intent, declared.kind);
      assert.equal(value.logical_operation?.skill_id, declared.skill_id);
      const initialSkill = initialMaterials.filter(item => item.skill_id === declared.skill_id);
      assert.ok(initialSkill.length, 'TURN_EVENT_UNKNOWN_SKILL_IDENTITY');
      const targetIndex = checkpoints.findIndex(item => item.turn_id === declared.before_turn);
      assert.ok(targetIndex > 0, 'TURN_EVENT_NEXT_TURN_NOT_OBSERVED');
      const previous = checkpoints[targetIndex - 1], target = checkpoints[targetIndex];
      assert.ok(row.sequence > previous.accepted.sequence && row.sequence < previous.decision.sequence, 'TURN_EVENT_OUTSIDE_SETTLED_CHECKPOINT');
      const started = control.rows.filter(item => item.type === 'event_started' && item.data.event_id === eventId);
      assert.equal(started.length, 1); assert.ok(started[0].sequence < row.sequence);
      assert.equal(started[0].data.idempotency_key, row.data.idempotency_key);
      references.push(...previous.refs, ...target.refs, lineRef(control.journal.artifact, started[0].sequence));
      const read = async (key, descriptor, options) => {
        const item = await control.checkedFile('collection-turn-event-' + index + '-' + key, descriptor, options);
        if (item.artifact.kind !== 'source-bytes')
          references.push(item.artifact.kind === 'jsonl' ? lineRef(item.artifact, 1) : ref(item.artifact));
        return item;
      };
      const adapter = await read('adapter', value.receipt);
      const { receipt: unused, ...withoutSelfReceipt } = value;
      assert.deepEqual(JSON.parse(adapter.bytes), withoutSelfReceipt, 'TURN_EVENT_ADAPTER_RECEIPT_CHANGED');
      const fixture = await read('fixture', value.fixture_receipt), fixtureValue = JSON.parse(fixture.bytes);
      for (const key of ['status', 'effect_verified', 'effect_unknown', 'event_id', 'episode_id'])
        assert.equal(fixtureValue[key], value[key], 'TURN_EVENT_FIXTURE_IDENTITY:' + key);
      assert.ok(Array.isArray(value.effect_evidence) && value.effect_evidence.length > 0, 'TURN_EVENT_EFFECT_EVIDENCE_REQUIRED');
      for (const [effectIndex, effect] of value.effect_evidence.entries()) await read('effect-' + effectIndex, effect);
      const version = fixtureValue.native_version;
      assert.ok(version && Array.isArray(version.files) && version.files.length > 0, 'TURN_EVENT_OBSERVED_VERSION_REQUIRED');
      const sealed = await read('readback', version.readback), readback = JSON.parse(sealed.bytes);
      const rawReadback = await read('raw-readback', version.raw_readback);
      assert.equal(readback.status, 'passed'); sameDescriptor(readback.rawEvidence, version.raw_readback);
      const expectedOwners = [...new Set(initialSkill.map(item => item.identity?.bound_owner).filter(Boolean))];
      if (expectedOwners.length) assert.ok(expectedOwners.includes(readback.object?.owner), 'TURN_EVENT_READBACK_OWNER');
      assert.ok(Array.isArray(readback.observed?.files), 'TURN_EVENT_READBACK_FILES_REQUIRED');
      const materialFiles = [];
      for (const [fileIndex, file] of version.files.entries()) {
        assert.equal(file.skill_id, declared.skill_id); assert.equal(file.version, declared.version);
        assert.ok(typeof file.resource_path === 'string' && !isAbsolute(file.resource_path) &&
          !file.resource_path.split(/[\\/]/).includes('..'), 'TURN_EVENT_RESOURCE_PATH');
        const source = await read('file-' + fileIndex, file, { kind: 'source-bytes' });
        assert.ok(['100644', '100755'].includes(file.mode));
        const info = await lstat(file.path);
        assert.equal(Boolean(info.mode & 0o111), file.mode === '100755', 'TURN_EVENT_SOURCE_MODE');
        references.push(ref(fixture.artifact, '/native_version/files/' + fileIndex));
        materialFiles.push({ file, source, row: { path: file.resource_path, sha256: source.artifact.sha256,
          bytes: source.artifact.bytes, mode: file.mode } });
      }
      assert.equal(new Set(materialFiles.map(item => item.row.path)).size, materialFiles.length);
      assert.deepEqual(projectFiles(materialFiles.map(item => item.row)), projectFiles(readback.observed.files), 'TURN_EVENT_READBACK_BYTES');
      let installation = null;
      if (run.pi_launch?.mode === 'native') {
        const installed = await read('installation', value.native_installation); installation = JSON.parse(installed.bytes);
        assert.equal(installation.status, 'applied'); assert.equal(installation.effect_verified, true);
        assert.equal(installation.event_id, eventId); assert.equal(installation.episode_id, run.run_id);
        assert.equal(installation.consistency_boundary, 'settled-turn-subject-paused');
        const nativeRoot = run.pi_launch?.native_corpus?.root;
        assert.ok(isAbsolute(nativeRoot) && installation.target === join(nativeRoot, version.target_name), 'TURN_EVENT_NATIVE_OWNER');
        assert.ok(!isAbsolute(version.target_name) && !version.target_name.includes('/') && !version.target_name.includes('\\'));
        const expectedNames = new Set(initialSkill.flatMap(item => [item.identity?.bound_name,
          item.path === 'SKILL.md' && item.native_path ? basename(dirname(item.native_path)) : null]).filter(Boolean));
        assert.ok(expectedNames.size > 0 && expectedNames.has(version.target_name), 'TURN_EVENT_NATIVE_SKILL_BINDING');
        sameDescriptor(installation.source_receipt, value.fixture_receipt);
        sameDescriptor(installation.readback, version.readback); sameDescriptor(installation.raw_readback, version.raw_readback);
        const owner = await read('installation-owner', installation.owner?.run);
        assert.equal(JSON.parse(owner.bytes).run_id, run.run_id);
        assert.deepEqual(projectFiles(installation.after), projectFiles(materialFiles.map(item => item.row)), 'TURN_EVENT_INSTALLED_TREE');
        assert.deepEqual(projectFiles(installation.before_retained), projectFiles(installation.before), 'TURN_EVENT_BEFORE_RETENTION');
        for (const item of [...installation.before, ...installation.after]) {
          assert.ok(typeof item.path === 'string' && !isAbsolute(item.path) && !item.path.split(/[\\/]/).includes('..'), 'TURN_EVENT_TREE_PATH');
          assert.ok(['100644', '100755'].includes(item.mode), 'TURN_EVENT_TREE_MODE');
        }
        for (const [beforeIndex, item] of installation.before.entries()) {
          const before = await read('before-' + beforeIndex, { path: join(installation.history, item.path), sha256: item.sha256, bytes: item.bytes }, { kind: 'source-bytes' });
          assert.equal(Boolean((await lstat(before.artifact.path)).mode & 0o111), item.mode === '100755');
        }
        for (const [afterIndex, item] of installation.after.entries()) {
          const actual = await read('installed-' + afterIndex, { path: join(installation.target, item.path), sha256: item.sha256, bytes: item.bytes }, { kind: 'source-bytes' });
          assert.equal(Boolean((await lstat(actual.artifact.path)).mode & 0o111), item.mode === '100755');
        }
      }
      for (const { file, source } of materialFiles) {
        const prior = initialMaterials.filter(item => item.skill_id === file.skill_id && item.path === file.resource_path &&
          item.actual_sha256 === file.sha256);
        const identities = initialMaterials.filter(item => item.skill_id === file.skill_id);
        assert.ok(identities.length, 'TURN_EVENT_UNKNOWN_SKILL_IDENTITY');
        let canonicalSha = source.artifact.sha256, mapping = 'exact-bytes';
        if (file.resource_path === 'SKILL.md') {
          if (prior.length !== 1) {
            result.limitations.push('TURN_EVENT_MAIN_TRANSFORMATION_UNPROVEN:' + file.skill_id);
            continue;
          }
          canonicalSha = prior[0].canonical_sha256; mapping = 'unchanged-main-reuses-verified-initial-parity';
        }
        result.material_rows.push({ skill_id: file.skill_id, path: file.resource_path,
          actual_sha256: source.artifact.sha256, canonical_sha256: canonicalSha,
          actual_source: source.artifact.path, native_path: installation ? join(installation.target, file.resource_path) : null,
          identity: identities[0].identity ?? {}, refs: [...references, ...(prior[0]?.refs ?? [])],
          available_from_turn_id: target.turn_id, version: file.version, mapping, event_id: eventId });
      }
      state = { ...state, status: 'applied', before_turn: target.turn_id, skill_id: declared.skill_id,
        version: declared.version, observation_scope: installation ? 'verified native tree installation and fixture readback' : 'verified fixture readback',
        agent_consumption: 'not inferred from the state readback' };
    } catch (error) {
      result.coverage.state_events = 'partial'; result.problems.push('turn_event_readback_unavailable');
      result.limitations.push(error.message); state.reason = error.message;
    }
    result.state_events.push(state); result.evidence_refs.set(evidence_id, references);
  }
  if (declaredEvents.some(event => !seen.has(event.id))) {
    result.coverage.state_events = 'partial'; result.problems.push('turn_event_result_missing');
  }
  return result;
}
