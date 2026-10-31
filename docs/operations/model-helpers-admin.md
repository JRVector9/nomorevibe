# 도우미 장비 관리 화면 (쉬는 장비가 1·2차 검수 돕기 · Oracle 감시자 · 자동 정지)

장비의 **자기 역할이 쉬면** 그 장비가 다른 역할(1차 검수·2차 검수)을 돕고, **자기 일이 다시 오면 바로 돌아가게** 하는 배정과 Oracle 감시자를
관리 화면 `/admin/models/helpers`(「도우미 장비」, 메뉴 설정·기록 · 장비 한도 바로 아래)에서 보고 바꾼다
(소유자 목표 2026-10-30: "DeepSeek(M3) 가 사람 검수를 하다가 쉬게 되면 1차/2차 검수를 돕게", 감시자는 Oracle, 모두 관리자에서 설정, 미확인 때문에 멈추지 않는다).

PR 2a 의 화면이다. 배포 직후에는 아무것도 바뀌지 않는다 — 감시자 control 은 꺼져 있고(`enabled=false`) 배정은 없다.
섀도 결과 목록·승격 조건 목록은 PR 2b, 「실전으로 올리기」는 PR 2c 에서 연다(그때까지 단추가 꺼져 있다).

## 원칙 — 신호는 열기만 한다(fail-closed)

- 감시자 신호는 도우미 경로를 **열거나** 빌려주기를 **줄일** 뿐, 우선 역할(순위 1) 일을 막지 못한다.
- 신호가 없거나·만료됐거나·다른 epoch·다른 판(version)·다른 계정이 썼으면 도우미는 **닫힌다**. 빌려주기 제한 신호가 오래되면 **무시**하고 장비 한도의 장부 규칙으로 돌아간다.
- 신선도는 입장 트랜잭션 안에서 DB 시계(`clock_timestamp()`)로만 판정한다. Oracle 호스트 시계와 견주지 않는다.
- 도우미는 언제나 그 장비의 우선 역할보다 낮은 순위이고 grant-or-nothing 이다(대기 행을 남기지 않는다).
- 그래서 감시자가 죽거나 Oracle 이 끊기면 **신호 유효 시간(기본 45초) 안에 도우미가 모두 쉬고**, 우선 역할은 그대로 돈다.

판정의 단일 출처는 `lib/llm/capacity-helpers.ts`(WP-2a-A 고정 계약)다. 이 화면의 「열림·닫힘」은 입장 판정이 DB 안에서 본 `helper_gate` 를
그대로 보이고, 화면 쪽 TS 판정(`helperSignalStaleness` 등)은 "왜 닫혔나"를 글자로 만드는 데만 쓴다.

## 무엇이 어디에 있나

| 항목 | 위치 | 바꾸려면 |
| --- | --- | --- |
| 감시자 전체 스위치·신호 유효 시간·순환 간격 | DB `model_supervisor_control`(id=1, 0154) | 이 화면 「감시자」 카드 |
| 감시자 lease·epoch·heartbeat·순환 번호·release | 같은 행(감시자가 쓴다) | 바꾸지 않는다(보기만) |
| 배정(장비 × 단계 × 경로 × 모드·임계값·이력) | DB `model_helper_assignments` | 이 화면 「배정별 설정」·「새 배정」 |
| 감시자 판정 신호 / 빌려주기 제한 신호 | `model_helper_signals` / `model_device_signals` | 감시자만 쓴다 |
| 자기 일 beacon | `model_role_demand` | 집 쪽 잡(human-deepseek-review·AI1 소비자)이 쓴다 |
| 자동 정지 기록(지울 수 없음) | `model_helper_stops` | 감시자만 넣는다. 풀기는 판 올리기(아래) |
| 장비 칸 수·역할 순위(도우미 경로 순위 2 이상) | `model_capacity_devices`·`model_capacity_device_roles` | `/admin/models/devices`(「장비 한도」) |
| 도우미 경로(정책 경로) | 용량 정책 JSON rev14 | `pipeline-control capacity policy` — DRAIN 창 |

