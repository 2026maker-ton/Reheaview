// 실제 마이크·외부 STT를 사용하지 않는 브라우저 자동 완료 회귀 검사.
export async function verifyRoomCompletion(page, check) {
  await page.clock.install();
  let submissions = 0; let transcriptions = 0; let stall = false;
  await page.route('**/api/v1/sessions/voice-check/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/transcriptions')) {
      transcriptions++;
      if (stall) return; // 응답 없는 STT 재현(실서비스 전송 없음)
      return route.fulfill({ json: { text: '제가 직접 실험 조건을 통제하고 결과를 비교했습니다.' } });
    }
    if (path.endsWith('/commands')) {
      submissions++;
      return route.fulfill({ json: submissions < 5
        ? { version: submissions + 1, state: 'active', action: 'next_question', question: { text: `자동 진행 질문 ${submissions + 1}` } }
        : { version: 6, state: 'completed', action: 'finish', closing: '면접을 마치겠습니다.' } });
    }
    return route.fulfill({ json: { status: 'ready', session_id: 'voice-check', evaluator: { kind: 'rule_based' }, transcript: [] } });
  });
  await page.evaluate(async () => {
    window.__voiceMode = 'silence';
    class Recorder {
      static isTypeSupported() { return true; }
      state = 'inactive'; mimeType = 'audio/webm';
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; setTimeout(() => { this.ondataavailable?.({ data: new Blob(['synthetic-voice']) }); this.onstop?.(); }, 250); }
    }
    window.MediaRecorder = Recorder;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    window.AudioContext = class {
      sampleRate = 48000;
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(buffer) {
        for (let i = 0; i < buffer.length; i++) buffer[i] = window.__voiceMode === 'speech' ? .2 * Math.sin(2 * Math.PI * 200 * i / 48000) : window.__voiceMode === 'noise' ? .08 * (Math.random() * 2 - 1) : 0;
      } }; }
      close() { return Promise.resolve(); }
    };
    const { state } = await import('/core/state.js');
    const { enterRoom } = await import('/screens/room.js');
    window.__startVoiceCheck = () => {
      state.user = { id: 'voice-browser-test', guest: true }; state.profile = null;
      state.session = { id: 'voice-check', version: 1, state: 'ready' };
      enterRoom({ session: { input_mode: 'groq', answer_seconds: 60 }, started: { question: { text: '자동 진행 질문 1' } } });
    };
    window.__startVoiceCheck();
  });
  await page.clock.runFor(1000);
  await page.clock.runFor(28_000);
  check(submissions === 0 && transcriptions === 0, '음성: 최초 무발화 29초에는 다음 질문·전사 없음');
  await page.evaluate(() => { window.__voiceMode = 'speech'; });
  await page.clock.runFor(1000);
  await page.evaluate(() => { window.__voiceMode = 'noise'; });
  await page.clock.runFor(2900);
  check(submissions === 0, '음성: 마지막 말소리 뒤 2.9초에는 조기 제출 없음');
  await page.clock.runFor(1000);
  check(submissions === 1 && transcriptions === 1, '음성: 배경 소음을 제외한 정적 3초 후 전사·제출 1회');
  await page.evaluate(() => { window.__voiceMode = 'silence'; });
  for (let i = 0; i < 4; i++) await page.clock.runFor(32_000);
  await page.waitForURL(/#\/feedback/);
  check(submissions === 5, '마지막 질문도 자동 제출 후 결과 화면 도착');
  check(transcriptions === 1, '무발화 답변은 외부 전사 없이 자동 진행');

  submissions = 0; transcriptions = 0; stall = true;
  await page.evaluate(() => { window.__voiceMode = 'silence'; window.__startVoiceCheck(); });
  await page.clock.runFor(1000);
  await page.evaluate(() => { window.__voiceMode = 'speech'; });
  await page.clock.runFor(1000);
  await page.evaluate(() => { window.__voiceMode = 'silence'; });
  await page.clock.runFor(32_000);
  await page.clock.runFor(36_000);
  check(await page.locator('#textAnswer').isVisible() && (await page.locator('#roomError').innerText()).includes('지연'), 'STT 무응답은 무한 대기 대신 텍스트 확인으로 전환');
  check(submissions === 0 && transcriptions === 1, 'STT 지연·60초 경계에서 중복 전사·빈 답변 제출 없음');

  let releaseTurn; let releaseFinish; let seenTurn;
  const turnSeen = new Promise((r) => { seenTurn = r; });
  const waitTurn = new Promise((r) => { releaseTurn = r; });
  const waitFinish = new Promise((r) => { releaseFinish = r; });
  let finishCount = 0;
  await page.route('**/api/v1/sessions/end-check/**', async (route) => {
    if (route.request().url().endsWith('/commands')) {
      const b = route.request().postDataJSON();
      if (b.type === 'turn.text') { seenTurn(); await waitTurn; return route.fulfill({ json: { version: 3, state: 'active', action: 'ask_followup', utterance: '종료 뒤에는 나오면 안 되는 꼬리질문?' } }); }
      if (b.type === 'session.finish') { finishCount++; await waitFinish; return route.fulfill({ json: { state: 'completed', version: 4 } }); }
    }
    return route.fulfill({ json: { status: 'ready', session_id: 'end-check', evaluator: { kind: 'rule_based' }, transcript: [] } });
  });
  await page.evaluate(async () => {
    const { state } = await import('/core/state.js'); const { enterRoom } = await import('/screens/room.js');
    state.session = { id: 'end-check', version: 2, state: 'ready' };
    enterRoom({ session: { input_mode: 'text', answer_seconds: 60 }, started: { question: { text: '종료 경합 검사 질문', stage: 'academic' } } });
  });
  await page.clock.runFor(50);
  await page.fill('#answerText', '제가 직접 실험 조건을 정했습니다.'); await page.click('#answerBtn');
  await turnSeen;
  await page.click('#finishBtn');
  await page.waitForURL(/#\/feedback/);
  await page.waitForSelector('.processing-card[aria-busy=true]');
  check(await page.locator('.processing-card[aria-busy=true]').isVisible() && (await page.locator('.processing-card').innerText()).includes('분석 중'), '종료 클릭 즉시 분석 화면과 처리 중 표시');
  check(await page.locator('#confirmDialog[open]').count() === 0, '종료 확인창 없이 즉시 종료');
  releaseTurn();
  await page.clock.runFor(100);
  check(!(await page.locator('#roomTitle').innerText()).includes('나오면 안 되는 꼬리질문'), '종료 뒤 도착한 꼬리질문 무시');
  releaseFinish();
  await page.waitForSelector('.report-overview');
  check(finishCount === 1 && page.url().endsWith('#/feedback'), '종료 요청 1회·결과 화면 유지');
}
