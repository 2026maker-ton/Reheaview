import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveTestBudget } from '../../tools/live-test-budget.mjs';
test('live test budget stops the tenth concurrent external request before network; local API is excluded', async () => {
  const sent = [];
  const budget = createLiveTestBudget(async (url, options) => { sent.push(String(url)); if (String(url).startsWith('https:')) assert.equal(options.redirect, 'error'); return new Response('ok'); });
  await budget.fetch('http://127.0.0.1:3000/api/v1/health');
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => budget.fetch('https://fake.provider.test/inference')));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 9);
  assert.equal(results[9].reason.code, 'TEST_AI_CALL_LIMIT');
  assert.equal(sent.filter((s) => s.includes('fake.provider.test')).length, 9);
  assert.equal(budget.calls, 9);
  await assert.rejects(budget.fetch('https://other.fake.provider.test/search'), /limit reached/);
});
test('failed attempts count too, and a caller cannot raise the live test budget above 9', async () => {
  let sent = 0;
  const budget = createLiveTestBudget(async () => { sent++; throw new Error('upstream failure'); }, 2);
  await assert.rejects(budget.fetch('https://fake.test/first'), /upstream/);
  await assert.rejects(budget.fetch(new Request('http://127.0.0.1:8317/v1/messages')), /upstream/, 'local AI proxy calls count too');
  await assert.rejects(budget.fetch('https://fake.test/fallback'), /limit reached/);
  assert.equal(sent, 2);
  assert.throws(() => createLiveTestBudget(() => {}, 10), RangeError);
});
