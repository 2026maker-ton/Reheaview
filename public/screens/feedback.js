import { ensureGuestAiConsent } from '../core/guest-ai.js';
import { busyButton } from '../core/busy.js';
// 면접 결과: 차트(실시간 참고 점수·대학 역량 적합성·평가 차원·음성 지표) + 질문·답변 본문(꼬리질문 구분, i 버튼 근거) + 다음 행동.
// 차트는 라이브러리 없이 인라인 SVG로 그리고, 같은 숫자를 화면 낭독기용 표로도 둔다.
import { $, $$, esc, uuid } from '../core/format.js';
import { dimLabel, FIXED, STAGE_LABEL } from '../core/copy.js';
import { toast } from '../core/toast.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { go } from '../core/router.js';
import { EvidenceQuote } from '../ui/index.js';
import { InfoBtn, PrivacyLink } from '../ui/info.js';
import { AXIS_HELP } from '../core/info-text.js';
import { highlightFillers, fillerSummary } from '../core/filler.js';
import { enterRoom } from './room.js';
import { dialog } from '../core/dialog.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let reportLoad = 0;
export function cancelReportLoading() { reportLoad++; cur = null; }
export function showReportProcessing() {
  cur = null; // 이전 보고서의 비동기 렌더가 새 처리 화면을 덮지 않게 한다.
  state.lastReport = null;
  $('#feedbackBody').innerHTML = '<section class="card processing-card" role="status" aria-live="polite" aria-busy="true"><span class="processing-mark" aria-hidden="true"></span><h2>면접 결과 분석 중...</h2><p>지금까지의 답변을 바탕으로 결과를 정리하고 있습니다.</p></section>';
  go('feedback');
}
export function showReportFailure(message, retry = loadReport) {
  $('#feedbackBody').innerHTML = `<section class="card processing-card"><h2>분석을 완료하지 못했습니다.</h2><p role="alert">${esc(message)}</p><button class="primary" id="analysisRetryBtn" type="button">${retry === loadReport ? '다시 확인' : '다시 시도'}</button></section>`;
  $('#analysisRetryBtn').addEventListener('click', retry);
}
export async function loadReport() {
  const load = ++reportLoad;
  const sessionId = state.session.id;
  showReportProcessing();
  for (let i = 0; i < 10; i++) {
    try {
      const r = await api(`/sessions/${sessionId}/report`);
      if (load !== reportLoad || state.session?.id !== sessionId) return;
      if (r.status === 'ready') { state.session.state = 'completed'; state.lastReport = r; go('feedback'); renderReport(r); return; }
      if (r.status === 'failed') return showReportFailure(r.detail || '결과를 만들지 못했습니다.');
    } catch (err) { if (load === reportLoad && state.session?.id === sessionId) return showReportFailure(err.message); return; }
    await sleep(1200);
  }
  if (load === reportLoad && state.session?.id === sessionId) showReportFailure('분석이 지연되고 있습니다. 잠시 후 다시 확인해 주세요.');
}

let cur = null; // 지금 그리는 보고서(? 근거 문구에 평가기·개수를 쓴다)
const evalName = () => (cur?.evaluator?.kind === 'llm' ? `AI(${cur.evaluator.provider === 'claude' ? 'Claude' : 'Gemini'})` : '규칙');
const BASIS = {
  head: () => `이번 평가기는 ${evalName()}입니다. 원문 인용·금지 표현을 검사하며, AI 결과 검증이 실패하면 규칙으로 대체합니다. 공식 평가가 아닌 검증 전 참고용입니다.`,
  fit: () => '역량의 핵심 단어가 나온 답변의 참고 점수 평균입니다. 단어 일치 기준이므로 같은 뜻의 다른 표현은 놓칠 수 있습니다.',
  radar6: () => '답변별 참고 점수·표지어를 규칙으로 집계했습니다. 공식 평가가 아니며, 단어 일치는 다른 표현을 놓칠 수 있습니다. 미관찰은 1로 표시합니다.',
  actions: () => '점수가 낮거나 답변에서 확인되지 않은 영역에서 다음에 연습할 행동 하나씩을 골랐습니다.',
};
const SCORE_KEYS = [['relevance', '질문 적합성'], ['specificity', '구체성'], ['reasoning', '논리']];
const srTable = (caption, head, rows) => `<table class="sr-only"><caption>${esc(caption)}</caption><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${esc(String(c))}</td>` : `<th scope="row">${esc(String(c))}</th>`)).join('')}</tr>`).join('')}</tbody></table>`;
// 박스 하단 아코디언 "AI의 생각이 궁금해요!": 면접관 말투 한줄평 + 이 박스의 판단 근거(예전 ? 버튼 내용).
// 한줄평은 Gemini가 쓴 것일 때만 AI로 표기하고, 규칙 문구면 AI 판단이 아니라고 밝힌다.
const AI_TITLE = 'AI의 생각이 궁금해요!';
function aiAccordion(which, basis, detail = '') {
  const c = cur?.ai_comments;
  const line = c?.[which];
  const who = c?.live ? `${c.provider === 'claude' ? 'Claude' : 'Gemini'} 한줄평 · 검증 전(참고용)` : '규칙 기반 문구 · AI가 쓴 글이 아닙니다';
  return `<details class="ai-acc"><summary>${AI_TITLE}</summary><div class="ai-acc-body">${line ? `<p class="ai-line">“${esc(line)}”</p><p class="meta">${esc(who)}</p>` : '<p class="meta">이번 결과에는 한줄평이 없습니다.</p>'}${basis ? `<p class="fine ai-basis"><b>판단 근거</b> ${esc(basis)}</p>` : ''}${detail}</div></details>`;
}
// 답변별 참고 점수 박스: 펼쳐지지 않고 아래 질문카드로 이동한다.
const aiJump = () => `<button type="button" class="ai-acc ai-jump" data-jump="qaTitle" aria-label="${AI_TITLE} 아래 질문과 답변으로 이동"><span>${AI_TITLE}</span><span class="ai-jump-go" aria-hidden="true">↓ 질문과 답변</span></button>`;
const turnLabel = (t, i, list) => { const n = list.slice(0, i + 1).filter((x) => !x.is_followup).length; return t.is_followup ? `Q${n} 꼬리` : `Q${n}`; };

