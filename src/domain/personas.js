// 면접관 페르소나(docs/personas/personas.v2.json): 역할·관점·대화 태도만 정의한다. 질문 문장은 만들지 않는다.
// 서버는 이 모듈로 (1) 설정 파일을 스키마대로 검증하고 (2) 선택 가능한 조합을 계산하고 (3) 질문 설계·꼬리질문 프롬프트에 관점 블록을 붙이고 (4) 생성 문장을 공통 금지 규칙으로 다시 검사한다.
import { PERSONAS_V2 } from './personas-data.js';

const ID = /^[a-z][a-z0-9_]*$/;
const POLICY_KEYS = ['is_real_person', 'claims_real_university_affiliation', 'claims_official_admissions_authority', 'may_impersonate_named_professor', 'may_decide_admission_outcome', 'may_generate_questions', 'may_generate_follow_up_questions', 'may_invent_facts'];
const isStr = (v) => typeof v === 'string' && v.length > 0;
const strArr = (v, min = 1) => Array.isArray(v) && v.length >= min && v.every(isStr);

// personas.schema.v2.json의 제약을 그대로 옮긴 검사(런타임에 JSON Schema 라이브러리를 쓰지 않는다). 위반 목록을 돌려준다.
export function validatePersonaConfig(cfg) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!cfg || typeof cfg !== 'object') return ['config is not an object'];
  const top = ['schema_version', 'product', 'locale', 'status', 'purpose', 'persona_policy', 'global_guardrails', 'personas', 'recommended_combinations'];
  for (const k of top) if (!(k in cfg)) bad(`missing ${k}`);
  for (const k of Object.keys(cfg)) if (!top.includes(k)) bad(`unknown top-level key ${k}`);
  if (cfg.schema_version !== '2.0.0') bad('schema_version');
  if (cfg.product !== 'Reheaview') bad('product');
  if (cfg.locale !== 'ko-KR') bad('locale');
  if (!['proposed_configuration', 'active_configuration', 'deprecated'].includes(cfg.status)) bad('status');
  if (!isStr(cfg.purpose)) bad('purpose');
  const pol = cfg.persona_policy || {};
  for (const k of POLICY_KEYS) if (pol[k] !== false) bad(`persona_policy.${k} must be false`);
  if (!isStr(pol.description)) bad('persona_policy.description');
  if (!strArr(cfg.global_guardrails) || new Set(cfg.global_guardrails).size !== cfg.global_guardrails.length) bad('global_guardrails');
  if (!Array.isArray(cfg.personas) || cfg.personas.length < 5) bad('personas must have at least 5 items');
  const ids = new Set();
  for (const p of cfg.personas || []) {
    const w = `persona ${p?.id}`;
    if (!ID.test(p?.id || '')) bad(`${w}: id`);
    ids.add(p?.id);
    for (const k of ['name', 'short_name', 'role_summary', 'purpose']) if (!isStr(p?.[k])) bad(`${w}: ${k}`);
    if (!['active', 'conditional_disabled', 'disabled'].includes(p?.availability)) bad(`${w}: availability`);
    for (const k of ['assessment_lens', 'behavior_rules', 'prohibited_behaviors', 'selection_tags']) if (!strArr(p?.[k])) bad(`${w}: ${k}`);
    const cs = p?.communication_style || {};
    if (!isStr(cs.tone) || !isStr(cs.manner) || !strArr(cs.avoid_manner)) bad(`${w}: communication_style`);
    // 페르소나 파일에는 질문 문장·질문 생성 규칙이 없어야 한다(스키마의 additionalProperties:false).
    const known = ['id', 'name', 'short_name', 'availability', 'role_summary', 'purpose', 'assessment_lens', 'communication_style', 'behavior_rules', 'prohibited_behaviors', 'selection_tags', 'activation_requirements', 'enabled_by_default'];
    for (const k of Object.keys(p || {})) if (!known.includes(k)) bad(`${w}: unknown key ${k}`);
    if (p?.id === 'faculty_research_lens') {
      if (p.availability !== 'conditional_disabled') bad(`${w}: availability must be conditional_disabled`);
      if (p.enabled_by_default !== false) bad(`${w}: enabled_by_default must be false`);
      if (!strArr(p.activation_requirements)) bad(`${w}: activation_requirements`);
    }
  }
  for (const c of cfg.recommended_combinations || []) {
    if (!ID.test(c?.id || '') || !isStr(c?.label) || !isStr(c?.condition) || !strArr(c?.persona_ids)) bad(`combination ${c?.id}`);
    for (const pid of c?.persona_ids || []) if (!ids.has(pid)) bad(`combination ${c?.id}: unknown persona ${pid}`);
  }
  return errors;
}

const cfgErrors = validatePersonaConfig(PERSONAS_V2);
if (cfgErrors.length) throw new Error(`personas.v2.json 검증 실패: ${cfgErrors.slice(0, 3).join('; ')}`); // 잘못된 설정으로 서버가 뜨지 않게 한다.

export const PERSONA_CONFIG = PERSONAS_V2;
export const GUARDRAILS = PERSONAS_V2.global_guardrails;
export const DEFAULT_COMBINATION = 'student_record_comprehensive_default';
const byId = new Map(PERSONAS_V2.personas.map((p) => [p.id, p]));

