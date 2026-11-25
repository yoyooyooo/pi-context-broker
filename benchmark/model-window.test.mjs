import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from './protocol.mjs';
import { assertSubjectModelWindow } from './controller.mjs';
import { modelWindowCondition, modelWindowContains, validModelWindow } from './model-window.mjs';

test('standing condition epochs have no expiry and serialize null without Infinity or NaN', () => {
  const window = { mode: 'standing', start: '2026-11-25T07:00:00Z', end: null };
  assert.equal(validModelWindow(window), true);
  assert.equal(modelWindowContains(window, Date.parse('2026-11-25T06:59:59Z')), false);
  assert.equal(modelWindowContains(window, Date.parse('2046-11-25T07:00:00Z')), true);
  assert.doesNotThrow(() => assertSubjectModelWindow({ backend: { window } }, Date.parse('2046-11-25T07:00:00Z')));
  assert.equal(canonicalJson(modelWindowCondition(window)), '{"end":null,"mode":"standing","start":1795590000000}');
  assert.equal(validModelWindow({ ...window, mode: undefined }), false);
  assert.equal(validModelWindow({ ...window, end: '2026-11-26T07:00:00Z' }), false);
});

test('historical windows preserve both their exclusive expiry and fingerprint projection', () => {
  const window = { start: '2026-11-25T07:00:00Z', end: '2026-11-26T07:00:00Z' };
  assert.equal(modelWindowContains(window, Date.parse(window.start)), true);
  assert.equal(modelWindowContains(window, Date.parse(window.end)), false);
  assert.deepEqual(modelWindowCondition(window), { start: Date.parse(window.start), end: Date.parse(window.end) });
});
