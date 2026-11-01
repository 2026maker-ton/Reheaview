// 답변 코멘트·민감 정보 위험 표시(규칙 기반)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBlindRisk, maskRisk, answerComment } from '../../src/domain/answer-review.js';

test('blind risk: detects family job, school type/name, exam number, own name, social position; clean text is none; matched text is never returned', () => {
  const t = (s) => detectBlindRisk(s);
  assert.equal(t('저는 동아리에서 실험을 설계하고 결과를 비교했습니다.').level, 'none');
  assert.equal(t('아버지가 대학교수라서 연구실을 자주 갔습니다').categories[0].id, 'family_job');
  assert.equal(t('의사인 어머니 영향으로 관심이 생겼습니다').level, 'high');
  assert.equal(t('저희 과학고에서는 연구 활동이 많았습니다').level, 'medium');
  assert.equal(t('한빛고등학교에 다니며 발표했습니다').categories[0].id, 'school_name');
  assert.equal(t('제 수험번호는 12345678입니다').categories[0].id, 'exam_number');
  assert.equal(t('제 이름은 김민수입니다').categories[0].id, 'own_name');
  assert.equal(t('금수저라는 말을 들었지만').categories[0].id, 'social_position');
  assert.ok(Object.keys(t('아버지가 교수입니다')).every((k) => k !== 'text'));
  const r = t('아버지가 교수입니다. 저는 과학고 출신입니다.');
  const masked = maskRisk('아버지가 교수입니다. 저는 과학고 출신입니다.', r.spans);
  assert.ok(!masked.includes('교수') && !masked.includes('과학고') && masked.includes('[가림]'));
  assert.equal(maskRisk('깨끗한 문장', []), '깨끗한 문장');
});

test('answer comment: fix from the weakest dimension, praise from the strongest, basis always present, no score -> short-answer hint', () => {
  const c = answerComment({ turn_score: { relevance: 4, specificity: 1, reasoning: 3 }, text: '충분히 긴 답변입니다.'.repeat(5) });
  assert.match(c.fix, /행동과 결과/);
  assert.match(c.good, /질문의 핵심/);
  assert.equal(c.weakest, 'specificity');
  assert.match(c.basis, /구체성/);
  const cut = answerComment({ turn_score: { relevance: 4, specificity: 4, reasoning: 4 }, cut_off: true, text: 'x'.repeat(100) });
  assert.match(cut.fix, /제한시간/);
  assert.match(answerComment({ text: '짧음' }).fix, /너무 짧아/);
});
