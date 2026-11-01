# 게스트 AI 허용과 동의

사용자 요청: 게스트도 AI 사용, AI를 껐을 때 Mock, 로컬 실행. PROJECT.md §5·§6.1·§7.7(P0 게이트·P3 AI·P5 게스트)에 해당한다. 앞선 게스트 강제 Mock 결정은 이 문서로 대체한다.

게스트는 계정 종류 때문에 AI를 차단하지 않는다. 별도 화면에서 만 18세 이상과 AI·Groq 음성 처리 고지를 확인한 동의를 서버에 저장한다. 동의 문구에는 분석 공급자·음성 전송/보관 안내·개인정보 탐지 한계·보관 기간·검증 전 참고 결과가 포함된다. 동의 전 AI 쓰기 요청은 428이며, 서버 소유 동의 버전과 연령을 확인하므로 임의 synthetic 플래그·일반 안내 버전으로 열리지 않는다. 콜드스타트에서도 동의 상태를 복원한다.

기존 LIVE_ACK·REAL_DATA_ACK·무료/미승인 공급자 제한·소유권·삭제·블라인드 사전 검사·예산 상한은 유지한다. 운영자 공급자 승인 값과 비밀키를 이 작업에서 바꾸지 않는다. AI off는 Mock이고, AI on에서 공급자가 막혀 있으면 사용 불가 사유를 표시한다. 기존 실패 시 규칙 기반 안전 폴백은 유지하며 AI 호출 성공으로 위장하지 않는다. 이전 Mock으로 생성한 계획/보고서를 자동으로 AI 결과로 바꾸지는 않는다.

자동 게스트 진입·경고 닫기·회원 전환은 유지한다. 최초 AI 작업 또는 AI 켜기 전에 필요한 동의를 요청하며, 취소하면 해당 작업을 보내지 않는다. 상단 AI 이용 확인 버튼으로 다시 동의할 수 있다. 동의가 끝나면 공급자/마이크 사용 가능 상태를 새로 읽는다. 게스트의 내 데이터·로그아웃 버튼 숨김은 유지한다.

검증은 가짜 키·스텁 및 Chromium Mock으로 한다. 미동의/미성년/거짓 동의 버전 거부, 동의 후 승인된 실데이터 공급자 경로(스텁), AI off 호출 0건, 공급자 승인 누락 차단, Vercel 콜드스타트 보존, 동의 화면 취소와 체크 검증을 포함한다. 실제 사용자 자료를 외부로 전송하지 않는다.

변경 파일: `src/domain/guest-policy.js`, `src/app/{core,router}.js`, `src/app/handlers/{auth,consents,stt}.js`, `src/store/memory.js`, `public/core/{guest-ai,providers}.js`, `public/screens/{login,application,evidence,setup,feedback,aiswitch}.js`, `public/index.html`, `tests/api/{ai-switch,vercel-store}.test.mjs`, `tools/e2e-ui.mjs`, `PROJECT.md`, 이 문서. 과거의 "게스트는 항상 외부 AI 차단" 설명은 이력이며 이 결정이 우선한다. 실제 음성/STT 품질과 배포 검증은 별도다.

최종 검증(2026-11-01): `npm run check:project` 4/4, `npm test` 367/367, `npm run e2e` 131개 검사 통과. 이번 검증의 외부 AI 호출은 0회이며 공급자 경로는 스텁으로 확인했다. 최신 코드의 로컬 서버를 재시작하고 `http://127.0.0.1:3000/` HTTP 200을 확인했다.
