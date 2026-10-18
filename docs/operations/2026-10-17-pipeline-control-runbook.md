# 파이프라인 운영자 제어 runbook — stage canary·legacy 복귀·capacity·HTTP·batch·제작 근거 스캔 (PR06d, 2026-10-17)

> **이 문서의 운영 실행(`--execute`)은 모두 사용자 승인 뒤에 한다.** 승인 전에는 dry-run과 아래 읽기 전용 SQL만 쓴다.
> 운영 DB에서 이 도구를 실행한 적은 아직 없다. 아래 순서와 수치는 코드와 로컬 테스트 DB로만 확인했다.

## 0. 도구와 공통 규칙

- 도구: `scripts/ops/pipeline-control.ts`. 대상은 `pipeline_stage_modes`(ai1·ai2), `model_capacity_control`, `http_origin_control`, `job_batch_control`, `agent_scan_control`(제작 근거 스캔, §11) 다섯 control 행이다. `fetch` stage는 운영 consumer가 연결돼 있지 않아 다루지 않는다.
- 실행 위치: 운영 DB primary에 쓰기로 접속할 수 있는 maintenance 계열 컨테이너. `node --import tsx scripts/ops/pipeline-control.ts <명령>`.
- DB URL은 `PIPELINE_CONTROL_DATABASE_URL` 환경변수로만 준다. 앱의 `DATABASE_URL`로 대체하지 않는다. `PGHOST`·`PGHOSTADDR`·`PGPORT`·`PGSERVICE`·`PGSERVICEFILE`·`PGOPTIONS`가 있거나 URL을 인자로 주면 거절한다. 복제본 URL은 쓰지 않는다.
- **기본은 dry-run이다.** `REPEATABLE READ, READ ONLY` 트랜잭션 하나로 현재 상태를 읽고 무엇이 바뀔지 계획만 출력한다. 행 잠금과 쓰기는 없다.
- `--execute`일 때만 쓴다. 한 트랜잭션 안에서 `dr_writer_fence`(FOR SHARE) → 대상 control 행(FOR UPDATE)을 잡고, 잠근 상태로 같은 계획을 다시 세워 기대 상태와 비교(compare-and-set)한다. 맞을 때만 기존 repository 전환 함수를 부르고, 같은 트랜잭션에 `operations_audit` 1행을 쓴 뒤 commit한다. 어느 단계든 거절되면 전체가 rollback된다. 실행 뒤 별도 읽기 전용 트랜잭션으로 readback을 출력한다.
- fenced DB(옛 primary·승격 전 사본)에서는 `site_fenced`로 거절한다.
- 출력: 기본은 사람이 읽는 표, `--json`은 결과 JSON 한 줄. exit `0`=허용(dry-run) 또는 실행 완료, `3`=거절(아무것도 쓰지 않음), `1`=오류(stderr에 `{"code":"..."}`만, URL·SQL 없음).
- 모든 전환 명령은 `--operator=<이름>`과 `--reason="<사유, 300자 이하>"`가 필수다. dry-run에도 같은 인자를 주고, 확인한 명령 끝에 `--execute`만 붙여 실행한다.
- 감사 행: `actor`=운영자, `action`=`pipeline-control-<area>-<action>`, `target`=대상 행, `detail`={`reason`, `expected`(입력한 기대 상태), `change`, `warnings`, `policyHash`, `before`, `after`}. `actor_kind`·`ip`·`user_agent`는 비어 있다(스크립트 행 관례). 이 표는 지울 수 없다(0056).

| 명령 | 기대 상태(필수) | 전환 함수 | 비고 |
|---|---|---|---|
| `stage contract --stage=ai1\|ai2` | `--expect-contract` `--expect-epoch` | `bumpStageWriterContract` | legacy에서만, +1만. 내리는 명령 없음 |
| `stage drain --stage --from-mode=legacy\|items` | `--expect-epoch` | `beginStageDrain` | contract ≥ 1 필요 |
| `stage complete --stage --draining-from=legacy\|items --to=legacy\|items [--allow-stalled-stage]` | `--expect-epoch` | `completeStageTransition` | live item lease 0일 때만. epoch +1. `--to=items`는 consumer가 모든 모델 항목을 미룰 조건이면 거절(§2) |
| `capacity policy --file=<json>` | `--from-mode=disabled\|draining` `--expect-epoch` `--expect-revision` | `setModelCapacityPolicy` | open이면 거절. revision +1, cursor 0 |
| `capacity mode --to=disabled\|draining\|open [--allow-deferred-routes]` | `--from-mode` `--expect-epoch` `--expect-revision` | `setModelCapacityMode` | draining을 거쳐서만 오간다 |
| `http policy --file=<json>` | `--from-mode=disabled\|draining` `--expect-epoch` `--expect-revision` | `setHttpOriginPolicy` | open이면 거절. revision +1 |
| `http mode --to=disabled\|draining\|open` | `--from-mode` `--expect-epoch` `--expect-revision` | `setHttpOriginMode` | draining을 거쳐서만 오간다 |
| `batch policy --file=<json>` | `--expect-epoch` `--expect-policy-hash=<64hex>\|none` | `setJobBatchPolicy` | legacy에서만 |
| `batch contract` | `--expect-contract` `--expect-epoch` | `bumpJobBatchContract` | legacy에서만, +1만 |
| `batch drain --from-mode=legacy\|versioned` | `--expect-epoch` | `beginJobBatchDrainIn` | legacy에서는 유효한 policy가 있어야 한다 |
| `batch complete --draining-from=legacy\|versioned --to=legacy\|versioned` | `--expect-epoch` | `completeJobBatchTransitionIn` | 전역 정지(아래 §8)일 때만. epoch +1 |
| `agent-scan contract` | `--expect-contract` `--expect-epoch` | `bumpAgentScanContract` | legacy에서만, +1만(§11) |
| `agent-scan drain --from-mode=legacy\|items` | `--expect-epoch` | `beginAgentScanDrain` | contract ≥ 1 필요 |
| `agent-scan complete --draining-from=legacy\|items --to=legacy\|items` | `--expect-epoch` | `completeAgentScanTransition` | 살아 있는 저장소 claim 0일 때만. epoch +1 |

