// i(의미 설명)·?(판단 근거) 버튼과 말풍선. 버튼 글은 data-info 속성에 두고, 말풍선은 textContent로만 채운다(HTML 주입 없음).
import { esc } from '../core/format.js';
import { INFO } from '../core/info-text.js';
export const PrivacyLink = (anchor = '') => `<a class="privacy-link" href="/privacy.html${anchor ? `#${esc(anchor)}` : ''}" target="_blank" rel="noopener">개인정보 보호 정책</a>`;

// key가 INFO에 있으면 그 문구, 아니면 key 자체를 설명문으로 쓴다(근거 문구는 화면에서 만든 글).
export function InfoBtn(keyOrText, { kind = 'info', label } = {}) {
  const text = INFO[keyOrText] || keyOrText;
  const name = label || (kind === 'basis' ? '판단 근거 보기' : '설명 보기');
  return `<button class="info-btn ${kind === 'basis' ? 'basis' : ''}" type="button" aria-expanded="false" aria-label="${esc(name)}" data-info="${esc(text)}">${kind === 'basis' ? '?' : 'i'}</button>`;
}

let pop = null; let owner = null;
function close() { if (pop) { pop.remove(); pop = null; } if (owner) { owner.setAttribute('aria-expanded', 'false'); owner.removeAttribute('aria-describedby'); owner = null; } }
function open(btn) {
  close();
  pop = document.createElement('div');
  pop.className = 'info-pop';
  pop.id = 'activeInfoTooltip';
  pop.setAttribute('role', 'tooltip');
  pop.textContent = INFO[btn.dataset.infoKey] || btn.dataset.tooltip || btn.dataset.info || '';
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect(); const w = Math.min(340, window.innerWidth - 24);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, r.left + window.scrollX - w / 2 + r.width / 2))}px`;
  pop.style.top = `${r.bottom + window.scrollY + 8}px`;
  btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-describedby', pop.id); owner = btn;
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.info-btn, [data-tooltip]');
  if (btn) { e.preventDefault(); e.stopPropagation(); if (owner === btn) close(); else open(btn); return; }
  if (pop && !e.target.closest('.info-pop')) close();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') close();
  const btn = e.target.closest?.('[data-tooltip]');
  if (btn && ['Enter', ' '].includes(e.key)) { e.preventDefault(); if (owner === btn) close(); else open(btn); }
});
document.addEventListener('pointerover', (e) => { const btn = e.target.closest?.('[data-tooltip]'); if (btn && owner !== btn) open(btn); });
document.addEventListener('pointerout', (e) => { if (owner?.matches('[data-tooltip]') && !owner.contains(e.relatedTarget) && document.activeElement !== owner) close(); });
document.addEventListener('focusin', (e) => { const btn = e.target.closest?.('[data-tooltip]'); if (btn) open(btn); });
document.addEventListener('focusout', (e) => { if (e.target === owner && owner?.matches('[data-tooltip]')) close(); });
window.addEventListener('hashchange', close);
