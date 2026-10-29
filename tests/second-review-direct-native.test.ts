import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewInput, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { itemBindingHash, type Ai2ItemBinding } from "@/lib/jobs/items/types";
import { ai2DispatchBindingHash, ai2ModelDispatchSchema } from "@/lib/llm/capacity";
import { prepareAi2GatewayCall, readAi2GatewayTerminal, readGatewayNotStarted, reviewWithReservedAi2Gateway,
  type PreparedAi2GatewayCall } from "@/lib/crawl/agent-review-gateway";
import { ai2DirectServingContractsFromConfig, ai2GatewayServingContractHash, type Ai2DirectServingContract } from "@/lib/crawl/second-review-serving-contract";

const fixture = vi.hoisted(() => ({ contract: null as Ai2DirectServingContract | null }));
vi.mock("@/lib/crawl/second-review-serving-contract", async original => ({
  ...await original<typeof import("@/lib/crawl/second-review-serving-contract")>(),
  resolveAi2GatewayServingContract: (_model: string, provider: string) => provider === "local-direct" ? fixture.contract : null,
}));
const model = "qwen3.8-flash-next";
const outcome = { decision: "approve", reason: "A working task tracker is shown.", evidenceIds: ["product"], confidence: 0.86 };
function input(): ReviewInput {
  const now = new Date("2026-10-25T00:00:00.000Z");
  return createReviewInput({ repo: "native/direct", productUrl: "https://direct.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "native/direct", productUrl: "https://direct.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "Direct", textSample: "<script>untrusted</script>" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
function dispatch(value: ReviewInput, call: PreparedAi2GatewayCall) {
  const owner = { instanceId: "direct-unit", bootId: randomUUID() };
  const review: Ai2ItemBinding = { stage: "ai2", candidateId: 1, secondReviewId: 3, vote: 3, fallbackForId: null,
    inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, policyHash: "b".repeat(64), generationKey: "c".repeat(64),
    source: { kind: "first_attempt", firstAttemptId: 2 }, promptVersion: value.snapshot.policy.promptVersion,
    rulesVersion: value.snapshot.policy.rulesVersion, reviewer: { provider: "local-direct", model: call.model } };
  const binding = { kind: "ai2_item_gateway" as const, version: 1 as const, logicalWorkKey: "ai2:1:3", review,
    rowIdentityHash: "d".repeat(64), failureCount: 0, inputPolicyHash: value.policyHash,
    item: { workKey: "ai2:3", owner, token: randomUUID(), stageEpoch: 1, itemEpoch: 1, bindingHash: itemBindingHash(review) },
    provider: "local-direct" as const, model: call.model, routeId: "second-review" as const,
    wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound };
  return ai2ModelDispatchSchema.parse({ requestId: randomUUID(), owner, token: randomUUID(), epoch: 1, revision: 1,
    policyHash: "a".repeat(64), binding, bindingHash: ai2DispatchBindingHash(binding) });
}
function envelope(change: Record<string, unknown> = {}) {
  return { id: "direct-response", object: "chat.completion", created: 1, model,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(outcome) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, ...change };
}
type Seen = { path: string; body: Record<string, unknown>; authorization: string | undefined };
type Reply = (request: IncomingMessage, response: ServerResponse) => void;
async function server(run: (state: { seen: Seen[]; token: (value: unknown) => void; reply: (next: Reply) => void }) => Promise<void>) {
  const seen: Seen[] = [];
  let tokens: unknown = { count: 100, max_model_len: 50_000, tokens: Array(100).fill(1) };
  let reply: Reply = (_request, response) => response.end(JSON.stringify(envelope()));
  const http = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    seen.push({ path: request.url ?? "", body: JSON.parse(body), authorization: request.headers.authorization });
    if (request.url === "/tokenize") response.end(typeof tokens === "string" ? tokens : JSON.stringify(tokens));
    else reply(request, response);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  const origin = `http://127.0.0.1:${address.port}`;
  fixture.contract = { version: 1, protocol: "ai2-direct-openai-chat-v1", routeId: "second-review", provider: "local-direct", model,
    responseModel: model, deploymentRevision: "local-fixture-only", endpoint: `${origin}/v1/chat/completions`,
    tokenizerEndpoint: `${origin}/tokenize`, backendId: "gpu3090-qwen", physicalGroup: "gpu3090", totalTokenBound: 50_000,
    requestTokenBound: 32_000, maxOutputTokens: 10_000 };
  try { await run({ seen, token: value => { tokens = value; }, reply: next => { reply = next; } }); }
  finally {
    fixture.contract = null;
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }
}
async function prepared(value: ReviewInput, signal?: AbortSignal) {
  const call = await prepareAi2GatewayCall(value, { model, provider: "local-direct", timeoutMs: 1_000, signal });
  if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
  return call;
}
afterEach(() => { fixture.contract = null; vi.unstubAllEnvs(); });

it("uses exact direct chat tokenization and a single no-thinking inference without abcLLM credentials", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "must-never-leave");
  vi.stubEnv("ABCLLM_BASE_URL", "http://127.0.0.1:1");
  await server(async ({ seen, token }) => {
    token({ count: 22_000, max_model_len: 50_000, tokens: Array(22_000).fill(1) });
    const value = input(), call = await prepared(value), owned = dispatch(value, call);
    expect(call.totalTokenBound).toBe(50_000);
    expect(seen.map(item => item.path)).toEqual(["/tokenize"]);
    const result = await reviewWithReservedAi2Gateway(value, owned, call);
    expect(result.result.ok).toBe(true);
    expect(seen.map(item => item.path)).toEqual(["/tokenize", "/v1/chat/completions"]);
    expect(seen.every(item => item.authorization === undefined)).toBe(true);
    expect(seen[0].body).toMatchObject({ model, add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false } });
    expect(seen[0].body.messages).toEqual(seen[1].body.messages);
    expect(seen[1].body).toMatchObject({ model, stream: false, max_tokens: 10_000, chat_template_kwargs: { enable_thinking: false } });
    expect(seen[1].body).not.toHaveProperty("context_strategy");
    expect(seen[1].body).not.toHaveProperty("reasoning_effort");
    expect(readAi2GatewayTerminal(result.terminal)).toMatchObject({ dispatch: owned, provenance: "upstream_reported",
      actualUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
    expect(readAi2GatewayTerminal(structuredClone(result.terminal))).toBeNull();
    await expect(reviewWithReservedAi2Gateway(value, owned, call)).rejects.toThrow("ai2_gateway_call_mismatch");
    expect(seen).toHaveLength(2);
  });
});

it.each([
  { count: 22_001, max_model_len: 50_000, tokens: Array(22_001).fill(1) },
  { count: 100, max_model_len: 32_000, tokens: Array(100).fill(1) },
  { count: 100, max_model_len: 50_000, tokens: [1] },
  { count: 1.5, max_model_len: 50_000, tokens: [1] },
  { count: 1, max_model_len: 50_000, tokens: [-1] },
  "invalid-json",
])("fails closed before inference when tokenizer evidence is invalid (%#)", async tokenizer => {
  await server(async ({ seen, token }) => {
    token(tokenizer);
    expect(await prepareAi2GatewayCall(input(), { model, provider: "local-direct", timeoutMs: 1_000 }))
      .toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
    expect(seen.map(item => item.path)).toEqual(["/tokenize"]);
  });
});

it("allows direct preparation with no abcLLM key and refuses a copied capability or changed input", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  await server(async ({ seen }) => {
    const value = input(), call = await prepared(value), owned = dispatch(value, call);
    await expect(reviewWithReservedAi2Gateway(value, owned, { ...call })).rejects.toThrow("ai2_gateway_call_mismatch");
    const changed = structuredClone(value); changed.snapshot.product.description += " changed";
    await expect(reviewWithReservedAi2Gateway(changed, owned, call)).rejects.toThrow("ai2_gateway_call_mismatch");
    expect(seen).toHaveLength(1);
    const stopped = new AbortController(); stopped.abort();
    const result = await reviewWithReservedAi2Gateway(value, owned, call, { signal: stopped.signal });
    expect(result.result).toMatchObject({ ok: false, error: "cancelled" });
    expect(readGatewayNotStarted(result.notStarted)?.dispatch).toEqual(owned);
    expect(seen).toHaveLength(1);
  });
});

it.each(["redirect", "bad-model", "over-engine-C", "bad-json"])("keeps %s inference failures unknown and never retries", async kind => {
  await server(async ({ seen, reply }) => {
    reply((_request, response) => {
      if (kind === "redirect") { response.statusCode = 307; response.setHeader("Location", "/v1/chat/completions"); response.end(); }
      else if (kind === "bad-model") response.end(JSON.stringify(envelope({ model: "other" })));
      else if (kind === "over-engine-C") response.end(JSON.stringify(envelope({ usage: { prompt_tokens: 50_000, completion_tokens: 1, total_tokens: 50_001 } })));
      else response.end("{");
    });
    const value = input(), call = await prepared(value), owned = dispatch(value, call);
    const result = await reviewWithReservedAi2Gateway(value, owned, call);
    expect(result.result.ok).toBe(false); expect(result.terminal).toBeNull();
    await expect(reviewWithReservedAi2Gateway(value, owned, call)).rejects.toThrow("ai2_gateway_call_mismatch");
    expect(seen.map(item => item.path)).toEqual(["/tokenize", "/v1/chat/completions"]);
  });
});

it("records actual physical completion when a server violates the smaller request budget", async () => {
  await server(async ({ reply }) => {
    reply((_request, response) => response.end(JSON.stringify(envelope({ usage: { prompt_tokens: 22_001, completion_tokens: 1, total_tokens: 22_002 } }))));
    const value = input(), call = await prepared(value);
    const result = await reviewWithReservedAi2Gateway(value, dispatch(value, call), call);
    expect(result.result).toMatchObject({ ok: false, error: "invalid_output", detail: "request_token_bound_exceeded" });
    expect(readAi2GatewayTerminal(result.terminal)?.actualUsage?.totalTokens).toBe(22_002);
  });
});

it("keeps direct contract configuration separate, strict and tied to the engine C", async () => {
  await server(async () => {
    const contract = fixture.contract!;
    expect(ai2DirectServingContractsFromConfig(JSON.stringify({ version: 1, contracts: [contract] })).get(contract.backendId)).toEqual(contract);
    for (const contracts of [[contract, contract], [{ ...contract, tokenizerEndpoint: "http://other.example/tokenize" }],
      [{ ...contract, requestTokenBound: 50_000 }], [{ ...contract, totalTokenBound: 24_999 }], [{ ...contract, secret: "no" }]])
      expect(ai2DirectServingContractsFromConfig(JSON.stringify({ version: 1, contracts })).size).toBe(0);
    expect(ai2GatewayServingContractHash({ ...contract, deploymentRevision: "changed" })).not.toEqual(ai2GatewayServingContractHash(contract));
  });
});

it("keeps the equipment key in capacity bindings and sends the verified engine model on the wire", async () => {
  await server(async ({ seen }) => {
    const contract = fixture.contract!;
    vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(definition =>
      definition.key === "gpu3090:review" ? { ...definition, baseUrl: contract.endpoint.replace("/chat/completions", "") } : definition) }));
    const value = input(), call = await prepareAi2GatewayCall(value, { model: "gpu3090:review", provider: "local-direct", timeoutMs: 1000 });
    expect(call.kind).toBe("prepared");
    if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
    expect(call.model).toBe("gpu3090:review");
    const owned = dispatch(value, call), result = await reviewWithReservedAi2Gateway(value, owned, call);
    expect(result.result.ok).toBe(true);
    expect(seen.map(request => request.body.model)).toEqual([model, model]);
    expect(readAi2GatewayTerminal(result.terminal)?.dispatch.binding.model).toBe("gpu3090:review");
  });
});
