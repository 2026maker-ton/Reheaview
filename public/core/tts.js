// 서버가 선택한 면접관 문장만 요청한다. API 키·임의 합성 문장은 브라우저에서 보내지 않는다.
import { api, apiUrl } from './api.js';
import { state } from './state.js';
import { uuid } from './format.js';

let pending = null;
const VOICE_KEY = 'reheaview.tts.voice';
const CHOICES = new Set(['default', 'george', 'sarah', 'daniel', 'charlotte', 'browser']);
export function getTtsVoice() {
  try { const v = localStorage.getItem(VOICE_KEY); return CHOICES.has(v) ? v : 'default'; } catch { return 'default'; }
}
export function setTtsVoice(value) {
  if (!CHOICES.has(value)) return;
  try { localStorage.setItem(VOICE_KEY, value); } catch { /* 저장소가 막혀 있어도 현재 화면의 선택은 적용 */ }
  state.ttsVoice = value;
}
export async function fetchTtsStatus() {
  const query = state.profile?.id ? `?profile_id=${encodeURIComponent(state.profile.id)}` : state.session?.id ? `?session_id=${encodeURIComponent(state.session.id)}` : '';
  state.ttsStatus = await api('/tts/status' + query);
  return state.ttsStatus;
}
const fallbackText = (reason) => ({
  not_configured: 'ElevenLabs 연결 설정이 완료되지 않아 브라우저 음성으로 읽습니다.',
  live_ack_missing: 'ElevenLabs 사용이 활성화되지 않아 브라우저 음성으로 읽습니다.',
  synthetic_only: 'ElevenLabs 서버 설정을 확인해 주세요. 브라우저 음성으로 읽습니다.',
  real_data_ack_missing: '실제 자료의 음성 처리 설정이 필요해 브라우저 음성으로 읽습니다.',
  consent_missing: '성인 확인·처리 동의가 필요해 브라우저 음성으로 읽습니다.',
  highschool_mock: '외부 음성 이용 동의를 확인해 주세요. 브라우저 음성으로 읽습니다.',
  kill_switch: 'AI가 꺼져 있어 브라우저 음성으로 읽습니다.',
  budget_cap: '음성 사용 한도에 도달해 브라우저 음성으로 읽습니다.',
  rate_limited: '음성 요청이 많아 브라우저 음성으로 읽습니다.',
  disabled: '브라우저 합성 음성',
})[reason] || '서버 음성을 사용할 수 없어 브라우저 합성 음성으로 읽습니다.';
const status = (text) => { const el = document.querySelector('#ttsStatus'); if (el) el.textContent = text; };

export function stopSpeech() {
  const current = pending;
  pending = null;
  current?.controller.abort();
  current?.finish();
  try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
}

export async function speakInterviewer(text, target) {
  stopSpeech();
  if (!text) return;
  const current = { controller: new AbortController(), finish: () => {} };
  pending = current;
  const active = () => pending === current;
  const voiceKey = state.ttsVoice || getTtsVoice();
  const useServer = voiceKey !== 'browser' && target && state.session?.id;
  let fallbackNote = useServer ? fallbackText('provider_error') : '브라우저 합성 음성';
  try {
    // 캐시된 providerStatus가 mock이어도 서버에 확인한다. 실제 전송 허용은 서버 게이트만 결정한다.
    if (useServer) {
      status('면접관 AI 음성을 준비하고 있습니다.');
      const timeout = setTimeout(() => current.controller.abort(), 20000);
      let res;
      try {
        res = await fetch(apiUrl(`/sessions/${encodeURIComponent(state.session.id)}/tts`), {
          method: 'POST', signal: current.controller.signal,
          headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': uuid() },
          body: JSON.stringify({ target, voice_key: voiceKey }),
        });
        if (!active()) return;
        if (current.controller.signal.aborted) throw new Error('audio request timeout');
        if (res.status === 200 && /^audio\//.test(res.headers.get('content-type') || '')) {
          const blob = await res.blob();
          if (!active()) return;
          if (current.controller.signal.aborted) throw new Error('audio request timeout');
          if (!blob.size || blob.size > 2 * 1024 * 1024) throw new Error('invalid audio');
          clearTimeout(timeout);
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          try {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('audio playback timeout')), 5000 + [...text].length * 250);
              current.finish = () => { clearTimeout(timer); audio.pause(); resolve(); };
              audio.onended = current.finish;
              audio.onerror = () => { clearTimeout(timer); reject(new Error('audio playback failed')); };
              const selected = state.ttsStatus?.voices?.find((v) => v.key === voiceKey);
              status(`${selected?.name || '선택한 음성'} · ElevenLabs AI 합성 음성`);
              audio.play().catch((e) => { clearTimeout(timer); reject(e); });
            });
            if (pending === current) pending = null;
            return;
          } finally { audio.pause(); audio.onended = audio.onerror = null; URL.revokeObjectURL(url); }
        }
        fallbackNote = fallbackText(res.headers.get('x-tts-reason') || (res.status === 429 ? 'rate_limited' : res.status === 401 ? 'consent_missing' : 'provider_error'));
      } finally { clearTimeout(timeout); }
    }
  } catch {
    // stopSpeech 이후에는 늦게 온 응답·재생 오류로 브라우저 낭독을 재개하지 않는다.
    if (pending !== current) return;
  }
  if (pending !== current) return;
  status(fallbackNote);
  try {
    if (!window.speechSynthesis) { status('음성을 재생할 수 없습니다. 화면의 질문을 읽어 주세요.'); return; }
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR'; u.rate = 1;
      const timer = setTimeout(resolve, 1500 + [...text].length * 160);
      current.finish = () => { clearTimeout(timer); resolve(); };
      u.onend = u.onerror = current.finish;
      window.speechSynthesis.speak(u);
    });
  } catch {
    status('음성을 재생할 수 없습니다. 화면의 질문을 읽어 주세요.');
  } finally { if (pending === current) pending = null; }
}
