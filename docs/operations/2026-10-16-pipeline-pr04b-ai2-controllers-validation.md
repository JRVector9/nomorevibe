# PR04b-2 — AI2 비결과 controller 검증 기록

2026-10-16. [실행 계약](../superpowers/plans/2026-10-16-pipeline-pr04b-ai2-controllers.md)에 따라 전용 작업 트리와 DB55497/55498/55499, root55500을 분리했다. 구현·직접/교차 리뷰·전체 로컬 검증과 readback/STOP을 완료했다. 이 checkpoint의 commit/push/PR·CI는 별도 남아 있다. 기본 legacy/epoch1/contract0·새 consumer 비활성, 운영 deploy/DDL/provider inference/발굴 재개0이다.

## 기준과 실제 RED

PR04b-1 #441/head0536116은 필수 PR CI38783342933 SUCCESS 뒤 2026-10-15T18:16:12Z main a0e00b7b6ef379845b00c94631604d29172c40a9로 정상 병합했다. PR04b-2 작업 트리에는 같은 source tree임을 확인한 뒤 actual main을 정상 merge했다. main CI38784227699의 필수 check·웹/워커 image 전체 SUCCESS를 실제 확인했으며 운영 적용과 구분한다.

A의 baseline source `/tmp/nomorevibe-pr04b2-source-before-20261016.ts` SHA256은 `9e3dc5ebcac3e1b819482cf317132f0fd169397d7a30f7150bb0c19a5d6bef42`다. A는 root가 B/C의 실제 로그와 driver를 읽고 수용할 때까지 생산 source를 동결했다.

- B 최초 **정상 control2 PASS/행동2 FAIL**, exit1, 1.64초: `/tmp/nomorevibe-pr04b2-independent-initial-red-20261016.log`. actual runJob retry가 ai1 stage UPDATE holder를 기다리지 않고 완료됐다. stale settled hint는 candidate→vote blocker 뒤 사람이 확정한 resolved/kept의 resolution·µs timestamp를 decided_elsewhere/현재시각으로 덮었다. SQL/import/API 오류가 아닌 실제 DB assertion 실패다.
- C 최초 **정상 control1 PASS/행동2 FAIL**, exit1, 1.03초: `/tmp/nomorevibe-pr04b2-authority-initial-red-20261016.log`. missing job과 실제 다른 job의 genuine lease가 모두 due failed vote를 pending으로 commit했다. negative만 Reflect.apply를 사용하고 정상 control은 actual second-review runJob이다. 최초 fixture의 attemptNumber 누락23502는 별도 initial-fixture-error 로그로 보존하고 행동 RED에서 제외했다.
- B 추가 current 사실 matrix **7 FAIL/5 PASS**, exit1, 1.27초: `/tmp/nomorevibe-pr04b2-independent-current-red-20261016.log`. 앞의2 RED와 중복되며 새5개는 최신 configured first reject 뒤 old approval enqueue, current document 변경 뒤 stale enqueue, current pool 복구 뒤 model_removed, caller enforce/current DB observe reopen, orphan root의 candidate hold trigger 실패에도 root needs_human/failureCount 선commit이다. 마지막은 의도한 trigger 예외를 확인한 뒤 raw root 불변 assertion이 깨져 실제 원자성 RED로 수용했다.

담당 로그는 겹치므로 실패·성공 수를 합산하지 않는다. foreign whole raw/µs와 관리행 복원 hook을 실제로 통과한 최초 로그를 보존했다.

## root 직접 리뷰에서 추가한 경계

첫 source를 읽어 세 부분을 보강 요청했다. 실제 독립 RED→GREEN과 최종 고정 source의 root 전체 검증으로 닫았다.

