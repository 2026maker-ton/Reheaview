// 답변별 코멘트와 민감 정보 위험 표시(결과 화면용). 모두 결정적 규칙이며 AI 호출이 아니다(검증 전 참고).
// 위험 표시는 "답변에 학교·가정 배경을 짐작하게 하는 표현이 있다"는 뜻이다. 어떤 표현이었는지(원문)는 결과에 다시 싣지 않고 종류만 알린다(블라인드 면접 원칙).

// 짧은 호칭(형·누나…)은 단어 일부(모형·유형)로 오인하기 쉬워 앞이 한글이 아니고 뒤에 조사가 올 때만 본다. 직업 단어도 "대표적·교사용" 같은 파생어는 제외한다.
const FAMILY = String.raw`(?<![가-힣])(?:아버지|어머니|아버님|어머님|아빠|엄마|부모님|부모|할아버지|할머니|삼촌|이모|고모|외삼촌|사촌|친척|(?:형|누나|오빠|언니)(?=[이가는은의도께]))`;
const JOB = String.raw`(?:교수|의사|변호사|판사|검사|교사|선생님|교장|회사|대표|사장|임원|이사|회장|원장|공무원|기자|박사|연구원|사업|CEO|건물주|재벌)(?![적성])`;

// 출신 학교 이름은 "고유 이름 + 학교급"일 때만 본다. "고등학교 때/시절"처럼 학교급만 말하거나
// "제가 다니던 고등학교"처럼 꾸미는 말이 앞에 오면 특정 학교가 드러나지 않으므로 막지 않는다.
const SCHOOL_SUFFIX = String.raw`(?:고등학교|여고|여자고)`;
const SCHOOL_GENERIC = new Set([
  '저희', '우리', '그', '이', '저', '모든', '각', '같은', '다른', '어떤', '무슨',
  '일반', '공립', '사립', '특성화', '자율', '특목', '지역', '출신', '졸업', '재학', '입학',
  '근처', '인근', '시내', '전국', '국내', '해외', '외국', '학교', '여고', '여자고', '고등학교', '중학교', '초등학교',
  // 때·시기를 가리키는 말은 특정 학교가 아니다(작년 고등학교, 당시 고등학교).
  '작년', '올해', '내년', '재작년', '당시', '예전', '평소', '어릴', '고교', '중등', '초등', '때', '시절',
  '처음', '먼저', '특히', '주로', '보통', '늘', '항상', '다시', '아직', '이미', '직접',
]);
// 명확한 문장 연결 표현만 제외한다. '전·도·인' 같은 한 글자를 어미로 보면
// 대전·송도·용인처럼 실제 학교 이름까지 누락된다.
const SCHOOL_WORD_ENDING = /(?:은|는|을|를|에서|에게|께|까지|부터|보다|처럼|하고|던|한|된|할)$/;
const SCHOOL_SEP = String.raw`[\s.·,_-]*`;
const SCHOOL_GAP = String.raw`[\s.·,_-]+`;
const spaced = (word) => [...word].join(SCHOOL_SEP);
const SCHOOL_SPACED_SUFFIX = `(?:${['고등학교', '여자고', '여고'].map(spaced).join('|')})`;
const SCHOOL_TYPES = ['외고', '외국어고', '과학고', '영재고', '과학영재', '자사고', '자율형사립', '특목고', '국제고', '예술고', '마이스터고'];
// '과학 고전'의 '고전'을 과학고로 잘라 읽지 않는다. 학교급 연장 또는 조사·경계를 확인한다.
const SCHOOL_TYPE_END = String.raw`(?=등학교|학교|에서|에선|으로|출신|학생|였|이었|입니다|이라|(?:은|는|을|를|의|에|도|와|과|로|라서|라|인)(?:[^가-힣]|$)|[^가-힣]|$)`;
function isSchoolName(word) {
  const name = word.replace(/[\s.·,_-]+/g, '');
  return !SCHOOL_GENERIC.has(name) && !SCHOOL_WORD_ENDING.test(name);
}

const RULES = [
  { id: 'family_job', level: 'high', label: '가족의 직업·직장', re: new RegExp(`${FAMILY}[^.?!\\n]{0,14}${JOB}|${JOB}[^.?!\\n]{0,6}${FAMILY}`, 'g') },
  {
    id: 'school_name', level: 'high', label: '출신 학교 이름',
    re: new RegExp(String.raw`(?<![가-힣])([가-힣]{2,10})${SCHOOL_SUFFIX}`, 'g'),
    // 띄어쓰기·기호로만 벌어진 이름(한빛 고등학교, 한.빛.고등학교)은 원문에서 찾아 가림 구간까지 남긴다.
    // 이름은 한 단어 또는 한 글자씩 벌린 형태다. 문장 전체를 붙여 앞말까지 학교명으로 만들지 않는다.
    looseRe: new RegExp(String.raw`(?<![가-힣])([가-힣]{2,10}|[가-힣](?:${SCHOOL_GAP}[가-힣]){1,9})${SCHOOL_SEP}${SCHOOL_SPACED_SUFFIX}`, 'g'),
    accept: (m) => isSchoolName(m[1]),
  },
  {
    id: 'school_type', level: 'medium', label: '학교 유형',
    re: new RegExp(`(?:${SCHOOL_TYPES.filter((s) => s !== '자율형사립').join('|')}|자율형\\s*사립)${SCHOOL_TYPE_END}`, 'g'),
    obfuscatedRe: new RegExp(`(?:${SCHOOL_TYPES.map(spaced).join('|')})${SCHOOL_TYPE_END}`, 'g'),
  },
  { id: 'exam_number', level: 'high', label: '수험번호', re: /수험\s*번호\s*[:은는이가]?\s*\d{4,}|수험\s*번호/g },
  { id: 'own_name', level: 'high', label: '본인 이름', re: /제\s*이름은\s*[가-힣]{2,4}|성함은\s*[가-힣]{2,4}/g },
  { id: 'social_position', level: 'medium', label: '사회적·경제적 위치', re: /금수저|재벌|부잣집|부자\s*집안|집안이\s*(?:좋|넉넉|어렵)|가정\s*형편|건물주|강남에서|유학파|해외에서\s*자라/g },
];

