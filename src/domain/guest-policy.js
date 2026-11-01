export const GUEST_AI_NOTICE_VERSION = 'guest-ai-2026-11-01';
export const guestAiReady = (record) => record?.guest_ai === true
  && record.age_18_confirmed === true && record.notice_version === GUEST_AI_NOTICE_VERSION;
