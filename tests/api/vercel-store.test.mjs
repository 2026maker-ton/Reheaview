// Vercel + Upstash Redis 저장 방식: 요청마다 새 코어, 사용자 데이터는 Redis에서 불러오고 저장. 가짜 Redis(메모리)로 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVercelHandler, LOCK_MS } from '../../src/vercel/handler.js';
import { readFileSync } from 'node:fs';
import { createRedis } from '../../src/vercel/redis.js';
import { getFixture } from '../../src/domain/fixtures.js';

// Upstash REST를 흉내 내는 fetch: 실제 createRedis 클라이언트를 통과시킨다.
function fakeUpstash() {
  const kv = new Map(); const sets = new Map(); const hashes = new Map(); let evals = 0;
  const run = (c) => {
    const [op, ...a] = c; const o = op.toUpperCase();
    if (o === 'GET') return kv.has(a[0]) ? kv.get(a[0]) : null;
    if (o === 'SET') { if (a.includes('NX') && kv.has(a[0])) return null; kv.set(a[0], a[1]); return 'OK'; }
    if (o === 'DEL') { const had = kv.delete(a[0]); sets.delete(a[0]); hashes.delete(a[0]); return had ? 1 : 0; }
    if (o === 'INCR') { const n = Number(kv.get(a[0]) || 0) + 1; kv.set(a[0], String(n)); return n; }
    if (o === 'EXPIRE') return 1;
    if (o === 'SADD') { const s = sets.get(a[0]) || new Set(); s.add(a[1]); sets.set(a[0], s); return 1; }
    if (o === 'SMEMBERS') return [...(sets.get(a[0]) || [])];
    if (o === 'HMGET') { const h = hashes.get(a[0]) || {}; return a.slice(1).map((f) => (f in h ? String(h[f]) : null)); }
    if (o === 'HINCRBYFLOAT') { const h = hashes.get(a[0]) || {}; h[a[1]] = (Number(h[a[1]]) || 0) + Number(a[2]); hashes.set(a[0], h); return String(h[a[1]]); }
    if (o === 'EVAL') { evals++; if (kv.get(a[2]) === a[3]) { kv.delete(a[2]); return 1; } return 0; }
    throw new Error('unsupported ' + op);
  };
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (opts.headers.Authorization !== 'Bearer tok') return new Response('{}', { status: 401 });
    const res = String(url).endsWith('/pipeline') ? body.map((c) => ({ result: run(c) })) : { result: run(body) };
    return new Response(JSON.stringify(res), { status: 200 });
  };
  return { kv, fetchFn, get evals() { return evals; } };
}
const ENV = { GEMINI_API_KEY: '', GROQ_WHISPER_KEY: '', CLAUDE_API_KEY: '', DEV_TOKEN_A: '', DEV_TOKEN_B: '', TRENDS_FILE: '', PROFILE_RATE_PER_MINUTE: '100', PROFILE_RATE_PER_DAY: '100' };
function setup() {
  const up = fakeUpstash();
  const redis = createRedis({ url: 'https://redis.test', token: 'tok', fetchFn: up.fetchFn });
  // 요청마다 새 핸들러(=콜드 스타트)로 호출해 인메모리 상태가 이어지지 않음을 보장한다.
  const call = async (path, { method = 'GET', body, token, ip = '1.1.1.1' } = {}) => {
    const h = createVercelHandler({ env: ENV, redis });
    const headers = { 'x-forwarded-for': ip };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
    const r = await h(new Request('http://x' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  return { up, call };
}
const SIGNUP = { email: 'V@Example.test', name: '브이', password: 'vercel-pass-1', age_18_confirmed: true, notice_ack: true };

test('owner lease covers the entire configured function lifetime and persistence margin', () => {
  const deploy = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.equal(deploy.functions['api/handler.js'].maxDuration, 300);
  assert.ok(LOCK_MS >= deploy.functions['api/handler.js'].maxDuration * 1000 + 30000);
});

test('cold starts: signup -> me -> login -> logout survive across stateless requests; tokens/passwords are stored hashed', async () => {
  const { up, call } = setup();
  const s = await call('/api/v1/auth/signup', { method: 'POST', body: SIGNUP });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal((await call('/api/v1/auth/me', { token: s.data.token })).data.name, '브이');
  const l = await call('/api/v1/auth/login', { method: 'POST', body: { email: 'v@example.test', password: SIGNUP.password } });
  assert.equal(l.status, 200);
  assert.equal((await call('/api/v1/auth/me', { token: l.data.token })).status, 200);
  assert.ok(![...up.kv.keys()].some((k) => k.includes(s.data.token)), 'token never stored raw');
  assert.ok(![...up.kv.values()].some((v) => String(v).includes(SIGNUP.password)), 'password never stored raw');
  assert.equal((await call('/api/v1/auth/logout', { method: 'POST', token: s.data.token, body: {} })).status, 200);
  assert.equal((await call('/api/v1/auth/me', { token: s.data.token })).status, 401);
  assert.equal((await call('/api/v1/auth/me', { token: l.data.token })).status, 200, 'other device session stays');
  assert.equal((await call('/api/v1/auth/signup', { method: 'POST', body: SIGNUP, ip: '2.2.2.2' })).status, 409, 'duplicate email');
  assert.equal((await call('/api/v1/auth/me')).status, 401);
  assert.ok(up.evals >= 1, 'per-owner lock is released through the compare-and-delete script');
  assert.equal([...up.kv.keys()].filter((k) => k.startsWith('lock:')).length, 0);
});

test('cold starts: profile, approval and interview state persist per owner; other owners cannot read it; account delete wipes everything', async () => {
  const { up, call } = setup();
  const a = (await call('/api/v1/auth/signup', { method: 'POST', body: SIGNUP })).data;
  const b = (await call('/api/v1/auth/signup', { method: 'POST', body: { ...SIGNUP, email: 'other@example.test' }, ip: '3.3.3.3' })).data;
  const fx = getFixture('smp-snu-bio');
  const p = await call('/api/v1/profiles', { method: 'POST', token: a.token, body: { org_type: 'university', school_name: fx.school_name, department: fx.department, track: fx.track, source_text: fx.posting_text, application_text: fx.application_text, fixture_id: fx.id } });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  assert.equal((await call(`/api/v1/profiles/${p.data.id}`, { token: a.token })).data.school_name, fx.school_name, 'read after cold start');
  assert.equal((await call(`/api/v1/profiles/${p.data.id}`, { token: b.token })).status, 404, 'owner isolation');
  const ap = await call(`/api/v1/profiles/${p.data.id}/approve`, { method: 'POST', token: a.token, body: { version_id: p.data.version_id } });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  const s = await call('/api/v1/sessions', { method: 'POST', token: a.token, body: { profile_version_id: p.data.version_id, interview_format: 'general', input_mode: 'text' } });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  const st = await call(`/api/v1/sessions/${s.data.id}/commands`, { method: 'POST', token: a.token, body: { command_id: crypto.randomUUID(), expected_version: s.data.version, type: 'session.start', payload: {} } });
  assert.equal(st.status, 202, JSON.stringify(st.data));
  const t = await call(`/api/v1/sessions/${s.data.id}/commands`, { method: 'POST', token: a.token, body: { command_id: crypto.randomUUID(), expected_version: st.data.version, type: 'turn.text', payload: { text: fx.answers[0] } } });
  assert.equal(t.status, 202, JSON.stringify(t.data));
  assert.equal((await call(`/api/v1/sessions/${s.data.id}`, { token: a.token })).data.q_index, 1, 'turn state persisted');
  assert.ok(up.kv.has(`own:${a.user.id}`) && up.kv.get(`own:${a.user.id}`).length < 200_000, 'one compressed bundle per owner');
  assert.equal((await call('/api/v1/account', { method: 'DELETE', token: a.token })).status, 202);
  for (const k of [`user:${a.user.id}`, `own:${a.user.id}`, 'email:v@example.test', `usess:${a.user.id}`]) assert.equal(up.kv.has(k), false, k);
  assert.equal((await call('/api/v1/auth/me', { token: a.token })).status, 401);
  assert.equal((await call('/api/v1/auth/me', { token: b.token })).status, 200, 'other account untouched');
});

test('auth rate limit lives in Redis (survives cold starts); unconfigured store and Redis outage fail closed', async () => {
  const { call } = setup();
  let last;
  for (let i = 0; i < 6; i++) last = await call('/api/v1/auth/login', { method: 'POST', body: { email: 'x@y.test', password: 'whatever-1' }, ip: '9.9.9.9' });
  assert.equal(last.status, 429);
  const none = await createVercelHandler({ env: ENV, redis: null })(new Request('http://x/api/v1/sessions', { headers: { Authorization: 'Bearer z' } }));
  assert.equal(none.status, 503);
  const down = createRedis({ url: 'https://redis.test', token: 'tok', fetchFn: async () => new Response('{}', { status: 500 }) });
  const out = await createVercelHandler({ env: ENV, redis: down })(new Request('http://x/api/v1/sessions', { headers: { Authorization: 'Bearer z' } }));
  assert.equal(out.status, 503);
});

test('no site gate on Vercel: open without SITE_PASSWORD, auth still required for user routes', async () => {
  const up = fakeUpstash();
  const redis = createRedis({ url: 'https://redis.test', token: 'tok', fetchFn: up.fetchFn });
  const h = createVercelHandler({ env: { ...ENV, VERCEL: '1' }, redis });
  const req = (path, init = {}) => new Request('http://x' + path, { headers: { 'x-forwarded-for': '2.2.2.2' }, ...init });
  assert.equal((await h(req('/api/v1/health'))).status, 200);
  assert.equal((await h(req('/api/v1/gate'))).status === 503, false);
  assert.equal((await h(req('/api/v1/sessions'))).status, 401);
});

test('ai switch on Vercel: state lives in Redis across cold starts and is rate limited via Redis', async () => {
  const up = fakeUpstash();
  const redis = createRedis({ url: 'https://redis.test', token: 'tok', fetchFn: up.fetchFn });
  const mk = () => createVercelHandler({ env: { ...ENV }, redis });
  const call = (method, body, ip = '4.4.4.4') => mk()(new Request('http://x/api/v1/ai-switch', { method, headers: { 'x-forwarded-for': ip, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }));
  assert.deepEqual(await (await call('GET')).json(), { on: true });
  assert.equal((await call('POST', { password: 'x' })).status, 422);
  assert.equal((await call('POST', { on: false })).status, 200);
  assert.equal(up.kv.get('flag:ai_off'), '1');
  assert.equal((await (await call('GET')).json()).on, false, 'a fresh handler sees the stored state');
  assert.equal((await call('POST', { on: true })).status, 200);
  assert.equal(up.kv.has('flag:ai_off'), false);
  let last;
  for (let i = 0; i < 22; i++) last = await call('POST', { on: true }, '5.5.5.5');
  assert.equal(last.status, 429);
});

test('guest on Vercel: always available, account persists across cold starts', async () => {
  const up = fakeUpstash();
  const redis = createRedis({ url: 'https://redis.test', token: 'tok', fetchFn: up.fetchFn });
  const mk = (extra = {}) => createVercelHandler({ env: { ...ENV, ...extra }, redis });
  const call = (h, path, { method = 'GET', token, body = {} } = {}) => h(new Request('http://x' + path, { method, headers: { 'x-forwarded-for': '9.9.9.9', 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(method !== 'GET' ? { 'Idempotency-Key': crypto.randomUUID() } : {}) }, body: method === 'POST' ? JSON.stringify(body) : undefined }));
  assert.equal((await (await call(mk(), '/api/v1/auth/mode')).json()).guest_allowed, true);
  const g = await call(mk(), '/api/v1/auth/guest', { method: 'POST' });
  assert.equal(g.status, 201);
  const { token, user } = await g.json();
  assert.equal(user.guest, true);
  const me = await (await call(mk(), '/api/v1/auth/me', { token })).json();
  assert.equal(me.guest, true);
  assert.equal(me.ai_consent, false);
  const consent = await call(mk(), '/api/v1/consents', { method: 'POST', token, body: { age_18_confirmed: true, notice_ack: true, notice_version: 'guest-ai-2026-11-01' } });
  assert.equal(consent.status, 201);
  const after = await (await call(mk(), '/api/v1/auth/me', { token })).json();
  assert.equal(after.ai_consent, true, 'guest AI consent persists across cold starts');
  assert.equal((await call(mk({ CLAUDE_API_KEY: 'k', CLAUDE_BASE_URL: 'https://x.test', CLAUDE_MODEL: 'm' }), '/api/v1/auth/guest', { method: 'POST' })).status, 201, 'live key configured: guests remain available');
});
