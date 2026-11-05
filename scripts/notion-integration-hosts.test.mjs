import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { selectIntegrationHosts, selectIntegrationPrefetch, selectLiveCatalogRecord, projectedResourceRef, measuredConsumptionArgs } from './notion-integration-hosts.mjs';
import { nativeEntries } from './notion-default-context.mjs';

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

test('the existing CLI ledger measures use and ctl prepare with valid JSON arguments', () => {
  for (const args of [['use', 'skill://a/SKILL.md'], ['ctl', 'prepare', 'skill://a/SKILL.md'], ['list'], ['read', 'skill://a/SKILL.md'], ['files', 's_fixed']])
    assert.deepEqual(measuredConsumptionArgs(args), [...args, '--json', '--metrics']);
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
