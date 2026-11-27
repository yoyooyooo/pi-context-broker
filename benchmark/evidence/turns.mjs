import { createHash } from 'node:crypto';
import { verifyArtifactFiles } from './store.mjs';

const exact = fact => fact?.status === 'known' && fact.precision !== 'estimated' && Number.isFinite(fact.value);
const unknown = reason => ({ status: 'unknown', value: null, reason });
const known = value => ({ status: 'known', value });
function sum(facts, complete, reason) {
  const usable = facts.filter(exact), subtotal = usable.reduce((n, fact) => n + fact.value, 0);
  return { ...(complete && usable.length === facts.length ? known(subtotal) : unknown(reason)),
    known_subtotal: subtotal, known_items: usable.length, total_items: facts.length };
}
function ns(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Malformed retained monotonic clock');
  return BigInt(value);
}
function elapsed(start, end) {
  if (start == null || end == null) return unknown('Both retained clock boundaries are required');
  const difference = ns(end) - ns(start);
  if (difference < 0n) throw new Error('Retained clock boundaries are reversed');
  return known(Number(difference) / 1e6);
}
function uniqueMap(rows, key, label) {
  const map = new Map();
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== 'string' || !value || map.has(value)) throw new Error('Missing or duplicate ' + label);
    map.set(value, row);
  }
  return map;
}
function usage(attempts, complete) {
  const sent = attempts.filter(attempt => attempt.sent === true);
  const allKnown = complete && attempts.every(attempt => attempt.sent !== null);
  const metric = select => sum(sent.map(select), allKnown, 'Incomplete actual attempts or exact usage');
  const inputs = sent.map(attempt => attempt.full_input);
  const tokenMetric = (key, subtotal) => ({ ...metric(attempt => attempt[key]),
    known_subtotal: sent.reduce((n, attempt) => n + (attempt[subtotal] ?? (exact(attempt[key]) ? attempt[key].value : 0)), 0) });
  const currencies = new Set(sent.filter(attempt => attempt.cost?.status === 'known').map(attempt => attempt.cost.value.currency));
  const priced = allKnown && sent.length > 0 && currencies.size === 1 && sent.every(attempt =>
    attempt.cost?.status === 'known' && attempt.cost.precision !== 'estimated' && Number.isFinite(attempt.cost.value.amount));
  return {
    provider_attempts: { ...(allKnown ? known(sent.length) : unknown('Actual attempt coverage is incomplete')), known_subtotal: sent.length },
    input_tokens: tokenMetric('full_input', 'known_input_subtotal'), output_tokens: tokenMetric('full_output', 'known_output_subtotal'),
    input_peak: allKnown && inputs.length && inputs.every(exact) ? known(Math.max(...inputs.map(fact => fact.value)))
      : unknown(inputs.length ? 'Incomplete exact input observations' : 'No actual provider input'),
    cache_read_tokens: metric(attempt => attempt.usage.cache_read),
    cache_write_tokens: metric(attempt => attempt.usage.cache_write),
    uncached_input_tokens: metric(attempt => exact(attempt.full_input) && exact(attempt.usage.cache_read) && attempt.full_input.value >= attempt.usage.cache_read.value
      ? known(attempt.full_input.value - attempt.usage.cache_read.value) : unknown('Exact full input and cache-read usage are required')),
    money: priced ? known({ currency: [...currencies][0], amount: sent.reduce((n, attempt) => n + attempt.cost.value.amount, 0) })
      : unknown('Missing, unpriced or mixed currency costs'),
  };
}

