import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{32,36}$/i.test(value);

/** Controller-only Notion scope allocation. Never pass this module or its receipts to the subject. */
export async function ensureRemoteParent({ projectPageId, scopeId, title, controlDir, token = process.env.NOTION_API_TOKEN, fetchImpl = fetch }) {
  assert.ok(uuid(projectPageId), 'An explicit authorized project parent is required');
  assert.match(scopeId, /^[a-z0-9][a-z0-9-]{3,79}$/);
  assert.ok(typeof title === 'string' && title.length > 0 && title.length < 150);
  assert.ok(isAbsolute(controlDir));
  assert.ok(typeof token === 'string' && token.length > 0, 'NOTION_API_TOKEN is unavailable');
  await mkdir(controlDir, { recursive: true });
  const fullTitle = title + ' · ' + scopeId;
  const intent = { version: 1, kind: 'benchmark-remote-parent', project_page_id: projectPageId.replaceAll('-', ''), scope_id: scopeId, title: fullTitle };
  const intentPath = join(controlDir, 'parent-intent.json');
  try { await save(intentPath, intent); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.deepEqual(JSON.parse(await readFile(intentPath, 'utf8')), intent, 'Existing remote ownership intent differs');
  }
  let seq = 0; const invocation = randomUUID();
  async function request(path, method = 'GET', body) {
    const startedAt = new Date().toISOString();
    const response = await fetchImpl('https://api.notion.com/v1/' + path, {
      method, headers: { authorization: 'Bearer ' + token, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000),
    });
    const text = await response.text();
    const receipt = { version: 1, started_at: startedAt, completed_at: new Date().toISOString(), method, path,
      status: response.status, request_body_sha256: body === undefined ? null : digest(JSON.stringify(body)), response: text };
    await save(join(controlDir, 'notion-' + invocation + '-' + (++seq) + '.json'), receipt);
    assert.ok(response.ok, 'Notion scope request failed with HTTP ' + response.status + '; evidence retained');
    return JSON.parse(text);
  }
  const receiptPath = join(controlDir, 'parent.json');
  try {
    const prior = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(prior.scope_id, scopeId);
    const current = await request('pages/' + prior.page_id);
    assert.ok(!current.archived && !current.in_trash, 'Owned Benchmark parent is no longer active');
    assert.equal(current.parent?.page_id?.replaceAll('-', ''), intent.project_page_id);
    return { ...prior, reused: true };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const project = await request('pages/' + projectPageId);
  assert.ok(project.object === 'page' && !project.archived && !project.in_trash, 'Project parent is not an active page');
  const matches = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await request('blocks/' + projectPageId + '/children?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''));
    for (const block of result.results ?? []) if (block.type === 'child_page' && block.child_page?.title === fullTitle) matches.push(block.id);
    if (!result.has_more) { cursor = null; break; }
    cursor = result.next_cursor;
  }
  assert.ok(!cursor, 'Cannot reconcile the complete authorized parent inventory');
  assert.ok(matches.length <= 1, 'Duplicate remote scope needs reconciliation before another write');
  let pageId = matches[0], disposition = pageId ? 'reconciled_existing' : 'created';
  if (!pageId) {
    assert.ok(!(await readdir(controlDir)).some(name => /^create-attempt-/.test(name)),
      'A previous create has no reconciled outcome; retained as unknown and no new write is allowed');
    try { await save(join(controlDir, 'create-claim.json'), { scope_id: scopeId, intent_sha256: digest(JSON.stringify(intent)), at: new Date().toISOString() }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new Error('A previous create owns this scope; reconcile its outcome before any new write');
    }
    // Never retry an ambiguous POST. A later invocation reconciles the exact owned title first.
    await save(join(controlDir, 'create-attempt-' + Date.now() + '.json'), { scope_id: scopeId, at: new Date().toISOString() });
    const created = await request('pages', 'POST', { parent: { type: 'page_id', page_id: projectPageId },
      properties: { title: { type: 'title', title: [{ type: 'text', text: { content: fullTitle } }] } },
      children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content:
        'Task-owned synthetic Benchmark fixtures. Scope: ' + scopeId + '. These objects are separate from daily Skills and retained with experiment evidence.' } }] } }] });
    pageId = created.id;
  }
  assert.ok(uuid(pageId));
  const actual = await request('pages/' + pageId);
  assert.equal(actual.parent?.page_id?.replaceAll('-', ''), intent.project_page_id);
  assert.ok(!actual.archived && !actual.in_trash);
  const result = { ...intent, page_id: pageId, url: actual.url, disposition, verified_at: new Date().toISOString() };
  await save(receiptPath, result);
  return result;
}
