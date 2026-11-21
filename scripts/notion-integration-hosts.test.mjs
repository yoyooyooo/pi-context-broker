import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectLiveCatalogRecord, projectedResourceRef, measuredConsumptionArgs } from './notion-integration-hosts.mjs';
import { nativeEntries, verifyPreparedDiagnostic, verifyPreparedProviderBody, defaultContextVerificationBudget, defaultContextResourceEntry } from './notion-default-context.mjs';
import { createNotionFixture, database, firstViewId, missingRef, missingPageId } from './notion-integration-fixture.mjs';
import { confirmedViewActivation, verifyPartialViewCoverage } from './notion-view-discovery.mjs';

test('the controlled management fixture accepts only current ctl views and retains exact argv', async t => {
  const base = await mkdtemp(join(tmpdir(), 'broker-ctl-fixture-'));
  t.after(() => { if (process.platform === 'darwin') assert.equal(spawnSync('/usr/bin/trash', [base]).status, 0); });
  const fixture = await createNotionFixture(base);
  const call = args => spawnSync(fixture.command[0], [...fixture.command.slice(1), ...args], { encoding: 'utf8', timeout: 10000 });
  const args = ['ctl', 'views', '--database', database, '--offline'];
  const listed = call(args); assert.equal(listed.status, 0, listed.stderr);
  const response = JSON.parse(listed.stdout);
  assert.equal(response.ok, true); assert.equal(response.count, 2); assert.equal(response.views[0].id, firstViewId);
  await fixture.setScenario('normal', { noViews: true });
  assert.deepEqual(JSON.parse(call(args).stdout), { ok: true, views: [], count: 0 });
  for (const retired of [['views'], ['doctor'], ['cache', 'identity'], ['list'], ['ctl', 'prepare', fixture.skillRef], ['read', fixture.skillRef], ['export', fixture.snapshotId]]) {
    const rejected = call(retired); assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stdout).error.code, 'UNSUPPORTED_CONTROLLED_OPERATION');
  }
  const calls = (await readFile(fixture.callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.slice(0, 2).map(call => [call.command, call.args, call.operation]), [['ctl', args.slice(1), 'views'], ['ctl', args.slice(1), 'views']]);
});

function partialViewSample() {
  const page = '11111111-1111-4111-8111-111111111111', id = 'shared_skill:fixture:' + page, ref = 'sr:C' + 'x'.repeat(22);
  const fixture = { scope: 'b'.repeat(64), skillRef: 'skill://' + encodeURIComponent(id) + '/SKILL.md', name: 'UI Alpha', alias: 'ui-alpha', canary: 'ROOT_BODY', resourceCanary: 'RESOURCE_BODY' };
  const record = { id, kind: 'skill', enabled: true, default_context: true, name: fixture.name, alias: fixture.alias, entrypoint: 'SKILL.md', ref: fixture.skillRef,
    description: 'Use the selected workflow.', locator: { type: 'shared_skill', library_id: 'fixture', skill_id: page, page_id: page, database_id: database, data_source_id: '44444444-4444-4444-8444-444444444444' } };
  const response = { ok: true, scope: fixture.scope, view: { id: firstViewId, database_id: database }, count: 1, records: [record],
    coverage: { method: 'explicit_view', exhaustive: false, failed_sources: [{ id: missingPageId, code: 'NOT_FOUND' }] } };
  const directory = '<ntn-skills-view-catalog><view source="notion" id="' + firstViewId + '" database="' + database + '" origin="first" partial="true">Default work</view>'
    + '<catalog-cards><group kind="skill" source="notion"><card name="UI Alpha" location="' + ref + '">Use the selected workflow.</card></group></catalog-cards></ntn-skills-view-catalog>';
  const entries = [{ id: 'candidate', type: 'custom', customType: 'context-broker-short-ref', data: { version: 1, ref,
    target: { kind: 'candidate', identity: { source: 'notion', scope: fixture.scope, id: record.id, kind: record.kind, locator: record.locator, ref: 'skill://' + encodeURIComponent(id) } } } },
    { id: 'message', parentId: 'candidate', type: 'message', message: { role: 'user', content: 'Describe available names.' } }];
  return { host: 'pi', context: { messages: [{ role: 'system', content: directory }] }, response, entries, fixture };
}

