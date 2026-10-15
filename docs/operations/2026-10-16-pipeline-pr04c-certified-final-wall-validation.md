# PR04c-1a 실제 검증 기록 — 2026-10-16

실행 계약: [계획](../superpowers/plans/2026-10-16-pipeline-pr04c-certified-final-wall.md). 최종 source와 실제 실행 결과를 기록한다. PR/CI·운영 적용은 별도 상태다.

## 현재 실제 결과

- base #442/main05cedd17: PR CI38788541111 필수 check 전체 SUCCESS 후 정상 병합. main CI38789769881 필수check·웹/워커 image 전체 SUCCESS root 직접 확인. feature2fb960a와 main tree 동일 diff exit0, 새 WT 정상 merge HEADbd82d7f1. 운영 적용0.
- root typegen exit0: `/tmp/nomorevibe-pr04c-wall-typegen-20261016.log`.
- A hook 단위 실제2FAIL/exit1: 순서에 finalWall 없음, 만료 hook 누락으로 native commit/ack. root 원로그 직접 확인, `/tmp/nomorevibe-pr04c-a-final-wall-unit-red-20261016.log`. 실제 DB 행동 RED와 구분한다.
- C authentic 기존 normal controls7PASS/20.62초/exit0 담당 보고, 원로그 `/tmp/nomorevibe-pr04c-wall-authority-baseline-controls-20261016.log`는 root 직접 확인 완료. 최초3 fixture assertion 실패는 문자열 bigint0/NULL 의미 오해이며 행동 RED가 아니다.
- B actual postflush **1행동FAIL/control1PASS,4.59초/exit1** root 원로그·driver 직접 수용. `/tmp/nomorevibe-pr04c-wall-independent-feature-red-20261016.log` SHA d503506391a034ca7347db14367989d86f6ea46496923a7b253a743161ac259c. fixed timeout/genuine locked_at headroom500ms; waiter173→holder162 실제 capacity_runs FOR UPDATE wait healthy→expired 뒤 oldwriter recorded, pending→agreed·publish요청0→1·journal packets7→8/changes7→9/events13→15 실제 commit. 나중 runner 실패와 구분해 before/after 전체불변 assertion이 실패했다. source 구현을 A에 해제했다. B test SHAbe4670bf9f31435f7cb954cae02a28de785c774b8b34b8ebc5a9bb7b895b65b7 동결. 최초3s headroom은 timeout rollback이므로 행동 RED가 아니며 원로그 보존. 동일 driver GREEN과 root 전체 gate 결과는 아래 최종 기록을 따른다.
- C ack focused1PASS/9skip 실제exit0 root 원로그 직접 확인. 최초 expanded exit0는 inner runJob이 assertion을 삼킨 위양성 경계로 최종근거에서 제외했다. 정확한 ack 오류와 inner outcome completed를 outer not_quiescent와 독립 필수검사한 뒤 실제1PASS. `/tmp/nomorevibe-pr04c-wall-authority-ack-control-20261016.log`.

## 작업 경계와 남은 확인

source5개와 단위2files는 A, 신규 DB race file은 B, 신규 authority file은 C, 문서/Git/나머지 fixture/전체 gate는 root다. 자세한 경로·DB는 계획을 따른다. 모델 gpt-6.1-sol/xhigh. DB는 각자 loopback55501/2/3이며 다른 DB/운영/provider 접근0. Docker 여유 경고 뒤 root는 완료 STOP/exited0 b2 root55500만 metadata 보존·제거하고2.3GB/98% 확인했다. forensic/타사용자 자료와 cache/image는 보존했다.

실제 B RED 수용→최소 source 구현→독립 GREEN→직접/교차리뷰→전체 unit/DB/정적/build/readback/STOP→PR/CI 순으로 진행한다. item lifecycle/B5 인증·provider/30분baseline·2배·Oracle DR·운영 적용은 포함하지 않는다.

## 구현 후 checkpoint / 아직 최종 gate 아님

