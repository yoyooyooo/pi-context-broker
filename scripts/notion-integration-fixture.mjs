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
  return { command: [process.execPath, fileURLToPath(import.meta.url), '--state', statePath], statePath, callsPath, canary, resourceCanary, skillRef, alias, name: 'UI Alpha', snapshotId: snapshot, scope, setScenario,
    duplicateSelections: [{ pageId: skillRef.split('/')[2], marker: canary }, { pageId: '22222222-2222-4222-8222-222222222222', marker: secondCanary }] };
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--state' || !args[1]) throw new Error('Fixture requires --state FILE');
  const state = JSON.parse(await readFile(args[1], 'utf8'));
  const [invokedCommand, ...invokedFlags] = args.slice(2);
  // Current ctl callers and the explicit legacy aliases share this controlled
  // implementation. Keep the public argv in the ledger so a migration cannot
  // be claimed from a normalized command name alone.
  const [command, ...flags] = invokedCommand === 'ctl' ? invokedFlags : [invokedCommand, ...invokedFlags];
  // Keep metadata discoverable while failure tests forbid all successful body
  // preparation, including the host's startup/default-View background reads.
  const scenario = state.activationOnly === true && !['prepare', 'read', 'export'].includes(command) ? 'normal' : state.scenario;
  await appendFile(state.callsPath, JSON.stringify({ command: invokedCommand, args: invokedFlags, operation: command, scenario, ...(state.activationOnly === true ? { configured_scenario: state.scenario, failure_scope: 'activation' } : {}), at: new Date().toISOString() }) + '\n');
  const out = value => console.log(JSON.stringify(value));
  if (command === 'doctor') { out({ ok: true, transport: 'direct_http', notion_api_version: '2026-03-11', authentication: 'available' }); return; }
  const views = state.noViews ? [] : [firstViewId, secondViewId].map((id, index) => ({ id, name: index ? 'Beta work' : 'Default work', type: 'table', database_id: database, data_source_id: '44444444-4444-4444-8444-444444444444', url: `https://notion.so/${database}?v=${id}` }));
  if (command === 'views') { out({ ok: true, views, count: views.length }); return; }
  if (command === 'cache' && flags[0] === 'identity' && state.cacheIdentity) {
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
  if (scenario === 'timeout') {
    await new Promise(resolve => setTimeout(resolve, Number(process.env.NTN_SKILLS_REQUEST_TIMEOUT_MS ?? 30000)));
    out({ ok: false, error: { code: 'NOTION_UNAVAILABLE', details: { reason: 'timeout' } } }); process.exitCode = 1; return;
  }
  if (scenario === 'malformed') { console.log('invalid-json'); return; }
  if (scenario === 'denied') { out({ ok: false, error: { code: 'ACCESS_DENIED', message: 'Controlled fixture access denied' } }); process.exitCode = 1; return; }
  if (state.scenario === 'slow-read' && ['prepare', 'read'].includes(command)) await new Promise(resolve => setTimeout(resolve, 32_000));
  if (state.scenario === 'controlled-read' && ['prepare', 'read'].includes(command)) await new Promise(resolve => setTimeout(resolve, state.delayMs ?? 4_000));
  if (state.failRead && ['prepare', 'read'].includes(command)) { out({ ok: false, error: { code: 'ACCESS_DENIED', message: 'Controlled prefetch failure' } }); process.exitCode = 1; return; }
  if (state.delayMs && state.scenario !== 'controlled-read' && ['prepare', 'read'].includes(command)) await new Promise(resolve => setTimeout(resolve, state.delayMs));
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
  const hash = value => createHash('sha256').update(value).digest('hex');
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  const pin = target => /[?&]snapshot=(s_[a-f0-9]{64})(?:&|$)/.exec(target ?? '')?.[1];
  const reject = (code, message) => { out({ ok: false, error: { code, message } }); process.exitCode = 1; };
  // This legacy fixture supplies a frozen wire receipt for adapter tests only.
  // The dedicated graph runner delegates prepare/read/export to Node + SQLite.
  if (command === 'prepare') {
    if (flags.includes('--json')) { reject('INVALID_ARGUMENT', 'prepare is already JSON and does not accept --json'); return; }
    const firstOption = flags.findIndex(flag => flag.startsWith('--'));
    const roots = flags.slice(0, firstOption < 0 ? flags.length : firstOption);
    const option = (name, fallback) => flags.includes(name) ? flags[flags.indexOf(name) + 1] : fallback;
    const purpose = option('--purpose', 'use');
    if (!roots.length || !['use', 'inspect'].includes(purpose)) { reject('INVALID_ARGUMENT', 'Explicit roots and purpose are required'); return; }
    const session = flags.includes('--session-bindings') ? JSON.parse(await readFile(option('--session-bindings'), 'utf8')) : [];
    if (!Array.isArray(session) || session.some(binding => binding.scope !== scope)) { reject('PREPARE_SCOPE_CONFLICT', 'Session binding scope differs'); return; }
    const nodes = [];
    const observedRoots = [];
    await mkdir(snapshots, { recursive: true });
    for (const target of roots) {
      const page = target.split('/')[2];
      const rootRef = `skill://${page}/${entrypoint}`;
      const rootSecond = page === '22222222-2222-4222-8222-222222222222';
      const rootUnflagged = page === unflaggedRef.split('/')[2];
      const rootMissing = page === missingRef.split('/')[2];
      if (![skillRef, unflaggedRef, missingRef, 'skill://22222222-2222-4222-8222-222222222222/SKILL.md'].some(ref => ref.split('/')[2] === page)) { reject('NOT_FOUND', 'The exact root is absent'); return; }
      const rootAlias = rootUnflagged ? unflaggedAlias : rootMissing ? missingAlias : alias;
      let frozen = {
        skill: { ...skill, id: 'notion_page:' + page, locator: { ...locator, page_id: page }, name: rootUnflagged ? 'UI Beta' : rootMissing ? 'UI Gamma' : state.name ?? 'UI Alpha', alias: state.alias ?? rootAlias, ref: rootRef, default_context: !rootMissing && !rootUnflagged && state.defaultContext !== false },
        entrypoint,
        content: `---\nname: ${rootAlias}\ndescription: ${skill.description}\n---\n${rootUnflagged ? unflaggedCanary : rootMissing ? missingCanary : rootSecond ? secondCanary : canary}\n${state.revision ?? ''}\nRead [the ledger resource](references/ledger.md) when applying this skill.\n`,
        version: kind === 'skill' && !state.revision && state.defaultContext !== false ? (rootSecond ? 'fixture-version-2' : 'fixture-version-1') : 'fixture-version-' + snapshotFor(rootUnflagged ? 'f' : rootMissing ? '1' : rootSecond ? 'd' : 'a').slice(2),
      };
      const current = snapshotFor(rootUnflagged ? 'f' : rootMissing ? '1' : rootSecond ? 'd' : 'a');
      const binding = session.find(item => item.record?.id === frozen.skill.id);
      if (pin(target) && binding && pin(target) !== binding.snapshot_id) { reject('PREPARE_VERSION_CONFLICT', 'Root pin differs from session binding'); return; }
      const selected = pin(target) ?? binding?.snapshot_id ?? current;
      if (selected !== current) {
        try { frozen = JSON.parse(await readFile(join(snapshots, selected + '.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; reject('SNAPSHOT_MISSING', 'Pinned fixture snapshot is absent'); return; }
      } else await writeFile(join(snapshots, selected + '.json'), JSON.stringify(frozen));
      if (frozen.skill.id !== 'notion_page:' + page) { reject('SNAPSHOT_CONFLICT', 'Pinned fixture snapshot belongs to another root'); return; }
      const exactRef = `${frozen.skill.ref}?snapshot=${selected}`;
      const bound = { record: frozen.skill, scope, snapshot_id: selected, version_id: frozen.version, body_sha256: hash(frozen.content), ref: exactRef };
      if (binding && canonical(binding) !== canonical(bound)) { reject('PREPARE_BINDING_CONFLICT', 'Frozen fixture binding differs'); return; }
      observedRoots.push({ target, id: frozen.skill.id, ref: exactRef, readiness: 'ready' });
      if (!nodes.some(node => node.id === frozen.skill.id)) nodes.push({ state: 'prepared', id: frozen.skill.id, ref: exactRef, roles: ['root'], kind: frozen.skill.kind, record: frozen.skill, binding: bound, path: frozen.entrypoint, content: frozen.content, bytes: Buffer.byteLength(frozen.content), body_sha256: bound.body_sha256, files: [{ path: frozen.entrypoint, bytes: Buffer.byteLength(frozen.content), sha256: bound.body_sha256, ref: exactRef }, { path: 'references/ledger.md', bytes: Buffer.byteLength(resourceCanary + '\n'), sha256: hash(resourceCanary + '\n'), ref: `skill://${page}/references/ledger.md?snapshot=${selected}` }], required: [], candidates: [], references: [], unresolved_references: [], source: 'local_snapshot', freshness: { policy: 'pinned' } });
    }
    nodes.sort((a, b) => a.id.localeCompare(b.id));
    const bindings = nodes.map(node => node.binding);
    const budget = { maxNodes: Number(option('--max-nodes', 64)), maxDepth: Number(option('--max-depth', 16)), maxInstructionBytes: Number(option('--max-instruction-bytes', 1048576)), maxContextBytes: Number(option('--max-context-bytes', 262144)) };
    if (nodes.length > budget.maxNodes || nodes.some(node => node.bytes > budget.maxInstructionBytes)) { reject('PREPARE_NODE_BUDGET', 'Controlled fixture preparation exceeds its budget'); return; }
    const vector = { version: 1, kind: 'observed_version_vector', purpose, scope, roots: nodes.map(node => node.id).sort(), required: [], bindings };
    const ready = { ok: true, version: 1, status: 'ready', purpose, scope, roots: observedRoots, nodes, required: [], required_closure: purpose === 'use' ? nodes.map(node => node.id) : [], session_bindings: bindings, graph_lock: { ...vector, sha256: hash(canonical(vector)) }, budget, usage: { prepared_nodes: nodes.length, instruction_bytes: nodes.reduce((sum, node) => sum + node.bytes, 0), context_bytes: 0, max_depth: 0 } };
    for (let previous = -1; previous !== ready.usage.context_bytes;) { previous = ready.usage.context_bytes; ready.usage.context_bytes = Buffer.byteLength(JSON.stringify(ready)); }
    if (ready.usage.context_bytes > budget.maxContextBytes) { reject('PREPARE_CONTEXT_BUDGET', 'Controlled fixture context exceeds its budget'); return; }
    out(ready); return;
  }
  if (command === 'read') {
    await mkdir(snapshots, { recursive: true });
    const requested = pin(flags[0]);
    if (requested && requested !== selectedSnapshot) {
      try { ({ skill, entrypoint, content, version } = JSON.parse(await readFile(join(snapshots, requested + '.json'), 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; reject('SNAPSHOT_MISSING', 'Pinned fixture snapshot is absent'); return; }
      if (skill.ref.split('/')[2] !== flags[0].split('/')[2]) { reject('SNAPSHOT_CONFLICT', 'Pinned fixture snapshot belongs to another root'); return; }
      selectedSnapshot = requested;
    } else await writeFile(join(snapshots, selectedSnapshot + '.json'), JSON.stringify({ skill, entrypoint, content, version }));
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
    const path = decodeURIComponent(new URL(flags[0]).pathname.slice(1));
    if (![entrypoint, 'references/ledger.md'].includes(path)) { reject('FILE_NOT_FOUND', 'The exact fixture file is absent'); return; }
    const bytes = Buffer.from(path === entrypoint ? content : resourceCanary + '\n');
    const ref = `skill://${skill.ref.split('/')[2]}/${path}?snapshot=${selectedSnapshot}`;
    const observedFreshness = pin(flags[0]) ? { policy: 'pinned', stale: false } : freshness;
    if (flags.includes('--output')) {
      const output = resolve(flags[flags.indexOf('--output') + 1]);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes, { flag: 'wx' });
      out({ ok: true, scope, record: skill, entrypoint, snapshot_id: selectedSnapshot, version_id: version,
        path, ref, source: 'local_snapshot', output, reused: false, bytes: bytes.length, freshness: observedFreshness });
    } else {
      const text = bytes.toString('utf8');
      out({ ok: true, scope, record: skill, entrypoint, snapshot_id: selectedSnapshot, version_id: version,
        path, ref, source: 'notion', content: text, range: { start: 1, end: text.split('\n').length, total_lines: text.split('\n').length }, has_more: false, freshness: observedFreshness });
    }
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
