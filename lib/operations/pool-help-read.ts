import "server-only";
import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { getSettings } from "@/lib/crawl/settings";
import { AI_TASK_WORKLOAD_POOL_TASKS, aiTaskPoolFeatures } from "@/lib/llm/ai-task-execution-config";
import { DEFAULT_MODEL_DEFINITIONS, readModelRegistry, type ModelDefinition } from "@/lib/llm/model-registry";
import { PRODUCT_TRANSLATION_SELECTION_ROUNDS } from "@/lib/jobs/products/translation-rounds";
import { logger } from "@/lib/observability/logger";
import { LIMITS_TASKS } from "./admin-limits-view";
import { readRuntimeSettingsRow } from "./runtime-settings";
import { resolveRuntimeSettings, type RuntimeSettings } from "./runtime-settings-schema";
import type { PoolHelpBase, PoolHelpContext, PoolHelpDevice } from "./pool-help";

/** 1차 심사 잡이 한 틱에 함께 보는 후보 수의 상한(lib/crawl/jobs/agent-review.ts MAX_CONCURRENT_REVIEWS) — 수집·판정 설정의 상한(16)과 같다 */
const REVIEW_CONCURRENCY_MAX = 16;

const quiet = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

/** model_capacity_devices 의 jsonb 줄 → 장비 한 줄(모양이 틀린 모델 줄은 버린다) */
export function poolHelpDevicesFromRows(rows: readonly { deviceId: string; limitSlots: number | string | null; enabled: boolean; modelLimits: unknown }[]): PoolHelpDevice[] {
  return rows.map(row => ({ deviceId: row.deviceId, limitSlots: row.limitSlots === null || !Number.isFinite(Number(row.limitSlots)) ? null : Number(row.limitSlots),
    enabled: row.enabled === true,
    modelLimits: (Array.isArray(row.modelLimits) ? row.modelLimits : []).flatMap(limit => limit && typeof limit === "object"
      && typeof (limit as { model?: unknown }).model === "string" && Number.isFinite(Number((limit as { max_slots?: unknown }).max_slots))
      ? [{ model: (limit as { model: string }).model, maxSlots: Number((limit as { max_slots: unknown }).max_slots) }] : []) }));
}

/**
 * 칸 수를 비웠을 때의 동시 처리 수 — 「동시에」를 받고 칸 수를 따르는 작업마다(실행 쪽 그대로).
 * 글 작업은 실시간 한도의 「<작업> 동시 호출」(routes.limits.<경로>.concurrency — 저장값, 없으면 기본값), 사유 번역은 한 줄,
 * 1차 심사는 수집·판정 설정의 심사 동시 수, 2차 심사는 jobs.second-review.consumerConcurrency.
 */
export function poolHelpBases(settings: RuntimeSettings | null, reviewConcurrency: number | null): Record<string, PoolHelpBase> {
  const out: Record<string, PoolHelpBase> = {};
  for (const task of AI_TASK_WORKLOAD_POOL_TASKS) {
    if (!aiTaskPoolFeatures(task).slotCaps) continue;
    if (task === "reason-translate") { out[task] = { kind: "one" }; continue; }
    if (task === "first-review") { out[task] = { kind: "review", value: reviewConcurrency === null ? null : Math.min(reviewConcurrency, REVIEW_CONCURRENCY_MAX), max: REVIEW_CONCURRENCY_MAX }; continue; }
    if (task === "second-review") {
      const value = settings?.jobs["second-review"]?.consumerConcurrency;
      out[task] = { kind: "consumer", path: "jobs.second-review.consumerConcurrency", value: typeof value === "number" ? value : null };
      continue;
    }
    const spec = LIMITS_TASKS.find(row => row.aiTask === task);
    const route = spec?.concurrency.kind === "route" ? spec.concurrency.route : null;
    if (!spec || !route) continue;
    const value = settings?.routes.limits[route]?.concurrency;
    out[task] = { kind: "route", label: `${spec.label} 동시 호출`, path: `routes.limits.${route}.concurrency`, value: typeof value === "number" ? value : null,
      ...(task === "product-translate" ? { roundsMax: PRODUCT_TRANSLATION_SELECTION_ROUNDS } : {}) };
  }
  return out;
}

async function readDevices(): Promise<PoolHelpDevice[]> {
  return withDbDeadline(Date.now() + 3_000, () => onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
    const rows = await tx.execute<{ deviceId: string; limitSlots: number | string | null; enabled: boolean; modelLimits: unknown }>(sql`SELECT device_id AS "deviceId",
      limit_slots AS "limitSlots", enabled, model_limits AS "modelLimits" FROM model_capacity_devices ORDER BY device_id LIMIT 200`);
    return poolHelpDevicesFromRows(Array.from(rows));
  }, { accessMode: "read only" })));
}

/** 「동시에」 도움말이 쓰는 읽기 — 장비 한도·실시간 한도·수집·판정 설정. 읽기만 하고, 못 읽은 것은 null 로 넘긴다(화면이 「읽지 못함」이라고 적는다) */
export async function readPoolHelpContext(): Promise<PoolHelpContext> {
  let models: readonly ModelDefinition[];
  try { models = readModelRegistry().models; } catch { models = DEFAULT_MODEL_DEFINITIONS; }
  const [devices, row, crawl] = await Promise.all([
    readDevices().catch(quiet("pool_help.devices_unavailable")),
    readRuntimeSettingsRow().catch(quiet("pool_help.runtime_settings_unavailable")),
    getSettings().catch(quiet("pool_help.crawl_settings_unavailable")),
  ]);
  const settings = row ? resolveRuntimeSettings(row.values, { models }).settings : null;
  return { devices, bases: poolHelpBases(settings, crawl ? crawl.reviewConcurrency || 2 : null) };
}