1. retry가 잠근 domain을 무시하고 due SQL만 수행했다. current pool/root/latest first/source의 실행 가능성을 재검증한 뒤 strict backoff CAS를 수행해야 한다. policy binding만 바뀐 유효 표의 동일행 회복은 보존한다.
2. held selector의 confidence 조건이 DISTINCT 전에 있어 stale confident first 후보가 LIMIT 앞을 차지할 수 있었다. 최신 first 선택 뒤·LIMIT 전에 필터하고 뒤의 정상 후보가 진행하는 실제 회귀를 추가한다.
3. cleanup hint가 모든 active/fallback 후보를 무제한 domain transaction으로 훑었다. 정상 published agreed/사람 확인 대기로 unrelated cleanup이 막히지 않게 기존 cleanup eligibility predicate를 SQL hint에 유지하고 잠금 뒤 다시 검사한다. 실제 settled1000 이전 필터와 기존 quota는 유지한다.

B가 세 경계를 독립 회귀로 추가해 실제 **3 FAIL/25 skip**, 1.97초 exit1을 먼저 확인했다. `/tmp/nomorevibe-pr04b2-independent-selector-red-20261016.log`. root가 로그와 driver를 직접 읽은 뒤 A에 source 변경을 승인했고, 최종28 PASS에 포함됐다.

마지막 readonly 리뷰에서 reopen의 기존 SKIP LOCKED가 blocking candidate lock으로 바뀐 회귀도 발견했다. 실제 첫1개/앞25개 candidate holder가 있는 두 정상 control에서 뒤 정상 orphan이 진행하지 못했다. **2 FAIL/28 skip**, 1.50초 exit1, `/tmp/nomorevibe-pr04b2-independent-skip-locked-red-20261016.log`. actual pg_blocking_pids holder43와 candidate FOR UPDATE 대기, locked candidate raw/µs·전체 vote 불변을 root가 직접 읽었다. SQL/import/setup 실패0. reopen 전용 비차단 candidate lock과 µs keyset hint 보충을 승인했고 수정 뒤 **전체30 PASS4.72초 exit0**, `/tmp/nomorevibe-pr04b2-independent-skip-locked-final-green-20261016.log`를 확인했다. 초기 ID 상한·방문 제외로 지속 producer/변경된 timestamp에 무한 재방문하지 않으며 actual25 quota를 유지한다.

## root가 실행한 검증

