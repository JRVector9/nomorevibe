# PR03d maintenance·소개·분류 입력 실제 검증

PR03c source1da624d를 바탕으로 root가 gpt-6.1-sol/xhigh 세 담당의 파일/DB 소유권을 분리했다. A는 maintenance source5, B는 소개·분류 source5, C는 신규 integration2개만 편집했다. root가 실제 RED를 확인한 뒤 구현을 승인했고 직접 코드 리뷰와 A/B 교차 리뷰를 수행했다. production10파일 변경은48추가/19삭제이며 기존 business 테스트10파일은 수정하지 않았다.

## 동작과 유지하는 경계

- reconsider·rejudge apply/revert·duplicate apply의 기존 TX 첫 줄에 fetch→ai1→ai2 stage SHARE를 추가했다. tidy/name은 기존 단일 CAS를 entry별 짧은 TX로 감쌌다. 기존 batch/부분 commit·alias/fetching/provider cooldown·사람 결정·raw µs receipt/revert 조건은 유지한다.
- tagline auto/manual·category hold/manual·intro editor/request fix/check의 canonical write TX가 domain/generation 전 같은 prefix를 얻는다. recordTaglineResult는 publish request 뒤, recordIntroCheck는 success/failure 실제 쓰기 뒤 마지막에 DB wallclock으로 job 권한을 확인한다. worker snapshot/CAS·수동 소개·maker 우선·요청 원자성·실패 backoff를 유지한다.
- keepIntro 및 intro 요청/단순 처리 metadata는 이번 canonical input 변경 범위 밖이다. manual tagline 저장 뒤 별도 admin 승인이 실패해도 기존 수동 줄은 남긴다. API/모델/품질 gate/동시성/transport 변경0, 외부 호출 중 DB TX 추가0, live item/attempt 조기 반납0이다. mode items/draining에서도 controller는 동작한다.

## 독립 실제 RED → GREEN

- 기존 실제 reconsider·tagline writer가 ai1 stage FOR UPDATE를 우회해 completed인2 RED와 정상 control2 PASS를 먼저 확인했다. `/tmp/nomorevibe-pr03d-independent-initial-red-20261016.log`.
- 확대 회귀는 모든 entry의 실제 pg_blocking_pids/NOWAIT/advisory 관측, mode 독립, healthy item/running attempt 원행 불변, stale/human CAS, actual publish/fetch request trigger 실패 원자 rollback을 확인한다. worker는 실제 job 잠금 대기 중 token 교체와 DB clock healthy_at_start=true/expired_now=true를 관측하고 success/failure 결과 전체 rollback을 검사한다.
- 교차 리뷰에서 global selector LIMIT2000 뒤 자기 ID를 찾는 fixture P2를 발견했다. unrelated eligible2000행을 먼저 생성한 실제 reconsider/tagline selector에서 각각 entries0/task없음의2 RED를 재현했다. preview 동안 target 외 demand의 decided_by만 임시 NULL로 두고 같은 열만 raw recordset으로 복원·전체 to_jsonb exact 비교한다. 기존 selector/API를 유지하며 최종 신규2파일29 PASS(4.09초). 별도 RED `/tmp/nomorevibe-pr03d-independent-selector-red-20261016.log`, GREEN `/tmp/nomorevibe-pr03d-independent-final-selector-green-20261016.log`.
- 중간27개 실행은 Docker VM ENOSPC(SQLSTATE53100)로10 FAIL/17 PASS였다. 그 원로그 파일은 담당이27 PASS 재실행으로 덮어 원본 파일을 보존하지 못했다. 원오류와 수치는 도구 출력·보고 메시지에 남았으며 code RED로 세지 않는다. 이후 공간 복구 뒤27 PASS, fixture 보완 후29 PASS를 별도로 기록했다. raw 원행/job/settings/stage 복원과 자기 CDN purge cleanup은 유지한다.

## 담당 및 root 실제 결과

