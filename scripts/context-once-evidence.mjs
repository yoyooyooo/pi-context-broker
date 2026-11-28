import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';

/** Read only model-visible content. Session details and observer receipts are not input. */
export function contextMessageText(message) {
  if (typeof message?.content === 'string') return message.content;
  assert.ok(Array.isArray(message?.content), 'A model message needs actual content');
  return message.content.filter(part => part.type === 'text').map(part => {
    assert.equal(typeof part.text, 'string');
    return part.text;
  }).join('\n');
}

function identityKey(identity) {
  assert.ok(object(identity));
  assert.ok(['instruction', 'resource', 'directory', 'card', 'guidance'].includes(identity.kind));
  for (const key of ['scope', 'owner', 'version']) assert.ok(typeof identity[key] === 'string' && identity[key]);
  assert.ok(Object.keys(identity).every(key => ['kind', 'scope', 'owner', 'version', 'file'].includes(key)));
  if (identity.kind === 'resource') assert.ok(typeof identity.file === 'string' && identity.file);
  return canonical(identity);
}

function readLocation(messages, location) {
  assert.ok(object(location) && Number.isSafeInteger(location.message) && location.message >= 0);
  const message = messages[location.message];
  assert.ok(message, 'An observation must point into this request');
  const text = contextMessageText(message), selector = location.selector;
  assert.ok(object(selector));
  if (selector.kind === 'text') return text;
  if (selector.kind === 'json') {
    assert.ok(Array.isArray(selector.path) && selector.path.length);
    let value = JSON.parse(text);
    for (const segment of selector.path) {
      assert.ok(typeof segment === 'string' || Number.isSafeInteger(segment) && segment >= 0);
      value = value === undefined ? undefined : value?.[segment];
    }
    return value;
  }
  assert.equal(selector.kind, 'span');
  assert.ok(Number.isSafeInteger(selector.start) && Number.isSafeInteger(selector.end)
    && selector.start >= 0 && selector.end >= selector.start && selector.end <= text.length, 'A span must be inside actual text');
  const span = text.slice(selector.start, selector.end);
  if (selector.encoding === 'raw') return span;
  if (selector.encoding === 'json') return JSON.parse('"' + span + '"');
  assert.equal(selector.encoding, 'xml');
  return span.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

/** Independent byte oracle. Callers bind identities and locations to their frozen
 * source fixture, not a production loaded flag or the projector under test. */
export function verifyContextOnce({ messages, expected, occurrences, operations = [] }) {
  assert.ok(Array.isArray(messages) && Array.isArray(expected) && expected.length && Array.isArray(occurrences));
  const originals = JSON.stringify(messages), wanted = new Map(), complete = new Map(), references = [];
  const locations = new Map();
  for (const item of expected) {
    const key = identityKey(item.identity);
    assert.ok(!wanted.has(key), 'Source expectations must be unique');
    assert.ok(typeof item.value === 'string' || object(item.value) || Array.isArray(item.value));
    assert.ok(item.copies === undefined || item.copies === 0 || item.copies === 1);
    wanted.set(key, item);
  }
  for (const occurrence of occurrences) {
    const key = identityKey(occurrence.identity), item = wanted.get(key);
    assert.ok(item, 'An observed object needs an independent source expectation');
    const location = canonical(occurrence.location), prior = locations.get(location);
    assert.ok(prior === undefined || prior === key, 'One physical occurrence cannot prove two identities');
    if (prior !== undefined) continue;
    locations.set(location, key);
    const actual = readLocation(messages, occurrence.location);
    if (occurrence.state === 'complete') {
      assert.deepEqual(actual, item.value, 'The complete object must match the original source, not a summary');
      complete.set(key, (complete.get(key) ?? 0) + 1);
    } else {
      assert.equal(occurrence.state, 'reference');
      assert.ok(Object.hasOwn(occurrence, 'value'), 'A reference needs its exact expected model representation');
      assert.deepEqual(actual, occurrence.value, 'Only the declared compact reference is accepted');
      references.push(key);
    }
  }
  for (const [key, item] of wanted) assert.equal(complete.get(key) ?? 0, item.copies ?? 1, 'A needed complete object appears exactly once');
  for (const key of references) assert.equal(complete.get(key), 1, 'A compact reference needs a complete witness in this request');
  const operationIds = new Set();
  for (const operation of operations) {
    assert.ok(typeof operation.toolCallId === 'string' && operation.toolCallId && !operationIds.has(operation.toolCallId));
    operationIds.add(operation.toolCallId);
    const message = messages[operation.location.message];
    assert.equal(message.toolCallId ?? message.tool_call_id, operation.toolCallId);
    assert.deepEqual(readLocation(messages, operation.location), operation.value, 'Each operation keeps its own effects');
  }
  assert.equal(JSON.stringify(messages), originals, 'The oracle must not change the request');
  const text = messages.map(contextMessageText).join('\n');
  return { objects: wanted.size, completeCopies: [...complete.values()].reduce((sum, n) => sum + n, 0),
    compactReferences: references.length, operations: operations.length, modelTextBytes: Buffer.byteLength(text),
    modelTextSha256: hash(text), wireBytes: null, sourceRequests: null, modelUsage: 'not_measured' };
}
