# PR04c-2a-3 — AI2 target 판정과 실제 claim 대조

승인된 PR별 병렬 개발을 이어간다. 기준은 PR448 head `86da89e5`다. 필수 CI38808970207 전체 SUCCESS 후 main `e22ec725`로 정상 병합했고 main CI38809968134는 필수 검사와 웹/워커 image까지 전체 SUCCESS다. 이 기능은 실제 main을 정상 통합한다. root는 계약·문서·직접/교차 리뷰·검사·Git을 관리하고 A/B/C는 아래 파일만 소유한다. 모델은 모두 gpt-6.1-sol/xhigh다. 운영·provider·새 consumer·인증 profile 활성화는 없다.

## 목적과 최소 변경

전체 combined snapshot에서 특정 2차 검수 ID의 논리 조건을 평가하고, 경합 없는 전용 DB의 실제 `claimItemSecondReview` 반환·영속 receipt와 대조한다. snapshot 관측과 잠금 후 실제 확보는 별도 TX다. queue-wide selector/정렬/limit/fairness/ready count/coverage는 만들지 않는다.

신규 production은 `lib/operations/pipeline-replay-ai2-target.ts` 한 파일이다. 기존 v1/readiness/loader/query/claim/writer/profile/entry/권한은 byte 변경0이다. 기존 공개 `createReviewInput`, `secondReviewInputMatches`, `secondReviewBinding`, `mergeWithDefaults`, `sameReviewModel`, `repositoryUrl`을 재사용한다. 새 공유 helper 추출은 필요하지 않다. SQL WHERE/ORDER BY에 해당하는 저장 행 선택만 새 snapshot adapter에서 표현하고 실제 differential의 검증 대상으로 명시한다. private currentInput/context body·판정 정책 복제, fake executor, 범용 callback/resolver, 새 authority flag는 없다.

## 고정 API

공개 함수와 반환 type만 추가한다.

```ts
export type ReplayAi2TargetAssessment =
  | { kind: "eligible"; targetId: number; binding: Ai2ItemBinding; inputMembership: "included" | "outside" }
  | { kind: "ineligible"; targetId: number; reason: "stage_inactive" | "not_pending" | "running" | "input_changed" }
  | { kind: "unknown"; targetId: number; reason: "ambiguous_settings" | "implicit_first_reviewer" | "missing_stored_readme" };

export function assessReplayAi2Target(
  value: unknown, targetId: number, wallTime: string
): ReplayAi2TargetAssessment;
```

eligible은 해당 snapshot과 명시 wall sample의 논리 조건일 뿐 실제 claim/receipt/실행 허가가 아니다. `binding`은 기존 공개 builder의 예상 값이며 nonce/token/owner를 만들지 않는다. eligible의 inputMembership은 **현재 재조립 input의 candidate/input/source 복합 identity**와 DB frozen universe를 대조한 사실이다. universe 밖이라는 이유로 실제 claim의 새 skip 규칙을 만들지 않는다. 판정 전에 탈락하거나 지원 범위가 모호하면 membership을 추정해 반환하지 않는다.

입력은 strict combined kind/version + 기존 readiness/item schemas로 검증하고 기존 `applyReplayChanges(domain,[])`/`canonicalReplayItemState`를 사용한다. target은 positive safe integer다. wallTime은 유효한 UTC ISO 3자리 또는6자리이며 lease 비교는 µs를 보존한다. 입력과 nested rows/manifest/frozen 객체를 변경하지 않고 반환 binding도 독립 객체다. 오류를 논리 negative/default/unknown으로 catch하지 않는다.

DB/SQL/connection/transaction/provider/환경/`Date.now()`/현재 wall 읽기는 없다. semantic reference는 domain.referenceTime을 명시해서 기존 factory/predicate에 전달한다. 이 공개 helper들은 기존 AsyncLocalStorage semantic context를 따르므로, `reviewSemanticNow(explicitReference)`가 다른 시각을 반환하면 기존 `replay_clock_scope_conflict` 오류로 거절한다. 같은 reference 또는 scope 부재에서만 평가한다. 새 AsyncLocalStorage scope를 열거나 현재 시각을 참조하지 않는다. 이 ambient 충돌 검증은 기존 helper의 의미를 보존하는 제한이며 DB replay scope/권한을 설정하지 않는다.

## 판정 순서와 storage 대응