- A 기존 integration5파일26 PASS(6.63초), B 기존5파일45 PASS(6.42초). 각 whole tsc/scoped lint exit0. A/B 전용55485/86은 자체 fixture/연결/item0·기본stage를 확인한 뒤 STOP. root 공간 복구 시 완료된86 volume을 삭제했고85는 보존했다.
- B 첫 tsc는 C 파일 작성 중 syntax3건으로 실패해 저장 완료 뒤 재실행 exit0. A의 patch context 불일치/no-write와 readback 테이블명 오타는 정정했다. C readback의 bigint epoch 문자열 비교 오류도 정정 대상이다. 이들은 행동 RED가 아니다.
- root final source unit277파일 **2,857 PASS**(8.08초), whole tsc·전체lint·i18n·Python23·production build·bundle exit0. 기존 vendor lint warning1. bundle148.7/159.0/136.2KB로 각 기존10% 한도 이내다. 그 뒤 변경은 독립 selector fixture 보강뿐이며 최종 whole tsc/scoped lint도 exit0이다.
- root 전용55487의 최종 전체 integration은 **172파일 / 1,947 PASS / 기존 TODO1**(388.04초), session11128 exit0이다. 로그 `/tmp/nomorevibe-pr03d-root-db-full-fresh-20261016.log`; 동일 prefix locks.jsonl은 read-only 잠금 관측이다.
- PR03c 최종 fixture31c8de3 및 문서f23c168을 merge하고 해당 coverage-runtime 전체 파일 **6 PASS**(32.05초), session87501 exit0을 확인했다. `/tmp/nomorevibe-pr03d-root-replay-cancellation-green-20261016.log`. 그 뒤 PR438 actual mainaded56e를 정상 merge했고 production/test diff0이었다. 별도 PR CI/병합은 남아 있다.
- 최종 readback에서 stage3 legacy/epoch1/계약0, item/replay schema/role/trigger/자체 candidate/document/타 연결 모두0, PUBLIC database/schema ACL 원복과 deadlock_timeout1s/lock_timeout0을 확인했다. focused fixture가 남긴 coverage-runtime candidate/document 각1만 scoped DELETE했고 다른 자료는 건드리지 않았다. `/tmp/nomorevibe-pr03d-root-db-final-readback-20261016.log`. 전용55487 STOP 후 실제 exited를 확인했다.
- root 로그 `/tmp/nomorevibe-pr03d-root-{unit,tsc,lint,i18n,python,build,bundle}-20261016.log`; 담당 `/tmp/nomorevibe-pr03d-{maintenance,text,independent}-...-20261016.log`.

## PR438 main CI의 조회 순서 fixture 보완

PR438 main CI38772764523은 quality·integration1/3 SUCCESS, integration2의 agent-review-item-ownership 단일 테스트 FAIL(598 PASS), check FAIL/image SKIP이다. 기존 attempt 조회에 ORDER BY가 없어 exhausted handoff 전후 동일3행이 id39/38/37→37/39/38 순서로 반환돼 deepEqual이 실패했다. actual 원본 `/tmp/nomorevibe-pr438-main-ci-integration2-failure-20261016.log:47733`을 확인했다.

C가 별도 소유권으로 해당 테스트 helper 두 줄에 attempt id/job name 정렬만 추가했다. production·권한·품질·assertion 변경0, root 직접 리뷰 완료. 실제 해당 전체 파일 **38 PASS**(5.00초), whole tsc/scopedlint exit0. `/tmp/nomorevibe-pr438-independent-order-{green,tsc,lint,cleanup}-20261016.log`. 전용55489의 자체 fixture·item·sentinel·trigger/function·타 연결0 및 기본 stage를 확인하고 STOP/exited했다. 이는 원래 전체DB PASS 이후 추가한 fixture 보완의 focused GREEN이며, 기존 main CI 실패를 성공으로 덮지 않는다. PR03d 최신 CI로 함께 검증한다.

root87/03c88은 최종 readback·STOP 뒤 검증 완료한 자기 test container/volume만 제거해 Docker VM free2.4GB를 확보했다. forensic77/실패81·타 사용자 자료는 보존했다.

## 남은 범위

PR04 full AI2 authority, B5 item certificate, durable legacy 외부 종료, provider serving identity/전체 비용·취소/30분 실모델 baseline, 2배 처리량 및 Oracle DR은 별도 미완료다. default legacy/epoch1/contract0·새 consumer 비활성을 유지한다. 운영 DDL/배포/provider inference/신규 발굴 재개0이며 마지막 확인 운영 릴리스8020dca다. 향후 legacy image rollout 전0077 migration 선적용이 필요하다.
