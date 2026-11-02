import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripSttHallucination } from '../../src/domain/stt-filter.js';

test('stt filter: silence hallucinations become empty (답변 없음), real speech is kept', () => {
  assert.equal(stripSttHallucination('다음 영상에서 만나요.'), '');
  assert.equal(stripSttHallucination('시청해 주셔서 감사합니다.'), '');
  assert.equal(stripSttHallucination('저는 실험을 했습니다. 다음 영상에서 만나요.'), '저는 실험을 했습니다.');
  assert.equal(stripSttHallucination('저는 실험을 했습니다.'), '저는 실험을 했습니다.');
});
