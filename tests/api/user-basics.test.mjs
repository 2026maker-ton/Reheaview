import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/server.js';

async function open(env = {}) {
  const app = createApp({ env: { GEMINI_API_KEY: '', GROQ_WHISPER_KEY: '', GROQ_API_KEY: '', DEV_TOKEN_A: '', DEV_TOKEN_B: '', TRENDS_FILE: '', ...env } });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const c = async (path, { method = 'GET', token, body } = {}) => {
    const h = {};
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (method !== 'GET') h['Idempotency-Key'] = crypto.randomUUID();
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { app, c, close: () => new Promise((r) => app.server.close(r)) };
}

const SIGNUP = { email: 'basics@example.test', name: '김지원', password: 'correct-horse-1', age_18_confirmed: true, notice_ack: true };

test('user basics: onboarding without password; edit requires password; guest forbidden', async () => {
  const { c, close } = await open();
  try {
    const s = await c('/api/v1/auth/signup', { method: 'POST', body: SIGNUP });
    assert.equal(s.status, 201);
    assert.equal(s.data.user.basics_complete, false);
    const g = await c('/api/v1/user/basics', { token: s.data.token });
    assert.equal(g.status, 200);
    assert.equal(g.data.onboarding_completed, false);
    const step = await c('/api/v1/user/basics', {
      method: 'PATCH', token: s.data.token,
      body: { onboarding: true, birth_year: 2005, student_record: '세특 요약', finish_onboarding: true, name: '김지원' },
    });
    assert.equal(step.status, 200, JSON.stringify(step.data));
    assert.equal(step.data.basics.onboarding_completed, true);
    assert.equal(step.data.user.basics_complete, true);
    const me = await c('/api/v1/auth/me', { token: s.data.token });
    assert.equal(me.data.basics_complete, true);
    const bad = await c('/api/v1/user/basics', { method: 'PATCH', token: s.data.token, body: { student_record: '변경' } });
    assert.equal(bad.status, 422);
    const ok = await c('/api/v1/user/basics', { method: 'PATCH', token: s.data.token, body: { password: SIGNUP.password, student_record: '변경된 요약' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.basics.student_record, '변경된 요약');
    const guest = await c('/api/v1/auth/guest', { method: 'POST', body: {} });
    assert.equal((await c('/api/v1/user/basics', { token: guest.data.token })).status, 403);
  } finally { await close(); }
});
