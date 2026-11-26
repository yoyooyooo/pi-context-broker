import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceObserverPreloadSource, readSourceObservation, parseSourceObservation } from './skill-consumption-source-observer.mjs';
import { readNotionAgentCliProcesses, verifyNotionAgentCliProcesses, verifyNotionAgentSingleProjectionRestore, verifyNotionAgentOriginalSourceResume } from './notion-agent-cli-process.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const identity = async path => {
  const bytes = await readFile(path); return { path, realpath: await realpath(path), sha256: sha(bytes), bytes: bytes.length };
};
const code = 'process.stdout.write("CLI_OUTPUT\\n"); process.exitCode=7;\n';

async function fixture(executable = code) {
  const directory = await mkdtemp(join(tmpdir(), 'notion-cli-process-'));
  const processes = join(directory, 'processes'), cli = join(directory, 'ntn-skills.js'), embedded = join(directory, 'ntn-skills.mjs');
  await mkdir(processes, { mode: 0o700 }); await writeFile(cli, executable); await writeFile(embedded, executable + '// embedded\n');
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

test('real OS ancestry bridges an intermediate shell to its observed source child lifetime', async t => {
  const f = await fixture();
  const nested = '/bin/bash -c ' + quote(f.invoke(f.cli) + '; status=$?; exit $status');
  const actual = await f.run(nested), observed = actual.proof.processes.find(row => row.cli);
  assert.equal(actual.stdout, 'CLI_OUTPUT\n'); assert.equal(actual.exitCode, 7); assert.equal(actual.stderr, '');
  assert.equal(actual.proof.status, 'passed', JSON.stringify(actual.proof.diagnostics));
  assert.deepEqual(observed.ancestry.map(row => row.basis), ['os-ppid', 'os-ppid', 'source-child', 'source-owner']);
  assert.equal(observed.osAncestry.method, 'unix-ps-pid-ppid-lstart-v1');
  const childIndex = actual.processFiles.findIndex(file => JSON.parse(file.contents.toString().split('\n')[0]).cli !== null);
  const ownerPid = actual.input.sourceObservation.events[0].pid;
  const changeStart = transform => file => sealed(file, rows => rows.map(row => row.phase === 'process_start' ? transform(row) : row));
  for (const [name, change, code] of [
    ['legacy evidence has no observed intermediate edge', changeStart(row => { const { osAncestry, ...old } = row; return old; }), 'CLI_PROCESS_ANCESTRY_UNKNOWN'],
    ['unsupported platform stays unknown', changeStart(row => ({ ...row, osAncestry: { complete: false, reason: 'unsupported-platform' } })), 'CLI_PROCESS_ANCESTRY_UNKNOWN'],
    ['changed confirmation', changeStart(row => { row.osAncestry.confirmation.stdout = row.osAncestry.confirmation.stdout.replace(/^\s*\d+/u, '2147483647'); return row; }), 'CLI_OS_ANCESTRY_INVALID'],
    ['capture after process start', changeStart(row => { row.osAncestry.finishedNs = String(BigInt(row.monotonicNs) + 1n); return row; }), 'CLI_OS_ANCESTRY_INVALID'],
    ['another owner process incarnation', changeStart(row => {
      for (const sample of [...row.osAncestry.samples, row.osAncestry.confirmation])
        sample.stdout = sample.stdout.split('\n').map(line => Number(/^\s*(\d+)/u.exec(line)?.[1]) === ownerPid ? line.replace(/\d{4}(\s*)$/u, '1900$1') : line).join('\n');
      return row;
    }), 'CLI_PROCESS_ANCESTRY_UNKNOWN'],
  ]) await t.test(name, () => {
    const files = [...actual.processFiles]; files[childIndex] = change(files[childIndex]);
    const proof = verifyNotionAgentCliProcesses({ ...actual.input, processFiles: files });
    assert.equal(proof.status, 'blocked'); assert.ok(proof.diagnostics.some(row => row.code === code), JSON.stringify(proof.diagnostics));
  });
  await t.test('matching PIDs cannot borrow a source child lifetime that ended before the OS capture', () => {
    const childId = observed.ancestry.find(row => row.basis === 'source-child').childId;
    const source = actual.input.sourceObservation.events;
    const spawn = source.find(row => row.childId === childId && row.phase === 'unmatched_child_spawn');
    const changed = sealed({ artifact: { path: '/owned/source.jsonl' }, contents: Buffer.from(source.map(row => JSON.stringify(row)).join('\n') + '\n') }, rows => rows.map(row =>
      row.childId === childId && row.phase === 'unmatched_child_exit' ? { ...row, monotonicNs: spawn.monotonicNs }
        : row.childId === childId && row.phase === 'unmatched_child_close' ? { ...row, monotonicNs: spawn.monotonicNs } : row));
    const sourceObservation = parseSourceObservation(changed.contents.toString());
    assert.deepEqual(sourceObservation.errors, []);
    const proof = verifyNotionAgentCliProcesses({ ...actual.input, processFiles: actual.processFiles, sourceObservation });
    assert.equal(proof.status, 'blocked'); assert.ok(proof.diagnostics.some(row => row.code === 'CLI_PROCESS_ANCESTRY_UNKNOWN'));
  });
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
    ['ancestry', file => sealed(file, rows => rows.map(row => ({ ...row, parentPid: 2147483647 }))), 'CLI_OS_ANCESTRY_INVALID'],
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

test('actual Agent resume fingerprints bind the original input, root, operation and installed CLI bytes', async () => {
  const f = await fixture('process.exitCode=0;\n'), declaration = join(f.directory, 'original-source.json');
  await writeFile(declaration, '{}\n');
  const original = { declaration: await identity(declaration), libraryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    operationId: 'original-operation', cli: await identity(f.cli) };
  const command = f.invoke(f.cli);
  const actual = await f.run(command + ' ctl library operation source-id --kind source --library ' + original.libraryId + '; '
    + command + ' ctl library source apply ' + quote(declaration) + ' --library=' + original.libraryId + ' --operation ' + original.operationId + ' --resume --json --metrics');
  assert.equal(actual.proof.status, 'passed');
  const result = verifyNotionAgentOriginalSourceResume(actual.proof, original);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.deepEqual(result.commands.map(command => command.kind), ['read-only', 'original-source-resume']);
  for (const changed of [{ ...original, operationId: 'replacement-operation' }, { ...original, libraryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { ...original, declaration: { ...original.declaration, path: declaration + '-copy' } }, { ...original, cli: { ...original.cli, sha256: '0'.repeat(64) } }])
    assert.equal(verifyNotionAgentOriginalSourceResume(actual.proof, changed).status, 'failed');
  assert.equal(verifyNotionAgentOriginalSourceResume({ ...actual.proof, processes: [...actual.proof.processes, ...actual.proof.processes.filter(row => row.cli)] }, original).status, 'failed');
  for (const file of actual.processFiles) assert.equal(file.contents.includes(original.operationId), false, 'Keep private arguments fingerprinted');
});

test('one real restoration allows help and read-only checks without retaining private argument text', async () => {
  const f = await fixture('process.exitCode=0;\n');
  const target = 'PRIVATE_RESTORE_TARGET', entry = 'PRIVATE_LIBRARY_ENTRY';
  const command = f.invoke(f.cli), projection = command + ' ctl library projection ' + target;
  const actual = await f.run([command + ' ctl library projection --help',
    projection + ' --library=' + entry + ' --dry-run',
    projection + ' --restore --library ' + entry + ' --include=**/*.md --exclude ' + quote('**/tests/**'),
    command + ' read ' + target + ' --refresh --path scripts/check.py',
    command + ' list --query skill-name --json',
    command + ' export ' + target + ' --output /owned/output',
    command + ' ctl library files ' + target + ' --library ' + entry].join('; '));
  const proof = verifyNotionAgentSingleProjectionRestore(actual.proof);
  assert.equal(proof.status, 'passed', JSON.stringify(proof));
  assert.equal(proof.restoreInvocations, 1);
  assert.deepEqual(proof.commands.map(row => row.kind), ['help', 'read-only', 'projection-restore', 'read-only', 'read-only', 'read-only', 'read-only']);
  for (const file of actual.processFiles) {
    assert.equal(file.contents.includes(target), false);
    assert.equal(file.contents.includes(entry), false);
  }
});

test('a failed restore followed by a successful retry is two invocations and never passes', async () => {
  const f = await fixture('process.exitCode=process.argv.includes("first")?1:0;\n'), command = f.invoke(f.cli);
  const actual = await f.run(command + ' ctl library projection first --restore --library library; '
    + command + ' ctl library projection second --restore --library library');
  const proof = verifyNotionAgentSingleProjectionRestore(actual.proof);
  assert.equal(proof.status, 'failed'); assert.equal(proof.restoreInvocations, 2);
  assert.deepEqual(proof.commands.map(row => row.exitCode), [1, 0]);
  assert.ok(proof.diagnostics.some(row => row.code === 'RESTORE_INVOCATION_COUNT'));
});

test('an additional ordinary projection or explicit resume cannot hide behind one restore', async t => {
  for (const suffix of ['', ' --operation operation-id --resume']) await t.test(suffix || 'new projection', async () => {
    const f = await fixture('process.exitCode=0;\n'), command = f.invoke(f.cli) + ' ctl library projection target --library library';
    const actual = await f.run(command + ' --restore; ' + command + suffix);
    const proof = verifyNotionAgentSingleProjectionRestore(actual.proof);
    assert.equal(proof.status, 'failed'); assert.equal(proof.restoreInvocations, 1);
    assert.ok(proof.diagnostics.some(row => row.code === 'EXTRA_PROJECTION_WRITE'));
  });
});

test('a failed sole restore and a help-only invocation cannot claim completion', async t => {
  for (const [suffix, code] of [['--restore', 'RESTORE_INVOCATION_FAILED'], ['--help', 'RESTORE_INVOCATION_COUNT']])
    await t.test(suffix, async () => {
      const f = await fixture(), actual = await f.run(f.invoke(f.cli) + ' ctl library projection target --library library ' + suffix);
      const proof = verifyNotionAgentSingleProjectionRestore(actual.proof);
      assert.equal(proof.status, 'failed'); assert.ok(proof.diagnostics.some(row => row.code === code));
    });
});

test('a restore-looking value or unknown command shape is not a verified restore command', async t => {
  for (const [args, expected] of [
    ['ctl library projection target --library library --include=--restore', 'failed'],
    ['ctl library projection target --library library --include --restore', 'blocked'],
    ['ctl library projection target --library library --restore --future-flag', 'blocked'],
    ['ctl library update target --library library', 'blocked'],
    ['read target --restore', 'blocked'],
    ['ctl library operation target --kind skill --library library --dry-run', 'blocked'],
    ['list unexpected-target --query skill-name', 'blocked'],
    ['export target', 'blocked'],
    ['files target --json', 'blocked'],
  ]) await t.test(args, async () => {
    const f = await fixture('process.exitCode=0;\n'), actual = await f.run(f.invoke(f.cli) + ' ' + args);
    const proof = verifyNotionAgentSingleProjectionRestore(actual.proof);
    assert.equal(proof.status, expected, JSON.stringify(proof));
    assert.equal(proof.restoreInvocations, 0);
  });
});

test('old or damaged argument observations remain unproved without changing original process identity', async () => {
  const f = await fixture('process.exitCode=0;\n');
  const actual = await f.run(f.invoke(f.cli) + ' ctl library projection target --library library --restore');
  const childIndex = actual.processFiles.findIndex(file => JSON.parse(file.contents.toString().split('\n')[0]).cli !== null);
  const oldFiles = [...actual.processFiles];
  oldFiles[childIndex] = sealed(oldFiles[childIndex], rows => rows.map(row => { const { invocation, ...old } = row; return old; }));
  const oldProof = verifyNotionAgentCliProcesses({ ...actual.input, processFiles: oldFiles });
  assert.equal(oldProof.status, 'passed');
  assert.equal(verifyNotionAgentSingleProjectionRestore(oldProof).status, 'blocked');
  const damaged = [...actual.processFiles];
  damaged[childIndex] = sealed(damaged[childIndex], rows => rows.map(row => row.phase === 'process_start'
    ? { ...row, invocation: { ...row.invocation, arguments: [{ sha256: 'invented', option: false, inline: null }] } } : row));
  const invalid = verifyNotionAgentCliProcesses({ ...actual.input, processFiles: damaged });
  assert.equal(invalid.status, 'blocked');
  assert.ok(invalid.diagnostics.some(row => row.code === 'CLI_PROCESS_ARGUMENTS_INVALID'));
});
