import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewInput, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { ai1DispatchBindingHash, ai1ModelDispatchSchema, type GatewayDispatchProvider } from "@/lib/llm/capacity";
import { prepareAi1DirectCall, prepareAi1GatewayCall, readAi1GatewayTerminal, reviewWithReservedAi1Gateway,
  type PreparedAi1GatewayCall } from "@/lib/crawl/agent-review-gateway";
import type { Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";

/**
 * PR 3b-C: AI1 이 엔진에 직접(local-direct) 갈 때의 선(wire) — 라벨 없는 엔진 모델 이름, 게이트웨이 전용 칸·엄격 terminal 헤더 없음,
 * 엔진의 완결 응답이 terminal 증거. 같은 규칙이 2026-10-31 엔진 연결 계약(raw, provider abcllm, 관리 transport direct)에도 이미 서 있는지 함께 본다.
 */
const fixture = vi.hoisted(() => ({ contract: null as Ai1GatewayServingContract | null, calls: [] as [string, string | undefined][] }));
vi.mock("@/lib/crawl/agent-review-serving-contract", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-serving-contract")>(),
  resolveAi1GatewayServingContract: (model: string, provider?: string) => {
    fixture.calls.push([model, provider]);
    return fixture.contract && fixture.contract.provider === (provider ?? "abcllm") ? fixture.contract : null;
  },
}));
const engineModel = "Inferact/Qwen3.8-27B-NVFP4";
const outcome = { decision: "approve", reason: "A working task tracker is shown.", evidenceIds: ["product"], confidence: 0.86 };
function input() {
  const now = new Date("2026-10-31T00:00:00.000Z");
  return createReviewInput({ repo: "direct/demo", productUrl: "https://demo.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "direct/demo", productUrl: "https://demo.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "Demo", textSample: "A task tracker" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
// vLLM's own completion: no gateway usage_provenance, answered with its first served name.
const engineReply = (usage = { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 }) => ({ id: "engine-response", object: "chat.completion",
  created: 1, model: "local-llm", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(outcome) }, finish_reason: "stop" }], usage });
function dispatch(value: ReviewInput, call: PreparedAi1GatewayCall, provider: GatewayDispatchProvider) {
  const binding = { kind: "ai1_legacy_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:1", candidateId: 1, attemptId: 2,
    inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, reviewPolicyHash: value.policyHash,
    promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
    provider, model: call.model, routeId: "crawl-agent-review" as const, stageEpoch: 1,
    wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound,
    chargedTokens: call.totalTokenBound, job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 1 } };
  return ai1ModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: "local-test", bootId: randomUUID() },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64), binding, bindingHash: ai1DispatchBindingHash(binding) });
}
type Seen = { url: string; body: string; headers: IncomingHttpHeaders };
async function engine<T>(run: (state: { seen: Seen[]; origin: string; reply: (value: (response: ServerResponse) => void) => void }) => Promise<T>) {
  const seen: Seen[] = [];
  let reply: (response: ServerResponse) => void = response => { response.end(JSON.stringify(engineReply())); };
  const http = createServer((request, response) => {
    void (async () => {
      let body = ""; for await (const chunk of request) body += chunk.toString();
      seen.push({ url: request.url ?? "", body, headers: request.headers });
      if (request.url === "/tokenize") return response.end(JSON.stringify({ count: 900, tokens: Array.from({ length: 900 }, () => 1), max_model_len: 131_072 }));
      reply(response);
    })();
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  try { return await run({ seen, origin: `http://127.0.0.1:${address.port}`, reply: value => { reply = value; } }); }
  finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
}
const direct = (origin: string): Ai1GatewayServingContract => ({ version: 1, protocol: "direct-openai-chat-v1", routeId: "crawl-agent-review",
  provider: "local-direct", model: engineModel, responseModel: "local-llm", deploymentRevision: "gpu3090-vllm;C=131072",
  endpoint: `${origin}/v1/chat/completions`, tokenizerEndpoint: `${origin}/tokenize`, backendId: "gpu3090-qwen", physicalGroup: "gpu3090",
  totalTokenBound: 131_072, requestTokenBound: 32_000, maxOutputTokens: 4_096 });
afterEach(() => { fixture.contract = null; fixture.calls = []; setServingContractSnapshotForTest(null); vi.unstubAllEnvs(); });

it("sends a local-direct AI1 review with the engine name, no gateway fields, no key and no strict header, and keeps the engine terminal", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "gateway-key-not-for-engines");
  await engine(async ({ seen, origin }) => {
    fixture.contract = direct(origin);
    const value = input();
    // The synchronous gateway preparation never opens a local-direct contract.
    expect(prepareAi1GatewayCall(value, { model: engineModel, timeoutMs: 2_000 })).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
    const call = await prepareAi1DirectCall(value, { model: engineModel, timeoutMs: 2_000 });
    expect(call.kind).toBe("prepared"); if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
    expect(fixture.calls).toContainEqual([engineModel, "local-direct"]);
    expect(seen.map(entry => entry.url)).toEqual(["/tokenize"]);
    expect(call).toMatchObject({ model: engineModel, totalTokenBound: 131_072 });
    const response = await reviewWithReservedAi1Gateway(value, dispatch(value, call, "local-direct"), call, { timeoutMs: 2_000 });
    expect(response.result).toMatchObject({ ok: true, outcome: { decision: "approve" } });
    const sent = seen.find(entry => entry.url === "/v1/chat/completions")!;
    const wire = JSON.parse(sent.body);
    expect(wire.model).toBe(engineModel);
    expect(wire).not.toHaveProperty("context_strategy");
    expect(wire).not.toHaveProperty("reasoning_effort");
    expect(wire).toMatchObject({ stream: false, max_tokens: 4_096, chat_template_kwargs: { enable_thinking: false } });
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers["x-abcllm-strict-terminal"]).toBeUndefined();
    expect(readAi1GatewayTerminal(response.terminal)).toMatchObject({ finishReason: "stop", provenance: "upstream_reported",
      actualUsage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 } });
  });
});

