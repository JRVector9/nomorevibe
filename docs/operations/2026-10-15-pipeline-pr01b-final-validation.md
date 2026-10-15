# PR01b-4 — 실제 결과 저장과 최종 완료 기록의 원자성 검증

2026-10-15. base main `664777d3175dbcded56dad96ad1e6d6f37027bb0` (#432),
branch `codex/pipeline-pr01b-final-20261015`, worktree
`/Users/jr/Desktop/projects/nomorevibe-pipeline-final`.

## 결과와 범위

기존 AI1/AI2 writer가 결과와 후속 요청을 저장하는 **같은 Drizzle transaction**에서 검수 전이와
고유 final을 기록한다. recorder 오류는 결과·후보 변경·outbox·event·final을 함께 rollback한다.
그 전에 정산된 모델 호출과 비용은 보존한다. AI1 반환 `applied`를 완료 수로 사용하지 않는다.

현재 단계는 격리 fixture 실행의 완료 기록이다. artifact/export·준비 coverage·seal·실제 DB 초기 상태 인증과
실모델 30분 baseline은 후속 b5/b6다. 진단의 `fixture_call_ledger_only` / `unverified` /
final throughput `null`은 그대로다. PR01 전체 합격이나 처리량2배, Oracle 업무/DR 완료는 미판정이다.
실모델 admission은 `unsupported_provider_budget`으로 닫혀 있다.
운영 설정·migration·수동 배포·실제 추론·새 consumer 활성화는 하지 않았다.

## 병렬 소유권과 root 리뷰

사용자 지정대로 세 담당 모두 `gpt-6.1-sol` / `xhigh`이며 root가 파일과 전용 DB port를 분리했다.
공통 계약을 먼저 고정하고 각 담당의 완료 보고와 파일 소유권을 받은 뒤 교차 읽기 리뷰와 root 전체 리뷰를 했다.

| 담당 | 소유 파일과 결과 |
| --- | --- |
| AI1 | `lib/crawl/agent-review-repository.ts`, `tests/integration/pipeline-replay-first-final.test.ts`; 현재 잠긴 입력 문맥과 전후 attempt/candidate 결합 |
| AI2 | `lib/crawl/second-review.ts`, `lib/crawl/second-review-input.ts`, `tests/integration/pipeline-replay-second-final.test.ts`; gate 전체 잠금·전이·prefix mutex·cleanup 보존 |
| 공통 ledger | `lib/operations/pipeline-replay-final.ts`, ledger/SQL·단위 회귀, provider read-only audit; authentic scope·opaque token·결과 증명·고유 final |
| root | runner/transport/profile, 실제 DB 원자성 회귀·fixture helper, 최종 요청 정규화·독립 리뷰·통합 검증·문서·Git 취합 |

AI1 담당은 AI2/transport/runner/profile을, 공통 담당은 AI1/AI2를 독립 읽기 검토했다. 공통 담당은 요청 정규화·실패 root-call 증명까지 재검토했고 새 P1/P2를 찾지 못했다.
root는 입력/정책·실제 행·SQL gate·호출 증명·원자 rollback·잠금순서·권한·중복·일반 운영 경로를 검토했다.
선택 검토 도구인 `review` skill의 참조 checklist가 로컬에 없어 전체 skill workflow 완료로 집계하지 않는다.
여기 적은 리뷰는 직접 코드 읽기와 실행한 회귀다.

## 구현 계약

- private WeakMap의 authentic `ReplayRun`과 검증된 동일 DB/소유자에만 ALS final scope를 결합한다.
  scope 종료·충돌·다른 tx·위조/재사용 token은 거절한다. 일반 운영 scope 밖에서는 recorder가 동작하지 않는다.
- 기존 잠금 뒤 실제 before 행을 준비하고, 기존 writer/outbox 뒤 after 행을 확인한다.
  현재 전체 설정·고정 입력 bytes/hash·source/policy/version·자동 후보 연결·lease를 재검증한다.
- fixture transport가 엄격히 검증한 응답을 정산할 때 전체 outcome hash와 decision/confidence/reason hash를 기록한다.
  성공 writer가 이 호출과 다르면 예외로 전체 저장을 취소한다. receipt-only 정산은 완료 증명이 되지 않는다.
- 신규 자동 AI1 reject와 gate가 꺼진 approve는 AI1에서 완료한다. 필수 gate가 켜진 approve는
  기존 `secondReviewApprovalPredicate(settings)`가 같은 tx에서 false→true가 되는 마지막 AI2 writer에서만 완료한다.
  현재 설정의 모든 독립 slot·generation·root/fallback과 같은 run의 실제 성공 호출이 필요하다.
  fallback은 같은 run의 실패 root 호출까지 결합하며 rootCallId를 보존한다.
- rules/reuse/이미 반영한 성공/observe/hold/사람 변경/stale/부분표는 신규 final0이다.
  sample·공개분과 AI2 reject/needs_review는 기존 결과·전이를 보존하되 자동 완료로 세지 않는다.
- final unique key는 `(run_id,candidate_id,input_hash,source_revision_hash,policy_hash)`다.
  event seq·first call·AI2 witness를 결합하며 cleanup은 과거 final을 지우거나 수정하지 않는다.
- handler profile은 고정 `handlers-v3`다. frozen input을 읽고 결과 proof 열을 갱신하며 finals는 SELECT/제한 INSERT만 한다.
  timestamp 직접 지정·UPDATE·DELETE는 금지하며 products/source 불변과 객체 OID/ACL fingerprint 검증을 유지한다.
  SQL은 격리 테스트 DB bootstrap용이며 운영 migration이 아니다.
- 모든 domain/job/outbox 작업 뒤 run/event 잠금을 마지막에 잡는다. AI2 mutation은 replay-only 공통 prefix mutex 뒤
  candidate→원본/설정→repository→first→정렬된 gate/root 행→job 순서다. 네트워크 중 DB 잠금은 없다.
  전이의 outbox descriptor는 `job,requestedVersion`만 직렬화한다.

## 실제 RED와 리뷰 수정

1. root 실제 handler에서 AI1+AI2 후 final0, recorder 실패 시 결과가 남는 두 RED를 확인한 뒤 같은 tx recorder로 GREEN을 확인했다.
2. transport 결과 proof 부재 두 RED와 runner final scope 미설치 RED를 실행한 뒤 실제 proof/ALS 설치로 GREEN을 확인했다.
3. AI1 담당의 구현 전 실제 RED는 신규 model reject와 gate-free approve의 final0/expected1 두 개다.
   초기10개 중4실패/6통과에서 나머지2개는 fixture 오류라 RED 근거에서 제외했다.
   최종15개 모두를 개별 RED했다고 주장하지 않는다. 실패 정산 호출 뒤 위조 approve 저장도 재현했다. 이제 `replay_final_result_mismatch`로 candidate/attempt/outbox/event/final이 rollback한다.
4. AI2 두 연결 회귀는 cleanup 선점·writer 선점을 barrier와 `pg_blocking_pids`로 검증한다.
   prefix mutex를 잠시 제거한 canary는 실제 UPDATE 대기가 관측되어 RED였고, 원복 뒤 GREEN이다.
   임시 제거는 최종 소스에 남아 있지 않다.
5. root 리뷰에서 host attempt 시간과 DB run 시간을 섞는 비교를 제거하고 DB clock의 dispatch/settle/run 시각만 쓴다.
   SQL result proof CHECK도 NULL의 삼중값 논리로 빠져나가지 않도록 `IS TRUE/FALSE`와 hash NOT NULL로 보완했다.
6. 실제 sample/fallback 회귀에서 outbox 반환의 extra status가 직렬화됨을 발견했다.
   first/second transition 단위 테스트 실제 RED2→job/version 정규화→GREEN을 실행했다.
7. 잘못 연결된 다른 candidate의 first attempt는 기존 identity 조회에서 불필요 SHARE 잠금을 취득했다.
   두 정상 작업은 서로 다른 job 행을 사용하므로 이 두 경로만으로 deadlock이라고 주장하지 않는다.
   loader가 null을 반환한 tx를 barrier로 유지한 동안 별도 연결의 외부 행 NOWAIT가
   실제 55P03 RED였다. identity 조회에 candidateId 조건만 추가해 동일 테스트 GREEN을 확인했다.

실패 trigger는 profile fingerprint 생성 **이전** test helper에서 설치한다. 생성 뒤 설치한 초기 fixture는
권한/함수 drift로 cleanup이 실패해 담당 전용 container만 재생성했다. 권한 검증을 완화하지 않았다.
실패 canary의 잘못된 outbox 기대값, race harness의 `JobContext<unknown>`와 조기 lease 해제도 fixture에서 보정했다.

## 실행한 검증

| 명령 / 경계 | 실제 결과 |
| --- | --- |
| `npm test` (요청 정규화 반영 후) | 274파일 / 2,781 PASS, 7.17초 |
| root 전용55459 `npm run test:integration` | 157파일 / 1,715 PASS / 기존 TODO1, 319.34초. 마지막 정규화/추가 경계 회귀 전 실행 |
| root 새 final 및 기존 handler runtime | 2파일 / 11 PASS |
| root ledger/profile | 2파일 / 32 PASS |
| AI1 실제 DB 담당 | 15 PASS |
| AI2 최종 실제 DB 담당 | 새10 + 기존 second-review61/runtime8 = 79 PASS, 42.30초 |
| root 최종 코드의 관련 DB | 6파일 / 68 PASS, 62.00초. 정규화·외부 잠금·sample/fallback 추가 회귀 포함 |
| root 최종 scope/transport/final 단위 | 3파일 / 74 PASS |
| `npx next typegen`, `npx tsc --noEmit` | 최종 요청 정규화 후 PASS |
| `npm run lint` 및 변경 파일 ESLint | PASS, 기존 vendor `_ctx` warning1 |
| `npm run check:i18n` | PASS |
| `python3 -m unittest tests/test_deploy_shared_images.py` | 23 PASS |
| `DATABASE_URL=postgres://build:build@localhost:5432/build npm run build` | PASS |
| `node scripts/bundle-size.mjs` | 공개 경로3개 한도 이내 PASS |
| `git diff --check` | PASS |

실제 로그는 `/tmp/nomorevibe-b4-unit-complete-20261015.log`,
`/tmp/nomorevibe-b4-integration-all-20261015.log`, `/tmp/nomorevibe-b4-lint-final-20261015.log`,
`/tmp/nomorevibe-b4-outbox-{red,green}-20261015.log` 등이다.
DB는 pinned `pgvector/pgvector:0.8.6-pg17`이며 root55459·AI1 55460·AI2 55461 loopback 전용이다.
최종 root 재검증 뒤 replay schema/runtime role/runtime 연결/source guard trigger가 모두0임을 직접 확인했다.
PUBLIC ACL은 database CONNECT/TEMPORARY, public schema USAGE와 grant option 없음으로 복구됐다.
AI1/AI2 담당도 전용 DB 정리를 확인했다. 세 이번 전용 container는 stop했으며 다른 container는 변경하지 않았다.
남은 blocking P1/P2 리뷰 지적은 없다. PR/CI 상태는 납품 현황과 handoff에 별도 기록한다.

## 후속과 재현

b5는 실제 readiness/coverage·별도 artifact/export·admission 종료/모든 call 정산/writer fence 뒤 seal이다.
b6는 실행 identity·강제 전체 토큰/시도 상한·실제 usage·원격 취소/불명 호출 해결 증명과 제한 baseline이다.
공급자 readback은 [감사 문서](2026-10-15-pipeline-pr01b-provider-audit.md)를 따른다.
확인된 gateway 파일 hash와 discovery metadata만으로 admission을 열지 않는다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe-pipeline-final
docker start nomorevibe-pr01-final-root-20261015
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55459/nomorevibe_test npm run test:integration
npm test
npx next typegen
npx tsc --noEmit
npm run lint
npm run check:i18n
DATABASE_URL=postgres://build:build@localhost:5432/build npm run build
node scripts/bundle-size.mjs
python3 -m unittest tests/test_deploy_shared_images.py
git diff --check
```
