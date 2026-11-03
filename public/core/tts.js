// 서버가 선택한 면접관 문장만 요청한다. API 키·임의 합성 문장은 브라우저에서 보내지 않는다.
import { apiUrl } from './api.js';
import { state } from './state.js';
import { uuid } from './format.js';

let pending = null;
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
  const active = () => pending === current && !current.controller.signal.aborted;
  const live = state.providerStatus?.operations?.['speech.synthesize']?.mode === 'live';
  try {
    if (live && target && state.session?.id) {
      status('면접관 AI 음성을 준비하고 있습니다.');
      const timeout = setTimeout(() => current.controller.abort(), 20000);
      let res;
      try {
        res = await fetch(apiUrl(`/sessions/${encodeURIComponent(state.session.id)}/tts`), {
          method: 'POST', signal: current.controller.signal,
          headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': uuid() },
          body: JSON.stringify({ target }),
        });
        if (!active()) return;
        if (res.status === 200 && /^audio\//.test(res.headers.get('content-type') || '')) {
          const blob = await res.blob();
          if (!active()) return;
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
              status('ElevenLabs AI 합성 음성');
              audio.play().catch((e) => { clearTimeout(timer); reject(e); });
            });
            if (pending === current) pending = null;
            return;
          } finally { audio.pause(); audio.onended = audio.onerror = null; URL.revokeObjectURL(url); }
        }
      } finally { clearTimeout(timeout); }
    }
  } catch {
    // stopSpeech 이후에는 늦게 온 응답·재생 오류로 브라우저 낭독을 재개하지 않는다.
    if (pending !== current) return;
  }
  if (pending !== current) return;
  status(live ? '서버 음성을 사용할 수 없어 브라우저 합성 음성으로 읽습니다.' : '브라우저 합성 음성');
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
