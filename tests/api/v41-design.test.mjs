// 설계서 v4.1 반영(답변 확정·음성 개인정보 제외): 블라인드 사전 차단, 지원서 마스킹, 페르소나, 6축 레이더, 실패 시 꼬리질문 미생성, 오류 신고.
// 스텁 fetch·가짜 키만 사용(실호출 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProviders, okReply, rawReply, statusReply } from '../helpers/provider-stub.mjs';
import { createStore } from '../../src/store/memory.js';
import { getFixture } from '../../src/domain/fixtures.js';

const fx = getFixture('smp-snu-bio');
const LIVE = { GEMINI_LIVE_ACK: 'true' };
const TRAITS = [{ label: '탐구 역량', quote: '탐구 역량을 중시합니다' }, { label: '공동체 역량', quote: '공동체 역량을 중시합니다' }];
const isDesign = (c) => JSON.stringify(c.body).includes('면접 질문 설계기');
const isTurn = (c) => JSON.stringify(c.body).includes('대학 입학 면접관');
const json = (o) => rawReply(JSON.stringify(o));
const NEXT = { action: 'next', turn_score: { relevance: 3, specificity: 3, reasoning: 3 } };
const stub = ({ turn = NEXT } = {}) => (c) => (isDesign(c) ? json({ stages: [] }) : isTurn(c) ? (typeof turn === 'function' ? turn(c) : json(turn)) : okReply());

