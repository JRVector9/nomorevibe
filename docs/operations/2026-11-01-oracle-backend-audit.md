# Oracle·백엔드 신뢰성 소스 감사 — 2026-11-01

기준은 main `f70901181e89e95e4e4a9d916b27f8a6d22a6e32`이다. 이 문서는 소스 검토·패치 범위이며 운영 설치·드릴 완료 영수증이 아니다. 사용자의 지시대로 로컬 테스트·lint·typecheck·build·컴파일러는 실행하지 않았다. SSH·운영 DB·서비스·외부 API에도 이 작업 스트림에서 접근하지 않았다. 필수 GitHub `check`는 유지한다.

## 수정한 결함

1. monitor heartbeat가 신선하고 `overall=ok`지만 Docker health가 나쁘면 gateway가 `ok=false, reason=ok`를 내보냈다. Oracle aggregate DOWN은 가능해도 notifier가 서비스 장애 사유로 분류하지 않아 관리자 알림이 없었다. 이제 `container_unhealthy`를 낸다. heartbeat 자체의 pipeline 장애가 있으면 기존 `pipeline_alarm`을 유지한다. 이 사유에 재시작 권한을 추가하지 않았다.
2. 두 replica 중 하나만 모델 장부 `review` 요약을 보고하면 `merge_capacity_unknowns([review], complete=False)`가 `alarmReasons=[]`를 포함한 요약을 냈다. notifier는 이를 명시적 정상으로 읽어 기존 장부 장애를 600초 뒤 해제할 수 있었다. 이제 replica 누락·읽기 실패가 있으면 canonical `unknown`을 내보낸다. Oracle은 기존에 확인한 검토/경보를 상태에 보존하고, 이번 읽기 실패는 경보로 다룬다. 완전한 `review`는 계속 정보일 뿐이다.
3. Docker gateway·Oracle의 복구 이력 검증은 음수 Unix 시각을 거절하지 않았다. 이 손상 값을 24시간보다 오래된 이력으로 버리면 새 복구 예산이 열렸다. native gateway와 같이 음수도 거절한다. 기존 유효한 이력·reservation·once marker는 변경하지 않는다.
4. 기존 Oracle은 AI1/AI2와 text 공급자 사유 외에는 aggregate `pipeline_alarm`만 받았다. aggregate가 이미 DOWN이면 이후 생긴 수집·승인·번역·scheduler·역할 장애가 새 관리자 알림을 만들지 못했다. 선택 필드 `stageFailures`로 이 누락을 보완했다.

## `stageFailures` 계약

heartbeat → forced gateway → Oracle → notifier로 다음 목록만 전달한다.

```json
{"stageFailures":[{"stage":"fetch","reason":"no_progress"}]}
```

각 원소는 정확히 `stage, reason` 두 키이며 stage는 중복할 수 없다. 최대 21개다.

| stage | 허용 reason |
| --- | --- |
| `fetch`, `judge`, `publish`, `evidence`, `agent-evidence`, `ai-level`, `uptime`, `reason-translate`, `crawl-tagline`, `keywords`, `keyword-verify`, `product-translate`, `tagline-ko`, `intro-check` | `no_progress`, `worker_missing`, `consumer_missing`, `upstream_stalled` |
| `scheduler` | `scheduler_missed`, `worker_missing` |
| `role-scheduler`, `role-crawler`, `role-reviewer`, `role-publisher`, `role-maintenance`, `role-text` | `worker_missing`, `restart_loop` |

생산자는 기존 progress 보고서의 명시적 `alarm=true`만 싣고 `held=true`는 제외한다. 다른 장애 때문에 overall이 alarm이어도 한 단계가 `unknown_age`, scheduler가 `unknown_schedule`, 공급된 수치가 유한한 비음수가 아니거나 고정 stage/reason/liveness를 검증할 수 없으면 필드 전체를 생략한다. 이를 빈 목록으로 바꿔 이전 장애를 해제하지 않는다. AI1/AI2는 기존 `reviewFailures`가 계속 담당한다. text `upstream_stalled`가 이미 `providerFailures`에 있으면 이 새 경로에서 제외해 기존 30분 관측과 알림 시점을 바꾸지 않는다. 기존 공급자 필드로 표현할 수 없는 text upstream 장애는 새 경로로 전달한다.

