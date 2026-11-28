import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const readRows = async path => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const userTexts = session => session.branch.filter(row => row.type === 'message' && row.message?.role === 'user')
  .map(row => typeof row.message.content === 'string' ? row.message.content
    : row.message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
const now = () => process.hrtime.bigint().toString();
const milliseconds = (end, start) => Number(BigInt(end) - BigInt(start)) / 1e6;
const one = (rows, message) => { assert.equal(rows.length, 1, message); return rows[0]; };

function delayPlan(facts) {
  const library = facts.sample.notion.library;
  return [
    ...[
      ['catalog-root', 'list', '/v1/pages/' + library.library_id],
      ['catalog-children', 'list', '/v1/blocks/' + library.library_id + '/children'],
      ['catalog-skills-schema', 'list', '/v1/data_sources/' + library.skills.data_source_id],
      ['initial-consume-owner', 'consume', '/v1/pages/' + facts.members[0].legacy_page_id],
    ].map(([label, operation, path]) => ({ label, operation, path, stage: 'ordinary', delay_ms: 0 })),
    { label: 'source-discovery-root', stage: 'discovery', operation: 'source-members', path: '/v1/pages/' + library.library_id, delay_ms: 14000 },
    { label: 'source-discovery-children', stage: 'discovery', operation: 'source-members', path: '/v1/blocks/' + library.library_id + '/children', delay_ms: 20000 },
    ...['skills', 'files', 'records', 'sources'].map(role => ({
      label: 'source-discovery-' + role + '-schema', stage: 'discovery', operation: 'source-members',
      path: '/v1/data_sources/' + library[role].data_source_id, delay_ms: 20000,
    })),
    { label: 'manager-root', stage: 'management', operation: 'management', path: '/v1/pages/' + library.library_id, delay_ms: 20000 },
    { label: 'manager-children', stage: 'management', operation: 'management', path: '/v1/blocks/' + library.library_id + '/children', delay_ms: 20000 },
    ...['skills', 'files'].map(role => ({
      label: 'manager-' + role + '-schema', stage: 'management', operation: 'management',
      path: '/v1/data_sources/' + library[role].data_source_id, delay_ms: 20000,
    })),
    ...[
      ['root', '/v1/pages/' + library.library_id],
      ['children', '/v1/blocks/' + library.library_id + '/children'],
      ['skills-schema', '/v1/data_sources/' + library.skills.data_source_id],
    ].map(([label, path]) => ({ label: 'post-catalog-' + label, stage: 'post_catalog', operation: 'list', path, delay_ms: 12000 })),
    ...[0, 1].map(index => ({ label: 'final-consume-' + (index ? 'required' : 'root'), stage: 'final_consume',
      operation: 'consume', path: '/v1/pages/' + facts.members[index].legacy_page_id, delay_ms: 18000 })),
  ].map(item => ({ ...item, method: 'GET' }));
}

function activeOwner(events, item, piPid) {
  const own = events.filter(row => row.observer_pid === piPid);
  const sdk = own.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'start'
    && !own.some(end => end.kind === 'context-broker.notion-sdk' && end.event === 'end' && end.id === row.id));
  const management = own.filter(row => row.kind === 'context-broker.notion-materialization' && row.event === 'start'
    && !own.some(end => end.kind === 'context-broker.notion-materialization' && end.event === 'result' && end.request_id === row.request_id));
  if (item.operation === 'management') {
    assert.equal(sdk.length, 0, 'A manager hold must not be charged to an active consumer SDK operation');
    const request = one(management, 'The held HTTP must belong to one active management request');
    const child = one(own.filter(row => row.kind === 'manager_transport' && row.event === 'spawn'
      && !own.some(end => end.kind === 'manager_transport' && end.event === 'close' && end.child_pid === row.child_pid)),
    'The held management HTTP requires its original active manager process');
    assert.ok(BigInt(request.observer_monotonic_ns) <= BigInt(child.observer_monotonic_ns));
    return { request_id: request.request_id, manager_pid: child.child_pid };
  }
  // The public manager still verifies the consumer scope after its child closes.
  // Release that matching GET immediately; only a ready-result-followed SDK list
  // can own the delayed post-catalog response.
  if (item.label === 'post-catalog-root' && management.length) {
    assert.equal(sdk.length, 0);
    const request = one(management, 'One unfinished management request owns this metadata GET');
    const child = one(own.filter(row => row.kind === 'manager_transport' && row.event === 'spawn'),
      'The unfinished request must retain its original manager PID');
    return { deferred: true, request_id: request.request_id, manager_pid: child.child_pid };
  }
  assert.equal(management.length, 0, 'A consumer SDK hold cannot overlap management');
  if (['post_catalog', 'final_consume'].includes(item.stage)) {
    const ready = one(own.filter(row => row.kind === 'context-broker.notion-materialization' && row.event === 'result'),
      'Post-management holds require the actual ready receipt');
    assert.ok(['ready', 'already_ready'].includes(ready.status));
  }
  const operation = one(sdk, 'The delayed HTTP must belong to exactly one active SDK operation: ' + item.label);
  assert.equal(operation.operation, item.operation);
  return { sdk_id: operation.id };
}

