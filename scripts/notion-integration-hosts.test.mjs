import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { selectIntegrationHosts } from './notion-integration-hosts.mjs';

test('default verification keeps the existing two-host contract', () => {
  assert.deepEqual(selectIntegrationHosts({}), ['pi', 'omp']);
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
