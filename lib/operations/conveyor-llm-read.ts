import "server-only";
import { asc, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { aiTaskModels } from "@/lib/db/schema";
import { AI_TASKS } from "@/lib/llm/ai-tasks";
import { logger } from "@/lib/observability/logger";
import { listAiConnections, readAiTaskRuntime } from "./admin-ai-tasks-repository";
import { readAiTaskExecutionAdminViews } from "./admin-ai-task-execution";
import type { LlmExecutionRow, LlmConnection, LlmInputs, LlmRankRow, LlmRuntime, LlmUsedRow } from "./conveyor-llm";

/**
 * 전체 흐름 칸의 「지금 쓰는 모델」 읽기 — 읽기만 한다(새 쓰기 경로 없음).
 * - 설정한 순위: 「작업 ↔ AI 모델」 화면과 같은 목록(listAiTaskRows·listAiConnections). 키는 열지 않고 있는지만 본다.
 *   키 자동 채움(maybeFillConnectionKeys)이나 순위 스냅숏 재읽기(ensureAiTaskModels — 뒤에서 키를 채운다)는 부르지 않는다.
 * - 실제 쓰인 모델: 최근 1시간 모델 장부(model_capacity_requests)에서 state=settled 를 route·provider·model 로 센다(운영 모델 현황과 같은 정산 기준).
 *   잡은 장비 그룹(group_id)도 모은다 — 순위에 맞지 않는 호출을 provider 키 대신 장비 이름으로 보인다.
 * - 실행 쪽 순위 사정: 잡의 마지막 틱 관측(readAiTaskRuntime) — 오래된 것은 판정 쪽에서 쓰지 않는다.
 * 한 묶음이 실패하면 그 묶음만 null 이다(칸은 「확인 못함」·「설정만」으로 보이고 0 이나 정상으로 보이지 않는다).
 */
const warn = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

const LEDGER_ROUTES = [...new Set(AI_TASKS.flatMap((task) => task.routeId ? [task.routeId] : []))];

export async function readLedgerUse(): Promise<LlmUsedRow[]> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    return tx.execute<{ routeId: string; provider: string; model: string; count: number; lastAt: Date | string | null; groups: string[] | null }>(sql`
      SELECT route_id AS "routeId", provider, model, count(*)::int AS count, max(settled_at) AS "lastAt",
        array_agg(DISTINCT group_id ORDER BY group_id) AS groups
      FROM model_capacity_requests
      WHERE state = 'settled' AND settled_at >= now() - interval '1 hour' AND settled_at <= now()
        AND route_id IN (${sql.join(LEDGER_ROUTES.map((route) => sql`${route}`), sql`, `)})
      GROUP BY route_id, provider, model ORDER BY count(*) DESC LIMIT 200`);
  }, { accessMode: "read only" });
  return [...rows].map((row) => ({ routeId: row.routeId, provider: row.provider, model: row.model, count: Number(row.count),
    lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null, groups: Array.isArray(row.groups) ? row.groups.filter((group) => typeof group === "string") : [] }));
}

export async function readLlmInputs(now: string): Promise<LlmInputs> {
  const [connections, rows, used, runtime, execution] = await Promise.all([
    listAiConnections().then((list): LlmConnection[] => list.map((row) => ({ id: row.id, label: row.label, kind: row.kind, baseUrl: row.baseUrl,
      cliTool: row.cliTool, hasKey: row.hasKey, enabled: row.enabled, updatedAt: row.updatedAt }))).catch(warn("conveyor.llm_connections_unavailable")),
    // Keep the save timestamp with the same primary read; old tick failures are about the old ranks.
    onPrimary(() => db.select({ task: aiTaskModels.task, slot: aiTaskModels.slot, rank: aiTaskModels.rank,
      connectionId: aiTaskModels.connectionId, model: aiTaskModels.model, enabled: aiTaskModels.enabled, updatedAt: aiTaskModels.updatedAt })
      .from(aiTaskModels).orderBy(asc(aiTaskModels.task), asc(aiTaskModels.slot), asc(aiTaskModels.rank)))
      .then((list): LlmRankRow[] => list.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })))
      .catch(warn("conveyor.llm_ranks_unavailable")),
    readLedgerUse().catch(warn("conveyor.llm_ledger_unavailable")),
    readAiTaskRuntime().then((map): Record<string, LlmRuntime> => Object.fromEntries(Object.entries(map).map(([task, view]) => [task, {
      at: view.at, ...(view.startedAt ? { startedAt: view.startedAt } : {}), ...(view.pool ? { pool: view.pool } : {}), degraded: view.degraded ? { code: view.degraded.code, detail: view.degraded.detail } : null,
      unusable: view.unusable.map((row) => ({ rank: row.rank, code: row.code, text: row.text })) }]))).catch(warn("conveyor.llm_runtime_unavailable")),
    readAiTaskExecutionAdminViews().then((list): LlmExecutionRow[] => list.map(row => ({
      task: row.task, slot: row.slot, mode: row.mode, revision: row.revision, updatedAt: row.updatedAt,
      members: row.members.map(member => ({ memberId: member.memberId, position: member.position,
        connectionId: member.connectionId, model: member.model, deviceId: member.deviceId })),
    }))).catch(warn("conveyor.llm_execution_unavailable")),
  ]);
  return { now, connections, rows, used, runtime, execution };
}
