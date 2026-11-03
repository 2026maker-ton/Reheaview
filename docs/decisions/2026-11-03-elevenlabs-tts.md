# ElevenLabs 면접관 TTS 연결 (P3 · P1-2)

사용자가 ElevenLabs CLI 온보딩과 TTS 연결을 요청했다. 보류했던 서버 TTS를 SDK로 연결하고, 질문 낭독이 끝난 뒤 녹음하는 현재 면접 흐름을 유지한다. 주장 검증·근거 기반 코칭과 평가 정책은 변경하지 않는다.

## 구현

- `@elevenlabs/elevenlabs-js`의 `ElevenLabsClient.textToSpeech.convert`가 서버에서만 실행된다. 기존 `ELEVENLABS_BASE_URL`은 `/v1` 포함 형식을 유지한다. SDK 요청의 헤더는 표준 Headers로 정규화하고 리디렉션은 거절한다.
- 기존 성공·오류·소유권·글자/응답 크기·예산·합성 위장 방어 계약을 유지한다. SDK와 어댑터의 재시도는 0회다. 응답은 오디오 MIME과 스트림 크기를 확인하고 2MiB를 넘으면 중단한다. 키·공급자 오류 본문은 브라우저로 보내지 않는다.
- 요청은 `target`만 전달한다. `current_question`, `last_utterance`와 서버 `SPOKEN`에서 고른 `fixed_opening/ack/cutoff/closing`만 허용한다. 지원자 답변·브라우저의 임의 문장을 합성하지 않는다.
- 면접실은 상태 API가 live인 경우 서버 음성을 재생하고, 실패·204·429·재생 실패 시 브라우저 낭독으로 이어간다. 화면에 실제 음성 모드와 폴백을 표시한다. 종료·이동 시 요청과 재생을 취소하고 대기 Promise를 해제한다. Blob URL은 재생 후 폐기한다. Node/Vercel CSP는 `media-src 'self' blob:`만 추가한다.
- 키 파일은 열거나 출력하지 않았다. CLI `onboard check`로 키를 확인했다. `start`·`dev`는 Node 환경 파일 플래그로 `.env`·`.env.local`을 로드한다. 기존 Node 전용 환경 로더도 `.env.local`을 지원하며 테스트의 `overrides.env`는 이 파일들을 읽지 않는다. SDK에 전달하는 키는 서버 환경 설정에서만 온다. SDK 로딩은 음성 게이트가 열린 TTS 요청에서만 실행한다.
- 로컬의 비밀 없는 설정만 `.env.local`에 추가했다. Flash v2.5·George를 초기 선택으로 두며 `.env.example`에 설정법을 적는다. 모델·음성의 한국어 품질·실제 계정 접근 권한은 미검증이다.

## 실데이터 및 비용 제한

`ELEVENLABS_REAL_DATA_ACK=false`를 유지한다. 실제 지원서에서 인용한 질문도 개인 데이터일 수 있으므로 기존 합성 fixture 판정·동의·성인 확인을 우회하지 않는다. 운영자가 제공사 데이터 보존·학습/검토·국외 처리 조건과 계정 설정을 확인하고 이용자 고지를 갱신하기 전에는 실질문을 보내지 않는다. 현재 개인정보 페이지에 ElevenLabs 처리 고지가 없으므로 실데이터 활성화는 미완료다.

기존 요청당 600자·사용자별 속도·세션/월 예산·공급자별 호출 상한·킬 스위치를 유지한다. 단가가 없으면 호출 수만 제한되고, 공급자별 월 상한은 인메모리이며 서버리스에서 지속되지 않는 기존 DEBT-11/17은 남아 있다. 콘솔 사용량 한도를 대체한다고 주장하지 않는다.

## 검증 가이드 (사용자 지시에 따라 새 테스트/Mock은 작성하지 않음)

작업 결과(Windows · Node 22.15.0): `check:project` 4/4, `npm test` 387 통과·0 실패, 그 안의 기존 B6 TTS 계약 9/9 통과. 변경 JS 문법 검사·`git diff --check` 통과. 초기 전체 실행은 샌드박스 임시 폴더의 원자적 rename에 EPERM이 나고 대기하여 중단했고, 쓰기 가능한 전용 TEMP/TMP에서 다시 실행해 위 결과를 얻었다. 최초 SDK 전환 점검에서는 SDK Headers 객체를 기존 스텁이 읽지 못해 8/9였으며, 전송 헤더를 표준 객체로 정규화한 뒤 통과했다. CLI 최종 점검은 유효 키·SDK 선언·SDK 사용·환경 파일 로딩을 확인했고 `offer_test`를 반환했다. 실제 음성 생성/기타 생성 AI 요청 0회. 실제 앱 실행·브라우저 재생·E2E는 테스트 승인 전 미실행이다.

변경 파일: `package.json`, `package-lock.json`, `src/providers/adapters/elevenlabs.js`, `src/app/handlers/tts.js`, `src/env.js`, `src/node/server.js`, `public/core/tts.js`, `public/screens/room.js`, `public/index.html`, `vercel.json`, `.env.example`, `PROJECT.md`, 이 결정 기록. `.env.local`에는 비밀 없는 TTS 설정만 추가했으며 git에서 제외된다.

기존 `tests/api/b6-tts.test.mjs`로 세션 문장 선택, 악성 text 무시, 게이트 조건별 외부 호출 0건, 429/500/잘못된 오디오/크기 제한, 예산, 소유권, 키 비노출을 검증한다. `npm run check:project`·`npm test`를 실행하고 실제 결과는 작업 완료 보고에 기록한다.

추가 시나리오는 다음 기준으로 검증해야 한다: 고정 문장 target이 요청 text와 무관하게 `SPOKEN` 값만 읽는지, 낭독 도중 종료/화면 이동 시 음성과 대기 작업이 해제되는지, 늦은 응답이 새 질문을 덮지 않는지, 서버 실패/재생 거절 후 브라우저 음성으로 한 번만 이어지는지, CSP가 Blob 재생을 허용하는지, 낭독 종료 전 녹음이 시작되지 않는지, 두 환경 파일과 실제 환경변수의 우선순위가 맞는지.

CLI 지침에 따라 실제 앱 실행·음성 생성·브라우저 리허설은 사용자에게 구체적 테스트를 제안하고 승인을 받은 뒤 수행한다. 키 확인은 음성 생성 검증이 아니며, 자동 검사와 스텁 시험 통과만으로 실제 TTS 연결 완료·한국어 품질을 주장하지 않는다.

## 참고한 공식 스킬·문서

- [ElevenLabs TTS 스킬](https://github.com/elevenlabs/skills/blob/main/text-to-speech/SKILL.md)
- [설치](https://github.com/elevenlabs/skills/blob/main/text-to-speech/references/installation.md), [스트리밍](https://github.com/elevenlabs/skills/blob/main/text-to-speech/references/streaming.md), [음성 설정](https://github.com/elevenlabs/skills/blob/main/text-to-speech/references/voice-settings.md)
- [SDK 공개 사용법·재시도·타임아웃](https://github.com/elevenlabs/elevenlabs-js/blob/main/README.md)

`PROJECT.md` 머리말의 현재 결정을 우선한다. 그 아래 과거 공급자 표와 `docs/plan/*`·`docs/cost-assumptions*`의 보류/가격 가정은 이력으로 남아 있으며 실제 ElevenLabs 이용 가능 여부·과금을 보증하지 않는다.
