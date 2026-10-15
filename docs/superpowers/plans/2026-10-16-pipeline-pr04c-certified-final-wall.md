# PR04c-1a — certified flush 이후 같은 작업자의 최종 DB 시각 검사

2026-10-16. PR04b-2 #442/head2fb960a의 전체 로컬 검증 뒤 착수한다. #442는 필수 PR CI38788541111 전체 성공 뒤 main05cedd174023dcf990c5e93cd5ba033952441d49에 정상 squash 병합됐다. main CI38789769881 필수check·웹/워커 image 전체 SUCCESS를 실제 확인했으며 운영 적용과 구분한다. 아래는 실행 계약이며 예정 테스트를 PASS로 기록하지 않는다.

## 목표와 범위

현재 writer callback의 마지막 job 검사는 certified transaction의 deferred flush보다 먼저 끝난다. 이후 run row나 session verifier를 기다리며 권한이 만료되면 callback 안의 검사만으로 commit을 허용해서는 안 된다. 실제 checked job authority를 기존 private transaction ticket에 결합하고 flush와 session 검사 뒤 native COMMIT 전 마지막 DB wall 검사로 재확인한다.

한-item lifecycle(c-1b), item B5 전체 인증(c-2), durable physical-call admission/종료(PR05/07), 실제 stage drain·새 consumer·baseline·2배·Oracle DR은 별도다. 기본 legacy/epoch1/contract0·현재 모델/품질·발굴 중단을 유지한다. migration/profile/증거 버전·운영/provider 호출 변경0이다.

## root가 고정한 최소 계약

1. source는 기존 `lib/jobs/control.ts`, `lib/jobs/lease.ts`, `lib/operations/pipeline-replay-execution.ts`, `lib/db/replay-scope.ts`, `lib/operations/pipeline-replay-ledger.ts` 다섯 파일로 제한한다. ledger의 직접 native hook 호출에도 같은 finalWall 순서를 적용한다. `JobLeaseLostError`는 lease leaf로 옮기고 control이 동일 class를 재export하여 기존 instanceof identity를 보존하고 execution의 control runtime 순환 import를 피한다. existing result/domain/ownership writer는 다시 열지 않는다. 새 일반 receipt/WeakMap framework·임의 validator callback·caller boolean을 도입하지 않는다.
2. 기존 `assertJobLeaseAtWallTime(tx, lease, mode)`의 실제 row lock과 DB wall 검사를 유지한다. 성공 뒤 고정 `registerReplayJobFinalAuthority(tx, lease, mode)`를 호출한다. certified scope 밖에서는 이 replay 등록이 no-op이고 기존 production 검사 의미는 그대로다.
3. active certified scope에서는 plain lease를 lookup 자료로만 취급한다. 기존 private ticket의 실제 DB/scope/raw TX/txKey/xid/open 상태를 확인하고 **ticket의 실제 raw TX에서 해당 job row와 token/DBwall을 직접 확인·잠근 뒤** 등록한다. `tx.execute()`가 돌려준 임의 JSON만으로 권한을 발급하지 않는다. 함수 내부의 일회 random challenge를 호출 TX에 local GUC로 설정하고 ticket raw가 txKey/fullxid/challenge를 직접 확인·소비한 뒤 job을 검사한다. 실패 후 finally SQL로 원 lease 오류를 덮지 않는다. 지원 job은 기존 두 legacy 검수 job으로 고정한다. 동일 name/token 반복은 합치며 다른 token으로 원 proof를 덮지 않는다. producer requestedVersion 증가를 거절하지 않는다.
4. 순서는 `writer callback → hooks.after(flush/journal/deferred recorder) → verifyReplayDatabaseSession → 동기 scope 검사 → hooks.finalWall(raw,ticket) → 동기 scope 검사 → native COMMIT → 별도 commitAck`다. finalWall 이후 추가 async verifier/ledger write를 넣지 않는다. 해당 job 잠금은 등록 때 이미 같은 TX가 보유한다. run lock 뒤 새 job/domain 잠금은 금지하고 마지막 검사는 고정 lock 없는 raw DBclock/token 조회만 수행한다.
5. ticket은 open/flushing/flushed/finalized/confirmed 상태를 구분해 finalWall 누락·중복·다른 raw TX·닫힌 scope를 거절한다. commitAck는 finalized만 받고 native COMMIT 전 실패는 전체 rollback, commit 성공/ack 실패는 기존 unconfirmed 증거를 보존한다. 마지막 검사는 현재 권한 정책이며 검사 시각=물리 COMMIT 또는 외부 호출 종료라는 증거는 아니다.
6. **모든 journal TX에 job proof를 요구하지 않는다.** 등록 없는 fresh claim·heartbeat·runner cursor/completion/deferred/failure·call/history·순수 journal은 기존 흐름을 유지한다. own token 해제 뒤 다시 생존하라고 요구하지 않는다. 미지원 item UUID를 job token으로 대입하거나 item 지원을 열지 않는다.

