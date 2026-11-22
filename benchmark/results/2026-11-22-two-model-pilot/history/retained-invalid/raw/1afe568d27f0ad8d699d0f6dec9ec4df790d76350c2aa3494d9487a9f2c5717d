import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const STATUSES = new Set(['pass', 'fail', 'unknown', 'not_applicable']);
const KINDS = new Set(['artifact-json', 'selection', 'resources', 'clarification', 'state-event']);
const hash = value => createHash('sha256').update(value).digest('hex');
const own = (value, key) => Object.hasOwn(value, key);

function same(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && typeof a === 'object') return !!b && typeof b === 'object' && !Array.isArray(b)
    && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => own(b, k) && same(a[k], b[k]));
  return false;
}

function subset(expected, actual) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => subset(v, actual[i]));
  if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object' && !Array.isArray(actual)
    && Object.keys(expected).every(k => own(actual, k) && subset(expected[k], actual[k]));
  return same(expected, actual);
}

function forbiddenKeys(value, keys) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(keys.includes(key) ? [key] : []), ...forbiddenKeys(child, keys),
  ]);
}

function result(contract, status, evidence, reason) {
  assert.ok(STATUSES.has(status));
  return { id: contract.id, kind: contract.kind, status, critical: contract.critical === true,
    evidence_ids: [...new Set(evidence.map(item => item.evidence_id).filter(Boolean))], reason };
}

function coverage(evidence, kind) { return evidence.coverage?.[kind] ?? 'partial'; }
function missing(contract, evidence, kind, reason) {
  return result(contract, coverage(evidence, kind) === 'complete' ? 'fail' : 'unknown', [], reason);
}

export function validateOracle(oracle) {
  assert.equal(oracle?.schema_version, 1, 'Oracle schema_version must be 1');
  assert.equal(typeof oracle.case_id, 'string', 'Oracle needs case_id');
  assert.ok(['common', 'extension'].includes(oracle.capability_scope), 'Invalid capability scope');
  assert.ok(Array.isArray(oracle.required_capabilities), 'Oracle needs required_capabilities');
  assert.ok(Array.isArray(oracle.contracts) && oracle.contracts.length > 0, 'Oracle needs contracts');
  const ids = new Set();
  for (const contract of oracle.contracts) {
    assert.equal(typeof contract.id, 'string'); assert.ok(!ids.has(contract.id), 'Duplicate contract id'); ids.add(contract.id);
    assert.ok(KINDS.has(contract.kind), 'Unknown contract kind ' + contract.kind);
    if (contract.kind === 'artifact-json') {
      assert.equal(typeof contract.path, 'string');
      assert.ok(['exact', 'subset', 'rows-by-key'].includes(contract.comparison));
      assert.ok(own(contract, 'expected'));
      if (contract.comparison === 'rows-by-key') {
        assert.ok(Array.isArray(contract.expected)); assert.equal(typeof contract.row_key, 'string');
        const keys = contract.expected.map(row => row[contract.row_key]);
        assert.ok(keys.every(key => key !== undefined), 'Expected rows need keys');
        assert.equal(new Set(keys).size, keys.length, 'Expected row keys must be unique');
      }
    }
    if (contract.kind === 'selection') assert.ok(Array.isArray(contract.allowed_sets) && contract.allowed_sets.length > 0);
    if (contract.kind === 'resources') {
      assert.ok(Array.isArray(contract.alternatives) && contract.alternatives.length > 0);
      for (const alternative of contract.alternatives) {
        assert.ok(Array.isArray(alternative) && alternative.length > 0);
        for (const resource of alternative) {
          assert.equal(typeof resource.skill_id, 'string'); assert.equal(typeof resource.path, 'string');
          assert.match(resource.sha256, /^[a-f0-9]{64}$/);
        }
      }
    }
    if (contract.kind === 'clarification') {
      assert.equal(typeof contract.topic_id, 'string');
      assert.ok(Number.isSafeInteger(contract.min) && Number.isSafeInteger(contract.max) && contract.min >= 0 && contract.max >= contract.min);
    }
    if (contract.kind === 'state-event') assert.equal(typeof contract.event_id, 'string');
  }
  assert.ok(oracle.contracts.some(contract => contract.kind === 'artifact-json'), 'Oracle must define a business deliverable');
  return oracle;
}

