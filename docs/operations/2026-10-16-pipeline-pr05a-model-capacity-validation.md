# PR05a 비활성 공통 모델 슬롯 — 실제 진행 기록

## 범위와 기준

[고정 계획](../superpowers/plans/2026-10-16-pipeline-pr05a-model-capacity.md)을 따른다. main40cca23d를 정상 merge한5f65a50a의 별도 worktree에서 A/B/C가 배타 파일을 수정하며 root가 검증·리뷰·Git을 조정한다. 기본 disabled·기존 caller 연결0·운영 migration/배포/provider 호출0이다. PR01 baseline·PR04 item 인증·PR05 전체 호출 상한·실모델 종료·2배 성능은 별도 미완료다.

## 사전 계약 검토

세 읽기 검토의 원문은 `/tmp/nomorevibe-pr05-contract-{a-review,b-repository-review,c-db-review}-20261016.md`에 보존했다. root가 전체를 읽어 explicit route/provider/model→budget/group, 이전 정책 tuple의 미정산 점유 존재 시 새 admission 차단, request/work 멱등성, 1poll 최대1grant, dispatch 후 release0을 확정했다. 별도 credential 발급 구조와 전체 대기열 충전 loop는 이번 최소안에 넣지 않았다.

## 실제 unit RED — 완료

runnable pure baseline source SHA `ed29fabcc3f8ddf8b2f8524045c4dc350a1238f77e2b206443f331cdb84a9393`는 strict policy/identity parser와 유효 SHA64를 제공하며, map/route canonical 순서와 weighted cycle만 미구현한 기준이다. 원문 `/tmp/nomorevibe-pr05a-capacity-a-baseline-source-20261016.ts`를 보존했다.

- A 원8개: **3 Assertion FAIL /5 control PASS, 126ms, 실제 exit1**. canonical 전체 hash·순서 동치·expanded cycle이 실패했다. driver SHA `934c051b88a78aa6aeb44b700c6483ee7633b9530c2c730f6fa911c3fa40ae73`, `/tmp/nomorevibe-pr05a-capacity-a-baseline-unit-20261016.ts`, 원로그 `/tmp/nomorevibe-pr05a-capacity-a-baseline-red-20261016.log`.
- C 독립 원88개: **3 Assertion FAIL /85 control PASS, 114ms, 실제 exit1**. 순서 동치·weights2/1/1·최대96 cycle이 실패했다. driver SHA `882554aca74ae37ea3a30ad622fa2c324bce9c48fc1f6aa684899f1eaa632e23`, `/tmp/nomorevibe-pr05a-capacity-c-frozen-unit-baseline-20261016.ts`, 원로그 `/tmp/nomorevibe-pr05a-capacity-c-unit-baseline-red-20261016.log`.

root가 source·두 driver·원로그 전체와 A current/frozen SHA 동일을 직접 확인해 본 hash/cycle 구현을 해제했다. import/setup/type 오류를 기능 RED로 세지 않았다. GREEN·DB assertion RED/통합·최종 정적/전체 검사·교차 리뷰·PR 제출은 아직 진행 중이다.

## 전용 DB와 환경

root가55518/55519의 LISTEN 부재와 pinned image 존재를 확인한 뒤 각 담당이 exact 이름/port 부재를 재확인하고 B/C 전용 DB를 만들었다. image는 `pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`, loopback만 노출한다. 이름은 `nomorevibe-pr05a-model-capacity-{b,c}-20261016`이다. 생성 후 원 metadata는 `/tmp/nomorevibe-pr05a-root-db-containers-before-tests-20261016.json`에 보존했다.

B pg_isready0, C pg_isready 정상 보고를 받았다. Docker VM 여유는 실제2.2–2.3GB/98% 사용으로 관측돼 공간 오류 시 원로그를 보존하고 중단하도록 지시했다. 다른 DB/image/cache/volume을 정리하지 않았다. 최종 raw/DDL/effectiveACL readback·STOP/own자원 제거는 아직 남았다.

root `npx next typegen` 실제 exit0, 로그 `/tmp/nomorevibe-pr05a-root-typegen-20261016.log`. 이 검사만으로 미작성 소스의 타입/빌드 통과를 주장하지 않는다.

## 같은 원 unit GREEN과 DDL 검토 — 완료