## 화면

### 1. 감시자 (Oracle)

- **전체 스위치(kill switch)** 「감시자 켜기 / 감시자 끄기」. 끄면 다음 입장 판정부터 모든 도우미가 닫힌다 — **돌고 있는 호출은 끝까지 간다**. 우선 역할은 영향이 없다.
  - 켜기는 확인 칸(「감시자 계정·GRANT·정책 rev14·배정(꺼짐)을 마쳤습니다」)을 표시해야 한다. 끄기는 확인 없이 바로 된다.
- **배지**: 정상 / 늦음 / 꺼짐 / 계정 불일치(앞에 있는 것이 먼저).
  - 꺼짐 — 스위치가 꺼져 입장 판정이 모든 신호를 무시한다.
  - 계정 불일치 — 신호를 쓴 DB 계정이 `signal_principal`(기본 `nomorevibe_oracle_capacity_supervisor`)과 다르다. 입장 판정은 그 신호를 쓰지 않는다.
  - 늦음 — lease 가 만료됐거나(감시자가 돌지 않음), 배정이 있는데 유효한 신호가 하나도 없다(신호 만료 → 도우미 모두 쉼).
  - 정상 — lease 가 살아 있고 신호가 유효하다.
- 칸: 위치(인스턴스 이름으로 Oracle 여부) · 인스턴스 · boot · epoch · 순환 번호 · lease(남은 시간) · 마지막 heartbeat · 마지막 신호 n초 전 · release · 신호 계정 · 마지막 변경.
- **순환 설정**(초로 적는다, 저장은 ms): 신호 유효 시간 15~300초 · 순환 간격 5~60초 · **순환 간격 × 2 ≤ 신호 유효 시간**. 감시자의 다음 순환부터 쓰인다.
- **빌려주기 제한 신호**: 장비마다 자기 일 수요(대기 수)·쓰는 신호/무시·나이. 신선한 수요는 그 장비의 빌려주기를 바로 멈춘다.
- **자기 일 beacon**: 역할마다 적체(사람 검수 대기·1차 검수 대기)·신선/오래됨·나이. 오래되거나 없으면 감시자는 그 장비를 바쁨으로 본다(돕지 않음).

### 2. 도우미 표

배정 한 줄씩. 색만으로 가르지 않고 글자를 낸다.

| 열 | 뜻 |
| --- | --- |
| 도우미 장비 | 장비 이름(아래 폼으로 가는 링크)·배정 이름·알림 수 |
| 돕는 단계 | 1차 검수 / 2차 검수 |
| 모델 | 계약·wire 모델 이름(도우미 출력의 참 identity) |
| 모드 | 꺼짐 / 섀도 / 실전 |
| 지금 판정 | 신호를 쓸 수 있으면 감시자 판정(돕는 중 / 섀도만 / 쉬는 중)과 이유, 아니면 「쉬는 중」과 신호를 못 쓰는 이유 |
| 신호 나이 | 신호가 쓰인 뒤 지난 시간 · 남은 유효 시간(또는 만료) |
| 입장(실제) | DB `helper_gate` — 실전·섀도 경로 열림/닫힘 · 점유 n/최대 칸(미확인 행은 점유가 아니다) |
| 주 장비 | 가득 참/여유 · 점유 n/n · 대기 n · 장비 수 (감시자 metrics) |
| 자기 일 | 사람 검수 대기 n(beacon) · 오래됨이면 「바쁨으로 봄」 · 수요 신호가 있으면 「빌려주기 멈춤」 |
| 섀도 | 표본(/승격 기준) · 일치율 · 위험 불일치(잘못 승인·잘못 거절) · 미확인률 · 실패율 (감시자 metrics) |
| 자동 정지 | 지금 판의 정지 효과 · 이유 · 시각 |
| 판 | 배정 version |

