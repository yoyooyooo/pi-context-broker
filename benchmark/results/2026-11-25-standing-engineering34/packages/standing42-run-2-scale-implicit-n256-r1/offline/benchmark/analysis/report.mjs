import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalJson,fingerprint} from '../protocol.mjs';
import {OFFLINE_REPORT_SOURCE_FILES} from '../offline-source-files.mjs';
import {scoreExperiment} from './compare.mjs';
import {verifyArtifactFiles} from '../evidence/store.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const display=value=>value===null||value===undefined?'unknown':Number.isFinite(value)?Number(value.toPrecision(6)).toString():String(value);
const percentage=value=>value===null||value===undefined?'unknown':(100*value).toFixed(1)+'%';
const csvCell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
export function toCsv(rows,columns) {
  return [columns.map(csvCell).join(','),...rows.map(row=>columns.map(c=>csvCell(row[c])).join(','))].join('\n')+'\n';
}
export function reportTables(analysis) {
  const conditions=analysis.conditions.map(c=>({
    condition_id:c.condition_id,environment_id:c.environment_id,model_id:c.model_id,
    planned:c.counts.planned,valid:c.counts.valid,success:c.counts.pass,known_failure:c.counts.fail,unknown:c.counts.unknown,
    unsupported:c.counts.unsupported,unresolved:c.counts.unresolved,invalid_runs:c.counts.invalid_runs,
    verified_quality:c.metrics.verified_quality.estimate,quality_unit:c.metrics.verified_quality.unit,
    score_percent:c.metrics.verified_quality.score_percent?.estimate??null,score_percent_lcb:c.metrics.verified_quality.score_percent?.interval.lower??null,
    score_percent_ucb:c.metrics.verified_quality.score_percent?.interval.upper??null,
    quality_lcb:c.metrics.verified_quality.interval.lower??null,quality_ucb:c.metrics.verified_quality.interval.upper??null,
    planned_success_lower_bound:c.metrics.verified_quality.planned_verified_lower_bound,
    coverage:c.metrics.evidence_coverage.estimate,unassisted_quality:c.metrics.unassisted_quality.estimate,
    input_first:c.metrics.input_first.estimate,input_peak:c.metrics.input_peak.estimate,input_total:c.metrics.input_total.estimate,
    known_input_subtotal:c.metrics.input_total.known_subtotal,capped_time_ms:c.metrics.capped_time.estimate,
    tau_ms:c.metrics.capped_time.tau_ms,p95_success_status:c.metrics.capped_time.p95_success_time.status,
    p95_success_time_ms:c.metrics.capped_time.p95_success_time.value_ms,
    interface_misuse_rate:c.metrics.interface_misuse_rate.estimate,
    weighted_mean_cost:c.metrics.currency_cost.estimate,mean_cost_interval_status:c.metrics.currency_cost.interval?.status??'unavailable',
    cost_per_success_status:c.metrics.cost_per_success.status,cost_per_success:c.metrics.cost_per_success.estimate,
    currency:c.metrics.cost_per_success.currency,critical_failures:c.critical_failures.length,
  }));
  const comparisons=analysis.comparisons.map(c=>({
    candidate:c.candidate,reference:c.reference,paired_units:c.paired_units,
    quality_delta:c.quality_delta.estimate,quality_delta_lcb:c.quality_delta.interval.lower??null,
    quality_delta_ucb:c.quality_delta.interval.upper??null,input_ratio:c.input_ratio.estimate,
    input_ratio_interval_status:c.input_ratio.interval.status,input_ratio_lcb:c.input_ratio.interval.lower??null,
    input_ratio_ucb:c.input_ratio.interval.upper??null,input_absolute_difference:c.input_ratio.absolute_difference??null,
    capped_time_ratio:c.time_ratio.estimate,capped_time_ratio_lcb:c.time_ratio.interval.lower??null,
    capped_time_ratio_ucb:c.time_ratio.interval.upper??null,decision:c.decision.status,decision_stage:c.decision.stage,
  }));
  const transitions=analysis.comparisons.flatMap(c=>c.version_transition.cells.map(cell=>({candidate:c.candidate,reference:c.reference,
    from:cell.from,to:cell.to,count:cell.count,weight:cell.weight,observed_count:cell.observed_count,unresolved_assigned_count:cell.unresolved_assigned_count,
    estimate:cell.estimate,interval_status:cell.interval.status,lcb:cell.interval.lower??null,ucb:cell.interval.upper??null,
    identification_lower:cell.identification_bounds.lower,identification_upper:cell.identification_bounds.upper})));
  const budget_curves=analysis.conditions.flatMap(c=>['time_ms','input_tokens'].flatMap(axis=>(c.metrics.success_by_budget[axis]??[]).map(point=>({
    condition_id:c.condition_id,axis,budget:point.budget,estimate:point.estimate,interval_status:point.interval.status,
    lcb:point.interval.lower??null,ucb:point.interval.upper??null,planned_repeats:point.planned_repeats,known_repeats:point.known_repeats,
    identification_lower:point.identification_bounds?.lower??null,identification_upper:point.identification_bounds?.upper??null}))));
  const paired_budgets=analysis.comparisons.flatMap(c=>['time_ms','input_tokens'].flatMap(axis=>(c.success_by_budget?.[axis]??[]).map(point=>({
    candidate:c.candidate,reference:c.reference,axis,budget:point.budget,estimate:point.estimate,interval_status:point.interval.status,
    lcb:point.interval.lower??null,ucb:point.interval.upper??null,planned_repeats:point.planned_repeats,known_repeats:point.known_repeats}))));
  const interactions=['model_environment_interaction','code_mode_interaction'].flatMap(kind=>analysis[kind].comparisons.flatMap(comparison=>
    Object.entries(comparison.metrics).map(([metric,value])=>({kind,id:comparison.id,metric,unit:value.unit??null,currency:value.currency??null,
      status:value.status,estimate:value.estimate,interval_status:value.interval.status,lcb:value.interval.lower??null,ucb:value.interval.upper??null,
      reason:value.interval.reason??comparison.reason??null,origin:comparison.origin,confirmation:comparison.confirmation}))));
  const cost_frontier=(analysis.cost_frontier.groups??[]).map(group=>({environment_id:group.scope.environment_id,scope_sha256:fingerprint(group.scope),
    currency:group.currency,status:group.status,minimum_complete_mean_cost:group.estimate,eligible:group.eligible.join(';'),selected:group.selected.join(';'),
    confirmation:'requires_independent_confirmation'}));
  return {conditions,comparisons,transitions,budget_curves,paired_budgets,interactions,cost_frontier};
}
export function renderAnalysisMarkdown(analysis) {
  const lines=['# Benchmark report','',
    '- Protocol: '+analysis.protocol_id+' ('+analysis.protocol_sha256+')',
    '- Analysis: '+analysis.analysis_version+' ('+analysis.analysis_sha256+')',
    '- Planned slots: '+analysis.completeness.planned_slots+'; valid slots: '+analysis.completeness.valid_slots+
      '; unresolved: '+analysis.completeness.unresolved_slots.length+'.',
    '- Actual runs: '+analysis.cost_ledger.actual_runs+'; invalid runs retained: '+analysis.cost_ledger.invalid_runs+
      '; known actual requests: '+analysis.cost_ledger.known_actual_attempts+'.',
    '- Known input subtotal including invalid runs: '+analysis.cost_ledger.known_input_subtotal+'. This subtotal is not a complete total when usage is missing.',
    '', '## Quality and evidence','',
    '| Condition | Verified quality | 95% simultaneous interval | Evidence coverage | Unassisted | Valid S / F / U | Unresolved |',
    '|---|---:|---|---:|---:|---|---:|'];
  for(const c of analysis.conditions) {
    const q=c.metrics.verified_quality;
    lines.push('| '+c.condition_id+' | '+percentage(q.estimate)+' | '+(q.interval.status==='available'?
      percentage(q.interval.lower)+' to '+percentage(q.interval.upper):q.interval.status)+' | '+
      percentage(c.metrics.evidence_coverage.estimate)+' | '+percentage(c.metrics.unassisted_quality.estimate)+' | '+
      c.counts.pass+' / '+c.counts.fail+' / '+c.counts.unknown+' | '+c.counts.unresolved+' |');
  }
  lines.push('','## Resource use','',
    '| Condition | First input | Peak input | Total input | Capped time (ms) | Population p95 success | Cost per success |',
    '|---|---:|---:|---:|---:|---|---|');
  for(const c of analysis.conditions) {
    const m=c.metrics;
    lines.push('| '+c.condition_id+' | '+display(m.input_first.estimate)+' | '+display(m.input_peak.estimate)+' | '+
      display(m.input_total.estimate)+' | '+display(m.capped_time.estimate)+' | '+
      (m.capped_time.p95_success_time.status==='available'?display(m.capped_time.p95_success_time.value_ms)+' ms':m.capped_time.p95_success_time.status)+' | '+
      (m.cost_per_success.status==='available'?display(m.cost_per_success.estimate)+' '+m.cost_per_success.currency:m.cost_per_success.status)+' |');
  }
  lines.push('','## Paired comparisons','');
  for(const c of analysis.comparisons) lines.push('- '+c.candidate+' versus '+c.reference+': quality delta '+
    display(c.quality_delta.estimate)+'; input ratio '+display(c.input_ratio.estimate)+'; capped-time ratio '+display(c.time_ratio.estimate)+
    '; decision '+c.decision.status+' ('+c.decision.stage+').');
  if(!analysis.comparisons.length)lines.push('No paired comparison was included in this batch.');
  lines.push('','## Budget, transitions and interactions','',
    'Budget curves and their paired differences retain case/repeat rows and cluster intervals. CSV files separate interval bounds, identification bounds and unresolved observations.',
    'All nine transition cells retain observed counts and unresolved assignments separately. Missing paired runs do not become observed unknown samples.',
    '', '| Interaction | Metric | Estimate | Interval | Unit |', '|---|---|---:|---|---|');
  for(const row of reportTables(analysis).interactions)lines.push('| '+row.id+' | '+row.metric+' | '+display(row.estimate)+' | '+
    (row.interval_status==='available'?display(row.lcb)+' to '+display(row.ucb):row.interval_status+'; '+row.reason)+' | '+(row.currency??row.unit??'unknown')+' |');
  lines.push('','## Tested mean-cost frontier','',
    'Frontier status: '+analysis.cost_frontier.status+'. The frontier minimizes complete fixed-weight mean cost within one environment, task scope and currency after the quality lower-bound requirement. Cost per success separately divides actual valid-run cost by the number of verified successes.',
    'Selecting the smallest observed cost on this report does not establish independent confirmation of that selection.',
    '', 'Quality estimates and thresholds use Q in [0, 1]. The corresponding S_verified percentage and percentage interval are available as score_percent in analysis.json and conditions.csv.');
  lines.push('','## Interpretation','',...analysis.limitations.map(v=>'- '+v),
    '- Population p95 includes the full fixed denominator; fewer than 95% verified successes by the cap is not_reached.',
    '- Identification bounds for unknown outcomes are separate from confidence intervals.',
    '- Currency cost remains unknown without verified route pricing. A configured zero placeholder is not a free model.',
    '- Reanalysis below reads retained evidence and does not submit model requests.',
    '', '## Reproduce offline','',
    'Run `node replay.mjs --out /absolute/new-report-directory` with the included Node modules. No package installation or model credentials are needed.',
    'The replay verifies included raw hashes and locators before recomputing analysis. The report manifest identifies every included file.',
    '', '## Planned units without a valid result','');
  for(const slot of analysis.completeness.unresolved_slots)lines.push('- '+slot.id+': '+slot.status+'; '+slot.reason);
  if(!analysis.completeness.unresolved_slots.length)lines.push('None.');
  lines.push('');return lines.join('\n');
}
export function renderMetricSvg(analysis,{metric='verified_quality',title=metric,width=980}={}) {
  if(!['verified_quality','input_total','capped_time'].includes(metric))throw new Error('Unsupported report chart');
  const rows=analysis.conditions.map(c=>({label:c.condition_id,value:c.metrics[metric].estimate,interval:c.metrics[metric].interval??null}));
  const height=115+rows.length*62,origin=300,right=120,plot=width-origin-right;
  const max=metric==='verified_quality'?1:Math.max(1,...rows.map(r=>Math.max(r.value??0,r.interval?.status==='available'?r.interval.upper:0)));
  const parts=['<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+escape(title)+'">',
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    '<style>text{font:14px system-ui,sans-serif;fill:#172033}.title{font-size:22px;font-weight:600}.note{font-size:12px;fill:#536176}</style>',
    '<text x="24" y="32" class="title">'+escape(title)+'</text>',
    '<text x="24" y="55" class="note">Fixed family weights; missing values stay unknown. Intervals use independent declared clusters.</text>'];
  for(let i=0;i<rows.length;i++) {
    const row=rows[i],y=85+i*62;
    parts.push('<text x="24" y="'+(y+17)+'">'+escape(row.label.length>34?row.label.slice(0,31)+'…':row.label)+'<title>'+escape(row.label)+'</title></text>');
    parts.push('<line x1="'+origin+'" y1="'+(y+26)+'" x2="'+(width-right)+'" y2="'+(y+26)+'" stroke="#dde3eb"/>');
    if(row.value!==null) {
      parts.push('<rect x="'+origin+'" y="'+y+'" width="'+Math.max(0,row.value/max*plot)+'" height="24" rx="3" fill="#3972ae"/>');
      if(row.interval?.status==='available') {
        const lo=origin+row.interval.lower/max*plot,hi=origin+row.interval.upper/max*plot;
        parts.push('<path d="M '+lo+' '+(y+12)+' H '+hi+' M '+lo+' '+(y+6)+' V '+(y+18)+' M '+hi+' '+(y+6)+' V '+(y+18)+'" stroke="#172033" fill="none"/>');
      }
    }
    parts.push('<text x="'+(width-right+12)+'" y="'+(y+17)+'">'+escape(metric==='verified_quality'?percentage(row.value):display(row.value))+'</text>');
  }
  parts.push('<text x="'+origin+'" y="'+(height-14)+'" class="note">0</text>',
    '<text x="'+(width-right)+'" y="'+(height-14)+'" class="note" text-anchor="end">'+escape(display(max))+'</text>','</svg>\n');
  return parts.join('\n');
}
async function writeOnce(path,bytes) {
  try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(error) {
    if(error.code!=='EEXIST')throw error;
    if(!(await readFile(path)).equals(Buffer.from(bytes)))throw new Error('Refusing to overwrite a different report artifact: '+path);
  }
}
export async function writeAnalysisReport({directory,analysis,input,includeRaw=true,rawRoot}) {
  if(analysis.analysis_sha256!==fingerprint({...analysis,analysis_sha256:null}))throw new Error('Analysis hash mismatch');
  if(input&&scoreExperiment(input).analysis_sha256!==analysis.analysis_sha256)throw new Error('Report inputs do not reproduce the supplied analysis');
  const tables=reportTables(analysis),files=new Map();
  files.set('analysis.json',canonicalJson(analysis)+'\n');
  files.set('report.md',renderAnalysisMarkdown(analysis));
  for(const [name,rows] of Object.entries(tables))files.set(name+'.csv',toCsv(rows,rows.length?Object.keys(rows[0]):['status']));
  files.set('quality.svg',renderMetricSvg(analysis,{metric:'verified_quality',title:'Verified business quality'}));
  files.set('input.svg',renderMetricSvg(analysis,{metric:'input_total',title:'Cumulative input across actual attempts'}));
  files.set('time.svg',renderMetricSvg(analysis,{metric:'capped_time',title:'Capped time across the full fixed denominator'}));
  if(input) {
    files.set('analysis-input.json',canonicalJson(input)+'\n');
    const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
    for(const name of OFFLINE_REPORT_SOURCE_FILES)
      files.set('offline/'+name,await readFile(join(repo,name)));
    if(includeRaw)for(const episode of input.episodes) {
      const raw=await verifyArtifactFiles(episode.artifacts,{root:rawRoot});
      for(const {artifact,bytes} of raw.values())files.set('raw/'+artifact.sha256,bytes);
    }
    files.set('replay.mjs',`import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scoreExperiment} from './offline/benchmark/analysis/compare.mjs';
import {writeAnalysisReport} from './offline/benchmark/analysis/report.mjs';
import {verifyBundle} from './offline/benchmark/evidence/store.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const input=JSON.parse(await readFile(join(root,'analysis-input.json'),'utf8'));
const receipt=JSON.parse(await readFile(join(root,'report-manifest.json'),'utf8'));
for(const item of receipt.files){
 const bytes=await readFile(join(root,item.path));
 if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('Offline package changed: '+item.path);
}
if(receipt.raw_evidence_included!==true)throw new Error('This report omitted raw files; obtain the raw evidence package before replay.');
const pathsBySha256=Object.fromEntries(input.episodes.flatMap(e=>e.artifacts.map(a=>[a.sha256,join(root,'raw',a.sha256)])));
for(const episode of input.episodes)await verifyBundle({episode},{root,pathsBySha256});
const index=process.argv.indexOf('--out');
if(index<0||!process.argv[index+1])throw new Error('Use --out /absolute/new-report-directory');
const analysis=scoreExperiment(input);
await writeAnalysisReport({directory:resolve(process.argv[index+1]),analysis});
process.stdout.write(JSON.stringify({analysis_sha256:analysis.analysis_sha256,model_requests:0})+'\\n');
`);
  }
  await mkdir(directory,{recursive:true});
  for(const [name,bytes] of files) {
    const path=join(directory,name);await mkdir(dirname(path),{recursive:true});await writeOnce(path,bytes);
  }
  const receipt={schema_version:1,kind:'benchmark-offline-report',analysis_sha256:analysis.analysis_sha256,
    raw_evidence_included:Boolean(input&&includeRaw),replay_included:Boolean(input),
    files:[...files].map(([path,bytes])=>({path,bytes:Buffer.byteLength(bytes),sha256:sha(bytes)}))};
  await writeOnce(join(directory,'report-manifest.json'),canonicalJson(receipt)+'\n');
  return {directory,receipt,receipt_sha256:fingerprint(receipt)};
}
