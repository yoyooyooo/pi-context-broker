import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCampaignSuccession } from './campaign-dispatch.mjs';

const previous = { value: { id: 'previous', amendment: { path: '/fixture/previous-amendment.json', sha256: 'a'.repeat(64) } },
  reference: { path: '/fixture/scope-registration-004.json', sha256: 'b'.repeat(64) } };
const amendment = { version: 1, kind: 'benchmark-finite-campaign', id: 'next',
  predecessor: { registration: previous.reference, amendment: previous.value.amendment } };
const row = { version: 1, kind: 'benchmark-finite-campaign-succession', sequence: 5,
  predecessor: previous.reference, id: 'next' };

test('a finite succession retains the actual prior registration and amendment identities', () => {
  assertCampaignSuccession({ row, amendment, previous, sequence: 5 });
  for (const altered of [ { ...row, sequence: 6 }, { ...row, id: 'other' },
    { ...row, predecessor: { ...previous.reference, sha256: 'c'.repeat(64) } },
    { ...row, kind: 'benchmark-prospective-cohort-succession' } ])
    assert.throws(() => assertCampaignSuccession({ row: altered, amendment, previous, sequence: 5 }));
  assert.throws(() => assertCampaignSuccession({ row, previous, sequence: 5,
    amendment: { ...amendment, predecessor: { ...amendment.predecessor, amendment: { ...previous.value.amendment, sha256: 'c'.repeat(64) } } } }));
});

test('a finite registration cannot reopen the closed legacy succession sequence', () => {
  assert.throws(() => assertCampaignSuccession({ row: { ...row, kind: 'benchmark-zero-send-scope-succession' },
    amendment: { ...amendment, kind: 'benchmark-pilot-scope-amendment', version: 2 }, previous, sequence: 5 }), /LEGACY_SUCCESSION_CLOSED/);
});

test('the pre-existing prospective kind retains its exact registration kind', () => {
  const old = { ...amendment, kind: 'benchmark-prospective-cohort' };
  assertCampaignSuccession({ row: { ...row, kind: 'benchmark-prospective-cohort-succession' }, amendment: old, previous, sequence: 5 });
  assert.throws(() => assertCampaignSuccession({ row, amendment: old, previous, sequence: 5 }));
});
