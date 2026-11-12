import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { runtimeSettings } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { jobIntervalOverrides } from "./job-intervals";

/**
 * scheduler 가 쓰는 잡 주기 덮어쓰기 — runtime_settings 행(id 1)의 jobs.<잡>.intervalMs 만 읽는다(30초 동안 프로세스 안에서 나눠 쓴다).
 *
 * 정기 요청 TX(requestDueJobs) 밖에서 읽는다: 읽기가 실패해도(행 없음·권한 없음 — Oracle scheduler 의 DB 역할에는 runtime_settings 읽기가 없다)
 * 그 TX 가 깨지지 않고, 마지막으로 읽은 값(처음이면 빈 값 = 코드 기본값)으로 돈다. 실패는 5분에 한 번만 다시 묻는다.
 */
const REFRESH_MS = 30_000;
const FAILURE_RETRY_MS = 5 * 60_000;
type Cache = { at: number; overrides: ReadonlyMap<string, number>; failed: boolean };
const holder = globalThis as unknown as { __nmvJobIntervalOverrides?: Cache | null };

async function readStored(): Promise<unknown> {
  const [row] = await db.select({ values: runtimeSettings.values }).from(runtimeSettings).where(eq(runtimeSettings.id, 1));
  return row?.values ?? null;
}

export async function readJobIntervalOverrides(options: { now?: number; read?: () => Promise<unknown> } = {}): Promise<ReadonlyMap<string, number>> {
  const now = options.now ?? Date.now();
  const cache = holder.__nmvJobIntervalOverrides ?? null;
  if (cache && now - cache.at < (cache.failed ? FAILURE_RETRY_MS : REFRESH_MS)) return cache.overrides;
  try {
    const overrides = jobIntervalOverrides(await (options.read ?? readStored)());
    holder.__nmvJobIntervalOverrides = { at: now, overrides, failed: false };
    return overrides;
  } catch (error) {
    logger.warn("scheduler.interval_overrides_unreadable", { errorName: error instanceof Error ? error.name : "unknown" });
    const overrides = cache?.overrides ?? new Map<string, number>();
    holder.__nmvJobIntervalOverrides = { at: now, overrides, failed: true };
    return overrides;
  }
}

/** 시험 전용 — 담아 둔 값을 비운다 */
export function resetJobIntervalOverridesForTest(): void { holder.__nmvJobIntervalOverrides = null; }
