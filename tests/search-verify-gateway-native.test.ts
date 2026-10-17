import { createHash, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { parseVerification, verifyKeywords, type VerifyItem } from "@/lib/domain/products/search-verify";
import { profileHash } from "@/lib/domain/products/search-profile";
import { searchVerifyGenerationHash, searchVerifyLogicalWorkKey, searchVerifyInputHash, searchVerifyDispatchBindingHash,
  searchVerifyModelDispatchSchema, type SearchVerifyInput, type SearchVerifyStep } from "@/lib/llm/capacity";
import { prepareSearchVerifyGatewayCall, verifyKeywordsWithReservedGateway, readSearchVerifyGatewayTerminal,
  readCrawlTaglineGatewayTerminal, type PreparedSearchVerifyGatewayCall } from "@/lib/crawl/agent-review-gateway";
import type { SearchVerifyServingContract } from "@/lib/llm/search-verify-serving-contract";

const fixture = vi.hoisted(() => ({ contract: null as SearchVerifyServingContract | null }));
vi.mock("@/lib/llm/search-verify-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/search-verify-serving-contract")>(), resolveSearchVerifyServingContract: () => fixture.contract,
}));
vi.mock("@/lib/llm/text-capacity-admission", () => ({ assertTextModelAdmission: vi.fn() }));
const model = "verify-original-model", requests = new Set<Promise<unknown>>();
const evidence = { name: "Academy", url: "https://a.test", category: "Sports", topics: "", tagline: "Bonos de clases <b>", pageText: "", readme: "", evidenceLevel: "thin" as const };
const item = (): VerifyItem => ({ evidence: structuredClone(evidence), keywords: ["sports academy", "membership bonuses", "보너스 관리"] });
const answer = (keywords: string[], unsupported: string[] = []) => JSON.stringify({ product: "Sports academy software",
  checks: keywords.map(keyword => ({ keyword, reading: keyword, source: "none", source_means: keyword, fits: !unsupported.includes(keyword) })) });
