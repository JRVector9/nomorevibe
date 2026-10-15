# PR04b-1 — AI2 결과·legacy handler 검증 기록

## 범위와 현재 상태

PR04a #440/main7977089 뒤 mandatory AI2 result receipt와 실제 legacy handler admission을 연결한다. 실행 계약은 [계획](../superpowers/plans/2026-10-16-pipeline-pr04b-ai2-results.md), 전체 납품 상태는 [장부](../superpowers/plans/2026-10-15-pipeline-delivery-status.md)를 따른다.

기본 legacy/epoch1/contract0, 새 consumer 비활성이다. 이번 단계 운영 배포·생산 migration·실제 provider 호출·발굴 재개는 실행하지 않았다. enqueue/close/reopen/retry controller 보강은 PR04b-2, item 실행은 PR04c, B5 item 인증·certified deferred flush 최종 wall clock·durable 외부 종료는 후속으로 남는다. 이 검증으로 2배 처리량이나 Oracle DR을 판정하지 않는다.

담당 구현과 root 직접·교차 리뷰, 단위/전체 DB/정적/build 검증을 완료했다. 최종 전체 DB는 176파일 2,024 PASS/기존 TODO1, 404.51초, exit0이다. 아래 결과는 로컬 합격 기록이며 PR·CI·병합 상태는 납품 장부를 따른다.

## 변경과 리뷰

- result writer는 receipt의 대상 ID·원래 row identity·실제 stage/owner/token/epoch/DB 만료를 검증하고 잠근 현재 입력·정책·제품 세대를 비교한다. 저장·fallback·사람 보류·outbox·자기 item release는 같은 transaction이다. caller가 주는 `status`는 결정 근거로 쓰지 않는다.
- 현재 context가 유효하지만 composite policy나 product ID만 달라졌으면 pending을 보존하고 원 owner만 정산한다. 새 실제 claim/readmit으로 같은 논리 표를 회복한다. 무조건 superseded하면 기존 unique/count 조건이 재검수를 막을 수 있다.
- handler는 실제 job lease를 요구하고 controller/budget보다 먼저 stage를 확인한다. 각 hint를 실제 admission row/input/receipt로 바꾸고 외부 대기 뒤 결과를 저장한다. 네 lane을 모두 정산한 뒤 종료하며 mode 전환은 새 호출을 멈추고 deferred로 남긴다.
- 기존 business 테스트는 실제 runJob/admit helper로 적응했다. stale/human/duplicate는 정상 admission 뒤 원 receipt를 유지한다. root replay duplicate는 같은 실제 job이 살아 있을 때 real handler 뒤 다시 저장해 not_pending과 전이 전체 불변을 확인한다.

A/B/C는 파일과 loopback DB55493/55494/55495를 분리했다. root가 실제 RED와 source를 직접 검토했고, A·B의 동결 handler 및 B의 동결 writer 교차 리뷰에서 추가 P1/P2는 없었다. root fixture 두 파일의 별도 읽기 리뷰도 추가 P1/P2가 없었다. 읽기 리뷰와 직접 테스트 실행은 구분한다.

동결 생산 source SHA256:

| 파일 | SHA256 |
| --- | --- |
| lib/crawl/second-review.ts | 9e3dc5ebcac3e1b819482cf317132f0fd169397d7a30f7150bb0c19a5d6bef42 |
| lib/crawl/jobs/second-review.ts | 67338803cf07d4b6939d2d4c55c676e48226896fe3c90447049f3d77aec14cac |

## 실제 실패에서 확인한 회귀