// A. 실시간 참고 점수: 답변별 3개 막대(1~4). 꼬리질문 답변은 빗금.
function scoreChart(tr) {
  const rows = tr.filter((t) => t.turn_score);
  if (!rows.length) return '';
  const W = Math.max(320, rows.length * 72 + 40); const H = 180; const base = 150; const unit = 30;
  const bars = rows.map((t, i) => {
    const x0 = 40 + i * 72;
    const b = SCORE_KEYS.map(([k], j) => { const v = t.turn_score[k] || 0; return `<rect class="bar s${j}${t.is_followup ? ' followup' : ''}" x="${x0 + j * 18}" y="${base - v * unit}" width="16" height="${v * unit}"><title>${esc(SCORE_KEYS[j][1])} ${v}</title></rect>`; }).join('');
    return `${b}<text class="axis" x="${x0 + 26}" y="${base + 18}" text-anchor="middle">${esc(turnLabel(t, tr.indexOf(t), tr))}</text>`;
  }).join('');
  const grid = [1, 2, 3, 4].map((v) => `<line class="grid" x1="32" x2="${W - 8}" y1="${base - v * unit}" y2="${base - v * unit}"/><text class="axis" x="26" y="${base - v * unit + 4}" text-anchor="end">${v}</text>`).join('');
  return `<figure class="chart"><figcaption>답변별 참고 점수${InfoBtn('report.score')} <span class="chip-note">${esc(FIXED.scoreLabel)}</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="답변별 참고 점수 막대 차트">${grid}${bars}</svg>
    <p class="legend">${SCORE_KEYS.map(([, l], j) => `<span><i class="sw s${j}"></i>${esc(l)}</span>`).join('')}<span><i class="sw followup"></i>꼬리질문 답변</span></p>
    ${srTable('답변별 참고 점수', ['답변', ...SCORE_KEYS.map((k) => k[1])], rows.map((t) => [turnLabel(t, tr.indexOf(t), tr), ...SCORE_KEYS.map(([k]) => t.turn_score[k])]))}${aiJump()}</figure>`;
}

// B1. 대학 역량 적합성: 역량별 평균 참고 점수(0~4). 0은 답변에서 다루지 않은 역량.
function fitChart(fit) {
  if (!fit?.length) return '';
  const rows = fit.map((c) => `<div class="hbar"><span class="hbar-label">${esc(c.label)}</span><span class="hbar-track"><span class="hbar-fill${c.answers ? '' : ' empty'}" style="width:${(c.avg_score / 4) * 100}%"></span></span><span class="hbar-val">${c.answers ? `${c.avg_score} · 답변 ${c.answers}개` : '다루지 않음'}</span></div>`).join('');
  return `<figure class="chart"><figcaption>대학 역량 적합성${InfoBtn('report.fit')} <span class="chip-note">${esc(FIXED.fitLabel)}</span></figcaption>${rows}
    ${srTable('대학 역량 적합성', ['역량', '평균 참고 점수', '관련 답변 수'], fit.map((c) => [c.label, c.avg_score, c.answers]))}${aiAccordion('fit_comment', BASIS.fit())}</figure>`;
}

