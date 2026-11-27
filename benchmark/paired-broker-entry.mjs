import assert from 'node:assert/strict';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The frozen paired build owns the public Broker entry in either installation mode. */
export function pairedBrokerEntry(build, buildRoot = build.root) {
  assert.ok(isAbsolute(buildRoot)); assert.equal(build.root, buildRoot);
  const mode = build.candidate ? build.candidate.mode : 'directory';
  assert.ok(['directory', 'packed'].includes(mode), 'Unknown paired installation mode');
  let root = join(buildRoot, 'broker'), path = join(root, 'src/index.ts'), installed;
  if (mode === 'packed') {
    assert.equal(build.candidate.root, join(buildRoot, 'installed'));
    installed = build.candidate.packages?.broker;
    assert.equal(installed?.name, 'pi-context-broker');
    root = join(buildRoot, 'installed/broker/node_modules/pi-context-broker');
    assert.equal(installed.root, root); path = installed.entry;
    assert.ok(typeof path === 'string' && isAbsolute(path) && resolve(path) === path);
    assert.ok(path.startsWith(root + sep), 'The Broker entry must belong to its frozen installed package');
  }
  const name = relative(root, path);
  const files = build.packages.broker.files.filter(file => file.path === name);
  assert.equal(files.length, 1, 'The public Broker entry needs one frozen package identity');
  assert.match(files[0].sha256, /^[a-f0-9]{64}$/u);
  if (installed) {
    assert.equal(installed.closure.root, root);
    const archived = installed.closure.files.filter(file => file.path === name);
    assert.equal(archived.length, 1, 'The installed Broker entry needs one archive identity');
    assert.equal(archived[0].sha256, files[0].sha256, 'The installed and built Broker entries differ');
  }
  return { path, sha256: files[0].sha256 };
}
