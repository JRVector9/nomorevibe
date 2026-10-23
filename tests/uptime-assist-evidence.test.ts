import { describe, expect, it, vi } from "vitest";
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/net/fetch", () => ({ safeFetch }));
import { collectUptimeAssist } from "@/lib/domain/products/uptime-delist-review";
import { parseAssistModelResponse } from "@/lib/domain/llm-assist/model-request";
import { ASSIST_SCHEMA_VERSION } from "@/lib/domain/llm-assist/contracts";

const candidate = { kind: "uptime" as const, product: { id: 1, slug: "example", url: "https://example.com",
  updatedAt: "2026-10-23 01:02:03.123456" }, health: { failures: 10, status: 404,
  checkedAt: "2026-10-23 02:02:03.123456", downSince: "2026-10-22 02:02:03.123456" } };
it("HTTP 404의 명시 본문을 보존하고 오류 단어가 있는 정상 제품과 구분할 근거를 전달한다", async () => {
  safeFetch.mockResolvedValueOnce({ finalUrl: candidate.product.url, response: new Response("<h1>Error tracking tool</h1><p>Start your free plan.</p>", { status: 404 }) });
  const input = await collectUptimeAssist(candidate);
  expect(input.subject.revision).toBe(candidate.product.updatedAt);
  expect(input.sources[0]).toMatchObject({ completeness: "complete", httpStatus: 404, text: "Error tracking tool Start your free plan." });
  expect(input.task === "uptime" && input.context.failureCount).toBe(10);
});
it("접근 차단·잘린 문서·네트워크 실패를 종료 본문으로 만들지 않는다", async () => {
  for (const [body, status, completeness] of [["Please retry later", 429, "blocked"], ["a".repeat(33_000), 200, "truncated"],
    ["<h1>Just a moment</h1>", 200, "blocked"]] as const) {
    safeFetch.mockResolvedValueOnce({ finalUrl: candidate.product.url, response: new Response(body, { status }) });
    expect((await collectUptimeAssist(candidate)).sources[0].completeness).toBe(completeness);
  }
  safeFetch.mockResolvedValueOnce(null);
  expect((await collectUptimeAssist(candidate)).sources[0]).toMatchObject({ completeness: "missing", text: "", httpStatus: null });
});
describe("업무 결과 검증", () => {
  it("실제 인용과 상태가 맞아야 하고 length 종료·confidence·가짜 인용은 적용 후보로 통과하지 않는다", async () => {
    safeFetch.mockResolvedValueOnce({ finalUrl: candidate.product.url, response: new Response("We permanently closed the entire service.") });
    const input = await collectUptimeAssist(candidate);
    const outcome = { schema_version: ASSIST_SCHEMA_VERSION, task: "uptime", state: { page_state: "closed", finding: "explicit_shutdown" },
      evidence_quality: { status: "sufficient", limitations: ["none"] },
      evidence: [{ source_id: "current-page", quote: "permanently closed", supports: ["/state/page_state"] }],
      action: { proposal: "delist_candidate", reason_ko: "영구 종료가 명시되어 있습니다.", missing_items: [] } };
    const response = (body: unknown, finish = "stop") => ({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(body) } }] });
    expect(parseAssistModelResponse(input, response(outcome)).ok).toBe(true);
    expect(parseAssistModelResponse(input, response(outcome, "length")).ok).toBe(false);
    expect(parseAssistModelResponse(input, response({ ...outcome, confidence: 1 })).ok).toBe(false);
    expect(parseAssistModelResponse(input, response({ ...outcome, evidence: [{ ...outcome.evidence[0], quote: "fabricated" }] })).ok).toBe(false);
  });
});