function gradeArtifact(contract, evidence) {
  const observed = (evidence.artifacts ?? []).filter(item => item.path === contract.path
    && (!contract.turn_id || !item.turn_id || item.turn_id === contract.turn_id));
  if (!observed.length) return missing(contract, evidence, 'artifacts', 'Required deliverable was not observed');
  const artifact = observed.at(-1);
  if (typeof artifact.content !== 'string') return result(contract, 'unknown', [artifact], 'Artifact bytes were not retained');
  if (artifact.sha256 && hash(artifact.content) !== artifact.sha256)
    return result(contract, 'unknown', [artifact], 'Artifact evidence hash does not match its bytes');
  let value;
  try { value = JSON.parse(artifact.content); } catch { return result(contract, 'fail', [artifact], 'Observed deliverable is not valid JSON'); }
  const forbidden = forbiddenKeys(value, contract.forbidden_fields ?? []);
  if (forbidden.length) return result(contract, 'fail', [artifact], 'Observed deliverable retains forbidden fields: ' + [...new Set(forbidden)].join(', '));
  let matches;
  if (contract.comparison === 'exact') matches = same(contract.expected, value);
  else if (contract.comparison === 'subset') matches = subset(contract.expected, value);
  else {
    const key = contract.row_key;
    matches = Array.isArray(value) && value.length === contract.expected.length;
    if (matches) {
      const rows = new Map(value.map(row => [row?.[key], row]));
      matches = rows.size === value.length && !rows.has(undefined)
        && contract.expected.every(expected => rows.has(expected[key]) && subset(expected, rows.get(expected[key])));
    }
  }
  return result(contract, matches ? 'pass' : 'fail', [artifact],
    matches ? 'Observed business values satisfy the declared output contract' : 'Observed business values differ from the declared output contract');
}

function gradeSelection(contract, evidence) {
  const rows = evidence.selections ?? [], selected = [...new Set(rows.map(item => item.skill_id))];
  const allowed = new Set(contract.allowed_sets.flat());
  const forbidden = rows.filter(item => !allowed.has(item.skill_id));
  if (forbidden.length) return result(contract, 'fail', forbidden, 'Observed a selection outside all legal candidate sets');
  const matches = contract.allowed_sets.some(set => set.length === selected.length && set.every(id => selected.includes(id)));
  if (matches && (selected.length > 0 || coverage(evidence, 'selections') === 'complete'))
    return result(contract, 'pass', rows, selected.length ? 'Observed selection is one of the legal sets' : 'Complete evidence shows no Skill was selected');
  if (coverage(evidence, 'selections') !== 'complete')
    return result(contract, 'unknown', rows, 'Selection evidence is incomplete');
  return result(contract, 'fail', rows, 'Observed selection does not satisfy any legal candidate set');
}

function gradeResources(contract, evidence) {
  const reads = evidence.resource_reads ?? [];
  for (const alternative of contract.alternatives) {
    const matched = alternative.map(expected => reads.find(read => read.skill_id === expected.skill_id
      && read.path === expected.path && read.sha256 === expected.sha256
      && (!expected.turn_id || read.turn_id === expected.turn_id)));
    if (matched.every(Boolean)) return result(contract, 'pass', matched, 'Observed a complete legal resource path with matching content identities');
  }
  // An incomplete adapter is not evidence that the Agent skipped a resource.
  return result(contract, coverage(evidence, 'resource_reads') === 'complete' ? 'fail' : 'unknown', reads,
    'No complete legal resource path was observed');
}

function gradeClarification(contract, evidence) {
  const all = evidence.clarifications ?? [], matching = all.filter(item => item.topic_id === contract.topic_id);
  if (all.length > contract.max) return result(contract, 'fail', all, 'Observed clarification count exceeds the declared bound');
  if (matching.length < contract.min) return missing(contract, evidence, 'clarifications', 'Required clarification was not observed');
  if (matching.length > contract.max) return result(contract, 'fail', matching, 'Observed clarification count exceeds the declared bound');
  if (contract.before_artifact && matching.some(item => item.before_completion === false))
    return result(contract, 'fail', matching, 'Clarification was observed after completion');
  if (contract.before_artifact && matching.some(item => item.before_completion !== true))
    return result(contract, 'unknown', matching, 'Clarification timing before completion was not proven');
  return result(contract, 'pass', matching, 'Required bounded clarification was observed');
}

