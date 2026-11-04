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
    // 가상 시계에서 네트워크 응답 후 생긴 낭독 타이머가 다음 질문을 막지 않게 한다.
    if (window.speechSynthesis) window.speechSynthesis.speak = (u) => Promise.resolve().then(() => u.onend?.());
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
  // The fake browser clock does not await the intercepted HTTP response on the Node event loop.
  await page.waitForFunction(() => document.querySelector('#roomTitle')?.textContent.includes('자동 진행 질문 2'), null, { timeout: 5000 });
  check(submissions === 1 && transcriptions === 1, '음성: 배경 소음을 제외한 정적 3초 후 전사·제출 1회');
  await page.evaluate(() => { window.__voiceMode = 'silence'; });
  for (let i = 0; i < 4; i++) {
    await page.clock.runFor(32_000);
    // 네트워크는 실제 Node 루프, 녹음/낭독은 가상 시계다. 외부 응답이 돌아온 뒤
    // 시작된 타이머까지 진행시키며 유한 횟수로 기다린다(멈춘 RAF 폴링 금지).
    for (let spin = 0; spin < 70 && submissions < i + 2; spin++) {
      await new Promise((r) => setTimeout(r, 10));
      await page.clock.runFor(1000);
    }
    if (submissions < i + 2) throw new Error(`자동 진행 질문 ${i + 2} 제출 지연`);
    await new Promise((r) => setTimeout(r, 20));
    await page.clock.runFor(1000);
  }
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

  // 텍스트 마지막 답변: AI 평가 응답이 지연되어도 종료 화면으로 전환한다.
  // 서버 응답 전에는 completed로 표시하거나 보고서를 조회하지 않는다.
  let releaseLast; let lastBody; let reportReads = 0; let finalResult = 'ready';
  await page.route('**/api/v1/sessions/text-final-check/**', async (route) => {
    if (route.request().url().endsWith('/tts')) return route.fulfill({ status: 204 });
    if (route.request().url().endsWith('/commands')) {
      lastBody = route.request().postDataJSON();
      await new Promise((r) => { releaseLast = r; });
      if (finalResult === 'error') return route.fulfill({ status: 503, json: { error: { message: '분석 요청 지연 시험' } } });
      if (finalResult === 'blind') return route.fulfill({ json: { state: 'active', version: 3, action: 'blind_blocked', message: '블라인드 표현을 빼고 다시 답해 주세요.' } });
      return route.fulfill({ json: { state: 'completed', version: 3, action: 'finish' } });
    }
    reportReads++;
    return route.fulfill({ json: { status: 'ready', session_id: 'text-final-check', evaluator: { kind: 'rule_based' }, transcript: [] } });
  });
  const startLast = () => page.evaluate(async () => {
    const { state } = await import('/core/state.js'); const { enterRoom } = await import('/screens/room.js');
    state.session = { id: 'text-final-check', version: 2, state: 'active' };
    state.ttsVoice = 'browser';
    enterRoom({ session: { input_mode: 'text', answer_seconds: 60 }, started: { question: { text: '마지막으로 하고 싶은 말이 있나요?', stage: 'closing' } } });
  });
  const lastAnswer = '입학 후에도 직접 탐구한 과정을 기록하고 동료와 비교하겠습니다.';
  const submitLast = async () => {
    releaseLast = null; lastBody = null;
    await startLast(); await page.clock.runFor(50);
    await page.fill('#answerText', lastAnswer); await page.click('#answerBtn');
    await page.waitForURL(/#\/feedback/);
    await page.clock.runFor(50); // hashchange의 화면 렌더까지 진행한다.
    await page.waitForSelector('#screen-feedback:not([hidden]) .processing-card[aria-busy=true]');
    for (let i = 0; i < 100 && !releaseLast; i++) await new Promise((r) => setTimeout(r, 10));
    if (!releaseLast) throw new Error('마지막 답변 요청 없음');
  };
  await submitLast();
  check(await page.locator('.processing-card[aria-busy=true]').isVisible(), '텍스트 마지막 답변: 평가 응답 전 분석 화면 자동 전환');
  check((await page.evaluate(async () => (await import('/core/state.js')).state.session.state)) === 'completing' && reportReads === 0, '마지막 답변 수락 전에는 완료·보고서 성공으로 표시하지 않음');
  check(lastBody.type === 'turn.text' && lastBody.payload.text === lastAnswer, '최종 답변 본문은 종료 대신 정상 제출');
  releaseLast();
  await page.waitForSelector('.report-overview');
  check(reportReads === 1, '평가 완료 응답 후 보고서 조회·결과 표시');

  finalResult = 'error';
  await submitLast(); releaseLast();
  await page.waitForURL(/#\/room/);
  check(await page.locator('#textAnswer').isVisible() && await page.inputValue('#answerText') === lastAnswer && (await page.locator('#roomError').innerText()).includes('분석 요청 지연 시험'), '텍스트 마지막 답변 오류: 면접실과 입력 답변 복구');

  finalResult = 'blind';
  await submitLast(); releaseLast();
  await page.waitForSelector('#confirmDialog[open]');
  check(page.url().endsWith('#/room') && reportReads === 1, '마지막 답변 블라인드 거절: 결과 대신 같은 질문으로 복구');
  await page.click('#confirmOk');
  check((await page.locator('#roomTitle').innerText()).includes('마지막으로'), '마지막 질문 재답변 유지');
}
