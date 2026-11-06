import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { consumptionFixture, evaluateConsumptionEvidence, selfTest, validateMap, expandCoverage, consumptionGateConfiguration, validateConsumptionGates } from './skill-consumption-contract.mjs';
import { assertSupportedPiVersion } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';

test('installed Pi acceptance admits only the two explicitly supported releases', () => {
  for (const version of ['1.4.0', '1.5.0']) assert.doesNotThrow(() => assertSupportedPiVersion(version));
  for (const version of ['1.4.1', '1.5.1', '1.6.0', '1.5.0-beta.1', '1.5', 'v1.5.0', '', undefined])
    assert.throws(() => assertSupportedPiVersion(version), /must be exactly/);
});

test('normal checks and both workflows retain consumption and real Pi installation gates', () => {
  assert.equal(validateConsumptionGates().status, 'gate-wiring-valid');
  for (const [mutate, code] of [
    [value => { value.packageScripts.check = 'bun run test'; }, 'GATE_CONSUMPTION_MISSING'],
    [value => { value.rootScripts['check:broker'] = 'bun run build:broker'; }, 'GATE_PACKAGE_CHECK_MISSING'],
    [value => { value.packageScripts['test:consumption'] = value.packageScripts['test:consumption'].replace('scripts/session-active.test.ts', ''); }, 'GATE_TEST_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('@earendil-works/pi-coding-agent@1.5.0', '@earendil-works/pi-coding-agent@1.5.1'); }, 'GATE_PI_VERSION'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('@earendil-works/pi-coding-agent@1.4.0', '@earendil-works/pi-coding-agent@1.4.1'); }, 'GATE_PI_COMPATIBILITY_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('- name: Pi 1.4 compatibility\n', '- name: Pi 1.4 compatibility\n        if: false\n'); }, 'GATE_PI_COMPATIBILITY_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('BROKER_INSTALLED_PACKAGE: ${{ steps.installed-pi.outputs.package }}', 'BROKER_INSTALLED_PACKAGE: packages/context-broker'); }, 'GATE_PI_COMPATIBILITY_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('--scenario all --out "$RUNNER_TEMP/pi14-sdk-evidence"', '--scenario dollar --out "$RUNNER_TEMP/pi14-sdk-evidence"'); }, 'GATE_PI_COMPATIBILITY_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('    steps:\n', '    strategy:\n      matrix:\n        pi: [1.4.0, 1.5.0]\n    steps:\n'); }, 'GATE_PUBLISH_MATRIX'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('NTN_SKILLS_BUILD_ENTRY:', 'UNUSED_CLI_ENTRY:'); }, 'GATE_SDK_BUILD_INPUT_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace(/(repository: yoyooyooo\/notion-skills-cli\s+ref: )[a-f0-9]{40}/u, '$1main'); }, 'GATE_SDK_BUILD_INPUT_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace(/(repository: yoyooyooo\/notion-skills-cli\s+ref: )[a-f0-9]{40}/u, '$1' + 'a'.repeat(40)); }, 'GATE_SDK_BUILD_INPUT_DRIFT'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('bun-version: 1.4.3', 'bun-version: 1.3.14'); }, 'GATE_BUN_VERSION'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('run: node scripts/verify-artifacts.mjs --host pi', 'run: true'); }, 'GATE_INSTALLED_HOST_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('    steps:\n', '      INVALID_FIXTURE: ${{ runner.temp }}/fixture.json\n    steps:\n'); }, 'GATE_RUNNER_CONTEXT_SCOPE'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('sdk-fixture.ts --outdir "$RUNNER_TEMP/ntn-skills-sdk-fixture" --catalog', 'sdk-fixture.ts --outdir "$RUNNER_TEMP/ntn-skills-sdk-fixture"'); }, 'GATE_SDK_FIXTURE_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('- name: Create controlled SDK fixture\n', '- name: Create controlled SDK fixture\n        if: false\n'); }, 'GATE_SDK_FIXTURE_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace(' --fixture "$RUNNER_TEMP/ntn-skills-sdk-fixture/fixture.json"', ''); }, 'GATE_INSTALLED_SDK_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace(' --fixture "$RUNNER_TEMP/ntn-skills-sdk-fixture/fixture.json"', ' --fixture "$RUNNER_TEMP/unrelated/fixture.json"'); }, 'GATE_INSTALLED_SDK_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace(' --require-sdk', ''); }, 'GATE_INSTALLED_SDK_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('- name: Installed Pi artifact regression\n', '- name: Installed Pi artifact regression\n        continue-on-error: true\n'); }, 'GATE_INSTALLED_SDK_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('if: always()', 'if: success()'); }, 'GATE_SDK_EVIDENCE_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('/tmp/notion-sdk-pi-*/', '/tmp/unrelated-*/'); }, 'GATE_SDK_EVIDENCE_MISSING'],
  ]) {
    const config = consumptionGateConfiguration(); mutate(config);
    assert.throws(() => validateConsumptionGates(config), { code });
  }
});

