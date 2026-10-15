# PR04c-2a-0 — item 상태 증거의 순수 모델 기반

사용자가 승인한 PR별 병렬 개발을 이어간다. root가 파일/DB 소유권·actual 결과·직접/교차 리뷰·Git을 관리한다. 모델은 모두 gpt-6.1-sol/xhigh다.

## 목표와 범위

stage와 item 전체 행의 상태·해시·정확한 OLD/NEW 변경 및 lease 만료 경계를 표현하는 작은 순수 모듈을 먼저 납품한다. 이후 combined readiness v2가 이를 구성요소로 사용한다. **이번 payload 자체는 독립 item-state v1**이며 기존 readiness/artifact v1과 다른 kind다. 현재 기존 v1/handlers-v5·replay entry/차단을 byte 변경0으로 유지한다. production DB capture/journal/profile/권한/실행/coverage/verified artifact는 이 PR에서 연결하지 않는다. 따라서 새 item 인증·새 consumer·운영 활성화·성능/DR 완료를 뜻하지 않는다.

선행 c1b PR444/headca715846의 CI38798204078 필수check 전체SUCCESS를 직접 확인하고 정상 squash merge했다. actual main은 `bcf4396e51738ee4c974f72728c27ea72d8a1598`, main CI38799565167은 진행 중이다. c1a main CI38797366784는 image까지 전체SUCCESS다. 새 WT `/Users/jr/Desktop/projects/nomorevibe-pipeline-item-projection`, branch `codex/pipeline-pr04c2-item-projection-20261016`, baseca715846에서 actualmain과 tree동일을 확인하고 정상 merge `cfc44c2d`로 통합했다. 원본 X branch push 금지, 최신 handoff만 동기화한다.

## 고정 API와 증거 형식

NEW `lib/operations/pipeline-replay-item-state.ts`만 production 파일로 허용한다. 기존 공개 API는 변경하지 않는다.

```ts
export const ReplayItemStateSchema: /* strict schema */;
export const ReplayItemStateChangeSchema: /* strict schema */;
export type ReplayItemState = /* inferred from strict schema */;
export function canonicalReplayItemState(value: unknown): ReplayItemState;
export function replayItemStateHash(value: unknown): string;
export function applyReplayItemStateChanges(value: unknown, changes: readonly unknown[]): ReplayItemState;
export function replayItemStateExpiries(value: unknown): string[];
```

상태의 최상위는 정확히 다음 형식이다. `tables`도 strict다.

```ts
{
  kind: "pipeline-replay-item-state", version: 1,
  tables: {
    pipeline_stage_modes: StageRawRow[],
    pipeline_item_leases: ItemRawRow[]
  }
}
```

StageRawRow는 실제 DB 열6개(stage/mode/draining_from/epoch/writer_contract_version/updated_at), ItemRawRow는 실제 열12개(stage/work_key/binding/binding_hash/owner_instance_id/owner_boot_id/token/stage_epoch/item_epoch/lease_until/created_at/updated_at)를 전부 요구한다. 실제 schema 열 수를 getTableColumns로 대조한다. unknown/missing 열은 거절한다. 원 JSON을 수정하지 않고 복제하며, 전체 fetch/ai1/ai2 stage가 정확히 한 행씩 있어야 한다. item은 전체 외부 행까지 보존하고 (stage,work_key) 복합키로 중복을 거절한다. 순서는 locale에 의존하지 않는 코드포인트 비교의 stage 및 work_key 오름차순이다.

기존 itemStage/Mode/Binding/Owner parser와 itemWorkKey/itemBindingHash의 구조 규칙을 재사용한다. ID/epoch는 safe integer, stageepoch>=1/itemepoch>=0, contract는 실제 SQL integer 범위의 비음수다. stage의 draining_from·owner 필드 all-null/all-set·active itemepoch>=1·정확한 binding stage/workkey/hash를 검증한다. **구조 검증은 현재 source/사람/정책·호출/소유권 발급 증명이 아니다.** 과거 stageepoch의 stale 행/외부 owner/expired 행은 제거하지 않고 그대로 표현한다. stage의 현재 epoch와 item의 과거 epoch가 같아야 한다는 검사를 추가하지 않는다.

## 시각과 해시

실제 PG to_jsonb의 zone있는 timestamp 텍스트와 ISO UTC를 받아 UTC로 정규화한다. 날짜/시각/zone 오류·유효하지 않은 달력·Date 객체·timezone 누락을 거절한다. 입력은 four-digit year, T 또는 space, 0–6자리 fractional seconds, Z 또는 ±HH:mm이다. canonical은 ISO UTC .sssZ, 실제 sub-ms가 있으면 .ssssssZ다. 같은 instant의 offset/0-padding 차이는 같은 값/해시, 1µs 차이는 다른 값/해시다. µs를 JS Date에만 왕복시켜 버리지 않는다. unsafe integer/NaN/Infinity가 증거에 들어가지 못하게 한다. source stage/item은 precision3이므로 실제 DB가6자리 정밀도를 가진다고 주장하지 않는다.

해시는 기존 reviewHash에 전체 canonical payload(kind/version/전체 행/모든 열)를 넣는다. 갱신 시각·lease/owner/token/epoch/binding 변경을 allowlist로 제거하지 않는다. 공개 verified handle이나 authority/성능 판정을 반환하지 않는다.