// B2. 평가 차원 레이더(1~4, 근거 부족은 최저 수준 1로 두고 미관찰 표시).
// B2'. 6축 연습용 레이더(설계서 §10): 답변에서 확인되지 않은 영역은 0점이 아니라 최저 수준(1)에 빈 점(미관찰)으로 그린다.
const EVID = { sufficient: '충분', partial: '부분', not_observed: '미관찰' };
function radar6(ax) {
  const ds = ax?.axes || [];
  if (ds.length < 3) return '';
  const C = 130; const R = 84; const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / ds.length;
  const pt = (i, r) => [C + Math.cos(ang(i)) * r, C + Math.sin(ang(i)) * r];
  const fmt = (p) => p.map((v) => v.toFixed(1)).join(',');
  const rings = [1, 2, 3, 4].map((v) => `<polygon class="grid" points="${ds.map((_, i) => fmt(pt(i, (R * v) / 4))).join(' ')}"/>`).join('');
  const spokes = ds.map((_, i) => { const [x, y] = pt(i, R); return `<line class="grid" x1="${C}" y1="${C}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join('');
  const pts = ds.map((d, i) => pt(i, (R * d.level) / 4));
  const hint = (d) => esc(`${d.label} · ${d.observed ? `${d.level} / 4` : '1 / 4 · 미관찰'}. ${AXIS_HELP[d.id] || d.basis}`);
  const area = `<polygon class="area" points="${pts.map(fmt).join(' ')}"/>`;
  const dots = ds.map((d, i) => {
    const p = pts[i];
    const dot = d.observed
      ? `<circle class="dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5"><title>${esc(d.label)} ${d.level}</title></circle>`
      : `<circle class="dot hold" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4"><title>${esc(d.label)} 미관찰(최저 수준 1)</title></circle>`;
    return `<g data-tooltip="${hint(d)}" class="chart-hint"><circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="9" fill="transparent"/>${dot}</g>`;
  }).join('');
  const labels = ds.map((d, i) => {
    const [x, y] = pt(i, R + 14); const c = Math.cos(ang(i));
    const anchor = c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle';
    const words = d.label.split(' ');
    const first = words.slice(0, Math.ceil(words.length / 2)).join(' '); const rest = words.slice(Math.ceil(words.length / 2)).join(' ');
    return `<g class="chart-hint" tabindex="0" role="button" aria-label="${hint(d)}" data-tooltip="${hint(d)}"><text class="axis" x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${anchor}">${esc(first)}${rest ? `<tspan x="${x.toFixed(1)}" dy="12">${esc(rest)}</tspan>` : ''}<tspan x="${x.toFixed(1)}" dy="12" class="axis-val${d.observed ? '' : ' hold'}">${d.observed ? d.level.toFixed(1) : '1.0 · 미관찰'}</tspan></text></g>`;
  }).join('');
  return `<figure class="chart wide"><figcaption>6개 영역 레이더${InfoBtn('report.axes')} <span class="chip-note">${esc(ax.label)}</span></figcaption><svg viewBox="-110 -14 480 290" role="group" aria-label="6개 영역 레이더 차트">${rings}${spokes}${area}${dots}${labels}</svg>
    ${srTable('6개 영역', ['영역', '수준', '근거', '관련 답변 수'], ds.map((d) => [d.label, d.observed ? `${d.level} / 4` : '1 / 4 (미관찰)', EVID[d.evidence], d.n]))}${aiAccordion('dimension_comment', BASIS.radar6(), axisTable(ax))}</figure>`;
}
function axisTable(ax) {
  const ds = ax?.axes || [];
  if (!ds.length) return '';
  const rows = ds.map((d) => `<tr><th scope="row">${esc(d.label)}</th><td><strong>${d.level.toFixed(1)}</strong> / 4${d.observed ? '' : ' <span class="tag">미관찰</span>'}</td><td><span class="tag${d.evidence === 'sufficient' ? ' official' : ''}">${esc(EVID[d.evidence])}</span> <span class="meta">답변 ${d.n}개</span></td><td>${d.quote ? `<q>${esc(d.quote)}</q>` : '<span class="meta">—</span>'}${d.reason ? `<p class="meta">${esc(d.reason.replace('아래 대조를 직접 확인하세요.', '세부 정보의 학생부·활동 근거와 답변을 직접 확인하세요.'))}</p>` : ''}${d.action ? `<p class="axis-action">${esc(d.action)}</p>` : ''}</td><td>${InfoBtn(`${d.basis}${d.reason ? ` ${d.reason}` : ''}`, { kind: 'basis', label: `${d.label} 판단 근거 보기` })}</td></tr>`).join('');
  return `<section class="card axis-card"><h2>영역별 근거${InfoBtn('report.axes')}</h2><div class="table-wrap"><table class="ev-table"><thead><tr><th scope="col">영역</th><th scope="col">수준(1~4)</th><th scope="col">근거 충분도</th><th scope="col">답변 인용 · 다음에 해 볼 것</th><th scope="col"><span class="sr-only">판단 근거</span></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
// 면접 태도·전달력 코칭(설계서 §10.4): 실제로 잴 수 있는 것만.
function coachingHtml(tr) {
  const n = tr.length;
  const lengths = tr.map((t) => [...t.answer_text].length);
  const avg = n ? Math.round(lengths.reduce((a, b) => a + b, 0) / n) : null;
  const cut = tr.filter((t) => t.cut_off).length;
  const fill = tr.reduce((sum, t) => sum + highlightFillers(t.answer_text).total, 0);
  const sil = tr.map((t) => t.voice_metrics?.longest_silence_seconds).filter(Number.isFinite);
  const silence = sil.length ? (sil.reduce((a, b) => a + b, 0) / sil.length).toFixed(1) : null;
  const metric = (label, value, unit, note) => `<div class="overview-metric"><dt>${label}</dt><dd>${value ?? '—'}<small>${value === null ? '' : unit}</small></dd><p>${esc(note)}</p></div>`;
  return `<section class="card report-overview" aria-labelledby="overviewTitle"><div class="overview-heading"><div><p class="overview-kicker">이번 면접의 말하기 기록</p><h2 id="overviewTitle">면접 태도·전달력 코칭${InfoBtn('report.coaching')}</h2></div><span class="overview-count">답변 ${n}개 기준</span></div>
    <dl class="overview-metrics">
      ${metric('시간 초과 답변', n ? cut : null, ` / ${n}개`, cut ? '결론부터 말하고 근거를 이어 보세요.' : '질문별 제한시간 기준')}
      ${metric('평균 답변 길이', avg, '자', n ? `가장 짧은 ${Math.min(...lengths)}자 · 가장 긴 ${Math.max(...lengths)}자` : '기록된 답변이 없습니다.')}
      ${metric('말버릇 표현', n ? fill : null, '회', fill >= 8 ? '문장 사이를 숨으로 대신해 보세요.' : '답변을 펼치면 노란 표시로 확인할 수 있어요.')}
      ${metric('최장 정적 평균', silence, '초', sil.length ? `음성 답변 ${sil.length}개 기준` : '음성 답변이 없어 측정하지 않았습니다.')}
    </dl><p class="fine">답변에서 관찰한 참고 수치입니다. 억양·표정·자신감·성격·정직성은 평가하지 않습니다.</p></section>`;
}
function blindSafetyHtml(bs) {
  if (!bs) return '';
  const kinds = [...new Set((bs.events || []).flatMap((e) => e.labels || []))];
  return `<section class="card privacy-results" id="privacyResults"><h2>블라인드·개인정보 검사 결과${PrivacyLink('blind')}</h2>
    <p>AI로 보내지 않고 다시 답하게 한 횟수: <strong>${bs.blocked_count}회</strong>${kinds.length ? ` <span class="meta">(${esc(kinds.join(' · '))})</span>` : ''}</p>
    ${bs.masked_answers ? `<p>결과에서 표현을 가린 답변: ${bs.masked_answers}개</p>` : ''}
    <p class="fine">대입 블라인드 면접 기준(성명·수험번호·출신 고교·부모 및 친인척의 직업 등 사회적 지위)과 개인정보에 대한 규칙 기반 검사입니다. 누락·오탐이 있을 수 있습니다. <span class="meta">검사 버전 ${esc(bs.filter_version)}</span></p></section>`;
}
async function reportIssue(r) {
  const type = await dialog({ title: '오류 신고', label: '신고 유형', choices: [['question', '질문 오류'], ['source', '출처 오류'], ['fact', '사실 오류'], ['privacy', '개인정보·블라인드 노출'], ['inappropriate', '부적절한 표현'], ['stt', '전사(음성 인식) 오류'], ['evaluation', '평가 오류']], value: 'evaluation', okText: '다음' });
  if (type === null) return;
  const comment = await dialog({ title: '내용 (선택)', message: '성명·수험번호·출신 고교·부모 및 친인척의 직업 등 개인정보나 사회적 지위를 드러내는 내용은 쓰지 마세요. 저장 전에 가려지고 모델 학습에 쓰지 않습니다.', label: '내용', value: '', multiline: true, okText: '신고' });
  if (comment === null) return;
  try { await api('/issue-reports', { method: 'POST', idempotent: true, body: { type, session_id: r.session_id, comment } }); toast('신고를 접수했습니다.'); } catch (err) { toast(err.message, true); }
}

// B3. 음성 참고 지표(답변 평균).
function voiceChart(tr) {
  const v = tr.map((t) => t.voice_metrics).filter(Boolean);
  if (!v.length) return '';
  const avg = (k) => v.reduce((s, x) => s + (x[k] || 0), 0) / v.length;
  const rows = [['발화 비율', avg('speech_ratio'), 1, (x) => `${Math.round(x * 100)}%`], ['최장 정적', avg('longest_silence_seconds'), 10, (x) => `${x.toFixed(1)}초`], ['음량 변동', avg('volume_cv'), 1.5, (x) => x.toFixed(2)], ['목소리 떨림', avg('pitch_jitter'), 0.2, (x) => x.toFixed(3)]];
  const vols = tr.map((t, i) => ({ t, i })).filter((x) => x.t.voice_metrics?.timeline?.envelope?.length);
  return `<figure class="chart voice-chart"><figcaption>음성${InfoBtn('report.voice')} <span class="chip-note">${esc(FIXED.voiceLabel)}</span></figcaption>${rows.map(([l, x, max, f]) => `<div class="hbar"><span class="hbar-label">${esc(l)}</span><span class="hbar-track"><span class="hbar-fill alt" style="width:${Math.min(100, (x / max) * 100)}%"></span></span><span class="hbar-val">${esc(f(x))}</span></div>`).join('')}
    ${vols.length ? `<div class="vol-list"><p class="vol-title">질문별 내 음량 크기${InfoBtn('report.volume')}</p>${vols.map(({ t, i }) => volumeRow(t.voice_metrics.timeline, turnLabel(t, i, tr))).join('')}</div>` : ''}</figure>`;
}
// 질문별 음량: 면접 중 녹음에서 소리 크기 숫자만 따로 기록한 값(오디오 자체는 저장하지 않음). 각 질문 안에서 가장 큰 소리를 100%로 본 상대값이다.
function volumeRow(tl, label) {
  const W = 300; const H = 36; const n = tl.envelope.length;
  const pts = tl.envelope.map((v, k) => `${(((k + 0.5) / n) * W).toFixed(1)},${(H - (v / 100) * (H - 3)).toFixed(1)}`).join(' ');
  return `<div class="vol-row"><span class="vol-label">${esc(label)}</span><div class="timeline-probe" data-seconds="${tl.total_seconds}" role="slider" tabindex="0" aria-label="${esc(label)} 음량 경과 시간" aria-valuemin="0" aria-valuemax="${tl.total_seconds}" aria-valuenow="0"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)} 음량 그래프, 녹음 ${fmtS(tl.total_seconds)}"><line class="vol-base" x1="0" x2="${W}" y1="${H}" y2="${H}"/><polygon class="vol-area" points="0,${H} ${pts} ${W},${H}"/></svg><div class="timeline-cursor" hidden><span></span></div></div><span class="vol-sec">${fmtS(tl.total_seconds)}</span></div>`;
}

