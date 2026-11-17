import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, readdir, realpath, access, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedEnv, resolveHost, assertSupportedPiVersion } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { bodyCount, observer, provider, publishToolPlan, resolveInstalledPiSerializer, sourceFinality, closedCliMetrics } from './notion-sdk-pi.mjs';
import { contextFromCompletionRequest, startLoopbackMock } from './mock-provider-adapter.mjs';
import { candidatePayloadBodies, observeCandidateTask, reviewCandidateMaintenanceTool } from './verify-pi-daily-candidate.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';

// This runner joins the existing public Pi/SDK/serializer observers for NXT's
// one owned library. It does not alter the historical scenarios or model gates.
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const rows = async path => (await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).split('\n').filter(Boolean).map(JSON.parse);
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const exists = path => access(path).then(() => true, () => false);
const text = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const identity = async path => { const bytes = await readFile(path); return { path: await realpath(path), sha256: hash(bytes), bytes: bytes.length }; };
const mainFile = config => config.oracle.find(file => file.logical_path === 'SKILL.md');

export const nxtNaturalTaskTemplates = Object.freeze([
  { id: 'onboarding', prompts: ['我有一个已经存在的 Notion Skills 库：$ENTRY。本次 Pi 项目的配置位置是 $CONFIG。请查阅这次已安装包的使用说明（CLI 入口是 $CLI），判断怎样连接这个已有库，给我可复制的下一步，并说明现在实际完成到了哪一步。只做必要的只读核对；本轮不要写入配置、创建库或改动任何 Notion 内容，也不要操作全局配置。'] },
  { id: 'maintenance', prompts: ['请对库 $ENTRY 中这个专用测试 Skill $TARGET 完成一次维护：要更新的主文和新增参考内容已放在 $INPUT。使用这次安装包的 CLI $CLI 提交这些改动，保留其他文件和原有页面身份；不要运行 Skill 内的脚本。完成后告诉我哪些文件已验证，是否还有未完成项，并给出这次操作的标识。只允许修改这个专用测试 Skill。'] },
  { id: 'read-use', prompts: ['库 $ENTRY 里的 nxt-journey 是做什么的？请介绍它，并核对 references/part-a.md 和 references/part-b.md 的内容，说明两者区别。本轮只是阅读，不应用其指令，不运行脚本，也不写入 Notion。',
    '现在请应用刚才那个 nxt-journey，用它记录一句“本次验收已核对两份参考”。不要再次读取已经完整取得的两份参考，不运行脚本，也不写入 Notion。'] },
]);