A source 최종 SHA `db6dd34a00e1d24829f9a3b681870dd119cd0f25743c0087359496c67665b372`. 원 unit bytes 동일(cmp0)로 **8 PASS/99ms/actual0**, C 독립 원88개도 bytes 동일로 **88 PASS/113ms/actual0**를 확인했다. root가 source전체/원unit/원로그/operations-schema 추가/0078SQL/journal 단일entry를 읽었고 현재 추가P1/P2 0이다. A scopedeslint0. SQL은 미확인 cap/alias를 seed하지 않으며 event 두 statement trigger를 ENABLE ALWAYS로 설치한다. zero-row UPDATE/DELETE와 TRUNCATE도 거절하는 계약이다. 0078 SHA `bcaf4b50bd735a2e16124744b00df7922c416b716dc060ca0e37c80c394b6dce`.

## 실제 DB baseline RED — 완료

B runnable source143행 SHA `cfa604ea00e664a82d117a6837c67692eead96f5a34bcd1f0ac75ffb77b5f98b`는 실제 예약·재관측·원 token취소·begin/unknown을 지원하고 한도/공정배분/만료회수는 미구현이다. 원 source `/tmp/nomorevibe-pr05a-model-capacity-b-runnable-baseline-source-20261016.ts`에 보존했다.

- B 원driver147행 SHA `7bc50a3f2f45ba3e0e879c7a89b9b08c78b258b2b93f77c4c8770712fb9a7403`: defaultdisabled/실제발급·원cancel controls2PASS, globalcap1에 동시요청2개가 actualgranted2/DBactive2가 되는 **AssertionFAIL1/1.11s/actual1**. 로그 `/tmp/nomorevibe-pr05a-model-capacity-b-baseline-red-20261016.log`. Promise.all만으로 서로 다른 backend PID까지 관측했다고 주장하지 않는다. baseline tsc/scopedlint actual0.
- C corrected 원driver SHA `957aa461a2fc0f50a043213f856f4c041074746b9313b994fbb5674419fc8c1a`: defaultdisabled0행과 실제 persisted owner/boot/token/epoch/hash·원cancel controls2PASS, **서로 다른2PID의 실제 blocking graph 대기를 확인한 뒤** cap1에서2grant가 되는 **AssertionFAIL1/1.13s/tests739ms/actual1**. 로그 `/tmp/nomorevibe-pr05a-capacity-c-db-actual-baseline-red-20261016.log`, 원driver `/tmp/nomorevibe-pr05a-capacity-c-frozen-db-actual-baseline-20261016.ts`. AggregateError는 동일 원Assertion을 보존하며 별도 cleanup실패가 아니다.

root가 B/C source/원driver/로그 전체를 읽고 같은 source SHA를 확인해 본 multi-limit/fairness/expiry/CAS 구현을 해제했다. 실제 provider 호출0인 전용 DB의 신규 기반 테스트이며 운영에서 두 호출이 허가됐다는 관측이 아니다.

C 첫 direct-blocker driver는 실제 대기2개 중 holder의 직접 blocker 한 개만 세어 **fixture assertion1FAIL/2PASS/3.66s**였다. 이 원로그 `/tmp/nomorevibe-pr05a-capacity-c-db-baseline-red-20261016.log`를 보존하고 기능RED로 세지 않는다. 바로 뒤 waiter가 앞 waiter의 tuple lock을 기다릴 수 있어 recursive blocking graph만 교정했다. source/상한/시간제한/기능assertion은 바꾸지 않았다.

## 보강 중인 테스트 정산 경계

B/C의 최초 병렬 Promise.all은 한 자식이 먼저 reject하면 다른 실제 API가 아직 실행 중일 수 있었다. root는 자식 API promise별 registry 정산, DB부재를 확인한 UUID만 소유 등록, eventPK+requestID AND 삭제, cleanup commit 전 foreign/control/guard 확인을 보강하도록 요청했다. C 초기 driver의 actual2PID control과 rawreadback은 통과했으며 미래 실패 경로를 닫는 helper 보강이다. 원3case 본문/assertion은 보존한다. 이 변경을 baseline 전체파일 bytes동일로 잘못 기록하지 않는다.

C baseline 후 whole raw readback actual0: `/tmp/nomorevibe-pr05a-capacity-c-after-baseline-red-readback-20261016.{json,log}`. 원 public rows/rawµs stage·effectiveACL·functions/triggers·role·DB jitoff/timeouts 일치, ownrequest/event/sentinel/otherconnection0. C initial whole tsc/scopedlint actual0. 최종 확장/전체검사·리뷰·자원STOP은 남아 있다.

