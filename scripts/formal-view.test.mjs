import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as view from '../verification/models/consumer-observations/flows/RetentionDisclosure.view.mjs';
const base = { phase: 'reported', writes: 0, effect: 'absent', outcome: 'ready', zeroClaim: false };
test('unknown failure cannot share a label with a legal zero-write result', () => {
  const lost = view.state({ ...base, outcome: 'failed', writes: 1 });
  assert.notEqual(lost, view.state(base));
  assert.match(lost, /未知结果未披露/);
});
test('the strict-read-only view uses the actual configuration, without changing model states', () => {
  assert.equal(typeof view.forConfig, 'function');
  const cfg = name => fs.readFileSync(new URL('../verification/models/consumer-observations/flows/RetentionDisclosure.' + name + '.cfg', import.meta.url), 'utf8');
  const strict = view.forConfig(cfg('read-only-negative')), ordinary = view.forConfig(cfg('implemented'));
  assert.match(strict.state({ ...base, phase: 'retained', writes: 1 }), /严格只读.*违反只读/);
  assert.doesNotMatch(ordinary.state({ ...base, phase: 'retained', writes: 1 }), /违反只读/);
  assert.throws(() => view.forConfig('CONSTANTS StrictReadOnly = SOME_OTHER_VALUE'));
});
