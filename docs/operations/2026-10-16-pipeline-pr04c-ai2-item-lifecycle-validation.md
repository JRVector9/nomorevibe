# PR04c-1b 실제 검증 장부 — 2026-10-16

[실행 계약](../superpowers/plans/2026-10-16-pipeline-pr04c-ai2-item-lifecycle.md). root가 A/B/C 배타 파일·DB를 배정했다. source4개·unit2개와 integration1개가 동결됐고, 실제90초 RED→동일GREEN 및 독립 읽기 리뷰를 취합했다. 전체 DB·최종 통합행렬·CI/운영 적용은 아래 실제 결과와 구분한다.

baseaf4df25. 선행PR443 첫CI38793351252 fixture실패 뒤 보강8a0810fb를 push했고 재CI38796407826 진행 중이다. source scaffold 동결→원90초expiry actual RED→고정heartbeat→동일GREEN→직접/교차리뷰까지 진행했고 root전체gate 중이다. 실제 로그/exit/SHA와 fixture실패를 구분해 이 문서에 갱신한다.

기본 legacy/epoch1/contract0, 새 consumer 비활성. 실제 provider/운영deploy/DDL0. itemB5/durable외부종료/실제baseline/2배/DR은 별도다.

## scaffold checkpoint / 실제90초 결과는 대기 중

A heartbeat0 실행가능 scaffold의 guard unit15FAIL/15controlPASS→신규30+기존57=87PASS, actual claim33PASS4.44초/독립C shortcontrol1PASS·long1skip524ms/lint0. B 신규 transport 실행가능stub19FAIL/기존handler·fixture29PASS→같은48PASS470ms. 이 stub RED는 기존 운영 동작 결함의 재현이 아니다. root가 원로그와 full helper/handler diff를 읽었다. adapter3·fixture byte보존 보고를 받았다.

root Next typegen실제exit0(`/tmp/nomorevibe-pr04c1b-root-typegen-20261016.log`), 앞 A/B tsc는 PageProps6건누락exit2로 PASS가 아니며 재검증한다. C actual90초driver2case가실행중이고 아직 heartbeat실패/합격을 주장하지 않는다. A55505 rawreadback·STOP 증거를 root 확인했다.

선행PR443 CI38793351252는 통합3 finalwallracefixture1FAIL/789PASS·TODO1로 실패했다. old500msheadroom을 expensive 준비전에설정하는경계를 B가원로그로조사하고 oldWT해당test만보강중이다. 별도oldsourceWT/동일newdriverRED→GREEN 후필수CI 재검증하며 이문제와 c1b행동증거를혼합하지않는다.

## 실제 original 90-second expiry RED 수용

root가 C frozen driver `70b4640b5364cedf8dff35510018f4355f751741878987e3ef659d6c0c22f546` 전체와 원로그를 직접 읽고 수용했다. `/tmp/nomorevibe-pr04c1b-c-initial-control-red-20261016.log`: **short control1PASS/long1FAIL, 실제exit1/91.29초**. 최초 actual claim expiry `2026-10-15T19:32:46.252000Z`를 실제 DBclock이 넘었고 원 token/owner/boot/epochs/binding은 같은데 live=false/renewals=[]였다. 실제 경쟁 claim이 claimed가 됐고, 원 transport를 finally에서 정산한 뒤 기존 writer가 `item_lease_lost`를 반환해 기대 recorded assertion이 실패했다. API/SQL/timeout 오류가 아니다.

baseline lifecycleSHA9fda89b1f77acb6c4a6aad1af58ad4dcafa9b4fcf08fc4e0fad6eed865256223, ownership4b06fad0a7ab6b63d774fa028dd3e19fc14c9f4eb77958519da7e4a79b6c5082. DB/claim/observer/결과writer는 실제이고 기존 adapter함수경계만 barrier로 바꿨다. 실제 provider 종료·비용·baseline의 증거로 쓰지 않는다. C 자체cleanup/다른connection0·3stagelegacy1contract0 readback도 root가 원로그로 확인했다.

이 RED 뒤 A 고정heartbeat 구현을 해제했다. C는 같은2case/driver를 유지하고 final source 뒤 첫GREEN을 확인한다. 현재 GREEN/추가행렬/전체gate는 미완료다.