// 답변별 음성: 음량 그래프(그 답변의 최대 음량 대비) + 아래 띠에 실제 답변 구간(초록)·중간 정적 구간(주황).
const fmtS = (x) => `${Number(x).toFixed(1)}초`;
function voiceTimelineChart(tl, idx) {
  if (!tl?.envelope?.length || !tl.total_seconds) return '';
  const W = 600; const H = 60; const T = tl.total_seconds; const n = tl.envelope.length;
  const X = (sec) => (sec / T) * W;
  const pts = tl.envelope.map((v, i) => `${(((i + 0.5) / n) * W).toFixed(1)},${(H - (v / 100) * (H - 4)).toFixed(1)}`).join(' ');
  const segs = tl.segments.map((g) => `<rect class="seg ${g.k}" x="${X(g.s).toFixed(1)}" y="${H + 6}" width="${Math.max(1, X(g.e) - X(g.s)).toFixed(1)}" height="12"><title>${g.k === 'speech' ? '답변' : '정적'} ${fmtS(g.s)}~${fmtS(g.e)}</title></rect>`).join('');
  const speech = tl.segments.filter((g) => g.k === 'speech'); const pauses = tl.segments.filter((g) => g.k === 'pause');
  const spoken = speech.reduce((a, g) => a + g.e - g.s, 0);
  const paused = pauses.reduce((a, g) => a + g.e - g.s, 0);
  return `<figure class="voice-tl"><figcaption>음량과 구간${InfoBtn('report.timeline')} <span class="chip-note">${esc(FIXED.voiceLabel)}</span></figcaption>
    <div class="timeline-probe" data-seconds="${T}" role="slider" tabindex="0" aria-label="답변 음량 경과 시간" aria-valuemin="0" aria-valuemax="${T}" aria-valuenow="0"><svg viewBox="0 0 ${W} ${H + 20}" preserveAspectRatio="none" role="img" aria-label="답변 음량 그래프와 답변·정적 구간"><polygon class="vol-area" points="0,${H} ${pts} ${W},${H}"/><rect class="seg-track" x="0" y="${H + 6}" width="${W}" height="12"/>${segs}</svg><div class="timeline-cursor" hidden><span></span></div></div>
    <p class="legend"><span><i class="sw seg-speech"></i>실제 답변 ${fmtS(spoken)}</span><span><i class="sw seg-pause"></i>중간 정적 ${pauses.length}회 · ${fmtS(paused)}</span><span class="meta">녹음 ${fmtS(T)}</span></p>
    ${srTable(`답변 ${idx + 1} 구간`, ['구간', '시작', '끝'], tl.segments.map((g) => [g.k === 'speech' ? '답변' : '정적', fmtS(g.s), fmtS(g.e)]))}</figure>`;
}

