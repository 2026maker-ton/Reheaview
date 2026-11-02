// AI 기능 스위치(비밀번호 없음, 입장 잠금 뒤에서만) + 가입 없이 체험(Mock 모드): 꺼지면 외부 AI 호출이 0건이고 기본(규칙 기반) 동작은 계속된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProviders, FAKE_KEY, STUB_BASE } from '../helpers/provider-stub.mjs';
import { createApp } from '../../src/server.js';

const CLAUDE = { LLM_ANALYSIS_PROVIDER: 'claude', CLAUDE_API_KEY: FAKE_KEY, CLAUDE_BASE_URL: `${STUB_BASE}/claude`, CLAUDE_MODEL: 'stub-claude-model', CLAUDE_LIVE_ACK: 'true', CLAUDE_TIMEOUT_MS: '200', GEMINI_API_KEY: '', ROUTE_SCHOOL_ANALYZE: 'claude' };
const text = (o) => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(o) }], usage: { input_tokens: 80, output_tokens: 40 } }), { status: 200 });
const respond = () => text({ talent_traits: [{ label: '탐구', quote: '탐구 역량' }], admission_elements: [], interview_format: [], unconfirmed: [] });
const sw = (ctx, body, ip) => fetch(`${ctx.base}/api/v1/ai-switch`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) }, body: JSON.stringify(body) });

test('ai switch: anyone behind the gate can toggle; off blocks all provider calls but the flow still works', async () => {
  await withProviders({ env: CLAUDE, overrides: { syntheticTraffic: true }, respond }, async (ctx) => {
    const get = async () => (await fetch(`${ctx.base}/api/v1/ai-switch`)).json();
    assert.deepEqual(await get(), { on: true });
    assert.equal((await sw(ctx, { password: 'x' })).status, 422, 'on must be boolean');

    const prof = () => ctx.g('/api/v1/profiles', { method: 'POST', body: { org_type: 'university', school_name: '임의대학교', department: '국문과', source_text: '인재상: 탐구 역량을 봅니다.', application_text: '저는 동아리 앱 개발 프로젝트에서 팀장을 맡아 일정을 조율했습니다.' } });
    const calls = () => ctx.calls.filter((c) => c.url.includes('/claude/messages')).length;
    const p1 = await prof();
    await ctx.g(`/api/v1/profiles/${p1.data.id}/school-analysis`, { method: 'POST', body: { refresh: true } });
    assert.ok(calls() >= 1, 'AI on: provider called');

    const off = await sw(ctx, { on: false });
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { on: false });
    assert.equal((await get()).on, false);
    const before = calls();
    const p2 = await prof();
    assert.equal(p2.status, 201, 'profile creation still works with AI off');
    const a = await ctx.g(`/api/v1/profiles/${p2.data.id}/school-analysis`, { method: 'POST', body: { refresh: true } });
    assert.equal(a.status, 200);
    assert.equal(a.data.analysis_provider, 'rule', 'rule-based fallback with AI off');
    const ap = await ctx.g(`/api/v1/profiles/${p2.data.id}/approve`, { method: 'POST', body: { version_id: p2.data.version_id } });
    assert.equal(ap.status, 200, 'approval (plan design) works with AI off');
    assert.equal(calls(), before, 'no provider calls while AI is off');
    assert.equal((await ctx.g('/api/v1/providers/status')).data.summary, 'mock');

    assert.equal((await sw(ctx, { on: true })).status, 200);
    assert.equal((await get()).on, true);
  });
});

test('ai switch: rate limited per IP', async () => {
  await withProviders({ env: { ...CLAUDE }, respond }, async (ctx) => {
    for (let i = 0; i < 20; i++) assert.equal((await sw(ctx, { on: true }, '7.7.7.7')).status, 200);
    assert.equal((await sw(ctx, { on: true }, '7.7.7.7')).status, 429);
    assert.equal((await sw(ctx, { on: true }, '8.8.8.8')).status, 200);
  });

});