async function setup(ctx, store, body = {}) {
  const r = await ctx.g('/api/v1/profiles', { method: 'POST', body: { org_type: 'university', school_name: fx.school_name, department: fx.department, source_text: fx.posting_text, application_text: fx.application_text, fixture_id: fx.id, ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const inst = store.getInstitution(r.data.id);
  store.setInstitution(r.data.id, { ...inst.profile, school_analysis: { talent_traits: TRAITS.map((t, i) => ({ id: `trait-${i + 1}`, ...t })), admission_elements: [] } }, 'review');
  return r.data;
}
const approve = (ctx, p, body = {}) => ctx.g(`/api/v1/profiles/${p.id}/approve`, { method: 'POST', body: { version_id: p.version_id, ...body } });
const run = (respond, fn, env = {}) => { const store = createStore({}); return withProviders({ env: { ...LIVE, ...env }, overrides: { store, syntheticTraffic: true }, respond }, (ctx) => fn(ctx, store)); };
async function startGeneral(ctx, p) {
  const s = await ctx.g('/api/v1/sessions', { method: 'POST', body: { profile_version_id: p.version_id, interview_format: 'general', input_mode: 'text' } });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  let v = s.data.version;
  const cmd = async (type, payload = {}) => { const r = await ctx.g(`/api/v1/sessions/${s.data.id}/commands`, { method: 'POST', body: { command_id: crypto.randomUUID(), expected_version: v, type, payload } }); if (r.data?.version) v = r.data.version; return r; };
  await cmd('session.start');
  return { id: s.data.id, cmd };
}
const GOOD = '제가 직접 실험을 설계했고 그 이유는 변수를 하나씩 통제하기 위해서였습니다. 결과를 비교해 보니 효소 활성이 달라졌습니다.';
const CRISPR_ANSWER = "네, 제가 생명과학부에 지원하게 된 계기는 고등학교 때 '유전자 가위(CRISPR)' 기술을 주제로 발표를 준비했던 경험 덕분입니다";

test('blind gate: generic high-school memory keeps its exact revision and reaches the provider; a later school identifier still blocks', () => run(stub(), async (ctx, store) => {
  const p = await setup(ctx, store);
  await approve(ctx, p);
  const s = await startGeneral(ctx, p);
  const before = ctx.calls.length;
  const accepted = await s.cmd('turn.text', { text: CRISPR_ANSWER });
  assert.equal(accepted.status, 202);
  assert.notEqual(accepted.data.action, 'blind_blocked');
  assert.equal(store.getRevisions(accepted.data.turn_id)[0].normalized_text, CRISPR_ANSWER);
  assert.ok(ctx.calls.slice(before).some((c) => isTurn(c) && JSON.stringify(c.body).includes(CRISPR_ANSWER)), 'safe evidence reaches the stub unchanged');
  const calls = ctx.calls.length;
  const turns = store.sessionTurns(s.id).length;
  const rejected = await s.cmd('turn.text', { text: `${CRISPR_ANSWER}. 송도 고등학교에서 발표했습니다.` });
  assert.equal(rejected.data.action, 'blind_blocked');
  assert.equal(rejected.data.ai_sent, false);
  assert.equal(ctx.calls.length, calls);
  assert.equal(store.sessionTurns(s.id).length, turns);
}));

test('personas: config validates against the schema rules; 5 personas, faculty is disabled with its reasons; endpoint lists them', async () => {
  const { validatePersonaConfig, PERSONA_CONFIG } = await import('../../src/domain/personas.js');
  assert.deepEqual(validatePersonaConfig(PERSONA_CONFIG), []);
  // 설정 파일 사본이 원본 JSON과 같다(Vercel 번들용 JS 사본이 어긋나지 않게)
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(JSON.parse(readFileSync(new URL('../../docs/personas/personas.v2.json', import.meta.url), 'utf8')), PERSONA_CONFIG);
  // 질문 문장 필드가 들어간 설정은 거절된다
  const bad = structuredClone(PERSONA_CONFIG); bad.personas[0].questions = ['지원 동기를 말해 보세요.']; bad.persona_policy.may_generate_questions = true;
  assert.ok(validatePersonaConfig(bad).length >= 2);
  const off = structuredClone(PERSONA_CONFIG); off.personas.find((p) => p.id === 'faculty_research_lens').enabled_by_default = true;
  assert.ok(validatePersonaConfig(off).some((e) => /enabled_by_default/.test(e)));
  await run(stub(), async (ctx) => {
    const r = await ctx.g('/api/v1/personas');
    assert.equal(r.status, 200);
    assert.equal(r.data.personas.length, 5);
    const fac = r.data.personas.find((p) => p.id === 'faculty_research_lens');
    assert.equal(fac.available, false);
    assert.ok(fac.missing.length >= 4 && /검증/.test(fac.unavailable_reason));
    assert.equal(r.data.combinations.find((c) => c.id === 'verified_faculty_research_focus').selectable, false);
    assert.equal(r.data.combinations.find((c) => c.id === 'student_record_comprehensive_default').selectable, true);
    assert.equal(r.data.default_combination, 'student_record_comprehensive_default');
  });
});

test('personas: persona block reaches the design and per-turn prompts by stage; faculty/unknown are rejected; choice is frozen in the plan and report', () => run(stub(), async (ctx, store) => {
  const p = await setup(ctx, store);
  assert.equal((await approve(ctx, p, { persona_combination: 'verified_faculty_research_focus' })).status, 422, 'faculty persona cannot be activated');
  assert.equal((await approve(ctx, p, { persona_combination: 'nope' })).status, 422);
  assert.equal((await approve(ctx, p, { persona_ids: ['reasoning_examiner', 'faculty_research_lens'] })).status, 422);
  const a = await approve(ctx, p); // 기본 조합
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual(a.data.personas.names, ['서류 검증', '전공 탐구']);
  assert.equal(a.data.personas.per_stage.experience, 'document_verifier');
  assert.equal(a.data.personas.per_stage.academic, 'major_explorer');
  const design = ctx.calls.filter(isDesign);
  assert.ok(design.length >= 1 && design.every((c) => JSON.stringify(c.body).includes('서류 검증형') && JSON.stringify(c.body).includes('공통 금지')), 'design prompt carries the persona block and the global guardrails');
  assert.ok(design.every((c) => !JSON.stringify(c.body).includes('교수 연구분야 특화형')), 'faculty persona is not injected');
  const s = await startGeneral(ctx, p);
  for (let i = 0; i < 5; i++) await s.cmd('turn.text', { text: GOOD });
  const turns = ctx.calls.filter(isTurn).map((c) => JSON.stringify(c.body));
  assert.ok(turns.some((t) => t.includes('서류 검증형')), 'experience/reflection turns use the document verifier lens');
  assert.ok(turns.some((t) => t.includes('전공 탐구형')), 'intro/academic turns use the major explorer lens');
  assert.ok(turns.every((t) => t.includes('원문을 반복하거나 요약하지 않는다')), 'blind guardrail is in every turn prompt');
  const rep = (await ctx.g(`/api/v1/sessions/${s.id}/report`)).data;
  assert.deepEqual(rep.personas.names, ['서류 검증', '전공 탐구']);
  assert.match(rep.personas.notice, /실제 대학/);
}));

test('blind gate: sensitive answers (name, high school, family job, loose spelling) stop before any provider call and are never stored; clean answers pass; response never echoes the phrase', () => run(stub(), async (ctx, store) => {
  const p = await setup(ctx, store);
  await approve(ctx, p);
  const s = await startGeneral(ctx, p);
  const before = ctx.calls.length;
  const risky = ['제 이름은 김민수입니다. 실험을 했습니다.', '한빛고등학교에서 동아리를 했습니다.', '어머니가 의사라서 관심이 생겼습니다.', '저는 과 학 고 에서 실험했습니다.', '제 수험번호는 12345678입니다.'];
  for (const text of risky) {
    const r = await s.cmd('turn.text', { text });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    assert.equal(r.data.action, 'blind_blocked', text);
    assert.equal(r.data.ai_sent, false);
    assert.ok(r.data.categories.length >= 1 && /AI로 전송되지 않았습니다/.test(r.data.message));
    assert.ok(!/김민수|한빛|의사|과 학 고|12345678/.test(JSON.stringify(r.data)), 'no echo');
  }
  assert.equal(ctx.calls.length, before, 'blocked answers made zero provider calls');
  const ok = await s.cmd('turn.text', { text: GOOD });
  assert.notEqual(ok.data.action, 'blind_blocked');
  // 같은 단어라도 일상 표현은 막지 않는다(오탐 방지): 모형·유형·대표적·예고편
  for (const text of ['유형별 모형을 만들어 대표적인 오차를 비교했고 예고편처럼 결과를 미리 확인했습니다.', '저희 팀의 형태 분석 결과 사업 계획서의 구조가 달랐습니다.']) {
    const r = await s.cmd('turn.text', { text });
    assert.notEqual(r.data.action, 'blind_blocked', text);
  }
}));

test('blind gate: events keep only codes/labels (no raw text); report summarises counts; application text is masked before analysis and returns the masked kinds only', () => run(stub(), async (ctx, store) => {
  const p = await setup(ctx, store, { application_text: '아버지가 대학 교수이고 저는 과학고에서 효소 실험을 직접 설계해 활성을 비교했습니다. 그 결과 온도에 따라 활성이 달라졌습니다.' });
  assert.ok(p.privacy.masked.some((m) => m.label === '가족의 직업·직장') && p.privacy.masked.some((m) => m.label === '학교 유형'), JSON.stringify(p.privacy));
  assert.ok(!JSON.stringify(p.privacy).includes('교수'), 'only kinds, no raw phrase');
  const claims = (await ctx.g(`/api/v1/profiles/${p.id}/claims`)).data.claims;
  assert.ok(claims.length && claims.every((c) => !/교수|과학고/.test(c.quote)), 'claim quotes come from the masked text');
  await approve(ctx, p);
  const s = await startGeneral(ctx, p);
  await s.cmd('turn.text', { text: '저희 아버지가 변호사입니다.' });
  for (let i = 0; i < 6; i++) await s.cmd('turn.text', { text: GOOD });
  const rep = (await ctx.g(`/api/v1/sessions/${s.id}/report`)).data;
  assert.equal(rep.blind_safety.blocked_count, 1);
  assert.deepEqual(rep.blind_safety.events[0].labels, ['가족의 직업·직장']);
  assert.ok(!/변호사/.test(JSON.stringify(rep.blind_safety)));
  const ev = store.getSession('u-a', s.id) || null; void ev;
}));

test('6-axis radar: six axes, unobserved axes sit at the lowest level 1 with observed:false and a reason (never 0, never withheld), no total or ranking, doc consistency is not auto-judged', () => run(stub(), async (ctx, store) => {
  const p = await setup(ctx, store);
  await approve(ctx, p);
  const s = await startGeneral(ctx, p);
  for (let i = 0; i < 7; i++) await s.cmd('turn.text', { text: GOOD });
  const rep = (await ctx.g(`/api/v1/sessions/${s.id}/report`)).data;
  assert.equal(rep.status, 'ready');
  const ax = rep.axes;
  assert.deepEqual(ax.axes.map((a) => a.id), ['reflection_growth', 'talent_link', 'major_inquiry', 'activity_specificity', 'doc_consistency', 'attitude']);
  for (const a of ax.axes) {
    assert.ok(Number.isFinite(a.level) && a.level >= 1 && a.level <= 4, `${a.id} level ${a.level} (never null, never 0)`);
    assert.ok(['sufficient', 'partial', 'not_observed'].includes(a.evidence));
    if (!a.observed) assert.ok(a.level === 1 && a.n === 0 && a.reason && a.evidence === 'not_observed' && a.quote === null, 'unobserved axes are level 1, carry no fabricated quote, and explain why');
    if (a.observed) assert.ok(a.n >= 1 && a.evidence !== 'not_observed');
    assert.ok(a.basis);
  }
  const by = Object.fromEntries(ax.axes.map((a) => [a.id, a]));
  assert.ok(by.reflection_growth.basis.includes('문제 해결·성찰 단계'), 'reflection growth is the reflection-stage rule score average');
  assert.equal(by.talent_link.label, '인재상 적합성');
  assert.ok(by.attitude.basis.includes('발화') || by.attitude.basis.includes('음성 지표가 없어'), 'attitude basis reflects the extended voice cues');
  assert.ok(by.doc_consistency.pairs.length >= 1 && by.doc_consistency.pairs.every((x) => x.claim && x.answer), 'doc/answer pairs are always shown side by side');
  assert.ok(by.major_inquiry.observed && by.activity_specificity.observed && by.attitude.observed);
  assert.ok(!('withheld' in ax.summary));
  assert.ok(!ax.summary.strengths.some((l) => ax.axes.find((a) => a.label === l && !a.observed)), 'an unobserved axis is never a strength');
  assert.ok(!('total' in ax) && !('rank' in ax) && !('score' in ax) && !/합격/.test(JSON.stringify(ax)));
  assert.match(ax.label, /검증 전/);
}));

test('live AI failure never invents a follow-up: the interview moves to the next approved question; demo (AI off) keeps the rule follow-up', async () => {
  const short = '네 그냥 해 봤습니다.'; // 규칙 휴리스틱은 학업 단계에서 꼬리질문을 요구하는 답변
  await run(stub({ turn: () => statusReply(500) }), async (ctx, store) => {
    const p = await setup(ctx, store);
    await approve(ctx, p);
    const s = await startGeneral(ctx, p);
    await s.cmd('turn.text', { text: GOOD }); // intro
    const r = await s.cmd('turn.text', { text: short }); // academic
    assert.equal(r.data.action, 'next_question', 'no fabricated follow-up when the live call failed');
    assert.ok(ctx.calls.filter(isTurn).length >= 2, 'the live call was attempted');
  });
  await run(stub(), async (ctx, store) => {
    const p = await setup(ctx, store);
    await approve(ctx, p);
    const s = await startGeneral(ctx, p);
    await s.cmd('turn.text', { text: GOOD });
    const r = await s.cmd('turn.text', { text: short });
    assert.equal(r.data.action, 'ask_followup', 'AI off (demo): the labelled rule follow-up is still used');
    assert.equal(ctx.calls.length, 0, 'no outbound calls while the gate is closed');
  }, { GEMINI_LIVE_ACK: '' });
});

test('issue report: type is validated, comment is masked before saving, never used for training, status readable', () => run(stub(), async (ctx) => {
  assert.equal((await ctx.g('/api/v1/issue-reports', { method: 'POST', body: { type: 'weird', comment: 'x' } })).status, 422);
  const r = await ctx.g('/api/v1/issue-reports', { method: 'POST', body: { type: 'privacy', comment: '제 이름은 김민수이고 아버지가 의사입니다. 질문이 이상했어요.' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(!/김민수|의사/.test(r.data.comment_preview) && r.data.comment_preview.includes('질문이 이상했어요'));
  const got = await ctx.g(`/api/v1/appeals/${r.data.appeal_id}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.used_for_training, false);
  assert.equal(got.data.type, 'privacy');
}));
