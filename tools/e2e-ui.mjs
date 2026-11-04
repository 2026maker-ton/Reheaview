// 랜딩 + 7화면 UI E2E (Mock 전용, 외부 키 없음)
// - 실제 서버를 임시 포트로 띄우고 Chromium으로 가입→대시보드→지원 정보(샘플)→근거 확인(렌치)→면접 준비→면접실(텍스트)→결과→로그아웃을 검증한다.
// - window.prompt/confirm 이 호출되면 실패한다. 1440 / 768 / 390 폭에서 가로 오버플로가 없어야 한다.
//
// 실행: node tools/e2e-ui.mjs   (playwright 미설치 시 npx 캐시에서 자동 탐색)

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

function resolvePlaywright() {
  const envPath = process.env.PLAYWRIGHT_MODULE;
  const candidates = [];
  if (envPath) candidates.push(envPath);
  candidates.push('playwright');
  const cache = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx') : null;
  if (cache && fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache)) {
      const p = path.join(cache, dir, 'node_modules', 'playwright');
      if (fs.existsSync(path.join(p, 'package.json'))) candidates.push(p);
    }
  }
  for (const c of candidates) {
    try { return require(c); } catch { /* 다음 후보 */ }
  }
  return null;
}

const pw = resolvePlaywright();
if (!pw) {
  console.error('playwright를 찾을 수 없습니다. `npx --yes playwright@1.64.1 install chromium` 후 다시 실행하세요.');
  process.exit(2);
}

