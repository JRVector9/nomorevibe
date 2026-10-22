import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/lib/db/schema";
import { crawlSettings, operationsAudit, productAuditItems, productAuditSecondOpinions, products } from "@/lib/db/schema";
import { lockProductGeneration } from "@/lib/domain/products/generation";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { auditItemModel, holdGate, releaseAuditHold, type HoldGateOpinion, type HoldGateOptions } from "./product-audit-hold";
import { lockedQwenAuto, lockedSettings, storedAuditHold, storedQwenAuto, type AuditHoldSettings } from "./settings";
import { autoCloseOpinion, type AutoCloseResult } from "./audit-auto-close";

/**
 * 두 번째 의견 옮겨 적기(0110) — 밖에서 돌린 grok 일괄 결과(JSONL)를 product_audit_second_opinions 에 넣는다.
 * scripts/ops/import-audit-second-opinions.ts 가 부른다. 감사 잡의 Qwen-v2 자동 의견(audit-second-opinion-auto.ts)도 같은 쓰기
 * (writeAuditSecondOpinions)를 지난다 — 그쪽은 작업 lease 를 함께 넘겨 같은 커밋에서 확인한다. 읽는 SQL 은 audit-second-opinions.ts 에 있다.
 *
 * 승인 의견이 지금 그 항목으로 보류된 제품에 오면 같은 트랜잭션에서 보류를 다시 가른다 — 덮어쓴 뒤의 의견과 지금 설정으로
 * 보류의 둘째 문(holdGate)이 더는 맞지 않으면 푼다(거절 의견이 남아 두 번째 거절이 켜져 있으면 그대로 둔다). 보류는 늘 시스템이
 * 건다(사람이 거는 보류는 없다). 푸는 길은 유지와 같고(releaseAuditHold — 기록·Cloudflare 지우기 줄), 누가는 import:<source>,
 * 그 제품의 답이 있는 열린 항목에는 '풀었음'을 적어 쓸기가 다시 걸지 않는다. 판단 보류 의견은 걸지도 풀지도 않는다.
 */

/** JSONL 한 줄 — 일괄 도구가 쓴 이름 그대로 */
export type SecondOpinionLine = {
  auditResultId?: unknown; productId?: unknown; grokDecision?: unknown; grokConfidence?: unknown; grokReason?: unknown;
  model?: unknown; inputHash?: unknown; error?: unknown;
};

const DECISIONS = new Set(["approve", "reject", "needs_review"]);
const REASON_LIMIT = 2_000;
const BATCH = 500;

export type SecondOpinionSkip = "error" | "invalid" | "duplicate" | "missing" | "product_mismatch" | "not_open" | "switched_off";
export type SecondOpinionImport = {
  read: number; inserted: number; updated: number;
  /** 승인 의견으로 푼 보류 — dryRun 이면 풀 것 */
  released: number;
  skipped: Record<SecondOpinionSkip, number>;
  dryRun: boolean;
  /** 답으로 닫기(auto.close, audit-auto-close.ts)를 본 쓰기만 — 유지·숨김한 수와 열어 둔 까닭별 수 */
  autoClose?: { kept: number; held: number; left: Record<string, number> };
};

/** 쓸 의견 한 줄 — promptVersion 은 그 의견을 받은 글의 판(Qwen-v2 자동 의견), grok 일괄은 null */
export type SecondOpinionRow = { itemId: number; productId: number; model: string; decision: "approve" | "reject" | "needs_review";
  confidence: number | null; reason: string | null; inputHash: string | null; promptVersion: string | null };
type Parsed = SecondOpinionRow;

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
  return { itemId, productId, model: line.model.trim(), decision: line.grokDecision as Parsed["decision"], confidence, reason, inputHash,
    promptVersion: null };
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
  const result = emptyResult(lines.length, options.dryRun);
  const unique = new Map<string, Parsed>();
  for (const line of lines) {
    const parsed = parseSecondOpinionLine(line);
    if (typeof parsed === "string") { result.skipped[parsed] += 1; continue; }
    const key = `${parsed.itemId}:${parsed.model}`;
    if (unique.has(key)) result.skipped.duplicate += 1;
    unique.set(key, parsed);
  }
  return writeAuditSecondOpinions(database, [...unique.values()], options, result);
}

function emptyResult(read: number, dryRun: boolean): SecondOpinionImport {
  return { read, inserted: 0, updated: 0, released: 0, dryRun,
    skipped: { error: 0, invalid: 0, duplicate: 0, missing: 0, product_mismatch: 0, not_open: 0, switched_off: 0 } };
}

