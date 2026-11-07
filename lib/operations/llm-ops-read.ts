import "server-only";
import { and, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { listJobStates } from "@/lib/jobs/runner";
import { isPausedJob } from "@/lib/jobs/status";
import { ensureServingContracts, servingContractSnapshot } from "@/lib/llm/serving-contract-store";
import { secretBoxReady } from "@/lib/security/secret-box";
import { readAiTaskExecutionAdminViews } from "./admin-ai-task-execution";
import { listAiConnections, listAiTaskRows, readAiTaskRuntime } from "./admin-ai-tasks-repository";
import type { AdminLogRow } from "./admin-log";
import type { AdminModelsObservation } from "./admin-models-observation";
import { readAdminModelsObservation } from "./admin-models-repository";
import { readConveyor } from "./conveyor";
import { LLM_HISTORY_ACTIONS, LLM_HISTORY_KINDS, type LlmHistoryFilter } from "./llm-ops-history";
import { canRequeueUnknownRoute } from "./model-capacity-requeue";
import { readModelCapacityReviewQueue, type CapacityReviewQueue } from "./model-capacity-unknowns";
import type { OpsState } from "./ops-runner/contract";
import { buildDashboardView, buildLlmOpsView, CLI_VERSION_PATTERN, parseClassifierObservation, type DashboardView, type JobPause, type LlmClassifierInput, type LlmCliContractInput, type LlmOpsView } from "./llm-ops-view";

/**
 * 「LLM 운영」 개편(PR 1·2)의 읽기 — 화면마다 필요한 것만 읽는다(예전에는 탭 다섯이 같은 읽기 일곱 개를 기다렸다).
 * 모두 읽기 전용이고 기존 읽기 함수를 그대로 부른다. 하나를 못 읽어도 화면은 뜬다(그 칸은 「확인 불가」).
 */

/** 잡마다 사람이 멈췄는가(not_before 를 먼 미래로 민 것). 못 읽으면 null. */
export async function readJobPauses(now = Date.now()): Promise<JobPause[] | null> {
  try { return (await listJobStates()).map(job => ({ name: job.name, paused: isPausedJob(job, now) })); }
  catch { return null; }
}

const CLI_ROUTE = /^cli:([a-z0-9-]{1,40}):(.{1,120})$/;
/** DB CLI 계약(cli:<provider>:<route>)의 이름·버전만 — 키·명령·주소는 읽지 않는다. 스냅숏은 프로세스 안에서 30초 나눠 쓴다. */
export async function readCliContracts(): Promise<LlmCliContractInput[] | null> {
  try {
    await ensureServingContracts();
    return servingContractSnapshot().rows.flatMap(row => {
      const match = CLI_ROUTE.exec(row.routeId);
      if (!match) return [];
      const contract = row.contract && typeof row.contract === "object" ? row.contract as Record<string, unknown> : {};
      const version = typeof contract.cliVersion === "string" && CLI_VERSION_PATTERN.test(contract.cliVersion) ? contract.cliVersion : null;
      return [{ provider: match[1], routeId: match[2], model: row.model, cliVersion: version }];
    });
  } catch { return null; }
}

/**
 * connect 에이전트(카테고리 분류)가 마지막으로 남긴 관측 한 줄 — 에이전트를 부르지 않는다(/admin/status?tab=ai 의 연결 확인과 다르다). 못 읽으면 null.
 */
export async function readClassifierObservation(now = Date.now()): Promise<LlmClassifierInput | null> {
  try {
    const [row] = await onPrimary(() => db.execute<{ observedAt: string; value: unknown }>(sql`
      SELECT to_char(observed_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt", value
      FROM operations_observations WHERE key LIKE 'service:connect-agent:%' ORDER BY observed_at DESC LIMIT 1`));
    return row ? parseClassifierObservation(row.observedAt, row.value, now) : null;
  } catch { return null; }
}

/** 대시보드 — 장부 관측(처리량 표본 없이)·흐름 관측(15초 공유 캐시)·잡 멈춤·연결·접수 작업 진행. */
export async function readModelsDashboard(): Promise<{ view: DashboardView; observation: AdminModelsObservation; opsStates: OpsState[] }> {
  const { readModelOpsStates } = await import("./ops-runner/repository");
  const [observation, conveyor, jobs, connections, opsStates] = await Promise.all([
    readAdminModelsObservation({ throughput: false }),
    readConveyor(false).catch(() => null),
    readJobPauses(),
    listAiConnections().catch(() => null),
    readModelOpsStates().catch((): OpsState[] => []),
  ]);
  return { view: buildDashboardView({ now: new Date().toISOString(), observation, conveyor, jobs, connections, requeueSupported: canRequeueUnknownRoute }), observation, opsStates };
}

/** LLM 운영 — 연결·순위·분산 구성·실행 쪽 순위 사정·장부 관측·잡 멈춤·CLI 계약·분류 에이전트 관측. 연결 확인(네트워크)은 하지 않는다. */
export async function readLlmOps(): Promise<{ view: LlmOpsView; secretBox: boolean }> {
  const now = new Date();
  const [observation, connections, rows, executions, runtime, jobs, cliContracts, classifier] = await Promise.all([
    readAdminModelsObservation({ throughput: false }),
    listAiConnections().catch(() => null),
    listAiTaskRows().catch(() => null),
    readAiTaskExecutionAdminViews().catch(() => null),
    readAiTaskRuntime().catch(() => null),
    readJobPauses(now.getTime()),
    readCliContracts(),
    readClassifierObservation(now.getTime()),
  ]);
  return { view: buildLlmOpsView({ now: now.toISOString(), observation, connections, rows, executions, runtime, jobs, cliContracts, classifier }), secretBox: secretBoxReady() };
}

export type LlmChangeLog = Readonly<{ rows: AdminLogRow[]; more: boolean; error: string | null }>;
/** 변경 기록 한 표 — 작업 로그(operations_audit)의 「LLM 운영」 작업만, 갈래·실패만·이전 쪽(before id)으로 거른다. 못 읽으면 error. */
export async function readLlmChangeLog(filter: LlmHistoryFilter, limit = 40): Promise<LlmChangeLog> {
  try {
    const where: SQL[] = [inArray(operationsAudit.action, [...(filter.kind ? LLM_HISTORY_KINDS[filter.kind].actions : LLM_HISTORY_ACTIONS)])];
    if (filter.failedOnly) where.push(eq(operationsAudit.ok, false));
    if (filter.before) where.push(lt(operationsAudit.id, filter.before));
    const rows = await db.select().from(operationsAudit).where(and(...where)).orderBy(desc(operationsAudit.id)).limit(limit + 1);
    return { rows: rows.slice(0, limit), more: rows.length > limit, error: null };
  } catch (error) { return { rows: [], more: false, error: error instanceof Error ? error.message : "read_failed" }; }
}

/** 기록 — 재실행 대기(장부 검토 목록)·열린 호출과 1시간 정산(장부 관측)·변경 기록. 하나를 못 읽어도 화면은 뜬다. */
export async function readLlmHistory(filter: LlmHistoryFilter): Promise<{ queue: CapacityReviewQueue; observation: AdminModelsObservation; changes: LlmChangeLog }> {
  const [queue, observation, changes] = await Promise.all([readModelCapacityReviewQueue(), readAdminModelsObservation({ throughput: false }), readLlmChangeLog(filter)]);
  return { queue, observation, changes };
}