`agent-scan status [--json]`은 `[agent-scan]` 칸만 읽는다(읽기 전용, operator·reason 없음).

기대 상태 값은 `status` 출력에서 그대로 옮긴다.

### 거절 code(`blocked`)

| code | 뜻 |
|---|---|
| `expect_<필드>_mismatch:<현재값>` | 입력한 기대 상태가 현재 행과 다르다(mode·epoch·revision·contract·draining_from·policy_hash). 다시 `status`를 본다 |
| `site_fenced` | 이 DB는 fenced다 |
| `stage_contract_required` / `batch_contract_required` / `agent_scan_contract_required` | writer contract가 0이다. 먼저 `contract` |
| `stage_transition_invalid` / `batch_transition_invalid` / `capacity_transition_invalid` / `http_transition_invalid` / `agent_scan_transition_invalid` | 허용되지 않는 전환(예: disabled→open 직행, draining에서 다시 drain, legacy 밖에서 contract·batch policy) |
| `stage_not_drained:<n>` | 그 stage에 lease_until이 지나지 않은 item lease가 n개 |
| `agent_scan_not_drained:<n>` | 제작 근거 저장소 claim 중 lease_until이 지나지 않은 것이 n개 |
| `batch_not_drained:jobs=..,roles=..,items=..,sources=..,agent_claims=..` | 전역 정지가 아니다(살아 있는 제작 근거 claim 포함) |
| `batch_policy_required_for_versioned` | versioned로 끝나야 하는데 유효한 batch policy가 없다 |
| `capacity_policy_missing` / `http_policy_missing` / `*_policy_invalid` | policy가 없거나 저장된 hash와 맞지 않는다 |
| `*_policy_requires_closed` | open 상태에서 policy를 바꾸려 했다 |
| `policy_invalid:<경로>` / `policy_unchanged` | 새 policy 파일이 schema에 맞지 않거나 현재와 같다 |
| `deferred_routes:<n>` | capacity를 열면 지금 쓰는 조합 n개가 호출 전에 미뤄진다(§6) |
| `items_consumer_defers:capacity_<mode>:<stage>` | `stage complete --to=items`인데 capacity가 open이 아니다. item consumer가 모든 모델 항목을 미루므로 dry-run부터 거절한다(§2) |
| `items_consumer_defers:route_not_serving:<stage>` | `stage complete --to=items`인데 그 stage가 쓰는 (route, provider, model) 중 serving이 아닌 것이 있다 |

### 경고 code(`warnings`) — 진행은 되지만 사용자에게 보고한다

| code | 뜻 |
|---|---|
| `consumer_heartbeat_missing:<stage>` | 최근 2분 `service:reviewer:<stage>-consumer-*` 관측이 없다. items로 가면 처리할 consumer가 없다 |
| `items_consumer_defers:*` | 위 거절 code와 같은 조건. `stage drain --from-mode=legacy`에서는 경고만 하고, `stage complete --to=items`는 `--allow-stalled-stage`를 붙였을 때만 경고로 바뀌어 진행된다 |
| `stage_paused_until_complete:<stage>` | draining 동안 그 stage의 legacy·item claim이 모두 멈춘다 |
| `legacy_job_in_flight:<stage>` | legacy job lease가 아직 살아 있다. 지금 items로 끝내면 그 결과는 ownership_lost로 버려진다 |
| `consumer_heartbeat_missing:agent-scan` | 최근 2분 `service:crawler:agent-scan-consumer-*` 관측이 없다. items로 가면 스캔할 consumer가 없다 |
| `agent_scan_paused_until_complete` | draining 동안 legacy 잡은 새 스캔을 시작하지 않고(컨트롤러만 돈다) consumer는 claim하지 않는다 |
| `legacy_job_in_flight:agent-scan` | drain 전에 시작한 `agent-evidence-refresh` 틱이 아직 살아 있다. 지금 items로 끝내면 그 틱이 쓰려던 스캔 1건은 관문에서 버려지고 다시 처리된다 |
| `expired_unsettled_claims:<n>` | 기한 지난 미정산 저장소 claim(누구든 다시 맡을 수 있다). complete를 막지 않는다 |
| `drain_cancelled` | 출발 mode로 되돌아간다(epoch는 오른다) |
| `agent_scan_contract_reset` | `agent-scan complete --to=legacy`는 writer contract를 0으로 내린다. 다시 items로 가려면 모든 스캔 writer의 release를 확인하고 11-1부터 한다 |
| `expired_unsettled_leases:<n>` | 기한 지난 미정산 item lease. complete를 막지 않는다 |
| `old_generation_held:<n>` | 이전 epoch·revision·policy로 잡힌 active 장부 행. 정산될 때까지 새 admission은 `policy_changed`로 미뤄진다 |
| `unsettled_dispatch_kept:<n>` | disabled로 가도 dispatched·indeterminate 행은 그대로 점유로 남는다 |
| `*_callers_defer_while_draining` | draining 동안 그 control을 쓰는 모든 호출자가 미룬다 |
| `deferred_routes:<n>` | `--allow-deferred-routes`로 미뤄질 경로를 받아들였다 |
| `instance_unmapped:<id>` | 최근 24시간 관측된 인스턴스가 HTTP policy에 없다 |
| `batch_claims_paused_until_complete:<target>` / `batch_live:...` | batch draining 동안 batch job claim이 멈춘다 / 아직 살아 있는 lease 수 |

## 1. 시작 전 기록

```sh
# PIPELINE_CONTROL_DATABASE_URL은 셸 기록에 남지 않는 방식으로 주입한다
node --import tsx scripts/ops/pipeline-control.ts status
node --import tsx scripts/ops/pipeline-control.ts status --json > control-before.json
```

`status`는 stage별 mode·epoch·contract·live·legacy job·consumer 수, capacity·HTTP·batch 행, `[agent-scan]` 행과 priority별 대기 표(§11), 그리고 `[capacity routes]` 표(지금 쓰는 조합별 serving 상태, §6-3)를 보여 준다.

## 2. 먼저 알아야 할 순서 제약 — item consumer는 capacity open이 필요하다

