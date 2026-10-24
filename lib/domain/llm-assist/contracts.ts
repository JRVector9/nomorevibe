import { createHash } from "node:crypto";
import { z } from "zod";

export const ASSIST_SCHEMA_VERSION = "2026-10-23.1";
export const ASSIST_POLICY_VERSION = "2026-10-23.1";
export const assistTaskSchema = z.enum(["uptime", "repo", "intro", "audit", "news"]);
export type AssistTask = z.infer<typeof assistTaskSchema>;
const identity = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().max(max);
const positive = z.number().int().positive().safe();
const rawRevision = z.string().min(1).max(1000);

export const assistSourceSchema = z.object({
  sourceId: identity, kind: z.enum(["page", "rendered_page", "readme", "repository", "news", "metadata"]),
  url: z.url().nullable(), observedAt: rawRevision, revision: rawRevision, text: text(100_000),
  completeness: z.enum(["complete", "truncated", "blocked", "missing"]),
  httpStatus: z.number().int().min(0).max(999).nullable(),
}).strict();
export type AssistSource = Readonly<z.infer<typeof assistSourceSchema>>;
const subjectSchema = z.object({ type: z.enum(["product", "news_item"]), id: positive, revision: rawRevision }).strict();
const commonInput = z.object({
  schemaVersion: z.literal(ASSIST_SCHEMA_VERSION), task: assistTaskSchema, subject: subjectSchema,
  policyVersion: identity, promptVersion: identity, sources: z.array(assistSourceSchema).max(16),
});
const uptimeContext = z.object({ requestedUrl: z.url(), finalUrl: z.url().nullable(),
  failureCount: z.number().int().nonnegative().safe(), requiredFailures: positive, administratorReleased: z.boolean() }).strict();
const repoContext = z.object({ oldRepositoryUrl: z.url(), productName: text(300), productDescription: text(8000),
  candidateRepositoryUrls: z.array(z.url()).max(12) }).strict();
const introContext = z.object({ tagline: text(4000), author: z.enum(["maker", "operator", "unknown"]),
  makerProtected: z.boolean(), placeholderEligible: z.boolean(), language: identity.nullable() }).strict();
const auditContext = z.object({ subject: z.enum(["uptime", "repo", "intro"]), ruleIds: z.array(identity).max(20),
  administratorReleased: z.boolean(), makerProtected: z.boolean() }).strict();
const newsContext = z.object({ title: text(4000), summary: text(32_000), locale: z.literal("ko") }).strict();
export const assistInputSchema = z.discriminatedUnion("task", [
  commonInput.extend({ task: z.literal("uptime"), context: uptimeContext }).strict(),
  commonInput.extend({ task: z.literal("repo"), context: repoContext }).strict(),
  commonInput.extend({ task: z.literal("intro"), context: introContext }).strict(),
  commonInput.extend({ task: z.literal("audit"), context: auditContext }).strict(),
  commonInput.extend({ task: z.literal("news"), context: newsContext }).strict(),
]).superRefine((value, context) => {
  if ((value.task === "news") !== (value.subject.type === "news_item")) {
    context.addIssue({ code: "custom", message: "invalid_subject_type", path: ["subject"] });
  }
  if (new Set(value.sources.map(source => source.sourceId)).size !== value.sources.length) {
    context.addIssue({ code: "custom", message: "duplicate_source", path: ["sources"] });
  }
});
export type AssistInput = Readonly<z.infer<typeof assistInputSchema>>;

const quality = z.object({ status: z.enum(["sufficient", "partial", "blocked", "conflicting", "missing"]),
  limitations: z.array(z.enum(["none", "truncated", "challenge", "no_body", "no_readme", "no_identity",
    "no_official_link", "unknown_author", "conflicting_sources", "stale_source", "missing_unit", "missing_release_stage", "other"])).max(8),
}).strict();
const evidence = z.object({ source_id: identity, quote: z.string().min(1).max(320),
  supports: z.array(z.string().regex(/^\/state\/(?:[a-z_]+|\d+)(?:\/(?:[a-z_]+|\d+))*$/)).min(1).max(8) }).strict();
const action = <T extends [string, ...string[]]>(values: T) => z.object({ proposal: z.enum(values),
  reason_ko: z.string().trim().min(1).max(240), missing_items: z.array(z.string().min(1).max(120)).max(8) }).strict();
const commonOutcome = z.object({ schema_version: z.literal(ASSIST_SCHEMA_VERSION), task: assistTaskSchema,
  evidence_quality: quality, evidence: z.array(evidence).max(24) });
const pageState = z.enum(["alive", "closed", "parked", "soft_404", "unclear"]);
const relationship = z.enum(["same_project", "unrelated", "unclear"]);
const treatment = z.enum(["keep", "rewrite_candidate", "human"]);

