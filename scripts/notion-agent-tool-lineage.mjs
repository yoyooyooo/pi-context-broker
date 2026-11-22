import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, resolve } from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const statusOf = diagnostics => diagnostics.some(item => item.status === 'failed') ? 'failed'
  : diagnostics.length ? 'blocked' : 'passed';

// Reviewed 0.1.3 read execution: the registered delegate forwards the unchanged
// arguments to the running Pi API's createReadTool(cwd). This says nothing about
// this package's other tools, UI hooks or background traffic.
const compactReadProfile = Object.freeze({ id: 'pi-compact-ui:0.1.3:native-read-delegate', files: {
  'package.json': { bytes: 567, sha256: 'a5f319f04fcc0ddeb47c0da5bdd08240598404f96b38dc1fe1baaaab14428f98' },
  'index.ts': { bytes: 66369, sha256: 'bac76ae9ed99a3790d8a728cc6e9b5463927ac427a1462ffe59c6adf9e4d4509' },
} });
export function inspectedCompactReadImplementation(event) {
  const source = event?.toolSource, implementation = event?.toolImplementation;
  if (event?.toolName !== 'read' || source?.origin !== 'package' || source.scope !== 'user'
    || source.source !== 'npm:pi-compact-ui' || !isAbsolute(source.baseDir ?? '')
    || source.path !== resolve(source.baseDir, 'index.ts') || implementation?.version !== 1
    || !Array.isArray(implementation.files) || implementation.files.length !== 2) return undefined;
  const seen = new Set();
  for (const file of implementation.files) {
    const expected = compactReadProfile.files[file.relativePath];
    if (!expected || seen.has(file.relativePath) || file.path !== resolve(source.baseDir, file.relativePath)
      || file.artifact?.sha256 !== expected.sha256 || file.artifact.bytes !== expected.bytes) return undefined;
    seen.add(file.relativePath);
  }
  return { profile: compactReadProfile.id, files: implementation.files, source };
}