function evidenceList(ev) {
  if (!ev?.length) return '<p class="meta">이 질문은 학과 정보로 만든 기본 질문입니다.</p>';
  return `<ul class="plain">${ev.map((e) => (e.kind === 'application'
    ? `<li><span class="tag user">학생부·활동</span> <q>${esc(e.quote)}</q></li>`
    : `<li><span class="tag">${esc(e.status === 'user_supplied' ? '직접 입력 역량' : e.status === 'ai_search' ? FIXED.aiSearch : '대학 인재상')}</span> ${esc(e.label)}${e.quote ? ` <q>${esc(e.quote)}</q>` : ''}${e.url ? ` <a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">출처</a>` : ''}</li>`)).join('')}</ul>`;
}

const RISK_TEXT = { high: '위험', medium: '주의' };
function answerHtml(t) {
  const f = highlightFillers(t.answer_text);
  return `<p class="qa-a">${f.html}</p>${f.total ? `<p class="meta filler-note">말버릇 ${f.total}회 · ${esc(fillerSummary(f.counts))}${InfoBtn('report.filler')}</p>` : ''}`;
}
function commentHtml(t) {
  const c = t.comment; const risk = t.risk;
  const hasRisk = risk && risk.level !== 'none';
  if (!c?.good && !c?.fix && !hasRisk) return '';
  const riskText = hasRisk ? `답변에 ${risk.categories.map((x) => x.label).join('·')}을(를) 드러내는 표현이 있습니다. 대입 블라인드 면접에서는 개인정보·출신 고교·부모의 직업 등 사회적 지위 노출을 피해야 하며, 그 표현은 위 답변에서 가렸습니다.` : '';
  return `<div class="qa-comment${hasRisk ? ' has-risk' : ''}"><div class="qa-comment-body">
    ${c?.good ? `<p><b>잘한 점</b> ${esc(c.good)}</p>` : ''}${c?.fix ? `<p><b>고치면 좋은 점</b> ${esc(c.fix)}</p>` : ''}
    <span class="comment-tools">${InfoBtn('report.comment')}${c?.basis ? InfoBtn(c.basis, { kind: 'basis' }) : ''}</span></div>
    ${hasRisk ? `<div class="risk-flag ${risk.level}" role="note"><strong>${RISK_TEXT[risk.level]}</strong><span>${esc(risk.categories.map((x) => x.label).join(' · '))}</span>${InfoBtn(riskText, { kind: 'basis', label: '위험 표시 이유 보기' })}</div>` : ''}
  </div>`;
}

