# PR04a — AI2 현재 입력·소유권 기반

PR04를 기반(a), 기존 writer/controller/handler의 필수 receipt 전환(b), 미연결 item 실행 lifecycle(c)로 나눈다. root가 세 담당의 배타적 파일/DB와 공통 API를 확정하고 직접·교차 리뷰 및 Git/전체 검증을 맡는다. 모델은 전원 gpt-6.1-sol/xhigh다.

## 목적과 납품 경계

현재 DB에서 잠근 vote·first/root·원본·정책을 실제 item owner에 결합한다. 기존 legacy writer/handler API는 a에서 유지하고 b에서 실제 caller와 함께 원자 전환한다. item adapter는 worker/registry/scheduler에 연결하지 않는다. 기본 legacy/epoch1/계약0, 실제 모델·품질 gate·동시성·신규 발굴 중단을 유지한다.

legacy `admitted`는 실제 job token·stage epoch 아래 pending 입력을 관측한 결과다. AI2에는 persisted per-row dispatch nonce가 없으므로 이를 durable item `claimed`와 구분한다. DB만으로 정확한 현재 job/row 내용을 복제한 receipt의 발급 함수 호출 사실이나 transport 종료를 증명할 수 없다. durable 외부 종료·B5 item 인증·실모델 baseline은 별도 남는다.

## 단독 소유권

| 담당 | 편집 가능 파일 | 전용 loopback DB |
| --- | --- | --- |
| A 기반 | lib/crawl/second-review-input.ts, NEW second-review-ownership.ts, NEW tests/second-review-ownership.test.ts, NEW tests/integration/second-review-item-claim.test.ts | 55490 / nomorevibe-pr04-foundation-db-20261016 |
| B 독립 domain proof | NEW tests/second-review-domain-binding.test.ts, 동명 integration 파일 | 55491 / nomorevibe-pr04-domain-db-20261016, 정리 후 STOP |
| C 기존 handler 독립 회귀·읽기 리뷰 | handler 회귀 원본은 b용 /tmp 보존, 현재 source 읽기 전용 | 55489 / nomorevibe-pr04-independent-db-20261016, 정리 후 STOP |
| root | 문서·공유 접점·Git·전체 검증·직접 리뷰 | 필요시 별도55492 |

C의 기존 handler 테스트는 a 범위에서 수정하지 않는 실제 결함3개를 재현한다. 원본은 `/tmp/nomorevibe-pr04b-second-review-item-ownership.test.ts`로 보존했고 SHA256 a5dadc044c913c30ccf7d869c48700f73869a157730c51e4a0a44225e0d208c8이다. b에 복원해 동일 RED→GREEN을 확인하며 a에 미해결 테스트를 섞지 않는다. C는 별도 PR03d WT의 CI fixture 정렬 두 줄 보완과38 PASS handback을 마쳤고 현재 foundation 읽기 리뷰를 맡는다.

## 확정 API

