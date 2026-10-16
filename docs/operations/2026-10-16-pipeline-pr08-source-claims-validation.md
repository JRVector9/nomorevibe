# PR08 source claims: local validation

Inactive additive delivery. Dedicated loopback PostgreSQL55524 only; no real HTTP/provider/model/remote/operational action, activation, full suite or build. Root owns Git, the final0080/0081 journal integration and container cleanup.

## Behavior and authority

A disabled singleton defaults to epoch1/cursor0. The existing source worker gains a fixed admin/normal/admin/catchup lane. Each canonical work key is the actual product generation ID plus documentation/canonical_site. Its strict original binding includes URL, product updatedAt text (microseconds), settings/parser policy hash, entire previous source row digest and captured request version. Owner instance/boot, UUID token and monotonic safe epoch are compared to the actual persisted row. Renewed receipt expiry is informational; final expiry is checked against DB clock after job/outbox waits.

A short transaction orders control→product lifecycle/product→settings→source/request→claim→writes→jobs/outbox→final wall. No HTTP runs in a transaction. Healthy foreign/old-control-epoch owners remain intact; expired/forged/replaced owners cannot store or release another owner. Input/policy/public-state mismatch releases only its original current owner and writes no authoritative observation. Full result, current relationship recomputation, captured source progress, next request and release commit together. Original repository relationship rules are reused. Product completion stays in the existing all-required gate.

A canonical result does not inherit GitHub's product request retry deadline. Partial2MiB input and typed origin deferral record no source failure or scheduling turn. Admission may retain active-request initialization; deferral adds no result completion/retry/failure key and acknowledges no request. Aborted fetches await actual settlement. Conditional304 requires valid last-good facts and matching current/final URL; otherwise an unconditional retry is required. No raw body is stored. Same-URL failure cooldown survives settings revision; normal freshness force and URL replacement controls still work.

No fallback writer converts canonical CAS rejection into an authoritative generic failure. A stale product checkpoint preserves independently committed current-URL canonical progress. Default-disabled legacy registration still permits an unchanged unverified product; its initial status/access/URL/updatedAt and policy are captured before HTTP and compared before writing.

## Executed evidence

| Command / log | Actual result |
|---|---|
| `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55524/nomorevibe_test npm run test:integration -- tests/integration/evidence-source-claims.test.ts` on preserved original provider; `/tmp/nomorevibe-pr08-a-original-red-20261016.log` |3 assertion FAIL, normal control1 PASS;814ms tests; exit1 |
| Same original four bodies after CAS; `/tmp/nomorevibe-pr08-a-original-green-20261016.log` |4 PASS;exit0 |
| Scoped integration source claims/evidence-refresh/repository-link-sync/site-fingerprint; `/tmp/nomorevibe-pr08-a-db-final-isolated-20261016.log` |4 files/63 PASS;5.62s tests;exit0 |
| Same-URL failed source→settings revision negative; `/tmp/nomorevibe-pr08-a-policy-backoff-red-20261016.log` |1 assertion FAIL/21 skipped;567ms;exit1 |
| Final source driver including backoff/fresh-force/URL replacement; `/tmp/nomorevibe-pr08-a-final-22-green-20261016.log` |22 PASS;2.07s;exit0 |
| Contract/collector/site cancellation/refresh cancellation+continuation/progress/GitHub evidence+cancellation unit range; `/tmp/nomorevibe-pr08-a-unit-final-20261016.log` |8 files/105 PASS;69ms tests;exit0 |
| `npx tsc --noEmit --incremental false`; `/tmp/nomorevibe-pr08-a-static-tsc-20261016.log` |exit0; no PageProps errors after root typegen |
| Scoped ESLint over changed source/tests; `/tmp/nomorevibe-pr08-a-static-eslint-20261016.log` |exit0;0 warnings |

The final22 DB cases use actual claim/renew/record/job APIs; HTTP alone is mocked. They cover default-disabled no claim/HTTP, captured request source-only completion, original receipt after renewal, parallel admission single winner, healthy old epoch preservation, URL/public/settings/source mutation, forged/expired/replaced owner, GitHub quota independence, incomplete/deferred no-attempt/cursor, outbox rollback, relationship derivation without GitHub HTTP, progress merge, actual existing worker and typed runner deferral, and actual pg_blocking_pids job wait crossing source expiry with full transaction rollback. Four available demand classes receive their fixed turns. Parallel API calls are not separately presented as observed distinct backend-PID proof; the wait regression does explicitly observe a real blocker.

## Failed approaches and corrections

- Initial `it.each` on a local wrapper failed suite collection (0 tests): fixture/API error, not RED; replaced with registered per-case tests.
- The first settings mutation matrix reused48 from an earlier case and expected a nonexistent change (14 PASS/1 fixture FAIL). Isolated settings baseline corrected it; no quality/source assertion was weakened.
- Initial fairness fixture allocated the same slug concurrently (duplicate SQL key): fixture error, not RED; sequential allocation fixed it.
- PR07c intentionally removed early abort races. Two old integration mocks never settled; those fixture assumptions were replaced with controlled actual settlement while preserving150ms,100ms/elapsed<500ms, no-source and ownership assertions. Separate predecessor patch: `/tmp/nomorevibe-pr08-site-settlement-predecessor-20261016.patch`.
- All63 body assertions initially passed, but whole-foreign verification caught the global consumer visiting a prior test's `isolated` product. Fixture isolation now suspends only baseline public status and pending request due time, restores their original raw microseconds after all actual work settles, and checks the entire nine-table raw universe. This cleanup failure is not counted as a production RED. A released claim from that earlier failed fixture is explicitly retained for root's exact cleanup.

## Cleanup and limitations

