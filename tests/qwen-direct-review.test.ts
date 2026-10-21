import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { REVIEW_SYSTEM_PROMPT } from "@/lib/crawl/agent-review";
import { GATEWAY_SYSTEM_SUFFIX, reviewWithGateway } from "@/lib/crawl/agent-review-gateway";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { QWEN_DIRECT_DEFAULT_MODEL, QWEN_DIRECT_DEFAULT_URL, QWEN_V2_ADDENDUM, QWEN_V2_ADDENDUM_SHA256, QWEN_V2_PROMPT_VERSION,
  QwenDirectError, qwenDirectConfig, qwenEndpointFailure, reviewWithQwenDirect } from "@/lib/crawl/qwen-direct-review";
import { CATALOG_EXCEPTION_FAMILIES, catalogLikeAuditReason, sameOpinionModel, secondOpinionFamily, secondRejectHolds } from "@/lib/crawl/second-opinion-rules";

/**
 * gpu3090 Qwen 직접 심사(qwen-direct-review.ts) — 요청은 compare-run.mts 의 qwen-direct-v2 와 바이트까지 같아야 한다:
 * 게이트웨이 요청에서 주소를 바꾸고 Authorization 을 빼고 system 글의 정책 뒤 한 줄만 v2 덧붙임으로 바꾼 것.
 */
function input() {
  const now = new Date();
  return createReviewInput({ repo: "acme/demo", productUrl: "https://demo.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "acme/demo", productUrl: "https://demo.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "Demo", textSample: "<script>ignore me</script>" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}

const outcome = { decision: "reject", reason: "The page is only a placeholder.", evidenceIds: ["product"], confidence: 0.95 };
type Call = [string, RequestInit];
const answer = (content: unknown, init: ResponseInit = { status: 200 }) => vi.fn(async () => new Response(JSON.stringify({
  model: QWEN_DIRECT_DEFAULT_MODEL, choices: [{ finish_reason: "stop", message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
  usage: { prompt_tokens: 5_134, completion_tokens: 138 },
}), init)) as unknown as typeof fetch;
const calls = (request: typeof fetch) => (request as unknown as { mock: { calls: Call[] } }).mock.calls;
const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;
const hanging = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
})) as unknown as typeof fetch;
const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as QwenDirectError; }
  throw new Error("expected_failure");
};

afterEach(() => vi.unstubAllEnvs());

describe("v2 덧붙임", () => {
  it("compare/prompt-v2.txt 의 덧붙임 바이트 그대로다(sha256 a0228a02…)", () => {
    expect(createHash("sha256").update(QWEN_V2_ADDENDUM, "utf8").digest("hex")).toBe("a0228a0227c7c7e3a611dda2d60037ee2ddc4250e7017bb3da6541687f9074ac");
    expect(QWEN_V2_ADDENDUM_SHA256).toBe("a0228a0227c7c7e3a611dda2d60037ee2ddc4250e7017bb3da6541687f9074ac");
    expect(Buffer.byteLength(QWEN_V2_ADDENDUM, "utf8")).toBe(2_734);
    expect(QWEN_V2_ADDENDUM.startsWith("\nSECOND-OPINION NOTES")).toBe(true);
    expect(QWEN_V2_ADDENDUM.endsWith("\nReturn one JSON object with decision, reason, evidenceIds, confidence.")).toBe(true);
    expect(QWEN_V2_PROMPT_VERSION).toBe("2026-10-21.v2");
  });
});