- AI2 consumer는 capacity가 `disabled`면 `disabled`, `draining`이면 `draining`, open이어도 `second-review` 매핑·serving 계약이 없으면 `unmapped`·`provider_contract_unavailable`로 **모든 항목을 미룬다**(`lib/crawl/second-review-ownership.ts:358-371`). AI1 consumer도 같다(`lib/crawl/agent-review-repository.ts:834-845`, provider `rules`만 예외).
- 반대로 AI2 legacy job은 capacity가 open이면 admission만 있어 **항상 미룬다**(`lib/crawl/jobs/second-review.ts:59-64`). AI1 legacy job에는 native 경로가 있다.
- 지금 통합 브랜치는 gateway·CLI serving 계약 resolver가 모두 `null`이다. 이 상태에서 stage를 items로 바꾸면 그 stage가 멈춘다. 그래서 도구는 `stage complete --to=items`를 capacity가 open이 아니거나 그 stage가 쓰는 조합(§6-3) 중 serving이 아닌 것이 있으면 **dry-run부터 거절**한다(`items_consumer_defers:*`, exit 3). 멈추는 것을 사용자가 승인한 경우에만 `--allow-stalled-stage`를 붙인다(경고로 남는다). `stage drain --from-mode=legacy`는 경고만 하고, items → draining → legacy 복귀는 막지 않는다.
- 따라서 AI2 canary와 capacity open은 한 작업 창으로 묶인다. 실제 순서는 다음과 같다(각 단계 dry-run 먼저).
  1. 선행: `second-review`(와 쓰는 모든 route)의 serving 계약이 배포 코드에 있다(PR05d gateway, PR05c-6 CLI). AI2 consumer 앱이 떠 있다.
  2. §6-1~6-3: capacity policy 설치(disabled 유지), route 표 확인.
  3. §3-0~3-2: AI2 contract, AI2 drain(from legacy), legacy job 종료 대기.
  4. §6-4~6-5: capacity disabled→draining→open.
  5. §3-3: AI2 complete → items. 관찰 시작(§3-4).

## 3. AI2 canary — legacy → draining → items (consumer 1개)

사전 확인:
- AI2 consumer 앱 1개: `SERVICE_INSTANCE_ID=ai2-consumer-<id>`, 명령 `node --import tsx scripts/worker-supervisor.ts --role=reviewer --consumer=ai2`, 전용 health 경로. host budget enforcement가 켜진 host에서는 consumer가 시작을 거절한다. 배포 helper에는 consumer 앱이 아직 등록돼 있지 않다(앱 생성은 운영자 작업).
- `status`의 ai2 `consumers` ≥ 1, §2의 capacity 조건.

`E` = `status`의 ai2 epoch.

```sh
# 3-0 writer contract 0→1 (운영자가 모든 AI2 writer가 stage lock을 지키는 release임을 확인했다는 표시)
node --import tsx scripts/ops/pipeline-control.ts stage contract --stage=ai2 --expect-contract=0 --expect-epoch=E --operator=<이름> --reason="<사유>"
node --import tsx scripts/ops/pipeline-control.ts stage contract --stage=ai2 --expect-contract=0 --expect-epoch=E --operator=<이름> --reason="<사유>" --execute

# 3-1 legacy → draining. 이 순간부터 AI2 legacy·item claim이 모두 멈춘다
node --import tsx scripts/ops/pipeline-control.ts stage drain --stage=ai2 --from-mode=legacy --expect-epoch=E --operator=<이름> --reason="<사유>"
node --import tsx scripts/ops/pipeline-control.ts stage drain --stage=ai2 --from-mode=legacy --expect-epoch=E --operator=<이름> --reason="<사유>" --execute
```

3-2 legacy job 종료 대기: `status`의 ai2 `legacy_job`이 `idle`이 될 때까지 기다린다(`second-review` job lease가 없거나 90초 넘게 갱신되지 않음). draining(from legacy) 동안 끝난 legacy 결과는 같은 epoch라 저장된다. 기다리지 않고 3-3을 하면 진행 중 결과는 버려지고 다시 처리된다(`legacy_job_in_flight` 경고).

```sh
# 3-3 draining → items. epoch E → E+1
node --import tsx scripts/ops/pipeline-control.ts stage complete --stage=ai2 --draining-from=legacy --to=items --expect-epoch=E --operator=<이름> --reason="<사유>"
node --import tsx scripts/ops/pipeline-control.ts stage complete --stage=ai2 --draining-from=legacy --to=items --expect-epoch=E --operator=<이름> --reason="<사유>" --execute
```

dry-run이 `items_consumer_defers:*`로 거절되면 §2 선행 조건(capacity open, `routes:`에 나온 second-review 조합 모두 `serving`)을 다시 본다. 멈춘 채로라도 items로 옮기라는 사용자 승인이 있을 때만 `--allow-stalled-stage`를 붙인다.

3-4 관찰: 첫 15분은 5분마다, 이후 6시간 동안 1시간마다 §9의 쿼리를 본다.
- AI2 `pending` 수가 줄고 최근 `reviewed_at`이 계속 생긴다.
- ai2 item lease `live`가 consumer 수(1) 근처, `unsettled`가 늘지 않는다.
- consumer 관측의 `status`·`lastProgressAt`이 갱신된다.
- `model_capacity_requests`의 `second-review` 행이 waiting→reserved→dispatched를 거쳐 정산되어 active에서 빠지고, `indeterminate`가 쌓이지 않는다.

중단 기준(하나라도 해당하면 §4로 복귀):
- consumer 관측이 5분 넘게 없다.
- 30분 동안 AI2 `pending`이 줄지 않거나 `reviewed_at`이 새로 생기지 않는다.
- `unsettled` item lease나 `indeterminate` 장부 행이 계속 늘어난다(DR 밖 회수 경로가 아직 없다).
- `second_reviews.error_code` 비율이 전환 전보다 뚜렷하게 높다.
- 판정 분포가 사람이 보기에 이상하다(사용자 판단).

## 4. AI2 legacy 복귀 — items → draining → legacy

legacy로 바로 갈 수 없다. 기존 불변식대로 draining을 거치고, 살아 있는 item lease가 0일 때만 끝난다.

