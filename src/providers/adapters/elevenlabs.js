// 서버 전용 SDK 어댑터. 세션 문장 선택·동의·예산은 tts.js와 공통 caller가 담당한다.
let sdkPromise;
const prepareSdk = () => sdkPromise ||= import('@elevenlabs/elevenlabs-js');

export function createElevenlabsAdapter({ apiKey, baseUrl, model, voiceId, timeoutMs = 15000, maxAudioBytes = 2 * 1024 * 1024, fetchFn = (...a) => globalThis.fetch(...a) }) {
  if (!apiKey || !baseUrl || !model || !voiceId) throw new Error('elevenlabs not configured');
  const base = String(baseUrl).replace(/\/+$/, '');
  const fail = (msg, props) => Object.assign(new Error(msg), props);
  return {
    name: 'elevenlabs',
    model,
    prepare: prepareSdk,
    async synthesize({ text, voiceId: selectedVoiceId = voiceId }) {
      const { ElevenLabsClient } = await prepareSdk();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const t0 = Date.now();
      let transportError, contentType;
      // apiKey는 서버 환경 설정에서만 받는다. 환경 기본값도 SDK가 지원한다.
      const client = new ElevenLabsClient({
        apiKey, baseUrl: base,
        fetch: async (url, options) => {
          // 기존 BASE_URL은 /v1까지 포함한다. SDK가 붙인 v1만 제거해 설정·스텁 계약을 유지한다.
          const endpoint = String(url).replace(`${base}/v1/`, `${base}/`);
          try {
            const res = await fetchFn(endpoint, { ...options, headers: Object.fromEntries(new Headers(options?.headers)), redirect: 'error', signal: controller.signal });
            if (res.status === 429) throw fail('elevenlabs rate limited', { code: 429, retryable: false });
            if (!res.ok) throw fail('elevenlabs upstream error', { code: res.status >= 500 ? 503 : 502, retryable: false });
            contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            if (!/^audio\/[a-z0-9.+-]+$/.test(contentType)) throw fail('elevenlabs bad content-type', { code: 502, invalid: true });
            if (Number(res.headers.get('content-length')) > maxAudioBytes) {
              await res.body?.cancel();
              throw fail('elevenlabs audio too large', { code: 502, invalid: true });
            }
            return res;
          } catch (e) { transportError = e; throw e; }
        },
      });
      let reader;
      try {
        const stream = await client.textToSpeech.convert(selectedVoiceId, { text, modelId: model }, {
          maxRetries: 0, timeoutInSeconds: timeoutMs / 1000, abortSignal: controller.signal,
        });
        reader = stream.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxAudioBytes) throw fail('elevenlabs audio too large', { code: 502, invalid: true });
          chunks.push(value);
        }
        if (!size) throw fail('elevenlabs empty audio', { code: 502, invalid: true });
        const audio = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
        return { provider: 'elevenlabs', model, usage: { chars: [...text].length }, latency_ms: Date.now() - t0, audio, contentType };
      } catch (error) {
        const e = transportError || error;
        if (controller.signal.aborted || e?.name === 'AbortError') throw fail('elevenlabs timeout', { code: 504, retryable: false, timeout: true });
        if (e?.code && typeof e.code === 'number') throw e;
        throw fail('elevenlabs network error', { code: 503, retryable: false });
      } finally {
        clearTimeout(timer);
        controller.abort();
        await reader?.cancel().catch(() => {});
      }
    },
  };
}
