import { sql, type SQL } from "drizzle-orm";
import { ensureAiTaskModels } from "@/lib/llm/ai-task-models-snapshot";
import { taskModels } from "@/lib/llm/ai-task-resolver";
import { aiConnectionTaskAllowed } from "@/lib/llm/ai-tasks";
import { cliEngineEndpoint, cliEngineRevision, isCliEngineConnection } from "@/lib/llm/cli-engine-config";
import { cliEngineBearer } from "@/lib/llm/cli-engine-auth";
import { verifiedLocalModelContract } from "@/lib/llm/local-model-capacity";
import { bareModelName } from "./review-model-identity";
import { rollingCampaignSql } from "./audit-stream";
import type { QwenDirectConfig } from "./qwen-direct-review";

export type RejudgeOpinionModel = Readonly<{ config: QwenDirectConfig; servingRevision: string | null }>;
const TASK = "audit-second-opinion";

/** Only this task's saved ranks can supply an independent opinion. Admission still belongs to model capacity. */
export async function rejudgeSecondOpinionModels(primary: string, options?: { sameModelRecheck: true }): Promise<RejudgeOpinionModel[]> {
  await ensureAiTaskModels();
  const models: RejudgeOpinionModel[] = [];
  for (const rank of taskModels(TASK)) {
    const connection = rank.connection;
    if (!rank.enabled || !connection.enabled || !aiConnectionTaskAllowed(TASK, connection) || connection.keyUnreadable
      || !connection.baseUrl || (options?.sameModelRecheck
        ? bareModelName(rank.model) !== bareModelName(primary) : bareModelName(rank.model) === bareModelName(primary))
      || models.some(row => bareModelName(row.config.model) === bareModelName(rank.model))) continue;
    try {
      const baseUrl = connection.baseUrl.replace(/\/+$/, "");
      let apiKey = connection.apiKey, servingRevision: string | null = null;
      if (isCliEngineConnection(connection)) {
        if (!apiKey) continue;
        const effort = rank.options.reasoningEffort;
        if (effort !== undefined && typeof effort !== "string") continue;
        servingRevision = cliEngineRevision({ connectionId: connection.id, ...(effort ? { reasoningEffort: effort } : {}) });
        cliEngineEndpoint(baseUrl);
        apiKey = cliEngineBearer(apiKey);
      } else if (connection.kind !== "api") continue;
      if (!verifiedLocalModelContract(`${baseUrl}/chat/completions`, rank.model, process.env, servingRevision ?? undefined)) continue;
      models.push({ config: { baseUrl, model: rank.model, apiKey }, servingRevision });
    } catch { /* Invalid connection/contract stays human work, without an alternate transport. */ }
  }
  return models;
}

/** Same normalization as bareModelName, including connection aliases. */
export const opinionBareModelSql = (model: SQL): SQL => sql`lower(regexp_replace(regexp_replace(regexp_replace(trim(${model}), '@[0-9a-f]{8}$', ''), '^\\[[^]]*\\]\\s*', ''), '^[^/[:space:]]+/', ''))`;

/** Choose once before checking for an existing opinion: an answered rank never spills into yet another model. */
export function rejudgeSecondOpinionModelSql(primary: string, models: readonly RejudgeOpinionModel[], rejectingModel: SQL): SQL {
  if (!models.length) return sql`${primary}`;
  return sql`case when i.campaign_id = ${rollingCampaignSql} and ${opinionBareModelSql(rejectingModel)} = ${bareModelName(primary)}
    then case ${sql.join(models.map(({ config }) => sql`when not exists (select 1 from product_audit_attempts a
      where a.item_id = i.id and a.outcome is not null and ${opinionBareModelSql(sql`a.model`)} = ${bareModelName(config.model)})
      then ${config.model}`), sql` `)} else null end else ${primary} end`;
}
