// 말버릇 표시(결과 화면): 사전에 있는 군말을 찾아 <mark>로 감싼다. 순수 함수(브라우저·테스트 공용).
// '그'는 지시 관형사·대명사와 군말을 텍스트만으로 구별하기 어려워 집계하지 않는다.
const FILLERS = ['뭐랄까', '있잖아요', '그러니까', '아무튼', '으음', '저기', '약간', '그냥', '이제', '진짜', '되게', '사실', '일단', '음', '어', '뭐', '막', '좀', '아'];
const BOUNDARY = String.raw`[\s,.!?…~]`;
const WORDS = new RegExp(`(^|${BOUNDARY})(${FILLERS.join('|')})(?=$|${BOUNDARY})`, 'g');
const HEDGE = /같(?:아요|습니다|은데요?|아서)/g;
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// text → { html, counts: { 말: 횟수 }, total }. 같음 계열("~것 같아요")은 3번 이상 나올 때만 말버릇으로 본다.
export function highlightFillers(text) {
  const t = String(text || '');
  const spans = []; const counts = {};
  const add = (a, b, w) => { spans.push([a, b]); counts[w] = (counts[w] || 0) + 1; };
  let m;
  WORDS.lastIndex = 0;
  while ((m = WORDS.exec(t))) { const a = m.index + m[1].length; add(a, a + m[2].length, m[2]); }
  const hedges = [...t.matchAll(HEDGE)];
  if (hedges.length >= 3) for (const h of hedges) add(h.index, h.index + h[0].length, '~같아요');
  spans.sort((x, y) => x[0] - y[0]);
  let html = ''; let i = 0;
  for (const [a, b] of spans) { if (a < i) continue; html += escHtml(t.slice(i, a)) + `<mark class="filler">${escHtml(t.slice(a, b))}</mark>`; i = b; }
  html += escHtml(t.slice(i));
  return { html, counts, total: Object.values(counts).reduce((s, n) => s + n, 0) };
}
export const fillerSummary = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(' · ');
