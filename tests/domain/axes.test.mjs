import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAxes } from '../../src/domain/axes.js';

const score = { relevance: 3, specificity: 3, reasoning: 3 };
const turn = (o) => ({ turn_id: o.turn_id || 't1', stage: 'academic', is_followup: false, answer_text: '', turn_score: score, evidence: [], ...o });

test('attitude: demonstrative 그 does not cause a filler penalty', () => {
  const answer = '그 경험에서 그 측정값과 그 결과를 보고 그 과정이 흔들린 이유를 배웠습니다.';
  const axis = buildAxes({ transcript: [turn({ answer_text: answer, voice_metrics: { speech_ratio: .8, longest_silence_seconds: 1 } })], competencies: [] }).axes.find((a) => a.id === 'attitude');
  assert.equal(axis.level, 3);
});

test('no answers: every axis is the lowest level 1, observed:false, with a reason, never null or 0', () => {
  const ax = buildAxes({ transcript: [], competencies: [], institution: null });
  assert.equal(ax.axes.length, 6);
  for (const a of ax.axes) {
    assert.equal(a.level, 1, a.id);
    assert.equal(a.observed, false, a.id);
    assert.equal(a.evidence, 'not_observed', a.id);
    assert.equal(a.n, 0);
    assert.equal(a.quote, null);
    assert.ok(a.reason && a.action, `${a.id} explains why and what to do`);
  }
  assert.equal(ax.summary.strengths.length, 0);
  assert.equal(ax.summary.not_observed.length, 6);
  assert.ok(!('withheld' in ax.summary));
});

test('competency not found in answers: talent_link is level 1 (not observed), not invented from a generic standard', () => {
  const t = [turn({ answer_text: '저는 효소 실험을 직접 설계해 결과를 비교했습니다. 그래서 온도 조건을 바꿨습니다.' })];
  const ax = buildAxes({ transcript: t, competencies: [{ id: 'trait-1', label: '협업 역량', status: 'source_quote' }], institution: null });
  const a = ax.axes.find((x) => x.id === 'talent_link');
  assert.equal(a.level, 1);
  assert.equal(a.observed, false);
  assert.match(a.reason, /최저 수준/);
});

test('competency found in an answer: talent_link is scored from that answer and marked observed', () => {
  const t = [turn({ answer_text: '저는 팀 협업 과정에서 제가 맡은 부분을 직접 조율했습니다.' })];
  const ax = buildAxes({ transcript: t, competencies: [{ id: 'trait-1', label: '협업 역량', status: 'source_quote' }], institution: null });
  const a = ax.axes.find((x) => x.id === 'talent_link');
  assert.equal(a.observed, true);
  assert.equal(a.level, 3);
  assert.equal(a.n, 1);
});

test('doc_consistency: shows pairs always; level rises only when the claim words reappear, never judged as true/false', () => {
  const claim = '저는 효소 활성을 온도별로 측정해 비교했습니다';
  const linked = (text) => turn({ stage: 'experience', evidence: [{ kind: 'application', quote: claim }], answer_text: text });
  const hit = buildAxes({ transcript: [linked('효소 활성을 온도별로 측정해서 비교한 경험이 있습니다.')] }).axes.find((x) => x.id === 'doc_consistency');
  assert.equal(hit.observed, true);
  assert.equal(hit.pairs.length, 1);
  const miss = buildAxes({ transcript: [linked('동아리에서 발표를 했습니다.')] }).axes.find((x) => x.id === 'doc_consistency');
  assert.equal(miss.observed, false);
  assert.equal(miss.level, 1);
  assert.equal(miss.pairs.length, 1);
  assert.ok(!/거짓|불일치/.test(JSON.stringify(miss)));
});

test('reflection growth replaces official criteria: scored from reflection-stage reference scores, not invented from generic standards', () => {
  const inst = { school_analysis: { admission_elements: [{ label: '면접 포함 전형', quote: '서류평가와 면접을 반영합니다.' }] } };
  const refl = turn({ stage: 'reflection', answer_text: '저는 실패 원인을 정리하고 다음에는 확인 절차를 바꾸겠습니다.' });
  const ax = buildAxes({ transcript: [refl], competencies: [], institution: inst });
  const a = ax.axes.find((x) => x.id === 'reflection_growth');
  assert.equal(a.observed, true);
  assert.ok(a.level >= 1 && a.level <= 4);
  assert.match(a.basis, /문제 해결·성찰 단계 답변/);
  assert.ok(!ax.axes.some((x) => x.id === 'official_criteria'));
});

test('talent label is 인재상 적합성 (id unchanged), attitude reflects extended voice cues in basis', () => {
  const t = turn({ answer_text: '제가 직접 실험을 설계했고 이유를 비교해 결과를 확인했습니다.', voice_metrics: { speech_ratio: 0.2, longest_silence_seconds: 8, volume_cv: 0.5, pitch_jitter: 0.05 } });
  const ax = buildAxes({ transcript: [t], competencies: [], institution: null });
  const talent = ax.axes.find((x) => x.id === 'talent_link');
  assert.equal(talent.label, '인재상 적합성');
  const att = ax.axes.find((x) => x.id === 'attitude');
  assert.match(att.basis, /발화·정적·말버릇/);
});
