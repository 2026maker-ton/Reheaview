import { $, esc, setError } from '../core/format.js';
import { api } from '../core/api.js';
import { state, resetFlow, setToken } from '../core/state.js';
import { go } from '../core/router.js';
import { toast } from '../core/toast.js';
import { askConfirm, askInput, dialog } from '../core/dialog.js';
import { Stepper } from '../ui/index.js';
import { clearDraft } from './draft.js';

const STEPS = ['이름', '기본 정보', '학생부', '활동 요약'];
let onboardingStep = 0;
let basicsCache = null;
let editing = false;

function ageHint(year) {
  const y = Number(year);
  if (!y) return '';
  const age = new Date().getFullYear() - y;
  return age >= 0 ? `만 ${age}세(추정)` : '';
}

function showOnboardingShell(on) {
  $('#profileOnboarding').hidden = !on;
  $('#profileView').hidden = on;
  $('#profileForm').hidden = on;
  $('#profileStepper').hidden = !on;
  $('#profileDanger').hidden = on;
  $('.profile-back')?.toggleAttribute('hidden', on);
  $('#profileEyebrow').textContent = on ? '시작하기' : '계정';
  $('#profileLead').textContent = on
    ? '처음 로그인이에요. 아래 단계대로 면접에 필요한 기본 정보를 입력해 주세요.'
    : '면접 연습에 쓰는 기본 정보를 미리 등록해 두면 지원 정보 입력이 수월합니다.';
}

function renderOnboardingStep() {
  $('#profileStepper').innerHTML = Stepper(STEPS, onboardingStep);
  const box = $('#profileOnboarding');
  const s = onboardingStep;
  if (s === 0) {
    box.innerHTML = `
      <p class="profile-step-lead"><strong>STEP 1.</strong> 면접실과 결과에 표시할 이름을 확인해 주세요.</p>
      <label class="field"><span>이름</span><input id="obName" autocomplete="name" maxlength="20" value="${esc(state.user?.name || '')}" /></label>
      <p class="fine" id="obError" role="alert"></p>
      <div class="actions"><button class="primary" type="button" id="obNext">다음</button></div>`;
    $('#obNext').onclick = () => saveOnboardingStep({ name: $('#obName').value, step: 0 });
    return;
  }
  if (s === 1) {
    box.innerHTML = `
      <p class="profile-step-lead"><strong>STEP 2.</strong> 출생 연도를 입력해 주세요. 만 18세 이상만 이용할 수 있습니다.</p>
      <label class="field"><span>출생 연도</span><input id="obBirth" type="number" inputmode="numeric" min="1940" max="2010" value="${esc(basicsCache?.birth_year || '')}" />
      <span class="fine" id="obAge">${esc(ageHint(basicsCache?.birth_year))}</span></label>
      <p class="fine" id="obError" role="alert"></p>
      <div class="actions"><button class="ghost" type="button" id="obPrev">이전</button><button class="primary" type="button" id="obNext">다음</button></div>`;
    $('#obBirth').addEventListener('input', (e) => { $('#obAge').textContent = ageHint(e.target.value); });
    $('#obPrev').onclick = () => { onboardingStep = 0; renderOnboardingStep(); };
    $('#obNext').onclick = () => saveOnboardingStep({ birth_year: Number($('#obBirth').value), step: 1 });
    return;
  }
  if (s === 2) {
    box.innerHTML = `
      <p class="profile-step-lead"><strong>STEP 3.</strong> 학생부에서 면접에 쓸 내용을 요약해 주세요. 출신 고교·가족 직업 등 블라인드 금지 정보는 넣지 마세요.</p>
      <label class="field"><span>학생부 요약</span><textarea id="obRecord" rows="8" maxlength="15000">${esc(basicsCache?.student_record || '')}</textarea></label>
      <p class="fine" id="obError" role="alert"></p>
      <div class="actions"><button class="ghost" type="button" id="obPrev">이전</button><button class="primary" type="button" id="obNext">다음</button></div>`;
    $('#obPrev').onclick = () => { onboardingStep = 1; renderOnboardingStep(); };
    $('#obNext').onclick = () => saveOnboardingStep({ student_record: $('#obRecord').value, step: 2 });
    return;
  }
  box.innerHTML = `
    <p class="profile-step-lead"><strong>STEP 4.</strong> 활동·특기와 면접에서 강조할 메모를 입력해 주세요.</p>
    <label class="field"><span>활동·특기 요약</span><textarea id="obActivity" rows="5" maxlength="8000">${esc(basicsCache?.activity_summary || '')}</textarea></label>
    <label class="field"><span>면접 메모 (선택)</span><textarea id="obNotes" rows="3" maxlength="4000">${esc(basicsCache?.intro_notes || '')}</textarea></label>
    <p class="fine" id="obError" role="alert"></p>
    <div class="actions"><button class="ghost" type="button" id="obPrev">이전</button><button class="primary" type="button" id="obFinish">완료하고 시작하기</button></div>`;
  $('#obPrev').onclick = () => { onboardingStep = 2; renderOnboardingStep(); };
  $('#obFinish').onclick = () => saveOnboardingStep({
    activity_summary: $('#obActivity').value,
    intro_notes: $('#obNotes').value,
    step: 3,
    finish: true,
  });
}