```sh
# 4-1 items → draining. 새 item claim이 멈추고, 진행 중 item은 원 owner가 끝낼 수 있다
node --import tsx scripts/ops/pipeline-control.ts stage drain --stage=ai2 --from-mode=items --expect-epoch=E1 --operator=<이름> --reason="<사유>"
node --import tsx scripts/ops/pipeline-control.ts stage drain --stage=ai2 --from-mode=items --expect-epoch=E1 --operator=<이름> --reason="<사유>" --execute
```

4-2 `status`의 ai2 `live`가 0이 될 때까지 기다린다. item lease TTL은 최대 1시간이다. consumer를 멈춰도 lease는 `lease_until`이 지나야 0이 된다. `unsettled`는 complete를 막지 않는다.

```sh
# 4-3 draining → legacy. epoch E1 → E1+1. AI2 legacy job은 다음 tick부터 다시 claim한다
node --import tsx scripts/ops/pipeline-control.ts stage complete --stage=ai2 --draining-from=items --to=legacy --expect-epoch=E1 --operator=<이름> --reason="<사유>"
node --import tsx scripts/ops/pipeline-control.ts stage complete --stage=ai2 --draining-from=items --to=legacy --expect-epoch=E1 --operator=<이름> --reason="<사유>" --execute
```

- `E1` = 그 시점 `status`의 epoch(3-3 뒤라면 E+1).
- capacity가 open이면 AI2 legacy job은 계속 미룬다(§2). AI2를 legacy로 되돌릴 때는 capacity도 §6-8 순서로 닫을지 함께 정한다.
- drain을 취소하려면 출발 mode로 complete한다(`--draining-from=items --to=items`, `drain_cancelled` 경고, epoch +1).
- epoch는 되돌리지 않고, writer contract는 내리지 않는다.

## 5. AI1 — 같은 순서

§3·§4와 같다. 차이는 다음뿐이다.
- `--stage=ai1`, legacy job `crawl-agent-review`, consumer `SERVICE_INSTANCE_ID=ai1-consumer-<id>` + `--consumer=ai1`, 관찰 대상은 `crawl_review_attempts`(§9).
- AI1 legacy job은 capacity native 경로가 있다. `crawl-agent-review`가 serving이면 capacity open 뒤에도 AI1을 legacy에 둘 수 있다.

## 6. capacity open — text pool부터, route별로 확인

먼저 알아야 할 것:
- **전역 스위치다. route 단위 mode가 없다.** open이 되면 policy에 없는 route는 `unmapped`, 계약이 없는 route는 `provider_contract_unavailable`로 호출 전에 미뤄진다. 기존 전송으로 돌아가지 않는다. 그래서 "route별"은 열기 전 계약·매핑을 route마다 확인한다는 뜻이고, "text pool부터"는 처음 한도를 보수적으로 두고 text pool 한도부터 올린다는 뜻이다.
- dispatched·indeterminate 행은 TTL·정책 변경·disabled로 풀리지 않는다. DR 밖 회수 경로는 아직 없다(재고 조사 3a·3b·2). 살아 있는 프로세스의 timeout·abort도 영구 indeterminate가 된다.
- 선행 결정·작업: PR05d(gateway 9 route 계약), PR05c-6(CLI 계약), abcLLM PR3(번역 4경로), product-audit abcllm 분기 결정(지금은 admission만 → 항상 `admission_only`), 슬롯 회수 결정, AI2 items 전환(§2).

```sh
# 6-1 policy 파일. routes에는 실제로 쓰는 (routeId, provider, model)을 모두 적는다. 값은 사용자 승인 사항이다
cat > capacity-policy.json <<'EOF'
{ "version": 1, "globalLimit": 4, "providerLimits": { "abcllm": 4 }, "groupLimits": { "gateway": 4 },
  "poolLimits": { "reviewer": 3, "text": 1 }, "weights": { "first": 2, "second": 2, "background": 1 },
  "maxWaiting": 64, "queueTtlMs": 300000, "reservationTtlMs": 30000,
  "routes": [
    { "routeId": "reason-translate", "provider": "abcllm", "model": "<모델>", "providerBudgetId": "abcllm", "groupId": "gateway" },
    { "routeId": "second-review", "provider": "abcllm", "model": "<모델>", "providerBudgetId": "abcllm", "groupId": "gateway" }
  ] }
EOF

# 6-2 policy 설치(disabled에서). revision R → R+1. 출력의 새 policy hash를 기록한다
node --import tsx scripts/ops/pipeline-control.ts capacity policy --file=capacity-policy.json --from-mode=disabled --expect-epoch=CE --expect-revision=R --operator=<이름> --reason="<사유>"
node --import tsx scripts/ops/pipeline-control.ts capacity policy --file=capacity-policy.json --from-mode=disabled --expect-epoch=CE --expect-revision=R --operator=<이름> --reason="<사유>" --execute
```

6-3 route 표 확인: `status`의 `[capacity routes]`. 도구는 지금 쓰는 (route, provider, model)만 판정한다.
- 읽는 곳: `crawl_settings`(1차 심사 `firstReview`, 없으면 Claude CLI + `CRAWL_REVIEW_MODEL` / 2차 `voters`+`fallbacks` / 그중 첫 grok-cli가 Grok 세션 점검), 실행 중 감사 행(provider가 abcllm이면 게이트웨이, 그 밖은 Claude CLI), CLI 프로세스의 model env(`ABCLLM_MODEL`·`ABCLLM_TAGLINE_MODEL`·`ABCLLM_PROFILE_MODEL`·`SEARCH_VERIFY_MODEL`·`INTRO_CHECK_MODEL`, 비면 코드 기본값). 각 호출 지점과 같은 식이다.
- **CLI는 text·reviewer 역할과 같은 model env로 실행한다.** 다른 env에서 돌리면 다른 모델로 판정한다.
- 쓰는 조합은 모두 `serving`이어야 한다. `no_contract`·`unmapped`·`admission_only`·`stage_legacy`·`unknown`(설정 행이 손상돼 읽지 못했거나 model 값이 비었다)이 남아 있으면 open에서 그 경로가 멈추고, `capacity mode --to=open`은 `deferred_routes`로 거절된다.
- `unused`는 policy에는 있거나 호출 지점은 있지만 지금 설정·env가 부르지 않는 조합이다. 정보일 뿐 판정에 넣지 않는다. 설정을 바꿔 그 조합을 쓰게 되면 다시 확인한다.

