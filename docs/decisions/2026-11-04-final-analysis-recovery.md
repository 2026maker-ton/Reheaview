# 최종 분석 복구와 TTS 요청 경합 (2026-11-04)

범위: PROJECT §4.4·§5·§7.7, P3/P4/P5, P1-2/P1-7. 제품 방향·평가 정책은 유지한다.

## 확인한 코드 결함

- 최종 분석은 관찰(Claude) → 채점(Gemini) → 답변 검토 → 보고서 한줄평을 순차 실행한다. 기본 공급자 타임아웃과 재시도가 누적되면 함수의 기존 60초를 넘을 수 있다. 사용자 Redis 잠금은 30초라 오래된 스냅샷을 읽은 겹친 요청이 데이터를 덮어쓸 수 있었다.
- strict AI 모드에서는 한 단계의 게이트/모델/검증 실패가 보고서 실패로 이어진다. 완료 세션의 종료 재요청은 기존 실패 상태만 돌려주고, 결과의 '다시 확인'도 GET만 실행해 복구할 수 없었다.
- 답변 인정 TTS와 답변 제출을 동시에 시작했다. Vercel은 사용자별 모든 요청을 직렬화하므로 TTS가 답변 분석 뒤로 밀리면 잠금 대기 15초/브라우저 음성 요청 20초 제한으로 대체 음성이 나올 수 있다.

이는 코드로 확인한 실패 가능 경로이며 사용자가 겪은 특정 장애의 확정 원인은 아니다. Vercel 커넥터 로그는 403, CLI는 기존 인증 정보가 없어 로그를 읽지 못했다. 실제 AI 요청 0회.

## 수정

함수 최대 시간을 300초로, 사용자 잠금을 330초로 맞춘다. Vercel Fluid compute 활성화는 실제 배포에서 확인해야 한다. 새 배포 전에는 기존 프로덕션에 적용되지 않는다. 중단된 함수의 잠금은 최대 330초 남을 수 있고, 다른 요청은 기존 15초 대기 뒤 busy를 반환한다.

TTS 인정 문장 재생을 마친 뒤 답변 제출을 시작한다. 실패 보고서만 명시적으로 재생성한다. 소유권·멱등·속도 제한·strict·비용 게이트를 유지하고, 성공 보고서·답변 revision·최초 완료 시각은 보존한다. 실패 응답에는 원시 예외 대신 operation/reason만 전달한다. 자동 재시도로 외부 호출을 추가하지 않는다.

## 검증과 한계

Mock/스텁 API 회귀 및 브라우저 회귀로 검증한다. 최종 실행 수치는 작업 완료 보고를 따른다. 실제 공급자 지연·실마이크/음성 재생·프로덕션 배포는 검증하지 않았고, 기존 PROJECT의 과거 검증 수치·§7.5 문서 불일치 목록은 역사 기록으로 유지한다.

최종 실행: `npm run check:project` 4/4, `npm test` 389 통과/0 실패, `npm run e2e` 198 체크 통과/0 실패. 실패 보고서의 실제 재분석 POST·결과 복구, 합성 음성 자동 완료·STT 지연·종료 경합을 포함한다. 실제 외부 AI HTTP 요청은 0회다.

변경 파일: `src/app/handlers/{commands,sessions}.js`(재분석·실패 진단), `src/providers/call.js`(안전한 실패 단계), `src/vercel/handler.js`·`vercel.json`(수명·잠금), `public/screens/{feedback,room}.js`·`public/core/tts.js`(재시도·낭독 순서·대체 사유), `tests/api/{finish-priority,vercel-store}.test.mjs`, `tools/e2e-{ui,room-cases}.mjs`, `PROJECT.md`, `docs/deploy-vercel.md`, 본 결정 기록.

브라우저 검사에는 최근 UI 변경으로 없어진 modeChip·온보딩 활동 단계·ev-weights ID, 새 임시저장 버튼을 반영했다. 가속 Mock 면접을 여러 회차 실행할 때만 TTS 분당 한도를 테스트 환경에서 높이고, 가상 시계와 네트워크 응답을 동기화한다. 제품 속도 제한은 유지하며 별도 API 회귀가 검증한다.

## 후속: 관찰 단계 설정 누락

사용자가 보낸 운영 응답에서 `evaluation.observe/not_configured`를 확인했다. 이 응답은 Claude 호출 전 키·BASE_URL·MODEL 중 누락이 있음을 증명하며 어느 필드인지는 기존 응답으로 구분할 수 없었다. 앞서 수정한 요청 수명과 별개의 문제다. 로컬의 기존 설정은 Claude 키 존재, `https://api.anthropic.com/v1`, 모델/작성 모델 `claude-haiku-5-5`, API 버전 `2023-06-01`이었다(키 값 미출력). Vercel 설정에는 활성화 ACK만 있고 이 비밀이 아닌 값들이 없었다. 동일 값을 배포 설정에 명시하고 Secret은 포함하지 않는다. Production Secret 존재 여부는 Vercel API 접근 오류(프로젝트/팀 확인 후에도 404)로 미확인이다.

원인이 남으면 추측하지 않도록 `failure.configuration={provider,missing}`에 누락 필드 이름만 전달한다. 실제 값은 전달하지 않는다. API 키는 해당 배포 환경에 등록하고 재배포해야 하며, 코드만으로 키 누락을 복구했다고 주장하지 않는다. strict 모드·REAL_DATA_ACK·성인·동의·비용 조건은 유지하고 다른 모델·공급자로 승격하지 않는다. 가짜 서버 키와 스텁 invoke로 배포 구성→Claude 관찰 라우트, 누락 시 호출 0회, 진단 값 비노출 및 동의·연령 차단을 시험한다.

후속 검증: `check:project` 4/4, `npm test` 390 통과/0 실패, 브라우저 E2E 198 통과/0 실패. 실제 AI 요청 0회. 변경 파일은 `vercel.json`, `src/providers/{gate,call}.js`, `src/app/handlers/commands.js`, `tests/api/{ai-strict,finish-priority}.test.mjs`, `PROJECT.md`, `docs/deploy-vercel.md`, 본 기록이다. 기존 문서의 과거 검증 수치는 유지하며 운영 Secret·실배포·실모델 완료를 뜻하지 않는다.