function preparedReadTransition(call, tasks, session, evidence) {
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const observations = tasks.filter(row => row.phase === 'prepared_read' && row.toolCallId === call.id);
  const observation = observations[0], event = call.event, result = call.result;
  require(evidence && observations.length === 1 && evidence.observation === observation && observation.version === 1,
    'Missing unique verified prepared-read observation');
  require(call.provenance.kind === 'native-tool-call' && call.name === 'read' && result.isError === false
    && Object.keys(call.arguments).length === 1 && /^sr:C[A-Za-z0-9_-]{22}$/u.test(call.arguments.path ?? ''),
  'Only a completed top-level candidate whole-entry read has a reviewed rewrite');
  const reader = inspectedCompactReadImplementation(event);
  require(reader && evidence.brokerOwner?.source && observation.brokerSource
    && ['path', 'source', 'scope', 'origin', 'baseDir'].every(key => observation.brokerSource[key] === evidence.brokerOwner.source[key]),
  'The actual read delegate and current frozen Broker owner are required');
  const receipt = tasks.find(row => row.phase === 'receipt' && row.sequence === observation.receiptSequence);
  const native = session.branchEntries.find(entry => entry.id === call.native.resultEntryId)?.message;
  const proof = native?.details?.contextBrokerRead, binding = proof?.binding, record = binding?.record;
  require(receipt?.toolCallId === call.id && receipt.toolName === 'read' && proof?.version === 3 && proof.toolCallId === call.id
    && isDeepStrictEqual(receipt.proofs?.contextBrokerRead, proof), 'The receipt must be the same actual native result');
  const at = row => tasks.indexOf(row), nextPayload = tasks.find((row, index) => index > at(result) && row.phase === 'provider_payload');
  require(Number.isSafeInteger(event.turn) && event.turn > 0 && Number.isSafeInteger(event.pid) && event.pid > 0
    && Number.isSafeInteger(observation.receiptSequence) && observation.receiptSequence > 0
    && event.turn === result.turn && result.turn === receipt.turn && receipt.turn === observation.turn
    && event.pid === result.pid && result.pid === receipt.pid && receipt.pid === observation.pid
    && at(result) < at(receipt) && at(receipt) < at(observation) && nextPayload && at(observation) < at(nextPayload),
  'A late, cross-turn, cross-process or cross-call receipt cannot justify a rewrite');
  require(digest(binding?.scope) && nonempty(record?.id) && record.kind === 'skill' && object(record.locator)
    && /^s_[a-f0-9]{64}$/u.test(binding.snapshot_id ?? '') && digest(binding.version_id)
    && digest(proof.bodySha256) && binding.body_sha256 === proof.bodySha256 && binding.snapshot_id === proof.snapshotId
    && record.entrypoint === 'SKILL.md' && Number.isSafeInteger(proof.bytes) && proof.bytes > 0,
  'The receipt needs the complete immutable owner identity');
  const prefix = 'skill://' + encodeURIComponent(record.id) + '/SKILL.md';
  require(record.ref === prefix && proof.identity === JSON.stringify(['notion', binding.scope, 'skill', record.locator.type, record.id])
    && proof.contentIdentity === JSON.stringify([binding.scope, record.id]), 'The receipt identity must name this exact Notion owner');
  const callIndex = session.branchEntries.findIndex(entry => entry.id === call.native.assistantEntryId);
  const refs = session.branchEntries.slice(0, callIndex).filter(entry => entry.type === 'custom'
    && entry.customType === 'context-broker-short-ref' && entry.data?.ref === call.arguments.path);
  const target = refs[0]?.data?.target, identity = target?.identity;
  require(callIndex >= 0 && refs.length === 1 && refs[0].data.version === 1 && target.kind === 'candidate'
    && identity?.source === 'notion' && identity.scope === binding.scope && identity.id === record.id
    && identity.kind === record.kind && identity.ref === 'skill://' + encodeURIComponent(record.id) && isDeepStrictEqual(identity.locator, record.locator),
  'The original short reference must already bind this owner on the actual native branch');
  const { input, manifest, body, content } = evidence, path = input?.path;
  const tail = '/scopes/' + binding.scope + '/records/' + sha(record.id) + '/entries/' + binding.snapshot_id + '/tree/SKILL.md';
  require(object(input) && Object.keys(input).length === 1 && isAbsolute(path ?? '') && resolve(path) === path && path.endsWith(tail)
    && observation.originalInputSha256 === event.inputSha256 && observation.preparedInputSha256 === result.inputSha256
    && sha(JSON.stringify(input)) === result.inputSha256 && observation.file?.path === path && observation.file.realpath === path,
  'The exact executed parameters must change only to the owned immutable entry path');
  const manifestPath = path.slice(0, -'/tree/SKILL.md'.length) + '/.broker-entry.json';
  const file = manifest.files?.[0], fileBinding = manifest.file_bindings?.[0];
  require(manifest.version === 1 && manifest.projection === 'entry' && manifest.manifest_complete === true
    && manifest.scope === binding.scope && manifest.id === record.id && manifest.snapshot_id === binding.snapshot_id
    && manifest.version_id === binding.version_id && manifest.entrypoint === 'SKILL.md' && manifest.ref === binding.ref
    && observation.manifest?.path === manifestPath && observation.manifest.realpath === manifestPath
    && manifest.files?.length === 1 && manifest.file_bindings?.length === 1 && file.path === 'SKILL.md'
    && file.bytes === proof.bytes && file.sha256 === proof.bodySha256 && file.ref === binding.ref
    && fileBinding.path === 'SKILL.md' && fileBinding.page_id === record.locator.page_id
    && /^file-[a-f0-9]{64}$/u.test(fileBinding.file_id ?? '')
    && binding.ref === prefix + '?snapshot=' + binding.snapshot_id + '&file_id=' + fileBinding.file_id,
  'The materialized entry manifest must retain the exact owner, snapshot and File');
  const text = value => typeof value === 'string' ? value : Array.isArray(value) && value.every(part => part?.type === 'text')
    ? value.map(part => part.text).join('\n') : undefined;
  const bodyText = body.toString('utf8'), rendered = text(native.content), delivered = text(content);
  require(body.length === proof.bytes && sha(body) === proof.bodySha256 && Buffer.from(bodyText).equals(body)
    && typeof rendered === 'string' && rendered.startsWith(bodyText) && [bodyText, rendered].includes(delivered)
    && proof.delivery?.start === 0 && proof.delivery.end === bodyText.length && proof.delivery.encoding === 'raw'
    && proof.rendered?.sha256 === sha(rendered) && proof.rendered.bytes === Buffer.byteLength(rendered)
    && receipt.content?.sha256 === sha(rendered) && receipt.content.bytes === Buffer.byteLength(rendered),
  'The actual callback, immutable file and native receipt must deliver identical whole-entry bytes');
  return { profile: reader.profile, originalRef: call.arguments.path, path, bodySha256: proof.bodySha256,
    snapshotId: proof.snapshotId, owner: record.id, scope: binding.scope, receiptSequence: receipt.sequence,
    brokerCommit: evidence.brokerOwner.commit };
}