/**
 * 읽은 의견을 쓴다 — 옮겨 적기와 Qwen-v2 자동 의견이 같이 지난다. rows 는 (항목, 모델)마다 하나여야 한다.
 * lease 를 주면 쓰기마다 같은 커밋에서 작업 lease 를 벽시계로 다시 본다(감사 잡 — 잃었으면 아무것도 commit 하지 않는다).
 * DR writer fence 는 lease 와 상관없이 늘 첫 잠금이다.
 * auto: Qwen-v2 자동 의견(audit-second-opinion-auto.ts) — 쓰는 순간 그 단계의 스위치(qwenAuto.auditSecondOpinion)를 잠근 설정 행에서 다시 보고
 * 꺼져 있으면 아무것도 쓰지 않는다(switched_off). 그 의견이 푼 보류는 작업 로그(audit-hold-auto-release, actor 모델)에도 남긴다.
 * auto.close: 같은 트랜잭션에서 그 답으로 닫는다(audit-auto-close.ts — 승인은 유지, 거절은 숨김. 스위치 autoClose 는 잠근 설정 행에서 다시 본다).
 * 그때는 승인·거절 모두 제품 세대를 잡고, 의견을 적기 전에 감사 항목을 잠근다(보류 쓸기와 같은 차례: 세대 → 항목 → 설정 행).
 */