export async function prepareNxtMaintenance(fixture, output, receipt) {
  assert.ok([fixture, output, receipt].every(isAbsolute));
  assert.equal(await exists(output), false, 'Use a new sparse author input');
  const original = await json(receipt), value = typeof original.output === 'string' ? JSON.parse(original.output) : original.output;
  assert.equal(value.verified, true); assert.equal(value.record.name, 'nxt-model-maintenance');
  assert.equal(value.record.locator.database_id, '4195636c-236e-8104-aafa-f7366fe421ce');
  assert.equal(value.record.locator.page_id, '4195636c-236e-81e8-b798-cf623fd25118');
  const originalMain = await readFile(join(fixture, 'SKILL.md'), 'utf8');
  assert.ok(originalMain.startsWith('---\nname: nxt-model-maintenance\n'));
  await mkdir(join(output, 'references'), { recursive: true, mode: 0o700 });
  await writeFile(join(output, 'SKILL.md'), originalMain.trimEnd() + '\n\n## Maintenance acceptance\n\nRecord the completed review using the [maintenance note](references/model-maintenance.md).\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(output, 'references/model-maintenance.md'), '# Maintenance note\n\nThis owned test records one complete main-and-reference maintenance intent. It does not authorize script execution.\n', { flag: 'wx', mode: 0o600 });
  const url = new URL(value.record.ref);
  const prepared = { id: 'maintenance', target: value.record.locator.page_id, refPrefix: url.protocol + '//' + url.host + '/', input: output,
    inputFiles: await Promise.all(['SKILL.md', 'references/model-maintenance.md'].map(path => identity(join(output, path)))),
    ownership: await identity(receipt), originalMain: await identity(join(fixture, 'SKILL.md')),
    expected: { changed: ['SKILL.md'], added: ['references/model-maintenance.md'], otherFiles: 'unchanged', remoteWrites: 'not_started' } };
  await save(output + '.json', prepared); return prepared;
}

export async function freezeNxtOracle(cli, receipt, output, reuse) {
  assert.ok([cli, receipt, output].every(isAbsolute)); assert.equal(await exists(output), false);
  const before = await identity(cli), original = await json(receipt), applied = typeof original.output === 'string' ? JSON.parse(original.output) : original.output;
  assert.equal(applied.verified, true); assert.equal(applied.record.locator.page_id, '4195636c-236e-81e0-be28-ed9a783bd84a');
  const source = { id: 'nxt', entry: applied.record.locator.database_id, target: applied.record.locator.page_id, name: applied.record.name };
  const url = new URL(applied.record.ref); source.refPrefix = url.protocol + '//' + url.host + '/';
  await mkdir(output, { recursive: false, mode: 0o700 });
  if (reuse) assert.ok(isAbsolute(reuse) && dirname(reuse) === dirname(output));
  const base = join(reuse ?? output, 'cold-client'), originals = join(output, 'originals'); if (!reuse) await mkdir(base); await mkdir(originals);
  const env = isolatedEnv({ base, agentDir: join(base, 'agent'), NOTION_API_TOKEN: process.env.NOTION_API_TOKEN, NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000' });
  delete env.NTN_SKILLS_DEV_ROOT;
  const paths = ['SKILL.md', 'references/part-a.md', 'references/part-b.md'], oracle = [], calls = [];
  for (const [index, path] of paths.entries()) {
    const expected = applied.files.find(file => file.path === path); assert.ok(expected);
    const args = [cli, 'read', index === 0 ? source.target : expected.ref, '--database', source.entry,
      ...(index === 0 ? ['--refresh'] : []), '--read-only', '--json', '--metrics'];
    const old = reuse && index === 0 ? join(reuse, 'read-0.json') : undefined;
    if (old) {
      const started = await json(join(reuse, 'read-0.started.json')); assert.deepEqual(started.args, args); assert.deepEqual(started.cli, before);
    }
    await save(join(output, 'read-' + index + '.started.json'), { executable: process.execPath, args, cli: before, isolatedState: base, devRootPresent: false,
      executed: !old, ...(old ? { originalRead: await identity(old), reason: 'Reuse the retained successful CLI receipt after observer field validation failed; no rerun of the root read' } : {}) });
    const { stdout, stderr } = old ? { stdout: await readFile(old, 'utf8'), stderr: await readFile(join(reuse, 'read-0.stderr'), 'utf8') }
      : await promisify(execFile)(process.execPath, args, { env, cwd: base, timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
    await writeFile(join(output, 'read-' + index + '.json'), stdout, { flag: 'wx', mode: 0o600 });
    await writeFile(join(output, 'read-' + index + '.stderr'), stderr, { flag: 'wx', mode: 0o600 });
    const value = JSON.parse(stdout); assert.equal(value.ok, true); assert.equal(value.has_more, false); assert.equal(value.path, path);
    assert.equal(value.record.locator.page_id, source.target); assert.equal(value.record.locator.database_id, source.entry);
    assert.equal(value.snapshot_id, applied.snapshot_id, 'Freeze the exact post-apply pin');
    assert.equal(Buffer.byteLength(value.content), expected.bytes); assert.equal(hash(value.content), expected.sha256);
    assert.equal(value.effects.remote_writes, 'none'); const metrics = safeRequestMetrics(value.request_metrics); assert.equal(metrics?.complete, true);
    assert.equal(metrics.trace.some(row => row.request_kind === 'notion_write'), false);
    const local = join(originals, path); await mkdir(dirname(local), { recursive: true });
    await writeFile(local, value.content, { flag: 'wx', mode: 0o600 });
    oracle.push({ ...await identity(local), logical_path: path, ref: value.ref, scope: value.scope, snapshot_id: value.snapshot_id });
    calls.push({ path, executedInThisReader: !old, request_metrics: value.request_metrics, normalized_metrics: metrics, effects: value.effects });
  }
  assert.equal((await identity(cli)).sha256, before.sha256);
  const result = { version: 1, source, oracle, calls, producer: before, sourceReceipt: await identity(receipt),
    stage: 'Independent canonical data oracle, not a final Broker package acceptance', authorStoreCopied: false, consumerSeeded: false,
    ...(reuse ? { priorDriverFailure: { evidence: reuse, correction: 'Public CLI uses effects.remote_writes and raw metrics; retain the original read and normalize metrics through the existing strict safeRequestMetrics reader.' } } : {}) };
  await save(join(output, 'manifest.json'), result); return { status: 'prepared', manifest: join(output, 'manifest.json'), source, oracle };
}

/** The original NXT fixture remains fixed. A separate SRC19 observation binds
 * its exact owned page to a retained public enable receipt, not a guessed name.
 * It may run one read-only task; old onboarding/maintenance attempts stay final. */
export function validateNxtFixture(config, receipt) {
  assert.equal(config.kind, 'nxt-pi-delivery');
  assert.equal(config.source.entry, '4195636c-236e-8104-aafa-f7366fe421ce');
  if (config.version === 1) {
    assert.equal(config.source.target, '4195636c-236e-81e0-be28-ed9a783bd84a');
    assert.equal(config.source.name, 'nxt-journey');
    assert.equal(config.fixtureReceipt, undefined);
    return;
  }
  if (config.version === 3 || config.version === 4) {
    assert.equal(config.scenario, 'owned-natural-maintenance');
    if (config.version === 4) assert.equal(config.commandOutputProof, 1);
    assert.equal(config.source.target, '4195636c-236e-81e0-be28-ed9a783bd84a');
    assert.equal(config.source.name, 'nxt-journey');
    assert.equal(receipt?.ok, true);
    assert.equal(receipt?.verified, true);
    assert.match(receipt.create_operation_id, /^skill-create-[a-f0-9]{64}$/u);
    const record = receipt.record;
    assert.equal(record?.kind, 'skill');
    assert.equal(record?.enabled, true);
    assert.equal(record?.locator?.type, 'shared_skill');
    assert.equal(record?.locator?.database_id, config.source.entry);
    assert.equal(record?.locator?.page_id, config.tasks[0]?.target);
    const fixtureName = config.version === 3 ? 'nxt-natural-maintenance-20261117'
      : config.fixtureName ?? 'nxt-daily-performance-20261117';
    if (config.version === 4) assert.match(fixtureName, /^nxt-daily-performance-20261117(?:-[a-z0-9]{1,16})?$/u);
    assert.equal(record?.name, fixtureName);
    assert.notEqual(record.locator.page_id, config.source.target);
    assert.notEqual(record.locator.page_id, '4195636c-236e-81e8-b798-cf623fd25118');
    if (config.version === 4) assert.notEqual(record.locator.page_id, '41b5636c-236e-811f-a9b9-ec874cd47dde');
    if (config.version === 4 && fixtureName !== 'nxt-daily-performance-20261117')
      assert.notEqual(record.locator.page_id, '41b5636c-236e-8132-85ac-c881f9ae5a49', 'Do not replay the already maintained four-pillar fixture');
    const ref = new URL(record.ref);
    assert.equal(config.tasks[0]?.refPrefix, ref.protocol + '//' + ref.host + '/');
    assert.deepEqual(config.tasks.map(task => task.id), ['maintenance']);
    assert.equal(config.tasks[0].prompts.length, 1);
    assert.equal(config.tasks[0].ownership.path, config.fixtureReceipt?.path);
    assert.equal(config.tasks[0].ownership.sha256, config.fixtureReceipt?.sha256);
    assert.deepEqual(config.tasks[0].expected, {
      changed: ['SKILL.md'], added: ['references/model-maintenance.md'], otherFiles: 'unchanged', remoteWrites: 'not_started',
    });
    assert.deepEqual(config.tasks[0].inputFiles.map(file => file.path.slice(config.tasks[0].input.length + 1)).sort(),
      ['SKILL.md', 'references/model-maintenance.md']);
    assert.deepEqual(receipt.file_bindings.map(binding => binding.path).sort(), ['SKILL.md', 'references/baseline.md']);
    return;
  }
  assert.equal(config.version, 2); assert.equal(config.scenario, 'git-document-overlay');
  assert.equal(receipt?.ok, true); assert.equal(receipt?.status, 'applied');
  const record=receipt.record;
  assert.equal(record?.kind, 'skill'); assert.equal(record?.enabled, true);
  assert.equal(record?.locator?.type, 'shared_skill');
  assert.equal(record.locator.database_id, config.source.entry);
  assert.equal(record.locator.page_id, config.source.target);
  assert.equal(record.name, config.source.name);
  const ref=new URL(record.ref);
  assert.equal(config.source.refPrefix, ref.protocol+'//'+ref.host+'/');
  assert.notEqual(config.source.target, '4195636c-236e-81e0-be28-ed9a783bd84a');
  assert.deepEqual(config.tasks.map(task=>task.id), ['read-use']);
  assert.equal(config.tasks[0].prompts.length, 1);
}

export async function inspectNxtInput(config) {
  for (const key of ['packageRoot', 'evidenceRoot', 'baselinePath']) assert.ok(isAbsolute(config[key]), key);
  let fixtureReceipt;
  if(config.version===2 || config.version===3 || config.version===4) {
    assert.ok(isAbsolute(config.fixtureReceipt?.path));
    assert.equal((await identity(config.fixtureReceipt.path)).sha256,config.fixtureReceipt.sha256);
    fixtureReceipt=await json(config.fixtureReceipt.path);
  }
  validateNxtFixture(config,fixtureReceipt);
  assert.match(config.source.id, /^[a-z][a-z0-9-]{0,63}$/u);
  const baseline = await json(config.baselinePath);
  assert.deepEqual(baseline.model, { provider: 'magpie', model: 'group/worker', runs_per_task: 1, max_turns: 10,
    max_output_tokens_per_turn: 4096, tasks: config.version===2 ? ['read-only Git/Notion document overlay']
      : ['cold onboarding and safe connection choice', 'one complete maintenance intent', 'read vs use and two references'],
    failures_retained: true, rerun_for_green: false });
  const packageRoot = await realpath(config.packageRoot), manifest = await json(join(packageRoot, 'package.json'));
  assert.equal(manifest.name, 'pi-context-broker');
  const publicFiles = [], publicDirectories = [packageRoot];
  const visitPublished = async path => {
    const selected = await realpath(path); assert.ok(selected.startsWith(packageRoot + '/'), 'Published paths stay inside the selected package');
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      publicDirectories.push(selected);
      for (const name of (await readdir(path)).sort()) await visitPublished(join(path, name));
    } else { assert.ok(metadata.isFile()); publicFiles.push(selected); }
  };
  for (const path of manifest.files) await visitPublished(join(packageRoot, path));
  const extension = join(packageRoot, manifest.pi.extensions[0]);
  const runtime = await json(join(packageRoot, 'dist/ntn-skills-runtime.json'));
  const cli = await identity(join(packageRoot, 'dist/ntn-skills.mjs')), sdk = await identity(join(packageRoot, 'dist/ntn-skills-sdk.mjs'));
  assert.equal(cli.sha256, runtime.cli_sha256); assert.equal(sdk.sha256, runtime.sdk_sha256);
  if (config.commandOutputProof !== undefined) {
    assert.equal(config.commandOutputProof, 1);
    assert.equal(runtime.command_output_proof_version, 1, 'Compact auditing requires the exact installed CLI proof capability');
    const selectedSdk = await import(pathToFileURL(sdk.path).href);
    assert.equal(selectedSdk.COMMAND_OUTPUT_PROOF_VERSION, 1);
  }
  assert.ok(config.oracle.length >= 3 && mainFile(config));
  for (const file of config.oracle) { const actual = await identity(file.path); assert.equal(actual.sha256, file.sha256); assert.equal(actual.bytes, file.bytes); }
  for (const sentinel of baseline.sentinels) assert.equal((await identity(sentinel.path)).sha256, sentinel.sha256, 'Daily configuration changed');
  const host = await resolveHost('pi'); let piRoot = dirname(host.identity), pi;
  for (;;) {
    try { const value = await json(join(piRoot, 'package.json')); if (value.name === '@earendil-works/pi-coding-agent') { pi = value; break; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.notEqual(piRoot, dirname(piRoot)); piRoot = dirname(piRoot);
  }
  assertSupportedPiVersion(pi.version);
  const harness = await Promise.all(['scripts/nxt-pi-delivery.mjs', 'scripts/notion-sdk-pi.mjs', 'scripts/verify-pi-daily-candidate.mjs',
    'scripts/mock-provider-adapter.mjs', 'scripts/notion-default-context.mjs', 'packages/context-broker/scripts/context-broker-rpc-harness.mjs',
    'packages/context-broker/scripts/context-broker-e2e-fixture.mjs'].map(path => identity(resolve(import.meta.dirname, '..', path))));
  let gitCredentialProbe;
  if (config.version === 2) {
    const gh = await resolveHost('gh'); assert.equal(gh.prefix.length, 0);
    const binary = await identity(gh.identity); harness.push(binary);
    gitCredentialProbe = { executable: gh.file, identity: binary.path, sha256: binary.sha256 };
  }
  return { packageRoot, publicFiles, publicDirectories, extension, runtime, cli, sdk, host, piRoot, pi: pi.version,
    serializer: await resolveInstalledPiSerializer(piRoot, pi.version), baseline: await identity(config.baselinePath), sentinels: baseline.sentinels, harness,
    ...(gitCredentialProbe ? { gitCredentialProbe } : {}) };
}

/** Actual fetch dispatch enforces the frozen request budget; Pi catches errors
 * thrown by before_provider_request handlers, so that hook alone is not a cap. */
export function nxtTransportSource({ controlPath, output, model, maxRequests = 10, maxOutputTokens = 4096 }) {
  return `import fs from 'node:fs';import crypto from 'node:crypto';
const controlPath=${JSON.stringify(controlPath)},output=${JSON.stringify(output)},model=${JSON.stringify(model)},maxRequests=${maxRequests},maxOutputTokens=${maxOutputTokens};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');let requests=0,sourceRequests=0;
const record=row=>fs.appendFileSync(output+'/transport.jsonl',JSON.stringify({pid:process.pid,at:process.hrtime.bigint().toString(),...row})+'\\n',{mode:0o600});
const guardedFetches=new WeakSet();
function install(){
 if(guardedFetches.has(globalThis.fetch))return;
 const original=globalThis.fetch;
 const guarded=async function(input,init){
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 const control=JSON.parse(fs.readFileSync(controlPath,'utf8'));
 if(url.hostname==='api.notion.com'&&control.failRefresh===true){record({phase:'controlled-source-failure',method:init?.method??input?.method??'GET',path:url.pathname,dispatched:false});throw new TypeError('NXT_CONTROLLED_REFRESH_TRANSPORT_FAILURE');}
 let raw=init?.body;if(raw===undefined&&input instanceof Request)raw=await input.clone().text();
 let body;try{if(typeof raw==='string')body=JSON.parse(raw);}catch{}
 if(model&&body&&typeof body.model==='string'){
  if(body.model!==model)throw new Error('NXT_MODEL_NOT_AUTHORIZED');
  if(body.max_completion_tokens!==maxOutputTokens||Object.hasOwn(body,'max_tokens'))throw new Error('NXT_OUTPUT_BUDGET_NOT_APPLIED');
  if(requests>=maxRequests){record({phase:'budget-refused',dispatched:false,requests});throw new Error('NXT_REQUEST_BUDGET_EXHAUSTED');}
  const n=++requests,file='request-'+String(n).padStart(3,'0')+'.json';fs.writeFileSync(output+'/'+file,raw,{flag:'wx',mode:0o600});
  record({phase:'request',request:n,file,bytes:Buffer.byteLength(raw),sha256:hash(raw),model:body.model,max_completion_tokens:body.max_completion_tokens});
  try{const response=await original.call(this,input,init);record({phase:'headers',request:n,status:response.status});return response;}catch(error){record({phase:'request-failed',request:n,name:error.name});throw error;}
 }
 if(url.hostname==='api.notion.com'){
  const n=++sourceRequests;record({phase:'source-request',request:n,method:init?.method??input?.method??'GET',path:url.pathname,dispatched:true});
  try{const response=await original.call(this,input,init);record({phase:'source-headers',request:n,status:response.status});return response;}catch(error){record({phase:'source-request-failed',request:n,name:error.name});throw error;}
 }
 return original.call(this,input,init);
 };
 guardedFetches.add(guarded);globalThis.fetch=guarded;record({phase:'transport-installed'});
}
globalThis[Symbol.for('nxt-pi-delivery.transport')]=install;install();\n`;
}

function controlExtension(controlPath, events, maxOutputTokens) {
  return `import fs from 'node:fs';
const control=()=>JSON.parse(fs.readFileSync(${JSON.stringify(controlPath)},'utf8'));
const record=row=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({pid:process.pid,at:process.hrtime.bigint().toString(),...row})+'\\n',{mode:0o600});
export default api=>{
 const installTransport=globalThis[Symbol.for('nxt-pi-delivery.transport')];if(typeof installTransport!=='function')throw new Error('NXT_TRANSPORT_PRELOAD_MISSING');
 installTransport();api.on('session_start',()=>installTransport());
 for(const name of ['session_start','session_shutdown','session_compact'])api.on(name,(event,ctx)=>record({phase:name,reason:event.reason??null,session:ctx.sessionManager.getSessionFile(),leaf:ctx.sessionManager.getLeafId(),fromExtension:event.fromExtension??null}));
 api.on('session_before_compact',event=>{const p=control();if(!p.compact)return;if(!event.branchEntries.some(e=>e.id===p.firstKeptEntryId))throw new Error('NXT_COMPACTION_KEEP_ID_MISSING');return {compaction:{summary:'Controlled NXT lifecycle summary. Continue the ordinary task using only persisted active fixed instruction bindings.',firstKeptEntryId:p.firstKeptEntryId,tokensBefore:event.preparation.tokensBefore,details:{verification:'actual Pi compaction with controlled summary; no model quality claim'}}};});
 ${maxOutputTokens ? `api.on('before_provider_request',event=>{const payload={...event.payload,max_completion_tokens:${maxOutputTokens}};delete payload.max_tokens;return payload;});` : ''}
};\n`;
}

async function setup(config, info, label, { model = false } = {}) {
  await mkdir(config.evidenceRoot, { recursive: true, mode: 0o700 });
  const base = await mkdtemp(join(config.evidenceRoot, label + '-'));
  const agentDir = join(base, 'agent'), sessions = join(base, 'sessions'), output = join(base, 'evidence');
  for (const path of [agentDir, sessions, output]) await mkdir(path, { recursive: true, mode: 0o700 });
  const sourcePath = join(agentDir, 'context-broker/config.json'), controlPath = join(base, 'control.json');
  await publishToolPlan(controlPath, { failRefresh: false });
  const toolSearch = join(info.piRoot, 'dist/extensions/tool-search/index.js');
  await save(join(agentDir, 'settings.json'), { packages: [info.packageRoot], defaultTools: ['read', 'bash', 'notion_list', 'notion_use', 'tool_search'],
    retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 128 } });
  const transport = join(base, 'transport.mjs');
  await writeFile(transport, nxtTransportSource({ controlPath, output, model: model ? 'group/worker' : null }), { flag: 'wx', mode: 0o600 });
  const controls = join(base, 'controls.mjs');
  await writeFile(controls, controlExtension(controlPath, join(output, 'native-events.jsonl'), model ? 4096 : null), { flag: 'wx', mode: 0o600 });
  const env = isolatedEnv({ base, agentDir, NOTION_API_TOKEN: process.env.NOTION_API_TOKEN,
    CONTEXT_BROKER_CONFIG: sourcePath, CONTEXT_BROKER_HOST: 'pi', NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000',
    BROKER_E2E_PROCESS_LEDGER: join(output, 'processes.jsonl') });
  delete env.NTN_SKILLS_DEV_ROOT;
  await save(join(output, 'input.json'), { config, package: info, setup: { sourcePath, agentDir, emptySourceState: true,
    inheritedDevRootRemoved: Object.hasOwn(process.env, 'NTN_SKILLS_DEV_ROOT'), effectiveDevRootPresent: false,
    credentials: 'Only explicitly inherited Notion/model credentials in process environment; no copied auth file' } });
  return { base, agentDir, sessions, output, sourcePath, controlPath, toolSearch, transport, controls, env };
}

async function notifyCommand(rpc, command, expectedKind) {
  const start = rpc.frames.length;
  const result = await rpc.command('prompt', { message: command });
  assert.equal(result.disposition, 'handled');
  const notifications = rpc.frames.slice(start).filter(frame => frame.type === 'extension_ui_request' && frame.method === 'notify').map(frame => frame.message);
  if (!expectedKind) return notifications;
  const parsed = notifications.flatMap(value => { try { return [JSON.parse(value)]; } catch { return []; } });
  assert.equal(parsed.filter(value => value.kind === expectedKind).length, 1, 'Public command must report one explicit result');
  return parsed.find(value => value.kind === expectedKind);
}

async function connection(rpc, state, source) {
  assert.equal(await exists(state.sourcePath), false);
  const command = `/context-broker connect ${source.id} ${source.entry} --config ${JSON.stringify(state.sourcePath)}`;
  const preview = await notifyCommand(rpc, command, 'source_connection');
  assert.equal(preview.status, 'preview'); assert.equal(preview.local_registration, 'not_configured');
  assert.equal(await exists(state.sourcePath), false);
  const applied = await notifyCommand(rpc, preview.next[0], 'source_connection');
  assert.equal(applied.status, 'configuration_saved'); assert.equal(applied.pi_connection, 'reload_required');
  assert.equal(applied.remote_writes, 'none');
  await save(join(state.output, 'connection.json'), { preview, applied, boundary: 'Actual public Pi command. New process reloads the exact saved path before consumption.' });
}

function sourceAccounting(events) {
  const completed = events.filter(event => event.kind === 'sdk' && event.event === 'end');
  return completed.map(event => {
    const metrics = event.request_metrics;
    assert.equal(event.metrics_observed, true, 'Every terminal SDK call needs its actual cost receipt');
    assert.equal(metrics?.complete, true);
    const trace = metrics.trace.filter(row => row.event === 'attempt'); assert.equal(trace.length, metrics.total_requests);
    return { id: event.id, operation: event.operation, status: event.status, error: event.error_code,
      request_metrics: metrics, sourceWriteAttempts: trace.filter(row => row.request_kind === 'notion_write').length };
  });
}

export function compactCommandAccounting(events, reviewedCommands) {
  const ordinals = new Map();
  return reviewedCommands.map(command => {
    const starts = events.filter(event => event.kind === 'child_start' && event.executable === '/bin/bash'
      && JSON.stringify(event.argv) === JSON.stringify(['-c', command]));
    assert.equal(starts.length, reviewedCommands.filter(value => value === command).length,
      'Every compact write/preview must retain its exact original dispatch');
    const ordinal = ordinals.get(command) ?? 0; ordinals.set(command, ordinal + 1);
    const start = starts[ordinal];
    const closes = events.filter(event => event.kind === 'child_close' && event.id === start.id
      && event.observer_pid === start.observer_pid);
    assert.equal(closes.length, 1, 'No closed stdout, no delivery evidence');
    const metrics = closedCliMetrics(events, closes[0]);
    assert.equal(metrics?.complete, true, 'Aggregate-only or unmatched compact stdout is not full HTTP observation');
    return { id: start.id, operation: 'apply', source: 'closed-stdout-bound-cli-diagnostics',
      output_sha256: closes[0].stdout_sha256, output_bytes: closes[0].stdout_bytes, request_metrics: metrics,
      sourceWriteAttempts: metrics.trace.filter(row => row.event === 'attempt' && row.request_kind === 'notion_write').length };
  });
}

export async function runNxtControlled(config, info) {
  info ??= await inspectNxtInput(config);
  assert.ok(process.env.NOTION_API_TOKEN); const state = await setup(config, info, 'controlled');
  const bodies = await Promise.all(config.oracle.map(async file => ({ ...file, text: await readFile(file.path, 'utf8') })));
  const rootBody = bodies.find(file => file.logical_path === 'SKILL.md'), references = bodies.filter(file => /^references\//u.test(file.logical_path));
  assert.equal(references.length, 2);
  let requestNumber = 0, phase = 'connect', pendingCall = null;
  const server = await startLoopbackMock({ selectCall: context => {
    if (!pendingCall || context.messages.some(message => message.role === 'toolResult' && message.toolCallId === pendingCall.id)) return null;
    return { type: 'toolCall', ...pendingCall };
  }, onBody: async (record, bytes) => {
    const file = 'controlled-request-' + String(++requestNumber).padStart(3, '0') + '.json';
    await writeFile(join(state.output, file), bytes, { flag: 'wx', mode: 0o600 }); Object.assign(record, { entityFile: file, phase });
  }, limits: { maxRequests: 80, maxBodyBytes: 16 * 1024 * 1024, requestTimeoutMs: 30000, holdTimeoutMs: 120000, maxInFlight: 1 } });
  const fake = await provider(state.base, { backend: 'http', serializerUrl: pathToFileURL(info.serializer.serializer.path).href });
  state.env.CTX_MOCK_PROVIDER_BASE_URL = server.baseUrl;
  let rpc, processNumber = 0, sessionFile, failed; const processes = [], observations = [];
  const launch = async resume => {
    const processOutput = join(state.output, 'process-' + (++processNumber)); await mkdir(processOutput);
    const preload = join(processOutput, 'source-observer.mjs'); await observer(preload, { gitCredentialProbe: info.gitCredentialProbe });
    const env = { ...state.env, SC10_PI_OBSERVER: join(processOutput, 'source.jsonl'), SC10_PI_BUNDLED_CLI: info.cli.path,
      NODE_OPTIONS: `--import=${JSON.stringify(state.transport)} --import=${JSON.stringify(preload)}` };
    delete env.NTN_SKILLS_DEV_ROOT;
    if (!await exists(state.sourcePath)) delete env.CONTEXT_BROKER_CONFIG;
    const args = ['--no-skills', '--no-mcp', '--session-dir', state.sessions, '-e', fake, '-e', state.toolSearch, '-e', state.controls,
      '--model', 'context-broker-e2e/fake', ...(resume ? ['--session', sessionFile] : [])];
    rpc = await startRpc({ host: 'pi', cwd: state.base, env, args, timeoutMs: 180000 });
    const current = await rpc.command('get_state'); sessionFile = current.sessionFile;
    processes.push({ output: processOutput, args, pid: rpc.lifecycle[0].pid, sessionFile, lifecycle: rpc.lifecycle, rpc });
    const commands = await rpc.command('get_commands');
    const selected = commands.commands.filter(command => command.name === 'context-broker');
    assert.equal(selected.length, 1); assert.equal(await realpath(selected[0].sourceInfo.path), await realpath(info.extension));
  };
  const close = async () => {
    const current = processes.at(-1); await rpc.closeInput();
    await save(join(current.output, 'rpc.json'), rpc.frames); await save(join(current.output, 'process.json'), { pid: current.pid, args: current.args, lifecycle: rpc.lifecycle, sessionFile });
    const events = await rows(join(current.output, 'source.jsonl'));
    const finality = sourceFinality(events, current.pid, { hostClosed: true, gitCredentialProbe: info.gitCredentialProbe }); assert.equal(finality.complete, true);
    const accounting = sourceAccounting(events); assert.ok(accounting.every(call => call.sourceWriteAttempts === 0), 'The controlled consumer must not write Notion');
    await save(join(current.output, 'source-finality.json'), { ...finality, accounting }); current.closed = true; delete current.rpc; rpc = undefined;
  };
  const observe = async (label, copies) => {
    const latest = server.requests.filter(request => request.entityFile).at(-1); assert.ok(latest);
    const payload = await json(join(state.output, latest.entityFile)), context = contextFromCompletionRequest(payload);
    const actual = bodies.map(file => ({ path: file.logical_path, sha256: file.sha256, copies: bodyCount(context, file.text) }));
    for (const [path, expected] of Object.entries(copies)) assert.equal(actual.find(file => file.path === path).copies, expected, label + ':' + path);
    for (const file of actual) assert.ok(file.copies === 0 || file.copies === 1, label + ': duplicate complete body');
    observations.push({ label, request: latest.entityFile, actual });
  };
  const call = async (id, name, args, copies, error = false) => {
    phase = id; pendingCall = { id, name, arguments: args };
    const offset = rpc.frames.length; await rpc.prompt('Execute the selected public operation for ' + id + '.'); pendingCall = null;
    const ends = rpc.frames.slice(offset).filter(frame => frame.type === 'tool_execution_end' && frame.toolCallId === id); assert.equal(ends.length, 1);
    assert.equal(ends[0].isError === true, error, id + ': unexpected tool outcome');
    if (copies) await observe(id, copies); return ends[0].result;
  };
  try {
    await launch(false); await connection(rpc, state, config.source); assert.equal(server.requests.length, 0, 'Connection commands use no provider'); await close();
    await launch(false);
    const list = JSON.parse(text(await call('nxt-list', 'notion_list', { query: config.source.name, source: config.source.id, limit: 20 }, { 'SKILL.md': 0 })));
    const matching = list.records.filter(record => record.name === config.source.name && record.source === config.source.id && record.availability === 'available'); assert.equal(matching.length, 1);
    const candidate = matching[0].ref;
    const used = JSON.parse(text(await call('nxt-use', 'notion_use', { ref: candidate, readOnly: true }, { 'SKILL.md': 1 })));
    assert.equal(used.records.length, 1); assert.equal(used.records[0].content, rootBody.text);
    const directory = used.records[0].directory, refFor = path => { const found = directory.files.filter(file => file.path === path); assert.equal(found.length, 1); return found[0].ref; };
    await call('nxt-two-references', 'read', { paths: references.map(file => refFor(file.logical_path)), readOnly: true }, Object.fromEntries(bodies.map(file => [file.logical_path, 1])));
    phase = 'ordinary'; await rpc.prompt('Continue the ordinary conversation without reading or applying any Skill again.'); await observe(phase, Object.fromEntries(bodies.map(file => [file.logical_path, 1])));
    await call('nxt-control-discovery', 'tool_search', { query: 'notion_ctl working set', limit: 1 }, { 'SKILL.md': 1 });
    if (config.controlledCliScope === true) {
      const current = processes.at(-1); assert.ok(current && !current.closed);
      const sourceBefore = await rows(join(current.output, 'source.jsonl'));
      const transportBefore = await rows(join(state.output, 'transport.jsonl'));
      const scope = JSON.parse(text(await call('nxt-cli-source', 'notion_ctl', { cli_source: config.source.id }, { 'SKILL.md': 1 })));
      assert.equal(scope.kind, 'host_cli_scope'); assert.equal(scope.sourceId, config.source.id);
      assert.equal(scope.database, config.source.entry); assert.equal(scope.executed, false);
      assert.equal(scope.command.length, 2); assert.equal(scope.command[1], info.cli.path);
      const processStart = sourceBefore.find(event => event.kind === 'observer_start' && event.observer_pid === current.pid);
      assert.ok(processStart); assert.equal(scope.command[0], processStart.exec_path);
      const rejected = await call('nxt-cli-source-unavailable', 'notion_ctl', { cli_source: 'not-a-configured-source' }, { 'SKILL.md': 1 }, true);
      assert.ok(text(rejected).includes('HOST_SOURCE_UNAVAILABLE'));
      const sourceAfter = await rows(join(current.output, 'source.jsonl'));
      const transportAfter = await rows(join(state.output, 'transport.jsonl'));
      const newSource = sourceAfter.slice(sourceBefore.length);
      assert.equal(newSource.filter(event => event.kind === 'sdk' || event.kind === 'child_start').length, 0,
        'A source command locator must not consume a Skill, start CLI work, or contact a provider');
      assert.equal(transportAfter.slice(transportBefore.length).filter(event => event.phase === 'source-request').length, 0);
      await save(join(state.output, 'cli-source-proof.json'), { status: 'passed', sourceId: scope.sourceId,
        database: scope.database, command: scope.command, executed: false, actual_tool_calls: 2,
        source_requests: 0, source_sdk_calls: 0, child_processes: 0, unavailable_source_rejected: true });
    }
    const beforeFailure = JSON.parse(text(await call('nxt-before-refresh', 'notion_ctl', { working_set: 'show' }, { 'SKILL.md': 1 })));
    await publishToolPlan(state.controlPath, { failRefresh: true });
    await call('nxt-failed-refresh', 'notion_use', { ref: candidate, refresh: true, readOnly: true }, { 'SKILL.md': 1 }, true);
    assert.ok((await rows(join(state.output, 'transport.jsonl'))).some(row => row.phase === 'controlled-source-failure'));
    await publishToolPlan(state.controlPath, { failRefresh: false });
    const afterFailure = JSON.parse(text(await call('nxt-after-failed-refresh', 'notion_ctl', { working_set: 'show' }, { 'SKILL.md': 1 })));
    assert.deepEqual(afterFailure.nodes, beforeFailure.nodes, 'A failed refresh cannot replace any active scope, pin or body');
    const refreshed = JSON.parse(text(await call('nxt-successful-refresh', 'notion_use', { ref: candidate, refresh: true, readOnly: true }, { 'SKILL.md': 1 })));
    assert.equal(refreshed.records[0].content, rootBody.text);
    const before = JSON.parse(text(await call('nxt-working-set', 'notion_ctl', { working_set: 'show' }, { 'SKILL.md': 1 })));
    assert.equal(before.roots.length, 1);
    await call('nxt-budget', 'notion_ctl', { working_set: 'budget', max_bytes: before.active.instruction_bytes }, { 'SKILL.md': 1 });
    const originalHistory = await readFile(sessionFile); await writeFile(join(state.output, 'history-before-release.jsonl'), originalHistory, { flag: 'wx', mode: 0o600 });
    await call('nxt-release', 'notion_ctl', { working_set: 'release', roots: before.roots }, { 'SKILL.md': 0 });
    assert.deepEqual((await readFile(sessionFile)).subarray(0, originalHistory.length), originalHistory, 'Release must retain the original native Session bytes');
    await close(); await launch(true);
    phase = 'resume-released'; await rpc.prompt('Continue the ordinary conversation without applying any Skill.'); await observe(phase, { 'SKILL.md': 0 });
    await call('nxt-reuse', 'notion_use', { ref: candidate, readOnly: true }, { 'SKILL.md': 1 });
    phase = 'before-compact'; await rpc.prompt('Keep only this neutral continuation note for the conversation.');
    const native = await rows(sessionFile), lastUser = native.filter(entry => entry.type === 'message' && entry.message.role === 'user').at(-1); assert.ok(lastUser);
    await publishToolPlan(state.controlPath, { failRefresh: false, compact: true, firstKeptEntryId: lastUser.id });
    await rpc.command('compact', { customInstructions: 'Use the controlled summary supplied by this owned verification extension.' });
    await publishToolPlan(state.controlPath, { failRefresh: false });
    phase = 'restore-after-compact'; await rpc.prompt('Continue the ordinary conversation using the active instructions.'); await observe(phase, { 'SKILL.md': 1 });
    await close(); await launch(true);
    phase = 'resume-restored'; await rpc.prompt('Continue the ordinary conversation using its active instructions.'); await observe(phase, { 'SKILL.md': 1 });
    await close();
  } catch (error) { failed = { name: error.name, message: error.message }; }
  finally {
    await publishToolPlan(state.controlPath, { failRefresh: false });
    if (rpc) { await close().catch(async error => { failed ??= { name: error.name, message: error.message }; await rpc?.stop().catch(() => {}); }); }
    await server.close();
    if (sessionFile && await exists(sessionFile)) await writeFile(join(state.output, 'original-session.jsonl'), await readFile(sessionFile), { flag: 'wx', mode: 0o600 });
    for (const sentinel of info.sentinels) if ((await identity(sentinel.path)).sha256 !== sentinel.sha256) failed ??= { message: 'Daily configuration sentinel changed' };
    for (const file of info.harness) if ((await identity(file.path)).sha256 !== file.sha256) failed ??= { message: 'Frozen verification harness changed' };
    const result = { status: failed ? 'failed' : 'passed', failure: failed, evidence: state.output, observations, requests: server.requests,
      processes: processes.map(({ rpc: _, ...process }) => process), source: 'Real Notion through the selected bundled SDK',
      provider: 'Actual installed Pi normal serializer to controlled loopback; no real model',
      failedRefresh: 'Explicit owned transport refusal, not an observed Notion permission denial',
      compaction: 'Actual Pi lifecycle with controlled summary; model summary quality not tested' };
    await save(join(state.output, 'result.json'), result);
  }
  return { status: failed ? 'failed' : 'passed', evidence: state.output, failure: failed };
}

/** A small shell grammar admits owned public reads, including ordinary help
 * sequences and bounded listing output. Author commands remain a single argv. */
export function reviewNxtCli(command, policy) {
  assert.ok(typeof command === 'string' && !/[\r\n\0\\]/u.test(command));
  const tokens = [], source = command.trim(), token = /\s*(?:'([^']*)'|"([^"$`\\]*)"|(&&|;|\||2>)|([^\s'"\\;&|`<>$()*?\[\]{}!~]+))/uy;
  let at = 0;
  while (at < source.length) {
    token.lastIndex = at; const found = token.exec(source); assert.ok(found && found.index === at, 'Only plain arguments and reviewed readonly separators are allowed');
    tokens.push(found[3] ? { operator: found[3] } : { word: found[1] ?? found[2] ?? found[4] }); at = token.lastIndex;
    if (!found[3]) assert.ok(at === source.length || /[\s;&|]/u.test(source[at]), 'Quoted and unquoted words may not be concatenated');
    assert.ok(tokens.length <= 512);
  }
  const commands = []; let words = [], piped = false, redirected = false, syntax = false;
  const finish = () => { assert.ok(words.length > 0); commands.push({ words, piped, redirected }); assert.ok(commands.length <= 16); words = []; redirected = false; };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.word !== undefined) { assert.equal(redirected, false, 'No argument after the reviewed stderr redirection'); words.push(token.word); continue; }
    syntax = true;
    if (token.operator === '2>') {
      assert.ok(words.length > 0 && !redirected && tokens[index + 1]?.word === '/dev/null', 'Only stderr to /dev/null is permitted');
      redirected = true; index++; continue;
    }
    finish(); piped = token.operator === '|';
  }
  finish();
  const steps = commands.map(({ words, piped, redirected }) => {
    if (piped) {
      assert.equal(words[0], 'head'); assert.equal(redirected, false);
      const limit = words.length === 1 ? '10' : words.length === 2 && /^-[1-9][0-9]*$/u.test(words[1]) ? words[1].slice(1)
        : words.length === 3 && words[1] === '-n' ? words[2] : '';
      assert.ok(/^[1-9][0-9]*$/u.test(limit) && Number(limit) <= 200, 'head may only bound the preceding output');
      return { kind: 'output-bound', argv: words };
    }
    if (words[0] === 'echo') return { kind: 'literal-output', argv: words };
    if (['ls', '/bin/ls'].includes(words[0])) {
      const flags = new Set(['-l', '-a', '-A', '-la', '-al', '-lA', '-Al', '-1', '--']);
      const paths = words.slice(1).filter(value => !flags.has(value)); assert.ok(paths.length > 0);
      for (const path of paths) assert.ok(isAbsolute(path) && !path.split('/').includes('..') && policy.listPaths?.includes(resolve(path)), 'List only canonical frozen package or owned input/config paths');
      return { kind: 'owned-list', argv: words, paths: paths.map(path => resolve(path)) };
    }
    return reviewNxtCliArgv(words, policy);
  });
  if (syntax || steps.length > 1) assert.ok(steps.every(step => !['apply', 'apply-preview'].includes(step.kind)), 'Author operations require one standalone CLI argv');
  return steps.length === 1 && !syntax ? steps[0] : { kind: 'readonly-shell', steps, paths: steps.flatMap(step => step.paths ?? []) };
}

function reviewNxtCliArgv(words, policy) {
  assert.ok(['node', policy.node].includes(words[0]) && words[1] === policy.cli, 'Use the selected same-package CLI');
  const args = words.slice(2);
  if (args.at(-1) === '--help') { assert.ok(args.slice(0, -1).every(value => /^[a-z][a-z-]*$/u.test(value))); return { kind: 'help', argv: words }; }
  if (args[0] === 'schema') { assert.ok(args.slice(1).every(value => /^[a-z][a-z-]*$/u.test(value))); return { kind: 'schema', argv: words }; }
  if (args.slice(0, 3).join(' ') === 'ctl builtin list') { assert.equal(args.length, 3); return { kind: 'builtin-list', argv: words }; }
  if (args.slice(0, 3).join(' ') === 'ctl builtin read') {
    assert.equal(args[3], 'notion/ntn-skills-maintain');
    assert.ok(args.length === 4 || args.length === 6 && args[4] === '--path' && ['SKILL.md', 'references/setup.md', 'references/operations.md'].includes(args[5]));
    return { kind: 'builtin-read', argv: words };
  }
  if (args.slice(0, 3).join(' ') === 'ctl library init') { assert.deepEqual(args.slice(3), ['--entry', policy.database]); return { kind: 'existing-library-check', argv: words }; }
  if (args.slice(0, 3).join(' ') === 'ctl library inspect') { assert.deepEqual(args.slice(3), [policy.database]); return { kind: 'existing-library-inspect', argv: words }; }
  if (args.slice(0, 3).join(' ') === 'ctl operation show') {
    assert.equal(policy.task, 'maintenance'); assert.match(args[3], /^[a-z][a-z0-9.-]{1,255}$/u);
    assert.ok(args.length === 4 || args.length === 8 && args[4] === '--entry' && args[5] === policy.database && args[6] === '--target' && args[7] === policy.target);
    return { kind: 'operation-show', argv: words };
  }
  if (args.length === 2 && args[0] === 'ctl' && args[1] === 'status'
    || args.length === 3 && args[0] === 'ctl' && args[1] === 'config' && args[2] === 'show') {
    assert.ok(typeof policy.ownedRoot === 'string' && isAbsolute(policy.ownedRoot) && resolve(policy.ownedRoot) === policy.ownedRoot);
    assert.deepEqual(Object.keys(policy.localRoots ?? {}).sort(), ['cache', 'config', 'data', 'state']);
    for (const path of Object.values(policy.localRoots)) assert.ok(typeof path === 'string' && isAbsolute(path)
      && resolve(path) === path && path.startsWith(policy.ownedRoot + '/'), 'Public diagnostics require the frozen isolated local roots');
    return { kind: 'local-diagnostics', argv: words };
  }
  const flags = new Map(), positional = [];
  const boolean = new Set(['--json', '--read-only', '--authoring', '--metrics', '--refresh', '--dry-run', '--compact']);
  for (let index = 1; index < args.length; index++) {
    const item = args[index];
    if (!item.startsWith('--')) { positional.push(item); continue; }
    assert.ok(!flags.has(item), 'No duplicate options');
    if (boolean.has(item)) flags.set(item, true);
    else { assert.ok(['--database', '--input', '--description', '--limit', '--query'].includes(item) && typeof args[index + 1] === 'string'); flags.set(item, args[++index]); }
  }
  assert.equal(flags.get('--database'), policy.database);
  if (args[0] === 'list') {
    assert.equal(positional.length, 0);
    assert.ok([...flags.keys()].every(key => ['--database', '--query', '--limit', '--json', '--metrics'].includes(key)));
    assert.ok(!flags.has('--limit') || /^[1-9][0-9]*$/u.test(flags.get('--limit')) && Number(flags.get('--limit')) <= 100);
    return { kind: 'list', argv: words };
  }
  assert.equal(positional.length, 1);
  const target = positional[0], exactOwner = target === policy.target || typeof policy.refPrefix === 'string' && target.startsWith(policy.refPrefix);
  assert.ok(exactOwner, 'Use only the separately owned target');
  if (args[0] === 'read' || args[0] === 'files') {
    assert.ok([...flags.keys()].every(key => ['--database', '--json', '--metrics', '--read-only', '--authoring', '--refresh'].includes(key)));
    if (flags.has('--authoring')) assert.equal(target, policy.target, 'Authoring reads select the exact current owned page');
    if (args[0] === 'read') assert.ok(flags.get('--read-only') === true
      || policy.task === 'maintenance' && flags.get('--authoring') === true && target === policy.target,
    'Readonly tasks require --read-only; only this maintenance task\'s exact authoring read may retain remote history');
    return { kind: args[0], argv: words };
  }
  assert.equal(policy.task, 'maintenance'); assert.equal(args[0], 'apply');
  assert.ok(target.startsWith(policy.refPrefix) && new URL(target).pathname === '/SKILL.md' && /^s_[a-f0-9]{64}$/u.test(new URL(target).searchParams.get('snapshot')));
  assert.equal(flags.get('--input'), policy.input);
  assert.ok([...flags.keys()].every(key => ['--database', '--input', '--dry-run', '--description', '--compact'].includes(key)));
  if (flags.has('--compact')) assert.equal(policy.commandOutputProof, 1,
    'The frozen installed candidate requires separately complete, stdout-bound CLI metrics');
  if (flags.has('--description')) assert.equal(flags.get('--description'), policy.description);
  return { kind: flags.get('--dry-run') ? 'apply-preview' : 'apply', argv: words };
}

export function nxtModelGuard(api, { fs, policy, output, reviewCli, reviewNative }) {
  let applies = 0; const approvedBash = new Set(), outputFiles = new Set(policy.readFiles);
  const record = value => fs.appendFileSync(output, JSON.stringify(value) + '\n', { mode: 0o600 });
  const checkPath = (path, allowed) => {
    assert.ok(typeof path === 'string' && isAbsolute(path) && !path.split('/').includes('..')); const selected = resolve(path);
    assert.ok(allowed.has(selected), 'Read only published package files or the exact owned input/config/output');
    try { assert.ok(allowed.has(fs.realpathSync(selected)), 'The selected path must not resolve outside its reviewed scope'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  api.on('tool_call', (event, ctx) => {
    try {
      let result;
      const localReads = event.toolName !== 'read' ? null : typeof event.input.path === 'string' && isAbsolute(event.input.path) ? [event.input.path]
        : Array.isArray(event.input.paths) && event.input.paths.length > 0 && event.input.paths.every(path => typeof path === 'string' && isAbsolute(path)) ? event.input.paths : null;
      if (event.toolName === 'bash') {
        result = reviewCli(event.input.command, policy);
        for (const path of result.paths ?? []) checkPath(path, new Set(policy.listPaths));
        if (result.kind === 'apply') { assert.ok(applies === 0, 'Only one author apply is authorized'); applies++; }
        approvedBash.add(event.toolCallId);
      } else if (localReads) {
        for (const path of localReads) checkPath(path, outputFiles); result = { kind: 'frozen-local-or-observed-output-read' };
      }
      else if (policy.task !== 'onboarding') result = reviewNative(event.toolName, event.input, { mode: 'owned-maintenance-readonly',
        sourceId: policy.sourceId, database: policy.database, target: policy.target, refPrefix: policy.refPrefix }, ctx.sessionManager.getBranch());
      else throw new Error('Onboarding permits same-package help and the existing-library check only');
      record({ toolCallId: event.toolCallId, tool: event.toolName, allowed: true, ...result });
    } catch (error) {
      record({ toolCallId: event.toolCallId, tool: event.toolName, allowed: false, reason: error.message });
      return { block: true, reason: error.message };
    }
  });
  api.on('tool_result', event => {
    if (event.toolName !== 'bash' || !approvedBash.has(event.toolCallId)) return;
    const path = event.details?.fullOutputPath;
    if (typeof path === 'string' && isAbsolute(path)) {
      outputFiles.add(resolve(path)); outputFiles.add(fs.realpathSync(path)); record({ phase: 'owned-cli-output', toolCallId: event.toolCallId, path });
    }
  });
}

export async function runNxtModel(config, taskId, info) {
  info ??= await inspectNxtInput(config);
  assert.ok(['onboarding', 'maintenance', 'read-use'].includes(taskId));
  const task = config.tasks.find(task => task.id === taskId); assert.ok(task);
  const frozenTasks = await identity(config.tasksReceipt.path); assert.equal(frozenTasks.sha256, config.tasksReceipt.sha256);
  const frozen = await json(frozenTasks.path); assert.deepEqual(task.prompts, frozen.tasks.find(item => item.id === taskId).prompts);
  assert.deepEqual(frozen.model, { provider: 'magpie', model: 'group/worker', thinking: 'medium', runsPerTask: 1, maxRequestsPerTask: 10, maxOutputTokensPerRequest: 4096 });
  assert.ok(Array.isArray(task.prompts) && task.prompts.length >= 1 && task.prompts.length <= 2);
  assert.ok(task.prompts.every(prompt => typeof prompt === 'string' && prompt.length > 0));
  assert.ok(process.env.NOTION_API_TOKEN);
  const modelsPath = '/Users/yoyo/.pi/agent/models.json', registered = await json(modelsPath), selected = registered.providers?.magpie;
  const selectedModel = selected?.models?.find(model => model.id === 'group/worker'); assert.ok(selectedModel);
  assert.equal(selected.api, 'openai-completions'); assert.ok(typeof selected.apiKey === 'string' && !selected.apiKey.startsWith('!'));
  assert.equal(selected.headers, undefined, 'Unexpected private model headers need explicit preparation');
  const endpoint = new URL(selected.baseUrl); assert.ok(!endpoint.username && !endpoint.password && !endpoint.search);
  const state = await setup(config, info, 'model-' + taskId, { model: true });
  const policy = { task: taskId, node: process.execPath, cli: info.cli.path, database: config.source.entry, sourceId: config.source.id,
    ...(config.commandOutputProof === 1 ? { commandOutputProof: 1 } : {}),
    target: task.target ?? config.source.target, refPrefix: task.refPrefix ?? config.source.refPrefix,
    input: task.input, description: task.description,
    ownedRoot: state.base, localRoots: { config: state.env.NTN_SKILLS_CONFIG_HOME, state: state.env.NTN_SKILLS_HOME,
      cache: state.env.NTN_SKILLS_CACHE_HOME, data: state.env.NTN_SKILLS_DATA_HOME },
    readFiles: [...info.publicFiles, state.sourcePath, ...(task.inputFiles ?? []).map(file => file.path)],
    listPaths: [...info.publicDirectories, ...info.publicFiles, state.sourcePath, dirname(state.sourcePath),
      ...(task.inputFiles ?? []).flatMap(file => [file.path, dirname(file.path)])] };
  for (const file of task.inputFiles ?? []) assert.equal((await identity(file.path)).sha256, file.sha256);
  if (taskId === 'maintenance') {
    assert.ok(task.target && task.target !== config.source.target && task.refPrefix && isAbsolute(task.input));
    const owner = await identity(task.ownership.path); assert.equal(owner.sha256, task.ownership.sha256);
    const original = await readFile(owner.path, 'utf8'); assert.ok(original.includes(task.target) && original.includes(config.source.entry));
  }
  const key = Object.hasOwn(process.env, selected.apiKey) ? process.env[selected.apiKey] : selected.apiKey;
  assert.ok(typeof key === 'string' && key.length > 0);
  state.env.NXT_PI_MODEL_API_KEY = key;
  const modelConfig = { ...selected, apiKey: 'NXT_PI_MODEL_API_KEY', models: [{ ...selectedModel, maxTokens: 4096 }] };
  await save(join(state.agentDir, 'models.json'), { providers: { magpie: modelConfig } });
  if (taskId !== 'onboarding') {
    await mkdir(dirname(state.sourcePath), { recursive: true });
    await save(state.sourcePath, { sources: [{ id: config.source.id, type: 'notion', database: config.source.entry, prefetch: false, cacheDir: join(state.base, 'broker-cache') }] });
  }
  const prompts = task.prompts.map(prompt => prompt.replaceAll('$CLI', info.cli.path).replaceAll('$CONFIG', state.sourcePath)
    .replaceAll('$ENTRY', config.source.entry).replaceAll('$TARGET', policy.target).replaceAll('$INPUT', task.input ?? ''));
  await save(join(state.output, 'frozen-task.json'), { task: taskId, prompts, promptHashes: prompts.map(hash), policy,
    modelConfiguration: await identity(modelsPath), provider: 'magpie', model: 'group/worker', thinking: 'medium', runs: 1, maxRequests: 10, maxOutputTokens: 4096, frozenTasks,
    nativeAutoCompaction: false, realModelRetries: false, completionCapRegistration: 'before selected Broker extension',
    boundary: 'Isolated installed Pi and selected package via explicit extension argument; normal daily package autoload is verified separately by the controlled journey.' });
  const preload = join(state.base, 'source-observer.mjs'); await observer(preload, { gitCredentialProbe: info.gitCredentialProbe });
  const sourceLedger = join(state.output, 'source.jsonl');
  const guard = join(state.base, 'guard.mjs'), tasks = join(state.output, 'tasks.jsonl'), payloads = join(state.output, 'hook-payloads'); await mkdir(payloads);
  const helper = pathToFileURL(import.meta.filename).href, candidate = pathToFileURL(resolve(import.meta.dirname, 'verify-pi-daily-candidate.mjs')).href;
  await writeFile(guard, `import fs from 'node:fs';import {nxtModelGuard,reviewNxtCli} from ${JSON.stringify(helper)};import {reviewCandidateMaintenanceTool} from ${JSON.stringify(candidate)};export default api=>nxtModelGuard(api,{fs,policy:${JSON.stringify(policy)},output:${JSON.stringify(join(state.output, 'guard.jsonl'))},reviewCli:reviewNxtCli,reviewNative:reviewCandidateMaintenanceTool});\n`, { flag: 'wx', mode: 0o600 });
  const taskObserver = join(state.base, 'tasks.mjs');
  await writeFile(taskObserver, `import fs from 'node:fs';import crypto from 'node:crypto';import {observeCandidateTask,candidatePayloadBodies} from ${JSON.stringify(candidate)};export default api=>observeCandidateTask(api,{fs,crypto,output:${JSON.stringify(tasks)},bodyFiles:${JSON.stringify(config.oracle)},inspectPayload:candidatePayloadBodies,payloadDirectory:${JSON.stringify(payloads)}});\n`, { flag: 'wx', mode: 0o600 });
  const env = { ...state.env, SC10_PI_OBSERVER: sourceLedger, SC10_PI_BUNDLED_CLI: info.cli.path,
    NODE_OPTIONS: `--import=${JSON.stringify(state.transport)} --import=${JSON.stringify(preload)}` };
  delete env.NTN_SKILLS_DEV_ROOT;
  if (taskId === 'onboarding') delete env.CONTEXT_BROKER_CONFIG;
  const args = ['--no-extensions', '--no-skills', '--no-mcp', '--session-dir', state.sessions, '-e', state.controls,
    '-e', info.extension, '-e', state.toolSearch, '-e', taskObserver, '-e', guard, '--model', 'magpie/group/worker', '--thinking', 'medium'];
  // Exclusive attempt marker is written before any real provider can run.
  await save(join(config.evidenceRoot, 'model-attempt-' + taskId + '.json'), { evidence: state.output, task: await identity(join(state.output, 'frozen-task.json')) });
  let rpc, failure, nativeFile, finality; const answers = [];
  const sealSource = async () => {
    const native = await rows(nativeFile), reviewed = await rows(join(state.output, 'guard.jsonl'));
    const calls = native.filter(row => row.type === 'message' && row.message.role === 'assistant')
      .flatMap(row => row.message.content.filter(part => part.type === 'toolCall'));
    const approvedShellCommands = reviewed.filter(row => row.tool === 'bash' && row.allowed === true).map(row => {
      const matching = calls.filter(call => call.id === row.toolCallId && call.name === 'bash');
      assert.equal(matching.length, 1, 'Each approved shell needs its exact original tool call');
      assert.equal(typeof matching[0].arguments.command, 'string');
      const steps = row.kind === 'readonly-shell' ? row.steps : [row];
      const nodeProcesses = steps.filter(step => Array.isArray(step.argv) && ['node', policy.node].includes(step.argv[0]) && step.argv[1] === policy.cli).length;
      return { command: matching[0].arguments.command, nodeProcesses };
    });
    const events = await rows(sourceLedger);
    const compactCommands = reviewed.filter(row => row.tool === 'bash' && row.allowed === true && ['apply','apply-preview'].includes(row.kind)
      && row.argv?.includes('--compact')).map(row => calls.find(call => call.id === row.toolCallId).arguments.command);
    return { ...sourceFinality(events, rpc.lifecycle[0].pid, { hostClosed: true, approvedShellCommands, gitCredentialProbe: info.gitCredentialProbe }),
      accounting: sourceAccounting(events), compact_command_accounting: compactCommandAccounting(events, compactCommands) };
  };
  try {
    rpc = await startRpc({ host: 'pi', cwd: state.base, env, args, timeoutMs: 240000 });
    const current = await rpc.command('get_state'); nativeFile = current.sessionFile;
    assert.equal(current.model.provider, 'magpie'); assert.equal(current.model.id, 'group/worker');
    for (const prompt of prompts) { await rpc.prompt(prompt); const answer = await rpc.command('get_last_assistant_text'); answers.push(answer); }
    await rpc.closeInput();
    finality = await sealSource(); assert.equal(finality.complete, true);
    const wire = await rows(join(state.output, 'transport.jsonl')), requests = wire.filter(row => row.phase === 'request');
    assert.ok(requests.length > 0 && requests.length <= 10);
    assert.equal(wire.some(row => row.phase === 'budget-refused'), false, 'Task exhausted the frozen model budget');
    const observations = await rows(tasks), captured = observations.filter(row => row.phase === 'provider_payload'); assert.equal(captured.length, requests.length);
    for (const [index, request] of requests.entries()) {
      assert.equal(captured[index].sha256, request.sha256, 'Observed hook payload must match the actual final fetch entity');
      assert.equal(captured[index].bytes, request.bytes);
    }
    const native = await rows(nativeFile), assistants = native.filter(row => row.type === 'message' && row.message.role === 'assistant');
    assert.ok(assistants.length > 0 && assistants.at(-1).message.stopReason === 'stop');
    assert.ok(assistants.every(row => !['length', 'error', 'aborted'].includes(row.message.stopReason)), 'Incomplete model output is a failed task');
  } catch (error) { failure = { name: error.name, message: error.message }; }
  finally {
    if (rpc && rpc.lifecycle.at(-1)?.event !== 'close') await rpc.closeInput().catch(async error => { failure ??= { name: error.name, message: error.message }; await rpc.stop().catch(() => {}); });
    if (rpc) { await save(join(state.output, 'rpc.json'), rpc.frames); await save(join(state.output, 'process.json'), { args, lifecycle: rpc.lifecycle }); }
    if (nativeFile && await exists(nativeFile)) await writeFile(join(state.output, 'original-session.jsonl'), await readFile(nativeFile), { flag: 'wx', mode: 0o600 });
    if (rpc && nativeFile && !finality) finality = await sealSource().catch(error => ({ complete: false, observerError: error.message }));
    for (const sentinel of info.sentinels) if ((await identity(sentinel.path)).sha256 !== sentinel.sha256) failure ??= { message: 'Daily configuration sentinel changed' };
    for (const file of info.harness) if ((await identity(file.path)).sha256 !== file.sha256) failure ??= { message: 'Frozen verification harness changed' };
    await save(join(state.output, 'result.json'), { status: failure ? 'failed' : 'completed_needs_semantic_review', task: taskId, evidence: state.output,
      failure, answers, sourceFinality: finality, provider: 'Real magpie/group/worker, installed serializer, final fetch entities retained',
      modelRetryPolicy: 'disabled', sourceCommandConfigured: false, inheritedDevRootPresent: false, semanticReview: 'required; process success alone does not satisfy task' });
  }
  return { status: failure ? 'failed' : 'completed_needs_semantic_review', task: taskId, evidence: state.output, failure };
}

async function main(args) {
  const [action, path, task, receipt, reuse] = args; assert.ok(['tasks', 'maintenance-input', 'oracle', 'doctor', 'controlled', 'model'].includes(action) && path && isAbsolute(path));
  if (action === 'oracle') return freezeNxtOracle(path, task, receipt, reuse);
  if (action === 'maintenance-input') return { status: 'prepared', ...await prepareNxtMaintenance(path, task, receipt) };
  if (action === 'tasks') {
    await save(path, { version: 1, frozenAt: new Date().toISOString(), tasks: nxtNaturalTaskTemplates,
      model: { provider: 'magpie', model: 'group/worker', thinking: 'medium', runsPerTask: 1, maxRequestsPerTask: 10, maxOutputTokensPerRequest: 4096 },
      substitutions: 'Only final package/runtime paths and exact owned identities; task prose is unchanged after freezing', execution: 'not_started' });
    return { status: 'prepared', path, identity: await identity(path), realModelCalls: 0 };
  }
  const config = await json(path), info = await inspectNxtInput(config);
  if (action === 'doctor') return { status: 'ready', package: info, model: { provider: 'magpie', model: 'group/worker', maxRequests: 10, maxOutputTokens: 4096 }, execution: 'not_started' };
  return action === 'model' ? runNxtModel(config, task, info) : runNxtControlled(config, info);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try { const result = await main(process.argv.slice(2)); console.log(JSON.stringify(result)); if (result.status === 'failed') process.exitCode = 1; }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
