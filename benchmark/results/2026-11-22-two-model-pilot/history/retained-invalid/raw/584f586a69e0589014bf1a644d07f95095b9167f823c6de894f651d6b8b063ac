import { canonicalJson, fingerprint } from '../protocol.mjs';

export const EVIDENCE_VERSION = '1.0.0';
const hashPattern = /^[a-f0-9]{64}$/;
const outcomes = new Set(['pass', 'fail', 'unknown', 'not_applicable']);
const precision = new Set(['observed', 'reported', 'derived', 'estimated']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value, label) => {
  if (typeof value !== 'string' || !value.length || value.length > 240) throw new TypeError('Missing bounded ' + label);
  return value;
};
export const unknown = (reason, refs = []) => ({ status: 'unknown', reason, refs });
export const known = (value, refs, label = 'observed', formula = null) => ({
  status: 'known', value, precision: label, refs, ...(formula === null ? {} : { formula }),
});

export function validateRef(ref, artifacts) {
  if (!object(ref) || !hashPattern.test(ref.sha256 ?? '')) throw new TypeError('Evidence ref needs SHA256');
  const artifact = artifacts.get(ref.artifact_id);
  if (!artifact || artifact.sha256 !== ref.sha256) throw new TypeError('Evidence ref must resolve to its raw artifact hash');
  const line = Object.hasOwn(ref, 'line'), pointer = Object.hasOwn(ref, 'pointer');
  if (line === pointer || line && (!Number.isSafeInteger(ref.line) || ref.line < 1) ||
      pointer && (typeof ref.pointer !== 'string' || ref.pointer !== '' && !ref.pointer.startsWith('/') || /~(?![01])/u.test(ref.pointer)))
    throw new TypeError('Evidence ref needs exactly one valid line or JSON pointer');
  return structuredClone(ref);
}

function refsOf(refs, artifacts, required = false) {
  if (!Array.isArray(refs) || required && !refs.length) throw new TypeError('Observed claims require raw evidence refs');
  return refs.map(ref => validateRef(ref, artifacts));
}

export function validateFact(value, artifacts, { numeric = false } = {}) {
  if (!object(value) || !['known', 'unknown'].includes(value.status)) throw new TypeError('Expected known or unknown fact');
  const refs = refsOf(value.refs, artifacts, value.status === 'known');
  if (value.status === 'unknown') return unknown(id(value.reason, 'unknown reason'), refs);
  if (!precision.has(value.precision)) throw new TypeError('Unknown evidence precision');
  if (numeric && (!Number.isFinite(value.value) || value.value < 0)) throw new TypeError('Expected a nonnegative finite measured value');
  canonicalJson(value.value);
  if (value.precision === 'derived' && (typeof value.formula !== 'string' || !value.formula))
    throw new TypeError('Derived fact requires a versioned formula');
  return { ...structuredClone(value), refs };
}

function unique(values, name) {
  const seen = new Set();
  for (const value of values) {
    id(value.id, name + ' ID');
    if (seen.has(value.id)) throw new TypeError('Duplicate ' + name + ': ' + value.id);
    seen.add(value.id);
  }
}
function sumFacts(facts, formula, complete = true) {
  const usable = facts.filter(f => f.status === 'known' && f.precision !== 'estimated');
  const refs = usable.flatMap(f => f.refs);
  const subtotal = usable.reduce((sum, f) => sum + f.value, 0);
  return { value: complete && usable.length === facts.length
    ? known(subtotal, refs, 'derived', formula) : unknown('Incomplete exact observations: ' + formula, refs),
  known_subtotal: subtotal, observed_items: usable.length, total_items: facts.length };
}
function inputFor(attempt) {
  if (!attempt.adapter.verified) return unknown('Adapter usage semantics are unverified', attempt.refs);
  const input = attempt.usage.input;
  if (attempt.adapter.input_semantics === 'includes_cache') return input;
  if (attempt.adapter.input_semantics === 'excludes_cache_read_write')
    return sumFacts([input, attempt.usage.cache_read, attempt.usage.cache_write], 'input+cache_read+cache_write/v1').value;
  return unknown('Full input semantics are unknown', attempt.refs);
}
function outputFor(attempt) {
  if (!attempt.adapter.verified) return unknown('Adapter usage semantics are unverified', attempt.refs);
  if (attempt.adapter.output_semantics === 'includes_reasoning') return attempt.usage.output;
  if (attempt.adapter.output_semantics === 'excludes_reasoning')
    return sumFacts([attempt.usage.output, attempt.usage.reasoning], 'output+reasoning/v1').value;
  return unknown('Full output semantics are unknown', attempt.refs);
}
function derivedWithZero(facts, formula, complete, refs) {
  if (facts.length === 0 && complete) return { value: known(0, refs, 'derived', formula), known_subtotal: 0, observed_items: 0, total_items: 0 };
  return sumFacts(facts, formula, complete);
}

