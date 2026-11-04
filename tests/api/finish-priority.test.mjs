import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProviders, rawReply } from '../helpers/provider-stub.mjs';
import { createStore } from '../../src/store/memory.js';
import { getFixture } from '../../src/domain/fixtures.js';
const fx = getFixture('smp-snu-bio');
const isTurn = (c) => JSON.stringify(c.body).includes('대학 입학 면접관');
const reply = () => rawReply(JSON.stringify({ action: 'followup', utterance: '그 실험에서 직접 맡은 역할은 무엇인가요?', turn_score: { relevance: 3, specificity: 3, reasoning: 3 } }));
async function setup(ctx, store, index) {
  const { data: p } = await ctx.g('/api/v1/profiles', { method: 'POST', body: { org_type: 'university', school_name: fx.school_name, department: fx.department, source_text: fx.posting_text, application_text: fx.application_text, fixture_id: fx.id } });
  assert.equal((await ctx.g(`/api/v1/profiles/${p.id}/approve`, { method: 'POST', body: { version_id: p.version_id } })).status, 200);
  const started = await ctx.startSession({ interview_format: 'general', profile_version_id: p.version_id });
  const s = store.getSession('user-a', started.id);
  store.updateSession(s, { q_index: index });
  return { ...started, version: s.version };
}
test('finish takes precedence over an in-flight AI followup; confirmed answer survives and finish can be retried', async () => {
  let unblock; let started;
  const inFlight = new Promise((r) => { started = r; });
  const store = createStore({});
  await withProviders({ env: { GEMINI_LIVE_ACK: 'true' }, overrides: { store, syntheticTraffic: true }, respond: (c) => {
    if (isTurn(c)) { started(); return new Promise((r) => { unblock = () => r(reply()); }); }
    return rawReply('{}');
  } }, async (ctx) => {
    const s = await setup(ctx, store, 1);
    const pending = ctx.turn(s, '제가 직접 실험 조건을 정하고 결과를 비교했습니다.');
    await inFlight;
    const finish = ctx.g(`/api/v1/sessions/${s.id}/commands`, { method: 'POST', body: { command_id: crypto.randomUUID(), type: 'session.finish', payload: {} } });
    try {
      for (let i = 0; i < 200 && !store.getSession('user-a', s.id).finish_requested; i++) await new Promise((r) => setTimeout(r, 5));
      assert.equal(store.getSession('user-a', s.id).finish_requested, true);
    } finally { unblock(); }
    const t = await pending;
    assert.equal(t.data.action, 'finish'); assert.equal(t.data.state, 'completing');
    const done = await finish; assert.equal(done.status, 202); assert.equal(done.data.state, 'completed');
    assert.equal(store.sessionTurns(s.id).filter((t) => t.speaker_id === 'user').length, 1);
    assert.equal(store.getSession('user-a', s.id).awaiting_followup, false);
    const retried = await ctx.g(`/api/v1/sessions/${s.id}/commands`, { method: 'POST', body: { command_id: crypto.randomUUID(), type: 'session.finish', payload: {} } });
    assert.equal(retried.status, 202); assert.equal(retried.data.state, 'completed');
    const late = await ctx.turn({ ...s, version: done.data.version });
    assert.equal(late.status, 409);
  });
});
test('last main answer immediately finishes without calling dialogue.next, even when a model would ask more', async () => {
  const store = createStore({});
  await withProviders({ env: { GEMINI_LIVE_ACK: 'true' }, overrides: { store, syntheticTraffic: true }, respond: () => reply() }, async (ctx) => {
    const s = await setup(ctx, store, 4);
    const before = ctx.calls.filter(isTurn).length;
    const done = await ctx.turn(s, '입학 후에도 직접 탐구한 과정을 기록하고 동료와 비교하겠습니다.');
    assert.equal(done.data.state, 'completed'); assert.equal(done.data.action, 'finish');
    assert.equal(ctx.calls.filter(isTurn).length, before);
  });
});

