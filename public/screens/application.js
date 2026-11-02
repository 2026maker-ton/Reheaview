import { ensureGuestAiConsent } from '../core/guest-ai.js';
import { busyButton } from '../core/busy.js';
import { $, esc, setError } from '../core/format.js';
import { toast } from '../core/toast.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { go } from '../core/router.js';
import { renderEvidence } from './evidence.js';
import { Stepper } from '../ui/index.js';
import { DRAFT_FIELDS, readDraft, saveDraft, clearDraft, markDraftForInterview } from './draft.js';

$('#appStepper').innerHTML = Stepper(['지원 정보', '근거 확인', '면접 준비'], 0);

let fixture = null; // 불러온 샘플 상세. 본문을 고치면 해제(서버가 다시 판정)
const val = (name) => String($(`#applicationForm [name=${name}]`)?.value || '');
let fillGen = 0;
const setFixture = (f) => { fixture = f; $('#fixtureBadge').hidden = !f; if (f) { fillGen += 1; const note = $('#basicsFillNote'); if (note) note.hidden = true; } };

// 샘플 목록: 서버가 DEMO_FIXTURES=on 일 때만 채운다.
let listed = false;
async function fillFixtureList() {
  if (listed) return;
  try {
    const { fixtures } = await api('/fixtures');
    $('#fixtureSelect').innerHTML = `<option value="">예시 선택</option>${(fixtures || []).map((f) => `<option value="${esc(f.id)}">${esc(f.title)}</option>`).join('')}`;
    listed = true;
  } catch { $('#fixtureSelect').closest('.sample-row').hidden = true; }
}
window.addEventListener('hashchange', () => { if (location.hash === '#/application') fillFixtureList(); });
if (location.hash === '#/application') fillFixtureList();

// 학생부 파일에서 추출한 글을 경험 자료 칸에 붙인다.
const MAX_FILE = 5 * 1024 * 1024;
let uploadKind = null;
document.querySelectorAll('[data-upload]').forEach((b) => b.addEventListener('click', () => { uploadKind = b.dataset.upload; $('#fileInput').value = ''; $('#fileInput').click(); }));
$('#fileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const status = $('#uploadStatus');
  setError('#applicationError', '');
  if (file.size > MAX_FILE) { status.textContent = ''; return setError('#applicationError', '파일은 5MB 이하만 올릴 수 있습니다.'); }
  status.textContent = `${file.name} 읽는 중…`;
  try {
    const content_base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('파일을 읽지 못했습니다.')); r.readAsDataURL(file); });
    const out = await api('/documents/extract', { method: 'POST', idempotent: true, body: { filename: file.name, mime_type: file.type, content_base64 } });
    const area = $('#applicationText');
    area.value = [area.value.trim(), out.text.trim()].filter(Boolean).join('\n\n');
    if (fixture) setFixture(null);
    status.textContent = `학생부 파일 "${file.name}"에서 ${out.char_count}자를 가져왔습니다.${out.truncated ? ' (너무 길어 일부만 가져왔습니다)' : ''}${out.warnings?.length ? ' ' + out.warnings.join(' ') : ''}`;
  } catch (err) {
    status.textContent = '';
    setError('#applicationError', err.message);
  }
});

$('#loadFixtureBtn')?.addEventListener('click', async () => {
  setError('#applicationError', '');
  await fillFixtureList();
  const id = $('#fixtureSelect').value || $('#fixtureSelect').options[1]?.value;
  if (!id) return setError('#applicationError', '불러올 샘플이 없습니다.');
  try {
    const f = await api(`/fixtures/${encodeURIComponent(id)}`);
    $('#fixtureSelect').value = id;
    const form = $('#applicationForm');
    form.school_name.value = f.school_name || '';
    form.department.value = f.department || '';
    form.track.value = f.track || '';
    form.source_text.value = f.posting_text;
    form.application_text.value = f.application_text;
    setFixture(f);
  } catch (e) {
    setError('#applicationError', e.message);
  }
});
['#sourceText', '#applicationText'].forEach((s) => $(s)?.addEventListener('input', () => { if (fixture) setFixture(null); }));

