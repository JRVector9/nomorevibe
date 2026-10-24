# Uptime 호스팅 안내 보류 구현 계획

> 상위 작업자가 승인한 설계로 현재 에이전트가 직접 실행하며 새 서브에이전트는 만들지 않는다.

**목표:** 확인되지 않은 호스팅 중단 안내가 자동 내림 제안으로 적용되는 것을 차단한다.

**구조:** `contracts.ts`의 uptime 후보 검증에 전체 본문·HTTP·completeness를 보는 작은 guard를 추가한다. `prompts.ts`에는 두 실제 안내의 의미를 설명한다. consumer의 기존 invalid 결과→human 경로를 그대로 사용한다.

**도구:** TypeScript, Vitest, 격리 PostgreSQL.

- [x] `tests/uptime-hosting-notice.test.ts`에 complete 402/503 안내와 delist 제안의 거절, 정상 종료/soft404·보류·인용 호환 회귀를 추가하고 RED를 확인한다.
- [x] `tests/integration/llm-assist-dispatch.test.ts`에 가짜 HTTP 모델의 두 잘못된 내림 응답이 human으로 남고 감사·purge가 생기지 않는 회귀를 추가한다. root의 DB와 다른 새 loopback DB에서 RED를 확인한다.
- [x] 알려진 두 안내 전체에만 일치하는 guard와 uptime prompt 설명을 최소 구현한다.
- [x] 같은 unit·DB 회귀의 GREEN, 관련 회귀·TypeScript·lint·diff 검사를 확인한다.
- [x] 실제 17건 측정·오내림 후보 2건·자동 적용 부적격과 다음 검증을 운영 문서·HANDOFF에 기록하고 커밋한다.
