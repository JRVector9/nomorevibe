import { describe, expect, it } from "vitest";
import { ASSIST_SCHEMA_VERSION, assistHash, assistInputHash, assistInputSchema, assistJsonSchema, assistOutcomeSchemas,
  validateAssistOutcome, type AssistInput } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION, assistPromptHash, buildAssistMessages } from "@/lib/domain/llm-assist/prompts";

const input: AssistInput = { schemaVersion: ASSIST_SCHEMA_VERSION, task: "uptime", subject: { type: "product", id: 1,
  revision: "2026-10-23 01:02:03.123456" }, policyVersion: "policy-1", promptVersion: ASSIST_PROMPT_VERSION,
  sources: [{ sourceId: "page:1", kind: "page", url: "https://example.com", observedAt: "2026-10-23 01:02:03.123456",
    revision: "snapshot-1", text: "We permanently closed the entire service.", completeness: "complete", httpStatus: 200 }],
  context: { requestedUrl: "https://example.com", finalUrl: "https://example.com", failureCount: 10, requiredFailures: 10, administratorReleased: false } };
const outcome = { schema_version: ASSIST_SCHEMA_VERSION, task: "uptime", state: { page_state: "closed", finding: "explicit_shutdown" },
  evidence_quality: { status: "sufficient", limitations: ["none"] },
  evidence: [{ source_id: "page:1", quote: "permanently closed", supports: ["/state/page_state"] }],
  action: { proposal: "delist_candidate", reason_ko: "서비스 전체의 종료가 명시되어 있습니다.", missing_items: [] } };

