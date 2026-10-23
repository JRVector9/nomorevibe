import { createHmac } from "node:crypto";
import { z } from "zod";
import { ASSIST_SCHEMA_VERSION, assistHash, assistInputHash, assistInputSchema, assistOutcomeSchema,
  assistSourceSchema, validateAssistOutcome, type AssistInput, type AssistOutcome, type AssistSource } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";

export const ACTION_AUDIT_POLICY_VERSION = "automated-action-audit-2026-10-23.1";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rawRevision = z.string().min(1).max(1000);
export const actionAuditSubjectSchema = z.enum(["uptime", "repo", "intro"]);
export type ActionAuditSubject = z.infer<typeof actionAuditSubjectSchema>;
export const currentActionAuditFactsSchema = z.discriminatedUnion("task", [
  z.object({ task: z.literal("uptime"), requestedUrl: z.url() }).strict(),
  z.object({ task: z.literal("repo"), repositoryUrl: z.url().nullable(), productName: z.string().max(120), description: z.string().max(8000) }).strict(),
  z.object({ task: z.literal("intro"), tagline: z.string().max(4000), taglineSource: z.string().max(20) }).strict(),
]);
export type CurrentActionAuditFacts = Readonly<z.infer<typeof currentActionAuditFactsSchema>>;
const finding = z.enum(["alive", "closed", "parked", "soft_404", "unclear", "same_project", "unrelated", "keep", "rewrite_candidate", "human"]);
export const actionAuditProductSchema = z.object({ id: z.number().int().positive().safe(), slug: z.string().min(1).max(80),
  url: z.url(), updatedAt: rawRevision, status: z.string().min(1).max(24) }).strict();

/** 원 모델 family는 출처에서 확인된 값만 받는다. unknown/이전 누락을 새 모델명으로 채우지 않는다. */
export const automatedDecisionSchema = z.object({ resultId: z.uuid(), workId: z.uuid(), productId: z.number().int().positive().safe(),
  task: actionAuditSubjectSchema, modelFamily: z.string().min(1).max(120).nullable(), decidedAt: rawRevision,
  sourceHash: hash, inputHash: hash, policyVersion: z.string().min(1).max(120), promptVersion: z.string().min(1).max(120),
  applied: z.boolean(), input: assistInputSchema, outcome: assistOutcomeSchema }).strict().superRefine((value, context) => {
  if (value.input.task !== value.task || value.outcome.task !== value.task || value.input.subject.id !== value.productId
    || value.input.subject.type !== "product" || value.inputHash !== assistInputHash(value.input)
    || value.input.policyVersion !== value.policyVersion || value.input.promptVersion !== value.promptVersion
    || !validateAssistOutcome(value.input, value.outcome).ok) context.addIssue({ code: "custom", message: "invalid_automated_decision" });
});
export type AutomatedDecision = Readonly<z.infer<typeof automatedDecisionSchema>>;
const timestampMillis = (value: string) => Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value)
  ? value.replace(" ", "T") + "Z" : value);

export const actionAuditPolicySchema = z.object({ enabled: z.literal(true), lookbackDays: z.number().int().min(1).max(30),
  perStratum: z.number().int().min(1).max(100), maxAuditsPerWeek: z.number().int().min(1).max(1000),
  maxExceptionsPerWeek: z.number().int().min(0).max(1000), maxCandidates: z.number().int().min(1).max(10000) }).strict();
export type ActionAuditPolicy = Readonly<z.infer<typeof actionAuditPolicySchema>>;
export function readActionAuditPolicy(env: Readonly<Record<string, string | undefined>> = process.env):
  { enabled: false } | { enabled: true; policy: ActionAuditPolicy; seed: string } {
  if (!env.LLM_ACTION_AUDIT_POLICY) return { enabled: false };
  const raw: unknown = JSON.parse(env.LLM_ACTION_AUDIT_POLICY);
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 1 && (raw as { enabled?: unknown }).enabled === false)
    return { enabled: false };
  const policy = actionAuditPolicySchema.parse(raw), seed = env.LLM_ACTION_AUDIT_SEED;
  if (!seed || seed.length < 32 || seed.length > 4096) throw new Error("action_audit_seed_required");
  return { enabled: true, policy, seed };
}

