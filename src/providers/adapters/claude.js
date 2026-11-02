// Claude 어댑터(WP-B3 claims.extract + 2026-10-31 school.analyze·questions.design·evaluation.generate). fetch만 사용한다. 모델 ID·URL·키는 모두 설정에서 받는다(하드코딩 없음).
// 요청/응답 형태(경로 /messages, 헤더 x-api-key, content[].text, usage.input_tokens)는 어댑터 내부 가정이며 [UNVERIFIED] — 실호출 전 공식 문서로 확인한다.
import { buildClaimsPrompt } from '../prompts/claims.js';
import { buildSchoolPrompt } from '../prompts/school.js';
import { buildStageMessages, buildTurnMessages } from '../prompts/interview.js';
import { buildEvaluationMessages, buildObserveMessages, buildGradeMessages } from '../prompts/evaluation.js';
import { buildCommentMessages } from '../prompts/comment.js';
import { buildAnswerReviewMessages } from '../prompts/review.js';
import { buildSkeletonMessages, buildWriteMessages } from '../prompts/skeleton.js';

export function createClaudeAdapter({ apiKey, baseUrl, model, writerModel = '', timeoutMs = 20000, apiVersion = '', thinking = 'off', fetchFn = (...a) => globalThis.fetch(...a) }) {
  async function post(body) {
    // 생각 끔: Haiku는 disabled, Sonnet 5.5는 disabled가 400이라 between_tools(도구를 쓰지 않으니 사실상 끔). 켜면(thinking='on') 지정하지 않는다.
    if (thinking === 'off') body = { ...body, thinking: { type: /haiku/i.test(String(body.model)) ? 'disabled' : 'between_tools' } };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey }; // [UNVERIFIED]
    if (apiVersion) headers['anthropic-version'] = apiVersion; // [UNVERIFIED] 값은 CLAUDE_API_VERSION으로만 지정
    let res;
    try {
      res = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      const timeout = e?.name === 'AbortError';
      throw Object.assign(new Error(timeout ? 'claude timeout' : 'claude network error'), { code: timeout ? 504 : 502, timeout, retryable: true });
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      const ra = Number(res.headers?.get?.('retry-after'));
      throw Object.assign(new Error(`claude http ${res.status}`), { code: res.status, retryable: res.status === 429 || res.status >= 500, retryAfter: Number.isFinite(ra) ? ra : undefined });
    }
    return res.json().catch(() => { throw Object.assign(new Error('claude bad body'), { code: 502, invalid: true }); });
  }

  // 프롬프트(system/user) → JSON 객체. Claude는 JSON 모드가 없어 프롬프트가 JSON 한 개만 요구하고, 파싱·형태 검사는 여기서, 내용 검증은 서버 도메인이 한다.
  async function json({ system, user }, maxTokens, ok, useModel = model) {
    const j = await post({ model: useModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
    const text = Array.isArray(j?.content) ? j.content.map((c) => c?.text || '').join('') : '';
    let parsed;
    try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw Object.assign(new Error('claude bad json'), { code: 502, invalid: true }); }
    if (!ok(parsed)) throw Object.assign(new Error('claude bad schema'), { code: 502, invalid: true });
    return { parsed, usage: { input: j?.usage?.input_tokens || 0, output: j?.usage?.output_tokens || 0 } };
  }
  const items = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x.quote === 'string').map((x) => ({ label: String(x.label || ''), quote: x.quote })) : []);

  return {
    model,
    // 학교 자료 → 인재상·역량·전형 요소·면접 형식(원문 인용). 가벼운 추출 작업이라 Haiku(CLAUDE_WRITER_MODEL)가 맡고, 없으면 기본 모델. 인용 검증은 서버(school-analysis.js)가 한다.
    async analyzeSchool({ sourceText }) {
      const m = writerModel || model;
      const { parsed: j, usage } = await json(buildSchoolPrompt(sourceText), 3000, (p) => p && typeof p === 'object', m);
      return { talent_traits: items(j.talent_traits), admission_elements: items(j.admission_elements), interview_format: items(j.interview_format), unconfirmed: Array.isArray(j.unconfirmed) ? j.unconfirmed.filter((x) => typeof x === 'string') : [], model: m, usage };
    },
    // 일반 면접 5단계 본질문·근거 id·연결 문장. 단계별 검증은 서버(interview-format.js)가 한다.
    async designStages(input) {
      const { parsed, usage } = await json(buildStageMessages(input), 1500, (p) => Array.isArray(p?.stages));
      return { stages: parsed.stages.slice(0, 8), model, usage };
    },
    // 질문 구조(단계별 근거·초점·방식)만 설계한다. 문장은 쓰지 않는다(Sonnet).
    async designSkeleton(input) {
      const { parsed, usage } = await json(buildSkeletonMessages(input), 1200, (p) => Array.isArray(p?.stages));
      return { stages: parsed.stages.slice(0, 8), model, usage };
    },
    // 구조와 근거 원문으로 질문·연결 문장을 쓴다(Haiku, CLAUDE_WRITER_MODEL). 설정이 없으면 호출하지 않는다.
    async writeQuestions(input) {
      if (!writerModel) throw Object.assign(new Error('claude writer model not configured'), { code: 501, invalid: true });
      const { parsed, usage } = await json(buildWriteMessages(input), 3000, // 한국어 5단계 질문·연결 문장은 1500토큰을 넘겨 잘린다(실측)
         (p) => Array.isArray(p?.stages), writerModel);
      return { stages: parsed.stages.slice(0, 8), model: writerModel, usage };
    },
    // 답변 하나에 대한 꼬리질문 여부·문장·참고 점수(Haiku). 인용·길이·금칙어 검증은 서버가 한다.
    async decideTurn(input) {
      const m = writerModel || model;
      const { parsed, usage } = await json(buildTurnMessages(input), 500, (p) => ['next', 'followup'].includes(p?.action), m);
      return { ...parsed, model: m, usage };
    },
    // 최종 평가 초안: 인용 위치 재계산·검증은 서버(llm-eval.js)가 한다.
    // 분업(2026-11-01): Sonnet은 관찰문·인용 후보만 남긴다(level 없음). 채점은 Gemini가 맡는다.
    async observeAnswers({ turns, rubric }) {
      const { parsed, usage } = await json(buildObserveMessages({ turns, rubric }), 2500, (p) => Array.isArray(p?.dimensions));
      return { parsed, model, usage };
    },
    // 관찰 → 채점 분업의 채점 단계(같은 모델이 맡는다)와 질문별 한줄평·보고서 한줄평.
    async gradeObservations({ observations, rubric }) {
      const { parsed, usage } = await json(buildGradeMessages({ observations, rubric }), 2500, (p) => Array.isArray(p?.dimensions));
      return { parsed, model, usage };
    },
    async reviewAnswers(input) {
      const { parsed, usage } = await json(buildAnswerReviewMessages(input), 2000, (p) => Array.isArray(p?.turns));
      return { turns: parsed.turns, model, usage };
    },
    async writeComments(input) {
      const { parsed, usage } = await json(buildCommentMessages(input), 400, (p) => typeof p?.fit_comment === 'string' && typeof p?.dimension_comment === 'string');
      return { fit_comment: parsed.fit_comment, dimension_comment: parsed.dimension_comment, model, usage };
    },
    async evaluateAnswers({ turns, rubric }) {
      const { parsed, usage } = await json(buildEvaluationMessages({ turns, rubric }), 2500, (p) => Array.isArray(p?.dimensions));
      return { parsed, model, usage };
    },
    // maskedApplication: 서버가 마스킹한 지원서 텍스트만 들어온다. 반환: {quotes:[string], model, usage}
    async extractApplicantClaims({ maskedApplication }) {
      const { system, user } = buildClaimsPrompt(maskedApplication);
      const j = await post({ model, max_tokens: 1500, system, messages: [{ role: 'user', content: user }] });
      const text = Array.isArray(j?.content) ? j.content.map((c) => c?.text || '').join('') : '';
      let parsed;
      try { parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw Object.assign(new Error('claude bad json'), { code: 502, invalid: true }); }
      if (!Array.isArray(parsed?.claims)) throw Object.assign(new Error('claude bad schema'), { code: 502, invalid: true });
      const quotes = parsed.claims.map((c) => (typeof c === 'string' ? c : c?.quote)).filter((q) => typeof q === 'string');
      return { quotes, model, usage: { input: j?.usage?.input_tokens || 0, output: j?.usage?.output_tokens || 0 } };
    },
  };
}
