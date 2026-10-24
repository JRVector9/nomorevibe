import { randomUUID } from "node:crypto";
import { ASSIST_SCHEMA_VERSION, assistHash, assistInputHash, type AssistInput, type AssistOutcome } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";
import type { ActionAuditCandidate, ActionAuditPolicy, AutomatedDecision } from "@/lib/domain/products/automated-action-audit";

export const at = new Date("2026-10-23T10:00:00Z"), periodStart = "2026-10-19", seed = "independent-audit-test-seed-32-characters";
export const policy: ActionAuditPolicy = { enabled: true, lookbackDays: 7, perStratum: 2, maxAuditsPerWeek: 10, maxExceptionsPerWeek: 1, maxCandidates: 100 };
export const auditSource = { sourceId: "page-old-model-confidence", kind: "page" as const, url: "https://example.com",
  observedAt: "2026-10-23T09:59:59Z", revision: "page-v1", text: "The service is permanently closed. The tool also had an active plan.",
  completeness: "complete" as const, httpStatus: 200 };
export const originalInput: AssistInput = { schemaVersion: ASSIST_SCHEMA_VERSION, task: "uptime", subject: { type: "product", id: 1,
  revision: "2026-10-22 10:00:00.123456" }, policyVersion: "uptime-test", promptVersion: ASSIST_PROMPT_VERSION, sources: [auditSource],
  context: { requestedUrl: "https://example.com", finalUrl: "https://example.com", failureCount: 10, requiredFailures: 10, administratorReleased: false } };
export const originalWorkSource = { kind: "uptime", product: { id: 1, slug: "example", url: "https://example.com", updatedAt: originalInput.subject.revision },
  health: { failures: 10, status: 404, checkedAt: "2026-10-22 11:00:00.123456", downSince: "2026-10-22 10:00:00.123456" } };
export const closed: AssistOutcome = { schema_version: ASSIST_SCHEMA_VERSION, task: "uptime", state: { page_state: "closed", finding: "explicit_shutdown" },
  evidence_quality: { status: "sufficient", limitations: ["none"] },
  evidence: [{ source_id: auditSource.sourceId, quote: "permanently closed", supports: ["/state/page_state"] }],
  action: { proposal: "delist_candidate", reason_ko: "이전 결론 노출 금지 특별 문장", missing_items: [] } };
export const alive: AssistOutcome = { ...closed, state: { page_state: "alive", finding: "active_product" },
  evidence: [{ source_id: auditSource.sourceId, quote: "active plan", supports: ["/state/page_state"] }],
  action: { proposal: "retain", reason_ko: "사용 가능한 제품입니다.", missing_items: [] } };
export function decision(changes: Partial<AutomatedDecision> = {}): AutomatedDecision {
  return { resultId: randomUUID(), workId: randomUUID(), productId: 1, task: "uptime", modelFamily: "qwen3.8-flash-next",
    decidedAt: "2026-10-22T10:00:00Z", sourceHash: assistHash(originalWorkSource), inputHash: assistInputHash(originalInput),
    policyVersion: originalInput.policyVersion, promptVersion: originalInput.promptVersion, applied: true,
    input: originalInput, outcome: closed, ...changes };
}
export function candidate(d = decision()): ActionAuditCandidate {
  return { kind: "decision_audit", product: { id: 1, slug: "example", url: "https://example.com", updatedAt: "2026-10-23 09:00:00.123456", status: "banned" },
    decision: d, periodStart, selectedAt: "2026-10-23T09:59:00Z", seedHash: assistHash(seed), conflict: null };
}
export function independentFinding(input: AssistInput, value: "alive" | "closed" = "alive"): AssistOutcome {
  return { schema_version: ASSIST_SCHEMA_VERSION, task: "audit", state: { audit_subject: "uptime", independent_finding: value,
    applicable_rule_ids: ["uptime-current-page"] }, evidence_quality: { status: "sufficient", limitations: ["none"] },
    evidence: [{ source_id: input.sources[0].sourceId, quote: value === "closed" ? "permanently closed" : "active plan", supports: ["/state/independent_finding"] }],
    action: { proposal: "record_finding", reason_ko: "현재 근거를 독립적으로 검토했습니다.", missing_items: [] } };
}
