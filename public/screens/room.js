// 면접실: 실제 면접처럼 질문과 면접관 말만 보인다(지원서 근거·단계·진행률 없음).
// 음성: 낭독 뒤 최초 무발화는 30초, 발화 후 마지막 말소리부터는 3초에 자동 제출한다.
// 질문별 제한시간(기본 60초)이 지나면 "네, 거기까지만…" 후 제출. 제출과 동시에 "네 답변 잘 들었습니다."
import { $, setError, uuid } from '../core/format.js';
import { FIXED } from '../core/copy.js';
import { toast } from '../core/toast.js';
import { api, apiUrl } from '../core/api.js';
import { state } from '../core/state.js';
import { go } from '../core/router.js';
import { askConfirm } from '../core/dialog.js';
import { loadReport, showReportProcessing, showReportFailure, cancelReportLoading } from './feedback.js';
import { clearDraftAfterInterview } from './draft.js';
import { openMic, createCapture, calibrate } from '../core/vad.js';
import { speakInterviewer, stopSpeech } from '../core/tts.js';

let room = null; // { voice, seconds, timer, endAt, parts, capture, busy, done }
let mic = null;

// ---- 면접관 음성(서버 ElevenLabs → 브라우저 합성 폴백) ----
export function speak(text, target = null) {
  const fixed = ['opening', 'ack', 'cutoff', 'closing'].find((k) => FIXED[k] === text);
  return speakInterviewer(text, target || (fixed ? `fixed_${fixed}` : null));
}
export function stopVoice() {
  stopSpeech();
  clearInterval(room?.timer);
  clearTimeout(room?.nudge);
  room?.capture?.stop();
  mic?.close(); mic = null;
}

const setListen = (st, text) => { const b = $('#listenBox'); b.hidden = !room?.voice; b.dataset.state = st; $('#listenStatus').textContent = text; };
const showError = (msg) => { const el = $('#roomError'); el.hidden = !msg; el.textContent = msg || ''; };

function setQuestion(text, line = '') {
  $('#roomTitle').textContent = text;
  $('#interviewerLine').textContent = line;
  $('#liveTranscript').hidden = true; $('#liveTranscript').textContent = '';
  try { $('#roomTitle').focus({ preventScroll: true }); } catch { /* noop */ }
}

// ---- 답변 제한시간 ----
function startClock() {
  clearInterval(room.timer);
  room.endAt = Date.now() + room.seconds * 1000;
  const paint = () => {
    const left = Math.max(0, Math.ceil((room.endAt - Date.now()) / 1000));
    $('#clock').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    $('#roomClock').classList.toggle('critical', left <= 10);
    if (left === 10) $('#clockAnnounce').textContent = '10초 남았습니다';
    if (left === 0) { clearInterval(room.timer); timeUp(); }
  };
  paint();
  room.timer = setInterval(paint, 250);
}

// ---- 한 질문 진행: 말하기 → 답변 받기 ----
async function ask(text, line = '', stage = '', target = 'last_utterance') {
  if (!room || room.done) return;
  const current = room;
  room.stage = stage;
  setQuestion(text, line);
  $('#textAnswer').hidden = true; $('#answerBtn').hidden = true; $('#listenBox').hidden = true;
  // 마이크는 질문을 읽기 전에 열고 소음 기준을 잡아 둔다: 질문이 끝나는 순간 지연 없이 바로 녹음·인식 상태로 들어가기 위해서다.
  if (room.voice) { try { mic ||= await openMic(); if (!mic.threshold) await calibrate(mic); } catch { /* beginAnswer가 텍스트로 전환한다 */ } }
  await speak(line ? `${line} ${text}` : text, target);
  if (room !== current || room?.done) return;
  beginAnswer();
}