판정 이유(pr2-plan §5.2): `primary_full` 주 장비가 가득 참 · `primary_not_full` 주 장비 여유 · `helper_own_work` 자기 일이 있음 · `stale_inputs` 관측이 오래됨 ·
`auto_stopped` 자동 정지됨 · `unknown_rate` 확인 못함 비율 초과 · `failure_rate` 실패 비율 초과 · `quality_regression` 품질 저하 · `mode_off` 꺼짐 · `supervisor_off` 감시자 꺼짐.

신호를 못 쓰는 이유: 감시자 control 행이 없음 · 감시자 꺼짐 · 감시자 lease 만료 · 아직 신호 없음 · 다른 epoch 의 신호 · 다른 계정이 쓴 신호 ·
저장 전 판의 신호(저장 직후 정상 — 다음 순환에 갱신) · 신호 만료.

감시자가 신호 `metrics` 에 적어 주면 화면이 읽는 열쇠(`HELPER_METRIC_KEYS`, 평평한 수·참거짓): `primaryFull` · `primaryActive` · `primaryLimit` · `primaryWaiting` ·
`primaryDevices` · `ownBacklog` · `shadowSamples` · `shadowAgreement` · `shadowWrongApproval` · `shadowWrongRejection` · `shadowUnknownRate` · `shadowFailureRate`(비율은 0~1).
없는 열쇠는 「—」이다. 이름이 바뀌면 `lib/operations/admin-model-helpers.ts` 의 그 표만 맞춘다.

### 3. 자동 정지

감시자가 확인 못함·실패 비율(표본 10 이상)이나 연속 미확인 3번, 실전 품질 저하로 넣은 정지 목록이다. 효과는 두 가지다.

- 자동 정지 — 실전·섀도 경로 모두 닫힌다.
- 실전 → 섀도 강등 — 실전 경로만 닫히고 섀도 표본은 계속 쌓인다(회복 근거).

정지는 **지금 판(version)에만** 걸리고 지워지지 않는다(append-only). 배정을 다시 저장하거나 「자동 정지 해제」로 판을 올리면 풀린다 — 옛 판의 정지는 표에서 사라지지만
행은 남는다. 근거(evidence)는 감시자가 남긴 JSON 을 글자 그대로 보인다(마크업으로 해석하지 않는다).

### 4. 배정별 설정 · 모드 단추

- **모드 단추**: 섀도 시작(꺼짐 → 섀도) · 섀도로 내리기(실전 → 섀도) · 끄기 · 자동 정지 해제(정지가 있을 때만) · 실전으로 올리기(PR 2c 전까지 꺼짐).
  - 섀도 결과는 어떤 판정에도 쓰이지 않는다. 실전 승격은 같은 `evidence_key` 의 섀도 근거·조건 목록·확인 「실전」이 필요하다(PR 2c).
  - 「자동 정지 해제」는 같은 값으로 다시 저장한다: 꺼짐·섀도는 같은 모드로 `setHelperMode`, 실전은 같은 입력으로 `saveHelperAssignment`. 둘 다 판이 오른다.
- **설정 폼**: 숨은 `expectedVersion` 으로 compare-and-set. 장비·단계·배정 이름·모드는 숨은 값으로 지킨다(모드는 단추로만 바꾼다).

| 칸 | 범위 | 기본 |
| --- | --- | --- |
| 모델 · 섀도 경로 · 실전 경로 · 실전 공급자 | 글자(섀도 ≠ 실전) | 단계별 기본 경로(아래) |
| 최대 칸 | 1~256 | 1 |
| 한 틱 최대 건수 | 1~16 | 2 |
| 시간당 섀도 표본 | 0~600 | 30 |
| 승격 최소 표본 | 20~10000 | 200 |
| 최소 일치율 | 50~100% | 95% |
| 잘못 승인 상한 · 잘못 거절 상한 · 확인 못함 비율 상한 | 0~50% | 1% · 2% · 2% |
| 실패 비율 상한 · 실전 2차 불일치 상한 | 0~90% | 10% · 10% |
| 들어가는 표본 수 · 나오는 표본 수 | 1~20 · 1~40 | 2 · 4 |
| 최소 유지 시간 · 재진입 대기 | 0~3600초 | 120초 · 60초 |
| 메모 | 400자 | — |