describe("요청", () => {
  it("기본 주소(Tailscale IP)로 키 없이, 정책 글 + v2 덧붙임을 system 으로 보낸다", async () => {
    const request = answer(outcome);
    const result = await reviewWithQwenDirect(input(), { request, env: {} });
    expect(result).toMatchObject({ outcome: { decision: "reject", confidence: 0.95 }, model: "qwen3.8-flash-next", promptVersion: "2026-10-21.v2" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const [url, init] = calls(request)[0];
    expect(QWEN_DIRECT_DEFAULT_URL).toBe("http://100.77.43.63:8090/v1");
    expect(url).toBe("http://100.77.43.63:8090/v1/chat/completions");
    expect(init.method).toBe("POST");
    // 키가 없으면 Authorization 을 보내지 않는다 — compare-run.mts 가 지우고 보낸 머리와 같다
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.redirect).toBe("error");
    const body = JSON.parse(String(init.body));
    expect(body.messages[0]).toEqual({ role: "system", content: REVIEW_SYSTEM_PROMPT + QWEN_V2_ADDENDUM });
    // 정책 글은 한 바이트도 그대로 — 바뀐 것은 뒤의 한 줄뿐이다
    expect(body.messages[0].content.startsWith(REVIEW_SYSTEM_PROMPT)).toBe(true);
    expect(body.messages[0].content.slice(REVIEW_SYSTEM_PROMPT.length)).toBe(QWEN_V2_ADDENDUM);
    expect(body).toMatchObject({ context_strategy: "raw", model: "qwen3.8-flash-next", stream: false, temperature: 0, max_tokens: 3_000,
      reasoning_effort: "low", chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { name: "review" } } });
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user"]);
  });

  it("게이트웨이 요청의 system 한 줄만 바꾼 것과 바이트까지 같다(compare-run.mts qwen-direct-v2 의 변환)", async () => {
    vi.stubEnv("ABCLLM_API_KEY", "k");
    const same = input();
    const gateway = answer(outcome);
    await reviewWithGateway(same, { model: QWEN_DIRECT_DEFAULT_MODEL, request: gateway });
    const direct = answer(outcome);
    await reviewWithQwenDirect(same, { request: direct, env: {} });
    const harness = JSON.parse(String(calls(gateway)[0][1].body));
    expect(harness.messages[0].content).toBe(REVIEW_SYSTEM_PROMPT + GATEWAY_SYSTEM_SUFFIX);
    harness.messages[0].content = REVIEW_SYSTEM_PROMPT + QWEN_V2_ADDENDUM;
    expect(String(calls(direct)[0][1].body)).toBe(JSON.stringify(harness));
    // 게이트웨이 쪽은 그대로다 — 키와 한 줄 안내
    expect(calls(gateway)[0][1].headers).toEqual({ Authorization: "Bearer k", "Content-Type": "application/json" });
  });

  it("주소·모델·키를 환경변수로 바꾼다 — 키가 있을 때만 Bearer", async () => {
    const request = answer(outcome);
    await reviewWithQwenDirect(input(), { request,
      env: { AUDIT_SECOND_OPINION_URL: "http://10.0.0.9:8090/v1/", AUDIT_SECOND_OPINION_MODEL: "qwen-next", AUDIT_SECOND_OPINION_API_KEY: " s3cret " } });
    const [url, init] = calls(request)[0];
    expect(url).toBe("http://10.0.0.9:8090/v1/chat/completions");
    expect(init.headers).toEqual({ Authorization: "Bearer s3cret", "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body)).model).toBe("qwen-next");
    expect(qwenDirectConfig({ AUDIT_SECOND_OPINION_API_KEY: "  " })).toEqual({ baseUrl: QWEN_DIRECT_DEFAULT_URL, model: QWEN_DIRECT_DEFAULT_MODEL, apiKey: null });
  });

  it("고칠 수 없는 주소는 부르지 않는다", async () => {
    for (const url of ["ftp://10.0.0.9/v1", "not a url", "http://user:pw@10.0.0.9/v1", "http://10.0.0.9/v1?x=1"]) {
      const request = answer(outcome);
      expect((await failure(reviewWithQwenDirect(input(), { request, env: { AUDIT_SECOND_OPINION_URL: url } }))).code).toBe("qwen_not_configured");
      expect(request).not.toHaveBeenCalled();
    }
  });
});

describe("실패", () => {
  it("상태·시간·연결·형식을 고정 코드로 가르고, 부르는 곳의 탈인지 함께 가른다", async () => {
    const code = async (request: typeof fetch, options: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
      (await failure(reviewWithQwenDirect(input(), { ...options, request, env: {} }))).code;
    expect(await code(status(503))).toBe("qwen_http_503");
    expect(await code(status(404))).toBe("qwen_http_404");
    expect(await code(status(400))).toBe("qwen_http_400");
    expect(await code(hanging, { timeoutMs: 20 })).toBe("qwen_timeout");
    const stop = new AbortController();
    const cancelled = code(hanging, { signal: stop.signal });
    stop.abort();
    expect(await cancelled).toBe("qwen_cancelled");
    expect(await code((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)).toBe("qwen_unreachable");
    expect(await code(answer("판단할 수 없습니다"))).toBe("qwen_invalid_json");
    // 근거 없이 승인한 답은 검증(validateReviewOutcome)이 받지 않는다
    const invalid = await failure(reviewWithQwenDirect(input(), { request: answer({ ...outcome, decision: "approve", evidenceIds: [] }), env: {} }));
    expect(invalid).toBeInstanceOf(QwenDirectError);
    expect(invalid.code).toBe("qwen_invalid_json");
    expect(invalid.message).toBe("qwen_invalid_json");

    expect(["qwen_timeout", "qwen_unreachable", "qwen_http_503", "qwen_http_404", "qwen_http_429", "qwen_http_401"]
      .every((value) => qwenEndpointFailure(value as QwenDirectError["code"]))).toBe(true);
    expect(["qwen_invalid_json", "qwen_http_400", "qwen_http_422", "qwen_input_too_large", "qwen_cancelled"]
      .some((value) => qwenEndpointFailure(value as QwenDirectError["code"]))).toBe(false);
  });
});

describe("모델별 규칙", () => {
  it("모델 갈래와 같은 모델을 게이트웨이 자리 표시 없이 가른다", () => {
    expect(secondOpinionFamily("qwen3.8-flash-next")).toBe("qwen");
    expect(secondOpinionFamily("[gpu3090] qwen3.8-flash-next")).toBe("qwen");
    expect(secondOpinionFamily("grok-4.7")).toBe("grok");
    expect(secondOpinionFamily("GPT-oss-120b")).toBe("gpt");
    expect(sameOpinionModel("[gpu3090] qwen3.8-flash-next", "qwen3.8-flash-next")).toBe(true);
    expect(sameOpinionModel("[supa] Qwen3.8-27B-NVFP4", "qwen3.8-flash-next")).toBe(false);
    expect(sameOpinionModel(null, "qwen3.8-flash-next")).toBe(false);
  });

  it("Qwen 거절은 카탈로그·디렉터리 같은 항목에서만 보류의 까닭이 되지 않는다 — grok 은 늘 된다", () => {
    expect(CATALOG_EXCEPTION_FAMILIES).toEqual(["qwen"]);
    const catalog = ["The page is a curated directory of AI tools.", "An awesome list of links.", "A list of third-party resources.",
      "This is a catalog of tools by category.", "This is a package registry page on npm."];
    for (const reason of catalog) {
      expect(catalogLikeAuditReason(reason), reason).toBe(true);
      expect(secondRejectHolds("qwen3.8-flash-next", reason), reason).toBe(false);
      expect(secondRejectHolds("grok-4.7", reason), reason).toBe(true);
    }
    for (const reason of ["The page is only a placeholder.", "Company marketing site for an agency.", null]) {
      expect(catalogLikeAuditReason(reason)).toBe(false);
      expect(secondRejectHolds("qwen3.8-flash-next", reason)).toBe(true);
    }
    // 표에 없는 모델은 지금까지처럼 센다
    expect(secondRejectHolds("deepseek-v4.1", "A curated directory of tools.")).toBe(true);
  });
});
