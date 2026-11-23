import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { verifyNotionAgentContentSearch } from './notion-agent-analysis.mjs';

// These closed verifier fixtures are counterexamples, not real-model acceptance evidence.
function fixture({ supporting = false } = {}) {
  const files = new Map(), hash = value => createHash('sha256').update(value).digest('hex');
  const artifact = (path, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    files.set(path, bytes); return { path, bytes: bytes.length, sha256: hash(bytes) };
  };
  const query = 'copper lantern checkpoint', page = '11111111-1111-4111-8111-111111111111';
  const database = '22222222-2222-4222-8222-222222222222', filePage = '33333333-3333-4333-8333-333333333333';
  const owner = 'shared_skill:library:handover', ref = 'skill://' + encodeURIComponent(owner) + '/SKILL.md';
  const resourcePath = supporting ? 'references/checklist.md' : 'SKILL.md', bodyKey = 'target@A/' + resourcePath;
  const body = { ...artifact('/owned/oracles/body.md', Buffer.from('# Handover\n\nUse the ' + query + ' before closing the handover.\n')),
    object: 'target', version: 'A', resourcePath };
  const item = { kind: 'notion', owner, name: 'handover-playbook', pageId: page, scope: 'a'.repeat(64),
    versions: { A: { bodyKeys: [bodyKey], readback: 'target' } } };
  const record = { id: owner, name: item.name, description: 'Shift handover guidance', ref, entrypoint: 'SKILL.md', enabled: true,
    locator: { type: 'shared_skill', page_id: page, database_id: database, data_source_id: database, library_id: 'library', skill_id: 'handover' } };
  const raw = { main: { record, scope: item.scope }, observedFiles: [{ path: resourcePath, sha256: body.sha256, bytes: body.bytes }],
    files: supporting ? [{ id: filePage, properties: { Path: { id: 'path-property', type: 'rich_text', rich_text: [{ plain_text: resourcePath }] } } }] : [] };
  const receipt = { status: 'passed', object: { owner, scope: item.scope } };
  const config = { sources: [{ type: 'notion', id: 'notion', database }] };
  const bindings = { public: { 'business.phrase': query }, private: { objects: { target: item }, bodies: { [bodyKey]: body },
    fixture: { entry: database, library: { files: { property_ids: { Path: 'path-property' } } }, observedReadbacks: { target: receipt } } } };
  const value = { ok: true, state: 'known', search_in: 'content', source: 'notion', count: 1, next_cursor: null,
    pagination: 'not_supported', coverage: 'remote_non_exhaustive', exhaustive: false, partial: false, result_id: 'result-1',
    connection: { id: 'connection', grantEpoch: 'epoch-1' }, records: [{ ...structuredClone(record), source: 'notion', availability: 'available',
      match: { kind: 'notion_remote_match', representation: supporting ? 'supporting_file' : 'native', pageId: supporting ? filePage : page } }] };
  const native = { id: 'result', message: { role: 'toolResult', toolCallId: 'call', isError: false } };
  const call = { id: 'call', name: 'notion_list', arguments: { search_in: 'content', query }, deliveryToolCallId: 'call',
    native: { resultEntryId: 'result' }, event: { pid: 42, monotonicNs: '200' }, result: { isError: false, monotonicNs: '300' } };
  const selection = { sessionId: 'session', scopes: [{ scope: 'fixed', roots: ['unrelated'], bindings: [{ version: 'A' }], graphLocks: [{ purpose: 'use' }] }], active: [] };
  const observed = { visibility: { source: { sourceId: 'notion', database } }, session: { sessionId: 'session', branchEntries: [native] },
    selection: structuredClone(selection), tasks: [] };
  const delivery = { requests: [{ selection: structuredClone(selection) }, { selection: structuredClone(selection) }] };
  const source = [{ phase: 'started', kind: 'sdk', operation: 'content-search', source_id: 'notion', database, requestId: 'request', pid: 42, monotonicNs: '210' },
    { phase: 'metrics', requestId: 'request', observed: false, complete: false, total_requests: null },
    { phase: 'completed', requestId: 'request', status: 'completed', monotonicNs: '290' }];
  const expected = { kind: 'content-search', object: 'target', query: 'business.phrase', body: bodyKey };
  let deliver = true;
  const seal = () => {
    observed.visibility.source.configArtifact = artifact('/owned/source.json', config);
    receipt.rawEvidence = artifact('/owned/readback.json', raw);
    const { artifact: _artifact, ...sealed } = receipt;
    receipt.artifact = artifact('/owned/receipt.json', sealed);
    const content = [{ type: 'text', text: JSON.stringify(value) }]; native.message.content = content;
    call.result.contentArtifact = artifact('/owned/tool-result.json', content);
    observed.tasks = delivery.requests.map((request, index) => {
      const payload = artifact('/owned/payload-' + index + '.json', { messages: index && deliver
        ? [{ role: 'tool', tool_call_id: call.deliveryToolCallId, content: content[0].text }] : [] });
      Object.assign(request, payload);
      return { phase: 'provider_payload', sha256: payload.sha256, bytes: payload.bytes, payloadFile: payload.path };
    });
  };
  const run = async () => { seal(); return verifyNotionAgentContentSearch(expected, observed, bindings,
    { attempts: [call], delivery, source, readArtifact: async path => { assert.ok(files.has(path)); return files.get(path); } }); };
  return { value, raw, item, bindings, config, call, observed, delivery, source, expected, run, skipDelivery: () => { deliver = false; } };
}

