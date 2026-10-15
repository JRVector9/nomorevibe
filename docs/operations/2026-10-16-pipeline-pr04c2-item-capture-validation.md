# PR04c-2a-1 검증 장부 — 단일 statement item capture

[고정 실행 계약](../superpowers/plans/2026-10-16-pipeline-pr04c2-item-capture.md). 기존v1/profile/entry/권한·standaloneitemstate는byte변경0이며새capture1파일만추가한다. 운영deploy/DDL/inference/새consumer활성화0이다.

A runnablebaseline d924 source와동결primaryee9 driver는실제3AssertionFAIL/3controlPASS254ms/exit1→최종sourceb417에서같은6PASS366ms/exit0, whole tsc/scopedlint0이다. `/tmp/nomorevibe-pr04c2-capture-a-{scaffold-red,green,tsc,lint}-20261016.log`. root는원source/unit/log를직접읽었다. baselinebytes `/tmp/nomorevibe-pr04c2-capture-d924-baseline-source-20261016.ts`를보존했다.

C actualSQL 원2caseSHA4f056: stage6/item12열·실generic90초control1PASS/UTCcanonical·hash행동1FAIL913ms/exit1→같은2PASS1.04s/exit0→확장9PASS2.17s/exit0. 최종352행SHAf08791438244268343467717ee76678d081452fb1b12cf8e93db2ecfcf70e481이며원2case전체byteprefix동일이다. 최초확장case괄호transform0tests/exit1은기능RED에서제외하고수정후GREEN/whole tsc·lints0을별도기록한다. 원로그 `/tmp/nomorevibe-pr04c2-capture-c-{initial-red,same-two-green,same-two-green-r2,whole9-first,driver-conformance,final-tsc,final-lint}-20261016.log`.

C는101+전체행/genericrenew·원release/외부·과거epoch/pairedMVCC/actualblocking취소57014/같은TX추가·누락SQL열rollback/v5제한SELECT·ALWAYSimmutable·itementryunsupported를검증했다. root관련gate는55511의capture9+state7=**2files16PASS3.42s/실제exit0**, `/tmp/nomorevibe-pr04c2-capture-root-focused-db-20261016.log`. snapshot은실제read결과이며ready/인증journal/coverage/commit/2배성능증거아니다. A→C읽기리뷰/C최종rawreadback·STOP은수신대기다.

B는CIfixture정산을먼저마쳤고독립unit을현재작성중이다. B실제RED/GREEN·root전체unit/정적gate/새PR·CI는아직PASS아니다. 별도baselineWT에서원d924와같은동결driverbytes를사용한다.

선행PR445는필수CI38800981283 전체SUCCESS→actualmaine11 정상병합. mainCI38802089410은qualitySUCCESS·통합진행중이다. root가captureWT에정상통합HEADcf863f7c를확인했다.

## 독립 경계 검증과 최소 보강

B frozen driver 90case/271행 SHA `792a3e6e8615e91665493a5a8ae60e1d6ab0629aa694ac9e4b956bd3cac54fc7`는 보존된 d924 baseline에서 38AssertionFAIL/52controlPASS595ms/exit1, b417에서 89PASS/배열유사result1FAIL595ms/exit1이었다. root가 전체driver와 원 current실패 로그를 직접 읽고 잘못된 result형식 fail-closed 계약의 gap을 수용했다. A가 resultguard에 Array.isArray만 추가한 최종source `5e313f404775b595414c5f5e3f49c8ad8a694eaa8bb65686d9672d92ad3637db`에서 같은90PASS1.38s/exit0·whole tsc/scopedlint0, A같은6PASS296ms/exit0·정적0이다. 실제 native PostgreSQL이 배열유사객체를 반환했다거나 권한·authority 결함이라는 주장은 하지 않는다. 로그 `/tmp/nomorevibe-pr04c2-capture-b-{baseline-red,current-before-guard,final-green,final-tsc,final-lint}-20261016.log`, A `...-a-result-guard-{green,tsc,lint}-20261016.log`. B가 root의 A/C RED 수용과 A 구현 뒤 baseline을 검증한 순서를 유지한다.

C f087 driver의 정상9PASS 뒤 A 교차리뷰에서 framework timeout후 원Promise 미정산 P2를 발견했다. 같은 v5 case CLI100ms는 실제timeout1/8skip/exit1 외 raw복원42501·runtime role/column ACL 잔류를 재현했다. `/tmp/nomorevibe-pr04c2-capture-c-forced-timeout-before-20261016.log`. process종료·다른연결0과 정확identity를 확인한 후, root는 기존 exported handler-profile teardown과 bootstrap release의 동일identity/active0/원ACL 검증을 /tmp recovery에서 재사용하도록 배정했다. 복구 exit0와 원stage raw·권한 일치가 확인되었다. `/tmp/nomorevibe-pr04c2-capture-c-timeout-recovery-20261016.log`. 임의guard우회·타DB수정0이다.

