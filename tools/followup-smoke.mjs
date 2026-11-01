import { createLiveTestBudget } from './live-test-budget.mjs';
globalThis.fetch = createLiveTestBudget(globalThis.fetch).fetch;
// 사용자 승인 실호출 검증: 합성 사례만, 실제 HTTP AI 요청 최대 9회(재시도 포함).
import fs from 'node:fs';
import { createApp } from '../src/server.js';
import { loadDotEnv } from '../src/env.js';
import { getFixture } from '../src/domain/fixtures.js';

const loaded = loadDotEnv();
if (!loaded.GEMINI_API_KEY) throw new Error('Gemini key not configured');
const realFetch = globalThis.fetch;
const requests = [];
const expected = new URL(loaded.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').origin;
globalThis.fetch = async (url, options) => {
  if (new URL(url).origin !== expected || !String(url).includes(':generateContent')) throw new Error('Unexpected outbound endpoint');
  if (requests.length >= 9) throw Object.assign(new Error('Nine-call cap reached'), { invalid: true });
  const entry = { number: requests.length + 1, status: null }; requests.push(entry);
  const response = await realFetch(url, options); entry.status = response.status; return response;
};
const env = { ...loaded, SITE_PASSWORD: '', STORE: 'memory', TRENDS_FILE: '', DEV_TOKEN_A: 'followup-synthetic-smoke', PROFILE_RATE_PER_MINUTE: '100' };
for (const op of ['CLAIMS_EXTRACT', 'SCHOOL_ANALYZE', 'QUESTIONS_DESIGN', 'QUESTIONS_WRITE', 'EVALUATION_OBSERVE', 'EVALUATION_GENERATE', 'REPORT_COMMENT', 'SCHOOL_SEARCH', 'TRENDS_DECIDE', 'SPEECH_TRANSCRIBE', 'SPEECH_SYNTHESIZE']) env[`ROUTE_${op}`] = 'mock';
env.ROUTE_DIALOGUE_NEXT = 'gemini';
const app = createApp({ env, syntheticTraffic: true });
async function call(path, body) {
  const res = await app.fetch(new Request(`http://local.test/api/v1${path}`, { method: 'POST', headers: { Authorization: 'Bearer followup-synthetic-smoke', 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) }));
  const data = await res.json();
  if (!res.ok) throw new Error(`Local API ${res.status}: ${data.error?.code}`);
  return data;
}
const fx = getFixture('smp-snu-bio');
const answers = {
  intro: '생명과학 실험에서 조건에 따라 효소 반응이 달라지는 점이 궁금해 직접 탐구하고 싶습니다.',
  academic: '전공 개념을 실험으로 확인했고 결과가 달랐습니다.',
  experience: '팀에서 좋은 결과를 냈습니다.',
  reflection: '실패했지만 다음에는 더 잘하려고 합니다.',
  closing: '입학 후 생명과학 개념을 배우고 실험으로 확인하고 싶습니다.',
};
const rows = [];
try {
  const p = await call('/profiles', { org_type: 'university', school_name: fx.school_name, department: fx.department, source_text: fx.posting_text, application_text: fx.application_text, fixture_id: fx.id });
  await call(`/profiles/${p.id}/approve`, { version_id: p.version_id });
  const s = await call('/sessions', { profile_version_id: p.version_id, interview_format: 'general', input_mode: 'text' });
  let version = s.version;
  const command = async (type, payload = {}) => { const r = await call(`/sessions/${s.id}/commands`, { command_id: crypto.randomUUID(), expected_version: version, type, payload }); version = r.version; return r; };
  await command('session.start');
  for (const [stage, answer] of Object.entries(answers)) {
    const r = await command('turn.text', { text: answer });
    rows.push({ stage, answer, action: r.action, followup: r.action === 'ask_followup' ? r.utterance : null, trace: r.provider_trace });
    if (r.action === 'ask_followup') {
      const follow = await command('turn.text', { text: '제가 실험 조건을 하나씩 통제하는 기준을 정했고, 같은 조건에서 반복 측정한 결과를 비교했습니다. 다음에는 측정 오차를 줄이는 절차를 먼저 확인하겠습니다.' });
      rows.push({ stage, followup_answer: true, action: follow.action, trace: follow.provider_trace });
    }
  }
  const result = { date: new Date().toISOString(), synthetic_only: true, hard_cap: 9, actual_http_ai_requests: requests.length, requests, rows };
  fs.mkdirSync('docs/verification', { recursive: true });
  fs.writeFileSync('docs/verification/2026-11-01-followup-smoke.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { globalThis.fetch = realFetch; }
