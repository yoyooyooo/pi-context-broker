#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { resolveHost, runCommand } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { createRequestLedger } from './notion-default-context.mjs';
import { systemTempRoot, evidenceRoot, verificationCliEnvironment } from './verification-paths.mjs';
import { safeDiagnostic } from './verification-command.mjs';
import { consumptionCostExtensionSource, readConsumptionCostEvents, consumptionMetricStats } from './skill-consumption-cost.mjs';
import { providerTransportExtensionSource, readProviderTransport } from './skill-consumption-provider.mjs';
import { sourceObserverPreloadSource, readSourceObservation } from './skill-consumption-source-observer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const rows = async path => { try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const usage = 'Usage: node scripts/skill-consumption-model-baseline.mjs doctor|run --config ABSOLUTE_JSON [--evidence-root ABSOLUTE_DIR]; evidence|cleanup --evidence ABSOLUTE_DIR. Real model is restricted to magpie/group/flash-free. Read-only source, normal Pi tools, no generated task guidance or forced tool choices. Config: {version:1,extension,transport?:"cli"|"sdk",command?:[absoluteNode,absoluteCLI],database,prompt,expectedAnswers:[string],counts:{cold:5,warm:20},packagePath?,toolProfile?:"standard"|"native-skills"}. Standard preserves the original seven tools; native-skills adds skill_search/skill_prepare/skill_graph without removing normal tools. Missing transport preserves legacy CLI mode and requires command. Explicit sdk forbids command and observes the unchanged default bundled source through a Node preload. Cold=new isolated process/cache; warm=ordinary turns in the final cold process, with existing session context retained. All attempts and unrun planned samples remain recorded.';