백분율은 소수 한 자리까지 받는다(저장은 0~1, 소수 셋째 자리). 기본값은 WP-2a-A zod 의 default 를 그대로 읽는다.

- 임계값·이력만 바꾸면 판이 오르고(그 판의 자동 정지가 풀린다) **섀도 근거는 그대로**다.
- 모델·경로(서빙 계약·wire 변형)를 바꾸면 `evidence_key` 가 바뀌어 **섀도 근거가 처음부터** 시작하고, 실전은 같은 저장에서 섀도로 내려간다(저장소가 정한다; 화면은 결과를 알린다).

### 5. 새 배정

장비 × 단계마다 하나(0156 부터는 도우미 행만 거는 부분 유일 색인 `model_helper_assignments_helper_stage_device_idx`). 배정 이름을 비우면 `<장비>:<단계>`(예: `m3-deepseek:ai1`)가 된다. 처음에는 꺼짐으로 만든다(실전은 고를 수 없다).

단계별 기본 경로(`HELPER_ROUTE_DEFAULTS`, 정책 rev14):

| 단계 | 섀도 경로 | 실전 경로 | 실전 공급자 |
| --- | --- | --- | --- |
| 1차 검수(ai1) | `local-helper-shadow-ai1` | `local-ai1-helper` | `local-direct` |
| 2차 검수(ai2) | `local-helper-shadow-ai2` | `second-review` | `local-direct` |

### 6. 최근 기록

`operations_audit` 의 `model-helper-save`(배정 저장) · `model-helper-mode`(모드 바꿈) · `model-helper-promote`(실전 승격, PR 2c) · `model-supervisor-toggle`(감시자 설정)
최근 20줄 — 누가 · 무엇 · 대상·판 · 바뀐 값(비율은 %, 시간은 초·분). 거절은 이유.

## 저장 경로

server action 다섯(`app/(operator)/admin/models/helpers/actions.ts`), 모두 `export const x = webWriteAction(async function x(prev, form) …)`:

| action | 하는 일 | 저장소 함수(WP-2a-A) |
| --- | --- | --- |
| `saveModelHelper` | 배정 만들기·저장(CAS) | `saveHelperAssignment(tx, input, expectedVersion, actor)` |
| `changeModelHelperMode` | 섀도 시작·섀도로 내리기·끄기(CAS). 실전은 저장소 전에 거절 | `setHelperMode(tx, id, "off"\|"shadow", expectedVersion, actor)` |
| `clearModelHelperStop` | 자동 정지 해제 = 같은 값으로 다시 저장(CAS) | `listHelperAssignments(tx)` → `setHelperMode` 또는 `saveHelperAssignment` |
| `switchCapacitySupervisor` | 전체 스위치(켜기는 확인 칸) | `setSupervisorControl(tx, { enabled }, actor)` |
| `saveCapacitySupervisorTiming` | 신호 유효 시간·순환 간격 | `setSupervisorControl(tx, { signalTtlMs, loopMs }, actor)` |

순서: 쓰기 관문(`webWriteAction` — 캐시 fence 확인, 쓰기 TX 의 첫 lock 은 fence SHARE) → `currentAdmin()` → 폼 숫자 모양 검사 →
`lib/operations/admin-model-helpers.ts` 의 저장 함수 = `onPrimary(() => db.transaction(tx => 저장소 함수(...)))` 한 번.
저장소가 그 TX 안에서 replay 거부 → DR fence → control FOR UPDATE → 검증 → 행 FOR UPDATE·CAS → 쓰기 → `operations_audit` **한 줄**을 모두 한다 —
화면 쪽은 감사 줄을 **또 쓰지 않는다**. 저장 뒤 `revalidatePath(/admin/models/helpers, /admin/models/devices, /admin/models, /admin/status)`.

