import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { mkdtemp, mkdir, writeFile, realpath, symlink } from 'node:fs/promises';
import { systemTempRoot } from './verification-paths.mjs';
import { createPiHelpBoundary } from './notion-pi-help.mjs';

async function fixture() {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'pi-help-boundary-'));
  const root = path.join(base, '@earendil-works', 'pi-coding-agent');
  await mkdir(path.join(root, 'docs'), { recursive: true }); await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', bin: { pi: 'dist/cli.js' } }));
  await writeFile(path.join(root, 'dist/cli.js'), '// controlled host\n');
  const files = { 'README.md': 'Host docs. [Linked](docs/linked.md)\n', 'docs/extensions.md': 'Extensions.\n',
    'docs/codemode.md': 'Codemode.\n', 'docs/linked.md': 'Explicitly linked help.\n', 'docs/unadvertised.md': 'Not advertised.\n' };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
  const canonical = await realpath(root), executable = path.join(canonical, 'dist/cli.js');
  const system = '<docs>\nPi documentation (read only when asked about Pi):\n- Main documentation: ' + canonical + '/README.md\n- Additional docs: ' + canonical + '/docs\n- When asked about: extensions (docs/extensions.md), codemode (docs/codemode.md)\n</docs>';
  return { root: canonical, executable, system, files, boundary: createPiHelpBoundary({ fs, path, crypto, executable }) };
}

test('actual system docs admit the four observed help reads while a misspelled package and unadvertised files remain blocked', async () => {
  const { root, system, files, boundary } = await fixture();
  const main = path.join(root, 'README.md');
  boundary.observeProvider({ messages: [{ role: 'assistant', content: system }, { role: 'user', content: system }] });
  assert.equal(boundary.target(main), undefined, 'Only actual system docs can advertise host help');
  assert.equal(boundary.observeProvider({ messages: [{ role: 'system', content: system }] }).length, 3);
  for (const file of ['README.md', 'docs/extensions.md', 'docs/extensions.md', 'docs/codemode.md']) {
    const target = boundary.target(path.join(root, file));
    assert.equal(target.role, 'host-help'); assert.equal(target.content, files[file]);
    assert.equal(boundary.verifyRead(target.path, files[file]).complete, true);
  }
  assert.equal(boundary.target(root.replace('@earendil-works', '@earenquil-works') + '/examples/extensions/'), undefined);
  assert.equal(boundary.target(path.join(root, 'docs/unadvertised.md')), undefined);
  assert.equal(boundary.target(root + '/docs/../README.md'), undefined);
  assert.equal(boundary.target(path.join(root, 'docs')), undefined);
  assert.equal(boundary.consumed().length, 3);
});

test('only a complete successful help read can discover its in-package markdown references, with symlinks rejected', async () => {
  const { root, system, files, boundary } = await fixture();
  boundary.observeProvider({ messages: [{ role: 'system', content: system }] });
  const main = path.join(root, 'README.md'), linked = path.join(root, 'docs/linked.md');
  assert.equal(boundary.target(linked), undefined);
  assert.equal(boundary.verifyRead(main, 'Host docs.').complete, false);
  assert.equal(boundary.target(linked), undefined);
  assert.equal(boundary.verifyRead(main, files['README.md'], true).complete, false);
  assert.equal(boundary.target(linked), undefined);
  assert.equal(boundary.verifyRead(main, files['README.md']).complete, true);
  assert.equal(boundary.target(linked).role, 'host-help');
  await symlink(path.join(root, 'docs/extensions.md'), path.join(root, 'docs/alias.md'));
  boundary.observeProvider({ messages: [{ role: 'system', content: system.replace('docs/codemode.md', 'docs/alias.md') }] });
  assert.equal(boundary.target(path.join(root, 'docs/alias.md')), undefined);
  const outside = path.join(path.dirname(root), 'outside.md'); await writeFile(outside, 'Outside.');
  assert.equal(boundary.target(outside), undefined);
});
