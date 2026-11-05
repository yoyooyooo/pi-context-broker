import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { selectIntegrationHosts, selectIntegrationPrefetch, selectLiveCatalogRecord, projectedResourceRef, measuredConsumptionArgs } from './notion-integration-hosts.mjs';
import { nativeEntries, verifyPreparedDiagnostic, verifyPreparedProviderBody, defaultContextVerificationBudget, defaultContextResourceEntry } from './notion-default-context.mjs';
import { createNotionFixture } from './notion-integration-fixture.mjs';
import { confirmedViewActivation } from './notion-view-discovery.mjs';

test('controlled CLI preserves actual ctl argv and explicit legacy aliases', async t => {
  const base = await mkdtemp(join(tmpdir(), 'broker-ctl-fixture-'));
  t.after(() => { if (process.platform === 'darwin') assert.equal(spawnSync('/usr/bin/trash', [base]).status, 0); });
  const fixture = await createNotionFixture(base);
  await fixture.setScenario('normal', { cacheIdentity: true });
  const call = args => {
    const result = spawnSync(fixture.command[0], [...fixture.command.slice(1), ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const args of [['views'], ['doctor'], ['cache', 'identity', '--database', 'fixture']]) {
    const legacy = call(args), current = call(['ctl', ...args]);
    assert.deepEqual(current, legacy);
    assert.equal(current.ok, true);
  }
  const calls = (await readFile(fixture.callsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(call => call.command === 'ctl').map(call => [call.command, call.args[0], call.operation]),
    [['ctl', 'views', 'views'], ['ctl', 'doctor', 'doctor'], ['ctl', 'cache', 'cache']]);
  const prepared = call(['ctl', 'prepare', fixture.skillRef, '--purpose', 'inspect', '--metrics']);
  assert.equal(prepared.status, 'ready'); assert.equal(prepared.purpose, 'inspect');
  const rejected = spawnSync(fixture.command[0], [...fixture.command.slice(1), 'prepare', fixture.skillRef, '--json'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).error.code, 'INVALID_ARGUMENT', 'The wire fixture must not hide an invalid public prepare argv');
});

test('bounded prepared diagnostics reject foreground delivery, wrong scope and oversized results', () => {
  const identity = { id: 'notion_page:owner', scope: 'b'.repeat(64) };
  const job = { purpose: 'prefetch', state: 'prepared', sourceId: 'notion', loaded: false, epoch: 0,
    budget: { ...defaultContextVerificationBudget }, preparedNodes: 1, instructionBytes: 17, contextBytes: 1000,
    records: [{ ...identity, snapshotId: 's_' + 'a'.repeat(64), bodySha256: 'c'.repeat(64), bytes: 17 }] };
  assert.deepEqual(verifyPreparedDiagnostic(job, identity), job.records[0]);
  for (const changed of [
    { ...job, purpose: 'foreground', state: 'ready' }, { ...job, loaded: true }, { ...job, body: 'secret' },
    { ...job, records: [{ ...job.records[0], scope: 'd'.repeat(64) }] },
    { ...job, records: [{ ...job.records[0], id: 'notion_page:unselected' }] },
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
  const expected = { id: 'notion_page:owner', scope: 'b'.repeat(64), snapshotId: 's_' + 'a'.repeat(64), bodySha256: 'c'.repeat(64), bytes: 204 };
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

test('default verification keeps the existing two-host contract', () => {
  assert.deepEqual(selectIntegrationHosts({}), ['pi', 'omp']);
});

test('provider metadata preserves author names, explicit sources and distinct same-name handles', () => {
  const entry = (source, location) => '<skill><name>真实 Skill &amp; A</name><description>A &lt; B</description><source>' + source + '</source><location>' + location + '</location></skill>';
  const context = { messages: [{ role: 'system', content: entry('notion', 'sr:C' + 'a'.repeat(22)) + entry('notion', 'sr:C' + 'b'.repeat(22)) + entry('other', 'skill://shared_skill%3Aowner/SKILL.md?snapshot=s_fixed&amp;file_id=main') }] };
  assert.deepEqual(nativeEntries('pi', context), [
    { name: '真实 Skill & A', source: 'notion', filePath: 'sr:C' + 'a'.repeat(22), catalog: 'prompt-metadata' },
    { name: '真实 Skill & A', source: 'notion', filePath: 'sr:C' + 'b'.repeat(22), catalog: 'prompt-metadata' },
    { name: '真实 Skill & A', source: 'other', filePath: 'skill://shared_skill%3Aowner/SKILL.md?snapshot=s_fixed&file_id=main', catalog: 'prompt-metadata' },
  ]);
});

test('fixed public refs select their exact owner without replacing the requested version', () => {
  const id = 'shared_skill:library-a:owner', page = '11111111-1111-4111-8111-111111111111';
  const record = { id, name: '真实 Skill & A', alias: 'shared-alias', locator: { page_id: page }, ref: 'skill://' + encodeURIComponent(id) + '/SKILL.md' };
  const other = { ...record, id: 'shared_skill:other:owner', locator: { page_id: '22222222-2222-4222-8222-222222222222' }, ref: 'skill://shared_skill%3Aother%3Aowner/SKILL.md' };
  const fixed = record.ref + '?snapshot=s_' + 'a'.repeat(64) + '&file_id=main';
  assert.equal(selectLiveCatalogRecord([record, other], fixed), record);
  assert.equal(selectLiveCatalogRecord([record, other], 'skill://' + page.replaceAll('-', '') + '/SKILL.md'), record);
  assert.equal(selectLiveCatalogRecord([record], 'skill://' + encodeURIComponent(record.name) + '/SKILL.md'), record);
  assert.throws(() => selectLiveCatalogRecord([record, other], 'skill://shared-alias/SKILL.md'), /exactly one/);
  assert.throws(() => selectLiveCatalogRecord([record], other.ref), /exactly one/);
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
    assert.deepEqual(measuredConsumptionArgs(args), [...args, '--metrics']);
  assert.deepEqual(measuredConsumptionArgs(['ctl', 'prepare', 'a', '--metrics']), ['ctl', 'prepare', 'a', '--metrics']);
  assert.deepEqual(measuredConsumptionArgs(['use', 'a', '--json', '--metrics']), ['use', 'a', '--json', '--metrics']);
  assert.deepEqual(measuredConsumptionArgs(['read', 'a', '--raw']), ['read', 'a', '--raw']);
  assert.deepEqual(measuredConsumptionArgs(['ctl', 'doctor']), ['ctl', 'doctor']);
});

for (const host of ['pi', 'omp']) {
  test(`${host} selection contains no implicit sibling host`, () => {
    assert.deepEqual(selectIntegrationHosts({ host }), [host]);
  });
  for (const feature of ['sharedCatalog', 'cacheLifecycle']) {
    test(`${feature} cannot claim cross-host acceptance from ${host} alone`, () => {
      assert.throws(() => selectIntegrationHosts({ host, [feature]: true }), /require multiple hosts/);
    });
  }
}

test('unknown, blank and combined host selections fail explicitly', () => {
  for (const host of ['', 'tern', 'all', 'pi,omp', null, ['pi']]) {
    assert.throws(() => selectIntegrationHosts({ host }), /--host must be/);
  }
});

test('each default selection is independently owned', () => {
  const hosts = selectIntegrationHosts({});
  hosts.pop();
  assert.deepEqual(selectIntegrationHosts({}), ['pi', 'omp']);
});

test('runner uses selected hosts for probes and all per-host acceptance branches', async () => {
  const source = await readFile(new URL('./verify-notion-integration.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('selectIntegrationHosts({ host: options.host, sharedCatalog, cacheLifecycle })'));
  assert.ok(source.includes("if(selectedHosts.includes('omp'))manifest.branches.push(await runSourceLifecycle"));
  assert.ok(!source.includes("for(const host of ['pi','omp'])"));
  assert.ok(!source.includes("mode==='model'?modelHosts"));
  assert.ok(source.includes('selectedHosts,defaultContext'));
});

test('real model has a separately recorded bounded multi-step budget', async () => {
  const source = await readFile(new URL('./notion-integration-model.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('const promptTimeoutMs = 300_000;'));
  assert.ok(source.includes('timeoutMs: promptTimeoutMs'));
  assert.ok(source.includes('model: options.model, promptTimeoutMs, files'));
  assert.ok(source.includes("phase === 'assistant_final' && row.success && row.bytes > 0"));
  assert.ok(source.includes('result.failureKind'));
  const rpc = await readFile(new URL('../packages/context-broker/scripts/context-broker-rpc-harness.mjs', import.meta.url), 'utf8');
  assert.ok(rpc.includes('timeoutMs = 120_000'));
});

test('verification prefetch is explicit and preserves the default policy', () => {
  assert.equal(selectIntegrationPrefetch(undefined), undefined);
  assert.equal(selectIntegrationPrefetch('false'), false);
  assert.equal(selectIntegrationPrefetch('true'), true);
  for (const value of ['', 'FALSE', false, 0, null]) assert.throws(() => selectIntegrationPrefetch(value), /--prefetch/);
});
test('ordinary live and both model routes use the selected real-source prefetch policy', async () => {
  const normal = await readFile(new URL('./verify-notion-integration.mjs', import.meta.url), 'utf8');
  assert.ok(normal.includes('prefetch:selectedPrefetch'));
  for (const file of ['notion-integration-model.mjs', 'notion-consumer-model.mjs']) {
    const source = await readFile(new URL('./' + file, import.meta.url), 'utf8');
    assert.ok(source.includes('prefetch: selectIntegrationPrefetch(options.prefetch)'));
  }
});
