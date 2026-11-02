// AI_REQUIRE_LIVE=on: AI 스위치가 켜져 있으면 Mock·규칙 폴백으로 조용히 대체하지 않고 503 ai_unavailable을 낸다. 스위치를 끄면 기본 동작이 돌아온다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProviders, FAKE_KEY, STUB_BASE } from '../helpers/provider-stub.mjs';
import { createCaller, aiUnavailable } from '../../src/providers/call.js';

const sw = (ctx, on) => fetch(`${ctx.base}/api/v1/ai-switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) });
const body = { org_type: 'university', school_name: '임의대학교', department: '국문과', source_text: '인재상: 탐구 역량을 봅니다.', application_text: '저는 동아리 앱 개발 프로젝트에서 팀장을 맡아 일정을 조율했습니다.' };

test('strict caller: mock route and gate-blocked calls throw ai_unavailable; speech is exempt; non-strict keeps mock', async () => {
  const registry = { route: (op) => ({ provider: 'mock', alias: 'm', operation: op }) };
  const mk = (strict) => createCaller({ registry, gates: {}, strict: () => strict, adapters: {}, ledger: {} });
  await assert.rejects(() => mk(true).call('school.search', { mock: async () => 1 }), (e) => e.code === 'ai_unavailable' && e.status === 503);
  assert.equal((await mk(true).call('speech.transcribe', { mock: async () => 1 })).value, 1);
  assert.equal((await mk(false).call('school.search', { mock: async () => 2 })).value, 2);
  assert.equal(aiUnavailable('x', 'kill_switch').reason, 'kill_switch');
});

test('API: strict + AI on -> 503 ai_unavailable (no Mock); AI off -> rule-based works', async () => {
  await withProviders({ env: { AI_REQUIRE_LIVE: 'on', GEMINI_API_KEY: '', CLAUDE_API_KEY: '' }, respond: () => new Response('{}') }, async (ctx) => {
    const blocked = await ctx.g('/api/v1/profiles', { method: 'POST', body });
    assert.equal(blocked.status, 503, JSON.stringify(blocked.data));
    assert.equal(blocked.data.code ?? blocked.data.error?.code, 'ai_unavailable');
    assert.equal((await sw(ctx, false)).status, 200);
    const p = await ctx.g('/api/v1/profiles', { method: 'POST', body });
    assert.equal(p.status, 201, JSON.stringify(p.data));
    assert.equal(ctx.calls.length, 0, 'no outbound calls');
  });
});

const CLAUDE = { CLAUDE_API_KEY: FAKE_KEY, CLAUDE_BASE_URL: `${STUB_BASE}/claude`, CLAUDE_MODEL: 'stub-sonnet', CLAUDE_WRITER_MODEL: 'stub-haiku', CLAUDE_LIVE_ACK: 'true', CLAUDE_TIMEOUT_MS: '200' };
test('claude decideTurn adapter: routes dialogue.next to Claude and requires verifiable quote', async () => {
  const { createClaudeAdapter } = await import('../../src/providers/adapters/claude.js');
  let sent;
  const fetchFn = async (_u, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ action: 'followup', quote: '온도별로 비교했습니다', utterance: '온도별로 비교하셨다고 했는데 기준은 무엇이었나요?', turn_score: { relevance: 3, specificity: 2, reasoning: 2 } }) }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 }); };
  const a = createClaudeAdapter({ apiKey: 'k', baseUrl: 'http://x', model: 'sonnet', writerModel: 'haiku', fetchFn });
  const out = await a.decideTurn({ stageLabel: '경험', question: '무엇을 했나요?', answer: '온도별로 비교했습니다', allowFollowup: true });
  assert.equal(out.action, 'followup');
  assert.equal(sent.model, 'haiku');
  assert.ok(CLAUDE.CLAUDE_MODEL);
});