## 배타적 병렬 소유권

전원 gpt-6.1-sol/xhigh. WT `/Users/jr/Desktop/projects/nomorevibe-pipeline-certified-wall`, branch `codex/pipeline-pr04c-certified-wall-20261016`, 초기2fb960a. root가 #442 실제 main05cedd17과 diff-tree 동일 exit0 확인 뒤 정상 통합한 현재 HEAD는 bd82d7f1이다. root만 Git과 문서를 취합한다.

| 담당 | 배타 편집 | 자기 loopback DB |
| --- | --- | --- |
| A | 위 source5파일, NEW unit `tests/pipeline-replay-final-wall.test.ts`, 기존 `tests/db-replay-scope.test.ts`의 hook mock 적응 | 55501 / nomorevibe-pr04c-wall-source-db-20261016 |
| B | NEW integration `tests/integration/pipeline-replay-certified-final-wall.test.ts` | 55502 / nomorevibe-pr04c-wall-independent-db-20261016 |
| C | NEW integration `tests/integration/pipeline-replay-final-wall-authority.test.ts` | 55503 / nomorevibe-pr04c-wall-authority-db-20261016 |
| root | 계획/검증/delivery/handoff/Git, 그 밖의 기존 fixture 적응·최종 전체 검증 | 필요 시55504 |

각 DB는 pinned PG17 `pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`, dummy nomorevibe/nomorevibe/nomorevibe_test, loopback만 사용한다. 다른 DB·운영·forensic77/실패81 접근0, 완료한 자기 prefix/관리행/foreign raw·µs 복원/readback 뒤 STOP한다.

## 첫 RED와 검증 순서

1. A source는 root가 B의 실제 행동 RED 원로그와 driver를 읽고 수용할 때까지 동결한다. B는 기존 authentic prepareCertified/execution scope와 actual second-review runJob/controller를 사용해 정상 control과 post-callback run-row wait→DBclock job expiry→도메인/journal/outbox의 전체 rollback을 재현한다. 실제 pg_blocking_pids와 raw before/after를 남긴다. SQL/API/import 오류·runner의 나중 실패만으로 RED를 판정하지 않는다.
2. 실제 lease는 actual runJob으로 발급한다. 만료 fixture는 본인 genuine job의 locked_at headroom만 필요하면 실제 guarded/journal transaction에서 조정하며 STALE_LOCK_MS/timeout/gate를 완화하지 않는다. callback 검사 시 healthy, flush 실제 대기 중 DBclock expiry가 되는 순서를 증명한다. worker_seen_at과 실제 lease의 locked_at을 혼동하지 않는다. 무기한 transport나 provider 호출은 없다.
3. source 승인 뒤 A가 고정 등록/finalWall과 hook 순서를 구현한다. C는 actual 정상 claim/heartbeat/completion·등록 없는 journal, idempotent 등록/producer 요청 증가·wrong token/다른 tx/닫힌 ticket·rollback/ack fail 경계를 독립 검증한다. 새 API가 없다는 import 오류를 RED로 부르지 않는다. 기존 private 인증과 profile을 재사용하고 grants를 넓히지 않는다.
4. B 독립 RED→GREEN, C authority/legacy controls, A unit·관련 source 회귀·whole tsc/scopedlint와 raw foreign 복원·자기 잔류/타 연결0·STOP 뒤 반환한다. root는 source 직접/교차 리뷰, 기존 handler/profile/replay 전체 회귀·unit/DB/정적/build·readback/CI를 취합한다.
5. 다른 실제 writer가 필요한 최종 검사를 등록하지 않는 counterexample가 발견되면 먼저 root에 보고한다. source 소유권/범위를 임의 확대하거나 모든 journal에 fictitious authority를 요구해 통과시키지 않는다.

