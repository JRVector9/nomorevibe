결론: 관리 화면(`/admin/status` → 작업 상세 → 「이 작업 멈춤」)의 정식 job-pause는 코드상 monitor_gate에 이미 반영됩니다(멈춘 잡의 단계는 `paused`, 경보 없음). 그래서 gate는 고치지 않았고, 회귀 시험 10건만 추가했습니다. 배포 직전에 멈출 잡은 `product-translate`·`product-tagline-ko`·`crawl-tagline`·`product-search-profile` 4개이고, 경보가 있을 때만 `reason-translate`·`product-search-verify`·`product-intro-check`를 더합니다. 다만 job-pause로는 `run`의 **별도 관문** `model_replacement_gate`(DRAINING + 활성·미확인 0건)를 지날 수 없습니다. 미확인 2건(M1 `29877f65`, Supa `65f8c399`)을 단건 복구로 먼저 해제해야 모델 보유 앱을 교체할 수 있습니다.

작성: 2026-10-29, 브랜치 `xaegis/4cefcc24`, 기준 `origin/main` 75b8aa31. 이 문서는 코드 읽기와 로컬 단위 시험의 결과입니다. 운영 DB·장비·배포는 실행하지 않았고, 아래 SQL·명령도 모두 **미실행**입니다. 운영 숫자(미확인 2건, crawl-tagline 15:55 이후 settled 0, product-translate 10-28 16:01부터 번역 0)는 작업 입력으로 받은 값이며, 이 작업에서 실측한 것이 아닙니다.

## 1. monitor_gate가 실행되는 곳과 판정 조건 (코드 확정)

| 호출 위치 | strict(주가 lease를 쥔 `ready`여야 하는 역할) | 실패 시 |
|---|---|---|
| `plan` 사전 검사 `scripts/ops/deploy_release.py:243` | 없음(`strict=()`) | plan 생성 중단 |
| `run` 첫 변경 전 `deploy_release.py:443` | 없음 | 서비스 변경 0, execution 디렉터리 소모 |
| `run` 역할 묶음 뒤 `('gate', 역할들)` `deploy_release.py:476` | 그 묶음의 역할 | 다음 묶음 중단 |
| `run` 마지막 `deploy_release.py:484` | 실제 배포된 `<역할>-m3` | `deployed-and-verified` 기록 안 함 |
| 배포 뒤 관측 5·10·15분·6시간 `scripts/ops/release_observer.py:302` | 없음 | `observer_monitor_not_ready` |

판정 함수는 `gate_verdict` (`scripts/ops/deploy_shared_images.py:1000`), 반복 주기는 `monitor_gate` (`:1027`, 3초 간격, 기본 120초·병렬 묶음 180초)입니다. 검사는 crawler-m3 컨테이너 안에서 `scripts/check-failover-readiness.ts`와 `scripts/check-worker-progress.ts`를 실행해 이루어집니다(`REMOTE_MONITOR`, `:633`). 통과하려면 아래 네 조건이 **모두** 참이어야 합니다.

1. failover readiness의 모든 역할(publisher·reviewer·crawler·text·maintenance)이 보고되어야 합니다(`<역할>=missing`이면 차단). strict 역할은 `ready`, 나머지는 `ready` 또는 `standby_active`(`VALID_HOLDER_REASONS`, `:994`)여야 합니다.
2. readiness의 `scheduler.reason == 'ready'`(scheduler 두 복제본).
3. **worker progress의 `overall == 'ok'`**. `unknown`도 차단합니다. 차단 메시지에는 `progress=alarm`만 나오고 **어느 단계인지는 나오지 않습니다**. 단계는 아래 R1 명령으로 확인합니다.
4. 관문은 `check-failover-readiness.ts` 결과에서 `.readiness`만 읽습니다. 같은 스크립트가 보고하는 미확인 요청 경보(`capacityUnknowns`, `lib/operations/failover-monitor.ts`)는 monitor_gate 판정에 **들어가지 않습니다**.

`overall` 계산은 `lib/operations/worker-progress-query.ts:176`에 있습니다.

