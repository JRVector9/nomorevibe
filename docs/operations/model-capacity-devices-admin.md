# 장비 한도 관리 화면 (장비별 칸 수·우선순위·빌려 쓰기, DRAIN 없이)

모델 장비(device)마다 **동시에 처리하는 칸 수**, **역할(경로) 우선순위**, **낮은 순위 역할의 상한**, **유휴 장비 빌려 쓰기**를 관리 화면
`/admin/models/devices`(「장비 한도」, 메뉴 설정·기록)에서 저장한다. 저장하면 **다음 입장 판정부터 바로** 쓰인다. 정책 개정·DRAIN·재배포가 필요 없다
(소유자 결정 2026-10-30: 전역·풀 한도 제거, 장비별 한도만; 한도·우선순위·상한·유휴 시간은 정책 세대와 분리된 실시간 설정).

## 무엇이 어디에 있나

| 항목 | 위치 | 바꾸려면 |
| --- | --- | --- |
| 장비별 칸 수·낮은 순위 상한·유휴 판정 시간·비워 둘 칸·엔진 실제 동시 처리 수·메모 | DB `model_capacity_devices` (0153) | 이 화면. 저장 즉시 다음 입장부터 |
| 장비별 역할 순서(경로 → 순위) | DB `model_capacity_device_roles` | 이 화면(같은 저장) |
| 경로 → 장비 매핑(`routes[].groupId`), 대기열 TTL·예약 TTL·최대 대기 | 용량 정책 JSON (`model_capacity_control.policy`) | `pipeline-control capacity policy` — 정책 개정, DRAIN 필요 |
| 경로 한도·번역 묶음·틱 예산 | `runtime_settings` | `/admin/models/limits`(「실시간 한도」) |
| 모델 주소·키·계약 | `model_serving_contracts`·`model_registry_overrides` | `/admin/models/contracts`(「모델 연결」) |

- **장비** = 정책 경로의 `groupId` = `model_capacity_requests.group_id`. 같은 장비를 쓰는 경로가 여러 개면 그 장비의 칸을 나눠 쓴다.
- **역할** = `routeId`. 순위 1 이 우선 역할이다(여러 경로가 1 을 가질 수 있다). 순위를 적지 않은 경로는 최하위(32767)다.
- 저장은 작업 로그 `operations_audit` 에 `model-capacity-device-save`(target = 장비 이름, detail `{ version, expectedVersion, before, after }`)로 남는다 —
  이 줄은 1b-A 저장소(`saveModelCapacityDevice`)가 쓰고 화면 쪽은 또 쓰지 않는다. 거절(판 불일치·검사 실패)은 저장소가 행도 감사도 건드리지 않고 던지며 화면에 문장으로 보인다.
- 표·불변식·SQL·GRANT 는 1b-A 문서 [`model-capacity-devices.md`](model-capacity-devices.md) 가 기준이다. 이 문서는 관리 화면의 몫만 적는다.

## 입장 판정이 이 표를 어떻게 보나

입장 판정(`grantOne`)은 **같은 트랜잭션 안에서 장비 행과 역할 순서를 그대로 읽는다**. 프로세스 안 캐시·TTL·폴링이 없고, 워커가 "읽은 판"을 알릴 것도 없다.
그래서 이 화면에는 「읽은 판」 줄이 없고, 장비마다 판(`version`)·마지막 저장만 있다. 판은 (a) 폼의 compare-and-set, (b) 감사 참조, (c) 재생·예산 도구가
"창 안에 설정이 바뀌었다"를 판단하는 데 쓴다.

장비 D 에 대한 판정(한 번의 입장 패스마다 장비별로 최대 한 건 예약):

- `점유(D)` = D 에 잡힌 행 수 — **예약(reserved)·진행(dispatched)과 결과 미확정 점유**. 미확인(indeterminate) 행은 보낸 시각(없으면 미확정이 된 시각)부터
  유지 시간(실시간 한도 「모델 장부 점유」 `capacity.unknownHoldSeconds`, 기본 600초) 동안만 점유로 세고 그 뒤로는 세지 않는다(2026-11-10 소유자 결정,
  `lib/llm/capacity-unknown-hold.ts`; 0 이면 예전 소유자 결정 a·indeterminate-no-hold 그대로 세지 않는다). 표의 「미확정 점유 N」이 그 수다.
- `우선 역할 바쁨(D)` = 순위 1 경로의 행이 대기 중(현재 세대, 만료 전)이거나 예약·진행 중이거나, 마지막 갱신이 **유휴 판정 시간** 안이다.
- `낮은 순위 상한(D)` = 우선 역할이 바쁘면 **낮은 순위 평소 상한**, 유휴면 `max(평소 상한, 칸 수 − 항상 비워 둘 칸)` → 이때가 **빌려 쓰는 중**이다.
- 대기 행 q 가 들어오는 조건: `점유 < 칸 수` 이고 (`q 가 순위 1` 이거나 `낮은 순위 점유 < 낮은 순위 상한`). 장비 안에서는 (순위, 대기 순번)이 작은 행부터.

