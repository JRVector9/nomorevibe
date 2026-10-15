# PR03c 제품·근거 입력과 blocked 요청 실제 검증

source1da624d(base PR03b66ca2c8). gpt-6.1-sol/xhigh 세 담당을 제품 lifecycle, evidence, typed admission/runner로 분리했고 root가 공유 publication의 최종 lease 경계·통합/문서/Git을 맡았다. 각 담당 handback 뒤 root 직접 리뷰와 교차 리뷰를 수행했다. 같은 source 파일이나 DB를 두 담당이 공유 편집하지 않았다.

## 결과와 경계

- 제품·scan·reopen·관리자 lifecycle은 mode 독립이다. top write transaction이 fetch→ai1→ai2 stage SHARE를 repository/generation/domain보다 먼저 얻는다. generic 하위 generation helper의 잠금 순서를 바꾸지 않았다.
- direct evidence reopen은 실제로 변경된 후보가 있을 때 judge 요청을 같은 transaction에 기록한다. scan/recovery/request와 worker 권한은 outbox·job 잠금 대기 뒤 DB wallclock으로 검증한다.
- fetch typed admission은 stage blocked와 실제 empty를 같은 transaction에서 구분한다. 전용 `stage_blocked`만 runner가 자기 token CAS로 lock/token 두 열을 해제하고 pending requested/processed, cursor, pause, 성공·오류 이력을 보존한다. 기존 bounded done:false ACK와 healthy foreign item skip은 유지한다. 두 replay loop는 deferred에서 멈춘다.
- 정상 publication은 full AI2 승인 gate를 유지한다. product insert가 실제 publisher JobLease를 받아 callback 뒤 generation·refresh/outbox 대기까지 마친 마지막 지점에서 검사한다. 공개 실패·uptime·repo delist/keep·spam도 실제 쓰기 뒤 마지막 wallclock 검사로 만료된 권한의 전체 transaction을 rollback한다.
- healthy logical item/running attempt를 controller가 조기 반납하거나 재할당하지 않는다. default legacy/epoch1/contract0과 새 consumer 비활성을 유지한다. stage 재조회는 실제 외부 dispatch/drain 종료 증명이 아니다.

## 실제 실패 재현과 담당 결과

- product initial7 RED/control1→확대15 RED/control1→최초18 PASS. 교차 리뷰 뒤 실제 stage/job/generation 잠금 대기와 DBclock expiry7 RED/control1을 추가했다. 최종 product-stage30 PASS, 기존 business 포함10파일150 PASS. 원래 managed job의 timestamp µs 손실도 별도 SQL exact 비교의 실제 실패로 확인했고 raw JSON 복원·원행 검사로 정리했다. 첫 fixture INSERT 중복은 행동 RED로 세지 않았다.
- evidence stage5 RED/control4, direct reopen outbox 누락1 RED, request 실패 원자성1 RED, walltime2 RED를 재현했다. 최종4파일85 PASS(새15포함). foreign candidate/product/jobs/settings의 전체 raw JSON과 별도 DB hash 전후동일을 확인했다. generated search_vector를 UPDATE하려던 중간 fixture 오류는 suspend열만 복원하도록 바로잡았으며 행동 RED로 세지 않았다.
- blocked initial4 RED/control3, replay deferred 중단 unit1 RED, root 교차 리뷰의 fetch budget0 items/draining2 RED/control1을 재현했다. 최종 blocked/기존AI1/runner4파일80 PASS(새16포함), 관련 unit7파일90 PASS. root의 raw timestamp 복원 actual teardown RED→16 PASS도 별도로 확인했다.
- 각 담당 whole tsc/scopedlint exit0. 각 자체55478/79/80은 자기 fixture/item/추가 연결0·stage 기본값을 확인한 뒤 STOP했다. 위 숫자는 겹치므로 합산하지 않는다.

## root 실제 검증

