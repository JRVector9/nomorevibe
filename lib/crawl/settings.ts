import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlSettings } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import {
  crawlSettingsSchema,
  DEFAULT_CRAWL_SETTINGS,
  type CrawlSettings,
} from "./settings-schema";

const ROW_ID = 1;

/**
 * 저장된 값을 기본값 위에 덮어 읽는다.
 *
 * 필터를 새로 추가하면 기존 행에는 그 필드가 없다. 그때 검증을 실패시키면 설정을
 * 못 읽어 수집이 멈추고, 마이그레이션으로 채우려면 "마이그레이션 없이 필터를 추가한다"는
 * 이점이 사라진다. 기본값을 바탕으로 얕게 병합해 없는 필드를 메운다.
 */
function mergeWithDefaults(stored: unknown): CrawlSettings {
  const raw = (stored ?? {}) as Record<string, unknown>;
  const merged = {
    ...DEFAULT_CRAWL_SETTINGS,
    ...raw,
    discover: { ...DEFAULT_CRAWL_SETTINGS.discover, ...((raw.discover as object) ?? {}) },
    judge: { ...DEFAULT_CRAWL_SETTINGS.judge, ...((raw.judge as object) ?? {}) },
  };

  const parsed = crawlSettingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;

  // 저장된 값이 손상된 경우. 수집을 멈추는 대신 기본값으로 돌아가되 반드시 남긴다 —
  // 조용히 다른 기준으로 도는 것이 최악이다.
  logger.error("crawl.settings_invalid", {
    issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  });
  return DEFAULT_CRAWL_SETTINGS;
}

export async function getSettings(): Promise<CrawlSettings> {
  const row = await db.query.crawlSettings.findFirst({ where: eq(crawlSettings.id, ROW_ID) });
  return mergeWithDefaults(row?.values);
}

export type SaveResult =
  | { ok: true; settings: CrawlSettings }
  | { ok: false; issues: string[] };

/**
 * 설정을 저장한다. 부분 수정을 허용한다 — 화면이 한 항목만 바꿔 보낼 수 있어야 한다.
 * 검증에 실패하면 아무것도 쓰지 않는다.
 */
export async function saveSettings(patch: unknown, updatedBy: string): Promise<SaveResult> {
  const current = await getSettings();
  const raw = (patch ?? {}) as Record<string, unknown>;
  const next = {
    ...current,
    ...raw,
    discover: { ...current.discover, ...((raw.discover as object) ?? {}) },
    judge: { ...current.judge, ...((raw.judge as object) ?? {}) },
  };

  const parsed = crawlSettingsSchema.safeParse(next);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "설정"}: ${i.message}`) };
  }

  await db
    .insert(crawlSettings)
    .values({ id: ROW_ID, values: parsed.data, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: crawlSettings.id,
      set: { values: parsed.data, updatedBy, updatedAt: new Date() },
    });

  // 기준이 바뀌면 수집 결과가 바뀐다. 나중에 "왜 이때부터 달라졌지"를 되짚을 수 있어야 한다.
  logger.info("crawl.settings_saved", { updatedBy, enabled: parsed.data.enabled });
  return { ok: true, settings: parsed.data };
}

/** 누가 언제 바꿨는지 (화면 표시용) */
export async function getSettingsMeta(): Promise<{ updatedBy: string | null; updatedAt: Date } | null> {
  const row = await db.query.crawlSettings.findFirst({ where: eq(crawlSettings.id, ROW_ID) });
  return row ? { updatedBy: row.updatedBy, updatedAt: row.updatedAt } : null;
}

/** 켜져 있는 검색 신호만 (discover 작업이 쓴다) */
export function enabledQueries(settings: CrawlSettings) {
  return settings.discover.queries.filter((q) => q.enabled);
}