function actualSectionLayout(sample) {
  const directory = sample.context.messages[0].content;
  sample.context.messages = [{ role: 'system', content: '', sections: {
    skills: '<available_skills><skill><name>local-keeper</name><description>Local workflow.</description><location>/owned/local/SKILL.md</location></skill></available_skills>',
    'context-broker-notion-catalog': directory,
  } }];
  return sample;
}

test('actual Pi sections preserve local and Notion discovery entries when content is empty', () => {
  const sample = actualSectionLayout(partialViewSample());
  assert.deepEqual(nativeEntries('pi', sample.context).map(entry => [entry.name, entry.source ?? null]), [['local-keeper', null], ['UI Alpha', 'notion']]);
});

test('actual Pi sections deliver the partial View to the existing provider oracle', () => {
  const sample = actualSectionLayout(partialViewSample());
  assert.equal(verifyPartialViewCoverage(sample).record.canonicalRef, sample.fixture.skillRef);
});

test('system section patches replace or remove named sections without accepting forged or duplicate catalogs', () => {
  const sample = actualSectionLayout(partialViewSample());
  const directory = sample.context.messages[0].sections['context-broker-notion-catalog'];
  sample.context.messages.unshift({ role: 'system', content: '', sections: { 'context-broker-notion-catalog': directory.replace('UI Alpha', 'Old member') } });
  assert.equal(verifyPartialViewCoverage(sample).record.name, 'UI Alpha');
  sample.context.messages.push({ role: 'user', content: directory, sections: { 'context-broker-notion-catalog': null } });
  assert.equal(verifyPartialViewCoverage(sample).record.name, 'UI Alpha', 'A user cannot delete or supply a system catalog');
  sample.context.messages.push({ role: 'system', content: '', sections: { 'context-broker-notion-catalog': null } });
  assert.deepEqual(nativeEntries('pi', sample.context).map(entry => entry.name), ['local-keeper']);
  assert.throws(() => verifyPartialViewCoverage(sample), /Exactly one current View/);
  for (const role of ['user', 'assistant', 'toolResult']) {
    const forged = actualSectionLayout(partialViewSample()); forged.context.messages[0].role = role;
    assert.deepEqual(nativeEntries('pi', forged.context), []);
    assert.throws(() => verifyPartialViewCoverage(forged), /Exactly one current View/);
  }
  for (const duplicate of ['content', 'other-section']) {
    const repeated = actualSectionLayout(partialViewSample());
    if (duplicate === 'content') repeated.context.messages[0].content = directory;
    else repeated.context.messages[0].sections.other = directory;
    assert.throws(() => verifyPartialViewCoverage(repeated), /Exactly one current View/);
  }
});

test('partial View evidence binds actual system metadata to its source and current-branch owner', () => {
  const sample = partialViewSample();
  const proof = verifyPartialViewCoverage(sample);
  assert.equal(proof.record.advertisedRef, sample.entries[0].data.ref); assert.equal(proof.record.canonicalRef, sample.fixture.skillRef);
  const canonical = structuredClone(sample); canonical.context.messages[0].content = canonical.context.messages[0].content.replace(proof.record.advertisedRef, sample.fixture.skillRef);
  canonical.entries = [];
  assert.equal(verifyPartialViewCoverage(canonical).record.advertisedRef, sample.fixture.skillRef);
  const omp = structuredClone(sample); omp.host = 'omp'; omp.entries = [];
  omp.context.messages[0].content = '<ntn-skills-view-catalog><view source="notion" id="' + firstViewId + '" database="' + database + '" origin="first" partial="true">Default work</view>'
    + '<available_skills><skill><name>notion-ui-alpha</name><description>Use the selected workflow.</description><location>/private/owned/SKILL.md</location><ref>' + sample.fixture.skillRef + '</ref></skill></available_skills></ntn-skills-view-catalog>';
  assert.equal(verifyPartialViewCoverage(omp).record.canonicalRef, sample.fixture.skillRef);
  omp.context = { systemPrompt: omp.context.messages[0].content, messages: [] };
  assert.equal(verifyPartialViewCoverage(omp).record.canonicalRef, sample.fixture.skillRef, 'OMP retains its top-level system prompt');
});