function envelope(content: string | null, change: Record<string, unknown> = {}) {
  return { id: "verify-local", object: "chat.completion", created: 1, model: "served-verify",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, usage_provenance: "upstream_reported", ...change };
}
function prepared(input: VerifyItem, timeoutMs = 1000) {
  const call = prepareSearchVerifyGatewayCall(input, { model, timeoutMs });
  expect(call.kind).toBe("prepared"); if (call.kind !== "prepared") throw new Error("fixture_not_prepared"); return call;
}
function dispatch(input: VerifyItem, call: PreparedSearchVerifyGatewayCall, step: SearchVerifyStep = { kind: "full" }, count = input.keywords.length) {
  const member = { productId: 31, slug: "academy", evidenceHash: profileHash(input.evidence),
    profile: { rowIdentityHash: "c".repeat(64), sourceRevision: 0, verifyAttempts: 1 }, keywordsHash: "a".repeat(64),
    keywordCount: count, mode: step.kind === "full" ? "full" as const : "chunk" as const, policyHash: "b".repeat(64) };
  // Native shape-only fixture; settled-parent, current-domain and DB authority belong to ledger/runtime tests.
  const value: SearchVerifyInput = { member, model, execution: 0, step,
    parent: step.kind === "full" || step.kind === "chunk" && step.chunk === 0 ? null : { requestId: randomUUID(), bindingHash: "e".repeat(64), responseHash: "f".repeat(64) } };
  const role = { role: "text" as const, instanceId: "verify-native-unit", bootId: randomUUID(), release: "local-only",
    kind: "primary" as const, epoch: 1, batch: { mode: "legacy" as const } };
  const binding = { ...value, kind: "search_verify_gateway" as const, version: 1 as const, generationHash: searchVerifyGenerationHash(value),
    logicalWorkKey: searchVerifyLogicalWorkKey(value), inputHash: searchVerifyInputHash(value), deadlineAt: Date.now() + 60_000,
    provider: "abcllm" as const, routeId: "product-search-verify" as const, wireHash: call.wireHash, servingContractHash: call.servingContractHash,
    totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, role,
    job: { name: "product-search-verify" as const, token: randomUUID(), requestedVersion: 1 } };
  return searchVerifyModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64), binding, bindingHash: searchVerifyDispatchBindingHash(binding) });
}
function send(...args: Parameters<typeof verifyKeywordsWithReservedGateway>) {
  const pending = verifyKeywordsWithReservedGateway(...args); requests.add(pending); void pending.catch(() => {}); return pending;
}
async function server(run: (state: { bodies: string[]; reply: (next: (response: ServerResponse) => void) => void }) => Promise<void>) {
  const bodies: string[] = [], responses = new Set<Promise<void>>(), errors: unknown[] = [], unused = new Set<Socket>();
  let reply = (response: ServerResponse) => { response.end(JSON.stringify(envelope(answer(item().keywords, ["membership bonuses"])))); };
  const http = createServer((request, response) => {
    unused.delete(request.socket);
    const closed = new Promise<void>(resolve => response.once("close", resolve));
    const pending = (async () => { let body = ""; for await (const part of request) body += part.toString(); bodies.push(body); reply(response); await closed; })();
    responses.add(pending); void pending.catch(() => {});
  });
  http.on("connection", socket => { unused.add(socket); socket.once("close", () => unused.delete(socket)); });
  let failed = false, original: unknown, watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
    fixture.contract = { version: 1, protocol: "abcllm-search-verify-total-bound-v1", routeId: "product-search-verify", provider: "abcllm",
      model, responseModel: "served-verify", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, deploymentRevision: "local-only", totalTokenBound: 8192 };
    watchdog = setTimeout(() => { errors.push(new Error("fixture_forced_close")); http.closeAllConnections(); }, 2000);
    await run({ bodies, reply: next => { reply = next; } });
  } catch (error) { failed = true; original = error; }
  finally {
    fixture.contract = null;
    try {
      while (requests.size) { const pending = [...requests]; await Promise.allSettled(pending); for (const promise of pending) requests.delete(promise); }
      // 중단된 소켓을 다시 잇는 undici 풀이 요청 없이 남긴 예비 연결은 server.close()가 유휴로 치지 않으므로 호출이 끝난 뒤 닫는다.
      for (const socket of unused) socket.destroy();
      const close = http.listening ? new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) : Promise.resolve();
      for (const result of await Promise.allSettled([close, ...responses])) if (result.status === "rejected") errors.push(result.reason);
    } finally { clearTimeout(watchdog); }
  }
  if (failed && errors.length) throw new AggregateError([original, ...errors], "native_fixture_failed", { cause: original });
  if (failed) throw original; if (errors.length) throw new AggregateError(errors);
}
afterEach(() => { fixture.contract = null; vi.unstubAllEnvs(); });