export function normalizeEpisode({ identity, admission, attempts, tools, business, contracts, interventions, timing, artifacts }) {
  if (!object(identity)) throw new TypeError('Episode identity is required');
  for (const name of ['episode_id', 'run_id', 'experiment_id', 'condition_id', 'case_id']) id(identity[name], name);
  if (!Number.isSafeInteger(identity.repeat) || identity.repeat < 0) throw new TypeError('repeat must be a nonnegative integer');
  for (const [name, value] of Object.entries({ artifacts, attempts, tools, contracts, interventions }))
    if (!Array.isArray(value)) throw new TypeError(name + ' must be an array, including an observed empty array');
  unique(artifacts, 'artifact');
  const registry = new Map(artifacts.map(a => {
    if (!hashPattern.test(a.sha256 ?? '') || typeof a.path !== 'string' || !a.path) throw new TypeError('Raw artifact needs a path and SHA256');
    return [a.id, { ...a }];
  }));
  if (!object(admission) || !['valid', 'invalid'].includes(admission.status)) throw new TypeError('Admission is valid or invalid');
  const admissionRefs = refsOf(admission.refs, registry, true);
  const completeness = {};
  for (const name of ['attempts', 'tools', 'interventions']) {
    const state = admission.completeness?.[name] ?? 'unavailable';
    if (!['complete', 'partial', 'unavailable'].includes(state)) throw new TypeError('Unknown completeness state');
    completeness[name] = state;
  }
  const facts = value => validateFact(value, registry, { numeric: true });
  unique(attempts, 'attempt');
  const normalizedAttempts = attempts.map((attempt, index) => {
    if (![true, false, null].includes(attempt.sent)) throw new TypeError('Actual send status must be observed true, false or unknown null');
    if (!Number.isSafeInteger(attempt.seq) || attempt.seq < 0) throw new TypeError('Attempt sequence must be observed');
    const refs = refsOf(attempt.refs, registry, true);
    const usage = Object.fromEntries(['input', 'output', 'cache_read', 'cache_write', 'reasoning'].map(name =>
      [name, facts(attempt.usage?.[name] ?? unknown('Missing ' + name + ' usage', refs))]));
    for (const value of Object.values(usage))
      if (value.status === 'known' && !Number.isSafeInteger(value.value)) throw new TypeError('Token observations must be nonnegative safe integers');
    const adapter = { id: attempt.adapter?.id ?? null, version: attempt.adapter?.version ?? null,
      verified: attempt.adapter?.verified === true, input_semantics: attempt.adapter?.input_semantics ?? null,
      output_semantics: attempt.adapter?.output_semantics ?? null };
    if (adapter.verified && (!adapter.id || !adapter.version || !hashPattern.test(attempt.adapter?.evidence_sha256 ?? '')))
      throw new TypeError('Verified adapter requires identity and verification evidence SHA256');
    if (adapter.verified) adapter.evidence_sha256 = attempt.adapter.evidence_sha256;
    let cost = attempt.cost ? validateFact(attempt.cost, registry) : unknown('No verified route price', refs);
    if (cost.status === 'known' && (!object(cost.value) || !Number.isFinite(cost.value.amount) || cost.value.amount < 0 ||
        typeof cost.value.currency !== 'string' || !cost.value.currency || attempt.pricing_verified !== true))
      throw new TypeError('Currency cost requires nonnegative amount, currency and verified pricing');
    const value = { ...structuredClone(attempt), request_id: id(attempt.request_id, 'request ID'), seq: attempt.seq,
      refs, usage, adapter, cost, index };
    const fullInput = inputFor(value), fullOutput = outputFor(value);
    const usable = fact => fact.status === 'known' && fact.precision !== 'estimated' ? fact.value : 0;
    const inputSubtotal = adapter.verified ? adapter.input_semantics === 'includes_cache' ? usable(usage.input)
      : adapter.input_semantics === 'excludes_cache_read_write' ? usable(usage.input) + usable(usage.cache_read) + usable(usage.cache_write) : 0 : 0;
    const outputSubtotal = adapter.verified ? adapter.output_semantics === 'includes_reasoning' ? usable(usage.output)
      : adapter.output_semantics === 'excludes_reasoning' ? usable(usage.output) + usable(usage.reasoning) : 0 : 0;
    return { ...value, full_input: fullInput, full_output: fullOutput, known_input_subtotal: inputSubtotal, known_output_subtotal: outputSubtotal };
  }).sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  if (new Set(normalizedAttempts.map(a => a.seq)).size !== normalizedAttempts.length) throw new TypeError('Attempt sequence must be unique');
  unique(tools, 'tool call');
  const toolIds = new Set(tools.map(t => t.id));
  const normalizedTools = tools.map(tool => {
    if (tool.parent_id !== null && !toolIds.has(tool.parent_id)) throw new TypeError('Nested tool call must reference its retained parent');
    if (!['pass', 'fail', 'unknown', 'running'].includes(tool.status)) throw new TypeError('Unknown tool result status');
    return { ...structuredClone(tool), name: id(tool.name, 'tool name'), refs: refsOf(tool.refs, registry, true) };
  });
  for (const tool of normalizedTools) {
    const seen = new Set([tool.id]); let parent = tool.parent_id;
    while (parent !== null) {
      if (seen.has(parent)) throw new TypeError('Tool ancestry must be acyclic');
      seen.add(parent); parent = normalizedTools.find(t => t.id === parent).parent_id;
    }
  }
  if (!outcomes.has(business?.status)) throw new TypeError('Unknown business outcome');
  const normalizedBusiness = { ...structuredClone(business), refs: refsOf(business.refs, registry, ['pass', 'fail'].includes(business.status)),
    capability_status: business.capability_status ?? 'unknown', capability_scope: business.capability_scope ?? 'common' };
  if (!['supported', 'unsupported', 'unknown'].includes(normalizedBusiness.capability_status) ||
      !['common', 'extension'].includes(normalizedBusiness.capability_scope)) throw new TypeError('Unknown capability scope or status');
  unique(contracts, 'contract');
  const normalizedContracts = contracts.map(contract => {
    if (!outcomes.has(contract.status)) throw new TypeError('Unknown contract status');
    return { ...structuredClone(contract), critical: contract.critical === true,
      refs: refsOf(contract.refs, registry, ['pass', 'fail'].includes(contract.status)) };
  });
  unique(interventions, 'intervention');
  const normalizedInterventions = interventions.map(intervention => {
    if (!['human_rescue', 'evaluation_rescue', 'task_clarification', 'product_recovery'].includes(intervention.kind))
      throw new TypeError('Unknown intervention type');
    return { ...structuredClone(intervention), refs: refsOf(intervention.refs, registry, true) };
  });
  const rawTiming = { duration_ms: facts(timing?.duration_ms ?? unknown('Missing elapsed time')),
    time_to_success_ms: facts(timing?.time_to_success_ms ?? unknown('Missing verified completion boundary')) };
  const eligible = admission.status === 'valid' && normalizedBusiness.capability_status !== 'unsupported';
  const applicable = normalizedContracts.filter(c => c.status !== 'not_applicable');
  let outcome = 'unknown';
  if (!eligible || business.status === 'not_applicable') outcome = 'not_applicable';
  else if (normalizedBusiness.capability_status === 'supported') {
    if (business.status === 'fail' || applicable.some(c => c.status === 'fail')) outcome = 'fail';
    else if (business.status === 'pass' && applicable.every(c => c.status === 'pass')) outcome = 'pass';
  }
  const sent = normalizedAttempts.filter(a => a.sent === true);
  const allSendsKnown = completeness.attempts === 'complete' && normalizedAttempts.every(a => a.sent !== null);
  const input = derivedWithZero(sent.map(a => a.full_input), 'sum_all_actual_attempt_full_input/v1', allSendsKnown, admissionRefs);
  const output = derivedWithZero(sent.map(a => a.full_output), 'sum_all_actual_attempt_full_output/v1', allSendsKnown, admissionRefs);
  input.known_subtotal = sent.reduce((sum, attempt) => sum + attempt.known_input_subtotal, 0);
  output.known_subtotal = sent.reduce((sum, attempt) => sum + attempt.known_output_subtotal, 0);
  const allInputsKnown = input.value.status === 'known';
  const inputFirst = sent.length && allSendsKnown ? sent[0].full_input : unknown(sent.length ? 'Unobserved sends may precede first recorded attempt' : 'No actual model send', admissionRefs);
  const inputPeak = allInputsKnown ? known(sent.length ? Math.max(...sent.map(a => a.full_input.value)) : 0,
    sent.length ? sent.flatMap(a => a.full_input.refs) : admissionRefs, 'derived', 'max_all_actual_attempt_full_input/v1')
    : unknown('Peak cannot be established from incomplete exact input usage', input.value.refs);
  const rescues = normalizedInterventions.filter(i => ['human_rescue', 'evaluation_rescue'].includes(i.kind));
  const unassisted = outcome !== 'pass' ? false : rescues.length > 0 ? false : completeness.interventions === 'complete' ? true : null;
  const costsKnown = allSendsKnown && sent.every(a => a.cost.status === 'known' && a.cost.precision !== 'estimated');
  const currencies = [...new Set(sent.filter(a => a.cost.status === 'known').map(a => a.cost.value.currency))];
  const cost = costsKnown && currencies.length === 1 ? known({ currency: currencies[0], amount: sent.reduce((n,a) => n + a.cost.value.amount,0) },
    sent.flatMap(a => a.cost.refs), 'derived', 'sum_actual_attempt_currency_cost/v1') : unknown('Missing, unpriced or mixed currency costs', admissionRefs);
  const episode = { schema_version: 1, kind: 'benchmark-normalized-episode', normalizer_version: EVIDENCE_VERSION,
    identity: structuredClone(identity), admission: { ...structuredClone(admission), refs: admissionRefs, completeness },
    artifacts: [...registry.values()], attempts: normalizedAttempts, tools: normalizedTools,
    business: normalizedBusiness, contracts: normalizedContracts, interventions: normalizedInterventions, timing: rawTiming,
    result: { outcome, verified_success: outcome === 'pass', unassisted_success: unassisted,
      critical_failures: normalizedContracts.filter(c => c.critical && c.status === 'fail').map(c => c.id) },
    measurements: { input_first: inputFirst, input_peak: inputPeak, input_total: input, output_total: output, cost,
      actual_attempts: allSendsKnown ? known(sent.length, admissionRefs, 'derived', 'count_actual_sends/v1') : unknown('Incomplete actual send observation', admissionRefs),
      known_actual_attempts: sent.length,
      transport_http_attempts: admission.http_attempts ? facts(admission.http_attempts) : unknown('All transport HTTP attempts have not been independently counted', admissionRefs),
      retries: allSendsKnown ? known(sent.length - new Set(sent.map(a => a.request_id)).size, admissionRefs, 'derived', 'actual_sends_minus_distinct_logical_requests/v1') : unknown('Incomplete actual retry observation', admissionRefs),
      model_decisions: allSendsKnown ? known(new Set(sent.map(a => a.request_id)).size, admissionRefs, 'derived', 'distinct_logical_requests/v1') : unknown('Incomplete logical request observation', admissionRefs),
      tool_top_level: completeness.tools === 'complete' ? known(normalizedTools.filter(t => t.parent_id === null).length, admissionRefs, 'derived', 'count_top_level_tool_calls/v1') : unknown('Incomplete tool observation', admissionRefs),
      tool_nested: completeness.tools === 'complete' ? known(normalizedTools.filter(t => t.parent_id !== null).length, admissionRefs, 'derived', 'count_nested_tool_calls/v1') : unknown('Incomplete tool observation', admissionRefs),
      logical_operations: completeness.tools === 'complete' && normalizedTools.every(t => typeof t.logical_operation_id === 'string')
        ? known(new Set(normalizedTools.map(t => t.logical_operation_id)).size, admissionRefs, 'derived', 'distinct_logical_operation_ids/v1') : unknown('Logical operations are not fully attributed', admissionRefs),
      observed_rescues: rescues.length,
      interface_misuse: normalizedTools.some(t => t.interface_misuse === true) ? known(1, normalizedTools.filter(t => t.interface_misuse).flatMap(t => t.refs), 'derived', 'any_interface_misuse_in_episode/v1')
        : completeness.tools === 'complete' && normalizedTools.every(t => typeof t.interface_misuse === 'boolean')
          ? known(0, admissionRefs, 'derived', 'any_interface_misuse_in_episode/v1') : unknown('Interface misuse classification is incomplete', admissionRefs) },
    episode_sha256: null };
  episode.episode_sha256 = fingerprint(episode);
  const events = [
    { type: 'admission', value: episode.admission, refs: admissionRefs },
    ...normalizedAttempts.map(value => ({ type: 'model_attempt', value, refs: value.refs })),
    ...normalizedTools.map(value => ({ type: 'tool_call', value, refs: value.refs })),
    ...normalizedInterventions.map(value => ({ type: 'intervention', value, refs: value.refs })),
    { type: 'business_readback', value: { business: normalizedBusiness, contracts: normalizedContracts }, refs: [...normalizedBusiness.refs, ...normalizedContracts.flatMap(c=>c.refs)] },
  ].map((event, seq) => ({ schema_version: 1, episode_id: identity.episode_id, seq, ...event }));
  const journey = { schema_version: 1, normalizer_version: EVIDENCE_VERSION, episode_id: identity.episode_id,
    identity: episode.identity, episode_sha256: episode.episode_sha256, goal: identity.goal ?? null,
    admission: episode.admission, outcome: episode.result, timings: episode.timing, measurements: episode.measurements,
    stages: events.map(event => ({ event_seq: event.seq, kind: event.type, refs: event.refs })),
    tool_tree: normalizedTools.map(t => ({ id: t.id, parent_id: t.parent_id, name: t.name, status: t.status, refs: t.refs })),
    interpretations: [], limitations: Object.entries(completeness).filter(([,v]) => v !== 'complete').map(([k,v])=> k + ': ' + v) };
  return { episode, events, journey };
}