async function tree(directory) {
  const output = {};
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const next = join(path, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'Runtime tree must not contain symlinks');
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) output[relative(directory, next)] = hash(await readFile(next));
    }
  }
  await walk(directory); return { files: output, sha256: hash(JSON.stringify(output)) };
}
export function validateModelBaselineConfig(config) {
  assert.equal(config.version, 1);
  assert.ok(Object.keys(config).every(key => ['version','extension','transport','command','database','prompt','expectedAnswers','counts','packagePath','toolProfile'].includes(key)));
  assert.ok(isAbsolute(config.extension));
  assert.ok(config.transport === undefined || ['cli','sdk'].includes(config.transport));
  if(config.transport==='sdk') assert.equal(Object.hasOwn(config,'command'),false,'SDK mode must omit command, not wrap the default source');
  else assert.ok(Array.isArray(config.command) && config.command.length === 2 && config.command.every(isAbsolute));
  assert.match(config.database, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  assert.ok(typeof config.prompt === 'string' && config.prompt.trim() && Array.isArray(config.expectedAnswers) && config.expectedAnswers.length
    && config.expectedAnswers.every(value => typeof value === 'string' && value.trim()));
  assert.ok(['cold','warm'].every(key => Number.isSafeInteger(config.counts?.[key]) && config.counts[key] >= 1 && config.counts[key] <= 20));
  modelBaselineTools(config);
  return config;
}
export function modelBaselineTools(config) {
  const profile=config.toolProfile===undefined?'standard':config.toolProfile;
  assert.ok(['standard','native-skills'].includes(profile),'Unsupported model tool profile');
  const tools=['read','bash','edit','write','grep','find','ls'];
  return profile==='native-skills'?[...tools,'skill_search','skill_prepare','skill_graph']:tools;
}
async function configAt(path) {
  assert.ok(isAbsolute(path ?? ''), 'Config path must be absolute');
  return validateModelBaselineConfig(JSON.parse(await readFile(path, 'utf8')));
}
export function modelBaselineSource(config, { cacheDir, command } = {}) {
  const source={id:'notion',namespace:'notion',type:'notion',database:config.database,prefetch:false,cacheDir};
  if(config.transport==='sdk') {
    assert.equal(Object.hasOwn(config,'command'),false,'SDK mode must omit command');
    assert.equal(command,undefined,'SDK mode must not install a source wrapper');
    return source;
  }
  assert.ok(Array.isArray(command)&&command.length>0,'Legacy CLI mode requires its explicit ledger command');
  return {...source,command};
}
async function bundledRuntimeAt(extension) {
  const locate=async name=>{
    for(const path of [join(dirname(extension),name),resolve(dirname(extension),'../dist',name)]) {
      try { await access(path); return {path:await realpath(path),sha256:hash(await readFile(path))}; }
      catch(error) { if(error.code!=='ENOENT')throw error; }
    }
    throw new Error('Bundled runtime artifact missing: '+name);
  };
  const cli=await locate('ntn-skills.mjs'),sdk=await locate('ntn-skills-sdk.mjs');
  const manifestPath=join(dirname(sdk.path),'ntn-skills-runtime.json'),manifestBytes=await readFile(manifestPath);
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.version,1);assert.equal(manifest.package,'ntn-skills');assert.equal(manifest.sdk_version,1);assert.equal(manifest.consumer_contract_version,1);
  return {cli,sdk,manifest:{path:await realpath(manifestPath),sha256:hash(manifestBytes),packageVersion:manifest.package_version}};
}
async function doctor(config) {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24 && !process.versions.bun, 'Use supported Node runtime');
  const host = await resolveHost('pi');
  const version = await runCommand('pi', ['--version'], { cwd: root, env: process.env, timeoutMs: 10000 });
  if(config.transport!=='sdk')for (const path of config.command) await access(path);
  const bundledRuntime=config.transport==='sdk'?await bundledRuntimeAt(config.extension):null;
  const runtime = await tree(dirname(config.extension));
  return { status:'ready', node:process.versions.node, pi:version.stdout.trim(), piIdentity:host.identity,
    piSha256:hash(await readFile(host.identity)), runtime, extension:config.extension,
    sourceTransport:config.transport??'cli',bundledRuntime,
    cliSha256:bundledRuntime?.cli.sha256??hash(await readFile(config.command[1])),
    packageSha256:config.packagePath ? hash(await readFile(config.packagePath)) : null,
    model:'magpie/group/flash-free',toolProfile:config.toolProfile??'standard',tools:modelBaselineTools(config), authentication:'not-probed' };
}
function textOf(frame) {
  const message = [...(frame?.messages ?? [])].reverse().find(message => message.role === 'assistant');
  return { text: (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'), stopReason:message?.stopReason };
}
export function verifyModelAnswer(answer, expectedAnswers) {
  if (answer?.stopReason !== 'stop' || typeof answer.text !== 'string' || !answer.text.trim()) return false;
  const permissionOnly = answer.text.length < 1200 && /(?:please\s+(?:approve|authorize|confirm)|(?:need|require|await)\w*\s+(?:your\s+)?(?:approval|permission)|(?:请|需要|等待).{0,15}(?:授权|批准|确认))/iu.test(answer.text);
  return !permissionOnly && expectedAnswers.some(value => answer.text.includes(value));
}
function summarizeTurn(sample, events, transport) {
  const selected = events.filter(event => event.turn === sample.turn);
  const requests = selected.filter(event => event.phase === 'provider_request');
  const assistants = selected.filter(event => event.phase === 'message_end' && event.message?.role === 'assistant');
  const firstText = selected.find(event => event.phase === 'message_update' && event.firstEffectiveText);
  const elapsed = event => event ? Number(BigInt(event.monotonicNs) - BigInt(sample.submitNs)) / 1e6 : null;
  const add = values => values.length && values.every(value => typeof value === 'number' && Number.isFinite(value)) ? values.reduce((a,b) => a+b,0) : null;
  const active = transport.filter(event => event.phase === 'request_start' && event.category === 'model' && BigInt(event.monotonicNs) >= BigInt(sample.submitNs)
    && BigInt(event.monotonicNs) <= BigInt(sample.completeNs));
  const ids = new Set(active.map(event => event.id));
  const sent = transport.filter(event => event.phase === 'request_sent' && ids.has(event.id));
  const completed = transport.filter(event => event.phase === 'request_end' && ids.has(event.id));
  const payloadsMatch = requests.length > 0 && requests.every(event => sent.some(request => request.requestBodySha256 === event.payload.sha256));
  return { ...sample, observedProviderHooks:requests.length, toolCalls:selected.filter(event => event.phase === 'tool_call').length,
    toolRounds:new Set(selected.filter(event => event.phase === 'tool_call').map(event => event.request)).size,
    providerPayloadJsonBytes:add(requests.map(event => event.payload.bytes)), firstProviderPayloadJsonBytes:requests[0]?.payload.bytes ?? null,
    reportedUsage:Object.fromEntries(['input','output','cacheRead','cacheWrite','totalTokens'].map(key => [key,add(assistants.map(event => event.message.usage[key]))])),
    submitToFirstProviderMs:elapsed(requests[0]), submitToFirstModelHttpMs:elapsed(active[0]), submitToFirstEffectiveTextMs:elapsed(firstText),
    submitToCompletionMs:Number(BigInt(sample.completeNs)-BigInt(sample.submitNs))/1e6,
    modelHttp:{ attempts:active.length, completed:completed.length, successful:completed.filter(event => event.status >= 200 && event.status < 300 && event.outcome === 'completed').length,
      requestBodyBytes:add(sent.map(event => event.requestBodyBytes)), responseEntityBytes:add(completed.map(event => event.responseEntityBytes)),
      decodedResponseBytes:add(completed.map(event => event.decodedResponseBytes)), payloadHashesMatchObservedRequests:payloadsMatch,
      method:'Node Undici diagnostics; HTTP entity chunks, not TCP/TLS wire', retryWaitMs:null, queueWaitMs:null, wireBytes:null },
    observationComplete:events.at(-1)?.phase === 'observer_end' && events.at(-1)?.complete === true
      && transport.at(-1)?.complete === true && transport.at(-1)?.selectedModel === hash('magpie/group/flash-free')
      && payloadsMatch && active.length === completed.length };
}
export function summarizeSource(ledger, { beforeCloseRequestIds, beforeCloseChildIds, ownedLifecycle = [], transport = 'cli', sourceObservation } = {}) {
  const starts=ledger.filter(row=>row.phase==='started'), ends=ledger.filter(row=>row.phase==='completed');
  const metrics=ledger.filter(row=>row.phase==='metrics'), attempts=ledger.filter(row=>row.phase==='attempt'), waits=ledger.filter(row=>row.phase==='wait');
  const ids=starts.map(row=>row.requestId), hostStarts=ownedLifecycle.filter(row=>row.event==='spawn'), hostEnds=ownedLifecycle.filter(row=>row.event==='close');
  const hostClosed=hostStarts.length>0&&hostStarts.every(row=>hostEnds.filter(end=>end.pid===row.pid&&end.observedExit===true).length===1)
    &&hostEnds.length===hostStarts.length;
  const boundaryObserved=Array.isArray(beforeCloseRequestIds);
  const lateStarts=boundaryObserved?ids.filter(id=>!beforeCloseRequestIds.includes(id)):null;
  const sdkStarts=starts.filter(row=>row.kind==='sdk'),sdkEnds=ends.filter(row=>row.kind==='sdk');
  const cliStarts=starts.filter(row=>row.kind!=='sdk'),cliEnds=ends.filter(row=>row.kind!=='sdk');
  const unmatchedStarts=ledger.filter(row=>row.phase==='unmatched_child_start'),unmatchedChildren=unmatchedStarts.length;
  const lateChildStarts=Array.isArray(beforeCloseChildIds)?unmatchedStarts.map(row=>row.childId).filter(id=>!beforeCloseChildIds.includes(id)):null;
  const complete=starts.length>0&&new Set(ids).size===ids.length&&boundaryObserved&&lateStarts.length===0&&hostClosed
    &&(transport!=='sdk'||sourceObservation?.complete===true&&unmatchedChildren===0)
    &&starts.every(row=>ends.filter(end=>end.requestId===row.requestId).length===1
      &&metrics.filter(metric=>metric.requestId===row.requestId&&metric.observed&&metric.complete).length===1)
    &&ends.length===starts.length&&metrics.length===starts.length;
  const add=values=>values.every(value=>typeof value==='number'&&Number.isFinite(value))?values.reduce((a,b)=>a+b,0):null;
  return {complete,transport,cliStarts:cliStarts.length,cliCloses:cliEnds.length,sdkStarts:sdkStarts.length,sdkCloses:sdkEnds.length,
    cliSpawnEvents:ledger.filter(row=>row.phase==='child-started').length,sdkEntered:sdkEnds.filter(row=>row.sdkStarted===true).length,
    operationStarts:starts.length,operationCloses:ends.length,unmatchedChildren,
    unmatchedChildLifecycle:sourceObservation?.unmatchedChildLifecycle??null,lateChildStarts,
    sourceObserverComplete:transport==='sdk'?sourceObservation?.complete===true:null,
    sourceObserverErrors:transport==='sdk'?(sourceObservation?.errors??['missing-observer']):[],
    httpAttempts:complete?attempts.length:null,observedHttpAttempts:attempts.length,
    sourceObserved:starts.length>0,hostClosed,beforeCloseBoundaryObserved:boundaryObserved,lateStarts,
    completenessScope:'observed source operations through final ledger reconciliation; quiet is not a metadata-producer terminal receipt',
    requestKinds:Object.fromEntries(['notion_metadata','notion_body','notion_write','provider'].map(kind=>[kind,complete?attempts.filter(row=>row.request_kind===kind).length:null])),
    requestBodyBytes:complete?add(attempts.map(row=>row.request_bytes)):null,decodedResponseBytes:complete?add(attempts.map(row=>row.response_bytes)):null,
    queueWaitMs:complete?add(waits.filter(row=>row.wait_kind==='queue').map(row=>row.milliseconds)):null,
    retryWaitMs:complete?add(waits.filter(row=>row.wait_kind==='retry').map(row=>row.milliseconds)):null,
    wireBytes:null,method:transport==='sdk'?'public SDK diagnostics and unchanged direct bundled CLI stdout request_metrics; includes observed source work after model completion'
      :'project request_metrics; includes observed source work after model completion'};
}
async function sourceRows(path,transport,final=false) {
  return transport==='sdk'?readSourceObservation(path,{final}):{events:await rows(path),complete:null,errors:[]};
}
export async function settleSource(path,transport='cli') {
  let last = -1, quietSince = process.hrtime.bigint();
  const started = process.hrtime.bigint();
  while (Number(process.hrtime.bigint()-started)/1e6 < 120000) {
    const observation=await sourceRows(path,transport),ledger=observation.events,pending=new Set(),pendingChildren=new Set();
    for (const row of ledger) { if (row.phase === 'started') pending.add(row.requestId); if (row.phase === 'completed') pending.delete(row.requestId); }
    const childStarts=ledger.filter(row=>row.phase==='unmatched_child_start');
    for (const row of ledger) {
      if (row.phase==='unmatched_child_start') pendingChildren.add(row.childId);
      if (row.phase==='unmatched_child_close') pendingChildren.delete(row.childId);
    }
    if (ledger.length !== last) { last=ledger.length; quietSince=process.hrtime.bigint(); }
    if (!pending.size&&!pendingChildren.size&&!(observation.errors?.length) && Number(process.hrtime.bigint()-quietSince)/1e6 >= 700) return {
      quiet:true, observed:ledger.some(row=>row.phase==='started'), rows:ledger.length,
      requestIds:ledger.filter(row=>row.phase==='started').map(row=>row.requestId),childIds:childStarts.map(row=>row.childId) };
    await sleep(50);
  }
  return { quiet:false, observed:false, rows:(await sourceRows(path,transport)).events.length, requestIds:[],childIds:[] };
}
async function run(config, parent) {
  const preflight = await doctor(config);
  const evidence = await mkdtemp(join(await evidenceRoot(parent, await systemTempRoot()), 'skill-model-cost-'));
  const scratch = await mkdtemp(join(await systemTempRoot(), 'skill-model-cost-scratch-'));
  const runId = randomUUID(), clockId = runId, planned = [
    ...Array.from({length:config.counts.cold},(_,i)=>({id:'cold-'+(i+1),cache:'cold',session:'new'})),
    ...Array.from({length:config.counts.warm},(_,i)=>({id:'warm-'+(i+1),cache:'warm',session:'existing'}))];
  const plan = { version:1, kind:'skill-consumption-model-baseline', runId, clockId, config, preflight,
    frozenAt:new Date().toISOString(), samples:planned, freshness:'unchanged production defaults; prefetch false',
    isolation:'disjoint production source/Broker caches; normal authentication only; no oracle preparation',
    warmCondition:'same process and existing session after final cold task; context history is retained and counted',
    answerPredicate:'normal stop, nonblank final text, no permission-only reply, and a frozen expected-answer substring; semantic correctness still requires review',
    earlyStop:'after first failed task/availability/owned-process failure; preserve remaining not-run entries',
    toolProfile:config.toolProfile??'standard',tools:modelBaselineTools(config), observer:'passive hooks plus Node Undici diagnostics',sourceTransport:config.transport??'cli',
    driverSha256:hash(await readFile(fileURLToPath(import.meta.url))),
    networkCondition:'same machine; run real service batches serially; ambient network is measured rather than controlled',
    observerSha256:hash(await readFile(join(root,'scripts/skill-consumption-cost.mjs'))),
    transportObserverSha256:hash(await readFile(join(root,'scripts/skill-consumption-provider.mjs'))),
    sourceObserverSha256:config.transport==='sdk'?hash(await readFile(join(root,'scripts/skill-consumption-source-observer.mjs'))):null };
  await save(join(evidence,'plan.json'),plan);
  await save(join(scratch,'owner.json'),{runId,evidence});
  await save(join(evidence,'ownership.json'),{runId,evidence,scratch,kind:plan.kind});
  const samples = [], processes = []; let stoppedReason;
  console.log(JSON.stringify({status:'running',evidence,planned:planned.length}));
  for (let processIndex=1;processIndex<=config.counts.cold;processIndex++) {
    if(stoppedReason) break;
    const id='process-'+processIndex, base=join(scratch,id), processEvidence=join(evidence,id);
    await mkdir(base,{recursive:true,mode:0o700}); await mkdir(processEvidence,{mode:0o700});
    const ledger=config.transport==='sdk'?{ledger:join(processEvidence,'safe-source-requests.jsonl')}
      :await createRequestLedger({scratch:base,evidence:processEvidence,command:config.command});
    const brokerConfig=join(base,'broker.json'), observation=join(processEvidence,'observer.jsonl'), network=join(processEvidence,'transport.jsonl');
    await save(brokerConfig,{pathMode:'hash',logPaths:false,sources:[modelBaselineSource(config,{command:ledger.command,cacheDir:join(base,'broker-cache')})]});
    const observer=join(base,'cost.mjs'), transport=join(base,'transport.mjs');
    await writeFile(observer,consumptionCostExtensionSource({output:observation,checkoutRoot:root,runId,sampleId:id,clockId}),{mode:0o600,flag:'wx'});
    await writeFile(transport,providerTransportExtensionSource({output:network,checkoutRoot:root,clockId}),{mode:0o600,flag:'wx'});
    const env=verificationCliEnvironment(join(base,'cli'));
    Object.assign(env,{CONTEXT_BROKER_CONFIG:brokerConfig,CONTEXT_BROKER_HOST:'pi',CONTEXT_BROKER_LOG_FILE:join(processEvidence,'broker.jsonl'),
      BROKER_E2E_PROCESS_LEDGER:join(processEvidence,'owned-processes.jsonl'),NTN_SKILLS_REQUEST_TRACE_LIMIT:'10000',PWD:base});
    for(const key of ['NODE_OPTIONS','CONTEXT_BROKER_ROOTS','OLDPWD','INIT_CWD']) delete env[key];
    if(config.transport==='sdk') {
      const preload=join(base,'source-observer.mjs');
      await writeFile(preload,sourceObserverPreloadSource({output:ledger.ledger,checkoutRoot:root,clockId,
        cliPath:preflight.bundledRuntime.cli.path,ownerEntry:preflight.piIdentity,ownerParentPid:process.pid}),{mode:0o600,flag:'wx'});
      env.NODE_OPTIONS='--import='+pathToFileURL(preload).href;
    }
    const args=['--no-extensions','--no-mcp','--no-context-files','--no-prompt-templates','--session-dir',join(base,'sessions'),
      '--tools',plan.tools.join(','),'-e',config.extension,'-e',transport,'-e',observer,'--model','magpie/group/flash-free'];
    let rpc, turn=0; const local=[]; const processResult={id,status:'running',observedSourcesQuiet:false,sourceTransport:config.transport??'cli'};
    try {
      rpc=await startRpc({host:'pi',cwd:base,env,args,timeoutMs:120000,waitForState:false});
      const tasks=[planned[processIndex-1],...(processIndex===config.counts.cold?planned.slice(config.counts.cold):[])];
      for(const task of tasks) {
        const sourceStartRow=(await sourceRows(ledger.ledger,config.transport)).events.length;
        const sample={...task,process:id,turn:++turn,status:'running',submitNs:process.hrtime.bigint().toString(),promptSha256:hash(config.prompt),sourceStartRow};
        try {
          const pending=rpc.prompt(config.prompt).then(frame=>({frame,completeNs:process.hrtime.bigint().toString()}),error=>({error,completeNs:process.hrtime.bigint().toString()}));
          await save(join(processEvidence,task.id+'-submission.json'),{...sample,prompt:config.prompt});
          const completed=await pending;sample.completeNs=completed.completeNs;if(completed.error)throw completed.error;
          const answer=textOf(completed.frame);
          sample.answerSha256=hash(answer.text); sample.answerBytes=Buffer.byteLength(answer.text); sample.stopReason=answer.stopReason;
          sample.taskVerified=verifyModelAnswer(answer,config.expectedAnswers);
          assert.ok(sample.taskVerified,'Successful final must answer the frozen task');
          sample.status='passed';
        } catch(error) {
          sample.completeNs??=process.hrtime.bigint().toString();sample.status='failed';sample.error=safeDiagnostic(Buffer.from(error.message));
          stoppedReason='A planned sample failed; no fallback, replacement or deletion';
        }
        sample.sourceEndRow=(await sourceRows(ledger.ledger,config.transport)).events.length;
        await save(join(processEvidence,task.id+'-outcome.json'),sample); local.push(sample);
        if(stoppedReason) break;
      }
      processResult.sourceBoundary=await settleSource(ledger.ledger,config.transport);
      processResult.observedSourcesQuiet=processResult.sourceBoundary.quiet&&processResult.sourceBoundary.observed;
      assert.ok(processResult.observedSourcesQuiet,'Source work is unobserved or still active; quiet alone is not a producer terminal');
      await rpc.closeInput(); processResult.status='closed';
    } catch(error) {
      processResult.status='failed';processResult.error=safeDiagnostic(Buffer.from(error.message));stoppedReason??='Owned process failed';
      if(rpc) try { await rpc.stop(); } catch {}
    } finally {
      if(rpc) processResult.lifecycle=rpc.lifecycle;
      let events=[],transportEvents=[];
      try { events=(await readConsumptionCostEvents(observation)).events;transportEvents=await readProviderTransport(network); }
      catch(error) { processResult.observationError=safeDiagnostic(Buffer.from(error.message)); }
      const sourceObservation=await sourceRows(ledger.ledger,config.transport,true);
      processResult.source=summarizeSource(sourceObservation.events,{
        beforeCloseRequestIds:processResult.sourceBoundary?.requestIds,
        beforeCloseChildIds:processResult.sourceBoundary?.childIds,
        transport:config.transport??'cli',sourceObservation,
        ownedLifecycle:await rows(join(processEvidence,'owned-processes.jsonl')) });
      processResult.sourceLedger=ledger.ledger;
      await save(join(processEvidence,'process.json'),processResult);processes.push(processResult);
      for(const sample of local) samples.push(summarizeTurn(sample,events,transportEvents));
    }
  }
  for(const sample of planned) if(!samples.some(value=>value.id===sample.id)) samples.push({...sample,status:'not_run',reason:stoppedReason??'Process did not reach submission'});
  // Re-read after the entire batch: a slow source wrapper may log its start only
  // after its Pi host has closed. Retain process.json as the capture-time receipt.
  for(const item of processes) {
    const sourceObservation=await sourceRows(item.sourceLedger,item.sourceTransport,true);
    item.source=summarizeSource(sourceObservation.events,{
      beforeCloseRequestIds:item.sourceBoundary?.requestIds,
      beforeCloseChildIds:item.sourceBoundary?.childIds,
      transport:item.sourceTransport,sourceObservation,
      ownedLifecycle:await rows(join(evidence,item.id,'owned-processes.jsonl')) });
    item.sourceReconciledAt=new Date().toISOString();
    await save(join(evidence,item.id,'process-reconciliation.json'),item);
  }
  const after=await tree(dirname(config.extension));
  const runtimeBundleUnchanged=config.transport!=='sdk'||JSON.stringify(await bundledRuntimeAt(config.extension))===JSON.stringify(preflight.bundledRuntime);
  const observed=samples.filter(sample=>sample.status!=='not_run');
  const sourceComplete=processes.length===config.counts.cold&&processes.every(item=>item.status==='closed'&&item.observedSourcesQuiet&&item.source.complete);
  const report={version:1,kind:plan.kind,runId,status:sourceComplete&&observed.every(sample=>sample.status==='passed'&&sample.observationComplete)&&observed.length===planned.length?'observed':'incomplete',
    evidence,scratch,planSha256:hash(await readFile(join(evidence,'plan.json'))),runtimeUnchanged:after.sha256===preflight.runtime.sha256&&runtimeBundleUnchanged,
    sourceTransport:config.transport??'cli',runtimeBundleUnchanged,
    sourceComplete,stoppedReason,samples,processes,notClaimed:['Skill task or graph acceptance','installed candidate acceptance','metadata-producer completion inferred from a quiet interval','model SDK retry/queue wait attribution','TCP/TLS wire bytes'],
    groups:Object.fromEntries(['cold','warm'].map(cache=>[cache,{planned:planned.filter(sample=>sample.cache===cache).length,observed:observed.filter(sample=>sample.cache===cache).length,
      metrics:Object.fromEntries(['submitToFirstProviderMs','submitToFirstModelHttpMs','submitToFirstEffectiveTextMs','submitToCompletionMs','providerPayloadJsonBytes','toolRounds']
        .map(key=>[key,consumptionMetricStats(observed.filter(sample=>sample.cache===cache).map(sample=>sample[key]??null))]))}]))};
  if(!report.runtimeUnchanged) report.status='incomplete';
  await save(join(evidence,'report.json'),report);
  const inventory=await tree(evidence);await save(join(evidence,'retained.json'),inventory);
  console.log(JSON.stringify({status:report.status,evidence,samples:report.samples.length,observed:observed.length,runtimeUnchanged:report.runtimeUnchanged,groups:report.groups},null,2));
  if(report.status!=='observed') process.exitCode=1;
}
async function evidence(path,cleanup=false) {
  assert.ok(isAbsolute(path??''));path=await realpath(path);
  const report=JSON.parse(await readFile(join(path,'report.json'),'utf8')), inventory=JSON.parse(await readFile(join(path,'retained.json'),'utf8'));
  for(const [name,sha] of Object.entries(inventory.files)) assert.equal(hash(await readFile(join(path,name))),sha,'Retained evidence changed: '+name);
  if(cleanup) {
    try {
      const prior=JSON.parse(await readFile(join(path,'cleanup.json'),'utf8'));
      assert.equal(prior.runId,report.runId);assert.equal(prior.evidencePreserved,true);
      await assert.rejects(access(report.scratch),{code:'ENOENT'},'A cleanup receipt cannot replace checking scratch absence');
      console.log(JSON.stringify({status:'already-trashed',functionalStatus:report.status,evidence:path,files:Object.keys(inventory.files).length}));return;
    } catch(error) { if(error.code!=='ENOENT')throw error; }
    const owner=JSON.parse(await readFile(join(path,'ownership.json'),'utf8')), scratch=owner.scratch;
    assert.equal(owner.evidence,path);assert.equal(owner.runId,report.runId);assert.equal(owner.kind,'skill-consumption-model-baseline');
    assert.ok(dirname(scratch)===await systemTempRoot()&&scratch.startsWith(join(await systemTempRoot(),'skill-model-cost-scratch-')));
    for(const item of report.processes){
      const ledger=await rows(join(path,item.id,'owned-processes.jsonl'));
      const spawned=ledger.filter(row=>row.event==='spawn');
      assert.ok(spawned.length>0&&spawned.every(row=>ledger.filter(end=>end.event==='close'&&end.pid===row.pid&&end.observedExit).length===1),'Missing or unclosed owned process');
      if((item.sourceTransport??'cli')==='sdk') {
        assert.equal(item.source.sourceObserverComplete,true,'Missing passive source terminal cannot prove safe cleanup');
        assert.equal(item.source.unmatchedChildren,0,'Unmatched child descendant transport remains unknown');
        assert.equal(item.source.sdkStarts,item.source.sdkCloses,'Unclosed source SDK operation');
      } else assert.ok(item.source.cliStarts>0,'Missing source lifecycle cannot prove safe cleanup');
      assert.equal(item.source.cliStarts,item.source.cliCloses,'Unclosed source CLI');
    }
    const marker=JSON.parse(await readFile(join(scratch,'owner.json'),'utf8'));assert.deepEqual(marker,{runId:owner.runId,evidence:path});
    await runCommand('/usr/bin/trash',[scratch],{cwd:path,env:process.env,timeoutMs:30000});
    await save(join(path,'cleanup.json'),{status:'trashed',scratch,evidencePreserved:true,runId:owner.runId});
    for(const [name,sha] of Object.entries(inventory.files)) assert.equal(hash(await readFile(join(path,name))),sha);
  }
  console.log(JSON.stringify({status:'preserved',functionalStatus:report.status,evidence:path,files:Object.keys(inventory.files).length,cleanup},null,2));
}
async function main() {
  const args=process.argv.slice(2);if(args.some(arg=>['--help','-h','help'].includes(arg))){console.log(usage);return;}
  const action=args.shift(),options={};while(args.length){const key=args.shift();assert.ok(key?.startsWith('--')&&args.length);options[key.slice(2)]=args.shift();}
  if(action==='evidence'||action==='cleanup')return evidence(options.evidence,action==='cleanup');
  assert.ok(action==='doctor'||action==='run',usage);
  const config=await configAt(options.config);
  if(action==='doctor')console.log(JSON.stringify(await doctor(config),null,2));else await run(config,options['evidence-root']);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(safeDiagnostic(Buffer.from(error.message)));process.exitCode=1;});

