import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/lib/db/schema";
import { httpOriginControl } from "@/lib/db/http-origin-schema";
import { agentScanControl, jobBatchControl, modelCapacityControl, operationsAudit, pipelineStageModes } from "@/lib/db/schema";
import { AGENT_SCAN_CONSUMER_HEARTBEAT_MS, AGENT_SCAN_CONSUMER_LIVE_STATUSES, AGENT_SCAN_CONSUMER_PREFIX, beginAgentScanDrain, bumpAgentScanContract,
  completeAgentScanTransition } from "@/lib/domain/evidence/agents/claim-control";
import { beginJobBatchDrainIn, bumpJobBatchContract, completeJobBatchTransitionIn, setJobBatchPolicy } from "@/lib/jobs/batch-repository";
import { beginStageDrain, bumpStageWriterContract, completeStageTransition } from "@/lib/jobs/items/repository";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { setModelCapacityMode, setModelCapacityPolicy } from "@/lib/llm/capacity-repository";
import { setHttpOriginMode, setHttpOriginPolicy } from "@/lib/net/origin-permits";
import { adminAuditRow } from "./admin-log";
import { lockWriterFence } from "./dr/epoch";
import { controlSnapshotSchema, planPipelineControl, type ControlOptions, type ControlPlan, type ControlResult,
  type ControlSnapshot, type ModelEnv, type TransitionCommand } from "./pipeline-control";

type Database = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * 한 문장·한 DB 시계. live는 각 전환 가드와 같은 조건이다(stage: lease_until, batch: completeJobBatchTransition의 다섯 조건,
 * agent-scan: completeAgentScanTransition 의 claim lease_until). claim 표의 시각은 시간대 없는 UTC 라 c.at 을 UTC 로 바꿔 비교한다.
 */
