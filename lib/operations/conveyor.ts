import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates } from "@/lib/db/schema";
import { sharedStore } from "@/lib/cache/shared";
import { getSettings } from "@/lib/crawl/settings";
import { readJobBatchMode } from "@/lib/jobs/batch-repository";
import { listJobStates } from "@/lib/jobs/runner";
import { isPausedJob } from "@/lib/jobs/status";
import { logger } from "@/lib/observability/logger";
import { operationsData } from "./admin";
import { buildConveyor, type Conveyor, type ConveyorInputs } from "./conveyor-model";
import { buildStationLlm, type LlmLegacyPublish } from "./conveyor-llm";
import { readLlmInputs } from "./conveyor-llm-read";
import { hourlyThroughput } from "./dashboard";
import { pipelineFlow } from "./pipeline";
import { readPublicListing } from "./public-listing";
import { readSearchHealth } from "./search-health-model";
import { sharedLoader } from "./shared-cache";
import { sharedHumanQueueOverview } from "./shared-reads";
import { pipelineThroughput } from "./throughput";
import { buildWorkerProgress } from "./worker-progress-query";

/**
 * 전체 흐름(/admin/flow) 한 장의 읽기 — 운영센터가 쓰는 읽기를 그대로 모아 conveyor-model 로 넘긴다.
 *
 * 한 묶음이 실패해도 화면은 나간다(그 칸만 미확인). 웹 여러 대·열린 창 여러 개가 15초 나눠 쓴다(sharedLoader) —
 * 운영센터와 같은 주 DB 집계를 이 화면이 한 번 더 부르는 셈이라, 창마다 따로 세지 않게 한다. 새로고침(ops_fresh)은 1분 3번까지 건너뛴다.
 */
const conveyorCache = sharedLoader<Conveyor>({ namespace: "admin:conveyor", ttlMs: 15_000, store: sharedStore });

/** 탐색 소스 — 카탈로그 잡 이름과 화면 이름(stage-registry 의 source 단계와 같은 잡) */
const SOURCES = [
  { job: "crawl-seed", label: "GitHub 검색" },
  { job: "hn-show-seed", label: "Show HN" },
  { job: "crawl-ko-apply", label: "한국어 프로젝트" },
] as const;

const warn = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

/** 보류 사유별 수와 거절 누적 — 한 번 훑는다. 24시간은 후보의 마지막 변경 시각 기준(보류로 바뀐 때 갱신된다) */
export async function readHoldCounts(): Promise<{ holds: { reason: string; count: number; recent24h: number }[]; rejected: number }> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    return tx.execute<{ state: string; reason: string | null; count: number; recent: number }>(sql`
      SELECT ${crawlCandidates.state} AS state, coalesce(${crawlCandidates.reason}, 'unknown') AS reason, count(*)::int AS count,
        count(*) FILTER (WHERE ${crawlCandidates.updatedAt} > now() - interval '24 hours')::int AS recent
      FROM ${crawlCandidates} WHERE ${crawlCandidates.state} IN ('needs_review', 'rejected') GROUP BY 1, 2`);
  }, { accessMode: "read only" });
  const list = [...rows];
  return {
    holds: list.filter((row) => row.state === "needs_review")
      .map((row) => ({ reason: row.reason ?? "unknown", count: Number(row.count), recent24h: Number(row.recent) })),
    rejected: list.filter((row) => row.state === "rejected").reduce((total, row) => total + Number(row.count), 0),
  };
}

async function loadConveyor(fresh: boolean): Promise<Conveyor> {
  const settings = await getSettings();
  const [ops, jobStates, batch, throughput, flow, hourly, human, holds, llm, listing] = await Promise.all([
    operationsData().catch(warn("conveyor.ops_unavailable")),
    listJobStates().catch(warn("conveyor.jobs_unavailable")),
    readJobBatchMode().catch(() => ({ mode: "legacy", writerContractVersion: 0 })),
    pipelineThroughput(settings).catch(warn("conveyor.throughput_unavailable")),
    pipelineFlow().catch(warn("conveyor.flow_unavailable")),
    hourlyThroughput(undefined, { fresh }).catch(warn("conveyor.hourly_unavailable")),
    sharedHumanQueueOverview(settings, fresh).catch(warn("conveyor.human_unavailable")),
    readHoldCounts().catch(warn("conveyor.holds_unavailable")),
    readLlmInputs(new Date().toISOString()).catch(warn("conveyor.llm_unavailable")),
    readPublicListing(fresh).catch(warn("conveyor.listing_unavailable")),
  ]);
  const now = ops?.fetchedAt ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const connect = ops?.serviceInstances.filter(row => row.role === "connect-agent")
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .find(row => nowMs >= Date.parse(row.observedAt) && nowMs - Date.parse(row.observedAt) <= 45_000);
  let legacyPublish: LlmLegacyPublish | null = null;
  if (connect) {
    const value = connect.value, raw = value.config;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const config = raw as Record<string, unknown>;
      const models = [config.primary, config.fallback].flatMap((candidate, index) => {
        if (!candidate || typeof candidate !== "object") return [];
        const model = (candidate as Record<string, unknown>).model;
        if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)) return [];
        const option = Array.isArray(value.modelOptions) ? value.modelOptions.find(row => row && typeof row === "object" && row.model === model) : null;
        const provider = option?.provider;
        return [{ rank: index + 1, model, where: provider === "claude-cli" ? "Claude CLI" : provider === "codex-cli" ? "Codex CLI" : "연결 에이전트 CLI" }];
      });
      legacyPublish = { source: "connect 에이전트 CLI 설정", observedAt: connect.observedAt,
        ready: typeof value.classifyReady === "boolean" ? value.classifyReady : null, models };
    }
  }
  let progress: ConveyorInputs["progress"] = null;
  if (throughput && ops && jobStates) {
    try {
      const report = buildWorkerProgress(throughput, jobStates, ops.observations, new Date(now), batch);
      progress = { stages: report.stages, liveness: report.liveness };
    } catch (error) { warn("conveyor.progress_unavailable")(error); }
  }
  const states = new Map((jobStates ?? []).map((job) => [job.name, job]));
  const searchJob = states.get("product-search-health");
  const search = searchJob?.lastError ? null : readSearchHealth(ops?.observations.find((row) => row.key === "job:product-search-health"), nowMs);
  const inputs: ConveyorInputs = {
    now, enabled: settings.enabled, throughput, flow, hourly, human, progress, search, listing,
    holds: holds?.holds ?? null, rejected: holds?.rejected ?? null, models: llm ? buildStationLlm({ ...llm, legacyPublish }) : null,
    classification: ops ? { held: ops.held, nextRetryAt: ops.heldNextRetryAt } : null,
    sources: SOURCES.filter((source) => states.has(source.job)).map((source) => {
      const job = states.get(source.job)!;
      return { job: source.job, label: source.label, lastSuccessAt: job.lastSuccessAt ? job.lastSuccessAt.toISOString() : null,
        paused: isPausedJob(job, nowMs), failing: !!job.lastError };
    }),
  };
  return buildConveyor(inputs);
}

export function readConveyor(fresh = false): Promise<Conveyor> {
  return conveyorCache("v5", () => loadConveyor(fresh), fresh);
}