test('body-only remote discovery requires real CLI readback and delivered current-owner results', async () => {
  const proof = await fixture().run();
  assert.equal(proof.pinsUnchanged, true); assert.equal(proof.exhaustive, false);
  assert.equal(proof.mcpHttpAttempts, null); assert.deepEqual(proof.sdkRequests, ['request']);
});

test('a supporting-file match proves its physical File and resolves to the owning Skill', async () => {
  const proof = await fixture({ supporting: true }).run();
  assert.equal(proof.records[0].representation, 'supporting_file');
  assert.equal(proof.records[0].pageId, '33333333-3333-4333-8333-333333333333');
});

test('partial results remain usable discovery without becoming exhaustive', async () => {
  const f = fixture(); f.value.partial = true;
  assert.equal((await f.run()).partial, true);
});

test('content proof rejects wrong mode, unsafe coverage, unrelated owners and unobserved dispatch', async t => {
  const cases = [
    ['metadata mode', f => { delete f.call.arguments.search_in; }, 'CONTENT_SEARCH_MISSING'],
    ['changed query bytes', f => { f.call.arguments.query += ' '; }, 'CONTENT_SEARCH_MISSING'],
    ['old cursor', f => { f.call.arguments.cursor = 'metadata-cursor'; }, 'CONTENT_CURSOR_UNSUPPORTED'],
    ['query in description', f => { f.raw.main.record.description += ' copper lantern checkpoint'; }, 'CONTENT_BODY_ONLY_PRECONDITION_MISSING'],
    ['wrong readback owner', f => { f.raw.main.record.id = 'another'; }, 'CONTENT_READBACK_OWNER_MISMATCH'],
    ['wrong source configuration', f => { f.config.sources[0].database = 'other'; }, 'CONTENT_SOURCE_SCOPE_MISMATCH'],
    ['multiple enabled sources', f => { f.config.sources.push({ type: 'notion', id: 'other', database: 'other' }); }, 'CONTENT_SOURCE_SCOPE_MISMATCH'],
    ['empty is not a positive match', f => { f.value.records = []; f.value.count = 0; }, 'CONTENT_MATCH_WRONG_OWNER'],
    ['auth required is not absence', f => { f.value.ok = false; f.value.state = 'auth_required'; }, 'CONTENT_RESULT_UNAVAILABLE'],
    ['exhaustive remote claim', f => { f.value.exhaustive = true; }, 'CONTENT_RESULT_CONTRACT_MISMATCH'],
    ['fabricated pagination', f => { f.value.next_cursor = 'remote-next'; }, 'CONTENT_RESULT_CONTRACT_MISMATCH'],
    ['count mismatch', f => { f.value.count = 2; }, 'CONTENT_RESULT_CONTRACT_MISMATCH'],
    ['invalid grant epoch', f => { f.value.connection.grantEpoch = 1; }, 'CONTENT_RESULT_CONTRACT_MISMATCH'],
    ['wrong Skill owner', f => { f.value.records[0].id = 'other'; }, 'CONTENT_MATCH_WRONG_OWNER'],
    ['wrong physical Skill', f => { f.value.records[0].locator.page_id = 'other'; }, 'CONTENT_MATCH_WRONG_OWNER'],
    ['snapshot ref', f => { f.value.records[0].ref += '?snapshot=old'; }, 'CONTENT_MATCH_WRONG_REPRESENTATION'],
    ['File ref', f => { f.value.records[0].ref += '?file_id=file'; }, 'CONTENT_MATCH_WRONG_REPRESENTATION'],
    ['wrong remote page', f => { f.value.records[0].match.pageId = 'other'; }, 'CONTENT_MATCH_WRONG_REPRESENTATION'],
    ['no provider delivery', f => f.skipDelivery(), 'CONTENT_NOT_DELIVERED'],
    ['another process', f => { f.source[0].pid = 43; }, 'CONTENT_SDK_CALL_UNPROVEN'],
    ['failed SDK', f => { f.source[2].status = 'failed'; }, 'CONTENT_SDK_CALL_UNPROVEN'],
    ['late SDK completion', f => { f.source[2].monotonicNs = '310'; }, 'CONTENT_SDK_CALL_UNPROVEN'],
    ['query broadcast', f => { f.source[0].source_id = 'other'; }, 'CONTENT_QUERY_BROADCAST'],
    ['changed active source', f => { f.observed.selection.active.push({ id: 'adopted' }); }, 'CONTENT_CHANGED_SELECTION'],
    ['changed Requires binding', f => { f.delivery.requests[1].selection.scopes[0].bindings[0].version = 'B'; }, 'CONTENT_CHANGED_SELECTION'],
  ];
  for (const [name, change, code] of cases) await t.test(name, async () => {
    const f = fixture(); change(f); await assert.rejects(f.run(), error => error.code === code);
  });
});

test('supporting-file proof rejects a same-name File from a different physical page', async () => {
  const f = fixture({ supporting: true }); f.value.records[0].match.pageId = f.item.pageId;
  await assert.rejects(f.run(), error => error.code === 'CONTENT_MATCH_WRONG_REPRESENTATION');
});