gateway는 **모든 replica의 heartbeat가 신선하고 모든 새 필드가 유효**할 때만 합친다. 서로 같은 stage에 다른 reason을 보고하거나, 구버전·누락·잘못된 필드가 있으면 새 필드를 생략한다. 명시적 빈 목록은 모든 replica가 그 stage 장애를 관측하지 않았다는 뜻이다.

Oracle은 같은 stage/reason을 150초 이내 간격으로 두 번 새로 관측해야 장애 이벤트를 만든다. 새 필드 누락·호스트 관측 실패는 이 새 경로의 연속 카운터를 끊는다. 사유 변경·시각 역행·150초 초과 간격도 두 표본을 다시 요구한다. 없는 시간을 실패나 정상으로 계산하지 않는다.

notifier의 영속 서명은 `<host>/<service>/progress-<stage>/<reason>`이다. 관리 메시지는 `progress-`를 빼고 stage를 표시한다. 새 stage 장애는 기존 aggregate DOWN과 독립해 알린다. 수신 API ACK를 받은 서명은 observer 재시작 뒤에도 다시 보내지 않는다. 명시적 빈 목록·현재 목록에서 빠진 사유만 이 namespace의 장애를 해제한다. 새 필드 누락·불완전 관측은 기존 장애와 ACK를 보존한다. 기존 provider·review·capacity·서비스 장애 서명은 그대로 둔다.

이 필드는 관측·알림 전용이다. 모델 요청 ID·모델명·프롬프트·본문·토큰·DB 자격·임의 오류를 전달하지 않는다. Oracle의 `recover` allowlist, gateway service allowlist, version CAS, replica 의도, cooldown, 일일 상한과 배포 중 거절은 그대로 유지한다. `indeterminate`는 소유자의 2026-10-30 결정대로 슬롯 점유가 아니며 사람 검토 목록이다.

## 요구사항별 현재 범위

| 요구사항 | 소스에서 확인한 경로 | 한계·운영 확인 |
| --- | --- | --- |
| 웹 프로세스 장애·페이지 실패 | Swarm restart policy, readiness와 홈페이지 직접 probe, 같은 spec/version CAS 복구 | 최신 릴리스 실제 드릴·HTTP 복귀·알림 영수증 필요 |
| monitor 종료·정체 | Docker/systemd + 오래된 heartbeat만 제한 복구; 이번 수정은 health 장애의 알림 보완 | fresh pipeline alarm을 monitor 재시작으로 바꾸지 않음 |
| frontier 수집·근거 단계 | progress의 `fetch/evidence/agent-evidence/ai-level` → 새 stage별 관측·알림 | 실제 근거 소비자의 진척·장애와 복구 확인 필요 |
| AI1·AI2 | 기존 `reviewFailures`, 독립 consumer 관측, 역할/consumer supervisor | capacity·upstream은 재시작으로 점유를 풀지 않음 |
| 승인·게시 | progress의 `judge/publish` → 새 stage별 관측·알림 | `judge`는 실제 코드 단계명이며 사람 승인 정책을 대체하지 않음 |
| 한국어·소개 검수 | 7개 text/intro queue, 기존 공급자 관측 + 새 개별 정체 관측 | hold·retry·시도 소진 등 정규 정책 유지 |
| scheduler·역할 상실·반복 재시작 | progress의 scheduler/liveness → 새 고정 stage 관측·알림 | safe 복구는 기존 fenced role/worker supervisor와 Swarm이 소유 |
| source discovery 검색·cursor 정체 | `readDiscoveryProgress`는 존재하지만 `readMonitorStatus` 입력이 아님 | 프로세스가 건강한데 신규 검색·cursor가 진행하지 않는 장애는 이 패치의 관측 범위 밖이다. 별도 discovery 신호를 연결해야 전체 수집 감시를 주장할 수 있다 |
| 외부 공급자·DB 장애 | readiness·progress·capacity unknown 경보 | 자격 오류·외부 장애를 무제한 재시작/공유 모델 종료로 대체하지 않음 |
| Oracle 자체 장애·수신기 장애 | systemd Restart, 독립 heartbeat Push, 수신기별 ACK·알림 | 운영 host/receiver 독립성 및 실제 관리자 수신은 별도 영수증 필요 |