async function snapshotIn(tx: Tx): Promise<ControlSnapshot> {
  const [row] = await tx.execute<{ snapshot: unknown }>(sql`
    WITH c AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT jsonb_build_object(
      'now', to_char(c.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'fence', (SELECT jsonb_build_object('state', state, 'writerEpoch', writer_epoch) FROM dr_writer_fence WHERE id = 1),
      'stages', (SELECT jsonb_agg(jsonb_build_object('stage', s.stage, 'mode', s.mode, 'drainingFrom', s.draining_from, 'epoch', s.epoch,
          'contract', s.writer_contract_version,
          'live', (SELECT count(*) FROM pipeline_item_leases i WHERE i.stage = s.stage AND i.lease_until > c.at),
          'unsettled', (SELECT count(*) FROM pipeline_item_leases i WHERE i.stage = s.stage AND i.token IS NOT NULL AND i.lease_until <= c.at),
          'legacyJobLive', EXISTS (SELECT 1 FROM jobs j WHERE j.name = CASE s.stage WHEN 'ai1' THEN 'crawl-agent-review' ELSE 'second-review' END
            AND j.lease_token IS NOT NULL AND j.locked_at >= c.at - ${STALE_LOCK_MS} * interval '1 millisecond'),
          -- consumer supervisor는 15초마다 service:reviewer:<SERVICE_INSTANCE_ID>를 남긴다
          'consumers', (SELECT count(*) FROM operations_observations o WHERE o.key LIKE 'service:reviewer:' || s.stage || '-consumer-%'
            AND o.observed_at >= localtimestamp - interval '2 minutes')) ORDER BY s.stage)
        FROM pipeline_stage_modes s WHERE s.stage IN ('ai1', 'ai2')),
      'capacity', (SELECT jsonb_build_object('mode', m.mode, 'epoch', m.epoch, 'revision', m.revision, 'policy', m.policy, 'policyHash', m.policy_hash,
          'waiting', (SELECT count(*) FROM model_capacity_requests WHERE state = 'waiting'),
          'reserved', (SELECT count(*) FROM model_capacity_requests WHERE state = 'reserved'),
          'dispatched', (SELECT count(*) FROM model_capacity_requests WHERE state = 'dispatched'),
          'indeterminate', (SELECT count(*) FROM model_capacity_requests WHERE state = 'indeterminate'),
          'oldGeneration', (SELECT count(*) FROM model_capacity_requests r WHERE r.state IN ('reserved', 'dispatched', 'indeterminate')
            AND (r.epoch <> m.epoch OR r.revision <> m.revision OR r.policy_hash IS DISTINCT FROM m.policy_hash)))
        FROM model_capacity_control m WHERE m.id = 1),
      'http', (SELECT jsonb_build_object('mode', h.mode, 'epoch', h.epoch, 'revision', h.revision, 'policy', h.policy, 'policyHash', h.policy_hash,
          'reserved', (SELECT count(*) FROM http_origin_hops WHERE state = 'reserved'),
          'dispatched', (SELECT count(*) FROM http_origin_hops WHERE state = 'dispatched'),
          'indeterminate', (SELECT count(*) FROM http_origin_hops WHERE state = 'indeterminate'))
        FROM http_origin_control h WHERE h.id = 1),
      'batch', (SELECT jsonb_build_object('mode', b.mode, 'drainingFrom', b.draining_from, 'epoch', b.epoch, 'contract', b.writer_contract_version,
          'policy', b.policy, 'policyHash', b.policy_hash,
          'liveJobs', (SELECT count(*) FROM jobs WHERE lease_token IS NOT NULL AND locked_at >= c.at - ${STALE_LOCK_MS} * interval '1 millisecond'),
          'liveRoles', (SELECT count(*) FROM role_leases WHERE owner_instance_id IS NOT NULL AND lease_until > c.at),
          'liveItems', (SELECT count(*) FROM pipeline_item_leases WHERE token IS NOT NULL AND lease_until > c.at),
          'liveSources', (SELECT count(*) FROM evidence_source_claims WHERE token IS NOT NULL AND lease_until > c.at),
          'liveAgentClaims', (SELECT count(*) FROM agent_repository_claims WHERE token IS NOT NULL AND lease_until > c.at AT TIME ZONE 'UTC'))
        FROM job_batch_control b WHERE b.id = 1),
      'agentScan', (SELECT jsonb_build_object('mode', a.mode, 'drainingFrom', a.draining_from, 'epoch', a.epoch, 'contract', a.writer_contract_version,
          'live', (SELECT count(*) FROM agent_repository_claims r WHERE r.token IS NOT NULL AND r.lease_until > c.at AT TIME ZONE 'UTC'),
          'unsettled', (SELECT count(*) FROM agent_repository_claims r WHERE r.token IS NOT NULL AND r.lease_until <= c.at AT TIME ZONE 'UTC'),
          -- legacy 스캔을 할 수 있는 틱이 살아 있는가: legacy 의 틱, draining(from legacy) 에서는 drain 전에 시작한 틱.
          -- drain 뒤에 시작한 틱과 items 의 틱은 컨트롤러다(GitHub 호출 없음). last_run_at 은 틱 시작(now(), 세션 시간대)이다
          'legacyJobLive', EXISTS (SELECT 1 FROM jobs j WHERE j.name = 'agent-evidence-refresh'
            AND j.lease_token IS NOT NULL AND j.locked_at >= c.at - ${STALE_LOCK_MS} * interval '1 millisecond'
            AND (a.mode = 'legacy' OR a.mode = 'draining' AND a.draining_from = 'legacy'
              AND j.last_run_at::timestamptz <= a.updated_at AT TIME ZONE 'UTC')),
          -- consumer 감독은 15초마다 service:crawler:<SERVICE_INSTANCE_ID>를 남긴다. 운영센터 consumer_missing 과 같은 기준(running·starting,
          -- 2분 안)이다. observed_at 은 시간대 없는 UTC 라 세션 시간대(localtimestamp)가 아니라 c.at 을 UTC 로 바꿔 비교한다
          'consumers', (SELECT count(*) FROM operations_observations o WHERE o.key LIKE ${`service:crawler:${AGENT_SCAN_CONSUMER_PREFIX}%`}
            AND o.value->>'status' IN (${sql.join(AGENT_SCAN_CONSUMER_LIVE_STATUSES.map(status => sql`${status}`), sql`, `)})
            AND o.observed_at >= (c.at AT TIME ZONE 'UTC') - ${AGENT_SCAN_CONSUMER_HEARTBEAT_MS} * interval '1 millisecond'),
          'queue', coalesce((SELECT jsonb_agg(jsonb_build_object('priority', q.priority, 'waiting', q.waiting, 'oldestMinutes', q.oldest) ORDER BY q.priority)
            FROM (SELECT r.priority, count(*) FILTER (WHERE r.ready) AS waiting,
                round((extract(epoch FROM (c.at AT TIME ZONE 'UTC') - min(r.ready_at) FILTER (WHERE r.ready)) / 60)::numeric, 1) AS oldest
              FROM (SELECT priority, greatest(due_at, retry_after) AS ready_at,
                  greatest(due_at, retry_after) <= c.at AT TIME ZONE 'UTC' AND (token IS NULL OR lease_until <= c.at AT TIME ZONE 'UTC') AS ready
                FROM agent_repository_claims WHERE state = 'active') r GROUP BY r.priority) q), '[]'::jsonb))
        FROM agent_scan_control a WHERE a.id = 1),
      'recentInstances', coalesce((SELECT jsonb_agg(DISTINCT split_part(o.key, ':', 3) ORDER BY split_part(o.key, ':', 3))
        FROM operations_observations o WHERE o.key LIKE 'service:%:%' AND o.key NOT LIKE 'service:scheduler:%'
          AND o.observed_at >= localtimestamp - interval '24 hours'), '[]'::jsonb),
      'reviewSettings', (SELECT s."values" FROM crawl_settings s WHERE s.id = 1),
      -- product_audit_one_running_idx: 실행 중 감사는 많아야 하나다
      'auditCampaign', (SELECT jsonb_build_object('provider', a.provider, 'model', a.model) FROM product_audit_campaigns a WHERE a.status = 'running')
    ) AS snapshot FROM c`);
  return controlSnapshotSchema.parse(row?.snapshot);
}

