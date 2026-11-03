// ElevenLabs 공식 TTS 스킬의 기본 제공 음성. 임의 voice_id·모델·URL은 요청에서 받지 않는다.
export const TTS_DEFAULTS = Object.freeze({ baseUrl: 'https://api.elevenlabs.io/v1', model: 'eleven_flash_v2_5', voiceId: 'JBFqnCBsd6RMkjVDRZzb' });
const PRESETS = Object.freeze([
  { key: 'george', name: 'George', description: '남성 · 내레이션', id: 'JBFqnCBsd6RMkjVDRZzb' },
  { key: 'sarah', name: 'Sarah', description: '여성 · 부드러운 목소리', id: 'EXAVITQu4vr4xnSDxMaL' },
  { key: 'daniel', name: 'Daniel', description: '남성 · 차분한 목소리', id: 'onwK4e9ZLuTAKqWW03F9' },
  { key: 'charlotte', name: 'Charlotte', description: '여성 · 대화형', id: 'XB0fDUnXU5powFXDhCwa' },
]);
export function ttsVoices(config) {
  const id = config.elevenlabs.voiceId;
  const preset = PRESETS.find((v) => v.id === id);
  return [{ key: 'default', name: preset ? `기본 (${preset.name})` : '운영자 기본 음성', description: '서버에서 지정한 음성', id }, ...PRESETS];
}
export function ttsMessage(reason) {
  return ({
    disabled: '브라우저 음성이 기본으로 설정되어 있습니다.',
    not_configured: 'ElevenLabs 연결 설정이 완료되지 않아 브라우저 음성을 사용합니다.',
    live_ack_missing: 'ElevenLabs 사용이 아직 활성화되지 않아 브라우저 음성을 사용합니다.',
    synthetic_only: '현재 예시 자료에서만 ElevenLabs 음성을 사용할 수 있습니다.',
    real_data_ack_missing: '실제 자료의 음성 처리 설정이 필요합니다.',
    consent_missing: '성인 확인과 AI 처리 동의가 필요합니다.',
    highschool_mock: '이 연습에서는 외부 음성을 사용할 수 없습니다. 이용 동의를 확인해 주세요.',
    kill_switch: 'AI가 꺼져 있어 브라우저 음성을 사용합니다.',
    budget_cap: '음성 사용 한도에 도달해 브라우저 음성으로 이어갑니다.',
    rate_limited: '음성 요청이 많아 브라우저 음성으로 이어갑니다.',
    timeout: '서버 음성이 지연되어 브라우저 음성으로 이어갑니다.',
    char_cap: '질문이 길어 브라우저 음성으로 읽습니다.',
    sdk_unavailable: '서버 음성 모듈을 불러오지 못해 브라우저 음성으로 이어갑니다.',
  })[reason] || '서버 음성을 사용할 수 없어 브라우저 음성으로 이어갑니다.';
}