export function actionAuditPeriod(at: Date): string {
  if (!Number.isFinite(at.getTime())) throw new Error("invalid_audit_time");
  const monday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday.toISOString().slice(0, 10);
}
const knownFamilies = new Set(["qwen3.8-flash-next", "deepseek-v4.1-flash-1017", "gpt-oss-120b"]);
export function independentAuditFamily(original: string | null, auditor: string): boolean {
  return original !== null && knownFamilies.has(original) && knownFamilies.has(auditor) && original !== auditor;
}
export function preferredAuditFamily(original: string | null): "qwen3.8-flash-next" | "deepseek-v4.1-flash-1017" | null {
  return original === "qwen3.8-flash-next" ? "deepseek-v4.1-flash-1017"
    : original !== null && knownFamilies.has(original) ? "qwen3.8-flash-next" : null;
}
export function decisionFinding(outcome: AssistOutcome): string | null {
  return outcome.task === "uptime" ? outcome.state.page_state : outcome.task === "repo" ? outcome.state.relationship
    : outcome.task === "intro" ? outcome.state.treatment : null;
}
const ascii = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** 층별 random rank는 비밀 seed·주간·결정ID에 고정한다. 입력 순서·재시작이 표본을 바꾸지 않는다. */
export function selectActionAuditSample(values: readonly AutomatedDecision[], periodStart: string, seed: string, policy: ActionAuditPolicy,
  at: Date): { selected: AutomatedDecision[]; skippedUnknownFamily: number; candidatesClipped: boolean } {
  actionAuditPolicySchema.parse(policy);
  if (actionAuditPeriod(at) !== periodStart || seed.length < 32) throw new Error("invalid_audit_sample_context");
  const rank = (key: string) => createHmac("sha256", seed).update(`${periodStart}:${key}`).digest("hex");
  const distinct = new Map<string, AutomatedDecision>(); let skippedUnknownFamily = 0;
  for (const value of values) {
    const decision = automatedDecisionSchema.parse(value), time = timestampMillis(decision.decidedAt);
    if (!Number.isFinite(time) || time > at.getTime() || time < at.getTime() - policy.lookbackDays * 86400000) continue;
    if (!preferredAuditFamily(decision.modelFamily)) { skippedUnknownFamily++; continue; }
    const previous = distinct.get(decision.resultId);
    if (previous && assistHash(previous) !== assistHash(decision)) throw new Error("conflicting_audit_decision_id");
    distinct.set(decision.resultId, decision);
  }
  const candidates = [...distinct.values()].sort((a, b) => ascii(rank(a.resultId), rank(b.resultId)) || ascii(a.resultId, b.resultId));
  const groups = new Map<string, AutomatedDecision[]>();
  for (const decision of candidates.slice(0, policy.maxCandidates)) {
    const key = `${decision.task}:${decision.outcome.action.proposal}:${decision.applied}:${decision.modelFamily}`;
    groups.set(key, [...(groups.get(key) ?? []), decision]);
  }
  const ordered = [...groups].sort(([a], [b]) => ascii(rank(`stratum:${a}`), rank(`stratum:${b}`)) || ascii(a, b));
  const selected: AutomatedDecision[] = [];
  for (let round = 0; round < policy.perStratum && selected.length < policy.maxAuditsPerWeek; round++) {
    for (const [, items] of ordered) if (items[round] && selected.length < policy.maxAuditsPerWeek) selected.push(items[round]);
  }
  return { selected, skippedUnknownFamily, candidatesClipped: candidates.length > policy.maxCandidates };
}

