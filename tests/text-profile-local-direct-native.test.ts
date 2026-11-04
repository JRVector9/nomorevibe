import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { profileHash, type ProfileEvidence } from "@/lib/domain/products/search-profile";
import { modelLimits } from "@/lib/llm/model-registry";
import { textProfileInputHash, textProfileDispatchBindingHash, textProfileModelDispatchSchema } from "@/lib/llm/capacity";
import { DIRECT_OPENAI_CHAT_PROTOCOL, DIRECT_REQUEST_TOKEN_BOUND } from "@/lib/llm/direct-serving-contract";
import { prepareTextProfileGatewayCall, readGatewayNotStarted, readTextProfileGatewayTerminal, writeKeywordsWithReservedGateway,
  type PreparedTextProfileGatewayCall } from "@/lib/crawl/agent-review-gateway";
import type { TextProfileServingContract } from "@/lib/llm/text-profile-serving-contract";

/**
 * PR 3b-E: product-search-profile 이 local-direct 직접 계약(direct-openai-chat-v1)으로 엔진에 바로 보내고, binding·terminal 에 provider local-direct 를
 * 남긴다. 엔진 tokenizer 가 요청 상한을 먼저 확인하고(넘으면 보내지 않고 not_started), 엔진의 완결 응답이 terminal 증거다. 운영 값이 아니다.
 */
const fixture = vi.hoisted(() => ({ contract: null as TextProfileServingContract | null }));
vi.mock("@/lib/llm/text-profile-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/text-profile-serving-contract")>(),
  resolveTextProfileServingContract: (_model: string, provider = "abcllm") => fixture.contract?.provider === provider ? fixture.contract : null,
}));
const requests = new Set<Promise<unknown>>();
function send(...args: Parameters<typeof writeKeywordsWithReservedGateway>) {
  const promise = writeKeywordsWithReservedGateway(...args); requests.add(promise); void promise.catch(() => {}); return promise;
}
const selection = "fixture/engine-7b";
function evidence(): ProfileEvidence {
  return { url: "https://profile.example", name: "Expense Demo", category: "finance", topics: "budget",
    tagline: "Manage expenses <untrusted>", pageText: "", readme: "", evidenceLevel: "thin" };
}
function envelope(change: Record<string, unknown> = {}) {
  // An engine's own completion: no gateway usage_provenance, the contract's responseModel.
  return { id: "engine-response", object: "chat.completion", created: 1, model: "local-llm",
    choices: [{ index: 0, message: { role: "assistant", content: '{"keywords_en":["budget app"],"keywords_ko":["가계부"]}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, ...change };
}
function prepared(value: ProfileEvidence) {
  const call = prepareTextProfileGatewayCall(value, { model: selection, timeoutMs: 2000, provider: "local-direct" });
  expect(call.kind).toBe("prepared");
  if (call.kind !== "prepared") throw new Error("fixture_not_prepared"); return call;
}
function dispatch(value: ProfileEvidence, call: PreparedTextProfileGatewayCall) {
  const role = { role: "text" as const, instanceId: "text-direct-unit", bootId: randomUUID(), release: "test-release",
    kind: "primary" as const, epoch: 1, batch: { mode: "legacy" as const } };
  const input = { productId: 1, slug: "direct-profile", evidenceHash: profileHash(value), profile: { kind: "absent" as const }, model: selection };
  const binding = { ...input, inputHash: textProfileInputHash(input), logicalWorkKey: "text:profile:1",
    kind: "text_profile_gateway" as const, version: 1 as const, role,
    job: { name: "product-search-profile" as const, token: randomUUID(), requestedVersion: 1 },
    routeId: "product-search-profile" as const, provider: call.provider, wireHash: call.wireHash,
    servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound };
  return textProfileModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64), binding, bindingHash: textProfileDispatchBindingHash(binding) });
}
type Seen = { path: string; body: string; headers: IncomingMessage["headers"] };
async function server(run: (state: { seen: Seen[]; tokens: (count: number) => void; reply: (value: (response: ServerResponse) => void) => void;
  tokenizer: (value: (response: ServerResponse) => void) => void }) => Promise<void>) {
  const seen: Seen[] = [], responses = new Set<Promise<void>>(), errors: unknown[] = [];
  let count = 120, reply = (response: ServerResponse) => { response.end(JSON.stringify(envelope())); };
  let tokenizer: ((response: ServerResponse) => void) | undefined;
  const http = createServer((request, response) => {
    const closed = new Promise<void>(resolve => response.once("close", resolve));
    const pending = (async () => { let body = ""; for await (const chunk of request) body += chunk.toString();
      seen.push({ path: request.url ?? "", body, headers: request.headers });
      if (request.url === "/tokenize") {
        if (tokenizer) tokenizer(response);
        else response.end(JSON.stringify({ count, max_model_len: 50_000, tokens: Array.from({ length: count }, (_, index) => index + 1) }));
      }
      else reply(response);
      await closed; })();
    responses.add(pending); void pending.catch(() => {});
  });
  let failure: unknown, failed = false;
  try {
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
    fixture.contract = { version: 1, protocol: DIRECT_OPENAI_CHAT_PROTOCOL, routeId: "product-search-profile", provider: "local-direct",
      model: selection, responseModel: "local-llm", deploymentRevision: "loopback-only", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      tokenizerEndpoint: `http://127.0.0.1:${address.port}/tokenize`, backendId: "engine-local-7b", physicalGroup: "engine-local",
      totalTokenBound: 50_000, requestTokenBound: DIRECT_REQUEST_TOKEN_BOUND, maxOutputTokens: 1024 };
    await run({ seen, tokens: next => { count = next; }, reply: next => { reply = next; }, tokenizer: next => { tokenizer = next; } });
  } catch (error) { failed = true; failure = error; }
  finally {
    fixture.contract = null;
    const watchdog = setTimeout(() => { errors.push(new Error("fixture_forced_close")); http.closeAllConnections(); }, 2000);
    try {
      await Promise.allSettled([...requests]); requests.clear();
      const closing = http.listening ? new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) : Promise.resolve();
      for (const result of await Promise.allSettled([closing, ...responses])) if (result.status === "rejected") errors.push(result.reason);
    } finally { clearTimeout(watchdog); }
  }
  if (failed && errors.length) throw new AggregateError([failure, ...errors]);
  if (failed) throw failure; if (errors.length) throw new AggregateError(errors);
}
afterEach(() => { fixture.contract = null; vi.unstubAllEnvs(); });

