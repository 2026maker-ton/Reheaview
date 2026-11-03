import { ensureGuestAiConsent } from '../core/guest-ai.js';
import { busyButton } from '../core/busy.js';
// 근거 확인: 핵심 역량·면접 형태(렌치로 직접 수정), 학교·전형 검색, 지원서 주장, 5단계 질문 계획. 서버 텍스트는 모두 esc().
import { $, esc, fmtDate, setError } from '../core/format.js';
import { toast } from '../core/toast.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { go } from '../core/router.js';
import { dialog } from '../core/dialog.js';
import { Stepper, StateBadge, EvidenceQuote } from '../ui/index.js';
import { InfoBtn, PrivacyLink } from '../ui/info.js';
import { FIXED, STAGE_LABEL, reasonCopy } from '../core/copy.js';
import { readStep, saveStep } from './draft.js';

const GAP = { role: '본인 역할', result: '관찰된 결과', reason: '판단 기준', number: '수치·기록' };
const FORMATS = [['general', '일반 면접'], ['pressure', '압박 면접 (준비 중)', true], ['blind', '블라인드 면접 (준비 중)', true], ['personality', '인성 면접 (준비 중)', true], ['technical', '기술 면접 (준비 중)', true], ['situational', '상황 면접 (준비 중)', true]];
const WRENCH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
let ctx = { loading: true, busy: false, searching: false, detail: null, claims: null, plan: null };

const SECTION_INFO = { comp: 'evidence.comp', format: 'evidence.format', search: 'evidence.search', persona: 'evidence.persona' };
const section = (id, title, body, tools = '') => `<section class="ev-sec" id="ev-${id}"><div class="ev-head"><h3>${esc(title)}${SECTION_INFO[id] ? InfoBtn(SECTION_INFO[id]) : ''}</h3>${tools}</div><div class="ev-body">${body}</div></section>`;
const REFRESH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
// 같은 자료는 저장된 분석 결과를 재사용한다(비용 절감). 이 버튼은 저장본을 무시하고 다시 분석한다.
const refreshBtn = (id, label) => `<button class="${ctx.busy ? 'ghost small' : 'icon-btn'}" type="button" id="${id}" aria-label="${ctx.busy ? '학교 자료 분석 중...' : label}" title="${label}"${ctx.busy || ctx.searching ? ' disabled' : ''}>${ctx.busy ? '학교 자료 분석 중...' : REFRESH}</button>`;
const wrench = (id) => `<button class="icon-btn" type="button" id="${id}" aria-label="직접 수정" title="직접 수정">${WRENCH}</button>`;