우선 역할은 상한·비워 둘 칸을 보지 않고 빈 칸을 모두 쓴다. 우선 역할 요청이 오면(대기 행 하나만 생겨도) 낮은 순위 상한은 평소 상한으로 바로 내려가
새 낮은 순위 입장이 멈추고, 빈 칸은 우선 역할로 간다. **진행 중인 낮은 순위 호출은 끊지 않는다**(한계 하나 — 소유자 수용). 유휴 판정은 장부만 본다(사람 위임 틱 60초 등
장부에 아직 없는 적체는 PR 2 감시자의 몫).

### 저장이 바꾸는 것·바꾸지 않는 것

- 칸 수를 점유보다 낮추면 **새 입장만 막힌다**. 잡힌 행은 취소·철회·표시되지 않고 끝날 때까지 그대로 센다. 화면은 「점유 n 가 칸 수 m 를 넘습니다 … 초과」로 보인다.
- 장비 설정은 요청 행에 찍히지 않는다(행에는 정책 세대만). 저장이 "옛 세대" 행을 만들지 않으므로 `policy_changed`·`compatiblePredecessor`·DRAIN 이 없다.
- 예약 TTL·대기 TTL 은 정책 값이라 저장 중간에 바뀌어도 handle 이 무효가 되지 않는다.
- 장비 이름(= groupId)을 바꾸거나 나누는 것(`m3-mlx` → `m3-deepseek` + `m3-gptoss`)은 경로→장비 매핑 변경이라 **정책 개정 → DRAIN** 이다.
  순서: 이 화면에서 새 이름의 행을 먼저 만든다(정책에 없는 이름도 받는다) → 정책 적용.

## 화면

- **장비 목록** — 장비마다 출처(표 / 정책 대체 / 미설정)·칸 수·낮은 순위 평소 상한·유휴 판정·비워 둘 칸·엔진 실제·역할 순서·점유(예약+진행)/칸·우선 역할(바쁨/유휴)·
  낮은 순위 n/상한·「빌려 쓰는 중」·대기(우선 n)·판·마지막 저장. 장비 목록은 **장비 행 ∪ 현재 정책 경로의 groupId ∪ 실시간 상태**다.
  - **정책 대체(policy_fallback)**: 행이 없고 정책 `groupLimits` 에 값(`^[1-9][0-9]{0,2}$`, 1..256)이 있다 — 그 값으로 칸 수 = 낮은 순위 상한, 유휴 60초, 비워 둘 칸 0,
    순위 없음(= 우선순위가 없던 때와 같다). 0153 seed 가 이 규칙으로 행을 심는다; 저장하면 표가 기준이 된다. 꺼진 행(enabled=false)도 판정은 정책 대체로 떨어진다(「판정은 정책 대체」 표시).
    `pipeline-control capacity mode --to=open` 은 `device_row_missing:<id>` 로 경고한다(1b-C).
  - **미설정(unconfigured)**: 행도 `groupLimits` 도 없다 — 이 장비로 가는 요청은 `device_unconfigured` 로 보류된다(대기 행도 생기지 않는다). OPEN 전에 저장한다
    (OPEN 계획이 `device_unconfigured:<id>` 로 막는다).
- **장비별 설정** — 장비마다 폼 하나. 칸마다 지금 값·기본값·「바꿈」표시. 기본값은 칸 수 = 정책 `groupLimits`, 낮은 순위 상한 = 칸 수, 유휴 60초, 비워 둘 칸 0, 엔진 실제 없음.
  - 칸 수 1~256 · 낮은 순위 평소 상한 0~칸 수 · 유휴 판정 시간 0~3600초(초로 적는다, 저장은 ms) · 항상 비워 둘 칸 0~칸 수−1 · 엔진 실제 동시 처리 수(선택, 1~256, 적으면 칸 수 ≤ 이 값) · 메모 400자.
  - **역할 순서**: 경로마다 숫자 순위(1~64) 하나. 비우면 순위 없음. 정책에 없는 경로는 「추가 경로」줄에 id 와 순위를 적는다. 같은 경로 두 번은 거절.
  - 숨은 `expectedVersion` 으로 compare-and-set — 저장 사이에 다른 사람이 저장했으면 「다른 사람이 먼저 저장했습니다(지금 판 N)」로 거절한다. 새 장비(판 없음)는 CAS 없이 만든다.
  - 사용(enabled) 끄기·행 지우기는 PR 1 에 없다(열은 PR 2 용). 꺼진 행이 있으면 화면이 알린다.