- domain-only `lockSecondReviewDomain(tx, secondReviewId): Promise<SecondReviewDomainContext|null>`. 기존 loadSecondReviewInput/loadLockedSecondReviewInput 읽기 export 유지, ownership을 domain loader에 넣지 않는다.
- `SecondReviewReceipt`: 실제 binding, rowIdentityHash, ownership=legacy(stageEpoch,job) 또는 item(actual Ai2ItemLease). rowIdentityHash는 immutable 원행 identity 비교이며 nonce가 아니다.
- `secondReviewPolicyHash(settings)`: version second-review-policy-v1 + 기존 base reviewPolicyHash + enabled/reviewMode/firstReviewer/secondReview 전체 + prompt/rules. fallback 배열 순서 보존, AI1 base hash 변경0.
- `secondReviewBinding(context)`: actual locked input의 hash/source, composite policy, 정확 row provider/model, 실제 first-or-published source/generation/primary vote/fallbackForId. published source는 slug와 실제 productId를 함께 포함한다. published slug placeholder와 actual inputHash를 구분한다.
- `canStartLegacySecondReview(job)`, `admitLegacySecondReview(id,job)` → admitted 또는 skipped. 실제 item mode/draining의 새 legacy admission은 차단한다.
- `claimItemSecondReview(id,owner,ttlMs)` → claimed 또는 skipped. 실제 generic0077 CAS·opaque guard만 사용한다. 같은 logical vote와 live root/child chain을 보호하고 독립 primary slot의 병렬성은 유지한다.
- `renewSecondReviewOwnership(itemReceipt,ttlMs)`: 원래 persisted binding/token으로 갱신한다. semantic input 변경이 현재 외부 호출의 종료 증거는 아니다.
- `assertSecondReviewOwnership(tx,ai2Guard,receipt,lockedRow)`: 원래 row identity 및 stage/actual owner를 증명한다. 현재 semantic input/composite가 여전히 적용 가능한지는 b writer의 현재 domain 비교 책임이다.
- `finishSecondReviewOwnership(tx,ai2Guard,receipt)`: 모든 실제 DML/outbox 대기 뒤 own item release CAS 또는 legacy name=second-review/token/DB wallclock 검사. heartbeat가 늘린 leaseUntil과 오래된 객체의 equality를 강제하지 않는다.

## 잠금·쓰기·검증 원칙

S3 fetch→ai1→ai2 SHARE → 필요한 published lifecycle/generation → candidate → document/settings/evidence → exact/latest first → root/관련 vote id ASC → chain item workKey ASC → jobs/outbox → 최종 wallclock/release. replay의 기존 writer fence/mutex·defer flush 순서를 유지한다. 외부 모델 대기 중 DB TX를 잡지 않는다.

legacy admission의 invalid input은 actual job/controller 아래 원래 pending 행을 다시 확인해 기존 superseded/input_changed 의미로 원자 정리한다. healthy foreign logical/chain item이 있으면 먼저 skip해 row/token을 변경하지 않는다. 아직 owner가 없는 invalid item claim은 write0이다. item 실행은 replay에서 mutation 전에 explicit reject하며 handlers-v5 권한·immutable guard·legacy 인증을 넓히지 않는다.

새 테스트는 외부 transport만 mock하고 실제 입력 생성·DB claim·잠금/clock/rollback을 검증한다. foreign rows/settings/jobs는 최소 demand 열만 suspend하고 같은 열을 raw JSON으로 µs exact 복원한다. 무관 sentinel·전체 원행·자기 fixture/연결0을 확인한다. 공간/SQL/import/fixture 실패를 행동 RED로 세지 않고 로그를 덮어쓰지 않는다.

## 공개 제품 세대의 추가 검토 결정

독립 읽기 리뷰에서 current product generation을 매번 잠그는 것만으로는 claim 당시 제품의 세대를 증명하지 못한다는 간극을 발견했다. B가 실제 removeProductAndEvidence→동일 slug/url/repo로 새 product id INSERT→actual markPublished를 실행해 확인했다. 같은 candidate의 actual inputHash/sourceRevisionHash/generationKey/policyHash/secondReviewId는 동일하고 기존0077에 저장한 원 binding과 새 binding이 완전히 같았다. 정상1 PASS/구분 assertion1 FAIL(1.11초), `/tmp/nomorevibe-pr04-domain-published-generation-red-20261016.log`. 결과 writer 미연결 단계이므로 이 증거를 실제 늦은 writer 적용 재현으로 확대하지 않는다.

root는 Ai2ItemBinding.source.kind=published에 positive safe integer productId를 필수 추가하기로 확정했다. 원래0077 binding/hash에 실제 제품 세대를 영속 결합하며, 같은 logical workKey는 유지한다. 비영속 receipt 필드나 policyHash에 id를 숨기는 것으로 대신하지 않는다. AI1 base input 및 AI2 settings composite는 바꾸지 않는다. generic source type과 기존 unit은 root 단독 소유로 추가됐고 missing id 거절의 actual1 RED/정상6 PASS→해당전체7 PASS를 확인했다. A가 actual domain의 제품 id를 binding에 연결한 뒤 B의 동일 세대 안정/재등록 구분 DB2/2 PASS(1.10초)를 확인했다. 로그 `/tmp/nomorevibe-pr04-domain-published-generation-green-20261016.log`. 별도 µs sentinel과 기존 id1 값을 넣은 반복도2 PASS였으며 원복·자기행0·stage 기본값·타 연결0 뒤 DB STOP을 확인했다.

