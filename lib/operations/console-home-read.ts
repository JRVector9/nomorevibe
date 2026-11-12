import "server-only";
import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { sharedStore } from "@/lib/cache/shared";
import { openBacklogStats } from "@/lib/crawl/audit-policy";
import { getSettings } from "@/lib/crawl/settings";
import { listJobStates } from "@/lib/jobs/runner";
import { isPausedJob } from "@/lib/jobs/status";
import { logger } from "@/lib/observability/logger";
import { listAiConnections, listAiTaskRows } from "./admin-ai-tasks-repository";
import { readAiTaskExecutionAdminViews } from "./admin-ai-task-execution";
import { adminJobControlVersions } from "./admin-job-control";
import { readAdminModelsObservation } from "./admin-models-repository";
import { readConveyor } from "./conveyor";
import type { Conveyor } from "./conveyor-model";
import type { ConsoleConnection, ConsoleDevice, ConsoleJob, ConsoleLedgerRow, ConsolePoolMember, ConsoleProgress, ConsoleRank, ConsoleTaskInputs } from "./console-tasks";
import { sharedInbox } from "./inbox";
import { sharedLoader } from "./shared-cache";
import { sharedHumanQueueOverview } from "./shared-reads";
import { readWorkerProgress } from "./worker-progress-query";

/**
 * 운영 콘솔 홈(할 일 + 흐름)의 읽기 — 관리자 화면이 이미 쓰는 읽기를 모은다. 쓰기는 하지 않는다
 * (readAiTasksAdminView 는 연결 키를 채우는 쓰기를 하므로 부르지 않고, 연결·순위는 목록 읽기만 쓴다).
 *
 * 읽기마다 따로 실패한다 — 하나가 실패하면 그 값만 null 이고, 할 일 규칙(console-tasks.ts)이 그 규칙만 「셀 수 없음」으로 남긴다.
 * 무거운 집계(워커 진행 · 24시간 장부 · 장비 점유 · 감사 적체)는 전체 흐름(conveyor.ts)과 같은 공유 캐시(sharedLoader, Valkey)로 웹 여러 대가 나눠 쓰고,
 * 담긴 값이 조금 지났으면 화면을 기다리게 하지 않고 그 값을 주며 뒤에서 다시 센다(staleMs) — 화면의 「마지막 확인」 시각이 함께 보인다.
 */

const progressCache = sharedLoader<ConsoleProgress>({ namespace: "admin:console:progress", ttlMs: 30_000, staleMs: 300_000, store: sharedStore });
const ledgerCache = sharedLoader<ConsoleLedgerRow[]>({ namespace: "admin:console:ledger24h", ttlMs: 60_000, staleMs: 600_000, store: sharedStore });
type Capacity = { admission: ConsoleTaskInputs["admission"]; devices: ConsoleDevice[] | null };
const capacityCache = sharedLoader<Capacity>({ namespace: "admin:console:capacity", ttlMs: 15_000, staleMs: 120_000, store: sharedStore });
const auditCache = sharedLoader<NonNullable<ConsoleTaskInputs["audit"]>>({ namespace: "admin:console:audit-backlog", ttlMs: 60_000, staleMs: 600_000, store: sharedStore });

const quiet = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

/**
 * 24시간 장부 — route·장비(group)·모델로 묶은 호출·정산·평균 응답·결과 없이 끝난 수(시안 build.py ledger24h 와 같은 묶음).
 * 창은 색인이 있는 시각으로 잡는다: 정산(settled_at)·철회(updated_at)·미확정(보낸 시각) 24시간. 호출 = 셋의 합(아직 도는 행은 빼고 센다).
 * 결과 없이 끝남 = 공급자가 처리 전에 거절(gateway_http_rejected)했거나 보내지 못한(gateway_not_started) 정산.
 */
async function loadLedger24h(): Promise<ConsoleLedgerRow[]> {
  return withDbDeadline(Date.now() + 4000, () => onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    const rows = await tx.execute<{ routeId: string; groupId: string; model: string; calls: number; settled: number; avgSeconds: number | null; noResult: number }>(sql`
      SELECT route_id AS "routeId", group_id AS "groupId", model,
        count(*)::int AS calls,
        count(*) FILTER (WHERE state = 'settled')::int AS settled,
        (avg(extract(epoch FROM settled_at - dispatched_at)) FILTER (WHERE state = 'settled'))::float8 AS "avgSeconds",
        count(*) FILTER (WHERE state = 'settled' AND terminal_evidence->>'kind' IN ('gateway_http_rejected', 'gateway_not_started'))::int AS "noResult"
      FROM model_capacity_requests
      WHERE (state = 'settled' AND settled_at >= transaction_timestamp() - interval '24 hours')
        OR (state = 'withdrawn' AND updated_at >= transaction_timestamp() - interval '24 hours')
        OR (state = 'indeterminate' AND coalesce(dispatched_at, updated_at) >= transaction_timestamp() - interval '24 hours')
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3 LIMIT 2001`);
    const list = Array.from(rows);
    if (list.length > 2000) throw new Error("console_ledger_truncated");
    return list.map(row => ({ routeId: row.routeId, groupId: row.groupId, model: row.model, calls: Number(row.calls), settled: Number(row.settled),
      avgSeconds: row.avgSeconds === null ? null : Number(row.avgSeconds), noResult: Number(row.noResult) }));
  }, { accessMode: "read only" })));
}

