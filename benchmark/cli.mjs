import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProtocol, validateEnvironmentManifest } from './protocol.mjs';
import { freezeExpectation } from './runtime/observation.mjs';
import { phaseZero } from './phase-zero.mjs';

const HELP = `Benchmark: frozen comparisons, actual episodes, and offline evidence

  node benchmark/cli.mjs configure --setup ABS_SETUP_JSON
  node benchmark/cli.mjs run --plan ABS_FROZEN_PLAN [--limit NONNEGATIVE_INTEGER] [--analysis-revision ABS_JSON | --collection-recovery ABS_JSON]
  node benchmark/cli.mjs status --root ABS_BATCH_DIRECTORY
  node benchmark/cli.mjs gate --root ABS_GATE_BATCH --out ABS_NEW_GATE_JSON
  node benchmark/cli.mjs reconcile --root ABS_BATCH_DIRECTORY --lease OBSERVED_DEAD_LEASE_ID
  node benchmark/cli.mjs analyze --root ABS_BATCH_DIRECTORY --out ABS_NEW_REPORT
  node benchmark/cli.mjs reanalysis --root ABS_BATCH_DIRECTORY --out ABS_NEW_REPORT
  node benchmark/cli.mjs register-reanalysis --plan ABS_PLAN --replacements ABS_JSON --out ABS_NEW_REVISION --reason TEXT
  node benchmark/cli.mjs register-collection-recovery --plan ABS_PLAN --frozen-controller ABS_ORIGINAL_CLI --reason TEXT
  node benchmark/cli.mjs journey --root ABS_BATCH_DIRECTORY --run RUN_ID
  node benchmark/cli.mjs query --root ABS_BATCH_DIRECTORY [--condition ID] [--outcome pass|fail|unknown]

  node benchmark/cli.mjs validate --protocol ABS_JSON [--stage phase0|execute]
  node benchmark/cli.mjs manifest --file ABS_JSON [--stage phase0|execute]
  node benchmark/cli.mjs phase0 --root ABS_PAIR --build ID --mode broker|native
    --skills ABS_SYNTHETIC_CORPUS [--expected ABS_FROZEN_LOAD_JSON]
    [--condition ID] [--id NEW_RUN_ID] [--out ABS_NEW_PROOF_DIRECTORY]
  node benchmark/cli.mjs freeze-load --file ABS_REVIEWED_PROPOSAL --out ABS_NEW_JSON

configure uses the shared paired environment and maintained Pi SDK, performs
zero provider sends, checks actual loading and final serialization, and freezes
the concrete bounded plan. run accepts that plan only; no arbitrary prompt or
silent model fallback is accepted. Invalid, unknown and failed evidence stays.
The legacy first24 gate and explicit prospective scope gates retain the same
144 scheduled-episode campaign cap. See docs/benchmark-pilot-scope.md for the
two-model gate, verified zero-send repair and single manual route amendment.
analyze replays normalized observations; reanalysis re-reads original artifacts
and the private oracle before scoring. Both perform zero model requests.
Collection recovery registers an exact storage-only projection and controller
identity after a collection failure. First use run --limit 0 with its explicit
reference to collect the retained run without sending a replacement request.

Legacy phase0 has no task submission API. Its local-command probe is not the full candidate manifest
or paid-run gate. It remains available to replay the earlier bootstrap scope.
No global configuration, credentials or daily packages are changed. Setup may
bind an explicitly prepared task-owned Notion library. Outputs are exclusive.
`;