## 같은 driver 첫 GREEN / source 반환

같은 `70b464…f546` 두case를 변경 없이 재실행해 **2PASS/91.31초/실제exit0**를 root가 원로그로 확인했다: `/tmp/nomorevibe-pr04c1b-c-same-driver-green-20261016.log`. 기존 owner/token/boot/epochs/binding으로 actualrenew가 expiry를 연장하고 최초90초expiry를넘겨도 live/경쟁claim skipped-running, 외부Promise미정산때ended=false, 정산뒤기존writer recorded/ownrelease/publishrequest+1이 같은assertion으로통과했다. 실제 provider/종료/처리량인증으로쓰지않는다.

A final lifecycleSHA **64edfb51a4a182b343f7959523a971c2cd038c5869de3ba10310dcfd3fe7860a**, ownership **4b06fad0a7ab6b63d774fa028dd3e19fc14c9f4eb77958519da7e4a79b6c5082**, unit **3f078ee7c5a57da96340200f9a4a058d8ab089d58154bc98ec6f9909f71794fd**. heartbeat unit은8FAIL/기존30PASS→신규38+기존57=95PASS, whole tsc/scopedlint0/actualshortcontrol1PASS566ms, 자기55505readback·STOP를root가원로그로확인했다. ownership 기존16함수본문보존/newobserver1. root전체source 직접리뷰추가P1/P2 0, 독립교차리뷰·추가actual짧은행렬·전체gate는남아있다.

첫동일GREEN수용뒤C에게원longbody를보존한짧은행렬추가를배정했다. 중간빠른행렬에90초를불필요하게반복하지않고최종wholefile/rootwhole에서다시포함한다. 기본stage/consumer비활성유지.

## 교차 리뷰·transport 최종 반환 / root 전체 gate 착수

A는 B transport/legacy3hunk를, B는 A lifecycle/observer/unit을 읽기 리뷰했고 추가P1/P2 0으로 반환했다. root도 최종source 전체와 C582행 actual matrix를 직접 읽었다. C추가행렬은 gateway/CLI/Grok의 기존adapter 함수만 제어하며 actual claim/observe/renew/resultwriter를 실행한다. 최초2case/90초body·fixturecore를 보존한 최종test SHA `ddfbb7936ba9086205d7596789d7a0812ec7a217e3620b153ce2b559eca534cc`. 짧은행렬19PASS/long1skip·62.98초를 원로그로 확인했고 최종whole20은 별도 실행 중이다. `/tmp/nomorevibe-pr04c1b-c-expanded-first-20261016.log`. 실제 blockedrenew의 pg_blocking_pids·abort무시중owner보존·takeover/latewriter거절·outbox원자rollback·현재human/source/policy/productgeneration을 포함한다. 짧은 takeover의 lease_until 조정은 fault injection이며 자연90초 만료 증거와 구분한다.

B 최종 unit48PASS470ms, 기존 item ownership/shutdown/replay-second-final 3파일25PASS28.11초 실제exit0, whole tsc/scopedlint0. `/tmp/nomorevibe-pr04c1b-transport-{green,focused-db,final-tsc,lint}-20261016.log`. 전용55506 mutable10종0·3stagelegacy1contract0·role/schema/trigger/타연결0·기본ACL·append-onlyaudit1보존을 root 원로그로 확인했다. STOP/exited0 후 이미 완료한 A55505와 함께 exact이름만 metadata보존 뒤 제거했다. `/tmp/nomorevibe-pr04c1b-completed-db-before-cleanup-20261016.json`, `/tmp/nomorevibe-pr04c1b-owned-db-storage-cleanup-20261016.log`. forensic/타user/cache/image는 보존한다.

root wholeunit **282파일2,985PASS7.19초 실제exit0**: `npm test`, `/tmp/nomorevibe-pr04c1b-root-unit-20261016.log`. whole tsc·전체lint(기존vendorwarning1)·i18n actual0, `/tmp/nomorevibe-pr04c1b-root-{tsc,lint,i18n}-20261016.log`. Python 첫 명령을 scripts 디렉터리로 잘못 지정해 **0tests/exit5**였으므로 PASS로 세지 않았고 workflow의 정확한 `python3 -m unittest tests/test_deploy_shared_images.py`로 수정했다. build/bundle도 workflow의 `node scripts/bundle-size.mjs`를 따른다.

