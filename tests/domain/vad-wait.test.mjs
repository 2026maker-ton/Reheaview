import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCapture } from '../../public/core/vad.js';

test('capture waits 30 seconds of initial silence, discards it, and never transcribes noise', async (t) => {
  let now = 0; let tick; let skipped = 0; let segments = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', (fn) => { tick = fn; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const originalWindow = globalThis.window; const originalRecorder = globalThis.MediaRecorder;
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  globalThis.window = { MediaRecorder: Recorder }; globalThis.MediaRecorder = Recorder;
  t.after(() => { globalThis.window = originalWindow; globalThis.MediaRecorder = originalRecorder; });
  const mic = { threshold: .02, stream: {}, sampleRate: 48000, read: () => new Float32Array(2048) };
  const capture = createCapture(mic, { onSegment: () => segments++, onNoSpeech: () => skipped++ });
  capture.start();
  for (now = 50; now < 30_000; now += 50) tick();
  assert.equal(skipped, 0); assert.equal(segments, 0);
  now = 30_000; tick(); await Promise.resolve();
  assert.equal(skipped, 1); assert.equal(segments, 0);
  assert.equal(await capture.stop(), null);

  // 실제 발화 후에는 3초를 쓴다. 초기 30초 대기와 독립적이며, 다시 말하면 3초가 새로 시작된다.
  let talking = true; let cutSegments = 0;
  mic.read = () => talking ? Float32Array.from({ length: 2048 }, (_, i) => .1 * Math.sin(2 * Math.PI * 200 * i / 48000)) : new Float32Array(2048);
  Recorder.prototype.stop = function () { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice']) }); this.onstop?.(); };
  const spoken = createCapture(mic, { onSegment: () => cutSegments++ });
  spoken.start();
  for (let i = 0; i < 20; i++) { now += 50; tick(); }
  assert.equal(spoken.spoke, true);
  talking = false;
  for (let i = 0; i < 59; i++) { now += 50; tick(); }
  assert.equal(cutSegments, 0, '2.95 seconds after speaking is too early');
  talking = true;
  for (let i = 0; i < 20; i++) { now += 50; tick(); }
  talking = false;
  for (let i = 0; i < 59; i++) { now += 50; tick(); }
  assert.equal(cutSegments, 0, 'resuming speech resets the silence wait');
  now += 50; tick(); await Promise.resolve();
  assert.equal(cutSegments, 1);

  // 발화 후 임계값보다 큰 비주기적 소음도 마지막 말소리 시각을 갱신하지 않는다.
  let noiseSeed = 12345;
  const noise = Float32Array.from({ length: 2048 }, () => { noiseSeed = (1664525 * noiseSeed + 1013904223) >>> 0; return ((noiseSeed / 2 ** 32) * 2 - 1) * .15; });
  talking = true;
  let noiseSegments = 0;
  const noisy = createCapture(mic, { onSegment: () => noiseSegments++ });
  noisy.start();
  for (let i = 0; i < 20; i++) { now += 50; tick(); }
  assert.equal(noisy.spoke, true);
  mic.read = () => noise;
  for (let i = 0; i < 59; i++) { now += 50; tick(); }
  assert.equal(noiseSegments, 0);
  // 주기성 검사는 100ms마다 하므로 소리 종류가 바뀌는 경계에는 최대 한 표본의 여유가 있다.
  for (let i = 0; i < 3; i++) { now += 50; tick(); }
  await Promise.resolve();
  assert.equal(noiseSegments, 1, 'background noise must not postpone the finish beyond the 3-second sampling boundary');
});

test('overlapping recorder stops share the final audio; an empty speech segment reports an error', async (t) => {
  let now = 0; let tick; let finish;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', (fn) => { tick = fn; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const previousWindow = globalThis.window; const previousRecorder = globalThis.MediaRecorder;
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; finish = () => { this.ondataavailable?.({ data: new Blob(['last words']) }); this.onstop?.(); }; }
  }
  globalThis.window = { MediaRecorder: Recorder }; globalThis.MediaRecorder = Recorder;
  t.after(() => { globalThis.window = previousWindow; globalThis.MediaRecorder = previousRecorder; });
  const mic = { threshold: .02, stream: {}, sampleRate: 48000, read: () => Float32Array.from({ length: 2048 }, (_, i) => .1 * Math.sin(2 * Math.PI * 200 * i / 48000)) };
  const capture = createCapture(mic, { onSegment() {} });
  capture.start();
  for (let i = 0; i < 20; i++) { now += 50; tick(); }
  const first = capture.stop(); const second = capture.stop(); finish();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b); assert.equal(await a.text(), 'last words');

  Recorder.prototype.stop = function () { this.state = 'inactive'; this.onstop?.(); };
  let error = null; let sent = 0;
  const empty = createCapture(mic, { onSegment: () => sent++, onError: (e) => { error = e; } });
  empty.start();
  for (let i = 0; i < 20; i++) { now += 50; tick(); }
  mic.read = () => new Float32Array(2048);
  now += 3_000; tick(); await Promise.resolve();
  assert.equal(sent, 0); assert.match(error?.message, /녹음된 음성/);
});