/**
 * Correlate actual tool callbacks with Pi's persisted native records.
 *
 * Pi 1.6's runtime-owned toolResult.nestedCalls is a complete root-call census,
 * including descendants. It is not the codemode UI's truncated args preview.
 * Immediate ancestry comes from actual parentToolCallId callbacks, or from the
 * codemode result's structured direct-call census. IDs are always opaque.
 *
 * The caller must validate the native session tree and callback stream first.
 * preparedReads contains only artifact bytes verified by the analyzer, plus
 * its independently verified current Broker owner. Raw receipt claims alone
 * cannot populate it or bypass the original argument and identity checks.
 * This function does not infer execution from proposals or from script text.
 */
export function correlateNotionAgentToolAttempts({ tasks, session, currentUserId = session?.currentUserId, preparedReads = new Map() }) {
  const diagnostics = [], attempts = [], containers = [], retractedProposals = [];
  const note = (code, message, details, status = 'blocked') => diagnostics.push({ status, code, message, ...(details ? { details } : {}) });
  if (!Array.isArray(tasks) || session?.supported !== true || !Array.isArray(session.attempts)
    || !Array.isArray(session.branchEntries) || !nonempty(currentUserId)) {
    note('NATIVE_TOOL_EVIDENCE_MISSING', 'Use the verified native branch and the actual current-turn callback stream');
    return { version: 1, status: 'blocked', complete: false, attempts, containers, retractedProposals, diagnostics, counts: null };
  }
  const native = session.attempts.filter(call => call.active && call.userEntryId === currentUserId);
  const nativeById = new Map(), roots = new Map(), declared = new Map(), directParents = new Map();
  const callEvents = new Map(), resultEvents = new Map(), positions = new Map();
  for (const [index, event] of tasks.entries()) {
    if (!['tool_call', 'tool_result'].includes(event.phase)) continue;
    if (!nonempty(event.toolCallId) || !nonempty(event.toolName)) {
      note('TOOL_IDENTITY_MISSING', 'An actual callback has no exact tool identity', { index }); continue;
    }
    const collection = event.phase === 'tool_call' ? callEvents : resultEvents;
    if (collection.has(event.toolCallId)) note('TOOL_CALLBACK_DUPLICATED', 'An actual callback was recorded twice',
      { toolCallId: event.toolCallId, phase: event.phase }, 'failed');
    else collection.set(event.toolCallId, event);
    positions.set(event, index);
  }
  for (const call of native) {
    if (!nonempty(call.id) || nativeById.has(call.id)) {
      note('NATIVE_TOOL_IDENTITY_DUPLICATED', 'The native turn repeats a tool identity', { toolCallId: call.id }, 'failed'); continue;
    }
    nativeById.set(call.id, call);
    const entry = session.branchEntries.find(entry => entry.id === call.resultEntryId);
    const message = entry?.type === 'message' ? entry.message : undefined;
    if (call.resultLine === undefined) {
      if (call.retractedLine !== undefined && !callEvents.has(call.id)) retractedProposals.push({
        ...call, dispatched: false, phase: 'proposed_retracted', deliveryToolCallId: null,
      });
      else note('NATIVE_TOOL_RESULT_MISSING', 'A non-retracted native proposal has no terminal result', { toolCallId: call.id });
      continue;
    }
    if (!message || message.role !== 'toolResult' || message.toolCallId !== call.id || message.toolName !== call.name) {
      note('NATIVE_TOOL_RESULT_MISSING', 'The native terminal result does not belong to its exact call', { toolCallId: call.id }); continue;
    }
    const root = { native: call, entry, message, members: [], direct: [], containerDiagnostics: [] };
    roots.set(call.id, root);
    const summary = message.nestedCalls;
    if (summary !== undefined) {
      if (!object(summary) || !Array.isArray(summary.calls) || summary.complete !== true) {
        note('NESTED_TOOL_SUMMARY_INCOMPLETE', 'Pi did not retain a complete nested-call census', { toolCallId: call.id });
      }
      if (Array.isArray(summary?.calls)) {
        for (const [index, child] of summary.calls.entries()) {
          const details = { toolCallId: child?.id, rootToolCallId: call.id, summaryIndex: index };
          if (!object(child) || !nonempty(child.id) || !nonempty(child.name)) {
            note('NESTED_TOOL_IDENTITY_MISSING', 'A nested native record has no exact identity', details); continue;
          }
          if (declared.has(child.id) || nativeById.has(child.id) || child.id === call.id) {
            note('NESTED_TOOL_IDENTITY_DUPLICATED', 'One nested identity belongs to multiple native records', details, 'failed'); continue;
          }
          if (!object(child.arguments) || child.argumentsBytes !== undefined)
            note('NESTED_TOOL_ARGUMENTS_MISSING', 'A nested record omitted its complete arguments', details);
          if (!['ok', 'error'].includes(child.status))
            note('NESTED_TOOL_RESULT_UNFINISHED', 'A nested call has no terminal native status', details);
          const declaration = { child, root, index, summarySha256: sha(JSON.stringify(summary)) };
          declared.set(child.id, declaration); root.members.push(child.id);
        }
      }
    }
    if (call.name === 'codemode') {
      const census = message.details?.calls;
      const problem = (code, text, details) => root.containerDiagnostics.push({ status: 'blocked', code, message: text, ...(details ? { details } : {}) });
      if (!Array.isArray(census)) problem('CODEMODE_DIRECT_CENSUS_MISSING', 'The codemode result omitted its structured direct-call census');
      else {
        const seen = new Set();
        for (const direct of census) {
          if (!object(direct) || !nonempty(direct.id) || !nonempty(direct.name) || seen.has(direct.id)) {
            problem('CODEMODE_DIRECT_CENSUS_INVALID', 'A codemode direct-call identity is invalid or duplicated'); continue;
          }
          seen.add(direct.id);
          const declaredChild = declared.get(direct.id);
          if (!declaredChild || declaredChild.root !== root || declaredChild.child.name !== direct.name) {
            problem('CODEMODE_UNOBSERVED_DIRECT_EFFECT', 'A codemode direct operation is outside the complete tool census',
              { toolCallId: direct.id, tool: direct.name }); continue;
          }
          if (!['ok', 'error', 'cancelled'].includes(direct.status)
            || (direct.status === 'ok') !== (declaredChild.child.status === 'ok'))
            problem('CODEMODE_DIRECT_STATUS_MISMATCH', 'The codemode direct call is not terminal or contradicts its native record', { toolCallId: direct.id });
          if (directParents.has(direct.id) && directParents.get(direct.id) !== call.id)
            note('NESTED_TOOL_PARENT_CONFLICT', 'Native results disagree about an immediate caller', { toolCallId: direct.id }, 'failed');
          directParents.set(direct.id, call.id); root.direct.push(direct.id);
        }
        root.directCensusSha256 = sha(JSON.stringify(census));
      }
    }
  }
  // Detect collisions with model-issued calls that occur after the root record.
  for (const [id] of declared) if (nativeById.has(id))
    note('NESTED_TOOL_IDENTITY_DUPLICATED', 'A nested identity also appears as a model-issued call', { toolCallId: id }, 'failed');

  for (const [id, event] of callEvents) {
    const nativeCall = nativeById.get(id), declaration = declared.get(id), result = resultEvents.get(id);
    const call = { id, name: event.toolName, selectors: event.selectors ?? {}, event, result, dispatched: true };
    attempts.push(call);
    if (nativeCall && roots.has(id)) {
      const root = roots.get(id);
      call.arguments = nativeCall.arguments; call.native = nativeCall;
      call.rootToolCallId = id; call.deliveryToolCallId = id;
      call.provenance = { kind: 'native-tool-call', callEntryId: nativeCall.assistantEntryId, resultEntryId: nativeCall.resultEntryId };
      if (event.parentToolCallId !== undefined || result?.parentToolCallId !== undefined)
        note('TOP_LEVEL_TOOL_PARENT_CONFLICT', 'A model-issued native call was observed as a nested call', { toolCallId: id }, 'failed');
      if ((root.message.isError === true) !== (nativeCall.isError === true))
        note('NATIVE_TOOL_STATUS_MISMATCH', 'The parsed native status differs from the retained result', { toolCallId: id }, 'failed');
    } else if (declaration) {
      const { child, root, index, summarySha256 } = declaration;
      call.arguments = child.arguments; call.rootToolCallId = root.native.id; call.deliveryToolCallId = root.native.id;
      call.provenance = { kind: 'native-nested-summary', rootToolCallId: root.native.id,
        resultEntryId: root.entry.id, resultLine: root.native.resultLine, summaryIndex: index, summarySha256 };
      call.native = { id: child.id, name: child.name, arguments: child.arguments, isError: child.status === 'error',
        userEntryId: currentUserId, active: true, assistantEntryId: root.native.assistantEntryId,
        resultEntryId: root.entry.id, resultLine: root.native.resultLine,
        syntheticFrom: 'native-nested-summary', rootToolCallId: root.native.id, summaryIndex: index };
      const callbackParent = event.parentToolCallId ?? result?.parentToolCallId, censusParent = directParents.get(id);
      if (event.parentToolCallId !== undefined || result?.parentToolCallId !== undefined) {
        if (!nonempty(event.parentToolCallId) || result?.parentToolCallId !== event.parentToolCallId)
          note('NESTED_TOOL_PARENT_CALLBACK_MISMATCH', 'Nested start and result do not retain the same explicit caller', { toolCallId: id }, 'failed');
      }
      if (callbackParent !== undefined && censusParent !== undefined && callbackParent !== censusParent)
        note('NESTED_TOOL_PARENT_CONFLICT', 'The callback caller contradicts the native direct-call census', { toolCallId: id }, 'failed');
      call.parentToolCallId = callbackParent ?? censusParent;
      if (!nonempty(call.parentToolCallId)) note('NESTED_TOOL_PARENT_UNOBSERVED',
        'The complete root census does not establish this immediate parent; retain parentToolCallId callbacks', { toolCallId: id });
      call.provenance.parentEvidence = callbackParent !== undefined ? 'actual-callbacks' : censusParent !== undefined ? 'native-codemode-direct-census' : 'unobserved';
    } else {
      note('NATIVE_TOOL_CORRELATION_MISSING', 'An actual callback has no record in the active native turn', { toolCallId: id }); continue;
    }
    if (call.native.name !== call.name)
      note('NATIVE_TOOL_NAME_MISMATCH', 'The actual and native tool names differ', { toolCallId: id }, 'failed');
    if (!object(call.arguments) || !digest(event.inputSha256)) note('TOOL_INPUT_HASH_MISSING', 'Complete native arguments and actual input hash are required', { toolCallId: id });
    else if (sha(JSON.stringify(call.arguments)) !== event.inputSha256)
      note('TOOL_INPUT_HASH_MISMATCH', 'The observed input differs from the native arguments', { toolCallId: id }, 'failed');
    for (const [key, value] of Object.entries(call.selectors)) if (!isDeepStrictEqual(value, call.arguments?.[key]))
      note('TOOL_SELECTOR_MISMATCH', 'The observed selector differs from the hash-bound arguments', { toolCallId: id, key }, 'failed');
    if (!result) note('TOOL_RESULT_UNOBSERVED', 'An actual tool start has no terminal callback', { toolCallId: id });
    else {
      if (result.toolName !== call.name || typeof result.isError !== 'boolean' || result.isError !== call.native.isError)
        note('TOOL_RESULT_STATUS_MISMATCH', 'The terminal callback contradicts its native result', { toolCallId: id }, 'failed');
      if (positions.get(result) <= positions.get(event))
        note('TOOL_RESULT_ORDER_INVALID', 'A result precedes its actual start', { toolCallId: id }, 'failed');
      if (result.inputSha256 !== undefined && result.inputSha256 !== event.inputSha256) {
        try { call.preparedRead = preparedReadTransition(call, tasks, session, preparedReads.get(id)); }
        catch (error) { note('TOOL_RESULT_INPUT_MISMATCH', 'The executed result input differs without a proven Broker preparation',
          { toolCallId: id, reason: error.message }, 'failed'); }
      }
    }
  }
  const byId = new Map(attempts.map(call => [call.id, call]));
  for (const [id, result] of resultEvents) if (!callEvents.has(id))
    note('TOOL_START_UNOBSERVED', 'A terminal callback has no actual start observation', { toolCallId: id, tool: result.toolName });
  for (const [id, root] of roots) if (!byId.has(id))
    note('TASK_TOOL_OBSERVATION_MISSING', 'A native model-issued call has no actual callback', { toolCallId: id, resultEntryId: root.entry.id });
  for (const [id] of declared) if (!byId.has(id))
    note('NESTED_TOOL_CHILD_UNOBSERVED', 'A child in the native complete census lacks actual callbacks', { toolCallId: id });
  for (const call of attempts.filter(call => declared.has(call.id))) {
    const parent = byId.get(call.parentToolCallId), root = byId.get(call.rootToolCallId);
    if (!parent || !root) { note('NESTED_TOOL_PARENT_UNOBSERVED', 'A nested call has no observed parent or root', { toolCallId: call.id }); continue; }
    if (parent.id === call.id || parent.rootToolCallId !== call.rootToolCallId)
      note('NESTED_TOOL_PARENT_SCOPE_MISMATCH', 'A nested call points outside its native root', { toolCallId: call.id }, 'failed');
    const seen = new Set([call.id]); let ancestor = parent;
    while (ancestor && ancestor.id !== root.id) {
      if (seen.has(ancestor.id)) { note('NESTED_TOOL_PARENT_CYCLE', 'Nested ancestry contains a cycle', { toolCallId: call.id }, 'failed'); break; }
      seen.add(ancestor.id); ancestor = byId.get(ancestor.parentToolCallId);
    }
    if (!ancestor) note('NESTED_TOOL_PARENT_UNOBSERVED', 'Nested ancestry does not reach the native root', { toolCallId: call.id });
    if (positions.get(parent.event) >= positions.get(call.event)
      || !parent.result || !call.result || positions.get(call.result) >= positions.get(parent.result))
      note('NESTED_TOOL_LIFETIME_UNPROVEN', 'The child must start and finish within its actual parent lifetime', { toolCallId: call.id });
  }
  const status = statusOf(diagnostics), complete = status === 'passed';
  for (const [id, root] of roots) {
    if (root.native.name !== 'codemode') continue;
    const call = byId.get(id), problems = [...root.containerDiagnostics];
    const source = call?.event.toolSource;
    if (!object(source) || source.path !== 'builtin:codemode' || source.source !== 'builtin')
      problems.push({ status: 'blocked', code: source === undefined ? 'CODEMODE_IMPLEMENTATION_UNOBSERVED' : 'CODEMODE_IMPLEMENTATION_UNREVIEWED',
        message: 'Only the observed builtin codemode implementation is a reviewed transparent container' });
    const declaredComplete = root.message.nestedCalls?.complete === true
      || root.message.nestedCalls === undefined && Array.isArray(root.message.details?.calls) && root.message.details.calls.length === 0;
    const container = { id, name: 'codemode', complete: complete && declaredComplete && problems.length === 0,
      directChildIds: root.direct, descendantIds: root.members, diagnostics: problems,
      coverage: 'native-complete-census-and-actual-terminal-callbacks',
      provenance: { resultEntryId: root.entry.id, resultLine: root.native.resultLine,
        ...(root.message.nestedCalls ? { summarySha256: sha(JSON.stringify(root.message.nestedCalls)) } : { noNestedCalls: true }),
        directCensusSha256: root.directCensusSha256, ...(source ? { toolSource: source } : {}) },
      semantics: 'container-only; evaluate every descendant tool independently; no script-text inference' };
    containers.push(container); if (call) call.container = container;
  }
  return { version: 1, status, complete, attempts, containers, retractedProposals, diagnostics,
    counts: { actual: attempts.length, topLevel: attempts.filter(call => call.provenance?.kind === 'native-tool-call').length,
      nested: attempts.filter(call => call.provenance?.kind === 'native-nested-summary').length,
      errors: attempts.filter(call => call.result?.isError === true).length, retractedProposals: retractedProposals.length } };
}

/** Only a proven container whose complete descendant set passes the caller's
 * normal effects classifier can be treated as a read-only composition. */
export function inspectNotionAgentReadOnlyContainer(attempt, correlation, isReadOnlyTool) {
  const container = attempt?.container;
  if (correlation?.complete !== true || container?.complete !== true || typeof isReadOnlyTool !== 'function')
    return { status: 'blocked', readOnly: false, code: 'TOOL_CONTAINER_COVERAGE_MISSING' };
  const byId = new Map(correlation.attempts.map(call => [call.id, call])), unreviewed = [];
  for (const id of container.descendantIds) {
    const child = byId.get(id);
    if (!child || !child.result || isReadOnlyTool(child) !== true) unreviewed.push(id);
  }
  return unreviewed.length ? { status: 'blocked', readOnly: false, code: 'TOOL_CONTAINER_EFFECTS_UNKNOWN', unreviewed }
    : { status: 'passed', readOnly: true, descendantIds: container.descendantIds, provenance: container.provenance };
}
