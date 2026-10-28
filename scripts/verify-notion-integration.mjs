#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, resolveHost, runCommand, spawnHost, signalHost, writeFakeProvider } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { createNotionFixture, database as fixtureDatabase, secondCanary } from './notion-integration-fixture.mjs';
import { runNotionModel } from './notion-integration-model.mjs';
import { runConsumerModel } from './notion-consumer-model.mjs';
import { createLiveFixture } from './notion-live-fixture.mjs';
import { runSourceLifecycle } from './notion-source-lifecycle.mjs';
import { createRequestLedger, nativeEntries, runDefaultContext } from './notion-default-context.mjs';
import { runCacheLifecycle } from './notion-cache-lifecycle.mjs';
import { runSharedCatalog } from './notion-shared-catalog.mjs';
import { runViewDiscovery } from './notion-view-discovery.mjs';
import { systemTempRoot, evidenceRoot } from './verification-paths.mjs';
import { entryIdentity, verifyEntryIdentity } from './verification-entry.mjs';
import { invokeJson } from './verification-command.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const usage = 'Usage: node scripts/verify-notion-integration.mjs doctor|run [--mode deterministic|live|live-fixture|model|installed] [--view-discovery true (deterministic only)] [--view VIEW_ID (live/model)] [--shared-catalog true (deterministic only)] [--cache-lifecycle true (live-fixture only)] [--consumer-isolation true (model only; explicit dollar selection, normal tools, hidden local paths)] [--consumer-resource RELATIVE_FILE --upstream-database UUID (with consumer-isolation)] [--database UUID --skill-ref skill://PAGE/SKILL.md --command-json JSON --extension ABSOLUTE_INSTALLED_ENTRY --package TGZ --model PROVIDER/MODEL --model-prompt TEXT --host pi|omp --evidence-root ABSOLUTE_DIRECTORY]; evidence|cleanup --evidence DIR';
if (argv.some(arg => ['--help','-h','help'].includes(arg))) { console.log(usage); process.exit(0); }
const action = argv.shift() ?? 'run';
let mode = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'deterministic';
const options = {};
while (argv.length) { const key = argv.shift(); if (!key?.startsWith('--') || !argv.length) throw new Error('Options require --name VALUE'); options[key.slice(2)] = argv.shift(); }
if(options.mode)mode=options.mode;
if (!['doctor','run','evidence','cleanup'].includes(action) || !['deterministic','live','live-fixture','model','installed'].includes(mode)) throw new Error('Usage: node scripts/verify-notion-integration.mjs doctor|run [deterministic|live|live-fixture|model|installed] [--default-context true (deterministic/live-fixture/installed) --database DB --skill-ref REF --command-json JSON --package TGZ --model PROVIDER/MODEL --model-prompt TEXT --host pi|omp (model only; default both)]; evidence|cleanup --evidence DIR');
// Dedicated Default Context acceptance retains the existing modes/entrypoints.
// It requires actual dual-host catalogs, session-neutral prefetch diagnostics,
// explicit-dollar unchecked pages, lifecycle and safe source request ledgers.
const defaultContext = options['default-context'] === 'true';
const viewDiscovery = options['view-discovery'] === 'true';
if (options['view-discovery'] !== undefined && (!viewDiscovery || mode !== 'deterministic' || defaultContext)) throw new Error('--view-discovery requires true and deterministic mode without another acceptance branch');
if (options['default-context'] !== undefined && (!defaultContext || !['deterministic','live-fixture','installed'].includes(mode))) throw new Error('--default-context requires true and deterministic, live-fixture, or installed mode');
const cacheLifecycle = options['cache-lifecycle'] === 'true';
if (options['cache-lifecycle'] !== undefined && (!cacheLifecycle || mode !== 'live-fixture' || defaultContext)) throw new Error('--cache-lifecycle requires true, live-fixture, and no --default-context');
const sharedCatalog = options['shared-catalog'] === 'true';
if (options['shared-catalog'] !== undefined && (!sharedCatalog || mode !== 'deterministic' || defaultContext || cacheLifecycle)) throw new Error('--shared-catalog requires true, deterministic, and no other acceptance branch');
if (options.host !== undefined && (mode !== 'model' || !['pi','omp'].includes(options.host))) throw new Error('--host accepts pi or omp only in model mode; omit it to run both hosts');
const consumerIsolation = options['consumer-isolation'] === 'true';
if (options['consumer-isolation'] !== undefined && (!consumerIsolation || mode !== 'model')) throw new Error('--consumer-isolation requires true and model mode');
if (options['consumer-resource'] !== undefined && !consumerIsolation) throw new Error('--consumer-resource requires --consumer-isolation true');
if (options['upstream-database'] !== undefined && !consumerIsolation) throw new Error('--upstream-database requires --consumer-isolation true');
const modelHosts = options.host ? [options.host] : ['pi','omp'];
const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split('.').map(Number);
const supportedNode = (nodeMajor === 22 && (nodeMinor > 22 || (nodeMinor === 22 && nodePatch >= 3))) || nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 20);
if (!supportedNode || process.versions.bun) throw new Error('Use Node.js 22.22.3+ within 22.x or 24.20.0+; Bun is build-only');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const rows = async path => { try { return (await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
const save = (path, value) => writeFile(path, JSON.stringify(value,null,2)+'\n');
const count = (value, marker) => JSON.stringify(value).split(marker).length - 1;
async function executable(name) { return resolveHost(name); }
async function capture(file,args,{cwd,env=process.env,timeout=60000}={}) {
  const command=typeof file==='string'?{file,prefix:[]}:file;
  const child=spawn(command.file,[...command.prefix,...args],{cwd,env,stdio:['ignore','pipe','pipe']});
  return new Promise((accept,reject)=>{ let stdout='',stderr='',expired=false; const timer=setTimeout(()=>{expired=true;child.kill('SIGTERM');},timeout); const escalation=setTimeout(()=>child.kill('SIGKILL'),timeout+2000); child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',e=>{clearTimeout(timer);clearTimeout(escalation);reject(e);});child.on('close',(code,signal)=>{clearTimeout(timer);clearTimeout(escalation);accept({code,signal,expired,stdout,stderr});}); });
}
function command() { const value=options['command-json']?JSON.parse(options['command-json']):['ntn-skills']; assert.ok(Array.isArray(value)&&value.length&&value.every(v=>typeof v==='string'),'--command-json must be a nonempty argument array'); return value; }
async function doctor() {
 const result={mode,node:process.versions.node,tools:[],failures:[],authentication:'not probed',status:'ready'};
 const probe = await mkdtemp(join(await systemTempRoot(),'broker-notion-doctor-'));result.scratch=probe;result.scratchDisposition='retained; move owned scratch to system Trash after review';
 for(const host of mode==='model'?modelHosts:['pi','omp',...(cacheLifecycle?['tern','python3']:[])]) { try {const output=await runCommand(host,['--version'],{cwd:probe,env:isolatedEnv({base:probe,agentDir:join(probe,'agent'),TMPDIR:await systemTempRoot()}),timeoutMs:10000}); result.tools.push({host,version:output.stdout.trim()});} catch(e){result.failures.push(e.message);} }
 if(['live','live-fixture','model'].includes(mode)){ if(!options.database||(mode!=='live-fixture'&&!options['skill-ref']?.startsWith('skill://')))result.failures.push('Require --database and (except live-fixture) explicit --skill-ref skill://PAGE/SKILL.md');try{result.tools.push({notionCommand:await executable(command()[0])});if(mode==='live-fixture')result.tools.push({notionApi:await executable('ntn')});}catch(e){result.failures.push(e.message);} }
 if(mode==='model'&&(!options.model||!options['model-prompt']))result.failures.push('model requires authorized --model provider/model and a natural --model-prompt (do not prompt token or CLI names)');
 try {
  if(mode==='installed')result.extension={status:'pending-install',package:await entryIdentity(options.package)};
  else {const extension=options.extension??join(root,'packages/context-broker/src/index.ts');assert.ok(isAbsolute(extension),'--extension must be absolute');result.extension=await entryIdentity(extension);}
  if(['live','live-fixture','model'].includes(mode)){
   const cmd=command();const file=await executable(cmd[0]);const script=cmd.slice(1).find(arg=>isAbsolute(arg));
   result.cli={command:[file.file,...file.prefix,...cmd.slice(1)],identity:file.identity,sha256:createHash('sha256').update(await readFile(script??file.identity)).digest('hex')};
  }
 }catch(error){result.failures.push(error.message);}
 if(mode==='installed'){try{assert.ok(isAbsolute(options.package??''),'--package must be absolute');await access(options.package);result.tools.push({npm:await executable('npm')});}catch(e){result.failures.push(e.message);} }
 result.status=result.failures.length?'blocked':'ready';return result;
}
async function sourceLive(scratch,{metadataOnly=false,commandOverride,evidence}={}) {
 const cmd=commandOverride??command();const resolved=await executable(cmd[0]);const invoke=async args=>invokeJson([resolved.file,...resolved.prefix,...cmd.slice(1)],args,{cwd:scratch,evidence:join(evidence,'command-receipts.jsonl'),category:'source-live',deadline:consumerIsolation?180000:60000});
 const listed=await invoke(['list','--database',options.database,...(!consumerIsolation ? options.view ? ['--view',options.view] : ['--default-view'] : [])]);assert.deepEqual(listed.coverage?.failed_sources,[],'Live list must not hide failed sources');assert.equal(listed.coverage?.exhaustive,true,'Explicit database catalog must be exhaustive');assert.ok(listed.coverage?.queried_data_sources?.length,'Live list must cover a data source');const target=options['skill-ref'].split('/')[2];const item=listed.records.find(s=>s.locator?.page_id===target||s.ref===options['skill-ref']);assert.ok(item,'Requested real skill must belong to selected database');
 if(!consumerIsolation)assert.ok(listed.view?.id,'Native live/model recipe requires a selected View containing the requested record');
 if(metadataOnly)return {command:cmd,alias:item.alias??item.name,skillRef:options['skill-ref'],live:{scope:listed.scope,skillId:item.id,metadataOnly:true}};
 const read=await invoke(['read',options['skill-ref'],...(consumerIsolation?['--database',options.database]:[])]);assert.ok(read.content?.trim()&&read.snapshot_id,'Live read must return a body and snapshot');const exported=await invoke(['export',read.snapshot_id,...['--projection','snapshot'],'--format','directory','--output',join(scratch,'live-export')]);const entry=join(exported.output,exported.main_path??'SKILL.md');const body=await readFile(entry,'utf8');assert.ok(body.trim());
 const marker=body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').split(/\r?\n/).find(line=>line.trim());assert.ok(marker,'Export must contain a non-metadata body');
 const selector=item.locator.type==='notion_page'?item.locator.page_id:item.locator.subscription_id;const selectionToken=`${item.alias}${listed.records.filter(record=>record.alias===item.alias).length>1?'@'+selector.replaceAll('-',''):''}@notion`;
 return {command:cmd,alias:item.alias??item.name,selectionToken,skillRef:options['skill-ref'],marker,entryContent:read.content,exportDirectory:exported.output,live:{scope:listed.scope,skillId:item.id,snapshotId:read.snapshot_id,readBytes:Buffer.byteLength(read.content),exportBytes:Buffer.byteLength(body)}};
}
async function scriptedProvider(directory) {
 const path=await writeFakeProvider(directory);let source=await readFile(path,'utf8');
 source=source.replace('import { appendFileSync }','import { appendFileSync, readFileSync }');
 source=source.replace('const output = {',`const plan=process.env.BROKER_NOTION_TOOL_PLAN?JSON.parse(readFileSync(process.env.BROKER_NOTION_TOOL_PLAN,'utf8')):null;
  const lastUser=[...context.messages].reverse().find(m=>m.role==='user');
  const requested=plan&&lastUser&&JSON.stringify(lastUser).includes(plan.trigger);
  const completed=context.messages.some(m=>m.role==='toolResult'&&m.toolCallId===plan?.id);
  const call=requested&&!completed?{type:'toolCall',id:plan.id,name:'read',arguments:{path:plan.path}}:null;
  const output = {`);
 source=source.replace('content: [{ type: "text", text: "OK" }]','content: call ? [call] : [{ type: "text", text: "OK" }]');
 source=source.replace('stopReason: "stop"','stopReason: call ? "toolUse" : "stop"');
 source=source.replace('for (const event of events) yield event;',`if(call){yield {type:'start',partial:output};yield {type:'toolcall_start',contentIndex:0,partial:output};yield {type:'toolcall_end',contentIndex:0,toolCall:call,partial:output};yield {type:'done',reason:'toolUse',message:output};}else for (const event of events) yield event;`);
 await writeFile(path,source);return path;
}
async function hostRun(host,context) {
 const {scratch,evidence,fixture,extension}=context;const namespace=fixture.namespace??'notion';const label=namespace==='notion'?host:host+'-'+namespace;const base=join(scratch,label);await mkdir(base,{recursive:true});const agentDir=join(base,'agent');await mkdir(join(agentDir,'context-broker'),{recursive:true});const sessions=join(base,'sessions');await mkdir(sessions);
 const source=fixture.source??{type:'notion',id:'notion',namespace:'notion',command:fixture.command,database:options.database??fixtureDatabase,cacheDir:join(base,'source-cache'),requestTimeoutMs:fixture.live?30000:1500};const config=join(agentDir,'context-broker','config.yml');await writeFile(config,JSON.stringify({sources:[source]}));
 const selection=source.type==='notion'?`${fixture.alias}@${namespace}`:`${namespace}/${fixture.alias}`;
 const provider=await scriptedProvider(base);const providerFile=join(evidence,label+'-provider.jsonl');const plan=join(base,'tool-plan.json');await save(plan,{trigger:'NEVER',id:'notion-read-1',path:'/nonexistent'});
 const env=isolatedEnv({base,agentDir,CONTEXT_BROKER_HOST:host,CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE:providerFile,CONTEXT_BROKER_LOG_FILE:join(evidence,label+'-decisions.jsonl'),BROKER_NOTION_TOOL_PLAN:plan});
 if(['live','live-fixture','model'].includes(mode)) {
  // Authentication is the only inherited CLI boundary; mutable roots remain owned.
  for(const key of ['NOTION_API_TOKEN','NTN_API_TOKEN']) if(process.env[key])env[key]=process.env[key];
  env.HOME=process.env.HOME;
  delete env.NTN_SKILLS_NTN_BIN;
 }
 const args=['--no-extensions','--session-dir',sessions,'--tools','read','-e',provider,'-e',extension,'--model','context-broker-e2e/fake',...(host==='omp'?['--no-title','--no-rules']:[])];
 let rpc;const observations=[];try {
  rpc=await startRpc({host,cwd:base,env,args});await rpc.prompt('Describe available ledger skill names without opening a file.');let captures=await rows(providerFile);assert.ok(captures.length);const initial=JSON.stringify(captures[0].context);assert.ok(initial.includes(fixture.alias),'Default host catalog must advertise the remote alias');assert.equal(count(captures[0].context,fixture.marker),0,'Metadata must not contain skill body');
  const nativeName=(namespace+'-'+fixture.alias).replace(/[^a-z0-9-]/g,'-');
  const selected=nativeEntries(host,captures[0].context).find(skill=>skill.name===nativeName);
  const location=selected?.filePath;assert.ok(location,'Host skill catalog must expose the selected native read entry');observations.push('metadata-only default host catalog');
  if(fixture.setScenario){
   for(const scenario of ['denied','malformed','timeout']){
    await fixture.setScenario(scenario);const before=(await rows(providerFile)).length;let failure;
    try{await rpc.prompt(`/skill:${nativeName}`);}catch(error){failure=error.message;}
    assert.equal((await rows(providerFile)).length,before,`${scenario} activation must block provider invocation`);
    observations.push({scenario,providerRequests:0,reportedFailure:failure??'host handled blocked command'});
   }
   await fixture.setScenario('normal');
  }
  await save(plan,{trigger:'OPEN_LEDGER_RESOURCE',id:'notion-read-1',path:location});await rpc.prompt('OPEN_LEDGER_RESOURCE: read the available ledger skill instructions.');captures=await rows(providerFile);assert.ok(captures.some(row=>JSON.stringify(row.context.messages).includes(fixture.marker)),'Real native read tool must return full source body');observations.push('cold native read activation');
  await save(join(evidence,label+'-cold-read-rpc.json'),rpc.frames);await rpc.stop();rpc=undefined;
  rpc=await startRpc({host,cwd:base,env,args});
  const nativeBefore=(await rows(providerFile)).length;
  const nativeArguments=`$${selection} NATIVE_ARGUMENT_FIRST NATIVE_ARGUMENT_SECOND`;
  await rpc.prompt(`/skill:${nativeName}${host==='pi'?'\t':' '}${nativeArguments}`);
  captures=await rows(providerFile);
  assert.ok(captures.length>nativeBefore,'Cold native skill must invoke the provider');
  assert.equal(count(captures.at(-1).context.messages,fixture.marker),1,'Native and same-selection dollar in one submission must deliver one body');
  assert.ok(JSON.stringify(captures.at(-1).context.messages).includes(nativeArguments),'Cold native arguments must reach the provider without losing the first word');
  observations.push('cold native /skill with same-selection dollar and preserved arguments');
  if(host==='pi')for(const separator of ['\t','\n']){
   const argument=`NATIVE_${separator==='\t'?'TAB':'NEWLINE'}_FIRST NATIVE_ARGUMENT_SECOND`;
   await rpc.prompt(`/skill:${nativeName}${separator}${argument}`);
   captures=await rows(providerFile);
   const latestUser=[...captures.at(-1).context.messages].reverse().find(message=>message.role==='user');
   assert.ok(JSON.stringify(latestUser).includes(argument),'Warm native arguments must preserve all words after any whitespace separator');
   assert.equal(count(captures.at(-1).context.messages,fixture.marker),1,'Warm native arguments must retain one selected body');
  }
  await rpc.prompt(`$${selection} Reuse the native skill instructions.`);captures=await rows(providerFile);assert.equal(count(captures.at(-1).context.messages,fixture.marker),1,'Dollar after native skill must retain exactly one source body');observations.push('native-to-dollar retains one body');
  await save(join(evidence,label+'-cold-native-rpc.json'),rpc.frames);await rpc.stop();rpc=undefined;
  const printCapture=join(evidence,label+'-cold-print-provider.jsonl');await runCommand(host,['-p',...args,`/skill:${nativeName}`],{cwd:base,env:{...env,CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE:printCapture}});const printRows=await rows(printCapture);assert.ok(printRows.some(row=>count(row.context.messages,fixture.marker)===1),'Cold print native command must load exactly one selected skill body');observations.push('cold print native /skill');
  rpc=await startRpc({host,cwd:base,env,args});
  await rpc.prompt(`$${selection} Apply the ledger contract.`);let dollarCaptures=await rows(providerFile);const firstCount=count(dollarCaptures.at(-1).context.messages,fixture.marker);assert.equal(firstCount,1,'Cold dollar must inject exactly one body');await rpc.prompt(`$${selection} Apply it once more.`);captures=await rows(providerFile);assert.equal(count(captures.at(-1).context.messages,fixture.marker),1,'Warm dollar must retain one body');observations.push('cold dollar activation and warm repeat');
  await rpc.prompt(`/skill:${nativeName}`);captures=await rows(providerFile);assert.equal(count(captures.at(-1).context.messages,fixture.marker),1,'Native skill after dollar must retain exactly one source body');observations.push('dollar-to-native retains one body');
  if(fixture.resourceCanary){await save(plan,{trigger:'OPEN_LINKED_LEDGER',id:'notion-resource-2',path:join(dirname(location),fixture.resourcePath??'references/ledger.md')});await rpc.prompt('OPEN_LINKED_LEDGER: read the linked ledger resource.');captures=await rows(providerFile);assert.ok(JSON.stringify(captures.at(-1).context.messages).includes(fixture.resourceCanary),'Real host read must return linked resource bytes');observations.push('native resource read');}
  await save(join(evidence,label+'-rpc.json'),rpc.frames);await rpc.stop();rpc=undefined;
  const continueBefore=(await rows(providerFile)).length;
  const continueTask=`$${selection} Continue using this skill.`;
  await runCommand(host,['-p',...args,'--continue',continueTask],{cwd:base,env});
  const continued=(await rows(providerFile)).slice(continueBefore);
  assert.ok(continued.length,'Persisted continuation must invoke the provider');
  assert.equal(count(continued.at(-1).context.messages,fixture.marker),1,'Persisted continuation must retain exactly one complete selected body');
  const continuedUser=[...continued.at(-1).context.messages].reverse().find(message=>message.role==='user');
  assert.ok(JSON.stringify(continuedUser).includes('Continue using this skill.'),'Persisted continuation must deliver the current user task');
  observations.push('persisted continuation with one selected body');
  if(fixture.setScenario){
   await fixture.setScenario('duplicates');const duplicateBase=join(base,'duplicates');await mkdir(duplicateBase);const duplicateCapture=join(evidence,label+'-duplicates-provider.jsonl');const duplicateEnv={...env,CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE:duplicateCapture};
   rpc=await startRpc({host,cwd:base,env:duplicateEnv,args:[...args,'--session-dir',duplicateBase]});await rpc.prompt('List available skill names only.');const catalog=(await rows(duplicateCapture))[0].context;
   const entries=nativeEntries(host,catalog);
   const selectedPages=entries.filter(entry=>entry.name.startsWith(nativeName+'-'));assert.equal(selectedPages.length,2,'Same alias pages must retain two qualified native names');assert.equal(count(catalog,fixture.marker),0);
   const before=(await rows(duplicateCapture)).length;await rpc.prompt(`$${fixture.alias}@${namespace} Apply this skill.`);assert.equal((await rows(duplicateCapture)).length,before,'Ambiguous alias must block provider request');
   for(const entry of selectedPages){const start=(await rows(duplicateCapture)).length;await rpc.prompt(`/skill:${entry.name}`);const contexts=(await rows(duplicateCapture)).slice(start);const expected=entry.filePath.includes('22222222')?secondCanary:fixture.marker;assert.ok(contexts.some(row=>JSON.stringify(row.context.messages).includes(expected)),'Qualified native page must load its own distinct body');}
   await save(join(evidence,label+'-duplicates-rpc.json'),rpc.frames);await rpc.stop();rpc=undefined;await fixture.setScenario('normal');observations.push('ambiguous alias blocked and two qualified pages selected');
  }
  if(fixture.callsPath){const calls=await rows(fixture.callsPath);assert.ok(calls.some(c=>c.command==='export'));}
  return {host,namespace,observations,providerRequests:(await rows(providerFile)).length,files:[label+'-provider.jsonl',label+'-decisions.jsonl',label+'-rpc.json',label+'-cold-read-rpc.json',label+'-cold-native-rpc.json',label+'-cold-print-provider.jsonl']};
 } finally {if(rpc){await save(join(evidence,label+'-rpc.json'),rpc.frames);await rpc.stop();}}
}
async function ownedExits(directory) {
 const events=await rows(join(directory,'owned-processes.jsonl'));
 const spawned=events.filter(row=>row.event==='spawn');
 const pending=spawned.filter(row=>!events.some(end=>end.event==='close'&&end.pid===row.pid&&end.observedExit));
 return {spawned:spawned.length,observedExits:spawned.length-pending.length,pending};
}
async function evidenceCheck(directory){
 assert.ok(isAbsolute(directory??''),'--evidence must be absolute');const manifest=await json(join(directory,'manifest.json'));const missing=[];
 for(const file of manifest.files)try{await access(join(directory,file));}catch{missing.push(file);}
 let extensionReadback='not-selected';
 if(manifest.extension){
  assert.deepEqual(manifest.extension,manifest.doctor.extension,'Doctor must identify the consumed extension');
  assert.deepEqual(manifest.extension,manifest.extensionReadback,'Consumed extension readback must match its manifest');
  try{await verifyEntryIdentity(manifest.extension.path,manifest.extension);extensionReadback='matched-current-bytes';}
  catch(error){if(error.code!=='ENOENT')throw error;extensionReadback='retained-readback; entry no longer present';}
 }
 return {status:missing.length?'incomplete':'preserved',functionalStatus:manifest.status,directory,mode:manifest.mode,branches:manifest.branches,extension:manifest.extension,extensionReadback,missing};
}
if(action==='doctor'){const value=await doctor();console.log(JSON.stringify(value,null,2));if(value.status!=='ready')process.exitCode=1;}
else if(action==='evidence')console.log(JSON.stringify(await evidenceCheck(options.evidence),null,2));
else if(action==='cleanup'){
 const directory=options.evidence;assert.ok(isAbsolute(directory??''));
 const processes=await ownedExits(directory);assert.equal(processes.pending.length,0,'Owned host close evidence missing; do not trash active scratch');
 const manifest=await json(join(directory,'manifest.json'));const scratch=await realpath(manifest.scratch);
 assert.ok(dirname(scratch)===await systemTempRoot()&&scratch.split('/').at(-1).startsWith('broker-notion-scratch-'),'Refuse non-owned scratch');
 assert.equal((await json(join(scratch,'ownership.json'))).evidence,directory);
 const result=await capture(await executable('/usr/bin/trash'),[scratch]);assert.equal(result.code,0,'Trash failed');
 await save(join(directory,'cleanup.json'),{scratch,status:'trashed',processes,evidencePreserved:true});console.log(JSON.stringify({status:'cleaned',evidence:directory}));
}
else {
 const report=await doctor();if(report.status!=='ready'){console.log(JSON.stringify(report,null,2));process.exitCode=1;}else{
  const temporaryRoot=await systemTempRoot();const evidence=await mkdtemp(join(await evidenceRoot(options['evidence-root'],temporaryRoot),'broker-notion-evidence-'));const scratch=await mkdtemp(join(temporaryRoot,'broker-notion-scratch-'));await save(join(scratch,'ownership.json'),{evidence});const manifest={mode,defaultContext,status:'running',scratch,temporaryRoot,doctor:report,branches:[],files:[],notRun:['native UI (separate --notion runner)', ...['pi','omp'].map(host=>`${host} real model`)]};console.log(`Notion integration evidence retained: ${evidence}`);
  process.env.BROKER_E2E_PROCESS_LEDGER=join(evidence,'owned-processes.jsonl');
  await writeFile(process.env.BROKER_E2E_PROCESS_LEDGER,'');
  manifest.files.push('owned-processes.jsonl');
  if(['live','live-fixture','model'].includes(mode)){await writeFile(join(evidence,'command-receipts.jsonl'),'');manifest.files.push('command-receipts.jsonl');}
  Object.assign(process.env, {
   TMPDIR:temporaryRoot,
   NTN_SKILLS_CONFIG_HOME:join(scratch,'cli','config'),NTN_SKILLS_HOME:join(scratch,'cli','state'),NTN_SKILLS_CACHE_HOME:join(scratch,'cli','cache'),NTN_SKILLS_DATA_HOME:join(scratch,'cli','data'),
   XDG_CONFIG_HOME:join(scratch,'xdg','config'),XDG_STATE_HOME:join(scratch,'xdg','state'),XDG_CACHE_HOME:join(scratch,'xdg','cache'),XDG_DATA_HOME:join(scratch,'xdg','data'),
  });
  delete process.env.NTN_SKILLS_NTN_BIN;
  manifest.isolation={cliConfig:process.env.NTN_SKILLS_CONFIG_HOME,cliState:process.env.NTN_SKILLS_HOME,cliCache:process.env.NTN_SKILLS_CACHE_HOME,cliData:process.env.NTN_SKILLS_DATA_HOME,authentication:'Inherited token or official ntn login in HOME; no credentials copied'};
  let ownedLive;
  let requestLedger;
  try{
   await save(join(evidence,'manifest.json'),manifest);
   if(consumerIsolation&&options['upstream-database']){await mkdir(process.env.NTN_SKILLS_CONFIG_HOME,{recursive:true,mode:0o700});await save(join(process.env.NTN_SKILLS_CONFIG_HOME,'config.json'),{upstream_database:options['upstream-database']});manifest.isolation.upstreamDatabase=options['upstream-database'];}
   if((defaultContext||cacheLifecycle)&&mode==='live-fixture'){const ntn=await executable(process.env.NTN_SKILLS_NTN_BIN??'ntn');requestLedger=await createRequestLedger({scratch,evidence,command:command(),ntnCommand:[ntn.file,...ntn.prefix]});}
   if(mode==='live-fixture'){ownedLive=await createLiveFixture({scratch,evidence,command:requestLedger?.command??command(),ntnCommand:requestLedger?.ntnCommand,database:options.database,resumeEvidence:options['resume-evidence'],onOwned:fixture=>{ownedLive=fixture;}});options['skill-ref']=ownedLive.skillRef;manifest.files.push('live-fixture-intent.json','live-fixture-create.json','live-fixture-cleanup.json','live-fixture-schema.json','live-fixture-default-context.json');if(options['resume-evidence']){manifest.files=manifest.files.filter(file=>file!=='live-fixture-intent.json');manifest.files.push('live-fixture-recovery.json');}}
   let fixture;
   if(cacheLifecycle)fixture={...ownedLive,command:requestLedger.command,live:{owned:true}};
   else {fixture=await createNotionFixture(join(scratch,'fixture'));fixture.marker=fixture.canary;if(['live','live-fixture','model'].includes(mode))fixture={...await sourceLive(scratch,{metadataOnly:defaultContext,commandOverride:requestLedger?.command,evidence}),...(ownedLive?{marker:ownedLive.canary,resourceCanary:ownedLive.resourceCanary,resourcePath:ownedLive.resourcePath,setDefaultContext:ownedLive.setDefaultContext}: {})};}
   if(defaultContext){requestLedger??=await createRequestLedger({scratch,evidence,command:fixture.command});fixture.command=requestLedger.command;manifest.files.push('safe-source-requests.jsonl');}
   let extension=options.extension??join(root,'packages/context-broker/src/index.ts');
   if(mode==='installed'){const installed=join(scratch,'installed');await mkdir(installed);const result=await capture(await executable('npm'),['install','--workspaces=false','--prefix',installed,'--omit=dev','--no-audit','--no-fund',options.package],{cwd:scratch,timeout:120000});assert.equal(result.code,0,'Package installation failed');const packageMeta=JSON.parse((await capture('tar',['-xOf',options.package,'package/package.json'],{cwd:scratch})).stdout);const packageRoot=join(installed,'node_modules',packageMeta.name);const ext=packageMeta.pi?.extensions?.[0]??packageMeta.omp?.extensions?.[0];assert.ok(ext,'Installed package must declare its extension');extension=resolve(packageRoot,ext);await access(extension);}
   const consumedEntry=await entryIdentity(extension);extension=consumedEntry.path;report.extension=consumedEntry;manifest.extension=consumedEntry;
   manifest.extensionReadback=await verifyEntryIdentity(extension,manifest.extension);
   await save(join(evidence,'manifest.json'),manifest);
   if(viewDiscovery)for(const host of ['pi','omp'])manifest.branches.push(await runViewDiscovery({host,scratch,evidence,fixture,extension,scriptedProvider}));
   else if(sharedCatalog)manifest.branches.push(await runSharedCatalog({scratch,evidence,fixture,extension,scriptedProvider}));
   else if(cacheLifecycle){manifest.files.push('cache-lifecycle-result.json');manifest.branches.push(await runCacheLifecycle({root,scratch,evidence,fixture,extension,database:options.database,command:command(),scriptedProvider}));manifest.notRun=manifest.notRun.filter(item=>!item.startsWith('native UI'));}
   else if(mode==='model'){const branches=consumerIsolation?await Promise.all(modelHosts.map(host=>runConsumerModel(host,{root,scratch,evidence,fixture,options,extension}))):await runNotionModel({root,scratch,evidence,fixture,options,extension});manifest.branches.push(...branches);for(const branch of branches)manifest.files.push(...(branch.files??[]));assert.ok(branches.every(branch=>branch.status==='passed'),'Consumer model verification failed; see retained per-host results');}
   else for(const host of ['pi','omp'])manifest.branches.push(defaultContext?await runDefaultContext({host,root,scratch,evidence,fixture,extension,database:options.database,ledger:requestLedger.ledger,scriptedProvider}):await hostRun(host,{scratch,evidence,fixture,extension}));
   if(['deterministic','installed'].includes(mode)&&!sharedCatalog&&!viewDiscovery){
    if(defaultContext)await fixture.setScenario('normal');
    const filesystemRoot=join(scratch,'filesystem-source');await mkdir(join(filesystemRoot,'ui-alpha','references'),{recursive:true});const marker='FILESYSTEM_SOURCE_BODY_61C9';const resourceCanary='FILESYSTEM_SOURCE_RESOURCE_61C9';await writeFile(join(filesystemRoot,'ui-alpha','SKILL.md'),`---\nname: ui-alpha\ndescription: Filesystem ledger verification\n---\n${marker}\nRead references/ledger.md\n`);await writeFile(join(filesystemRoot,'ui-alpha','references','ledger.md'),resourceCanary+'\n');const localFixture={namespace:'fs',alias:'ui-alpha',marker,resourceCanary,source:{type:'filesystem',id:'fs',namespace:'fs',roots:[filesystemRoot],requireAutoload:false}};
    for(const host of ['pi','omp'])manifest.branches.push(await hostRun(host,{scratch,evidence,fixture:localFixture,extension}));
    manifest.branches.push(await runSourceLifecycle({root,scratch,evidence,fixture,extension}));
   }
   if(mode==='live-fixture'&&options.model){assert.ok(options['model-prompt'],'--model-prompt required with --model');const branches=await runNotionModel({root,scratch,evidence,fixture,options,extension});manifest.branches.push(...branches);for(const branch of branches)manifest.files.push(...(branch.files??[]));}
   if(fixture.live)manifest.live=fixture.live;else{await writeFile(join(evidence,'source-cli-calls.jsonl'),await readFile(fixture.callsPath));manifest.files.push('source-cli-calls.jsonl');}
   for(const branch of manifest.branches)manifest.files.push(...(branch.files??[]));manifest.files=[...new Set(manifest.files)];manifest.status='passed';
  }catch(error){if(error.results)manifest.branches.push(...error.results);manifest.status='failed';manifest.error=error.message;process.exitCode=1;}finally{for(const branch of manifest.branches){manifest.files.push(...(branch.files??[]));if(branch.mode==='model')manifest.notRun=manifest.notRun.filter(item=>item!==`${branch.host} real model`);}manifest.files=[...new Set(manifest.files)];if(ownedLive)try{await ownedLive.archive();}catch(error){manifest.status='failed';manifest.cleanupError=error.message;process.exitCode=1;}manifest.finishedAt=new Date().toISOString();await save(join(evidence,'manifest.json'),manifest);console.log(JSON.stringify({status:manifest.status,evidence,error:manifest.error,cleanupError:manifest.cleanupError},null,2));}
 }
}
