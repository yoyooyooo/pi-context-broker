import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gradeEpisode, validateOracle } from './corpus/grader.mjs';
import { buildCorpus, validateCorpus, planCaseVariant } from './corpus/index.mjs';
import { fingerprint } from './protocol.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const answerText = 'Total: 7. Ownership is unproven.';
const facts = {
  total: { anyOf: ['Total: 7'] },
  uncertain: { anyOf: ['ownership is unproven', 'source is unknown'] },
  invented: { anyOf: ['ownership confirmed'] },
};
function contract(assessment = 'necessary-facts') {
  return { id: 'answer', kind: 'final-answer', turn_id: 'turn-2', critical: true,
    assessment, all: ['total'], any: ['uncertain'], none: ['invented'] };
}
function oracle(assessment = 'necessary-facts') {
  return { schema_version: 1, case_id: 'natural-question', capability_scope: 'common',
    required_capabilities: [], facts, contracts: [contract(assessment)] };
}
function answer(content = answerText, extra = {}) {
  return { evidence_id: 'answer-event', turn_id: 'turn-2', content, sha256: hash(content), ...extra };
}
function review(content = answerText, extra = {}) {
  return { evidence_id: 'independent-review', contract_id: 'answer', turn_id: 'turn-2', answer_sha256: hash(content),
    status: 'pass', reason: 'The retained answer states the required total and preserves uncertainty.',
    reviewer: 'independent-reviewer', method: 'independent-semantic-review', ...extra };
}
function grade({ assessment = 'necessary-facts', answers = [answer()], reviews, coverage } = {}) {
  return gradeEpisode({ oracle: oracle(assessment), evidence: { final_answers: answers,
    ...(reviews ? { final_answer_reviews: reviews } : {}), ...(coverage ? { coverage } : {}) } });
}

test('natural answers use normalized necessary facts and alternatives without a JSON artifact', () => {
  for (const text of [answerText, 'ＴＯＴＡＬ: 7.\n SOURCE   IS UNKNOWN. Additional explanation is allowed.']) {
    const result = grade({ answers: [answer(text)] });
    assert.equal(result.business_outcome, 'pass'); assert.equal(result.verified_success, true);
    assert.match(result.contracts[0].reason, /semantic correctness is outside/);
    assert.equal(result.readback_refs[0].sha256, hash(text));
  }
  assert.equal(grade({ answers: [answer('Total: 8. Ownership is unproven.')] }).business_outcome, 'fail');
  assert.equal(grade({ answers: [answer('Total: 7. Ownership is unproven. Ownership confirmed.')] }).business_outcome, 'fail');
});

test('semantic answers stay unknown regardless of keyword hits or harmless paraphrases', () => {
  for (const text of [answerText, 'The sum is seven and no source attribution can be established.',
    'It is false that total: 7. It is false that ownership is unproven.']) {
    const result = grade({ assessment: 'semantic-review', answers: [answer(text)] });
    assert.equal(result.business_outcome, 'unknown'); assert.equal(result.verified_success, false);
    assert.deepEqual(result.critical_flags, []);
    assert.equal(result.contracts[0].assessment, 'semantic-review');
  }
});

test('independent semantic review binds exact turn and answer bytes, and may override mechanical diagnostics', () => {
  const paraphrase = 'The sum is seven and no source attribution can be established.';
  const pass = grade({ assessment: 'semantic-review', answers: [answer(paraphrase)], reviews: [review(paraphrase)] });
  assert.equal(pass.business_outcome, 'pass'); assert.equal(pass.verified_success, true);
  assert.equal(pass.contracts[0].checks.all[0].found, false);
  assert.deepEqual(pass.contracts[0].evidence_ids, ['answer-event', 'independent-review']);
  const fail = grade({ assessment: 'semantic-review', reviews: [review(answerText, {
    status: 'fail', reason: 'The full answer contradicts the frozen relation truth despite containing its words.',
  })] });
  assert.equal(fail.business_outcome, 'fail'); assert.equal(fail.critical_flags.length, 1);
  for (const extra of [{ answer_sha256: hash('another answer') }, { turn_id: 'turn-1' }, { contract_id: 'another-contract' }])
    assert.equal(grade({ assessment: 'semantic-review', reviews: [review(answerText, extra)] }).business_outcome, 'unknown');
  assert.equal(grade({ assessment: 'semantic-review', reviews: [review(), review()] }).business_outcome, 'unknown');
  assert.equal(grade({ assessment: 'semantic-review', reviews: [review(answerText, { status: 'unknown' })] }).business_outcome, 'unknown');
});

