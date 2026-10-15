# PR01b-3 — 실제 검수 handler의 격리 fixture 실행 검증

2026-10-15. base main `9601e3b61b10ebdf5cffea2a0c5a4bfc9992897b` (#431),
branch `codex/pipeline-pr01b-runtime-20261015`, worktree
`/Users/jr/Desktop/projects/nomorevibe-pipeline-handler-runtime`.

## 결과와 범위

기존 `reviewCrawlCandidates` / `secondReviewCandidates`를 전용 로컬 DB에서 실행한다.
fixture 호출만 새 경계로 바꾸며 실제 claim·입력·규칙·AI2 gate·결과 writer·재시도·outbox를 재사용한다.
기존 모델 설정·심사 기준을 바꾸지 않고, downstream 요청은 저장하되 검수 두 job만 실행한다.

운영 migration·실제 provider 호출·공개 발행·수동 배포·새 consumer 활성화는 없다.
이 checkpoint는 원래 PR01의 일부다. final 원자 기록·readiness/coverage·artifact/seal·실제 모델 baseline은
후속 b4–6이다. `initialStateHash`의 실제 DB 상태 인증도 아직 없다.
`fixture_call_ledger_only` / `unverified` / final throughput `null`을 유지한다.
fixture 속도나 실제 handler 테스트로 처리량2배·PR01 전체 합격·Oracle 상시 업무/DR을 주장하지 않는다.

## 구현과 병렬 소유권

서브에이전트 3명 모두 `gpt-6.1-sol` / `xhigh`를 사용했다. root가 파일 소유권과 DB port를 분리하고,
전체 코드 리뷰·실제 handler 통합 검증·문서·Git 제출을 맡았다. 각 담당은 완료 뒤 편집 소유권을 반환했다.

| 담당 | 파일 / 결과 |
| --- | --- |
| fixture transport | `lib/crawl/review-fixture-transport.ts`, 두 검수 handler, 세 raw adapter, 새 transport/dispatch/adapter 단위 테스트 |
| restricted runner | `lib/operations/pipeline-replay-runner.ts`, `lib/jobs/runner.ts`, runner 단위 테스트 |
| profile/ledger | `pipeline-replay-{database,handler-profile,ledger}.ts`, 격리 ledger SQL, profile/ledger 통합 회귀·test helper. 전용55457 DB |
| root | `lib/db/replay-scope.ts`의 private identity 결합, scope 단위 회귀, 실제 handler 통합8개·기존 clock test 보정, 계획·상태·handoff. 전용55458 DB |

runner는 caller 값을 첫 await 전에 복사하고 fixture mode·고정 두 job만 허용한다.
별도 raw ledger와 owned Drizzle 연결의 private DB target/nonce가 같아야 하며 nested/stale scope를 거절한다.
실제 handler가 읽은 settings를 부수 효과 전에 다시 검증한다. 실제 job 요청/backoff/continuation을 소비하며
role lease·fetch/judge/publish 실행·gateway 목록 조회·raw CLI/모델 adapter는 claim 또는 외부 호출 전에 차단한다.

fixture call은 정확한 provider/model, full input, input/source/policy hash, 실제 attempt,
AI2 row/generation/root vote slot 및 timeout을 request에 결합한다.
장부 reserve→dispatch→in-flight 커밋 뒤 callback을 실행하고 유효한 receipt/result를 settle한 뒤 기존 writer로 반환한다.
`requestHash`는 fixture 요청 계약이며 아직 실제 provider wire body의 해시를 증명하지 않는다.
불명 receipt·잘못된 result·dispatch 이후 취소/timeout은 indeterminate로 보존하고 새 admission을 닫는다.
전체 deadline은 durable start 전부터 handler/heartbeat 종료·drain·연결 정리까지 유지한다.

고정 `handlers-v2` profile은 새 ledger table/column만 추가한다. inputs/transitions SELECT를 주지 않고
identity·timestamp·manifest를 임의 갱신할 권한을 주지 않는다. products SELECT only·source ALWAYS 불변 trigger를 유지한다.
기존 v1 profile은 fail closed이며 운영 DDL은 없다. bootstrap SQL은 새 전용 테스트 DB용이다.

## 실제 handler에서 확인한 동작

새 `tests/integration/pipeline-replay-handler-runtime.test.ts` 8개를 실제 DB에서 실행했다.

- 실제 AI1→AI2 승인·기존 필수 gate와 결과 저장. 장부 in-flight가 callback 전에 보이고 settled 후 writer가 실행된다.
- AI2 불일치가 `needs_review` / `second_review_split` / `needs_human`으로 남으며 발행 요청이 생기지 않는다.
- AI1 auth 실패의 실제 실패 attempt와 wall-clock retry_after를 보존한다.
- hard fork 규칙 거절은 모델 호출0이다.
- AI2 기본 실패 뒤 별도 fallback tick은 같은 generation/root vote를 결합하고 실제 fallback resolution을 저장한다.
- 원본이 없는 후보는 기존 frontier/fetch outbox로 대기하고 준비된 후보 검수는 계속한다.
- fetch/judge/publish는 실제 runJob의 DB claim 전에 거절한다. global DB/replica·fetch poison에서도 기존 handler의 외부 접근0,
  공개 products digest 불변, publisher outbox requested만 증가하고 runs0·lease 없음이다.
- 전체2초 deadline에 응답하지 않는 fixture는 indeterminate call1을 남기고 job/heartbeat/owned DB 연결을 정리한다.

입력 semantic reference는 `2001-11-01`로 고정했지만 lease/retry/event 시간은 실제 DB clock이다.
실제 설정의 `[MLX] gpt-oss-120b` / `[supa] Qwen3.8-27B-NVFP4`를 fixture identity로 썼다.
`qwen3-coder:30b`는 fallback 동작을 검증하기 위한 테스트 fixture일 뿐 운영 모델 교체나 품질 판정이 아니다.

## 실행한 검증

| 명령 | 실제 결과 |
| --- | --- |
| `npm test` | 273파일 / 2,762 PASS |
| 전용55458의 `npm run test:integration` | 최종154파일 / 1,689 PASS / 기존 TODO1, 292.60초 |
| 새 runtime 실제 handler DB 파일 | 최종8 PASS, 30.55초 |
| 기존 스팸 보류 DB 파일 | 수정 뒤9 PASS; host/DB clock을 섞은 fixture 오류 보정 |
| 관련 DB6파일 | 64 PASS, 42.50초. 최종8번째 runtime 회귀 추가 전 실행 |
| 담당 transport 단위8파일 | 96 PASS |
| 독립 reviewer의 runner/transport 등 단위5파일 | 81 PASS |
| 담당 profile/ledger/boundary DB | 32 PASS, 전용55457 |
| `npx next typegen`, `npx tsc --noEmit --incremental false` | PASS |
| `npm run lint`, `npm run check:i18n` | PASS. 기존 vendor `_ctx` warning1, locale4/namespace8/public page11 |
| `DATABASE_URL=postgres://build:build@localhost:5432/build npm run build` | PASS |
| `node scripts/bundle-size.mjs` | 공개 경로3개 한도 이내 PASS |
| `python3 -m unittest tests/test_deploy_shared_images.py` | 23 PASS |
| `git diff --check` | PASS |

단위 로그 `/tmp/nomorevibe-pr01-runtime-unit-20261015.log`, 전체 DB 로그
`/tmp/nomorevibe-pr01-runtime-integration-final-20261015.log`, 빌드 로그
`/tmp/nomorevibe-pr01-runtime-build-20261015.log`를 남겼다.
각 DB는 pinned `pgvector/pgvector:0.8.6-pg17` / loopback 전용이며 운영 DB를 사용하지 않았다.
전체 suite 뒤 replay schema 없음·runtime role0·runtime 연결0을 직접 확인했다.
PUBLIC ACL은 database CONNECT/TEMPORARY, public schema USAGE와 grant option 없음으로 복구됐다.
55457/55458의 이번 전용 container는 검증 뒤 stop했고 삭제하지 않았다.

## 리뷰·실제 RED와 수정

root가 모든 production 변경·권한/SQL·핵심 회귀를 검토했다. 구현 담당을 바꿔
runner/transport/handler/adapter와 profile/ledger/SQL/scope를 각각 독립 읽기 리뷰했다.
리뷰에서 per-call timeout 부재와 malformed result discriminant를 재현했고, settings 재검증·caller 입력 캡처·전체 deadline 범위도 보완했다.
수정 뒤 담당/독립 회귀와 root 실제 DB 검증을 실행했으며 최종 substantiated P1/P2 잔여는 없다.
`review` 스킬은 필수 checklist 파일을 찾을 수 없어 workflow를 중단했다. 해당 스킬을 완료한 것으로 표시하지 않는다.

- 실제 dispatch 추가 전 기존 handler가 raw adapter guard에 닿는 RED를 실행했다.
- timeout 없는 영구대기 fixture, truthy `ok`의 잘못된 result가 통과하는 문제를 독립 reviewer가 재현했다.
  AbortSignal race·엄격한 discriminated result 검증으로 해결했다.
- runner의 nested owner/두 job/정책·모델 동일성/caller mutation/deadline guard RED→GREEN을 실행했다.
- profile/call identity의 최초5 fail25 pass를 실행한 뒤 AI2 metadata와 제한된 ledger 권한을 구현했다.
- root 실제 handler 회귀의 full input hash 불일치는 raw PG timestamp-without-timezone parser와 Drizzle UTC 해석 차이였다.
  source/후보를 Drizzle로 읽는 같은 경로에서 fixture를 만들었다. 입력 hash나 equality를 완화하지 않았다.
- 기존 clock 통합 회귀에서 DB가 host보다 약37.8ms 뒤였다. 실행 전 lower bound를 같은 DB clock에서 읽도록
  테스트만 수정했다. lease/backoff 운영 로직과 시간 허용치를 완화하지 않았다.
- 최초 전체 DB는153파일PASS/1파일FAIL,1688PASS/1FAIL/기존TODO1이었다. 스팸 보류 파일만 다시 실행해도 실패했다.
  임시 probe에서 host가 쓴 fetched_at이 DB now보다22.41ms 미래이고 ready0인 것을 확인했다.
  해당 README fixture의 fetchedAt만 DBclock-1s로 설정하자 단독9PASS였다. 모델 호출0·사람 보류 검증은 유지하며
  별도 reviewer도 두 clock 테스트 변경의 의미 약화 없음을 읽기 검토했다. 임시 probe는 제거했다. 최종 전체 재실행은154파일/1,689PASS/기존TODO1이다.
- 초반 tsc의 생성 PageProps 부재는 `next typegen` 후 해소됐고 최종 tsc를 다시 실행했다.

## 다음 PR과 재현 명령

b4는 기존 writer와 같은 transaction에서 final을 기록하고 mandatory AI2 gate·stale/human/중복을 검사한다.
b5는 readiness/coverage·artifact/export와 admission 종료·settle·writer fence 뒤 seal을 검증한다.
b6의 실제 모델 실행은 serving identity·전체 token/attempt/usage/취소 계약이 입증될 때까지
`unsupported_provider_budget`이다. PR01 측정 기반과 baseline이 합격하기 전 새 consumer 활성화는 없다.
2배 판정은 변경 소비자를 검증하는 PR06/17의 별도 조건이다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe-pipeline-handler-runtime
docker start nomorevibe-pr01-runtime-test-db-20261015
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55458/nomorevibe_test npm run test:integration
npm test
npx next typegen
npx tsc --noEmit --incremental false
git diff --check
docker stop nomorevibe-pr01-runtime-test-db-20261015
```
