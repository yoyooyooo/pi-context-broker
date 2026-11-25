import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {freezeStudyDesignFile,bindStudyPlanFile,writeStudyReport} from './study-io.mjs';

export async function studyMain(args) {
  if(!args.length||args.length===1&&['--help','-h'].includes(args[0]))return {help:`Offline Benchmark study analysis

  node benchmark/analysis/study-cli.mjs design --request ABS_JSON --out ABS_NEW_DESIGN
  node benchmark/analysis/study-cli.mjs bind --request ABS_JSON --out ABS_NEW_BINDING
  node benchmark/analysis/study-cli.mjs analyze --request ABS_JSON --out ABS_NEW_REPORT

design reads only the declared sampling, profiles and analysis policy.
bind requires exact panel plans and empty/absent dispatch ledgers.
analyze verifies original plans, canonical analyses, normalized episodes and raw locators.
No command configures an environment, resolves credentials or submits a model request.
See docs/benchmark-study-analysis.md for the two-stage registration and input formats.
`};
  const [action,...rest]=args;assert.ok(['design','bind','analyze'].includes(action),'Unknown study action');
  const options={};assert.equal(rest.length,4,'Use --request and --out');
  for(let index=0;index<rest.length;index+=2){const key=rest[index];assert.ok(['--request','--out'].includes(key)&&!options[key]);assert.ok(isAbsolute(rest[index+1]??''));options[key]=rest[index+1];}
  const request=JSON.parse(await readFile(options['--request'],'utf8'));
  return action==='design'?freezeStudyDesignFile({request,outputFile:options['--out']}):action==='bind'
    ?bindStudyPlanFile({request,outputFile:options['--out']}):writeStudyReport({request,directory:options['--out']});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {const value=await studyMain(process.argv.slice(2));process.stdout.write(value.help??JSON.stringify(value)+'\n');}
  catch(error){process.stdout.write(JSON.stringify({status:'failed',error:error.message,model_requests:0,execution_performed:false})+'\n');process.exitCode=1;}
}