// text → { level: 'none'|'medium'|'high', categories: [{ id, label, level }], spans: [[start,end],…] } (spans는 서버 내부에서 가림 처리에만 쓴다)
// loose: 학교 유형은 원문 경계를 보존한 채 글자 사이 우회를 찾는다. 이 경로는 분류만 더하므로
// sanitizeForAi는 위치를 모르는 위험을 unmasked로 보고 전송을 멈춘다.
export function detectBlindRisk(text, { loose = false } = {}) {
  const t = String(text || '');
  const categories = []; const spans = [];
  for (const r of RULES) {
    r.re.lastIndex = 0;
    let m; let hit = false;
    while ((m = r.re.exec(t))) {
      if (m[0].length === 0) { r.re.lastIndex++; continue; }
      // accept는 "고유 이름 + 학교급"처럼 맥락을 봐야 하는 규칙의 오탐을 거른다(계기는 고등학교, 다니던 고등학교).
      if (r.accept && !r.accept(m)) continue;
      hit = true; spans.push([m.index, m.index + m[0].length]);
    }
    // 띄어쓰기·기호로 벌어진 이름은 원문에서 위치를 찾을 수 있으므로 가림 구간까지 남긴다.
    if (r.looseRe) {
      r.looseRe.lastIndex = 0;
      while ((m = r.looseRe.exec(t))) {
        if (r.accept && !r.accept(m)) continue;
        hit = true; spans.push([m.index, m.index + m[0].length]);
      }
    }
    if (hit) categories.push({ id: r.id, label: r.label, level: r.level });
  }
  if (loose) {
    const squeezed = t.replace(/[\s.·,_-]+/g, '');
    for (const r of RULES) {
      // 학교명은 위의 원문 기반 looseRe가 맡는다. 문장 전체 공백 제거는 번호 표지에만 쓴다.
      if (categories.some((c) => c.id === r.id)) continue;
      const re = r.obfuscatedRe || (r.id === 'exam_number' ? r.re : null);
      if (!re) continue;
      re.lastIndex = 0;
      if (re.test(r.obfuscatedRe ? t : squeezed)) categories.push({ id: r.id, label: r.label, level: r.level, loose: true });
    }
  }
  const level = categories.some((c) => c.level === 'high') ? 'high' : categories.length ? 'medium' : 'none';
  return { level, categories, spans };
}

// 감지된 표현을 가린 텍스트. 겹치는 구간은 합친다.
export function maskRisk(text, spans) {
  const t = String(text || '');
  if (!spans?.length) return t;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of sorted) { const last = merged[merged.length - 1]; if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push([...s]); }
  let out = ''; let i = 0;
  for (const [a, b] of merged) { out += t.slice(i, a) + '[가림]'; i = b; }
  return out + t.slice(i);
}

const DIM = {
  relevance: { label: '질문 적합성', fix: '질문에 먼저 직접 답하고(결론), 그 뒤에 설명을 이어 보세요.', good: '질문의 핵심에 바로 답했습니다.' },
  specificity: { label: '구체성', fix: '본인이 직접 한 행동과 결과(수치·관찰)를 한 가지씩 넣어 보세요.', good: '본인의 행동과 결과가 구체적으로 드러났습니다.' },
  reasoning: { label: '논리', fix: '그렇게 판단한 이유나 비교한 대안, 한계를 한 문장 덧붙여 보세요.', good: '판단의 이유가 설명됐습니다.' },
};

// 질문별 한 줄 코멘트: 가장 낮은 차원에서 고칠 점 하나, 가장 높은 차원에서 잘한 점 하나. 근거는 turn_score(면접 중 참고 점수)와 제한시간 초과 여부다.
export function answerComment({ turn_score: ts, cut_off: cut = false, text = '' } = {}) {
  const n = [...String(text).trim()].length;
  if (!ts) return { good: null, fix: n < 20 ? '답변이 너무 짧아 판단하기 어렵습니다. 핵심을 두세 문장으로 말해 보세요.' : null, basis: '참고 점수가 없어 답변 길이만 살폈습니다.', weakest: null, strongest: null };
  const keys = Object.keys(DIM);
  const sorted = [...keys].sort((a, b) => ts[a] - ts[b]);
  const weakest = sorted[0]; const strongest = sorted[sorted.length - 1];
  const fix = ts[weakest] <= 2 ? DIM[weakest].fix : (cut ? '제한시간 안에 핵심을 먼저 말하는 연습을 해 보세요.' : null);
  const good = ts[strongest] >= 3 ? DIM[strongest].good : null;
  return {
    good, fix: fix || (good ? null : DIM[weakest].fix),
    basis: `면접 중 참고 점수(질문 적합성 ${ts.relevance}·구체성 ${ts.specificity}·논리 ${ts.reasoning}, 1~4) 중 가장 낮은 "${DIM[weakest].label}"과 가장 높은 "${DIM[strongest].label}"을 근거로 한 규칙 기반 코멘트입니다.${cut ? ' 제한시간 초과 표시도 반영했습니다.' : ''}`,
    weakest, strongest,
  };
}