// 교수 연구분야 특화형 활성화: 공식 교수 프로필·학술 출처가 모두 VERIFIED인 자료가 있을 때만 켠다.
// 지금은 출처 등록부(source registry)와 검수 절차가 없으므로 어떤 입력으로도 켜지지 않는다(설계서 §9.5).
export function facultyActivation(inst = null) {
  const list = Array.isArray(inst?.faculty_profiles) ? inst.faculty_profiles : [];
  const ok = list.some((f) => f?.status === 'VERIFIED' && f.disambiguated === true && f.department_linked === true && Array.isArray(f.sources) && f.sources.length > 0 && f.sources.every((s) => s?.status === 'VERIFIED'));
  return ok ? { ok: true, missing: [] } : { ok: false, missing: byId.get('faculty_research_lens').activation_requirements };
}

// 화면용 목록: 비활성 페르소나는 이유와 함께 내려 보내 회색으로 보여 준다.
export function publicPersonas(inst = null) {
  const fac = facultyActivation(inst);
  const items = PERSONAS_V2.personas.map((p) => {
    const available = p.id === 'faculty_research_lens' ? fac.ok : p.availability === 'active';
    return { id: p.id, name: p.name, short_name: p.short_name, role_summary: p.role_summary, tags: p.selection_tags, available, ...(available ? {} : { unavailable_reason: p.id === 'faculty_research_lens' ? '공식 교수 프로필과 학술 출처가 검증(VERIFIED)된 자료가 아직 없어 사용할 수 없습니다.' : '사용할 수 없습니다.', missing: p.id === 'faculty_research_lens' ? fac.missing : [] }) };
  });
  const okIds = new Set(items.filter((x) => x.available).map((x) => x.id));
  return {
    status: PERSONAS_V2.status, notice: '가상의 면접관 관점입니다. 실제 대학의 면접관·교수·입학사정관이 아니며 평가 기준·합격 여부와 무관합니다.',
    personas: items,
    combinations: PERSONAS_V2.recommended_combinations.map((c) => ({ id: c.id, label: c.label, persona_ids: c.persona_ids, condition: c.condition, selectable: c.persona_ids.every((i) => okIds.has(i)) })),
    default_combination: DEFAULT_COMBINATION,
  };
}

// 요청값(조합 id 또는 페르소나 id 목록) → 검증된 id 목록. 비활성·알 수 없는 id는 오류를 돌려준다.
export function resolvePersonaIds(input, inst = null) {
  let ids;
  if (input === undefined || input === null || input === '') ids = PERSONAS_V2.recommended_combinations.find((c) => c.id === DEFAULT_COMBINATION).persona_ids;
  else if (typeof input === 'string') { const c = PERSONAS_V2.recommended_combinations.find((x) => x.id === input); if (!c) return { error: '알 수 없는 면접관 조합입니다.' }; ids = c.persona_ids; }
  else if (Array.isArray(input) && input.length >= 1 && input.length <= 2) ids = [...new Set(input.map(String))];
  else return { error: '면접관 관점은 1~2개까지 선택할 수 있습니다.' };
  const pub = publicPersonas(inst);
  for (const id of ids) {
    const p = pub.personas.find((x) => x.id === id);
    if (!p) return { error: `알 수 없는 면접관 관점입니다: ${id.slice(0, 40)}` };
    if (!p.available) return { error: `${p.name}은(는) 지금 사용할 수 없습니다. ${p.unavailable_reason}` };
  }
  return { ids };
}

// 단계별로 어떤 관점이 말하는가: 두 관점을 고르면 서류·경험 단계는 서류 검증형, 나머지는 다른 쪽이 맡는다. 한 관점이면 전 단계.
const AFFINITY = {
  document_verifier: ['experience', 'reflection'],
  major_explorer: ['intro', 'academic', 'closing'],
  communication_collaborator: ['intro', 'experience', 'reflection', 'closing'],
  reasoning_examiner: ['academic', 'reflection'],
  faculty_research_lens: ['academic'],
};
export function personaForStage(ids = [], stage) {
  if (!ids.length) return null;
  return ids.find((i) => (AFFINITY[i] || []).includes(stage)) || ids[0];
}
export const personaName = (id) => byId.get(id)?.short_name || id;

// 프롬프트에 붙이는 관점 블록(질문 설계·작성·꼬리질문). 말투·관점만 주고 질문 내용은 주지 않는다. 길이를 줄여 비용을 아낀다.
export function personaBlock(ids = [], { stage = null } = {}) {
  const use = stage ? [personaForStage(ids, stage)].filter(Boolean) : ids;
  if (!use.length) return '';
  const lines = use.map((id) => {
    const p = byId.get(id); if (!p) return '';
    return `- ${p.name}: ${p.role_summary}. 관점: ${p.assessment_lens.slice(0, 4).join(' / ')}. 태도: ${p.communication_style.tone}; ${p.communication_style.manner}. 피할 태도: ${p.communication_style.avoid_manner.join(' / ')}.`;
  }).filter(Boolean);
  return `면접관 관점(가상 역할, 질문 내용이 아니라 초점과 말투만 정함. 실제 교수·입학사정관 사칭 금지):\n${lines.join('\n')}\n공통 금지: ${GUARDRAILS.join(' ')}`;
}

// 생성된 면접관 문장이 공통 금지 규칙을 어기는지 검사한다(정직성·인격 단정, 합격 판단, 모욕·압박, 사칭). true면 통과.
const FORBIDDEN = /거짓말|정직하지|진실성|성실하지|인성이\s*(?:나쁘|부족|안\s*좋)|지능|멍청|한심|바보|불합격|합격\s*(?:가능|할\s*것|못)|떨어질|(?:저는|제가)\s*(?:실제\s*)?(?:교수|입학사정관|면접위원)(?:입니다|이에요)|실제\s*면접관/;
export const personaOutputOk = (text) => !FORBIDDEN.test(String(text || ''));