- `alarm`이 되는 경우는 다음 넷 중 하나입니다.
  - **생존**: 역할의 서비스 관측이 45초 넘게 없음(`worker_missing`), 또는 5분에 3회 이상 재시작(`restart_loop`) — `worker-progress.ts:133`.
  - **단계**: reason이 `no_progress`·`worker_missing`·`upstream_stalled`·`consumer_missing` 중 하나 — `worker-progress.ts:125`, `worker-progress-query.ts:127`.
  - **lane**: `lane_poll_timeout`·`job_timeout`·`lane_progress_timeout` — `worker-progress.ts:59`.
  - **scheduler**: `scheduler_missed`(주기의 2배 넘게 예약이 밀림) 또는 `worker_missing` — `worker-progress.ts:140`.
- `unknown`은 어떤 단계가 `unknown_age`이거나 scheduler가 `unknown_schedule`일 때입니다.

단계 판정(`classifyStage`, `worker-progress.ts:102`)은 위에서부터 순서대로 적용합니다.

1. `paused`: `enabled=false`이거나, 잡의 `not_before`가 지금부터 365일 넘게 뒤(`isPausedJob`, `lib/jobs/status.ts:10`).
2. `no_work`: 대기 0, 미룸 0.
3. `progressing`: **최근 5분 완료 > 0**.
4. `upstream_stalled`(경보): 최장 대기(공급자 오류가 있으면 오류 지속 시간) 30분 이상이고 오류 > 0. 오류 수는 과거 실패 수·5분 실패 수 중 큰 값에, 잡 `last_error`가 있으면 1을 더한 값입니다.
5. `backoff`: 잡 `not_before`가 미래인 경우, 의도적 보류(held)인 경우, 미룸만 남은 경우.
6. `upstream_or_job_error`: 오류는 있으나 위 조건에 해당하지 않음.
7. `warming_up`: 최장 대기가 text 단계 10분, judge 15분, 그 밖 5분 미만.
8. 나머지는 `no_progress`(워커가 살아 있을 때) 또는 `worker_missing`.

전역 모델 접수가 `draining`이면 first·second와 text 7단계가 held가 됩니다. 이때 `upstream_stalled`도 **5분 내 새 실패 0이고 잡 `last_error`가 비었을 때만** `backoff`로 내려갑니다(`worker-progress-query.ts:98`, `:117`).

**monitor_gate가 아닌 별도 관문**도 `run`을 막습니다.

- `model_replacement_gate`(`deploy_release.py:335`, 호출은 `:448`·`:471`)는 교체 대상에 web·reviewer·publisher·text·maintenance가 하나라도 있으면 세 가지를 요구합니다: 주 DB, `model_capacity_control.mode='draining'`, `dispatched`·`indeterminate`·유효한 `reserved`가 **0건**.
- 미확인 2건이 `indeterminate`로 남아 있으면 이 관문은 job-pause와 관계없이 `model_replacement_requires_explicit_drain_and_zero_active_calls`로 멈춥니다. 서비스 변경은 0이지만 execution 디렉터리가 소모되므로 새 plan이 필요합니다.
- 앱의 모델 이름 고정 문제는 공통 lib 변경이라 전체 18앱 배포 대상이 되고, 모델 보유 앱이 반드시 포함됩니다.

## 2. job-pause가 gate 판정에서 어떻게 처리되는가 (코드 확인 결과)

