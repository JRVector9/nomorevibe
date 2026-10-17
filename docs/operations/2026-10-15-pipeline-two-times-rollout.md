# 수집·검수 처리량 2배 — 판정·운영 관측·장애 drill 보고서 (골격)

상태: **측정 전 골격.** 아래 수치 칸은 모두 비어 있다. 각 칸은 어느 도구의 어느 artifact 필드에서 오는지 적어 두었다.
설계: [2배 설계 §7·§6.2](../superpowers/specs/2026-10-15-pipeline-two-times-design.md). 설계 완료·구현 완료·배포 완료·2배 실측 성공을 서로 구분해 적는다.

| 단계 | 상태 | 근거(artifact 경로·sha256) |
| --- | --- | --- |
| 격리 2배 판정(고정 입력 replay) | 측정 전 | |
| 운영 30분 canary | 측정 전 | |
| 운영 24시간 관측 | 측정 전 | |
| DR drill | 측정 전 | |

도구(모두 읽기 전용, 쓰기 0은 `tests/integration/pipeline-rollout-report.test.ts`가 전후 DB digest로 확인한다):

- `scripts/pipeline-replay-fixed-input.ts export|preflight|run|report|compare|label` — 격리 replay와 2배 판정(PR01).
- `scripts/pipeline-capacity-live.ts collect|report|compare|label` — 운영 30분 이상 구간의 같은 판정 규칙(PR01).
- `scripts/pipeline-rollout-report.ts snapshot|observe|dr-drill|report` — 운영 관측·슬롯 적분·DR RPO/RTO(PR17a).
  DB는 `PIPELINE_REPORT_DATABASE_URL` 하나만 쓴다. exit 0 정상, 1 오류(고정 code), 3 `report`에서 안전 위반 검증됨.

## 1. 2배 판정 결과

출처: `pipeline-replay-fixed-input.ts compare BASELINE CANDIDATE` 출력(`judgeLiveCapacity`와 같은 규칙).
기준 SHA·후보 SHA·입력 artifact sha256·포함 입력 수를 함께 적는다. `status`가 `passed`일 때만 2배 성공으로 적는다.

| 항목 | 출처 필드 | 기준(legacy) | 후보(items) | 판정 |
| --- | --- | --- | --- | --- |
| 최종 고유 완료(신규) | `baseline/candidate.finals.newCandidates` | | | |
| 시간당 최종 | `*.finalPerHour` | | | |
| 배율(≥2.0) | `ratio`, `numericThresholds.doubled` | | | |
| p95 종단 지연(악화 없음) | `*.latencyMs.endToEnd.p95`, `numericThresholds.latencyNotWorse` | | | |
| 기술 실패율(≤기준+1%p) | `*.calls.technicalFailureRate`, `numericThresholds.technicalFailureWithinOnePoint` | | | |
| 종합 | `status`, `reasons` | | | |

## 2. 품질 표본

출처: `compare` 출력의 `labelTemplate`로 표본을 뽑고, 사람 라벨을 `label RESULT LABELS OUTPUT`으로 붙인 뒤 다시 `compare`.
표본 크기·라벨러·선정 방식은 사용자 결정이다(미정).

| 항목 | 출처 필드 | 기준 | 후보 |
| --- | --- | --- | --- |
| 표본 hash | `*.quality.datasetHash` | | |
| 평가 수 / 기대 수 | `*.quality.evaluated` / `expected` | | |
| 잘못 승인 | `*.quality.wrongApprovals` | | |
| 잘못 거절 | `*.quality.wrongRejections` | | |
| 판정 | `quality` | | |

## 3. Budget(호출·토큰 상한)

출처: `compare` 출력의 `budgetEvidence`. 현재 코드에서는 항상 `unverified`라 종합 판정이 `incomplete`에 머문다
(PR01b-9 lane에서 "budget verified" 정의·생성기를 다루는 중). 정의 또는 합격 기준에서 뺄지는 사용자 결정이다.