// Like readEpisodeDecision, the caller supplies a verified normalized episode.
// This projection checks the retained source files again, but does not regrade,
// replace the normalized episode or infer missing execution from a later pass.
export async function readEpisodeTurns(episode, options = {}) {
  const ids = ['events', 'collection-runtime-result', 'collection-readback', 'collection-grade'];
  const selected = episode.artifacts.filter(artifact => ids.includes(artifact.id));
  const files = await verifyArtifactFiles(selected, options);
  const base = { version: 1, kind: 'benchmark-user-turn-view', episode_id: episode.identity.episode_id,
    episode_sha256: episode.episode_sha256, model_requests: 0 };
  if (!files.has('events')) return { ...base, status: 'unavailable', reason: 'No retained user-turn event stream', rows: [] };
  const json = id => files.has(id) ? JSON.parse(files.get(id).bytes.toString('utf8')) : null;
  const ref = (id, locator) => ({ artifact_id: id, sha256: files.get(id).artifact.sha256, ...locator });
  const lines = files.get('events').bytes.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events = lines.map((line, i) => ({ value: JSON.parse(line), ref: ref('events', { line: i + 1 }) }));
  const starts = events.filter(row => row.value.type === 'user_turn_start');
  const ends = events.filter(row => row.value.type === 'user_turn_end');
  const turnRows = starts.map(row => ({ id: row.value.turn_id, start: row }));
  const turns = uniqueMap(turnRows, 'id', 'user-turn start');
  const ended = new Set();
  for (const end of ends) {
    const id = end.value.turn_id;
    if (!turns.has(id) || ended.has(id)) throw new Error('Missing start or duplicate user-turn end');
    turns.get(id).end = end; ended.add(id);
  }
  for (const [i, turn] of turnRows.entries()) {
    ns(turn.start.value.monotonic_ns);
    if (turn.end && turn.end.value.sequence <= turn.start.value.sequence) throw new Error('User-turn end precedes its start');
    if (i && (!turnRows[i - 1].end || turn.start.value.sequence <= turnRows[i - 1].end.value.sequence))
      throw new Error('Retained user-turn boundaries overlap');
  }
  if (!turnRows.length) return { ...base, status: 'unavailable', reason: 'No actual user-turn starts were retained', rows: [] };
  const runtime = json('collection-runtime-result'), readback = json('collection-readback'), grade = json('collection-grade');
  const runtimeTurns = uniqueMap(runtime?.turns ?? [], 'id', 'runtime turn');
  for (const id of runtimeTurns.keys()) if (!turns.has(id)) throw new Error('Runtime turn is absent from the retained event stream');
  const workspaceIds = new Set([...runtimeTurns.values()].map(turn => turn.workspace_manifest_ref?.artifact_id).filter(Boolean));
  for (const [id, file] of await verifyArtifactFiles(episode.artifacts.filter(artifact => workspaceIds.has(artifact.id)), options)) files.set(id, file);
  const requests = new Map();
  for (const row of events.filter(row => row.value.type === 'model_request_start' && row.value.data?.capture_only !== true)) {
    const request = row.value;
    if (!request.request_id || requests.has(request.request_id) || request.data?.request_id !== request.request_id)
      throw new Error('Missing, duplicate or conflicting model request identity');
    const turn = turns.get(request.turn_id);
    if (turn && (request.sequence <= turn.start.value.sequence || turn.end && request.sequence >= turn.end.value.sequence))
      throw new Error('Model request is outside its declared user turn');
    requests.set(request.request_id, { id: request.request_id, turn_id: request.turn_id ?? null, ref: row.ref });
  }
  for (const request of runtime?.requests ?? []) {
    const observed = requests.get(request.id);
    if (!observed || observed.turn_id !== (request.turn_id ?? null)) throw new Error('Runtime request differs from its retained turn event');
  }
  const origin = runtime?.timing?.started_monotonic_ns ?? null;
  const runtimeStart = events.find(row => row.value.type === 'runtime_start');
  if (origin !== null && runtimeStart?.value.data?.started_monotonic_ns !== undefined && runtimeStart.value.data.started_monotonic_ns !== origin)
    throw new Error('Runtime start differs between retained sources');
  const unknownAttempts = episode.attempts.filter(attempt => !turns.has(requests.get(attempt.request_id)?.turn_id));
  const unknownTools = episode.tools.filter(tool => !turns.has(tool.turn_id));
  const allAttempts = [], allRequests = [], allTools = [];
  const complete = episode.admission.completeness.attempts === 'complete';
  const contracts = new Map(episode.contracts.map(contract => [contract.id, contract]));
  const businessChecks = (grade?.contracts ?? []).filter(contract => contract.kind === 'artifact-json');
  for (const check of businessChecks) {
    const retained = contracts.get(check.id);
    if (!retained || retained.status !== check.status || retained.kind !== check.kind) throw new Error('Retained business grade differs from the normalized contract');
  }
  const businessArtifacts = turn => businessChecks.flatMap(check => {
    const refs = (grade.readback_refs ?? []).filter(row => check.evidence_ids?.includes(row.evidence_id) && row.kind === 'artifact');
    return refs.flatMap(source => {
      // An output must be explicitly named by one actual user prompt. Contract
      // ID suffixes and a final snapshot's turn ID are not task-turn bindings.
      const namedBy = [...runtimeTurns.values()].filter(row => typeof row.prompt === 'string' && row.prompt.includes(source.path));
      if (namedBy.length !== 1 || namedBy[0].id !== turn.id) return [];
      const observations = (readback?.evidence?.artifacts ?? []).map((row, index) => ({ row, index }))
        .filter(({ row }) => row.turn_id === turn.id && row.path === source.path);
      if (observations.length !== 1) return [];
      const observed = observations[0], workspaceId = runtimeTurns.get(turn.id)?.workspace_manifest_ref?.artifact_id;
      const workspaceFiles = (json(workspaceId)?.files ?? []).map((value, index) => ({ value, index })).filter(({ value }) => value.path === source.path);
      const contentMatches = typeof observed.row.content === 'string' && createHash('sha256').update(observed.row.content).digest('hex') === source.sha256;
      const matches = observed.row.sha256 === source.sha256 && contentMatches && workspaceFiles.length === 1 && workspaceFiles[0].value.sha256 === source.sha256;
      const originalIndex = grade.contracts.findIndex(row => row.id === check.id);
      return [{ contract_id: check.id, critical: check.critical === true, path: source.path, original_status: check.status,
        status: matches ? check.status : 'unknown',
        reason: matches ? 'Original graded bytes match the uniquely named user turn, readback content and workspace manifest' : 'User-turn content or workspace bytes do not establish the original graded bytes',
        original_sha256: source.sha256, turn_sha256: observed.row.sha256,
        refs: [ref('collection-grade', { pointer: '/contracts/' + originalIndex }),
          ref('collection-readback', { pointer: '/evidence/artifacts/' + observed.index }),
          ref('collection-runtime-result', { pointer: '/turns/' + [...runtimeTurns.keys()].indexOf(turn.id) + '/prompt' }),
          ...(workspaceFiles.length === 1 ? [ref(workspaceId, { pointer: '/files/' + workspaceFiles[0].index })] : [])] }];
    });
  });
  const rows = turnRows.map(turn => {
    const ownRequests = [...requests.values()].filter(request => request.turn_id === turn.id);
    const ownAttempts = episode.attempts.filter(attempt => ownRequests.some(request => request.id === attempt.request_id));
    const ownTools = episode.tools.filter(tool => tool.turn_id === turn.id);
    allAttempts.push(...ownAttempts); allRequests.push(...ownRequests); allTools.push(...ownTools);
    const closed = Boolean(turn.end), prefixComplete = closed && complete && unknownAttempts.length === 0;
    const resources = (readback?.evidence?.resource_reads ?? []).map((value, index) => ({ value, index })).filter(({ value }) => value.turn_id === turn.id);
    return { turn_id: turn.id, completed: closed, request_ids: ownRequests.map(request => request.id),
      attempt_ids: ownAttempts.map(attempt => attempt.id), tool_ids: ownTools.map(tool => tool.id),
      marginal: { ...usage(ownAttempts, prefixComplete), model_requests_started: ownRequests.length,
        recorded_tool_calls: ownTools.length, executed_tool_calls: ownTools.filter(tool => tool.execution === 'observed').length,
        top_level_tool_calls: ownTools.filter(tool => tool.parent_id === null).length,
        nested_tool_calls: ownTools.filter(tool => tool.parent_id !== null).length },
      cumulative: { ...usage(allAttempts, prefixComplete), model_requests_started: allRequests.length,
        recorded_tool_calls: allTools.length, executed_tool_calls: allTools.filter(tool => tool.execution === 'observed').length,
        top_level_tool_calls: allTools.filter(tool => tool.parent_id === null).length,
        nested_tool_calls: allTools.filter(tool => tool.parent_id !== null).length },
      timing: { user_turn_duration_ms: elapsed(turn.start.value.monotonic_ns, turn.end?.value.monotonic_ns),
        elapsed_from_episode_start_ms: elapsed(origin, turn.end?.value.monotonic_ns),
        elapsed_from_first_user_turn_ms: elapsed(turnRows[0].start.value.monotonic_ns, turn.end?.value.monotonic_ns) },
      business_artifacts: businessArtifacts(turn),
      resource_reads: resources.map(({ value, index }) => ({ skill_id: value.skill_id, path: value.path, kind: value.kind,
        tool_call_id: value.tool_call_id ?? null, sha256: value.sha256,
        refs: [ref('collection-readback', { pointer: '/evidence/resource_reads/' + index })] })),
      refs: [turn.start.ref, ...(turn.end ? [turn.end.ref] : []), ...ownRequests.map(request => request.ref)] };
  });
  const sdk = runtime?.notion;
  const operations = sdk?.operations ?? [];
  uniqueMap(operations, 'source_request_id', 'SDK source operation');
  const sourceOperations = operations.map((operation, index) => ({
    source_request_id: operation.source_request_id, operation: operation.operation, start_context_turn_id: operation.turn_id ?? null,
    stage: operation.stage ?? null, status: operation.status,
    http_attempts: operation.metrics_complete === true && Number.isSafeInteger(operation.http_attempts)
      ? known(operation.http_attempts) : unknown('Complete owned SDK HTTP metrics are unavailable'),
    association: 'Recorded operation context; not causal tool attribution or per-turn completion accounting',
    refs: [ref('collection-runtime-result', { pointer: '/notion/operations/' + index })],
  }));
  return { ...base, status: ended.size === turnRows.length && unknownAttempts.length === 0 && complete ? 'available' : 'partial',
    timing_basis: 'Original user_turn_start/end event clocks; end includes workspace capture. Episode elapsed includes startup and inter-turn gaps.',
    tool_count_scope: 'Normalized visible tool entries; parent containers and nested calls count separately. These are not logical operation counts.',
    quality_scope: 'Business artifacts retain original grades only when matching bytes existed in their uniquely named user turn. This is not a complete per-turn grade; resource and selection contracts remain episode-scoped.',
    startup_ms: elapsed(origin, turnRows[0].start.value.monotonic_ns),
    postlude_ms: elapsed(turnRows.at(-1).end?.value.monotonic_ns, runtime?.timing?.ended_monotonic_ns),
    episode_duration_ms: structuredClone(episode.timing.duration_ms),
    first_input_tokens: episode.measurements?.input_first ? structuredClone(episode.measurements.input_first)
      : complete && episode.attempts.every(attempt => attempt.sent !== null) && episode.attempts.some(attempt => attempt.sent === true)
        ? structuredClone(episode.attempts.find(attempt => attempt.sent === true).full_input) : unknown('No complete first actual provider input'),
    coverage: structuredClone(episode.admission.completeness), rows,
    unattributed: { request_ids: [...requests.values()].filter(request => !turns.has(request.turn_id)).map(request => request.id),
      attempt_ids: unknownAttempts.map(attempt => attempt.id), tool_ids: unknownTools.map(tool => tool.id),
      usage: usage(unknownAttempts, complete) },
    source_operations: { coverage: sdk?.coverage ?? null, scope: sdk?.source_scope ?? 'unavailable', rows: sourceOperations },
    refs: selected.map(artifact => ({ artifact_id: artifact.id, sha256: artifact.sha256 })),
  };
}
