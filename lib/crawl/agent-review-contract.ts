import { createHash } from "node:crypto";
import { z } from "zod";
import type { CrawlCandidate, CrawlDocument, AgentRepositoryScan } from "@/lib/db/schema";
import { CATEGORIES } from "@/lib/domain/products/schema";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";
import { summarizeAgentEvidence } from "@/lib/domain/evidence/agents/summary";
import type { CrawlSettings } from "./settings-schema";

export const REVIEW_PROMPT_VERSION = "2026-09-08.1";
export const REVIEW_RULES_VERSION = "2026-09-08.1";
export const MAX_REVIEW_INPUT_BYTES = 64 * 1024;
export const MAX_REVIEW_ATTEMPTS = 3;
export const REVIEW_FRESH_MS = 24 * 3600_000;
export const reviewOutcomeSchema = z.object({
  decision: z.enum(["approve", "reject", "needs_review"]),
  reason: z.string().trim().min(1).max(2000),
  evidenceIds: z.array(z.string().min(1).max(100)).max(40),
  category: z.enum(CATEGORIES).optional(),
}).strict();
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;
export type ReviewEvidence = { id: string; observation: AgentObservation };
export type ReviewSource = {
  candidateJudgedAt: string | null;
  documentId: number;
  documentFetchedAt: string;
  productUrl: string | null;
  scanId: number | null;
  scanSha: string | null;
  scanStartedAt: string | null;
  scanCompletedAt: string | null;
  scanState: string | null;
  scanError: string | null;
  detectorVersion: string;
};
export type ReviewSnapshot = {
  product: { repo: string; name: string; description: string; url: string | null; topics: string[]; language: string | null };
  policy: { rulesVersion: string; promptVersion: string; detectorVersion: string; policyVersion: string; enforceEligibility: boolean };
  evidence: ReviewEvidence[];
  evidenceSummary: ReturnType<typeof summarizeAgentEvidence>;
  relationship: "same_product" | "unknown" | "conflict";
  scanState: "pending" | "complete" | "partial" | "failed";
  evidenceTruncated: boolean;
};
export type ReviewInput = {
  snapshot: ReviewSnapshot;
  inputHash: string;
  policyHash: string;
  sourceRevisionHash: string;
  source: ReviewSource;
  validUntil: Date;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
export const reviewHash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export function reviewPolicyHash(settings: CrawlSettings): string {
  return reviewHash({ judge: settings.judge, agentEvidence: {
    enforceEligibility: settings.agentEvidence.enforceEligibility,
    detectorVersion: settings.agentEvidence.detectorVersion,
    policyVersion: settings.agentEvidence.policyVersion,
  }, rulesVersion: REVIEW_RULES_VERSION, promptVersion: REVIEW_PROMPT_VERSION });
}
const limitedText = (value: unknown, size: number) => typeof value === "string" ? value.slice(0, size).trim() : "";

export function createReviewInput(
  candidate: CrawlCandidate,
  document: CrawlDocument,
  settings: CrawlSettings,
  evidence: { scan: AgentRepositoryScan | null; observations: ReviewEvidence[] },
  now = new Date(),
): ReviewInput {
  const scan = evidence.scan;
  const fetchedAt = document.fetchedAt.getTime();
  const siteFresh = fetchedAt <= now.getTime() && fetchedAt + REVIEW_FRESH_MS > now.getTime();
  const raw = siteFresh ? document.pageMeta?.repositoryKeys : undefined;
  const keys = Array.isArray(raw) ? [...new Set(raw.filter((key): key is string => typeof key === "string")
    .map(key => key.replace(/^github:/, "").toLowerCase()))] : [];
  const relationship = keys.length === 1 ? keys[0] === document.repo.toLowerCase() ? "same_product" : "conflict" : "unknown";
  const scanFresh = scan?.completedAt && scan.completedAt <= now
    && scan.completedAt.getTime() + REVIEW_FRESH_MS > now.getTime()
    && scan.detectorVersion === settings.agentEvidence.detectorVersion && !scan.lastErrorCode;
  const scanState = scan?.state === "complete" && !scanFresh ? "pending" : scan?.state ?? "pending";
  const all = evidence.observations.filter(item => item.observation.scope === "")
    .sort((a, b) => canonical(a.observation).localeCompare(canonical(b.observation)));
  const page = document.pageMeta ?? {};
  const snapshot: ReviewSnapshot = {
    product: {
      repo: candidate.repo,
      name: limitedText(page.title, 300) || candidate.repo.split("/").at(-1)!,
      description: [limitedText(page.description, 6000), limitedText(document.repoMeta.description, 6000)].filter(Boolean).join("\n"),
      url: candidate.productUrl,
      topics: Array.isArray(document.repoMeta.topics) ? document.repoMeta.topics.slice(0, 30).map(item => limitedText(item, 100)) : [],
      language: limitedText(document.repoMeta.language, 100) || null,
    },
    policy: { rulesVersion: REVIEW_RULES_VERSION, promptVersion: REVIEW_PROMPT_VERSION,
      detectorVersion: settings.agentEvidence.detectorVersion, policyVersion: settings.agentEvidence.policyVersion,
      enforceEligibility: settings.agentEvidence.enforceEligibility },
    evidence: all.slice(0, 32),
    evidenceSummary: summarizeAgentEvidence({ relationship, scanState, observations: [] }),
    relationship, scanState, evidenceTruncated: all.length > 32,
  };
  while (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_REVIEW_INPUT_BYTES && snapshot.evidence.length) {
    snapshot.evidence.pop();
    snapshot.evidenceTruncated = true;
  }
  snapshot.evidenceSummary = summarizeAgentEvidence({ relationship, scanState,
    observations: snapshot.evidence.map(item => item.observation) });
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_REVIEW_INPUT_BYTES) throw new Error("review_input_too_large");
  const source: ReviewSource = {
    candidateJudgedAt: candidate.judgedAt?.toISOString() ?? null,
    documentId: document.id, documentFetchedAt: document.fetchedAt.toISOString(), productUrl: document.productUrl,
    scanId: scan?.id ?? null, scanSha: scan?.commitSha ?? null, scanStartedAt: scan?.startedAt?.toISOString() ?? null,
    scanCompletedAt: scan?.completedAt?.toISOString() ?? null,
    scanState: scan?.state ?? null, scanError: scan?.lastErrorCode ?? null, detectorVersion: settings.agentEvidence.detectorVersion,
  };
  const policyHash = reviewPolicyHash(settings);
  // IDs and observation timestamps locate the source, but do not change its semantic judgment.
  const semantic = { ...snapshot, evidence: snapshot.evidence.map(item => item.observation) };
  return { snapshot, source, policyHash, inputHash: reviewHash({ snapshot: semantic, policyHash }),
    sourceRevisionHash: reviewHash(source),
    validUntil: new Date(Math.min(fetchedAt + REVIEW_FRESH_MS,
      scan?.completedAt ? scan.completedAt.getTime() + REVIEW_FRESH_MS : Infinity)) };
}

export function validateReviewOutcome(input: ReviewInput, value: unknown): ReviewOutcome {
  const outcome = reviewOutcomeSchema.parse(value);
  const allowed = new Set(["product", ...input.snapshot.evidence.map(item => item.id)]);
  if (outcome.evidenceIds.some(id => !allowed.has(id))) throw new Error("review_unknown_evidence");
  if (outcome.decision !== "needs_review" && outcome.evidenceIds.length === 0) throw new Error("review_missing_evidence");
  if (outcome.decision === "approve" && input.snapshot.policy.enforceEligibility && !input.snapshot.evidenceSummary.eligible) {
    throw new Error("review_evidence_policy_failed");
  }
  return outcome;
}

export const REVIEW_RETRIABLE_REASONS = ["ambiguous", "ai_evidence_pending", "ai_evidence_insufficient",
  "ai_evidence_not_found", "repository_relationship_conflict", "source_changed"] as const;
export function isReviewCandidate(candidate: CrawlCandidate): boolean {
  return candidate.decidedBy === "auto" && (candidate.state === "approved"
    || candidate.state === "needs_review" && REVIEW_RETRIABLE_REASONS.some(reason => reason === candidate.reason));
}
