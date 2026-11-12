import "server-only";
import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { sharedStore } from "@/lib/cache/shared";
import { logger } from "@/lib/observability/logger";
import { secretBoxReady } from "@/lib/security/secret-box";
import { listAiConnections, listAiTaskRows } from "./admin-ai-tasks-repository";
import { readAiTaskExecutionAdminViews } from "./admin-ai-task-execution";
import { readAdminModelsObservation } from "./admin-models-repository";
import { buildConsoleTasks, type ConsoleTaskBoard } from "./console-tasks";
import { readConsoleHome } from "./console-home-read";
import { readJobPauses } from "./llm-ops-read";
import { buildModelConsole, type ModelConsoleView, type ModelDeviceState, type ModelLedgerRow } from "./model-console";
import { sharedLoader } from "./shared-cache";

/**
 * 운영 콘솔 「모델」 화면의 읽기(2026-11-12 조각 3a). 모두 읽기 전용이고 기존 읽기를 그대로 부른다 — 연결·순위는 목록 읽기(listAiConnections ·
 * listAiTaskRows — 키 채우기 쓰기가 없는 읽기), 작업 분산 구성원, 장비 점유(readAdminModelsObservation), 잡 멈춤, 24시간 장부.
 * 읽기마다 따로 실패한다 — 하나가 실패하면 그 값만 null 이고 화면은 그 칸을 「—」로 둔다.
 * 24시간 장부는 홈(console-home-read)과 같은 창·같은 묶음에 미확정 수를 더한 것이고, 웹 여러 대가 공유 캐시로 나눠 센다.
 */

const ledgerCache = sharedLoader<ModelLedgerRow[]>({ namespace: "admin:models:ledger24h", ttlMs: 60_000, staleMs: 600_000, store: sharedStore });

const quiet = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

/**
 * 24시간 장부 — route·장비·모델로 묶은 호출·정산·평균 응답·결과 없이 끝난 수·미확정 수. 창은 색인이 있는 시각으로 잡는다
 * (정산 settled_at · 철회 updated_at · 미확정 보낸 시각) — 홈 할 일(console-home-read loadLedger24h)과 같은 식에 미확정 칸만 더했다.
 */
async function loadModelLedger24h(): Promise<ModelLedgerRow[]> {
  return withDbDeadline(Date.now() + 4000, () => onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    const rows = await tx.execute<{ routeId: string; groupId: string; model: string; calls: number; settled: number; avgSeconds: number | null; noResult: number; indeterminate: number }>(sql`
      SELECT route_id AS "routeId", group_id AS "groupId", model,
        count(*)::int AS calls,
        count(*) FILTER (WHERE state = 'settled')::int AS settled,
        (avg(extract(epoch FROM settled_at - dispatched_at)) FILTER (WHERE state = 'settled'))::float8 AS "avgSeconds",
        count(*) FILTER (WHERE state = 'settled' AND terminal_evidence->>'kind' IN ('gateway_http_rejected', 'gateway_not_started'))::int AS "noResult",
        count(*) FILTER (WHERE state = 'indeterminate')::int AS indeterminate
      FROM model_capacity_requests
      WHERE (state = 'settled' AND settled_at >= transaction_timestamp() - interval '24 hours')
        OR (state = 'withdrawn' AND updated_at >= transaction_timestamp() - interval '24 hours')
        OR (state = 'indeterminate' AND coalesce(dispatched_at, updated_at) >= transaction_timestamp() - interval '24 hours')
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3 LIMIT 2001`);
    const list = Array.from(rows);
    if (list.length > 2000) throw new Error("model_ledger_truncated");
    return list.map(row => ({ routeId: row.routeId, groupId: row.groupId, model: row.model, calls: Number(row.calls), settled: Number(row.settled),
      avgSeconds: row.avgSeconds === null ? null : Number(row.avgSeconds), noResult: Number(row.noResult), indeterminate: Number(row.indeterminate) }));
  }, { accessMode: "read only" })));
}

export type ModelConsoleRead = { view: ModelConsoleView; devices: readonly ModelDeviceState[] | null; secretBox: boolean;
  admission: { mode: "open" | "draining" | "disabled"; since: string | null } | null };

export async function readModelConsole(fresh = false): Promise<ModelConsoleRead> {
  const now = new Date();
  const [connections, ranks, executions, observation, ledger, jobs] = await Promise.all([
    listAiConnections().catch(quiet("models.connections_unavailable")),
    listAiTaskRows().catch(quiet("models.ranks_unavailable")),
    readAiTaskExecutionAdminViews().catch(quiet("models.executions_unavailable")),
    readAdminModelsObservation({ throughput: false }).catch(quiet("models.observation_unavailable")),
    ledgerCache("v1", loadModelLedger24h, fresh).catch(quiet("models.ledger_unavailable")),
    readJobPauses(now.getTime()),
  ]);
  const devices: ModelDeviceState[] | null = observation && !observation.error && observation.devicesRead
    ? observation.devices.map(device => ({ deviceId: device.deviceId, source: device.source, limitSlots: device.limitSlots, active: device.active, version: device.version,
      models: (device.models ?? []).map(model => ({ model: model.model, active: model.active, maxSlots: model.maxSlots ?? null, engineMax: model.engineMax ?? null })) }))
    : null;
  const view = buildModelConsole({
    now: now.toISOString(), connections, ledger, devices,
    ranks: ranks?.map(row => ({ task: row.task, slot: row.slot, rank: row.rank, connectionId: row.connectionId, model: row.model, enabled: row.enabled })) ?? null,
    pools: executions?.filter(row => row.mode === "workload_pool").flatMap(row => row.members.map(member => ({ task: row.task, slot: row.slot,
      connectionId: member.connectionId, model: member.model }))) ?? null,
    pausedJobs: jobs ? jobs.filter(job => job.paused).map(job => job.name) : null,
  });
  return { view, devices, secretBox: secretBoxReady(),
    admission: observation?.mode ? { mode: observation.mode, since: observation.controlUpdatedAt } : null };
}

/** 쌓인 단계(지금 속도로 며칠) — 홈 할 일과 같은 읽기·같은 규칙(console-tasks)을 쓴다. 못 읽으면 null */
export async function readModelBacklog(): Promise<ConsoleTaskBoard | null> {
  try { return buildConsoleTasks((await readConsoleHome()).inputs); }
  catch (error) { return quiet("models.backlog_unavailable")(error); }
}
