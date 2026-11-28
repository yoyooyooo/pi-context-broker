#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const check = (condition, code, message) => {
  if (!condition) throw Object.assign(new Error(message), { code });
};

export function consumptionGateConfiguration() {
  const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  let cliRevision;
  try { cliRevision = readFileSync(new URL('../.github/ntn-skills-cli-revision', import.meta.url), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { cliRevision, rootScripts: json('../package.json').scripts, packageScripts: json('../packages/context-broker/package.json').scripts,
    workflows: ['ci', 'publish'].map(name => ({ name, text: readFileSync(new URL('../.github/workflows/' + name + '.yml', import.meta.url), 'utf8') })) };
}

function pinnedCliInput(workflow) {
  const missing = message => check(false, 'GATE_SDK_BUILD_INPUT_MISSING', workflow.name + ': ' + message);
  const jobs = workflow.text.split(/^jobs:\n/mu);
  if (jobs.length !== 2) missing('The current main job must select the CLI input.');
  const mainJobs = jobs[1].split(/(?=^  [a-zA-Z_][a-zA-Z0-9_-]*:\n)/mu)
    .filter(value => value.startsWith('  main:\n'));
  if (mainJobs.length !== 1) missing('The current main job must be unique.');
  const main = mainJobs[0], steps = main.split(/(?=^      - name: )/mu);
  const step = name => {
    const found = steps.filter(value => value.startsWith('      - name: ' + name + '\n'));
    return found.length === 1 ? found[0].trimEnd() : '';
  };
  const checkout = step('Checkout'), selector = step('Select frozen CLI input'),
    source = step('Checkout pinned CLI SDK'), build = step('Build pinned CLI SDK');
  const unconditional = value => !/\n        (?:if|continue-on-error):/u.test(value) && !/\|\|\s*true/u.test(value);
  const rootCheckout = workflow.name === 'ci'
    ? /^      - name: Checkout\n        uses: actions\/checkout@[a-f0-9]{40}(?: #[^\n]+)?$/u.test(checkout)
    : /^      - name: Checkout\n        uses: actions\/checkout@[a-f0-9]{40}(?: #[^\n]+)?\n        with:\n          fetch-depth: 0\n          ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}$/u.test(checkout);
  check(checkout && selector && source && build
    && rootCheckout
    && unconditional(checkout) && unconditional(selector) && unconditional(source) && unconditional(build)
    && (main.match(/^        id: cli-input$/gmu) ?? []).length === 1
    && main.indexOf(checkout) < main.indexOf(selector) && main.indexOf(selector) < main.indexOf(source)
    && main.indexOf(source) < main.indexOf(build),
    'GATE_SDK_BUILD_INPUT_MISSING', workflow.name + ' must bind one main-job CLI output before checkout and build.');
  check(selector === [
    '      - name: Select frozen CLI input',
    '        id: cli-input',
    '        run: echo "revision=$(cat .github/ntn-skills-cli-revision)" >> "$GITHUB_OUTPUT"',
  ].join('\n'), 'GATE_SDK_BUILD_INPUT_DRIFT',
  workflow.name + ' must produce revision from the single current CLI pin file.');
  check(/^      - name: Checkout pinned CLI SDK\n        uses: actions\/checkout@[a-f0-9]{40}(?: #[^\n]+)?\n        with:\n          repository: yoyooyooo\/notion-skills-cli\n          ref: \$\{\{ steps\.cli-input\.outputs\.revision \}\}\n          path: \.verification\/ntn-skills-cli\n          persist-credentials: false$/u.test(source)
    && build === [
      '      - name: Build pinned CLI SDK',
      '        working-directory: .verification/ntn-skills-cli',
      '        run: |',
      '          bun install --frozen-lockfile',
      '          bun run build',
    ].join('\n'), 'GATE_SDK_BUILD_INPUT_MISSING',
  workflow.name + ' must checkout the exact producer output and build that selected tree.');
  return main;
}

export function validateConsumptionGates(config = consumptionGateConfiguration()) {
  const revision = /^(?<revision>[a-f0-9]{40})\n?$/u.exec(typeof config.cliRevision === 'string' ? config.cliRevision : '');
  check(revision && revision[0] === config.cliRevision, 'GATE_SDK_BUILD_INPUT_MISSING', 'The single .github/ntn-skills-cli-revision file must contain one lowercase 40-hex commit.');
  for (const name of ['check', 'check:broker']) {
    check(config.rootScripts[name]?.includes('bun run --cwd packages/context-broker check'),
      'GATE_PACKAGE_CHECK_MISSING', name + ' must reach the actual package check.');
    check(config.rootScripts[name]?.includes('bun run build:broker'),
      'GATE_BROKER_TARGET_MISSING', name + ' must use the current Broker target.');
  }
  check(config.packageScripts.check?.split('&&').map(command => command.trim()).includes('bun run test:consumption'),
    'GATE_CONSUMPTION_MISSING', 'Package check must execute consumption tests.');
  const required = ['notion-sdk', 'notion-consumption-tools', 'pi-read-adapter', 'fixed-resource-source',
    'resource-read-host', 'session-active', 'native-read-session', 'host-prepare', 'skill-context-session'];
  for (const name of required) check(config.packageScripts['test:consumption']?.split(' ').includes('scripts/' + name + '.test.ts'),
    'GATE_TEST_MISSING', 'Required consumption regression is absent: ' + name);
  for (const path of ['scripts/pack-target.test.mjs', 'scripts/skill-consumption-contract.test.mjs',
    'scripts/verification-skill-routing.test.mjs', 'scripts/context-once-evidence.test.mjs', 'scripts/notion-sdk-pi.test.mjs',
    'scripts/verify-pi-daily-cache.test.mjs',
    'scripts/catalog-representation.test.mjs',
    'packages/context-broker/scripts/final-request-undici.test.ts'])
    check(config.rootScripts['test:verification']?.split(' ').includes(path), 'GATE_VERIFICATION_MISSING',
      'Required current check is absent: ' + path);
  check(config.workflows.length === 2 && new Set(config.workflows.map(row => row.name)).size === 2
    && config.workflows.some(row => row.name === 'ci') && config.workflows.some(row => row.name === 'publish'),
    'GATE_WORKFLOW_MISSING', 'Check CI and publish.');
  for (const workflow of config.workflows) {
    const text = workflow.text;
    const main = pinnedCliInput(workflow);
    check(main.includes('NTN_SKILLS_BUILD_ENTRY: ${{ github.workspace }}/.verification/ntn-skills-cli/packages/cli/dist/ntn-skills.js')
      && main.includes('CONTEXT_BROKER_GRAPH_CORE: ${{ github.workspace }}/.verification/ntn-skills-cli/packages/core/src'),
      'GATE_SDK_BUILD_INPUT_MISSING', workflow.name + ' must build and decode with one pinned current CLI.');
    const nodePinned = workflow.name === 'ci'
      ? text.includes('node: [24.22.3, 26.13.1]') && text.includes('node-version: ${{ matrix.node }}')
      : text.includes('node-version: 26.13.1');
    check(text.includes('bun-version: 1.4.3') && nodePinned,
      'GATE_TOOLCHAIN_VERSION', workflow.name + ' must use the pinned toolchain.');
    check(text.includes('run: bun run check:broker'), 'GATE_CHECK_MISSING', workflow.name + ' must run the current package check.');
    check(!/--distinct-names|--ambiguous-names|--name-fixture|--ambiguity-fixture|--host omp|pi14|Pi 1\.4|@oh-my-pi|context-broker-host-e2e|tern-context-broker\.tar/u.test(text),
      'GATE_RETIRED_PATH', workflow.name + ' may not restore old fixture or deferred host gates.');
    const steps = text.split(/(?=^      - name: )/mu);
    const step = name => steps.find(value => value.startsWith('      - name: ' + name + '\n')) ?? '';
    const unconditional = value => !/\n        (?:if|continue-on-error):/u.test(value) && !/\|\|\s*true/u.test(value);
    const fixture = step('Create current SDK fixture'), installed = step('Installed current SDK consumption');
    check(fixture.includes('run: node .verification/ntn-skills-cli/scripts/sdk-fixture.ts --outdir "$RUNNER_TEMP/ntn-skills-current-fixture" --catalog')
      && unconditional(fixture) && text.indexOf(fixture) < text.indexOf(installed)
      && (text.match(/sdk-fixture\.ts/g) ?? []).length === 1,
      'GATE_CURRENT_FIXTURE_MISSING', workflow.name + ' must create exactly one current service fixture.');
    check(installed.includes('run: node scripts/verify-artifacts.mjs --fixture "$RUNNER_TEMP/ntn-skills-current-fixture/fixture.json" --source-http-helper "$GITHUB_WORKSPACE/.verification/ntn-skills-cli/scripts/sdk-source-fixture.mjs"')
      && unconditional(installed), 'GATE_INSTALLED_SDK_MISSING', workflow.name + ' must run the actual installed SDK/Broker over current HTTP.');
    const retained = step('Preserve current SDK results');
    check(retained.includes('if: always()') && /uses: actions\/upload-artifact@[a-f0-9]{40} # v7\.0\.2/u.test(retained)
      && retained.includes('/tmp/broker-artifacts-*/') && retained.includes('${{ runner.temp }}/ntn-skills-current-fixture/')
      && retained.includes('include-hidden-files: true'), 'GATE_RESULTS_MISSING', workflow.name + ' must preserve actual package and HTTP results.');
    if (workflow.name === 'ci') {
      const piSteps = main.split(/(?=^      - name: )/mu)
        .filter(value => value.startsWith('      - name: Actual Pi cross-session cache\n'));
      const pi = piSteps.length === 1 ? piSteps[0] : '';
      const cacheCases = ['http-warm-restart', 'http-warm-directory-expired', 'http-smart-revalidate', 'http-smart-current'];
      const expected = [
        '      - name: Actual Pi cross-session cache',
        '        run: |',
        '          BROKER_PACKAGE=$(node -p \'require(process.argv[1]).package.installed\' "$RUNNER_TEMP/current-sdk-artifacts.json")',
        '          PI_ENTRY=$(node -p \'require(process.argv[1]).pi.entry.path\' "$RUNNER_TEMP/current-sdk-artifacts.json")',
        ...cacheCases.map(scenario => '          node scripts/notion-sdk-pi.mjs run --package "$BROKER_PACKAGE" --fixture "$RUNNER_TEMP/ntn-skills-current-fixture/fixture.json" --source-http-helper "$GITHUB_WORKSPACE/.verification/ntn-skills-cli/scripts/sdk-source-fixture.mjs" --pi "$PI_ENTRY" --out "$RUNNER_TEMP/' + scenario.replace(/^http-/, 'pi-') + '" --scenario ' + scenario),
      ].join('\n');
      check(installed.includes('--report "$RUNNER_TEMP/current-sdk-artifacts.json"')
        && pi.trimEnd() === expected && text.indexOf(installed) < text.indexOf(pi) && text.indexOf(pi) < text.indexOf(retained),
        'GATE_PI_CACHE_MISSING', 'CI must reuse the checked installed package and explicit public Pi entry.');
      for (const scenario of cacheCases) {
        const output = scenario.replace(/^http-/, 'pi-');
        check(retained.includes('${{ runner.temp }}/' + output + '/'), 'GATE_PI_CACHE_RESULTS_MISSING',
          'CI must preserve ' + scenario + ' process, complete wire and independent HTTP evidence.');
      }
      check(retained.includes('${{ runner.temp }}/current-sdk-artifacts.json'), 'GATE_PI_CACHE_RESULTS_MISSING',
        'CI must preserve the installed package and Pi identity handoff.');
    }
    if (workflow.name === 'publish') {
      check(!/^    strategy:/mu.test(text), 'GATE_PUBLISH_MATRIX', 'Publishing remains a single job.');
      const candidate = step('Record the checked candidate'), presence = step('Reconcile npm presence'),
        publish = step('Publish the checked archive'), registry = step('Verify registry, cold install, and provenance');
      check(text.includes('environment: npm-publish') && text.includes('run: bun scripts/pack.mjs --target broker')
        && text.includes('group: npm-publish-pi-context-broker') && text.includes('cancel-in-progress: false')
        && installed.includes('--archive "$TARBALL" --report "$RUNNER_TEMP/broker-release/installed.json"')
        && candidate.includes('scripts/release-evidence.mjs candidate') && unconditional(candidate)
        && presence.includes('scripts/release-evidence.mjs presence') && unconditional(presence)
        && publish.includes('npm publish "$TARBALL" --ignore-scripts --registry https://registry.npmjs.org --access public --provenance --tag latest')
        && unconditional(publish) && registry.includes('scripts/release-evidence.mjs verify') && unconditional(registry)
        && text.indexOf(installed) < text.indexOf(candidate) && text.indexOf(candidate) < text.indexOf(presence)
        && text.indexOf(presence) < text.indexOf(publish) && text.indexOf(publish) < text.indexOf(registry)
        && text.includes('  release:\n    needs: main\n'),
        'GATE_RELEASE_POLICY_MISSING', 'Keep the existing release approval and publication boundary.');
      const staged = step('Stage verified release inputs'), upload = step('Preserve verified release inputs'),
        download = step('Download verified release inputs');
      check(staged.includes('id: release_inputs')
        && staged.includes('artifact=verified-release-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}')
        && staged.includes('>> "$GITHUB_OUTPUT"') && unconditional(staged)
        && text.includes('verified_artifact: ${{ steps.release_inputs.outputs.artifact }}')
        && upload.includes('name: ${{ steps.release_inputs.outputs.artifact }}') && unconditional(upload)
        && !upload.includes('overwrite:')
        && download.includes('name: ${{ needs.main.outputs.verified_artifact }}')
        && text.indexOf(registry) < text.indexOf(staged),
        'GATE_RELEASE_HANDOFF_MISSING', 'Preserve each verified attempt and consume its producer-selected artifact.');
    }
  }
  return { status: 'gate-wiring-valid', sdkVersion: 3, requiredTests: required.length,
    cliSourceRevision: revision.groups.revision, installedSdk: 'required_current_http',
    piSession: 'not_run', providerModel: 'not_run', deferredHosts: ['OMP', 'Tern'],
    ciPiCache: ['http-warm-restart', 'http-warm-directory-expired', 'http-smart-revalidate', 'http-smart-current'],
    boundary: 'Wiring checks do not establish actual package execution or Pi daily-use acceptance.' };
}

function main(argv) {
  if (argv.length === 1 && argv[0] === 'check-gates') {
    console.log(JSON.stringify(validateConsumptionGates(), null, 2));
    return;
  }
  if (!argv.length || argv.length === 1 && ['help', '--help', '-h'].includes(argv[0])) {
    console.log('Usage: node scripts/skill-consumption-contract.mjs check-gates');
    console.log('Current wiring only. Actual package execution and Pi daily use require their own results.');
    return;
  }
  throw new Error('Retired matrix/evidence action. Use check-gates for the current bounded route.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'ERROR', message: error.message })); process.exitCode = 1; }
}
