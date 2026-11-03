import { ensureGuestAiConsent } from '../core/guest-ai.js';
import { busyButton } from '../core/busy.js';
// 면접 준비: 답변 방식(음성/텍스트)·마이크 확인·시작. 면접 형태는 일반 면접 5단계로 고정이다.
import { $, $$, esc, setError, uuid } from '../core/format.js';
import { refreshModeChip } from '../core/providers.js';
import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { enterRoom } from './room.js';
import { openMic } from '../core/vad.js';
import { Stepper } from '../ui/index.js';
import { toast } from '../core/toast.js';
import { readStep, saveStep } from './draft.js';
import { fetchTtsStatus, getTtsVoice, setTtsVoice } from '../core/tts.js';

$('#setupStepper').innerHTML = Stepper(['지원 정보', '근거 확인', '면접 준비'], 2);

async function refreshTtsPicker() {
  const select = $('#ttsVoice');
  const note = $('#ttsSetupStatus');
  if (!select || !note) return;
  const requestedProfile = state.profile?.id;
  try {
    const tts = await fetchTtsStatus();
    if (state.profile?.id !== requestedProfile) return;
    const wanted = state.ttsVoice || getTtsVoice();
    select.replaceChildren(...tts.voices.map((v) => new Option(`${v.name} · ${v.description}`, v.key)), new Option('브라우저 기본 음성', 'browser'));
    select.value = [...select.options].some((o) => o.value === wanted) ? wanted : 'default';
    setTtsVoice(select.value);
    note.textContent = select.value === 'browser' ? '브라우저 내장 음성으로 읽습니다. ElevenLabs로 보내지 않습니다.' : tts.message;
  } catch {
    note.textContent = '음성 연결 상태를 확인하지 못했습니다. 면접 시작 시 다시 확인합니다.';
  }
}
$('#ttsVoice')?.addEventListener('change', (e) => {
  setTtsVoice(e.target.value);
  $('#ttsSetupStatus').textContent = e.target.value === 'browser' ? '브라우저 내장 음성으로 읽습니다. ElevenLabs로 보내지 않습니다.' : state.ttsStatus?.message || '선택한 음성을 면접 질문 낭독에 사용합니다.';
});

export function updateSetupSummary() {
  const el = $('#setupSummary');
  if (!el || !state.profile) return;
  const p = state.profile;
  const names = state.personaNames?.length ? ` · 면접관 관점: ${esc(state.personaNames.join(' · '))}` : '';
  el.innerHTML = `<strong>${esc(p.school_name || p.target_name || '')} · ${esc(p.department || p.role || '')}</strong>${p.track ? ` <span class="meta">${esc(p.track)}</span>` : ''}<p class="meta">일반 면접 · 본질문 5개 · 답변당 1분${names}</p>`;
}

// 음성은 서버 전사(Groq)를 쓸 수 있을 때만 고를 수 있다. 막히면 텍스트로 시작하고 이유를 보인다.
function applyInputModes() {
  const stt = state.stt;
  const usable = !!(stt?.configured && stt.provider === 'groq-whisper' && stt.real_data_allowed && navigator.mediaDevices?.getUserMedia);
  const voice = $('#setupForm input[value=groq]');
  voice.disabled = !usable;
  voice.closest('label').classList.toggle('disabled', !usable);
  const note = $('#inputModeUnavailable');
  note.hidden = usable;
  note.textContent = usable ? '' : `음성 답변을 쓸 수 없어 텍스트로 진행합니다. ${stt?.message || ''}`;
  (usable ? voice : $('#setupForm input[value=text]')).checked = true;
  $('#micCheck').hidden = !usable;
}

const setupDraft = () => ({ input_mode: new FormData($('#setupForm')).get('input_mode') || 'text', blind_ack: $('#blindAck').checked });
function restoreSetupDraft() {
  const d = readStep('setup');
  if (!d) return;
  const radio = $(`#setupForm input[value=${d.input_mode === 'groq' ? 'groq' : 'text'}]`);
  if (radio && !radio.disabled) radio.checked = true;
  $('#blindAck').checked = !!d.blind_ack;
}
$('#setupDraftBtn')?.addEventListener('click', () => { saveStep('setup', setupDraft()); toast('임시저장했습니다.'); });
window.addEventListener('hashchange', () => { if (state.user && location.hash !== '#/setup' && $('#setupForm') && !$('#screen-setup').hidden) saveStep('setup', setupDraft()); });

export async function refreshSetup() {
  updateSetupSummary();
  applyInputModes(); // 마지막으로 알던 상태로 먼저 그리고, 서버 상태로 다시 맞춘다
  try { state.stt = await api('/stt/status' + (state.profile?.id ? `?profile_id=${encodeURIComponent(state.profile.id)}` : '')); } catch { /* 이전 값 유지 */ }
  applyInputModes();
  restoreSetupDraft();
  await refreshModeChip();
  await refreshTtsPicker();
}
window.addEventListener('hashchange', () => { if (location.hash === '#/setup') refreshSetup(); });
$$('#setupForm input[name="input_mode"]').forEach((r) => r.addEventListener('change', () => { $('#micCheck').hidden = r.value !== 'groq' || !r.checked; }));

// 마이크 확인: 3초 동안 입력 크기만 보여 준다(녹음·전송 없음).
$('#micTestBtn')?.addEventListener('click', async () => {
  const btn = $('#micTestBtn');
  btn.disabled = true;
  try {
    const mic = await openMic();
    $('#micStatus').textContent = '말해 보세요';
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        $('#micMeter').style.width = `${Math.min(100, Math.round(mic.level() * 400))}%`;
        if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else resolve();
      };
      tick();
    });
    mic.close();
    $('#micMeter').style.width = '0';
    $('#micStatus').textContent = '마이크 확인 완료';
  } catch {
    $('#micStatus').textContent = '마이크를 사용할 수 없습니다. 텍스트로 진행해 주세요.';
    $('#setupForm input[value=text]').checked = true;
  } finally { btn.disabled = false; }
});

$('#setupForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.approved) return setError('#setupError', '근거를 승인해야 시작할 수 있습니다.');
  if (!$('#blindAck').checked) { setError('#setupError', '시작 전 확인 항목에 체크해 주세요.'); toast('시작 전 확인 항목에 체크해 주세요.', true); $('#blindCheck').scrollIntoView?.({ block: 'center' }); return; }
  const btn = $('#startBtn');
  setError('#setupError', '');
  const done = busyButton(btn, '면접 준비 중...');
  try {
    if (!(await ensureGuestAiConsent())) return;
    const input_mode = new FormData(e.target).get('input_mode') || 'text';
    state.lastInputMode = input_mode; // 결과 화면의 "다시 면접 보기"가 같은 방식으로 시작한다
    const s = await api('/sessions', { method: 'POST', idempotent: true, body: { profile_version_id: state.versionId, interview_format: 'general', input_mode } });
    state.session = { id: s.id, version: s.version, state: 'ready' };
    const started = await api(`/sessions/${s.id}/commands`, { method: 'POST', idempotent: true, body: { command_id: uuid(), expected_version: s.version, type: 'session.start', payload: {} } });
    state.session.version = started.version;
    enterRoom({ session: { ...s, input_mode, answer_seconds: s.limits.answer_seconds }, started });
  } catch (err) {
    setError('#setupError', err.message);
  } finally {
    done();
  }
});

window.addEventListener('guest-ai-ready', () => { if (location.hash === '#/setup') refreshSetup(); });
