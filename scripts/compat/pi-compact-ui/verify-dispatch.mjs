import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const rawArgs = process.argv.slice(2), options = {};
for (let index = 0; index < rawArgs.length; index += 2) {
  const key = rawArgs[index];
  assert.ok(['--pi-root', '--compact-package', '--broker-package', '--output', '--library', '--skill-ref', '--case'].includes(key));
  assert.equal(options[key], undefined); assert.ok(rawArgs[index + 1]); options[key] = rawArgs[index + 1];
}
for (const key of ['--pi-root', '--compact-package', '--broker-package', '--output']) assert.ok(isAbsolute(options[key]));
assert.match(options['--library'], /^[a-f0-9-]{36}$/);
assert.ok(options['--skill-ref'].startsWith('skill://'));
const sha = value => createHash('sha256').update(value).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const piRoot = await realpath(options['--pi-root']), compactRoot = await realpath(options['--compact-package']), brokerRoot = await realpath(options['--broker-package']);
const output = resolve(options['--output']), script = fileURLToPath(import.meta.url);
const cases = ['builtin', 'compact-first', 'broker-first', 'third-party'];
const piPackage = await readJson(join(piRoot, 'package.json'));
assert.equal(piPackage.name, '@earendil-works/pi-coding-agent'); assert.equal(piPackage.version, '1.6.0');
const sourceRefs = await Promise.all([script, join(piRoot, 'package.json'), join(compactRoot, 'index.ts'), join(compactRoot, 'package.json'), join(brokerRoot, 'src/index.ts'), join(brokerRoot, 'src/pi-host-adapter.ts'), join(brokerRoot, 'dist/ntn-skills-sdk.mjs'), join(brokerRoot, 'dist/next-build.json')].map(async path => ({ path, sha256: sha(await readFile(path)) })));
if (!options['--case']) {
  await mkdir(output);
  const results = [];
  for (const name of cases) {
    const caseRoot = join(output, name);
    await mkdir(caseRoot);
    const child = spawnSync(process.execPath, [script, ...rawArgs, '--case', name], { cwd: dirname(script), env: { ...process.env }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 300_000 });
    await writeFile(join(caseRoot, 'stdout.log'), child.stdout ?? '', { flag: 'wx' });
    await writeFile(join(caseRoot, 'stderr.log'), child.stderr ?? '', { flag: 'wx' });
    assert.equal(child.status, 0, name + ': ' + (child.stderr ?? '') + (child.error?.message ?? ''));
    results.push(await readJson(join(caseRoot, 'report.json')));
  }
  for (const ref of sourceRefs) assert.equal(sha(await readFile(ref.path)), ref.sha256);
  const report = { version: 1, status: 'passed', scope: 'Actual Pi 1.6 registry and runToolCall validation/hooks/executor pipeline. Controlled tool calls, no model inference.', source_refs: sourceRefs, cases: results, model_stream_calls: 0 };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({status: report.status, output, cases: results.map(item => ({ name: item.case, owner: item.read.sourceInfo, calls: item.calls.map(call => ({name: call.name, is_error: call.is_error})) }))}));
  process.exit(0);
}
const name = options['--case']; assert.ok(cases.includes(name));
const caseRoot = join(output, name), cwd = join(caseRoot, 'workspace'), agentDir = join(caseRoot, 'agent');
await mkdir(cwd); await mkdir(agentDir);
await writeFile(join(cwd, 'local.txt'), 'CONTROLLED_LOCAL_READ\nsecond line\n', { flag: 'wx' });
const stateRoot = join(output, 'owned-source-state'); await mkdir(stateRoot, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const [key, suffix] of Object.entries({NTN_SKILLS_HOME:'state',NTN_SKILLS_CONFIG_HOME:'config',NTN_SKILLS_CACHE_HOME:'cache',NTN_SKILLS_DATA_HOME:'data',NTN_SKILLS_SCHEDULER_ROOT:'scheduler'})) process.env[key] = join(stateRoot, suffix);
const sourceConfig = join(caseRoot, 'broker.json');
await writeFile(sourceConfig, JSON.stringify({ sources: name === 'builtin' ? [] : [{ id: 'notion', type: 'notion', namespace: 'notion', library: options['--library'], cacheDir: join(stateRoot, 'broker-cache'), prefetch: false }], skillRoots: [], extraSkillRoots: [], ruleRoots: [], discoveryCatalogs: [], extraDiscoveryCatalogs: [], requireAutoload: false }), { flag: 'wx' });
process.env.CONTEXT_BROKER_CONFIG = sourceConfig;
const thirdPath = join(caseRoot, 'third-party.mjs'), thirdLog = join(caseRoot, 'third-party-calls.jsonl');
await writeFile(thirdPath, `import { appendFileSync } from 'node:fs';\nexport default api => api.registerTool({ name:'read',label:'third-party read',description:'Third-party read contract fixture',parameters:{type:'object',additionalProperties:false,required:['marker'],properties:{marker:{type:'string'}}},async execute(id,input){appendFileSync(${JSON.stringify(thirdLog)},JSON.stringify({id,input})+'\\n');return {content:[{type:'text',text:'THIRD_PARTY_READ:'+input.marker}],details:{controlled:true}};}});\n`, { flag: 'wx' });
const compact = join(compactRoot, 'index.ts'), broker = join(brokerRoot, 'src/index.ts');
const paths = name === 'builtin' ? [compact] : name === 'compact-first' ? [compact, broker] : name === 'broker-first' ? [broker, compact] : [thirdPath, compact, broker];
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, createReadTool } = await import(pathToFileURL(join(piRoot, 'dist/index.js')));
const { runToolCall } = await import(pathToFileURL(join(piRoot, 'node_modules/@earendil-works/pi-agent-core/dist/index.js')));
const settings = SettingsManager.inMemory({ packages: [] });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, additionalExtensionPaths: paths, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, disabledBuiltinExtensions: ['mcp'] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const model = { id:'controlled-no-provider', name:'Controlled no-provider fixture', api:'openai-completions',provider:'fixture',baseUrl:'http://127.0.0.1:1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1024 };
const { session } = await createAgentSession({ cwd, agentDir, model, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader });
let modelCalls = 0;
session.agent.streamFn = () => { modelCalls++; throw new Error('No model invocation is permitted in this controlled dispatch fixture'); };
const errors = [], calls = [];
try {
  await session.bindExtensions({ mode: 'rpc', onError: event => errors.push(event) });
  assert.deepEqual(errors, []);
  const info = session.getAllTools().filter(tool => tool.name === 'read'); assert.equal(info.length, 1);
  const read = info[0], canonical = value => JSON.parse(JSON.stringify(value));
  const call = async (toolName, args) => {
    const id = 'controlled-' + (calls.length + 1), toolCall = { type:'toolCall',id,name:toolName,arguments:args };
    const assistantMessage = {role:'assistant',content:[toolCall],api:'openai-completions',provider:'fixture',model:'controlled-no-provider',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()};
    session.sessionManager.appendMessage(assistantMessage);
    session.agent.state.messages = [...session.agent.state.messages, assistantMessage];
    const outcome = await runToolCall(toolCall, {tools:session.agent.state.tools,assistantMessage,context:{messages:session.agent.state.messages,tools:session.agent.state.tools},beforeToolCall:session.agent.beforeToolCall,afterToolCall:session.agent.afterToolCall});
    calls.push({id,name:toolName,args,is_error:outcome.isError,result:outcome.result});
    return outcome;
  };
  const text = outcome => outcome.result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (name === 'builtin') {
    const builtin = createReadTool(cwd);
    assert.equal(read.sourceInfo.source, 'builtin'); assert.equal(read.description, builtin.description); assert.deepEqual(canonical(read.parameters), canonical(builtin.parameters));
    const result = await call('read', {path:'local.txt',offset:1,limit:1}); assert.equal(result.isError, false); assert.ok(text(result).includes('CONTROLLED_LOCAL_READ'));
  } else if (name === 'third-party') {
    assert.equal(read.sourceInfo.path, thirdPath); assert.equal(read.description,'Third-party read contract fixture');
    assert.deepEqual(canonical(read.parameters), {type:'object',additionalProperties:false,required:['marker'],properties:{marker:{type:'string'}}});
    const result = await call('read',{marker:'kept'});assert.equal(result.isError,false);assert.equal(text(result),'THIRD_PARTY_READ:kept');
    assert.equal((await readFile(thirdLog,'utf8')).trim().split('\n').length,1);
  } else {
    assert.equal(read.sourceInfo.path, broker); assert.equal(Buffer.byteLength(read.description),872);
    for(const key of ['path','offset','limit','paths','from','refresh','budget']) assert.ok(Object.hasOwn(read.parameters.properties,key));
    const local = await call('read',{path:'local.txt',offset:1,limit:1});assert.equal(local.isError,false);assert.ok(text(local).includes('CONTROLLED_LOCAL_READ'));
    const used = await call('notion_use',{ref:options['--skill-ref']});assert.equal(used.isError,false,text(used));
    const prepared = JSON.parse(text(used));assert.equal(prepared.ok,true);assert.equal(prepared.status,'ready');assert.equal(prepared.records.length,1);
    const record = prepared.records[0], files = record.directory.files;
    const eligibility = files.find(file=>file.path==='references/eligibility.md'), regions=files.find(file=>file.path==='references/tables/regions.json'), caps=files.find(file=>file.path==='references/tables/caps.json');
    assert.ok(eligibility && regions && caps);
    const single = await call('read',{path:'references/eligibility.md',from:record.ref});assert.equal(single.isError,false,text(single));assert.ok(text(single).includes('tables/regions.json')&&text(single).includes('tables/caps.json'));
    const batch = await call('read',{paths:[regions.ref,caps.ref]});assert.equal(batch.isError,false,text(batch));const value=JSON.parse(text(batch));assert.equal(value.status,'ready');assert.deepEqual(value.files.map(file=>file.path),['references/tables/regions.json','references/tables/caps.json']);assert.ok(value.files.every(file=>file.kind==='text'&&typeof file.content==='string'));
    const invalid = await call('read',{path:'local.txt',paths:[regions.ref]});assert.equal(invalid.isError,true);assert.match(text(invalid),/Choose one file path or an explicit resource paths array/);
  }
  assert.equal(modelCalls,0);assert.deepEqual(errors,[]);
  await session.extensionRunner.emit({type:'session_shutdown',reason:'exit'});
  session.dispose();
  for(const ref of sourceRefs)assert.equal(sha(await readFile(ref.path)),ref.sha256);
  await writeFile(join(caseRoot,'report.json'),JSON.stringify({version:1,status:'passed',case:name,extension_paths:paths,read,model_stream_calls:modelCalls,calls,scope:'Controlled calls through actual Pi registry and runToolCall validation/hooks/execution. Source reads use the declared synthetic Notion library; no model inference.'},null,2)+'\n',{flag:'wx'});
} catch(error) {
  await session.extensionRunner.emit({type:'session_shutdown',reason:'exit'}).catch(()=>{});session.dispose();
  await writeFile(join(caseRoot,'failure.json'),JSON.stringify({case:name,error:String(error),calls,extension_errors:errors,model_stream_calls:modelCalls},null,2)+'\n',{flag:'wx'});throw error;
}
