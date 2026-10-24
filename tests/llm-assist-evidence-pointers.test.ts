import { describe, expect, it } from "vitest";
import { ASSIST_SCHEMA_VERSION, assistHash, assistJsonSchema, assistOutcomeSchemas, validateAssistOutcome,
  type AssistInput } from "@/lib/domain/llm-assist/contracts";
import { assistPromptHash, buildAssistMessages } from "@/lib/domain/llm-assist/prompts";

const states = {
  repo: { project_identity: "unknown", code_lineage: "unknown", official_continuity: "unverified", relationship: "unclear" },
  intro: { factual_match: "insufficient", content_kind: "unknown", author_protection: "server_operator", treatment: "human" },
  audit: { audit_subject: "repo", independent_finding: "unclear", applicable_rule_ids: ["official-move"] },
  news: { names: [{ original: "Tool", korean: "도구" }], prices: [{ amount: "3", currency: "USD", per_quantity: "1000000",
    per_unit: "token", direction: "input", effective_status: "unknown" }], quantities: [{ value: "1", unit: "token", qualifier: "input" }],
  dates: [{ original: "2026-10-25", iso_date: "2026-10-25", event: "announcement" }], release: { stage: "preview", availability: "unknown", scope: ["api"] },
  qualifications: ["Preview"], draft: { title: "Tool", summary: "Tool preview" } },
};
type Task = keyof typeof states;
function input(task: Task): AssistInput {
  const common = { schemaVersion: ASSIST_SCHEMA_VERSION, task, subject: { type: task === "news" ? "news_item" : "product", id: 1, revision: "raw" },
    policyVersion: "policy", promptVersion: "2026-10-23.1", sources: [{ sourceId: "source", kind: "page", url: "https://example.com",
      observedAt: "2026-10-25T00:00:00Z", revision: "raw", text: "Source text.", completeness: "complete", httpStatus: 200 }] };
  const context = task === "repo" ? { oldRepositoryUrl: "https://github.com/old/tool", productName: "Tool", productDescription: "Tool", candidateRepositoryUrls: ["https://github.com/new/tool"] }
    : task === "intro" ? { tagline: "Tool", author: "operator", makerProtected: false, placeholderEligible: false, language: null }
      : task === "audit" ? { subject: "repo", ruleIds: ["official-move"], administratorReleased: false, makerProtected: false }
        : { title: "Tool", summary: "Source text.", locale: "ko" };
  return { ...common, context } as AssistInput;
}
function outcome(task: Task, pointer: string) {
  return { schema_version: ASSIST_SCHEMA_VERSION, task, state: states[task], evidence_quality: { status: "partial", limitations: ["other"] },
    evidence: [{ source_id: "source", quote: "Source text.", supports: [pointer] }],
    action: { proposal: "human_review", reason_ko: "근거를 확인해야 합니다.", missing_items: [] } };
}
describe("업무별 필드 경로 계약", () => {
  it.each([{ task: "repo", pointer: "/state/official_continuity/explicit_move" },
    { task: "intro", pointer: "/state/content_kind/descriptive" },
    { task: "audit", pointer: "/state/independent_finding/alive" },
    { task: "news", pointer: "/state/release/stage/preview" }] as const)("$task의 상태 값을 붙인 경로를 schema부터 거절한다", ({ task, pointer }) => {
    expect(assistOutcomeSchemas[task].safeParse(outcome(task, pointer)).success).toBe(false);
    expect(validateAssistOutcome(input(task), outcome(task, pointer)).ok).toBe(false);
    const schema = assistJsonSchema(task) as { properties: { evidence: { items: { properties: { supports: { items: { enum?: string[] } } } } } } };
    expect(schema.properties.evidence.items.properties.supports.items.enum).toBeDefined();
  });
  it.each([{ task: "repo", paths: ["/state/project_identity", "/state/code_lineage", "/state/official_continuity", "/state/relationship"] },
    { task: "intro", paths: ["/state/factual_match", "/state/content_kind", "/state/author_protection", "/state/treatment"] },
    { task: "audit", paths: ["/state/audit_subject", "/state/independent_finding", "/state/applicable_rule_ids", "/state/applicable_rule_ids/0"] },
    { task: "news", paths: ["/state/names", "/state/names/0", "/state/names/0/original", "/state/names/0/korean", "/state/prices/0/amount",
      "/state/quantities/0/qualifier", "/state/dates/0/iso_date", "/state/release", "/state/release/stage", "/state/release/scope/0",
      "/state/qualifications/0", "/state/draft/title"] }] as const)("$task의 기존 실제 필드·배열 원소 경로는 허용한다", ({ task, paths }) => {
    for (const pointer of paths) expect(validateAssistOutcome(input(task), outcome(task, pointer)), pointer).toHaveProperty("ok", true);
  });
  it("news의 없는 원소·배열 메타 속성·다른 task 필드는 권한이 없다", () => {
    for (const pointer of ["/state/names/12/original", "/state/names/length", "/state/treatment"])
      expect(assistOutcomeSchemas.news.safeParse(outcome("news", pointer)).success, pointer).toBe(false);
    expect(validateAssistOutcome(input("news"), outcome("news", "/state/names/1/original"))).toEqual({ ok: false, error: "invalid_evidence_pointer" });
  });
  it.each(["repo", "intro", "audit", "news"] as const)("%s prompt가 필드 경로와 값의 차이를 명시한다", task => {
    const content = buildAssistMessages(input(task))[1].content;
    expect(content).toContain("2026-10-25.1");
    expect(content).toContain("필드 경로");
  });
  it("전역 wire 버전과 uptime schema/prompt hash를 바꾸지 않는다", () => {
    expect(ASSIST_SCHEMA_VERSION).toBe("2026-10-23.1");
    expect(assistHash(assistJsonSchema("uptime"))).toBe("fafe8e354f66f4f2b1cad71a6f55d708e5a7ceaaaaed7d26240a4845d910352b");
    expect(assistPromptHash("uptime")).toBe("a9345c8892920d3d2af39bf576ce840559b7e5450f7a7c703b0e4ece78a7f83d");
  });
});
