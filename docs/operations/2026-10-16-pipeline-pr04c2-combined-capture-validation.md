# PR04c-2a-2 검증 장부 — domain/item 단일 snapshot

[고정 계약](../superpowers/plans/2026-10-16-pipeline-pr04c2-combined-capture.md). A는 새 source와 자체 unit, B는 독립 unit, C는 새 통합 테스트와 전용 PostgreSQL 55515, root는 문서·리뷰·전체 검사·Git을 소유한다. 선행 기능의 성공은 이 모듈의 검증으로 합산하지 않는다.

## 구현 전 행동 재현

root가 아래 source·각 driver 전체와 원로그를 직접 읽고 SHA를 확인한 뒤 A의 최소 구현을 해제했다. 이 시점까지 구현 GREEN은 없다.

- 실행 가능한 SQL/strict envelope baseline: `32334d283b08ababc62d32a2c90997a34f8bfa8ce9d0eb9e41713dfc38b6a2bf`. SQL 및 exact manifest universe 검사는 구현되었고 canonical/hash만 누락되어 있다.
- A 원본 6개: 3 AssertionError FAIL / 3 control PASS, 실제 exit1, 510ms. driver SHA `583098038baf96232767e1eb3d1e7f3a9e0ce624e355127ecd81f262fac512c3`. 로그 `/tmp/nomorevibe-pr04c2-combined-a-scaffold-red-20261016.log`.
- B 독립 295개: 206 AssertionError FAIL / 89 control PASS, 실제 exit1, 891ms. driver SHA `a32d61e05bf31553fd5e3fde1ee4f6196ffb3a6ecf7eda142292d390f25a91e3`. 로그 `/tmp/nomorevibe-pr04c2-combined-b-scaffold-red-20261016.log`. full-row 각 열의 해시 결합·µs·정렬·frozen tamper·중복/안전 정수 경계를 포함한다. SQL mock은 MVCC 증거가 아니다.
- C 실제 PG 원본 2개: full SQL/universe/generic lease control 1 PASS, canonical 전체 envelope/hash 행동 1 FAIL. 실제 exit1, total1.21s/tests717ms. driver SHA `86d37717fec252d9bb89dfde2072ad4f7861c4986c96733c3251a2f0f774f26b`. 로그 `/tmp/nomorevibe-pr04c2-combined-c-initial-red-20261016.log`. hook AggregateError는 동일한 원 AssertionError를 보존하며 setup/SQL/권한/복원 오류는 없다.
- A/B whole tsc·각 scoped lint 실제 exit0. A의 앞선 transform 0-test와 prompt/rules fixture 오류는 행동 RED에서 제외했다.

root가 네 파일의 원본을 `/tmp/nomorevibe-pr04c2-combined-root-frozen-{source,a-unit,b-unit,c-driver}-20261016.ts`에 보존했다. 다음은 기대값을 바꾸지 않은 동일 driver GREEN, 실제 DB 확장 행렬, 직접/교차 리뷰와 전체 검사다.

## 동일 driver GREEN과 독립 리뷰

A는 기존 SQL/strict schema/membership를 보존하고 기존 공개 domain/item normalizer와 전체 envelope hash만 연결했다. source SHA `b398dddd983d7bc7b8dce446eb4625523287a4d1bd05d2f033e55f8dfbed3b2d`. root가 baseline 대비 최소 diff를 직접 읽었다.

- A 원6개 bytes 동일, 6 PASS/536ms/실제 exit0. whole tsc `--incremental false` 및 scoped lint 실제0. `/tmp/nomorevibe-pr04c2-combined-a-{green,tsc,lint}-20261016.log`.
- B 원295개 bytes 동일, 295 PASS/8.93s/실제 exit0. whole tsc/scoped lint 실제0, 새 source 전체 읽기 리뷰 추가 P1/P2 0. `/tmp/nomorevibe-pr04c2-combined-b-final-{green,tsc,lint}-20261016.log`.
- C 원254행/2case bytes 동일, 2 PASS/total1.36s/tests796ms/실제 exit0. `/tmp/nomorevibe-pr04c2-combined-c-initial-two-green-20261016.log`. 그 뒤 실제 DB 행렬을 추가 중이다.
- A→C baseline 리뷰 P2: 원 control의 문서/item 전체 개수 `2` 고정은 원래 외부행을 보존하는 공유 DB와 충돌한다. root가 해당 두 assertions를 raw 전체 개수 및 자체/sentinel 실제 key 포함으로 바꾸는 최소 수정을 승인했다. 원2개 GREEN은 보존하되 이후 원254행 전체 byte 동일 주장은 하지 않는다. 현재 source 결함 RED나 공유 DB에서 실제 재현한 오류로 과장하지 않는다.

