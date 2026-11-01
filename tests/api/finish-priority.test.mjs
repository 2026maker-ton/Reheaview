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