- root55500 pinned PG17 생성/`DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55500/nomorevibe_test node scripts/migrate.mjs` 실제 exit0. `/tmp/nomorevibe-pr04b2-root-migrate-20261016.log`.
- missing candidate 정상 production cleanup과 authentic legacy replay fail-closed rollback: **2 PASS/13 skip**, 1.75초, 실제 exit0. `/tmp/nomorevibe-pr04b2-root-missing-candidate-scope-fixed-20261016.log`. actual runJob·현재 profile을 사용하고 replay는 exact `replay_final_binding_mismatch`와 vote·전체 transition 불변/final0을 확인했다. baseline에서 확인한 경계이며 아래 최종 전체에서도 다시 통과했다.
- 첫 root 시도2 FAIL은 run start transition을 0으로 가정한 assertion과 noncertified run에 certified execution scope를 씌운 fixture 오류였다. `/tmp/nomorevibe-pr04b2-root-missing-candidate-baseline-20261016.log`. 전이는 실제 before 전체 snapshot과 비교하고 일반 authentic final/database scope를 사용해 바로잡았다. 생산 source·인증 요구를 완화하지 않았으며 행동 RED로 계산하지 않는다.
- root 기존 caller/replay/ownership/clock focused7files **71 PASS46.96초**, session85579 실제exit0. `/tmp/nomorevibe-pr04b2-root-fixtures-final-20261016.log`. controller fixture는 actual second-review runJob을 사용한다. 그 runner가 request10을 ACK하므로 ownership fixture의 후속 tick은 실제 requestJob으로 request11을 발행하고 기존 diagnostic/cursor sentinel만 배치했다. lease/token/epoch/version 조작·gate assertion 완화0.
- root 최종 `npm test`279files **2922 PASS8.14초**, typegen/whole tsc/전체lint(기존vendor unused warning1)/i18n/Python23/build/bundle 실제exit0. 최종 source 수정 뒤 unit44713·whole tsc/lint92117·build/bundle96694의 종료를 확인했다. `/tmp/nomorevibe-pr04b2-root-{unit-final,typegen,tsc-final,lint-final,i18n,python-final,build-final,bundle-final}-20261016.log`. br148.7/159.0/136.2KB 한도 이내.
- root 전체 DB **178파일2090 PASS/기존 TODO1, 435.48초, session51664 실제exit0**. 명령 `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55500/nomorevibe_test PIPELINE_TEST_LOG_PREFIX=/tmp/nomorevibe-pr04b2-root-db node /tmp/nomorevibe-pr04b2-db-diagnostics-20261016.mjs`. `/tmp/nomorevibe-pr04b2-root-db-full-20261016.log`, wait 원로그는 동명 locks-20261016.jsonl. focused를 먼저 실행한 같은 DB이므로 별도 fresh full이라고 주장하지 않는다. 개별 negative job.failed를 최종 Vitest 실패로 오분류하지 않는다.
- root final readback 자기 후보·문서·표·item·제품/CDN·job/settings·replay schema/role·guard/function·타 연결 모두0, 세 stage legacy/epoch1/contract0, PUBLIC USAGE true/CREATE false, lock_timeout0/deadlock_timeout1s 확인. `/tmp/nomorevibe-pr04b2-root-final-readback-20261016.log`. 다른 whole-suite fixture와 append-only audit은 삭제하지 않았다. root container55500도 실제 STOP/exited0을 확인했다.
- 첫 root focused15 FAIL/56 PASS(151.87초)는 helper import 누락1 및 mandatory actual runner ACK 뒤 후속 producer request 누락14였다. `/tmp/nomorevibe-pr04b2-root-fixtures-first-20261016.log`. 중간 ownership1 FAIL/13 PASS는 실제 request11을10으로 가정한 fixture assertion 오류이며 원본 로그를 보존했다. 올바른 actual producer/요청 version으로 수정하고71 PASS를 확인했다. 잘못된 Python `discover -s scripts`는0tests/exit5였으며 성공으로 계산하지 않고 실제 tests 경로23 PASS를 별도로 실행했다.

## 담당 검증과 리뷰

A 기존 business2files84 PASS14.41초, B current/selection/skip30 PASS4.72초, C authority34 PASS10.07초. 각 whole tsc/scopedlint 실제exit0, raw whole-row/µs foreign·자기 잔류·관리행·stage·타 연결을 원복/readback한 뒤 STOP했다. 마지막 SKIP LOCKED 수정 후 A/B는 자기 DB만 재시작해 해당 최종 결과를 확인했고 다시 STOP했다. root는 정확한 자기 완료 STOP 세 container/volume metadata를 확인한 뒤 공간을 정리했다. forensic77/실패81/타 사용자 DB와 실행 중 root55500은 보존했다. 중복 수를 합산하지 않는다.

A/C readonly 교차 리뷰 추가P1/P2 0. C는 source SHA e7ff762a…f75 및 b1 `recordSecondReview` 본문 exact 보존, 모든 세대 item과 실제job/DBwall, 실제 admin keep/doubledecision 경계를 확인했다. B의 추가P2는 위 실제2RED→GREEN으로 닫았다. 최종 source SHA는 `092bc9ba776416bd405e7071efedbf94002fdd243502bf1f2abd56d1c24bb884`다. root가 수정 helper/reopen selector와 기존 caller fixture diff를 직접 읽고 b1 결과 writer 본문 exact 비교도 실제 exit0으로 확인했다. root 전체 DB도 이 고정 source에서 통과했다. 최종 미해결 P1/P2는0이다.

## 남은 검증

최신 main 필수 CI/정상 PR merge/main CI/image가 남는다. certified deferred flush 최종 clock·item B5·durable 외부 종료·provider baseline·2배·Oracle DR은 이 결과로 완료하지 않는다.
