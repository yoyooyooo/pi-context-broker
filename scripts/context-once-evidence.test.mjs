import test from 'node:test';
import assert from 'node:assert/strict';
import { contextMessageText, verifyContextOnce } from './context-once-evidence.mjs';

const identity = { kind: 'instruction', scope: 'owned-scope', owner: 'alpha', version: 'fixed-a' };
const body = '\uFEFF完整正文 <tag> 🧭\r\n', directory = { files: [{ path: 'guide.md', ref: 'fixed-resource' }] };
const dirIdentity = { ...identity, kind: 'directory' };
const expected = [{ identity, value: body }, { identity: dirIdentity, value: directory }];
const slot = (message, field) => ({ message, selector: { kind: 'json', path: [field] } });
const effects = { remote_writes: 'unknown' };
function fixture() {
  return { messages: [
    { role: 'tool', tool_call_id: 'first', content: JSON.stringify({ body, directory, effects }) },
    { role: 'tool', tool_call_id: 'second', content: JSON.stringify({ body: 'Already loaded.', effects: { remote_writes: 'none' } }) },
  ], expected, occurrences: [
    { identity, state: 'complete', location: slot(0, 'body') },
    { identity: dirIdentity, state: 'complete', location: slot(0, 'directory') },
    { identity, state: 'reference', location: slot(1, 'body'), value: 'Already loaded.' },
    { identity: dirIdentity, state: 'reference', location: slot(1, 'directory'), value: undefined },
  ], operations: [{ toolCallId: 'first', location: slot(0, 'effects'), value: effects },
    { toolCallId: 'second', location: slot(1, 'effects'), value: { remote_writes: 'none' } }] };
}

test('CTX01 full bytes, one directory, compact reuse and distinct operation effects pass', () => {
  const result = verifyContextOnce(fixture());
  assert.equal(result.completeCopies, 2); assert.equal(result.compactReferences, 2); assert.equal(result.operations, 2);
  assert.equal(result.wireBytes, null); assert.equal(result.sourceRequests, null);
});
test('CTX01 duplicate full directories or bodies fail even when a product says loaded', () => {
  for (const [id, field, value] of [[identity, 'body', body], [dirIdentity, 'directory', directory]]) {
    const input = fixture();
    input.messages.push({ role: 'tool', tool_call_id: 'duplicate', content: JSON.stringify({ [field]: value }), details: { loaded: true } });
    input.occurrences.push({ identity: id, state: 'complete', location: slot(2, field) });
    assert.throws(() => verifyContextOnce(input), /exactly once/);
  }
});
test('CTX01 omitted last copy and summaries cannot witness a reused object', () => {
  for (const value of ['Summary: loaded=true', body.slice(1)]) {
    const input = fixture(); input.messages[0].content = JSON.stringify({ body: value, directory, effects });
    assert.throws(() => verifyContextOnce(input), /original source/);
  }
  const input = fixture(); input.occurrences = input.occurrences.filter(value => value.identity.kind !== 'instruction' || value.state !== 'complete');
  assert.throws(() => verifyContextOnce(input), /exactly once/);
});
test('CTX01 actual text, not proof fields, establishes a complete object', () => {
  const input = fixture(); input.messages[0].details = { body, directory, loaded: true };
  input.messages[0].content = JSON.stringify({ body: 'Already loaded.', effects });
  assert.throws(() => verifyContextOnce(input), /original source/);
  assert.equal(contextMessageText({ content: [{ type: 'image', data: 'private' }, { type: 'text', text: 'visible' }], details: { text: body } }), 'visible');
});
test('CTX01 equal text from different scopes cannot share one physical witness', () => {
  const input = fixture(), foreign = { ...identity, scope: 'foreign-scope' };
  input.expected = [...expected, { identity: foreign, value: body }];
  input.occurrences.push({ identity: foreign, state: 'complete', location: slot(0, 'body') });
  assert.throws(() => verifyContextOnce(input), /two identities/);
  input.messages.push({ role: 'tool', tool_call_id: 'foreign', content: JSON.stringify({ body }) });
  input.occurrences.at(-1).location = slot(2, 'body');
  assert.equal(verifyContextOnce(input).completeCopies, 3);
});
test('CTX01 unknown effects cannot disappear, become none, or move to a different call', () => {
  for (const patch of [undefined, { remote_writes: 'none' }]) {
    const input = fixture(); input.messages[0].content = JSON.stringify({ body, directory, effects: patch });
    assert.throws(() => verifyContextOnce(input), /own effects/);
  }
  const input = fixture(); input.operations[0].toolCallId = 'wrong-call';
  assert.throws(() => verifyContextOnce(input));
});
test('CTX01 span checks preserve UTF-16 positions and original UTF-8 content', () => {
  for (const encoding of ['raw', 'xml', 'json']) {
    const encoded = encoding === 'raw' ? body : encoding === 'json' ? JSON.stringify(body).slice(1, -1)
      : body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const prefix = '🧭 prefix\n', message = { content: prefix + encoded + '\nfooter' };
    const location = { message: 0, selector: { kind: 'span', start: prefix.length, end: prefix.length + encoded.length, encoding } };
    const input = { messages: [message], expected: [{ identity, value: body }], occurrences: [{ identity, location, state: 'complete' }] };
    assert.equal(verifyContextOnce(input).completeCopies, 1);
    location.selector.start++;
    assert.throws(() => verifyContextOnce(input));
  }
});
