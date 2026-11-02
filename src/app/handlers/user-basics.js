// 회원 기본 정보(면접 준비용). 게스트는 사용하지 않는다. 수정·완료 시 비밀번호 확인(온보딩 중 제외).
import { verifyPassword } from '../crypto.js';

const MAX = { student_record: 15_000, activity_summary: 8_000, intro_notes: 4_000 };

function emptyBasics() {
  return { birth_year: null, student_record: '', activity_summary: '', intro_notes: '', onboarding_completed: false, updated_at: null };
}

function publicBasics(row) {
  if (!row) return { ...emptyBasics() };
  return {
    birth_year: row.birth_year ?? null,
    student_record: row.student_record || '',
    activity_summary: row.activity_summary || '',
    intro_notes: row.intro_notes || '',
    onboarding_completed: !!row.onboarding_completed,
    updated_at: row.updated_at || null,
  };
}

function ageFromBirthYear(y) {
  if (!y) return null;
  return new Date().getFullYear() - y;
}

function validateBasics(body, u) {
  const out = {};
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || [...name].length > 20) return { error: 'validation_error', message: '이름은 1~20자로 입력해 주세요.', status: 422 };
    out.name = name;
  }
  if (body.birth_year !== undefined) {
    const y = Number(body.birth_year);
    if (!Number.isInteger(y) || y < 1940 || y > new Date().getFullYear()) {
      return { error: 'validation_error', message: '출생 연도를 확인해 주세요.', status: 422 };
    }
    if (ageFromBirthYear(y) < 18) return { error: 'age_restricted', message: '만 18세 이상만 이용할 수 있습니다.', status: 403 };
    out.birth_year = y;
  }
  if (body.student_record !== undefined) {
    const t = String(body.student_record || '');
    if (t.length > MAX.student_record) return { error: 'validation_error', message: '학생부 요약이 너무 깁니다.', status: 422 };
    out.student_record = t;
  }
  if (body.activity_summary !== undefined) {
    const t = String(body.activity_summary || '');
    if (t.length > MAX.activity_summary) return { error: 'validation_error', message: '활동 요약이 너무 깁니다.', status: 422 };
    out.activity_summary = t;
  }
  if (body.intro_notes !== undefined) {
    const t = String(body.intro_notes || '');
    if (t.length > MAX.intro_notes) return { error: 'validation_error', message: '메모가 너무 깁니다.', status: 422 };
    out.intro_notes = t;
  }
  return { fields: out };
}

function readyToComplete(u, row) {
  return !!(u?.name?.trim()
    && row?.birth_year
    && String(row.student_record || '').trim());
}

export function createUserBasicsHandlers(d) {
  const { store, err, now } = d;

  function get(owner) {
    const u = store.getUser(owner);
    if (u.guest) return err('forbidden', '게스트는 기본 정보를 저장할 수 없습니다.', 403);
    if (!u) return err('not_found', '사용자를 찾을 수 없습니다.', 404);
    return { status: 200, body: publicBasics(store.getUserBasics(owner)) };
  }

  async function patch(owner, body) {
    const u = store.getUser(owner);
    if (!u) return err('not_found', '사용자를 찾을 수 없습니다.', 404);
    if (u.guest) return err('forbidden', '게스트는 기본 정보를 저장할 수 없습니다.', 403);

    const prev = store.getUserBasics(owner) || emptyBasics();
    const onboarding = body?.onboarding === true;
    const finish = body?.finish_onboarding === true;
    if (!onboarding && prev.onboarding_completed) {
      const password = String(body?.password || '');
      if (!password) return err('validation_error', '수정하려면 비밀번호를 입력해 주세요.', 422);
      const ok = await verifyPassword(password, u.pass || { salt: 'AAAAAAAAAAAAAAAAAAAAAA', hash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
      if (!ok) return err('invalid_credentials', '비밀번호가 올바르지 않습니다.', 401);
    }

    const v = validateBasics(body, u);
    if (v.error) return err(v.error, v.message, v.status);
    const { name, ...rest } = v.fields;
    if (name) store.updateUser(owner, { name });

    const next = { ...prev, ...rest, updated_at: now() };
    if (finish && onboarding) {
      if (!readyToComplete(store.getUser(owner), next)) {
        return err('validation_error', '이름·출생 연도·학생부를 모두 입력해 주세요.', 422);
      }
      next.onboarding_completed = true;
    }
    store.setUserBasics(owner, next);
    const user = store.getUser(owner);
    return {
      status: 200,
      body: {
        basics: publicBasics(store.getUserBasics(owner)),
        user: { id: user.id, email: user.email, name: user.name, basics_complete: !!store.getUserBasics(owner)?.onboarding_completed },
      },
    };
  }

  return { get, patch };
}

export function basicsComplete(store, owner) {
  const u = store.getUser(owner);
  if (!u || u.guest) return true;
  return !!store.getUserBasics(owner)?.onboarding_completed;
}