test('installed name gates cannot omit their distinct fixture, required execution, evidence or compatibility route', () => {
  for (const mutate of [
    value => { value.workflows[0].text = value.workflows[0].text.replace(' --catalog --distinct-names', ' --catalog'); },
    value => { value.workflows[1].text = value.workflows[1].text.replace('- name: Create controlled name SDK fixture\n', '- name: Create controlled name SDK fixture\n        if: false\n'); },
    value => { value.workflows[1].text = value.workflows[1].text.replace(' --name-fixture "$RUNNER_TEMP/ntn-skills-name-fixture/fixture.json"', ''); },
    value => { value.workflows[0].text = value.workflows[0].text.replace(' --name-fixture "$RUNNER_TEMP/ntn-skills-name-fixture/fixture.json"', ' --name-fixture "$RUNNER_TEMP/unrelated/fixture.json"'); },
    value => { value.workflows[1].text = value.workflows[1].text.replace('${{ runner.temp }}/ntn-skills-name-fixture/', '${{ runner.temp }}/unrelated/'); },
    value => { value.workflows[0].text = value.workflows[0].text.replace('for scenario in name-references name-reference-failed-source;', 'for scenario in name-references;'); },
  ]) {
    const config = consumptionGateConfiguration(); mutate(config);
    assert.throws(() => validateConsumptionGates(config), { code: 'GATE_INSTALLED_NAMES_MISSING' });
  }
});

