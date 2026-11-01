import { api } from './api.js';
import { state } from './state.js';
import { $ } from './format.js';

let pending = null;
export async function ensureGuestAiConsent({ turningOn = false } = {}) {
  if (!state.user?.guest || state.user.ai_consent) return true;
  if (!turningOn && !(await api('/ai-switch', { auth: false })).on) return true;
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const dlg = $('#guestAiDialog');
    const form = $('#guestAiForm'); form.reset(); $('#guestAiError').textContent = '';
    let settled = false;
    const finish = (value) => { settled = true; dlg.close(); resolve(value); };
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!form.age_18_confirmed.checked || !form.notice_ack.checked) { $('#guestAiError').textContent = '만 18세 이상 확인과 처리 안내 동의가 필요합니다.'; return; }
      const btn = $('#guestAiAccept'); btn.disabled = true;
      try {
        await api('/consents', { method: 'POST', idempotent: true, body: { age_18_confirmed: true, notice_ack: true, notice_version: 'guest-ai-2026-11-01' } });
        state.user.ai_consent = true; $('#guestAiBtn').hidden = true; window.dispatchEvent(new Event('guest-ai-ready')); finish(true);
      } catch (err) { $('#guestAiError').textContent = err.message; }
      finally { btn.disabled = false; }
    };
    $('#guestAiCancel').onclick = () => finish(false);
    dlg.addEventListener('close', () => { if (!settled) resolve(false); }, { once: true });
    try { dlg.showModal(); } catch (err) { reject(err); }
  }).finally(() => { pending = null; });
  return pending;
}