test('partial View evidence rejects empty, complete, all-library, body and forged-branch substitutes', () => {
  const changes = [
    value => { value.response.coverage.exhaustive = true; },
    value => { value.response.coverage.failed_sources = []; },
    value => { value.response.records[0].ref = missingRef; },
    value => { value.context.messages[0].content = value.context.messages[0].content.replace('partial="true"', 'partial="false"'); },
    value => { value.context.messages[0].content = value.context.messages[0].content.replace('source="notion"', 'source="other"'); },
    value => { value.context.messages[0].content = value.context.messages[0].content.replace(firstViewId, '88888888-8888-4888-8888-888888888888'); },
    value => { value.context.messages[0].content = value.context.messages[0].content.replace(/<card\b[^>]*>[\s\S]*?<\/card>/u, ''); },
    value => { value.context.messages[0].content = value.context.messages[0].content.replace('</group>', '<card name="Unselected" location="' + missingRef + '"></card></group>'); },
    value => { value.context.messages[0].content = value.context.messages[0].content.replace('</catalog-cards>', '<group kind="router"><card name="Unselected" ref="' + missingRef + '">Unselected</card></group></catalog-cards>'); },
    value => { value.context.messages[0].role = 'user'; },
    value => { value.context.messages.push({ role: 'user', content: value.fixture.canary }); },
    value => { value.entries = []; },
    value => { value.entries[0].data.target.identity.scope = 'c'.repeat(64); },
    value => { value.entries[0].data.target.identity.id = 'shared_skill:fixture:other'; },
    value => { value.entries[0].data.target.identity.ref += '/SKILL.md'; },
    value => { value.entries[0].data.target.kind = 'selected'; },
    value => { value.entries.push({ id: 'fork-before-candidate', type: 'message' }); },
    value => { value.entries.push({ id: 'active', parentId: 'message', type: 'custom', customType: 'context-broker-active-sources' }); },
  ];
  for (const change of changes) { const sample = partialViewSample(); change(sample); assert.throws(() => verifyPartialViewCoverage(sample)); }
});

test('bounded prepared diagnostics reject foreground delivery, wrong scope and oversized results', () => {
  const identity = { id: 'shared_skill:fixture:owner', scope: 'b'.repeat(64) };
  const job = { purpose: 'prefetch', state: 'prepared', sourceId: 'notion', loaded: false, epoch: 0,
    budget: { ...defaultContextVerificationBudget }, preparedNodes: 1, instructionBytes: 17, contextBytes: 1000,
    records: [{ ...identity, snapshotId: 's_' + 'a'.repeat(64), bodySha256: 'c'.repeat(64), bytes: 17 }] };
  assert.deepEqual(verifyPreparedDiagnostic(job, identity), job.records[0]);
  for (const changed of [
    { ...job, purpose: 'foreground', state: 'ready' }, { ...job, loaded: true }, { ...job, body: 'secret' },
    { ...job, records: [{ ...job.records[0], scope: 'd'.repeat(64) }] },
    { ...job, records: [{ ...job.records[0], id: 'shared_skill:fixture:unselected' }] },
    { ...job, contextBytes: job.budget.maxBytes + 1 }, { ...job, preparedNodes: 2 },
  ]) assert.throws(() => verifyPreparedDiagnostic(changed, identity));
});

test('OMP compatibility derives a resource only from the delivered owner directory', () => {
  const context = { messages: [{ role: 'user', content: '<context-broker-record name="Skill A"><skill-directory>/private/tmp/owned/root</skill-directory><body>complete</body></context-broker-record>' }] };
  assert.equal(defaultContextResourceEntry('omp', context, 'Skill A', 'references/ledger.md'), '/private/tmp/owned/root/references/ledger.md');
  assert.throws(() => defaultContextResourceEntry('omp', context, 'Other', 'references/ledger.md'));
  assert.throws(() => defaultContextResourceEntry('omp', context, 'Skill A', '../sibling.md'));
  assert.throws(() => defaultContextResourceEntry('omp', { messages: [{ role: 'user', content: context.messages[0].content.replace('/private/tmp/owned/root', 'redacted') }] }, 'Skill A', 'references/ledger.md'));
  assert.throws(() => defaultContextResourceEntry('pi', context, 'Skill A', 'references/ledger.md'), /resource directory/);
});

