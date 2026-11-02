import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeneralPlan, competencyFit, stageQuestions } from '../../src/domain/interview-format.js';

test('plan: every competency is owned by a question stage, so the fit chart never has an unanswered competency', () => {
  const competencies = ['학업 역량', '탐구 정신', '협업 능력', '성장 가능성', '전공 이해'].map((label, i) => ({ id: `trait-${i + 1}`, label, quote: label }));
  const plan = buildGeneralPlan({ department: '생명과학부', competencies, claims: [], limits: [] });
  const owned = plan.stages.flatMap((s) => s.competency_ids);
  assert.deepEqual([...owned].sort(), competencies.map((c) => c.id).sort());
  assert.deepEqual(plan.stages.find((s) => s.stage === 'intro').competency_ids, []);
  const turns = stageQuestions(plan).map((q, i) => ({ turn_id: `t${i}`, text: '답변', turn_score: { relevance: 3, specificity: 3, reasoning: 3 }, evidence_ids: [], competency_ids: q.competency_ids }));
  assert.ok(competencyFit(plan.competencies, turns).every((c) => c.answers > 0));
});