`replayItemStateExpiries`는 owner가 설정된 모든 item의 lease_until을 canonical UTC로 중복제거·정확한 시각순 정렬해 반환한다. released 행은 제외하고 expired/stale/foreign 행은 보존한다. now를 받거나 live/ready라고 판정하지 않는다. 실제 item lease의 `lease_until > DBclock` 경계는 **expiry 그 시각**이며 job의 >= TTL/+1µs 경계를 복사하지 않는다.

## 변경 적용

Change는 strict table_name enum(stage/item 두 개), operation INSERT/UPDATE/DELETE, full old_row/new_row 또는 null, ordinal positive safe integer다. 입력 전체 순서의 ordinal은1..N 연속이어야 하며 중복·누락·역순은 거절한다. operation과 OLD/NEW null 조합을 검증한다. 모든 row를 같은 canonical 규칙으로 정규화하고, INSERT 기존키 존재·UPDATE/DELETE 실제 OLD 전체불일치·UPDATE키변경은 거절한다. stage PK는 stage, item PK는 JSON tuple(stage,work_key)이다. 모든 변경은 caller 입력 복제본에서만 적용하고 실패 시 원본 변경0이다. 마지막 전체 상태도 strict로 검증한다. 알 수 없는 테이블/임의 source mutation은 이 모듈에서 다루지 않는다.

이는 실제 ledger journal이나 DB commit authority가 아니다. 테스트가 actual OLD/NEW를 함수에 넣어 비교하더라도 인증된 journal/fence/seal을 이미 구현했다고 쓰지 않는다.

## 배타 파일 소유권

| 담당 | 편집 파일 | DB |
| --- | --- | --- |
| A /root/pr01_final_ai1 | NEW lib/operations/pipeline-replay-item-state.ts + NEW tests/pipeline-replay-item-state.test.ts | DB없음 |
| B /root/pr01_final_ai2 | NEW tests/pipeline-replay-item-state-adversarial.test.ts만 | DB없음 |
| C /root/provider_contract_evidence | NEW tests/integration/pipeline-replay-item-state.test.ts만 | 55509 / nomorevibe-pr04c2-state-db-20261016 |
| root | docs4/Git/리뷰/전체 gate | 필요시 별도55510 |

A가 API와 실행 가능한 최소 scaffold를 먼저 동결/통보한다. B/C는 독립 테스트를 설계하되 import/API부재를 행동 RED로 세지 않는다. A는 자신의 새 기능 unit TDD를 먼저 실행하고, 추가 독립 behavioral RED는 root가 원 driver/log/exit를 수용한 뒤 해당 production 파일의 수정을 배정한다. B/C는 source를 수정하지 않는다. freeze 뒤 쓰기는 root에 먼저 알리고 허가받는다. 기존 v1 파일·SQL·generic item/registry/provider/worker·운영 변경0.

C는 pinnedPG17 `pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`, loopback55509/dummy nomorevibe:nomorevibe/nomorevibe_test만 생성/연결한다. root가 현재포트 미사용 확인 후 사용한다. 실제 stage/item SQL열/to_jsonb와 generic claim/renew/release가 만든 행을 pure projection으로 roundtrip/변경대조한다. 별도 domain AI2 검수나 실제 인증 journal을 증명하는 테스트로 부르지 않는다. 정상 token/owner는 actual generic claim으로 발급하고 raw 임의 token을 positive authority로 쓰지 않는다. 모든 stage/외부행/관리행은 raw to_jsonb 전체snapshot·µs값으로 exact 복원, own prefix만 삭제·다른connection0·기본stage readback/STOP/exited0을 반환한다. broad prune/다른DB/forensic/cache/image변경0. default test20초 유지, 원래claim90초/일반renew로 충분하며 자연90초재실행은 이번범위가 아니다.

## 검증과 완료 기준

- A: 실제 함수의 key/hash/reducer/expiry 기대행동 FAIL→같은 unit GREEN, whole tsc/scopedlint·최종SHA 반환.
- B: malformed/version/OLD/ordinal/복합키·입력불변·시각offset/1µs/epoch/외부행/hash 회귀. 기존 v1 strict parser가 새kind payload를 인증증거로 받아들이지 않는 negative도 포함한다.
- C: actual SQL column conformance·generic claim/renew/release raw행·exact OLD/NEW/replay/hash·released/foreign/stale 보존, 실패정리/최종readback/STOP.
- root: 전체diff 직접·B→A/A→C 읽기교차 리뷰, 기존v1파일byte0 확인, unit/관련DB/wholeDB/타입/lint/i18n/Python/build/bundle 필요한 gate를 취합한다. source변경 없는 검증을 불필요반복하지 않는다. 최신main 통합·commit/push/PR/필수CI/normalmerge/mainCI를 실제확인한다.

후속은 actual capture/selector differential→journal/coverage→불변version/profile→실제authority/finalWall→고정AI1legacy+AI2item fixture runner다. 처음부터 all-item/2배/Oracle DR 합격으로 올리지 않는다. 참고 `/tmp/nomorevibe-pr04c2-source-contract-20261016.md`는 읽기제안이며 이 고정계약이 우선한다.