test('a prepared hash proves delivery only when the full body is in the provider payload', () => {
  const body = 'Complete & exact source\nRequired trailing line\n';
  const prepared = { bytes: Buffer.byteLength(body), bodySha256: createHash('sha256').update(body).digest('hex') };
  const wrap = value => ({ messages: [{ role: 'user', content: '<context-broker-record name="Skill A"><body>\n' + value.replaceAll('&', '&amp;') + '\n</body></context-broker-record>' }] });
  assert.deepEqual(verifyPreparedProviderBody(wrap(body), 'Skill A', prepared), { bytes: prepared.bytes, sha256: prepared.bodySha256 });
  assert.throws(() => verifyPreparedProviderBody(wrap('Complete & exact source'), 'Skill A', prepared), /partial body/);
  assert.throws(() => verifyPreparedProviderBody({ messages: [{ role: 'toolResult', details: prepared, content: [] }] }, 'Skill A', prepared));
  assert.throws(() => verifyPreparedProviderBody(wrap(body), 'Other', prepared));
});

test('View compaction restoration requires a confirmation on the current branch and its exact fixed vector', () => {
  const expected = { id: 'shared_skill:fixture:owner', scope: 'b'.repeat(64), snapshotId: 's_' + 'a'.repeat(64), bodySha256: 'c'.repeat(64), bytes: 204 };
  const binding = { record: { id: expected.id }, scope: expected.scope, snapshot_id: expected.snapshotId, body_sha256: expected.bodySha256 };
  const graph = { purpose: 'use', scope: expected.scope, roots: [expected.id], required: [], bindings: [binding] };
  const source = { ...expected, record: { id: expected.id, source: 'notion', sourceId: 'notion', sourceScope: expected.scope, preparationBinding: binding } };
  const start = { id: 'selected', type: 'custom', customType: 'context-broker-selected-graph', data: { graphs: [graph] } };
  const receipt = { id: 'confirmed', parentId: start.id, type: 'custom', customType: 'context-broker-active-sources', data: { activation_id: 'delivery', graphs: [graph], sources: [source] } };
  const leaf = { id: 'ordinary', parentId: receipt.id, type: 'message' };
  assert.equal(confirmedViewActivation([start, receipt, leaf], expected).activationId, 'delivery');
  assert.throws(() => confirmedViewActivation([start, receipt, { ...leaf, parentId: start.id }], expected), /confirmation/);
  assert.throws(() => confirmedViewActivation([start, receipt, leaf], { ...expected, snapshotId: 's_' + 'd'.repeat(64) }), /snapshotId/);
  assert.throws(() => confirmedViewActivation([start, receipt, leaf], { ...expected, scope: 'd'.repeat(64) }));
  const wrong = structuredClone(receipt); wrong.data.graphs[0].purpose = 'inspect';
  assert.throws(() => confirmedViewActivation([start, wrong, leaf], expected));
});

test('provider metadata preserves author names, explicit sources and distinct same-name handles', () => {
  const entry = (source, location) => '<catalog-cards><group kind="skill" source="' + source + '"><card name="真实 Skill &amp; A" location="' + location + '">A &lt; B</card></group></catalog-cards>';
  const context = { messages: [{ role: 'system', content: entry('notion', 'sr:C' + 'a'.repeat(22)) + entry('notion', 'sr:C' + 'b'.repeat(22)) + entry('other', 'skill://shared_skill%3Aowner/SKILL.md?snapshot=s_fixed&amp;file_id=main') }] };
  assert.deepEqual(nativeEntries('pi', context), [
    { name: '真实 Skill & A', source: 'notion', filePath: 'sr:C' + 'a'.repeat(22), catalog: 'prompt-metadata' },
    { name: '真实 Skill & A', source: 'notion', filePath: 'sr:C' + 'b'.repeat(22), catalog: 'prompt-metadata' },
    { name: '真实 Skill & A', source: 'other', filePath: 'skill://shared_skill%3Aowner/SKILL.md?snapshot=s_fixed&file_id=main', catalog: 'prompt-metadata' },
  ]);
});