// 핵심 역량·인재상을 한 표로: 직접 입력한 항목이 먼저, 그 뒤 학교 자료에서 뽑은 인재상·역량(원문 인용 포함). 질문 계획의 '학업·전공 적합성' 단계가 이 표의 항목을 쓴다.
function competencies(inst) {
  const sa = inst?.school_analysis || {};
  const rows = [
    ...(inst?.custom_competencies || []).map((c) => ({ label: c.label, src: StateBadge('직접 입력', 'info'), quote: '' })),
    ...(sa.talent_traits || []).map((t) => ({ label: t.label, src: StateBadge('자료 원문', 'ok'), quote: t.quote !== t.label ? t.quote : '' })),
  ];
  // 독립 자료 분석은 검색 결과와 구분한다.
  if (!rows.length && (ctx.busy || ctx.loading)) return `<p class="fine" role="status">${ctx.busy ? '학교 자료 분석 중...' : '불러오는 중...'}</p>`;
  if (!rows.length) return `<p class="fine">질문 근거로 확인된 역량은 아직 없습니다. 모집요강 원문을 입력하거나 <button class="ghost small" type="button" id="compAddBtn">직접 등록</button>할 수 있습니다. 학교·전형·인재상 정보는 위 Gemini 검색에서 확인하세요.</p>`;
  return `<table class="ev-table"><thead><tr><th scope="col">역량·인재상</th><th scope="col">출처</th><th scope="col">원문 근거</th></tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${esc(r.label)}</th><td>${r.src}</td><td>${r.quote ? `<q>${esc(r.quote)}</q>` : '<span class="meta">—</span>'}</td></tr>`).join('')}</tbody></table>
    <p class="fine">질문에 반영할 역량입니다. 원문 근거는 입력한 모집요강·자료에서 확인합니다. 위 Gemini 검색 결과는 이 목록으로 자동 변환하지 않습니다.</p>`;
}

function formatBody(inst) {
  const custom = inst?.custom_interview_format;
  const quotes = (inst?.school_analysis?.interview_format || []).map((f) => `<li>${EvidenceQuote({ quote: f.quote })}</li>`).join('');
  return `<p><span class="val">연습 형태: 일반 면접</span> ${custom ? StateBadge('직접 선택', 'info') : ''}</p>${quotes ? `<ul class="claims">${quotes}</ul>` : ''}`;
}

function weightsBody(inst) {
  const sa = inst?.school_analysis;
  const weights = sa?.evaluation_weights;
  if (ctx.busy || ctx.loading) return '<p class="fine" role="status">평가 비율 확인 중...</p>';
  if (!weights?.items?.length) return `<p class="meta">${esc(weights?.reason || '입력한 자료에서 해당 전형의 평가 비율이 확인되지 않았습니다.')}</p><p class="fine">학교·학과·전형이 적힌 모집요강을 입력하거나 위 Gemini 검색에서 확인해 주세요.</p>`;
  const source = (id) => sa.sources?.find((s) => s.id === id);
  return `<p class="meta">${esc([weights.target.school, weights.target.department, weights.target.track].filter(Boolean).join(' · '))}</p>
    <div class="weight-grid">${weights.items.map((w) => { const s = source(w.source_id); return `<div class="weight-item"><p class="meta">${esc([w.year && `${w.year}학년도`, w.stage].filter(Boolean).join(' · ') || '단계·학년도 미명시')}</p><strong>${w.percent}<small>%</small></strong><p>${esc(w.label)}</p><details><summary>원문·출처</summary><q>${esc(w.quote)}</q><p class="fine">${esc(s?.status === 'official_verified' ? '수집한 공식 자료' : s?.status === 'demo_fixture' ? '데모 예시 · 공식 정보 아님' : '사용자 제공 자료 · 공식 확인 전')} · ${esc(s?.title || '')}${s?.url ? ` · <a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">출처 열기</a>` : ''}</p></details></div>`; }).join('')}</div><p class="fine">모집요강에 적힌 비율입니다. 연습 점수의 가중치로 사용하지 않습니다. 최신 공식 요강을 확인해 주세요.</p>`;
}

// 면접관 관점(가상 역할): 고른 조합과 이유, 쓸 수 없는 관점은 이유와 함께 회색으로 보인다. 질문 설계·꼬리질문의 초점과 말투만 바꾸며 평가 기준·점수는 그대로다.
const comboId = () => ctx.combo || ctx.personas?.default_combination || null;
function personaBody() {
  const pe = ctx.personas;
  if (!pe) return '<p class="fine" role="status">불러오는 중…</p>';
  const combo = pe.combinations.find((c) => c.id === comboId());
  const byId = new Map(pe.personas.map((p) => [p.id, p]));
  const chosen = (combo?.persona_ids || []).map((i) => byId.get(i)).filter(Boolean);
  const off = pe.personas.filter((p) => !p.available);
  return `<p><span class="val">${esc(combo?.label || '')}</span></p>
    <ul class="plain">${chosen.map((p) => `<li><span class="tag">${esc(p.short_name)}</span> ${esc(p.role_summary)}</li>`).join('')}</ul>
    ${off.map((p) => `<p class="meta persona-off">${esc(p.name)} — 사용 불가: ${esc(p.unavailable_reason)}</p>`).join('')}
    <p class="fine">${esc(pe.notice)}</p>`;
}

// 개인정보·블라인드 사전 검사 결과: 지원서에서 AI로 보내기 전에 가린 표현의 종류만 알린다(원문은 싣지 않는다).
function privacyBody() {
  const pv = state.profile?.privacy;
  if (!pv) return '<p class="meta">이 학생부·활동 자료의 블라인드·개인정보 검사 결과는 새로 분석할 때 표시됩니다.</p>';
  return pv.masked?.length
    ? `<p><strong>AI로 보내기 전에 가린 표현</strong>: ${pv.masked.map((m) => `<span class="tag">${esc(m.label)}</span>`).join(' ')}</p><p class="fine">개인정보·출신 고교·부모 및 친인척의 직업 등 사회적 지위를 드러내는 원문은 저장하지 않았고, 질문 근거에는 가린 글만 쓰입니다.</p>`
    : '<p>개인정보나 출신 고교·부모의 직업 등 사회적 지위를 드러내는 표현을 찾지 못했습니다. 면접 중 답변도 같은 블라인드 검사를 거쳐, 감지되면 AI로 보내지 않고 다시 답하게 합니다.</p>';
}

// 검색 결과는 약관상 수정 없이 그대로 보여 준다. 방금 검색한 결과만 출처 링크·추천 검색어와 함께, 지난 기록은 텍스트만(링크는 저장하지 않음).
function searchBody(inst) {
  const fresh = ctx.lastSearch;
  const h = fresh || inst?.search_history?.[0];
  const btn = `<button class="ghost small" type="button" id="schoolSearchBtn"${ctx.searching ? ' disabled' : ''}>${ctx.searching ? '검색 중…' : h ? `${REFRESH} 다시 검색` : '학교·전형 검색'}</button>`;
  if (!h) return `<p class="fine">대학·학과·전형을 기준으로 Gemini가 Google 검색에서 공식 모집요강·입학처·대학 홈페이지를 찾아 학교 정보, 전형, 면접, 평가 비율, 인재상·교육목표를 함께 조사합니다.</p><div class="actions">${btn}</div><p class="fine" id="searchNote" role="status">${esc(ctx.searching ? '학교·전형·인재상을 검색하는 중입니다…' : ctx.searchNote || '')}</p>`;
  const src = (fresh?.sources || []).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a></li>`).join('');
  return `<p class="fine">Gemini Google 검색으로 찾은 학교·전형·인재상 정보입니다. 대학 공통 인재상과 해당 전형의 평가 기준은 다를 수 있습니다. 확인되지 않은 정보는 "확인 안 됨"으로 표시합니다.</p>
    <div class="actions">${btn}${StateBadge(FIXED.aiSearch, 'warn')}<span class="meta">${esc(fmtDate(h.searched_at))}${fresh ? '' : ' · 지난 기록'}</span></div>
    <div class="school-search-result" role="region" aria-label="학교·전형·인재상 검색 결과">${esc(h.text)}</div>
    ${src ? `<ul class="plain source-list">${src}</ul>` : ''}
    ${fresh?.suggestions_html ? '<iframe class="search-suggestions" title="Google 검색 추천" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>' : ''}
    <p class="fine" id="searchNote" role="status">${esc(ctx.searchNote || '')}</p>`;
}

function paint() {
  const { detail, claims, plan } = ctx;
  if (!detail) return;
  const ex = detail.current_version?.extracted || {};
  const inst = detail.institution || null;
  $('#evStepper').innerHTML = Stepper(['지원 정보', '근거 확인', '면접 준비'], 1);
  $('#evidenceBody').innerHTML = `
    ${section('search', '학교·전형·인재상 · Gemini 검색', `<p class="val">${esc([detail.school_name || detail.target_name, detail.department || detail.role, detail.track].filter(Boolean).join(' · '))}</p>${searchBody(inst)}`)}
    <div class="ev-grid">
      ${section('comp', '면접 질문에 반영할 역량', competencies(inst), `${refreshBtn('reanalyzeBtn', '자료 원문 다시 분석')}${wrench('editCompBtn')}`)}
      ${section('format', '면접 형태', formatBody(inst), wrench('editFormatBtn'))}
    </div>
    <details class="ev-sec"><summary>입력한 모집요강의 평가 비율</summary>${weightsBody(inst)}</details>
    <div class="ev-grid">
      ${section('persona', '면접관 관점', personaBody(), wrench('editPersonaBtn'))}
      ${section('privacy', '개인정보·블라인드 검사', `${privacyBody()}<p class="fine">${PrivacyLink('blind')}</p>`)}
    </div>
    ${ctx.needsReapproval ? '<p class="missing" role="status">내용이 바뀌어 다시 승인해야 합니다.</p>' : ''}`;
  const frame = $('#evidenceBody .search-suggestions');
  if (frame) {
    // sandbox(스크립트 차단) 안에서만 렌더. 링크는 새 탭으로 열어 iframe 문서가 바뀌며 미리보기가 사라지지 않게 한다(base target).
    const html = `<base target="_blank">${ctx.lastSearch.suggestions_html}`;
    let loads = 0;
    frame.addEventListener('load', () => { if (++loads > 1 && ctx.lastSearch) { loads = 0; frame.srcdoc = html; } }); // 그래도 문서가 바뀌면 한 번 복원
    frame.srcdoc = html;
  }
  $('#approveBtn').disabled = !!(ctx.busy || ctx.loading || ctx.approving);
}

const optional = (path) => api(path).catch(() => null);
async function refresh(id) {
  const [detail, cl, plan, personas] = await Promise.all([api(`/profiles/${id}`), optional(`/profiles/${id}/claims`), optional(`/profiles/${id}/plan`), ctx.personas || optional('/personas')]);
  ctx.personas = personas;
  ctx.detail = detail; ctx.claims = Array.isArray(cl?.claims) ? cl.claims : null; ctx.plan = plan;
  ctx.needsReapproval = ctx.needsReapproval || !!cl?.needs_reapproval;
  state.sources = detail.sources || [];
  paint();
}

export async function renderEvidence(detail, created, { autoAnalyze = false } = {}) {
  ctx = { busy: false, loading: true, searching: false, showDetail: false, detail, claims: null, plan: null, needsReapproval: false, personas: null, combo: readStep('evidence')?.combo || null };
  $('#evidenceState').textContent = '확인 필요';
  $('#evidenceState').className = 'state-badge warn';
  paint();
  const id = detail.id || created.id;
  await refresh(id).catch((err) => setError('#evidenceError', err.message));
  ctx.loading = false; paint();
  // 학교 정보의 기본 경로는 Gemini 검색이다. 자료 원문 추출은 사용자가 별도로 요청할 때만 한다.
  if (autoAnalyze && !detail.institution?.search_history?.length) await runSearch();
}

async function editCompetencies() {
  const cur = (ctx.detail?.institution?.custom_competencies || []).map((c) => c.label).join('\n');
  const v = await dialog({ title: '핵심 역량·인재상 직접 입력', message: '한 줄에 하나, 최대 8개', label: '역량', value: cur, multiline: true, okText: '저장' });
  if (v === null) return;
  await saveCustom({ competencies: v.split('\n').map((s) => s.trim()).filter(Boolean) });
}
async function editFormat() {
  const v = await dialog({ title: '면접 형태 선택', label: '면접 형태', choices: FORMATS, value: ctx.detail?.institution?.custom_interview_format || 'general', okText: '저장' });
  if (v === null) return;
  await saveCustom({ interview_format: v });
}
async function editPersona() {
  const pe = ctx.personas;
  if (!pe) return;
  const v = await dialog({ title: '면접관 관점 선택', message: '질문의 초점과 말투만 달라집니다. 점수 기준은 같습니다.', label: '관점', choices: [...pe.combinations.map((c) => [c.id, c.selectable ? c.label : `${c.label} (사용 불가)`, !c.selectable])], value: comboId(), okText: '저장' });
  if (v === null) return;
  ctx.combo = v;
  ctx.needsReapproval = true; state.approved = false; // 관점이 바뀌면 질문 계획을 다시 확정해야 한다
  paint();
}
async function saveCustom(body) {
  try {
    const r = await api(`/profiles/${state.profile.id}/customization`, { method: 'PATCH', idempotent: true, body });
    if (r.needs_reapproval) { ctx.needsReapproval = true; state.approved = false; }
    await refresh(state.profile.id);
  } catch (err) { setError('#evidenceError', err.message); }
}
async function reanalyze() {
  ctx.busy = true; paint();
  try { if (!(await ensureGuestAiConsent())) return; await api(`/profiles/${state.profile.id}/school-analysis`, { method: 'POST', idempotent: true, body: { refresh: true } }); await refresh(state.profile.id); } catch (err) { setError('#evidenceError', err.message); }
  finally { ctx.busy = false; paint(); }
}
async function runSearch() {
  ctx.searching = true; paint();
  try {
    if (!(await ensureGuestAiConsent())) return;
    const r = await api(`/profiles/${state.profile.id}/school-search`, { method: 'POST', idempotent: true, body: {} });
    ctx.searching = false;
    if (r.status === 'ok') ctx.lastSearch = r.entry;
    await refresh(state.profile.id);
    ctx.searchNote = r.status === 'blocked' ? reasonCopy(r.reason) : r.status === 'failed' ? '검색 결과를 확인하지 못했습니다. 공식 자료를 직접 확인하거나 다시 검색해 주세요.' : ''; paint();
  } catch (err) { setError('#evidenceError', err.message); }
  finally { ctx.searching = false; paint(); }
}

$('#evidenceBody')?.addEventListener('click', (e) => {
  if (!state.profile) return;
  if (e.target.closest('#editCompBtn, #compAddBtn')) editCompetencies();
  else if (e.target.closest('#reanalyzeBtn') && !ctx.busy) reanalyze();
  else if (e.target.closest('#editFormatBtn')) editFormat();
  else if (e.target.closest('#editPersonaBtn')) editPersona();
  else if (e.target.closest('#schoolSearchBtn') && !ctx.searching) runSearch();
});

$('#evidenceDraftBtn')?.addEventListener('click', () => { saveStep('evidence', { combo: comboId() }); toast('임시저장했습니다.'); });

$('#approveBtn')?.addEventListener('click', async () => {
  if (ctx.busy || ctx.loading || !state.profile) return;
  const btn = $('#approveBtn');
  ctx.approving = true;
  const done = busyButton(btn, '면접 질문 생성 중...');
  setError('#evidenceError', '');
  try {
    if (!(await ensureGuestAiConsent())) return;
    const ap = await api(`/profiles/${state.profile.id}/approve`, { method: 'POST', idempotent: true, body: { version_id: state.versionId, persona_combination: comboId() || undefined } });
    state.approved = true;
    state.personaNames = ap.personas?.names || [];
    $('#evidenceState').textContent = '승인 완료';
    $('#evidenceState').className = 'state-badge ok';
    go('setup');
    toast('승인했습니다. 질문 계획이 확정됐습니다.');
  } catch (err) {
    setError('#evidenceError', err.message);
  } finally {
    ctx.approving = false; done();
  }
});

