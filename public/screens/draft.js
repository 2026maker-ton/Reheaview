// 임시저장: 사용자(계정)마다 작성 중인 지원 정보 하나만 이 브라우저에 보관한다. 저장하면 이전 임시저장은 덮어쓴다.
// 나가기·새로고침 때 자동으로 저장하고, 대시보드에서 이어 쓰거나 삭제할 수 있다. 로그아웃·"내 데이터" 삭제 때 지운다.
import { $, esc, fmtDate } from '../core/format.js';
import { state } from '../core/state.js';
import { go } from '../core/router.js';
import { toast } from '../core/toast.js';

export const DRAFT_FIELDS = ['school_name', 'department', 'track', 'source_text', 'application_text'];
const key = () => `intervu.draft.${state.user?.id || 'anon'}`;

export function readDraft() {
  try { const d = JSON.parse(localStorage.getItem(key()) || 'null'); return d && d.v === 1 && d.values ? d : null; } catch { return null; }
}
// values: 폼 값. 전부 비어 있으면 저장하지 않는다. 반환: 저장했는지
export function saveDraft(values, extra = {}) {
  if (!DRAFT_FIELDS.some((k) => String(values?.[k] || '').trim())) return false;
  const clean = Object.fromEntries(DRAFT_FIELDS.map((k) => [k, String(values[k] || '').slice(0, 20000)]));
  try { localStorage.setItem(key(), JSON.stringify({ v: 1, saved_at: new Date().toISOString(), values: clean, ...extra })); return true; } catch { return false; }
}
export function clearDraft(uid = state.user?.id) {
  try { localStorage.removeItem(`intervu.draft.${uid || 'anon'}`); } catch { /* noop */ }
}

// 대시보드 카드: 임시저장이 있을 때만 보인다.
export function renderDraftCard() {
  const card = $('#draftCard');
  if (!card) return;
  const d = state.user ? readDraft() : null;
  card.hidden = !d;
  if (!d) return;
  const title = [d.values.school_name, d.values.department].filter((x) => x.trim()).join(' · ') || '지원 정보';
  $('#draftMeta').textContent = `${title} · ${fmtDate(d.saved_at)} 저장`;
}
$('#draftResumeBtn')?.addEventListener('click', () => { go('application'); });
$('#draftDeleteBtn')?.addEventListener('click', () => { clearDraft(); renderDraftCard(); toast('임시저장을 삭제했습니다.'); });
void esc;