async function beginAnswer() {
  if (!room || room.done) return;
  $('#roomState').textContent = '면접 중';
  room.parts = []; room.busy = false; room.submitting = false; room.timeExpired = false;
  const answerNo = room.answerNo = uuid();
  showError('');
  startClock();
  if (room.voice) {
    try {
      mic ||= await openMic();
      room.capture = createCapture(mic, {
        onSegment: (blob) => onSegment(blob, answerNo),
        onError: (err) => useTextAfterError(err, answerNo),
        onNoSpeech: () => { if (room && room.answerNo === answerNo && !room.done && !room.submitting) submit(true); },
        onState: (st) => {
          if (!room || room.done || room.answerNo !== answerNo) return;
          if (st === 'processing') room.busy = true; // MediaRecorder.stop 이벤트를 기다리는 동안에도 중복 종료 방지
          setListen(st, { listening: '듣고 있습니다', speaking: '말하는 중', processing: '정리 중' }[st] || '');
        },
      });
      room.capture.start();
      room.nudge = setTimeout(() => { if (room && !room.capture?.spoke) setListen('listening', '답변을 시작해 주세요'); }, 10_000);
      return;
    } catch {
      room.voice = false;
      toast('마이크를 사용할 수 없어 텍스트로 답합니다.', true);
    }
  }
  $('#textAnswer').hidden = false; $('#answerBtn').hidden = false;
  $('#answerText').value = ''; $('#charCount').textContent = '0';
  $('#answerText').focus();
}

function useTextAfterError(err, answerNo) {
  if (!room || room.done || room.answerNo !== answerNo) return;
  clearInterval(room.timer); clearTimeout(room.nudge);
  room.busy = false; room.voice = false;
  showError(`${err.message} 텍스트로 답변을 확인한 뒤 제출해 주세요.`);
  $('#listenBox').hidden = true;
  $('#textAnswer').hidden = false; $('#answerBtn').hidden = false;
  $('#answerText').value = room.parts.join(' ');
  $('#charCount').textContent = String([...$('#answerText').value].length);
  $('#answerText').focus();
}

async function transcribe(blob) {
  const fd = new FormData();
  fd.append('file', blob, `answer.${/mp4/.test(blob.type) ? 'm4a' : 'webm'}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(apiUrl(`/sessions/${state.session.id}/transcriptions`), { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${state.token}`, 'Idempotency-Key': uuid() }, body: fd });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || '음성 인식에 실패했습니다.'), { status: res.status });
    return String(data.text || '').trim();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('음성 인식 응답이 지연되어 자동 처리를 멈췄습니다.');
    throw err;
  } finally { clearTimeout(timer); }
}

// 발화 후 잡음을 제외한 정적 3초로 끊긴 구간은 문장 끝맺음과 무관하게 전사·제출한다.
async function onSegment(blob, answerNo) {
  if (!room || room.done || room.answerNo !== answerNo || room.submitting) return;
  room.busy = true;
  try {
    setListen('processing', '음성 인식 중...');
    const t = await transcribe(blob);
    if (!room || room.done || room.answerNo !== answerNo) return;
    if (t) room.parts.push(t);
    const joined = room.parts.join(' ');
    $('#liveTranscript').hidden = !joined; $('#liveTranscript').textContent = joined;
    if (room.submitting) return;
    return submit(room.timeExpired);
  } catch (err) {
    useTextAfterError(err, answerNo);
  } finally { if (room?.answerNo === answerNo) room.busy = false; }
}

async function timeUp() {
  if (!room || room.done || room.submitting) return;
  // 정적 전사가 진행 중이면 그 결과를 받은 뒤 제출해 마지막 말을 잃지 않는다.
  if (room.busy) { room.timeExpired = true; $('#interviewerLine').textContent = FIXED.cutoff; speak(FIXED.cutoff); return; }
  if (room.voice) {
    const tail = await room.capture.stop();
    if (room.done) return;
    const say = speak(FIXED.cutoff);
    $('#interviewerLine').textContent = FIXED.cutoff;
    if (tail && room.capture.spoke) { try { setListen('processing', '음성 인식 중...'); const t = await transcribe(tail); if (!room.done && t) room.parts.push(t); } catch { /* 남은 구간 전사 실패는 넘어간다 */ } }
    await say;
  } else {
    $('#interviewerLine').textContent = FIXED.cutoff;
    await speak(FIXED.cutoff);
  }
  submit(true);
}