- **멈춤 처리**: `controlAdminJob`(`lib/operations/admin-job-control.ts:16`)이 잡 행을 잠근 뒤 `not_before`를 지금+100년으로 바꿉니다(`:35`). 같은 트랜잭션에서 `operations_audit`에 `action='job-pause'`, `target=<잡>`, `detail={reason, beforeNotBefore, afterNotBefore, previousControlVersion, inFlight, requestedVersion, processedVersion}`를 기록합니다(`:43`). 이 표는 DB 트리거가 수정·삭제를 거부합니다(마이그레이션 0056).
- **gate 판정**: 단계 판정은 `jobs` 행을 이름으로 찾습니다(`jobForStage`, `worker-progress-query.ts:31`). 단계 → 잡 대응은 `TEXT_PROGRESS_STAGE_JOBS`에 있습니다. 위 1번 규칙이 가장 먼저 적용되므로 대기·과거 실패·`last_error`가 있어도 `paused`, `alarm=false`, 재시작 대상 아님이 됩니다. 그 단계의 경보만 사라지고 다른 단계의 경보는 그대로 남습니다.
- **lane**: 멈춘 잡은 `pendingJobNames`의 `not_before <= now()` 조건(`lib/jobs/control.ts:78`)에서 빠집니다. lane은 매 poll마다 `polling`→`idle`로 보고합니다(`scripts/worker.ts:182`, `:226`). 그래서 `lane_progress_timeout`이 생기지 않습니다.
- **scheduler**: `requestDueJobs`는 멈춘 잡의 `next_scheduled_at`도 계속 다음 주기로 넘깁니다(`lib/jobs/control.ts:50`). 그래서 `scheduler_missed`가 생기지 않습니다.
- **결론**: 정식 pause를 했는데 그 단계가 계속 경보를 내는 버그는 없습니다. gate 코드는 바꾸지 않았고 면제도 추가하지 않았습니다. 이 계약을 고정하는 회귀 시험만 추가했습니다(5절).
- **제약 ①**: job-pause는 `job_batch_control.mode='legacy'`일 때만 가능합니다(`admin-job-control.ts:25`). versioned·draining에서는 화면에 「이 작업 배치에서는 개별 멈춤을 지원하지 않습니다」가 뜨고 아무것도 바뀌지 않습니다. 그 경우 정식 대안은 `pipeline-control capacity mode --to=draining`입니다. 이것으로 text·AI1·AI2 단계가 held가 되지만, **잡 `last_error`가 남은 단계나 5분 내 새 실패가 있는 단계는 여전히 경보**합니다. 그런 단계가 있으면 배포를 멈추고 원인을 해결합니다(면제 금지).
- **제약 ②**: pause는 다음 실행부터 적용됩니다. 진행 중인 틱은 끝까지 갑니다. 이미 `indeterminate`인 모델 요청은 해제되지 **않습니다**.
- **제약 ③**: `crawl-agent-review`(first 단계)는 pause 대상에서 뺐습니다. AI1이 items 모드면 독립 consumer가 계속 일하는데도 그 단계가 `paused`로 표시되어 실제 정체를 가리게 됩니다. first·second는 위 DRAINING에서 held로 처리됩니다.

## 3. 단계별 표

확인 SQL은 7절 S0~S7을 참조합니다. 모든 단계의 최종 근거는 R1(관문이 읽는 것과 같은 출력)입니다.

| 단계(관문 이름) | 잡 / 역할 | 코드로 추적한 원인 | 확인 SQL | pause 필요 |
|---|---|---|---|---|
| product-translate | `product-translate` / text (lane `product-translation`) | 경로 `product-translate`는 M1 `m1:translation` Gemma 항목을 씁니다(`lib/llm/model-registry.ts:82`, 동시성 1). 미확인 `29877f65`가 같은 그룹·공급자 한도를 점유하면 새 요청을 받지 못합니다. relay 메모리의 indeterminate는 파일 정리만으로 풀리지 않습니다(2026-10-28 복구 문서). 앱의 모델 이름이 정책 경로의 model과 다르면 `unmapped` 미룸이 납니다. | S1·S2·S3·S4·S5·S6 | **예** |
| tagline-ko | `product-tagline-ko` / text (lane `korean-translation`) | 공통 text 풀·정책 경로. 미확인 1건이라도 `old_policy=true`이면 모든 신규 접수가 `policy_changed`로 거절됩니다(`capacity-admission-block.ts`의 `oldActive`). 모델 이름 불일치면 `unmapped`. | S2·S3(old_policy)·S4·S5·S6 | **예** |
| crawl-tagline | `crawl-tagline` / text | `writeCrawlTaglineWithModelCapacity`(용량 장부)를 거칩니다(`lib/crawl/jobs/tagline.ts:94`). 정책상 Supa 그룹이면 `65f8c399`(crawl-agent-review)가 그 그룹 한도를 점유합니다. 그룹 이름·한도는 S4로 확인합니다. | S2·S3·S4·S5·S6 | **예** |
| keywords | `product-search-profile` / text | open일 때 정책 경로의 model과 `scopedModel`이 다르면 `unmapped`(`lib/domain/products/search-profiles.ts:353`). 이 모델 이름 고정은 배포로만 고쳐집니다. 그룹 점유는 S4로 봅니다. | S2·S4·S5·S6 | **예** |
| reason-translate | `reason-translate` / text | product-translate와 같은 M1 translation 항목을 씁니다(같은 registry purposes). | S2·S4·S5·S6 | R1에서 경보일 때만 |
| keyword-verify | `product-search-verify` / text | `assertTextModelAdmission` 경로(`lib/domain/products/search-verify.ts:167`): open에서 `provider_contract_unavailable` 또는 `unmapped`로 미룸. | S2·S6 | R1에서 경보일 때만 |
| intro-check | `product-intro-check` / reviewer | claude-cli 경로. 위의 미확인 2건과 직접 묶이지 않습니다. | S1·S2 | R1에서 경보일 때만 |
| first | `crawl-agent-review` / reviewer·ai1 consumer | 미확인 `65f8c399`. 이전 정책 점유면 정책 범위 보호로 재시작만 꺼지고 경보는 유지됩니다. | S0·S3·S4 | **아니오**. DRAINING의 held로 처리하고, 그래도 경보면 배포 중단 |
| second | `second-review` / ai2 | DRAINING에서 held | S0·S3 | 아니오 |
| fetch·judge·publish·evidence·agent-evidence·ai-level·uptime | 각 잡 | 이번 모델 점유와 무관합니다. 경보면 별도 원인입니다. | R1 | 아니오(경보면 배포 중단) |
| 생존·lane·scheduler | — | pause로 바뀌지 않습니다. | R1 | 아니오(경보면 배포 중단) |

