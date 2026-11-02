// 로그인·가입·로그아웃. 토큰은 서버가 발급한 로그인 토큰만 저장한다(비밀번호는 저장하지 않음).
import { $, $$, setError } from '../core/format.js';
import { api } from '../core/api.js';
import { state, setToken, resetFlow } from '../core/state.js';
import { go } from '../core/router.js';
import { toast } from '../core/toast.js';
import { loadProvider } from './dashboard.js';
import { clearDraft } from './draft.js';
import { ensureGuestAiConsent } from '../core/guest-ai.js';

function needsBasicsRedirect() {
  return state.user && !state.user.guest && state.user.basics_complete === false;
}

function onLandingScreen() {
  const raw = (location.hash || '').replace(/^#\/?/, '') || 'landing';
  return raw === 'landing';
}

function showUser() {
  $('#userMenu').hidden = !state.user;
  $('#userName').textContent = state.user?.name ? (state.user.guest ? state.user.name : `${state.user.name}님`) : '';
  $('#guestLoginBtn').hidden = !state.user?.guest;
  $('#guestAiBtn').hidden = !state.user?.guest || !!state.user.ai_consent;
  $('#myProfileBtn').hidden = !!state.user?.guest;
  $('#logoutBtn').hidden = !!state.user?.guest;
  // 소개 랜딩에서는 게스트 개인정보 배너를 숨기고, 연습 공간(앱 화면) 진입 후에만 표시한다.
  $('#guestWarning').hidden = !state.user?.guest || dismissedGuest === state.user.id || onLandingScreen();
}
let dismissedGuest = null;
$('#dismissGuestWarning')?.addEventListener('click', () => { dismissedGuest = state.user?.id; showUser(); });
$('#guestAiBtn')?.addEventListener('click', async () => { try { if (await ensureGuestAiConsent({ turningOn: true })) await loadProvider(); } catch (err) { toast(err.message, true); } });
$('#guestLoginBtn')?.addEventListener('click', () => signedOut(''));

export async function startGuest() {
  const r = await api('/auth/guest', { method: 'POST', body: {}, auth: false });
  setToken(r.token); state.user = r.user; showUser();
}

// 저장된 토큰으로 사용자 확인. 실패하면 로그아웃 상태.
export async function loadMe() {
  if (!state.token) { state.user = null; showUser(); return false; }
  try { state.user = await api('/auth/me'); } catch { state.user = null; setToken(''); }
  showUser();
  return !!state.user;
}

let handling = false;
// message: 401(만료·서버 초기화)로 나간 경우 이유를 알린다. 직접 로그아웃은 메시지 없음.
export function signedOut(message = '로그인이 만료됐습니다. 다시 로그인해 주세요.') {
  if (handling) return;
  handling = true;
  const wasIn = !!state.user;
  clearDraft(state.user?.id);
  setToken(''); state.user = null; resetFlow(); showUser();
  go('login');
  if (wasIn && message) toast(message, true);
  handling = false;
}

function selectTab(signup) {
  $('#tabLogin').setAttribute('aria-selected', String(!signup)); $('#tabLogin').tabIndex = signup ? -1 : 0;
  $('#tabSignup').setAttribute('aria-selected', String(signup)); $('#tabSignup').tabIndex = signup ? 0 : -1;
  $('#loginForm').hidden = signup; $('#signupForm').hidden = !signup;
  setError('#authError', '');
}
$('#tabLogin')?.addEventListener('click', () => selectTab(false));
$('#tabSignup')?.addEventListener('click', () => selectTab(true));
$$('[role=tab]').forEach((t) => t.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault(); const signup = t.id === 'tabLogin'; selectTab(signup); (signup ? $('#tabSignup') : $('#tabLogin')).focus();
}));

async function enter(path, body, btn) {
  setError('#authError', '');
  btn.disabled = true;
  try {
    const r = await api(path, { method: 'POST', body, auth: false });
    setToken(r.token); state.user = r.user; showUser();
    await loadProvider();
    go(needsBasicsRedirect() ? 'profile' : 'dashboard');
  } catch (err) {
    setError('#authError', err.message);
  } finally { btn.disabled = false; }
}
$('#loginForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  enter('/auth/login', { email: f.get('email'), password: f.get('password') }, $('#loginBtn'));
});
$('#signupForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get('age_18_confirmed') !== 'on') return setError('#authError', '만 18세 이상만 이용할 수 있습니다.');
  if (f.get('notice_ack') !== 'on') return setError('#authError', '처리 안내에 동의해 주세요.');
  enter('/auth/signup', { name: f.get('name'), email: f.get('email'), password: f.get('password'), age_18_confirmed: true, notice_ack: true }, $('#signupBtn'));
});

// 자동 게스트 진입 실패·로그아웃 뒤에도 게스트 체험 버튼을 제공한다.
async function loadAuthMode() {
  try { $('#guestBox').hidden = !(await api('/auth/mode', { auth: false })).guest_allowed; } catch { $('#guestBox').hidden = true; }
}
window.addEventListener('hashchange', () => { showUser(); if (location.hash === '#/login') loadAuthMode(); });
if (location.hash === '#/login') loadAuthMode();
$('#guestBtn')?.addEventListener('click', () => enter('/auth/guest', {}, $('#guestBtn')));

$('#logoutBtn')?.addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST', idempotent: true, body: {} }); } catch { /* 토큰은 아래에서 지운다 */ }
  signedOut('');
  toast('로그아웃했습니다.');
});

