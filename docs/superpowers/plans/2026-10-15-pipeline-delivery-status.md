# 파이프라인 PR별 개발·적용 현황 — 2026-10-15

승인된 [PR00–17 로드맵](2026-10-15-pipeline-pr-roadmap.md)의 납품 상태를 기록한다.
PR 번호·의존성은 유지하며, 아래 PR01 소단위는 원래 PR01 안의 검토 경계다.
전체 요구와 합격 기준은 [설계](../specs/2026-10-15-pipeline-two-times-design.md)를 따른다.

## 현재 확인된 결과

| 범위 | 개발 | main 병합 | 운영 적용 | 확인된 검증 |
| --- | --- | --- | --- | --- |
| **PR00** 응답 body 회수·근거 continuation | 완료 | [#427](https://github.com/JRVector9/nomorevibe/pull/427), `94d2f9e`; 설계 문서 포함 배포 SHA `8020dca` | **M3·mini 13앱 적용** | 회귀·전체 unit·관련 DB·CI, 실제 image/source hash·health·역할 progress·근거 helper 단일 인계 확인. 전체 적체 해소·24h·2배 검증은 아님 |
| **PR01a** 현재 검수 snapshot·오프라인 비교 | 완료 | [#429](https://github.com/JRVector9/nomorevibe/pull/429), `2ce8cff` | 미적용 | 로컬 unit 2,633 / 관련 DB 62 PASS, main CI [38702607101](https://github.com/JRVector9/nomorevibe/actions/runs/38702607101) 전체 성공. snapshot은 `as_of_snapshot_only` / `unverified` |
| **PR01b-1** 격리 DB·semantic clock·fixture 호출 예약 장부 | 완료 | [#430](https://github.com/JRVector9/nomorevibe/pull/430), `2c7a71c` | 미적용 | 로컬 unit 2,669 PASS; 전체 DB 1,657 PASS/기존 TODO 1은 마지막 예산 산술 회귀 전, 최종 관련 DB 35 PASS. main CI [38710286609](https://github.com/JRVector9/nomorevibe/actions/runs/38710286609)의 quality·통합 3shard·check·웹/워커 image 모두 성공 |
| **PR01b-2** 명시 verified Drizzle DB scope·좁은 handler table profile | 완료 | [#431](https://github.com/JRVector9/nomorevibe/pull/431), `9601e3b` | 미적용 | unit2,679·DB1,675 PASS/기존 TODO1. main CI [38716366046](https://github.com/JRVector9/nomorevibe/actions/runs/38716366046) 전체 성공. 기존 AI1 repository/writer/outbox와 실제 rollback 확인 |
| **PR01b-3** 실제 AI1/AI2 fixture handler runner | 구현·전체 검증·리뷰 완료 | [#432](https://github.com/JRVector9/nomorevibe/pull/432), `664777d`; PR·main 전체 CI 성공 | 미적용 | unit2,762·전체 DB1,689 PASS/기존 TODO1(새 실제 handler8개 포함), 타입/lint/빌드/bundle 통과. 두 검수 job만 실행·실제 모델 차단·AI2 gate/실패/보류/폴백·held outbox 확인. PR CI [38719944888](https://github.com/JRVector9/nomorevibe/actions/runs/38719944888)·main CI [38720568825](https://github.com/JRVector9/nomorevibe/actions/runs/38720568825) 전체 성공(image 포함) |
| **PR01b-4** 실제 writer 원자 final | **구현·로컬 검증·root/교차 리뷰 완료** | [#433](https://github.com/JRVector9/nomorevibe/pull/433), `4af0589`; PR·main 전체 CI 성공(image 포함) | 미적용 | unit2,781·최종 PR CI DB1,717 PASS/기존TODO1; 관련 DB68 및 AI2/기존79 PASS. 실제 원자 rollback·다중 slot·fallback·cleanup 잠금·tokenless 공개분·외부 후보 잠금 회귀 통과 |
| **PR01b-5** 준비 coverage·writer fence·인증 artifact | **구현·root/교차 리뷰・로컬 필수 검증 완료** | [#434](https://github.com/JRVector9/nomorevibe/pull/434), `d95c6c8`; PR·main 전체 CI 성공(image 포함) | 미적용 | unit2,843·전체 DB1,745 PASS/기존 TODO1, 타입/lint/i18n/Python23/build/bundle PASS. 실제 두 단계·CLI·15초 heartbeat·양방향 fence·초기 actual binding 검증. [실제 검증 기록](../../operations/2026-10-15-pipeline-pr01b-coverage-validation.md) |
| **원래 PR01 전체** 측정 기준·격리 replay | **부분 완료** | 위 기반만 병합 | replay/새 consumer 비활성 | 실제 handler·원자 final·준비 coverage·artifact/seal 기반까지 병합. provider 상한·실모델 baseline 미완료. **2배 성능 미판정** |
| **PR02** item lease·stage mode 비활성 기반 | **구현·root/교차 리뷰·전체 로컬 검증 완료** | [#435](https://github.com/JRVector9/nomorevibe/pull/435), `8f2bdb3`; PR·main 전체 CI 성공(image 포함) | legacy/계약0·운영 미적용 | [상세 계획](2026-10-15-pipeline-pr02-item-leases.md)·[실제 진행 장부](../../operations/2026-10-15-pipeline-pr02-item-leases-validation.md). 새 DB33·unit2,849·전체DB1,778 PASS/기존TODO1·tsc/lint/build/bundle PASS. PR CI38756321978·main CI38757351403 모두 SUCCESS |
| **PR03a** fetch writer 결합 | **병렬 구현·직접/교차 리뷰·전체 로컬 검증 완료** | [#436](https://github.com/JRVector9/nomorevibe/pull/436), `254a5bb`; PR·main 전체 CI 성공(image 포함) | 새 consumer 비활성·운영 미적용 | [상세 계획](2026-10-15-pipeline-pr03a-fetch-writers.md)·[실제 검증](../../operations/2026-10-15-pipeline-pr03a-fetch-validation.md). root unit2,849·전체DB1,804 PASS/기존TODO1·tsc/lint/i18n/Python23/build/bundle PASS. PR CI38759886199·main CI38760739008 모두 SUCCESS; 향후 배포 전0077 선적용 필수 |
| **PR03b** AI1 writer·공유 입력·legacy replay 호환 | **병렬 구현·root/교차 리뷰·전체 로컬 검증 완료** | [#437](https://github.com/JRVector9/nomorevibe/pull/437), `0330a5d`; PR 필수CI 성공/main CI fixture1 실패 | legacy/계약0·새 consumer 비활성 | [계획](2026-10-16-pipeline-pr03b-ai1-writers.md)·[실제 검증](../../operations/2026-10-16-pipeline-pr03b-ai1-validation.md). unit2,853·최종 전체DB1,856 PASS/기존TODO1; type/lint/i18n/Python23/build/bundle PASS. PR CI38768321001 check SUCCESS. main CI38769318771 coverage-runtime 공유30s signal로1FAIL/541PASS; 취소scope 실제1RED→6PASS 최소보강을 PR438에 포함, 기존 main image SKIP |
| **PR03c** 제품·근거 입력·blocked 요청 보존 | **세 담당 구현·root/교차 리뷰·전체 로컬 검증 완료** | [#438](https://github.com/JRVector9/nomorevibe/pull/438), `aded56e`; PR 필수CI 성공/main CI fixture1 실패 | 비활성 | source1da624d, unit2,857 PASS; 담당 evidence85·제품150·blocked/기존AI1/runner80 PASS(중복 합산 금지), type/lint/i18n/Python23/build/bundle PASS. 최종전체DB1,918PASS/기존TODO1(404.28초). publicationfixture31PASS, CI공유취소scope actual1RED→해당6PASS·정적0. PR CI38771791245 check SUCCESS, main CI38772764523 quality/통합1·3 PASS, 통합2 조회순서 fixture1 FAIL/check FAIL/image SKIP. PR03d의 최소정렬 보완 wholefile38PASS |
| **PR03d** maintenance·소개·분류 입력 | **구현·root/교차 리뷰·전체 로컬 검증 완료** | [#439](https://github.com/JRVector9/nomorevibe/pull/439), `643bd3c`; PR·main 전체 CI/image SUCCESS | 비활성 | [계획](2026-10-16-pipeline-pr03d-input-controllers.md). 실제 entry2 RED/control2 PASS→신규29PASS, source614fac5/root·교차리뷰 완료. unit2,857/type/lint/i18n/Python23/build/bundle PASS. 최종 전체DB172파일1,947PASS/기존TODO1(388.04초), PR438 mainaded56e 통합·취소fixture6PASS·readback/STOP 완료. 추가CI조회정렬fixture38PASS·tsc/lint0. PR CI38774067586·main CI38775007005 필수check·웹/워커 image 전체 SUCCESS |
| **PR04a** AI2 domain·item claim 기반 | **세 담당 구현·root/교차 리뷰·전체 로컬 검증 완료** | [#440](https://github.com/JRVector9/nomorevibe/pull/440), `7977089`; PR·main CI/image SUCCESS | 비활성 | [계획](2026-10-16-pipeline-pr04a-ai2-authority.md)·[실제 검증](../../operations/2026-10-16-pipeline-pr04a-ai2-authority-validation.md). actual source/generation·recorder wait clock RED→GREEN, claim33·pure46·published 세대2 PASS. root unit2,915/전체DB174파일1,982PASS·TODO1, type/lint/i18n/Python23/build/bundle exit0. PR CI38778457336·main CI38779482314 전체 성공. 기존 handler3RED는 b에 보존, item B5·실제 외부 종료/activation0 |
| **PR04b-1** AI2 필수 receipt 결과·기존 handler 연결 | **구현·root/교차 리뷰·전체 로컬 검증 완료** | [#441](https://github.com/JRVector9/nomorevibe/pull/441), `a0e00b7b`; PR·main CI/image SUCCESS | 비활성 | [실행 계약](2026-10-16-pipeline-pr04b-ai2-results.md)·[실제 검증](../../operations/2026-10-16-pipeline-pr04b-ai2-results-validation.md). receipt-less 저장 우회1RED/control1·기존 handler3RED→GREEN. root unit2,922/전체DB176파일2,024PASS·기존TODO1(404.51초), type/lint/i18n/Python23/build/bundle exit0. 제품 restricted-profile actual6RED→22PASS, root replay/profile53PASS. PR CI38783342933·main CI38784227699 필수check·웹/워커 image 전체 SUCCESS 직접 확인. 운영 적용과 구분 |
| **PR04b-2** AI2 enqueue/cleanup/reopen/retry | **구현·root/교차 리뷰·전체 로컬 검증 완료** | [#442](https://github.com/JRVector9/nomorevibe/pull/442), `05cedd17`; PR·main CI/image SUCCESS | 비활성 | [실행 계약](2026-10-16-pipeline-pr04b-ai2-controllers.md)·[실제 검증](../../operations/2026-10-16-pipeline-pr04b-ai2-controllers-validation.md). 실제 stage/current/human CAS/mandatory job/원자 rollback·SKIP LOCKED RED→GREEN. 담당84·30·34 PASS, root unit2,922·전체DB178파일2,090 PASS/기존TODO1(435.48초)·type/lint/i18n/Python23/build/bundle exit0. 최종source092bc9ba·미해결P1/P2 0, readback/STOP. PR CI38788541111 필수 check 전체 SUCCESS; main CI38789769881 필수check·웹/워커 image 전체 SUCCESS 직접 확인, 운영 적용은 별도 |
| **PR04c-1a** certified 최종 DBwall | **구현·root/교차 리뷰·전체 로컬 검증 완료** | [#443](https://github.com/JRVector9/nomorevibe/pull/443), `c7754651`; PR·main CI/image SUCCESS | 비활성 | [실행 계약](2026-10-16-pipeline-pr04c-certified-final-wall.md)·[실제 검증](../../operations/2026-10-16-pipeline-pr04c-certified-final-wall-validation.md). root unit2,928/전체DB180파일2,112PASS·기존TODO1·정적build0. 첫CI fixture1FAIL을 source변경0/동일새driver oldsource1RED→현재2PASS로 보강했고 재CI38796407826 전체SUCCESS 뒤 정상병합. main CI38797366784 필수check·웹/워커image 전체SUCCESS 직접확인. 운영 적용은 별도 |
| **PR04c-1b** AI2 한-item lifecycle | **구현·root/교차 리뷰·전체 로컬 회귀 완료** | [#444](https://github.com/JRVector9/nomorevibe/pull/444), `bcf4396e`; PR 필수CI SUCCESS/main CI timeout·정리 실패 | 비활성 | [계약](2026-10-16-pipeline-pr04c-ai2-item-lifecycle.md)·[검증](../../operations/2026-10-16-pipeline-pr04c-ai2-item-lifecycle-validation.md). 실제90초 expiry RED→동일GREEN/전체20PASS, rootunit2985·전체DB2132PASS/기존TODO1·정적build0. main CI38799565167은 재시도까지 healthy20초timeout 뒤 정리42501/147후속FAIL. 최초지연원인미확정, 정산보강은별도PR446 |
| **CI fixture 정산** | **구현·직접/교차 리뷰·로컬 검증 완료** | [#446](https://github.com/JRVector9/nomorevibe/pull/446), `1fa994d2`; PR·main CI38804670621 및 두 image SUCCESS | 운영 source 변경 없음 | [계약](2026-10-16-pipeline-ci-fixture-drain.md)·[검증](../../operations/2026-10-16-pipeline-ci-fixture-drain-validation.md). 원exercise 정산→정상profile해제→raw복원. 기존2PASS/정적0·강제1초 예상timeout2/후속정리오류0. 최초CI20초 지연 원인미확정 |
| **PR04c-2a-0** item 상태 순수 모델 | **병렬 구현·직접/교차 리뷰·로컬/PR CI 완료·병합** | [#445](https://github.com/JRVector9/nomorevibe/pull/445), `e11fa51c`; PR CI SUCCESS/main CI 동일fixture실패 | 비활성 | [계약](2026-10-16-pipeline-pr04c2-item-state-foundation.md)·[검증](../../operations/2026-10-16-pipeline-pr04c2-item-state-validation.md). rootunit3120/관련DB41·정적build0, PR CI38800981283 필수check전체SUCCESS. mainCI38802089410은quality·통합1/2SUCCESS·통합3같은healthy20초timeout/147후속FAIL/checkFAIL/imageSKIP. 상태모델 source결함으로확대하지않고PR446정산보강 |
| **PR04c-2a-1** 전체 item-state capture | **병렬 구현·직접/교차 리뷰·로컬/PR CI 완료·병합** | [#447](https://github.com/JRVector9/nomorevibe/pull/447), `820f7fe7`; PR CI38805574539 SUCCESS/main CI 추적 중 | 비활성 | [계약](2026-10-16-pipeline-pr04c2-item-capture.md)·[검증](../../operations/2026-10-16-pipeline-pr04c2-item-capture-validation.md). A6·B90·C9PASS, rootunit3216/최종main관련DB18·tsc/lint/i18n/Python23 실제0. Binvalidresult gap 최소guard수정·Ctimeout정리P2재현후정산보강·같은9PASS·최종교차리뷰P1/P2 0. build/bundle0·최종55514포함세전용DBrawreadbackSTOP완료. 기존v1/profile/entry/권한byte0·item인증차단유지. PR 필수CI 전체SUCCESS 후 정상병합 |
| **PR04c-2a-2** domain/item 단일 snapshot | **병렬 구현·root 검증 완료/최종 교차리뷰 중** | 미병합 | 비활성 | [계약](2026-10-16-pipeline-pr04c2-combined-capture.md)·[검증](../../operations/2026-10-16-pipeline-pr04c2-combined-capture-validation.md). 같은 runnable baseline A3FAIL/3PASS·B206FAIL/89PASS·실제DB C1FAIL/1controlPASS를 root가 원로그/전체 driver로 수용하고 canonical/hash 최소구현을 해제. 동일 A6/B295/C원2GREEN, rootunit3517PASS·i18n/Python23 actual0. C최종15/ root관련DB33·전체tsc/lint/build/bundle actual0. A→C최종리뷰 진행·기존v1/entry/권한byte0 |
| **PR04c-2a-3–17** | 남은 writer inventory 검토 완료 | 미병합 | 비활성 | item B5 인증·durable 외부 종료 및 후속 로드맵이 남음. 아래는 예정 검증이며 PASS 기록이 아님 |

PR433은 `2026-10-15T12:16:32Z` main4af0589로 병합했다. [PR CI38732534554](https://github.com/JRVector9/nomorevibe/actions/runs/38732534554)는 quality·통합3shard·check 모두 SUCCESS다. [main CI38733408567](https://github.com/JRVector9/nomorevibe/actions/runs/38733408567)는 quality·통합3shard·check·웹/워커 image 전체 SUCCESS다.

PR434는 `2026-10-15T13:38:53Z` main `d95c6c8`로 병합했다. 최신 base `4af0589`·head `40d807d`의 [PR CI38743497505](https://github.com/JRVector9/nomorevibe/actions/runs/38743497505)는 quality·통합3shard·check 모두 SUCCESS다. [main CI38744485690](https://github.com/JRVector9/nomorevibe/actions/runs/38744485690)는 quality·통합3shard·check·웹/워커 image 전체 SUCCESS를 직접 확인했다.

PR435는 `2026-10-15T15:06:10Z` main `8f2bdb3`로 병합됐다. 최신 base d95c6c8·head a7e8545의 [PR CI38756321978](https://github.com/JRVector9/nomorevibe/actions/runs/38756321978)는 quality·통합3shard·check 모두 SUCCESS다. [main CI38757351403](https://github.com/JRVector9/nomorevibe/actions/runs/38757351403)는 웹/워커 image까지 전체 SUCCESS를 직접 확인했다.

PR436은 `2026-10-15T15:29:10Z` main `254a5bb`로 병합됐다. 최신 base8f2bdb3·head b3cfeea의 [PR CI38759886199](https://github.com/JRVector9/nomorevibe/actions/runs/38759886199)는 필수 검사 전체 SUCCESS다. [main CI38760739008](https://github.com/JRVector9/nomorevibe/actions/runs/38760739008)는 quality·통합3shard·check·웹/워커 image 전체 SUCCESS를 직접 확인했다.

PR430은 `2026-10-15T09:04:44Z`, PR431은 `2026-10-15T09:54:08Z` 병합됐다. 두 main CI는 image 작업까지 전체 성공을 직접 확인했다.
image 생성 성공은 운영 적용 증거가 아니다. 마지막 확인된 운영 릴리스는 **`8020dca`**이며
PR429–444를 위한 운영 migration·provider 설정 변경·공개 발행·수동 배포는 수행하지 않았다.
실제 검수 모델·품질 gate·신규 GitHub/Show HN 발굴 중단·사람 판단·검색어 `api-stop`을 유지한다.

## PR01의 다음 검토 단위

기존 [handler 상세 계획](2026-10-15-pipeline-pr01b-handlers.md)을 다음처럼 나눠 진행한다.
[b5 coverage/fence/artifact 상세 계획](2026-10-15-pipeline-pr01b-coverage.md)에 세 담당 사전 읽기 결과를 취합했다. b5는 세 담당 병렬 구현 후 root 통합·직접/교차 리뷰와 전체 로컬 검증을 완료하고 최신 base 필수 CI를 거쳐 PR434로 병합했다. 실제 provider baseline은 b6로 남아 있다.
각 행은 회귀와 검토를 마치면 독립 PR로 제출할 수 있다. 작은 기반 PR의 병합을 PR01 전체 완료로 올리지 않는다.

| 단위 | 납품 결과 | 반드시 확인할 경계 | 복구 / 아직 포함하지 않는 범위 |
| --- | --- | --- | --- |
| **PR01b-2 — 병합 완료** | verified dedicated client의 Drizzle scope, 고정 table/sequence allowlist·OID/ACL과 결합한 handler profile | global/replica를 poison해도 접근 0, `onPrimary/onReplica` scope 유지, concurrent/nested 교차 거절, 같은 writer transaction 검증, privilege drift 거절, products 쓰기 거절 | scope/profile 사용 중단으로 복구. 일반 worker·실제 handler·provider 실행은 열지 않음 |
| **PR01b-3 — 병합 완료** | 기존 AI1/AI2 handler를 fixture transport로 실행하고 downstream 요청을 격리 outbox에 보존 | 허용 job 두 종류만 claim, 실제 provider/fetch/publisher 실행 0, 기존 lease/heartbeat/backoff 유지, 공개 products 불변 | replay runner admission 중단·heartbeat 종료. 새 심사 엔진이나 별도 승인 규칙을 만들지 않음 |
| **PR01b-4** | 기존 결과 writer와 **같은 transaction**에 고유 final 전이 기록 | writer/recorder 어느 쪽 rollback에도 result/event 동시 0, 필수 AI2 gate 재사용, 중복·부분표·rules/reuse/human/stale 결과의 신규 final 0 | recorder 결합 비활성, 격리 장부 보존. 완료 뒤 별도 append로 원자성을 대신하지 않음 |
| **PR01b-5** | 실제 준비/보류/재개 coverage, 별도 artifact/export·seal | 0-ready·재시작 gap·30분 미달은 미판정, admission 종료·모든 call 정산·writer fence 뒤 seal, unresolved call이면 seal/겹친 run 거절 | admission 닫고 drain, 불명 비용/이력 유지. v1 snapshot parser를 완화하지 않음 |
| **PR01b-6** | 실제 serving identity·강제 전체 비용 상한을 입증한 제한 replay와 유효 baseline | exact 모델/정책/고정 입력·시각, 숨은 retry/fallback과 실제 usage/취소 계약, 사전 call/token/time 한도, 준비 대기가 유지되는 30분 baseline | provider admission 차단·drain. 모델 교체/품질 완화 금지; fixture 속도를 모델 처리량으로 쓰지 않음 |

provider 증거 확인은 handler 구현과 독립적으로 진행할 수 있다. 현재 `model-replay`는
`unsupported_provider_budget`으로 막혀 있다. 게이트웨이 실행 컨테이너의 감사 대상8파일 hash와 upstream metadata를 읽기 확인했지만, 전체 serving identity와 비용/취소 계약은 아직 입증되지 않았다.

무제한 retry·추정 usage·상한 미확인을 manifest boolean만으로 해소하지 않는다.

**PR01은 비교를 신뢰할 수 있는 측정 도구와 baseline을 준비하는 선행 단계다.**
계속 소비자를 구현한 뒤의 변경 실행·2배 판정은 PR06/17에서 수행한다.
PR02는 기본 `legacy`인 비활성 기반이므로 독립 개발·검토를 준비할 수 있지만,
PR01 합격 전 새 consumer를 활성화하지 않는다. Oracle/최종 DR 준비를 기다리느라
정상 검수의 PR02–06 경로를 뒤로 미루지 않는다.

## PR00–17 납품·의존성·검증 경계

PR00의 실행 결과와 PR01의 부분 완료는 위 표를 따른다. **아래 표는 납품 기준이며 실제 완료 상태는 위 표를 따른다.**
각 코드 PR은 최신 main에서 상세 회귀→구현→CI/검토→병합을 마친 뒤 필요한 migration·canary를 별도 기록한다.

| PR | 선행 | 납품 결과 | 핵심 검증 / 복구 경계 |
| --- | --- | --- | --- |
| **00** | 없음 | unread body 회수, full-page deadline 뒤 근거 continuation | error/oversize/redirect cleanup과 cursor/quota/abort 보존. DDL 없음; drain 뒤 이전 image |
| **01** | 00 | 동일 조건 manifest·고유 완료 집계·격리 replay/예산/coverage | 실제 final·필수 AI2·30분 baseline, 불일치/고갈/미확인 비용은 미판정. 관측/replay admission 중단; 장부 보존 |
| **02** | 01 | item lease·owner/boot/token/epoch와 `legacy/draining/items` 비활성 기반 | 두 DB 연결 claim·SKIP LOCKED·만료 재할당·늦은 저장 거절·원자 handoff. claim 중단→drain/fence→legacy; additive table 유지 |
| **03** | 02 | 원본·AI1의 모든 결과 writer를 item 소유권에 결합 | 살아 있는 타 owner의 frontier/attempt 보존, 결과·실패·cursor·입력/admin 변경 token 검사. 새 consumer 비활성 유지 |
| **04** | 02 | AI2 vote claim과 모든 쓰기 fencing | enqueue/close/retry/sweep/invalidation/admin 경로, 오래된 세대·동일 모델 승인 거절. legacy 유지, 새 claim drain |
| **05** | 02, 03, 04 | gateway·CLI·웹 질의 번역까지 공통 실제 모델 슬롯 | alias별 공유 한도, retry/chunk/fallback 직전 예약, deferred는 실패/attempt 미소모, 외부 대기 중 DB 점유 0. 전 caller 교체·구 호출 drain 후 활성화; 기존 동시성 복귀 |
| **06** | 01–05 | AI1·AI2·배경 독립 계속 소비 | 빈 큐 호출 0·fairness·heartbeat/shutdown, 한 stage씩 canary, 같은 조건 30분 변경 비교·품질·지연·실패 기준. drain 후 legacy 복귀 실제 시험 |
| **07** | 02 | host 공통 per-hop HTTP origin permit | redirect마다 SSRF/DNS, body 읽기/취소까지 permit, crash/TTL/두 host 경합. 새 claim drain 후 기존 단일 consumer |
| **08** | 02, 07 | 출처별 근거 refresh | GitHub 대기와 canonical 분리, source/input/policy CAS·공정 배분·잘못된 304/부분완료 거절. 실제 due canonical 10·공식 source 1 readback; 기존 product consumer |
| **09** | 02, 07 | 멱등 uptime raw 관측과 지역/광역 장애 보호 | observation ID/6h slot/URL·세대 CAS, Oracle 단독 실패는 hold, 3회 숨김·10회 내림·기존 sweep 보호. raw canary 뒤 정책 gate; authoritative 이전 중단 |
| **10** | 03–05, 08, 09 | 3서버 역할 선출·번역 분리·실처리 readiness | 현 owner 비선점·새 epoch, 세 번역 handler만 분리, host+release+실제 결과 canary, Oracle HTTP 합 2/origin 1·모델 1·pool/heartbeat 여유. 기존 text/maintenance drain 뒤 전환 |
| **11** | 07–10 | osaka-smoke의 상시 번역·canonical/news·uptime 실제 배포 | tenancy/region/instance guard, nonroot·ARM·독립 scheduler, 실저장/실갱신·양방향 인계·24h. Oracle drain 후 M3/mini 인계; X/Mautic 보존 |
| **12** | 01–06 | 발견 shard·원본 공급·시간 버퍼 | dedup·query/window claim·계정 예산, R 실측 후 2h 목표/6h 상한, 필요할 때만 원본 3→6 비교. selector/admission flag 복귀; 기존 발굴 pause 자동 해제 금지 |
| **13** | 01, 05–11 | 관리자 stage·host·적체·공통 예산 표시 | 완료/호출/재사용/표·ready/backoff/human·lease/epoch·Oracle/DR 상태 구분, 인증·좁은 화면 확인. 읽기 UI 복귀 |
| **14** | 병렬 조사 가능; 활성 구성은 용량 검증 후 | Oracle 전용 logical DR 데이터와 실제 복원 | PG17 x86→ARM physical standby 금지, 용량·실복원·table/DDL/sequence/extension/retention·RPO/RTO. 기존 writer 변경 전 복구안; 복원만으로 승격 허용 금지 |
| **15** | 02, 05, 07, 14 | 단일 writer 승격과 복원 뒤 외부 호출 barrier | 독립 fencing 없으면 승격 차단, 옛 epoch/token 거절, 구 호출 종료 또는 증명된 deadline+skew 뒤 permit. split-brain/중복 발행·내림 0; 계획 failback, DB 양방향 merge 금지 |
| **16** | 11, 14, 15 | 독립 모델·동일 embedding·최소 웹/관리자·비상 운영 | M3 독립 serving/키/DNS·품질/비용, embedding 동일 revision/1024차원 또는 degraded, 앱+DB+모델 동반 장애·복귀 RPO/RTO. 비상 우선순위·1CPU 합계 예산, 준비 안 된 기능은 대기 |
| **17** | 06, 11–16 | 최종 2배·장애·24h 운영 보고 | 같은 조건 고유 final ≥2.0배, p95 악화 없음, 기술 실패 ≤기준+1%p, 오판 증가 없음, lease 위반/사람 덮음/중복 발행 0. 미검증 범위 미완료, 회귀 시 consumer drain/복귀 |

우선 경로는 **00→01→02→03/04→05→06**이다.
Oracle 상시 업무는 **02→07→08/09→10→11**, 최종 생존 서버의 DB·모델·웹 복구는
**14→15→16**의 별도 합격 조건을 갖는다. PR14 조사는 병렬로 가능하지만
Oracle가 설치됐거나 standby라는 이유로 PR11·16·17을 완료 처리하지 않는다.

## 증거와 다음 보고

- PR00: [로컬 검증](../../operations/2026-10-15-pipeline-pr00-validation.md), [13앱 적용·실제 readback](../../operations/2026-10-15-pipeline-pr00-rollout.md).
- PR01: [snapshot 검증](../../operations/2026-10-15-pipeline-pr01a-validation.md), [격리 기반 검증](../../operations/2026-10-15-pipeline-pr01b-validation.md), [provider 미확인 계약](../../operations/2026-10-15-pipeline-pr01b-provider-audit.md).
- 이전 단계에서 `gh pr view 430 --json number,url,state,mergedAt,mergeCommit,headRefOid`와
  `gh run view 38710286609 --json databaseId,headSha,status,conclusion,jobs`를 읽기 전용으로 실행해 병합·전체 성공을 재확인했다.
  기존 로컬 테스트를 이번 문서 작업에서 재실행한 것으로 주장하지 않는다.
- 이번 변경은 서브에이전트3명 병렬 구현 후 root 전체 리뷰와 담당 간 교차 검토를 마쳤다.
  **PR01b-5의 실제 변경 파일·회귀 결과·운영 미적용 여부**를 갱신했다. coverage/seal은 로컬 검증 완료이며 PR/CI와 실모델 baseline은 별도 남아 있다.
  운영 적체의 감소와 고정 입력 성능을 합산하지 않는다.
- PR01b-5: [계획](2026-10-15-pipeline-pr01b-coverage.md), [준비량·종료 장부 실제 검증](../../operations/2026-10-15-pipeline-pr01b-coverage-validation.md).
- PR01b-2: [DB scope 검증](../../operations/2026-10-15-pipeline-pr01b-handler-scope-validation.md).
- PR01b-4: [계획](2026-10-15-pipeline-pr01b-final.md), [실제 원자성 검증](../../operations/2026-10-15-pipeline-pr01b-final-validation.md).
- PR01b-3: [runtime 계획](2026-10-15-pipeline-pr01b-runtime.md), [실제 handler 검증](../../operations/2026-10-15-pipeline-pr01b-runtime-validation.md).

공통 복구는 새 admission/claim 중단→inflight drain→token/epoch fence→이전 consumer/image다.
실패·quota·사람 판단·불명 호출·외부 반영 이력은 보존하고, DB DROP이나 장부 초기화로 복구하지 않는다.
