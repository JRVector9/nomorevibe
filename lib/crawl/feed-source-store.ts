import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlSettings, operationsAudit } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { feedSourceSchema, feedSourcesSchema, type FeedSourceConfig } from "./feed-source-schema";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { mergeWithDefaults, settingsUnreadable } from "./settings";
import { crawlSettingsSchema, DEFAULT_CRAWL_SETTINGS, SHOW_GN_SIGNAL, SHOW_HN_SIGNAL, type CrawlSettings } from "./settings-schema";

/**
 * 글 목록 수집원 저장(2026-11-12 운영 콘솔 조각 4a, 「수집원 추가」·주기 바꾸기·켜고 끄기) — 크롤 설정 행의 discover.feeds 만 바꾼다.
 *
 * 다른 설정 쓰기와 같은 잠금 순서(stage → 설정 행 FOR UPDATE)로, 잠근 행에서 화면이 본 값(expected — 새 수집원이면 null)과 견준다(compare-and-set).
 * 검색 신호(discover.queries)·정렬·기간은 그대로다 — GitHub 검색 주기 해시(seed configHash)가 보는 것이라 이 저장으로 검색 주기가 처음부터 다시 돌지 않는다.
 * 저장된 설정이 깨져 기본값으로 읽혔으면 쓰지 않는다. 성공·거절 모두 작업 로그(crawl-source-save, target = 수집원 열쇠)에 남는다.
 */
export const FEED_SOURCE_AUDIT_ACTION = "crawl-source-save";
const ROW_ID = 1;
/**
 * 프론티어 signal 로 이미 쓰는 이름 — 수집원 이름이 신호가 되므로 겹치면 공개 비율이 섞인다. 다시 받기 신호는 코드의 글자 그대로다
 * (admin-review·agent-review-repository·held-qwen-retry·human-review-repository·second-review, 한국어 발굴 korean-discovery/apply.ts).
 */
const RESERVED_SIGNALS = [SHOW_HN_SIGNAL, SHOW_GN_SIGNAL, "Oracle Korean", "admin-evidence-refresh", "review-source-refresh", "star-auto-source-refresh"];

export type FeedSourceSaveResult = { ok: true; feed: FeedSourceConfig; created: boolean } | { ok: false; issues: string[] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 이름이 다른 신호와 겹치는가 — 검색 신호 라벨·코드의 신호·다른 글 목록 수집원(대소문자 무시) */
export function feedNameTaken(discover: Pick<CrawlSettings["discover"], "queries" | "feeds">, id: string, name: string): boolean {
  const wanted = name.trim().toLowerCase();
  return RESERVED_SIGNALS.some(signal => signal.toLowerCase() === wanted)
    || discover.queries.some(query => query.label.trim().toLowerCase() === wanted)
    || (discover.feeds ?? []).some(feed => feed.id !== id && feed.name.trim().toLowerCase() === wanted);
}

export async function saveFeedSource(input: { next: FeedSourceConfig; expected: FeedSourceConfig | null; actor: string; reason?: string }): Promise<FeedSourceSaveResult> {
  const parsed = feedSourceSchema.safeParse(input.next);
  const reason = input.reason?.trim().slice(0, 500) || null;
  return db.transaction(async tx => {
    await lockPipelineInputStages(tx);
    await tx.insert(crawlSettings).values({ id: ROW_ID, values: DEFAULT_CRAWL_SETTINGS }).onConflictDoNothing();
    const [row] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, ROW_ID)).for("update");
    const current = mergeWithDefaults(row.values);
    const target = parsed.success ? parsed.data.id : String((input.next as { id?: unknown })?.id ?? "").slice(0, 40) || "feed";
    const before = (current.discover.feeds ?? []).find(feed => feed.id === target) ?? null;
    const refuse = async (error: string, issues: string[]): Promise<FeedSourceSaveResult> => {
      await tx.insert(operationsAudit).values(await adminAuditRow(input.actor, { action: FEED_SOURCE_AUDIT_ACTION, target,
        detail: { before, requested: input.next, reason }, ok: false, error }));
      return { ok: false, issues };
    };
    if (settingsUnreadable(current)) return refuse("settings_unreadable", ["저장된 크롤 설정을 읽지 못해 바꾸지 않았습니다. 설정 화면을 먼저 확인해 주세요."]);
    if (!parsed.success) return refuse("invalid", parsed.error.issues.map(issue => `${issue.path.join(".") || "수집원"}: ${issue.message}`));
    const next = parsed.data;
    if (!same(before, input.expected)) return refuse("stale_state", ["그 사이 다른 곳에서 바뀌었습니다. 새로고침해 지금 값을 확인한 뒤 다시 해 주세요."]);
    if (feedNameTaken(current.discover, next.id, next.name)) return refuse("name_taken", [`「${next.name}」은 이미 쓰는 신호 이름입니다. 다른 이름을 적어 주세요.`]);
    const feeds = before ? (current.discover.feeds ?? []).map(feed => feed.id === next.id ? next : feed) : [...(current.discover.feeds ?? []), next];
    const list = feedSourcesSchema.safeParse(feeds);
    if (!list.success) return refuse("invalid", list.error.issues.map(issue => issue.message));
    const values = crawlSettingsSchema.parse({ ...current, discover: { ...current.discover, feeds: list.data } });
    await tx.update(crawlSettings).set({ values, updatedBy: input.actor, updatedAt: new Date() }).where(eq(crawlSettings.id, ROW_ID));
    logger.info("crawl.feed_source_saved", { updatedBy: input.actor, feed: next.id, created: !before });
    await tx.insert(operationsAudit).values(await adminAuditRow(input.actor, { action: FEED_SOURCE_AUDIT_ACTION, target: next.id,
      detail: { name: next.name, created: !before, before, after: next, reason } }));
    return { ok: true, feed: next, created: !before };
  });
}