/** Delay actual HTTP responses, without changing the SDK, clocks or product deadlines. */
export async function runColdMaterializationPrompt({ base, facts, service, rpc, piPid, prompt }) {
  const initial = JSON.parse(await readFile(join(base, 'discovery-empty-session.json'), 'utf8'));
  assert.deepEqual(userTexts(initial), [], 'The cold client already has a user conversation');
  assert.equal(service.requests.length, 0, 'Cold literal selection must precede all Notion HTTP');
  const eventsPath = join(base, 'sdk.jsonl');
  const before = await readRows(eventsPath);
  assert.equal(before.some(row => ['list', 'consume', 'source-members'].includes(row.operation)), false,
    'A readonly discovery or body operation prewarmed the cold literal');
  const plan = delayPlan(facts), controls = [];
  const arm = item => {
    const hold = service.holdNext({ method: item.method, path: item.path });
    controls.push(hold); return hold;
  };
  let hold = arm(plan[0]);
  const receipt = { version: 3, kind: 'actual-pi-cold-materialization-budget', prompt, pi_pid: piPid,
    initial_session: 'discovery-empty-session.json', initial_http_count: service.requests.length,
    initial_sdk_events: before.length, sent_monotonic_ns: now(), holds: [], deferred_holds: [] };
  const save = () => writeFile(join(base, 'cold-budget.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  await save();
  const result = rpc.prompt(prompt).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  const prematurelyEnded = result.then(outcome => {
    throw new Error('Pi completed before all cold HTTP observations: ' + (outcome.ok ? 'completed' : outcome.error.message));
  });
  // Attach immediately: a failed prompt must not become an unhandled rejection.
  prematurelyEnded.catch(() => {});
  try {
    for (const [index, item] of plan.entries()) {
      let arrived, owner;
      for (;;) {
        arrived = await Promise.race([hold.reached, prematurelyEnded]);
        owner = activeOwner(await readRows(eventsPath), item, piPid);
        if (!owner.deferred) break;
        assert.ok(receipt.deferred_holds.length < 8, 'Unexpected repeated management metadata while awaiting its ready receipt');
        const next = arm(item), reached = now();
        const proof = { label: item.label, stage: 'management_pending', operation: 'management', method: item.method, path: item.path,
          delay_ms: 0, sequence: arrived.sequence, request_id: owner.request_id, manager_pid: owner.manager_pid,
          reached_monotonic_ns: reached, released_monotonic_ns: now() };
        receipt.deferred_holds.push(proof);
        hold.release();
        const closed = await hold.closed;
        proof.closed_monotonic_ns = closed.closed_monotonic_ns;
        assert.equal(closed.terminal, 'finished'); assert.equal(closed.status, 200);
        await save(); hold = next;
      }
      const next = index + 1 < plan.length ? arm(plan[index + 1]) : undefined;
      const proof = { ...item, sequence: arrived.sequence, ...owner, reached_monotonic_ns: now() };
      receipt.holds.push(proof); await save();
      const deadline = BigInt(proof.reached_monotonic_ns) + BigInt(item.delay_ms) * 1000000n;
      while (process.hrtime.bigint() < deadline) {
        let timer;
        try {
          const remaining = Math.ceil(Number(deadline - process.hrtime.bigint()) / 1e6);
          await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, Math.max(1, remaining)); }), prematurelyEnded]);
        } finally { clearTimeout(timer); }
      }
      proof.released_monotonic_ns = now(); hold.release();
      const closed = await hold.closed;
      proof.closed_monotonic_ns = closed.closed_monotonic_ns;
      assert.equal(closed.terminal, 'finished'); assert.equal(closed.status, 200);
      await save(); hold = next;
    }
    const outcome = await result;
    receipt.completed_monotonic_ns = now();
    if (!outcome.ok) throw outcome.error;
    receipt.status = 'completed'; await save();
    return outcome.value;
  } catch (error) {
    receipt.status = 'failed'; receipt.error = error.message;
    receipt.completed_monotonic_ns = now(); await save(); throw error;
  } finally { for (const control of controls) control.release(); }
}