이 JSON binding 계약은 item 소비자 활성화 전 보강이며 DB schema/DDL 변경이 아니다. 기본 contract0·item consumer inactive를 유지한다. 제품 세대 식별을 실제 외부 종료나 결과 적용 권한의 전체 증명으로 보고하지 않는다.

## 실제 착수 결과와 남은 gate

B가 기존 actual pure helper에서 잘못 root.id/first confidence/candidate ID 결합을 허용하는3 RED/정상3 PASS를 먼저 확인했다. 확대44개 중16 actual assertion RED 후 A의 최소 predicate 보강으로44 PASS, 관련3파일82 PASS·tsc/scopedlint exit0을 B가 직접 실행했다. 이는 전달한 current context 검증 증거이며 DB loader가 실제 다른 후보/root를 선택했다는 실험으로 주장하지 않는다.

C actual runJob 기존 handler control1 PASS/3 RED(1.82초): items/draining completed→deferred 기대 실패, healthy foreign logical item에서 transport1→0 기대 실패. 원본 로그 `/tmp/nomorevibe-pr04-independent-initial-red-20261016.log`. source 변경 없이 raw 복원·sentinel/µs 검증·tsc/scopedlint exit0, own DB readback/STOP 확인. b에서 닫는다.

A 최종 claim33 PASS(13.37초), related pure64 PASS를 직접 실행했고 source/test4파일 동결·root 반환을 마쳤다. B nullable/빈 first.model actual2 RED/44 PASS→46 PASS, C 원본 source↔generation 지적 actual1 RED→GREEN, actual nondeferred run-row 대기 중 job 만료 actual1 RED→rollback GREEN을 확인했다. 기존 managed jobs/settings/observation 원행은 in-place/raw µs exact 복원했고, 자기 absent-baseline만 whole-row CAS로 제거한 뒤 잔류/연결0·stage 기본값과 own55490 STOP을 확인했다.

invalid legacy admission의 최종 검사는 잠금 순서를 위한 recorder 전 job 확인을 유지하고, nondeferred recorder 대기 뒤 같은 이미 잠근 job의 DB wallclock을 다시 확인한다. certified B5의 transaction callback 뒤 deferred flush 대기는 공통 미완료 경계로 남기며 이 한 경로의 보강으로 해결됐다고 주장하지 않는다. 전역 replay framework 변경0이다.

부모 PR03d #439는 main643bd3c로 정상 병합됐고 PR CI38774067586·main CI38775007005는 필수 검사와 웹/워커 image까지 SUCCESS를 직접 확인했다. 이 WT에 실제 main을 통합했다. root 직접/B·C 동결 source 교차 리뷰에서 미해결P1/P2 0이다. root unit279파일2,915 PASS, fresh55492 전체DB174파일1,982 PASS/기존TODO1(398.46초), type/lint/i18n/Python23/build/bundle exit0을 확인했다. 기존 reference-time fixture의 실제 필드 두 개 누락으로 첫unit1FAIL/2914PASS를 보고했고 필수값만 추가해 해당15 PASS→전체GREEN, 기존 clock/identity assertion 유지·C 리뷰0이다. [실제 검증 장부](../../operations/2026-10-16-pipeline-pr04a-ai2-authority-validation.md). 이 PR의 최신 base 필수 CI/병합은 아직 남아 있다. 실행하지 않은 PASS·item B5·durable drain·2배 처리량·Oracle DR을 완료로 보고하지 않는다. 운영 배포/DDL/provider 호출/consumer 활성화0이며 향후 legacy image 시작 전0077 migration 선적용이 필요하다.
