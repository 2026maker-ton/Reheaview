// 동작 불변 추출(WP-A1): src/server.js에서 옮긴 핸들러. 반환은 { status, body } 또는 { error, status }.
import { randomUUID, sha256Hex } from '../crypto.js';
import { detectPii, buildBlindContext } from '../../domain/pii.js';
import { detectBlindRisk, maskRisk, answerComment, validateAnswerReview } from '../../domain/answer-review.js';
import { linkAnswersToInstitution } from '../../domain/institution.js';
import { followupForRole, ROLES } from '../../domain/roles.js';
import { canSessionTransition } from '../../domain/state.js';
import { FOLLOWUPS, followupReasonFor } from '../../domain/questions.js';
import { buildMockEvaluation } from '../../domain/mock-eval.js';
import { validateEvaluation } from '../../domain/evaluation.js';
import { rubricForInterviewType, getRubric } from '../../domain/rubrics.js';
import { buildTypedEvaluation } from '../../domain/mock-eval-typed.js';
import { validateEvaluationGeneric } from '../../domain/evaluation-generic.js';
import { nextAiUtterance, moderatorLine, recordDiscussionTurn } from '../../domain/discussion.js';
import { validateDialogueOutput, validateFollowupOutput } from '../../providers/validate.js';
import { buildLlmEvaluation } from '../../domain/llm-eval.js';
import { checkFeedbackSafety } from '../../domain/evaluation.js';
import { SPOKEN, ackOnly, answerState, pickAck, ruleFollowup, ruleTurnScore, validTurnScore, competencyFit } from '../../domain/interview-format.js';
import { blindGate, blindEvent, blindMessage, FILTER_VERSION } from '../../domain/blind-gate.js';
import { buildAxes } from '../../domain/axes.js';
import { ruleComments, validComments } from '../../domain/report-comment.js';
import { COMMENT_PROMPT_VERSION } from '../../providers/prompts/comment.js';
import { personaBlock, personaOutputOk, personaName } from '../../domain/personas.js';