/** Replay timestamps against raw HTTP/SDK/native-session evidence, not reported totals.
 * The caller also verifies the original manager stdout/stderr, binding and receipt.
 */
export function assertColdMaterializationBudget({ receipt, facts, source, events, initial, session, piPid }) {
  assert.equal(receipt.version, 3); assert.equal(receipt.kind, 'actual-pi-cold-materialization-budget');
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.pi_pid, piPid);
  assert.equal(receipt.initial_http_count, 0); assert.deepEqual(userTexts(initial), []);
  assert.equal(userTexts(session)[0], receipt.prompt);
  assert.ok(receipt.prompt.startsWith('$' + facts.members[0].name + ' '));
  assert.equal(userTexts(session).length, 1, 'The first literal cannot be preceded by a model discovery turn');
  const sent = BigInt(receipt.sent_monotonic_ns), completed = BigInt(receipt.completed_monotonic_ns);
  assert.ok(milliseconds(completed, sent) > 240000 && milliseconds(completed, sent) < 840000,
    'The actual cold turn must cross the former 240s wall and finish within 840s');
  assert.equal(source.some(row => BigInt(row.started_monotonic_ns) < sent), false, 'Notion HTTP preceded the literal input');
  const own = events.filter(row => row.observer_pid === piPid);
  assert.equal(own.some(row => ['list', 'consume', 'source-members'].includes(row.operation)
    && BigInt(row.observer_monotonic_ns) < sent), false, 'An SDK operation prewarmed the first literal');
  const actions = own.filter(row => row.kind === 'context-broker.notion-materialization');
  const start = one(actions.filter(row => row.event === 'start'), 'One management request must start');
  const managed = one(actions.filter(row => row.event === 'result'), 'One management request must settle');
  assert.equal(actions.length, 2);
  assert.equal(typeof start.request_id, 'string'); assert.ok(start.request_id.length > 0);
  assert.equal(managed.request_id, start.request_id);
  assert.ok(['ready', 'already_ready'].includes(managed.status));
  const transport = own.filter(row => row.kind === 'manager_transport');
  const spawn = one(transport.filter(row => row.event === 'spawn'), 'One fixed manager must actually spawn');
  const close = one(transport.filter(row => row.event === 'close'), 'The original manager must actually close');
  assert.equal(transport.length, 2);
  assert.ok(Number.isSafeInteger(spawn.child_pid) && spawn.child_pid > 0);
  assert.equal(close.child_pid, spawn.child_pid); assert.equal(close.code, 0); assert.equal(close.signal, null);
  assert.ok(BigInt(start.observer_monotonic_ns) <= BigInt(spawn.observer_monotonic_ns));
  assert.ok(BigInt(spawn.observer_monotonic_ns) < BigInt(close.observer_monotonic_ns));
  assert.ok(BigInt(close.observer_monotonic_ns) <= BigInt(managed.observer_monotonic_ns),
    'A ready result must follow the actual manager close');
  const managementMs = milliseconds(managed.observer_monotonic_ns, start.observer_monotonic_ns);
  assert.ok(managementMs >= 80000 && managementMs < 600000, 'Observed management must finish within its separate 600s allowance');

  const plan = delayPlan(facts);
  assert.equal(receipt.holds.length, plan.length);
  assert.equal(new Set(receipt.holds.map(proof => proof.sequence)).size, plan.length, 'A held HTTP response cannot prove two delays');
  for (const [index, proof] of receipt.holds.entries()) {
    for (const key of Object.keys(plan[index])) assert.equal(proof[key], plan[index][key]);
    const request = one(source.filter(row => row.sequence === proof.sequence), 'The held request must have one original HTTP record');
    assert.equal(request.method, proof.method); assert.equal(request.path, proof.path);
    assert.equal(request.control, 'hold-before-headers'); assert.equal(request.phase, 'materialize');
    assert.equal(request.terminal, 'finished'); assert.equal(request.status, 200);
    assert.equal(request.response_bytes_complete, true);
    // The fixture marks writes only; the exact GET method and path were checked above.
    assert.ok(request.semantic_write === undefined || request.semantic_write === false,
      'A held GET must not carry a semantic write or an unknown write marker');
    if (proof.operation === 'management') {
      assert.equal(proof.sdk_id, undefined); assert.equal(proof.request_id, start.request_id);
      assert.equal(proof.manager_pid, spawn.child_pid);
      assert.ok(BigInt(spawn.observer_monotonic_ns) <= BigInt(request.started_monotonic_ns),
        'Management HTTP must follow the actual fixed manager spawn');
      assert.ok(BigInt(request.closed_monotonic_ns) <= BigInt(close.observer_monotonic_ns),
        'The original manager must remain alive through its held HTTP response');
    } else {
      assert.equal(proof.request_id, undefined); assert.equal(proof.manager_pid, undefined);
      const begin = one(own.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'start' && row.id === proof.sdk_id),
        'One original SDK start must own each consumer hold');
      const end = one(own.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end' && row.id === proof.sdk_id),
        'One original SDK end must settle each consumer hold');
      assert.equal(begin.operation, proof.operation); assert.equal(end.operation, proof.operation);
      assert.equal(end.status, proof.stage === 'ordinary' && proof.operation === 'consume' ? 'failed' : 'completed');
      assert.ok(BigInt(begin.observer_monotonic_ns) <= BigInt(request.started_monotonic_ns));
      assert.ok(BigInt(end.observer_monotonic_ns) >= BigInt(request.ended_monotonic_ns));
      if (['ordinary', 'discovery'].includes(proof.stage))
        assert.ok(BigInt(end.observer_monotonic_ns) < BigInt(start.observer_monotonic_ns),
          'The original read and discovery operations must settle before management');
      else assert.ok(BigInt(begin.observer_monotonic_ns) > BigInt(managed.observer_monotonic_ns),
        'Post-catalog and final consume must follow the actual ready management result');
    }
    assert.ok(BigInt(proof.reached_monotonic_ns) >= BigInt(request.started_monotonic_ns));
    assert.ok(milliseconds(proof.released_monotonic_ns, proof.reached_monotonic_ns) >= proof.delay_ms);
    assert.ok(BigInt(request.ended_monotonic_ns) >= BigInt(proof.released_monotonic_ns));
    assert.equal(request.closed_monotonic_ns, proof.closed_monotonic_ns);
    assert.ok(BigInt(request.closed_monotonic_ns) >= BigInt(request.ended_monotonic_ns));
    if (index) assert.ok(BigInt(request.started_monotonic_ns) >= BigInt(receipt.holds[index - 1].released_monotonic_ns));
  }
  assert.ok(Array.isArray(receipt.deferred_holds) && receipt.deferred_holds.length <= 8);
  assert.equal(new Set([...receipt.holds, ...receipt.deferred_holds].map(proof => proof.sequence)).size,
    receipt.holds.length + receipt.deferred_holds.length, 'Immediate releases cannot also prove delayed SDK holds');
  for (const proof of receipt.deferred_holds) {
    assert.equal(proof.label, 'post-catalog-root'); assert.equal(proof.stage, 'management_pending');
    assert.equal(proof.operation, 'management'); assert.equal(proof.delay_ms, 0); assert.equal(proof.sdk_id, undefined);
    assert.equal(proof.request_id, start.request_id); assert.equal(proof.manager_pid, spawn.child_pid);
    const request = one(source.filter(row => row.sequence === proof.sequence), 'Immediate release requires its original HTTP record');
    assert.equal(proof.method, 'GET'); assert.equal(request.method, proof.method);
    assert.equal(proof.path, '/v1/pages/' + facts.sample.notion.library.library_id); assert.equal(request.path, proof.path);
    assert.equal(request.control, 'hold-before-headers'); assert.equal(request.phase, 'materialize');
    assert.equal(request.terminal, 'finished'); assert.equal(request.status, 200); assert.equal(request.response_bytes_complete, true);
    assert.ok(request.semantic_write === undefined || request.semantic_write === false);
    assert.ok(BigInt(request.started_monotonic_ns) >= BigInt(start.observer_monotonic_ns));
    assert.ok(BigInt(request.closed_monotonic_ns) <= BigInt(managed.observer_monotonic_ns),
      'Manager completion HTTP cannot be counted as post-ready finalization');
    assert.ok(BigInt(proof.reached_monotonic_ns) >= BigInt(request.started_monotonic_ns));
    assert.ok(BigInt(proof.released_monotonic_ns) >= BigInt(proof.reached_monotonic_ns));
    assert.ok(BigInt(request.ended_monotonic_ns) >= BigInt(proof.released_monotonic_ns));
    assert.equal(request.closed_monotonic_ns, proof.closed_monotonic_ns);
    assert.ok(BigInt(request.closed_monotonic_ns) >= BigInt(request.ended_monotonic_ns));
  }
  assert.equal(new Set(receipt.holds.slice(0, 3).map(proof => proof.sdk_id)).size, 1);
  const firstConsume = one(own.filter(row => row.kind === 'context-broker.notion-sdk-result' && row.id === receipt.holds[3].sdk_id),
    'The initial ordinary consume must retain its actual failed result');
  assert.equal(firstConsume.value?.status, 'failed');
  assert.ok(['CURRENT_SCHEMA_REQUIRED', 'CURRENT_SKILL_NOT_READY'].includes(firstConsume.value.error?.code));
  const discoveryHolds = receipt.holds.filter(proof => proof.operation === 'source-members');
  assert.equal(new Set(discoveryHolds.map(proof => proof.sdk_id)).size, 1);
  const discovery = one(own.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'start'
    && row.id === discoveryHolds[0].sdk_id), 'The slow discovery requires its original SDK operation');
  const discovered = one(own.filter(row => row.kind === 'context-broker.notion-sdk-result' && row.id === discovery.id),
    'The slow discovery must retain its complete public result');
  assert.equal(discovered.value?.coverage, 'complete'); assert.deepEqual(discovered.value.failures, []);
  assert.ok(milliseconds(discovery.observer_monotonic_ns, sent) < 60000, 'Initial ordinary reads must remain below 60s');
  assert.ok(milliseconds(start.observer_monotonic_ns, sent) > 60000, 'The episode must survive more than 60s before management starts');
  assert.ok(BigInt(start.observer_monotonic_ns) > BigInt(discoveryHolds.at(-1).closed_monotonic_ns));
  assert.ok(milliseconds(close.observer_monotonic_ns, discovery.observer_monotonic_ns) > 180000,
    'Actual discovery followed by the original manager must cross the former shared 180s limit');

  const lists = own.filter(row => row.kind === 'context-broker.notion-sdk' && row.operation === 'list' && row.event === 'start'
    && BigInt(row.observer_monotonic_ns) > BigInt(managed.observer_monotonic_ns));
  const refreshed = one(lists, 'A real complete post-management catalog must precede normal consumption');
  const end = one(own.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end' && row.id === refreshed.id),
    'The complete post-management catalog must settle');
  assert.equal(end.status, 'completed');
  const consumed = one(own.filter(row => row.kind === 'context-broker.notion-sdk-result' && row.operation === 'consume' && row.value?.status === 'ready'),
    'One final ordinary ready consume is required');
  const consumeStart = one(own.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'start' && row.id === consumed.id),
    'The ready consume must have its original start');
  const consumeEnd = one(own.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end' && row.id === consumed.id),
    'The ready consume must have its original terminal');
  assert.equal(consumeEnd.status, 'completed');
  assert.ok(BigInt(consumeStart.observer_monotonic_ns) > BigInt(end.observer_monotonic_ns));
  assert.ok(BigInt(consumed.observer_monotonic_ns) >= BigInt(consumeStart.observer_monotonic_ns));
  assert.ok(BigInt(consumeEnd.observer_monotonic_ns) >= BigInt(consumed.observer_monotonic_ns));
  assert.ok(completed >= BigInt(consumeEnd.observer_monotonic_ns));
  const discoveryEnd = one(own.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end' && row.id === discovery.id),
    'Slow discovery must retain its original terminal');
  const catalogHolds = receipt.holds.filter(proof => proof.stage === 'post_catalog');
  const consumeHolds = receipt.holds.filter(proof => proof.stage === 'final_consume');
  assert.ok(catalogHolds.every(proof => proof.sdk_id === refreshed.id), 'Every post-catalog delay belongs to the actual refreshed SDK operation');
  assert.ok(consumeHolds.every(proof => proof.sdk_id === consumeStart.id), 'Every final body delay belongs to the actual ready consume');
  const discoveryMs = milliseconds(discoveryEnd.observer_monotonic_ns, discovery.observer_monotonic_ns);
  const catalogMs = milliseconds(end.observer_monotonic_ns, refreshed.observer_monotonic_ns);
  const consumeMs = milliseconds(consumeEnd.observer_monotonic_ns, consumeStart.observer_monotonic_ns);
  // These are operation observations, not exact internal bucket counters. The
  // management diagnostic encloses the public API; never subtract just its child.
  const finalizationMs = milliseconds(consumeEnd.observer_monotonic_ns, managed.observer_monotonic_ns);
  const nonManagementMs = milliseconds(consumeEnd.observer_monotonic_ns, discovery.observer_monotonic_ns) - managementMs;
  assert.ok(discoveryMs >= 114000 && discoveryMs < 180000, 'Observed discovery must fit its own 180s allowance');
  assert.ok(catalogMs >= 36000, 'The actual post-management catalog must include its 36s HTTP delay');
  assert.ok(consumeMs >= 36000, 'The actual final consume must include both 18s owner delays');
  assert.ok(finalizationMs >= 72000 && finalizationMs < 180000, 'Observed finalization must fit its own 180s allowance');
  assert.ok(nonManagementMs > 180000, 'Discovery and finalization together must cross the former shared 180s limit');
  return { version: 1, kind: 'cold-budget-phase-observation', pi_pid: piPid, manager_pid: spawn.child_pid, request_id: start.request_id,
    discovery_sdk_id: discovery.id, catalog_sdk_id: refreshed.id, consume_sdk_id: consumeStart.id,
    total_ms: milliseconds(completed, sent), initial_read_ms: milliseconds(discovery.observer_monotonic_ns, sent),
    discovery_ms: discoveryMs, management_ms: managementMs, post_catalog_ms: catalogMs, final_consume_ms: consumeMs,
    observed_finalization_ms: finalizationMs, observed_non_management_ms: nonManagementMs,
    delayed_http_count: receipt.holds.filter(proof => proof.delay_ms > 0).length, immediate_management_releases: receipt.deferred_holds.length };

}
