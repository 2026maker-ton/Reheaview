// 무음·잡음 구간에서 음성 인식(Whisper 계열)이 지어내는 정형 문구("다음 영상에서 만나요" 등)는 답변이 아니다. 해당 문장만 지우고 남은 말이 없으면 빈 전사(=답변 없음)로 본다.
const PHRASES = [/다음\s*영상(에서|에|도)?\s*(만나요|만나뵙겠습니다|봬요|뵙겠습니다)/g, /시청해\s*주셔서\s*감사(합니다|해요)/g, /구독과?\s*좋아요(\s*부탁(드립니다|해요))?/g, /좋아요와?\s*구독(\s*부탁(드립니다|해요))?/g, /영상이\s*도움이\s*되셨(다면|으면)[^.!?]*/g, /자막\s*(제공|제작)[^.!?]*/g, /MBC\s*뉴스[^.!?]*/g, /한글\s*자막[^.!?]*/g, /Thanks\s+for\s+watching!?/gi];
export function stripSttHallucination(text) {
  let t = String(text || '');
  for (const re of PHRASES) t = t.replace(re, ' ');
  return t.replace(/\s+([.!?。])/g, '$1').replace(/([.!?。])\1+/g, '$1').replace(/^[\s.!?。,]+/, '').replace(/\s+/g, ' ').trim();
}
export const NO_ANSWER_TEXT = '(답변 없음)';