const uptimeOutcome = commonOutcome.extend({ task: z.literal("uptime"),
  state: z.object({ page_state: pageState, finding: z.enum(["active_product", "explicit_shutdown", "domain_parking",
    "missing_requested_resource", "temporary_maintenance", "access_challenge", "insufficient_content", "conflict"]) }).strict(),
  action: action(["retain", "delist_candidate", "collect_evidence", "human_review", "independent_review"]),
}).strict();
const repoOutcome = commonOutcome.extend({ task: z.literal("repo"),
  state: z.object({ project_identity: z.enum(["matches", "different", "unknown"]),
    code_lineage: z.enum(["original", "fork_or_copy", "independent", "unknown"]),
    official_continuity: z.enum(["explicit_move", "author_continuity", "unverified", "contradicted"]), relationship }).strict(),
  action: action(["retain", "update_repo_candidate", "delist_candidate", "collect_evidence", "human_review", "independent_review"]),
}).strict();
const introOutcome = commonOutcome.extend({ task: z.literal("intro"),
  state: z.object({ factual_match: z.enum(["supported", "explicit_mismatch", "unsupported_claim", "conflicting", "insufficient"]),
    content_kind: z.enum(["descriptive", "performance_or_value_claim", "name_only_placeholder", "unknown"]),
    author_protection: z.enum(["server_maker_protected", "server_operator", "server_unknown"]), treatment }).strict(),
  action: action(["retain", "rewrite_candidate", "collect_evidence", "human_review", "independent_review"]),
}).strict();
const auditOutcome = commonOutcome.extend({ task: z.literal("audit"),
  state: z.object({ audit_subject: z.enum(["uptime", "repo", "intro"]),
    independent_finding: z.enum(["alive", "closed", "parked", "soft_404", "unclear", "same_project", "unrelated", "keep", "rewrite_candidate", "human"]),
    applicable_rule_ids: z.array(identity).max(20) }).strict(),
  action: action(["record_finding", "collect_evidence", "human_review"]),
}).strict();
const newsOutcome = commonOutcome.extend({ task: z.literal("news"), state: z.object({
  names: z.array(z.object({ original: z.string().min(1).max(200), korean: text(200).nullable() }).strict()).max(12),
  prices: z.array(z.object({ amount: z.string().min(1).max(40), currency: z.string().min(1).max(40),
    per_quantity: z.string().min(1).max(40), per_unit: z.string().min(1).max(80),
    direction: z.enum(["input", "output", "other"]), effective_status: z.enum(["current", "planned", "unknown"]) }).strict()).max(12),
  quantities: z.array(z.object({ value: text(80), unit: text(80), qualifier: text(160) }).strict()).max(16),
  dates: z.array(z.object({ original: text(120), iso_date: z.iso.date().nullable(), event: text(200) }).strict()).max(8),
  release: z.object({ stage: z.enum(["preview", "beta", "general_availability", "research", "unknown"]),
    availability: z.enum(["available", "planned", "delayed", "unavailable", "unknown"]),
    scope: z.array(z.enum(["api", "weights", "training_code", "training_data", "paper", "product", "unknown"])).max(8) }).strict(),
  qualifications: z.array(z.string().min(1).max(240)).max(12),
  draft: z.object({ title: z.string().min(1).max(45).nullable(), summary: z.string().min(1).max(1200).nullable() }).strict(),
}).strict(), action: action(["publish_translation_candidate", "collect_evidence", "human_review", "independent_review"]) }).strict();

export const assistOutcomeSchemas = { uptime: uptimeOutcome, repo: repoOutcome, intro: introOutcome,
  audit: auditOutcome, news: newsOutcome } as const;
export const assistOutcomeSchema = z.discriminatedUnion("task", [uptimeOutcome, repoOutcome, introOutcome, auditOutcome, newsOutcome]);
export type AssistOutcome = Readonly<z.infer<typeof assistOutcomeSchema>>;

export function assistHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function assistInputHash(input: AssistInput): string { return assistHash(assistInputSchema.parse(input)); }
export function assistJsonSchema(task: AssistTask): Record<string, unknown> {
  return z.toJSONSchema(assistOutcomeSchemas[task]) as Record<string, unknown>;
}