async function submit(cutOff) {
  if (!room || room.done || room.submitting) return;
  const current = room;
  room.submitting = true;
  clearInterval(room.timer); clearTimeout(room.nudge);
  if (room.voice) await room.capture?.stop();
  if (room !== current || room.done) return;
  const text = (room.voice ? room.parts.join(' ') : $('#answerText').value).trim() || '(답변 없음)';
  const voice_metrics = room.voice ? room.capture?.metrics() : undefined;
  $('#textAnswer').hidden = true; $('#answerBtn').hidden = true;
  setListen('processing', '답변 분석 중...');
  $('#roomState').textContent = '답변 분석 중...';
  // 받은 답변을 먼저 말하고, 그 음성이 끝난 뒤에만 결과 분석 화면으로 넘어간다.
  $('#interviewerLine').textContent = FIXED.ack;
  const said = speak(FIXED.ack);
  try {
    // Vercel은 같은 계정의 TTS와 답변 쓰기를 직렬화한다. 낭독 요청을 먼저 마쳐
    // 긴 답변 분석이 TTS를 15초 잠금 대기/20초 클라이언트 타임아웃에 빠뜨리지 않게 한다.
    await said;
    if (room !== current || room.done) return;
    const r = await api(`/sessions/${state.session.id}/commands`, { method: 'POST', idempotent: true, body: { command_id: uuid(), expected_version: state.session.version, type: 'turn.text', payload: { text, cut_off: cutOff, ...(voice_metrics ? { voice_metrics } : {}) } } });
    if (room !== current || room.done) return;
    if (r.version) state.session.version = r.version;
    // 블라인드 사전 차단: 서버가 이 답변을 AI로 보내지 않았다. 안내를 보여 주고 같은 질문으로 다시 답하게 한다.
    if (r.action === 'blind_blocked') {
      state.session.state = 'active'; go('room');
      stopSpeech();
      $('#interviewerLine').textContent = '';
      await askConfirm('블라인드 안내', r.message, { okText: '다시 답하기' });
      return beginAnswer();
    }
    if (r.state === 'completed' || r.action === 'finish') return endInterview(r.closing || FIXED.closing);
    if (r.action === 'ask_followup') return ask(r.utterance, '', room.stage);
    return ask(r.question?.text || r.utterance, r.bridge || '', r.question?.stage);
  } catch (err) {
    if (room !== current || room.done) return;
    state.session.state = 'active'; go('room');
    room.submitting = false;
    showError(err.message);
    $('#textAnswer').hidden = false; $('#answerBtn').hidden = false; $('#answerText').value = text;
    room.voice = false;
  }
}

async function endInterview(closing) {
  room.done = true;
  stopVoice();
  clearDraftAfterInterview();
  state.session.state = 'completed';
  void closing;
  await loadReport();
}

// ---- 진입 ----
// started: session.start 응답(인사 + 첫 질문). resumeQuestion: 새로고침 복원 시 현재 질문.
export function enterRoom({ session, started = null, resumeQuestion = null }) {
  cancelReportLoading();
  stopVoice();
  room = { voice: session.input_mode === 'groq', seconds: session.answer_seconds || session.limits?.answer_seconds || 60, parts: [], done: false };
  state.session.state = 'active';
  $('#roomState').textContent = '면접 중';
  $('#finishBtn').disabled = false;
  showError('');
  go('room');
  if (started?.question) ask(started.question.text, started.opening || FIXED.opening, started.question.stage);
  else if (resumeQuestion?.text) ask(resumeQuestion.text, '', resumeQuestion.stage, 'current_question');
}

$('#answerBtn')?.addEventListener('click', () => {
  if (!$('#answerText').value.trim()) return setError('#roomError', '답변을 입력해 주세요.');
  submit(false);
});
$('#answerText')?.addEventListener('input', (e) => { $('#charCount').textContent = String([...e.target.value].length); });
$('#answerText')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#answerBtn').click(); } });

$('#finishBtn')?.addEventListener('click', async () => {
  if (!state.session || room?.done) return;
  if (room) { room.done = true; room.submitting = true; }
  $('#finishBtn').disabled = true;
  stopVoice();
  state.session.state = 'completing';
  const finish = async () => {
    $('#interviewerLine').textContent = FIXED.ack;
    await speak(FIXED.ack);
    clearDraftAfterInterview();
    showReportProcessing();
    try {
      // 진행 중 답변이 버전을 올릴 수 있다. 종료 명령은 최신 상태에서 직렬 처리한다.
      const r = await api(`/sessions/${state.session.id}/commands`, { method: 'POST', idempotent: true, body: { command_id: uuid(), type: 'session.finish', payload: {} } });
      state.session = { ...state.session, version: r.version, state: r.state };
      await loadReport();
    } catch (err) { showReportFailure(err.message, finish); }
  };
  await finish();
});

// 다른 화면으로 나가면 녹음·음성을 멈춘다.
window.addEventListener('hashchange', () => { if (location.hash !== '#/room' && room && !room.done && state.session?.state !== 'completing') { room.done = true; stopVoice(); } });
