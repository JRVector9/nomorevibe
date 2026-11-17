import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsAudit, productAuditItems, productAuditSameModelRechecks, products } from "@/lib/db/schema";
import { assertJobLeaseAtWallTime, withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { lockedSettings } from "./settings";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import type { ReviewInput } from "./agent-review-contract";
import type { QwenDirectReview } from "./qwen-direct-review";
import { recheckRejectRevision, SAME_MODEL_RECHECK_PROMPT_VERSION, SAME_MODEL_RECHECK_SOURCE,
  sameModelRecheckModel, sameModelRecheckWanted } from "./same-model-recheck-policy";

export type SameModelRecheckTarget = { item_id: number; product_id: number; slug: string; reason: string | null; reject_revision: string };

export async function sameModelRecheckTargets(model: string, limit: number, skip: readonly number[]): Promise<SameModelRecheckTarget[]> {
  return Array.from(await db.execute<SameModelRecheckTarget>(sql`
    select i.id as item_id, p.id as product_id, p.slug, i.ai_reason as reason, ${recheckRejectRevision("i")} as reject_revision
    from product_audit_items i, products p where ${sameModelRecheckWanted(model)}
      and exists (select 1 from crawl_candidates c join crawl_documents d on d.repo = c.repo where c.published_slug = p.slug)
      ${skip.length ? sql`and i.id not in (${sql.join(skip.map(id => sql`${id}`), sql`, `)})` : sql``}
    order by (p.audit_hold_at is not null), i.id limit ${limit}`));
}

/** The only writer. Both answers are advisory records; it has no product/hold/decision writer. */
export async function writeSameModelRecheck(target: SameModelRecheckTarget, review: QwenDirectReview, input: ReviewInput, lease: JobLease):
  Promise<"written" | "not_open" | "switched_off"> {
  if (review.promptVersion !== SAME_MODEL_RECHECK_PROMPT_VERSION) throw new Error("same_model_recheck_prompt_mismatch");
  return withJobLeaseWrite(lease, async tx => {
    await lockPipelineInputStages(tx);
    await tx.select({ id: products.id }).from(products).where(eq(products.id, target.product_id)).for("share");
    await tx.select({ id: productAuditItems.id }).from(productAuditItems).where(eq(productAuditItems.id, target.item_id)).for("update");
    const settings = await lockedSettings(tx);
    if (!settings.enabled || !settings.qwenAuto.auditSecondOpinion.enabled || !settings.qwenAuto.sameModelRecheck.enabled) return "switched_off";
    if (!await sameModelRecheckModel(review.model)) return "not_open";
    const rows = await tx.execute(sql`select i.id from product_audit_items i, products p
      where i.id = ${target.item_id} and p.id = ${target.product_id} and ${sameModelRecheckWanted(review.model)}
        and ${recheckRejectRevision("i")} = ${target.reject_revision}`);
    if (!rows.length) return "not_open";
    await tx.insert(productAuditSameModelRechecks).values({ itemId: target.item_id, rejectRevision: target.reject_revision,
      source: SAME_MODEL_RECHECK_SOURCE, actor: SAME_MODEL_RECHECK_SOURCE, model: review.model, promptVersion: review.promptVersion,
      decision: review.outcome.decision, reason: review.outcome.reason?.trim().slice(0, 2000) || null,
      confidence: review.outcome.confidence ?? null, inputHash: input.inputHash }).onConflictDoNothing();
    await tx.insert(operationsAudit).values({ actor: SAME_MODEL_RECHECK_SOURCE, actorKind: "model", action: SAME_MODEL_RECHECK_SOURCE,
      target: target.slug, ok: true, detail: { itemId: target.item_id, model: review.model, promptVersion: review.promptVersion,
        decision: review.outcome.decision, recommendation: review.outcome.decision === "approve" ? "human_keep_review" : null } });
    await assertJobLeaseAtWallTime(tx, lease);
    return "written";
  });
}

export type SameModelRecheckView = { model: string; reason: string | null; source: "same-model-recheck" };

/** Display only, confined to audit findings; no shared pipeline predicate or independent vote reads this table. */
export function sameModelRecheckField(itemId: SQL): SQL<SameModelRecheckView | null> {
  return sql`(select json_build_object('model', r.model, 'reason', r.reason, 'source', r.source)
    from product_audit_same_model_rechecks r join product_audit_items ri on ri.id = r.item_id
    where r.item_id = ${itemId} and r.decision = 'approve' and r.prompt_version = ${SAME_MODEL_RECHECK_PROMPT_VERSION}
      and r.reject_revision = ${recheckRejectRevision("ri")} limit 1)`;
}
