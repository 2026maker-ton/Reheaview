# Reheaview: 입력·종료·안내 개편

사용자 요청 7건을 PROJECT.md §2.1·§2.2·§2.5·§2.6·§3·§5·§7.7에 반영했다. P1 학생부 입력, P2 출처 기반 모집요강 비율, P3 종료 우선 처리, P5 작업 상태·개인정보 안내·명칭 변경에 해당한다. 과거 Intervu 문서·파일명은 이력으로 유지한다.

## 동작

- 자소서 업로드 버튼·입력 라벨·도움말·새 질문의 자소서 표현을 제거했다. 학생부·활동 경험 입력은 유지하여 주장 원문 → 질문 → 답변 근거 → 코칭의 차별점을 보존한다. `application_text`·레거시 문서 종류 API와 기존 저장 데이터는 호환한다.
- 종료 버튼은 확인창 없이 마이크·낭독을 멈추고 바로 결과 처리 화면으로 전환한다. 종료 명령은 진행 중 답변이 바꿀 수 있는 버전을 클라이언트에서 고정하지 않고 서버 직렬화로 처리한다. 서버는 소유권·멱등 검사를 통과한 종료 의사를 먼저 기록하고, 진행 중 AI 응답이 돌아와도 질문을 발행하지 않는다. 확정 중 답변은 보존하며 녹음 중 미확정 답변은 추가 제출하지 않는다. 완료 후 종료 재시도는 성공 상태를 반환하며 중복 분석하지 않는다. 마지막 본질문은 `dialogue.next`를 호출하지 않고 최종 분석으로 넘긴다.
- 자료 분석·학교 자료 분석·질문 생성·검색·면접 준비·음성 인식·답변 분석에 작업 이름을 표시하고 버튼 중복 요청을 막는다. 최종 분석은 결과 화면의 회전 표시와 `분석 중...` 문구로 알리고 실패·지연은 재확인 경로를 제공한다. 기존 AI 평가 실패를 재생성하는 백그라운드 작업은 구현하지 않았다.
- 학교·학과·전형이 명시된 모집요강의 %만 단계·학년도·원문 좌표·출처 상태와 표시한다. 기존 개인정보 마스킹으로 학교명이 가려지는 공개 자료는 원문으로 대상 범위를 로컬 대조하되 이 원문을 외부 AI에 추가 전송하지 않는다. 표시 인용에 개인정보 후보가 있으면 버린다. 대상 누락·다른 학과/전형·배점만 있는 경우는 미확인이다. 원문을 읽은 결과이지 공식 비율 검증이나 연습 점수 가중치가 아니다. 복잡한 PDF 표·축약 명칭·전 모집단위 공통 적용은 보수적으로 미확인이 될 수 있다.
- 학교 검색 프롬프트는 해당 연도·학과·전형의 공식 공개 비율을 요청한다. Grounding 결과는 기존대로 수정 없이 출처·추천 검색어와 표시하며 비율 카드·질문 근거로 재가공하지 않는다. 공급자 게이트·조회 한도·보관 정책은 유지한다. 실제 모집요강 검색 품질은 이번에 확인하지 않았다.
- `/privacy.html`에 처리 자료·외부 AI/음성·블라인드 검사·보관·삭제·권리를 모았다. 상단·동의·준비·검사 결과에서 접근한다. 동의에 필요한 핵심 고지는 남겼다. 공개 운영자명·연락처·배포별 처리 지역·계약 고지는 미확정이며 이 페이지는 법률 검토 완료를 뜻하지 않는다. 게스트의 내 데이터·로그아웃 숨김은 유지한다.
- 일반 i 설명을 줄이고 역량별 설명은 레이더 점·축의 호버·포커스·터치 말풍선으로 옮겼다. 1·미관찰·규칙 기반·단어 일치 한계는 남겼다.
- UI·package·현재 안내 문서·서버 문구·페르소나 설정의 제품명을 Reheaview로 변경했다. 기존 토큰·초안·쿠키 키는 호환을 위해 유지한다. GitHub 저장소는 `2026maker-ton/Reheaview`로 변경하고 origin 주소를 갱신했다. 로컬 폴더 변경 결과는 아래 검증 기록을 따른다.