test('missing, corrupt and ambiguous answer evidence cannot manufacture a correct response', () => {
  assert.equal(grade({ answers: [] }).business_outcome, 'unknown');
  assert.equal(grade({ answers: [], coverage: { final_answers: 'complete' } }).business_outcome, 'fail');
  assert.equal(grade({ answers: [answer('', {})] }).business_outcome, 'fail');
  assert.equal(grade({ answers: [answer(answerText, { sha256: hash('wrong') })], reviews: [review()] }).business_outcome, 'unknown');
  assert.equal(grade({ answers: [answer(answerText, { turn_id: 'turn-1' })] }).business_outcome, 'unknown');
  assert.equal(grade({ answers: [answer(), answer()] }).business_outcome, 'unknown');
});

test('natural oracle rejects undeclared facts, contradictory conditions and implicit assessment', () => {
  for (const mutate of [
    value => { delete value.contracts[0].assessment; },
    value => { delete value.contracts[0].turn_id; },
    value => { value.contracts[0].all = ['missing']; },
    value => { value.contracts[0].none = ['total']; },
    value => { value.facts = { ...facts, total: { anyOf: ['  '] } }; },
    value => { value.contracts[0].all = []; value.contracts[0].any = []; value.contracts[0].none = []; },
  ]) {
    const value = oracle(); mutate(value); assert.throws(() => validateOracle(value));
  }
  assert.throws(() => grade({ assessment: 'semantic-review', reviews: [review(answerText, { method: 'model-self-score' })] }),
    /declare its method/);
});

function naturalCorpus() {
  const value = buildCorpus({ seed: 'natural-answer-unit-test' });
  const item = value.publicCorpus.cases.find(item => !Object.keys(item.variants).length);
  const control = value.control.cases.find(control => control.case_id === item.id);
  const privateOracle = { ...oracle('semantic-review'), case_id: item.id,
    required_capabilities: item.required_capabilities, public_sha256: '' };
  privateOracle.contracts[0].turn_id = item.turns.at(-1).id;
  item.completion = { kind: 'final-answer', paths: [] };
  item.contract_sha256 = fingerprint(privateOracle.contracts);
  const { content_sha256: ignored, ...itemIdentity } = item;
  item.content_sha256 = fingerprint(itemIdentity); privateOracle.public_sha256 = item.content_sha256;
  control.oracles = { [item.default_round_count]: privateOracle };
  const { content_sha256: ignoredCorpus, ...corpusIdentity } = value.publicCorpus;
  value.publicCorpus.content_sha256 = fingerprint(corpusIdentity);
  value.control.public_sha256 = value.publicCorpus.content_sha256;
  return { value, item, privateOracle };
}

test('public natural completion exposes no private facts and binds the declared turn', () => {
  const { value, item, privateOracle } = naturalCorpus();
  assert.equal(validateCorpus(value).status, 'valid');
  const plan = planCaseVariant({ ...value, caseId: item.id });
  assert.deepEqual(plan.publicCase.completion, { kind: 'final-answer', paths: [] });
  assert.equal(JSON.stringify(plan.publicCase).includes('Ownership is unproven.'), false);
  assert.equal(Object.hasOwn(plan.publicCase, 'facts'), false);
  privateOracle.contracts[0].turn_id = 'unregistered-turn';
  assert.throws(() => validateCorpus(value), /undeclared public turn/);
});