「예」인 4개도 **R1에서 실제로 경보인 경우에만** 멈춥니다. 경보가 아닌 잡을 미리 멈추지 않습니다.

## 4. pause / resume 정확한 방법과 감사 경로

- **정식 경로(유일)**: 관리자 상태 화면 `/admin/status`(README의 관리자 상태 링크와 같은 등록 관리자 접근)에서 작업 표의 해당 잡을 열면 상세 창이 뜹니다. 그 아래 「멈춤 사유」를 입력하고 **「이 작업 멈춤」**을 누릅니다. 재개도 같은 창에서 「재개 사유」를 입력하고 **「이 작업 재개」**를 누릅니다.
  - 서버 액션: `app/(operator)/admin/status/job-control-actions.ts` → `controlAdminJob`. 관리자 로그인, CSRF HMAC, DR writer fence, 낙관적 버전 확인을 모두 거칩니다.
  - 이 저장소에 CLI는 없습니다. SQL로 `jobs.not_before`를 직접 바꾸면 감사 기록이 남지 않으므로 금지합니다.
- **멈춤 사유 예시**: `배포 <SHA> 직전 monitor_gate 정체 경보(<단계>=no_progress). 원인: M1 29877f65 / Supa 65f8c399 미확인 점유와 모델 이름 고정. 배포·M1 relay 재설치 뒤 재개.`
- **재개 동작**: 마지막 제어가 그 pause이고, pause 직전 `not_before`가 아직 미래면 그 재시도 시각을 복원합니다. 그렇지 않으면 `NULL`로 둡니다(`admin-job-control.ts:36-41`). 요청·cursor·진행 중 lease는 보존됩니다.
- **화면 오류 메시지**: `job_control_conflict`(다른 사람이 바꿈)이면 새로고침 뒤 다시 확인합니다. `job_control_unsupported_mode`이면 2절 제약 ①을 따릅니다.
- **감사 기록**: 표는 `operations_audit`, 쓰는 코드는 `admin-job-control.ts:43`입니다. 화면에서는 `/admin/activity`의 「개별 작업 멈춤」(`job-pause`)과 `job-resume`으로 볼 수 있습니다. 확인 SQL은 S7입니다.

## 5. 이번 변경과 시험 결과

- 추가: `tests/worker-progress-job-pause.test.ts` (코드 수정 없음).
  - 관리자 pause가 만드는 행 모양(`not_before` = 지금+100년, `last_error` 남음, 대기 40·최장 900분·과거 실패 5)을 그대로 `buildWorkerProgress`에 넣습니다.
  - text·intro 7단계 각각에서 멈춘 단계만 `paused`/경보 없음이 되고 나머지 단계는 경보를 유지하는지 확인합니다.
  - 7개를 모두 멈추면 `overall=ok`가 되는지 확인합니다.
  - 10분짜리 재시도 지연은 pause로 보지 않는지 확인합니다.
