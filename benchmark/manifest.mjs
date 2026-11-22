import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fingerprint, validateEnvironmentManifest } from './protocol.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Material bindings vary by case; their exact startup expectations are frozen in the execution plan. */
export async function environmentFromCapture({ id, environmentRoot, buildId, expectationFile, runResultFile, expectationSet, corpusSha256, sourceKind, codeMode = 'free' }) {
  const expectationBytes = await readFile(expectationFile), expectation = JSON.parse(expectationBytes);
  assert.equal(expectation.kind, 'benchmark-pi-sdk-expectation');
  const p = expectation.projection;
  assert.equal(p.entry_kind, 'pi-sdk');
  const shared = JSON.parse(await readFile(runResultFile, 'utf8'));
  assert.equal(shared.runtime_check.status, 'unchanged'); assert.equal(shared.frozen_artifacts, 'passed');
  const actualRuntime = shared.runtime_check.after;
  assert.equal(actualRuntime.node.sha256, p.node.sha256);
  assert.equal(actualRuntime.bun.sha256, p.bun.sha256, 'SDK and shared launcher selected different Bun files');
  assert.ok(actualRuntime.bun.version, 'Actual Bun version was not observed');
  if (actualRuntime.git !== undefined || p.git !== undefined) {
    assert.equal(actualRuntime.git?.status, 'observed', 'Shared Git identity must be observed');
    assert.equal(actualRuntime.git.sha256, p.git?.sha256, 'SDK and shared launcher selected different Git files');
    assert.equal(actualRuntime.git.path, p.git.realpath, 'SDK and shared launcher selected different Git paths');
    assert.equal(actualRuntime.git.version, p.git.version, 'SDK and shared launcher observed different Git versions');
  }
  const buildBytes = await readFile(join(environmentRoot, 'builds', buildId, 'build.json')), build = JSON.parse(buildBytes);
  assert.equal(p.build.sha256, sha(buildBytes), 'Capture used another paired build');
  const sdk = p.pi.files.find(file => file.path.endsWith('/pi-coding-agent/dist/index.js'));
  assert.ok(sdk, 'Actual maintained SDK module was not observed');
  const sdkPackageFile = build.packages.cli.files.find(file => file.path === 'dist/sdk.js');
  assert.ok(sdkPackageFile?.sha256, 'Complete paired CLI SDK identity is missing');
  const observer = p.visibility.projection.files.find(file => file.path === 'benchmark/runtime/episode-runner.mjs');
  assert.ok(observer);
  if (p.mode === 'native') assert.equal(p.native_roots.length, 1, 'The native manifest requires its single observed task root');
  const physicalPath = path => path.startsWith('$BUILD/') ? join(environmentRoot, 'builds', buildId, path.slice(7))
    : path.startsWith('$RUN/') ? join(dirname(runResultFile), path.slice(5)) : path;
  const extensions = p.extensions.map((extension, index) => {
    const role = extension.path.includes('$BUILD/broker/') ? 'broker' : extension.path.includes('benchmark-observer') ? 'observer' : 'common';
    let file = extension.entry;
    if (!file && extension.path === 'builtin:codemode') file = p.pi.files.find(file => file.path.endsWith('/extensions/codemode/index.js'));
    if (!file && extension.path === 'builtin:tool_search') file = p.pi.files.find(file => file.path.endsWith('/extensions/tool-search/index.js'));
    if (!file && role === 'observer') file = { path: '$RUN/subject-runtime/' + observer.path, sha256: observer.sha256 };
    assert.ok(file?.sha256, 'A loaded extension has no actual implementation identity: ' + extension.path);
    return { id: role + '-' + index, role, path: physicalPath(file.path), sha256: file.sha256 };
  });
  const value = { schema_version: 1, id, status: 'frozen', paired_environment_id: build.environment_id,
    build: { id: buildId, receipt_sha256: sha(buildBytes),
      cli: { commit: build.sources.cli.commit, source_sha256: build.sources.cli.sha256, package_sha256: build.packages.cli.sha256, sdk_sha256: sdkPackageFile.sha256 },
      broker: { commit: build.sources.broker.commit, source_sha256: build.sources.broker.sha256, package_sha256: build.packages.broker.sha256 } },
    runtime: { node: { version: p.node_version, entry: p.node.path, sha256: p.node.sha256 },
      pi: { version: p.pi.version, entry: sdk.path, sha256: sdk.sha256 },
      bun: { version: actualRuntime.bun.version, entry: p.bun.path, sha256: p.bun.sha256 },
      ...(p.git ? { git: { version: p.git.version, entry: p.git.realpath, sha256: p.git.sha256 } } : {}) },
    pi: { mode: p.mode, entry_kind: 'pi-sdk', entry: sdk.path, config_sha256: fingerprint({ settings: p.settings, broker: p.broker_config, factories: p.factories }),
      extensions, tools: p.tools.all.map(({ name, description, parameters }) => ({ name, description, parameters })),
      active_tools: p.tools.active, catalog_sha256: fingerprint(expectationSet),
      sources: [{ id: 'canonical-corpus', kind: sourceKind ?? (p.mode === 'native' ? 'native' : 'local'), content_sha256: corpusSha256 }],
      native_root: p.mode === 'native' ? { path: '${RUN_ROOT}/skills/native', content_sha256: p.native_roots[0].sha256 } : null,
      guidance_sha256: fingerprint(p.system_prompt), injection_sha256: fingerprint({ context: p.initial_context, request: expectation.request_contract }),
      return_contract_sha256: fingerprint({ tools: p.tools.all, runtime_files: p.pi.files, paired_cli_sdk: sdkPackageFile.sha256, broker_package: build.packages.broker.sha256, scope: 'implemented-return-contract' }),
      error_contract_sha256: fingerprint({ runtime_files: p.pi.files, paired_cli_sdk: sdkPackageFile.sha256, broker_package: build.packages.broker.sha256, scope: 'implemented-error-contract' }) },
    policies: { cache: 'cold', session: 'episode_private', recovery: 'none', code_mode: codeMode }, manifest_sha256: null };
  value.manifest_sha256 = fingerprint(value);
  const checked = validateEnvironmentManifest(value, { stage: 'execute' });
  assert.ok(checked.valid, JSON.stringify(checked.errors));
  return value;
}