const rules: Readonly<Record<ActionAuditSubject, readonly string[]>> = {
  uptime: ["uptime-current-page", "uptime-existing-threshold", "administrator-release"],
  repo: ["repository-project-identity", "repository-official-continuity", "repository-maker-protection"],
  intro: ["intro-factual-match", "intro-maker-protection", "intro-name-only-placeholder"],
};
export const actionAuditCandidateSchema = z.object({ kind: z.enum(["decision_audit", "semantic_exception"]),
  product: actionAuditProductSchema, decision: automatedDecisionSchema, periodStart: z.iso.date(), selectedAt: rawRevision,
  seedHash: hash, conflict: z.object({ otherResultId: z.uuid(), otherOutcomeHash: hash,
    subject: actionAuditSubjectSchema }).strict().nullable() }).strict().superRefine((value, context) => {
  if (value.product.id !== value.decision.productId || (value.kind === "semantic_exception") !== (value.conflict !== null)
    || value.conflict && value.conflict.subject !== value.decision.task) context.addIssue({ code: "custom", message: "invalid_audit_candidate" });
});
export type ActionAuditCandidate = Readonly<z.infer<typeof actionAuditCandidateSchema>>;
export function actionAuditSourceHash(candidate: ActionAuditCandidate): string { return assistHash(actionAuditCandidateSchema.parse(candidate)); }

/** 모델에는 과거 결론·이유·family·backend·confidence·결정ID를 보내지 않는다. 수집 근거 metadata도 제외한다. */
export function buildBlindedActionAuditInput(value: ActionAuditCandidate, currentSources: readonly AssistSource[], protections:
  { administratorReleased: boolean; makerProtected: boolean }, factsValue: CurrentActionAuditFacts, at = new Date()): AssistInput {
  const candidate = actionAuditCandidateSchema.parse(value);
  const facts = currentActionAuditFactsSchema.parse(factsValue);
  if (facts.task !== candidate.decision.task) throw new Error("audit_current_subject_mismatch");
  const sources = currentSources.filter(source => ["page", "rendered_page", "readme", "repository"].includes(source.kind))
    .map((source, index) => assistSourceSchema.parse({ ...source, sourceId: `evidence-${index + 1}` }));
  if (!sources.some(source => source.completeness === "complete" && source.text.trim() && timestampMillis(source.observedAt) <= at.getTime()
    && timestampMillis(source.observedAt) >= at.getTime() - 300_000 && timestampMillis(source.observedAt) >= timestampMillis(candidate.selectedAt)))
    throw new Error("audit_current_evidence_required");
  sources.push({ sourceId: "current-subject", kind: "metadata", url: null, observedAt: at.toISOString(),
    revision: candidate.product.updatedAt, text: JSON.stringify(facts), completeness: "complete", httpStatus: null });
  return assistInputSchema.parse({ schemaVersion: ASSIST_SCHEMA_VERSION, task: "audit", subject: { type: "product", id: candidate.product.id,
    revision: candidate.product.updatedAt }, policyVersion: ACTION_AUDIT_POLICY_VERSION, promptVersion: ASSIST_PROMPT_VERSION,
    sources, context: { subject: candidate.decision.task, ruleIds: [...rules[candidate.decision.task]], ...protections } });
}

export function semanticConflictEligible(reason: "capacity" | "transport" | "invalid_output" | "missing_evidence" | "semantic_conflict",
  first: AutomatedDecision, second: AutomatedDecision): boolean {
  if (reason !== "semantic_conflict" || first.resultId === second.resultId || first.inputHash !== second.inputHash
    || first.productId !== second.productId || first.task !== second.task
    || first.sourceHash !== second.sourceHash || first.modelFamily !== "qwen3.8-flash-next"
    || second.modelFamily !== "qwen3.8-flash-next") return false;
  if (!automatedDecisionSchema.safeParse(first).success || !automatedDecisionSchema.safeParse(second).success) return false;
  return first.outcome.evidence_quality.status === "sufficient" && second.outcome.evidence_quality.status === "sufficient"
    && decisionFinding(first.outcome) !== decisionFinding(second.outcome)
    && !["unclear", "human", null].includes(decisionFinding(first.outcome)) && !["unclear", "human", null].includes(decisionFinding(second.outcome));
}

export const actionAuditComparisonSchema = z.object({ status: z.enum(["agree", "human_review", "needs_evidence", "invalid", "not_independent"]),
  reason: z.string().min(1).max(120), originalFinding: finding.nullable(), currentFinding: finding.nullable(),
  authority: z.literal("record_only"), interpretation: z.literal("current_evidence_comparison") }).strict();