async function saveOnboardingStep(payload) {
  const errEl = $('#obError');
  if (errEl) errEl.textContent = '';
  const body = { onboarding: true, ...payload };
  delete body.step;
  if (payload.finish) body.finish_onboarding = true;
  try {
    const r = await api('/user/basics', { method: 'PATCH', idempotent: true, body });
    basicsCache = r.basics;
    if (r.user?.name) state.user.name = r.user.name;
    if (payload.finish) {
      state.user.basics_complete = true;
      toast('기본 정보를 저장했습니다.');
      go('dashboard');
      return;
    }
    if (payload.name !== undefined) state.user.name = payload.name.trim();
    onboardingStep = Math.min(payload.step + 1, STEPS.length - 1);
    renderOnboardingStep();
  } catch (err) {
    if (errEl) errEl.textContent = err.message;
  }
}

function fillView() {
  const b = basicsCache || {};
  $('#profileViewName').textContent = state.user?.name || '—';
  $('#profileViewBirth').textContent = b.birth_year ? `${b.birth_year}년 (${ageHint(b.birth_year)})` : '—';
  $('#profileViewRecord').textContent = b.student_record?.trim() || '—';
  $('#profileViewActivity').textContent = b.activity_summary?.trim() || '—';
  $('#profileViewNotes').textContent = b.intro_notes?.trim() || '—';
}

function fillForm() {
  const f = $('#profileForm');
  const b = basicsCache || {};
  f.name.value = state.user?.name || '';
  f.birth_year.value = b.birth_year || '';
  f.student_record.value = b.student_record || '';
  f.activity_summary.value = b.activity_summary || '';
  f.intro_notes.value = b.intro_notes || '';
  f.password.value = '';
  $('#profileAgeHint').textContent = ageHint(b.birth_year);
  f.birth_year.oninput = (e) => { $('#profileAgeHint').textContent = ageHint(e.target.value); };
}

function showEditMode(on) {
  editing = on;
  $('#profileView').hidden = on;
  $('#profileForm').hidden = !on;
  $('#profileFormHint').hidden = !on;
  const pw = $('#profileForm [name=password]');
  pw.required = on;
  if (on) fillForm();
}

export async function renderProfile() {
  if (!state.user || state.user.guest) { go('dashboard'); return; }
  const onboarding = !state.user.basics_complete;
  showOnboardingShell(onboarding);
  try {
    basicsCache = await api('/user/basics');
  } catch (err) {
    toast(err.message, true);
    return;
  }
  if (onboarding) {
    onboardingStep = 0;
    if (basicsCache.birth_year) onboardingStep = 1;
    if (basicsCache.student_record?.trim()) onboardingStep = 2;
    if (basicsCache.activity_summary?.trim()) onboardingStep = 3;
    renderOnboardingStep();
    return;
  }
  fillView();
  showEditMode(false);
  $('#profileDanger').hidden = false;
}

$('#myProfileBtn')?.addEventListener('click', () => go('profile'));
$('#profileEditBtn')?.addEventListener('click', () => showEditMode(true));
$('#profileCancelBtn')?.addEventListener('click', () => { if (editing) showEditMode(false); });

$('#profileForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('#profileError', '');
  const f = new FormData(e.target);
  try {
    const r = await api('/user/basics', {
      method: 'PATCH', idempotent: true,
      body: {
        password: f.get('password'),
        name: f.get('name'),
        birth_year: Number(f.get('birth_year')),
        student_record: f.get('student_record'),
        activity_summary: f.get('activity_summary'),
        intro_notes: f.get('intro_notes'),
      },
    });
    basicsCache = r.basics;
    if (r.user?.name) state.user.name = r.user.name;
    showUserMenuName();
    fillView();
    showEditMode(false);
    toast('저장했습니다.');
  } catch (err) { setError('#profileError', err.message); }
});

function showUserMenuName() {
  const el = $('#userName');
  if (el && state.user?.name) el.textContent = `${state.user.name}님`;
}

async function discardSessions() {
  if (!(await askConfirm('면접 데이터 폐기', '모든 면접 답변·결과를 삭제합니다.', { okText: '폐기', danger: true }))) return;
  try {
    const { sessions } = await api('/sessions');
    for (const s of sessions || []) if (!['deleted', 'deleting'].includes(s.state)) await api(`/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE', idempotent: true });
    resetFlow(); clearDraft(); toast('면접 기록을 폐기했습니다.'); go('dashboard');
  } catch (err) { toast(err.message, true); }
}

async function discardAccount() {
  const typed = await askInput('계정 삭제', '확인을 위해 “삭제”를 입력하세요.', '확인 문구');
  if (typed !== '삭제') return;
  try { await api('/account', { method: 'DELETE', idempotent: true }); } catch (err) { toast(err.message, true); return; }
  clearDraft(); setToken(''); state.user = null; resetFlow(); toast('계정을 삭제했습니다.'); go('login');
}

$('#discardSessionsBtn')?.addEventListener('click', discardSessions);
$('#discardAccountBtn')?.addEventListener('click', discardAccount);

export function needsBasicsRedirect() {
  return state.user && !state.user.guest && state.user.basics_complete === false;
}