| 항목 | 출처 | 값 |
| --- | --- | --- |
| budget 증거 | `budgetEvidence` | |
| replay 호출 수·거절 | `*.replay.meter` | |
| AI1 입력·출력 토큰 | `*.calls.ai1InputTokens` / `ai1OutputTokens` | |

## 4. 안전 지표

격리 판정은 `compare`의 `safety`, 운영 관측은 `pipeline-rollout-report.ts report`의 `safety`·`violations`에서 온다.
0097 증거 장부의 기록 시작 marker가 구간 시작보다 앞서야 사람 결정 덮음·lease 위반이 `verified`가 된다. 아니면 `unverified`다.

| 항목 | 격리 replay | 30분 canary | 24시간 |
| --- | --- | --- | --- |
| 중복 발행(0건) | | | |
| 사람 결정 덮음(0건) | | | |
| lease 위반(0건) | | | |
| 필수 심사 누락(0건) | | | |
| 0097 장부 상태(`ledger.status`) | | | |

## 5. 운영 30분 canary·24시간 관측

순서(운영자 실행, 읽기 전용):

1. 구간 시작 **전**: `pipeline-rollout-report.ts snapshot --output=BASE.json`. 이 스냅숏이 없거나 구간 시작보다 늦으면 역할 인계·epoch·잡 실행 수는 `unverified`로 남는다(이력 표가 없어 두 시점 카운터 차이로만 증명한다).
2. 구간이 끝난 뒤: `observe --run=ID --end=끝시각(UTC ms ISO) --hours=0.5|24 --baseline=BASE.json --output=OBS.json`.
3. `report --artifact=OBS.json`(사람용), `--json`(기계용). exit 3이면 안전 위반이 검증된 것이다.

| 항목 | 출처 필드(`report --json`) | 30분 canary | 24시간 |
| --- | --- | --- | --- |
| 인계 근거 구간 | `coverage` | | |
| 역할별 인계(epoch 증가·소유자 변경) | `roles[].handoff` | | |
| 역할별 잡 성공·실행 수 | `roles[].jobs[]` | | |
| 역할별 마지막 ACK가 구간 안 | `roles[].acks[]` | | |
| 역할별 실처리 행(하한) | `roles[].readback[]` | | |
| 제어 epoch 변화(stage·모델·batch·writer fence) | `controls` | | |
| AI1 기술 실패율 | `stageFailures[ai1]` | | |
| AI2 기술 실패율(0097 필요) | `stageFailures[ai2]` | | |
| 모델 route별 indeterminate 비율 | `stageFailures[model:*]`, `modelLedger.routes` | | |
| 수집 시 열린 dispatch·indeterminate | `modelLedger.openAtCollection` | | |
| 빈 슬롯 대기(준비 대기 있는데 슬롯 빔) | `slots.all/scopes[].freeWhileWaitingMs` | | |
| 포화 대기(슬롯 가득 차 대기) | `slots.all/scopes[].fullWhileWaitingMs` | | |
| 한도 미상 대기 | `slots.*.unknownWhileWaitingMs` | | |
| 미검증·주의 | `evidenceIssues` | | |
| 유입 충분성·입력 분포(§7.5) | 별도 기록 필요(이 도구 범위 밖) | | |

슬롯 적분 정의(보수적): 준비 대기 = 모델 장부의 `waiting` 요청이다. 그 시각 전역·provider budget·group·pool 점유가 모두 한도 미만이면
"빈 슬롯 대기", 하나라도 한도에 닿았으면 "포화 대기", 요청의 정책 hash가 현재 정책과 다르면 "한도 미상"이다. route/class 안의 대기 중
하나라도 빈 슬롯이면 빈 슬롯으로 센다. 대기는 `queue_until`, 보내지 않은 예약은 `reserved_until`에서 끝난 것으로 본다.
장부에 들어오지 않은 파이프라인 대기(준비됐지만 슬롯을 요청하지 않은 항목)는 이 적분에 없다.

