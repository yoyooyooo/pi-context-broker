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
  assert.equal(actual.cliSourceRevision, consumptionGateConfiguration().cliRevision.trim());
});

test('the single CLI pin is read as one exact commit and changing that pin updates both workflow inputs', () => {
  const config = structuredClone(consumptionGateConfiguration());
  config.cliRevision = 'b'.repeat(40) + '\n';
  assert.equal(validateConsumptionGates(config).cliSourceRevision, 'b'.repeat(40));
  config.cliRevision = 'c'.repeat(40);
  assert.equal(validateConsumptionGates(config).cliSourceRevision, 'c'.repeat(40));
  for (const value of [undefined, null, '', 'main\n', 'A'.repeat(40), 'g'.repeat(40),
    'a'.repeat(39), 'a'.repeat(41), ' ' + 'a'.repeat(40), 'a'.repeat(40) + ' ',
    'a'.repeat(40) + '\n\n', 'a'.repeat(40) + '\r\n', 'a'.repeat(40) + '\n' + 'b'.repeat(40)]) {
    config.cliRevision = value;
    assert.throws(() => validateConsumptionGates(config), { code: 'GATE_SDK_BUILD_INPUT_MISSING' });
  }
});

test('the pin output must come from its unique unconditional main-job producer and exact checkout chain', () => {
  const original = consumptionGateConfiguration();
  const selector = original.workflows[0].text.match(/^      - name: Select frozen CLI input\n[\s\S]*?(?=^      - name: )/mu)?.[0];
  assert.ok(selector);
  const cases = [
    ['root checkout from another ref', text => text.replace('      - name: Select frozen CLI input\n', '        with:\n          ref: main\n      - name: Select frozen CLI input\n'), 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['missing producer', text => text.replace(selector, ''), 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['duplicate producer', text => text.replace(selector, selector + selector), 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['different producer id', text => text.replace('        id: cli-input\n', '        id: impostor\n'), 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['conditional producer', text => text.replace('        id: cli-input\n', '        id: cli-input\n        if: false\n'), 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['ignored producer failure', text => text.replace('        id: cli-input\n', '        id: cli-input\n        continue-on-error: true\n'), 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['forged producer value', text => text.replace('$(cat .github/ntn-skills-cli-revision)', 'a'.repeat(40)), 'GATE_SDK_BUILD_INPUT_DRIFT'],
    ['different pin file', text => text.replace('$(cat .github/ntn-skills-cli-revision)', '$(cat .github/other-cli-revision)'), 'GATE_SDK_BUILD_INPUT_DRIFT'],
    ['redirected pin directory', text => text.replace('        id: cli-input\n', '        id: cli-input\n        working-directory: elsewhere\n'), 'GATE_SDK_BUILD_INPUT_DRIFT'],
    ['wrong output destination', text => text.replace('>> "$GITHUB_OUTPUT"', '>> "$GITHUB_ENV"'), 'GATE_SDK_BUILD_INPUT_DRIFT'],
    ['different output producer', text => text.replace('steps.cli-input.outputs.revision', 'steps.impostor.outputs.revision'), 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['different output key', text => text.replace('steps.cli-input.outputs.revision', 'steps.cli-input.outputs.commit'), 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['fallback checkout expression', text => text.replace('steps.cli-input.outputs.revision }}', "steps.cli-input.outputs.revision || 'main' }}"), 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['retired literal revision', text => text.replace('ref: ${{ steps.cli-input.outputs.revision }}', 'ref: ' + 'a'.repeat(40)), 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['producer after checkout', text => text.replace(selector, '').replace('      - name: Build pinned CLI SDK\n', selector + '      - name: Build pinned CLI SDK\n'), 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['producer in another job', text => text.replace(selector, '') + '\n  impostor:\n    steps:\n' + selector, 'GATE_SDK_BUILD_INPUT_MISSING'],
    ['skipped selected build', text => text.replace('      - name: Build pinned CLI SDK\n', '      - name: Build pinned CLI SDK\n        if: false\n'), 'GATE_SDK_BUILD_INPUT_MISSING'],
  ];
  for (const [name, mutate, code] of cases) {
    const config = structuredClone(original), before = config.workflows[0].text;
    config.workflows[0].text = mutate(before);
    assert.notEqual(config.workflows[0].text, before, name + ' must change the real workflow.');
    assert.throws(() => validateConsumptionGates(config), { code }, name);
  }
});

test('missing consumption, drifting CLI input and skipped current HTTP gate are rejected', () => {
  const cases = [
    [value => { value.packageScripts.check = 'bun run test'; }, 'GATE_CONSUMPTION_MISSING'],
    [value => { value.rootScripts['check:broker'] = 'bun run build:broker'; }, 'GATE_PACKAGE_CHECK_MISSING'],
    [value => { value.rootScripts.check = value.rootScripts.check.replace('bun run build:broker', 'bun run build'); }, 'GATE_BROKER_TARGET_MISSING'],
    [value => { value.packageScripts['test:consumption'] = value.packageScripts['test:consumption'].replace('scripts/notion-sdk.test.ts', ''); }, 'GATE_TEST_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('NTN_SKILLS_BUILD_ENTRY:', 'UNUSED_ENTRY:'); }, 'GATE_SDK_BUILD_INPUT_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('ref: ${{ inputs.tag || github.ref }}', 'ref: main'); }, 'GATE_SDK_BUILD_INPUT_MISSING'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('ref: ${{ steps.cli-input.outputs.revision }}', 'ref: main'); }, 'GATE_SDK_BUILD_INPUT_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('$(cat .github/ntn-skills-cli-revision)', '$(cat .github/other-cli-revision)'); }, 'GATE_SDK_BUILD_INPUT_DRIFT'],
    [value => { value.workflows[0].text = value.workflows[0].text.replace('node: [24.22.3, 26.13.1]', 'node: [22.23.5, 24.22.3, 26.13.1]'); }, 'GATE_TOOLCHAIN_VERSION'],
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
    [value => { value.workflows[1].text = value.workflows[1].text.replace('artifact=verified-release-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}', 'artifact=verified-release'); }, 'GATE_RELEASE_HANDOFF_MISSING'],
    [value => { value.workflows[1].text = value.workflows[1].text.replace('name: ${{ needs.main.outputs.verified_artifact }}', 'name: verified-release'); }, 'GATE_RELEASE_HANDOFF_MISSING'],
  ];
  for (const [mutate, code] of cases) {
    const config = structuredClone(consumptionGateConfiguration()), before = JSON.stringify(config); mutate(config);
    assert.notEqual(JSON.stringify(config), before, 'A negative fixture must change the current configuration.');
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
