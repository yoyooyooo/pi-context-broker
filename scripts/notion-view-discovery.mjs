import { nativeFileRef, nativeSkillId } from '../packages/context-broker/src/native-reference.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { database, firstViewId, unflaggedCanary, missingCanary, missingPageId } from './notion-integration-fixture.mjs';
import { catalogCards, providerSystemText } from './notion-default-context.mjs';
import { decodeCatalogText } from './notion-integration-hosts.mjs';

function system(context) {
  return [Array.isArray(context.systemPrompt) ? context.systemPrompt.join('\n') : context.systemPrompt ?? '', providerSystemText(context)].filter(Boolean).join('\n');
}
function current(context) {
  const text = system(context);
  const matches = [...text.matchAll(/<ntn-skills-view-catalog>[\s\S]*?<\/ntn-skills-view-catalog>/g)];
  assert.equal(matches.length, 1, 'Exactly one current View directory in the model prompt');
  return matches[0][0];
}
const occurrences = (value, needle) => JSON.stringify(value).split(needle).length - 1;

function retainedBranch(entries) {
  const indexed = entries.filter(entry => typeof entry.id === 'string'), byId = new Map(indexed.map(entry => [entry.id, entry]));
  const branch = [], seen = new Set();
  let current = indexed.at(-1);
  while (current) {
    assert.ok(!seen.has(current.id), 'Native branch must not contain a cycle');
    seen.add(current.id); branch.unshift(current);
    if (!current.parentId) break;
    current = byId.get(current.parentId); assert.ok(current, 'Native branch parent must be retained');
  }
  return branch;
}

/** Inspect the retained native branch, not every historical entry in the file. */
export function confirmedViewActivation(entries, expected) {
  const branch = retainedBranch(entries);
  const receipts = branch.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-active-sources');
  const receipt = receipts.at(-1); assert.ok(receipt, 'A successful provider delivery must have an active-source confirmation');
  assert.equal(receipt.data.sources?.length, 1);
  const source = receipt.data.sources[0];
  assert.equal(source.record.source, 'notion'); assert.equal(source.record.sourceId, 'notion');
  assert.equal(source.record.id, expected.id); assert.equal(source.record.sourceScope, expected.scope);
  for (const key of ['snapshotId', 'bodySha256', 'bytes']) assert.equal(source[key], expected[key], `Confirmed ${key} must match the exact frozen source`);
  assert.equal(source.record.body, undefined, 'Confirmation metadata is not the delivered body');
  assert.equal(receipt.data.graphs?.length, 1);
  const graph = receipt.data.graphs[0];
  assert.equal(graph.purpose, 'use'); assert.equal(graph.scope, expected.scope);
  assert.deepEqual(graph.roots, [expected.id]); assert.deepEqual(graph.required, []); assert.equal(graph.bindings.length, 1);
  const binding = graph.bindings[0];
  assert.equal(binding.record.id, expected.id); assert.equal(binding.scope, expected.scope);
  assert.equal(binding.snapshot_id, expected.snapshotId); assert.equal(binding.body_sha256, expected.bodySha256);
  assert.deepEqual(source.record.preparationBinding, binding);
  return { entryId: receipt.id, activationId: receipt.data.activation_id, graph, source,
    selectedGraphEntries: branch.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-selected-graph').map(entry => ({ id: entry.id, data: entry.data })) };
}

/** Match a nonempty partial wire response to the actual system directory. */
export function verifyPartialViewCoverage({ host, context, response, entries, fixture }) {
  assert.equal(response.ok, true); assert.equal(response.scope, fixture.scope);
  assert.equal(response.view.id, firstViewId); assert.equal(response.view.database_id, database);
  assert.equal(response.count, 1);
  assert.deepEqual(response.records.map(record => record.ref), [fixture.skillRef]);
  assert.equal(response.coverage.method, 'explicit_view'); assert.equal(response.coverage.exhaustive, false);
  assert.deepEqual(response.coverage.failed_sources, [{ id: missingPageId, code: 'NOT_FOUND' }]);
  const record = response.records[0], directory = current(context);
  assert.equal(record.name, fixture.name); assert.equal(record.alias, fixture.alias);
  assert.equal(record.locator.type, 'shared_skill');
  assert.equal(record.enabled, true);
  assert.equal(record.id, nativeSkillId(record.locator.library_id, record.locator.skill_id));
  const owner = record.id;
  assert.equal(record.ref, nativeFileRef(owner, record.entrypoint));
  const views = [...directory.matchAll(/<view\b([^>]*)>/gu)];
  assert.equal(views.length, 1);
  const attributes = Object.fromEntries([...views[0][1].matchAll(/([a-z_]+)="([^"]*)"/gu)].map(match => [match[1], decodeCatalogText(match[2])]));
  assert.deepEqual(attributes, { source: 'notion', id: firstViewId, database, origin: 'first', partial: 'true' });
  const cards = catalogCards(directory).filter(card => card.kind === 'skill');
  assert.equal(cards.length, 1, 'Partial coverage must preserve the exact returned member, not all-library or empty fallback');
  assert.equal(catalogCards(directory).some(card => card.kind === 'router'), false, 'An unrelated Router cannot enter the selected View');
  const card = cards[0];
  assert.equal(card.name, host === 'pi' ? record.name : 'notion-' + record.alias);
  assert.equal(card.description, record.description);
  const ref = card.location; assert.ok(ref);
  const branch = retainedBranch(entries);
  assert.equal(branch.filter(entry => ['context-broker-selected-graph', 'context-broker-active-sources'].includes(entry.customType)).length, 0, 'Metadata cannot activate or confirm a Skill');
  if (host === 'pi') {
    assert.equal(card.source, 'notion');
    if (ref.startsWith('sr:')) {
      assert.match(ref, /^sr:C[A-Za-z0-9_-]{22}$/u);
      const bindings = branch.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-short-ref' && entry.data?.ref === ref);
      assert.ok(bindings.length > 0, 'An advertised short ref needs a retained current-branch owner binding');
      const expected = { kind: 'candidate', identity: { source: 'notion', scope: response.scope, id: record.id, kind: record.kind, locator: record.locator, ref: owner } };
      for (const binding of bindings) { assert.equal(binding.data.version, 1); assert.deepEqual(binding.data.target, expected); }
    } else assert.equal(ref, record.ref, 'A canonical entry must retain the exact source owner and main path');
  } else assert.equal(card.ref, record.ref, 'The OMP native path must advertise the same canonical owner');
  for (const marker of [fixture.marker ?? fixture.canary, unflaggedCanary, missingCanary, fixture.resourceCanary, 'LOCAL_BODY_NOT_AUTOMATIC_413']) {
    assert.ok(typeof marker === 'string' && marker.length > 0);
    assert.equal(occurrences(context, marker), 0, 'Partial metadata must not contain any Skill or resource body');
  }
  return { source: 'notion', viewId: firstViewId, partial: true, count: 1, coverage: response.coverage,
    record: { id: record.id, scope: response.scope, name: record.name, description: record.description, canonicalRef: record.ref, advertisedRef: ref },
    responseSha256: createHash('sha256').update(JSON.stringify(response)).digest('hex'), directorySha256: createHash('sha256').update(directory).digest('hex') };
}
