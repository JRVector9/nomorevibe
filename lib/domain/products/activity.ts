import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productEvidenceSources, productLinks, productUpdates } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { githubOwnerFromRepositoryUrl } from "./github-owner";

export type ProductActivity = {
  updatedAt: string | null;
  pushedAt: string | null;
  pushCount: number | null;
  pushObservedAt: string | null;
};
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const COUNT_FRESH_MS = 24 * 60 * 60 * 1_000;

function timestamp(value: unknown, now: number): string | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now ? new Date(at).toISOString() : null;
}

/** 공개 업데이트와 현재 저장소의 관측을 목록 전체에 한 번에 붙인다. */
export async function withProductActivity<T extends { slug: string; repoUrl: string | null }>(items: T[]): Promise<Array<T & { activity?: ProductActivity }>> {
  if (items.length === 0) return items;
  const slugs = items.map(item => item.slug);
  const now = new Date();
  const latestAt = sql<Date>`max(coalesce(${productUpdates.publishedAt}, ${productUpdates.observedAt}))`.mapWith(productUpdates.observedAt);
  try {
    const [updates, sources] = await Promise.all([
      db.select({ slug: productUpdates.slug, at: latestAt }).from(productUpdates)
        .where(and(inArray(productUpdates.slug, slugs), eq(productUpdates.visible, true), isNull(productUpdates.makerDeletedAt),
          lte(sql`coalesce(${productUpdates.publishedAt}, ${productUpdates.observedAt})`, now.toISOString())))
        .groupBy(productUpdates.slug),
      db.select({ slug: productEvidenceSources.slug, key: productEvidenceSources.sourceKey, facts: productEvidenceSources.normalizedFacts })
        .from(productEvidenceSources).innerJoin(productLinks, and(
          eq(productLinks.slug, productEvidenceSources.slug), eq(productLinks.kind, productEvidenceSources.kind),
          eq(productLinks.normalizedKey, productEvidenceSources.sourceKey), eq(productLinks.visible, true),
        ))
        .where(and(inArray(productEvidenceSources.slug, slugs), eq(productEvidenceSources.kind, "repository"),
          eq(productEvidenceSources.provider, "github"), eq(productEvidenceSources.state, "ok"))),
    ]);
    const updated = new Map(updates.map(row => [row.slug, row.at.toISOString()]));
    const repository = new Map(sources.map(row => [`${row.slug}:${row.key}`, row.facts]));
    return items.map(item => {
      const activity: ProductActivity = { updatedAt: updated.get(item.slug) ?? null, pushedAt: null, pushCount: null, pushObservedAt: null };
      const key = githubOwnerFromRepositoryUrl(item.repoUrl)?.repositoryUrl.slice("https://github.com/".length).toLowerCase();
      const facts = key ? repository.get(`${item.slug}:${key}`) : null;
      if (facts?.type === "github_repository" && facts.public === true && facts.repositoryKey === key) {
        activity.pushedAt = timestamp(facts.pushedAt, now.getTime());
        const push = facts.pushActivity;
        if (push && typeof push === "object" && !Array.isArray(push)) {
          const count = push as Record<string, unknown>;
          const observedAt = timestamp(count.observedAt, now.getTime());
          const since = timestamp(count.since, now.getTime());
          if (observedAt && since && typeof count.count === "number" && Number.isSafeInteger(count.count) && count.count >= 0
            && Date.parse(observedAt) - Date.parse(since) === WEEK_MS
            && now.getTime() - Date.parse(observedAt) <= COUNT_FRESH_MS) {
            activity.pushCount = count.count;
            activity.pushObservedAt = observedAt;
          }
        }
      }
      return { ...item, activity };
    });
  } catch (error) {
    // 활동 정보가 없어도 기존 공개 목록은 그대로 보여 준다.
    logger.warn("products.activity_failed", { count: items.length, error });
    return items;
  }
}