function transcriptHtml(tr) {
  return tr.map((t, i) => `<details class="qa${t.is_followup ? ' followup' : ''}">
    <summary class="qa-head">${t.is_followup ? '<span class="stage-chip alt">꼬리질문</span>' : `<span class="stage-chip">${esc(STAGE_LABEL[t.stage] || t.stage_label || '')}</span>`}
      <p class="qa-q">${esc(t.question_text)}</p>
      <span class="qa-toggle" aria-hidden="true">＋</span></summary><div class="qa-body">
      ${t.is_followup ? '' : `<button class="icon-btn info" type="button" aria-label="근거 보기" aria-expanded="false" aria-controls="ev-${i}">i</button>`}
    ${t.is_followup ? '' : `<div class="qa-evidence" id="ev-${i}" hidden>${evidenceList(t.evidence)}</div>`}
    ${answerHtml(t)}
    ${commentHtml(t)}
    ${voiceTimelineChart(t.voice_metrics?.timeline, i)}
    ${t.cut_off ? '<p class="meta">제한시간 초과</p>' : ''}
  </div></details>`).join('');
}

// 세부 정보(결과 맨 뒤, 읽기 전용): 면접 질문의 바탕이 된 지원서 근거와 확정된 질문 목록.
const GAP = { role: '본인 역할', result: '관찰된 결과', reason: '판단 기준', number: '수치·기록' };
function claimsHtml(list) {
  const rows = (list || []).filter((c) => !c.kind || c.kind === 'applicant_claim');
  if (!rows.length) return '<p class="meta">경험·성과 문장을 찾지 못했습니다.</p>';
  return `<ul class="claims">${rows.map((c) => `<li class="claim-item${c.excluded ? ' excluded' : ''}">${EvidenceQuote({ quote: c.quote, start: c.start_cp, end: c.end_cp })}${c.gaps?.length ? `<span class="meta">빠진 정보: ${c.gaps.map((g) => `<span class="tag">${esc(GAP[g] || g)}</span>`).join(' ')}</span>` : ''}</li>`).join('')}</ul>`;
}
function planHtml(plan) {
  const st = plan?.stages || [];
  if (!st.length) return '<p class="meta">질문 계획을 불러오지 못했습니다.</p>';
  return `<ol class="plan-list">${st.map((s) => `<li><span class="stage-chip">${esc(STAGE_LABEL[s.stage] || s.stage)}</span><span class="val">${esc(s.text)}</span>${s.evidence?.length ? `<span class="meta">근거: ${s.evidence.map((e) => esc(e.kind === 'application' ? `학생부·활동 “${String(e.quote).slice(0, 30)}…”` : e.label)).join(', ')}</span>` : ''}</li>`).join('')}</ol>`;
}
async function loadDetail() {
  const id = state.profile?.id;
  const host = $('#reportDetail');
  if (!id || !host) return;
  const [cl, plan] = await Promise.all([api(`/profiles/${id}/claims`).catch(() => null), api(`/profiles/${id}/plan`).catch(() => null)]);
  if (!cl && !plan) { host.hidden = true; return; }
  host.hidden = false;
  host.querySelector('.detail-body').innerHTML = `<h3>학생부·활동 자료에서 확인한 내용</h3>${claimsHtml(cl?.claims)}<h3>면접 질문 목록</h3>${planHtml(plan)}`;
}