- root가 source5파일 full diff 직접 리뷰, 임의JSON sibling metadata replay를 막는 private TX-local challenge 및 entry name/token snapshot 보강을 고정했다. A 최종 source SHA(execution)3f2444c29c65f87c73626f0c58dfcada53c4c93d58b7f69868f3d68bdc254f52 시점이다.
- B frozen test be4670bf…65b7 동일 driver **2PASS/4.87초/exit0**, `/tmp/nomorevibe-pr04c-wall-independent-feature-green-20261016.log` root 직접 확인. 만료 시 writer full raw snapshot(domain/vote/outbox/changes/packets/confirmations/events/finals/projection/head) 불변·동일 class lease 오류·writer결과0. 첫call historical fixture라 생성된 final rollback은 증명하지 않는다. B tsc/scopedlint0, own55502 readback/STOP 보고 수령, 최종 root 확인 예정.
- root 전체 unit **280files2,928PASS/7.99초/exit0** session84639. 관련 DB6files **48PASS/81.61초/exit0** session27463(own55504, 먼저 migrate0). `/tmp/nomorevibe-pr04c-wall-root-{unit,focused}-20261016.log`. 서로 다른 전체 DB 합격으로 주장하지 않는다.
- A unit53PASS/자기 기존DB5files55PASS 담당 보고, 최종 source와실행시점이 겹친 점을 스스로 구분하고 후속 재검증 중이다. C first authority14PASS/3FAIL은 pool max1중첩/SQLrenderer/Drizzle cause fixture 문제로 보존하고 기능RED에서 제외했다. genuine 별도 native connection의 sibling공격/endedTX focused3PASS 담당 보고, 최종 행렬/원로그 root 확인 예정.
- A self-review가 **flush중 ticket state=open** 경계를 보고했다. 실제 guardedcallback은 이미 closing이지만 direct native hooks에서 flush가 runlock을 가진 동안 늦은 registration이 가능해지는지 C가 genuine deferred callback barrier로 실제RED를 준비한다. root가 이 한 건의 RED 후 open→flushing→flushed 최소보강을 고정했다. 현재 source freeze, 이 추가보강 뒤 최종 전체gate를 실행한다. B readonly 교차리뷰는 이 동일건 외 미해결P1/P2 발견0 보고, 아직 최종반환 전이다.
- root Docker55504 own 준비/마이그레이션0, 아직 running. 실제 free2.2GB/98%. 다른 DB/운영 접근0.

## 최종 source / root 전체 gate 실행 중

execution 최종SHA **9d3fe65e9e3146b1855c34947d4c49a3330a2c1f8085255ca881404343a2f1fd**. B readonly 교차리뷰 추가P1/P2 0 최종반환, A source5/단위2파일 동결. C의 flushing actual1RED/19skip(exit1) 원로그·실제driver를 root가 직접읽어 수용했다. same test SHA138892bed719630d0b139aacb1da96306a756d1d5b3501a6230760bb11575cab은 actualnative deferredcallback+packet을 확인하고 lateAccepted=true로 실패했다. patch 뒤 focused1PASS/19skip 담당보고, 전체20·정적/readback/STOP은 진행중이다. C 이전19PASS27.68초 원로그도 root직접확인(phasepatch전 증거).

root 최종unit **280파일2,928PASS/9.43초 exit0** 및 whole tsc/전체lint(기존vendorwarning1) session90170 exit0. i18n/Python23/build/bundle session71247 exit0. `/tmp/nomorevibe-pr04c-wall-root-{unit-final,tsc-final,lint-final,i18n,python,build,bundle}-20261016.log`, bundle br148.7/159.0/136.2KB 한도내.

전체 DB session52482 **실행중**(아직 PASS 주장0). 명령: `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55504/nomorevibe_test PIPELINE_TEST_LOG_PREFIX=/tmp/nomorevibe-pr04c-wall-root-db node /tmp/nomorevibe-pr04c-wall-db-diagnostics-20261016.mjs`, 로그 full-20261016.log 및 locks-20261016.jsonl. 해당 observer는 자기 DB lock만 읽고 gate/timeout을 바꾸지 않는다. 앞의 related48을 실행한 같은DB이며 별도fresh whole이라고 주장하지 않는다.