상태 읽기는 `readHelperStatusSnapshot()` 한 번(REPEATABLE READ READ ONLY, `nowMs` = DB 시계)과 감사 읽기다. 스냅샷을 못 읽으면 이유만 보이고 화면은 읽기 전용이 된다
(WP-2a-A 저장소 본문이 들어오기 전에는 「도우미 저장소가 아직 준비되지 않았습니다」).

## 거절 코드와 문장

`lib/operations/admin-model-helpers.ts modelHelperIssueMessage` 한 곳에서 만든다. 모르는 코드는 그대로 보인다.

| 코드 | 문장(요지) |
| --- | --- |
| `model_helper_version_mismatch:<판\|none\|invalid>` | 다른 사람이 먼저 저장했습니다(지금 판 N). 새로고침해 주세요 |
| `model_helper_refused:helper_route_is_primary` | 도우미 경로가 이 장비의 우선 역할입니다 — 장비 한도에서 순위를 2 이상으로 |
| `model_helper_refused:helper_route_unmapped` | 정책에 도우미 경로가 없습니다(DRAIN 창에서 rev14 적용) |
| `model_helper_refused:helper_ai2_voter_not_in_fallbacks` | 2차 대체 모델 목록에 먼저 넣으세요 |
| `model_helper_refused:helper_device_unconfigured` | 도우미 장비 행이 없습니다 — 장비 한도에서 먼저 저장 |
| `model_helper_refused:helper_live_requires_promotion` | 실전은 승격으로만(PR 2c) |
| `model_helper_invalid:<path>` | 칸별 범위 문장(위 표). `root` = 모양이 틀림, `evidence` = 근거 열쇠를 만들지 못함 |
| `model_supervisor_invalid:<enabled\|signalTtlMs\|loopMs\|root>` | 감시자 설정 범위·순환 × 2 ≤ 유효 시간 |
| `model_supervisor_control_missing` | 감시자 control 행이 없습니다 — migration 0154 확인 |
| `site_fenced` · `lineage_mismatch` · `epoch_stale` · `epoch_ahead` | 이 사이트는 지금 쓰기가 막혀 있습니다(DR) |
| `model_capacity_replay_unsupported` · `model_capacity_control_missing` | 재생 DB 에서는 저장 불가 · 용량 제어 행 없음 |
| `capacity_helpers_not_implemented` | 도우미 저장소가 아직 준비되지 않았습니다 |

## 운영 순서(감시자를 켜기 전에)

1. Oracle 에 감시자 계정 `nomorevibe_oracle_capacity_supervisor` 를 만들고 `deploy/oracle/least-privilege.sql` 의 감시자 부분을 적용한다(WP-2a-B).
   읽기 전용 monitor 역할에 새 표 SELECT 를 준다.
2. DRAIN 창에서 정책 rev14(도우미 경로 넷)를 적용하고, 장비 한도에서 도우미 경로를 그 장비의 순위 2 이상으로 둔다.
3. 이 화면에서 배정을 **꺼짐**으로 만든다(OPEN 전에).
4. 감시자 소비자(`capacity-supervisor`)를 Oracle 에서 띄운다. 배지가 「늦음」(lease 없음)에서 바뀌는지는 켠 뒤에 본다.
5. 그다음에만 「감시자 켜기」(확인 칸 표시). 섀도는 배정마다 「섀도 시작」으로 연다.

장애 드릴(감시자 멈춤 → 45초 안에 도우미 판정 만료)·첫 섀도 표본은 실제 실행 영수증으로만 기록한다.

## 배정 표 열 — 3b-A