24시간 합격 기준(사용자 결정, 미정):

| 기준 | 값 |
| --- | --- |
| 안전 위반 | 0건(설계 §7 즉시 중단 조건) |
| AI1·AI2 기술 실패율 상한 | |
| indeterminate 비율 상한 | |
| 포화 대기 비율 상한(증설 중단 기준) | |
| 역할 인계 허용 횟수 | |
| 필수 `verified` 칸 | |

## 6. DR drill

출처: 승격된(또는 seal된) 복원 DB에서 `dr-drill --promotion=UUID --failure-at=장애주입시각 --output=DRILL.json`, 이어서 `report`.
시각은 기존 DR 증거만 쓰고, 없으면 `unknown(사유)`로 남긴다. 장애 시각은 DB 장부에 칸이 없어 drill 운영자가 선언한 값(`operator_declared`)이다.

| 장애 범위(설계 §6.2) | 마지막 복제 확정(`times.snapshotAt`) | 장애(`times.failureAt`) | RPO(`rpoMs`) | 옛 writer 쓰기 창(`writeWindowMs`) | RTO 승격(`rtoPromotionMs`) | RTO 첫 잡 성공 상한(`rtoFirstJobSuccessAtMostMs`) | unknown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M3만 중단 | | | | | | | |
| M3·mini 중단 | | | | | | | |
| 기존 DB까지 중단 | | | | | | | |
| M3 종속 모델까지 중단 | | | | | | | |

정의: RPO = 장애 − 마지막 복제 확정(장애가 더 이르면 0과 `snapshot_after_failure`). 옛 writer 쓰기 창 = 계획·seal 장부의 모든 instance의
`writer_process_stopped` 최댓값 − 마지막 복제 확정(승격 G5 정산 창과 같은 정의). RTO = `promoted_at` − 장애. 첫 잡 성공은 승격 뒤
`jobs.last_success_at` 최솟값이라 실제 첫 성공보다 늦거나 같다(상한).

## 7. 롤백 절차

설계 §7의 중단 조건: lease 위반·사람 결정 덮음·이중 발행은 즉시 중단. 오류율 증가·p95 2배·quota 429 반복·DB pool 대기 증가가
지속되면 consumer 증설을 되돌리고 신규 유입부터 줄인다. 모델 포화가 남으면 추가 worker 배포를 멈춘다.

| 단계 | 방법 | 확인(readback) | 실행 기록 |
| --- | --- | --- | --- |
| 1. 신규 유입 축소 | 기존 발굴 중단 설정 유지·복귀 | | |
| 2. consumer 증설 되돌림 | `PIPELINE_BACKGROUND_CONSUMER_*`·AI1/AI2 consumer 앱 중지 | | |
| 3. stage mode items→draining→legacy | 운영 제어 CLI 미구현(인벤토리 7a) — 도구 준비 전 칸 비움 | | |
| 4. model capacity open→draining/disabled | 운영 제어 CLI 미구현(인벤토리 7b) | | |
| 5. job batch versioned→legacy | 운영 제어 CLI 미구현(인벤토리 8c), 전체 정지 필요 | | |
| 6. 고정 SHA 재배포 | 배포 helper(`scripts/ops/deploy_shared_images.py`)·예비 먼저 | | |
| 7. 롤백 뒤 관측 | `snapshot` → `observe --hours=0.5` → `report` | | |

## 8. 미결 결정

- "budget verified" 정의, 또는 합격 기준에서 budget 제외 여부.
- 품질 표본 크기·라벨러.
- 24시간 합격 기준 수치(5절 표).
- 슬롯 적분에서 장부 밖 파이프라인 대기까지 셀지(현재 정의는 장부 `waiting`만).
- DR drill 장애 시각을 DB 장부에 남길지(지금은 운영자 선언값).