## 아직 완료하지 않는 것

이 납품은 legacy certified transaction의 마지막 권한 시각을 닫는다. 새 item lifecycle, item 역사적 claim/call/result authority·projection/journal/readiness/profile·strict artifact 인증과 durable 외부 종료는 각각 별도 남는다. actual 30분 모델 baseline·2배 성능·운영 배포를 fixture 회귀로 대신하지 않는다.

## 실제 RED 수용 checkpoint

root가 B driver와 `/tmp/nomorevibe-pr04c-wall-independent-feature-red-20261016.log`를 직접 읽어 actual1FAIL/control1PASS(exit1,4.59초)을 수용하고 A source 구현을 해제했다. 고정 timeout 유지·genuine locked_at headroom500ms, actual waiter173→holder162/run-row FOR UPDATE에서 healthy→DBclock expired 뒤 oldwriter recorded, pending→agreed·publish요청0→1·packets7→8/changes7→9/events13→15의 실제 commit을 확인했다. 앞3s headroom은 timeout rollback이므로 행동 RED가 아니다. B test SHAbe4670bf9f31435f7cb954cae02a28de785c774b8b34b8ebc5a9bb7b895b65b7를 동결하고 구현 뒤 동일 driver를 재실행한다.

## flush 진입 phase 추가 실제 RED 수용

A self-review의 flush중 open 유지 경계를 C가 actual native ticket·실제 deferred callback barrier로 재현했다. 원로그 `/tmp/nomorevibe-pr04c-wall-authority-flushing-red-20261016.log`: 1FAIL/19skip exit1, 실제 packet/runlock 이후 lateAccepted=true라 기대false 실패. root가 driver·로그를 직접 수용한 뒤 after 진입을 동기 flushing으로 닫는 최소2줄 보강을 승인했다. source execution 최종SHA9d3fe65e9e3146b1855c34947d4c49a3330a2c1f8085255ca881404343a2f1fd, C 동일testfocused1PASS/19skip→최종20PASS/29.92초와 root 전체DB2,112PASS/기존TODO1를 실제 확인했다. 새 job/domain lock이 flush 이후 추가되는 registration을 거절하며 기존 deferred recorder는 유지한다.

## 구현·리뷰·로컬 gate 완료

source5/단위2파일·신규 integration2파일을 동결하고 root 직접/교차 리뷰의 미해결 P1/P2 0을 확인했다. root unit2,928, 전체DB180파일2,112PASS/기존TODO1, type/lint/i18n/Python23/build/bundle 실제 exit0와 자기4DB readback/STOP을 확인했다. 상세 원로그·실패 접근·한계는 [검증 기록](../../operations/2026-10-16-pipeline-pr04c-certified-final-wall-validation.md)을 따른다. PR/필수CI/정상병합은 별도로 이어간다. 운영 적용·item lifecycle/B5·2배/DR 완료로 올리지 않는다.

## CI 동기화 보강

PR443/af4df25 첫 CI38793351252 통합3의 racefixture1FAIL을 원로그로 조사했다. source5개는 그대로 두고 B test1개만 원 writer callback 뒤 sameTX750ms anchor·RETURNINGexacttext expiry·원 callback 오류 외부 보존으로 보강했다. 최종6bbc9186…df548 동일driver의 oldsource실제1RED/control1PASS→현재2PASS를 root가 직접 확인했다. 고정timeout/품질/권한 gate는 유지하며 자세한 로그와 실패한 timestamp serializer 접근은 validation 문서를 따른다. 필수 PR CI를 다시 확인한 뒤 정상 병합한다.