```sh
# 6-4 disabled → draining. 이 순간부터 모든 모델 호출이 미뤄진다(기존 전송 포함)
node --import tsx scripts/ops/pipeline-control.ts capacity mode --to=draining --from-mode=disabled --expect-epoch=CE --expect-revision=R1 --operator=<이름> --reason="<사유>" --execute
```

장부 밖에서 진행 중이던 기존 호출이 끝날 때까지 기다린다(각 호출 경로 timeout 상한 이상). 이 시간 동안 모델 작업 전체가 멈추므로 짧게 잡는다.

```sh
# 6-5 draining → open. 먼저 dry-run으로 route 표와 deferred 수를 본다. 0이 아니면 거절된다
node --import tsx scripts/ops/pipeline-control.ts capacity mode --to=open --from-mode=draining --expect-epoch=CE --expect-revision=R1 --operator=<이름> --reason="<사유>"
# deferred를 사용자에게 보고하고, 그 경로들이 멈추는 것을 승인받은 경우에만
node --import tsx scripts/ops/pipeline-control.ts capacity mode --to=open --from-mode=draining --expect-epoch=CE --expect-revision=R1 --operator=<이름> --reason="<사유>" --allow-deferred-routes --execute
```

6-6 관찰(첫 15분 5분마다, 이후 1시간마다): §9 장부 쿼리. route·state별 수, 최장 대기, `indeterminate` 추이, `policy_changed`·`wait_expired` event 수.

6-7 한도 올리기(text pool부터): `capacity mode --to=draining --from-mode=open` → `capacity policy --from-mode=draining`(새 한도) → `capacity mode --to=open --from-mode=draining`. policy 명령이 revision을 하나 올리므로 마지막 명령의 `--expect-revision`은 `status`에서 다시 읽는다. 옛 세대 active 행이 정산될 때까지 새 admission은 `policy_changed`로 미뤄진다(`old_generation_held` 경고).

중단 기준(하나라도 해당하면 6-8):
- `indeterminate`가 계속 늘어난다(회수 경로 없음).
- 최장 대기가 `queueTtlMs`에 닿거나 `wait_expired`가 계속 생긴다.
- `serving`이라고 본 route가 미뤄진다(로그 `*_deferred`·`provider_contract_unavailable`).
- 처리량이 전환 전보다 뚜렷하게 낮다.

```sh
# 6-8 되돌리기: open → draining(즉시 신규 admission 중단, 모든 모델 호출 미룸) → disabled(기존 전송 복귀)
node --import tsx scripts/ops/pipeline-control.ts capacity mode --to=draining --from-mode=open --expect-epoch=CE --expect-revision=R1 --operator=<이름> --reason="<사유>" --execute
node --import tsx scripts/ops/pipeline-control.ts capacity mode --to=disabled --from-mode=draining --expect-epoch=CE --expect-revision=R1 --operator=<이름> --reason="<사유>" --execute
```

disabled로 가도 dispatched·indeterminate 행은 남는다(`unsettled_dispatch_kept`). 다음 open 때 같은 세대면 계속 한도에 잡힌다. disabled에서는 AI1·AI2 item consumer가 모두 미루므로(§2), stage도 §4로 legacy에 돌려야 처리가 이어진다.

## 7. 공유 HTTP 활성화

- 스위치가 둘이다. DB control(mode·policy)과 프로세스 env `HTTP_ORIGIN_PERMITS=1`. env가 없거나 `0`인 프로세스는 DB를 보지 않고 기존 전송을 쓴다(`lib/net/http-origin-policy.ts`).
- 한도는 origin당 1, Oracle 물리 host 합계 2로 SQL·코드에 고정돼 있다. 이 도구로 바꿀 수 없다.
- policy는 `{"version":1,"instanceHosts":{"<SERVICE_INSTANCE_ID>":"m3|mini|oracle-osaka-smoke"}}`. 참여하는 모든 인스턴스를 넣는다. 도구는 최근 24시간 `service:*` 관측(scheduler 제외) 중 policy에 없는 인스턴스를 `instance_unmapped`로 경고한다.
- 선행: `docs/operations/2026-10-16-shared-http-permits.md`의 활성화 조건(generic catch caller, DB role `lock_timeout` 확인). crash·indeterminate hop 회수 경로가 없다(재고 조사 2).

순서(각각 dry-run 먼저, `HE`·`HR`은 `status`의 http epoch·revision):

```sh
node --import tsx scripts/ops/pipeline-control.ts http policy --file=http-policy.json --from-mode=disabled --expect-epoch=HE --expect-revision=HR --operator=<이름> --reason="<사유>" --execute
node --import tsx scripts/ops/pipeline-control.ts http mode --to=draining --from-mode=disabled --expect-epoch=HE --expect-revision=HR1 --operator=<이름> --reason="<사유>" --execute
node --import tsx scripts/ops/pipeline-control.ts http mode --to=open --from-mode=draining --expect-epoch=HE --expect-revision=HR1 --operator=<이름> --reason="<사유>" --execute
# 그 다음 역할별로 HTTP_ORIGIN_PERMITS=1 재배포(별도 승인). mode가 open이 아닐 때 env=1이면 hop이 'unavailable'로 거절된다
```

관찰: §9 HTTP 쿼리. origin별 active hop, `indeterminate` 추이, Oracle 점유(최대 2). caller별 거절 처리는 위 문서의 표를 따른다.

되돌리기: env=0 재배포를 먼저 한 뒤 `http mode --to=draining --from-mode=open ...` → `--to=disabled --from-mode=draining ...`. 이미 dispatched·indeterminate인 hop은 남는다.

## 8. job batch 전환 — legacy → versioned → legacy

- `complete`는 **전역 정지**에서만 된다. 살아 있는 job lease(90초 안 갱신), role lease, item lease, source claim이 모두 0이어야 한다(`completeJobBatchTransition`).
- **draining은 출발 mode로 되돌아가지 못한다**(기존 불변식). legacy에서 drain하면 versioned로만 끝난다. 그래서 도구는 유효한 batch policy가 없으면 legacy drain을 거절한다. draining 동안에는 batch job claim이 모두 멈춘다.
- batch policy는 legacy에서만 바꾼다. versioned 상태에서 release를 바꾸는 절차는 아직 정해지지 않았다(versioned → legacy → policy → versioned로 두 번 전역 정지가 필요하다).