## 병렬 읽기 리뷰 — 테스트 helper 보강 진행

A가 B의 frozen147행 helper를 읽고 setup/beforeEach/restore의 실제 Promise도 retain해야 한다는 추가 P2 1건을 보고했다. hook timeout 뒤 원 TX가 계속 실행할 수 있으므로 후속 cleanup/end 전에 같은 in-flight work를 정산하고 cleanup은 단일 Promise를 재사용한다. root의 기존4요청과 중복 집계하지 않았다. 원문 `/tmp/nomorevibe-pr05a-a-review-b-test-cleanup-20261016.md`를 root도 읽었고 B/C에 최소 보강을 요청했다. 이 리뷰에서 실제 timeout 재현·새 DB/Git 실행은 하지 않았다.

잠금 지원 범위를 명확히 했다. 정상 API의 첫 lock은 항상 singleton control UPDATE이며 여기서 직렬화된다. 기존 다중 request의 만료 정리 집합은 queueOrdinal로 정렬한다. 신규 INSERT/own 조회/foreign grant까지 모든 획득이 전역 오름차순이라고 주장하지 않는다. 추가 mutex/advisory/domain lock을 도입하지 않았다.

## 최종 repository·원 DB driver GREEN — 완료

B 최종 source231행 SHA `17af8163914a0ce7e5db905a0c4ee1997d6507144d87a11ac32d7b45a3d04ebb`, 자체 driver375행 SHA `0331973bf01809a10921909239f1a7df98415573e9552e92f5d4d0b02fda239a`를 동결했다. root가 두 파일 전체와 원로그를 읽었다. B **16PASS/1.98s/actual0**, scopedlint0. 로그 `/tmp/nomorevibe-pr05a-model-capacity-b-final-green-20261016.log`. 독립 C 원3case도 최종 같은 source에서 **3PASS/25skip/1.28s/actual0**다. 원로그 `/tmp/nomorevibe-pr05a-capacity-c-original-three-green-20261016.log`.

root가 원 baseline 두 driver에서 첫3개 `it` block을 직접 추출해 최종 본문/assertion exact동일을 확인했다(actual0). 결합 SHA는 B `b69ac604256dfc95550f80d2f9a2e41dc598c8490c318b6009d5195204eca50c`, C `5f7bb997155fbcc695c5ded4eda81621e7fcf9cd0b824724b505bceb18143400`이다. helper는 승인된 정산/소유/복원 보강으로 달라져 전체파일 bytes동일이라고 주장하지 않는다.

A가 같은 source 전체와 pure/DDL/고정계획을 교차 검토했고 추가P1/P2 0·타입/DDL충돌0을 보고했다. root도 source를 직접 완독했다. `/tmp/nomorevibe-pr05a-a-final-source-review-20261016.md`. 최종 B helper의 기존 P2 폐쇄 확인과 B→C 독립 교차 리뷰는 진행 중이다.

B own55518 최종 readback actual0: requests/events/items/타연결0, control disabled/policy·hashnull, stages3 legacy/epoch1/contract0, 두appendonly guard ALWAYS, 원roles/public/database raw일치. `/tmp/nomorevibe-pr05a-model-capacity-b-final-readback-20261016.json`. root가 JSON 전체를 읽었다. 아직 running이며 STOP/삭제는 root 최종 취합 뒤 수행한다.

## 독립 확장 fixture 실패와 교정 — 진행 중

C 첫확장28은 **27PASS/fixture-cleanup1FAIL/4.82s/actual1**이었다. genuine replay 4API가 transaction 진입 전에 거절되는 기능 assertion은 통과했지만 normal restricted-profile 해제 뒤 database ACL 및 기존16관계 ACL이 NULL에서 명시 owner-default 표현으로 바뀌어 raw ACL 비교가 정리 TX를 rollback시켰다. 기능RED로 세지 않으며 원로그 `/tmp/nomorevibe-pr05a-capacity-c-expanded-first-20261016.log`를 보존한다.

