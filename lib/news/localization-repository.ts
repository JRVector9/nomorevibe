import { sql } from "drizzle-orm";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { newsLocalizations } from "@/lib/db/news-localization-schema";
import { newsLocalizationSourceSchema, type NewsLocalizationSource } from "./localization-contract";
import type { NewsLocalizationDraft } from "./localization-work";

/** TX를 새로 열지 않는다. common result 저장 TX가 원문 상태 변경까지 직렬화한다. */
export async function lockNewsLocalizationSource(tx: ProductTransaction, newsItemId: number): Promise<NewsLocalizationSource | null> {
  const [row] = await tx.execute(sql`select id,url,title,summary,state,decided_at::text as revision,
    created_at::text as "observedAt" from news_items where id=${newsItemId} for share`);
  return row ? newsLocalizationSourceSchema.parse(row) : null;
}

/** 동일 result를 재전달해도 한 번만 저장한다. 원문·공개 상태에 쓰지 않는다. */
export async function saveNewsLocalizationDraft(tx: ProductTransaction, value: NewsLocalizationDraft): Promise<{ created: boolean }> {
  const [row] = await tx.insert(newsLocalizations).values(value).onConflictDoNothing({ target: newsLocalizations.resultId })
    .returning({ id: newsLocalizations.resultId });
  return { created: Boolean(row) };
}
