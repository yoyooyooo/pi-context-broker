import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tool = new URL('./migrate-content-assets.mjs', import.meta.url).pathname;
test('historical Bundle conversion changes only catalog/session schema and retains authored bytes and paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-conversion-regression-'));
  const opaque = { sourceBytes: 'bundle: authored kind="bundle"\n', snapshotBytes: 'context-broker:bundle: pinned\n', resourcePath: 'assets/bundle:literal.bin', kind: 'bundle', bundles: { literal: 'bundle: untouched' } };
  const input = { bundles: { legacy: { kind: 'bundle', id: 'bundle:legacy', ref: 'bundle:legacy', description: 'bundle: literal', members: [{ path: 'bundle:literal/SKILL.md' }] } }, retained: opaque };
  const source = join(root, 'input.json'), output = join(root, 'output.json');
  const bytes = JSON.stringify(input);
  await writeFile(source, bytes);
  const run = spawnSync(process.execPath, [tool, source, output], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const actual = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(actual.retained, opaque);
  assert.deepEqual(actual.routers.legacy, { ...input.bundles.legacy, kind: 'router', id: 'router:legacy', ref: 'router:legacy', members: [{ path: 'bundle:literal/SKILL.md', type: 'local' }] });
  assert.equal(await readFile(source, 'utf8'), bytes);
  const entry = { type: 'custom', customType: 'context-broker', content: 'kind="bundle" authored bundle: text', details: { kind: 'bundle', sourceId: 'source', sourceScope: 'scope', sourceSkillId: '11111111111141118111111111111111', snapshotId: 'bundle:opaque', ...{ retained: opaque } } };
  const session = join(root, 'session.jsonl'), converted = join(root, 'current.jsonl');
  await writeFile(session, JSON.stringify(entry) + '\n');
  const next = spawnSync(process.execPath, [tool, session, converted], { encoding: 'utf8' });
  assert.equal(next.status, 0, next.stderr);
  const message = JSON.parse(await readFile(converted, 'utf8'));
  assert.equal(message.content, entry.content);
  assert.deepEqual(message.details.retained, opaque);
  assert.equal(message.details.snapshotId, entry.details.snapshotId);
  assert.equal(message.details.kind, 'router');
  assert.equal(message.details.recordId, 'notion_page:11111111-1111-4111-8111-111111111111');
  assert.equal(message.details.identity, JSON.stringify(['source', 'scope', 'router', 'notion_page', message.details.recordId]));
  const occupied = spawnSync(process.execPath, [tool, source, output], { encoding: 'utf8' });
  assert.notEqual(occupied.status, 0);
  // Keep failed assertions' inputs; successful owned scratch goes through system Trash.
  if (process.platform === 'darwin') assert.equal(spawnSync('/usr/bin/trash', [root]).status, 0);
});
