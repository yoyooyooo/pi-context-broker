import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const { values } = parseArgs({ options: {
 'pi-root': {type:'string'}, 'compact-entry': {type:'string'},
 'broker-renderer-source': {type:'string'}, out: {type:'string'},
 help: {type:'boolean'},
}});
const usage = 'node review-ui.mjs --pi-root /absolute/installed/pi-coding-agent --compact-entry /absolute/compact-ui/index.ts --broker-renderer-source /absolute/broker/packages/context-broker/src/pi-read-renderer.ts --out /absolute/new-owned-output';
if (values.help) { console.log(usage); process.exit(0); }
for (const key of ['pi-root','compact-entry','broker-renderer-source','out']) {
 assert.equal(typeof values[key], 'string', `Missing --${key}. ${usage}`);
 assert(path.isAbsolute(values[key]), `--${key} must be absolute`);
}
const piRoot = values['pi-root'];
const compact = values['compact-entry'];
const broker = values['broker-renderer-source'];
const out = values.out;
assert(statSync(piRoot).isDirectory(), '--pi-root must be a directory');
assert(statSync(compact).isFile(), '--compact-entry must be a file');
assert(statSync(broker).isFile(), '--broker-renderer-source must be a file');
// A fresh owned output prevents overwriting earlier evidence. Parent must exist.
mkdirSync(out);
const brokerFixture = path.join(out,'broker-renderer-fixture.ts');
writeFileSync(brokerFixture, `import { createPiReadRenderers } from ${JSON.stringify(broker)};
export default function(pi) {
 pi.registerToolRenderer((name,next) => { const native = next(); if(name !== "read" || !native) return native; return {...native, ...createPiReadRenderers({native})}; });
}
`);
const req = createRequire(path.join(piRoot,'package.json'));
const pi = await import(pathToFileURL(path.join(piRoot,'dist/index.js')));
const tui = await import(pathToFileURL(req.resolve('@earendil-works/pi-tui')));
const { loadExtensions } = await import(pathToFileURL(path.join(piRoot,'dist/core/extensions/loader.js')));
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const identities = Object.fromEntries([fileURLToPath(import.meta.url),compact,broker,brokerFixture,path.join(piRoot,'dist/modes/interactive/components/tool-execution.js'),path.join(piRoot,'dist/core/extensions/runner.js')].map(p=>[p,sha(p)]));
pi.initTheme('dark',false);
const base = pi.createReadToolDefinition(out);
let uiRequests=0;
const ui={requestRender(){uiRequests++;}};
const snapshots=[];
const failures=[];
const checks=[];
function capture(group,label,width){
 const lines=group.render(width);
 for(const line of lines)assert(tui.visibleWidth(line)<=width,`${label}: exceeds width ${width}`);
 const text=lines.map(tui.stripTerminalSequences).join('\n');
 snapshots.push({label,width,text});
 return text;
}
function count(hay,needle){return hay.split(needle).length-1;}
for(const order of ['compact-only','compact-broker','broker-compact','thirdparty-compact']){
 const paths=order==='broker-compact'?[brokerFixture,compact]:order==='compact-broker'?[compact,brokerFixture]:[compact];
 const loaded=await loadExtensions(paths,out);
 assert.deepEqual(loaded.errors,[]);
 const compactExtension=loaded.extensions.find(e=>e.path===compact||e.resolvedPath===compact)??loaded.extensions.find(e=>e.tools?.has('bash'));
 assert(compactExtension,'compact extension exists');
 assert.equal(compactExtension.tools.has('read'),false,'compact must not register logical read');
 // This UI-only Runner never accesses ModelRegistry or performs tool/model actions.
 const runner=new pi.ExtensionRunner(loaded.extensions,loaded.runtime,out,pi.SessionManager.inMemory(out),undefined);
 runner.onError(error=>failures.push(error));
 await runner.emit({type:'session_start'});
 const thirdBase={...base,renderCall:()=>new tui.Text('THIRDPARTY_NATIVE_CALL',0,0),renderResult:()=>new tui.Text('THIRDPARTY_NATIVE_RESULT',0,0)};
 const original=order==='thirdparty-compact'?thirdBase:base;
 const renderers=runner.resolveToolRenderers('read',()=>original);
 assert.equal(original.execute,base.execute);
 assert.equal(original.parameters,base.parameters);
 for(const fixture of [
  {name:'single-success',args:{path:'/tmp/read-fixture.md'},text:'BODY_ONE',error:false},
  {name:'batch-success',args:{paths:['notion://fixture/alpha.md','notion://fixture/beta.md'],from:'source-0',refresh:false},text:'BODY_TWO',error:false},
  {name:'single-error',args:{path:'/tmp/missing-fixture.md'},text:'ERR_ONE',error:true},
 ]){
  const parent=new tui.Container();
  const id=`${order}-${fixture.name}`;
  const tool=new pi.ToolExecutionComponent('read',id,fixture.args,{showImages:false},renderers,ui,out);
  parent.addChild(tool);
  assert.equal(parent.children.length,1);
  const group=parent.children[0];
  assert.notEqual(group,tool,'actual Container patch must wrap native component');
  assert.deepEqual(group.children,[tool]);
  tool.setArgsComplete();
  tool.markExecutionStarted();
  await runner.emit({type:'tool_execution_start',toolCallId:id,toolName:'read',args:fixture.args});
  for(const width of [32,100]){
   const pending=capture(group,`${id}/pending`,width);
   assert.equal(count(pending,' read '),1,'one compact read row while pending');
   if(fixture.name==='batch-success')assert.match(pending,/2 files/);
  }
  const result={content:[{type:'text',text:fixture.text}],details:{},isError:fixture.error};
  tool.updateResult(result,false);
  await runner.emit({type:'tool_execution_end',toolCallId:id,toolName:'read',args:fixture.args,result,isError:fixture.error});
  for(const width of [32,100]){
   group.setExpanded(false);
   const collapsed=capture(group,`${id}/collapsed`,width);
   assert.equal(count(collapsed,' read '),1);
   assert.equal(count(collapsed,fixture.text),0,'collapsed preview omits body');
   assert(collapsed.includes(fixture.error?'✗':'✓'),'terminal status visible');
   group.setExpanded(true);
   const expanded=capture(group,`${id}/expanded`,width);
   assert.equal(count(expanded,' read '),1);
   assert.equal(count(expanded,fixture.text),1,'expanded result exactly once');
   assert(!expanded.includes('THIRDPARTY_NATIVE'),'native renderer must not leak outside group');
  }
  group.setExpanded(false);
  checks.push({order,case:fixture.name,groupClass:group.constructor.name,oneReadRow:true,expandedBodyExactlyOnce:true,widths:[32,100]});
  parent.clear();
 }
 // Two real components join one compact group, without duplicate body previews.
 const parent=new tui.Container();
 for(let i=1;i<=2;i++){
  const tool=new pi.ToolExecutionComponent('read',`${order}-group-${i}`,{path:`/tmp/group-${i}.md`},{showImages:false},renderers,ui,out);
  parent.addChild(tool);tool.setArgsComplete();tool.markExecutionStarted();
  tool.updateResult({content:[{type:'text',text:`GROUP_BODY_${i}`}],details:{},isError:false},false);
 }
 assert.equal(parent.children.length,1);
 const group=parent.children[0];assert.equal(group.children.length,2);group.setExpanded(true);
 const grouped=capture(group,`${order}/two-tools-expanded`,100);
 assert.equal(count(grouped,' read '),2);assert.equal(count(grouped,'GROUP_BODY_1'),1);assert.equal(count(grouped,'GROUP_BODY_2'),1);
 checks.push({order,case:'two-tools-group',oneGroup:true,twoRows:true,eachBodyExactlyOnce:true});
 parent.clear();
 await runner.emit({type:'agent_end',messages:[]});
 await runner.emit({type:'session_shutdown'});
}
assert.deepEqual(failures,[]);
for(const [p,hash] of Object.entries(identities))assert.equal(sha(p),hash,'source changed during fixture');
writeFileSync(path.join(out,'rendered-snapshots.json'),JSON.stringify(snapshots,null,2)+'\n');
const report={schema:'compact-ui-real-component-review/v2',ok:true,piVersion:JSON.parse(readFileSync(path.join(piRoot,'package.json'))).version,compactVersion:JSON.parse(readFileSync(path.join(path.dirname(compact),'package.json'))).version,identities,checks,snapshotCount:snapshots.length,modelRequests:0,toolExecutions:0,remoteOperations:0,userSettingsWrites:0,scope:'Actual installed Pi ToolExecutionComponent, Container, ExtensionRunner and compact grouping; actual frozen Broker renderer decorator in both resolver orders. Synthetic text result injection only; registry and dispatch covered independently.',uiRequests};
writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({ok:true,checks:checks.length,snapshots:snapshots.length,report:path.join(out,'report.json'),reportSha256:sha(path.join(out,'report.json'))}));
