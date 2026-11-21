import { sql, type SQL } from "drizzle-orm";
import { rollingCampaignSql } from "./audit-stream";
import { auditItemModel } from "./product-audit-hold";
import { opinionBareModelSql, rejudgeSecondOpinionModels } from "./rejudge-second-opinion-models";
import { bareModelName } from "./review-model-identity";

export const SAME_MODEL_RECHECK_SOURCE = "same-model-recheck";
export const SAME_MODEL_RECHECK_PROMPT_VERSION = "2026-11-17.same-model-recheck.v1";
export { SAME_MODEL_RECHECK_LABEL } from "./same-model-recheck-label";

/** Explicit same-model exception, confined to this advisory path and this task's saved ranks. */
export async function sameModelRecheckModel(model: string) {
  if ((await rejudgeSecondOpinionModels(model)).length) return null;
  return (await rejudgeSecondOpinionModels(model, { sameModelRecheck: true }))[0] ?? null;
}

/** SQL fingerprint avoids timestamp precision loss and binds a recommendation to the original rejection. */
export const recheckRejectRevision = (alias: string): SQL => sql`md5(jsonb_build_array(${sql.identifier(alias)}.ai_model,
  ${sql.identifier(alias)}.ai_reason, ${sql.identifier(alias)}.reviewed_at)::text)`;

/** i = audit item, p = public product. Never imported by shared pipeline/replay selection. */
export function sameModelRecheckWanted(model: string): SQL {
  return sql`i.campaign_id = ${rollingCampaignSql} and i.product_id = p.id and i.slug = p.slug
    and i.ai_decision = 'reject' and i.human_decision is null and p.status in ('seeded', 'verified')
    and ${opinionBareModelSql(auditItemModel("i"))} = ${bareModelName(model)}
    and not exists (select 1 from product_audit_items n where n.product_id = p.id and n.id > i.id and n.ai_decision is not null)
    and not exists (select 1 from product_audit_second_opinions o where o.item_id = i.id)
    and not exists (select 1 from product_audit_same_model_rechecks r where r.item_id = i.id
      and r.reject_revision = ${recheckRejectRevision("i")} and r.prompt_version = ${SAME_MODEL_RECHECK_PROMPT_VERSION})`;
}