const open = async (env) => {
  const app = createApp({ env: { GEMINI_API_KEY: '', GROQ_WHISPER_KEY: '', GROQ_API_KEY: '', DEV_TOKEN_A: '', DEV_TOKEN_B: '', TRENDS_FILE: '', ...env } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const c = async (path, { method = 'GET', token, body, ip } = {}) => {
    const h = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(ip ? { 'x-forwarded-for': ip } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'Idempotency-Key': crypto.randomUUID() } : {}) };
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { app, c, close: () => new Promise((r) => app.server.close(r)) };
};

test('guest: Mock mode lets people in without signup, guest data never reaches external AI, and the full flow works', async () => {
  const { c, close } = await open();
  try {
    assert.deepEqual((await c('/api/v1/auth/mode')).data, { guest_allowed: true });
    const g = await c('/api/v1/auth/guest', { method: 'POST', body: {} });
    assert.equal(g.status, 201, JSON.stringify(g.data));
    assert.equal(g.data.user.guest, true);
    assert.equal(g.data.user.email, null);
    const me = await c('/api/v1/auth/me', { token: g.data.token });
    assert.equal(me.data.guest, true);
    await c('/api/v1/ai-switch', { method: 'POST', body: { on: false } });
    const p = await c('/api/v1/profiles', { method: 'POST', token: g.data.token, body: { org_type: 'university', school_name: '임의대학교', department: '국문과', source_text: '인재상: 탐구 역량', application_text: '저는 동아리에서 팀장을 맡아 일정을 조율했습니다.' } });
    assert.equal(p.status, 201, JSON.stringify(p.data));
    assert.equal((await c('/api/v1/providers/status', { token: g.data.token })).data.summary, 'mock');
    assert.equal((await c('/api/v1/account', { method: 'DELETE', token: g.data.token })).status, 202);
    assert.equal((await c('/api/v1/auth/me', { token: g.data.token })).status, 401);
  } finally { await close(); }
});

test('guest AI: explicit adult consent opens approved providers; AI off is Mock; missing/forged consent never sends data', async () => {
  await withProviders({ env: { ...CLAUDE, CLAUDE_REAL_DATA_ACK: 'true', GROQ_WHISPER_KEY: FAKE_KEY, GROQ_LIVE_ACK: 'true', GROQ_REAL_DATA_ACK: 'true' }, respond }, async (ctx) => {
    const post = (path, body, ip) => fetch(`${ctx.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) }, body: JSON.stringify(body) });
    const guest = await post('/api/v1/auth/guest', {});
    const { token } = await guest.json();
    const req = (path, body) => ctx.g(path, { method: 'POST', token, body, noConsent: true });
    const profile = { org_type: 'university', school_name: '임의대학교', department: '국문과', source_text: '인재상: 탐구 역량을 중시합니다.', application_text: '저는 동아리 앱 개발 프로젝트에서 팀장을 맡아 일정을 조율했습니다.', synthetic: true };
    assert.equal((await req('/api/v1/profiles', profile)).status, 428);
    assert.equal((await req('/api/v1/consents', { age_18_confirmed: true, notice_version: 'test', notice_ack: true })).status, 428);
    assert.equal((await req('/api/v1/consents', { age_18_confirmed: false, notice_version: 'guest-ai-2026-11-01', notice_ack: true })).status, 403);
    assert.equal((await req('/api/v1/consents', { age_18_confirmed: true, notice_version: 'guest-ai-2026-11-01' })).status, 428);
    assert.equal(ctx.calls.length, 0);
    assert.equal((await req('/api/v1/consents', { age_18_confirmed: true, notice_version: 'guest-ai-2026-11-01', notice_ack: true })).status, 201);
    assert.equal((await ctx.g('/api/v1/auth/me', { token })).data.ai_consent, true);
    assert.equal((await ctx.g('/api/v1/stt/status', { token })).data.real_data_allowed, true, 'guest consent includes the audio notice');
    const p = await req('/api/v1/profiles', profile);
    assert.equal(p.status, 201, JSON.stringify(p.data));
    await req(`/api/v1/profiles/${p.data.id}/school-analysis`, { refresh: true });
    assert.ok(ctx.calls.length > 0, 'consenting guest may use an approved real-data provider (stub)');
    const before = ctx.calls.length;
    await sw(ctx, { on: false });
    await req(`/api/v1/profiles/${p.data.id}/school-analysis`, { refresh: true });
    assert.equal(ctx.calls.length, before, 'AI off performs zero outbound calls');
    assert.equal((await ctx.g('/api/v1/providers/status', { token })).data.summary, 'mock');
    for (let i = 0; i < 5; i++) await post('/api/v1/auth/guest', {}, '6.6.6.6');
    assert.equal((await post('/api/v1/auth/guest', {}, '6.6.6.6')).status, 429);
  });
});

test('guest consent does not bypass provider real-data approval', async () => {
  await withProviders({ env: CLAUDE, respond }, async (ctx) => {
    const guest = await ctx.g('/api/v1/auth/guest', { method: 'POST', body: {} });
    const token = guest.data.token;
    await ctx.g('/api/v1/consents', { method: 'POST', token, body: { age_18_confirmed: true, notice_ack: true, notice_version: 'guest-ai-2026-11-01' } });
    const status = await ctx.g('/api/v1/providers/status', { token });
    assert.equal(status.data.operations['school.analyze'].mode, 'mock');
    assert.ok(['synthetic_only', 'real_data_ack_missing'].includes(status.data.operations['school.analyze'].blocked_reason));
    assert.equal(ctx.calls.length, 0);
  });
});