root55508 새전용DB pinnedPG17/loopback/dummy로 생성·migration 성공 뒤 전체DB 진단driver 실행 중이다. 이때 base에는 c1a 첫 fixture가 있으므로 후속선행8a0810fb 통합 뒤 fixture최종 검증을 별도로 구분한다. 최종 source4개는 64ed/4b06/d73/67f 계약을 유지한다. 전체DB·build·bundle·C최종/읽기리뷰·rootreadback/STOP·최신main통합·PR/CI/병합은 아직 PASS로 쓰지 않는다.

root 최종 Python은 정확한 workflow 명령으로 **23PASS/exit0**였다(`/tmp/nomorevibe-pr04c1b-root-python-final-20261016.log`). build→bundle도 실제exit0, `/tmp/nomorevibe-pr04c1b-root-{build,bundle}-20261016.log`, br148.7/159.0/136.2KB로 기준 한도 이내다. 앞 잘못 지정한 Python0tests는 별도 실패 기록으로 남긴다.

C동결ddfbb의 최종 wholefile **20PASS/153.25초/실제exit0**를 root 원로그로 확인했다(`/tmp/nomorevibe-pr04c1b-c-final20-20261016.log`). A독립읽기리뷰는 production추가P1/P2 0, 테스트증명경계P2 한건을 찾았다. blockedrenew 단발 waiter-count만으로는 writerTX진입이 늦어진 회귀를 놓칠 수 있어, C에게 actual transaction의 원 callback/config/result를 보존하는 임시 pass-through 순서관찰을 배정했다. 이는 새 production 결함이나 actual RED가 아니며 원90초body/defaulttimeout/authority 변경0이다. 보강 단일short재검증·root읽기리뷰는 진행 중이다.

## root 최종 회귀·순서 테스트 감도검증

root wholeDB **181파일2,132PASS/기존TODO1,611.49초, 실제exit0**: `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55508/nomorevibe_test PIPELINE_TEST_LOG_PREFIX=/tmp/nomorevibe-pr04c1b-root-db node /tmp/nomorevibe-pr04c1b-db-diagnostics-20261016.mjs`. 원로그 `/tmp/nomorevibe-pr04c1b-root-db-full-20261016.log`, 실제 lock진단 `/tmp/nomorevibe-pr04c1b-root-db-locks-20261016.jsonl`. 새DB에 migration 후 whole실행했고 기존intentional job.failed 로그는 최종Vitest PASS와 구분했다. 이 whole 시작시 c1a initialfixture/Cddfbb driver였으므로 마지막test-only 보강의 개별검증을 별도로 기록한다. source4개는 동일동결 SHA다.