export function createCommandHandlers(d) {
  const { config, store, err, now, caller, mock, requestContext, checkRate, publicSession } = d;
  // 세션 provider_trace: 실제 호출 결과만 쌓는다(최근 100건). 본문·키는 담기지 않는다.
  const pushTrace = (s, t) => { (s.provider_trace ||= []).push(t); if (s.provider_trace.length > 100) s.provider_trace.shift(); };
  // 유형·단계별 평가 차원 매핑: 보고서의 근거 차원은 발화 시점의 단계로 고정한다.
  const discussionTurnDims = (phase, userTurnNo) => {
    if (userTurnNo <= 1) return ['claim_understanding', 'evidence_use'];
    if (userTurnNo === 2) return ['rebuttal', 'claim_understanding', 'evidence_use'];
    if (userTurnNo === 3) return ['rebuttal', 'collaboration', 'evidence_use'];
    return ['collaboration', 'claim_understanding', 'evidence_use'];
  };
  const situationalTurnDims = (idx, followupCount) => {
    if (idx === 0) return ['role_understanding', 'responsiveness', 'reasoning'];
    if (idx === 1) return ['responsiveness', 'reasoning', 'role_understanding'];
    if (idx <= followupCount) return ['role_understanding', 'reasoning', 'reflection'];
    return ['reflection', 'responsiveness', 'reasoning'];
  };

  async function runCommand(owner, sessionId, body, requestId) {
    const s = store.getSession(owner, sessionId);
    if (!s) return err('not_found', '세션을 찾을 수 없습니다.', 404);
    if (s.state === 'deleting' || s.state === 'deleted') return err('not_found', '세션을 찾을 수 없습니다.', 404);
    const commandId = body.command_id;
    if (!commandId) return err('validation_error', 'command_id가 필요합니다.', 422);
    const key = `${sessionId}:${commandId}`;
    const hash = await sha256Hex(JSON.stringify(body.payload || {}));
    const prior = store.commands.get(key);
    if (prior) {
      if (prior.request_hash !== hash) return err('conflict', '동일 command_id에 다른 본문이 사용되었습니다.', 409);
      return { status: 202, body: prior.response };
    }
    const expected = body.expected_version;
    if (expected !== undefined && expected !== s.version) return err('conflict', '예상 버전이 일치하지 않습니다.', 409, { details: { current_version: s.version } });
    const type = body.type;
    const payload = body.payload || {};
    const accept = (response) => {
      store.commands.set(key, { request_hash: hash, response });
      return { status: 202, body: response };
    };
    if (type === 'session.finish' && s.state === 'completed') {
      const reportStatus = store.evaluations.get(s.id)?.status;
      if (payload.retry_report === true && reportStatus !== 'ready') {
        const limited = checkRate(owner, 'turns');
        if (limited) return limited;
        return finishSessionAsync(owner, s, accept, commandId, true);
      }
      return accept({ command_id: commandId, state: 'completed', version: s.version, report_status: reportStatus || 'pending' });
    }
    if (s.finish_requested && type !== 'session.finish') return err('conflict', '면접 종료를 처리하고 있습니다.', 409);

    if (type === 'session.start') {
      if (s.state === 'paused') return err('conflict', '일시정지 상태에서는 재개를 사용하세요.', 409);
      if (s.state !== 'ready') return err('conflict', '시작할 수 없는 상태입니다.', 409);
      if (!canSessionTransition(s.state, 'active')) return err('conflict', '전이 불가', 409);
      store.updateSession(s, { state: 'active', started_at: now() });
      store.pushEvent(s.id, 'session.snapshot', { state: 'active' });
      // 유형별 시작 멘트: 토론은 사회자 오프닝 + A 입론, PT는 과제 브리핑
      const it = s.interview_type || s.mode || 'general';
      let openings = [];
      if (it === 'discussion' && s.discussion) {
        const open = moderatorLine(s.discussion, 'open');
        recordDiscussionTurn(s.discussion, { speaker_id: 'moderator', claim_id: 'c-open', text: open });
        const aiA = nextAiUtterance(s.discussion, 'ai-a', '');
        recordDiscussionTurn(s.discussion, { speaker_id: aiA.speaker_id, claim_id: aiA.claim_id, text: aiA.text });
        store.pushEvent(s.id, 'assistant.message', { utterance: open, speaker_id: 'moderator', discussion_phase: s.discussion.phase });
        store.pushEvent(s.id, 'assistant.message', { utterance: aiA.text, speaker_id: aiA.speaker_id, speaker_name: aiA.speaker_name, claim_id: aiA.claim_id, discussion_phase: s.discussion.phase });
        openings = [{ speaker_id: 'moderator', utterance: open }, { speaker_id: aiA.speaker_id, speaker_name: aiA.speaker_name, utterance: aiA.text, claim_id: aiA.claim_id }];
        store.updateSession(s, {});
      } else if (it === 'pt') {
        store.updateSession(s, { pt_phase: 'brief' });
        store.pushEvent(s.id, 'assistant.message', { utterance: s.pt_brief, speaker_id: 'moderator', pt_phase: 'brief' });
      } else if (it === 'situational') {
        store.updateSession(s, { scenario_index: 0 });
        store.pushEvent(s.id, 'assistant.message', { utterance: s.questions[0]?.text || '', speaker_id: 'interviewer', scenario_id: s.scenario_id });
      } else if (it === 'panel' && Array.isArray(s.panel_roles) && s.panel_roles.length) {
        store.pushEvent(s.id, 'assistant.message', { utterance: `패널 면접을 시작합니다. ${s.panel_roles.map((r) => ROLES[r]?.label || r).join(' · ')} 면접관이 돌아가며 질문합니다.`, speaker_id: 'moderator' });
      }
      if (s.format === 'general') {
        // 일반 면접: 인사 + 첫 질문. 질문을 보낸 시각부터 답변 제한시간을 잰다.
        store.updateSession(s, { question_started_at: now(), awaiting_followup: false });
        store.pushEvent(s.id, 'assistant.message', { utterance: `${SPOKEN.opening} ${s.questions[0].text}`, action: 'opening', stage: s.questions[0].stage });
        return accept({ command_id: commandId, state: 'active', version: s.version, opening: SPOKEN.opening, question: roomQuestion(s.questions[0]), question_total: s.questions.length, answer_seconds: s.answer_seconds });
      }
      const base0 = { command_id: commandId, state: 'active', version: s.version, question: s.questions[s.q_index], question_total: s.questions.length, last_seq: (store.events.get(s.id) || []).length };
      if (openings.length) base0.openings = openings;
      if (it === 'discussion') base0.discussion = publicSession(s).discussion;
      if (it === 'pt') { base0.pt_phase = s.pt_phase; base0.pt_task = publicSession(s).pt_task; }
      if (it === 'situational') base0.scenario = publicSession(s).scenario;
      if (it === 'panel') base0.panel_roles = publicSession(s).panel_roles;
      return accept(base0);
    }
    if (type === 'pt.prepare') {
      if (s.interview_type !== 'pt') return err('validation_error', 'PT 세션에서만 사용할 수 있습니다.', 422);
      if (s.state !== 'active') return err('conflict', '진행 중인 세션에서만 단계를 바꿀 수 있습니다.', 409);
      const to = String(payload.phase || '');
      if (!['brief', 'prepare', 'present', 'qa'].includes(to)) return err('validation_error', '단계 값이 올바르지 않습니다.', 422);
      // 건너뛰기 금지: brief → prepare → present → qa 순서만 허용
      const order = ['brief', 'prepare', 'present', 'qa'];
      const from = order.indexOf(s.pt_phase || 'brief');
      const target = order.indexOf(to);
      if (target < from || target > from + 1) return err('conflict', 'PT 단계는 순서대로만 진행할 수 있습니다.', 409, { details: { current: s.pt_phase, requested: to } });
      store.updateSession(s, { pt_phase: to });
      let utterance = null;
      if (to === 'prepare') utterance = `준비 시간 ${Math.round((s.pt_prepare_seconds || 180) / 60)}분입니다. 과제를 읽고 발표 구조를 정리하세요. 준비가 끝나면 “발표 시작”을 누르세요.`;
      if (to === 'present') utterance = `발표 시간 ${Math.round((s.pt_present_seconds || 180) / 60)}분입니다. 결론 → 근거 → 실행계획 순서로 발표해 보세요.`;
      if (to === 'qa') utterance = s.pt_qa?.[0] || '질의응답을 시작합니다.';
      if (utterance) store.pushEvent(s.id, 'assistant.message', { utterance, speaker_id: 'interviewer', pt_phase: to });
      return accept({ command_id: commandId, state: s.state, version: s.version, pt_phase: to, pt_qa_index: s.pt_qa_index || 0, utterance });
    }
    if (type === 'session.pause') {
      if (s.state !== 'active') return err('conflict', '진행 중인 세션만 일시정지할 수 있습니다.', 409);
      store.updateSession(s, { state: 'paused', active_elapsed_ms: s.active_elapsed_ms + (s.started_at ? Math.max(0, Date.now() - Date.parse(s.started_at)) : 0) });
      store.pushEvent(s.id, 'session.paused', {});
      return accept({ command_id: commandId, state: 'paused', version: s.version });
    }
    if (type === 'session.resume') {
      if (s.state !== 'paused') return err('conflict', '일시정지 상태가 아닙니다.', 409);
      store.updateSession(s, { state: 'active', started_at: now() });
      store.pushEvent(s.id, 'session.snapshot', { state: 'active' });
      return accept({ command_id: commandId, state: 'active', version: s.version });
    }
    if (type === 'turn.text' || type === 'turn.commit') {
      if (s.state !== 'active') return err('conflict', '진행 중인 세션에서만 답변할 수 있습니다.', 409);
      const limited = checkRate(owner, 'turns');
      if (limited) return limited;
      // 서버 시계 기준 시간 상한(클라이언트 타이머 조작과 무관)
      const elapsedMs = s.active_elapsed_ms + (s.started_at ? Math.max(0, Date.now() - Date.parse(s.started_at)) : 0);
      if (elapsedMs >= s.duration_seconds * 1000) return finishSession(owner, s, accept, commandId);
      let text = String(payload.text || '').trim();
      if (!text) return err('validation_error', '답변이 비어 있습니다.', 422);
      if ([...text].length > config.limits.maxAnswerChars) return err('validation_error', '답변은 4,000자 이하여야 합니다.', 422);
      // 블라인드 사전 차단(설계서 §4.3): 일반 면접 답변은 AI로 가기 전에 프로그램이 먼저 검사한다. 걸리면 답변을 저장·전송하지 않고 같은 질문으로 다시 답하게 한다.
      // 이벤트에는 원문 없이 분류·수준·조치만 남긴다. 필터가 실패해도(level 'error') 통과시키지 않는다(fail-closed).
      if (s.format === 'general') {
        const gate = blindGate(text);
        if (gate.blocked) {
          const ev = blindEvent({ gate, question_id: s.awaiting_followup ? `${s.questions[s.q_index]?.id}:followup` : s.questions[s.q_index]?.id, action: 'rejected_reanswer' });
          const events = [...(s.blind_events || []), ev].slice(-50);
          store.updateSession(s, { blind_events: events, blind_paused: true, question_started_at: now() });
          store.pushEvent(s.id, 'blind.detected', { level: gate.level, codes: ev.codes });
          return accept({ command_id: commandId, state: s.state, version: s.version, action: 'blind_blocked', level: gate.level, categories: gate.categories.map(({ id, label }) => ({ id, label })), message: blindMessage(gate), violations: events.filter((e) => e.level === 'high').length, ai_sent: false });
        }
        if (s.blind_paused) store.updateSession(s, { blind_paused: false });
      }
      // 블라인드 모드: 저장·평가에 쓰이는 텍스트에서 학교·성별·출신 단서를 마스킹한다.
      // (완전 익명화 보장은 아니며, 원문은 저장하지 않는다.)
      if (s.blind) text = buildBlindContext(text);
      const answered = store.sessionTurns(s.id).filter((t) => t.speaker_id === 'user').length;
      if (answered >= config.limits.maxUserTurns) return finishSession(owner, s, accept, commandId);
      const it = s.interview_type || s.mode || 'general';
      if (s.format === 'general') return generalTurn(owner, s, text, payload, commandId, accept);
      // 토론 턴: 사용자 발언 → 상태 기록 → 다음 화자 1명 발언을 함께 반환.
      // 4번째 사용자 발언이 끝나면 사회자가 정리하고 자동 종료한다(발언 기회 4회 보장).
      if (it === 'discussion') {
        const q = s.questions[Math.min(s.q_index, s.questions.length - 1)];
        const phaseBefore = s.discussion?.phase || 'opening';
        const dims = discussionTurnDims(phaseBefore, (s.discussion?.user_turns || 0) + 1);
        const turn = store.createTurn(s.id, { speaker_id: 'user', question_id: q.id, competency: q.primary, followup: false, elicited_dims: dims });
        const rev = store.addRevision(turn.id, text, 'user', detectPii(text).map((x) => x.type));
        recordDiscussionTurn(s.discussion, { speaker_id: 'user', claim_id: `c-u-${s.discussion.total_turns + 1}`, text });
        store.pushEvent(s.id, 'assistant.message', { utterance: text, speaker_id: 'user', discussion_phase: s.discussion.phase });
        const utterances = [];
        // 다음 발언: 사용자 → (AI 1명) → 사용자. 사회자는 단계 안내만 한다.
        if (s.discussion.next_speaker === 'user') {
          const line = moderatorLine(s.discussion, s.discussion.phase === 'agreement' ? 'agreement' : 'to_user');
          utterances.push({ speaker_id: 'moderator', utterance: line });
          store.pushEvent(s.id, 'assistant.message', { utterance: line, speaker_id: 'moderator', discussion_phase: s.discussion.phase });
          store.updateSession(s, {});
          return accept({ command_id: commandId, state: s.state, version: s.version, action: 'await_user', utterance: line, utterances, turn_id: turn.id, revision: rev.revision, discussion: publicSession(s).discussion, followups_used: s.followups_used, llm_calls: s.llm_calls });
        }
        if (s.discussion.next_speaker === 'moderator') {
          const closing = moderatorLine(s.discussion, 'closing');
          utterances.push({ speaker_id: 'moderator', utterance: closing });
          store.pushEvent(s.id, 'assistant.message', { utterance: closing, speaker_id: 'moderator', discussion_phase: 'closing' });
          s.q_index = s.questions.length - 1;
          store.updateSession(s, {});
          // 종료 응답은 사회자 마무리 멘트와 토론 상태를 함께 돌려준다(기록도 같은 본문).
          let captured = null;
          const fin = await finishSession(owner, s, (resp) => {
            captured = {
              ...resp, action: 'discussion_complete', utterance: closing, utterances,
              turn_id: turn.id, revision: rev.revision, discussion: publicSession(s).discussion,
            };
            accept(captured);
          }, commandId);
          if (fin.error) return fin;
          return { status: fin.status, body: captured || fin.body };
        }
        const ai = nextAiUtterance(s.discussion, s.discussion.next_speaker, text);
        recordDiscussionTurn(s.discussion, { speaker_id: ai.speaker_id, claim_id: ai.claim_id, text: ai.text });
        store.pushEvent(s.id, 'assistant.message', { utterance: ai.text, speaker_id: ai.speaker_id, speaker_name: ai.speaker_name, claim_id: ai.claim_id, responds_to: ai.responds_to, discussion_phase: s.discussion.phase });
        utterances.push({ speaker_id: ai.speaker_id, speaker_name: ai.speaker_name, utterance: ai.text, claim_id: ai.claim_id });
        // AI 발언 뒤에는 항상 사용자 차례 → 사회자 안내를 덧붙인다
        if (s.discussion.next_speaker === 'user') {
          const line = moderatorLine(s.discussion, s.discussion.phase === 'agreement' ? 'agreement' : 'to_user');
          utterances.push({ speaker_id: 'moderator', utterance: line });
          store.pushEvent(s.id, 'assistant.message', { utterance: line, speaker_id: 'moderator', discussion_phase: s.discussion.phase });
        }
        // 질문 슬롯을 사용자 발언 수에 맞춰 전진 (보고서 elicited 보조 매핑)
        s.q_index = Math.min(s.discussion.user_turns, s.questions.length - 1);
        store.updateSession(s, {});
        return accept({ command_id: commandId, state: s.state, version: s.version, action: 'ai_speaks', utterance: ai.text, utterances, turn_id: turn.id, revision: rev.revision, discussion: publicSession(s).discussion, followups_used: s.followups_used, llm_calls: s.llm_calls });
      }
      // PT 턴: 발표 단계와 Q&A 단계의 답변만 평가 대상으로 기록한다.
      if (it === 'pt') {
        let phase = s.pt_phase || 'brief';
        // 준비 단계에서 바로 발표를 시작해도 막히지 않게 첫 발표 발언으로 기록한다.
        if (phase === 'brief' || phase === 'prepare') {
          store.updateSession(s, { pt_phase: 'present' });
          phase = 'present';
        }
        const inQa = phase === 'qa';
        const qid = inQa ? 'pt-qa' : 'pt-present';
        const q = s.questions.find((x) => x.id === qid) || s.questions[0];
        const dims = inQa ? ['qa_response', 'evidence_use'] : ['structure', 'evidence_use', 'execution_plan'];
        const turn = store.createTurn(s.id, { speaker_id: 'user', question_id: q.id, competency: q.primary, followup: inQa, elicited_dims: dims });
        const rev = store.addRevision(turn.id, text, 'user', detectPii(text).map((x) => x.type));
        store.pushEvent(s.id, 'assistant.message', { utterance: text, speaker_id: 'user', pt_phase: phase });
        let utterance = '';
        if (!inQa) {
          const presentCount = store.sessionTurns(s.id).filter((t) => t.speaker_id === 'user' && t.question_id === 'pt-present').length;
          if (presentCount >= 2) {
            store.updateSession(s, { pt_phase: 'qa', pt_qa_index: 0 });
            utterance = s.pt_qa[0] || '질의응답을 시작합니다. 질문에 답해 주세요.';
          } else {
            utterance = '발표를 이어가거나, 준비가 끝났으면 “발표 완료”라고 입력해 주세요. 발표가 끝나면 Q&A가 이어집니다.';
          }
        } else {
          const idx = (s.pt_qa_index || 0) + 1;
          if (idx >= s.pt_qa.length) {
            store.updateSession(s, { pt_qa_index: idx });
            return finishSession(owner, s, accept, commandId);
          }
          store.updateSession(s, { pt_qa_index: idx });
          utterance = s.pt_qa[idx];
        }
        store.pushEvent(s.id, 'assistant.message', { utterance, speaker_id: 'interviewer', pt_phase: s.pt_phase });
        store.updateSession(s, {});
        return accept({ command_id: commandId, state: s.state, version: s.version, action: 'ask_followup', utterance, turn_id: turn.id, revision: rev.revision, pt_phase: s.pt_phase, pt_qa_index: s.pt_qa_index, followups_used: s.followups_used, llm_calls: s.llm_calls });
      }
      // 상황·역할극: 시나리오 오프닝 → 후속 2개 → 성찰 질문 → 종료 (모두 검수된 고정 문장)
      if (it === 'situational') {
        const idx = s.scenario_index || 0; // 0=오프닝 답변, 1..n=후속, n+1=성찰
        const followups = s.scenario_followups || [];
        const inFollowup = idx >= 1;
        const q = s.questions[0];
        const dims = situationalTurnDims(idx, followups.length);
        const turn = store.createTurn(s.id, { speaker_id: 'user', question_id: q.id, competency: dims[0], followup: inFollowup, elicited_dims: dims });
        const rev = store.addRevision(turn.id, text, 'user', detectPii(text).map((x) => x.type));
        store.pushEvent(s.id, 'assistant.message', { utterance: text, speaker_id: 'user', scenario_id: s.scenario_id });
        const nextIdx = idx + 1;
        store.updateSession(s, { scenario_index: nextIdx });
        if (nextIdx <= followups.length) {
          const utterance = followups[nextIdx - 1];
          store.pushEvent(s.id, 'assistant.message', { utterance, speaker_id: 'interviewer', scenario_id: s.scenario_id });
          return accept({ command_id: commandId, state: s.state, version: s.version, action: 'ask_followup', utterance, turn_id: turn.id, revision: rev.revision, scenario_index: nextIdx, followups_used: s.followups_used, llm_calls: s.llm_calls });
        }
        if (nextIdx === followups.length + 1) {
          const utterance = '마지막으로, 이 상황에서 본인이 택한 대응을 다음에 다시 한다면 무엇을 바꾸겠습니까? 그렇게 판단한 기준도 함께 말해 주세요.';
          store.pushEvent(s.id, 'assistant.message', { utterance, speaker_id: 'interviewer', scenario_id: s.scenario_id });
          return accept({ command_id: commandId, state: s.state, version: s.version, action: 'ask_followup', utterance, turn_id: turn.id, revision: rev.revision, scenario_index: nextIdx, followups_used: s.followups_used, llm_calls: s.llm_calls });
        }
        return finishSession(owner, s, accept, commandId);
      }
      const q = s.questions[s.q_index];
      if (!q) return err('conflict', '남은 질문이 없습니다.', 409);
      const followupTurn = !!q._followedUp && s.followups_used > 0;
      const turn = store.createTurn(s.id, { speaker_id: 'user', question_id: q.id, competency: q.primary, followup: followupTurn });
      const rev = store.addRevision(turn.id, text, 'user', detectPii(text).map((x) => x.type));
      // 예산: 대화 호출 1회 예약(보수적 상한)
      if (s.llm_calls >= config.budgets.maxLlmCallsPerSession - 3) {
        // 평가/repair 슬롯 3회 보존
        return finishSession(owner, s, accept, commandId);
      }
      let utterance = q.text;
      let action = 'next_question';
      let followupReason = null;
      let trace = null;
      let liveResult = null;
      // 패널: 현재 질문 담당 역할의 꼬리질문 전략을 사용 (평가는 동일 루브릭)
      const panelRole = (s.interview_type === 'panel') ? (q._panel_role || (s.panel_roles || [])[s.q_index % (s.panel_roles || ['practitioner']).length] || s.interviewer_role) : s.interviewer_role;
      const needFollowup = s.followups_used < config.limits.maxFollowupsTotal && !q._followedUp;
      if (needFollowup) {
        followupReason = followupReasonFor(text);
        action = 'ask_followup';
      }
      // 공급자는 서버 상태(ctx)로만 정한다(요청 본문 무시). 고교 세션은 Mock 강제(미성년자 보호).
      // 합성 판정은 서버가 한다: 이 턴의 답변이 서버 fixture 샘플 답변과 일치할 때만 합성(클라이언트 값 아님).
      // 고입 세션은 Mock 강제를 유지하되, 합성 샘플 답변일 때만 외부 호출을 허용한다(미성년자 실입력은 계속 차단).
      const turnSynthetic = rev.synthetic === true;
      const ctx = requestContext(owner, { forceMock: !!s.highschool_mock && !turnSynthetic, synthetic: turnSynthetic });
      // 최근 대화(최대 4턴)를 문맥으로 전달: 모델이 답변 근거를 활용하도록
      const pastTurns = store.sessionTurns(s.id).slice(-5, -1);
      const history = pastTurns.map((t) => {
        const revs = store.getRevisions(t.id);
        const last = revs[revs.length - 1];
        const qq = s.questions.find((x) => x.id === t.question_id);
        return { question: qq?.text || '', answer: last?.normalized_text || '' };
      }).filter((h) => h.question || h.answer);
      history.push({ question: q.followup || q.text, answer: text });
      // 학교 맥락(09 §5.2): 승인된 학교 분석의 인재상 label 최대 5개. 없으면 빈 배열.
      const sv = s.profile_version_id ? store.getVersion(s.profile_version_id) : null;
      const school_context = (store.getInstitution(sv?.profile_id)?.profile?.school_analysis?.talent_traits || []).map((t) => String(t?.label || '').trim()).filter(Boolean).slice(0, 5);
      const dialogueInput = { persona: s.persona, role: panelRole, followupReason, questionText: q.followup || q.text, recentAnswer: text, interviewType: s.interview_type, history, school_context };
      // 검증 기준 문맥: 모델 출력의 숫자는 이 안에 있어야 한다(새 사실·수치 금지)
      const contextText = `${dialogueInput.questionText}\n${text}\n${history.map((h) => `${h.question}\n${h.answer}`).join('\n')}`;
      const staticFollowup = () => (followupReason ? (followupForRole(panelRole, followupReason, null) || FOLLOWUPS[followupReason] || q.text) : q.text);
      const res = await caller.call('dialogue.next', {
        ctx,
        reserve: { key: `session:${s.id}`, amount: 0.005 },
        invoke: (a) => a.next(dialogueInput),
        mock: () => mock.next(dialogueInput),
        // 429·타임아웃·잘못된 출력 등 장애: 검증된 정적 후속 문장으로 세션을 계속한다(BUG-8). 다른 공급자로 승격하지 않는다.
        fallback: async () => ({ utterance: staticFollowup() }),
        validate: (o, prov) => (prov === 'deepseek' ? validateFollowupOutput(o, contextText, dialogueInput.questionText + ' ' + text) : validateDialogueOutput(o, contextText)),
      });
      trace = res.trace;
      pushTrace(s, trace);
      utterance = res.value.utterance;
      if (trace.mode === 'live') {
        s.degraded_reason = null;
        liveResult = res.value;
        store.pushEvent(s.id, 'provider.used', { provider: trace.provider, model: res.value.model });
      } else if (trace.mode === 'fallback' || (trace.mode === 'blocked' && trace.reason === 'budget_cap')) {
        s.degraded_reason = trace.reason;
        store.pushEvent(s.id, 'budget.warning', { reason: trace.reason, fallback: 'static' });
      }
      s.llm_calls += 1;
      const panel_prefix = (s.interview_type === 'panel' && panelRole) ? `[${(ROLES[panelRole] || {}).label || panelRole}] ` : '';
      if (action === 'ask_followup') {
        s.followups_used += 1;
        q._followedUp = true;
        utterance = panel_prefix + utterance;
        store.pushEvent(s.id, 'assistant.message', { utterance, action: 'ask_followup', target_competency: q.primary, followup_reason: followupReason, speaker_role: panelRole });
      } else {
        s.followups_used = 0;
        s.q_index += 1;
        if (s.q_index >= s.questions.length) {
          return finishSession(owner, s, accept, commandId);
        }
        // 다음 질문은 검수된 팩 문장을 사용(모델이 평가·사실을 만들지 않음)
        utterance = s.questions[s.q_index].text;
        if (s.interview_type === 'panel') {
          const nr = s.questions[s.q_index]._panel_role || (s.panel_roles || [])[s.q_index % (s.panel_roles || ['practitioner']).length];
          utterance = `[${(ROLES[nr] || {}).label || nr}] ${utterance}`;
          store.pushEvent(s.id, 'assistant.message', { utterance, action: 'next_question', target_competency: s.questions[s.q_index].primary, speaker_role: nr });
        } else {
          store.pushEvent(s.id, 'assistant.message', { utterance, action: 'next_question', target_competency: s.questions[s.q_index].primary });
        }
      }
      store.updateSession(s, {});
      const resp = {
        command_id: commandId, state: s.state, version: s.version, action, utterance,
        turn_id: turn.id, revision: rev.revision, current_question: s.questions[s.q_index] || null,
        followups_used: s.followups_used, llm_calls: s.llm_calls,
        provider: trace.mode === 'live' ? trace.provider : 'mock', provider_trace: [trace],
        ...(liveResult?.model ? { model: liveResult.model } : {}),
        ...(s.degraded_reason ? { degraded_reason: s.degraded_reason } : {}),
      };
      if (s.interview_type === 'panel') resp.speaker_role = panelRole;
      return accept(resp);
    }
    if (type === 'session.finish') return finishSession(owner, s, accept, commandId);
    return err('validation_error', '알 수 없는 명령입니다.', 422);
  }

  // ---- 일반 면접 5단계(2026-10-31) ----
  // 면접실에 보낼 질문: 질문 문장과 단계만(근거는 면접 중에 보여 주지 않는다).
  const roomQuestion = (q) => (q ? { id: q.id, text: q.text, stage: q.stage } : null);
  const schoolContextOf = (s) => {
    const sv = s.profile_version_id ? store.getVersion(s.profile_version_id) : null;
    return (sv?.plan?.general?.competencies || []).map((c) => String(c.label || '').trim()).filter(Boolean).slice(0, 5);
  };
  // 음성 지표는 브라우저에서 계산한 숫자만 받는다(오디오 없음). 범위를 벗어나면 버린다.
  const VOICE_KEYS = { speech_seconds: 600, silence_count: 200, longest_silence_seconds: 600, speech_ratio: 1, volume_cv: 10, pitch_jitter: 1 };
  const sanitizeVoice = (v) => {
    if (!v || typeof v !== 'object') return null;
    const out = {};
    for (const [k, max] of Object.entries(VOICE_KEYS)) { const n = Number(v[k]); if (Number.isFinite(n) && n >= 0 && n <= max) out[k] = Math.round(n * 1000) / 1000; }
    const tl = sanitizeTimeline(v.timeline);
    if (tl) out.timeline = tl;
    return Object.keys(out).length ? out : null;
  };
  // 답변 음량 그래프(0~100 정수, 최대 120칸)와 구간(speech·pause, 초). 형식이 어긋나면 통째로 버린다.
  const sanitizeTimeline = (t) => {
    if (!t || typeof t !== 'object' || !Array.isArray(t.envelope) || !Array.isArray(t.segments)) return null;
    const total = Number(t.total_seconds);
    if (!Number.isFinite(total) || total <= 0 || total > 600 || t.envelope.length > 120 || t.segments.length > 80) return null;
    const envelope = t.envelope.map((x) => Math.round(Number(x)));
    if (envelope.some((x) => !Number.isFinite(x) || x < 0 || x > 100)) return null;
    const segments = [];
    for (const g of t.segments) {
      const sv = Number(g?.s); const ev = Number(g?.e);
      if ((g?.k !== 'speech' && g?.k !== 'pause') || !Number.isFinite(sv) || !Number.isFinite(ev) || sv < 0 || ev < sv || ev > total + 0.1) return null;
      segments.push({ k: g.k, s: Math.round(sv * 10) / 10, e: Math.round(ev * 10) / 10 });
    }
    return { total_seconds: Math.round(total * 10) / 10, envelope, segments };
  };

  async function generalTurn(owner, s, text, payload, commandId, accept) {
    const q = s.questions[s.q_index];
    if (!q) return err('conflict', '남은 질문이 없습니다.', 409);
    const followupTurn = !!s.awaiting_followup;
    const askedText = followupTurn ? s.current_followup : q.text;
    const limitMs = (s.answer_seconds + config.budgets.answerGraceSeconds) * 1000;
    const cutOff = payload.cut_off === true || (!!s.question_started_at && Date.now() - Date.parse(s.question_started_at) > limitMs);
    const turn = store.createTurn(s.id, { speaker_id: 'user', question_id: q.id, competency: q.primary, followup: followupTurn, elicited_dims: followupTurn ? [q.primary] : [q.primary, ...(q.secondary || [])] });
    const rev = store.addRevision(turn.id, text, 'user', detectPii(text).map((x) => x.type));
    Object.assign(turn, { cut_off: cutOff, voice_metrics: sanitizeVoice(payload.voice_metrics), asked_text: askedText, stage: q.stage });
    const canFollow = q.followup_allowed && !followupTurn && answerState({ text }) !== 'noanswer'; // 무응답에는 꼬리질문을 하지 않는다
    const ctx = requestContext(owner, { synthetic: rev.synthetic === true });
    const evidenceText = (q.evidence || []).filter((e) => e.kind === 'application').map((e) => e.quote || '').filter(Boolean).join('\n');
    const scoreCtx = { question: askedText, evidence: evidenceText };
    const contextText = `${askedText}\n${evidenceText}\n${text}`;
    const followupReason = followupReasonFor(text);
    const scored = () => ruleTurnScore(text, scoreCtx);
    const ruleNext = () => { const f = canFollow ? ruleFollowup(q.stage, text, scoreCtx) : null; return f ? { action: 'followup', utterance: f, turn_score: scored() } : { action: 'next', turn_score: scored() }; };
    let decision; let trace;
    if (q.stage === 'closing' || s.q_index === s.questions.length - 1) {
      // 마지막 답변은 대화 판단을 다시 호출하지 않고 바로 최종 분석으로 넘긴다.
      decision = { action: 'next', turn_score: scored() };
      trace = { operation: 'dialogue.next', provider: 'mock', mode: 'blocked', reason: 'interview_finished', model_alias: 'rule-based', latency_ms: null };
    } else if (s.llm_calls >= config.budgets.maxLlmCallsPerSession - 3) {
      decision = ruleNext(); trace = { operation: 'dialogue.next', provider: 'mock', mode: 'blocked', reason: 'budget_cap', model_alias: 'rule-based', latency_ms: null };
    } else {
      const res = await caller.call('dialogue.next', {
        ctx, mockAlias: 'rule-based', reserve: { key: `session:${s.id}`, amount: 0.005 },
        invoke: (a) => (a.decideTurn ? a.decideTurn({ stageLabel: q.stage_label, question: askedText, answer: text, evidence: evidenceText, followupReason, schoolContext: schoolContextOf(s), allowFollowup: canFollow, persona: personaBlock(s.persona_ids || [], { stage: q.stage }) }) : Promise.reject(Object.assign(new Error('decideTurn unsupported'), { invalid: true }))),
        // 실제 AI 호출이 실패하면 꼬리질문을 만들어내지 않고 다음 승인 질문으로 넘어간다(설계서 §6.2-6). AI가 꺼진 데모(Mock)에서만 규칙 꼬리질문을 쓴다.
        mock: ruleNext, fallback: () => ({ action: 'next', turn_score: scored() }),
        // 꼬리질문 문장은 기존 대화 검증기(240자·물음표 1개·금칙어·새 숫자 금지)를 통과해야 한다. 점수가 형식에 안 맞으면 규칙 점수로 바꾼다.
        // 인용(quote)이 있으면 답변 속 연속된 글이어야 한다(지어낸 인용 차단). 프롬프트가 인용을 요구하지만 없어도 위 검증(1개 질문·새 숫자 금지)은 통과해야 한다.
        validate: (o) => o?.action === 'next' || (o?.action === 'followup' && validateDialogueOutput(o, contextText) && personaOutputOk(o.utterance) && (String(o.utterance).match(/[?？]/g) || []).length === 1 && (!o.quote || text.replace(/\s+/g, '').includes(String(o.quote).replace(/\s+/g, '')))),
      });
      trace = res.trace; decision = res.value;
      if (['live', 'fallback'].includes(trace.mode)) s.llm_calls += 1; // 실제로 호출한 경우만 센다
      if (res.live && !validTurnScore(decision.turn_score)) decision = { ...decision, turn_score: scored(), score_source: 'rule' };
      if (trace.mode !== 'live') decision = { ...decision, turn_score: scored() };
    }
    pushTrace(s, trace);
    if (decision.action === 'followup' && !canFollow) decision = { ...decision, action: 'next' };
    turn.turn_score = { ...decision.turn_score, source: trace.mode === 'live' && decision.score_source !== 'rule' ? 'llm' : 'rule' };
    const base = { command_id: commandId, turn_id: turn.id, revision: rev.revision, ack: SPOKEN.ack, cut_off: cutOff, provider: trace.mode === 'live' ? trace.provider : 'mock', provider_trace: [trace], llm_calls: s.llm_calls };
    if (s.finish_requested) {
      // 이미 확정 중이던 답변은 보존하되, 종료 뒤 도착한 모델의 질문은 발행하지 않는다.
      return accept({ ...base, state: 'completing', version: s.version, action: 'finish', closing: SPOKEN.closing });
    }
    if (decision.action === 'followup') {
      store.updateSession(s, { awaiting_followup: true, current_followup: String(decision.utterance).trim(), followups_used: s.followups_used + 1, question_started_at: now() });
      store.pushEvent(s.id, 'assistant.message', { utterance: s.current_followup, action: 'ask_followup', stage: q.stage, followup_reason: followupReason });
      return accept({ ...base, state: s.state, version: s.version, action: 'ask_followup', utterance: s.current_followup, followups_used: s.followups_used });
    }
    const nextIndex = s.q_index + 1;
    store.updateSession(s, { awaiting_followup: false, current_followup: null, q_index: nextIndex });
    if (nextIndex >= s.questions.length) {
      let captured = null;
      const fin = await finishSession(owner, s, (resp) => { captured = { ...resp, ...base, action: 'finish', closing: SPOKEN.closing, utterance: SPOKEN.closing }; accept(captured); }, commandId);
      if (fin.error) return fin;
      return { status: fin.status, body: captured || fin.body };
    }
    const nq = s.questions[nextIndex];
    store.updateSession(s, { question_started_at: now() });
    store.pushEvent(s.id, 'assistant.message', { utterance: nq.text, action: 'next_question', stage: nq.stage });
    return accept({ ...base, state: s.state, version: s.version, action: 'next_question', bridge: pickAck(answerState({ text, cut_off: cutOff, followup: followupTurn }), q.bridge, parseInt(String(s.id).replace(/[^0-9a-f]/g, '').slice(0, 6), 16) + s.q_index), question: roomQuestion(nq), utterance: nq.text, current_question: roomQuestion(nq) });
  }

  // 보고서용 질문·답변 기록(일반 면접): 본질문·꼬리질문을 구분하고, 근거(i 버튼)·참고 점수·음성 지표를 붙인다.
  function generalTranscript(s) {
    return store.sessionTurns(s.id).filter((t) => t.speaker_id === 'user').map((t) => {
      const q = s.questions.find((x) => x.id === t.question_id) || {};
      const revs = store.getRevisions(t.id); const rev = revs[revs.length - 1];
      // 답변에 학교·가정 배경을 짐작하게 하는 표현이 있으면 결과에는 그 표현을 가려서 싣고(블라인드 원칙) 위험 종류만 알린다.
      const rawAnswer = rev?.normalized_text || '';
      const risk = detectBlindRisk(rawAnswer);
      const answerText = risk.level === 'none' ? rawAnswer : maskRisk(rawAnswer, risk.spans);
      return { turn_id: t.id, question_id: q.id, competency_ids: q.competency_ids || [], stage: q.stage, stage_label: q.stage_label, is_followup: !!t.followup, question_text: t.asked_text || q.text, answer_text: answerText, comment: answerComment({ turn_score: t.turn_score, cut_off: !!t.cut_off, text: rawAnswer }), risk: { level: risk.level, categories: risk.categories.map(({ id, label }) => ({ id, label })) }, revision: rev?.revision || 1, cut_off: !!t.cut_off, turn_score: t.turn_score || null, voice_metrics: t.voice_metrics || null, evidence: t.followup ? [] : (q.evidence || []) };
    });
  }

  function finishSession(owner, s, accept, commandId) {
    return finishSessionAsync(owner, s, accept, commandId);
  }

  async function finishSessionAsync(owner, s, accept, commandId, retryReport = false) {
    if (s.state === 'completed' && !retryReport) return err('conflict', '이미 완료된 세션입니다.', 409);
    if (!retryReport && !canSessionTransition(s.state, 'completing')) return err('conflict', '종료할 수 없는 상태입니다.', 409);
    // 토론 세션은 사용자 발언 기회 미달 시 협업 차원을 보류하고 안내를 보고서에 포함한다
    const it0 = s.interview_type || s.mode || 'general';
    if (it0 === 'discussion' && s.discussion && s.discussion.user_turns < 4) {
      store.pushEvent(s.id, 'session.snapshot', { note: 'discussion_user_turns_below_4' });
    }
    void it0;
    store.updateSession(s, { ...(retryReport ? {} : { state: 'completing' }), finish_requested: true, awaiting_followup: false, current_followup: null });
    const turns = store.sessionTurns(s.id).filter((t) => t.speaker_id === 'user');
    const turnsWithText = [];
    let allSynthetic = turns.length > 0;
    for (const t of turns) {
      const revs = store.getRevisions(t.id);
      const rev = revs[revs.length - 1];
      if (!rev) continue;
      const q = s.questions.find((x) => x.id === t.question_id);
      // 발화 시점의 단계별 차원(토론·PT·역할극)을 우선 사용한다.
      let elicited;
      if (Array.isArray(t.elicited_dims) && t.elicited_dims.length) elicited = [...t.elicited_dims];
      else if (t.followup) elicited = [...(q?.followup_dimensions || [q?.primary || 'reflection'])];
      else elicited = q ? [q.primary, ...(q.secondary || [])] : [];
      if (rev.synthetic !== true) allSynthetic = false;
      turnsWithText.push({ turn_id: t.id, question_id: t.question_id, revision: rev.revision, text: rev.normalized_text, elicited });
    }
    let report = null;
    try {
      const it = s.interview_type || s.mode || 'general';
      const rubric_version = s.policy_snapshot?.rubric || rubricForInterviewType(it);
      const isLegacy = rubric_version === 'behavioral-ko-v1' && (it === 'general' || it === 'panel' || it === 'structured');
      const evalTurns = turnsWithText.map((t) => ({ turn_id: t.turn_id, revision: t.revision, speaker: 'user', text: t.text, elicited_dimensions: t.elicited }));
      const validateGenerated = (g) => (isLegacy ? validateEvaluation(g, evalTurns) : validateEvaluationGeneric(g, evalTurns, getRubric(rubric_version)));
      // 규칙 기반 평가: 인용·span 검증을 통과한 결과만 채택한다(기존 동작 불변)
      const ruleBased = () => {
        const g = isLegacy ? buildMockEvaluation({ sessionId: s.id, turnsWithText }) : buildTypedEvaluation({ rubricVersion: rubric_version, turnsWithText });
        const v = validateGenerated(g);
        if (!v.ok) throw new Error(v.errors.join('; '));
        return g;
      };
      // 평가 분업(2026-11-01 사용자 결정: Sonnet 관찰 → Gemini 채점). 한쪽 실패 시 규칙 기반 폴백.
      // 1단계 관찰(evaluation.observe, 기본 claude): level 없이 관찰문·인용 후보. 2단계 채점(evaluation.generate, 기본 gemini): 그 안에서 level만.
      const evalCtx = requestContext(owner, { forceMock: !!s.highschool_mock && !allSynthetic, synthetic: allSynthetic });
      const evalRub = getRubric(rubric_version);
      const evalTurnsForModel = turnsWithText.map((t) => ({ turn_id: t.turn_id, text: t.text, elicited: t.elicited }));
      const obsRes = await caller.call('evaluation.observe', {
        ctx: evalCtx,
        mockAlias: 'claude-observe',
        reserve: { key: `session:${s.id}`, amount: config.budgets.evalReserve },
        invoke: async (a2) => {
          if (typeof a2.observeAnswers !== 'function') throw Object.assign(new Error('observe unsupported'), { code: 501, invalid: true });
          const out = await a2.observeAnswers({ turns: evalTurnsForModel, rubric: evalRub });
          return { observations: out.parsed, model: out.model, usage: out.usage };
        },
        mock: async () => null, fallback: async () => null,
        validate: (o) => !!o?.observations && Array.isArray(o.observations.dimensions),
      });
      pushTrace(s, obsRes.trace);
      if (['live', 'fallback'].includes(obsRes.trace.mode)) s.llm_calls += 1;
      // 평가 라우팅(evaluation.generate): 기본은 규칙 기반. 모델 평가가 켜져도 같은 검증을 통과한 출력만 쓴다.
      const obsLive = obsRes.live && !!obsRes.value && Array.isArray(obsRes.value.observations?.dimensions);
      const evalRes = await caller.call('evaluation.generate', {
        // 평가 입력(모든 사용자 답변)이 전부 서버 fixture 샘플 답변일 때만 합성으로 본다.
        ctx: evalCtx,
        mockAlias: 'rule-based',
        reserve: { key: `session:${s.id}`, amount: config.budgets.evalReserve },
        // 모델 출력은 서버가 인용을 원문에서 재계산해 보고서로 만든 뒤 같은 검증기를 통과해야 한다(WP-E). 아니면 규칙 기반.
        // 분업 채점: Sonnet 관찰 안에서만 level을 정한다. grade 미지원 어댑터(레거시 단일 호출)는 기존 evaluateAnswers로 호환.
        invoke: async (a2) => {
          const rub = getRubric(rubric_version);
          if (obsLive && typeof a2.gradeObservations === 'function') {
            const out = await a2.gradeObservations({ observations: obsRes.value.observations, rubric: rub });
            const built = buildLlmEvaluation({ parsed: out.parsed, turnsWithText, rubric: rub, checkSafety: checkFeedbackSafety });
            return { report: built, model: out.model, usage: out.usage };
          }
          const out = await a2.evaluateAnswers({ turns: turnsWithText.map((t) => ({ turn_id: t.turn_id, text: t.text, elicited: t.elicited })), rubric: rub });
          const built = buildLlmEvaluation({ parsed: out.parsed, turnsWithText, rubric: rub, checkSafety: checkFeedbackSafety });
          return { report: built, model: out.model, usage: out.usage };
        },
        mock: ruleBased, fallback: ruleBased,
        validate: (o) => !!o?.report && validateGenerated(o.report).ok === true,
      });
      const generated = evalRes.live ? evalRes.value.report : evalRes.value;
      const evalTrace = evalRes.trace;
      pushTrace(s, evalTrace);
      if (['live', 'fallback'].includes(evalTrace.mode)) s.llm_calls += 1;
      // 기관 연결: 공개 요구사항과 답변의 근거 연결 (평가 점수와 별도 레이어)
      let institution_link = { mode: 'general', note: '모집요강·공고 연결 없이 일반 역량 기준으로만 분석합니다.', links: [], uncovered: [] };
      let institution_profile = null;
      if (s.profile_version_id) {
        const ver = store.getVersion(s.profile_version_id);
        const prof = ver ? store.getProfile(owner, ver.profile_id) : null;
        const inst = ver && prof ? store.getInstitution(prof.id)?.profile : null;
        if (inst) {
          institution_profile = { org_type: inst.org_type, org_label: inst.org_label, target_name: inst.target_name, role: inst.role, badge: inst.badge, fallback_to_general: inst.fallback_to_general, core_values: inst.core_values, unevaluable: inst.unevaluable, disclaimer: inst.disclaimer };
          institution_link = linkAnswersToInstitution({ institution: inst, turnsWithText });
        }
      }
      const general = s.format === 'general';
      // 재연습 질문: 기관 미관찰 요구 우선(레거시). 일반 면접 보고서는 적합성 차트가 미관찰 역량을 보여 주므로 중복 항목을 만들지 않는다.
      const next_actions = [...(generated.next_actions || [])];
      for (const u of (general ? [] : institution_link.uncovered || []).slice(0, 2)) {
        if (next_actions.length >= 3) break;
        if (next_actions.some((a) => a.practice_question?.includes(u.requirement))) continue;
        next_actions.push({
          dimension_id: 'relevance',
          action: `다음 답변에서는 ‘${u.requirement}’ 요구와 연결되는 본인 행동 근거를 한 가지 덧붙이세요.`,
          practice_question: `‘${u.requirement}’ 요구와 연결되는 본인의 경험을 설명해 주세요.`,
          institution_requirement: u.requirement,
        });
      }
      // 일반 면접: 질문·답변 기록, 역량 적합성, 6축을 먼저 만들고 면접관 말투 한줄평(report.comment)을 붙인다.
      const buildGeneralPart = async () => {
        // 일반 면접: 질문·답변 기록. 차트 점수는 가능하면 Gemini가 질문·학생부·답변을 읽고 매긴 값으로 바꾼다.
        let transcript = generalTranscript(s);
        const ver = store.getVersion(s.profile_version_id);
        const vProfEarly = ver ? store.getProfile(owner, ver.profile_id) : null;
        const reviewIds = transcript.map((t) => t.turn_id);
        const reviewRes = await caller.call('answer.review', {
          ctx: requestContext(owner, { forceMock: !!s.highschool_mock && !allSynthetic, synthetic: allSynthetic }),
          mockAlias: 'rule-based',
          reserve: { key: `session:${s.id}`, amount: config.budgets.commentReserve },
          invoke: (a2) => {
            if (typeof a2.reviewAnswers !== 'function') throw Object.assign(new Error('review unsupported'), { code: 501, invalid: true });
            return a2.reviewAnswers({
              application: vProfEarly?.application_text || '',
              turns: transcript.map((t) => ({ turn_id: t.turn_id, question: t.question_text, evidence: (t.evidence || []).map((e) => e.quote || e.label || '').filter(Boolean).join('\n'), answer: t.answer_text })),
            });
          },
          mock: async () => null, fallback: async () => null,
          validate: (o) => validateAnswerReview(o, reviewIds) !== null,
        });
        pushTrace(s, reviewRes.trace);
        if (['live', 'fallback'].includes(reviewRes.trace.mode)) s.llm_calls += 1;
        const reviewed = reviewRes.live ? validateAnswerReview(reviewRes.value, reviewIds) : null;
        if (reviewed) {
          const byId = new Map(reviewed.turns.map((t) => [t.turn_id, t]));
          transcript = transcript.map((t) => {
            const r = byId.get(t.turn_id);
            if (!r) return t;
            return { ...t, turn_score: { relevance: r.relevance, specificity: r.specificity, reasoning: r.reasoning, source: 'llm' }, comment: { good: r.good || null, fix: r.fix || null, basis: 'Gemini가 이 질문, 학생부 근거, 이 답변을 읽고 쓴 문장입니다. 검증 전 참고이며 합격 판단이 아닙니다.', weakest: null, strongest: null } };
          });
        }
        const fitTurns = transcript.map((t) => ({ turn_id: t.turn_id, text: t.answer_text, turn_score: t.turn_score, evidence_ids: (t.evidence || []).map((e) => e.id).filter(Boolean), competency_ids: t.competency_ids || [] }));
        const comps = ver?.plan?.general?.competencies || [];
        const vProf = vProfEarly;
        const vInst = vProf ? store.getInstitution(vProf.id)?.profile : null;
        const events = s.blind_events || [];
        const axes = buildAxes({ transcript, competencies: comps, institution: vInst });
        const competency_fit = competencyFit(comps, fitTurns);
        // 한줄평 입력은 블라인드 위험 표현을 가린 답변뿐이다. 게이트가 닫혀 있거나 실패·검증 불일치면 규칙 문구를 쓴다.
        const ruleCmt = () => ruleComments({ fit: competency_fit, axes: axes.axes });
        const cmtRes = await caller.call('report.comment', {
          ctx: requestContext(owner, { forceMock: !!s.highschool_mock && !allSynthetic, synthetic: allSynthetic }),
          mockAlias: 'rule-based',
          reserve: { key: `session:${s.id}`, amount: config.budgets.commentReserve },
          invoke: (a2) => a2.writeComments({
            turns: transcript.map((t) => ({ question: t.question_text, answer: t.answer_text, followup: t.is_followup })),
            competencies: comps.map((c) => String(c.label || '').trim()).filter(Boolean),
            fit: competency_fit, axes: axes.axes,
          }),
          mock: ruleCmt, fallback: ruleCmt,
          validate: validComments,
        });
        pushTrace(s, cmtRes.trace);
        if (['live', 'fallback'].includes(cmtRes.trace.mode)) s.llm_calls += 1;
        const cm = cmtRes.value;
        const ai_comments = { fit_comment: String(cm.fit_comment).trim(), dimension_comment: String(cm.dimension_comment).trim(), provider: cmtRes.trace.mode === 'live' ? cmtRes.trace.provider : 'rule_based', live: cmtRes.live === true, validated: false, version: COMMENT_PROMPT_VERSION };
        return { format: 'general', transcript, axes, ai_comments,
          // 블라인드 안전 결과(설계서 §10.5-5): 민감 원문은 싣지 않고 종류·처리 결과만.
          blind_safety: { filter_version: FILTER_VERSION, blocked_count: events.length, events: events.map((e) => ({ level: e.level, labels: e.labels, action: e.action, at: e.at })), masked_answers: transcript.filter((t) => t.risk?.level && t.risk.level !== 'none').length, note: '대입 블라인드 면접 기준(성명·수험번호·출신 고교·부모 및 친인척의 직업 등 사회적 지위)에 해당하는 표현은 AI로 보내기 전에 막았고, 결과 화면에는 원문을 싣지 않습니다. 대학별 공식 규정이 확인되지 않아 Reheaview의 보수적 기본 정책을 적용했습니다.' },
          personas: { ids: s.persona_ids || [], names: (s.persona_ids || []).map(personaName), notice: '가상의 면접관 관점입니다. 실제 대학의 면접관·교수·입학사정관이 아니며 평가 기준·합격 여부와 무관합니다.' }, competency_fit, score_label: reviewed ? 'Gemini 참고 점수 · 검증 전' : '규칙 참고 점수 · 검증 전', fit_label: '질문과 연결된 역량의 답변 점수 · 검증 전' };
      };
      const generalPart = general ? await buildGeneralPart() : null;
      report = {
        ...generated,
        next_actions: next_actions.slice(0, 3),
        evaluation_id: randomUUID(),
        status: 'ready',
        generated_at: now(),
        // 평가기 종류·실제 공급자는 provider_trace와 같은 값이다(BUG-6). 규칙 기반 평가를 AI 평가처럼 표기하지 않는다.
        provider: evalTrace.provider,
        evaluator: { kind: evalTrace.mode === 'live' ? 'llm' : 'rule_based', provider: evalTrace.provider, model_alias: evalTrace.model_alias, version: evalTrace.mode === 'live' ? 'eval-llm-v2' : 'rule-based-v1', ...(evalTrace.mode === 'live' ? { validated: false } : {}) },
        provider_trace: [...(s.provider_trace || [])],
        session_id: s.id, attempt_no: s.attempt_no || 1, profile_version_id: s.profile_version_id || null,
        interviewer_role: s.interviewer_role || null,
        role_label: s.interviewer_role ? (ROLES[s.interviewer_role]?.label || null) : null,
        institution: institution_profile,
        ...(general ? generalPart : { institution_link, claim_links: buildClaimLinks(s, turnsWithText) }),
        model_version: (evalRes.live ? evalRes.value.model : generated.model_version) || 'mock-model-v1',
        interview_type: it,
        rubric_version,
        transcript_turn_count: turnsWithText.length,
      };
      store.evaluations.set(s.id, report);
    } catch (e) {
      // 원문·공급자 오류 본문·키 대신 서버가 만든 단계와 사유만 공개한다.
      const operation = e?.code === 'ai_unavailable' ? e.operation : null;
      const reason = e?.code === 'ai_unavailable' ? e.reason : null;
      const configuration = e?.code === 'ai_unavailable' ? e.configuration : null;
      const stage = ({ 'evaluation.observe': '답변 근거 관찰', 'evaluation.generate': '답변 분석', 'answer.review': '질문별 답변 검토', 'report.comment': '종합 코멘트 작성' })[operation];
      const missingLabels = (configuration?.missing || []).map((key) => ({ apiKey: 'API 키', baseUrl: '요청 주소', model: '모델' })[key]).filter(Boolean);
      const failureNote = reason === 'not_configured' && missingLabels.length
        ? `${configuration.provider === 'claude' ? 'Claude' : 'AI'} 서버 설정 누락(${missingLabels.join('·')}) — 운영자 설정 후 다시 시도할 수 있습니다`
        : ({ timeout: '응답 시간 초과', rate_limited: '공급자 요청 한도 초과', budget_cap: '분석 예산 한도 도달', invalid_output: '응답 검증 실패', consent_missing: '처리 동의 확인 필요', provider_error: '공급자 응답 오류' })[reason] || 'AI 이용 설정 확인 필요';
      report = { status: 'failed', error_code: 'evaluation_failed', generated_at: now(), retryable: true,
        failure: { operation, reason, ...(configuration ? { configuration } : {}) }, provider_trace: [...(s.provider_trace || [])],
        detail: `평가를 생성하지 못했습니다.${stage ? ` ${stage}: ${failureNote}.` : ''} 확정된 답변은 보존됩니다. 분석을 다시 시도해 주세요.` };
      store.evaluations.set(s.id, report);
    }
    store.updateSession(s, { state: 'completed', completed_at: s.completed_at || now() });
    store.pushEvent(s.id, 'session.completed', { report_ready: report.status === 'ready' });
    if (report.status === 'ready') store.pushEvent(s.id, 'report.ready', { evaluation_id: report.evaluation_id });
    const response = { command_id: commandId, state: 'completed', version: s.version, report_status: report.status };
    if (accept) accept(response);
    return { status: 202, body: response };
  }

  // 지원서 주장 ↔ 실제 답변을 나란히 보여준다. 사실 여부를 판정하지 않는다.
  function buildClaimLinks(s, turnsWithText) {
    return s.questions.filter((q) => q.application_evidence?.length).map((q) => {
      const answers = turnsWithText.filter((t) => t.question_id === q.id).map((t) => ({ turn_id: t.turn_id, revision: t.revision, excerpt: Array.from(t.text).slice(0, 160).join('') }));
      return { question_id: q.id, claim_id: q.application_evidence[0].id, quote: q.application_evidence[0].quote, start_cp: q.application_evidence[0].start_cp, end_cp: q.application_evidence[0].end_cp, gaps: q.application_evidence[0].gaps, answered: answers.length > 0, answers };
    });
  }

  return { runCommand };
}
