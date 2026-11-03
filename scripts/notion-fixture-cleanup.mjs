import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeJson } from './verification-command.mjs';

// Reconciliation consumes the original ownership receipt and never creates pages.
export async function archiveOwnedFixture({ evidence, invoke }) {
  const owned = JSON.parse(await readFile(join(evidence, 'live-fixture-create.json'), 'utf8'));
  assert.equal(owned.owned, true, 'Cleanup requires the original owned fixture receipt');
  const pageId = owned.pageId;
  assert.match(pageId, /^[0-9a-f-]{32,36}$/i);
  assert.match(owned.operationId, /^(?:p_[A-Za-z0-9-]{1,100}|skill-create-[a-f0-9]{64})$/);
  const path = join(evidence, 'live-fixture-cleanup.json');
  let previous;
  try { previous = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) assert.equal(previous.pageId, pageId, 'Cleanup receipt must match original owner');
  const previousAttempts = previous ? [...(previous.previousAttempts ?? []), { ...previous, previousAttempts: undefined }] : [];
  const state = { pageId, status: 'running', attempt: (previous?.attempt ?? 0) + 1, previousAttempts, knownIds: [...new Set([...(previous?.knownIds ?? []), pageId])], receipts: [] };
  for (const id of state.knownIds) assert.match(id, /^[0-9a-f-]{32,36}$/i);
  const save = () => writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await save();
  try {
    const ownership = await invoke(['ctl', 'archive', pageId, '--operation', owned.operationId, '--dry-run']);
    assert.equal(ownership.dry_run, true);
    assert.ok(Array.isArray(ownership.owned_page_ids) && ownership.owned_page_ids.includes(pageId), 'Cleanup requires a complete original creation ownership inventory');
    for (const id of ownership.owned_page_ids) assert.match(id, /^[0-9a-f-]{32,36}$/i);
    assert.ok(state.knownIds.every(id => ownership.owned_page_ids.includes(id)), 'Previous cleanup inventory must belong to the same creation');
    state.knownIds = [...new Set(ownership.owned_page_ids)];
    state.ownership = { operationId: owned.operationId, verified: true, knownIds: [...state.knownIds] };
    const readPage = async id => {
      const observed = (await invoke(['ctl', 'api', `v1/pages/${id}`])).response;
      assert.equal(observed.id, id, 'Cleanup readback must match the exact owned ID');
      const inTrash = observed.in_trash ?? observed.archived;
      assert.equal(typeof inTrash, 'boolean', 'Cleanup requires an explicit page archive state');
      return { attempted: true, result: 'observed', inTrash };
    };
    let ownerReadback;
    try { ownerReadback = await readPage(pageId); }
    catch (error) { ownerReadback = { attempted: true, result: 'unknown', error: error.message }; }
    state.ownerReadback = ownerReadback;
    let inventoryComplete = false;
    if (ownerReadback.inTrash === true) {
      // An archived page's children endpoint can return 404. Only an earlier
      // complete owned inventory proves which exact IDs must be read again.
      const prior = [...previousAttempts].reverse().find(attempt =>
        attempt.pageId === pageId && Array.isArray(attempt.knownIds) &&
        state.knownIds.every(id => attempt.knownIds.includes(id)) &&
        (attempt.inventory?.complete === true ||
          (attempt.status === 'archived' && !attempt.inventoryError &&
            attempt.knownIds.every(id => attempt.receipts?.some(receipt =>
              receipt.pageId === id && receipt.status === 'archived' && receipt.readback?.inTrash === true)))));
      if (prior) {
        for (const id of prior.knownIds) assert.match(id, /^[0-9a-f-]{32,36}$/i);
        state.knownIds = [...new Set([...state.knownIds, ...prior.knownIds])];
        inventoryComplete = true;
        state.inventory = { complete: true, source: 'previous-attempt', attempt: prior.attempt, knownIds: [...state.knownIds] };
      } else {
        inventoryComplete = true;
        state.inventory = { complete: true, source: 'original-creation-ownership', knownIds: [...state.knownIds] };
      }
    } else if (ownerReadback.inTrash === false) {
      try {
        const blocks = (await invoke(['ctl', 'api', `v1/blocks/${pageId}/children`])).response;
        assert.ok(Array.isArray(blocks.results), 'Fixture cleanup requires an explicit child inventory');
        const children = blocks.results.filter(block => block.type === 'child_page').map(block => block.id);
        for (const id of children) assert.match(id, /^[0-9a-f-]{32,36}$/i);
        assert.ok(children.every(id => state.knownIds.includes(id)), 'Cleanup refuses a child page not owned by the original creation');
        assert.equal(blocks.has_more, false, 'Fixture cleanup refuses an unpaginated child inventory');
        inventoryComplete = true;
        state.inventory = { complete: true, source: 'observed', knownIds: [...state.knownIds] };
      } catch (error) { state.inventoryError = error.message; }
    } else state.inventoryError = 'Owner archive state could not be read; child inventory remains unconfirmed';
    await save();
    for (const id of [...state.knownIds.filter(id => id !== pageId), pageId]) {
      const receipt = { pageId: id, status: 'pending', patch: { attempted: false }, readback: { attempted: false } };
      state.receipts.push(receipt);
      try { receipt.readback = id === pageId ? ownerReadback : await readPage(id); }
      catch (error) { receipt.readback = { attempted: true, result: 'unknown', error: error.message }; }
      if (receipt.readback.inTrash === true) { receipt.status = 'archived'; await save(); continue; }
      if (receipt.readback.inTrash !== false) { receipt.status = 'blocked'; receipt.reason = 'Page archive state could not be read'; await save(); continue; }
      if (id === pageId && !inventoryComplete) { receipt.status = 'blocked'; receipt.reason = 'Child inventory incomplete'; await save(); continue; }
      receipt.patch = { attempted: true, result: 'unknown' };
      await save();
      try { await invoke(['ctl', 'archive', id, '--operation', owned.operationId]); receipt.patch.result = 'accepted'; }
      catch (error) { receipt.patch.error = error.message; receipt.patch.recovery = error.recovery; }
      receipt.readback = { attempted: true, result: 'unknown' };
      await save();
      try {
        receipt.readback = await readPage(id);
        receipt.status = receipt.readback.inTrash === true ? 'archived' : 'failed';
      } catch (error) { receipt.readback.error = error.message; receipt.status = 'blocked'; }
      await save();
    }
    state.status = inventoryComplete && state.receipts.every(item => item.status === 'archived') ? 'archived' : state.receipts.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  } catch (error) { state.status = 'failed'; state.error = error.message; }
  finally { state.finishedAt = new Date().toISOString(); await save(); }
  assert.equal(state.status, 'archived', `Owned fixture cleanup ${state.status}; reconcile original IDs from live-fixture-cleanup.json`);
  return state.receipts;
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  const [evidence, commandJson = '["ntn-skills"]'] = process.argv.slice(2);
  assert.ok(evidence, 'Usage: node scripts/notion-fixture-cleanup.mjs /absolute/EVIDENCE [project-cli-command-json]');
  const command = JSON.parse(commandJson);
  assert.ok(Array.isArray(command) && command.length && command.every(item => typeof item === 'string'));
  await archiveOwnedFixture({ evidence, invoke: (args, input) => invokeJson(command, args, { input, evidence: join(evidence, 'command-receipts.jsonl'), category: 'fixture-reconcile' }) });
}