test('fixed public refs select their exact owner without replacing the requested version', () => {
  const id = 'shared_skill:library-a:owner', page = '11111111-1111-4111-8111-111111111111';
  const record = { id, name: '真实 Skill & A', alias: 'shared-alias', locator: { type: 'shared_skill', page_id: page, library_id: 'library-a', skill_id: 'owner', database_id: database, data_source_id: '44444444-4444-4444-8444-444444444444' }, ref: 'skill://' + encodeURIComponent(id) + '/SKILL.md' };
  const other = { ...record, id: 'shared_skill:other:owner', locator: { ...record.locator, library_id: 'other', page_id: '22222222-2222-4222-8222-222222222222' }, ref: 'skill://shared_skill%3Aother%3Aowner/SKILL.md' };
  const fixed = record.ref + '?snapshot=s_' + 'a'.repeat(64) + '&file_id=main';
  assert.equal(selectLiveCatalogRecord([record, other], fixed), record);
  assert.equal(selectLiveCatalogRecord([record, other], 'skill://' + page.replaceAll('-', '') + '/SKILL.md'), record);
  assert.equal(selectLiveCatalogRecord([record], 'skill://' + encodeURIComponent(record.name) + '/SKILL.md'), record);
  assert.throws(() => selectLiveCatalogRecord([record, other], 'skill://shared-alias/SKILL.md'), /exactly one/);
  assert.throws(() => selectLiveCatalogRecord([record], other.ref), /exactly one/);
  assert.throws(() => selectLiveCatalogRecord([{ ...record, locator: { type: 'notion_page', page_id: page } }], fixed), /exactly one/);
  assert.equal(record.ref.includes('snapshot='), false, 'The selected metadata is not rewritten into a current or fixed ref');
});

test('resource reads copy the supplied reference of the one selected body', () => {
  const ref = 'sr:R' + 'x'.repeat(22);
  const projection = '<context-broker-record kind="skill" name="Skill &amp; A" ref="sr:S' + 'a'.repeat(22) + '"><body>complete source</body><resources>' + JSON.stringify([{ path: 'references/a&b.md', ref }]).replaceAll('&', '&amp;') + '</resources></context-broker-record>';
  const context = { messages: [{ role: 'user', content: projection }] };
  assert.equal(projectedResourceRef(context, 'Skill & A', 'references/a&b.md'), ref);
  assert.throws(() => projectedResourceRef(context, 'Other', 'references/a&b.md'), /one actual provider/);
  assert.throws(() => projectedResourceRef(context, 'Skill & A', 'references/unknown.md'), /belong/);
  assert.throws(() => projectedResourceRef({ messages: [...context.messages, ...context.messages] }, 'Skill & A', 'references/a&b.md'), /one actual provider/);
});

test('the existing CLI ledger respects each public command output contract', () => {
  for (const args of [['use', 'skill://a/SKILL.md'], ['list'], ['read', 'skill://a/SKILL.md'], ['files', 's_fixed']])
    assert.deepEqual(measuredConsumptionArgs(args), [...args, '--json', '--metrics']);
  for (const args of [['prepare', 'skill://a/SKILL.md'], ['ctl', 'prepare', 'skill://a/SKILL.md']])
    assert.throws(() => measuredConsumptionArgs(args), /prepare protocol is retired/);
  assert.throws(() => measuredConsumptionArgs(['ctl', 'prepare', 'a', '--metrics']), /prepare protocol is retired/);
  assert.deepEqual(measuredConsumptionArgs(['use', 'a', '--json', '--metrics']), ['use', 'a', '--json', '--metrics']);
  assert.deepEqual(measuredConsumptionArgs(['read', 'a', '--raw']), ['read', 'a', '--raw']);
  assert.deepEqual(measuredConsumptionArgs(['ctl', 'doctor']), ['ctl', 'doctor']);
});