1. 기존 receipt-less writer는 살아 있는 foreign item이 있어도 pending 표를 agreed로 바꾸고 발행 요청을 만들었다. 실제 정상 legacy control1 PASS/우회1 RED, exit1. `/tmp/nomorevibe-pr04b-results-initial-red-20261016.log`. API/import/SQL 오류가 아닌 DB 변경 assertion 실패를 root가 수용한 뒤 writer를 수정했다.
2. 보존된 기존 handler는 items/draining에서 completed를 반환하고 healthy foreign owner 아래 transport를 호출했다. 정상 control1 PASS/3 RED를 같은 원본 SHA로 재확인한 뒤 연결했다. `/tmp/nomorevibe-pr04b-handler-initial-red-20261016.log`.
3. budget0/midtick stage 전환의 추가 실제 실패를 별도 보존했다. `/tmp/nomorevibe-pr04b-handler-budget-midtick-red-20261016.log`. 최종 신규14 PASS는 실제 stage/job blocker, request/cursor/pause 보존, 네 lane 정산, stale token·취소·정책 변경·사람 판단을 포함한다.
4. root replay3files는 첫 실행에서 **2 FAIL/29 PASS**였다. `/tmp/nomorevibe-pr04b-root-replay-fixtures-first-20261016.log`. 실제 제품을 추가하자 제품 FOR UPDATE와 restricted profile SELECT-only가 충돌했다. 다른 실패는 dispatch 중 모델을 직접 바꾼 fixture의 원 receipt가 올바르게 거절되며 job이 끝나 cleanup이 lease를 잃은 경우였다.
5. root는 cleanup을 같은 live job의 finally 안에서 기다리고 원 receipt 거절을 exact `invalid_second_review_receipt`로 확인하도록 바꿨다. 기존 blocker/mutex query·final0·model_removed assertion은 유지했다. 해당 **1 PASS/9 skip**, `/tmp/nomorevibe-pr04b-root-cleanup-receipt-green-20261016.log`.
6. C는 제품 profile 회귀에서 **6 FAIL/16 PASS**를 확보했다. actual FOR UPDATE42501, id 열 UPDATE 권한 누락, statement guard 부재가 원인이었다. `/tmp/nomorevibe-pr04b-products-profile-red-20261016.log`. 기존 source/stage/item과 같은 products `update:['id'], immutable:true` 한 줄로 수정해 **22 PASS(2.21초)**, `/tmp/nomorevibe-pr04b-products-profile-green-20261016.log`. actual generation lock과 wrong slug, id만 UPDATE 권한·테이블/name 권한0, matching/0-row UPDATE 차단, 원래 INSERT/UPDATE name/DELETE 거절, disabled trigger drift·7 guard OID/function·raw µs whole product 불변을 확인했다. 생산 generation lock·input source·role 우회/SECURITY DEFINER 변경0, 기존 profile은 바뀐 policyHash와 불일치하므로 그대로 재사용할 수 없다.

## 실행한 명령과 결과

| 담당 / 명령 | 실제 결과 | 로그 |
| --- | --- | --- |
| A DB55493: integration second-review + review-handoffs | 71 PASS, 11.08초 | /tmp/nomorevibe-pr04b-writer-existing-final-20261016.log |
| B DB55494: integration second-review-item-results + pipeline-capacity + review-publication-gate | 55 PASS, 11.04초 | /tmp/nomorevibe-pr04b-results-focused-first-20261016.log |
| B foreign raw·µs 복원 재검증: 새 writer 회귀 | 23 PASS, 7.18초 | /tmp/nomorevibe-pr04b-results-foreign-final-green-20261016.log |
| C DB55495: integration second-review-item-ownership + agent-review-job + second-review-shutdown | 20 PASS, 8.24초 | /tmp/nomorevibe-pr04b-handler-final-actual-20261016.log |
| C unit second-review-job + review-fixture-handler-dispatch | 29 PASS, 0.666초 | /tmp/nomorevibe-pr04b-handler-final-unit-20261016.log |
| C 제품 profile actual 회귀 | 22 PASS, 2.21초 | /tmp/nomorevibe-pr04b-products-profile-green-20261016.log |
| root DB55496: replay-clock + replay-second-final + replay-lifecycle + handler-profile | 4파일53 PASS, 32.93초 | /tmp/nomorevibe-pr04b-root-replay-profile-green-20261016.log |
| root DB55496: `npm run test:integration` 전체 | 176파일 2,024 PASS/기존 TODO1, 404.51초, exit0 | /tmp/nomorevibe-pr04b-root-db-full-20261016.log |
| root `npm test` | 279파일 2,922 PASS, 7.03초 | /tmp/nomorevibe-pr04b-root-unit-first-20261016.log |
| root `npx next typegen`, `npx tsc --noEmit --incremental false`, scoped eslint | exit0 | /tmp/nomorevibe-pr04b-root-tsc-adapted-20261016.log |
| root 최종 profile 포함 whole tsc/scoped eslint | exit0 | /tmp/nomorevibe-pr04b-root-tsc-final-20261016.log 및 scoped-lint-final-20261016.log |
| root `npm run lint` | exit0, 기존 vendor unused 경고1 | /tmp/nomorevibe-pr04b-root-lint-20261016.log |
| root `npm run check:i18n` | exit0, 4 locales/8 namespaces/11 pages | /tmp/nomorevibe-pr04b-root-i18n-20261016.log |
| root Python deploy unit | 23 PASS, 1.307초 | /tmp/nomorevibe-pr04b-root-python-20261016.log |
| root 최종 `npm run build`, `node scripts/bundle-size.mjs` | exit0, br148.7/159.0/136.2KB, 한도 이내 | /tmp/nomorevibe-pr04b-root-build-final-20261016.log 및 bundle-final-20261016.log |

