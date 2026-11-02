import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleTurnScore, topicAligned, competencyFit } from '../../src/domain/interview-format.js';
import { answerComment } from '../../src/domain/answer-review.js';

const claim = '산책 시간과 짖음, 물건 훼손 등의 행동 빈도를 비교한 결과 산책 시간이 긴 집단에서 일부 문제행동의 보고 빈도가 낮은 경향을 관찰';
const question = `학생부·활동 자료에 “${claim}”라고 쓰셨습니다. 그 과정에서 본인이 직접 한 일을 말씀해 주세요.`;

test('off-topic answer does not keep a mid score from length and generic words', () => {
  const dna = 'DNA 유전자 가위로 염기서열을 비교한 결과 특정 유전자의 발현이 달라지는 경향을 관찰했습니다. 제가 직접 실험 조건을 정한 이유는 대조군이 필요했기 때문입니다.';
  assert.equal(topicAligned(question, claim, dna), false);
  const score = ruleTurnScore(dna, { question, evidence: claim });
  assert.deepEqual({ relevance: score.relevance, specificity: score.specificity, reasoning: score.reasoning }, { relevance: 1, specificity: 1, reasoning: 1 });
  const comment = answerComment({ turn_score: score, text: dna });
  assert.equal(comment.good, null);
  assert.match(comment.fix, /다른 주제/);
});

test('same-topic answer is still scored by the length heuristic', () => {
  const answer = '산책 시간을 늘린 집단에서 짖음과 물건 훼손이 줄어드는 경향을 제가 직접 기록했습니다. 비교 기준을 맞춘 이유는 집단 차이를 보기 위해서입니다.';
  assert.equal(topicAligned(question, claim, answer), true);
  const score = ruleTurnScore(answer, { question, evidence: claim });
  assert.ok(score.relevance >= 2);
  assert.equal(score.off_topic, undefined);
});

test('a competency asked by a question is scored even when the answer omits the competency name', () => {
  const fit = competencyFit(
    [{ id: 'trait-1', label: '탐구 역량' }, { id: 'trait-2', label: '공동체 역량' }],
    [{ turn_id: 't1', text: '유전자 가위 실험을 했습니다.', turn_score: { relevance: 1, specificity: 1, reasoning: 1 }, evidence_ids: ['trait-1'] }],
  );
  const asked = fit.find((c) => c.id === 'trait-1');
  const other = fit.find((c) => c.id === 'trait-2');
  assert.equal(asked.answers, 1);
  assert.equal(asked.avg_score, 1);
  assert.equal(other.answers, 0);
});
