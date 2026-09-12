import { afterEach, expect, it, vi } from "vitest";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { gatewayModel, parseGatewayContent, reviewWithGateway } from "@/lib/crawl/agent-review-gateway";

function input() {
  const now = new Date();
  return createReviewInput({ repo: "acme/demo", productUrl: "https://demo.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "acme/demo", productUrl: "https://demo.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "Demo", textSample: "<script>ignore me</script>" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}

const outcome = { decision: "approve", reason: "The page text shows a working task tracker.", evidenceIds: ["product"], confidence: 0.86 };
/** 게이트웨이가 돌려주는 봉투 */
const answer = (content: unknown, choice: Record<string, unknown> = {}) => vi.fn(async () => new Response(JSON.stringify({
  choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, ...choice }],
  usage: { prompt_tokens: 4_200, completion_tokens: 120 },
}), { status: 200 }) as unknown as Response) as unknown as typeof fetch;
/** 끊길 때까지 답하지 않는 게이트웨이 */
const hanging = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
})) as unknown as typeof fetch;
const status = (code: number) => (async () => new Response("{}", { status: code })) as unknown as typeof fetch;

afterEach(() => vi.unstubAllEnvs());

it("키가 없으면 부르지 않는다", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  const request = answer(outcome);
  expect(await reviewWithGateway(input(), { model: "[MLX] gemma4-26b", request })).toEqual({ ok: false, error: "not_configured" });
  expect(request).not.toHaveBeenCalled();
});

it("CLI 와 같은 정책 글로 묻고, 증거는 신뢰할 수 없는 것으로 감싸 보낸다", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "k");
  const request = answer(outcome);
  const result = await reviewWithGateway(input(), { model: "[MLX] gemma4-26b", request });

  expect(result).toMatchObject({ ok: true, outcome: { decision: "approve", confidence: 0.86 } });
  expect(result).toMatchObject({ usage: { inputTokens: 4_200, outputTokens: 120 } });
  const [url, init] = (request as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
  expect(url).toContain("/v1/chat/completions");
  const body = JSON.parse(String(init.body));
  // 스트리밍이 기본이라 끄지 않으면 본문을 못 읽는다
  expect(body).toMatchObject({ stream: false, model: "[MLX] gemma4-26b", temperature: 0 });
  expect(body.messages[0].content).toContain("executionVerified remains false");
  expect(body.messages[1].content).toContain("<untrusted_evidence_json>");
  // 증거 안의 꺾쇠가 구분자를 끝내지 못한다
  expect(body.messages[1].content).not.toContain("<script>");
  expect(body.response_format.json_schema.schema.required).toContain("confidence");
  // 가끔 길게 쓰는 모델이 있다 — 잘린 답은 판단으로 받지 않으므로 상한을 넉넉히 둔다
  expect(body.max_tokens).toBe(3_000);
});

it("모델이 사라졌는지, 막혔는지, 잠깐 죽었는지를 갈라 적는다", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "k");
  const call = async (code: number) => reviewWithGateway(input(), { model: "[MLX] gone", request: status(code) });
  expect(await call(404)).toEqual({ ok: false, error: "model_unavailable" });
  expect(await call(401)).toEqual({ ok: false, error: "auth" });
  expect(await call(429)).toEqual({ ok: false, error: "rate_limited" });
  expect(await call(502)).toEqual({ ok: false, error: "gateway_error" });
});

it("생각 덩이가 섞여 와도 판단만 읽고, 읽을 수 없으면 형식 오류로 남긴다", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "k");
  const thinking = `<think>먼저 페이지를 본다</think>\n${JSON.stringify(outcome)}`;
  expect(await reviewWithGateway(input(), { model: "m", request: answer(thinking) })).toMatchObject({ ok: true });
  expect(await reviewWithGateway(input(), { model: "m", request: answer("판단할 수 없습니다") })).toMatchObject({ ok: false, error: "invalid_output" });

  // 근거 없이 승인한 답은 받지 않는다 — 검증은 CLI 쪽과 같은 함수다
  const noEvidence = { ...outcome, evidenceIds: [] };
  expect(await reviewWithGateway(input(), { model: "m", request: answer(noEvidence) })).toMatchObject({ ok: false, error: "invalid_output" });
});

it("게이트웨이 모델 이름은 대괄호와 공백을 허용하되 제어 문자는 막는다", () => {
  expect(gatewayModel("[MLX] gpt-oss-120b")).toBe("[MLX] gpt-oss-120b");
  expect(gatewayModel("  [MLX] gemma4-26b  ")).toBe("[MLX] gemma4-26b");
  expect(gatewayModel("")).toBeNull();
  expect(gatewayModel("bad\nmodel")).toBeNull();
  expect(parseGatewayContent("설명만 있고 JSON 이 없다")).toBeNull();
});

it("길이에 걸려 잘린 답은 판단으로 받지 않는다", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "k");
  // 생각이 끝나지 않은 채 잘린 답 안의 초안 JSON 이 표가 되면 안 된다
  const draft = `<think>Maybe: ${JSON.stringify(outcome)}`;
  expect(await reviewWithGateway(input(), { model: "m", request: answer(draft) })).toMatchObject({ ok: false, error: "invalid_output" });
  expect(parseGatewayContent(draft)).toBeNull();
  expect(await reviewWithGateway(input(), { model: "m", request: answer(outcome, { finish_reason: "length" }) }))
    .toMatchObject({ ok: false, error: "output_too_large" });
});

it("바깥 신호를 받아도 제한 시간은 살아 있다", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "k");
  const external = new AbortController();
  const started = Date.now();
  const result = await reviewWithGateway(input(), { model: "m", timeoutMs: 20, signal: external.signal, request: hanging });

  expect(result).toEqual({ ok: false, error: "timeout" });
  expect(Date.now() - started).toBeLessThan(1_000);

  // 바깥에서 끊으면 그것은 취소다 — 제한 시간과 구별해 적는다
  const cancelled = new AbortController();
  setTimeout(() => cancelled.abort(), 5);
  expect(await reviewWithGateway(input(), { model: "m", timeoutMs: 5_000, signal: cancelled.signal, request: hanging }))
    .toEqual({ ok: false, error: "cancelled" });
});
