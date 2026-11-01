// 6축 연습용 레이더(설계서 §10): 축마다 1~4 수준·근거 충분도·관련 답변 수·근거 인용을 함께 낸다.
// 답변에서 확인되지 않은 축은 판단 보류(level:null)가 아니라 최저 수준 1로 표시하되 observed:false·evidence:'not_observed'와 사유를 붙인다
// (2026-11-01 사용자 결정, PROJECT.md v1.4.1). 0점·일반 기준 채우기는 하지 않는다. 합산 점수·순위·합격 예측은 만들지 않는다.
// 모두 면접 중 참고 점수(turn_score)와 답변 표지어에서 규칙으로 집계한 값이며 공식 평가·검증된 AI 평가가 아니다.
import { competencyFit } from './interview-format.js';
import { highlightFillers } from '../../public/core/filler.js';

const AXES = [
  { id: 'reflection_growth', label: '성찰·성장 깊이' },
  { id: 'talent_link', label: '인재상 적합성' },
  { id: 'major_inquiry', label: '전공·학업 탐구' },
  { id: 'activity_specificity', label: '활동 수행 구체성' },
  { id: 'doc_consistency', label: '서류-답변 일관성' },
  { id: 'attitude', label: '면접 태도·의사소통' },
];
export const AXIS_IDS = AXES.map((a) => a.id);
const ACTION = {
  reflection_growth: '문제 해결·성찰 단계에서 실패 원인 한 가지와 다음에 바꿀 행동 한 가지를 한 문장씩 말해 보세요.',
  talent_link: '대학이 중시하는 역량 중 답에서 다루지 않은 것을 골라 그에 해당하는 본인 행동 한 가지를 준비해 보세요.',
  major_inquiry: '전공 개념을 쓴 이유와 탐구에서 한계였던 점을 한 문장씩 덧붙여 보세요.',
  activity_specificity: '팀 결과가 아니라 본인이 직접 한 행동과 그 결과(수치·관찰)를 먼저 말해 보세요.',
  doc_consistency: '서류에 적은 활동을 말할 때 서류의 표현과 같은 순서로(역할→과정→결과) 설명하는 연습을 해 보세요.',
  attitude: '질문에 먼저 직접 답하고, 제한시간 안에 핵심을 말하는 연습을 해 보세요.',
};
const r1 = (n) => Math.round(n * 10) / 10;
const clamp = (n) => Math.max(1, Math.min(4, n));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sufficiency = (n) => (n >= 3 ? 'sufficient' : n >= 1 ? 'partial' : 'not_observed');
const MIN_LEVEL = 1;
const PARTICLE = /(으로|에서|에게|까지|부터|은|는|이|가|을|를|에|의|와|과|로|도|만)$/u;
const stems = (text) => [...new Set(String(text || '').split(/[^\p{L}\p{N}]+/u).map((w) => w.replace(PARTICLE, '')).filter((w) => [...w].length >= 2))];
const excerpt = (t, n = 70) => [...String(t || '')].slice(0, n).join('');
const hasScore = (t) => t.turn_score && Number.isFinite(t.turn_score.relevance);

