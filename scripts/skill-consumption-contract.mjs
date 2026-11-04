#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { selfTest as graphSelfTest } from './verify-skill-graph-contract.mjs';

const map = JSON.parse(readFileSync(new URL('./skill-consumption-scenarios.json', import.meta.url), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const check = (condition, code, message) => {
  if (!condition) throw Object.assign(new Error(message), { code });
};
const key = value => JSON.stringify([value.scope, value.ref, value.snapshot]);

export function validateMap() {
  check(map.schema === 'skill-consumption-map/v1', 'MAP_SCHEMA', 'Unknown scenario map.');
  check(map.tasks.length === 24 && new Set(map.tasks.map(row => row.id)).size === 24,
    'TASK_COVERAGE', 'SC01–24 must each occur once.');
  check(map.journeys.length === 21 && new Set(map.journeys.map(row => row.id)).size === 21,
    'JOURNEY_COVERAGE', 'J01–21 must each occur once.');
  for (let i = 1; i <= 24; i++) {
    const task = map.tasks.find(row => row.id === 'SC' + String(i).padStart(2, '0'));
    check(task && /^AH-\d+$/.test(task.issue) && task.featurePrefix && task.recipeStatus === 'draft',
      'TASK_COVERAGE', 'Every planned feature needs an issue and an explicit draft recipe status.');
    for (const journey of task.journeys) check(map.journeys.some(row => row.id === journey && row.tasks.includes(task.id)),
      'MAP_LINK', 'Task/journey links must agree.');
  }
  for (const row of map.journeys) {
    check(row.required === true && row.status === 'not_run' && row.tasks.length > 0,
      'JOURNEY_STATUS', 'The plan is not execution evidence.');
    for (const task of row.tasks) check(map.tasks.some(value => value.id === task && value.journeys.includes(row.id)),
      'MAP_LINK', 'Journey/task links must agree.');
  }
  return { status: 'map-valid', tasks: map.tasks.length, journeys: map.journeys.length,
    tuples: expandCoverage().length, productAcceptance: 'not-inferred' };
}

export function expandCoverage() {
  const rows = [];
  for (const cache of map.axes.cache) for (const session of map.axes.session)
    for (const entry of map.axes.entry) for (const intent of map.axes.intent) {
      let reason = null;
      if (intent === 'none' && entry !== 'ordinary') reason = 'No Skill intent has no explicit Skill entry.';
      else if (entry === 'search' && intent !== 'discover') reason = 'Search returns candidates, not content or active instructions.';
      else if (entry === 'ordinary' && ['inspect', 'use'].includes(intent)) reason = 'Record the actual subsequent inspection/activation tool separately.';
      else if (['dollar', 'native'].includes(entry) && intent !== 'use') reason = 'Explicit host activation has use intent.';
      else if (['cli', 'sdk'].includes(entry) && session !== 'new') reason = 'Direct clients have no Pi session lifecycle; cover their host caller.';
      rows.push({ cache, session, entry, intent, status: reason ? 'not_applicable' : 'not_run', reason });
    }
  return rows;
}

// A normalized observation contract, never a product/SDK wire format.
// SC03 must freeze deterministic projection semantics before another compiler is accepted.
export function evaluateConsumptionEvidence(value) {
  check(value?.schema === 'skill-consumption-evidence/v1', 'EVIDENCE_SCHEMA', 'Unknown evidence schema.');
  check(Array.isArray(value.observerErrors) && value.observerErrors.length === 0, 'OBSERVER_FAILURE', 'Observer errors invalidate claims.');
  check(value.isolation?.oracleWarmedConsumer === false, 'ORACLE_WARMING', 'Oracle must not warm consumer state.');
  check(Array.isArray(value.isolation.hiddenLocalCopies) && value.isolation.hiddenLocalCopies.length === 0,
    'LOCAL_COPY', 'Hidden copies invalidate autonomous discovery.');
  check(value.isolation.forcedToolArguments === false, 'FORCED_TOOLS', 'Observation must not choose model tools.');
  for (const channel of ['notion', 'attachments', 'provider']) {
    const ledger = value.transport?.[channel];
    check(ledger?.observed === true && ledger.complete === true && Array.isArray(ledger.attempts),
      'TRANSPORT_INCOMPLETE', channel + ' must have a complete observed ledger, including an observed empty one.');
  }
  check(Array.isArray(value.processes) && value.processes.length > 0 &&
    value.processes.every(row => row.spawnObserved === true && row.closeObserved === true),
    'PROCESS_EVIDENCE', 'Spawn and close must both be observed.');
  check(Array.isArray(value.samples?.expected) && value.samples.expected.length > 0 &&
    Array.isArray(value.samples.retained) && value.samples.expected.every(id => value.samples.retained.includes(id)),
    'SAMPLE_LOSS', 'Retain failed, blocked and successful samples.');
  check(Array.isArray(value.cleanup?.expectedEvidence) && value.cleanup.expectedEvidence.length > 0 &&
    Array.isArray(value.cleanup.retainedEvidence) &&
    value.cleanup.expectedEvidence.every(row => value.cleanup.retainedEvidence.some(other => other.path === row.path && other.sha256 === row.sha256)),
    'EVIDENCE_LOSS', 'Cleanup cannot discard or alter evidence.');
  check(Array.isArray(value.providerInputs) && value.providerInputs.length > 0 && value.providerInputs.every(row => typeof row === 'string'),
    'PROVIDER_MISSING', 'Loaded logs are not observed provider inputs.');
  check(Array.isArray(value.sources) && Array.isArray(value.projections) && Array.isArray(value.deliveries),
    'CONTENT_SCHEMA', 'Source, projection and delivery observations are separate.');
  for (const source of value.sources) {
    check(typeof source.content === 'string' && sha(source.content) === source.sha256 &&
      Buffer.byteLength(source.content) === source.bytes, 'SOURCE_HASH', 'Source bytes/hash disagree.');
    check(source.scope && source.ref && source.snapshot, 'SOURCE_IDENTITY', 'Source identity is incomplete.');
  }
  for (const projection of value.projections) {
    const source = value.sources.find(row => key(row) === key(projection));
    check(source && projection.sourceSha256 === source.sha256, 'PROJECTION_SOURCE', 'Projection has no matching verified source.');
    check(typeof projection.content === 'string' && sha(projection.content) === projection.sha256 &&
      Buffer.byteLength(projection.content) === projection.bytes, 'PROJECTION_HASH', 'Projection bytes/hash disagree.');
    check(projection.compiler === 'source-identity/v1' && projection.content === source.content,
      'PROJECTION_CONTRACT_DRAFT', 'New compiled projections need the separately frozen SC03 contract; keep old graph proof intact.');
    const delivery = value.deliveries.find(row => row.projectionSha256 === projection.sha256);
    check(delivery, 'DELIVERY_MISSING', 'Cached or materialized bytes are not delivery.');
    check(key(delivery) === key(projection), 'DELIVERY_IDENTITY', 'Delivered scope/ref/snapshot disagree.');
    const input = value.providerInputs[delivery.requestIndex];
    check(typeof input === 'string' && Number.isInteger(delivery.start) && Number.isInteger(delivery.end) &&
      delivery.start >= 0 && delivery.end > delivery.start &&
      input.slice(delivery.start, delivery.end) === projection.content,
      'DELIVERY_BYTES', 'Exact provider span does not contain complete projected bytes.');
    for (const request of value.providerInputs) {
      check(request.split(projection.content).length - 1 <= 1, 'DUPLICATE_BODY', 'A provider input contains the same complete body more than once.');
    }
  }
  return { status: 'evidence-contract-valid', productAcceptance: 'not-inferred', sources: value.sources.length,
    projections: value.projections.length, deliveries: value.deliveries.length,
    boundary: 'Normalized observations require raw artifacts and an actual run. This checker does not execute Pi, Notion or a model.' };
}

export function consumptionFixture() {
  const content = 'Controlled complete Skill body. Read the feature map before verification.';
  const identity = { scope: 'controlled-credential-library', ref: 'skill://fixture/SKILL.md', snapshot: 'fixed-fixture-v1' };
  const source = { ...identity, content, sha256: sha(content), bytes: Buffer.byteLength(content) };
  const projection = { ...source, sourceSha256: source.sha256, compiler: 'source-identity/v1' };
  const retained = [{ path: 'provider.jsonl', sha256: sha('controlled-provider-observation') }];
  return { schema: 'skill-consumption-evidence/v1', observerErrors: [],
    isolation: { oracleWarmedConsumer: false, hiddenLocalCopies: [], forcedToolArguments: false },
    transport: Object.fromEntries(['notion', 'attachments', 'provider'].map(channel => [channel, { observed: true, complete: true, attempts: [] }])),
    processes: [{ spawnObserved: true, closeObserved: true }],
    samples: { expected: ['successful-run', 'failed-run'], retained: ['successful-run', 'failed-run'] },
    cleanup: { expectedEvidence: retained, retainedEvidence: structuredClone(retained) },
    sources: [source], projections: [projection], providerInputs: ['Instructions:\n' + content],
    deliveries: [{ ...identity, projectionSha256: projection.sha256, requestIndex: 0, start: 'Instructions:\n'.length, end: 'Instructions:\n'.length + content.length }] };
}

export function selfTest() {
  const cases = [];
  const positive = consumptionFixture();
  assert.equal(evaluateConsumptionEvidence(positive).status, 'evidence-contract-valid');
  const negatives = [
    ['loaded-log-only', 'PROVIDER_MISSING', value => { value.providerInputs = []; }],
    ['cached-not-delivered', 'DELIVERY_MISSING', value => { value.deliveries = []; }],
    ['summary-not-body', 'DELIVERY_BYTES', value => { value.providerInputs[0] = 'loaded: summary'; }],
    ['wrong-source-hash', 'SOURCE_HASH', value => { value.sources[0].content += ' changed'; }],
    ['wrong-scope', 'DELIVERY_IDENTITY', value => { value.deliveries[0].scope = 'other'; }],
    ['wrong-version', 'DELIVERY_IDENTITY', value => { value.deliveries[0].snapshot = 'other'; }],
    ['bad-projection-source', 'PROJECTION_SOURCE', value => { value.projections[0].sourceSha256 = 'wrong'; }],
    ['bad-projection-hash', 'PROJECTION_HASH', value => { value.projections[0].content += ' changed'; }],
    ['unfrozen-projection', 'PROJECTION_CONTRACT_DRAFT', value => { value.projections[0].compiler = 'draft'; }],
    ['duplicate-body', 'DUPLICATE_BODY', value => { value.providerInputs[0] += value.projections[0].content; }],
    ['oracle-prewarming', 'ORACLE_WARMING', value => { value.isolation.oracleWarmedConsumer = true; }],
    ['forced-tools', 'FORCED_TOOLS', value => { value.isolation.forcedToolArguments = true; }],
    ['hidden-copy', 'LOCAL_COPY', value => { value.isolation.hiddenLocalCopies = ['renamed']; }],
    ['truncated-notion-trace', 'TRANSPORT_INCOMPLETE', value => { value.transport.notion.complete = false; }],
    ['missing-attachment-ledger', 'TRANSPORT_INCOMPLETE', value => { delete value.transport.attachments; }],
    ['observer-error', 'OBSERVER_FAILURE', value => { value.observerErrors = ['lost frame']; }],
    ['unobserved-close', 'PROCESS_EVIDENCE', value => { value.processes[0].closeObserved = false; }],
    ['failed-sample-deleted', 'SAMPLE_LOSS', value => { value.samples.retained = ['successful-run']; }],
    ['cleanup-deletes-evidence', 'EVIDENCE_LOSS', value => { value.cleanup.retainedEvidence = []; }],
  ];
  for (const [id, code, mutate] of negatives) {
    const fixture = consumptionFixture(); mutate(fixture);
    assert.throws(() => evaluateConsumptionEvidence(fixture), { code }, id);
    cases.push({ id, status: 'passed', rejectedWith: code, evidenceKind: 'controlled' });
  }
  return { schema: 'skill-consumption-self-test/v1', status: 'passed', productAcceptance: 'not-inferred',
    map: validateMap(), graph: graphSelfTest(), consumption: { tests: cases.length, cases } };
}

function main(argv) {
  const [action, path] = argv;
  if (!action || ['-h', '--help', 'help'].includes(action)) {
    console.log('Usage: node scripts/skill-consumption-contract.mjs self-test | check-map | coverage | evaluate EVIDENCE.json');
    console.log('Offline/read-only. No run directories, production API calls, model calls or product acceptance claims.');
    return;
  }
  let result;
  if (action === 'self-test') result = selfTest();
  else if (action === 'check-map') result = validateMap();
  else if (action === 'coverage') result = { ...validateMap(), cases: expandCoverage() };
  else if (action === 'evaluate' && path) result = evaluateConsumptionEvidence(JSON.parse(readFileSync(path, 'utf8')));
  else throw new Error('Unknown action or missing evidence file; use --help.');
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'ERROR', message: error.message })); process.exitCode = 1; }
}