- 최종 unit277파일 **2,857 PASS**(9.64초).
- next typegen, `tsc --noEmit --incremental false`, 전체 lint, i18n, Python23, production build, bundle exit0. 기존 vendor lint warning1이 있다. 새 unused fixture warning1은 변수 삭제 후 scopedlint exit0이다.
- bundle /[locale]148.7KB≤163.6KB, /p159.0KB≤174.6KB, /launch136.2KB≤149.5KB.
- 첫 full integration은170파일 중169 PASS/1 FAIL, 1,914 PASS/3 FAIL/기존TODO1(421.51초), session28846 exit1이다. 새 publication fixture가 상속된 enforce 설정에서 AI1 승인 기록 없이 guard를 호출한 세 건이다. gate/오류 assertion을 유지하고 명시 enforce 설정·현재 input과 일치하는 실제 승인·원본 settings raw exact 복원을 추가했다. 승인 없음 거절 control을 포함해31 PASS(9.72초), tsc/scopedlint exit0. source 변경0, fixture commitb5feaea. 첫 로그 `/tmp/nomorevibe-pr03c-root-db-full-fresh-20261016.log` 보존.
- actual PR03b main0330a5d 통합 merge54b9770 뒤55481 재실행은 Docker VM ENOSPC/SQLSTATE53100로 오염돼 대상 vitest만 TERM했다(session73278 exit143). 실패 로그와 서버 원본 `/tmp/nomorevibe-pr03c-root-db-verified-full-fresh-20261016.log`, `/tmp/nomorevibe-pr03c-root-enospc-postgres-20261016.log`를 보존했다. 완료·STOP·자체 정리를 확인한 임시 DB10개만 volume과 함께 삭제해 free2.5GB를 확보했다. forensic55477·실패55481 및 다른 사용자/운영 DB는 보존했다. /tmp host bind는 colima 미공유 경로라125 실패해 사용하지 않았다.
- 새 root55488 최종 전체 integration **170파일 / 1,918 PASS·기존TODO1**(404.28초), session17641 exit0. `/tmp/nomorevibe-pr03c-root-db-storage-recovered-full-fresh-20261016.log` 및 동명-locks.jsonl. timeout 완화0.
- PR437 main CI38769318771에서 coverage-runtime 한 건이30,564ms AbortError/TimeoutError로 실패했다(나머지541 PASS). PR checkout/head/main tree는 모두 동일하며 PR에서는23,423ms 통과했다. runner30s signal이 이후 CLI 명령에도 누적 전달된 fixture 경계를 확인했다. 정확히 어느 CLI에서 취소됐는지는 원로그 stack이 없어 미확정이다. certification·DB close 뒤 명시 취소를 추가해 실제1 RED(8.47초)를 재현하고, CLI의 signal 인자만 제거해 전체 해당6 PASS(33.56초)를 확인했다. runner30s·CLI10s·outer45s·실제 child-close 대기 및 기존 artifact assert는 유지한다. production 변경0. commit31c8de3, root tsc/scopedlint exit0, 읽기 교차리뷰 추가P1/P2없음. 이 fixture 보강은 앞의 전체DB 실행 뒤이며 해당 변경 파일 전체를 재검증했다.
- 최종55488 readback에서3stage legacy/epoch1/contract0, items0, replay schema/role/trigger0, own candidate/document0, 다른연결0 및 PUBLIC database/schema ACL 원복을 확인했다. `/tmp/nomorevibe-pr03c-root-db-final-readback-20261016.log`. 새55488과 실패55481은 STOP했다. 원본실패81 데이터는 보존한다.
- 나머지 로그 `/tmp/nomorevibe-pr03c-root-{unit-final,typegen,tsc-final,lint-final,i18n,python,build,bundle}-20261016.log`.

## 미완료 범위

maintenance/reconsider/rejudge/duplicate/소개·분류 입력의 나머지 controller는 PR03d로 별도 진행한다. 전체 AI2 item authority, B5 item certificate, durable legacy admission·원격 정산, provider serving identity/비용·취소/실모델30분 baseline·2배·Oracle DR은 아직 미완료다. 운영 DDL/배포/provider inference/consumer 활성화/신규 발굴 재개는 수행하지 않았다. 마지막 확인 운영 릴리스8020dca이며 향후 image rollout 전0077 migration 선적용이 필요하다.
