import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionsFromCapture } from './manifest.mjs';

const brokerSha = 'a'.repeat(64), observerSha = 'b'.repeat(64), otherSha = 'c'.repeat(64);
const buildRoot = '/owned/builds/candidate', runRoot = '/owned/runs/capture';

function fixture(mode = 'directory') {
  const packageRoot = mode === 'packed' ? buildRoot + '/installed/broker/node_modules/pi-context-broker' : buildRoot + '/broker';
  const path = mode === 'packed' ? '$BUILD/installed/broker/node_modules/pi-context-broker/src/index.ts' : '$BUILD/broker/src/index.ts';
  const build = { root: buildRoot, packages: { broker: { files: [{ path: 'src/index.ts', sha256: brokerSha }] } },
    ...(mode === 'packed' ? { candidate: { mode, root: buildRoot + '/installed', packages: { broker: {
      name: 'pi-context-broker', root: packageRoot, entry: packageRoot + '/src/index.ts',
      closure: { root: packageRoot, files: [{ path: 'src/index.ts', sha256: brokerSha }] },
    } } } } : {}) };
  return { buildRoot, runRoot, build, projection: { mode: 'broker',
    launch_profile: { extensions: [{ role: 'broker', path, sha256: brokerSha }] },
    extensions: [{ path, resolved_path: path, entry: { path, realpath: path, sha256: brokerSha } },
      { path: '<inline:benchmark-observer>', resolved_path: '<inline:benchmark-observer>', entry: null }],
    visibility: { projection: { files: [{ path: 'benchmark/runtime/episode-runner.mjs', sha256: observerSha }] } },
    pi: { files: [] } } };
}

for (const mode of ['directory', 'packed']) test('capture identifies the exact ' + mode + ' paired Broker', () => {
  const input = fixture(mode);
  const extensions = extensionsFromCapture(input);
  const prefix = mode === 'packed' ? '/installed/broker/node_modules/pi-context-broker' : '/broker';
  assert.deepEqual(extensions, [
    { id: 'broker-0', role: 'broker', path: buildRoot + prefix + '/src/index.ts', sha256: brokerSha },
    { id: 'observer-1', role: 'observer', path: runRoot + '/subject-runtime/benchmark/runtime/episode-runner.mjs', sha256: observerSha },
  ]);
});

test('native capture contains the observer and no Broker declaration or implementation', () => {
  const input = fixture('packed'); input.projection.mode = 'native';
  input.projection.launch_profile.extensions = []; input.projection.extensions.shift();
  assert.deepEqual(extensionsFromCapture(input).map(extension => extension.role), ['observer']);
});

const rejected = [
  ['missing declaration', p => { p.launch_profile.extensions = []; }],
  ['Broker disguised as common', p => { p.launch_profile.extensions[0].role = 'common'; }],
  ['declaration outside the frozen package', p => { p.launch_profile.extensions[0].path = '/outside/index.ts'; }],
  ['declaration with wrong bytes', p => { p.launch_profile.extensions[0].sha256 = otherSha; }],
  ['duplicate declaration', p => { p.launch_profile.extensions.push({ ...p.launch_profile.extensions[0] }); }],
  ['unloaded declaration', p => { p.extensions.shift(); }],
  ['loaded path outside the frozen package', p => { p.extensions[0].path = '/outside/index.ts'; }],
  ['different resolved path', p => { p.extensions[0].resolved_path = '/outside/index.ts'; }],
  ['different entry path', p => { p.extensions[0].entry.path = '/outside/index.ts'; }],
  ['different real path', p => { p.extensions[0].entry.realpath = '/outside/index.ts'; }],
  ['different loaded bytes', p => { p.extensions[0].entry.sha256 = otherSha; }],
  ['duplicate loaded Broker', p => { p.extensions.push(structuredClone(p.extensions[0])); }],
  ['a path alias instead of the captured canonical path', p => { p.extensions[0].path = '$BUILD/installed/../installed/broker/node_modules/pi-context-broker/src/index.ts'; }],
  ['another Broker-looking path', p => {
    const path = '$BUILD/broker/pretender/index.ts'; p.launch_profile.extensions[0].path = path;
    p.extensions[0] = { path, resolved_path: path, entry: { path, realpath: path, sha256: otherSha } };
  }],
  ['a native Broker declared common', p => { p.mode = 'native'; p.launch_profile.extensions[0].role = 'common'; }],
  ['Broker bytes copied outside the native launch', p => {
    p.mode = 'native'; p.launch_profile.extensions = [];
    const path = '/outside/renamed.ts'; p.extensions[0] = { path, resolved_path: path, entry: { path, realpath: path, sha256: brokerSha } };
  }],
];
for (const [name, change] of rejected) test('capture rejects ' + name, () => {
  const input = fixture('packed'); change(input.projection);
  assert.throws(() => extensionsFromCapture(input), assert.AssertionError);
});