migration `0156_model_assignments`(PR 3b-A)는 같은 표 `model_helper_assignments` 를 「단계 × 장비 × 모델」 배정 표로 넓힌다.
**배포 직후 동작은 바뀌지 않는다** — 배정 표 행(role `primary`)은 아직 없고, 만드는 함수(`saveModelAssignment`)를 부르는 화면·잡도 아직 없다.
이 행을 읽어 모델을 고르는 것은 3b-B(flag 뒤), 로컬 계약을 표에서 읽는 것은 3b-C 다.
번호: 원래 0155 였으나 PR 3a-C(`0155_split_composite_jobs`)가 먼저 main 에 들어가 통합 때 0156 / when 1794086401067 로 다시 매겼다(2026-10-31).

### 새 열

| 열 | 뜻 | 기존(도우미) 행 |
| --- | --- | --- |
| `registry_key text` | 관리자 모델 등록부 key(`equipment:name`, 1~200자). 배정 표 행은 필수(`primary_registry_check`) | NULL |
| `transport text` | `gateway` · `direct` · `local-direct` · `cli` | `gateway`(기본값, 뜻 없음) |
| `rank integer` | 단계 안 순위(≥ 1, 저장은 1~64 — 장비 순위 CHECK 와 같다). 1 = 먼저 고른다 | 1 |
| `role text` | `primary` = 배정 표 행, `helper` = PR 2a 도우미 행 | `helper` |
| `vote boolean` | 2차 투표자. `stage = 'ai2' AND rank = 1` 일 때만(`vote_check`) | false |

- 단계 CHECK(`model_helper_assignments_stage_check`)는 열일곱으로 넓혔다: `ai1, ai2, human, audit, audit-second-opinion, intro, screen, assist, assist-audit,
  reason, tagline, profile, verify, ko, translate, publish-classify, repo`(열은 `varchar(24)`). 도우미 행은 여전히 `ai1`·`ai2` 만(`role_stage_check`).
  섀도·실전 결과 표의 단계 CHECK 와 `pipeline_stage_modes`·`pipeline_item_leases` 의 단계(`fetch·ai1·ai2`, 다른 어휘)는 바꾸지 않았다.
- 유일: `(stage, device_id)` 제약(`…_stage_device_key`)을 지우고 `UNIQUE (stage, device_id, model)`(`…_stage_device_model_key`)을 걸었다.
  「도우미는 단계 × 장비 하나」는 부분 유일 색인 `…_helper_stage_device_idx … WHERE role = 'helper'` 로 남는다. `(device_id, live_route_id, live_provider, model)`·
  `(device_id, shadow_route_id, model)` 유일은 그대로다.
- `live_check` 는 도우미 행에만 승격 기록을 요구한다(`mode <> 'live' OR role = 'primary' OR (promoted_at … AND promoted_evidence …)`). 배정 표 행의 `live` 는 「이 배정을 쓴다」다.
- 입장(`helperGateCte`)·감시자 스냅숏·이 화면(`listHelperAssignments`·`readHelperStatusSnapshot`·도우미 경로 상태)은 **`role = 'helper'` 행만** 읽는다 — 배정 표 행의
  route 는 그 장비의 보통 역할이라 도우미 관문에 걸리면 안 된다. 기존 행은 모두 `helper` 라 판정은 이전과 같다. `saveHelperAssignment`·`setHelperMode` 는 배정 표
  행 이름을 받으면 `model_helper_invalid:assignmentId` 로 거절한다.

단계별 route·전송(`ASSIGNMENT_STAGES`, `lib/llm/capacity-helpers.ts`):

| 단계 | route | 전송 |
| --- | --- | --- |
| ai1 | `crawl-agent-review` | gateway · direct · cli |
| ai2(투표) | `second-review` | gateway · direct · local-direct · cli |
| human · audit · audit-second-opinion · screen | `local-human-deepseek` · `local-audit` · `local-second-opinion` · `local-screen` | local-direct |
| intro · publish-classify | `product-intro-check` · `crawl-publish-classify` | cli |
| reason · tagline · profile · verify · ko · translate | `reason-translate` · `crawl-tagline` · `product-search-profile` · `product-search-verify` · `product-tagline-ko` · `product-translate` | gateway · direct |
| assist · assist-audit · repo | (예약) | 없음 — assist 의 route 는 작업·백엔드마다 다르다(`local-assist-<task>-<backendId>`), 3b-B 가 정한다 |

