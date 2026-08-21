/**
 * 단위 테스트는 셸이 아니라 코드를 재야 한다.
 *
 * .env.local의 값이 셸에 떠 있으면(로컬 실행에서 흔하다) 테스트가 조용히 다른 것을 잰다.
 * 실제로 세 건이 그렇게 빨갛게 떴다 — ALLOW_PRIVATE_URLS=1이 SSRF 가드를 꺼서 사설
 * 주소로 가는 리다이렉트가 통과했고, NEXT_PUBLIC_SITE_URL이 요청 origin 폴백을 덮었다.
 * CI는 깨끗한 환경이라 통과하므로 이 어긋남은 로컬에서만 보인다.
 *
 * 그래서 개발 전용 스위치를 여기서 지운다. 필요한 테스트는 스스로 값을 세운다.
 * 통합 테스트는 tests/integration/env.ts가 자기 값을 명시적으로 넣으므로 여기 대상이 아니다.
 */
const DEV_ONLY = ["ALLOW_PRIVATE_URLS", "NEXT_PUBLIC_SITE_URL"];

for (const name of DEV_ONLY) delete process.env[name];
