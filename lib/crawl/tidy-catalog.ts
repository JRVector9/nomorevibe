import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, products } from "@/lib/db/schema";
import { CATEGORIES, LIMITS, type Category } from "@/lib/domain/products/schema";
import { CATEGORY_BATCH_SIZE, type ClassifyInput } from "./classify";
import { productName } from "./product-name";

/**
 * 공개 목록 정리 — 이름 규칙과 분류가 나아지기 전에 올라간 것을 지금 기준으로 다시 본다.
 *
 * 2026-09-11 실측: 공개분 3,878개 중 이름이 45자를 넘는 것 254개, 기타가 1,105개(28%).
 * 기타는 AI 분류가 들어오기 전 주(키워드 규칙)에 49~62%였고 들어온 뒤로는 7~9%다.
 * 옛 기타 표본 40개를 지금 분류기에 다시 넣자 38개가 제 분류를 찾았다.
 *
 * 크롤러가 올린 seeded 만 건드린다 — 주인이 있는 것은 주인이 고친다.
 * 바꾸기 전 값을 함께 남긴다. 사람이 목록을 보고 적용하고, 틀렸으면 그대로 되돌린다.
 */
/** label 은 사람이 목록을 볼 때 쓰는 이름 — 분류 변경은 before 가 모두 Other 라 그것만으로는 무엇인지 모른다 */
export type TidyChange = { slug: string; field: "name" | "category"; before: string; after: string; label?: string };

const crawlerSeeded = and(eq(products.status, "seeded"), eq(products.source, "crawler"));

/** https://github.com/owner/repo → owner/repo */
function repoOf(repoUrl: string | null): string {
  return repoUrl?.match(/github\.com\/([^/]+\/[^/#?]+)/)?.[1] ?? "";
}

/**
 * 지금 이름에 지금 규칙을 다시 태운다. 페이지 제목을 다시 읽지 않는다 — 올린 뒤 제목이 바뀐 것까지
 * 따라가면 이름 정리가 아니라 이름 갱신이 된다.
 */
export async function planNameChanges(): Promise<TidyChange[]> {
  const rows = await db.select({ slug: products.slug, name: products.name, url: products.url, repoUrl: products.repoUrl })
    .from(products).where(crawlerSeeded).orderBy(asc(products.id));
  return rows.flatMap((row) => {
    const after = productName(row.name, repoOf(row.repoUrl), row.url).slice(0, LIMITS.name);
    return after && after !== row.name ? [{ slug: row.slug, field: "name" as const, before: row.name, after }] : [];
  });
}

export type ClassifyBatch = (inputs: ClassifyInput[]) => Promise<(Category | null)[]>;

/**
 * 기타를 발행 때와 같은 분류기에 다시 넣는다. 분류기가 여전히 기타라고 하거나 답하지 못하면 그대로 둔다.
 * names 로 정리한 이름을 넘기면 그 이름으로 분류한다 — 문장이 된 이름이 분류를 흐리지 않게.
 */
export async function planCategoryChanges(classify: ClassifyBatch, options: {
  limit?: number; names?: Map<string, string>; concurrency?: number; onBatch?: (done: number, total: number) => void;
} = {}): Promise<TidyChange[]> {
  const rows = await db.select({
    slug: products.slug, name: products.name, tagline: products.tagline, url: products.url, repoUrl: products.repoUrl,
    topics: sql<unknown>`${crawlDocuments.repoMeta} -> 'topics'`, language: sql<string | null>`${crawlDocuments.repoMeta} ->> 'language'`,
  }).from(products)
    .leftJoin(crawlCandidates, eq(crawlCandidates.publishedSlug, products.slug))
    .leftJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(and(crawlerSeeded, eq(products.category, "Other")))
    .orderBy(asc(products.id)).limit(options.limit ?? 10_000);

  const batches: (typeof rows)[] = [];
  for (let i = 0; i < rows.length; i += CATEGORY_BATCH_SIZE) batches.push(rows.slice(i, i + CATEGORY_BATCH_SIZE));
  const changes: TidyChange[] = [];
  let done = 0;
  const queue = [...batches];
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      const categories = await classify(batch.map((row) => ({
        repo: repoOf(row.repoUrl), url: row.url, name: options.names?.get(row.slug) ?? row.name, tagline: row.tagline,
        topics: Array.isArray(row.topics) ? row.topics.map(String) : [], language: row.language,
      })));
      batch.forEach((row, index) => {
        const after = categories[index];
        if (after && after !== "Other" && CATEGORIES.includes(after)) {
          changes.push({ slug: row.slug, field: "category", before: "Other", after, label: options.names?.get(row.slug) ?? row.name });
        }
      });
      done += batch.length;
      options.onBatch?.(done, rows.length);
    }
  }));
  return changes;
}

/**
 * 바꾼다 — 지금 값이 계획의 before 와 같을 때만. 계획을 세운 뒤 누가 고쳤으면 그쪽을 지킨다.
 * 되돌리기는 before·after 를 바꿔 넣은 같은 호출이다.
 */
export async function applyChanges(changes: TidyChange[]): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  for (const change of changes) {
    const column = change.field === "name" ? products.name : products.category;
    const updated = await db.update(products)
      .set(change.field === "name" ? { name: change.after, updatedAt: new Date() } : { category: change.after, updatedAt: new Date() })
      .where(and(eq(products.slug, change.slug), crawlerSeeded, eq(column, change.before)))
      .returning({ id: products.id });
    applied += updated.length;
  }
  return { applied, skipped: changes.length - applied };
}

export function reverse(changes: TidyChange[]): TidyChange[] {
  return changes.map((change) => ({ ...change, before: change.after, after: change.before }));
}