C가 원raw/실효권한/실패DB를 읽고 `/tmp/nomorevibe-pr05a-capacity-c-expanded-first-relation-acl-20261016.json`에 보존했다. root가 해당16관계의 actual ACL과 owner-default의 전필드 동등을 Python으로 직접 확인했다(actual0). 그 정확한16개 표현만 effective ACL로 비교하도록 helper 보강을 허용했다. 외부grantee/column/schema/role/function/trigger/원raw 이력은 그대로 비교·보존한다. pg_catalog 직접수정/전체ACLreset/권한완화0이다. rollback으로 남은 자기 request1+event3만 기존 exact-ID/owner/guard TX로 정리한 뒤 같은28개를 재실행한다. 최종 GREEN/readback은 아직 확인 중이다.

B가 중간 whole tsc를 실행했을 때 작성 중 C `model-capacity-adversarial.test.ts:510`의 string→boolean 타입1건으로 실제exit2를 받았다. C가 자신의 파일에서 보강하며 원중간오류와 최종 결과를 구분한다.

## root 실제 전체 검사 — 진행 중

- `npm test`: **292파일/3740PASS/12.77s/actual0**.
- `npm run lint`: actual0, 기존 vendor `_ctx` unused warning1만 있다.
- `npm run check:i18n`: locales4/namespaces8/publicPages11, actual0.
- `python3 -m unittest tests/test_deploy_shared_images.py`: **23PASS/1.201s/actual0**.
- `npx next typegen`: 앞서 actual0. 최종 tsc·두 새DBfile 결합실행·build/bundle·필수CI는 아직 남았다.

root 로그 prefix `/tmp/nomorevibe-pr05a-root`: `-unit-20261016.log`, `-final-lint-20261016.log`, `-i18n-20261016.log`, `-python-20261016.log`, `-typegen-20261016.log`. source변경이나 새실패가 없으면 이미 통과한 검사를 이유 없이 반복하지 않는다.

## 최종 교차 리뷰의 fixture 보강 — 진행 중

root가 C594행·최종28로그·readback script전체를 읽고 baseline/final JSON의 모든 captured field를 직접 비교했다(actual0). clock sample과 문서화된 rawdatacl 표현만 제외하면 79publictable/rawµs/control/stage/role/settings/functions/triggers/effectiveACL 등이 정확히 같았다. C **28PASS4.54s/tests4.12s/actual0**, whole tsc/scopedlint actual0. 당시 integration SHA `98ec4ed4dacc8fac1b78fb2993ee3ded4939fc1d07deca13c4c2f361aa8ca1c5`, unit88은 원bytes동일이었다. 이 GREEN 뒤 다음 읽기 발견을 최소 보강한다.

- A 잔여 fixture P2: B helper가 caller와 같은 mutable request/owner를 소유 장부에 보관한다. 현재16body의 직접 mutation이나 actual 실패는 없지만 원identity 고정 계약을 닫기 위해 선언 registry와 wrapper async 경계에 독립 snapshot을 둔다. wrong-work 복사본 음성은 그대로 실제 API에 전달한다. 원문 `/tmp/nomorevibe-pr05a-a-final-b-helper-review-20261016.md`.
- root/B TTL 보강: C non-expiry의200/300ms TTL은 wholeSnapshot 다수쿼리 동안 의도않게 만료될 수 있다. non-expiry60s, 자연만료 두case만 명시1s로 분리한다. 실제 기능FAIL로 세지 않는다.
- B coverage gap: lockwait expiry는 실제 blocked session의 `xact_start < reserved_until` boolean을 확인해야 transaction 시작시각을 쓰는 잘못된 구현과 구별된다. 원blocking·자연expiry·latebegin거절 assertion을 유지하며 그 양성을 추가한다.
- B fixture P2: holder가 started.resolve 전에 reject하면 `await started.promise`에 갇혀 finally 정산에 도달하지 못한다. 두 holder 시작을 `Promise.race([started.promise, holding])`로 묶어 원오류를 전파한다. 실제 fault주입은 하지 않았다. 원3case 중 concurrency의 이 한줄은 승인된 helper 수정이라 최종 전체body bytes동일이라고 주장하지 않는다. 앞서 확보한 원3body동일 GREEN은 역사적 증거로 보존한다.

root build(dummyDB)와 bundle actual0. br148.7/159.0/136.2KB로 기준선 이내다. 로그 `-root-build-20261016.log`, `-root-bundle-20261016.log`. 설치된 optional review skill의 참조 `.agents/skills/gstack/review/checklist.md` 및 전역대체파일은 존재하지 않아 해당 skill 자동절차 완료를 주장하지 않는다. source/DDL/driver 전체 직접읽기와 담당간 교차리뷰를 수행했다. 새실행/최종추가finding·소유권반환을 확인한 뒤 최종 결합DB/tsc를 수행한다.