test('invalid finish and replayed commands do not plant a finish flag or block a ready session', async () => {
  const store = createStore({});
  await withProviders({ overrides: { store }, respond: () => rawReply('{}') }, async (ctx) => {
    const active = await setup(ctx, store, 0);
    const row = store.getSession('user-a', active.id);
    await ctx.g(`/api/v1/sessions/${active.id}/commands`, { method: 'POST', body: { command_id: crypto.randomUUID(), type: 'session.finish', payload: {} } });
    const fresh = await ctx.g('/api/v1/sessions', { method: 'POST', body: { interview_format: 'general', profile_version_id: row.profile_version_id } });
    assert.equal(fresh.status, 201);
    const ready = fresh.data;
    const finish = await ctx.g(`/api/v1/sessions/${ready.id}/commands`, { method: 'POST', body: { command_id: crypto.randomUUID(), type: 'session.finish', payload: {} } });
    assert.equal(finish.status, 409);
    assert.ok(!store.getSession('user-a', ready.id).finish_requested);
    const id = crypto.randomUUID();
    const started = await ctx.g(`/api/v1/sessions/${ready.id}/commands`, { method: 'POST', body: { command_id: id, type: 'session.start', payload: {} } });
    assert.equal(started.status, 202);
    await ctx.g(`/api/v1/sessions/${ready.id}/commands`, { method: 'POST', body: { command_id: id, type: 'session.finish', payload: {} } });
    assert.ok(!store.getSession('user-a', ready.id).finish_requested, 'command replay cannot mutate state before its cached response');
    const denied = await ctx.g(`/api/v1/sessions/${ready.id}/commands`, { method: 'POST', token: 'dev-user-b-token', body: { command_id: crypto.randomUUID(), type: 'session.finish', payload: {} } });
    assert.equal(denied.status, 404);
    assert.ok(!store.getSession('user-a', ready.id).finish_requested, 'other owner cannot interrupt');
  });
});

test('failed final analysis retries explicitly, keeps strict gating and answers, and never regenerates a ready report', async () => {
  const store = createStore({});
  await withProviders({ env: { GEMINI_API_KEY: '', CLAUDE_API_KEY: '' }, overrides: { store }, respond: () => { throw new Error('unexpected outbound request'); } }, async (ctx) => {
    const s = await setup(ctx, store, 0);
    await ctx.turn(s, '제가 직접 실험 조건을 정하고 결과를 비교했습니다.');
    const turnsBefore = structuredClone(store.sessionTurns(s.id));
    const revisionsBefore = turnsBefore.map((t) => structuredClone(store.getRevisions(t.id)));
    ctx.app.config.aiRequireLive = true;
    const command = (payload = {}, command_id = crypto.randomUUID(), token) => ctx.g(`/api/v1/sessions/${s.id}/commands`, { method: 'POST', ...(token ? { token } : {}), body: { command_id, type: 'session.finish', payload } });
    const failed = await command();
    assert.equal(failed.data.report_status, 'failed');
    const originalFailure = store.evaluations.get(s.id);
    assert.equal(originalFailure.failure.operation, 'evaluation.observe');
    assert.ok(!JSON.stringify(originalFailure).includes('debug'));
    const report = await ctx.g(`/api/v1/sessions/${s.id}/report`);
    assert.equal(report.data.retryable, true);
    assert.equal(report.data.failure.operation, 'evaluation.observe');
    const completedAt = store.getSession('user-a', s.id).completed_at;
    await command();
    assert.equal(store.evaluations.get(s.id), originalFailure, 'plain finish remains idempotent');
    assert.equal((await command({ retry_report: true }, undefined, 'dev-user-b-token')).status, 404);
    await command({ retry_report: true });
    assert.equal(store.evaluations.get(s.id).status, 'failed', 'retry cannot bypass strict AI gate');
    // 사용자가 AI를 끈 것과 같은 명시적인 테스트 설정. 실패를 AI 성공으로 바꾸지 않는다.
    ctx.app.config.aiRequireLive = false;
    const id = crypto.randomUUID();
    const recovered = await command({ retry_report: true }, id);
    assert.equal(recovered.data.report_status, 'ready');
    const ready = store.evaluations.get(s.id);
    assert.equal(ready.evaluator.kind, 'rule_based');
    await command({ retry_report: true }, id);
    await command({ retry_report: true });
    assert.equal(store.evaluations.get(s.id), ready, 'ready report is immutable on retries');
    assert.equal(store.getSession('user-a', s.id).completed_at, completedAt);
    assert.deepEqual(store.sessionTurns(s.id), turnsBefore);
    assert.deepEqual(turnsBefore.map((t) => store.getRevisions(t.id)), revisionsBefore);
    assert.equal(ctx.calls.length, 0);
  });
});