- 실행 결과(Node v22.22.1, 로컬, 운영 접근 없음):
  - `npx vitest run tests/worker-progress-job-pause.test.ts` → **10/10 통과**
  - 같은 파일 + `tests/worker-progress.test.ts` + `tests/worker-progress-capacity-drain.test.ts` → 3파일 **77/77 통과**
  - `npx eslint tests/worker-progress-job-pause.test.ts` 통과. `npx next typegen` 후 `npx tsc --noEmit --incremental false` 통과(typegen 전에는 Next의 `PageProps` 미생성 오류로 실패했고, 변경과 무관합니다).
- 실행하지 않은 것: 전체 unit, DB 통합, build, CI. AGENTS.md 정책에 따라 통합 단계에서 실행합니다.

## 6. 대표 실행 순서

배포 대상 SHA는 CI `check`와 이미지가 준비된 main SHA입니다. 각 단계의 응답이 불명확하면 읽어서 확인하고, 자동으로 재요청하지 않습니다.

1. **사전 읽기**(쓰기 없음): S0, R1, S1, S2, S3, S4를 실행합니다.
   - S0의 `job_batch_mode`가 `legacy`가 아니면 job-pause는 불가합니다(2절 ①).
   - R1에서 경보인 단계를 표로 남깁니다. 3절에서 「아니오」인 경보가 있으면 여기서 멈춥니다.
2. **미확인 2건 단건 복구**는 일반 배포와 별도이고 선행 조건입니다. `docs/operations/2026-10-28-unknown-request-recovery.md`의 순서를 따릅니다: drain → 물리 종료 증거 → `scripts/ops/model-provider-boundary-release.ts` dry-run → `--apply`, M1은 `--relay-state-dir` 사용.
   - S3에서 두 요청이 `withdrawn`이 되고 활성 0인지 확인합니다.
   - 증거가 없으면 blocked로 남기고 배포를 진행하지 **않습니다**. 이 상태에서 `run`은 `model_replacement_gate`에서 멈춥니다.
3. **모델 접수 DRAINING**: `node --import tsx scripts/ops/pipeline-control.ts capacity mode --to=draining --from-mode=open --expect-epoch=<S0 epoch> --expect-revision=<S0 revision> --operator=<이름> --reason="<배포 SHA> 모델 보유 앱 교체" --execute` (`docs/operations/2026-10-17-pipeline-control-runbook.md`). 2번에서 이미 draining이면 그대로 둡니다.
4. **job-pause**: R1에서 아직 경보인 잡만 4절 방식으로 하나씩 멈춥니다(기본 4개: `product-translate`·`product-tagline-ko`·`crawl-tagline`·`product-search-profile`, 그다음 조건부).
   - 잡마다 S7에서 `job-pause` 행과 `after_nb`를 확인하고, S1에서 `paused=true`를 확인합니다.
5. **R1 재확인**: `overall`이 `ok`여야 합니다. 경보가 남았으면 그 단계를 3절에서 찾고, pause 대상이 아니면 배포를 중단합니다.
6. `npm run deploy -- plan --sha <SHA> --out <새 절대 경로>` → `npm run deploy -- run --plan <PLAN> --plan-sha <PLAN_SHA256>` (`docs/operations/deployment-fast-path.md`). 관측 예약 영수증도 확인합니다.
7. **M1 relay 재설치**: `docs/operations/2026-10-29-m1-relay-model-handoff.md`의 argv(같은 SHA). launchd readback과 `/v1/models` id가 일치하는지 확인합니다.
8. **접수 OPEN**: `capacity mode --to=open --from-mode=draining ...`. 이 명령이 `deferred_routes`로 거절되면 모델 이름 고정 문제가 아직 남은 것입니다. 이 경우 재개하지 말고 원인을 확인합니다.
9. **resume**: 다음 절의 순서와 조건을 따릅니다.

### resume 순서와 정상 복귀 조건

- **순서**: S4에서 그룹 점유가 한도 미만인 경로부터, 한 번에 하나씩 재개합니다.
  1. `product-search-profile`(keywords). 이 단계는 모델 이름 고정 해소만 확인하면 됩니다.
  2. `crawl-tagline`(Supa 그룹 해제 뒤).
  3. `product-tagline-ko`.
  4. `product-translate`.
  5. 조건부로 멈췄던 `reason-translate`·`product-search-verify`·`product-intro-check`.
  - M1을 쓰는 4와 `reason-translate`는 7번 relay 확인이 끝난 뒤에만 재개합니다.