## 최종 root 검증 완료

2026-10-16 KST. source/test 동결 뒤 root가 결과 로그와 프로세스 exit를 직접 확인했다.

- execution SHA `9d3fe65e9e3146b1855c34947d4c49a3330a2c1f8085255ca881404343a2f1fd`. A source5/단위2파일, B 신규 race, C 신규 authority 소유권을 반환했다. root 전체 source diff 직접 리뷰, B source/단위 교차리뷰와 A C585행 교차리뷰의 미해결 P1/P2는 0이다.
- **전체 DB 180파일 2,112 PASS / 기존 TODO1, 465.61초, 실제 exit0**. 위 observer 명령/session52482의 최종 Vitest summary와 종료를 확인했다. 로그 `/tmp/nomorevibe-pr04c-wall-root-db-full-20261016.log`; 실제 lock 관측 `/tmp/nomorevibe-pr04c-wall-root-db-locks-20261016.jsonl`. related48을 먼저 실행한 같은 DB이며 별도 fresh whole이라고 주장하지 않는다.
- **전체 unit 280파일 2,928 PASS /9.43초, whole tsc·lint·i18n·Python23·build·bundle exit0**. 앞 최종 로그가 증거다. 기존 vendor lint warning1, bundle br148.7/159.0/136.2KB 한도 이내다.
- C 최종 동일 20case **20 PASS/29.92초/exit0**를 원로그로 확인했다: `/tmp/nomorevibe-pr04c-wall-authority-final20-20261016.log`. final test SHA `138892bed719630d0b139aacb1da96306a756d1d5b3501a6230760bb11575cab`. actual flushing1RED→동일 focused1GREEN→최종20 및 root whole을 구분한다.
- A final source unit53/lifecycle15 PASS와 whole tsc/scopedlint0를 확인했다. 이전 pre-flushing source의 관련55PASS를 final55 재실행으로 바꾸지 않는다. root whole이 최종 source의 관련 회귀를 포함한다.
- root own55504 최종 readback 실제 exit0: 자기 candidate/document/vote/item/product/CDN/job/settings, replay schema/role/profile trigger/function 및 다른 client connection **전부0**. 3stage **legacy/epoch1/contract0**, PUBLIC USAGE=true/CREATE=false, lock_timeout=0/deadlock_timeout=1s. `/tmp/nomorevibe-pr04c-wall-root-final-readback-20261016.log`. exact container `nomorevibe-pr04c-wall-root-db-20261016` **STOP/exited0**를 실제 inspect로 확인했다. 다른 전체-suite fixture/append-only 감사행은 삭제하지 않았다.
- A55501/B55502/C55503도 자기 raw/µs 복원·잔류/권한/타연결 readback과 STOP/exited0를 root 직접 확인했다. A 최초 빈 cleanup 로그는 증거가 아니며 docker exec -i 뒤 실제 성공 readback으로 대체했다. DockerVM 여유2.2GB/98%에서 타사용자/forensic 자료·cache/image의 광범위 삭제0이다.

B 역사적 first call은 actual AI2 call1/final0이라 **생성된 capacity_finals rollback 자체를 증명하지 않는다**. 전체 raw snapshot 불변과 domain/outbox/journal rollback이 해당 race의 증거다. C initial fixture bigint/NULL·max1 pool/endedTX 오류, inner assertion을 runJob이 삼킨 위양성, B 3초 headroom timeout은 행동 RED에서 제외했다. 모델 품질·timeout·인증·권한 gate 완화0이다.

기본 legacy와 새 consumer 비활성을 유지한다. 한-item lifecycle(c1b), item B5(c2), PR05/07 durable physical-call admission/종료, provider identity/상한/취소·실제30분 baseline·2배·Oracle DR·운영 배포는 미완료다. 다음 작업 계약은 /tmp 읽기 노트 단계이며 아직 구현/새 PASS가 아니다.

