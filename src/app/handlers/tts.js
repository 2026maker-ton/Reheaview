// 서버 TTS 프록시(WP-B6): POST /sessions/:id/tts {target}. 합성할 문장은 요청이 아니라 세션에서만 가져온다(임의 텍스트 불가).
// 성공 → 오디오 바이트(저장 없음). 차단·실패·미설정 → 204 + X-TTS-Fallback: browser(본문 없음)로 브라우저 TTS 대체.
import { SPOKEN } from '../../domain/interview-format.js';
import { ttsVoices, ttsMessage } from '../../domain/tts-voices.js';
const TARGETS = new Set(['current_question', 'last_utterance', ...Object.keys(SPOKEN).map((k) => `fixed_${k}`)]);

export function createTtsHandlers(d) {
  const { config, store, err, caller, elevenlabs, requestContext, checkRate } = d;
  const fallback = (trace, reason = trace?.reason || (trace?.mode === 'mock' ? 'disabled' : 'provider_error')) => new Response(null, { status: 204, headers: { 'X-TTS-Fallback': 'browser', 'X-TTS-Reason': reason, 'Cache-Control': 'no-store', ...(trace ? { 'X-Provider-Trace': JSON.stringify(trace) } : {}) } });

  function status(owner, params = new URLSearchParams()) {
    const pid = params.get('profile_id'), sid = params.get('session_id');
    if (pid && sid) return err('validation_error', '하나의 연습만 선택하세요.', 422);
    const session = sid ? store.getSession(owner, sid) : null;
    const profile = pid ? store.getProfile(owner, pid) : session ? store.getProfile(owner, store.getVersion(session.profile_version_id)?.profile_id) : null;
    if ((pid && !profile) || (sid && !session)) return err('not_found', '연습을 찾을 수 없습니다.', 404);
    const ctx = requestContext(owner, { synthetic: session ? session.server_synthetic === true : profile?.synthetic === true, forceMock: !!session?.highschool_mock || (profile?.org_type === 'highschool' && !profile.synthetic) });
    const p = caller.plan('speech.synthesize', ctx);
    const configured = !!elevenlabs;
    const live = configured && p.route.provider === 'elevenlabs' && p.live;
    const reason = !configured ? 'not_configured' : p.route.provider !== 'elevenlabs' ? 'disabled' : p.reason;
    return { status: 200, body: {
      provider: live ? 'elevenlabs' : 'browser', configured, live, reason,
      message: live ? 'ElevenLabs AI 합성 음성으로 면접 질문을 읽습니다.' : ttsMessage(reason),
      voices: ttsVoices(config).map(({ key, name, description }) => ({ key, name, description })),
      default_voice: 'default',
    } };
  }

  function textOf(s, target) {
    if (target.startsWith('fixed_')) return SPOKEN[target.slice(6)] || '';
    if (target === 'current_question') return s.questions?.[s.q_index]?.text || '';
    const evs = store.events.get(s.id) || [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const p = evs[i].payload;
      if (evs[i].type === 'assistant.message' && p?.speaker_id !== 'user' && typeof p?.utterance === 'string' && p.utterance) return p.utterance;
    }
    return '';
  }

  async function synthesize(owner, id, body, requestId) {
    const target = body?.target;
    if (!TARGETS.has(target)) return err('validation_error', '허용된 면접관 문장 target이 필요합니다.', 422, { requestId });
    const s = store.getSession(owner, id);
    if (!s || s.state === 'deleting' || s.state === 'deleted') return err('not_found', '세션을 찾을 수 없습니다.', 404);
    const voice = ttsVoices(config).find((v) => v.key === (body.voice_key ?? 'default'));
    if (!voice) return err('validation_error', '목록에 있는 면접관 음성을 선택해 주세요.', 422, { requestId });
    const text = textOf(s, target); // 요청 본문의 text 등 다른 필드는 읽지 않는다.
    if (!text) return err('validation_error', '읽어 줄 문장이 아직 없습니다.', 422, { requestId });
    const limited = checkRate(owner, 'tts');
    if (limited) return limited;
    if (!elevenlabs) return fallback(null, 'not_configured');
    if ([...text].length > config.elevenlabs.charCap) return fallback(null, 'char_cap');
    const cap = config.elevenlabs.maxAudioBytes;
    const ctx = requestContext(owner, { forceMock: !!s.highschool_mock, synthetic: s.server_synthetic === true });
    // 음성 게이트가 열린 경우에만 SDK를 로드해 다른 경로의 시작 비용을 늘리지 않는다.
    const plan = caller.plan('speech.synthesize', ctx);
    if (plan.route.provider !== 'elevenlabs') return fallback(null, 'disabled');
    if (plan.live) {
      try { await elevenlabs.prepare(); } catch { return fallback(null, 'sdk_unavailable'); }
    }
    const res = await caller.call('speech.synthesize', {
      ctx,
      mockAlias: 'none',
      reserve: { key: `session:${s.id}`, amount: ([...text].length / 1000) * config.elevenlabs.pricePer1kChars },
      invoke: (a) => a.synthesize({ text, voiceId: voice.id }),
      mock: () => null, fallback: () => null,
      validate: (o) => o?.audio?.byteLength > 0 && o.audio.byteLength <= cap && /^audio\//.test(o.contentType || ''),
    });
    if (res.value === null) return fallback(res.trace);
    return new Response(res.value.audio, { status: 200, headers: { 'Content-Type': res.value.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-TTS-Voice': voice.key, 'X-Provider-Trace': JSON.stringify(res.trace) } });
  }

  return { synthesize, status };
}
