// 보고서 한줄평(report.comment): 규칙 기반 문구와 AI 출력 검증. AI 출력은 길이·금지 표현·블라인드 위험 표현을 서버가 다시 검사하고 통과하지 못하면 규칙 문구로 대신한다.
import { checkFeedbackSafety } from './evaluation.js';
import { detectBlindRisk } from './answer-review.js';
import { personaOutputOk } from './personas.js';

const MAX_LEN = 140;

export function ruleComments({ fit = [], axes = [] }) {
  const seen = fit.filter((c) => c.answers > 0);
  const missed = fit.filter((c) => !c.answers);
  let fitText;
  if (!fit.length) fitText = '비교할 학교 인재상·역량이 확인되지 않아 연결 정도를 말씀드리기 어렵습니다.';
  else if (!seen.length) fitText = '학교가 중시하는 역량과 이어지는 표현이 답변에서 발견되지 않았습니다. 역량을 직접 보여 주는 경험을 한 가지 덧붙여 보세요.';
  else {
    const top = [...seen].sort((a, b) => b.avg_score - a.avg_score)[0];
    fitText = `‘${top.label}’ 이야기가 답변에서 확인됐습니다.${missed.length ? ` ‘${missed[0].label}’은(는) 아직 다루지 않았으니 한 번 언급해 보세요.` : ''}`;
  }
  const seenAxes = axes.filter((a) => a.observed);
  let dimText;
  if (!seenAxes.length) dimText = '답변에서 차원별로 확인된 근거가 부족합니다. 본인 행동과 결과를 한 가지씩 더 말해 보세요.';
  else {
    const hi = [...seenAxes].sort((a, b) => b.level - a.level)[0];
    const lo = [...axes].sort((a, b) => a.level - b.level)[0];
    dimText = hi.id === lo.id ? `‘${hi.label}’ 부분이 답변에서 확인됐습니다.` : `‘${hi.label}’은(는) 비교적 잘 드러났고, ‘${lo.label}’은(는) 더 보여 주면 좋겠습니다.`;
  }
  return { fit_comment: fitText.slice(0, MAX_LEN), dimension_comment: dimText.slice(0, MAX_LEN) };
}

export function validComment(text) {
  const t = String(text ?? '').trim();
  if (!t || [...t].length > MAX_LEN) return false;
  if (/[<>]|https?:|www\./i.test(t)) return false;
  if (checkFeedbackSafety(t).length || !personaOutputOk(t)) return false;
  if (/\d+\s*%|\d+\s*위|확률|가능성|합격|불합격/.test(t)) return false;
  return detectBlindRisk(t).level === 'none';
}

export function validComments(o) {
  return !!o && validComment(o.fit_comment) && validComment(o.dimension_comment);
}