3187 중간정산fix는 같은9PASS(total3.01s/tests2.41s)/정적0, 같은100ms는 예상timeout만 남고 정상cleanup/rawreadback을 확인했다. 초기 wrapper의 Vitest fixture parser 0test setup실패는 기능RED에서 제외하고 zero-argument wrapper로 수정했다. 모든8정의/9case inner body는 f087과 byte동일이며 초기165행 전체prefix는 허용된 registration/hooks/wrapper 때문에 달라졌다. 재리뷰에서 registry를 allSettled 전에 비우는 hook-timeout 경계와 finally admin.end 예외의 원오류 대체 경계를 추가로 보완 중이다. 이 두 구조 지적의 80초 실재현은 수행하지 않는다. 최종same9·정적/회복감도·readbackSTOP/재리뷰는 별도로 기록한다.

root wholeunit **286files3216PASS7.93s/actualexit0**, whole tsc(3187기준)/lint(기존vendor warning1)/i18n4·8·11/Python23 actualexit0. `/tmp/nomorevibe-pr04c2-capture-root-{unit,tsc,lint,i18n,python}-20261016.log`. root관련DB16은 정산wrapper 보완 전 결과이며 최종C9와 구분한다. 새 build/bundle과 PR CI는 아직이다.

## 최종 정산 보강과 root gate

C 최종377행 SHA `5486855bf9c2d047bff0b35d12ae53927a18817aed71870dfd3b339d4fbef1a2`: Set snapshot을 실제 allSettled한 뒤 해당 Promise만 삭제하고, admin.end도 같은 allSteps의 마지막 단계로 오류를 합산한다. 기존8정의/9case의 inner body와 초기2case 본문은 byte동일하다. same9PASS(total1.97s/tests1.47s)/actualexit0·whole tsc/scopedlint0. 같은profile case CLI100ms는 예상timeout1/8skip/exit1만 남고 실제356ms까지 정산·정리오류0 및 rawreadback exit0이다. hook60초 경계와 종료 동시 오류는 코드리뷰로 보강했고 80초 강제실험·dual-error fault 주입은 하지 않았다. root 직접코드리뷰 및 A 최종읽기재리뷰의 추가P1/P2는0이다. `/tmp/nomorevibe-pr04c2-capture-c-final-cleanup-{whole9,tsc,lint,conformance,readback,stop}-20261016.log`.

최종 rawreadback에서 public 전체는 원stage3/visit_collection_state1 외 모든행0, stage 전체raw·원updated_at/legacy1contract0 일치, role/schema/trigger/function/columnACL/unsafe relationACL/타connection0·effective PUBLIC ACL원상·baseline jit=off와timeout0/1s/0이다. STOP/exited0/OOMfalse를root가원로그와JSON으로직접확인했다. root build(dummyDB)/bundle actualexit0, `/tmp/nomorevibe-pr04c2-capture-root-{build,bundle}-20261016.log`; br148.7/159.0/136.2KB한도내이다. 새모듈은기존v1/profile/entry/registry/운영consumer와연결하지않는다.

전용55511/55513 모두 검증·정상STOP 뒤 root가 metadata `/tmp/nomorevibe-pr04c2-capture-completed-dbs-before-cleanup-20261016.json`를보존하고각volume이정확owncontainer에만연결되었음을확인해두container와전용volume만제거(actualexit0)했다. `/tmp/nomorevibe-pr04c2-capture-owned-db-storage-cleanup-20261016.log`. 최초anonymous-only검사에서C의명명volume이달라assert로중단했으며삭제0이었다. 명명volume의정확이름/단독연결을검증한뒤진행했고다른DB/image/cache/forensic은보존했다.

PR 제출·필수CI전체·정상main병합/mainCI는남아있다. 별도fixture PR446/CI38803582254 결과를확인하고최신main을정상통합한다.

PR446 필수CI38803582254 전체SUCCESS 뒤 실제main1fa994d2로정상병합됐다. capture feature84119d4에main을정상통합하며root소유handoff/delivery문서충돌만최신결과를보존해해결했다. 기존productionsource변경0이며통합한fixture0524·계획/validation을그대로유지한다. mainCI38804670621/최종관련회귀·이capture PR CI는별도확인한다.

## 최신 main 통합 후 관련 회귀

HEAD ee6bc242에서 전용 새55514/pinnedPG17로 fixture2+capture9+state7 **3files18PASS / total7.74s / tests6.66s / actualexit0**. `/tmp/nomorevibe-pr04c2-capture-merge-c-related18-20261016.log`. expired negative의 job_lease_lost 로그는 예상 경계이며 test 실패/timeout은0이다. production/capture/원driver SHA는 그대로다. 전체raw·원stage timestamp·PUBLIC/effectiveACL·roleconfig·함수OID/정의·trigger 정의가 baseline과 일치하고 원stage3/visitrow1 외 행0·replay role/schema/guard/columnACL/타연결0을 확인했다. STOP/exited0/OOMfalse. `/tmp/nomorevibe-pr04c2-capture-merge-c-{final-readback,stop}-20261016.log`. root가 원로그/최종summary를 직접 읽었다.

최초 readback이 PostgreSQL JIT-on을 기대해 exit1이었으나 저장소 migration0058이 database jit=off를 설정하는 것을 확인했다. 별도 ALTER/env/timeout 변경은 수행하지 않았으며 기대를 실제 repository baseline에 맞춰 재확인했다. 이 가정 오류는 기능RED가 아니다. 최종 jitoff/source=database·timeout0/1s/0과 원raw를 그대로 보존했다.