/** 읽기 전용 TX. dry-run과 status는 이것만 쓴다(행 잠금·쓰기 0). */
export function readControlSnapshot(database: Database): Promise<ControlSnapshot> {
  return database.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    return snapshotIn(tx);
  });
}

class Rejected extends Error { constructor(readonly plan: ControlPlan, readonly snapshot: ControlSnapshot) { super("pipeline_control_rejected"); } }

/** 판정 대상 control 행. fence 다음 첫 control lock이며 전환 함수가 같은 행을 다시 잠근다(같은 TX라 대기 없음). */
async function lockTarget(tx: Tx, command: TransitionCommand): Promise<void> {
  const stage = (command.options as ControlOptions).stage;
  if (command.area === "stage") await tx.select({ stage: pipelineStageModes.stage }).from(pipelineStageModes).where(eq(pipelineStageModes.stage, stage)).for("update");
  else {
    const table = { capacity: modelCapacityControl, http: httpOriginControl, batch: jobBatchControl, "agent-scan": agentScanControl }[command.area];
    await tx.select({ id: table.id }).from(table).where(eq(table.id, 1)).for("update");
  }
}

/** 상태 전환은 기존 repository 함수로만 한다. 이 파일은 control 행에 직접 쓰지 않는다. */
async function transition(tx: Tx, command: TransitionCommand, policyFile: unknown): Promise<void> {
  const o = command.options as ControlOptions;
  switch (command.name) {
    case "stage drain": await beginStageDrain(tx, o.stage); return;
    case "stage complete": await completeStageTransition(tx, o.stage, o.to as "legacy" | "items"); return;
    case "stage contract": await bumpStageWriterContract(tx, o.stage); return;
    case "capacity policy": await setModelCapacityPolicy(tx, policyFile); return;
    case "capacity mode": await setModelCapacityMode(tx, o.to as "disabled" | "draining" | "open"); return;
    case "http policy": await setHttpOriginPolicy(tx, policyFile); return;
    case "http mode": await setHttpOriginMode(tx, o.to as "disabled" | "draining" | "open"); return;
    case "batch policy": await setJobBatchPolicy(tx, policyFile); return;
    case "batch contract": await bumpJobBatchContract(tx); return;
    case "batch drain": await beginJobBatchDrainIn(tx); return;
    case "batch complete": await completeJobBatchTransitionIn(tx, o.to as "legacy" | "versioned"); return;
    case "agent-scan contract": await bumpAgentScanContract(tx); return;
    case "agent-scan drain": await beginAgentScanDrain(tx); return;
    case "agent-scan complete": await completeAgentScanTransition(tx, o.to as "legacy" | "items"); return;
  }
}