`BE` = `status`의 batch epoch.

```sh
# 8-1 policy(release = 배포 RELEASE_TAG, instances = 참여 SERVICE_INSTANCE_ID → host). 처음이면 --expect-policy-hash=none
node --import tsx scripts/ops/pipeline-control.ts batch policy --file=batch-policy.json --expect-epoch=BE --expect-policy-hash=none --operator=<이름> --reason="<사유>" --execute
# 8-2 writer contract 0→1
node --import tsx scripts/ops/pipeline-control.ts batch contract --expect-contract=0 --expect-epoch=BE --operator=<이름> --reason="<사유>" --execute
```

8-3 전역 정지: scheduler·모든 워커·consumer 앱을 멈추거나(Dokploy stop, 별도 승인) lease가 끝나기를 기다린다(role 45초, job 90초, item 최대 1시간, source claim, 제작 근거 claim 120초). `status`의 `[batch] live jobs=0 roles=0 items=0 sources=0 agent_claims=0`을 확인한다.
- `agent_claims`는 **참고값**이다. source claim과 달리 batch complete가 제작 근거 control을 잠그지 않고 한 번 읽기만 하며, consumer는 batch draining을 보지 않는다. consumer(M3 앱·Oracle unit)가 도는 동안에는 거의 늘 0이 아니어서 complete가 `batch_not_drained`로 막히고, 0으로 통과해도 다음 순간 새 claim이 생길 수 있다. 이 검사가 consumer를 멈춰 주지 않는다 — 위처럼 consumer를 먼저 멈춘다(또는 `agent-scan drain`).

```sh
# 8-4 legacy → draining
node --import tsx scripts/ops/pipeline-control.ts batch drain --from-mode=legacy --expect-epoch=BE --operator=<이름> --reason="<사유>" --execute
# 8-5 draining → versioned. epoch BE → BE+1. live가 하나라도 있으면 batch_not_drained로 거절된다
node --import tsx scripts/ops/pipeline-control.ts batch complete --draining-from=legacy --to=versioned --expect-epoch=BE --operator=<이름> --reason="<사유>" --execute
```

8-6 워커를 다시 띄우고 host별 준비 상태를 관리 화면(파이프라인 제어 상태)과 `job_batch_candidates`로 확인한다. versioned 역할의 canary·준비 근거는 PR10·PR11 문서를 따른다.

되돌리기: `batch drain --from-mode=versioned --expect-epoch=BE1 ...` → 전역 정지 → `batch complete --draining-from=versioned --to=legacy --expect-epoch=BE1 ...`(epoch +1).

## 9. 읽기 전용 확인 SQL

`timestamp`(시간대 없음) 열은 UTC 벽시계다.

```sql
-- control 네 행
SELECT stage, mode, draining_from, epoch, writer_contract_version, updated_at FROM pipeline_stage_modes ORDER BY stage;
SELECT mode, epoch, revision, policy_hash, cursor, updated_at FROM model_capacity_control WHERE id = 1;
SELECT mode, epoch, revision, policy_hash, updated_at FROM http_origin_control WHERE id = 1;
SELECT mode, draining_from, epoch, writer_contract_version, policy_hash, updated_at FROM job_batch_control WHERE id = 1;
SELECT state, writer_epoch, reason FROM dr_writer_fence WHERE id = 1;

-- stage별 item lease(live는 complete 가드와 같은 조건)
SELECT stage, count(*) FILTER (WHERE lease_until > clock_timestamp()) AS live,
       count(*) FILTER (WHERE token IS NOT NULL AND lease_until <= clock_timestamp()) AS unsettled
FROM pipeline_item_leases GROUP BY stage ORDER BY stage;

-- legacy job lease
SELECT name, lease_token IS NOT NULL AS leased, locked_at, last_success_at, last_error
FROM jobs WHERE name IN ('crawl-agent-review', 'second-review');

-- consumer 관측(15초마다 갱신)
SELECT key, observed_at, value->>'status' AS status, value->>'lastProgressAt' AS last_progress_at
FROM operations_observations WHERE key LIKE 'service:reviewer:ai_-consumer-%' ORDER BY key;

-- AI2 진행
SELECT status, count(*) FROM second_reviews GROUP BY status ORDER BY status;
SELECT count(*) AS reviewed_1h, count(*) FILTER (WHERE error_code IS NOT NULL) AS errors_1h
FROM second_reviews WHERE reviewed_at > (now() AT TIME ZONE 'utc') - interval '1 hour';

-- AI1 진행
SELECT state, count(*) FROM crawl_review_attempts WHERE started_at > (now() AT TIME ZONE 'utc') - interval '1 hour' GROUP BY state;

-- 모델 슬롯 장부
SELECT route_id, provider, state, count(*) FROM model_capacity_requests
WHERE state IN ('waiting', 'reserved', 'dispatched', 'indeterminate') GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
SELECT min(queued_at) AS oldest_waiting FROM model_capacity_requests WHERE state = 'waiting';
SELECT kind, count(*) FROM model_capacity_events WHERE created_at > clock_timestamp() - interval '1 hour' GROUP BY kind ORDER BY 2 DESC;

-- 공유 HTTP
SELECT origin, host_id, state, count(*) FROM http_origin_hops WHERE state IN ('reserved', 'dispatched', 'indeterminate') GROUP BY 1, 2, 3 ORDER BY 4 DESC;
SELECT count(*) FROM http_origin_hops WHERE host_id = 'oracle-osaka-smoke' AND state IN ('reserved', 'dispatched', 'indeterminate');

-- batch 전역 정지 확인(complete 가드와 같은 조건)
SELECT
  (SELECT count(*) FROM jobs WHERE lease_token IS NOT NULL AND locked_at >= clock_timestamp() - interval '90 seconds') AS live_jobs,
  (SELECT count(*) FROM role_leases WHERE owner_instance_id IS NOT NULL AND lease_until > clock_timestamp()) AS live_roles,
  (SELECT count(*) FROM pipeline_item_leases WHERE token IS NOT NULL AND lease_until > clock_timestamp()) AS live_items,
  (SELECT count(*) FROM evidence_source_claims WHERE token IS NOT NULL AND lease_until > clock_timestamp()) AS live_sources;

-- 전환 이력
SELECT id, actor, action, target, created_at, detail->>'reason' AS reason, detail->>'change' AS change
FROM operations_audit WHERE action LIKE 'pipeline-control-%' ORDER BY id DESC LIMIT 20;
```