$('#applicationForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#analyzeBtn');
  setError('#applicationError', '');
  const payload = {
    org_type: 'university',
    school_name: val('school_name').trim(), department: val('department').trim(), track: val('track').trim() || undefined,
    source_text: val('source_text').trim(), application_text: val('application_text').trim(),
  };
  if (!payload.school_name || !payload.department) return setError('#applicationError', '대학교와 학과를 입력해 주세요.');
  // 합성 판정은 서버가 정하며, 본문이 샘플과 정확히 같을 때만 fixture_id를 보낸다.
  if (fixture && payload.source_text === fixture.posting_text && payload.application_text === fixture.application_text) payload.fixture_id = fixture.id;
  // 뒤로 갔다 와서 입력을 바꾸지 않았으면 이미 분석한 결과를 그대로 쓴다(다시 만들지·분석하지 않는다).
  const key = JSON.stringify(payload);
  if (state.profile?.id && state.appKey === key) { go('evidence'); return; }
  const done = busyButton(btn, '자료 분석 중...');
  try {
    if (!(await ensureGuestAiConsent())) return;
    const created = await api('/profiles', { method: 'POST', idempotent: true, body: payload });
    state.profile = created;
    state.versionId = created.version_id;
    state.approved = false;
    state.appKey = key;
    markDraftForInterview();
    clearDraft(); // 작성 중이던 내용은 서버 프로필로 넘어갔다. 면접을 끝내면 다시 저장된 임시저장도 지운다.
    const detail = await api(`/profiles/${created.id}`);
    state.profile = { ...created, ...detail };
    state.sources = detail.sources || [];
    renderEvidence(detail, created, { autoAnalyze: true });
    go('evidence');
    if (created.pii_warnings?.length) toast(`개인정보 후보(${created.pii_warnings.join(', ')})를 가렸습니다.`);
    else if (created.privacy?.masked?.length) toast(`AI로 보내기 전에 ${created.privacy.masked.map((m) => m.label).join('·')} 표현을 가렸습니다.`);
  } catch (err) {
    setError('#applicationError', err.message);
    $('#applicationError')?.setAttribute('tabindex', '-1');
    $('#applicationError')?.focus();
  } finally {
    done();
  }
});

// ---- 임시저장: 버튼으로 저장, 화면을 나가거나 새로고침하면 자동 저장, 비어 있는 폼에 다시 오면 불러온다 ----
const formValues = () => Object.fromEntries(DRAFT_FIELDS.map((k) => [k, val(k)]));
const formEmpty = () => !DRAFT_FIELDS.some((k) => val(k).trim());
function restoreDraft() {
  const d = readDraft();
  if (!d || !formEmpty()) return;
  const form = $('#applicationForm');
  for (const k of DRAFT_FIELDS) form[k].value = d.values[k] || '';
  toast('임시저장한 내용을 불러왔습니다.');
}
async function fillFromBasics() {
  if (state.user?.guest || fixture || val('application_text').trim()) return;
  const gen = ++fillGen;
  try {
    const b = await api('/user/basics');
    if (gen !== fillGen || fixture || val('application_text').trim()) return;
    const text = [b.student_record, b.activity_summary, b.intro_notes].map((s) => String(s || '').trim()).filter(Boolean).join('\n\n');
    if (!text) return;
    $('#applicationText').value = text;
    const note = $('#basicsFillNote');
    if (note) note.hidden = false;
  } catch { /* 기본 정보가 없거나 게스트면 빈 칸으로 둔다 */ }
}
function openApplication() {
  restoreDraft();
  fillFromBasics();
}
$('#draftSaveBtn')?.addEventListener('click', () => {
  if (saveDraft(formValues())) toast('임시저장했습니다. 나갔다가 돌아와도 이어서 쓸 수 있어요.');
  else setError('#applicationError', '저장할 내용이 없습니다.');
});
let lastHash = location.hash;
window.addEventListener('hashchange', () => {
  if (lastHash === '#/application' && location.hash !== '#/application' && state.user) saveDraft(formValues());
  lastHash = location.hash;
  if (location.hash === '#/application' && state.user) openApplication();
});
window.addEventListener('beforeunload', () => { if (location.hash === '#/application' && state.user) saveDraft(formValues()); });
if (location.hash === '#/application') setTimeout(() => { if (state.user) openApplication(); }, 0);