it("sends the byte-identical legacy wire once and issues an immutable opaque parsed outcome", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies }) => {
    const input = item(), call = prepared(input), owned = dispatch(input, call), response = await send(input, owned, call);
    expect(response.result).toEqual({ ok: true, unsupported: ["membership bonuses"] });
    let legacy = "";
    expect(await verifyKeywords(input, { model, timeoutMs: 1000, request: (async (_url, init) => {
      legacy = String(init?.body); return new Response(JSON.stringify(envelope(answer(input.keywords)))); }) as typeof fetch })).toEqual({ ok: true, unsupported: [] });
    expect(bodies).toEqual([legacy]);
    const wire = JSON.parse(bodies[0]);
    expect(wire).toMatchObject({ context_strategy: "raw", model, stream: false, temperature: 0, max_tokens: 3000, reasoning_effort: "low",
      chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_object" } });
    expect(wire.messages[1].content).toContain("\\u003cb\\u003e");
    const proof = readSearchVerifyGatewayTerminal(response.terminal);
    expect(proof).toMatchObject({ dispatch: owned, finishReason: "stop", outcome: { ok: true, removed: ["membership bonuses"] },
      actualUsage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 }, provenance: "upstream_reported" });
    expect(Object.isFrozen(proof?.outcome)).toBe(true);
    expect(proof?.responseHash).toBe(createHash("sha256").update(JSON.stringify(envelope(answer(input.keywords, ["membership bonuses"])))).digest("hex"));
  });
});
it("keeps production unsupported without caller-enabled terminal authority", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only");
  const leaf = await vi.importActual<typeof import("@/lib/llm/search-verify-serving-contract")>("@/lib/llm/search-verify-serving-contract");
  expect(leaf.resolveSearchVerifyServingContract(model)).toBeNull();
  expect(prepareSearchVerifyGatewayCall(item(), { model, timeoutMs: 1000 })).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
  expect(readSearchVerifyGatewayTerminal({ kind: "search_verify_gateway_terminal" })).toBeNull();
  await server(async ({ bodies }) => {
    for (const input of [{ ...item(), extra: true }, { ...item(), keywords: [] }, { ...item(), keywords: [1] }, { ...item(), evidence: { ...evidence, pageText: null } }])
      expect(prepareSearchVerifyGatewayCall(input as unknown as VerifyItem, { model, timeoutMs: 1000 }).kind).toBe("unsupported");
    vi.stubEnv("ABCLLM_API_KEY", "");
    expect(prepareSearchVerifyGatewayCall(item(), { model, timeoutMs: 1000 }).kind).toBe("unsupported"); expect(bodies).toEqual([]);
  });
});
it("uses one preparation per physical step and rejects copies, changed keywords and request reuse before POST", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies }) => {
    const input = item(), call = prepared(input), owned = dispatch(input, call);
    await expect(send(input, owned, { ...call })).rejects.toThrow("search_verify_gateway_call_mismatch");
    for (const changed of [{ ...input, keywords: [...input.keywords].reverse() }, { ...input, keywords: input.keywords.slice(1) },
      { ...input, evidence: { ...input.evidence, tagline: "Changed" } }])
      await expect(send(changed, owned, call)).rejects.toThrow("search_verify_gateway_call_mismatch");
    expect(bodies).toEqual([]);
    await send(input, owned, call);
    await expect(send(input, owned, call)).rejects.toThrow("search_verify_gateway_call_mismatch");
    await expect(send(input, dispatch(input, call), call)).rejects.toThrow("search_verify_gateway_call_mismatch");
    await expect(send(input, owned, prepared(input))).rejects.toThrow("search_verify_gateway_call_mismatch");
    expect(bodies).toHaveLength(1);
    const single = { ...input, keywords: [input.keywords[1]] }, call2 = prepared(single), second = dispatch(single, call2, { kind: "single", chunk: 0, item: 1 }, 3);
    const singleResponse = await send(single, second, call2);
    expect(readSearchVerifyGatewayTerminal(singleResponse.terminal)?.dispatch.binding.step).toEqual({ kind: "single", chunk: 0, item: 1 });
    expect(readCrawlTaglineGatewayTerminal(singleResponse.terminal)).toBeNull();
    expect(readSearchVerifyGatewayTerminal(structuredClone(singleResponse.terminal))).toBeNull(); expect(bodies).toHaveLength(2);
  });
});
it("persists the original parser failure as a terminal invalid_output outcome", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ reply }) => {
    const input = item();
    for (const content of [answer(input.keywords.slice(1)), "not JSON", null, answer(["made up", ...input.keywords])]) {
      reply(response => response.end(JSON.stringify(envelope(content))));
      const call = prepared(input), response = await send(input, dispatch(input, call), call);
      expect(() => parseVerification(input.keywords, content ?? "")).toThrow();
      expect(response.result).toEqual({ ok: false, error: "invalid_output" });
      expect(readSearchVerifyGatewayTerminal(response.terminal)?.outcome).toEqual({ ok: false, error: "invalid_output" });
    }
  });
});
it("keeps the outer JSON decoding failure as network and an untrusted envelope as invalid_output, both without terminal", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies, reply }) => {
    const input = item();
    reply(response => response.end("{not json"));
    let call = prepared(input);
    expect(await send(input, dispatch(input, call), call)).toEqual({ result: { ok: false, error: "network" }, terminal: null });
    for (const change of [{ model: "wrong" }, { usage: { prompt_tokens: 8192, completion_tokens: 1, total_tokens: 8193 } },
      { choices: [{ index: 0, message: { role: "assistant", content: answer(input.keywords) }, finish_reason: null }] }]) {
      reply(response => response.end(JSON.stringify(envelope(answer(input.keywords), change))));
      call = prepared(input);
      expect(await send(input, dispatch(input, call), call)).toEqual({ result: { ok: false, error: "invalid_output" }, terminal: null });
    }
    expect(bodies).toHaveLength(4);
  });
});
it.each([[404, "model_unavailable"], [429, "rate_limit"], [503, "http_503"], [307, "http_307"]])
  ("performs one physical POST for HTTP %i with the original %s error and no redirect/retry", async (status, error) => {
    vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies, reply }) => {
      reply(response => { response.statusCode = status; response.setHeader("Location", "/v1/chat/completions"); response.end("failure"); });
      const input = item(), call = prepared(input);
      expect(await send(input, dispatch(input, call), call)).toEqual({ result: { ok: false, error }, terminal: null });
      expect(bodies).toHaveLength(1);
    });
  });
