# PR07c HTTP permit 대기 호출자 처리

> 구현: gpt-6.1-sol / xhigh. Git·운영·외부 HTTP·전체 suite/build는 실행하지 않는다.

목표: `HttpOriginPermitError`만 일시 보류로 전달하여 사이트 실패, 검증 실패, 캐시, 시도 횟수, 뉴스 cursor, 작업 ACK로 소비하지 않는다. 정상 HTTP·네트워크 실패 규약은 유지한다. 새 정책·스키마·queue·transport 권한은 추가하지 않는다.

## 소유 파일과 순서

1. 실제 도메인/호출자 회귀부터 RED/control을 보존한다. `tests/http-permit-product-callers.test.ts`, `tests/http-permit-worker-callers.test.ts`, `tests/http-permit-readme-content.test.ts`, `tests/handler.test.ts` 및 기존 fetch/publish 테스트의 필요한 사례를 사용한다.
2. `lib/domain/products/og.ts`, `register.ts`, `verify.ts`, `readme-content.ts`, `thumbnails/resolver.ts`, `lib/jobs/products/{thumbnail-refresh,repo-review}.ts`, `lib/news/refresh.ts`의 typed 오류만 재전파한다. 이미 저장된 등록/발행의 선택적 OG 수집은 성공과 editToken을 보존하고 기존 thumbnail 요청으로 넘긴다(`lib/crawl/publish.ts`). 뉴스/썸네일 병렬 작업은 모든 자식 Promise 정산 뒤 오류를 전달한다.
3. `lib/domain/evidence/refresh.ts`의 기존 partial 결과에 optional deferred reason만 더하고 `lib/jobs/products/evidence-refresh.ts`에서 typed 오류로 전달한다. source/미디어 progress와 정상 provider 보류는 유지하되 작업 ACK/실패/backoff로 소비하지 않는다.
4. `lib/http/handler.ts`에서 typed 오류만 일반적인 임시 이용 불가 503으로 변환한다. 등록/검증 Result의 기존 사이트 실패 응답은 유지한다. 실제 routes는 기존 withRoute를 사용하므로 별도 route 분기/기술 문구가 필요 없다.
5. `lib/jobs/runner.ts`에 `http_origin_permit` deferred reason을 추가한다. handler의 typed 오류만 이 결과로 바꾸며 현재 token과 DB wall을 확인한 뒤 lock/token만 해제한다. producer 요청, processed, cursor, notBefore/pause, 성공/실패 이력은 보존한다. `lib/crawl/jobs/fetch.ts`의 기존 permit 항목 반환 결과도 해당 reason으로 연결한다. 보통 done:false ACK와 stage_blocked 의미는 유지한다.
6. 새 `tests/integration/http-permit-deferred-requests.test.ts`는 root가 배정한 새 전용 DB에서 실제 runJob/CAS로 producer·pause·token 교체·job lock 대기 만료·일반 ACK/실패를 검증한다. 정상 token은 실제 runJob에서만 발급한다. 자체 job/observation exact key만 정리하고 foreign raw µs 및 기본 stage/ACL을 보존한다.

README/readme-refresh/review-document/HN/AI1 lane은 현재 typed 오류를 전파한다. 호출자 경계 회귀로 이를 확인하며 필요 없는 source 변경은 하지 않는다. A 소유 uptime/health/product repository/detail/inbox/0080, B replay/lifecycle, net transport/0079, 공용 상태 문서는 수정하지 않는다.

## 검증 및 증거

- 최초 source/driver SHA와 실제 Assertion RED/control 로그를 `/tmp/nomorevibe-pr07c-*-red-20261016.log`에 보존한다. fixture/import 실패는 기능 RED로 세지 않는다.
- 동일 driver GREEN 후 변경 관련 기존 테스트만 실행한다. `npx vitest run <위 신규 unit 파일 및 해당 기존 파일>`.
- 실제 runner: `TEST_DATABASE_URL=<root가 배정한 loopback dummy URL> npx vitest run --config vitest.integration.config.ts tests/integration/http-permit-deferred-requests.test.ts`.
- `npx tsc --noEmit --incremental false`, `npx eslint <정확 변경 .ts 파일>`만 정적 검사한다. Next typegen 필요 시 root에 요청한다.
- raw before/after, 원 실패, 명령/exit, SHA 및 운영 비활성 한계를 반환한다. root가 DB 최종 readback/STOP·Git·공용 handoff를 관리한다.

실제 외부 호출의 종료/크래시 회복·HTTP permit 운영 활성화·물리 host attestation을 이 PR의 증거로 주장하지 않는다. 기존 PR07b의 native 정산 경계는 변경하지 않는다.

추가 실제 caller RED: README 기존 deadline Promise.race가 permit abort를 unavailable로 부정 캐시하는 경계가 확인되어 동일 8초 abort 후 actual readContent 정산을 await한다. source transport/상한은 변경하지 않는다.

별도 승인된 실제 site-fingerprint deadline RED도 read의 abort→null race만 제거하여 닫았다. `lib/domain/evidence/providers/site-fingerprint.ts`와 `tests/site-fingerprint-cancellation.test.ts`는 먼저 root에 동결 반환했고 후속 PR08 CAS 담당자에게 순차 인계한다.

완료 검증: 변경 관련 unit 19파일221PASS + 사이트지문2파일16PASS, 실제 runner8PASS, whole tsc/scopedlint 실제exit0. 전체suite/전체DB/build는 실행하지 않았다. 최종 명령·원RED·해시·raw readback은 `/tmp/nomorevibe-pr07c-c-final-report-20261016.md`에 반환한다. root가 공용 CODEX_HANDOFF·진행장부·DB STOP·Git을 취합한다.
