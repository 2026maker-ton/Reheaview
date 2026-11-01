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

  // 실제 목소리 모양의 주기 신호 뒤 정적에도 동일한 30초 기준을 쓴다.
  let talking = true; let cutSegments = 0;
  mic.read = () => talking ? Float32Array.from({ length: 2048 }, (_, i) => .1 * Math.sin(2 * Math.PI * 200 * i / 48000)) : new Float32Array(2048);
  Recorder.prototype.stop = function () { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice']) }); this.onstop?.(); };
  const spoken = createCapture(mic, { onSegment: () => cutSegments++ });
  spoken.start();
  for (let i = 0; i < 20; i++) { now += 50; tick(); }
  assert.equal(spoken.spoke, true);
  talking = false;
  for (let i = 0; i < 599; i++) { now += 50; tick(); }
  assert.equal(cutSegments, 0, 'even 29.95 seconds after speaking is too early');
  talking = true;
  for (let i = 0; i < 20; i++) { now += 50; tick(); }
  talking = false;
  for (let i = 0; i < 599; i++) { now += 50; tick(); }
  assert.equal(cutSegments, 0, 'resuming speech resets the silence wait');
  now += 50; tick(); await Promise.resolve();
  assert.equal(cutSegments, 1);
});
