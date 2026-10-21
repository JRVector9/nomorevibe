import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/lib/db/schema";
import { productAuditItems, productAuditSecondOpinions, products } from "@/lib/db/schema";
import { lockProductGeneration } from "@/lib/domain/products/generation";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { releaseAuditHold } from "./product-audit-hold";

/**
 * 두 번째 의견 옮겨 적기(0110) — 밖에서 돌린 grok 일괄 결과(JSONL)를 product_audit_second_opinions 에 넣는다.
 * scripts/ops/import-audit-second-opinions.ts 가 부른다. 읽는 SQL 은 audit-second-opinions.ts 에 있다.
 *
 * 승인 의견이 지금 그 항목으로 보류된 제품에 오면 같은 트랜잭션에서 보류를 푼다 — 그 항목에 거절 의견이 하나도 남지 않았을 때만
 * (거절이 있으면 두 번째 모델 거절로 다시 걸 까닭이다). 보류는 늘 시스템이 건다(사람이 거는 보류는 없다). 푸는 길은 유지와 같고
 * (releaseAuditHold — 기록·Cloudflare 지우기 줄), 누가는 import:<source>, 그 항목에는 '풀었음'을 적어 쓸기가 다시 걸지 않는다.
 * 판단 보류 의견은 걸지도 풀지도 않는다.
 */

/** JSONL 한 줄 — 일괄 도구가 쓴 이름 그대로 */
export type SecondOpinionLine = {
  auditResultId?: unknown; productId?: unknown; grokDecision?: unknown; grokConfidence?: unknown; grokReason?: unknown;
  model?: unknown; inputHash?: unknown; error?: unknown;
};

const DECISIONS = new Set(["approve", "reject", "needs_review"]);
const REASON_LIMIT = 2_000;
const BATCH = 500;

export type SecondOpinionSkip = "error" | "invalid" | "duplicate" | "missing" | "product_mismatch" | "not_open";
export type SecondOpinionImport = {
  read: number; inserted: number; updated: number;
  /** 승인 의견으로 푼 보류 — dryRun 이면 풀 것 */
  released: number;
  skipped: Record<SecondOpinionSkip, number>;
  dryRun: boolean;
};

type Parsed = { itemId: number; productId: number; model: string; decision: "approve" | "reject" | "needs_review";
  confidence: number | null; reason: string | null; inputHash: string | null };

/** 한 줄을 읽는다. 오류가 적힌 줄·모양이 틀린 줄은 까닭을 돌려준다 */
export function parseSecondOpinionLine(line: SecondOpinionLine): Parsed | "error" | "invalid" {
  if (line.error !== undefined && line.error !== null && line.error !== "" && line.error !== false) return "error";
  const itemId = Number(line.auditResultId), productId = Number(line.productId);
  if (!Number.isSafeInteger(itemId) || itemId <= 0 || !Number.isSafeInteger(productId) || productId <= 0) return "invalid";
  if (typeof line.grokDecision !== "string" || !DECISIONS.has(line.grokDecision)) return "invalid";
  if (typeof line.model !== "string" || !line.model.trim() || line.model.trim().length > 160) return "invalid";
  const confidence = line.grokConfidence === null || line.grokConfidence === undefined ? null : Number(line.grokConfidence);
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) return "invalid";
  const reason = typeof line.grokReason === "string" && line.grokReason.trim() ? line.grokReason.trim().slice(0, REASON_LIMIT) : null;
  const inputHash = typeof line.inputHash === "string" && line.inputHash.trim() ? line.inputHash.trim().slice(0, 128) : null;
  return { itemId, productId, model: line.model.trim(), decision: line.grokDecision as Parsed["decision"], confidence, reason, inputHash };
}

type Database = PostgresJsDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * 두 번째 의견을 옮겨 적는다 — 몇 번 돌려도 같은 결과다: (항목, 모델)이 같으면 덮어쓴다.
 *
 * 건너뛰는 것: 오류가 적힌 줄, 모양이 틀린 줄, 같은 파일 안의 같은 (항목, 모델)(뒤의 것만 쓴다), 없는 항목, 제품이 다른 항목,
 * 이제 열린 거절이 아닌 항목(사람이 정했거나·거절이 아니거나·제품이 목록에서 내려감).
 *
 * BATCH 줄씩 한 트랜잭션이다. 잠금은 감사 쓸기와 같은 순서: DR writer fence(fenced 면 쓰지 않고 멈춘다) → stage → 승인 줄의 제품 세대
 * (제품 id 순) → 의견 쓰기(항목 외래 키 잠금) → 보류 풀기. 세대를 의견보다 먼저 잡아, 쓸기가 같은 제품에 막 보류를 거는 중이면
 * 그 커밋을 기다렸다가 푼다. dryRun 이면 읽기 전용 트랜잭션에서 셈만 한다(풀 것은 지금 보류와 이 파일을 덮어쓴 뒤의 의견으로 센다).
 * 결과는 수만 돌려준다 — 사유 문장은 출력하지 않는다.
 */