// 같은 질문 계획으로 여러 번 본 면접의 회차 목록(2회 이상일 때만 탭을 보인다). 회차별 보고서는 처음 열 때 불러온다.
const reportCache = new Map();
async function loadAttempts(r) {
  if (!r.profile_version_id) return [];
  try {
    const { sessions } = await api('/sessions');
    return (sessions || []).filter((x) => x.profile_version_id === r.profile_version_id && x.state === 'completed' && x.session_kind !== 'practice').sort((a, b) => (a.attempt_no || 0) - (b.attempt_no || 0));
  } catch { return []; }
}
function attemptTabs(list, currentId) {
  if (list.length < 2) return '';
  return `<div class="attempt-tabs" role="tablist" aria-label="면접 회차">${list.map((a, k) => `<button type="button" role="tab" class="attempt-tab" aria-selected="${a.id === currentId}" data-attempt="${esc(a.id)}">${a.attempt_no || k + 1}회차</button>`).join('')}${InfoBtn('report.attempts')}</div>`;
}

// 다시 보기: 승인 때 확정한 질문 계획 그대로(질문을 새로 만들지 않는다) 실면접과 결과만 새로 진행한다. 꼬리질문 판단은 면접 중 공급자 설정(Gemini)을 따른다.
async function retryInterview(r) {
  const btn = $('#retryBtn');
  const done = busyButton(btn, '면접 준비 중...');
  try {
    if (!(await ensureGuestAiConsent())) return;
    const input_mode = state.lastInputMode || 'text';
    const s = await api('/sessions', { method: 'POST', idempotent: true, body: { profile_version_id: r.profile_version_id || state.versionId, interview_format: 'general', input_mode } });
    state.session = { id: s.id, version: s.version, state: 'ready' };
    const started = await api(`/sessions/${s.id}/commands`, { method: 'POST', idempotent: true, body: { command_id: uuid(), expected_version: s.version, type: 'session.start', payload: {} } });
    state.session.version = started.version;
    enterRoom({ session: { ...s, input_mode, answer_seconds: s.limits.answer_seconds }, started });
  } catch (err) {
    toast(err.message, true);
  } finally { done(); }
}

