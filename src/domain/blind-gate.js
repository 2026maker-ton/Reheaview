// 블라인드·개인정보 사전 차단(설계서 §3.5·§4.3): 답변이 AI로 가기 전에 프로그램이 먼저 검사한다.
// 규칙은 결정적이며 AI 호출이 없다. 필터가 예외로 실패하면 "탐지되지 않았다"로 보지 않고 전송을 막는다(fail-closed).
// 이벤트에는 원문을 담지 않는다: 분류 코드·수준·조치·시각만 남긴다(§4.6).
import { detectPii } from './pii.js';
import { detectBlindRisk, maskRisk } from './answer-review.js';
import { randomUUID } from '../app/crypto.js';

export const FILTER_VERSION = 'blind-filter-2026-11-01.2';

// 직접 식별 정보로 보는 개인정보 종류. 학교(대학교) 이름은 지원 대학을 말하는 것이라 막지 않는다(출신 고교는 blind-risk의 school_name이 본다).
const PII_LABEL = { name: '본인 이름', phone: '전화번호', email: '이메일', rrn: '주민등록번호', address: '주소', id_number: '수험·식별번호' };

// text → { blocked, level: 'none'|'medium'|'high'|'error', categories:[{id,label,level}] }
export function blindGate(text) {
  try {
    const r = detectBlindRisk(text, { loose: true });
    const categories = r.categories.map(({ id, label, level }) => ({ id, label, level }));
    for (const h of detectPii(String(text || ''))) {
      const label = PII_LABEL[h.type];
      if (label && !categories.some((c) => c.id === `pii_${h.type}`)) categories.push({ id: `pii_${h.type}`, label, level: 'high' });
    }
    const level = categories.some((c) => c.level === 'high') ? 'high' : categories.length ? 'medium' : 'none';
    return { blocked: level !== 'none', level, categories, filter_version: FILTER_VERSION };
  } catch {
    return { blocked: true, level: 'error', categories: [], filter_version: FILTER_VERSION };
  }
}

// 지원서·자료처럼 길고 AI로 보내야 하는 글: 위험 표현을 가려서 보낸다. 가릴 수 없는(위치를 모르는) 위험이 남으면 unmasked를 true로 돌려 호출자가 전송을 멈추게 한다.
export function sanitizeForAi(text) {
  try {
    const t = String(text || '');
    const r = detectBlindRisk(t);
    const masked = r.level === 'none' ? t : maskRisk(t, r.spans);
    const after = detectBlindRisk(masked, { loose: true });
    return { text: masked, masked_categories: r.categories.map(({ id, label }) => ({ id, label })), unmasked: after.level !== 'none' && after.categories.some((c) => c.loose), filter_version: FILTER_VERSION };
  } catch {
    return { text: '', masked_categories: [], unmasked: true, error: true, filter_version: FILTER_VERSION };
  }
}

// 감지 이벤트(원문 없음). 세션에 쌓아 보고서의 "블라인드 안전 결과"와 반복 횟수 판단에 쓴다.
export function blindEvent({ gate, question_id, action }) {
  return { event_id: randomUUID(), level: gate.level, codes: gate.categories.map((c) => c.id), labels: gate.categories.map((c) => c.label), question_id: question_id || null, action, filter_version: gate.filter_version, at: new Date().toISOString() };
}

// 사용자에게 보이는 안내문(학생을 비난하지 않는 문구, 설계서 §4.6). 보수적 기본 정책임을 밝힌다.
export function blindMessage(gate) {
  if (gate.level === 'error') return '블라인드·개인정보 검사를 완료하지 못해 이 답변을 AI로 보내지 않았습니다. 잠시 후 다시 답해 주세요.';
  const kinds = gate.categories.map((c) => c.label).join('·');
  return `답변에서 블라인드 면접 기준에 포함될 수 있는 표현(${kinds})이 감지되었습니다. 해당 답변은 아직 AI로 전송되지 않았습니다. 본인 개인정보나 출신 고교, 부모·친인척의 직업 등 사회적 지위를 드러내는 내용을 빼고 다시 답해 주세요. (대학별 공식 규정이 확인되지 않아 Reheaview의 보수적 기본 정책을 적용했습니다.)`;
}