function areaState(snapshot: ControlSnapshot, command: TransitionCommand): unknown {
  if (command.area === "agent-scan") return snapshot.agentScan;
  if (command.area !== "stage") return snapshot[command.area];
  return snapshot.stages.find(row => row.stage === (command.options as ControlOptions).stage);
}

/**
 * 기본 dry-run: 읽기 전용 readback과 계획만 낸다. --execute면 한 TX에서 fence(share) → 대상 control 행(update)을 잡고
 * 잠근 상태로 같은 계획을 다시 세워 기대 상태(compare-and-set)를 확인한 뒤 기존 전환 함수와 관리자 작업 로그를 함께 commit한다.
 * 계획·가드 어느 쪽이든 거절되면 TX 전체가 rollback된다.
 */
export async function runPipelineControl(database: Database, command: TransitionCommand, policyFile?: unknown,
  models: ModelEnv | null = null): Promise<ControlResult> {
  const before = await readControlSnapshot(database);
  const plan = planPipelineControl(command, before, policyFile, models);
  if (!command.execute || plan.blocked.length) return { command: command.name, dryRun: !command.execute, executed: false, blocked: plan.blocked.length > 0, plan, before };
  const o = command.options as ControlOptions;
  let executed: { plan: ControlPlan; before: ControlSnapshot; auditId: number };
  try {
    executed = await database.transaction(async tx => {
      await lockWriterFence(tx, "share");
      await lockTarget(tx, command);
      const locked = await snapshotIn(tx);
      const checked = planPipelineControl(command, locked, policyFile, models);
      if (checked.blocked.length) throw new Rejected(checked, locked);
      await transition(tx, command, policyFile);
      const after = await snapshotIn(tx);
      const row = await adminAuditRow(o.operator, { action: `pipeline-control-${command.name.replace(" ", "-")}`, target: checked.target,
        detail: { reason: o.reason, expected: command.options, change: checked.change, warnings: checked.warnings,
          policyHash: checked.policyHash ?? null, before: areaState(locked, command), after: areaState(after, command) } });
      // 운영 CLI에는 로그인 방식이 없다 — 스크립트 행 관례(actor_kind 없음)로 남긴다.
      const [audit] = await tx.insert(operationsAudit).values({ ...row, actorKind: null }).returning({ id: operationsAudit.id });
      return { plan: checked, before: locked, auditId: audit.id };
    });
  } catch (error) {
    if (error instanceof Rejected) return { command: command.name, dryRun: false, executed: false, blocked: true, plan: error.plan, before: error.snapshot };
    throw error;
  }
  return { command: command.name, dryRun: false, executed: true, blocked: false, ...executed, after: await readControlSnapshot(database) };
}