1. 기존 strict state 및 인자 검증 후 AI2 mode가 items이고 contract>=1인지 확인한다. 아니면 stage_inactive. target 없음/nonpending은 not_pending이다. fetch/AI1 mode를 추가 admission gate로 쓰지 않는다.
2. target/root(`fallbackForId ?? id`) 및 모든 child의 실제 AI2 work keys만 chain으로 본다. token이 있고 leaseUntil>wall인 committed owner가 있으면 running이다. owner/boot/과거 stageEpoch가 같거나 다르다는 이유로 healthy owner를 무시하지 않는다. candidate ANY-generation controller 보호를 target claim에 합치지 않는다. itemEpoch MAX_SAFE는 아래 current context 검증이 끝난 뒤 기존 generic claim과 같은 running 경계로 확인한다. 실제 row/advisory 잠금은 payload에 없어 아래 경합 대조에서 별도 unknown으로 다룬다.
3. candidate/document/설정을 현재 SQL과 같은 identity로 선택한다. settings는 현재 SQL이 id 조건 없이 LIMIT1이므로 복수 행이면 ambiguous_settings다. 저장한 explicit firstReview가 없으면 implicit_first_reviewer로 보수적으로 남긴다. 실제 runtime 환경 fallback/default를 제거하지 않는다. settings0행도 implicit_first_reviewer다. stored README/version이 없으면 missing_stored_readme로 보고하며 실제 loader의 오류를 ineligible로 합치지 않는다. 기존 schema/type 오류는 그대로 실패한다.
4. scan은 repositoryKey==candidate.repo.toLowerCase(), scope==''에서 started_at DESC/id DESC이며 선택은 raw µs를 보존한다. 해당 scan observations는 id ASC로 가져온 뒤 `{id:'observation:'+id, observation:facts}`로 public factory에 전달한다. 다른 evidence selector의 detector/scopeHash 조건을 섞지 않는다. raw→typed hydration은 column metadata를 사용하며 timestamp 선택 후에 Date(ms) 경계를 적용한다.
5. latest first는 현재 SQL의 automatic/succeeded provider 조건과 id DESC를 따른다. ai_approved는 referenced first의 **같은 provider/model identity** 안의 최신 판단이다. 다른 reviewer의 더 새 판단을 잘못 고르지 않는다. abcllm/claude-cli 및 설정된 grok identity 조건을 보존한다. root는 exact fallbackForId로 선택하고 generation/pool/model/first/source/policy/freshness 조건은 공개 predicate에 맡긴다. published에 unpublished-only expiry/first 규칙을 추가하지 않는다.
6. published product는 actual slug ID와 기존 repository identity 선택 결과가 같아야 한다. homepage URL 또는 canonical repository URL 또는 현재 SQL과 같은 repo_url 정규화의 OR 조건, banned 우선/id ASC를 정확히 대조한다. 단일 fixture ID/slug 존재만으로 대체하지 않는다. public repositoryUrl은 그대로 사용한다. 조건 불일치는 input_changed다.
7. current context를 공개 predicate로 검증하고 공개 binding builder를 호출한다. target itemEpoch MAX_SAFE는 이 current context 검증 뒤에 running으로 판정한다. published binding에는 actual productId, unpublished에는 actual firstAttemptId, current composite policy와 원 provider/model/root vote를 보존한다. ready/실행권한·caller receipt를 조립해 반환하지 않는다.

stage→pending→chain busy는 현재 실제 claim의 우선순위를 따른다. 이후 unknown은 지원 범위 미확정이다. 실제 loader가 candidate 오류를 settings 조회보다 먼저 확인하는 내부 순서까지 같은 reason을 보장하지 않는다. 따라서 candidate 오류와 ambiguous settings가 함께 있는 경우도 보수적으로 unknown이며, unknown은 안정적인 eligible/ineligible과 actual claim의 일치율 집계에서 제외한다. 지원 가능한 행의 current 조건은 기존 공개 predicate에 맡기고 private candidate/context 정책을 복제하지 않는다. 불명확한 실제 의미가 있으면 A/B/C는 구현 전에 root에 코드 줄 근거로 보고한다.

## 배타 병렬 파일·DB

| 담당 | 변경 허용 | DB |
| --- | --- | --- |
| A /root/pr01_final_ai1 | NEW lib/operations/pipeline-replay-ai2-target.ts + NEW tests/pipeline-replay-ai2-target.test.ts | 없음 |
| B /root/pr01_final_ai2 | NEW tests/pipeline-replay-ai2-target-adversarial.test.ts | 없음 |
| C /root/provider_contract_evidence | NEW tests/integration/pipeline-replay-ai2-target.test.ts | 새55517 / nomorevibe-pr04c2-ai2-target-db-20261016 |
| root | 계획/새validation/handoff/delivery·전체리뷰·Git | 필요시 별도 배정 |

새 WT `/Users/jr/Desktop/projects/nomorevibe-pipeline-ai2-target`, branch `codex/pipeline-pr04c2-ai2-target-20261016`, base86da89e5다. deps는 APFS clone이고 root typegen은 실제 결과를 별도 기록한다. 55517은 root lsof 실제 exit1/출력0으로 미사용을 확인했다. C는 이전에 쓴 동일 pinnedPG17 sha cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f/loopback dummy만 사용한다. repo0058 jitoff 및 timeout0/1s/0, test20초/hook60초, generic90초는 변경하지 않는다. 다른 DB/volume/image/cache/forensic/생산 접근은 없다.