## 최종 최소 보강·root 통합 검증 — 완료

B fixture는 registry/소유 장부와 실제 API 입력을 독립 structuredClone으로 고정했다. wrong-work 음성과 원3case assertion을 유지했다. 최종 driver376행 SHA `912b011b77cd302a6e7894ef04fd04fad49ead7499455fcc24a43208b643c7b3`, **같은16PASS/1.95s/actual0**, scopedlint0. 원로그 `/tmp/nomorevibe-pr05a-model-capacity-b-clone-final-green-20261016.log`.

C 최종596행 SHA `cff357865b235715fd77fb8a30363c71558d3aa3691d1834eeb2047a410812a3`. non-expiry60s/자연expiry두case1s, 실제 blocked session의 healthy-at-TX-start 양성, 두holder Promise.race 정산을 보강한 **같은28PASS/6.35s/tests5.96s/actual0**, scopedlint0. 로그 `/tmp/nomorevibe-pr05a-capacity-c-nonexpiry-final-28-green-20261016.log`, 승인diff `-nonexpiry-approved-20261016.diff`. 원3case 기대/assertion은 같고 세번째 holder 대기1줄만 승인 수정했다. root가 최소diff와 관련 소스 전체를 다시 읽어 위 fixture finding 폐쇄를 확인했다. 추가 미해결P1/P2 0. 실제 holder-start/이중cleanup timeout fault를 주입한 것은 아니다.

root 최종 `npx tsc --noEmit --incremental false` **actual0**. 같은 DB에 두 새 통합파일을 함께 실행해 **2파일44PASS/8.80s/tests8.07s/actual0**를 확인했다. 로그 `/tmp/nomorevibe-pr05a-root-{final-tsc,combined-db}-20261016.log`. 앞선 전체 unit3740·wholelint·i18n·Python23·build/bundle 결과와 합쳐 로컬 필수 gate를 완료했다. 로컬 전체 DB suite를 새로 돌린 것은 아니며 PR CI3shard는 별도 남아 있다.

## root 최종 readback·자원 정리 — 완료

B root가 원10필드를 직접 재조회하고 full equality를 assert해 actual0. clone후B가 제공한7필드readback과 초기10필드 파일은 shape가 달라 root의 첫 전체object 비교가 실패했으며, 누락필드를 같은 것으로 가정하지 않고 root가 원10개를 새로 읽었다. 실제 DB 차이는 없었다. 실제 script는 `/tmp/nomorevibe-pr05a-root-b-readback-20261016.mjs`, 결과는 `/tmp/nomorevibe-pr05a-root-b-final-readback-20261016.{json,log}`다.

C root 결합44 후 readback script actual0, baseline과 전public행/control/stage rawµs·roles/config·functions/triggers·effectiveACL·defaultsettings 일치, request/event/sentinel/replay자원/다른연결0. JSON `/tmp/nomorevibe-pr05a-capacity-c-root-combined-final-readback-20261016.json`, 로그 `/tmp/nomorevibe-pr05a-root-combined-final-readback-20261016.log`. normalprofile의 documentedrawACL 표현변화만 보존하며 권한확대0이다.

root가 생성시 fullID·pinnedimage·loopback·원mount·전체container목록의 단독volume참조를 재확인했다. B 실제volume은 `nomorevibe-pr05a-model-capacity-b-20261016-data`, C는 `nomorevibe-pr05a-model-capacity-c-20261016`이다. 이름을 추측하지 않고 원inspect와 대조했다. 정상STOP 후 둘 모두 **exited0/OOMfalse**를 직접 확인하고 정확한두container와 미참조ownvolume만 제거했다(actual0). image/cache/기타volume/prune0. 원metadata `/tmp/nomorevibe-pr05a-root-owned-db-{before-cleanup,after-stop}-20261016.json`, stop로그 `-root-owned-db-stop-20261016.log`.

이제55518/55519에 재접속하지 않는다. PR 제출·최신base 필수CI·정상병합·main CI/image는 다음 단계이며 운영 migration/배포/provider/새consumer 활성화0을 유지한다.
