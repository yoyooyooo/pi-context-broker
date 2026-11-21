import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceObserverPreloadSource, readSourceObservation, parseSourceObservation } from './skill-consumption-source-observer.mjs';
import { readNotionAgentCliProcesses, verifyNotionAgentCliProcesses } from './notion-agent-cli-process.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const identity = async path => {
  const bytes = await readFile(path); return { path, realpath: await realpath(path), sha256: sha(bytes), bytes: bytes.length };
};
const code = 'process.stdout.write("CLI_OUTPUT\\n"); process.exitCode=7;\n';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'notion-cli-process-'));
  const processes = join(directory, 'processes'), cli = join(directory, 'ntn-skills.js'), embedded = join(directory, 'ntn-skills.mjs');
  await mkdir(processes, { mode: 0o700 }); await writeFile(cli, code); await writeFile(embedded, code + '// embedded\n');
  const expectedEntries = await Promise.all([cli, embedded].map(identity));
  const owner = join(directory, 'owner.mjs'), preload = join(directory, 'observer.mjs'), source = join(directory, 'source.jsonl');
  async function run(command) {
    // The shell remains alive after Node exits, so PPID must cross an actual
    // observed shell boundary; a filename or command-string match cannot pass.
    await writeFile(owner, 'import {spawn} from "node:child_process";\n'
      + 'const child=spawn("/bin/bash",["-c",' + JSON.stringify(command + '; status=$?; exit $status') + '],{stdio:["ignore","pipe","pipe"]});\n'
      + 'child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);\n'
      + 'process.exitCode=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});\n');
    await writeFile(preload, sourceObserverPreloadSource({ output: source, processDirectory: processes, checkoutRoot: process.cwd(),
      clockId: randomUUID(), cliPath: cli, ownerEntry: owner, ownerParentPid: process.pid }));
    const child = spawn(process.execPath, [owner], { env: { ...process.env, NODE_OPTIONS: '--import=' + pathToFileURL(preload).href }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const sourceObservation = await readSourceObservation(source);
    assert.deepEqual(sourceObservation.errors, []); assert.equal(sourceObservation.complete, true);
    assert.deepEqual(parseSourceObservation(await readFile(source, 'utf8')), sourceObservation);
    const input = { directory: processes, sourceObservation, expectedEntries, min: 1 };
    const proof = await readNotionAgentCliProcesses(input);
    const processFiles = await Promise.all(proof.artifacts.map(async artifact => ({ artifact, contents: await readFile(artifact.path) })));
    return { proof, input, processFiles, exitCode, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  }
  return { directory, processes, cli, embedded, expectedEntries, run, invoke: path => quote(process.execPath) + ' ' + quote(path) };
}

function sealed(file, change) {
  const rows = file.contents.toString().trimEnd().split('\n').map(line => JSON.parse(line));
  const next = change(rows); let previous = null;
  const contents = Buffer.from(next.map((row, index) => {
    const { eventSha256: _old, ...event } = row;
    event.sequence = index + 1; event.previousSha256 = previous; event.eventSha256 = sha(JSON.stringify(event)); previous = event.eventSha256;
    return JSON.stringify(event);
  }).join('\n') + '\n');
  return { artifact: { ...file.artifact, sha256: sha(contents), bytes: contents.length }, contents };
}

test('inherited passive preload proves the real symlink target through bash and retains a failed CLI exit', async () => {
  const f = await fixture(), link = join(f.directory, 'selected-cli'); await symlink(f.cli, link);
  const privateArgument = 'PRIVATE_ARG_MUST_NOT_BE_RECORDED';
  const actual = await f.run(f.invoke(link) + ' ' + quote(privateArgument));
  assert.equal(actual.exitCode, 7); assert.equal(actual.stdout, 'CLI_OUTPUT\n'); assert.equal(actual.stderr, '');
  assert.equal(actual.proof.status, 'passed'); assert.equal(actual.proof.cliCount, 1); assert.equal(actual.proof.matchedCliCount, 1);
  assert.equal(actual.proof.distinctEntries.length, 1);
  const observed = actual.proof.processes.find(process => process.cli);
  assert.equal(observed.entry.realpath, f.expectedEntries[0].realpath); assert.equal(observed.entry.sha256, f.expectedEntries[0].sha256);
  assert.equal(observed.exitCode, 7); assert.deepEqual(observed.ancestry.map(item => item.basis), ['observed-ppid', 'source-child', 'source-owner']);
  assert.ok(actual.input.sourceObservation.events.some(row => row.phase === 'unmatched_child_start' && row.transport === 'unknown'));
  for (const file of actual.processFiles) assert.equal(file.contents.includes(privateArgument), false);
  assert.deepEqual(verifyNotionAgentCliProcesses({ ...actual.input, processFiles: actual.processFiles }), actual.proof);
});

test('standalone and embedded entries are distinct accepted actual processes, with per-turn filtering', async () => {
  const f = await fixture(), alias = join(f.directory, 'cli-alias'); await symlink(f.cli, alias);
  const actual = await f.run(f.invoke(f.cli) + '; ' + f.invoke(f.embedded) + '; ' + f.invoke(alias));
  assert.equal(actual.proof.status, 'passed'); assert.equal(actual.proof.cliCount, 3); assert.equal(actual.proof.distinctEntries.length, 2);
  const child = actual.proof.processes.filter(process => process.cli).sort((a, b) => BigInt(a.startedNs) < BigInt(b.startedNs) ? -1 : 1)[1];
  const isolated = verifyNotionAgentCliProcesses({ ...actual.input, processFiles: actual.processFiles, window: { startNs: child.startedNs, endNs: child.endedNs } });
  assert.equal(isolated.status, 'passed'); assert.equal(isolated.cliCount, 1); assert.equal(isolated.distinctEntries[0].realpath, f.expectedEntries[1].realpath);
});

test('an actual unselected CLI is a hard failure even without a required invocation assertion', async () => {
  const f = await fixture(), other = join(f.directory, 'other'); await mkdir(other);
  const actualCli = join(other, 'renamed.js');
  await writeFile(actualCli, code + '// unexpected package\n');
  await writeFile(join(other, 'package.json'), JSON.stringify({ name: 'ntn-skills', bin: { 'ntn-skills': './renamed.js' } }));
  const actual = await f.run(f.invoke(f.cli) + '; ' + f.invoke(actualCli));
  const proof = verifyNotionAgentCliProcesses({ ...actual.input, processFiles: actual.processFiles, min: 0 });
  assert.equal(proof.status, 'failed'); assert.equal(proof.cliCount, 2); assert.equal(proof.matchedCliCount, 1);
  assert.equal(proof.processes.find(process => process.status === 'failed').classification, 'package-bin');
  assert.ok(proof.diagnostics.some(item => item.code === 'CLI_CANDIDATE_MISMATCH'));
});

test('the expected path with changed actual bytes cannot pass candidate identity', async () => {
  const f = await fixture(); await writeFile(f.cli, code + '// changed after candidate freeze\n');
  const actual = await f.run(f.invoke(f.cli));
  assert.equal(actual.proof.status, 'failed'); assert.ok(actual.proof.diagnostics.some(item => item.code === 'CLI_CANDIDATE_MISMATCH'));
});

test('Node eval cannot pretend to execute a CLI by placing its filename in argv', async () => {
  const f = await fixture(), actual = await f.run(quote(process.execPath) + ' -e ' + quote('process.stdout.write("EVAL")') + ' ' + quote(f.cli));
  assert.equal(actual.stdout, 'EVAL'); assert.equal(actual.exitCode, 0);
  assert.equal(actual.proof.status, 'blocked'); assert.equal(actual.proof.cliCount, 0);
  assert.ok(actual.proof.unknownProcesses.some(process => process.entryMode === 'non-file' && process.entry === null));
  assert.ok(actual.proof.diagnostics.some(item => item.code === 'CLI_CANDIDATE_EXECUTION_MISSING'));
});

test('a child that drops the inherited preload is not filled in from shell argv', async () => {
  const f = await fixture(), actual = await f.run('env -u NODE_OPTIONS ' + f.invoke(f.cli));
  assert.equal(actual.stdout, 'CLI_OUTPUT\n'); assert.equal(actual.proof.status, 'blocked'); assert.equal(actual.proof.cliCount, 0);
  assert.ok(actual.proof.diagnostics.some(item => item.code === 'CLI_CANDIDATE_EXECUTION_MISSING'));
});

test('missing terminal, unknown ancestry, changed entry and corrupt raw artifacts never become passes', async t => {
  const f = await fixture(), actual = await f.run(f.invoke(f.cli));
  const childIndex = actual.processFiles.findIndex(file => JSON.parse(file.contents.toString().split('\n')[0]).cli !== null);
  const cases = [
    ['terminal', file => sealed(file, rows => rows.slice(0, 1)), 'CLI_PROCESS_TERMINAL_MISSING'],
    ['ancestry', file => sealed(file, rows => rows.map(row => ({ ...row, parentPid: 2147483647 }))), 'CLI_PROCESS_ANCESTRY_UNKNOWN'],
    ['changed entry', file => sealed(file, rows => rows.map(row => row.phase === 'process_end' ? { ...row, entry: { ...row.entry, sha256: 'a'.repeat(64) } } : row)), 'CLI_PROCESS_ENTRY_CHANGED'],
    ['corrupt artifact', file => ({ ...file, contents: Buffer.concat([file.contents, Buffer.from(' ')]) }), 'CLI_PROCESS_ARTIFACT_INVALID'],
  ];
  for (const [name, change, code] of cases) await t.test(name, () => {
    const files = [...actual.processFiles]; files[childIndex] = change(files[childIndex]);
    const proof = verifyNotionAgentCliProcesses({ ...actual.input, processFiles: files });
    assert.equal(proof.status, 'blocked'); assert.ok(proof.diagnostics.some(item => item.code === code));
  });
  const missing = verifyNotionAgentCliProcesses({ ...actual.input, processFiles: [] });
  assert.equal(missing.status, 'blocked'); assert.equal(missing.cliCount, null);
  const unknown = verifyNotionAgentCliProcesses({ ...actual.input, processFiles: actual.processFiles, sourceObservation: { events: [], errors: [] } });
  assert.equal(unknown.status, 'blocked'); assert.equal(unknown.cliCount, null);
});