test('name fixture selection rejects an unrelated host, missing original fixture or relative path before packaging', () => {
  const driver = fileURLToPath(new URL('./verify-artifacts.mjs', import.meta.url));
  for (const args of [
    ['--host', 'omp', '--name-fixture', '/unopened/name-fixture.json'],
    ['--host', 'pi', '--name-fixture', '/unopened/name-fixture.json'],
    ['--host', 'pi', '--fixture', '/unopened/original.json', '--name-fixture', 'relative.json'],
  ]) {
    const result = spawnSync(process.execPath, [driver, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 1);
    assert.match(result.stderr, /--name-fixture/u);
    assert.doesNotMatch(result.stdout, /Artifact workspace retained/u);
  }
});

test('required installed SDK execution rejects missing fixture before packaging or host execution', () => {
  const driver = fileURLToPath(new URL('./verify-artifacts.mjs', import.meta.url));
  for (const args of [
    ['--host', 'pi', '--require-sdk'],
    ['--host', 'pi', '--fixture', '', '--require-sdk'],
  ]) {
    const result = spawnSync(process.execPath, [driver, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 1);
    assert.match(result.stderr, /--require-sdk/u);
    assert.doesNotMatch(result.stdout, /Artifact workspace retained/u, 'An absent CI fixture must not start the optional installation-only route');
  }
});

test('SC01 retains the full task and journey map without promoting draft routes', () => {
  const result = validateMap();
  assert.equal(result.tasks, 26);
  assert.equal(result.journeys, 26);
  const coverage = expandCoverage();
  assert.ok(coverage.length > 1000);
  assert.ok(coverage.every(row => ['not_run', 'not_applicable'].includes(row.status)));
  assert.ok(coverage.filter(row => row.status === 'not_applicable').every(row => row.reason));
  for (const axis of ['cache', 'session', 'entry', 'intent']) assert.ok(new Set(coverage.map(row => row[axis])).size > 3);
});

test('only observed provider spans prove complete delivery, independently of source hashes', () => {
  const fixture = consumptionFixture();
  assert.equal(evaluateConsumptionEvidence(fixture).status, 'evidence-contract-valid');
  assert.equal(evaluateConsumptionEvidence(fixture).productAcceptance, 'not-inferred');
  const summary = structuredClone(fixture);
  summary.providerInputs[0] = 'Skill loaded. Summary only.';
  assert.throws(() => evaluateConsumptionEvidence(summary), { code: 'DELIVERY_BYTES' });
  const cached = structuredClone(fixture); cached.deliveries = [];
  assert.throws(() => evaluateConsumptionEvidence(cached), { code: 'DELIVERY_MISSING' });
});

test('source and projection identities are independently verified', () => {
  for (const [mutate, code] of [
    [value => { value.sources[0].content += ' altered'; }, 'SOURCE_HASH'],
    [value => { value.projections[0].sourceSha256 = '0'.repeat(64); }, 'PROJECTION_SOURCE'],
    [value => { value.projections[0].content += ' altered'; }, 'PROJECTION_HASH'],
    [value => { value.deliveries[0].scope = 'other-credential-scope'; }, 'DELIVERY_IDENTITY'],
    [value => { value.deliveries[0].snapshot = 'other-version'; }, 'DELIVERY_IDENTITY'],
  ]) {
    const fixture = consumptionFixture(); mutate(fixture);
    assert.throws(() => evaluateConsumptionEvidence(fixture), { code });
  }
});

test('unobserved or truncated transport cannot establish zero calls', () => {
  for (const channel of ['notion', 'attachments', 'provider']) {
    for (const field of ['observed', 'complete']) {
      const fixture = consumptionFixture(); fixture.transport[channel][field] = false;
      assert.throws(() => evaluateConsumptionEvidence(fixture), { code: 'TRANSPORT_INCOMPLETE' });
    }
  }
  const fixture = consumptionFixture(); fixture.observerErrors.push('lost frame');
  assert.throws(() => evaluateConsumptionEvidence(fixture), { code: 'OBSERVER_FAILURE' });
});

test('log-only proof, duplicate content, oracle warming and suppressed failures are rejected', () => {
  for (const [mutate, code] of [
    [value => { value.providerInputs = []; }, 'PROVIDER_MISSING'],
    [value => { value.providerInputs[0] += value.projections[0].content; }, 'DUPLICATE_BODY'],
    [value => { value.isolation.oracleWarmedConsumer = true; }, 'ORACLE_WARMING'],
    [value => { value.isolation.hiddenLocalCopies = ['other-copy']; }, 'LOCAL_COPY'],
    [value => { value.isolation.forcedToolArguments = true; }, 'FORCED_TOOLS'],
    [value => { value.processes[0].closeObserved = false; }, 'PROCESS_EVIDENCE'],
    [value => { value.samples.retained = ['successful-run']; }, 'SAMPLE_LOSS'],
    [value => { value.cleanup.retainedEvidence = []; }, 'EVIDENCE_LOSS'],
  ]) {
    const fixture = consumptionFixture(); mutate(fixture);
    assert.throws(() => evaluateConsumptionEvidence(fixture), { code });
  }
});

test('compiled projections require a separately frozen contract and cannot replace the old graph gate', () => {
  const fixture = consumptionFixture();
  fixture.projections[0].compiler = 'unfrozen-minimal-projection';
  assert.throws(() => evaluateConsumptionEvidence(fixture), { code: 'PROJECTION_CONTRACT_DRAFT' });
});

test('offline self-test exercises the inherited anti-oracle contract and new observation failures', () => {
  const result = selfTest();
  assert.equal(result.status, 'passed');
  assert.ok(result.graph.tests >= 30);
  assert.ok(result.consumption.tests >= 15);
  assert.equal(result.productAcceptance, 'not-inferred');
});