전송 → 정책 route provider: gateway·direct → `abcllm`, local-direct → `local-direct`, cli → 등록부 provider(`claude-cli`·`grok-cli`·`codex-cli`, 등록부 equipment 가
`connect` 인 모델만). wire 모델: gateway 는 `[label] model`(modelRequestName), 나머지는 엔진·CLI 이름 그대로.

### 저장 흐름(`saveModelAssignment(tx, input, actor, deps)`, `lib/llm/capacity-helpers-repository.ts`)

호출자의 TX 하나에서, 던지면 아무 행도 남지 않는다.

1. replay 거부 → zod(`modelAssignmentInputSchema`: (단계, 전송) 허락·cli = connect·vote = 2차 rank 1·role `primary` 만·mode `off`/`live`) → 등록부 key → wire 모델·provider.
2. 장비 행 미리 보기 → **계약 확인**(잠금 없이): gateway·direct 는 `model_serving_contracts` 의 (route, wire 모델) enabled 행(transport 가 맞아야 한다),
   local-direct 는 `local-direct:<route>` 행(local-openai-chat-v1, physicalGroup = 장비), cli 는 `probeCliServingContracts()` 가 연 CLI 계약.
   행이 없으면 `deps.probeContract`(운영 배선 = `probeEngineContract`: 엔진 연결과 같은 `/models` readback + 1-token probe)로 만든다. **readback 실패 = 저장 거절**
   (`model_assignment_refused:contract_probe_failed:<원인>`). `second-review` 처럼 엔진 연결이 계약을 만들지 않는 route 는 `contract_unbuildable`(계약 화면에서 먼저 넣는다).
   local-direct 계약은 env `LOCAL_MODEL_SERVING_CONTRACTS` 대신 같은 표에 `route_id = local-direct:<route>` 로 둔다(gateway 계약의 (route_id, model)과 섞이지 않게).
   backendId = 등록부 key 의 `:` 를 `-` 로, 보수적 기본값(vision·jsonSchema 끔, thinking 끔, response_only, 출력 상한 = 등록부 maxTokens). 지금은 아무도 읽지 않는다.
3. DR fence(첫 잠금) → probe 한 계약 쓰기(자기 감사 `model-serving-contract-save`) → control FOR UPDATE → 장비 행 FOR UPDATE(없거나 꺼졌으면 `device_unconfigured`) →
   배정 행 FOR UPDATE·compare-and-set(`expectedVersion`) → 같은 장비의 도우미 경로와 겹침 검사(`route_is_helper_route`).
4. **정책 route 덧붙이기**(`appendCompatibleRoutes`, `lib/llm/capacity-repository.ts`): `{ route, provider, wire 모델, providerBudgetId, groupId = 장비 }` —
   providerBudgetId 는 등록부 equipment, local-direct 만 계약의 backendId. 같은 (route, provider, 모델)이 이미 같은 장비에 있으면 그대로 쓰고(다른 장비면 `route_device_mismatch`),
   다섯 칸이 같으면 아무것도 쓰지 않는다(다시 저장해도 revision 그대로). **mode 는 그대로(DRAIN 없음)**, revision + 1, 옛 route 는 지우거나 순서를 바꾸지 않는다.
   잡힌 행(reserved·dispatched)은 `compatiblePredecessor` 로 산다. 앞 판은 한 단계뿐이라: 지금 정책에 앞 판이 없으면 앞 판 = 지금 정책, 있으면 지금 판의 잡힌 행이
   남아 있을 때 `model_capacity_append_predecessor_busy`(그 행이 끝난 뒤 다시 저장), 지금 판이 비었으면 앞 판의 잡힌 행이 있을 때만 그 앞 판을 넘기고 아니면 비운다.
   route 상한은 128 → 256(`MODEL_CAPACITY_ROUTES_MAX`) — 옛 parser 는 129개 이상을 거절하므로 모든 용량 소비자가 이 판을 돈 뒤에만 129번째를 넣는다.