export function parseBenchmarkArgs(args) {
  if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0])) return { action: 'help' };
  const [action, ...rest] = args;
  const flags = { validate: ['protocol', 'stage'], manifest: ['file', 'stage'],
    phase0: ['root', 'build', 'mode', 'skills', 'expected', 'condition', 'id', 'out'], 'freeze-load': ['file', 'out'],
    configure: ['setup'], run: ['plan', 'limit', 'analysis-revision', 'collection-recovery'], status: ['root'], gate: ['root', 'out'], reconcile: ['root', 'lease'], analyze: ['root', 'out'], reanalysis: ['root', 'out'],
    'register-reanalysis': ['plan', 'replacements', 'out', 'reason'],
    'register-collection-recovery': ['plan', 'frozen-controller', 'reason'],
    journey: ['root', 'run'], query: ['root', 'condition', 'outcome'] };
  assert.ok(Object.hasOwn(flags, action), 'Unknown Benchmark action; use --help');
  const options = { action };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.startsWith('--') ? rest[i].slice(2) : '';
    assert.ok(flags[action].includes(key), 'Unexpected option ' + rest[i]);
    assert.ok(!Object.hasOwn(options, key), 'Repeated option --' + key);
    assert.ok(rest[i + 1] && !rest[i + 1].startsWith('--'), 'Missing value for --' + key);
    options[key] = rest[i + 1];
  }
  return options;
}

