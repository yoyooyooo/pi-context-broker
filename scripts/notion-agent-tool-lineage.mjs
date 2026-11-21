import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const statusOf = diagnostics => diagnostics.some(item => item.status === 'failed') ? 'failed'
  : diagnostics.length ? 'blocked' : 'passed';

/**
 * Correlate actual tool callbacks with Pi's persisted native records.
 *
 * Pi 1.6's runtime-owned toolResult.nestedCalls is a complete root-call census,
 * including descendants. It is not the codemode UI's truncated args preview.
 * Immediate ancestry comes from actual parentToolCallId callbacks, or from the
 * codemode result's structured direct-call census. IDs are always opaque.
 *
 * The caller must validate the native session tree and callback stream first.
 * This function does not infer execution from proposals or from script text.
 */
export function correlateNotionAgentToolAttempts({ tasks, session, currentUserId = session?.currentUserId }) {
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
      if (result.inputSha256 !== undefined && result.inputSha256 !== event.inputSha256)
        note('TOOL_RESULT_INPUT_MISMATCH', 'The executed result input differs from the observed start', { toolCallId: id }, 'failed');
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
    if (source !== undefined && (source?.path !== 'builtin:codemode' || source.source !== 'builtin'))
      problems.push({ status: 'blocked', code: 'CODEMODE_IMPLEMENTATION_UNREVIEWED', message: 'A replacement codemode implementation is not a reviewed transparent container' });
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
