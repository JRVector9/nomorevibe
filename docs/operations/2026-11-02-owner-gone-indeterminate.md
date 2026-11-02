# 소유 프로세스가 사라진 전송 중(dispatched) 행 → 미확정 → 사람 검토 (2026-11-02)

## 배경

대표 실측(2026-11-02 14:50Z, 운영 DB 읽기 전용): `model_capacity_requests` 에 `state='dispatched'` 5건이 남아 있고 소유 프로세스가 모두 없다.

| request_id | 작업 | budget | owner / boot | 전송(UTC) |
|---|---|---|---|---|
| 578b94ac-1865-4ec5-8047-3471472c642b 외 3건(아래 목록) | product-search-verify 3, crawl-tagline 1 | supa-direct | m3-text / cfae3be6-… | 11/01 14:21~14:26 |
| 1건(아래 목록) | crawl-agent-review | gpu3090-qwen | mini-reviewer-standby / 3511cf90-… | 11/01 14:33 |

대상 5건: `578b94ac-1865-4ec5-8047-3471472c642b`, `aac34be2-2094-41a8-9a66-99c0c75e56b1`, `a3955d87-2010-4eca-ab29-0be55fc1c13a`,
`f0e53895-7255-4afc-bb87-71909aa3772a`, `4054e658-4643-440d-a7ab-945272ed3fd6`.

정식 회수(`scripts/ops/dr/promotion.ts reclaim-report`)는 5건 모두 `unproven`(`spawn_not_exited:1`)이다. `group_exited` 는 같은 커널 부팅의 후속 프로세스가
적어야 하는데 M3 는 11/02 13:56Z 커널 패닉으로 재부팅했고, 옛 컨테이너는 이미 죽었다. 사람 검토(`closeModelCapacityUnknownReview`)는 indeterminate 만 받는다.
그래서 supa-direct 4칸 중 4칸, gpu3090-qwen 4칸 중 1칸이 잡혀 있고 모니터가 `dispatch_stuck 5` 경보를 낸다.

## 무엇이 바뀌나