- **새 장비** — 정책에 아직 없는 이름도 받는다(위 "나누기" 순서).
- **최근 저장** — `model-capacity-device-save` 최근 10줄(누가·장비·판·바뀐 값; 거절은 이유).

저장 거절 코드와 문장(`lib/operations/admin-capacity-devices.ts capacityDeviceIssueMessage`, 모르는 코드는 그대로 보인다):

| 코드 | 뜻 |
| --- | --- |
| `model_capacity_device_version_mismatch:<판\|none\|invalid>` | 다른 사람이 먼저 저장했다(`none` = 새 장비였는데 그 사이 생김). 새로고침 |
| `model_capacity_device_invalid:<path>` | zod 검사 실패. path 는 첫 issue 의 칸 — 교차 검사도 그 칸으로 온다: `secondaryCap`(상한 > 칸 수), `reserveSlots`(비워 둘 칸 ≥ 칸 수), `limitSlots`(칸 수 > 엔진 실제), `roles`(중복 경로·64개 초과), `roles.<n>.rank`, `root`(모양) |
| `site_fenced` | DR fence — 이 사이트는 쓰기가 막혀 있다 |
| `model_capacity_replay_unsupported` | 재생 DB 에서는 저장하지 않는다 |
| `model_capacity_control_missing` | 용량 제어 행이 없다 |
| `model_capacity_device_version_exhausted` | 판 번호 상한 — 운영자 확인 |

## 저장 경로

`saveCapacityDevice`(server action, `webWriteAction`) → `currentAdmin` → 폼 숫자 모양 검사(`capacityDeviceInputFromForm`) →
`saveAdminCapacityDevice` = `onPrimary(() => db.transaction(tx => saveModelCapacityDevice(tx, input, expectedVersion, admin.login)))` 한 번.
1b-A 의 저장이 그 TX 안에서 replay 거부 → DR fence SHARE → `model_capacity_control` FOR UPDATE(모든 입장과 직렬화) → zod → 장비 행 FOR UPDATE·CAS →
INSERT … ON CONFLICT DO UPDATE(version+1, enabled=true) → 역할 교체 → `operations_audit` 한 줄을 모두 한다. 화면은 돌아온 before/after 로 토스트의 "바뀐 값"을 만들고
`revalidatePath(/admin/models/devices, /admin/models/limits, /admin/models, /admin/status)` 한다.
한 저장이 한 트랜잭션이므로 입장 판정은 저장 전 또는 저장 후의 설정만 본다(섞인 설정을 보지 않는다).

## 운영 메모

- Oracle 번역 소비자는 입장 판정을 자기 DB 역할로 돌린다 — `model_capacity_devices`·`model_capacity_device_roles` **SELECT GRANT 를 OPEN 전에** 적용해야 한다
  (`deploy/oracle/least-privilege.sql`, WP-A). 없으면 Oracle 쪽 입장이 보류가 아니라 오류가 된다. 읽기 전용 monitor 역할도 상태 화면용 SELECT 가 필요하다.
- 이 화면은 정책 JSON 을 저장된 hash 로 검증해 경로·`groupLimits` 를 읽는다. hash 가 맞지 않으면 정책 장비를 보이지 않고 그 사실을 알린다(`pipeline-control status` 로 확인).
- rev13 적용 때 넣을 장비 값(소유자 확인 필요, pr1-plan §4.3): `supa` 4 / 상한 1 / crawl-agent-review 1, product-search-verify 2, crawl-tagline 3 · `gpu3090-qwen` 4 / 상한 2 /
  second-review 1, local-screen 2, local-held-qwen 3, local-audit 4 · `m3-deepseek` 1 / 상한 0 / local-human-deepseek 1, local-deepseek-confirm 2 · `m3-gptoss` 2 / 상한 2 ·
  `m1-qwen` 2 / 상한 1 / product-translate 1, reason-translate 2 · `anthropic-cli` 2, `openai-cli` 2.

## 테스트

- `tests/admin-capacity-devices.test.tsx` — 화면 모형(행 ∪ 정책 ∪ 상태, 기본값, 역할 순서, 문제 줄, 감사 줄), 폼 → 저장 입력, 거절 문장, server action, 그리기, 메뉴.
- `tests/integration/admin-capacity-devices.test.ts` — action → 저장(감사 한 줄) → 화면 모형; CAS 거절(감사 없음); 검사 거절; 비관리자; 정책 밖 장비 이름.
  1b-A 의 저장소가 트리에 있으면 진짜 표(0153)로 돌고, 없으면 같은 계약의 메모리 구현(`setCapacityDeviceRepositoryForTest`)으로 돈다.
- `tests/dr-web-fence.test.ts` — 장비 저장 action 이 쓰기 관문을 지난다(수 91).
- 표·입장 판정·seed·GRANT 는 1b-A 의 `tests/capacity-devices.test.ts`·`tests/integration/capacity-devices.test.ts` 가 본다.
