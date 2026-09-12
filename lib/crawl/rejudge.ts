import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings } from "@/lib/db/schema";
import { factsFromRepoMeta, judge, pageFactsFromDocument } from "./rules";
import { mergeWithDefaults } from "./settings";

// maxStars는 포함 상한이다. 10만부터 제외하려면 99,999여야 한다.
export const REJUDGE_MAX_STARS = 99_999;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const fingerprint = z.string().regex(/^[a-f0-9]{32}$/);
const entrySchema = z.object({
  id: z.number().int().positive(), repo: z.string().min(1).max(200),
  stars: z.number().int().min(2000).max(REJUDGE_MAX_STARS), ownerType: z.string(),
  beforeHash: fingerprint, documentHash: fingerprint,
  // DB 원문을 저장한다. timestamp without time zone을 JS Date로 왕복하지 않는다.
  beforeUpdatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/),
  preview: z.object({ state: z.enum(["approved", "rejected", "needs_review"]), reason: z.string() }),
});
const uniqueEntries = <T extends { id: number }>(rows: T[]) => new Set(rows.map(r => r.id)).size === rows.length;
const planSchema = z.object({
  kind: z.literal("star-rejudge-plan-v1"), createdAt: z.iso.datetime(), database: fingerprint,
  fromMaxStars: z.number().int().nonnegative(), toMaxStars: z.literal(REJUDGE_MAX_STARS),
  settingsHash: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(entrySchema).max(10_000).refine(uniqueEntries, "중복 후보 ID"),
});
const receiptSchema = z.object({
  kind: z.literal("star-rejudge-receipt-v1"), createdAt: z.iso.datetime(), database: fingerprint,
  planCreatedAt: z.iso.datetime(), skipped: z.number().int().nonnegative(),
  entries: z.array(entrySchema.extend({ afterHash: fingerprint })).max(10_000).refine(uniqueEntries, "중복 후보 ID"),
});
export type StarRejudgePlan = z.infer<typeof planSchema>;
export type StarRejudgeReceipt = z.infer<typeof receiptSchema>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
function settingsHash(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
async function databaseId(tx: Tx): Promise<string> {
  const [row] = await tx.execute<{ identity: string }>(sql`
    select md5(current_database() || coalesce(inet_server_addr()::text, 'local') || inet_server_port()::text) as identity
  `);
  return row.identity;
}
const candidateHash = sql<string>`md5(to_jsonb(${crawlCandidates})::text)`;
const documentHash = sql<string>`md5(to_jsonb(${crawlDocuments})::text)`;
const eligibleCandidate = and(eq(crawlCandidates.state, "rejected"), eq(crawlCandidates.reason, "large_oss"),
  eq(crawlCandidates.decidedBy, "auto"), isNull(crawlCandidates.decidedAt), isNull(crawlCandidates.publishedSlug));

/** 설정·DB·AI를 바꾸거나 호출하지 않는, 저장 원본 기준의 규칙 미리보기다. */
export async function planStarRejudge(): Promise<StarRejudgePlan> {
  return db.transaction(async tx => {
    const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
    const current = mergeWithDefaults(saved?.values);
    const proposed = { ...current, judge: { ...current.judge, maxStars: REJUDGE_MAX_STARS } };
    const now = new Date();
    const rows = await tx.select({ candidate: crawlCandidates, document: crawlDocuments,
      beforeHash: candidateHash, documentHash,
      beforeUpdatedAt: sql<string>`${crawlCandidates.updatedAt}::text`,
    }).from(crawlCandidates).innerJoin(crawlDocuments, eq(crawlCandidates.repo, crawlDocuments.repo))
      .where(and(eligibleCandidate, sql`${crawlDocuments.pageStatus} >= 200 and ${crawlDocuments.pageStatus} < 400`,
        sql`${crawlDocuments.productUrl} is not null`)).orderBy(asc(crawlCandidates.id));
    const entries: StarRejudgePlan["entries"] = [];
    for (const row of rows) {
      const stars = row.document.repoMeta.stargazers_count;
      if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 2000 || stars > REJUDGE_MAX_STARS) continue;
      const facts = factsFromRepoMeta(row.document.repo, row.document.repoMeta);
      const preview = judge(facts, pageFactsFromDocument(row.document), proposed, now);
      entries.push({ id: row.candidate.id, repo: row.candidate.repo, stars, ownerType: facts.ownerType,
        beforeHash: row.beforeHash, documentHash: row.documentHash, beforeUpdatedAt: row.beforeUpdatedAt,
        preview: { state: preview.state, reason: preview.reason } });
    }
    return planSchema.parse({ kind: "star-rejudge-plan-v1", createdAt: now.toISOString(), database: await databaseId(tx),
      fromMaxStars: current.judge.maxStars, toMaxStars: REJUDGE_MAX_STARS, settingsHash: settingsHash(proposed), entries });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** 기존 판정 잡과 같은 순서로 후보→원본을 잠근다. 오래된 미리보기는 적용하지 않는다. */
async function unchanged(tx: Tx, entry: StarRejudgePlan["entries"][number], expectedHash: string, state: "new" | "rejected") {
  const [candidate] = await tx.select({ hash: candidateHash, row: crawlCandidates }).from(crawlCandidates)
    .where(eq(crawlCandidates.id, entry.id)).for("update");
  if (!candidate || candidate.hash !== expectedHash || candidate.row.repo !== entry.repo || candidate.row.state !== state
    || candidate.row.decidedBy !== "auto" || candidate.row.decidedAt || candidate.row.publishedSlug
    || candidate.row.reason !== "large_oss") return false;
  const [document] = await tx.select({ hash: documentHash }).from(crawlDocuments)
    .where(eq(crawlDocuments.repo, entry.repo)).for("share");
  return document?.hash === entry.documentHash;
}

/** 영수증을 내구성 있게 기록한 뒤에만 커밋한다. 기록 실패 시 전체 변경이 롤백된다. */
export async function applyStarRejudge(input: unknown, persistReceipt: (receipt: StarRejudgeReceipt) => void | Promise<void>): Promise<StarRejudgeReceipt> {
  const plan = planSchema.parse(input);
  return db.transaction(async tx => {
    if (await databaseId(tx) !== plan.database) throw new Error("계획과 다른 DB입니다");
    // 공유 잠금끼리는 판정 잡과 충돌하지 않고, 설정 저장은 적용이 끝날 때까지 기다린다.
    const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
    const settings = mergeWithDefaults(saved?.values);
    if (!saved || settings.judge.maxStars !== REJUDGE_MAX_STARS || settingsHash(settings) !== plan.settingsHash) {
      throw new Error("계획의 설정과 다릅니다. 스타 상한 99999와 나머지 심사 설정을 확인하세요");
    }
    const entries: StarRejudgeReceipt["entries"] = [];
    for (const entry of [...plan.entries].sort((a, b) => a.id - b.id)) {
      if (!await unchanged(tx, entry, entry.beforeHash, "rejected")) continue;
      const [updated] = await tx.update(crawlCandidates).set({ state: "new", updatedAt: sql`clock_timestamp()` })
        .where(eq(crawlCandidates.id, entry.id)).returning({ afterHash: candidateHash });
      entries.push({ ...entry, afterHash: updated.afterHash });
    }
    const receipt: StarRejudgeReceipt = { kind: "star-rejudge-receipt-v1", createdAt: new Date().toISOString(),
      database: plan.database, planCreatedAt: plan.createdAt, skipped: plan.entries.length - entries.length, entries };
    await persistReceipt(receipt);
    return receipt;
  });
}

/** 이미 판정/수동 수정/발행되었거나 원본이 갱신된 건은 되돌리지 않는다. 설정은 별도 관리한다. */
export async function revertStarRejudge(input: unknown): Promise<{ reverted: number; skipped: number }> {
  const receipt = receiptSchema.parse(input);
  return db.transaction(async tx => {
    if (await databaseId(tx) !== receipt.database) throw new Error("영수증과 다른 DB입니다");
    let reverted = 0;
    for (const entry of [...receipt.entries].sort((a, b) => a.id - b.id)) {
      if (!await unchanged(tx, entry, entry.afterHash, "new")) continue;
      await tx.update(crawlCandidates).set({ state: "rejected", updatedAt: sql`${entry.beforeUpdatedAt}::timestamp` })
        .where(eq(crawlCandidates.id, entry.id));
      reverted++;
    }
    return { reverted, skipped: receipt.entries.length - reverted };
  });
}