export async function benchmarkMain(args) {
  const options = parseBenchmarkArgs(args);
  if (options.action === 'help') return { help: HELP };
  if (options.action === 'phase0') return phaseZero(options);
  if (options.action === 'register-reanalysis') {
    for (const key of ['plan', 'replacements', 'out']) assert.ok(options[key] && isAbsolute(options[key]), '--' + key + ' must be absolute');
    assert.ok(options.reason, '--reason must explain the analysis correction');
    const { createAnalysisRevision } = await import('./revision.mjs');
    return createAnalysisRevision({ planFile: options.plan, outputFile: options.out,
      replacements: JSON.parse(await readFile(options.replacements, 'utf8')), reason: options.reason });
  }
  if (options.action === 'register-collection-recovery') {
    for (const key of ['plan', 'frozen-controller'])
      assert.ok(options[key] && isAbsolute(options[key]), '--' + key + ' must be absolute');
    assert.ok(options.reason, '--reason must explain the collection failure and path projection');
    const { createCollectionRecovery } = await import('./collection-recovery.mjs');
    const { reference, recovery } = await createCollectionRecovery({ planFile: options.plan,
      frozenController: options['frozen-controller'], reason: options.reason });
    return { status: 'registered', kind: recovery.kind, reference, execution_performed: false, model_requests: 0 };
  }
  if (options.action === 'configure') {
    assert.ok(options.setup && isAbsolute(options.setup), '--setup must be absolute');
    const { configureComparison } = await import('./configure.mjs');
    return configureComparison(JSON.parse(await readFile(options.setup, 'utf8')), {
      onProgress: event => process.stderr.write(JSON.stringify(event) + '\n'),
    });
  }
  if (options.action === 'run') {
    assert.ok(options.plan && isAbsolute(options.plan), '--plan must be absolute');
    assert.ok(options.limit === undefined || /^(0|[1-9][0-9]*)$/.test(options.limit), '--limit is a nonnegative integer');
    assert.ok(options['analysis-revision'] === undefined || isAbsolute(options['analysis-revision']), '--analysis-revision must be absolute');
    assert.ok(options['collection-recovery'] === undefined || isAbsolute(options['collection-recovery']), '--collection-recovery must be absolute');
    assert.ok(!options['analysis-revision'] || !options['collection-recovery'], 'Choose one registered correction');
    const { executeBatchPlan } = await import('./controller.mjs');
    const result = await executeBatchPlan({ plan: JSON.parse(await readFile(options.plan, 'utf8')),
      maximumNewEpisodes: options.limit === undefined ? Infinity : Number(options.limit), analysisRevisionFile: options['analysis-revision'],
      collectionRecoveryFile: options['collection-recovery'] });
    return { ...result, ledger: undefined, execution_performed: (result.last?.new_episodes ?? 0) > 0 };
  }
  if (['status', 'gate', 'reconcile', 'analyze', 'reanalysis', 'journey', 'query'].includes(options.action)) {
    assert.ok(options.root && isAbsolute(options.root), '--root must be absolute');
    const { batchStatus } = await import('./batch.mjs');
    if (options.action === 'reconcile') {
      assert.ok(options.lease, '--lease must name the observed interrupted lease');
      const { reconcileBatchLease } = await import('./batch.mjs');
      const result = await reconcileBatchLease({ controlRoot: options.root, leaseId: options.lease });
      return { ...result, ledger: undefined, execution_performed: false };
    }
    if (options.action === 'gate') {
      assert.ok(options.out && isAbsolute(options.out), '--out must be absolute');
      const { writeRouteGate } = await import('./gate.mjs');
      return writeRouteGate({ plan: JSON.parse(await readFile(join(options.root, 'plan.json'), 'utf8')),
        status: await batchStatus(options.root), outputFile: options.out });
    }
    if (options.action === 'analyze' || options.action === 'reanalysis') {
      assert.ok(options.out && isAbsolute(options.out), '--out must be absolute');
      const { analyzeBatch } = await import('./controller.mjs');
      return analyzeBatch({ root: options.root, outputDirectory: options.out, reanalysis: options.action === 'reanalysis' });
    }
    const status = await batchStatus(options.root);
    const plan = JSON.parse(await readFile(join(options.root, 'plan.json'), 'utf8'));
    const { verifyCollectionRecoveryResults } = await import('./collection-recovery.mjs');
    await verifyCollectionRecoveryResults(plan, status.episodes);
    if (options.action === 'status') return { ...status, ledger: undefined, execution_performed: false };
    const { readEvidenceBundle, buildEvidenceIndex, queryEvidenceIndex } = await import('./evidence/store.mjs');
    if (options.action === 'journey') {
      assert.ok(options.run, '--run must name one retained episode');
      const item = status.episodes.find(item => item.run_id === options.run);
      assert.ok(item, 'Episode has no completed normalization receipt; inspect status for unresolved execution');
      const bundle = await readEvidenceBundle({ directory: item.result.normalized_directory, rawRoot: plan.execution.environment_root });
      return { journey: bundle.journey, text: await readFile(join(item.result.normalized_directory, 'journey.md'), 'utf8'), model_requests: 0 };
    }
    assert.ok(options.outcome === undefined || ['pass', 'fail', 'unknown'].includes(options.outcome));
    const episodes = await Promise.all(status.episodes.map(async item => (await readEvidenceBundle({ directory: item.result.normalized_directory, rawRoot: plan.execution.environment_root })).episode));
    return { rows: queryEvidenceIndex(buildEvidenceIndex(episodes), { ...(options.condition ? { condition_id: options.condition } : {}),
      ...(options.outcome ? { outcome: options.outcome } : {}) }), model_requests: 0 };
  }
  const path = options.action === 'validate' ? options.protocol : options.file;
  assert.ok(path && isAbsolute(path), 'Input file must be absolute');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (options.action === 'freeze-load') {
    assert.ok(options.out && isAbsolute(options.out), '--out must name a new absolute JSON file');
    const frozen = freezeExpectation(value);
    await writeFile(options.out, JSON.stringify(frozen, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: 'frozen', scope: frozen.scope, expectation_sha256: frozen.expectation_sha256,
      output: options.out, task_execution_enabled: false };
  }
  const stage = options.stage ?? 'phase0';
  assert.ok(['phase0', 'execute'].includes(stage), '--stage must be phase0 or execute');
  const result = (options.action === 'validate' ? validateProtocol : validateEnvironmentManifest)(value, { stage });
  return { ...result, stage, input: path, execution_performed: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await benchmarkMain(process.argv.slice(2));
    if (result.help) process.stdout.write(result.help);
    else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.valid === false || ['failed', 'rejected'].includes(result.status)) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'failed', error: error.message,
      execution_performed: process.argv[2] === 'run' ? null : false,
      ...(process.argv[2] === 'run' ? { next_step: 'Read the retained batch status before any further run; an exception does not prove zero requests.' } : {}) }) + '\n');
    process.exitCode = 1;
  }
}
