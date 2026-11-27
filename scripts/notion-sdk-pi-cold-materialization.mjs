import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const readRows = async path => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const userTexts = session => session.branch.filter(row => row.type === 'message' && row.message?.role === 'user')
  .map(row => typeof row.message.content === 'string' ? row.message.content
    : row.message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
const now = () => process.hrtime.bigint().toString();
const milliseconds = (end, start) => Number(BigInt(end) - BigInt(start)) / 1e6;
const durations = Object.freeze([12000, 12000, 12000, 12000, 14000]);

function delayPlan(facts) {
  const library = facts.sample.notion.library;
  return [
    { label: 'catalog-root', operation: 'list', path: '/v1/pages/' + library.library_id },
    { label: 'catalog-children', operation: 'list', path: '/v1/blocks/' + library.library_id + '/children' },
    { label: 'catalog-skills-schema', operation: 'list', path: '/v1/data_sources/' + library.skills.data_source_id },
    { label: 'initial-consume-owner', operation: 'consume', path: '/v1/pages/' + facts.members[0].legacy_page_id },
    { label: 'source-discovery-root', operation: 'source-members', path: '/v1/pages/' + library.library_id },
  ].map((item, index) => ({ ...item, method: 'GET', delay_ms: durations[index] }));
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
  const receipt = { version: 1, kind: 'actual-pi-cold-materialization-budget', prompt, pi_pid: piPid,
    initial_session: 'discovery-empty-session.json', initial_http_count: service.requests.length,
    initial_sdk_events: before.length, sent_monotonic_ns: now(), holds: [] };
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
      const arrived = await Promise.race([hold.reached, prematurelyEnded]);
      const events = await readRows(eventsPath);
      const active = events.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'start'
        && row.observer_pid === piPid && row.operation === item.operation
        && !events.some(end => end.kind === 'context-broker.notion-sdk' && end.event === 'end' && end.id === row.id));
      assert.equal(active.length, 1, 'The delayed HTTP must belong to exactly one expected SDK operation: ' + item.label);
      const next = index + 1 < plan.length ? arm(plan[index + 1]) : undefined;
      const proof = { ...item, sequence: arrived.sequence, sdk_id: active[0].id, reached_monotonic_ns: now() };
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

/** Replay timestamps against raw HTTP/SDK/native-session evidence, not reported totals. */
export function assertColdMaterializationBudget({ receipt, facts, source, events, initial, session, piPid }) {
  assert.equal(receipt.version, 1); assert.equal(receipt.kind, 'actual-pi-cold-materialization-budget');
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.pi_pid, piPid);
  assert.equal(receipt.initial_http_count, 0); assert.deepEqual(userTexts(initial), []);
  assert.equal(userTexts(session)[0], receipt.prompt);
  assert.ok(receipt.prompt.startsWith('$' + facts.members[0].name + ' '));
  assert.equal(userTexts(session).length, 1, 'The first literal cannot be preceded by a model discovery turn');
  const sent = BigInt(receipt.sent_monotonic_ns), completed = BigInt(receipt.completed_monotonic_ns);
  assert.ok(milliseconds(completed, sent) > 60000 && milliseconds(completed, sent) < 240000);
  assert.equal(source.some(row => BigInt(row.started_monotonic_ns) < sent), false, 'Notion HTTP preceded the literal input');
  const own = events.filter(row => row.observer_pid === piPid);
  assert.equal(own.some(row => ['list', 'consume', 'source-members'].includes(row.operation)
    && BigInt(row.observer_monotonic_ns) < sent), false, 'An SDK operation prewarmed the first literal');
  const plan = delayPlan(facts);
  assert.equal(receipt.holds.length, plan.length);
  for (const [index, proof] of receipt.holds.entries()) {
    for (const key of Object.keys(plan[index])) assert.equal(proof[key], plan[index][key]);
    const requests = source.filter(row => row.sequence === proof.sequence); assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.method, proof.method); assert.equal(request.path, proof.path);
    assert.equal(request.control, 'hold-before-headers'); assert.equal(request.phase, 'materialize');
    assert.equal(request.terminal, 'finished'); assert.equal(request.status, 200);
    assert.equal(request.response_bytes_complete, true);
    // The fixture marks writes only; the exact GET method and path were checked above.
    assert.ok(request.semantic_write === undefined || request.semantic_write === false,
      'A held GET must not carry a semantic write or an unknown write marker');
    const starts = own.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'start' && row.id === proof.sdk_id);
    const ends = own.filter(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end' && row.id === proof.sdk_id);
    assert.equal(starts.length, 1); assert.equal(ends.length, 1);
    assert.equal(starts[0].operation, proof.operation); assert.equal(ends[0].operation, proof.operation);
    assert.ok(BigInt(starts[0].observer_monotonic_ns) <= BigInt(request.started_monotonic_ns));
    assert.ok(BigInt(ends[0].observer_monotonic_ns) >= BigInt(request.ended_monotonic_ns));
    assert.ok(BigInt(proof.reached_monotonic_ns) >= BigInt(request.started_monotonic_ns));
    assert.ok(milliseconds(proof.released_monotonic_ns, proof.reached_monotonic_ns) >= proof.delay_ms);
    assert.ok(BigInt(request.ended_monotonic_ns) >= BigInt(proof.released_monotonic_ns));
    assert.equal(request.closed_monotonic_ns, proof.closed_monotonic_ns);
    if (index) assert.ok(BigInt(request.started_monotonic_ns) >= BigInt(receipt.holds[index - 1].released_monotonic_ns));
  }
  assert.equal(new Set(receipt.holds.slice(0, 3).map(proof => proof.sdk_id)).size, 1);
  const firstConsume = own.find(row => row.kind === 'context-broker.notion-sdk-result' && row.id === receipt.holds[3].sdk_id);
  assert.equal(firstConsume?.value?.status, 'failed');
  assert.ok(['CURRENT_SCHEMA_REQUIRED', 'CURRENT_SKILL_NOT_READY'].includes(firstConsume.value.error?.code));
  const start = own.find(row => row.kind === 'context-broker.notion-materialization' && row.event === 'start');
  assert.ok(start); assert.ok(BigInt(start.observer_monotonic_ns) > BigInt(receipt.holds.at(-1).closed_monotonic_ns));
  assert.ok(milliseconds(start.observer_monotonic_ns, sent) > 60000, 'The episode must survive more than 60s before management starts');
  const managed = own.find(row => row.kind === 'context-broker.notion-materialization' && row.event === 'result');
  assert.ok(managed && ['ready', 'already_ready'].includes(managed.status));
  const lists = own.filter(row => row.kind === 'context-broker.notion-sdk' && row.operation === 'list' && row.event === 'start'
    && BigInt(row.observer_monotonic_ns) > BigInt(managed.observer_monotonic_ns));
  assert.equal(lists.length, 1, 'A real complete post-management catalog must precede normal consumption');
  const end = own.find(row => row.kind === 'context-broker.notion-sdk' && row.event === 'end' && row.id === lists[0].id);
  assert.equal(end?.status, 'completed');
  const consumed = own.find(row => row.kind === 'context-broker.notion-sdk-result' && row.operation === 'consume' && row.value?.status === 'ready');
  assert.ok(consumed);
  const consumeStart = own.find(row => row.kind === 'context-broker.notion-sdk' && row.event === 'start' && row.id === consumed.id);
  assert.ok(BigInt(consumeStart.observer_monotonic_ns) > BigInt(end.observer_monotonic_ns));
}
