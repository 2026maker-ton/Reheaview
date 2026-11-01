import { ensureGuestAiConsent } from '../core/guest-ai.js';
// 화면 상단 AI 기능 스위치(입장 잠금 뒤에서만 동작, 비밀번호 없음). 끄면 서버가 모든 외부 AI 호출을 막고 규칙 기반 기본 동작만 남긴다.
import { $ } from '../core/format.js';
import { api } from '../core/api.js';
import { toast } from '../core/toast.js';
import { state } from '../core/state.js';
import { refreshModeChip } from '../core/providers.js';

const paint = (on) => {
  const b = $('#aiSwitch');
  if (!b) return;
  b.hidden = false;
  b.setAttribute('aria-checked', String(on));
  b.dataset.on = String(on);
  b.title = on ? 'AI 기능 켜짐 · 눌러서 끄기' : 'AI 기능 꺼짐 · 눌러서 켜기';
};

export async function initAiSwitch() {
  const b = $('#aiSwitch');
  if (!b || b.dataset.ready) return;
  b.dataset.ready = '1';
  try { paint((await api('/ai-switch', { auth: false })).on); } catch { return; } // 서버에 스위치가 없으면 숨긴 채 둔다
  b.addEventListener('click', async () => {
    const next = b.getAttribute('aria-checked') !== 'true';
    try {
      if (next && !(await ensureGuestAiConsent({ turningOn: true }))) return;
      const r = await api('/ai-switch', { method: 'POST', auth: false, body: { on: next } });
      paint(r.on);
      toast(r.on ? 'AI 기능을 켰습니다.' : 'AI 기능을 껐습니다. 기본 동작만 가능합니다.');
      if (state.user) refreshModeChip();
    } catch (err) { toast(err.message, true); }
  });
}
