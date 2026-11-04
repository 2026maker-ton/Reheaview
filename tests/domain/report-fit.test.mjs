import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAxes } from '../../src/domain/axes.js';

const competencies = [{ id: 'trait-1', label: '탐구 역량' }];
const turn = { turn_id: 'a', stage: 'academic', answer_text: '온도를 바꿔 효소 반응을 비교했습니다.', turn_score: { relevance: 3, specificity: 2, reasoning: 4 }, evidence: [] };
const talent = (transcript) => buildAxes({ transcript, competencies }).axes.find((a) => a.id === 'talent_link');

test('radar uses question competency IDs without requiring the competency name in the answer', () => {
  const a = talent([{ ...turn, competency_ids: ['trait-1'] }]);
  assert.equal(a.observed, true);
  assert.equal(a.n, 1);
  assert.equal(a.level, 3);
  assert.equal(a.quote, turn.answer_text);
});

test('unrelated competency IDs never create an observation or invented quote', () => {
  for (const transcript of [[], [turn], [{ ...turn, competency_ids: ['trait-other'] }]]) {
    const a = talent(transcript);
    assert.equal(a.observed, false);
    assert.equal(a.level, 1);
    assert.equal(a.n, 0);
    assert.equal(a.quote, null);
    assert.equal(a.evidence, 'not_observed');
  }
});

test('legacy evidence and keyword links remain supported and a multiply-linked answer counts once', () => {
  const a = talent([{ ...turn, competency_ids: ['trait-1'], evidence: [{ id: 'trait-1' }], answer_text: '탐구를 위해 온도별 효소 반응을 비교했습니다.' }]);
  assert.equal(a.n, 1);
  assert.equal(a.level, 3);
  assert.equal(talent([{ ...turn, evidence: [{ id: 'trait-1' }] }]).observed, true);
  assert.equal(talent([{ ...turn, answer_text: '탐구를 위해 변수를 통제했습니다.' }]).observed, true);
});