function gradeStateEvent(contract, evidence) {
  const rows = (evidence.state_events ?? []).filter(item => item.id === contract.event_id);
  if (!rows.length) return missing(contract, evidence, 'state_events', 'Required state event was not observed');
  const last = rows.at(-1), success = ['applied', 'completed', 'passed'];
  if (last.status === contract.expected_status || (contract.expected_status === 'applied' && success.includes(last.status)))
    return result(contract, 'pass', [last], 'State change has a successful readback');
  if (['failed', 'rejected', 'not_applied'].includes(last.status)) return result(contract, 'fail', [last], 'State change readback confirms failure');
  return result(contract, 'unknown', [last], 'State change outcome remains unknown');
}

/** Pure private grading: consumes retained observations; never reads or repairs product state. */
export function gradeEpisode({ oracle, evidence = {}, capabilities = [] }) {
  validateOracle(oracle);
  assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'Evidence must be an object');
  for (const key of ['artifacts', 'selections', 'resource_reads', 'clarifications', 'state_events']) {
    assert.ok(evidence[key] === undefined || Array.isArray(evidence[key]), 'Evidence ' + key + ' must be an array');
    for (const item of evidence[key] ?? []) {
      assert.equal(typeof item.evidence_id, 'string', 'Observed evidence needs an evidence_id');
      assert.ok(item.evidence_id.length > 0, 'Observed evidence needs a nonempty evidence_id');
    }
    assert.ok(evidence.coverage?.[key] === undefined || ['complete', 'partial', 'unavailable'].includes(evidence.coverage[key]), 'Invalid evidence coverage');
  }
  assert.ok(Array.isArray(capabilities), 'Capabilities must be an array');
  for (const capability of capabilities) {
    if (typeof capability === 'string') assert.ok(capability.length > 0, 'Capability ID must be nonempty');
    else {
      assert.equal(typeof capability?.id, 'string', 'Capability observation needs an ID');
      assert.equal(typeof capability.supported, 'boolean', 'Capability observation needs an explicit boolean supported value');
    }
  }
  const supported = new Map(capabilities.map(capability => typeof capability === 'string' ? [capability, true] : [capability.id, capability.supported]));
  assert.equal(supported.size, capabilities.length, 'Duplicate capability declarations');
  const absent = oracle.required_capabilities.filter(id => !supported.has(id));
  const unsupported = oracle.required_capabilities.filter(id => supported.get(id) === false);
  const capabilityStatus = unsupported.length ? 'unsupported' : absent.length ? 'unknown' : 'supported';
  const graders = { 'artifact-json': gradeArtifact, selection: gradeSelection, resources: gradeResources,
    clarification: gradeClarification, 'state-event': gradeStateEvent };
  const contracts = oracle.contracts.map(contract => capabilityStatus === 'unsupported'
    ? result(contract, 'not_applicable', [], 'Required capability is explicitly unsupported')
    : graders[contract.kind](contract, evidence));
  const business = contracts.filter(contract => contract.kind === 'artifact-json').map(contract => contract.status);
  const businessOutcome = business.every(status => status === 'not_applicable') ? 'not_applicable'
    : business.includes('fail') ? 'fail' : business.includes('unknown') ? 'unknown' : 'pass';
  const used = new Set(contracts.flatMap(contract => contract.evidence_ids));
  const refs = [
    ...(evidence.artifacts ?? []).map(item => ({ evidence_id: item.evidence_id, kind: 'artifact', path: item.path, ...(item.sha256 ? { sha256: item.sha256 } : {}) })),
    ...(evidence.resource_reads ?? []).map(item => ({ evidence_id: item.evidence_id, kind: 'resource', path: item.path, ...(item.sha256 ? { sha256: item.sha256 } : {}) })),
    ...(evidence.state_events ?? []).map(item => ({ evidence_id: item.evidence_id, kind: 'state-event' })),
  ].filter(item => used.has(item.evidence_id));
  const readbackRefs = [...new Map(refs.map(ref => [ref.evidence_id, ref])).values()];
  return {
    schema_version: 1, case_id: oracle.case_id, business_outcome: businessOutcome,
    capability_scope: oracle.capability_scope, capability_status: capabilityStatus,
    unsupported_capabilities: unsupported, unknown_capabilities: absent, contracts,
    critical_flags: contracts.filter(contract => contract.critical && contract.status === 'fail')
      .map(contract => ({ contract_id: contract.id, reason: contract.reason, evidence_ids: contract.evidence_ids })),
    readback_refs: readbackRefs,
    verified_success: capabilityStatus === 'supported' && businessOutcome === 'pass'
      && contracts.every(contract => contract.status === 'pass' || contract.status === 'not_applicable'),
  };
}