it("without a local-direct contract the direct preparation is unsupported, and an abcllm preparation never picks a direct contract", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  expect(prepareTextProfileGatewayCall(evidence(), { model: selection, timeoutMs: 1000, provider: "local-direct" }))
    .toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
  await server(async () => {
    expect(prepareTextProfileGatewayCall(evidence(), { model: selection, timeoutMs: 1000 })).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
    expect(prepareTextProfileGatewayCall(evidence(), { model: selection, timeoutMs: 1000, provider: "abcllm" })).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
  });
});

it("tokenizes first, then sends one engine wire without gateway fields or a bearer, and records a local-direct terminal with usage", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  await server(async ({ seen }) => {
    const value = evidence(), call = prepared(value), owned = dispatch(value, call);
    expect(call.provider).toBe("local-direct");
    expect(owned.binding.provider).toBe("local-direct");
    const result = await send(value, owned, call);
    expect(result.result).toEqual({ ok: true, en: ["budget app"], ko: ["가계부"] });
    expect(seen.map(entry => entry.path)).toEqual(["/tokenize", "/v1/chat/completions"]);
    const wire = JSON.parse(seen[1].body);
    expect(wire).toMatchObject({ model: selection, stream: false, max_tokens: Math.min(modelLimits("product-search-profile").maxTokens, 1024),
      chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_object" } });
    expect(wire).not.toHaveProperty("context_strategy");
    expect(wire).not.toHaveProperty("reasoning_effort");
    expect(seen[1].headers.authorization).toBeUndefined();
    expect(seen[1].headers["x-abcllm-strict-terminal"]).toBeUndefined();
    // The tokenizer saw the exact chat messages and template controls of the wire.
    expect(JSON.parse(seen[0].body)).toMatchObject({ model: selection, messages: wire.messages, add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false } });
    const proof = readTextProfileGatewayTerminal(result.terminal);
    expect(proof).toMatchObject({ dispatch: owned, finishReason: "stop", actualUsage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 }, provenance: "upstream_reported" });
    expect(proof?.dispatch.binding).toMatchObject({ provider: "local-direct", routeId: "product-search-profile", totalTokenBound: 50_000, chargedTokens: 50_000 });
    expect(result.notStarted).toBeUndefined();
    // One-use: the same dispatch cannot be sent again.
    await expect(send(value, owned, call)).rejects.toThrow("text_profile_gateway_call_mismatch");
    expect(seen).toHaveLength(2);
  });
});

