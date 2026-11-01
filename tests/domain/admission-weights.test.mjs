import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admissionWeights } from '../../src/domain/admission-weights.js';
const target = { school_name: '가상대학교', department: '생명과학부', track: '일반전형' };
const segment = (text) => [{ id: 'source-1', text }];
const heading = '2027학년도 가상대학교 생명과학부 일반전형\n';
test('admission weights: exact percentages, stage/year and codepoint source provenance', () => {
  const text = heading + '2단계 서류평가 70%, 면접 30%\n면접 학업역량 40%, 공동체역량 60%';
  const r = admissionWeights(segment(text), target);
  assert.equal(r.status, 'found');
  assert.deepEqual(r.items.map((i) => [i.label, i.percent]), [['서류평가', 70], ['면접', 30], ['면접 학업역량', 40], ['공동체역량', 60]]);
  for (const item of r.items) {
    assert.equal(item.stage, '2단계'); assert.equal(item.year, '2027');
    assert.equal(Array.from(text).slice(item.start_cp, item.end_cp).join(''), item.quote);
    assert.equal(item.source_id, 'source-1');
  }
});
test('admission weights: no invented conversion, absent scope or different track/department', () => {
  for (const text of [heading + '서류 700점, 면접 300점. 1단계 3배수', '서류 70%, 면접 30%', heading.replace('일반전형', '지역균형전형') + '면접 100%', heading.replace('생명과학부', '수학과') + '면접 100%', heading + '지역균형전형\n면접 100%', heading + '면접 130%']) {
    assert.equal(admissionWeights(segment(text), target).status, 'unconfirmed', text);
  }
  assert.equal(admissionWeights(segment(heading + '면접 30%'), { ...target, track: '' }).status, 'unconfirmed');
  assert.equal(admissionWeights(segment(heading + '일반전형 면접 30%, 지역균형전형 면접 50%'), target).items.length, 0, 'mixed-track row is ambiguous');
});
test('admission weights: scope never crosses source boundary', () => {
  assert.equal(admissionWeights([{ id: 'a', text: heading }, { id: 'b', text: '면접 30%' }], target).items.length, 0);
});