async function loadProgress(): Promise<ConsoleProgress> {
  const report = await readWorkerProgress(new Date(), { includeText: true });
  return {
    stages: report.stages.map(stage => ({ stage: stage.stage, job: stage.job ?? null, reason: stage.reason, alarm: stage.alarm,
      waiting: stage.waiting ?? null, oldestMinutes: stage.oldestMinutes ?? null, completed5m: stage.completed5m ?? null,
      skipBlock: stage.skipBlock ? { reason: stage.skipBlock.reason, code: stage.skipBlock.code, detail: stage.skipBlock.detail } : null })),
    liveness: report.liveness.map(row => ({ role: row.role, reason: row.reason })),
  };
}

async function loadCapacity(): Promise<Capacity> {
  const observation = await readAdminModelsObservation({ throughput: false });
  // 못 읽은 관측(error)은 담지 않는다 — 다음 부름이 다시 센다
  if (observation.error || !observation.mode) throw new Error("console_capacity_unavailable");
  return {
    admission: { mode: observation.mode, since: observation.controlUpdatedAt },
    devices: observation.devicesRead ? observation.devices.map(device => ({ deviceId: device.deviceId, active: device.active,
      models: (device.models ?? []).map(model => ({ model: model.model, active: model.active })) })) : null,
  };
}

export type ConsoleJobControl = { paused: boolean; notBefore: string | null; version: number };

export type ConsoleHomeRead = {
  /** 이 읽기를 시작한 시각 — 할 일의 「마지막 확인」 */
  checkedAt: string;
  inputs: ConsoleTaskInputs;
  conveyor: Conveyor | null;
  /** 할 일의 「재개」가 쓰는 작업 제어 상태 — 기존 JobControl 과 같은 값(멈춘 작업만) */
  jobControls: Record<string, ConsoleJobControl>;
};

export async function readConsoleHome(fresh = false): Promise<ConsoleHomeRead> {
  const checkedAt = new Date();
  const [conveyor, progress, ledger, capacity, audit, jobRows, versions, connections, ranks, executions, inbox, agreed] = await Promise.all([
    readConveyor(fresh).catch(quiet("console.conveyor_unavailable")),
    progressCache("v1", loadProgress, fresh).catch(quiet("console.progress_unavailable")),
    ledgerCache("v1", loadLedger24h, fresh).catch(quiet("console.ledger_unavailable")),
    capacityCache("v1", loadCapacity, fresh).catch(quiet("console.capacity_unavailable")),
    auditCache("v1", async () => {
      const stats = await openBacklogStats();
      return { open: stats.open, overdue: stats.overdue, oldestWaitDays: stats.oldestWaitDays };
    }, fresh).catch(quiet("console.audit_unavailable")),
    listJobStates().catch(quiet("console.jobs_unavailable")),
    adminJobControlVersions().catch(quiet("console.job_versions_unavailable")),
    listAiConnections().catch(quiet("console.connections_unavailable")),
    listAiTaskRows().catch(quiet("console.ranks_unavailable")),
    readAiTaskExecutionAdminViews().catch(quiet("console.executions_unavailable")),
    sharedInbox(fresh).catch(quiet("console.inbox_unavailable")),
    getSettings().then(settings => sharedHumanQueueOverview(settings, fresh)).then(overview => overview.agreed)
      .catch(quiet("console.human_overview_unavailable")),
  ]);
  const now = checkedAt.getTime();
  const jobs: ConsoleJob[] | null = jobRows?.map(job => ({ name: job.name, paused: isPausedJob(job, now), lastRunAt: job.lastRunAt?.toISOString() ?? null,
    notBefore: job.notBefore?.toISOString() ?? null })) ?? null;
  const takedown = inbox?.results.takedown;
  return {
    checkedAt: checkedAt.toISOString(), conveyor,
    inputs: {
      now: checkedAt.toISOString(),
      conveyor, progress, jobs,
      admission: capacity?.admission ?? null,
      takedown: takedown?.ok ? { count: takedown.data.count, overdue: takedown.data.overdue ?? 0 } : null,
      agreed: agreed ? { approve: agreed.approve, reject: agreed.reject } : null,
      audit,
      connections: connections?.map((row): ConsoleConnection => ({ id: row.id, label: row.label, kind: row.kind, cliTool: row.cliTool, deviceId: row.deviceId,
        capacitySlots: row.capacitySlots, enabled: row.enabled,
        models: [...new Set([...(row.models ?? []).map(model => model.id), ...row.cliModels, ...(row.manualModels ?? [])])],
        allowedTasks: [...(row.allowedTasks ?? [])], keySetAt: row.keySetAt ?? null, keyValidDays: row.keyValidDays ?? null, updatedAt: row.updatedAt })) ?? null,
      ranks: ranks?.map((row): ConsoleRank => ({ task: row.task, slot: row.slot, rank: row.rank, connectionId: row.connectionId, model: row.model, enabled: row.enabled })) ?? null,
      pools: executions?.filter(row => row.mode === "workload_pool")
        .flatMap(row => row.members.map((member): ConsolePoolMember => ({ task: row.task, slot: row.slot, connectionId: member.connectionId, model: member.model }))) ?? null,
      devices: capacity?.devices ?? null,
      ledger,
    },
    // 제어 판(작업 로그 id)을 못 읽으면 그 자리 조작을 내지 않는다 — 단추는 작업 상세로 보낸다
    jobControls: !versions ? {} : Object.fromEntries((jobs ?? []).filter(job => job.paused)
      .map(job => [job.name, { paused: true, notBefore: job.notBefore ?? null, version: versions[job.name] ?? 0 }])),
  };
}
