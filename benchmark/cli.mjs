import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProtocol, validateEnvironmentManifest } from './protocol.mjs';
import { freezeExpectation } from './runtime/observation.mjs';
import { phaseZero } from './phase-zero.mjs';

const HELP = `Benchmark protocol and no-model bootstrap

  node benchmark/cli.mjs validate --protocol ABS_JSON [--stage phase0|execute]
  node benchmark/cli.mjs manifest --file ABS_JSON [--stage phase0|execute]
  node benchmark/cli.mjs phase0 --root ABS_PAIR --build ID --mode broker|native
    --skills ABS_SYNTHETIC_CORPUS [--expected ABS_FROZEN_LOAD_JSON]
    [--condition ID] [--id NEW_RUN_ID] [--out ABS_NEW_PROOF_DIRECTORY]
  node benchmark/cli.mjs freeze-load --file ABS_REVIEWED_PROPOSAL --out ABS_NEW_JSON

Validation checks the registered protocol; it does not run a model or certify
evidence authenticity. Phase 0 reuses paired-environment and actual machine Pi,
observes a local handled command, and records zero real-model episodes. It has
no task submission API. A frozen load expectation only compares this limited
observation on a later probe. It is not the full candidate manifest/paid-run gate.
No global configuration, credentials, remote Notion objects or daily packages
are changed. Output files are exclusive and failures remain available.
`;

export function parseBenchmarkArgs(args) {
  if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0])) return { action: 'help' };
  const [action, ...rest] = args;
  const flags = { validate: ['protocol', 'stage'], manifest: ['file', 'stage'],
    phase0: ['root', 'build', 'mode', 'skills', 'expected', 'condition', 'id', 'out'], 'freeze-load': ['file', 'out'] };
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
    process.stdout.write(JSON.stringify({ status: 'failed', error: error.message, execution_performed: false }) + '\n');
    process.exitCode = 1;
  }
}
