#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, resolveHost, runCommand, writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { createGraphFixture } from './notion-skill-graph.mjs';
import { createRequestLedger } from './notion-default-context.mjs';
import { systemTempRoot, evidenceRoot } from './verification-paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const driver = join(root, '.agents/skills/verify-context-broker/scripts/pi-pty-driver.py');
const usage = 'Usage: node scripts/verify-pi-graph-pty.mjs doctor|run --package ABSOLUTE_BROKER_TGZ --command-json \'["/absolute/node","/absolute/installed/ntn-skills.js"]\' --cli-source ABSOLUTE_CLI_CHECKOUT [--cases selection,escape-stop --evidence-root ABSOLUTE_DIRECTORY]\\nActual installed Pi PTY; controlled provider and immutable SQLite graph fixture; native Tab and Escape input. No actual Notion or autonomous model claim.\\n       evidence|cleanup --evidence ABSOLUTE_DIRECTORY';
const argv = process.argv.slice(2);
if (!argv.length || argv.some(arg => ['help', '--help', '-h'].includes(arg))) { console.log(usage); process.exit(0); }
const action = argv.shift(), options = {};
while (argv.length) { const key = argv.shift(); assert.ok(['--package','--command-json','--cli-source','--cases','--evidence-root','--evidence'].includes(key) && argv.length, usage); options[key.slice(2)] = argv.shift(); }
assert.ok(['doctor','run','evidence','cleanup'].includes(action), usage);
assert.ok(!process.versions.bun, 'The host acceptance runner requires Node');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const rows = async path => { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const identity = async path => ({ path: await realpath(path), sha256: sha(await readFile(path)) });
const cases = (options.cases ?? 'selection,escape-stop').split(',');
const cliCommand = options['command-json'] ? JSON.parse(options['command-json']) : undefined;
async function doctor() {
  const result = { status: 'ready', node: process.versions.node, platform: process.platform, failures: [], source: 'installed Node CLI + controlled immutable SQLite input', provider: 'controlled; credentials not inherited' };
  try {
    assert.notEqual(process.platform, 'win32');
    assert.ok(isAbsolute(options.package ?? '') && isAbsolute(options['cli-source'] ?? ''), usage);
    assert.ok(Array.isArray(cliCommand) && cliCommand.length === 2 && cliCommand.every(isAbsolute), usage);
    assert.ok(cases.length && cases.every(name => ['selection','escape-stop'].includes(name)), usage);
    result.package = await identity(options.package); result.cli = await identity(cliCommand[1]);
    result.host = await resolveHost('pi');
    assert.ok(result.host.identity.includes('/@earendil-works/pi-coding-agent/'), 'The required installed Pi identity must be observed; do not substitute OMP');
    const probe = await mkdtemp(join(await systemTempRoot(), 'broker-pi-graph-doctor-'));
    const env = isolatedEnv({base:probe,agentDir:join(probe,'agent')});
    result.scratch = probe;
    result.version = (await runCommand(result.host.file, [...result.host.prefix, '--version'], { cwd: probe, env, timeoutMs: 10000 })).stdout.trim();
    const help = (await runCommand(result.host.file, [...result.host.prefix, '--help'], { cwd: probe, env, timeoutMs: 10000 })).stdout;
    for (const flag of ['--no-extensions','--no-mcp','--no-context-files','--no-prompt-templates','--approve','--offline','--tui-mode','--tools']) assert.ok(help.includes(flag), 'Installed Pi lacks ' + flag);
    await access(join(options['cli-source'], 'packages/core/src/store.ts')); await access(driver);
    result.python = (await runCommand('python3', ['-c','import pty,fcntl,termios,select; print("stdlib PTY ready")'], { cwd: root, env: process.env, timeoutMs: 10000 })).stdout.trim();
  } catch (error) { result.status = 'blocked'; result.failures.push(error.message); }
  return result;
}
async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(path));
    else result.push(path);
  }
  return result;
}
function verifyBodies(context, graph) {
  const visible = context.messages.map(message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')).map(text => text.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&'));
  const selected = new Set(graph.useIds);
  const results = graph.nodes.filter(node => node.record.id !== graph.bom.record.id).map(node => {
    const copies = visible.reduce((sum, text) => sum + text.split(node.body).length - 1, 0);
    assert.equal(copies, selected.has(node.record.id) ? 1 : 0, 'Complete exact body count: ' + node.record.id);
    return { id: node.record.id, scope: node.scope, snapshot_id: node.snapshot_id, bytes: Buffer.byteLength(node.body), body_sha256: sha(node.body), copies };
  });
  const tools = [...new Set([...(context.tools ?? []), ...context.messages.flatMap(message => message.toolsAdded ?? [])].map(tool => tool.name ?? tool.tool?.name).filter(Boolean))];
  assert.ok(tools.includes('read') && !tools.some(name => /^(?:bash|exec|shell|execute|terminal)$/i.test(name)), 'Only the permitted native read tool may be active');
  return { bodies: results, tools };
}
async function evidence(directory) {
  assert.ok(isAbsolute(directory ?? ''), '--evidence is required');
  const manifest = await json(join(directory, 'manifest.json'));
  const observations = [];
  for (const branch of manifest.branches) {
    const result = await json(join(directory, branch.name, 'result.json')), cleanup = await json(join(directory, branch.name, 'cleanup.json'));
    assert.equal(cleanup.observedExit, true, 'Owned Pi process exit must be observed');
    assert.ok((await readFile(join(directory, branch.name, 'terminal.ansi'))).length);
    observations.push({ name: branch.name, status: result.status, naturalExit: cleanup.naturalExit });
  }
  return { status: 'preserved', functionalStatus: manifest.status, evidence: directory, observations };
}
if (action === 'doctor') { const result = await doctor(); console.log(JSON.stringify(result, null, 2)); if (result.status !== 'ready') process.exitCode = 1; }
else if (action === 'evidence') console.log(JSON.stringify(await evidence(options.evidence), null, 2));
else if (action === 'cleanup') {
  await evidence(options.evidence);
  const manifest = await json(join(options.evidence, 'manifest.json')), scratch = await realpath(manifest.scratch);
  assert.equal(dirname(scratch), await systemTempRoot()); assert.ok(scratch.split('/').at(-1).startsWith('broker-pi-graph-scratch-'));
  assert.equal((await json(join(scratch,'ownership.json'))).evidence, options.evidence);
  await runCommand('/usr/bin/trash', [scratch], { cwd: root, env: process.env });
  await save(join(options.evidence, 'scratch-cleanup.json'), { scratch, status: 'trashed', evidencePreserved: true });
} else {
  const report = await doctor();
  if (report.status !== 'ready') { console.log(JSON.stringify(report,null,2)); process.exitCode = 1; }
  else {
    const temporaryRoot = await systemTempRoot(), directory = await mkdtemp(join(await evidenceRoot(options['evidence-root'], temporaryRoot), 'broker-pi-graph-pty-'));
    const scratch = await mkdtemp(join(temporaryRoot, 'broker-pi-graph-scratch-'));
    await save(join(scratch,'ownership.json'), { evidence: directory });
    const manifest = { status: 'running', doctor: report, scratch, branches: [], boundary: 'actual installed Pi TUI + Tab and Escape; controlled provider and real installed Node CLI with immutable SQLite fixture; no actual Notion/model claim' };
    console.log('Pi graph PTY evidence retained: ' + directory);
    try {
      const installed = join(scratch,'installed'); await mkdir(installed);
      const install = await runCommand('npm', ['install','--workspaces=false','--prefix',installed,'--omit=dev','--no-audit','--no-fund', options.package], { cwd: scratch, env: process.env });
      await save(join(directory,'installation.json'), { ...install, package: report.package });
      const packageRoot = join(installed,'node_modules','pi-context-broker'), metadata = await json(join(packageRoot,'package.json'));
      const extension = await identity(resolve(packageRoot, metadata.pi.extensions[0]));
      manifest.extension = extension;
      for (const name of cases) {
        const base = join(scratch,name), output = join(directory,name), agentDir = join(base,'agent');
        await mkdir(join(agentDir,'context-broker'), { recursive:true }); await mkdir(output);
        const fixture = await createGraphFixture({ directory: join(base,'cli'), evidence: join(output,'source'), cliCommand, cliSource: options['cli-source'] });
        const ledger = await createRequestLedger({ scratch: base, evidence: output, command: fixture.command });
        try {
          if (name === 'escape-stop') await fixture.setState({ scenario: 'pending-http' });
          const config = join(agentDir,'context-broker/config.yml');
          await save(config, { sources:[{ type:'notion',id:'notion',namespace:'notion',command:ledger.command,database:fixture.graph.root.record.locator.database_id,cacheDir:join(base,'broker-cache'),prefetch:false,activation:{offline:true},requestTimeoutMs:45000,preparation:{maxNodes:8,maxDepth:4,maxInstructionBytes:8192,maxContextBytes:131072} }] });
          const providerFile = join(output,'provider.jsonl'); await writeFile(providerFile,'');
          const provider = await writeFakeProvider(base), env = isolatedEnv({ base,agentDir,TMPDIR:temporaryRoot,TERM:'xterm-256color',COLORTERM:'truecolor',CONTEXT_BROKER_HOST:'pi',CONTEXT_BROKER_CONFIG:config,CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE:providerFile,CONTEXT_BROKER_LOG_FILE:join(output,'decisions.jsonl') });
          const command = [report.host.file,...report.host.prefix,'--no-extensions','--no-mcp','--no-context-files','--no-prompt-templates','--approve','--offline','--tui-mode','regular','--tools','read','--session-dir',join(base,'sessions'),'-e',provider,'-e',extension.path,'--model','context-broker-e2e/fake'];
          const steps = [
            { label:'ready',screen:{stage:'ready',skill:'notion-graph-root'},providerCount:0 },
            { label:'dollar-candidate',send:'$graph-ro',screen:{stage:'candidate',prefix:'$graph-ro',selected:'$graph-root@notion'},providerCount:0 },
            { label:'dollar-selected',send:'\t',screen:{stage:'draft',token:'$graph-root@notion'},providerCount:0 },
          ];
          if (name === 'escape-stop') {
            steps.push(
              { label:'pending-prepare',send:' PTY_CANCEL_PENDING\r',ledger:[{path:fixture.httpPath,where:{phase:'request'}},{path:fixture.callsPath,where:{phase:'cli-spawned',category:'installed-cli-prepare'}}],providerCount:0 },
              { label:'escape-stop',send:'\x1b',ledger:[{path:ledger.ledger,where:{command:'prepare',phase:'completed'},nonzeroExit:true,exited:['pid','childPid']},{path:fixture.callsPath,where:{phase:'cli-completed',category:'installed-cli-prepare'},nonzeroExit:true,exited:['pid','childPid']}],providerCount:0 },
              { label:'retry-after-stop',fixtureState:{path:fixture.statePath,changes:{scenario:'normal'}},send:'$graph-root@notion PTY_RETRY_AFTER_STOP\r',screen:{stage:'submitted'},requests:1 },
            );
          } else {
            steps.push(
              {label:'dollar-submit',send:' PTY_GRAPH_DOLLAR\r',screen:{stage:'submitted'},requests:1},
              {label:'native-candidate',send:'/skill:notion-graph-ro',screen:{stage:'candidate',prefix:'/skill:notion-graph-ro',selected:'skill:notion-graph-root'}},
              {label:'native-selected',send:'\t',screen:{stage:'draft',token:'/skill:notion-graph-root'}},
              {label:'native-submit',send:' PTY_GRAPH_NATIVE\r',screen:{stage:'submitted'},requests:2},
            );
          }
          steps.push({label:'natural-exit',send:'\x04',exit:true});
          const spec = join(base,'pty.json'); await save(spec, { command,cwd:base,env,evidence:output,provider:providerFile,canary:'GRAPH_ROOT_WORKFLOW_COMPLETE',steps });
          manifest.branches.push({name,status:'running'}); await save(join(directory,'manifest.json'),manifest);
          const child = spawn('python3',[driver,spec],{cwd:base,env:isolatedEnv({base,agentDir,TMPDIR:temporaryRoot}),stdio:['ignore','pipe','pipe']});
          const stdout=[],stderr=[];child.stdout.on('data',chunk=>stdout.push(chunk));child.stderr.on('data',chunk=>stderr.push(chunk));
          const exited = await new Promise((done,fail)=>{child.once('error',fail);child.once('close',(code,signal)=>done({code,signal}));});
          await save(join(output,'driver-exit.json'),{pid:child.pid,...exited,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()});
          assert.equal(exited.code,0,'Actual Pi PTY case failed; inspect '+output);
          const captures = await rows(providerFile); assert.equal(captures.length,name==='selection'?2:1);
          const verification = captures.map(row=>verifyBodies(row.context,fixture.graph));
          const sessionFiles = (await filesIn(join(base,'sessions'))).filter(path=>path.endsWith('.jsonl'));
          for (const [index,path] of sessionFiles.entries()) await writeFile(join(output,'session-'+index+'.jsonl'),await readFile(path));
          const actions = await json(join(output,'actions.json'));
          const bodyReadsBeforeSelection = (await rows(fixture.callsPath)).filter(row=>row.phase==='source-entered'&&['prepare','read','export'].includes(row.command)&&Date.parse(row.at)<actions.find(row=>row.label==='dollar-selected').at*1000);
          assert.equal(bodyReadsBeforeSelection.length,0,'Candidates and Tab selection cannot prepare bodies');
          if(name==='escape-stop') {
            const pending=actions.find(row=>row.label==='pending-prepare');
            const visible=pending.screen.lines.join('\n');
            assert.ok(visible.includes('Preparing use:')&&visible.includes('8 nodes')&&visible.includes('Stop cancels preparation.'),'Preparation budget and Stop must be visible in the actual terminal');
          }
          await save(join(output,'verification.json'),{status:'passed',verification,metadata_only_selection:true,sourceProcesses:(await rows(fixture.callsPath)).filter(row=>row.phase==='cli-spawned'),native_composer_stop:name==='escape-stop'});
          manifest.branches.at(-1).status='passed';
        } finally { await fixture.close(); }
      }
      assert.deepEqual(await identity(manifest.extension.path),manifest.extension);
      manifest.status='passed';
    } catch(error) { manifest.status='failed';manifest.error=error.stack??error.message;process.exitCode=1; }
    finally { await save(join(directory,'manifest.json'),manifest); }
    console.log(JSON.stringify(await evidence(directory),null,2));
  }
}