역할 progress check는 legacy batch의 primary candidate에만 있고, active standby는 runtime lane supervisor에 의존한다(`scripts/role-worker.ts`). 전체 자동복구를 주장하려면 standby active·독립 consumer·host failover의 실제 복구도 따로 확인해야 한다.

## 검증 상태와 부정 경로

실행한 것은 파일 읽기·`rg`·`git diff`를 통한 수동 소스 검토뿐이다. 테스트 코드를 추가했지만 실행 결과는 없다. GitHub CI의 기존 `test_recovery*.py`, `test_oracle_watchdog*.py`, unit job이 해당 회귀를 실행하도록 변경 범위를 유지했다. 필요한 CI 범위는 다음과 같다. 아래 명령도 이번 로컬 작업에서는 실행하지 않았다.

```sh
python3 -B -m unittest discover -s tests -p 'test_recovery*.py'
python3 -B -m unittest discover -s tests -p 'test_oracle_watchdog*.py'
npx vitest run tests/monitor-heartbeat.test.ts tests/model-capacity-unknowns.test.ts
```

추가한 회귀는 unhealthy monitor의 명시적 사유·알림, 부분 장부 읽기로 기존 경보를 해제하지 않음, 손상/음수 복구 이력, aggregate DOWN 중 새 stage 알림, 재시작 뒤 ACK 유지, 누락된 필드/호스트/150초 간격/시각 역행의 카운터 초기화, 명시적 빈 목록의 namespace별 해제, 허용 목록·중복·비밀 필드 거절, 구 heartbeat 수용, replica 일부 구버전·불일치·stale 관측을 다룬다.

## 적용 순서와 남은 일

1. 필수 GitHub CI에서 변경 회귀·정적 검사를 확인한다. 아직 통과했다고 기록하지 않는다.
2. Oracle의 `oracle_watchdog.py`, `incident_notifications.py`, 함께 설치된 `recovery_gateway.py`를 하나의 관리된 소스 갱신으로 먼저 설치한다. 기존 state/config/key/known_hosts/lock·알림 ACK·복구 예약을 보존한다.
3. M3/mini의 forced SSH gateway를 갱신한다. 구 Oracle은 새 선택 필드를 거절하므로 이 순서를 바꾸지 않는다. gateway만 먼저 갱신해도 구 monitor는 계속 관측할 수 있다.
4. monitor 이미지를 정규 배포 경로로 갱신한다. 새 monitor + 구 gateway는 새 필드를 생략하며 기존 알림은 유지된다.
5. 읽기 전용 운영 관측에서 소스 hash·서비스 상태·새 필드·고정 inventory·heartbeat 신선도·양 receiver ACK·알림 API ACK를 대조한다. aggregate DOWN 중 새 개별 stage 장애가 별도 알림을 만드는지 확인한다.
6. 운영 데이터/의도/복구 예산을 보존하는 격리 드릴에서 누락·구버전·모순 replica, 음수 이력, 알림 ACK 유실, 제한 복구의 version 변경·배포 중 거절·일일 상한을 확인한다. 불명확한 mutation은 재요청하지 않는다.
7. discovery-specific 정체 관측, active standby·host 장애·외부 공급자 복구의 남은 범위는 통합 담당자가 이어간다. 최종 `docs/CODEX_HANDOFF.md`는 통합 담당자가 갱신한다.

파일 검토용 다음 명령:

```sh
git -C /Users/jr/Desktop/projects/nomorevibe-reliability-oracle-20261101 status --short
git -C /Users/jr/Desktop/projects/nomorevibe-reliability-oracle-20261101 diff -- scripts/ops scripts/watch-failover-readiness.ts tests
```
