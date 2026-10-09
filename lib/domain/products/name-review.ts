import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsAudit, products } from "@/lib/db/schema";
import { createMemo } from "@/lib/cache/memo";
import { reviewProductName, type NameReview } from "./display-name";

/**
 * 이미 올라간 제품의 이름 확인(UX-33) — 관리자 '이름 확인 필요'와 백필 스크립트(scripts/normalize-product-names.ts)가 쓴다.
 *
 * 주인 없는 수집 공개분만 본다 — 주인이 있는 제품의 이름은 주인이 정한다(tidy-catalog.ts 와 같은 선).
 * 규칙이 JS(reviewProductName) 하나라 SQL 로 옮기지 않고 이름·저장소만 읽어 거른다 — 공개분 3만7천 행에 2MB 남짓.
 */
export type NameReviewRow = NameReview & { id: number; slug: string; name: string };

const unclaimedPublic = and(inArray(products.status, ["seeded", "verified"]), eq(products.source, "crawler"), isNull(products.claimedAt));

export async function scanProductNames(): Promise<NameReviewRow[]> {
  const rows = await db.select({ id: products.id, slug: products.slug, name: products.name, repoUrl: products.repoUrl })
    .from(products).where(unclaimedPublic).orderBy(asc(products.id));
  return rows.flatMap((row) => {
    const review = reviewProductName(row.name, row.repoUrl);
    return review ? [{ id: row.id, slug: row.slug, name: row.name, ...review }] : [];
  });
}

/** 관리자 화면은 칩의 수·목록·행마다 같은 결과를 읽는다 — 1분 들고 있는다 */
const reviewMemo = createMemo<Map<string, NameReviewRow>>({ ttlMs: 60_000, max: 1 });

/** 이름 확인이 필요한 제품 — 주소(slug) → 사유와 제안 */
export function namesNeedingReview(): Promise<Map<string, NameReviewRow>> {
  return reviewMemo.get("all", async () => new Map((await scanProductNames()).map((row) => [row.slug, row])));
}

export type NameChange = { slug: string; before: string; after: string; issues: NameReview["issues"] };

/**
 * 고칠 계획 — 제목 안의 말로 고친 제안(source title)만. 짐작한 제안(guessSuggestions)·저장소 이름으로 대신한 제안(repoSuggestions)과
 * 내세울 이름이 없는 것(withoutProposal)은 관리자 '이름 확인 필요'에서 사람이 본다 — 둘 다 자주 틀린다(display-name.ts NameReview).
 */
export async function planNameChanges(): Promise<{ changes: NameChange[]; guessSuggestions: NameReviewRow[]; repoSuggestions: NameReviewRow[]; withoutProposal: NameReviewRow[] }> {
  const rows = await scanProductNames();
  return {
    changes: rows.flatMap((row) => row.proposed && row.source === "title" ? [{ slug: row.slug, before: row.name, after: row.proposed, issues: row.issues }] : []),
    guessSuggestions: rows.filter((row) => row.proposed && row.source === "guess"),
    repoSuggestions: rows.filter((row) => row.proposed && row.source === "repo"),
    withoutProposal: rows.filter((row) => !row.proposed),
  };
}

export function reverseNameChanges(changes: NameChange[]): NameChange[] {
  return changes.map((change) => ({ ...change, before: change.after, after: change.before }));
}

/**
 * 계획을 적용하고 관리자 작업 로그(operations_audit, 지울 수 없다)에 한 줄 남긴다 — 누가·몇 건·되돌리기 파일.
 * 바뀐 줄 전부는 되돌리기 파일에 있다(스크립트가 쓴다). 로그에는 건수와 앞쪽 몇 건만.
 */
export async function applyNameChangesWithLog(changes: NameChange[], options: { actor: string; revert: boolean; revertFile: string | null }) {
  const applied = await applyNameChanges(changes);
  const issues: Record<string, number> = {};
  for (const change of applied) for (const issue of change.issues) issues[issue] = (issues[issue] ?? 0) + 1;
  await db.insert(operationsAudit).values({
    actor: options.actor.slice(0, 120), action: options.revert ? "revert-product-names" : "normalize-product-names", target: "products",
    detail: { applied: applied.length, skipped: changes.length - applied.length, issues, revertFile: options.revertFile,
      sample: applied.slice(0, 20).map((change) => ({ slug: change.slug, before: change.before, after: change.after })) },
  });
  return { applied, skipped: changes.length - applied.length };
}

/**
 * 바꾼다 — 지금 이름이 계획의 before 와 같고 아직 주인 없는 수집 공개분일 때만. 계획을 세운 뒤 누가 고쳤으면 그쪽을 지킨다.
 * 되돌리기는 before·after 를 바꿔 넣은 같은 호출이다. 바꾼 것만 돌려준다.
 */
export async function applyNameChanges(changes: NameChange[]): Promise<NameChange[]> {
  const applied: NameChange[] = [];
  for (const change of changes) {
    const updated = await db.update(products).set({ name: change.after, updatedAt: new Date() })
      .where(and(eq(products.slug, change.slug), unclaimedPublic, eq(products.name, change.before)))
      .returning({ id: products.id });
    if (updated.length) applied.push(change);
  }
  reviewMemo.clear();
  return applied;
}
