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

/**
 * 저장된 설정이 코드 기본값과 어디가 다른지.
 *
 * 설정은 데이터라 한 번 저장하면 그 값이 기준이 된다. 그래서 판정 규칙을 고쳐 기본값을
 * 바꿔도 이미 돌고 있는 환경에는 닿지 않는다 — 조직 계정 제외를 걷고 Codex 신호를 켰는데
 * 정작 배포 환경은 옛 값으로 돌고 있는 일이 실제로 있었다.
 *
 * 조용히 어긋나는 것이 문제이므로 어긋난 것을 보여준다. 되돌릴지는 사람이 정한다.
 */
export type SettingsDrift = { label: string; stored: string; standard: string }[];

const TRACKED: { label: string; read: (s: CrawlSettings) => unknown }[] = [
  { label: "검색 신호", read: (s) => s.discover.queries.filter((q) => q.enabled).map((q) => q.label) },
  { label: "검색 정렬", read: (s) => s.discover.sort },
  { label: "기간 창(일)", read: (s) => s.discover.windowDays },
  { label: "틱당 페이지", read: (s) => s.discover.pagesPerTick },
  { label: "스타 상한", read: (s) => s.judge.maxStars },
  { label: "스타 하한", read: (s) => s.judge.minStars },
  { label: "방치 기준(일)", read: (s) => s.judge.maxPushAgeDays },
  { label: "포크 제외", read: (s) => s.judge.excludeForks },
  { label: "조직 계정 제외", read: (s) => s.judge.excludeOrganizations },
  { label: "차단 도메인", read: (s) => s.judge.blockedHomepageDomains },
  { label: "제외 패턴", read: (s) => s.judge.excludedRepoPatterns },
  { label: "개인 사이트 키워드", read: (s) => s.judge.personalSiteKeywords },
  { label: "문서 생성기", read: (s) => s.judge.docsGenerators },
  { label: "애매하면 보류", read: (s) => s.judge.holdAmbiguous },
];

const show = (value: unknown): string =>
  Array.isArray(value) ? (value.length ? value.join(", ") : "(없음)") : String(value);

export function settingsDrift(current: CrawlSettings): SettingsDrift {
  return TRACKED.flatMap(({ label, read }) => {
    const stored = read(current);
    const standard = read(DEFAULT_CRAWL_SETTINGS);
    if (JSON.stringify(stored) === JSON.stringify(standard)) return [];
    return [{ label, stored: show(stored), standard: show(standard) }];
  });
}

/**
 * 기본값으로 되돌린다.
 *
 * 수집 스위치(enabled)는 그대로 둔다 — 기준을 맞추려다 수집이 켜지거나 꺼지면 그게 더 큰 사고다.
 */
export async function resetSettings(updatedBy: string): Promise<SaveResult> {
  const current = await getSettings();
  return saveSettings({ ...DEFAULT_CRAWL_SETTINGS, enabled: current.enabled }, updatedBy);
}

/** 켜져 있는 검색 신호만 (discover 작업이 쓴다) */
export function enabledQueries(settings: CrawlSettings) {
  return settings.discover.queries.filter((q) => q.enabled);
}