C최종test **606행/SHA7e56b75026e50be5060a26238bedf86bca74fb92eb50a8aace5dca33f8c624e6**. 실제 초기화 Drizzle instance의 원 transaction을 receiver/args/config/result/예외 그대로 통과하는 임시관찰로 정확히 renew TX와 writer TX의 start/end를 기록한다. 기존 실제 pg_blocking_pids를 유지하고 `[start1,end1,start2,end2]` 및 count2를 검증한다. holder·execution drain 후 descriptor를 복원한다. A독립읽기재리뷰/root직접리뷰 추가P1/P2 0, C해당short1PASS/19skip16.22초·whole tsc/scopedlint0(`/tmp/nomorevibe-pr04c1b-c-renew-order-short-green-20261016.log`). 원90초body·최초fixturecore·기존defaulttimeout·source는 변경0이다. **2026-10-22 갱신:** 사용자가 CI 시간 하한을 줄이려고 이 원90초 실시간 대기를 짧은 lease 로 바꾸는 시험 변경을 승인했다. 운영 기본값(90초 lease·15초 연장)과 운영 경로 동작은 그대로이고, 통합 시험만 `executeSecondReviewItem` 의 `lease` 로 짧은 TTL·연장 간격을 주입한다. 근거·전후 시간은 아래 [2026-10-22 통합 시험 시간 단축](#2026-10-22-통합-시험-시간-단축) 절에 있다.

root는 독립 임시WT `/Users/jr/Desktop/projects/nomorevibe-pipeline-ai2-drain-mutant`에서 **await heartbeat 한줄만 제거**했다. mutant sourceSHA557a69b3…a2d4d1/같은test7e56/같은55507순차실행은 실제 **1FAIL/19skip16.59초·exit1**이며 trace `[start1,start2,end1,end2]`의 정확한 순서assertion이 실패했다. 원본source64ed 같은test 재실행은 **1PASS/19skip16.28초·exit0**. `/tmp/nomorevibe-pr04c1b-root-renew-order-{mutant,current-green}-20261016.log`. 이는 새생산결함 RED가 아니라 테스트 감도검증이다. 임시source는 원본WT/Git에 반영하지 않았다.

root whole후 own후보/문서/vote/item/제품/CDN/job/settings/replay schema·role·guard·function/타connection0, 3stagelegacy1contract0/PUBLIC USAGEtrue CREATEfalse·timeout0/1s 실제readback을 확인했다(`/tmp/nomorevibe-pr04c1b-root-pre-integration-readback-20261016.log`). C최종55507도 same raw잔류/권한·연결0뒤 **STOP/exited0/OOMfalse** 직접확인: `/tmp/nomorevibe-pr04c1b-c-final-stop-readback-20261016.log`, `/tmp/nomorevibe-pr04c1b-c-stop-20261016.log`. root55508은 최신main통합뒤 c1a최종fixture를 확인하고 finalreadback/STOP한다. 다른suite fixture/append-onlyaudit는 삭제하지 않는다.

선행 **PR443 재CI38796407826 모든필수check SUCCESS→정상squashmain c7754651aa548d9f6147ac2fe912bac283bc38b5 병합**을 root가 직접확인했다. 최종feature8a0810fb와 실제main tree동일이다. mainCI38797366784/image는 진행 중이다. c1b는 최신main통합·PR/필수CI/정상병합을 이어가며 운영적용/itemB5/실모델/2배/DR 완료로 올리지 않는다.

## 최신 main 통합·최종 fixture·정리 완료

feature405dace 후 mainc7754651을 정상merge한 HEADd0ff7b9다. squash ancestry add/add는 c1a최종test6bbc와 해당계획/검증을 main에서 보존하고 c1b최신handoff/delivery를 유지해해결했다. source4개와 C7e56 SHA는 모두 원동결과동일이다. 최신main의 c1afixture단독 **2PASS/5.79초 actualexit0**: `/tmp/nomorevibe-pr04c1b-root-main-integrated-wall-20261016.log`. 전체DB2132PASS와 마지막두 test-only개별검증을구분한다.

root최종rawreadback의 own후보/문서/vote/item/제품/CDN/job/settings/replay schema·role·guard·function·타connection 모두0, 3stagelegacy1contract0/PUBLIC USAGEtrue CREATEfalse·기본timeout0/1s를직접확인했다. `/tmp/nomorevibe-pr04c1b-root-final-readback-20261016.log`. root55508 **STOP/exited0/OOMfalse** 직접확인(`/tmp/nomorevibe-pr04c1b-root-stop-20261016.log`). A/B/C/root의전용4DB 모두 readback/STOP 반환완료, 타suitefixture/append-onlyaudit는보존한다. 모든source/test소유권은root에반환됐고 미해결P1/P2 0이다. PR필수CI/정상merge/mainCI 및 운영적용은별도다.

## 2026-10-22 통합 시험 시간 단축

사용자 결정(2026-10-22): CI 시간의 하한을 정하던 두 통합 시험 파일을 줄인다. 위 "원90초body 변경0" 규칙은 이 결정으로 바뀐다. 운영 기본값·동작은 바꾸지 않는다.

**주입한 값과 운영 기본값(그대로)**

- `lib/crawl/second-review-item-lifecycle.ts`: `SECOND_REVIEW_ITEM_LEASE = { ttlMs: STALE_LOCK_MS(90초), renewEveryMs: 15초 }` 로 이름만 붙였다. 호환 adapter `executeSecondReviewItem` 만 선택 인자 `lease` 를 받는다. 주지 않으면 이 운영 값이다. consumer 진입(`executeSecondReviewConsumerItem`)은 주입을 받지 않는다. 그 모델 슬롯 claim 이 운영 lease 를 직접 쓰기 때문이다. 주입 값은 `renewEveryMs < ttlMs`, TTL 1ms~1시간 정수만 받는다.
- `lib/operations/pipeline-replay-fixed-input.ts`·`pipeline-replay-model-runner.ts`: `FixedInputTiming` 에 선택 값 `workerIntervalMs` 를 더했다. 운영 `FIXED_INPUT_TIMING`·replay CLI 는 이 값을 주지 않아 reviewer 워커가 기본 5초로 폴링한다. 구간·lead·drain 은 원래부터 manifest·timing 으로 주입되던 값이라 시험 값만 줄였다.

**같은 불변식을 보는 근거**

- lease 만료·재획득·fencing: 만료 시각은 그대로 claim·연장 UPDATE 의 DB `clock_timestamp()+ttl` 이고 시계를 속이지 않는다. 시험 lease 는 6초/1초(운영과 같은 1/6 비율)다. 같은 owner·token·epoch 가 연장으로 원래 만료를 실제로 넘기고, 그 사이 경쟁 claim 은 `running` 이다(원 장기 case 와 같은 단언에 `lease_until-updated_at` 이 주입 TTL 인지 확인을 더했다). 만료 뒤 새 owner 의 재획득(epoch+1)과 늦은 원 writer 거절은 기존 takeover case 가 그대로 본다. 짧은 lease 라 실제 DB 시계 만료 뒤에만 재획득되는 case 를 하나 더했다(`reclaims an abandoned item only after its actual DB-clock expiry`).
- 연장 실패·연장 대기 drain: 첫 연장 전에 관찰 설치·행 잠금을 마치거나 연장 실패 뒤에도 lease 가 살아 있음을 단언하는 두 case 는 18초/3초를 쓴다(준비·단언 시간 수백 ms 보다 넉넉하다). `[start1,end1,start2,end2]` 순서 단언은 그대로다.
- 운영 기본값: 주입하지 않은 실제 claim 이 DB 에 90초를 쓰는지(`dispatches once when two actual executions compete`), 상수가 90초/15초인지 통합 시험이 확인한다. 단위 시험은 기존대로 90초 claim·15초 연장을 fake timer 로 보고, 주입 값이 claim·모든 연장에 쓰이며 잘못된 값은 claim 전에 거절되는지 더 본다.
- replay drain·replay 의미·manifest 구간: 같은 runner·scheduler·워커·consumer·계량기·수집기 경로다. 고정 입력 10건 구간은 8초다. 실측 마지막 호출은 legacy 1.6초, items 3.6~5.0초다(워커 5초 폴링 때는 5.5초·7.6초). drain case 는 구간 2초·답 4초·끊기 1초다(전: 12초·20초·2초). 첫 호출은 구간 시작 뒤 0.1~0.4초라 구간 끝에 반드시 진행 중이다. 끊는 실행의 상한(구간 끝+1초)은 답(호출+4초)보다 앞선다. legacy 2건·items 1건의 진행 중 호출 수, budget·장부 정산, `replay_drain_calls_cut` 단언은 바뀌지 않았다. lead 1초는 실측 적재 0.2초 안팎보다 길어 marker 가 구간 시작 전이라는 단언을 그대로 지킨다.
- 시험 이름: `renews the same actual owner beyond its original 90-second expiry before settling` 은 `... original lease expiry ...` 로 바뀌었다. 위 계획 문서의 `-t 'original 90-second expiry'` 명령은 이제 `-t 'original lease expiry'` 로 고른다.

**전후 시간(로컬 전용 PG17 컨테이너, 파일 단독)**

| 파일 | 전 | 후 |
| --- | --- | --- |
| `tests/integration/second-review-item-lifecycle.test.ts` | 159.5초(20 tests) | 22.0초(21 tests) |
| `tests/integration/pipeline-replay-fixed-input.test.ts` | 304.7초 | 83.5초 |

replay 파일의 남은 시간은 고정 입력 전체 구간 실행 다섯 번(각 약 9초), drain case 두 개(각 약 10초), 격리 DB 두 개 생성·migration(약 6.5초)이다. 더 줄이려면 첫 두 case 의 실행을 공유하는 구조 변경이 필요하다(이번에는 하지 않았다).
