import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';

const args=process.argv.slice(2);
assert.equal(args[0],'--out','Usage: PSTACK_STATECHART_ROOT=/frozen/statechart TLA2TOOLS=/frozen/tla2tools.jar node scripts/verify-consumer-observations.mjs --out /new/absolute/output');
const flowSuite=args.length===4&&args[2]==='--suite'&&args[3]==='flows';
assert.ok(args.length===2||flowSuite,'Only --suite flows is supported as an optional review suite');assert.ok(path.isAbsolute(args[1]));
const modelRoot=fileURLToPath(new URL('../verification/models/consumer-observations/',import.meta.url)),root=flowSuite?path.join(modelRoot,'flows'):modelRoot,out=args[1];
const tool=process.env.PSTACK_STATECHART_ROOT,jar=process.env.TLA2TOOLS;
assert.ok(tool&&path.isAbsolute(tool)&&jar&&path.isAbsolute(jar));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),lock=JSON.parse(fs.readFileSync(path.join(modelRoot,'tool-lock.json')));
const repository=fileURLToPath(new URL('../',import.meta.url));
const coverage=JSON.parse(fs.readFileSync(path.join(root,'coverage.json')));
for(const[file,expected]of Object.entries(coverage.files))assert.equal(hash(fs.readFileSync(path.join(repository,file))),expected,'Review changed source correspondence before rerunning: '+file);
assert.equal(hash(fs.readFileSync(jar)),lock.tlc_sha256,'Use the declared frozen TLC, not an unverified replacement');
for(const member of lock.files)assert.equal(hash(fs.readFileSync(path.join(tool,member.path))),member.sha256,member.path);
fs.mkdirSync(out,{recursive:false});const scratch=path.join(out,'scratch'),retained=path.join(out,'retained-tool-temporaries');fs.mkdirSync(scratch);fs.mkdirSync(retained);process.env.TMPDIR=scratch;
// The upstream runner retires owned scratch. Preserve it with the evidence;
// user deletion policy forbids permanent removal even for tool temporaries.
fs.rmSync=name=>{const resolved=path.resolve(String(name));assert.equal(path.dirname(resolved),scratch);assert.ok(path.basename(resolved).startsWith('statechart-'));fs.renameSync(resolved,path.join(retained,path.basename(resolved)));};
const{check}=await import(pathToFileURL(path.join(tool,'scripts/run.ts')).href);
const{compile}=await import(pathToFileURL(path.join(tool,'scripts/pipeline.ts')).href);
const{checkView}=await import(pathToFileURL(path.join(tool,'scripts/frontends/view.ts')).href);
const cases=flowSuite?coverage.cases:[['Availability','current',['KnownObservationAgrees','CursorCannotMixAvailability']],['Availability','candidate',[]],['Availability','cursor-negative',['CursorCannotMixAvailability']],['ReadRace','current',['NewestObservationWins']],['ReadRace','candidate',[]],['ReadRace','generation-negative',['NewestObservationWins','NoCrossSessionPublication']]];
const summary={version:1,suite:flowSuite?'flows':'observations',proofScope:coverage.kind??coverage.correspondence,toolCommit:lock.commit,tlcSha256:lock.tlc_sha256,coverageSha256:hash(fs.readFileSync(path.join(root,'coverage.json'))),sourceFiles:coverage.files,runs:[],complete:false};
for(const[model,variant,expected]of cases){
 const dir=path.join(out,model+'-'+variant);fs.mkdirSync(dir);
 const spec=path.join(root,model+'.tla'),config=path.join(root,model+'.'+variant+'.cfg'),viewFile=path.join(root,model+'.view.mjs');
 const result=await check(spec,config),view=checkView(await import(pathToFileURL(viewFile).href),inspect),rendered=compile(result,view);
 for(const[name,parts]of rendered.files){const fd=fs.openSync(path.join(dir,name),'wx');try{for(const part of parts)fs.writeSync(fd,typeof part==='string'?Buffer.from(part):part);fs.writeSync(fd,'\n');}finally{fs.closeSync(fd);}}
 const broken=result.rules.filter(x=>x.outcome==='broken').map(x=>x.rule.name).sort();
 const entry={model,variant,states:result.states,broken,expected,rules:result.rules,files:[spec,config,viewFile].map(file=>({file,sha256:hash(fs.readFileSync(file))})),matches:JSON.stringify(broken)===JSON.stringify([...expected].sort())&&result.rules.every(x=>['holds','broken'].includes(x.outcome))};
 summary.runs.push(entry);fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({model,variant,distinct:result.states.distinct,broken,matches:entry.matches}));
 assert.ok(entry.matches&&result.states.complete&&!result.states.cut,'Unexpected property result or incomplete exploration');
}
summary.complete=true;fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