- **타이밍**: 잡 주기는 60초, lane poll은 수 초, text 모델 상한은 40~45초입니다. 그래서 첫 결과는 재개 후 약 2분 안에 기대할 수 있습니다.
- **정상 복귀 조건**(재개 후 **5분 안에** 모두 충족):
  1. R1에서 그 단계가 `progressing`(최근 5분 완료 ≥ 1)이거나, `no_work`·`backoff`이면서 경보가 없음.
  2. S5에서 그 경로의 `settled_5m` ≥ 1.
  3. S6에서 해당 결과 표의 `ok_5m` ≥ 1.
  4. S3에 새 `indeterminate`가 없음.
  5. S2의 마지막 미룸 이유가 `unmapped`·`policy_changed`·`draining`이 아님.
  6. S7에 `job-resume` 행이 있음.
- 2분에 1차 확인하고 5분에 판정합니다. 다음 잡은 앞 잡이 통과한 뒤에 재개합니다.
- **10분 안에도 완료가 0이면** 다음 재개를 멈추고 R1·S2~S6 결과를 그대로 기록합니다. 다시 멈출지는 대표가 판단하며, 다시 멈출 때는 실패 사실을 사유에 적습니다.
- **배포 관측과의 관계**: 5·10·15분·6시간 관측이 통과해도 멈춰 있던 단계가 정상이라는 증거는 아닙니다. 멈춘 동안의 관측 통과는 그 단계를 보지 않은 것입니다. 재개 뒤 위 조건을 충족한 시각을 따로 기록합니다.

## 7. 확인 명령과 READ ONLY SQL (대표 실행용, 미실행)

**R1 — 관문이 읽는 것과 같은 진행 보고**. M3에서 crawler-m3 컨테이너를 찾은 뒤 실행합니다. 관문의 `REMOTE_MONITOR`와 같은 읽기입니다.

```bash
CID=$(docker ps --filter name=<crawler-m3 appName> --format '{{.ID}}')   # 정확히 1개여야 함
docker exec "$CID" node --import tsx scripts/check-worker-progress.ts | python3 -c '
import json,sys; r=json.load(sys.stdin); print("overall", r["overall"])
for s in r["stages"]:
  if s["alarm"] or s["reason"] in ("paused","unknown_age"): print(s["stage"], s.get("job"), s["reason"], "wait", s.get("waiting"), "oldest", s.get("oldestMinutes"), "done5m", s.get("completed5m"), "err5m", s.get("errors5m"))
for k in ("liveness","lanes"):
  for x in r.get(k) or []:
    if x.get("alarm"): print(k, x)
print("scheduler", r["scheduler"]["reason"], r["scheduler"]["overdueJobs"])'
```

**SQL 실행기**: 같은 컨테이너의 `DATABASE_URL`을 쓰며, 값은 출력하지 않습니다. 실행은 READ ONLY 트랜잭션과 5초 제한 안에서만 이루어집니다. 파일 하나에 SELECT 하나를 넣습니다.

```bash
docker exec -i "$CID" node --input-type=module -e '
import postgres from "postgres";
let text=""; for await (const c of process.stdin) text+=c;
const sql=postgres(process.env.DATABASE_URL,{max:1,prepare:false,onnotice:()=>{}});
try { const rows=await sql.begin("read only", async tx=>{ await tx.unsafe("SET LOCAL statement_timeout = 5000"); return tx.unsafe(text); });
  console.log(JSON.stringify(rows,null,1)); } finally { await sql.end({timeout:5}); }' < S1.sql
```

아래 SQL의 잡 목록은 다음과 같습니다(필요하면 줄여 씁니다).
`('product-translate','product-tagline-ko','crawl-tagline','product-search-profile','reason-translate','product-search-verify','product-intro-check','crawl-agent-review')`

**S0 — 전제(배치·접수·단계 모드)**
```sql
SELECT (SELECT mode FROM job_batch_control WHERE id=1) AS job_batch_mode,
  (SELECT writer_contract_version FROM job_batch_control WHERE id=1) AS writer_contract_version,
  c.mode AS capacity_mode, c.epoch, c.revision, c.policy->>'globalLimit' AS global_limit, c.policy->'poolLimits' AS pool_limits,
  (SELECT jsonb_object_agg(stage, mode) FROM pipeline_stage_modes) AS item_stage_modes
FROM model_capacity_control c WHERE c.id=1;
```

