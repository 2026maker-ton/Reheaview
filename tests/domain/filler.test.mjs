// 말버릇 표시: 사전 군말만 표시하고, HTML은 항상 이스케이프한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightFillers, fillerSummary } from '../../public/core/filler.js';

test('fillers: demonstrative 그 is not counted in references to a measurement or process', () => {
  for (const text of ['이 경험에서 측정값이 나왔다는 것과 그 측정값이 무엇을 의미하는가에는 다르다는 걸 배웠어요', '그런데 후성 유전학을 공부하면서 그 과정이 흔들렸죠.', '그 사람과 그 결과를 비교했습니다.']) {
    assert.equal(highlightFillers(text).total, 0, text);
  }
  assert.deepEqual(highlightFillers('음, 그 측정값을 다시 봤습니다.').counts, { 음: 1 });
});

test('fillers: standalone filler words are marked, word-internal matches are not, counts are summarized', () => {
  const r = highlightFillers('음 저는 그냥 실험을 했고, 어 이제 결과를 봤습니다. 사실 그래서 어렵지 않았습니다.');
  assert.equal(r.total, 5, JSON.stringify(r.counts));
  assert.deepEqual(r.counts, { 음: 1, 그냥: 1, 어: 1, 이제: 1, 사실: 1 });
  assert.ok(r.html.includes('<mark class="filler">그냥</mark>'));
  assert.ok(!r.html.includes('<mark class="filler">그래서') && !r.html.includes('>어렵'), 'no marks inside longer words');
  assert.equal(fillerSummary(r.counts).includes('그냥 1'), true);
});

test('fillers: hedge ending counts only from three repeats; html is escaped; empty is safe', () => {
  assert.equal(highlightFillers('그럴 것 같아요. 맞는 것 같아요.').total, 0);
  assert.equal(highlightFillers('그럴 것 같아요. 맞는 것 같아요. 아닌 것 같아요.').counts['~같아요'], 3);
  const x = highlightFillers('<img src=x onerror=alert(1)> 음 <b>');
  assert.ok(!x.html.includes('<img') && x.html.includes('&lt;img') && x.html.includes('<mark class="filler">음</mark>'));
  assert.deepEqual(highlightFillers('').counts, {});
});