## 10. 이 도구가 하지 않는 것

- 장부 행 회수(dispatched·indeterminate 모델 슬롯, HTTP hop), 강제 reset, epoch 되돌리기, writer contract 내리기.
- route 단위 open, HTTP 한도 변경, versioned 상태의 batch policy 변경, fetch stage.
- 배포·env 변경, consumer 앱 생성, 워커 정지.
- 처리량·품질·2배 판정. 이 도구의 허용은 control 행 전환이 가드를 통과했다는 뜻일 뿐이다.

## 11. 제작 근거 스캔(agent-scan) — legacy → items, 되돌리기

`agent_scan_control`(0104)의 뜻은 stage와 같다. 모드별 동작:

| 모드 | `agent-evidence-refresh` 잡(crawler) | consumer(`agent-scan-consumer-*`) | 스캔 기록 |
|---|---|---|---|
| legacy | 지금처럼 GitHub로 스캔한다 | claim하지 않는다 | legacy 쓰기만 |
| draining(from legacy) | 새 스캔을 시작하지 않는다(틱 도중이어도 다음 저장소 전에 멈춘다). 컨트롤러 일만 한다 | claim하지 않는다 | 진행 중이던 legacy 쓰기만 |
| items | **컨트롤러**: GitHub 호출 없이 큐 채우기 → 관리자 추가 수집 완료 처리 → 제품 연결 → 근거 대기 후보 풀기 | claim·스캔·기록 | consumer 기록만(epoch 일치) |
| draining(from items) | 컨트롤러 | 새 claim 없음, 진행 중 기록만 마친다 | 진행 중 consumer 기록만 |

- 컨트롤러 틱은 잡 커서에서 새 제품 몫의 자리(`afterNewProduct`)만 남기고 legacy 스캔의 공급자 대기·스캔 전 실패 기록은 지운다. 운영센터 `agent-evidence` 단계는 items·draining(from items)에서 claim 표로 센다: 대기·최장 대기는 claim의 `due_at`과 저장소별 `retry_after` 중 늦은 쪽, 처리·오류는 최신 스캔(스캔 행이 없는 실패는 claim 행의 실패 기록)이다.
- items·draining에서 이 단계는 crawler 자동 재시작 대상이 아니다(재시작해도 consumer 문제는 고쳐지지 않는다). items인데 consumer 관측이 2분 넘게 없으면 단계 판정이 `consumer_missing`(소비자 끊김) 경보다.
- **잡 멈춤은 items에서도 스캔을 멈춘다.** 운영자가 `agent-evidence-refresh`를 멈추면(`jobs.not_before` 먼 미래, 1년 넘게) 컨트롤러 틱이 멈추고, consumer의 claim도 `paused`로 쉰다(30초마다 다시 본다. Oracle 계정은 jobs 권한 없이 0105 보기 `agent_scan_job_schedule`로 그 값만 읽는다). 이미 맡은 저장소는 기록을 마친다. 운영센터는 '설정상 중지'이고 `consumer_missing` 경보를 내지 않는다. 다시 열면(`not_before` 비움) 30초 안에 이어 맡는다. 스캔을 멈추는 다른 방법은 `agent-scan drain`, `agentEvidence.enabled=false`, consumer 정지다.
- **비상(PR16 full·recovering·hold)에서 이 잡은 `suspended`지만 consumer는 비상 판정을 스스로 읽지 못한다** — 판정이 role_leases·http_origin_control을 읽는데 consumer 계정에는 그 권한이 없고, Oracle consumer는 host 장부(HOST_BUDGET_ENFORCEMENT)를 켜지 않는다. 비상으로 들어가면 위 잡 멈춤으로 모든 consumer를 멈추거나 Oracle에서 `systemctl stop nomorevibe-core-consumer@agent-scan`을 한다.
- `status`의 `[agent-scan]`: `live`(lease_until 전 claim), `unsettled`(기한 지난 미정산), `legacy_job`(drain 전에 시작한 잡 틱이 살아 있으면 `live`), `consumers`(상태가 running·starting이고 2분 안인 consumer 관측 수 — 운영센터 `consumer_missing`과 같은 기준. 크래시 루프·정지 중인 consumer는 세지 않는다), 그리고 priority별 `waiting`(지금 잡을 수 있는 행: 도래했고 backoff가 지났고 살아 있는 claim이 아님)·`oldest_min`. priority: 0 관리자 추가 수집 · 1 1차 심사 대기 · 2 스캔 없는 공개 제품 · 3 스캔 없는 후보 · 4 이어 하기 · 5 정기 · 6 오류 반복.

사전 확인(설계 §8 S3–S5, 각각 별도 승인):
- migration 0104가 운영 DB에 있다(`agent_scan_control` 1행, legacy·epoch 1·contract 0).
- 관문이 들어간 release가 **스캔을 쓰는 모든 앱**(crawler M3·mini, 다른 역할 포함 14앱)에 배포됐다. `scripts/backfill-agent-evidence.ts`도 같은 release로만 돌린다. contract는 이것을 운영자가 확인했다는 표시다 — 옛 코드는 items에서도 스캔을 써서 consumer와 같은 저장소를 겹쳐 쓴다.
- consumer 앱(`SERVICE_INSTANCE_ID=agent-scan-consumer-<자리>`, `worker-supervisor.ts --role=crawler --consumer=agent-scan`)이 떠 있고 `status`의 `consumers` ≥ 1이다. legacy에서는 claim하지 않고 쉰다.

`A` = `status`의 `[agent-scan]` epoch.