**S1 — 잡 상태(pause 전후)**
```sql
SELECT name, not_before, not_before > now() + interval '365 days' AS paused, requested_version, processed_version,
  next_scheduled_at, locked_at, lease_token IS NOT NULL AS in_flight, last_run_at, last_success_at, left(last_error,160) AS last_error
FROM jobs WHERE name IN ('product-translate','product-tagline-ko','crawl-tagline','product-search-profile','reason-translate','product-search-verify','product-intro-check','crawl-agent-review')
ORDER BY name;
```

**S2 — 잡별 마지막 미룸 이유와 최근 1시간 이유별 횟수**(`defer:<잡>`, `lib/jobs/deferral-observation.ts`)
```sql
SELECT substring(o.key from 7) AS job, o.value->>'reason' AS last_reason, o.value->>'at' AS last_at,
  (SELECT jsonb_object_agg(r, n) FROM (SELECT split_part(c.k,'|',2) AS r, sum(c.v::int) AS n
     FROM jsonb_each_text(o.value->'counts') AS c(k, v) GROUP BY 1) t) AS last_hour_by_reason
FROM operations_observations o
WHERE o.key IN ('defer:product-translate','defer:product-tagline-ko','defer:crawl-tagline','defer:product-search-profile',
  'defer:reason-translate','defer:product-search-verify','defer:product-intro-check','defer:crawl-agent-review')
ORDER BY 1;
```

**S3 — 미확인·활성 점유**. 기대값은 `29877f65…`(product-translate·M1)와 `65f8c399…`(crawl-agent-review·Supa)입니다.
```sql
SELECT r.request_id, r.state, r.route_id, r.provider, r.model, r.group_id, r.provider_budget_id, r.pool, r.class,
  r.owner_instance_id, r.dispatched_at, r.updated_at,
  (r.epoch <> c.epoch OR r.revision <> c.revision OR r.policy_hash IS DISTINCT FROM c.policy_hash) AS old_policy,
  EXISTS (SELECT 1 FROM model_capacity_events e WHERE e.request_id = r.request_id AND e.kind = 'dispatch_local_ended') AS local_end_recorded
FROM model_capacity_requests r CROSS JOIN model_capacity_control c
WHERE c.id = 1 AND (r.state IN ('dispatched','indeterminate') OR (r.state = 'reserved' AND r.reserved_until > clock_timestamp())
  OR r.request_id::text LIKE '29877f65%' OR r.request_id::text LIKE '65f8c399%')
ORDER BY r.queue_ordinal;
```

**S4 — 경로 → 그룹·공급자 한도 대비 현재 점유**
```sql
WITH c AS (SELECT policy FROM model_capacity_control WHERE id = 1),
routes AS (SELECT x->>'routeId' AS route_id, x->>'provider' AS provider, x->>'model' AS model, x->>'groupId' AS group_id,
  x->>'providerBudgetId' AS budget FROM c, jsonb_array_elements(c.policy->'routes') x),
active AS (SELECT group_id, provider_budget_id, count(*) AS n FROM model_capacity_requests
  WHERE state IN ('dispatched','indeterminate') OR (state = 'reserved' AND reserved_until > clock_timestamp()) GROUP BY 1, 2)
SELECT r.route_id, r.provider, r.model, r.group_id, (c.policy->'groupLimits'->>r.group_id)::int AS group_limit,
  coalesce((SELECT sum(n) FROM active a WHERE a.group_id = r.group_id), 0) AS group_active,
  r.budget, (c.policy->'providerLimits'->>r.budget)::int AS provider_limit,
  coalesce((SELECT sum(n) FROM active a WHERE a.provider_budget_id = r.budget), 0) AS provider_active
FROM routes r, c
WHERE r.route_id IN ('product-translate','reason-translate','product-tagline-ko','crawl-tagline','product-search-profile','product-search-verify','crawl-agent-review','product-intro-check')
ORDER BY r.route_id, r.provider, r.model;
```

**S5 — 경로별 정산(settled) 추이**. settled 0인 시점과 재개 뒤 증가를 봅니다.
```sql
SELECT route_id, model, max(settled_at) AS last_settled,
  count(*) FILTER (WHERE settled_at > now() - interval '5 minutes') AS settled_5m,
  count(*) FILTER (WHERE settled_at > now() - interval '60 minutes') AS settled_60m,
  count(*) FILTER (WHERE settled_at > now() - interval '24 hours') AS settled_24h
FROM model_capacity_requests
WHERE state = 'settled' AND settled_at > now() - interval '3 days'
  AND route_id IN ('product-translate','reason-translate','product-tagline-ko','crawl-tagline','product-search-profile','product-search-verify')
GROUP BY 1, 2 ORDER BY 1, 2;
```