describe("assist contracts and server guards", () => {
  it("실제 Qwen 응답의 상태 값 경로 /state/closed를 uptime 출력 계약에서 거절한다", () => {
    // 실제 첫 canary의 실패 구조만 재현한다. 원문·운영 cohort는 비공개 산출물에 보존한다.
    const valuePointer = { ...outcome, evidence: [{ ...outcome.evidence[0], supports: ["/state/closed"] }] };
    expect(assistOutcomeSchemas.uptime.safeParse(valuePointer).success).toBe(false);
    expect(validateAssistOutcome(input, valuePointer).ok).toBe(false);
    expect(assistJsonSchema("uptime")).toMatchObject({ properties: { evidence: { items: { properties: {
      supports: { items: { enum: ["/state/page_state", "/state/finding"] } },
    } } } } });
  });
  it.each(["/state/page_state", "/state/finding"])("기존의 유효한 uptime 근거 경로 %s는 그대로 허용한다", pointer => {
    const valid = { ...outcome, evidence: [{ ...outcome.evidence[0], supports: [pointer] }] };
    expect(assistOutcomeSchemas.uptime.safeParse(valid).success).toBe(true);
    expect(validateAssistOutcome(input, valid).ok).toBe(true);
    expect(assistInputSchema.parse(input).schemaVersion).toBe("2026-10-23.1");
  });
  it("uptime 메시지가 새 경로 계약과 필드 경로·상태 값의 차이를 설명한다", () => {
    const content = buildAssistMessages(input)[1].content;
    expect(content).toContain("2026-10-24.1");
    expect(content).toContain("/state/page_state");
    expect(content).toContain("/state/finding");
    expect(content).toContain("/state/closed");
    expect(input.promptVersion).toBe("2026-10-23.1");
  });
  it("preserves raw source revision precision and fences source, policy and prompt changes", () => {
    expect(assistInputSchema.parse(input).subject.revision).toBe("2026-10-23 01:02:03.123456");
    for (const changed of [{ ...input, subject: { ...input.subject, revision: "2026-10-23 01:02:03.123457" } },
      { ...input, promptVersion: "later" }, { ...input, policyVersion: "other" },
      { ...input, sources: [{ ...input.sources[0], revision: "changed" }] }]) expect(assistInputHash(changed)).not.toBe(assistInputHash(input));
    expect(assistHash({ a: 1, b: 2 })).toBe(assistHash({ b: 2, a: 1 }));
  });
  it("does not authorize a state change from invented quote, pointer, confidence or incomplete evidence", () => {
    expect(validateAssistOutcome(input, outcome).ok).toBe(true);
    for (const invalid of [
      { ...outcome, confidence: 1 }, { ...outcome, evidence: [{ ...outcome.evidence[0], source_id: "invented" }] },
      { ...outcome, evidence: [{ ...outcome.evidence[0], quote: "we offer a working app" }] },
      { ...outcome, evidence: [{ ...outcome.evidence[0], supports: ["/state/not_real"] }] },
      { ...outcome, evidence_quality: { status: "blocked", limitations: ["challenge"] } },
      { ...outcome, evidence: [] }, { ...outcome, state: { page_state: "closed", finding: "active_product" } },
    ]) expect(validateAssistOutcome(input, invalid).ok).toBe(false);
    expect(validateAssistOutcome({ ...input, sources: [{ ...input.sources[0], completeness: "blocked" }] }, outcome).ok).toBe(false);
  });
  it("keeps administrator release and the existing failure threshold in server authority", () => {
    expect(validateAssistOutcome({ ...input, context: { ...input.context, administratorReleased: true } }, outcome)).toEqual({ ok: false, error: "uptime_delist_not_permitted" });
    expect(validateAssistOutcome({ ...input, context: { ...input.context, failureCount: 9 } }, outcome).ok).toBe(false);
    expect(validateAssistOutcome(input, { ...outcome, state: { page_state: "alive", finding: "active_product" } }).ok).toBe(false);
  });
  it.each(["retain", "delist_candidate", "collect_evidence", "human_review", "independent_review"])(
    "unclear 상태의 %s 조치는 근거 수집 또는 사람 확인일 때만 허용한다", proposal => {
      const unclearInput = { ...input, sources: [{ ...input.sources[0], httpStatus: 503,
        text: "Service temporarily unavailable. Please try again later." }] };
      const unclear = { ...outcome, state: { page_state: "unclear", finding: "temporary_maintenance" },
        evidence_quality: { status: "partial", limitations: ["other"] },
        evidence: [{ ...outcome.evidence[0], quote: "Service temporarily unavailable" }],
        action: { proposal, reason_ko: "일시 장애로 현재 서비스 상태를 확인해야 합니다.", missing_items: ["실제 서비스 상태"] } };
      expect(validateAssistOutcome(unclearInput, unclear).ok).toBe(["collect_evidence", "human_review"].includes(proposal));
    });
  it("does not equate a fork with an official move or accept a model-authored maker permission", () => {
    const repo = { ...input, task: "repo", context: { oldRepositoryUrl: "https://github.com/old/tool", productName: "Tool", productDescription: "Notes",
      candidateRepositoryUrls: ["https://github.com/new/tool"] } } as AssistInput;
    const proposed = { ...outcome, task: "repo", state: { project_identity: "matches", code_lineage: "fork_or_copy",
      official_continuity: "unverified", relationship: "same_project" }, action: { ...outcome.action, proposal: "update_repo_candidate" },
      evidence: [{ ...outcome.evidence[0], supports: ["/state/relationship"] }] };
    expect(validateAssistOutcome(repo, proposed)).toEqual({ ok: false, error: "unverified_repository_move" });
    expect(validateAssistOutcome(repo, { ...proposed, state: { ...proposed.state, official_continuity: "explicit_move" } }).ok).toBe(true);
    const intro = { ...input, task: "intro", context: { tagline: "Fastest search", author: "maker", makerProtected: true,
      placeholderEligible: false, language: "en" } } as AssistInput;
    const rewrite = { ...outcome, task: "intro", state: { factual_match: "unsupported_claim", content_kind: "performance_or_value_claim",
      author_protection: "server_maker_protected", treatment: "rewrite_candidate" }, action: { ...outcome.action, proposal: "rewrite_candidate" },
      evidence: [{ ...outcome.evidence[0], supports: ["/state/treatment"] }] };
    expect(validateAssistOutcome(intro, rewrite)).toEqual({ ok: false, error: "intro_rewrite_not_permitted" });
  });
  it("blinds audit inputs and keeps task-specific findings separate", () => {
    const audit = { ...input, task: "audit", context: { subject: "repo", ruleIds: ["official-move"], administratorReleased: false, makerProtected: false } } as AssistInput;
    expect(assistInputSchema.safeParse({ ...audit, context: { ...audit.context, previousDecision: "delist", confidence: 1 } }).success).toBe(false);
    const response = { ...outcome, task: "audit", state: { audit_subject: "repo", independent_finding: "alive", applicable_rule_ids: ["official-move"] },
      evidence: [{ ...outcome.evidence[0], supports: ["/state/independent_finding"] }], action: { ...outcome.action, proposal: "record_finding" } };
    expect(validateAssistOutcome(audit, response)).toEqual({ ok: false, error: "invalid_audit_finding" });
  });
  it("builds versioned task messages and does not silently apply an unknown prompt version", () => {
    const messages = buildAssistMessages(input);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain("[비신뢰 근거]");
    expect(messages[1].content).toContain("snapshot-1");
    expect(() => buildAssistMessages({ ...input, promptVersion: "unknown" })).toThrow("unsupported_assist_prompt_version");
    expect(assistPromptHash("uptime")).not.toBe(assistPromptHash("repo"));
    expect(assistJsonSchema("uptime").additionalProperties).toBe(false);
  });
});
