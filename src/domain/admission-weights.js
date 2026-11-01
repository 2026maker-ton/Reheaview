// 원문에 명시된 %만 추출한다. 배점/배수로 역산하거나 검색 결과를 재가공하지 않는다.
export function admissionWeights(segments, target = {}) {
  const norm = (s) => String(s || '').normalize('NFC').replace(/\s+/g, '');
  const school = norm(target.school_name || target.target_name);
  const department = norm(target.department || target.role);
  const track = norm(target.track);
  const result = { status: 'unconfirmed', target: { school: target.school_name || target.target_name, department: target.department || target.role, track: target.track || '' }, items: [] };
  if (!school || !department || !track) return { ...result, reason: '학교·학과·전형을 모두 입력하면 해당 범위의 평가 비율을 확인합니다.' };
  for (const seg of segments) {
    const sourceText = String(seg.text || '').normalize('NFC');
    let scopedSchool = false; let scopedDepartment = false; let scopedTrack = false;
    let stage = ''; let year = ''; let offset = 0;
    for (const raw of sourceText.split('\n')) {
      const text = raw.trim(); const compact = norm(text);
      if (/[가-힣]+대학교/.test(text)) { scopedSchool = compact.includes(school); scopedDepartment = false; scopedTrack = false; stage = ''; }
      if (/[가-힣]+(?:학과|학부|계열)/.test(text)) { scopedDepartment = compact.includes(department); scopedTrack = false; stage = ''; }
      if (compact.includes(school)) scopedSchool = true;
      if (compact.includes(department)) scopedDepartment = true;
      if (/전형/.test(text) && !/전형요소|전형방법|전형평가|전형비율/.test(compact)) { scopedTrack = compact.includes(track); stage = ''; }
      if (compact.includes(track)) scopedTrack = true;
      // 같은 행에 여러 전형을 섞은 표는 해당 열을 확정할 수 없어 채택하지 않는다.
      if ([...text.matchAll(/([가-힣]+전형)/gu)].some((m) => !track.includes(norm(m[1])) && !['해당전형', '선택전형', '각전형'].includes(norm(m[1])))) scopedTrack = false;
      if (/(20\d{2})\s*학년도/.test(text)) year = text.match(/(20\d{2})\s*학년도/)[1];
      if (/(\d+)\s*단계/.test(text)) stage = `${text.match(/(\d+)\s*단계/)[1]}단계`;
      if (scopedSchool && scopedDepartment && scopedTrack && text.length <= 300) {
        const pattern = /([가-힣][가-힣·ㆍ /()]*?)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*[%％]/gu;
        for (const m of text.matchAll(pattern)) {
          const label = m[1].trim().replace(/^단계\s*/, '').trim(); const percent = Number(m[2]);
          if (!label || label.length > 35 || !/서류|학생부|교과|수능|면접|구술|실기|역량|적합|인성|성장|탐구|학업|공동체|자기주도/.test(label) || percent < 0 || percent > 100) continue;
          const start = Array.from(sourceText.slice(0, offset + raw.indexOf(text))).length;
          result.items.push({ label, percent, stage, year: year || null, source_id: seg.id, quote: text, start_cp: start, end_cp: start + Array.from(text).length });
          if (result.items.length >= 24) break;
        }
      }
      offset += raw.length + 1;
      if (result.items.length >= 24) break;
    }
    if (result.items.length >= 24) break;
  }
  const seen = new Set();
  result.items = result.items.filter((i) => { const k = JSON.stringify([i.label, i.percent, i.stage, i.year, i.source_id]); if (seen.has(k)) return false; seen.add(k); return true; });
  result.status = result.items.length ? 'found' : 'unconfirmed';
  result.reason = result.items.length ? null : '입력·등록된 모집요강에서 이 학교·학과·전형에 명시된 평가 비율을 확인하지 못했습니다.';
  return result;
}
