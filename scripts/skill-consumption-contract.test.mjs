import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { consumptionGateConfiguration, validateConsumptionGates } from './skill-consumption-contract.mjs';

test('current CI and publish use one installed SDK v2 HTTP gate without claiming Pi acceptance', () => {
  const actual = validateConsumptionGates();
  assert.equal(actual.status, 'gate-wiring-valid');
  assert.equal(actual.sdkVersion, 2);
  assert.equal(actual.installedSdk, 'required_current_http');
  assert.equal(actual.piSession, 'not_run');
  assert.equal(actual.providerModel, 'not_run');
  assert.deepEqual(actual.deferredHosts, ['OMP', 'Tern']);
});

test('missing consumption, drifting CLI input and skipped current HTTP gate are rejected', () => {
  const cases = [
    [value => { value.packageScripts.check = 'bun run test'; }, 'GATE_CONSUMPTION_MISSING'],
    [value => { value.rootScripts['check:broker'] = 'bun run build:broker'; }, 'GATE_PACKAGE_CHECK_MISSING'],
    [value => { value.rootScripts.check = value.rootScripts.check.replace('bun run build:broker', 'bun run build'); }, 'GATE_BROKER_TARGET_MISSING'],
    [value => { value.packageScripts['test:consumption'] = value.packageScripts['test:consumption'].replace('scripts/notion-sdk.test.ts', ''); }, 'GATE_TEST_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('NTN_SKILLS_BUILD_ENTRY:', 'UNUSED_ENTRY:'); }, 'GATE_SDK_BUILD_INPUT_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace(/(repository: yoyooyooo\/notion-skills-cli\s+ref: )[a-f0-9]{40}/u, '$1main'); }, 'GATE_SDK_BUILD_INPUT_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace(/(repository: yoyooyooo\/notion-skills-cli\s+ref: )[a-f0-9]{40}/u, '$1' + 'a'.repeat(40)); }, 'GATE_SDK_BUILD_INPUT_DRIFT'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('node: [22.23.5, 24.22.3, 26.13.1]', 'node: [22.22.3, 24.20.0]'); }, 'GATE_TOOLCHAIN_VERSION'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('--catalog', '--catalog --distinct-names'); }, 'GATE_RETIRED_PATH'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('Create current SDK fixture\n', 'Create current SDK fixture\n        if: false\n'); }, 'GATE_CURRENT_FIXTURE_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('Installed current SDK consumption\n', 'Installed current SDK consumption\n        continue-on-error: true\n'); }, 'GATE_INSTALLED_SDK_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace(' --source-http-helper "$GITHUB_WORKSPACE/.verification/ntn-skills-cli/scripts/sdk-source-fixture.mjs"', ''); }, 'GATE_INSTALLED_SDK_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('if: always()', 'if: success()'); }, 'GATE_RESULTS_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('environment: npm-publish', 'environment: bypass'); }, 'GATE_RELEASE_POLICY_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('npm publish "$TARBALL"', 'npm publish packages/context-broker'); }, 'GATE_RELEASE_POLICY_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('cancel-in-progress: false', 'cancel-in-progress: true'); }, 'GATE_RELEASE_POLICY_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('Verify registry, cold install, and provenance\n', 'Verify registry, cold install, and provenance\n        if: false\n'); }, 'GATE_RELEASE_POLICY_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('needs: main', 'needs: []'); }, 'GATE_RELEASE_POLICY_MISSING'],
  ];
  for (const [mutate, code] of cases) {
    const config = structuredClone(consumptionGateConfiguration()); mutate(config);
    assert.throws(() => validateConsumptionGates(config), { code });
  }
});

test('retired artifact arguments fail before building or creating an artifact workspace', () => {
  const script = fileURLToPath(new URL('./verify-artifacts.mjs', import.meta.url));
  for (const args of [[], ['--host', 'pi'], ['--host', 'omp'], ['--require-sdk'], ['--name-fixture', '/missing']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Artifact workspace retained:/);
  }
});