export async function importAuditSecondOpinions(database: Database, lines: SecondOpinionLine[],
  options: { dryRun: boolean; source: string }): Promise<SecondOpinionImport> {
  const result: SecondOpinionImport = { read: lines.length, inserted: 0, updated: 0, released: 0, dryRun: options.dryRun,
    skipped: { error: 0, invalid: 0, duplicate: 0, missing: 0, product_mismatch: 0, not_open: 0 } };
  const source = options.source.trim().slice(0, 40) || "import";
  const unique = new Map<string, Parsed>();
  for (const line of lines) {
    const parsed = parseSecondOpinionLine(line);
    if (typeof parsed === "string") { result.skipped[parsed] += 1; continue; }
    const key = `${parsed.itemId}:${parsed.model}`;
    if (unique.has(key)) result.skipped.duplicate += 1;
    unique.set(key, parsed);
  }
  const rows = [...unique.values()];
  for (let offset = 0; offset < rows.length; offset += BATCH) {
    const batch = rows.slice(offset, offset + BATCH);
    const run = async (tx: Transaction) => {
      if (!options.dryRun) {
        if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
        await lockPipelineInputStages(tx);
      }
      const ids = [...new Set(batch.map((row) => row.itemId))];
      const items = new Map((await tx.select({ id: productAuditItems.id, productId: productAuditItems.productId, slug: products.slug,
        open: sql<boolean>`(${productAuditItems.aiDecision} = 'reject' and ${productAuditItems.humanDecision} is null
          and coalesce(${products.status} in ('seeded', 'verified'), false))` })
        .from(productAuditItems).leftJoin(products, eq(products.id, productAuditItems.productId))
        .where(inArray(productAuditItems.id, ids))).map((item) => [item.id, item]));
      const accepted = batch.filter((row) => {
        const item = items.get(row.itemId);
        const skip: SecondOpinionSkip | null = !item ? "missing" : item.productId !== row.productId ? "product_mismatch" : !item.open ? "not_open" : null;
        if (skip) result.skipped[skip] += 1;
        return skip === null;
      });
      if (!accepted.length) return;
      const approvals = accepted.filter((row) => row.decision === "approve");
      if (options.dryRun) {
        const existing = await tx.select({ itemId: productAuditSecondOpinions.itemId, model: productAuditSecondOpinions.model,
          decision: productAuditSecondOpinions.decision })
          .from(productAuditSecondOpinions).where(inArray(productAuditSecondOpinions.itemId, accepted.map((row) => row.itemId)));
        const after = new Map(existing.map((row) => [`${row.itemId}:${row.model}`, row]));
        for (const row of accepted) {
          if (after.has(`${row.itemId}:${row.model}`)) result.updated += 1;
          else result.inserted += 1;
          after.set(`${row.itemId}:${row.model}`, row);
        }
        result.released += (await heldBy(tx, approvals)).filter((itemId) =>
          ![...after.values()].some((row) => row.itemId === itemId && row.decision === "reject")).length;
        return;
      }
      // 승인이 보류를 풀 수 있는 제품의 세대를 의견을 적기 전에 잡는다 — 제품 id 순
      const locked = new Set<number>();
      for (const row of [...new Map(approvals.map((row) => [row.productId, row])).values()].sort((a, b) => a.productId - b.productId)) {
        if (await lockProductGeneration(tx, row.productId, items.get(row.itemId)!.slug!)) locked.add(row.productId);
      }
      const written = await tx.insert(productAuditSecondOpinions)
        .values(accepted.map((row) => ({ ...row, source })))
        .onConflictDoUpdate({ target: [productAuditSecondOpinions.itemId, productAuditSecondOpinions.model], set: {
          productId: sql`excluded.product_id`, decision: sql`excluded.decision`, confidence: sql`excluded.confidence`,
          reason: sql`excluded.reason`, inputHash: sql`excluded.input_hash`, source: sql`excluded.source`, createdAt: sql`now()`,
        } })
        // 새로 넣은 줄은 xmax 가 0 이다 — 덮어쓴 줄과 가른다
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      for (const row of written) {
        if (row.inserted) result.inserted += 1;
        else result.updated += 1;
      }
      // 잠근 뒤 다시 본다 — 지금 그 항목으로 보류됐고, 덮어쓴 뒤에도 그 항목에 거절 의견이 하나도 없다
      const rejected = new Set((await tx.select({ itemId: productAuditSecondOpinions.itemId }).from(productAuditSecondOpinions)
        .where(and(inArray(productAuditSecondOpinions.itemId, ids), eq(productAuditSecondOpinions.decision, "reject")))).map((row) => row.itemId));
      for (const itemId of await heldBy(tx, approvals.filter((row) => locked.has(row.productId)))) {
        if (rejected.has(itemId)) continue;
        const item = items.get(itemId)!;
        if (await releaseAuditHold(tx, { productId: item.productId, slug: item.slug!, actor: `import:${source}`, reason: "second_approve" })) {
          result.released += 1;
        }
      }
    };
    await (options.dryRun ? database.transaction(run, { accessMode: "read only" }) : database.transaction(run));
  }
  return result;
}

/** 이 승인 줄들 가운데 지금 그 항목으로 보류된 제품의 항목 id */
async function heldBy(tx: Transaction, approvals: Parsed[]): Promise<number[]> {
  if (!approvals.length) return [];
  const rows = await tx.select({ itemId: products.auditHoldItemId }).from(products)
    .where(and(inArray(products.id, approvals.map((row) => row.productId)), sql`${products.auditHoldAt} is not null`,
      inArray(products.auditHoldItemId, approvals.map((row) => row.itemId))));
  return [...new Set(rows.flatMap((row) => row.itemId === null ? [] : [row.itemId]))];
}