## PR443 CI 실패와 테스트 동기화 보강

첫 feature head af4df25의 PR CI38793351252는 quality·통합1/2 SUCCESS, 통합3 **1FAIL/789PASS·기존TODO1**로 check FAILURE/image SKIP이었다. 원로그 `/tmp/nomorevibe-pr04c-wall-pr443-ci-failed-20261016.log`. 실제 정상 control에서 job locked_at→run-row wait 관측까지 약4.18초가 걸렸다. 기존 committed500ms headroom은 expensive 준비 전에 소진될 수 있고, waiter poll0 원assertion을 runJob이 catch한 뒤 afterundefined TypeError가 덮었다. 생산 최종wall source5개는 변경하지 않았다.

root와 B가 테스트 한 파일만 보강하고 root 직접 리뷰했다. 실제 currentReplayDb executor transaction **단1회 pass-through**가 원 result writer callback을 끝까지 실행한 뒤 **같은 실제 TX의 자기 job name+token CAS**로 locked_at을 조정해750ms headroom/정확한 DBexpiry를 RETURNING한다. 기존 native after/실제 run-row holder/query·pg_blocking_pids·고정1초 locktimeout을 그대로 거친다. transaction descriptor는 finally에서 복원하고 holder/writer를 drain한다. actual callback 원오류는 외부에서 다시 검사하므로 TypeError가 가리지 않는다. holder 생성 뒤 try 밖에서 executor를 조회하던 정리 경계는 root 리뷰로 앞쪽 조회로 옮겼다.

이 fixture는 앞의 committed500ms driver와 다른 **same-writer-TX callback-end anchor**다. 미커밋 job값을 admin이 읽었다고 주장하지 않고 RETURNING한 exact expiry와 실제 DBclock을 비교한다. timestamp parameter를 직접 `::timestamp`로 바인딩하면 driver OID serializer가 KST/µs를 변형했다. 첫 새driver1FAIL/control1PASS와 `/tmp/nomorevibe-pr04c-wall-ci-fixture-anchor-diagnostic-20261016.log`는 fixture SQL 실패로 행동RED에서 제외했다. `::text::timestamp`로 고정해 exact readback을 assert하며 정책/TTL/DBtimeout/gate는 변경0이다.

최종 동일driver SHA **6bbc9186e47ac627c3ba0e8550bcaecc1d6cb6f6dd6d3d88cd739b12578df548**를 root가 oldsource05cedd17 임시WT로 복사하고 양쪽 hash를 직접 확인했다. 같은 전용55506 DB를 순차 사용했다.

- oldsource 실제 **feature1FAIL/control1PASS·exit1/5.07초**: `/tmp/nomorevibe-pr04c-wall-ci-fixture-feature-red-20261016.log`. holder157→writer168 실제 capacity_runs FOR UPDATE wait. healthy wall19:38:54.977129, exact expiry/readback19:38:55.719991, unlock 전 wall19:38:55.731671 expired=true. oldwriter recorded·pending→agreed·publish[]→[1]·packets6→7/changes6→9/events12→14/head12→14 실제 commit으로 raw equality가 실패했다. 나중 runner 실패와 구분한다.
- 현재 c1a 같은driver **2PASS·exit0/5.07초**: `/tmp/nomorevibe-pr04c-wall-ci-fixture-feature-green-20261016.log`. actual writer error stack이 execution.finalWall:135의 JobLeaseLostError이고 domain/outbox/journal full snapshot 불변·actual runJob failed를 확인했다. root가 원로그/driver를 직접 읽었다.

전체 source unit2,928/DB2,112PASS와 build/정적의 앞 검증은 source가 동일한 상태에서 실행했으며, 마지막 이 fixture 변경 뒤 전체 DB를 다시 돌렸다고 주장하지 않는다. 최종 fixture의 필수 PR CI는 새 commit 뒤 재검증한다. item lifecycle/B5·운영 적용·2배/DR은 계속 별도다.
