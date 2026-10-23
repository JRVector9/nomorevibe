import { describe, expect, it } from "vitest";
import { assistHash } from "@/lib/domain/llm-assist/contracts";
import { buildAssistMessages } from "@/lib/domain/llm-assist/prompts";
import { actionAuditPeriod, auditServerProtectionDecision, buildBlindedActionAuditInput, compareActionAudit,
  independentAuditFamily, preferredAuditFamily, readActionAuditPolicy, selectActionAuditSample, semanticConflictEligible } from "@/lib/domain/products/automated-action-audit";
import { alive, at, auditSource, candidate, decision, independentFinding, periodStart, policy, seed } from "./fixtures/automated-action-audit";

describe("독립 기반 모델과 기본 비활성 설정", () => {
  it("장비가 달라도 같은 Qwen은 독립표가 아니며 unknown을 채우지 않는다", () => {
    expect(independentAuditFamily("qwen3.8-flash-next", "qwen3.8-flash-next")).toBe(false);
    expect(independentAuditFamily("qwen3.8-flash-next", "deepseek-v4.1-flash-1017")).toBe(true);
    for (const unknown of [null, "unknown", "qwen-alias-unverified"]) expect(preferredAuditFamily(unknown)).toBeNull();
    expect(preferredAuditFamily("gpt-oss-120b")).toBe("qwen3.8-flash-next");
  });
  it("표본·예외 한도와 seed를 모두 명시해야 동작한다", () => {
    expect(readActionAuditPolicy({})).toEqual({ enabled: false });
    expect(readActionAuditPolicy({ LLM_ACTION_AUDIT_POLICY: '{"enabled":false}' })).toEqual({ enabled: false });
    expect(() => readActionAuditPolicy({ LLM_ACTION_AUDIT_POLICY: JSON.stringify(policy) })).toThrow("action_audit_seed_required");
    expect(readActionAuditPolicy({ LLM_ACTION_AUDIT_POLICY: JSON.stringify(policy), LLM_ACTION_AUDIT_SEED: seed }).enabled).toBe(true);
    expect(() => readActionAuditPolicy({ LLM_ACTION_AUDIT_POLICY: '{"enabled":true,"rate":0.05}', LLM_ACTION_AUDIT_SEED: seed })).toThrow();
  });
});
describe("재현되는 층화 표본", () => {
  it("UTC 월요일에 주간이 바뀌고 시간대가 다른 시각도 같은 주로 묶는다", () => {
    expect(actionAuditPeriod(at)).toBe(periodStart);
    expect(actionAuditPeriod(new Date("2026-10-26T00:00:00Z"))).toBe("2026-10-26");
    expect(actionAuditPeriod(new Date("2026-10-25T23:59:59Z"))).toBe(periodStart);
  });
  it("입력 역순·중복·재실행에 같은 표본을 고르고 층별·주간 한도를 넘지 않는다", () => {
    const rows = Array.from({ length: 20 }, (_, i) => decision(i % 2 ? { outcome: alive, applied: false } : {}));
    const first = selectActionAuditSample(rows, periodStart, seed, policy, at).selected;
    expect(selectActionAuditSample([...rows].reverse().concat(rows), periodStart, seed, policy, at).selected).toEqual(first);
    expect(first).toHaveLength(4);
    expect(new Set(first.map(row => row.outcome.action.proposal)).size).toBe(2);
    expect(selectActionAuditSample(rows, periodStart, seed, { ...policy, maxAuditsPerWeek: 1 }, at).selected).toHaveLength(1);
    expect(selectActionAuditSample(rows, periodStart, seed + "changed", policy, at).selected).not.toEqual(first);
  });
  it("원 모델 미상·미래·기간 밖은 제외하고 같은 result ID의 다른 내용은 거부한다", () => {
    const row = decision();
    const sample = selectActionAuditSample([row, decision({ modelFamily: null }), decision({ decidedAt: "2026-10-24T00:00:00Z" }),
      decision({ decidedAt: "2026-09-01T00:00:00Z" })], periodStart, seed, policy, at);
    expect(sample.selected).toEqual([row]);
    expect(sample.skippedUnknownFamily).toBe(1);
    expect(() => selectActionAuditSample([row, { ...row, modelFamily: "deepseek-v4.1-flash-1017" }], periodStart, seed, policy, at)).toThrow("conflicting_audit_decision_id");
  });
});
describe("이전 결론을 가린 현재 근거 감사", () => {
  const build = () => buildBlindedActionAuditInput(candidate(), [auditSource,
    { ...auditSource, sourceId: "old-answer", kind: "metadata", text: "prior_reason qwen3.8-flash-next confidence=0.99" }],
  { administratorReleased: false, makerProtected: false }, { task: "uptime", requestedUrl: "https://example.com" }, at);
  it("이전 결론·이유·family·backend·source ID를 프롬프트에서 제거한다", () => {
    const input = build(), prompt = JSON.stringify(buildAssistMessages(input));
    for (const secret of ["이전 결론 노출 금지 특별 문장", "prior_reason", "qwen3.8-flash-next", "confidence=0.99", "page-old-model-confidence"]) expect(prompt).not.toContain(secret);
    expect(input.subject.revision).toBe("2026-10-23 09:00:00.123456");
    expect(prompt).toContain("https://example.com");
  });
  it("원본의 오래된 자료·접근 차단·metadata만 있으면 DeepSeek에 보내지 않는다", () => {
    for (const source of [{ ...auditSource, observedAt: "2026-10-22T00:00:00Z" }, { ...auditSource, completeness: "blocked" as const },
      { ...auditSource, kind: "metadata" as const }]) expect(() => buildBlindedActionAuditInput(candidate(), [source],
      { administratorReleased: false, makerProtected: false }, { task: "uptime", requestedUrl: "https://example.com" }, at)).toThrow("audit_current_evidence_required");
  });
  it("현재 불일치는 사람 검토로 기록하고 과거 오판이나 자동 복구 권한으로 승격하지 않는다", () => {
    const c = candidate(), input = build();
    const mismatch = compareActionAudit(c, input, independentFinding(input), "deepseek-v4.1-flash-1017", at);
    expect(mismatch).toMatchObject({ status: "human_review", originalFinding: "closed", currentFinding: "alive", authority: "record_only",
      interpretation: "current_evidence_comparison", reason: "current_evidence_disagrees" });
    expect(compareActionAudit(c, input, independentFinding(input, "closed"), "deepseek-v4.1-flash-1017", at).status).toBe("agree");
    expect(compareActionAudit(c, input, independentFinding(input), "qwen3.8-flash-next", at).status).toBe("not_independent");
    expect(compareActionAudit(c, input, { ...independentFinding(input), confidence: 1 }, "deepseek-v4.1-flash-1017", at).status).toBe("invalid");
  });
});
describe("의미 충돌만 예외 상향", () => {
  it("동일 입력의 충분한 상반 판정만 허용하고 대기·통신·형식·수집 실패를 배제한다", () => {
    const first = decision(), second = decision({ workId: first.workId, outcome: alive });
    expect(semanticConflictEligible("semantic_conflict", first, second)).toBe(true);
    for (const reason of ["capacity", "transport", "invalid_output", "missing_evidence"] as const) expect(semanticConflictEligible(reason, first, second)).toBe(false);
    expect(semanticConflictEligible("semantic_conflict", first, { ...second, sourceHash: assistHash("other") })).toBe(false);
    expect(semanticConflictEligible("semantic_conflict", first, decision())).toBe(false);
    expect(semanticConflictEligible("semantic_conflict", { ...first, modelFamily: null }, second)).toBe(false);
  });
  it("기반 모델 미상 기록의 보호 규칙 검토는 모델 독립 감사로 집계하지 않는다", () => {
    expect(auditServerProtectionDecision({ task: "intro", action: "rewrite_candidate", applied: true,
      administratorReleasedAtDecision: null, makerProtectedAtDecision: true, placeholderEligibleAtDecision: false }))
      .toMatchObject({ kind: "server_rule_audit", status: "human_review", independentModelAudit: false, authority: "record_only" });
    expect(auditServerProtectionDecision({ task: "uptime", action: "delist_candidate", applied: true,
      administratorReleasedAtDecision: null, makerProtectedAtDecision: null, placeholderEligibleAtDecision: null }).status).toBe("insufficient_snapshot");
  });
});
