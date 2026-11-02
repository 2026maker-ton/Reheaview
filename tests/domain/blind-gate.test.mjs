// 블라인드 사전 차단 규칙(결정적): 직접 식별 정보·학교/가족 배경 표현은 막고, 일상 표현은 통과시키며, 필터가 고장 나면 통과가 아니라 차단(fail-closed)이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blindGate, sanitizeForAi, blindMessage, blindEvent } from '../../src/domain/blind-gate.js';
import { detectBlindRisk } from '../../src/domain/answer-review.js';

const CRISPR_ANSWER = "네, 제가 생명과학부에 지원하게 된 계기는 고등학교 때 '유전자 가위(CRISPR)' 기술을 주제로 발표를 준비했던 경험 덕분입니다";
const FAMILY_TRANSCRIPT = '저는 국회의원 아들이니까 그냥 통화시켜주세요 저는 국회의원 아들이니까 통화시켜주세요';

test('family background: political jobs and child relations block in both directions, including spaced spelling', () => {
  for (const text of [FAMILY_TRANSCRIPT, '저는 국회의원의 딸입니다.', '나는 국회의원 아들이다.', '국회의원 자녀라서 부탁드립니다.', '장관의 자제입니다.', '의사 아들이라 관심을 가졌습니다.', '장관의 자녀예요.', '아버지가 국회의원이십니다.', '어머니는 정치인입니다.', '저는 국 회 의 원 의 아 들 이니까 통화시켜 주세요.', '부 모 님 은 국 회 의 원 이십니다.']) {
    const gate = blindGate(text);
    assert.equal(gate.blocked, true, text);
    assert.equal(gate.level, 'high', text);
    assert.ok(gate.categories.some((c) => c.id === 'family_job'), text);
    const sanitized = sanitizeForAi(text);
    assert.ok(sanitized.text.includes('[가림]') || sanitized.unmasked, text);
    assert.ok(!JSON.stringify(blindEvent({ gate })).includes(text), 'audit events cannot include the raw transcript');
  }
  const masked = sanitizeForAi(FAMILY_TRANSCRIPT);
  assert.ok(!masked.text.includes('국회의원') && !masked.text.includes('아들'));
  assert.equal(masked.unmasked, false);
});

test('family background: political research topics and ordinary family memories still pass', () => {
  for (const text of ['국회의원 자녀 특혜 관련 기사를 분석했습니다.', '국회의원 아들에 대한 기사를 읽고 공정성 문제를 토론했습니다.', '저는 국회의원 선거 제도를 주제로 발표했습니다.', '정치인들의 자녀 교육 정책을 비교했습니다.', '장관의 역할을 공부했습니다.', '아들이 과학에 관심이 있어 함께 실험했습니다.', '의사소통 과정에서 서로의 의견을 모았습니다.']) {
    assert.equal(blindGate(text).blocked, false, text);
    assert.equal(sanitizeForAi(text).text, text);
  }
});

test('school context: generic school memories and academic vocabulary preserve the exact answer', () => {
  for (const text of [CRISPR_ANSWER, '처음 고등학교에서 발표했습니다.', '특히 고등학교 때 실험했습니다.', '먼저 고등학교 때의 경험을 말씀드리겠습니다.', '과학 고전을 읽고 외국어 공부와 비교했습니다.']) {
    assert.equal(blindGate(text).blocked, false, text);
    assert.equal(detectBlindRisk(text).level, 'none', text);
    assert.equal(detectBlindRisk(text, { loose: true }).level, 'none', text);
    const safe = sanitizeForAi(text);
    assert.equal(safe.text, text);
    assert.equal(safe.unmasked, false);
    assert.deepEqual(safe.masked_categories, []);
  }
});