export async function writeAuditSecondOpinions(database: Database, rows: SecondOpinionRow[],
  options: { dryRun: boolean; source: string; lease?: JobLease; auto?: { actor: string; close?: boolean } },
  result: SecondOpinionImport = emptyResult(rows.length, options.dryRun)):
  Promise<SecondOpinionImport> {
  const source = options.source.trim().slice(0, 40) || "import";
  for (let offset = 0; offset < rows.length; offset += BATCH) {
    const batch = rows.slice(offset, offset + BATCH);
    const run = async (tx: Transaction) => {
      if (!options.dryRun) {
        if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
        await lockPipelineInputStages(tx);
      }
      const ids = [...new Set(batch.map((row) => row.itemId))];
      const items = new Map((await tx.select({ id: productAuditItems.id, productId: productAuditItems.productId, slug: products.slug,
        aiReason: productAuditItems.aiReason, aiConfidence: productAuditItems.aiConfidence, model: auditItemModel("product_audit_items"),
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
          decision: productAuditSecondOpinions.decision, source: productAuditSecondOpinions.source, confidence: productAuditSecondOpinions.confidence })
          .from(productAuditSecondOpinions).where(inArray(productAuditSecondOpinions.itemId, accepted.map((row) => row.itemId)));
        const after = new Map<string, HoldGateOpinion & { itemId: number }>(existing.map((row) => [`${row.itemId}:${row.model}`, row]));
        for (const row of accepted) {
          if (after.has(`${row.itemId}:${row.model}`)) result.updated += 1;
          else result.inserted += 1;
          after.set(`${row.itemId}:${row.model}`, { ...row, source });
        }
        const [settings] = await tx.select({ values: crawlSettings.values }).from(crawlSettings).where(eq(crawlSettings.id, 1));
        const hold = storedAuditHold(settings?.values);
        const gate = { autoOpinions: storedQwenAuto(settings?.values).auditSecondOpinion.enabled };
        const opinions = [...after.values()];
        result.released += (await heldBy(tx, approvals)).filter((itemId) => releasable(items.get(itemId)!,
          opinions.filter((row) => row.itemId === itemId), hold, gate)).length;
        return;
      }
      // 승인이 보류를 풀 수 있는 제품의 세대를 의견을 적기 전에 잡는다 — 제품 id 순. 답으로 닫으면(auto.close) 거절도 숨길 수 있어 모두 잡는다
      const closing = Boolean(options.auto?.close);
      const locked = new Set<number>();
      for (const row of [...new Map((closing ? accepted : approvals).map((row) => [row.productId, row])).values()].sort((a, b) => a.productId - b.productId)) {
        if (await lockProductGeneration(tx, row.productId, items.get(row.itemId)!.slug!)) locked.add(row.productId);
      }
      // 사람의 결정(유지·내리기)·정책 처리와 같은 항목 잠금으로 줄을 세운다 — 세대 뒤, 설정 행 앞(보류 쓸기와 같은 차례)
      if (closing) {
        await tx.select({ id: productAuditItems.id }).from(productAuditItems).where(inArray(productAuditItems.id, accepted.map((row) => row.itemId)))
          .orderBy(asc(productAuditItems.id)).for("update");
      }
      // 자동 의견은 쓰는 순간 그 단계의 스위치를 다시 본다 — 끈 뒤에 받은 답은 쓰지 않는다(잠금은 보류 걸기와 같은 차례: 세대 뒤 설정 행)
      if (options.auto && !(await lockedQwenAuto(tx)).auditSecondOpinion.enabled) {
        result.skipped.switched_off += accepted.length;
        if (options.lease) await assertJobLeaseAtWallTime(tx, options.lease);
        return;
      }
      const written = await tx.insert(productAuditSecondOpinions)
        .values(accepted.map((row) => ({ ...row, source })))
        .onConflictDoUpdate({ target: [productAuditSecondOpinions.itemId, productAuditSecondOpinions.model], set: {
          productId: sql`excluded.product_id`, decision: sql`excluded.decision`, confidence: sql`excluded.confidence`,
          reason: sql`excluded.reason`, inputHash: sql`excluded.input_hash`, source: sql`excluded.source`,
          promptVersion: sql`excluded.prompt_version`, createdAt: sql`now()`,
        } })
        // 새로 넣은 줄은 xmax 가 0 이다 — 덮어쓴 줄과 가른다
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      for (const row of written) {
        if (row.inserted) result.inserted += 1;
        else result.updated += 1;
      }
      // 답으로 닫는다 — 승인은 유지(보류면 같은 길로 풀고), 거절은 숨김. 일지·작업 로그는 audit-auto-close.ts 가 같은 커밋에 적는다.
      // 유지로 푼 제품은 아래 승인 풀기가 다시 보지 않는다(이제 보류가 없다)
      if (closing && options.auto) {
        const settings = await lockedSettings(tx);
        const tally = result.autoClose ??= { kept: 0, held: 0, left: {} };
        for (const row of accepted) {
          const outcome: AutoCloseResult = locked.has(row.productId)
            ? await autoCloseOpinion(tx, { itemId: row.itemId, productId: row.productId, slug: items.get(row.itemId)!.slug!, model: row.model,
              decision: row.decision, confidence: row.confidence, promptVersion: row.promptVersion, actor: options.auto.actor, settings })
            : { action: null, skip: "changed" };
          if (outcome.action === null) tally.left[outcome.skip] = (tally.left[outcome.skip] ?? 0) + 1;
          else if (outcome.action === "kept") tally.kept += 1;
          else tally.held += 1;
        }
      }
      // 잠근 뒤 다시 본다 — 지금 그 항목으로 보류됐고, 덮어쓴 뒤의 의견과 지금 설정으로는 둘째 문이 맞지 않는다
      const held = await heldBy(tx, approvals.filter((row) => locked.has(row.productId)));
      if (held.length) {
        const settings = await lockedSettings(tx);
        const gate = { autoOpinions: settings.qwenAuto.auditSecondOpinion.enabled };
        const opinions = await tx.select({ itemId: productAuditSecondOpinions.itemId, model: productAuditSecondOpinions.model,
          decision: productAuditSecondOpinions.decision, source: productAuditSecondOpinions.source, confidence: productAuditSecondOpinions.confidence })
          .from(productAuditSecondOpinions).where(inArray(productAuditSecondOpinions.itemId, held));
        for (const itemId of held) {
          const item = items.get(itemId)!;
          if (!releasable(item, opinions.filter((row) => row.itemId === itemId), settings.auditHold, gate)) continue;
          if (await releaseAuditHold(tx, { productId: item.productId, slug: item.slug!, actor: `import:${source}`, reason: "second_approve" })) {
            result.released += 1;
            // 모델이 푼 보류 — 사람이 정하지 않은 공개 목록 변화라 작업 로그에도 남긴다(누가 그 모델)
            const approval = accepted.find((row) => row.itemId === itemId && row.decision === "approve");
            if (options.auto && approval) {
              await tx.insert(operationsAudit).values({ actor: options.auto.actor.slice(0, 120), actorKind: "model", ok: true,
                action: "audit-hold-auto-release", target: item.slug!.slice(0, 200),
                detail: { itemId, productId: item.productId, model: approval.model, promptVersion: approval.promptVersion, confidence: approval.confidence } });
            }
          }
        }
      }
      if (options.lease) await assertJobLeaseAtWallTime(tx, options.lease);
    };
    await (options.dryRun ? database.transaction(run, { accessMode: "read only" }) : database.transaction(run));
  }
  return result;
}

/**
 * 덮어쓴 뒤의 의견으로 보류의 둘째 문(holdGate — 모델별 거절 규칙·자동 의견의 확신 하한 포함)이 더는 맞지 않는가 — 맞지 않으면 승인이
 * 보류를 푼다. 자동 의견의 승인은 확신 0.90 이상일 때만 세므로 그보다 낮으면 풀지 않는다(의견만 남고 사람이 본다)
 */
function releasable(item: { aiReason: string | null; model: string | null; aiConfidence: number | null }, opinions: HoldGateOpinion[],
  hold: AuditHoldSettings, options: HoldGateOptions): boolean {
  return !holdGate({ reason: item.aiReason, opinions, model: item.model, confidence: item.aiConfidence }, hold, options);
}

/** 이 승인 줄들 가운데 지금 그 항목으로 보류된 제품의 항목 id */
async function heldBy(tx: Transaction, approvals: Parsed[]): Promise<number[]> {
  if (!approvals.length) return [];
  const rows = await tx.select({ itemId: products.auditHoldItemId }).from(products)
    .where(and(inArray(products.id, approvals.map((row) => row.productId)), sql`${products.auditHoldAt} is not null`,
      inArray(products.auditHoldItemId, approvals.map((row) => row.itemId))));
  return [...new Set(rows.flatMap((row) => row.itemId === null ? [] : [row.itemId]))];
}