담당 focused 수치는 겹치므로 합산하지 않는다. root55496은 pinned PG17 이미지로 생성·migration exit0 뒤 focused와 전체 DB를 순서대로 실행했다. 별도 fresh full 실행으로 주장하지 않는다. 각 담당의 최종 tsc/scoped lint도 실제 exit0이었다.

## 실패한 시도와 한계

B의 중간21 PASS/2 FAIL은 fixture가 agreeAt .99를 주면서 first .94의 승인을 기대한 경우와 의도적으로 만료한 runJob의 failed 결과 기대 누락이었다. 품질 gate나 timeout은 바꾸지 않았다. A의 cleanup 첫 read-only 조회는 scan 열 이름 오기로42703을 냈고 repository_key로 바로잡았다. root 첫 tsc의 callback generic unknown은 runJob<null>로 수정했다. 이들은 행동 RED로 계산하지 않는다.

root 첫 build는 node_modules가 다른 worktree를 가리키는 symlink여서 Turbopack이 filesystem root 밖 접근을 거절했다. `/tmp/nomorevibe-pr04b-root-build-20261016.log`. 이 worktree의 symlink만 같은 부모 dependency tree의 로컬 APFS 복사본으로 바꿔 기본 build를 통과했다. source/config/build flag 변경이나 dependency 버전 변경은 없다.

담당 DB는 자기 행과 관리행 raw timestamp·JSON을 복원하고 타 연결0·세 stage 기본값을 확인한 뒤 STOP했다. B audit109/A audit243 같은 append-only 기존 business 기록은 삭제하지 않았다. C는 제품 profile 재검증 뒤 자기 제품/CDN·guard·schema와 11개 대상 테이블 잔류0을 확인하고 STOP했다. 최종 로그는 `/tmp/nomorevibe-pr04b-products-profile-cleanup-final-{green,tsc,lint,readback}-20261016.log`다.

root 전체 실행 뒤 자기 prefix/clock/second-final 후보·문서·표, item, 자기 제품/CDN, replay role/schema/trigger/function, 타 연결 모두0을 확인했다. stage3은 legacy/epoch1/contract0, PUBLIC schema USAGE=true/CREATE=false, lock_timeout=0/deadlock_timeout=1s였다. `/tmp/nomorevibe-pr04b-root-db-final-readback-20261016.log`. 전체 suite의 다른 fixture와 append-only audit은 별도 삭제하지 않았으며 DB96은 STOP/exited0을 직접 확인했다. 읽기 조회 중 열 이름 오기42703과 pg_catalog의 기본 replay 함수6개를 넓게 센 경우는 정정해 재조회했으며 행동 실패로 계산하지 않는다. forensic77/실패81/다른 사용자 자료는 보존한다.

실제 provider serving identity·전체 비용 상한·취소 계약·30분 baseline, item B5 인증과 외부 dispatch의 durable 종료 증명은 이 결과에 포함하지 않는다.