// transcript: generalTranscript의 항목(답변은 이미 위험 표현을 가린 텍스트). institution: 승인된 기관 프로필(없으면 null).
export function buildAxes({ transcript = [], competencies = [], institution = null }) {
  const turns = transcript.filter(hasScore);
  const fitTurns = turns.map((t) => ({ turn_id: t.turn_id, text: t.answer_text, turn_score: t.turn_score }));
  const out = {};
  const put = (id, { level = null, n = 0, basis, reason = null, quote = null }) => {
    const def = AXES.find((a) => a.id === id);
    const observed = level !== null;
    out[id] = { id, label: def.label, level: observed ? r1(clamp(level)) : MIN_LEVEL, observed, evidence: observed ? sufficiency(n) : 'not_observed', n: observed ? n : 0, basis, ...(reason ? { reason } : {}), quote: observed && quote ? excerpt(quote) : null };
    out[id].action = out[id].level <= 2.5 ? ACTION[id] : null;
  };
  const avg3 = (t) => (t.turn_score.relevance + t.turn_score.specificity + t.turn_score.reasoning) / 3;
  void institution;

  // 1. 성찰·성장 깊이(2026-11-01 사용자 결정: 모집요강 단어 일치 축 교체).
  // reflection 단계 답변의 구체성·논리 참고 점수 평균. 뜻 해석·AI 판단이 아니라 규칙 참고 점수다.
  const stage = (s) => turns.filter((t) => t.stage === s);
  const refl = stage('reflection');
  put('reflection_growth', refl.length ? { level: mean(refl.map((t) => (t.turn_score.specificity + t.turn_score.reasoning) / 2)), n: refl.length, basis: `문제 해결·성찰 단계 답변 ${refl.length}개의 구체성·논리 참고 점수 평균입니다(실패 원인·한계·개선 방향 표현 기준, 검증 전).`, quote: refl[0].answer_text } : { basis: '문제 해결·성찰 단계 답변이 없습니다.', reason: '질문 기회가 없어 최저 수준(1)으로 표시했습니다.' });

  // 2. 인재상 적합성(2026-11-01 라벨만 변경: id·집계 유지): 대학 인재상·역량(커스텀 포함)이 답변에 나타난 정도.
  const fit = competencyFit(competencies, fitTurns).filter((c) => c.answers > 0);
  const tIds = new Set(fit.flatMap((c) => c.turn_ids));
  const tHit = turns.filter((t) => tIds.has(t.turn_id));
  put('talent_link', competencies.length
    ? { level: tHit.length ? mean(tHit.map(avg3)) : null, n: tHit.length, basis: `역량 ${competencies.length}개 중 ${fit.length}개가 답변에 나타났습니다(단어 일치 기반, 뜻 해석 아님).`, reason: tHit.length ? null : '확인된 역량이 답변에서 발견되지 않아 최저 수준(1)으로 표시했습니다. 같은 뜻을 다른 말로 했어도 단어 일치로는 잡히지 않습니다.', quote: tHit[0]?.answer_text }
    : { basis: '확인된 인재상·역량이 없습니다.', reason: '비교할 인재상이 확인되지 않아 최저 수준(1)으로 표시했습니다.' });

  // 3·4. 단계별 집계.
  const acad = stage('academic');
  put('major_inquiry', acad.length ? { level: mean(acad.map((t) => (t.turn_score.relevance + t.turn_score.reasoning) / 2)), n: acad.length, basis: `학업·전공 단계 답변 ${acad.length}개의 질문 적합성·논리 참고 점수 평균입니다.`, quote: acad[0].answer_text } : { basis: '학업·전공 단계 답변이 없습니다.', reason: '질문 기회가 없어 최저 수준(1)으로 표시했습니다.' });
  const exp = stage('experience');
  put('activity_specificity', exp.length ? { level: mean(exp.map((t) => t.turn_score.specificity)), n: exp.length, basis: `경험 검증 단계 답변 ${exp.length}개의 구체성 참고 점수 평균입니다(본인 행동·결과 표현 기준).`, quote: exp[0].answer_text } : { basis: '경험 검증 단계 답변이 없습니다.', reason: '질문 기회가 없어 최저 수준(1)으로 표시했습니다.' });

  // 5. 서류-답변 일관성: 규칙으로는 서로 다르게 설명했는지 판단할 수 없다. 서류 문장의 핵심 단어가 답변에 다시 나왔는지만 보고,
  // 나오지 않으면 최저 수준으로 둔다. 서류 문장과 답변은 항상 나란히 보여 주며 일치·불일치(거짓)를 판정하지 않는다.
  const linked = transcript.filter((t) => !t.is_followup && (t.evidence || []).some((e) => e.kind === 'application'));
  const pairs = linked.slice(0, 3).map((t) => ({ turn_id: t.turn_id, claim: excerpt((t.evidence.find((e) => e.kind === 'application') || {}).quote, 80), answer: excerpt(t.answer_text, 80) }));
  const echoed = linked.filter((t) => {
    const claimWords = stems(t.evidence.filter((e) => e.kind === 'application').map((e) => e.quote).join(' '));
    const ans = String(t.answer_text || '');
    return t.turn_score && claimWords.filter((w) => ans.includes(w)).length >= 2;
  });
  put('doc_consistency', echoed.length
    ? { level: mean(echoed.map(avg3)), n: echoed.length, basis: `서류 문장과 연결된 답변 ${linked.length}개 중 ${echoed.length}개에서 서류의 핵심 단어가 다시 나왔습니다(단어 일치 기반). 서로 다르게 설명했는지는 판단하지 않습니다.`, quote: echoed[0].answer_text }
    : { basis: `서류 문장과 연결된 답변 ${linked.length}개를 나란히 보여 줍니다. 서로 다르게 설명했는지는 규칙으로 판단할 수 없습니다.`, reason: linked.length ? '서류 문장의 핵심 단어가 답변에서 발견되지 않아 최저 수준(1)으로 표시했습니다. 일치 여부의 판정이 아니니 아래 대조를 직접 확인하세요.' : '서류 문장과 연결된 답변이 없어 최저 수준(1)으로 표시했습니다.' });
  out.doc_consistency.pairs = pairs;

  // 6. 면접 태도·의사소통(2026-11-01 확장: 음성 참고 지표 반영, 타당성 미검증이라 과장 금지).
  // 질문 적합성(기본) − 제한시간 초과·긴 정적 + 발화·말버릇 보정. 음량 변동·떨림은 점수에 직접 반영하지 않고 참고 문구로만 싣는다.
  // 음성이 없으면 기존(적합성·초과) 방식으로만 계산한다. 말투·억양·자신감·성격 평가는 하지 않는다.
  const base = turns.filter((t) => !t.is_followup);
  const cut = base.filter((t) => t.cut_off).length;
  const fillerCount = (t) => highlightFillers(t.answer_text).total;
  const voiceOf = (t) => t.voice_metrics || null;
  const voicePenalty = (t) => {
    const v = voiceOf(t);
    if (!v) return 0;
    let p = 0;
    // 발화 비율이 낮거나(할 말이 짧음) 긴 정적이 있으면 감점
    if (Number.isFinite(v.speech_ratio) && v.speech_ratio < 0.4) p += 0.3;
    if (Number.isFinite(v.longest_silence_seconds) && v.longest_silence_seconds >= 6) p += 0.3;
    // 답변 길이가 짧을 때만 말버릇 감점(긴 답변의 정상적 어미와 구분)
    const n = [...String(t.answer_text || '')].length;
    if (n < 120 && fillerCount(t) >= 4) p += 0.3;
    return Math.min(0.6, p);
  };
  const voiceNote = () => {
    const vs = base.map(voiceOf).filter(Boolean);
    if (!vs.length) return '음성 지표가 없어 참고 점수와 제한시간 초과로만 계산했습니다.';
    const parts = [];
    const cv = vs.map((v) => v.volume_cv).filter(Number.isFinite);
    const pj = vs.map((v) => v.pitch_jitter).filter(Number.isFinite);
    if (cv.length) parts.push(`음량 변동 평균 ${r1(cv.reduce((a, b) => a + b, 0) / cv.length)}`);
    if (pj.length) parts.push(`목소리 떨림 평균 ${r1(pj.reduce((a, b) => a + b, 0) / pj.length)}`);
    return `질문 적합성 참고 점수 평균에서 제한시간 초과 ${cut}/${base.length}개와 발화·정적·말버릇(최대 0.6 감점)을 반영했습니다${parts.length ? `(${parts.join('·')}, 참고용·검증 전)` : '(음성 지표 일부 없음)'}. 억양·성격·표정·자신감은 평가하지 않습니다.`;
  };
  put('attitude', base.length ? { level: mean(base.map((t) => t.turn_score.relevance - voicePenalty(t))) - (cut / base.length) * 1, n: base.length, basis: voiceNote(), quote: base[0].answer_text } : { basis: '답변이 없습니다.', reason: '답변이 없어 최저 수준(1)으로 표시했습니다.' });

  const list = AXES.map((a) => out[a.id]);
  const seen = list.filter((a) => a.observed);
  return {
    axes: list,
    summary: {
      strengths: [...seen].filter((a) => a.level >= 3).sort((a, b) => b.level - a.level).slice(0, 3).map((a) => a.label),
      improvements: [...list].filter((a) => a.level <= 2.5).sort((a, b) => a.level - b.level).slice(0, 3).map((a) => ({ id: a.id, label: a.label, action: a.action })),
      not_observed: list.filter((a) => !a.observed).map((a) => ({ id: a.id, label: a.label, reason: a.reason })),
    },
    label: '연습용 수준(1~4) · 규칙 기반 집계 · 검증 전',
  };
}