const OUT = path.join(process.env.TEMP || os.tmpdir(), 'intervu-e2e');
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
function check(ok, label, detail = '') {
  if (ok) { console.log(`  ok  ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

const ADMIN_TOKEN = `e2e-admin-${Date.now()}`;
const TRENDS_FILE = path.join(OUT, `trends-${Date.now()}.json`);
const ws = fs.mkdtempSync(path.join(OUT, 'profile-'));
const schoolMemoryAnswer = "네, 제가 생명과학부에 지원하게 된 계기는 고등학교 때 '유전자 가위(CRISPR)' 기술을 주제로 발표를 준비했던 경험 덕분입니다";
const answers = [
  schoolMemoryAnswer,
  '갈등이 생겼을 때 저는 상대의 요구를 먼저 확인하고, 제가 양보할 수 있는 부분과 지킬 기준을 나눠 설명했습니다. 그 결과 역할을 다시 나눠 진행했습니다.',
  '아쉬웠던 점은 중간 점검을 미룬 것입니다. 다음에는 첫 주에 확인 기준을 정하고, 매주 금요일에 짧게 점검하는 절차를 만들었습니다.',
  '새로운 업무를 맡았을 때 먼저 선례와 데이터를 찾아보고, 이해관계자에게 확인한 뒤 실행 순서를 정했습니다. 시행 후에는 지표로 결과를 확인했습니다.',
];

// ---------- WP-D8: 페이지 내 접근성 감사 (의존성 없음, axe 대체) ----------
// 보이는 요소만 검사해 { labels, buttons, contrast, tap } 문제 목록을 돌려준다.
const A11Y_AUDIT = (opts) => {
  const vis = (el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const txt = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const desc = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''}`;
  const name = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' ').trim(); if (t) return t; }
    if (el.getAttribute('aria-label')?.trim()) return el.getAttribute('aria-label').trim();
    if (el.labels && el.labels.length) { const t = [...el.labels].map(txt).join(' ').trim(); if (t) return t; }
    if (el.getAttribute('title')?.trim()) return el.getAttribute('title').trim();
    if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') return txt(el);
    return '';
  };
  const out = { labels: [], buttons: [], contrast: [], tap: [], skipped: 0 };
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (el.type === 'hidden' || !vis(el)) continue;
    if (!name(el)) out.labels.push(desc(el));
  }
  for (const el of document.querySelectorAll('button, [role=button]')) {
    if (!vis(el)) continue;
    if (!name(el)) out.buttons.push(desc(el));
  }
  const parse = (c) => {
    let m = c.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/);
    if (m) { const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]); return [+m[1], +m[2], +m[3], a]; }
    m = c.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.%]+))?\s*\)$/);
    if (m) { const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]); return [m[1] * 255, m[2] * 255, m[3] * 255, a]; }
    return null;
  };
  const over = (top, bot) => { const a = top[3] + bot[3] * (1 - top[3]); return a === 0 ? [255, 255, 255, 1] : [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat(a); };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      // 그라데이션·이미지 위 텍스트는 자동 계산 불가. 단 body/html의 은은한 장식 배경은 배경색으로 근사한다(ponytail: 근사치).
      if (cs.backgroundImage !== 'none' && n !== document.body && n !== document.documentElement) return null;
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let acc = [255, 255, 255, 1];
    for (const l of layers.reverse()) acc = over(l, acc);
    return acc;
  };
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (el.disabled || el.closest('[disabled], [aria-disabled=true]')) continue;
    const cs = getComputedStyle(el);
    if (el.matches('.toast') && parseFloat(cs.opacity) < 1) continue; // 페이드 전환 중 토스트는 제외
    const fg = parse(cs.color); const bg = bgOf(el);
    if (!fg || !bg) { out.skipped += 1; continue; }
    const f = over([fg[0], fg[1], fg[2], fg[3] * (parseFloat(cs.opacity) || 1)], bg);
    const l1 = lum(f); const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const px = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
    const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
    if (ratio < need) { const k = `${desc(el)}|${cs.color}|${need}`; if (!seen.has(k)) { seen.add(k); out.contrast.push(`${desc(el)} ${ratio.toFixed(2)}<${need}`); } }
  }
  if (opts.tap) {
    for (const el of document.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href], summary')) {
      if (!vis(el)) continue;
      let t = el;
      if (el.matches('input[type=radio], input[type=checkbox]')) t = el.closest('label') || el; // 라벨 전체가 터치 영역
      const r = t.getBoundingClientRect();
      if (r.height + 0.5 < 44) out.tap.push(`${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  out.text = document.body.innerText;
  return out;
};

async function tabTo(page, id, max = 150) {
  const rings = [];
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const st = await page.evaluate(() => {
      const el = document.activeElement; const cs = getComputedStyle(el);
      const lab = el.closest('label');
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || cs.boxShadow !== 'none'
        || (!!lab && getComputedStyle(lab).outlineStyle !== 'none');
      return { id: el.id, tag: el.tagName, ring };
    });
    rings.push(st);
    if (st.id === id) return { found: true, steps: i + 1, rings };
  }
  return { found: false, steps: max, rings };
}

async function main() {
  const { createApp } = await import(pathToFileURL(path.resolve('src/server.js')).href);
  const app = createApp({
    env: {
      GEMINI_API_KEY: '', GROQ_WHISPER_KEY: '', GROQ_API_KEY: '', DEV_TOKEN_A: '', DEV_TOKEN_B: '',
      ADMIN_TOKEN, TRENDS_FILE, PROFILE_RATE_PER_MINUTE: '100', PROFILE_RATE_PER_DAY: '100',
      TTS_RATE_PER_MINUTE: '1000', // 가속된 Mock 면접 여러 회차; 실제 속도 제한은 API 시험에서 검증
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  console.log(`server ${base} · provider ${app.providerInfo().selected}`);

  const browser = await pw.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await context.newPage();
  await page.route('**/api/v1/sessions/*/commands', (route) => {
    const data = route.request().postDataJSON();
    if (data?.type === 'turn.text') {
      data.payload.voice_metrics = { speech_ratio: .7, longest_silence_seconds: 2, silence_count: 1, volume_cv: .2, pitch_jitter: .02, timeline: { total_seconds: 10, envelope: [0, 40, 80, 100, 30, 0], segments: [{ k: 'speech', s: 1, e: 7 }, { k: 'pause', s: 7, e: 9 }] } };
      return route.continue({ postData: JSON.stringify(data) });
    }
    return route.continue();
  });
  const consoleErrors = []; const pageErrors = []; const badResponses = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  await page.addInitScript(() => {
    window.prompt = () => { throw new Error('window.prompt must not be used'); };
    window.confirm = () => { throw new Error('window.confirm must not be used'); };
    // 헤드리스 음성 합성은 끝 이벤트가 늦거나 없다: 즉시 끝난 것으로 처리하고 말한 문장을 기록한다.
    window.__spoken = [];
    if (window.speechSynthesis) window.speechSynthesis.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => u.onend?.(), 5); };
  });
  const overflow = async (label) => {
    for (const w of [1440, 768, 390]) {
      await page.setViewportSize({ width: w, height: 900 });
      const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(o <= 1, `${label}: ${w}px 가로 오버플로 없음`, `+${o}px`);
      if (w === 390) {
        const mobile = await page.evaluate(A11Y_AUDIT, { tap: true });
        check(!mobile.contrast.length, `${label}: 모바일 대비`, mobile.contrast.slice(0, 5).join(', '));
        check(!mobile.tap.length, `${label}: 모바일 터치 영역 44px`, mobile.tap.slice(0, 5).join(', '));
      }
      // E2E_SHOTS=1이면 화면별 전체 캡처를 남긴다(레이아웃 점검용).
      if (process.env.E2E_SHOTS && w !== 768) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(150); // sticky header settles after viewport / scroll changes
        fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
        await page.screenshot({ path: path.join(OUT, 'shots', `${label}-${w}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  const audit = async (label) => {
    if (process.env.E2E_SHOTS) { fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true }); await page.screenshot({ path: path.join(OUT, 'shots', `${label}-audit.png`), fullPage: true }); }
    const r = await page.evaluate(A11Y_AUDIT, { tap: false });
    check(!r.labels.length, `${label}: 입력 이름`, r.labels.join(', '));
    check(!r.buttons.length, `${label}: 버튼 이름`, r.buttons.join(', '));
    check(!r.contrast.length, `${label}: 대비`, r.contrast.slice(0, 5).join(', '));
    const banned = /합격\s*(가능성|확률|예측)|정확(히|한)\s*(AI\s*)?(평가|채점)|순위|백분위/;
    check(!banned.test(r.text.replace(/합격 예측이 아닙니다/g, '')), `${label}: 금지 표현 없음`);
  };

  try {
    console.log('\n[1] 로그인·가입');
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForURL(/#\/landing/);
    await page.waitForSelector('#screen-landing:not([hidden])');
    check(await page.locator('#guestWarning').isHidden(), '랜딩: 게스트 개인정보 경고 숨김');
    check(await page.locator('.re-scene img').evaluate((img) => img.complete && img.naturalWidth === 1225), '랜딩: 제공 이미지 로드');
    await overflow('랜딩');
    await audit('랜딩');
    check(await page.locator('.topbar-right').isHidden(), '랜딩: 앱 헤더 버튼 숨김');
    await page.evaluate(() => document.fonts.ready);
    check(await page.evaluate(() => document.fonts.check('700 40px SUIT')), '랜딩: SUIT 글꼴 로드');
    await page.locator('.landing-header-start').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/#\/login/);
    await page.waitForSelector('#screen-login:not([hidden])');
    check(await page.locator('#loginForm').isVisible(), '랜딩: 무료로 시작하기는 로그인으로 이동');
    check(await page.locator('.landing-header-start').isHidden(), '앱 화면: 랜딩 전용 버튼 숨김');
    await page.goto(`${base}/#/landing`);
    await page.waitForSelector('#screen-landing:not([hidden])');
    await page.locator('.re-invitation [data-go="login"]').click();
    await page.waitForSelector('#screen-login:not([hidden])');
    check(true, '랜딩: 본문 시작 버튼도 로그인 진입');
    await page.goto(`${base}/#/dashboard`);
    await page.waitForURL(/#\/dashboard/);
    await page.waitForSelector('#screen-dashboard:not([hidden])');
    check(await page.locator('#journeyUniversity').isVisible(), '게스트 연습 공간 진입');
    check(await page.locator('.brand-logo').evaluate((img) => img.complete && img.naturalWidth === 250), '서비스 로고 SVG 로드');
    const iconUrl = await page.locator('link[rel=icon]').getAttribute('href');
    const icon = await page.request.get(`${base}${iconUrl}`);
    check(icon.ok() && icon.headers()['content-type'].includes('image/svg+xml'), '브라우저 아이콘 SVG 제공');
    await overflow('대시보드');
    check(await page.locator('#guestWarning').isVisible(), '첫 방문 자동 게스트: 개인정보 경고 표시');
    check(await page.locator('#myProfileBtn').isHidden() && await page.locator('#logoutBtn').isHidden(), '게스트: 내 정보·로그아웃 숨김');
    check((await page.locator('#guestWarning').innerText()).includes('유출될 수'), '개인정보·블라인드 누락 가능성 안내');
    check(await page.locator('#aiSwitch').getAttribute('aria-checked') === 'true', '첫 방문 AI 스위치 켜짐');
    await page.click('#guestAiBtn');
    await page.click('#guestAiAccept');
    check((await page.locator('#guestAiError').innerText()).includes('만 18세'), '게스트 AI 연령·동의 미확인은 거부');
    await page.click('#guestAiCancel');
    check(await page.locator('#guestAiDialog').isHidden(), '게스트 AI 동의 취소');
    await page.click('#guestAiBtn');
    await page.check('#guestAiForm [name=age_18_confirmed]');
    await page.check('#guestAiForm [name=notice_ack]');
    await page.click('#guestAiAccept');
    await page.waitForFunction(() => !document.querySelector('#guestAiDialog').open);
    check(await page.locator('#guestAiBtn').isHidden(), '게스트 AI 동의 완료');
    await page.click('#aiSwitch');
    await page.waitForFunction(() => document.querySelector('#aiSwitch').getAttribute('aria-checked') === 'false');
    check(true, 'AI 끄기 상태 반영');
    await page.click('#aiSwitch');
    await page.waitForFunction(() => document.querySelector('#aiSwitch').getAttribute('aria-checked') === 'true');
    check(true, 'AI 켜기 상태 반영');
    await page.click('#dismissGuestWarning');
    check(await page.locator('#guestWarning').isHidden(), 'X로 게스트 경고 닫기');
    await page.click('#guestLoginBtn');
    await page.waitForURL(/#\/login/);
    await page.waitForSelector('#guestBox:not([hidden])');
    check(await page.locator('#guestBtn').isVisible(), 'Mock 모드: 가입 없이 체험하기 버튼');
    check(await page.locator('#screen-login').isVisible(), '로그인 화면 보임');
    await audit('로그인');
    await overflow('로그인');
    await page.click('#tabSignup');
    await page.fill('#signupForm [name=name]', '이투이');
    await page.fill('#signupForm [name=email]', `e2e-${Date.now()}@intervu.test`);
    await page.fill('#signupForm [name=password]', 'e2e-local-only-1');
    await page.click('#signupBtn');
    check(await page.locator('#authError').innerText() !== '', '연령·고지 미확인 가입은 막힘');
    await page.check('#signupForm [name=age_18_confirmed]');
    await page.check('#signupForm [name=notice_ack]');
    await page.click('#signupBtn');
    await page.waitForURL(/#\/profile/);
    await page.click('#obNext');
    await page.fill('#obBirth', '2005');
    await page.click('#obNext');
    await page.fill('#obRecord', '수학 세특과 봉사 활동을 요약했습니다.');
    await page.click('#obFinish');
    await page.waitForURL(/#\/dashboard/);
    check(await page.locator('#userName').innerText() === '이투이님', '상단에 사용자 이름');
    check(await page.locator('#myProfileBtn').isVisible() && await page.locator('#logoutBtn').isVisible(), '회원: 내 정보·로그아웃 표시');
    await audit('로그인 후 대시보드');

    console.log('\n[2] 대시보드');
    const screens = await page.locator('[data-screen]').evaluateAll((els) => els.map((e) => e.dataset.screen));
    check([...screens].sort().join(',') === ['login', 'profile', 'landing', 'dashboard', 'application', 'evidence', 'setup', 'room', 'feedback'].sort().join(','), '랜딩 + 앱 화면 8개(부가기능 없음)', screens.join(','));
    check(await page.locator('[data-journey]').count() === 1, '대입 여정 하나');
    check(!(await page.locator('text=자료 없이').count()), '자료 없이 일반 연습 없음');
    // AI 스위치(비밀번호 없음): 누르면 바로 바뀐다
    check(await page.locator('#aiSwitch').getAttribute('aria-checked') === 'true', 'AI 스위치 기본 켜짐');
    await page.click('#aiSwitch');
    await page.waitForFunction(() => document.querySelector('#aiSwitch').getAttribute('aria-checked') === 'false');
    check(await page.locator('#confirmDialog[open]').count() === 0, '비밀번호 창 없이 AI 끔');
    await page.click('#aiSwitch');
    await page.waitForFunction(() => document.querySelector('#aiSwitch').getAttribute('aria-checked') === 'true');
    check(true, 'AI 켬');
    await page.click('#journeyUniversity');

    console.log('\n[3] 지원 정보');
    await page.waitForURL(/#\/application/);
    await page.waitForFunction(() => document.activeElement?.id === 'applicationTitle');
    await page.locator('.brand').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/#\/dashboard/);
    await page.waitForSelector('#screen-dashboard:not([hidden])');
    check(await page.locator('#screen-dashboard').isVisible(), '키보드로 로고를 눌러 대시보드 이동');
    await page.click('#journeyUniversity');
    await page.waitForURL(/#\/application/);
    await page.waitForFunction(() => document.querySelectorAll('#fixtureSelect option').length >= 11);
    check(await page.locator('#fixtureSelect option').count() === 11, '샘플 10건');
    check(await page.locator('[name=experiences]').count() === 0 && !(await page.locator('text=경험 메모').count()), '경험 메모 입력 없음');
    check(await page.locator('#screen-application .back-btn').count() === 1 && await page.locator('#applicationForm .sticky-actions .primary').count() === 1 && await page.locator('#applicationForm .sticky-actions .ghost').allInnerTexts().then((t) => t.join() === '임시저장'), '지원 정보: 위쪽 뒤로가기, 아래에는 다음(+임시저장) 버튼만');
    check(await page.locator('[data-upload]').count() === 1 && await page.locator('[data-upload=cover_letter]').count() === 0 && !(await page.locator('#applicationForm').innerText()).includes('자기소개서') && await page.locator('#postingDetails').evaluate((d) => !d.open && !!d.querySelector('[name=source_text]')), '학생부 업로드만 유지, 자소서 버튼·내용 제거, 모집요강은 선택 아코디언');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-upload=resume]')]);
    await chooser.setFiles({ name: 'cover.txt', mimeType: 'text/plain', buffer: Buffer.from('저는 로봇 동아리에서 제어 알고리즘을 직접 설계했고 오차를 줄이기 위해 세 가지 방법을 비교했습니다.') });
    await page.waitForFunction(() => document.querySelector('#uploadStatus').textContent.includes('가져왔습니다'), null, { timeout: 8000 });
    check((await page.inputValue('#applicationText')).includes('로봇 동아리'), '파일에서 뽑은 글자가 학생부·활동 경험 칸에 들어감');
    await page.click('#screen-application .info-btn');
    check(await page.locator('.info-pop').isVisible() && (await page.locator('.info-pop').innerText()).length > 10, 'i 버튼 설명 말풍선');
    await page.keyboard.press('Escape');
    check(await page.locator('.info-pop').count() === 0, 'Esc로 말풍선 닫힘');
    await page.fill('[name=school_name]', '임시대학교');
    await page.fill('[name=department]', '임시학과');
    await page.click('#draftSaveBtn');
    check(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('intervu.draft.')).length === 1), '임시저장은 하나만');
    await page.click('.brand');
    await page.waitForURL(/#\/dashboard/);
    await page.waitForSelector('#draftCard:not([hidden])');
    check((await page.locator('#draftMeta').innerText()).includes('임시대학교'), '대시보드에 임시저장 카드');
    await page.evaluate(() => document.querySelector('#applicationForm').reset());
    await page.click('#draftResumeBtn');
    await page.waitForURL(/#\/application/);
    await page.waitForFunction(() => document.querySelector('[name=school_name]').value === '임시대학교');
    check((await page.inputValue('[name=department]')) === '임시학과' && (await page.inputValue('#applicationText')).includes('로봇 동아리'), '임시저장 내용이 폼으로 복원됨');
    await page.selectOption('#fixtureSelect', 'smp-snu-bio');
    await page.click('#loadFixtureBtn');
    await page.waitForFunction(() => document.querySelector('[name=school_name]').value === '서울대학교');
    check(await page.locator('#fixtureBadge').isVisible(), '샘플 배지');
    const selected = await page.evaluate(() => { const f = document.querySelector('#applicationForm'); return { school: f.school_name.value, department: f.department.value, track: f.track.value }; });
    await page.locator('details:has(#sourceText) > summary').click();
    await page.fill('#sourceText', `${await page.inputValue('#sourceText')}\n2027학년도 ${selected.school} ${selected.department} ${selected.track}\n2단계 서류평가 70%, 면접 30%`);
    await overflow('지원 정보');
    let releaseAnalyze;
    const analyzing = new Promise((r) => { releaseAnalyze = r; });
    const holdAnalyze = async (route) => { await analyzing; await route.continue(); };
    await page.route('**/api/v1/profiles', holdAnalyze);
    await page.click('#analyzeBtn');
    check((await page.locator('#analyzeBtn').innerText()).includes('자료 분석 중') && await page.locator('#analyzeBtn').isDisabled(), '분석 버튼: 작업 문구·중복 클릭 방지');
    releaseAnalyze();

    console.log('\n[4] 근거 확인');
    await page.waitForURL(/#\/evidence/);
    await page.unroute('**/api/v1/profiles', holdAnalyze);
    await page.waitForFunction(() => !document.querySelector('#approveBtn').disabled, null, { timeout: 15000 });
    check(await page.locator('details.ev-sec > summary', { hasText: '입력한 모집요강의 평가 비율' }).count() === 1, '평가 비율은 입력 자료 별도 구역');
    check(await page.locator('#evDetail, #detailToggle').count() === 0, '근거 확인에는 세부 조정(지원서 근거·질문 목록)이 없다(결과 뒤로 이동)');
    check(await page.locator('#screen-evidence .back-btn').count() === 1 && await page.locator('#evidenceCard > .actions #approveBtn').count() === 1 && await page.locator('#evidenceCard > .actions #evidenceDraftBtn').count() === 1, '근거 확인: 위쪽 뒤로가기, 아래 승인·임시저장');
    check((await page.locator('#ev-search').innerText()).includes('서울대학교'), '학교·전형 정보 표시');
    check(await page.locator('#editCompBtn[aria-label="직접 수정"]').count() === 1 && await page.locator('#editFormatBtn').count() === 1, '렌치 버튼 2개');
    await page.waitForFunction(() => document.querySelector('#ev-persona')?.innerText.includes('서류 검증'), null, { timeout: 8000 });
    check((await page.locator('#ev-persona').innerText()).includes('전공 탐구') && (await page.locator('#ev-persona').innerText()).includes('교수 연구분야 특화형'), '면접관 관점: 기본 조합과 사용 불가 이유(교수 특화형)');
    check((await page.locator('#ev-privacy').innerText()).length > 10, '개인정보·블라인드 검사 결과 표시');
    await page.click('#editPersonaBtn');
    check(await page.locator('#confirmChoice option[disabled]').count() === 1, '교수 연구분야 특화 조합은 선택 불가');
    await page.click('#confirmCancel');
    // 뒤로 갔다가 수정 없이 다시 다음: 이미 분석한 결과를 그대로 쓴다(새 프로필·분석 요청 없음)
    let created = 0;
    const onReq = (r) => { if (r.method() === 'POST' && new RegExp('/api/v1/profiles(/[^/]+/school-analysis)?$').test(r.url())) created++; };
    page.on('request', onReq);
    await page.click('#screen-evidence .back-btn');
    await page.waitForURL(/#\/application/);
    await page.click('#analyzeBtn');
    await page.waitForURL(/#\/evidence/);
    page.off('request', onReq);
    check(created === 0, '수정 없이 뒤로 갔다 오면 다시 분석하지 않음', String(created));
    await page.click('#editCompBtn');
    await page.fill('#confirmText', '과학적 추론\n탐구 논리성');
    await page.click('#confirmOk');
    await page.waitForFunction(() => document.querySelector('#ev-comp').innerText.includes('과학적 추론'));
    await page.click('#editFormatBtn');
    const disabled = await page.locator('#confirmChoice option[disabled]').count();
    check(disabled === 5, '특수 면접 5종 선택 불가', String(disabled));
    await page.click('#confirmCancel');
    // 지원서 분석 직후 검색이 자동으로 한 번 실행된다(서버가 꺼 두면 사유 표시). 버튼은 다시 검색.
    await page.waitForFunction(() => document.querySelector('#searchNote')?.textContent.includes('꺼져'));
    
    check((await page.locator('#searchNote').innerText()).includes('검색 기능이 꺼져'), '검색 꺼짐 사유 표시');
    await audit('근거 확인');
    await overflow('근거 확인');
    let releaseApprove;
    const approving = new Promise((r) => { releaseApprove = r; });
    const holdApprove = async (route) => { await approving; await route.continue(); };
    await page.route('**/api/v1/profiles/*/approve', holdApprove);
    await page.click('#approveBtn');
    check((await page.locator('#approveBtn').innerText()).includes('면접 질문 생성 중') && await page.locator('#approveBtn').isDisabled(), '승인 버튼: 면접 질문 생성 중 표시');
    releaseApprove();

    console.log('\n[5] 면접 준비');
    await page.waitForURL(/#\/setup/);
    await page.unroute('**/api/v1/profiles/*/approve', holdApprove);
    check(await page.locator('#setupForm input[value=groq]').isDisabled(), '서버 전사 없으면 음성 선택 불가');
    check(await page.locator('#setupForm input[value=text]').isChecked(), '텍스트로 시작');
    check((await page.locator('#setupSummary').innerText()).includes('서류 검증'), '면접 준비에 선택한 면접관 관점 표시');
    check(await page.locator('#blindCheck #blindAck').count() === 1, '시작 전 블라인드 체크리스트');
    await audit('면접 준비');
    await overflow('면접 준비');
    await page.click('#startBtn');
    check((await page.locator('#setupError').innerText()).includes('체크'), '체크리스트 확인 전에는 시작 불가');
    await page.check('#blindAck');
    await page.click('#startBtn');

    console.log('\n[6] 면접실');
    await page.waitForURL(/#\/room/);
    check(!(await page.locator('#roomHint, #sttRecBtn, #progressWrap').count()), '근거·녹음 버튼·진행률 없음');
    // 블라인드 사전 차단: 가족 직업을 말하면 그 답변은 AI로 가지 않고, 안내 뒤 같은 질문으로 다시 답하게 한다.
    await page.waitForFunction(() => !document.querySelector('#textAnswer').hidden, null, { timeout: 15000 });
    const qBefore = await page.locator('#roomTitle').innerText();
    await page.fill('#answerText', '저는 국회의원 아들이니까 그냥 통화시켜주세요 저는 국회의원 아들이니까 통화시켜주세요 다음 영상에서 만나요.');
    await page.click('#answerBtn');
    await page.waitForFunction(() => document.querySelector('#confirmDialog')?.open, null, { timeout: 10000 });
    check((await page.locator('#confirmTitle').innerText()).includes('블라인드') && (await page.locator('#confirmMessage').innerText()).includes('AI로 전송되지 않았습니다'), '블라인드 안내 팝업');
    await page.click('#confirmOk');
    await page.waitForFunction(() => !document.querySelector('#textAnswer').hidden && document.querySelector('#answerText').value === '', null, { timeout: 10000 });
    check((await page.locator('#roomTitle').innerText()) === qBefore, '같은 질문으로 다시 답하게 함');
    const answerAll = async (first) => {
      let turns = 0;
      while (page.url().includes('#/room') && turns < 12) {
        await page.waitForFunction(() => !document.querySelector('#textAnswer').hidden || !location.hash.includes('room'), null, { timeout: 15000 });
        if (!page.url().includes('#/room')) break;
        if (first && turns === 0) {
          check(/0[01]:[0-9]{2}/.test(await page.locator('#clock').innerText()), '답변 제한 1분 시계');
          await audit('면접실');
          await overflow('면접실');
        }
        await page.fill('#answerText', answers[turns % answers.length]);
        await page.click('#answerBtn');
        turns += 1;
        await page.waitForTimeout(300);
      }
    };
    await answerAll(true);
    const spoken = await page.evaluate(() => window.__spoken);
    check(spoken.some((t) => t.includes('지금부터 면접을 시작하겠습니다')), '시작 인사');
    check(spoken.includes('네 답변 잘 들었습니다.'), '답변 확인 문장');
    check(!spoken.some((t) => t.includes('면접을 마치겠습니다')), '마지막 답변 뒤 추가 낭독 대기 없이 분석으로 전환');

    console.log('\n[7] 결과');
    await page.waitForURL(/#\/feedback/, { timeout: 20000 });
    await page.waitForSelector('.qa');
    check(await page.locator('.report-charts svg').count() >= 2, '차트 SVG(점수·차원)');
    check(await page.locator('.report-charts .hbar').count() >= 1, '역량 적합성 막대');
    check(await page.locator('figure.chart.wide svg .dot').count() === 6 && await page.locator('figure.chart.wide svg .dot.hold').count() >= 1, '6축 레이더: 미관찰 영역은 최저 수준 1의 빈 점(0점·판단 보류 아님)');
    const axisHint = page.locator('.chart.wide [data-tooltip][tabindex]').first();
    await axisHint.hover();
    check((await page.locator('.info-pop').innerText()).includes('성찰') && (await page.locator('.info-pop').innerText()).includes('개선 방향'), '레이더 역량 호버 설명');
    await page.keyboard.press('Escape'); await axisHint.focus();
    check(await page.locator('.info-pop').isVisible(), '레이더 설명 키보드 포커스 지원');
    await page.keyboard.press('Escape');
    check(await page.locator('.chart.wide .ai-acc .axis-card tbody tr').count() === 6, '영역별 근거는 레이더 아코디언 내부');
    check(await page.locator('.axis-card').isHidden(), '레이더 근거는 기본 접힘');
    const voiceBox = await page.locator('.voice-chart').boundingBox();
    const chartsBox = await page.locator('.report-charts').boundingBox();
    check(Math.abs(voiceBox.width - chartsBox.width) < 2, '음성 구역 가로 전체 폭');
    const probe = page.locator('.voice-chart .timeline-probe').first();
    const box = await probe.boundingBox();
    await probe.hover({ position: { x: box.width / 2, y: box.height / 2 } });
    check(await probe.locator('.timeline-cursor').isVisible() && (await probe.locator('.timeline-cursor span').innerText()) === '5.0초', '음성 호버: 세로선과 경과 초');
    await probe.focus(); await probe.press('End');
    check(await probe.getAttribute('aria-valuenow') === '10', '음성 타임라인 키보드 탐색');
    check(await page.locator('.report-overview .overview-metric').count() === 4, '오버뷰: 큰 수치 네 개');
    check(!(await page.locator('#feedbackBody').innerText()).match(/이번 면접 요약|답변 차원별 관찰|서류와 답변 나란히 보기|분석의 한계/), '요청한 네 구역 제거');
    check((await page.locator('#privacyResults').innerText()).includes('블라인드·개인정보 검사 결과') && (await page.locator('#privacyResults').innerText()).includes('1회'), '블라인드·개인정보 검사 결과(차단 1회)');
    check(await page.evaluate(() => !!(document.querySelector('#privacyResults').compareDocumentPosition(document.querySelector('.report-main')) & Node.DOCUMENT_POSITION_FOLLOWING)), '개인정보 검사가 질문·답변 위에 표시');
    check(await page.locator('details.qa').count() >= 5 && await page.locator('details.qa[open]').count() === 0, '질문 아코디언은 모두 접힌 상태로 시작');
    await page.locator('details.qa > summary').first().click();
    check(await page.locator('.qa-a').first().isVisible(), '질문 펼치면 답변 표시');
    const answerProbe = page.locator('.qa .timeline-probe').first();
    const answerBox = await answerProbe.boundingBox();
    await answerProbe.hover({ position: { x: answerBox.width / 2, y: answerBox.height / 2 } });
    check((await answerProbe.locator('.timeline-cursor span').innerText()) === '5.0초', '펼친 답변의 음성 차트도 호버 시간 표시');
    check((await page.locator('.qa-a').first().innerText()).includes(schoolMemoryAnswer), 'CRISPR 답변 원문 보존');
    check(!(await page.locator('#feedbackBody').innerText()).match(/국회의원|아버지/), '결과 어디에도 감지된 가족 배경 원문이 없다');
    check(await page.locator('.persona-line .tag').count() === 2 && await page.locator('#issueBtn').count() === 1, '면접관 관점 표시, 오류 신고 버튼');
    check((await page.locator('#feedbackBody').innerText()).includes('면접 태도·전달력 코칭'), '태도·전달력 코칭 오버뷰');
    await page.waitForFunction(() => !document.querySelector('#reportDetail')?.hidden, null, { timeout: 8000 });
    check(await page.locator('#reportDetail .claims li').count() >= 1 && await page.locator('#reportDetail .plan-list li').count() === 5, '세부 정보(지원서 근거·질문 5개)는 결과 맨 뒤');
    check(await page.evaluate(() => { const d = document.querySelector('#reportDetail'); const last = document.querySelector('#feedbackBody').lastElementChild; return last.contains(document.querySelector('#retryBtn')) && d.nextElementSibling === last; }), '다시 면접 보기 버튼은 세부 정보 아래 마지막 구역');
    check(await page.locator('.qa:not(.followup)').count() === 5, '본질문 5개');
    const info = page.locator('.qa .icon-btn.info').first();
    await info.click();
    check(await info.getAttribute('aria-expanded') === 'true' && await page.locator('.qa-evidence:not([hidden])').count() === 1, 'i 버튼으로 근거 열림');
    check(!(await page.locator('text=재연습').count()), '재연습 없음');
    check(await page.locator('.qa-comment').count() >= 5, '답변마다 코멘트');
    check(await page.locator('#feedbackBody .info-btn.basis').count() >= 5 && await page.locator('#feedbackBody .info-btn:not(.basis)').count() >= 6, '박스마다 i(의미)·?(근거) 버튼');
    check(await page.locator('.report-charts > .chart > .info-btn.basis').count() === 0, '차트 박스에는 ? 버튼 없음(하단 아코디언으로 이동)');
    check(await page.locator('.report-charts details.ai-acc > summary', { hasText: 'AI의 생각이 궁금해요!' }).count() >= 2, '박스 하단 "AI의 생각이 궁금해요!" 아코디언');
    const acc = page.locator('.report-charts details.ai-acc').first();
    await acc.locator('summary').click();
    const accText = await acc.innerText();
    check(await acc.evaluate((e) => e.open) && accText.includes('규칙 기반 문구') && accText.includes('판단 근거'), '아코디언 펼침: 한줄평(Mock은 규칙 문구 표기)과 판단 근거');
    const fitAcc = page.locator('.report-charts figure.chart:has(.hbar) details.ai-acc');
    await fitAcc.locator('summary').click();
    check((await fitAcc.innerText()).includes('해당 역량을 묻는 질문'), '역량 차트 근거는 질문 역량 연결과 단어 일치를 함께 설명');
    await fitAcc.locator('summary').click();
    const jump = page.locator('.report-charts .ai-jump');
    check(await jump.count() === 1 && await page.locator('.report-charts .ai-jump').evaluate((e) => e.tagName === 'BUTTON'), '답변별 참고 점수: 열리지 않는 점프 버튼');
    await jump.click();
    await page.waitForTimeout(600);
    check(await page.evaluate(() => document.activeElement?.id === 'qaTitle'), '점프 버튼: 질문과 답변으로 이동');
    check(await page.locator('.report-charts figure.chart:has(.vol-list) .info-btn.basis').count() === 0, '음성 박스에 ? 버튼 없음');
    check(await page.locator('.attempt-tabs').count() === 0, '1회만 봤으면 회차 탭 없음');
    check(await page.locator('#retryBtn').count() === 1, '다시 면접 보기 버튼');
    await page.click('#retryBtn');
    await page.waitForURL(/#\/room/);
    check(true, '다시 면접 보기: 근거 확인 없이 바로 면접실');
    await answerAll(false);
    await page.waitForURL(/#\/feedback/, { timeout: 20000 });
    await page.waitForSelector('.attempt-tabs');
    check(await page.locator('.attempt-tab').count() === 2 && (await page.locator('.attempt-tab[aria-selected=true]').innerText()).startsWith('2'), '2회차 탭 두 개, 지금 2회차');
    const q2 = await page.locator('.qa-q').allInnerTexts();
    await page.click('.attempt-tab:not([aria-selected=true])');
    await page.waitForFunction(() => document.querySelector('.attempt-tab[aria-selected=true]').innerText.startsWith('1'));
    const q1 = await page.locator('.qa-q').allInnerTexts();
    check(q1[0] === q2[0] && q1.length >= 5, '회차가 달라도 본질문은 같은 승인 계획');
    await page.locator('.chart.wide .ai-acc > summary').click();
    await audit('결과');
    await overflow('결과');
    await page.setViewportSize({ width: 390, height: 900 });
    check(await page.locator('.axis-card td:nth-child(4)').first().evaluate((e) => e.getBoundingClientRect().width > 240), '모바일 영역별 근거는 넓은 행으로 표시');
    await page.setViewportSize({ width: 1440, height: 900 });
    // 실패 응답을 한 번만 주입한다. 실제 서버의 ready 보고서는 재시도에도 보존한다.
    await page.route('**/api/v1/sessions/*/report', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ status: 'failed', detail: '분석 실패 재시도 시험', retryable: true }) }), { times: 1 });
    await page.evaluate(async () => (await import('/screens/feedback.js')).loadReport());
    await page.waitForSelector('#analysisRetryBtn');
    check((await page.locator('#analysisRetryBtn').innerText()) === '다시 시도', '실패 보고서에 재분석 버튼 표시');
    const retryRequest = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes('/commands') && r.postDataJSON()?.payload?.retry_report === true);
    await page.click('#analysisRetryBtn');
    await retryRequest;
    await page.waitForSelector('#qaTitle');
    check(true, '재분석 버튼은 종료 명령 POST 후 보고서로 복구');
    const policy = await context.newPage();
    await policy.goto(`${base}/privacy.html`);
    check(await policy.locator('.brand-logo').evaluate((img) => img.complete && img.naturalWidth === 250), '개인정보 페이지에도 동일 로고 로드');
    check((await policy.title()).includes('Reheaview') && (await policy.locator('main').innerText()).includes('Groq') && (await policy.locator('main').innerText()).includes('30일'), '개인정보 보호 정책 별도 페이지·공급자·보관 안내');
    await policy.setViewportSize({ width: 390, height: 900 });
    check(await policy.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '개인정보 정책 모바일 가로 넘침 없음');
    check(await policy.locator('#ai table').evaluate((e) => e.getBoundingClientRect().height < 1800 && getComputedStyle(e.querySelector('td')).whiteSpace === 'normal' && e.querySelector('td').getBoundingClientRect().width >= e.getBoundingClientRect().width - 2), '개인정보 공급자 안내는 모바일에서 전체 폭 카드로 표시');
    if (process.env.E2E_SHOTS) await policy.screenshot({ path: path.join(OUT, 'privacy-390.png'), fullPage: true });
    await policy.close();

    console.log('\n[8] 로그아웃');
    await page.click('#logoutBtn');
    await page.waitForURL(/#\/login/);
    check(await page.locator('#screen-login').isVisible(), '로그아웃 후 로그인 화면');
    check(await page.evaluate(() => !localStorage.getItem('intervu.token')), '토큰 삭제');
    await (await import('./e2e-room-cases.mjs')).verifyRoomCompletion(page, check);
  } catch (e) {
    failures.push(`예외: ${e.message}`);
    console.error(`E2E 예외: ${e.message}`);
    await page.screenshot({ path: path.join(OUT, 'failure.png'), fullPage: true }).catch(() => {});
  } finally {
    check(!pageErrors.length, '페이지 오류 없음', pageErrors.join(' | '));
    check(!consoleErrors.filter((m) => !/Failed to load resource/.test(m)).length, '콘솔 오류 없음', consoleErrors.join(' | '));
    const unexpected = badResponses.filter((r) => !/\/auth\/signup|^401 POST .*\/ai-switch|^503 POST .*\/sessions\/text-final-check\/commands$/.test(r)); // 가입·스위치 거절 및 합성 최종 답변의 의도된 503
    check(!unexpected.length, '예상하지 않은 4xx/5xx 없음', unexpected.join(' | '));
    await browser.close();
    app.server.close();
  }
  console.log(failures.length ? `\nE2E FAIL ${failures.length}건` : '\nE2E OK');
  process.exitCode = failures.length ? 1 : 0;
}

main();
