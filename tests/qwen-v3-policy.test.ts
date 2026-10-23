import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createReviewInput, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { REVIEW_SYSTEM_PROMPT } from "@/lib/crawl/agent-review";
import { QWEN_V2_ADDENDUM, QWEN_V2_ADDENDUM_SHA256, QWEN_V2_PROMPT_VERSION, QWEN_V3_ADDENDUM,
  QWEN_V3_ADDENDUM_SHA256, QWEN_V3_EVALUATION_SOURCE, QWEN_V3_PROMPT_VERSION, qwenPromptConfig,
  reviewWithQwenDirect, type QwenPromptVersion } from "@/lib/crawl/qwen-direct-review";
import { sameReviewModel, sameUnderlyingModel } from "@/lib/crawl/review-model-identity";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";

const now = new Date("2026-10-23T07:00:00.000Z");
function input(): ReviewInput {
  return createReviewInput({ repo: "acme/cli", productUrl: null, judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "acme/cli", productUrl: null, repoMeta: { description: "A terminal task manager",
      stargazers_count: 600 }, pageMeta: { readmeSample: "Install taskctl; taskctl add work." }, pageStatus: 0, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
const response = () => vi.fn(async () => new Response(JSON.stringify({ model: "qwen3.8-flash-next",
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ decision: "needs_review", reason: "Fixture response.",
    evidenceIds: ["product"], confidence: 0.5 }) } }] })));
const wire = (request: ReturnType<typeof response>) => JSON.parse(String((request.mock.calls[0] as unknown as [unknown, RequestInit])[1].body));

describe("Qwen v3의 명시 선택과 고정 정책", () => {
  it("v2 원문 해시를 보존하고 새 글도 별도 판과 해시로 고정한다", () => {
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(hash(QWEN_V2_ADDENDUM)).toBe("a0228a0227c7c7e3a611dda2d60037ee2ddc4250e7017bb3da6541687f9074ac");
    expect(hash(QWEN_V2_ADDENDUM)).toBe(QWEN_V2_ADDENDUM_SHA256);
    expect(hash(QWEN_V3_ADDENDUM)).toBe("9d2b82127a1af076d0b8a9e333a74ee107fbe76ec3e78fb6903af24c1197a9b0");
    expect(hash(QWEN_V3_ADDENDUM)).toBe(QWEN_V3_ADDENDUM_SHA256);
    expect(qwenPromptConfig()?.version).toBe(QWEN_V2_PROMPT_VERSION);
    expect(qwenPromptConfig("future")).toBeNull();
    expect(qwenPromptConfig("")).toBeNull();
  });

  it("기존 호출은 환경에 실험판 이름이 있어도 v2를 유지한다", async () => {
    const request = response();
    const result = await reviewWithQwenDirect(input(), { env: { AUDIT_SECOND_OPINION_PROMPT_VERSION: QWEN_V3_PROMPT_VERSION },
      request: request as unknown as typeof fetch });
    expect(wire(request).messages[0].content).toBe(REVIEW_SYSTEM_PROMPT + QWEN_V2_ADDENDUM);
    expect(result.promptVersion).toBe(QWEN_V2_PROMPT_VERSION);
    expect(result.recordedModel).toBe("qwen3.8-flash-next");
  });

  it("homepage 없는 installable의 README·자격·공통 정책을 그대로 실어 범위만 정정한다", async () => {
    const original = input();
    expect(original.snapshot.product.accessMode).toBe("installable");
    expect(original.snapshot.product.url).toBeNull();
    const before = structuredClone(original.snapshot);
    const request = response();
    const result = await reviewWithQwenDirect(original, { env: {}, promptVersion: QWEN_V3_PROMPT_VERSION,
      request: request as unknown as typeof fetch });
    const body = wire(request);
    expect(body.messages[0].content).toBe(REVIEW_SYSTEM_PROMPT + QWEN_V3_ADDENDUM);
    expect(body.messages[0].content).toContain("The following page-first notes apply only to website mode");
    expect(body.messages[0].content).toContain("including its existing stars/packageProof eligibility and own-deliverable requirements");
    expect(body.messages[1].content).toContain('"accessMode":"installable"');
    expect(body.messages[1].content).toContain("Install taskctl");
    expect(original.snapshot).toEqual(before);
    expect(body.model).toBe("qwen3.8-flash-next");
    expect(result).toMatchObject({ promptVersion: QWEN_V3_PROMPT_VERSION, source: QWEN_V3_EVALUATION_SOURCE,
      recordedModel: "qwen3.8-flash-next+prompt-v3", promptHash: QWEN_V3_ADDENDUM_SHA256, cacheGeneration: QWEN_V3_PROMPT_VERSION });
    expect(result.inputHash).not.toBe(original.inputHash);
    expect(result.wireHash).toBe(createHash("sha256").update(String((request.mock.calls[0] as unknown as [unknown, RequestInit])[1].body)).digest("hex"));
  });

  it("문서 홈·단순 API 문서·체크포인트·빈 website를 섞어도 입력과 공통 정책은 바꾸지 않는다", async () => {
    for (const pageText of ["Tool home: Install now. API reference.", "Reference: GET /items returns all items.",
      "Checking your browser", "Enable JavaScript", ""]) {
      const base = input();
      const candidate = { ...base, snapshot: { ...base.snapshot, product: { ...base.snapshot.product,
        accessMode: "website" as const, url: "https://tool.example", pageText } } };
      const request = response();
      await reviewWithQwenDirect(candidate, { env: {}, promptVersion: QWEN_V3_PROMPT_VERSION, request: request as unknown as typeof fetch });
      const body = wire(request);
      expect(body.messages[0].content).toBe(REVIEW_SYSTEM_PROMPT + QWEN_V3_ADDENDUM);
      expect(body.messages[1].content).toContain(JSON.stringify(pageText));
    }
  });

  it("판 선택 오류는 호출하지 않고, 다른 판을 독립적인 가중치로 세지 않는다", async () => {
    const request = response();
    await expect(reviewWithQwenDirect(input(), { env: {}, promptVersion: "future" as QwenPromptVersion,
      request: request as unknown as typeof fetch })).rejects.toMatchObject({ code: "qwen_not_configured" });
    expect(request).not.toHaveBeenCalled();
    expect(sameReviewModel("qwen3.8-flash-next+prompt-v3", "qwen3.8-flash-next")).toBe(false);
    expect(sameUnderlyingModel("qwen3.8-flash-next+prompt-v3", "qwen3.8-flash-next")).toBe(true);
    expect(sameUnderlyingModel("[m1] qwen3.8-flash-next+vision-shot2", "[gpu3090] qwen3.8-flash-next")).toBe(true);
  });
});