The new driver's original four test bodies are byte identical to the preserved baseline; its setup/cleanup was strengthened. Original source/driver/hash are in `/tmp/nomorevibe-pr08-a-original-hashes-20261016.json`. Test promises and child runJob operations settle before restoration. Held-writer and fault-trigger finally blocks retain original body plus cleanup errors. Only absence-guarded own product IDs/keys are deleted. Baseline managed settings/job/observation rows are restored from raw JSON, with whole raw equality after selector-field restoration. Test trigger/function cleanup is exact and verified.

Readback files: `/tmp/nomorevibe-pr08-a-final-readback-20261016.json` and `/tmp/nomorevibe-pr08-a-retained-claim-readback-20261016.json`. Own pr08 product/source/request/trigger/function counts are0, other connections0, control disabled/epoch1/cursor0. A released `isolated` claim from the known failed fixture and ordinary `site-cache` business fixture remain for root-owned cleanup; no global-zero claim is made. This agent does not stop/remove the root-owned container.

The new mode is not enabled. Existing configured role identity is reused; it is not physical host attestation. No new consumer or source type beyond canonical site is activated.90s is logical DB authority, not remote termination evidence. Shared HTTP permits, runtime host budgets, operator rollout/canary and final all-PR integration remain separate. New source APIs explicitly reject replay DB scopes; this is not B5 source certification. Final fresh migration order with root's0080 is not certified by the earlier isolated0081 bootstrap.

## Root 최종 리뷰·추가 경계 보강

독립 B 리뷰에서 renew의 row lock 대기 전에 계산된 live projection이 만료 후 갱신에 쓰일 수 있음을 실제 blocker/PID/DBwall로 확인했다. 2 Assertion RED(renew/fixture holder 오류) → 동일2 GREEN, 정상 renew·기존 job-row wait 포함 영향4 PASS/20skip(1.90초 tests/2.55초 total). 갱신 UPDATE의 DBwall 조건/빈 RETURNING만 수정했다. holder는 원 Promise/ready race를 finally 안에서 정산한다. 원4 body와 새2 body RED/GREEN byte 동일. 최종 tsc/scoped eslint 각 exit0. 전체24/관련63/unit105는 반복하지 않았다. 로그 `/tmp/nomorevibe-pr08-b-final-four-green-20261016.log`, 보고 `/tmp/nomorevibe-pr08-b-readonly-review-20261016.md`.

Fixture CDN snapshot 누락6행도 별도 실제 raw 차이로 확인해 원raw/발생근거를 보존하고 exact PK+slug+whole raw CAS/RETURNING1로만 정리했다. 같은 fixture는 CDN 포함10table universe를 검증한다. 기존 CDN80행/released isolated claim1/site-cache는 보존한다. Production RED로 중복 계산하지 않았다.

Root는 claim/collection/context/control/contract/SQL/schema·기존 caller와 관계 재계산의 전체 변경, B 최종 patch·실행 로그를 직접 읽고 26파일 frozen manifest를 검증했다. source 최종 SHA `fd3b7c8658453d02042467cde3f048b1083114cb44cef7a3d3576b8c8a3165c2`, actual driver `a1b8d00f996e69ba0458aa3e2f8d2c1c5194a7d68a565b5c8c509837634301fd`. 추가 미해결 P1/P2 0.

Root 독립 읽기 `/tmp/nomorevibe-pr08-root-readback-20261016.mjs`는 원 baseline/B 최종과84table rawµs 전체 exact·catalog(relname/relacl) exact·stage raw exact·다른연결0을 확인했다(`/tmp/nomorevibe-pr08-root-final-readback-20261016.json`). 첫 읽기의 stage table명 오기 `pipeline_stage_control`은42P01/쓰기0/연결종료였고 실제 `pipeline_stage_modes`로 수정한 읽기가 exit0이다. 이는 기능 RED가 아니다.

기본 disabled/epoch1/cursor0 유지. 운영배포·DDL·provider·새consumer·활성화0. 수동 전체검사는 모든 PR 개발 종료 후 통합단계에만 실행한다. 최종0080→0081 journal/fresh migration·선행 caller PR455 병합은 이어서 root가 확인한다.

## 최종 journal 통합 검증

Source commit `cc2c650e223310e111150dee992e0c3d6551ca52`, main6cabb005 정상 merge `f93adbd914639f56875405cc84df0e06ff255d5d`. schema additive exports와 journal idx80/0080→idx81/0081 충돌만 해결했다. own55524 별도 `nomorevibe_pr08_migration_test`에서 `MIGRATION_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55524/nomorevibe_pr08_migration_test node scripts/migrate.mjs` 실제 exit0, 동일 명령 재실행 exit0. 로그 `/tmp/nomorevibe-pr08-root-fresh-migration-20261016.log`, `/tmp/nomorevibe-pr08-root-migration-rerun-20261016.log`.

독립 readback: journal82개/마지막0080·0081 SHA 일치, source disabled·epoch1·cursor0, uptime observations/gate disabled, append-only ALWAYS trigger2개, claims/observations0·다른연결0. `/tmp/nomorevibe-pr08-root-fresh-migration-readback-20261016.json`. 기존 작업DB84table rawµs/catalog/stages exact를 다시 확인한 뒤 정확 owncontainer 정상STOP/exited0/OOMfalse/container+exclusive volume제거0(`/tmp/nomorevibe-pr08-root-cleanup-20261016.json`). **55524 재접속·재생성 금지**. 이는 변경된 migration 순서의 검사이며 전체DBsuite를 실행한 것이 아니다. source/test unchanged 범위를 반복하지 않았다.

PR455 caller defer 선행에 의존하여 초안으로 제출한다. PR455 필수CI first-final human lock timeout은 별도 새55528의 제한된 재현 조사 중이며 성공이라고 기록하지 않는다. 운영기능 활성화0.