```sh
# 11-1 writer contract 0→1
node --import tsx scripts/ops/pipeline-control.ts agent-scan contract --expect-contract=0 --expect-epoch=A --operator=<이름> --reason="<사유>"
node --import tsx scripts/ops/pipeline-control.ts agent-scan contract --expect-contract=0 --expect-epoch=A --operator=<이름> --reason="<사유>" --execute

# 11-2 legacy → draining. 이 순간부터 legacy 잡은 새 스캔을 시작하지 않는다
node --import tsx scripts/ops/pipeline-control.ts agent-scan drain --from-mode=legacy --expect-epoch=A --operator=<이름> --reason="<사유>" --execute
```

11-3 legacy 틱 종료 대기: `agent-scan status`의 `legacy_job`이 `idle`이 될 때까지 기다린다(최대 약 1분: 틱 마감 50초 + 진행 중 스캔 1건). drain 뒤에 시작한 틱은 컨트롤러라 `idle`로 센다.

```sh
# 11-4 draining → items. epoch A → A+1. 이때부터 consumer만 스캔한다
node --import tsx scripts/ops/pipeline-control.ts agent-scan complete --draining-from=legacy --to=items --expect-epoch=A --operator=<이름> --reason="<사유>"
node --import tsx scripts/ops/pipeline-control.ts agent-scan complete --draining-from=legacy --to=items --expect-epoch=A --operator=<이름> --reason="<사유>" --execute
```

11-5 관찰(5분 안, 이후 2–24시간): 잡 관측 `job:agent-evidence-refresh`의 `agent_scan.queue_filled`가 0보다 큼(첫 틱), `live` ≤ consumer 수, 새 스캔 행의 `started_at`이 consumer claim 시각, legacy 잡의 GitHub 호출 0, `unsettled`가 늘지 않음, crawler 재시작 없음, 운영센터 `agent-evidence`가 `consumer_missing`이 아님. 중단 기준: consumer 관측 5분 이상 없음, 30분 동안 대기가 줄지 않음, `unsettled`가 5보다 크고 계속 증가.

### 11-6 되돌리기 — items → draining → legacy

```sh
# items → draining(from items). consumer는 새 claim을 멈추고 진행 중 기록만 마친다
node --import tsx scripts/ops/pipeline-control.ts agent-scan drain --from-mode=items --expect-epoch=A1 --operator=<이름> --reason="<사유>" --execute
# live 0 대기(claim TTL 최대 120초). 그 뒤 legacy. epoch A1 → A1+1, 옛 consumer의 늦은 기록은 epoch가 달라 거절된다
node --import tsx scripts/ops/pipeline-control.ts agent-scan complete --draining-from=items --to=legacy --expect-epoch=A1 --operator=<이름> --reason="<사유>" --execute
```

- `A1` = 그 시점 epoch(11-4 뒤라면 A+1). legacy로 바로 갈 수 없다(`expect_mode_mismatch`).
- **코드를 이전 SHA로 되돌릴 때의 순서(중요):** 이전 release에는 모드 관문이 없다. 그래서 **먼저** 위 순서로 control을 `legacy`로 돌리고, **consumer 앱(M3 Dokploy)과 Oracle unit을 멈춘 뒤에** 앱을 이전 SHA로 재배포한다. items 상태에서 옛 crawler가 돌면 consumer와 같은 저장소를 겹쳐 쓰고 스캔 커서가 뒤로 돈다. control 행과 claim 표는 남아 있어도 옛 코드에는 무해하다.
  - `deploy_shared_images.py restore --app crawler-*|agent-scan-consumer-*`와 `plan|run`은 되돌릴(배포할) SHA에 관문(`assertLegacyAgentScanWrite`)이 없으면 운영 `agent_scan_control.mode`를 읽기 전용으로 읽어(reviewer-m3 → publisher-m3 → crawler-m3 컨테이너 순, migration 확인과 같은 방식) `legacy`(또는 0104 전)가 아니면 Dokploy를 바꾸기 전에 `agent_scan_ungated_release_while_<mode>`로 거절한다. 읽지 못하면 `agent_scan_mode_unknown`으로 거절한다. 관문이 있는 SHA는 읽지 않고 통과한다.
  - **pipeline-control CLI를 돌리는 컨테이너(maintenance, git 빌드)는 control이 `legacy`가 될 때까지 되돌리지 않는다.** 관문 release보다 옛 SHA에는 `agent-scan` 명령이 없어 items를 끌 수단이 사라진다.
  - git 빌드 앱(text·maintenance)도 G1 제외 변수(`GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS`)를 아는 release여야 한다. 옛 SHA로 되돌리면 Oracle 몫 설치를 함께 써 한도가 겹친다.
- drain을 취소하려면 출발 mode로 complete한다(`--draining-from=items --to=items`, `drain_cancelled`, epoch +1). epoch는 되돌리지 않는다.
- **legacy로 끝내면 writer contract가 0이 된다**(`agent_scan_contract_reset`). legacy 동안 앱을 관문 없는 옛 SHA로 되돌렸을 수 있으므로, 다시 items로 갈 때는 `deploy_shared_images.py inventory --sha=<관문 release>`로 모든 앱(crawler M3·mini 포함)이 관문 release 이상인지 확인한 뒤 11-1부터 다시 한다. items 쪽 drain 취소(`--to=items`)는 contract를 그대로 둔다.

```sql
-- 제작 근거 스캔 control·claim(시각은 시간대 없는 UTC)
SELECT mode, draining_from, epoch, writer_contract_version, updated_at FROM agent_scan_control WHERE id = 1;
SELECT count(*) FILTER (WHERE token IS NOT NULL AND lease_until > clock_timestamp() AT TIME ZONE 'UTC') AS live,
       count(*) FILTER (WHERE token IS NOT NULL AND lease_until <= clock_timestamp() AT TIME ZONE 'UTC') AS unsettled,
       count(*) FILTER (WHERE state = 'active' AND retry_after > clock_timestamp() AT TIME ZONE 'UTC') AS backoff
FROM agent_repository_claims;
SELECT instance_id, count(*) FROM agent_repository_claims WHERE token IS NOT NULL GROUP BY 1;
SELECT key, observed_at, value->>'status' AS status FROM operations_observations WHERE key LIKE 'service:crawler:agent-scan-consumer-%' ORDER BY key;
```
