// 질문별 점수·잘한 점·고치면 좋은 점: Gemini가 질문·학생부·답변을 읽고 쓰고, 실데이터는 REAL_DATA_ACK+동의 없으면 나가지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProviders, rawReply, okReply } from '../helpers/provider-stub.mjs';
import { createStore } from '../../src/store/memory.js';
import { validateAnswerReview } from '../../src/domain/answer-review.js';

const LIVE = { GEMINI_LIVE_ACK: 'true', GEMINI_REAL_DATA_ACK: 'true' };
const ANSWER = '산책 시간을 늘린 집단에서 짖음이 줄었습니다. 제가 직접 기록했고 비교 기준을 맞춘 이유는 집단 차이를 보기 위해서입니다.';
const FIX = '기록 간격을 먼저 말한 뒤 짖음이 어떻게 줄었는지 이어서 말해 보세요.';
const isReview = (c) => JSON.stringify(c.body).includes('각 답변의 점수와');

function reviewReply(c) {
  const ids = [...JSON.stringify(c.body).matchAll(/turn_id: ([A-Za-z0-9-]+)/g)].map((m) => m[1]);
  return rawReply(JSON.stringify({ turns: ids.map((turn_id) => ({ turn_id, relevance: 1, specificity: 2, reasoning: 2, good: '산책 집단을 직접 기록한 점을 먼저 말했습니다.', fix: FIX })) }));
}
const stub = (c) => (isReview(c) ? reviewReply(c) : okReply());

async function interview(g, store) {
  const r = await g('/api/v1/profiles', { method: 'POST', body: { org_type: 'university', school_name: '한빛대학교', department: '생명과학과', source_text: '인재상: 탐구 역량.', application_text: '산책 시간과 짖음, 물건 훼손의 빈도를 비교해 산책이 긴 집단에서 문제행동이 적다고 관찰했다.' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.synthetic, false);
  const inst = store.getInstitution(r.data.id);
  store.setInstitution(r.data.id, { ...inst.profile, school_analysis: { talent_traits: [{ id: 'trait-1', label: '탐구 역량', quote: '탐구 역량을 중시합니다' }], admission_elements: [] } }, 'review');
  assert.equal((await g(`/api/v1/profiles/${r.data.id}/approve`, { method: 'POST', body: { version_id: r.data.version_id } })).status, 200);
  const s = await g('/api/v1/sessions', { method: 'POST', body: { profile_version_id: r.data.version_id, interview_format: 'general', input_mode: 'text' } });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  let v = s.data.version;
  const cmd = async (type, payload = {}) => {
    const x = await g(`/api/v1/sessions/${s.data.id}/commands`, { method: 'POST', body: { command_id: crypto.randomUUID(), expected_version: v, type, payload } });
    if (x.data?.version) v = x.data.version;
    return x;
  };
  await cmd('session.start');
  for (let i = 0; i < 8 && (await g(`/api/v1/sessions/${s.data.id}`)).data.state === 'active'; i++) await cmd('turn.text', { text: ANSWER });
  return (await g(`/api/v1/sessions/${s.data.id}/report`)).data;
}

test('answer.review: consented real data is scored from the answer text, not a stock sentence', async () => {
  const store = createStore({});
  await withProviders({ env: LIVE, overrides: { store, syntheticTraffic: false }, respond: stub }, async ({ g, calls }) => {
    const rep = await interview(g, store);
    assert.equal(rep.status, 'ready', JSON.stringify(rep));
    assert.ok(calls.some(isReview));
    assert.equal(rep.score_label, 'Gemini 참고 점수 · 검증 전');
    const row = rep.transcript.find((t) => t.answer_text.includes('산책'));
    assert.equal(row.turn_score.relevance, 1);
    assert.equal(row.turn_score.source, 'llm');
    assert.equal(row.comment.fix, FIX);
    assert.match(row.comment.good, /산책/);
  });
});

test('answer.review: real data without REAL_DATA_ACK never reaches Gemini', async () => {
  const store = createStore({});
  await withProviders({ env: { GEMINI_LIVE_ACK: 'true' }, overrides: { store, syntheticTraffic: false }, respond: stub }, async ({ g, calls }) => {
    const rep = await interview(g, store);
    assert.equal(rep.status, 'ready');
    assert.equal(calls.some(isReview), false);
    assert.equal(rep.score_label, '규칙 참고 점수 · 검증 전');
    assert.ok(rep.transcript.every((t) => t.comment.fix !== FIX));
  });
});

test('validateAnswerReview rejects stock sentences and incomplete turns', () => {
  assert.equal(validateAnswerReview({ turns: [{ turn_id: 'a', relevance: 3, specificity: 3, reasoning: 3, good: '질문의 핵심에 바로 답했습니다.', fix: '기록 간격을 말해 보세요.' }] }, ['a']), null);
  const ok = validateAnswerReview({ turns: [{ turn_id: 'a', relevance: 1, specificity: 2, reasoning: 2, good: '', fix: '유전자 이야기 대신 산책 관찰로 돌아와 보세요.' }] }, ['a']);
  assert.equal(ok.turns[0].relevance, 1);
  assert.equal(ok.turns[0].good, '');
});