it("a request the engine tokenizer counts past the request bound is never sent and settles as not_started", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  await server(async ({ seen, tokens }) => {
    tokens(DIRECT_REQUEST_TOKEN_BOUND); // count + max_tokens > 32k
    const value = evidence(), call = prepared(value), owned = dispatch(value, call);
    const result = await send(value, owned, call);
    expect(result.result).toEqual({ ok: false, error: "input_too_large" });
    expect(result.terminal).toBeNull();
    expect(readGatewayNotStarted(result.notStarted)).toMatchObject({ kind: "gateway_not_started", dispatch: owned });
    expect(seen.map(entry => entry.path)).toEqual(["/tokenize"]);
  });
});

it.each(["http_error", "invalid_response", "contract_mismatch"])("keeps tokenizer %s separate from product input overflow and issues only zero-byte proof", async cause => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  await server(async ({ seen, tokenizer }) => {
    tokenizer(response => {
      if (cause === "http_error") { response.statusCode = 503; response.end("{}"); }
      else if (cause === "invalid_response") response.end("not-json");
      else response.end(JSON.stringify({ count: DIRECT_REQUEST_TOKEN_BOUND, max_model_len: 98_304,
        tokens: Array(DIRECT_REQUEST_TOKEN_BOUND).fill(1) }));
    });
    const value = evidence(), call = prepared(value), owned = dispatch(value, call);
    const result = await send(value, owned, call);
    expect(result.result).toEqual({ ok: false, error: "tokenizer_unavailable" });
    expect(result.terminal).toBeNull();
    expect(readGatewayNotStarted(result.notStarted)).toMatchObject({ kind: "gateway_not_started", dispatch: owned });
    expect(seen.map(entry => entry.path)).toEqual(["/tokenize"]);
    await expect(send(value, owned, call)).rejects.toThrow("text_profile_gateway_call_mismatch");
    expect(seen).toHaveLength(1);
  });
});

it("an engine completion whose usage contradicts the request bound keeps the terminal but is not a result", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  await server(async ({ reply }) => {
    reply(response => response.end(JSON.stringify(envelope({ usage: { prompt_tokens: DIRECT_REQUEST_TOKEN_BOUND, completion_tokens: 20, total_tokens: DIRECT_REQUEST_TOKEN_BOUND + 20 } }))));
    const value = evidence(), call = prepared(value), owned = dispatch(value, call);
    const result = await send(value, owned, call);
    expect(result.result).toEqual({ ok: false, error: "invalid_output" });
    expect(readTextProfileGatewayTerminal(result.terminal)).toMatchObject({ provenance: "upstream_reported", actualUsage: { totalTokens: DIRECT_REQUEST_TOKEN_BOUND + 20 } });
  });
});

it("a binding that names abcllm cannot be sent through the local-direct preparation", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  await server(async ({ seen }) => {
    const value = evidence(), call = prepared(value), owned = dispatch(value, call);
    const forged = textProfileModelDispatchSchema.parse({ ...owned, binding: { ...owned.binding, provider: "abcllm" },
      bindingHash: textProfileDispatchBindingHash({ ...owned.binding, provider: "abcllm" }) });
    await expect(send(value, forged, call)).rejects.toThrow("text_profile_gateway_call_mismatch");
    expect(seen).toHaveLength(0);
  });
});
