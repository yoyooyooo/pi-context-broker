import assert from 'node:assert/strict';
import test from 'node:test';
import { freezeClarificationPolicy, selectFrozenClarification } from './fixture-turn-adapter.mjs';

const clarifications = [
  { topic_id: 'delivery-mode', max_questions: 1, response: 'Use priority delivery.' },
  { topic_id: 'target-currency', max_questions: 1, response: 'Use EUR.' },
];
const policy = freezeClarificationPolicy(clarifications);
const select = (text, available = clarifications, frozen = policy) =>
  selectFrozenClarification({ observation: { final_text: text }, available }, frozen);

test('recognizes explicit Chinese clarification requests without question marks', () => {
  for (const text of [
    '这批报价还缺配送方式，规则里不能默认。请指定用哪一种（economy 或 priority）。确认后我会写出报价。',
    '配送方式必须由你指定，我不能默认。请告诉我用哪一种，确认后我再计算。',
    '请告诉我们配送方式，确认后再报价。',
    '请告知本批配送方式。',
  ]) assert.equal(select(text), 'delivery-mode', text);
});

test('recognizes explicit English clarification requests without question marks', () => {
  for (const text of [
    'Please specify the shipping mode before I quote.',
    'Please tell me which delivery mode to use.',
    'PLEASE TELL US THE DELIVERY MODE.',
    'Please\nspecify the currency for the result.',
  ]) assert.equal(select(text), text.includes('currency') ? 'target-currency' : 'delivery-mode', text);
});

test('retains existing question and request forms', () => {
  for (const text of [
    '配送方式？', 'Which shipping mode?', '请问配送方式。', '请确认配送方式。',
    '请选择配送方式。', '请提供配送方式。', 'Could you specify delivery mode.',
    'Would you choose the shipping mode.', 'Please confirm delivery mode.',
    'Please choose delivery mode.', 'Please provide delivery mode.',
  ]) assert.equal(select(text), 'delivery-mode', text);
});

test('does not turn declarative delivery or currency text into a clarification', () => {
  for (const text of [
    '', '配送方式已指定为 priority。', '我会告诉你配送报价。',
    'The delivery mode is priority.', 'I will tell you the delivery cost.',
    'The user specified the currency.', 'No shipping information was provided.',
  ]) assert.equal(select(text), null, text);
});

test('requires exactly one available frozen topic', () => {
  assert.equal(select('Please tell me which color to use.'), null);
  assert.equal(select('请告诉我配送方式和结算币种。'), null);
  assert.equal(select('Please specify delivery and currency.'), null);
  assert.equal(select('请指定配送方式。', []), null);
  assert.equal(select('Please tell me the delivery mode.', [clarifications[1]]), null);
  assert.equal(select('Please specify delivery and currency.', [clarifications[0]]), 'delivery-mode');
});

test('selection leaves the frozen policy, available budget and response unchanged', () => {
  const available = structuredClone(clarifications), frozen = structuredClone(policy);
  const before = structuredClone({ available, frozen });
  assert.equal(select('请指定配送方式。', available, frozen), 'delivery-mode');
  assert.deepEqual({ available, frozen }, before);
  assert.equal(select('请指定配送方式。', available.filter(item => item.topic_id !== 'delivery-mode'), frozen), null);
});

test('custom topics remain explicitly frozen and independent of request wording', () => {
  const available = [{ topic_id: 'delivery-mode', max_questions: 1, response: 'Use priority delivery.' }];
  const supplied = { version: 1, kind: 'literal-question-topic-v1', topics: [{ topic_id: 'delivery-mode', match_any: ['courier'] }] };
  const frozen = freezeClarificationPolicy(available, supplied);
  supplied.topics[0].match_any.push('shipping');
  assert.equal(select('Please tell me which courier to use.', available, frozen), 'delivery-mode');
  assert.equal(select('Please specify the shipping mode.', available, frozen), null);
  assert.deepEqual(frozen.topics[0].match_any, ['courier']);
});

test('keeps the observation limit and rejects invalid topic bindings', () => {
  assert.equal(select('x'.repeat(32768) + ' Please specify delivery mode.'), null);
  assert.throws(() => freezeClarificationPolicy([clarifications[0]], {
    version: 1, kind: 'literal-question-topic-v1', topics: [{ topic_id: 'unregistered', match_any: ['delivery'] }],
  }), /FIXTURE_TURN_UNKNOWN_CLARIFICATION_TOPIC/);
  assert.throws(() => freezeClarificationPolicy([clarifications[0]], {
    version: 1, kind: 'literal-question-topic-v1', topics: [{ topic_id: 'delivery-mode', match_any: [] }],
  }), /FIXTURE_TURN_CLARIFICATION_RULE_REQUIRED/);
});