## root가 실행한 전체 검사

- `npm test`: 288 files / 3,517 PASS, 13.03s, 실제 exit0. `/tmp/nomorevibe-pr04c2-combined-root-unit-20261016.log`.
- `npm run check:i18n`: locales4/namespaces8/publicPages11, 실제0. Python 배포 도구 단위 23개 실제0. `/tmp/nomorevibe-pr04c2-combined-root-{i18n,python}-20261016.log`.
- `npx tsc --noEmit --incremental false`, `npm run lint`, dummy DB 환경의 `npm run build`, `node scripts/bundle-size.mjs` 모두 실제 exit0. lint는 기존 vendor unused warning 1개/오류0. bundle br148.7/159.0/136.2KB. `/tmp/nomorevibe-pr04c2-combined-root-{tsc,lint,build,bundle}-20261016.log`.

선행 PR447 필수 CI38805574539의 scope/quality/통합3구간/check 전체 성공을 root가 확인하고 정상 squash 병합했다. 실제 main `820f7fe7a0a1c8e0e5698b53f2e83d30d5f71e67`, merged `2026-10-15T21:01:50Z`. main CI는 별도 추적하며 이미지 생성과 운영 적용을 구분한다. PR446 main CI38804670621은 두 image까지 전체 성공했다.

## 실제 DB 행렬과 관련 회귀

C 최종 481행 SHA `0694ed58d9ef1d7623fcc93aba65125b103c4d656ea8d1ac5727dd8a3ab12dba`: 15 PASS/total4.51s/tests3.98s/실제0. whole tsc/scoped lint 실제0. `/tmp/nomorevibe-pr04c2-combined-c-expanded-{first,tsc,lint}-20261016.log` (첫 GREEN 파일명은 `...-c-expanded-first-20261016.log`). 원254행 증거를 보존했고 승인된 control의 전체 개수·fixture key 경계만 고친 뒤 append했다. `/tmp/nomorevibe-pr04c2-combined-c-driver-conformance-20261016.log`.

확인한 범위는 실제 137 frozen 입력·generic leases와 외부행 전량, 한 실제 writer TX의 domain/item 변경 전 old/old와 commit 후 new/new, 서로 다른 시점의 두 읽기로 만든 혼합 대조, 현재 run에 한정한 frozen/calls와 외부 run 보존, DB universe 4종 거절, domain/item SQL 열 추가·삭제의 strict 거절/DDL rollback, 실제 자기 backend의 blocked query 취소57014, genuine v5 SELECT 및 원 immutable DML/item entry 차단이다. generic lease는 domain/AI2 실행권한의 증거가 아니다. old/old→new/new 테스트만으로 query 분할 mutant를 잡았다고 주장하지 않는다. literal 한 statement 경계의 정적/단위 증거와 실제 관측을 구분한다.

root 관련 회귀: combined15 + item capture9 + item state7 + certified wall2 = 4 files / 33 PASS, 11.82s, 실제 exit0. `/tmp/nomorevibe-pr04c2-combined-root-related-db-20261016.log`. expired-owner negative control의 `job_lease_lost` 로그는 예상된 거절이며 테스트 실패가 아니다. 로컬 전체 DB suite는 다시 실행하지 않았고 이후 PR 필수 CI가 남아 있다.

root가 전용55515에서 원 readback 스크립트를 실행해 전체 public raw·원 stage의 µs timestamp·effective DB/PUBLIC ACL·원 public 함수 OID/정의·trigger를 baseline과 비교했고 실제0이었다. 원 migration0058 jitoff/source=database 및 timeout0/1s/0를 보존했다. 공개 표준 초기행 stage3/visit1만 남고 replay schema/role·column ACL·다른 연결 0. `/tmp/nomorevibe-pr04c2-combined-root-related-final-readback-20261016.log` 및 C 라벨별 JSON. DB는 최신 main 통합 후 관련 회귀를 위해 아직 RUNNING이며 STOP 완료로 기록하지 않는다.

현재 root/B source 리뷰 추가 P1/P2 0, A→C 최종 리뷰는 대기 중이다. 새 source와 unit 2개는 동결했다. 기존 v1/profile/entry/권한 및 item 인증 실행 차단은 바꾸지 않았다. 실제 provider baseline·2배·Oracle DR 또는 운영 적용의 증거가 아니다.