it("refuses a local-direct preparation whose tokenized request would exceed the request bound, before any chat request", async () => {
  await engine(async ({ seen, origin }) => {
    fixture.contract = { ...direct(origin), maxOutputTokens: 31_500 } as Ai1GatewayServingContract;
    expect(await prepareAi1DirectCall(input(), { model: engineModel, timeoutMs: 2_000 }))
      .toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
    expect(seen.map(entry => entry.url)).toEqual(["/tokenize"]);
  });
});

it("rejects an engine answer whose reported usage breaks the direct request bound", async () => {
  await engine(async ({ origin, reply }) => {
    fixture.contract = direct(origin);
    const value = input(), call = await prepareAi1DirectCall(value, { model: engineModel, timeoutMs: 2_000 });
    if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
    reply(response => response.end(JSON.stringify(engineReply({ prompt_tokens: 30_000, completion_tokens: 40, total_tokens: 30_040 }))));
    const response = await reviewWithReservedAi1Gateway(value, dispatch(value, call, "local-direct"), call, { timeoutMs: 2_000 });
    expect(response.result).toEqual({ ok: false, error: "invalid_output", detail: "request_token_bound_exceeded" });
    // The completed engine response is still the physical terminal of that dispatch.
    expect(readAi1GatewayTerminal(response.terminal)).toMatchObject({ finishReason: "stop" });
  });
});

it("already sends the 2026-10-31 engine-connect contract (raw, abcllm, admin transport direct) with the engine name and no strict header", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  await engine(async ({ seen, origin }) => {
    fixture.contract = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm", model: engineModel,
      responseModel: "local-llm", deploymentRevision: `direct-gpu3090-${engineModel}-C131072`, endpoint: `${origin}/v1/chat/completions`, totalTokenBound: 131_072 };
    setServingContractSnapshotForTest([{ routeId: "crawl-agent-review", model: engineModel, contract: fixture.contract, auth: "none", apiKey: null, transport: "direct" }]);
    const value = input(), call = prepareAi1GatewayCall(value, { model: engineModel, timeoutMs: 2_000 });
    if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
    const response = await reviewWithReservedAi1Gateway(value, dispatch(value, call, "abcllm"), call, { timeoutMs: 2_000 });
    expect(response.result).toMatchObject({ ok: true });
    const sent = seen.find(entry => entry.url === "/v1/chat/completions")!;
    expect(JSON.parse(sent.body).model).toBe(engineModel);
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers["x-abcllm-strict-terminal"]).toBeUndefined();
    // No gateway usage_provenance: the engine's own completion is terminal for a direct transport.
    expect(readAi1GatewayTerminal(response.terminal)).toMatchObject({ provenance: "upstream_reported" });
  });
});