export async function renderReport(r, opts = {}) {
  const body = $('#feedbackBody');
  if (!body) return;
  cur = r;
  reportCache.set(r.session_id, r);
  const llm = r.evaluator?.kind === 'llm';
  const inst = r.institution || {};
  const tr = r.transcript || [];
  const actions = (r.next_actions || []).slice(0, 3);
  const attempts = opts.attempts || await loadAttempts(r);
  if (cur !== r) return; // 그 사이 다른 보고서로 바뀌었다
  body.innerHTML = `
    <div class="report-head card"><div><strong>${esc(inst.target_name || '')}</strong> <span class="meta">${esc(inst.role || '')}</span>${r.attempt_no > 1 || attempts.length > 1 ? ` <span class="tag">${esc(String(r.attempt_no || 1))}회차</span>` : ''}</div><span class="head-tags"><span class="tag ${llm ? 'official' : ''}">${esc(llm ? `${r.evaluator?.provider === 'claude' ? 'Claude' : 'Gemini'} 분석 · 검증 전(참고용)` : FIXED.evaluator)}</span>${InfoBtn(BASIS.head(), { kind: 'basis' })}</span></div>
    ${attemptTabs(attempts, r.session_id)}
    ${r.personas?.names?.length ? `<p class="persona-line"><span class="meta">면접관 관점</span> ${r.personas.names.map((n) => `<span class="tag">${esc(n)}</span>`).join(' ')}${InfoBtn('report.persona')}</p>` : ''}
    ${coachingHtml(tr)}
    <section class="report-charts">${radar6(r.axes)}${scoreChart(tr)}${fitChart(r.competency_fit)}${voiceChart(tr)}</section>
    ${blindSafetyHtml(r.blind_safety)}
    <section class="report-main" aria-labelledby="qaTitle"><h2 id="qaTitle">질문과 답변${InfoBtn('report.qa')}</h2>${tr.length ? transcriptHtml(tr) : '<p class="missing">기록된 답변이 없습니다.</p>'}</section>
    ${actions.length ? `<section class="card report-actions"><h2>다음 연습${InfoBtn('report.actions')}${InfoBtn(BASIS.actions(), { kind: 'basis' })}</h2><ol>${actions.map((a) => `<li><strong>${esc(dimLabel(a.dimension_id))}</strong> ${esc(a.action)}</li>`).join('')}</ol></section>` : ''}

    <details class="card report-detail" id="reportDetail" hidden><summary>세부 정보 · 학생부·활동 근거와 질문 목록${InfoBtn('report.detail')}</summary><div class="detail-body"></div></details>
    <div class="actions"><button class="primary" type="button" id="retryBtn">다시 면접 보기</button><button class="ghost" type="button" id="reportHomeBtn">처음으로</button><button class="ghost" type="button" id="issueBtn">오류 신고</button></div>`;
  bindTimelineProbes(body);
  loadDetail();
  $('#reportHomeBtn').addEventListener('click', () => go('dashboard'));
  $('#retryBtn').addEventListener('click', () => retryInterview(r));
  $('#issueBtn').addEventListener('click', () => reportIssue(r));
  $$('#feedbackBody .attempt-tab').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.attempt;
    if (id === r.session_id) return;
    try {
      const rep = reportCache.get(id) || await api(`/sessions/${id}/report`);
      if (rep.status !== 'ready') return toast('이 회차의 결과를 아직 불러올 수 없습니다.', true);
      state.lastReport = rep;
      renderReport(rep, { attempts });
    } catch (err) { toast(err.message, true); }
  }));
  $$('#feedbackBody .ai-jump').forEach((b) => b.addEventListener('click', () => {
    const el = document.getElementById(b.dataset.jump);
    if (!el) return;
    el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true });
  }));
  $$('#feedbackBody .icon-btn.info').forEach((b) => b.addEventListener('click', () => {
    const panel = document.getElementById(b.getAttribute('aria-controls'));
    const open = panel.hidden;
    panel.hidden = !open; b.setAttribute('aria-expanded', String(open));
  }));
}

// 음량 그래프의 실제 표시 폭으로 시간을 환산한다. 호버·터치·키보드 모두 같은 경과 시간을 보여 준다.
function bindTimelineProbes(host) {
  host.querySelectorAll('.timeline-probe').forEach((probe) => {
    const duration = Number(probe.dataset.seconds);
    const cursor = probe.querySelector('.timeline-cursor');
    const label = cursor.querySelector('span');
    const show = (ratio) => {
      const r = Math.max(0, Math.min(1, ratio));
      const seconds = Math.round(r * duration * 10) / 10;
      cursor.hidden = false; cursor.style.left = `${r * 100}%`;
      label.textContent = `${seconds.toFixed(1)}초`;
      label.style.transform = `translateX(${r < .15 ? '0' : r > .85 ? '-100%' : '-50%'})`;
      probe.setAttribute('aria-valuenow', String(seconds));
      probe.setAttribute('aria-valuetext', `경과 ${seconds.toFixed(1)}초`);
    };
    probe.addEventListener('pointermove', (event) => { const b = probe.getBoundingClientRect(); show((event.clientX - b.left) / b.width); });
    probe.addEventListener('pointerleave', () => { if (document.activeElement !== probe) cursor.hidden = true; });
    probe.addEventListener('focus', () => show(Number(probe.getAttribute('aria-valuenow')) / duration));
    probe.addEventListener('blur', () => { cursor.hidden = true; });
    probe.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = Number(probe.getAttribute('aria-valuenow'));
      show((event.key === 'Home' ? 0 : event.key === 'End' ? duration : current + (event.key === 'ArrowRight' ? .1 : -.1)) / duration);
    });
  });
}