export function renderJourney(journey) {
  const lines = ['# Episode ' + journey.episode_id, '', 'Goal: ' + (journey.goal ?? 'not recorded'), '',
    '- Admission: ' + journey.admission.status, '- Outcome: ' + journey.outcome.outcome,
    '- Verified success: ' + journey.outcome.verified_success, '- Unassisted success: ' + String(journey.outcome.unassisted_success),
    '', '## Observed tool lineage', ''];
  for (const tool of journey.tool_tree) lines.push('- ' + tool.id + ': ' + tool.name + ' (' + tool.status + '), parent=' + (tool.parent_id ?? 'none'));
  if (!journey.tool_tree.length) lines.push('No retained tool calls. See completeness before interpreting this as zero.');
  lines.push('', '## Raw evidence', '');
  for (const stage of journey.stages) for (const ref of stage.refs)
    lines.push('- ' + stage.kind + ': ' + ref.artifact_id + ' @ ' + ref.sha256 + ' ' + (ref.line ? 'line ' + ref.line : 'pointer ' + JSON.stringify(ref.pointer)));
  lines.push('', '## Limitations', '', ...(journey.limitations.length ? journey.limitations.map(x=>'- ' + x) : ['No additional normalization limitations recorded.']), '');
  return lines.join('\n');
}