**S6 — 단계별 업무 산출(결과 표)**. 근사값이며, 관문 수치의 근거는 R1입니다.
```sql
SELECT 'product-translate' AS stage, max(updated_at) FILTER (WHERE status IN ('ready','reviewed')) AS last_ok,
  count(*) FILTER (WHERE status IN ('ready','reviewed') AND updated_at > now() - interval '5 minutes') AS ok_5m,
  count(*) FILTER (WHERE status IN ('pending','failed')) AS open_rows FROM product_translations
UNION ALL SELECT 'tagline-ko', max(updated_at) FILTER (WHERE error_code IS NULL),
  count(*) FILTER (WHERE error_code IS NULL AND updated_at > now() - interval '5 minutes'), count(*) FILTER (WHERE error_code IS NOT NULL) FROM product_korean_taglines
UNION ALL SELECT 'crawl-tagline', max(updated_at) FILTER (WHERE error_code IS NULL),
  count(*) FILTER (WHERE error_code IS NULL AND updated_at > now() - interval '5 minutes'), count(*) FILTER (WHERE error_code IS NOT NULL) FROM crawl_taglines
UNION ALL SELECT 'keywords', max(generated_at), count(*) FILTER (WHERE generated_at > now() - interval '5 minutes'),
  count(*) FILTER (WHERE error_code IS NOT NULL) FROM product_search_profiles
UNION ALL SELECT 'keyword-verify', max(verified_at), count(*) FILTER (WHERE verified_at > now() - interval '5 minutes'),
  count(*) FILTER (WHERE verified_at IS NULL) FROM product_search_profiles
UNION ALL SELECT 'reason-translate', max(updated_at) FILTER (WHERE status = 'done'),
  count(*) FILTER (WHERE status = 'done' AND updated_at > now() - interval '5 minutes'), count(*) FILTER (WHERE status = 'failed')
  FROM text_translations WHERE target_lang = 'ko';
```

**S7 — pause·resume 감사 기록과 감사 없는 멈춤 탐지**
```sql
SELECT j.name, j.not_before, j.not_before > now() + interval '365 days' AS paused,
  a.id AS control_id, a.created_at, a.actor, a.actor_kind, a.action, a.ok, a.detail->>'reason' AS reason,
  a.detail->>'beforeNotBefore' AS before_nb, a.detail->>'afterNotBefore' AS after_nb, a.detail->>'inFlight' AS in_flight,
  -- 멈춘 잡인데 마지막 제어가 job-pause가 아니면 감사 없는 멈춤(SQL 직접 변경 등)이다
  (j.not_before > now() + interval '365 days' AND a.action IS DISTINCT FROM 'job-pause') AS paused_without_audit
FROM jobs j LEFT JOIN LATERAL (SELECT * FROM operations_audit o WHERE o.target = j.name AND o.action IN ('job-pause','job-resume')
  ORDER BY o.id DESC LIMIT 1) a ON true
WHERE j.name IN ('product-translate','product-tagline-ko','crawl-tagline','product-search-profile','reason-translate','product-search-verify','product-intro-check')
ORDER BY j.name;
```

## 8. 남은 일 (이 구역)

| 항목 | 상태 |
|---|---|
| gate 단계·판정 조건 확정, 단계별 원인 추적, SQL 작성 | 완료(이 문서) |
| job-pause의 gate 반영 확인과 회귀 시험 | 완료. 버그 없음, 시험 10건 추가 |
| 운영 실측(S0~S7, R1) | **막힘**: 이 환경은 SSH가 막혀 있고 운영 접근이 금지되어 있습니다. 대표가 실행해야 합니다. |
| 미확인 2건 단건 복구 | **막힘**: 물리 종료 증거와 운영 실행이 필요합니다. 일반 배포와 별도 절차입니다. |
| 배포·M1 relay 재설치·OPEN·resume | 대기: 6절 순서대로 대표가 실행합니다. |
| 전체 unit·DB 통합 | 정책상 통합 단계에서 실행합니다(미실행). |
