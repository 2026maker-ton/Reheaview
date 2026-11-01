// 수동 실호출 도구 전용. 실제 네트워크 직전에 재시도·대체 모델까지 합산한다.
// 한 작업에서 여러 도구를 실행하는 경우의 합산 9회 상한은 AGENTS.md도 따라야 한다.
export function createLiveTestBudget(fetcher, maxCalls = 9) {
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 9) throw new RangeError('Live AI tests allow at most 9 outbound requests');
  let calls = 0;
  return {
    get calls() { return calls; },
    async fetch(input, options) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      // 테스트 앱의 로컬 API 요청은 AI 호출로 세지 않는다. 그 앱에서 나가는 외부 요청은 별도로 센다.
      const localApp = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.startsWith('/api/v1/');
      if (!localApp) {
        if (calls >= maxCalls) throw Object.assign(new Error('Live AI test request limit reached (maximum 9 including retries)'), { code: 'TEST_AI_CALL_LIMIT', invalid: true });
        calls++;
      }
      // 숨은 redirect 재요청으로 실제 HTTP 상한을 넘지 않게 한다.
      return fetcher(input, localApp ? options : { ...options, redirect: 'error' });
    },
  };
}
