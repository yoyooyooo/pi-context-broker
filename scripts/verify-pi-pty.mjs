#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, resolveHost, runCommand, writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { createNotionFixture, database, canary } from './notion-integration-fixture.mjs';
import { systemTempRoot, evidenceRoot } from './verification-paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const driver = join(root, '.agents/skills/verify-context-broker/scripts/pi-pty-driver.py');
const args = process.argv.slice(2);
const usage = 'Usage: node scripts/verify-pi-pty.mjs help|doctor|run [--extension ABSOLUTE_ENTRY --evidence-root ABSOLUTE_DIRECTORY --upstream-labels]\n       node scripts/verify-pi-pty.mjs evidence|cleanup --evidence ABSOLUTE_DIRECTORY\nReal isolated Pi terminal, controlled Notion executable/provider; no live Notion or real model requests. Scratch/TMPDIR use system /tmp independently of evidence.';
if (!args.length || args.some(arg => ['help', '--help', '-h'].includes(arg))) { console.log(usage); process.exit(0); }
const action = args.shift();
const options = {};
while (args.length) {
  const key = args.shift();
  if (key === '--upstream-labels') { options.upstreamLabels = true; continue; }
  assert.ok(['--extension', '--evidence', '--evidence-root'].includes(key) && args.length, usage);
  options[key.slice(2)] = args.shift();
}
assert.ok(['doctor','run','evidence','cleanup'].includes(action), usage);
const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split('.').map(Number);
const supportedNode = (nodeMajor === 22 && (nodeMinor > 22 || (nodeMinor === 22 && nodePatch >= 3))) || nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 20);
assert.ok(!process.versions.bun && supportedNode, 'Use Node.js 22.22.3+ within 22.x or 24.20.0+; Bun is build-only');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requiredFlags = ['--no-extensions','--no-mcp','--no-context-files','--no-prompt-templates','--approve','--offline','--tui-mode'];
async function doctor() {
  const temporaryRoot = await systemTempRoot();
  const base = await mkdtemp(join(temporaryRoot, 'broker-pi-doctor-'));
  const report = { status: 'ready', node: process.versions.node, platform: process.platform, scratch: base, scratchDisposition: 'retained; move owned scratch to system Trash after review', failures: [], authentication: 'not needed; controlled provider' };
  try {
    assert.notEqual(process.platform, 'win32', 'PTY driver requires POSIX');
    const entry = options.extension ?? join(root, 'packages/context-broker/src/index.ts');
    assert.ok(isAbsolute(entry), '--extension must be absolute');
    await access(driver);
    report.extension = { path: await realpath(entry), sha256: hash(await readFile(entry)) };
    report.host = await resolveHost('pi');
    const env = isolatedEnv({ base, agentDir: join(base, 'agent'), TMPDIR: temporaryRoot });
    report.version = (await runCommand('pi', ['--version'], { cwd: base, env, timeoutMs: 10000 })).stdout.trim();
    const help = (await runCommand('pi', ['--help'], { cwd: base, env, timeoutMs: 10000 })).stdout;
    for (const flag of requiredFlags) assert.ok(help.includes(flag), `Installed Pi does not advertise ${flag}; do not substitute another host`);
    report.python = (await runCommand('python3', ['-c', 'import pty,fcntl,termios,select; print("stdlib PTY ready")'], { cwd: base, env, timeoutMs: 10000 })).stdout.trim();
  } catch (error) { report.status = 'blocked'; report.failures.push(error.message); }
  return report;
}
async function evidence(directory) {
  assert.ok(isAbsolute(directory ?? ''), '--evidence must be absolute');
  const manifest = await json(join(directory, 'manifest.json'));
  const branches = [];
  for (const name of manifest.sessions) {
    const result = await json(join(directory, name, 'result.json'));
    const cleanup = await json(join(directory, name, 'cleanup.json'));
    await access(join(directory, name, 'terminal.ansi'));
    branches.push({ name, status: result.status, observedExit: cleanup.observedExit, naturalExit: cleanup.naturalExit });
    assert.equal(cleanup.observedExit, true, 'Owned PTY child shutdown was not observed');
  }
  return { status: 'preserved', functionalStatus: manifest.status, directory, branches };
}
if (action === 'doctor') {
  const report = await doctor(); console.log(JSON.stringify(report, null, 2)); if (report.status !== 'ready') process.exitCode = 1;
} else if (action === 'evidence') {
  console.log(JSON.stringify(await evidence(options.evidence), null, 2));
} else if (action === 'cleanup') {
  const directory = options.evidence; await evidence(directory);
  const manifest = await json(join(directory, 'manifest.json'));
  const scratch = await realpath(manifest.scratch);
  assert.equal(dirname(scratch), await systemTempRoot());
  assert.ok(scratch.split('/').at(-1).startsWith('broker-pi-scratch-'));
  assert.equal((await json(join(scratch, 'ownership.json'))).evidence, directory);
  const result = await runCommand('/usr/bin/trash', [scratch], { cwd: root, env: process.env });
  await save(join(directory, 'scratch-cleanup.json'), { scratch, status: 'trashed', evidencePreserved: true, stdoutBytes: Buffer.byteLength(result.stdout) });
} else {
  const report = await doctor();
  if (report.status !== 'ready') { console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; }
  else {
    const temporaryRoot = await systemTempRoot();
    const directory = await mkdtemp(join(await evidenceRoot(options['evidence-root'], temporaryRoot), 'broker-pi-evidence-'));
    const scratch = await mkdtemp(join(temporaryRoot, 'broker-pi-scratch-'));
    await save(join(scratch, 'ownership.json'), { evidence: directory });
    const manifest = { status: 'running', doctor: report, scratch, temporaryRoot, sessions: [], boundary: 'real Pi PTY; controlled source executable and provider; no live service or real model proof' };
    console.log(`Pi PTY evidence retained: ${directory}`);
    try {
      for (const direction of ['dollar-native-dollar','native-dollar']) {
        const base = join(scratch, direction), output = join(directory, direction);
        const agentDir = join(base, 'agent');
        await mkdir(join(agentDir, 'context-broker'), { recursive: true }); await mkdir(output);
        const fixture = await createNotionFixture(join(base, 'fixture'));
        if (options.upstreamLabels) await fixture.setScenario('normal', { upstream: { repo: 'fixture-repo' } });
        const config = join(agentDir, 'context-broker/config.yml');
        await save(config, { sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command: fixture.command, database, cacheDir: join(base, 'source-cache') }] });
        const provider = await writeFakeProvider(base);
        const providerFile = join(output, 'provider.jsonl');
        const env = isolatedEnv({ base, agentDir, TMPDIR: temporaryRoot, TERM: 'xterm-256color', COLORTERM: 'truecolor', CONTEXT_BROKER_HOST: 'omp', CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerFile, CONTEXT_BROKER_LOG_FILE: join(output, 'decisions.jsonl') });
        const host = report.host;
        const command = [host.file, ...host.prefix, '--no-extensions','--no-mcp','--no-context-files','--no-prompt-templates','--approve','--offline','--tui-mode','regular','--session-dir',join(base,'sessions'),'-e',report.extension.path,'-e',provider,'--provider','context-broker-e2e','--model','fake'];
        const paths = direction === 'dollar-native-dollar' ? ['dollar','native','dollar'] : ['native','dollar'];
        const page = fixture.skillRef.split('/')[2];
        const ready = { callsPath: fixture.callsPath, cacheDir: join(base, 'source-cache'), listArgs: ['--database', database], readArgs: [fixture.skillRef, '--database', database], snapshotId: fixture.snapshotId, scope: fixture.scope, id: `notion_page:${page}`, locator: { type: 'notion_page', page_id: page, database_id: database, data_source_id: '44444444-4444-4444-8444-444444444444' } };
        const steps = [{ label: 'ready', source: ready, screen: { stage: 'ready', skill: 'notion-ui-alpha' } }];
        for (const [index, kind] of paths.entries()) {
          const token = kind === 'dollar' ? '$ui-alpha@notion' : '/skill:notion-ui-alpha';
          const prefix = kind === 'dollar' ? (options.upstreamLabels ? '$fixture-repo/ui-a' : '$ui-a') : '/skill:notion-ui-a';
          steps.push({ label: `${index}-candidate`, send: prefix, screen: { stage: 'candidate', prefix, selected: kind === 'dollar' ? (options.upstreamLabels ? 'fixture-repo/UI Alpha [skill]' : token) : token.slice(1) } });
          steps.push({ label: `${index}-draft`, send: '\t', screen: { stage: 'draft', token } });
          steps.push({ label: `${index}-submit`, send: ` PTY_CASE_${index}\r`, screen: { stage: 'submitted' }, requests: index + 1 });
        }
        steps.push({ label: 'natural-exit', send: '\x04', exit: true });
        const spec = join(base, 'pty.json'); await save(spec, { command, cwd: base, env, evidence: output, provider: providerFile, canary, steps });
        manifest.sessions.push(direction); await save(join(directory, 'manifest.json'), manifest);
        const child = spawn('python3', [driver, spec], { cwd: base, env: isolatedEnv({ base, agentDir, TMPDIR: temporaryRoot }), stdio: ['ignore','pipe','pipe'] });
        child.stdout.resume(); child.stderr.resume();
        const result = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); });
        await save(join(output, 'driver-exit.json'), { pid: child.pid, ...result, observedExit: true });
        assert.equal(result.code, 0, `PTY ${direction} failed; inspect ${output}`);
      }
      manifest.status = 'passed';
    } catch (error) { manifest.status = 'failed'; manifest.error = error.message; manifest.failureDoctor = await doctor(); process.exitCode = 1; }
    finally { await save(join(directory, 'manifest.json'), manifest); }
    console.log(JSON.stringify(await evidence(directory), null, 2));
  }
}
