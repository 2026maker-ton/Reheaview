# Vercel 배포 (정적 화면 + 서버리스 API + Upstash Redis)

> 상태: 코드와 가짜 Redis 테스트는 통과했습니다. **실제 Vercel·Upstash에 올려 돌려 본 적은 없습니다** `[UNVERIFIED]`.

## 구조
- `public/` → 정적 화면(Vercel이 그대로 서빙, 빌드 없음)
- `api/handler.js` → `/api/v1/*` 전체를 처리하는 서버리스 함수(`vercel.json` 리라이트가 경로를 `__p` 쿼리로 넘김)
- `src/vercel/handler.js` → 요청마다 새 코어를 만들고, Upstash Redis에서 **그 사용자의 데이터만** 불러와 처리한 뒤 다시 저장
- `vercel.json` → 출력 폴더, 함수 실행 시간(300초, Fluid compute 필요), 보안 헤더(CSP, 마이크 허용은 같은 출처만)

## Redis에 저장되는 것
| 키 | 내용 |
|---|---|
| `user:{id}`, `email:{이메일}` | 계정(비밀번호는 해시), 이메일 중복 가입 방지 |
| `sess:{해시}`, `usess:{id}` | 로그인 세션(토큰은 SHA-256 해시, 7일 만료) |
| `own:{id}` | 그 사용자의 프로필·질문 계획·면접·평가·동의를 gzip+base64로 한 덩어리 |
| `lock:{id}` | 같은 사용자의 요청이 겹치지 않게 하는 잠금(330초 자동 해제; 함수 최대 수명 + 저장 여유) |
| `ledger:{YYYY-MM}` | 월 AI 비용 합계 |
| `rl:*` | 가입·로그인 시도 제한(이메일+IP 분당 5·일 50, IP 분당 20) |

30일 보관 기한은 요청 때마다 `own:{id}` 안에서 지웁니다. 계정 삭제는 위 키를 모두 지웁니다.

## 배포 순서
1. Vercel에서 이 저장소를 프로젝트로 가져옵니다(Framework: Other, 빌드 명령 없음 — `vercel.json`이 정합니다).
2. Storage 탭에서 만든 Upstash Redis(`intervuDB`)를 이 프로젝트에 **연결**합니다. 연결하면 `KV_REST_API_URL`·`KV_REST_API_TOKEN`(또는 `UPSTASH_REDIS_REST_URL`·`UPSTASH_REDIS_REST_TOKEN`)이 자동 등록됩니다.
3. 환경변수(Production)에 `.env`의 값을 등록합니다. **넣지 말 것:** `PORT`, `DEV_TOKEN_A/B`, `STORE`, `DATA_DIR`, `TRENDS_FILE`.
   화면 상단 AI 스위치는 비밀번호가 없고 상태는 Redis(`flag:ai_off`)에 저장되어 모든 사용자에게 적용된다. 글꼴(Pretendard·고운바탕)은 jsDelivr·Google Fonts에서 불러오므로 CSP(`vercel.json`)에 두 도메인이 허용돼 있다.
4. 배포 후 확인: 가입 → 샘플로 면접 한 바퀴 → 새로고침해도 로그인 유지 → 계정 삭제.

## 최종 분석의 Claude 설정 누락

`failure.operation=evaluation.observe`, `failure.reason=not_configured`는 외부 요청 전 Claude 키·주소·모델 중 하나가 없다는 뜻이다. API의 결제/인증 실패·타임아웃과 구분한다. `vercel.json`에는 현재 로컬 구성과 같은 비밀이 아닌 `CLAUDE_BASE_URL`, `CLAUDE_MODEL`, `CLAUDE_WRITER_MODEL`, `CLAUDE_API_VERSION`을 명시했다. 모델 변경이나 다른 공급자로 자동 전환하지 않는다.

`CLAUDE_API_KEY`는 Vercel의 **해당 배포 환경(Production 또는 Preview)의 서버 Secret**으로 직접 등록해야 한다. 키 값은 저장소·오류 화면에 넣지 않는다. 키를 추가해도 이미 만들어진 배포에 소급 적용되지 않으므로 새로 배포한 다음 실패 보고서의 다시 시도를 사용한다. 새 실패 응답의 `failure.configuration`에는 공급자와 누락된 필드 이름만 담긴다. 주소·모델·키의 실제 값은 담기지 않는다.

## 입장 비밀번호
- 2026-11-03에 제거했습니다. `SITE_PASSWORD`·`GATE_SECRET` 없이 배포가 열리며, 접근 제어는 회원 가입·로그인(연령·동의 확인)뿐입니다. 공개 전에 Anthropic·Google 콘솔 월 지출 한도를 확인하세요.

## 알려진 한계
- **월 Claude 호출 상한(`CLAUDE_MONTHLY_CALL_CAP`)은 서버리스에서 작동하지 않습니다**(요청마다 카운트가 초기화). Anthropic·Google 콘솔에서 월 지출 한도를 직접 거세요. 월 비용 합계(`MONTHLY_API_BUDGET_USD`)는 Redis로 이어지지만 Claude 단가를 설정하지 않으면 0원으로 계산됩니다(`CLAUDE_PRICE_IN_PER_M_USD`, `CLAUDE_PRICE_OUT_PER_M_USD`).
- 사용자 데이터를 한 덩어리로 저장하므로 면접 기록이 매우 많아지면 한 번에 주고받는 크기가 커집니다(압축해도 Upstash 요청 크기 제한 1MB 안에서). 30일 보관으로 억제합니다.
- 함수 실행 시간은 `maxDuration` 300초. 배포 프로젝트의 Fluid compute 활성화를 확인한다([공식 한도](https://vercel.com/docs/functions/limitations)). 시간 초과로 강제 종료되면 저장이 완료되지 않을 수 있으며 규칙 평가 성공으로 취급하지 않는다. Production의 strict AI 모드는 실패 단계·사유와 재시도를 표시한다.
- 요청 본문 4.5MB 제한: 음성 한 구간은 보통 이보다 작습니다.
- 이메일 인증이 없어 가짜 계정으로 AI 비용을 쓰게 만들 수 있습니다. 가입 시도 제한은 있지만 공개 전에 공급자 지출 한도를 반드시 거세요.
- 관리자 월간 트렌드는 서버리스에서 영속하지 않습니다(UI 미사용).
