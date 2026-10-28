#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const canary = 'NOTION_INTEGRATION_BODY_61C9';
export const resourceCanary = 'NOTION_INTEGRATION_RESOURCE_61C9';
export const alias = 'ui-alpha';
export const skillRef = 'skill://11111111-1111-4111-8111-111111111111/SKILL.md';
const snapshot = 's_' + 'a'.repeat(64);
export const database = '33333333-3333-4333-8333-333333333333';
const scope = 'b'.repeat(64);
export const secondCanary = 'NOTION_INTEGRATION_SECOND_BODY_61C9';
export const unflaggedAlias = 'ui-beta';
export const unflaggedCanary = 'NOTION_INTEGRATION_UNFLAGGED_BODY_61C9';
export const unflaggedRef = 'skill://55555555-5555-4555-8555-555555555555/SKILL.md';
export const missingAlias = 'ui-gamma';
export const missingCanary = 'NOTION_INTEGRATION_MISSING_FLAG_BODY_61C9';
export const missingRef = 'skill://66666666-6666-4666-8666-666666666666/SKILL.md';
export const firstViewId = '77777777-7777-4777-8777-777777777777';
export const secondViewId = '88888888-8888-4888-8888-888888888888';
export async function createNotionFixture(directory) {
  await mkdir(directory, { recursive: true });
  const statePath = join(directory, 'notion-fixture-state.json');
  const callsPath = join(directory, 'notion-fixture-calls.jsonl');
  const setScenario = async (scenario, options = {}) => writeFile(statePath, JSON.stringify({ ...options, scenario, callsPath }));
  await setScenario('normal');
  return { command: [process.execPath, fileURLToPath(import.meta.url), '--state', statePath], statePath, callsPath, canary, resourceCanary, skillRef, alias, snapshotId: snapshot, scope, setScenario };
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--state' || !args[1]) throw new Error('Fixture requires --state FILE');
  const state = JSON.parse(await readFile(args[1], 'utf8'));
  const [command, ...flags] = args.slice(2);
  await appendFile(state.callsPath, JSON.stringify({ command, args: flags, scenario: state.scenario, at: new Date().toISOString() }) + '\n');
  const out = value => console.log(JSON.stringify(value));
  const views = state.noViews ? [] : [firstViewId, secondViewId].map((id, index) => ({ id, name: index ? 'Beta work' : 'Default work', type: 'table', database_id: database, data_source_id: '44444444-4444-4444-8444-444444444444', url: `https://notion.so/${database}?v=${id}` }));
  if (command === 'views') { out({ ok: true, views, count: views.length }); return; }
  if (command === 'ctl' && flags[0] === 'cache' && flags[1] === 'identity' && state.cacheIdentity) {
    const selector = flags[flags.indexOf('--database') + 1];
    const selected = flags.includes('--database') ? selector === 'fixture' ? database : selector.replaceAll('-', '').toLowerCase() : null;
    out({ ok: true, identity: createHash('sha256').update(JSON.stringify([state.account ?? 'default', state.configVersion ?? 0, selected === database.replaceAll('-', '') ? database : selected])).digest('hex'), catalog_max_age_ms: state.catalogTtlMs ?? 60_000 });
    return;
  }
  if (command === 'list' && state.listDelayMs) await new Promise(resolve => setTimeout(resolve, state.listDelayMs));
  if (command === 'list' && state.failList) {
    await appendFile(state.callsPath, JSON.stringify({ command: 'catalog-failed', at: new Date().toISOString() }) + '\n');
    out({ ok: false, error: { code: 'NOTION_REQUEST_FAILED' } }); process.exitCode = 1; return;
  }
  if (state.scenario === 'timeout') {
    await new Promise(resolve => setTimeout(resolve, Number(process.env.NTN_SKILLS_REQUEST_TIMEOUT_MS ?? 30000)));
    out({ ok: false, error: { code: 'NTN_UNAVAILABLE', details: { reason: 'timeout' } } }); process.exitCode = 1; return;
  }
  if (state.scenario === 'malformed') { console.log('invalid-json'); return; }
  if (state.scenario === 'denied') { out({ ok: false, error: { code: 'ACCESS_DENIED', message: 'Controlled fixture access denied' } }); process.exitCode = 1; return; }
  if (state.scenario === 'slow-read' && command === 'read') await new Promise(resolve => setTimeout(resolve, 32_000));
  if (state.scenario === 'controlled-read' && command === 'read') await new Promise(resolve => setTimeout(resolve, state.delayMs ?? 4_000));
  if (state.failRead && command === 'read') { out({ ok: false, error: { code: 'ACCESS_DENIED', message: 'Controlled prefetch failure' } }); process.exitCode = 1; return; }
  if (state.delayMs && state.scenario !== 'controlled-read' && command === 'read') await new Promise(resolve => setTimeout(resolve, state.delayMs));
  const kind = state.kind ?? 'skill';
  const snapshotFor = seed => kind === 'skill' && !state.revision && state.defaultContext !== false
    ? 's_' + seed.repeat(64)
    : 's_' + createHash('sha256').update(JSON.stringify([seed, kind, state.revision ?? '', state.defaultContext !== false])).digest('hex');
  const second = command !== 'list' && flags.some(flag => flag.includes('22222222-2222-4222-8222-222222222222') || flag === snapshotFor('d'));
  const unflagged = command !== 'list' && flags.some(flag => flag.includes('55555555-5555-4555-8555-555555555555') || flag === snapshotFor('f'));
  const missing = command !== 'list' && flags.some(flag => flag.includes('66666666-6666-4666-8666-666666666666') || flag === snapshotFor('1'));
  let selectedSnapshot = snapshotFor(unflagged ? 'f' : missing ? '1' : second ? 'd' : 'a');
  const selectedRef = unflagged ? unflaggedRef : missing ? missingRef : second ? 'skill://22222222-2222-4222-8222-222222222222/SKILL.md' : skillRef;
  const selectedAlias = unflagged ? unflaggedAlias : missing ? missingAlias : alias;
  let entrypoint = { skill: 'SKILL.md', router: 'ROUTER.md', prompt: 'PROMPT.md' }[kind];
  const locator = { type: 'notion_page', page_id: selectedRef.split('/')[2], database_id: database, data_source_id: '44444444-4444-4444-8444-444444444444' };
  let skill = { id: 'notion_page:' + locator.page_id, kind, locator, entrypoint, name: unflagged ? 'UI Beta' : missing ? 'UI Gamma' : state.name ?? 'UI Alpha', alias: state.alias ?? selectedAlias, description: 'Use the UI alpha integration contract for ledger verification.', ref: selectedRef.replace('SKILL.md', entrypoint), default_context: !missing && !unflagged && state.defaultContext !== false };
  if (state.upstream && command === 'list') skill.upstream = state.upstream;
  const freshness = { policy: 'max_age', validated_at: new Date(Date.now() - (state.catalogAgeMs ?? 0)).toISOString(), age_ms: state.catalogAgeMs ?? 0, max_age_ms: state.catalogTtlMs ?? 60_000, stale: (state.catalogAgeMs ?? 0) >= (state.catalogTtlMs ?? 60_000) };
  let content = `---\nname: ${selectedAlias}\ndescription: ${skill.description}\n---\n${unflagged ? unflaggedCanary : missing ? missingCanary : second ? secondCanary : canary}\n${state.revision ?? ''}\nRead [the ledger resource](references/ledger.md) when applying this skill.\n`;
  let version = kind === 'skill' && !state.revision && state.defaultContext !== false ? (second ? 'fixture-version-2' : 'fixture-version-1') : 'fixture-version-' + selectedSnapshot.slice(2);
  const snapshots = args[1] + '.snapshots';
  if (command === 'read') {
    await mkdir(snapshots, { recursive: true });
    await writeFile(join(snapshots, selectedSnapshot + '.json'), JSON.stringify({ skill, entrypoint, content, version }));
  } else if (command === 'export') {
    selectedSnapshot = flags[0];
    ({ skill, entrypoint, content, version } = JSON.parse(await readFile(join(snapshots, selectedSnapshot + '.json'), 'utf8')));
  }
  if (command === 'list') {
    const skills = [skill];
    if (state.scenario === 'duplicates') skills.push({ ...skill, id: 'notion_page:22222222-2222-4222-8222-222222222222', locator: { ...locator, page_id: '22222222-2222-4222-8222-222222222222' }, ref: 'skill://22222222-2222-4222-8222-222222222222/' + entrypoint });
    if (state.includeUnflagged) skills.push(
      { ...skill, id: 'notion_page:' + unflaggedRef.split('/')[2], locator: { ...locator, page_id: unflaggedRef.split('/')[2] }, name: 'UI Beta', alias: unflaggedAlias, ref: unflaggedRef.replace('SKILL.md', entrypoint), default_context: false },
      { ...skill, id: 'notion_page:' + missingRef.split('/')[2], locator: { ...locator, page_id: missingRef.split('/')[2] }, name: 'UI Gamma', alias: missingAlias, ref: missingRef.replace('SKILL.md', entrypoint), default_context: false },
    );
    const selectedView = flags.includes('--view') || flags.includes('--default-view');
    const rawSelector = flags.includes('--view') ? flags[flags.indexOf('--view') + 1] : undefined;
    let requestedView = rawSelector;
    if (rawSelector?.startsWith('https://')) requestedView = new URL(rawSelector).searchParams.get('v');
    const view = requestedView ? views.find(view => view.id === requestedView) : views[0];
    if (selectedView && requestedView && !view) { out({ ok: false, error: { code: 'NOT_FOUND' } }); process.exitCode = 1; return; }
    const records = !selectedView ? skills : !view ? [] : view.id === secondViewId ? skills.filter(item => item.alias === unflaggedAlias) : skills.filter(item => item.default_context);
    out({ ok: true, scope, source: 'notion', fetched_at: Date.now(), databases: [{ database_id: skill.locator.database_id, title: 'Fixture', alias: 'fixture', data_source_ids: [skill.locator.data_source_id] }], records, count: records.length, coverage: { method: selectedView ? 'explicit_view' : 'explicit_database', exhaustive: true, queried_data_sources: [skill.locator.data_source_id], failed_sources: [], search_index_limited: false }, freshness, ...(selectedView ? { view: view ?? null, view_selection: view ? requestedView ? 'explicit' : 'first' : 'none', view_query: null } : {}) });
    if (state.cacheIdentity) await appendFile(state.callsPath, JSON.stringify({ command: 'catalog-ready', at: new Date().toISOString() }) + '\n');
  } else if (command === 'read') {
    out({ ok: true, scope, record: skill, entrypoint, snapshot_id: selectedSnapshot, version_id: version, path: entrypoint, ref: `${skill.ref}?snapshot=${selectedSnapshot}`, source: 'notion', content, range: { start: 1, end: content.split('\n').length, total_lines: content.split('\n').length }, has_more: false, freshness });
  } else if (command === 'export') {
    const position = flags.indexOf('--output');
    if (flags[flags.indexOf('--projection') + 1] !== 'snapshot') throw new Error('Broker fixture export requires explicit snapshot projection');
    if (position < 0 || flags[position + 1] === undefined) throw new Error('export requires --output');
    const output = resolve(flags[position + 1]);
    await mkdir(join(output, 'references'), { recursive: true });
    await writeFile(join(output, entrypoint), content);
    await writeFile(join(output, 'references/ledger.md'), resourceCanary + '\n');
    const manifest = JSON.stringify({ format: 'ntn-skills', version: 2, kind: skill.kind, name: skill.name, description: skill.description, main: entrypoint });
    await writeFile(join(output, '.ntn-skills.json'), manifest);
    await appendFile(state.callsPath, JSON.stringify({ command, args: flags, scenario: state.scenario, phase: 'completed', at: new Date().toISOString() }) + '\n');
    const inventory = [{ path: '.ntn-skills.json', content: manifest, role: 'manifest' }, { path: entrypoint, content, role: 'entrypoint' }, { path: 'references/ledger.md', content: resourceCanary + '\n', role: 'resource' }].map(({ path, content, role }) => ({ path, bytes: Buffer.byteLength(content), hash: createHash('sha256').update(content).digest('hex'), role }));
    out({ ok: true, scope, record: skill, entrypoint, snapshot_id: selectedSnapshot, version_id: version, ref: `${skill.ref}?snapshot=${selectedSnapshot}`, operation: 'export', projection: 'snapshot', output, main_path: entrypoint, content_id: createHash('sha256').update(JSON.stringify([skill, content, resourceCanary])).digest('hex'), reused: false, files: inventory, format: 'directory', source: 'local_snapshot', freshness: { policy: 'pinned', stale: false } });
  } else throw new Error(`Unsupported controlled fixture command: ${command}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