export type ActionAuditComparison = Readonly<z.infer<typeof actionAuditComparisonSchema>>;
export function compareActionAudit(candidateValue: ActionAuditCandidate, input: AssistInput, value: unknown, auditorFamily: string, at = new Date()): ActionAuditComparison {
  const candidate = actionAuditCandidateSchema.parse(candidateValue), originalFinding = finding.safeParse(decisionFinding(candidate.decision.outcome));
  const base = { originalFinding: originalFinding.success ? originalFinding.data : null, currentFinding: null,
    authority: "record_only" as const, interpretation: "current_evidence_comparison" as const };
  if (!independentAuditFamily(candidate.decision.modelFamily, auditorFamily)) return { ...base, status: "not_independent", reason: "same_or_unknown_model_family" };
  if (auditorFamily !== preferredAuditFamily(candidate.decision.modelFamily)) return { ...base, status: "not_independent", reason: "auditor_family_not_selected" };
  const metadata = input.sources.find(source => source.sourceId === "current-subject" && source.kind === "metadata");
  const facts = currentActionAuditFactsSchema.safeParse((() => { try { return JSON.parse(metadata?.text ?? "null"); } catch { return null; } })());
  const parsed = validateAssistOutcome(input, value);
  if (!parsed.ok || input.task !== "audit" || parsed.outcome.task !== "audit" || input.context.subject !== candidate.decision.task
    || input.subject.id !== candidate.product.id || input.subject.revision !== candidate.product.updatedAt
    || input.policyVersion !== ACTION_AUDIT_POLICY_VERSION || input.promptVersion !== ASSIST_PROMPT_VERSION
    || input.sources.filter(source => source.kind === "metadata").length !== 1
    || !facts.success || facts.data.task !== candidate.decision.task
    || input.context.ruleIds.length !== rules[candidate.decision.task].length
    || input.context.ruleIds.some((rule, i) => rule !== rules[candidate.decision.task][i]))
    return { ...base, status: "invalid", reason: "invalid_audit_result" };
  const outcome = parsed.outcome;
  if (outcome.evidence_quality.status !== "sufficient" || outcome.action.proposal !== "record_finding"
    || ["unclear", "human"].includes(outcome.state.independent_finding)
    || !outcome.evidence.some(evidence => input.sources.some(source => source.sourceId === evidence.source_id
      && source.kind !== "metadata" && source.completeness === "complete" && timestampMillis(source.observedAt) <= at.getTime()
      && timestampMillis(source.observedAt) >= at.getTime() - 300_000 && timestampMillis(source.observedAt) >= timestampMillis(candidate.selectedAt))))
    return { ...base, status: "needs_evidence", reason: "independent_finding_insufficient" };
  const currentFinding = outcome.state.independent_finding;
  if (candidate.decision.task === "intro" && candidate.decision.input.task === "intro" && candidate.decision.applied
    && candidate.decision.outcome.action.proposal === "rewrite_candidate" && candidate.decision.input.context.makerProtected
    && !candidate.decision.input.context.placeholderEligible) return { ...base, currentFinding, status: "human_review", reason: "server_maker_protection_violation" };
  return { ...base, currentFinding, status: currentFinding === base.originalFinding ? "agree" : "human_review",
    reason: currentFinding === base.originalFinding ? "current_evidence_agrees" : "current_evidence_disagrees" };
}

/** 모델 출처가 unknown인 과거 기록에도 쓸 수 있는 결정적 서버 규칙 검토다. 독립 모델 감사로 집계하지 않는다. */
export function auditServerProtectionDecision(input: { task: ActionAuditSubject; action: string; applied: boolean;
  administratorReleasedAtDecision: boolean | null; makerProtectedAtDecision: boolean | null; placeholderEligibleAtDecision: boolean | null }) {
  const violation = input.applied && (input.task === "uptime" && input.action === "delist_candidate" && input.administratorReleasedAtDecision === true
    || input.task === "intro" && input.action === "rewrite_candidate" && input.makerProtectedAtDecision === true && input.placeholderEligibleAtDecision === false);
  const unknown = input.task === "uptime" ? input.administratorReleasedAtDecision === null
    : input.task === "intro" ? input.makerProtectedAtDecision === null || input.placeholderEligibleAtDecision === null : true;
  return { kind: "server_rule_audit" as const, status: violation ? "human_review" as const : unknown ? "insufficient_snapshot" as const : "no_violation_observed" as const,
    independentModelAudit: false as const, authority: "record_only" as const };
}