## 구현 전 행동 RED와 검증

A는 정상 API/strict state·인자 검증/초기 stage·not_pending controls가 실행 가능한 baseline과 자체 실제 행동 RED를 먼저 만들고 두 파일을 동결한다. 미구현 current-domain 분기는 input_changed로 시작할 수 있다. B/C는 그 정확한 source에서 독립 driver의 실제 current valid target 판정/binding 실패와 control PASS를 확인하고 root가 source·driver·원로그·실제 exit를 읽어 수용한 뒤 A 최소 구현을 해제한다. import/API/SQL/setup 오류는 기능 RED가 아니다. 원 driver bytes/기대값을 보존하며 GREEN을 위해 바꾸지 않는다.

A/B는 strict/clone/입력오류, 명시 시각과 ambient conflict, stage/status/unknown reason, rawµs scan tie, referenced reviewer latest, gate/held/published/fallback·provider/model alias·current composite policy, 실제 product identity 우선순위, healthy old-epoch/chain vs 독립 primary/다른 generation, released/expired/MAX_SAFE/정확 expiry 경계, outside universe와 foreign101+ 전량을 검증한다. SQL mock/조립 receipt를 실제 claim의 양성으로 세지 않는다.

C는 경합 없는 ordinary DB에서 **capture TX 종료→논리 판정→별도 내부 TX actual claim→실제 영속 binding/token/owner/boot/epochs 대조→실제 원 receipt의 cancelled writer 정산**을 수행한다. actual claimed receipt만 양성이다. fixture first history/DB frozen bootstrap은 provider 실행이나 인증 이력이 아니다. profile 설치 없이 ordinary actual claim을 사용하며 currentReplayDb item 차단을 우회하지 않는다. semantic context는 referenceTime만 고정하고 lease에는 실제 wall을 쓴다.

capture 전후/claim 전후 DB clock_timestamp µs bounds, 실제 시작한 모든 writer/holder 작업의 정산과 foreign domain/stage 원행 보존을 함께 확인한다. 실제 expiry가 bounds 사이를 가로지르거나 commit/lock 경합이 생긴 비교는 stable differential에서 분리한다. 실제 item/advisory holder의 running skip·해제 후 회복은 별도 경합 증거다. 이를 pure logical false로 바꾸지 않는다. 자연90초 대기를 반복할 필요는 없으며 expired raw fixture를 actual 선발급 양성으로 포장하지 않는다.

정상 claimed는 실제 recordSecondReview cancelled를 await하고 pending domain/jobs/outbox 불변·원 owner/token/lease NULL release·다음 token/epoch 증가를 확인한다. old-epoch 음성 fixture는 현재 epoch에서 옛 receipt 정산이 거절되는 의미를 보존하며 epoch를 되돌려 release 성공으로 만들지 않는다. 실제 외부 작업0/전체 정산 후 own exact row teardown으로 기록한다.

setup/test/writer/holder/정산 Promise를 즉시 Set에 등록한다. snapshot→actualallSettled→registry 삭제→normal profile/bootstrap release(사용시)→own exact keys와 managed raw 복원→whole rawµs/DB·PUBLIC·relation/column ACL·함수/trigger·원stage/readback→STOP를 따른다. body+cleanup+client.end 동시 오류도 보존한다. 기존 전역행을 fixture 개수로 가정하거나 TRUNCATE/global reset/foreign DELETE 재삽입을 하지 않는다.

최종 직접/교차 리뷰·whole unit/정적/관련 DB·필수 CI 후 정상 병합한다. 다음 journal/coverage·새 artifact/profile·실제 item authority/finalwall·혼합 runner, provider baseline/2배/OracleDR 완료를 이 단계로 주장하지 않는다.

## 구현·검증 checkpoint

A6/B121/C원2의 같은 driver GREEN을 확보한 뒤 C 최종600행/a0f6fc12의27PASS6.87s와 root 관련DB4files58PASS15.63s, unit3644·정적/i18n/Python23/build/bundle actual0을 확인했다. root 직접·B→source/A→C 교차리뷰 추가P1/P2 0. fixture µs/uniqueURL/type 및 publication trigger cleanup 누락을 원로그에 보존하고 최소 보강했다. root 원two본문 byte동일·whole raw/effectiveACL baseline 일치 확인 후 own55517 정상STOP/정확 container+volume 제거 완료다. 최종 PR/필수CI/main 결과와 검증 한계는 [검증 장부](../../operations/2026-10-16-pipeline-pr04c2-ai2-target-validation.md)를 따른다. 운영/consumer/provider 활성화0이다.
