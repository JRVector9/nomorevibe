import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsItems, type NewsState } from "@/lib/db/schema";

/** 한 쪽 — 218줄을 한 번에 그려 9,148px 이던 것을 나눈다(2026-10-08 UX 감사 ADM-32) */
export const NEWS_PAGE_SIZE = 50;

/** 상태 거르기(?state=) — 모르는 값은 전체 */
export function newsFilter(raw: unknown): NewsState | "all" {
  return raw === "approved" || raw === "pending" || raw === "hidden" ? raw : "all";
}

/**
 * 모은 글 한 쪽 — 화면과 내보내기(/admin/export?view=news)가 같이 쓴다. 순서는 lib/news/repository listNewsForAdmin 과 같다
 * (최근 게시일, 같으면 id). 그 함수는 쪽 넘김(offset)이 없어 여기 둔다.
 */
export async function listNewsPage(state: NewsState | "all", { limit, offset }: { limit: number; offset: number }) {
  return db.select().from(newsItems)
    .where(state === "all" ? undefined : eq(newsItems.state, state))
    .orderBy(desc(newsItems.publishedAt), desc(newsItems.id))
    .limit(limit).offset(offset);
}