function pointerExists(state: unknown, path: string): boolean {
  let current = state;
  for (const key of path.slice("/state/".length).split("/")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return current !== undefined && current !== null;
}

/** 근거·권한의 기계적 모순을 거른다. 인용이 존재한다는 사실만으로 의미 정확성을 보장하지 않는다. */
export function validateAssistOutcome(inputValue: AssistInput, value: unknown):
  { ok: true; outcome: AssistOutcome } | { ok: false; error: string } {
  const parsedInput = assistInputSchema.safeParse(inputValue);
  const parsed = assistOutcomeSchema.safeParse(value);
  if (!parsedInput.success || !parsed.success) return { ok: false, error: "invalid_schema" };
  const input = parsedInput.data, outcome = parsed.data;
  if (input.task !== outcome.task) return { ok: false, error: "task_mismatch" };
  for (const item of outcome.evidence) {
    const source = input.sources.find(source => source.sourceId === item.source_id);
    if (!source || !source.text.includes(item.quote)) return { ok: false, error: "invalid_evidence_quote" };
    if (item.supports.some(pointer => !pointerExists(outcome.state, pointer))) return { ok: false, error: "invalid_evidence_pointer" };
  }
  const sufficient = outcome.evidence_quality.status === "sufficient";
  const candidate = ["delist_candidate", "update_repo_candidate", "rewrite_candidate", "publish_translation_candidate"].includes(outcome.action.proposal);
  const limitations = outcome.evidence_quality.limitations;
  if (limitations.includes("none") && (limitations.length !== 1 || !sufficient)
    || sufficient && limitations.some(item => item !== "none")) return { ok: false, error: "contradictory_evidence_quality" };
  if (sufficient && (!outcome.evidence.length || !outcome.evidence.some(item => input.sources.some(source =>
    source.sourceId === item.source_id && source.completeness === "complete" && source.text.trim())))) {
    return { ok: false, error: "missing_complete_evidence" };
  }
  if (candidate && !sufficient) return { ok: false, error: "insufficient_evidence_for_candidate" };
  if (input.task === "uptime" && outcome.task === "uptime") {
    const { page_state: state, finding } = outcome.state;
    const expectedFinding = { alive: "active_product", closed: "explicit_shutdown", parked: "domain_parking", soft_404: "missing_requested_resource" };
    if (state !== "unclear" && finding !== expectedFinding[state]) return { ok: false, error: "state_finding_mismatch" };
    if (outcome.action.proposal === "delist_candidate" && (state === "alive" || state === "unclear"
      || input.context.administratorReleased || input.context.failureCount < input.context.requiredFailures)) {
      return { ok: false, error: "uptime_delist_not_permitted" };
    }
    if (state === "alive" && outcome.action.proposal !== "retain") return { ok: false, error: "alive_requires_retain" };
    if (state === "unclear" && !["collect_evidence", "human_review"].includes(outcome.action.proposal)) {
      return { ok: false, error: "unclear_requires_review" };
    }
  }
  if (input.task === "repo" && outcome.task === "repo") {
    const state = outcome.state;
    if (state.relationship === "same_project" && (state.project_identity !== "matches"
      || !["explicit_move", "author_continuity"].includes(state.official_continuity))) return { ok: false, error: "unverified_repository_move" };
    if (state.relationship === "unrelated" && state.project_identity !== "different") return { ok: false, error: "unverified_unrelated_repository" };
    if (outcome.action.proposal === "update_repo_candidate" && state.relationship !== "same_project"
      || outcome.action.proposal === "delist_candidate" && state.relationship !== "unrelated") return { ok: false, error: "repository_action_mismatch" };
  }
  if (input.task === "intro" && outcome.task === "intro") {
    const protectedMaker = input.context.makerProtected || input.context.author === "maker";
    const expected = protectedMaker ? "server_maker_protected" : input.context.author === "operator" ? "server_operator" : "server_unknown";
    if (outcome.state.author_protection !== expected) return { ok: false, error: "author_metadata_mismatch" };
    if (outcome.action.proposal === "rewrite_candidate" && (outcome.state.treatment !== "rewrite_candidate"
      || input.context.author === "unknown" || protectedMaker && !input.context.placeholderEligible
      || protectedMaker && outcome.state.content_kind !== "name_only_placeholder"
      || !protectedMaker && outcome.state.factual_match !== "explicit_mismatch")) return { ok: false, error: "intro_rewrite_not_permitted" };
  }
  if (input.task === "audit" && outcome.task === "audit") {
    const allowed = { uptime: ["alive", "closed", "parked", "soft_404", "unclear"],
      repo: ["same_project", "unrelated", "unclear"], intro: ["keep", "rewrite_candidate", "human"] };
    if (outcome.state.audit_subject !== input.context.subject
      || !allowed[input.context.subject].includes(outcome.state.independent_finding)
      || outcome.state.applicable_rule_ids.some(rule => !input.context.ruleIds.includes(rule))) return { ok: false, error: "invalid_audit_finding" };
  }
  if (input.task === "news" && outcome.task === "news" && outcome.action.proposal === "publish_translation_candidate") {
    const { draft } = outcome.state;
    if (!draft.title || !draft.summary) return { ok: false, error: "missing_translation" };
    const rendered = `${draft.title}\n${draft.summary}`;
    if (outcome.state.names.some(name => !rendered.includes(name.original))) return { ok: false, error: "original_name_missing" };
    // 가격·단위·출시 단계의 의미 검증은 news domain이 수행한다. 1000000/100만 같은 표현을 substring으로 채점하지 않는다.
  }
  return { ok: true, outcome };
}