- `scripts/ops/model-owner-gone.ts mark` — 명시한 id 만(최대 20건) 판정해, 소유자 부재 근거가 있으면 `dispatched → indeterminate` 로 옮긴다.
  `released` 가 아니다(제공자 쪽 생성이 끝났는지 모른다). event `dispatch_indeterminate`(reason `process_exit` — 관리자 화면 문구 "워커 프로세스가 끝나 결과를
  받지 못함")에 근거(evidence `kind: owner_gone`)를, `operations_audit` 에 `model-capacity-owner-gone` 을 같은 TX 로 남긴다.
- `scripts/ops/model-owner-gone.ts close-review` — 그 뒤 기존 사람 검토 함수(`closeModelCapacityUnknownReview`, 관리자 `/admin/models` "확인 못함 — 사람 검토"의
  **검토 완료**와 같은 함수·같은 감사 action `model-capacity-unknown-reviewed`)로 `withdrawn` 으로 닫는다. 관리자 화면에서 닫아도 된다.
- 마이그레이션 없음. 기존 열(event `evidence` jsonb, reason 목록의 `process_exit`)만 쓴다.

## 판정 근거(코드: `lib/operations/dr/owner-gone-contract.ts` `judgeOwnerGone`)

시간 경과만으로 바꾸지 않는다. 행 잠금 뒤 같은 TX·DB 시계로 아래 기록을 읽고, **모두** 만족할 때만 바꾼다.

1. 행이 지금 `dispatched` 이고 전송 시각을 안다(`dispatched_at`, 없으면 `dispatch_started` event).
2. 옛 boot 가 아직 쥔 lease 가 없다 — 만료 전 `role_leases`(owner_boot_id = 옛 boot) 또는 `pipeline_item_leases` 가 있으면 `owner_holds_role_lease`/`owner_holds_item_lease` 로 거절.
3. 옛 boot 의 생존 기록 중 마지막 것(전송 자체 포함)이 quiet 창(기본 30분, `--quiet-minutes` 10분~7일) 이상 지났다. 아니면 `owner_seen_recently`.
   읽는 기록: `dr_process_group_events`(owner_opened·spawn·exit), 이 요청 이후의 장부 활동(`queued_at`·`dispatched_at`), `role_leases.updated_at`,
   `job_batch_candidates.observed_at`, 관측 `candidate:<role>:<instance>`·`worker-exit:<role>:<boot>` 의 `observed_at`.
   이 조건은 **단독 근거가 아니다** — 아래 양성 근거가 있어야 한다.
4. 양성 근거가 하나 이상 있다.
   - `successor_boot`: 같은 instance 의 **다른 boot 가 전송 뒤에 시작했다**는 기록 — 그 boot 의 프로세스 그룹 `owner_opened`(role-worker 가 boot 직후 한 번 쓴다)
     또는 역할 lease 취득 기록(`role_leases.primary_boots` 의 그 boot 항목). 그리고 그 boot 의 마지막 기록이 옛 boot 의 마지막 기록보다 늦다
     (그 instance 의 지금 프로세스는 새 boot 다). 아니면 `no_successor_boot`/`owner_newer_than_successor`.
   - `owner_exit_record`: 옛 boot 자신이 전송 뒤에 남긴 종료 기록 `worker-exit:<role>:<옛 boot>`.

근거 기록에는 owner·전송 시각·판정 시각·quiet·근거 종류·옛 boot 의 마지막 기록(시각·출처)·옛/새 boot 의 커널 boot id(owner_opened attestation)·
종료 기록 없는 spawn 수·후속 boot(시작·마지막 기록·쥔 역할 lease)·운영자를 남긴다. 커널 boot id 가 다르다는 것은 참고 정보이고 판정 조건이 아니다.

가정: `SERVICE_INSTANCE_ID` 하나에는 한 프로세스만 오래 산다(Swarm 1복제본, 교체 배포의 옛 task 는 stop grace 안에 멈춘다). `http_origin_hops` 는 instance 색인이
없어 읽지 않는다(quiet 창과 다른 기록이 그 몫을 진다).

## 안전성

- 행만 `FOR UPDATE` 로 잠그고 `UPDATE … WHERE state='dispatched'` 로 바꾼다. 이미 다른 상태(indeterminate·settled·withdrawn)면 아무것도 쓰지 않는다(`not_dispatched`).
  같은 행을 두 운영자가 동시에 돌려도 한 번만 바뀐다(시험).
- control 행은 잠그지 않는다(점유를 줄이기만 하고 control 을 쓰지 않는다). TX 마다 `lock_timeout 1s`·`statement_timeout 5s`·`transaction_timeout 15s`, 행 하나에 TX 하나.
  DR fence 가 닫힌 DB(`dr_writer_site_fenced`)에서는 아무것도 하지 않는다.
- 행의 binding·token·terminal 칸은 그대로다. 늦은 종료 근거는 indeterminate 행도 정산한다(기존 동작). 사람 검토로 닫은(withdrawn) 뒤에는 늦은 근거를 받지 않는다(기존 동작).
- indeterminate 는 슬롯을 차지하지 않는다(2026-10-30 결정, `lib/llm/capacity-states.ts`). 엔진 쪽 orphan 생성이 아직 돌고 있으면 그 엔진은 잠시 한도 이상 부하를 받을 수 있다
  — 이번 5건은 하루 이상 지났다.
- `operations_audit`·`dr_process_group_events` 는 덧붙이기만 된다. 시험도 지우지 않는다.

## 대표용 실행 순서

운영 이미지에는 `scripts/ops` 가 없다(`.dockerignore` 7행). 기존 도구(`promotion.ts`)처럼 **이 PR 이 병합된 main SHA 의 checkout 루트(`npm ci` 끝)** 에서 돌리거나,
[release-order C5](2026-10-29-release-order.md) 와 같은 `/tmp` 스테이징(같은 SHA 의 `git archive` tar, `node_modules` 는 이미지 `/app/node_modules` 심링크)에서 돌린다.
DB URL 은 stdin 한 줄로만 준다(인자·env 금지, host·port·DB 이름 명시, query 는 `sslmode` 만). 아래 `$DBURL` 은 그 한 줄이 든 0600 파일 경로다(예: 직접 연결 `/tmp/nmv-prod-db-direct`).

```bash
IDS="--request=578b94ac-1865-4ec5-8047-3471472c642b --request=aac34be2-2094-41a8-9a66-99c0c75e56b1 --request=a3955d87-2010-4eca-ab29-0be55fc1c13a --request=f0e53895-7255-4afc-bb87-71909aa3772a --request=4054e658-4643-440d-a7ab-945272ed3fd6"

# 0) 읽기 전용 확인 SELECT(아래 "근거 확인") — 5건 모두 owner_holds_* = false, successor_opened_after_dispatch 가 있거나 owner_exit_recorded_at 이 있는지.

# 1) dry-run(같은 TX 실행 뒤 ROLLBACK). 종료 코드 0 = 5건 모두 바뀔 것, 3 = 하나라도 거절(rows[].reason 확인), 1 = 오류.
node --import tsx scripts/ops/model-owner-gone.ts mark $IDS --operator=<이름> --database-url-stdin < "$DBURL"

# 2) apply(dry-run 결과가 같을 때만). 거절된 행은 그대로 남는다 — 그 id 만 빼고 다시 돌려도 된다.
node --import tsx scripts/ops/model-owner-gone.ts mark $IDS --operator=<이름> --apply --database-url-stdin < "$DBURL"

# 3) 사람 검토로 닫기(dry-run 은 상태만 읽는다: would_review). 관리자 /admin/models "확인 못함 — 사람 검토"의 검토 완료와 같다.
node --import tsx scripts/ops/model-owner-gone.ts close-review $IDS --operator=<이름> --note="소유 프로세스 부재(M3 커널 패닉·mini 예비 재시작) 확인, 결과 미상" --database-url-stdin < "$DBURL"
node --import tsx scripts/ops/model-owner-gone.ts close-review $IDS --operator=<이름> --note="소유 프로세스 부재(M3 커널 패닉·mini 예비 재시작) 확인, 결과 미상" --apply --database-url-stdin < "$DBURL"

# 4) 슬롯·모니터 확인 SELECT(아래 "결과 확인").
```

### 근거 확인(읽기 전용, `BEGIN READ ONLY; … ROLLBACK;` 안에서)

CLI dry-run 이 판정의 기준이다. 이 SELECT 는 같은 기록을 사람이 눈으로 보는 용도다(역할 lease 취득 기록 `primary_boots` 는 dry-run 만 본다).

```sql
WITH t AS (
  SELECT r.request_id, r.state, r.owner_instance_id AS inst, r.owner_boot_id::text AS boot, r.provider_budget_id, r.queue_ordinal,
    coalesce(r.dispatched_at, (SELECT min(e.created_at) FROM model_capacity_events e WHERE e.request_id = r.request_id AND e.kind = 'dispatch_started')) AS dispatch_at
  FROM model_capacity_requests r
  WHERE r.request_id IN ('578b94ac-1865-4ec5-8047-3471472c642b','aac34be2-2094-41a8-9a66-99c0c75e56b1','a3955d87-2010-4eca-ab29-0be55fc1c13a',
    'f0e53895-7255-4afc-bb87-71909aa3772a','4054e658-4643-440d-a7ab-945272ed3fd6'))
SELECT t.request_id, t.state, t.inst, left(t.boot, 8) AS boot, t.provider_budget_id, t.dispatch_at,
  greatest(t.dispatch_at,
    (SELECT max(recorded_at) FROM dr_process_group_events WHERE owner_instance_id = t.inst AND owner_boot_id = t.boot::uuid),
    (SELECT max(greatest(queued_at, coalesce(dispatched_at, queued_at))) FROM model_capacity_requests
      WHERE owner_instance_id = t.inst AND owner_boot_id = t.boot::uuid AND queue_ordinal >= t.queue_ordinal),
    (SELECT max(updated_at::timestamptz) FROM role_leases WHERE owner_instance_id = t.inst AND owner_boot_id = t.boot),
    (SELECT max(observed_at) FROM job_batch_candidates WHERE instance_id = t.inst AND boot_id = t.boot),
    (SELECT max(observed_at AT TIME ZONE 'UTC') FROM operations_observations
      WHERE (key LIKE 'candidate:%' OR key LIKE 'worker-exit:%') AND value->>'instanceId' = t.inst AND value->>'bootId' = t.boot)) AS owner_last_seen,
  EXISTS (SELECT 1 FROM role_leases WHERE owner_instance_id = t.inst AND owner_boot_id = t.boot AND lease_until > clock_timestamp()) AS owner_holds_role_lease,
  EXISTS (SELECT 1 FROM pipeline_item_leases WHERE owner_instance_id = t.inst AND owner_boot_id = t.boot::uuid AND token IS NOT NULL
    AND lease_until > clock_timestamp()) AS owner_holds_item_lease,
  (SELECT max(observed_at AT TIME ZONE 'UTC') FROM operations_observations
    WHERE key LIKE 'worker-exit:%' AND value->>'instanceId' = t.inst AND value->>'bootId' = t.boot) AS owner_exit_recorded_at,
  (SELECT string_agg(left(o.owner_boot_id::text, 8) || '@' || to_char(o.recorded_at AT TIME ZONE 'UTC', 'MM-DD"T"HH24:MI"Z"')
      || coalesce(' k=' || left(o.detail->>'kernelBootId', 8), ''), ', ' ORDER BY o.recorded_at)
    FROM dr_process_group_events o WHERE o.owner_instance_id = t.inst AND o.kind = 'owner_opened' AND o.owner_boot_id <> t.boot::uuid
      AND o.recorded_at > t.dispatch_at) AS successor_opened_after_dispatch,
  (SELECT left(detail->>'kernelBootId', 8) FROM dr_process_group_events WHERE owner_instance_id = t.inst AND owner_boot_id = t.boot::uuid
    AND kind = 'owner_opened') AS owner_kernel,
  (SELECT string_agg(role || ':' || left(owner_boot_id, 8) || CASE WHEN lease_until > clock_timestamp() THEN '(live)' ELSE '' END, ', ')
    FROM role_leases WHERE owner_instance_id = t.inst) AS instance_role_leases,
  (SELECT string_agg(key || '=' || left(value->>'bootId', 8) || '@' || to_char(observed_at, 'MM-DD"T"HH24:MI"Z"'), ', ')
    FROM operations_observations WHERE key LIKE 'candidate:%' AND value->>'instanceId' = t.inst) AS instance_candidate_now
FROM t ORDER BY t.dispatch_at;
```

통과 조건(행마다): `state = dispatched`, 두 `owner_holds_*` 가 false, `now() - owner_last_seen ≥ 30분`, 그리고
`successor_opened_after_dispatch` 에 마지막 기록이 `owner_last_seen` 보다 늦은 boot 가 있거나 `owner_exit_recorded_at ≥ dispatch_at`.
m3-text 는 M3 재부팅(11/02 13:56Z) 뒤의 새 boot 가, mini-reviewer-standby 는 11/01 14:33Z 뒤에 다시 뜬 예비 boot 가 `owner_opened` 를 남겼어야 한다
(PROCESS_GROUP_RECORDING=1 이면 boot 직후 한 번 쓴다 — 5건 모두 `spawn_not_exited` 였으니 기록기는 켜져 있었다). 없으면 dry-run 이 `no_successor_boot` 로 거절하고,
그 행은 지금 도구로 닫을 수 없다(그 경우 기록이 없는 까닭을 먼저 본다).

### 결과 확인(읽기 전용)

```sql
-- 대상 5건 상태: mark 뒤 indeterminate, close-review 뒤 withdrawn
SELECT request_id, state, provider_budget_id FROM model_capacity_requests
WHERE request_id IN ('578b94ac-1865-4ec5-8047-3471472c642b','aac34be2-2094-41a8-9a66-99c0c75e56b1','a3955d87-2010-4eca-ab29-0be55fc1c13a',
  'f0e53895-7255-4afc-bb87-71909aa3772a','4054e658-4643-440d-a7ab-945272ed3fd6');

-- event·근거
SELECT request_id, kind, reason, evidence->>'kind' AS evidence_kind, evidence->'basis' AS basis, evidence->'successor'->>'bootId' AS successor, created_at
FROM model_capacity_events
WHERE request_id IN ('578b94ac-1865-4ec5-8047-3471472c642b','aac34be2-2094-41a8-9a66-99c0c75e56b1','a3955d87-2010-4eca-ab29-0be55fc1c13a',
  'f0e53895-7255-4afc-bb87-71909aa3772a','4054e658-4643-440d-a7ab-945272ed3fd6') AND kind IN ('dispatch_indeterminate','dispatch_reviewed') ORDER BY id;

-- 감사 기록
SELECT id, actor, action, target, ok, created_at FROM operations_audit
WHERE action IN ('model-capacity-owner-gone','model-capacity-unknown-reviewed') AND target IN ('578b94ac-1865-4ec5-8047-3471472c642b',
  'aac34be2-2094-41a8-9a66-99c0c75e56b1','a3955d87-2010-4eca-ab29-0be55fc1c13a','f0e53895-7255-4afc-bb87-71909aa3772a','4054e658-4643-440d-a7ab-945272ed3fd6') ORDER BY id;

-- 슬롯: budget 별 점유(reserved+dispatched)와 검토 대기. supa-direct 점유가 4 → 지금 일하는 행 수로, gpu3090-qwen 은 1 줄어야 한다.
SELECT provider_budget_id, count(*) FILTER (WHERE state IN ('reserved','dispatched')) AS occupying, count(*) FILTER (WHERE state = 'indeterminate') AS review
FROM model_capacity_requests WHERE provider_budget_id IN ('supa-direct','gpu3090-qwen') AND state IN ('reserved','dispatched','indeterminate') GROUP BY 1;

-- 모니터 dispatch_stuck 과 같은 식(기본 1800초, lib/operations/model-capacity-unknowns.ts) — 5 → 0 이어야 경보가 풀린다.
SELECT count(*) AS stuck_dispatched FROM model_capacity_requests
WHERE state = 'dispatched' AND coalesce(dispatched_at, updated_at) < clock_timestamp() - interval '1800 seconds';
```

mark 만 하고 닫지 않으면 모니터는 `dispatch_stuck` 대신 검토 대기를 센다. 검토 나이는 전송 시각 기준이라(11/01) 이 5건은 mark 직후 바로 `review_stale`(24시간 초과)
경보가 된다 — mark 와 close-review 를 같은 창에서 이어서 한다.