## 보호 조건과 검증 범위

성인·동의·LIVE_ACK·REAL_DATA_ACK·예산·개인정보 사전 차단·출처 인용·관찰 부족 표시·규칙 폴백 구분은 유지한다. 테스트는 가짜 키/공급자 스텁·합성 자료·Chromium을 사용하며 실 AI·실음성·실검색·배포 검증이 아니다.

개인정보 페이지의 공급자 보관 문구는 2026-11-01 공식 안내를 확인했다: [Anthropic](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [Gemini](https://ai.google.dev/gemini-api/terms), [Groq](https://console.groq.com/docs/your-data). 서비스가 공급자 계약·삭제·국외 처리까지 보장한다고 쓰지 않는다.

주요 변경 파일: `public/{index,privacy}.html`, `public/core/{busy,info-text,router}.js`, `public/ui/info.js`, `public/screens/{application,evidence,setup,room,feedback,dashboard}.js`, `public/styles.css`, `src/app/router.js`, `src/app/handlers/{commands,profiles}.js`, `src/domain/{admission-weights,claims,blind-gate,personas,personas-data}.js`, `src/providers/prompts/{interview,claims}.js`, `src/node/server.js`, `docs/personas/personas.v2.json`, `package.json`, `README.md`, `AGENTS.md`, `PROJECT.md`, `tests/api/{finish-priority,s1-school}.test.mjs`, `tests/domain/{admission-weights,claims}.test.mjs`, `tools/e2e-{ui,room-cases}.mjs`.

## 최종 확인 (2026-11-01)

- `npm run check:project`: 4/4 통과. `npm test`: 374/374 통과, 실패 0. `npm run e2e`: Chromium 144개 검사 통과, 페이지·콘솔 오류와 예상 밖 HTTP 오류 0. 검사 모드는 Mock·가짜 공급자 스텁이며 이번 외부 AI 호출은 0회다.
- 브라우저는 학생부 업로드·자소서 제거, 분석/질문 생성 버튼의 지연 중 문구·중복 차단, 비율 70%·30%와 원문/출처 표시, 레이더 호버/포커스, 정책 페이지 390px 전체 폭, 자동 완료·STT 지연 복구, 종료 직후 처리 화면·늦은 꼬리질문 무시·종료 1회를 확인했다. 이전 보고서의 비동기 응답이 새 면접/분석 화면을 덮는 결함도 취소 토큰과 렌더 무효화로 수정했다. 1440/768/390px 확인과 모바일 화면 육안 검토를 수행했다.
- GitHub 저장소 이름 변경과 origin 주소 갱신 완료: `https://github.com/2026maker-ton/Reheaview`.
- 최상위 폴더는 원본·목적지 절대 경로와 충돌 여부를 확인하고 로컬 서버를 중지한 뒤 이름 변경을 시도했으나 Windows가 `The process cannot access the file because it is being used by another process.`로 거부했다. 폴더·자료를 그대로 보존했으며 현재 경로는 `.../Contests/Intervu`다.
- 기존 폴더에서 최신 서버를 숨김으로 재시작했고 `http://127.0.0.1:3000/`의 Reheaview 이름과 HTTP 200, `/privacy.html` HTTP 200을 확인했다. 공급자 승인 설정은 변경하지 않았다.
- 미검증: 실제 공급자 추론·모집요강 검색 품질·실마이크·배포, 법률 검토·운영자/연락처·배포 계약별 개인정보 고지. 과거 기획서·Figma·기록의 Intervu 명칭과 이전 UI는 이력이며 현재 §7.7보다 우선하지 않는다.