test('observer-looking filenames do not acquire the inline observer role', () => {
  const input = fixture('packed'), path = '/external/benchmark-observer-copy.mjs';
  input.projection.extensions.push({ path, resolved_path: path, entry: { path, realpath: path, sha256: otherSha } });
  assert.equal(extensionsFromCapture(input).at(-1).role, 'common');
});


test('MCP factory identity comes from the pinned SDK implementation, without a fabricated entry path', () => {
  const input = fixture();
  input.projection.extensions.push({ path: 'builtin:mcp', resolved_path: 'builtin:mcp', entry: null });
  assert.throws(() => extensionsFromCapture(input), /no actual implementation identity/);
  input.projection.pi.files.push({ path: '/pinned-pi/dist/extensions/mcp/index.js', sha256: otherSha });
  assert.deepEqual(extensionsFromCapture(input).at(-1), { id: 'common-2', role: 'common', path: '/pinned-pi/dist/extensions/mcp/index.js', sha256: otherSha });
});


test('explicit builtin implementation identity survives opaque labels and paths without reversal', () => {
  const input = fixture();
  const file = { path: '/pinned-pi/dist/extensions/tool-REDACTED_CREDENTIAL/index.js', realpath: '/pinned-pi/dist/extensions/tool-REDACTED_CREDENTIAL/index.js', sha256: otherSha, bytes: 10 };
  input.projection.pi.files.push(file);
  input.projection.pi.entry = { path: '/pinned-pi/dist/index.js', sha256: observerSha };
  input.projection.extensions.push({ path: 'builtin:tool_REDACTED_CREDENTIAL', resolved_path: 'builtin:tool_REDACTED_CREDENTIAL', entry: file });
  assert.deepEqual(extensionsFromCapture(input).at(-1), { id: 'common-2', role: 'common', path: file.path, sha256: otherSha });
  input.projection.extensions.at(-1).entry = null;
  assert.throws(() => extensionsFromCapture(input), /no actual implementation identity/);
});

for (const [name, directory] of [['codemode', 'codemode'], ['tool_search', 'tool-search'], ['mcp', 'mcp']]) {
  test('historical ' + name + ' capture retains its observed-file fallback', () => {
    const input = fixture(), file = { path: '/pinned-pi/dist/extensions/' + directory + '/index.js', sha256: otherSha };
    input.projection.extensions.push({ path: 'builtin:' + name, resolved_path: 'builtin:' + name, entry: null });
    input.projection.pi.files.push(file);
    assert.deepEqual(extensionsFromCapture(input).at(-1), { id: 'common-2', role: 'common', path: file.path, sha256: otherSha });
  });
}


test('new builtin evidence rejects missing and inconsistent implementation identities', () => {
  const input = fixture(), file = { path: '/pinned-pi/dist/extensions/codemode/index.js', realpath: '/pinned-pi/dist/extensions/codemode/index.js', sha256: otherSha, bytes: 10 };
  input.projection.pi.entry = { path: '/pinned-pi/dist/index.js', sha256: observerSha };
  input.projection.pi.files.push(file);
  input.projection.extensions.push({ path: 'builtin:codemode', resolved_path: 'builtin:codemode', entry: null });
  assert.throws(() => extensionsFromCapture(input), /no actual implementation identity/);
  for (const change of [{ sha256: brokerSha }, { realpath: '/unobserved/index.js' }, { bytes: 11 }, { path: '/unobserved/index.js' }]) {
    input.projection.extensions.at(-1).entry = { ...file, ...change };
    assert.throws(() => extensionsFromCapture(input), assert.AssertionError);
  }
  input.projection.extensions.at(-1).entry = file;
  input.projection.pi.files.push({ ...file });
  assert.throws(() => extensionsFromCapture(input), /must have one observed file/);
});
