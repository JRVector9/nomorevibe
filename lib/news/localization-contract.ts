import { z } from "zod";
import { ASSIST_SCHEMA_VERSION, assistHash, assistInputSchema, assistOutcomeSchemas, type AssistInput } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";

export const NEWS_LOCALIZATION_POLICY_VERSION = "news-ko-facts-2026-10-23.1";
export const newsLocalizationSourceSchema = z.object({
  id: z.number().int().positive().safe(), url: z.url(), title: z.string().min(1).max(4000),
  summary: z.string().max(32_000).nullable(), revision: z.string().min(1).max(1000),
  observedAt: z.string().min(1).max(1000), state: z.enum(["approved", "pending", "hidden"]),
}).strict();
export type NewsLocalizationSource = Readonly<z.infer<typeof newsLocalizationSourceSchema>>;
export type NewsLocalizationOutcome = Readonly<z.infer<typeof assistOutcomeSchemas.news>>;

/** 공개 상태와 원문 세대까지 고정한다. 제목/요약 해시만 맞는 과거 결과도 적용하지 않는다. */
export function newsLocalizationSourceHash(value: NewsLocalizationSource): string {
  return assistHash({ policyVersion: NEWS_LOCALIZATION_POLICY_VERSION, ...newsLocalizationSourceSchema.parse(value) });
}

export function buildNewsLocalizationInput(value: NewsLocalizationSource): Extract<AssistInput, { task: "news" }> {
  const source = newsLocalizationSourceSchema.parse(value), revision = newsLocalizationSourceHash(source);
  return assistInputSchema.parse({
    schemaVersion: ASSIST_SCHEMA_VERSION, task: "news", subject: { type: "news_item", id: source.id, revision },
    policyVersion: NEWS_LOCALIZATION_POLICY_VERSION, promptVersion: ASSIST_PROMPT_VERSION,
    sources: [{ sourceId: `news:${source.id}:${revision}`, kind: "news", url: source.url, revision,
      observedAt: source.observedAt, text: `${source.title}\n${source.summary ?? ""}`,
      completeness: "complete", httpStatus: null }],
    context: { title: source.title, summary: source.summary ?? "", locale: "ko" },
  }) as Extract<AssistInput, { task: "news" }>;
}

export type NewsLocalizationIssue = Readonly<{
  code: "invalid_contract" | "hidden_source" | "source_changed" | "not_a_translation_candidate"
    | "unsupported_price_expression" | "normalized_price_mismatch" | "draft_price_mismatch"
    | "release_stage_mismatch" | "availability_mismatch" | "release_scope_mismatch"
    | "qualification_lost" | "unsupported_confirmation" | "instruction_as_fact" | "normalized_name_missing"
    | "unsupported_free_claim" | "unsupported_release_expression" | "date_mismatch" | "unsupported_date_expression";
  location: "source" | "state" | "draft" | "evidence";
}>;
export type NewsLocalizationValidation =
  | { ok: true; sourceHash: string; title: string; summary: string; factsHash: string;
      semanticCoverage: "bounded_patterns"; authority: "translation_candidate_only" }
  | { ok: false; disposition: "needs_review"; issues: readonly NewsLocalizationIssue[] };