test('school identifiers: name endings are not grammatical exceptions; spacing bypasses still block', () => {
  for (const text of ['대전고등학교에서 발표했습니다.', '송도 고등학교에서 발표했습니다.', '용인고등학교 출신입니다.', '한빛 고등학교에서 실험했습니다.', '한 빛 고 등 학 교에서 실험했습니다.', '과 학 고 에서 배웠습니다.', '서울과학고에서는 실험했습니다.', '과학고에서의 경험입니다.', '자사고였고 발표를 했습니다.']) {
    const gate = blindGate(text);
    assert.equal(gate.blocked, true, text);
    assert.ok(gate.categories.some((c) => ['school_name', 'school_type'].includes(c.id)), text);
    const safe = sanitizeForAi(text);
    assert.ok(safe.unmasked || safe.text.includes('[가림]'), text);
  }
  assert.equal(blindGate(`${CRISPR_ANSWER}. 송도고등학교에서 발표했습니다.`).blocked, true, 'a safe clause never exempts a later identifier');
  for (const name of ['한빛고등학교', '과학고', '자사고']) {
    assert.equal(blindGate([...name].join('     ') + ' 출신입니다.').blocked, true, 'long gaps cannot bypass detection');
  }
});

test('gate blocks direct identifiers and school/family background; allows target university names and everyday words', () => {
  const blocked = {
    '제 이름은 박서준입니다': 'pii_name', '한빛고등학교 출신입니다': 'school_name', '아버지가 의사입니다': 'family_job',
    '저희 외고에서는 토론이 많았습니다': 'school_type', '수험번호는 20261234입니다': 'exam_number', '연락은 010-1234-5678로 주세요': 'pii_phone',
  };
  for (const [t, code] of Object.entries(blocked)) {
    const g = blindGate(t);
    assert.equal(g.blocked, true, t);
    assert.ok(g.categories.some((c) => c.id === code || c.id.startsWith(code.split('_')[0])), `${t} -> ${JSON.stringify(g.categories)}`);
  }
  for (const t of ['서울대학교 생명과학부에 지원했고 그 이유는 효소 연구 때문입니다.', '모형 실험의 유형별 오차를 비교했습니다.', '대표적인 사례로 사업 계획서를 분석했습니다.', '형태를 바꿔 다시 실험했습니다.']) {
    assert.equal(blindGate(t).blocked, false, t);
  }
});

test('gate: spaced-out school names are caught in loose mode but family-job rules do not match across sentences', () => {
  assert.equal(blindGate('저는 자 사 고 학생이었습니다').blocked, true);
  assert.equal(blindGate('저는 과.학.고 에서 배웠습니다').blocked, true);
  assert.equal(blindGate('어머니는 건강하세요. 연구원을 목표로 합니다.').blocked, false, 'sentence boundary keeps the distance rule honest');
  assert.equal(detectBlindRisk('아버지 직장 때문에 이사를 했습니다').level, 'high');
});

test('gate fails closed when the filter itself throws; message never echoes input; event has codes/labels only', () => {
  const boom = { toString() { throw new Error('boom'); } };
  const g = blindGate(boom);
  assert.equal(g.blocked, true);
  assert.equal(g.level, 'error');
  assert.match(blindMessage(g), /AI로 보내지 않았습니다/);
  const ok = blindGate('제 이름은 김민수입니다');
  assert.ok(!blindMessage(ok).includes('김민수'));
  const ev = blindEvent({ gate: ok, question_id: 'stage-intro', action: 'rejected_reanswer' });
  assert.ok(ev.event_id && ev.codes.length && ev.labels.length && ev.filter_version);
  assert.ok(!JSON.stringify(ev).includes('김민수'));
  assert.equal(sanitizeForAi(boom).error, true);
});

test('sanitizeForAi masks risky phrases, reports kinds only, and flags what it cannot mask', () => {
  const r = sanitizeForAi('아버지가 교수이고 저는 과학고에서 실험을 했습니다. 결과를 비교했습니다.');
  assert.ok(!/교수|과학고/.test(r.text) && r.text.includes('[가림]') && r.text.includes('결과를 비교했습니다'));
  assert.ok(r.masked_categories.length >= 2 && r.masked_categories.every((m) => m.id && m.label && !('text' in m)));
  assert.equal(r.unmasked, false);
  assert.equal(sanitizeForAi('저는 과 학 고 학생이었습니다').unmasked, true, 'spaced spelling cannot be located -> caller must stop');
  assert.deepEqual(sanitizeForAi('효소 실험을 설계했습니다').masked_categories, []);
  assert.equal(sanitizeForAi('가족과 함께 주말에 과학관을 방문했습니다').text, '가족과 함께 주말에 과학관을 방문했습니다');
});
