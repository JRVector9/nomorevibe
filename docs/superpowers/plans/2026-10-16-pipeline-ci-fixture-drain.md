# 반복 main CI 실패 — certified wall fixture 정산

PR444 mainbcf4396e CI38799565167의 두 실행에서 기존 healthy case가 default20초timeout 후에도 원exercise가진행했고, afterEach/afterAll이먼저원행을복원하다immutableguard42501→147후속FAIL을일으켰다. 원로그 `/tmp/nomorevibe-pr04c1b-main-ci-failed-20261016.log`, `...-main-ci-attempt2-failed-20261016.log`; 읽기진단 `/tmp/nomorevibe-pr04c1b-ci-timeout-diagnosis-20261016.md`. 최초지연이발생한정확한await는미확정이다. 동일재시도quality는성공했으나DB실패는닫히지않았다.

사용자승인병렬개발중 발견한필수CI회복작업이다. 별도WT `/Users/jr/Desktop/projects/nomorevibe-pipeline-wall-fixture-drain`, branch codex/pipeline-pr04c-ci-fixture-drain-20261016/basebcf4396e. B /root/pr01_final_ai2가 **tests/integration/pipeline-replay-certified-final-wall.test.ts 하나만** 수정한다. root는이계획/validation/handoff/delivery와Git·직접리뷰를소유한다. capture A/C와파일·DB를공유하지않는다. Bcapture신규unit은아직작성하지않고동결했다. 모두gpt-6.1-sol/xhigh.

test-local 원exercise Promise를추적하고hooks에서그원Promise·실제writer/holder/profile release를정산한뒤fixture원행을복원한다. wrapper의timeout이나표면Promise만정산하지않는다. 원오류와cleanup예외를숨기거나실패를성공으로바꾸지않는다. phase별monotonic duration 진단으로실제늦은부분을구분한다. callback/race/ticket/production/helper/권한·품질gate·TTL·750msanchor·원두case핵심assertions를변경하지않는다. globaltest20초/default는유지하고근거없이timeout을확대하지않는다.

기존CI의실패를실제RED로기록하며import/setup실패를기능RED로대체하지않는다. local원두caseGREEN/전체rawµs·외부행보존·정상verifiedprofile해제/정적결과, 최종samefileCI실행으로검증한다. 로컬PASS만으로CI최초지연원인이확정되었다고하지않는다. 필요하면새phase증거를읽고다음최소수정을판단한다.

B ownDB55513/nomorevibe-pr04c-ci-fixture-db-20261016, pinnedPG17 sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f/loopbackdummy만허용. rootlsof미사용확인완료. 모든borrowedstage/jobs/settings/observations rawwholeµs복원·ownprefix만삭제·role/schema/trigger/ACL/defaulttimeout·타연결0 readback/STOP/exited0/OOMfalse를반환한다. 타DB/image/cache/forensic/globalprune0.

root가직접diff/원테스트보존/actualexit·로그를검토하고featurecommit/push/PR·필수CI/정상merge/mainCI를실제확인한다. 기존PR445와capturePR는실제mainfix를정상통합후기존source동일/관련회귀/필수CI를확인한다. 운영deploy/DDL/inference/발굴재개0이며전체2배·OracleDR/providerbaseline미완료상태유지.