5. 장비 순위 `(device, route) = rank`(바뀌면 장비 version + 1 — 장비 폼의 옛 화면 저장이 CAS 로 거절된다) → 배정 행 upsert(version + 1; `shadow_route_id` 는 표지
   `primary:<단계>`, `live_route_id`·`live_provider` = 그 route) → `operations_audit` `model-assignment-save` 한 줄(before·after·계약·route·덧붙였나·revision·장비 순위).

거절 문자열: `model_assignment_invalid:<path>` · `model_assignment_version_mismatch:<current|none>` · `model_assignment_refused:<code>`(`MODEL_ASSIGNMENT_REFUSALS`) ·
덧붙이기의 `model_capacity_routes_cap` · `model_capacity_route_conflict` · `model_capacity_append_predecessor_busy` · `site_fenced`.

읽기·고르기(`lib/llm/stage-assignments.ts`, 아직 아무도 부르지 않는다): `assignmentsForStage(stage, { mode: 'live' })` = rank → assignment_id 순,
`chooseModelForItem(rows, itemKey, { excludeModels })` = 1차 오늘 규칙(`selectFirstReviewer`)과 같은 `(itemKey − 1) mod n` 칸, rank 가 모두 빠지면 다음 rank,
`votersForItem(rows, itemKey, 1차 모델)` = 2차 rank 1 · vote · live 행에서 1차와 같은 가중치(`sameUnderlyingModel`)를 뺀 목록(순서만 항목마다 돈다).

## 테스트

- `tests/admin-model-helpers.test.tsx` — 화면 모형(감시자 배지 우선순위·나이·신호 못 쓰는 이유·지금 판의 정지·beacon·metrics), 폼 → 저장 입력(백분율·초·이름 유도),
  순환 설정 검사, 모든 거절 코드 문장, 저장소 전 거절(실전 모드 등은 저장소를 부르지 않는다), server action 다섯, 그리기(표·카드·폼·실전 단추 꺼짐), 메뉴·PageStamp,
  클라이언트 글자 규칙 = 서버 모듈.
- `tests/integration/admin-model-helpers.test.ts` — 진짜 쓰기 관문·감사 표·0154 control 행 위에서 action → 메모리 저장소(같은 계약,
  `setCapacityHelpersRepositoryForTest`) → 감사 한 줄 → 화면 모형; CAS 거절(저장·모드·해제, 감사 없음); 자동 정지 해제; 저장 거절; 전체 스위치(확인 칸·감사·배지); 순환 설정; 비관리자.
  공유 테스트 DB(55435)가 아니라 자기 DB 로 돌린다(예: `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55452/nomorevibe_test`).
- `tests/dr-web-fence.test.ts` — 도우미 action 다섯이 쓰기 관문을 지난다(수 97). `tests/admin-navigation.test.tsx` — 메뉴 링크 23개.
- 배정 표(3b-A): `tests/capacity-helpers.test.ts`(어휘·zod·evidence·0156 글자·route 상한), `tests/stage-assignments.test.ts`(고르기, 1차 칸 = selectFirstReviewer),
  `tests/integration/model-assignments.test.ts`(자기 DB: 계약·route·장비 순위·감사 한 TX, 같은 저장 반복, 잡힌 행과 앞 판, 상한·충돌, 거절 뒤 남는 행 없음, cli·vote·local-direct 계약).
- 표·입장 판정·감시자 순환은 WP-2a-A·B 의 테스트가 본다(`tests/capacity-helpers.test.ts`, `tests/integration/model-capacity-helpers.test.ts`, `tests/capacity-supervisor-decide.test.ts`).