it.each([{ usage: null }, { usage_provenance: "gateway_estimated" }])("keeps full C when native counters have no verified provenance: %j", async change => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ reply }) => {
    const input = item(); reply(response => response.end(JSON.stringify(envelope(answer(input.keywords), change))));
    const call = prepared(input), response = await send(input, dispatch(input, call), call);
    expect(readSearchVerifyGatewayTerminal(response.terminal)).toMatchObject({ actualUsage: null, provenance: "unknown", dispatch: { binding: { chargedTokens: 8192 } } });
  });
});
it("leaves truncated EOF, caller abort and timeout without terminal authority", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies, reply }) => {
    const input = item();
    reply(response => { response.writeHead(200, { "Content-Length": "1000" }); response.write("{"); response.socket?.destroy(); });
    let call = prepared(input);
    expect(await send(input, dispatch(input, call), call)).toEqual({ result: { ok: false, error: "network" }, terminal: null });
    reply(response => { response.writeHead(200); response.flushHeaders(); });
    call = prepared(input, 80);
    expect(await send(input, dispatch(input, call), call)).toEqual({ result: { ok: false, error: "timeout" }, terminal: null });
    const controller = new AbortController(); call = prepared(input);
    const pending = send(input, dispatch(input, call), call, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 30)); controller.abort();
    expect(await pending).toEqual({ result: { ok: false, error: "network" }, terminal: null }); expect(bodies).toHaveLength(3);
  });
});
it("makes a key removed after preparation incapable of POST or terminal issuance", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies }) => {
    const input = item(), call = prepared(input), owned = dispatch(input, call); vi.stubEnv("ABCLLM_API_KEY", "");
    expect(await send(input, owned, call)).toEqual({ result: { ok: false, error: "no_key" }, terminal: null }); expect(bodies).toEqual([]);
  });
});
it("keeps invalid endpoint and descriptor data outside the fixed leaf contract", async () => {
  await server(async () => {
    const leaf = await vi.importActual<typeof import("@/lib/llm/search-verify-serving-contract")>("@/lib/llm/search-verify-serving-contract");
    for (const change of [{ endpoint: "not a URL" }, { endpoint: "http://user:pass@127.0.0.1/v1/chat/completions" },
      { endpoint: "http://127.0.0.1/v1/chat/completions?key=local-test-only" }, { totalTokenBound: 0 }, { extra: true }, { routeId: "crawl-tagline" }])
      expect(leaf.searchVerifyServingContractSchema.safeParse({ ...fixture.contract, ...change }).success).toBe(false);
    expect(leaf.searchVerifyServingContractHash(fixture.contract!)).toMatch(/^[a-f0-9]{64}$/);
  });
});
