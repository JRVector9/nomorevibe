import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { TRANSLATE_MODEL, parseQueryTranslation, textHash, translateChineseQueryToEnglish, translateQueryToEnglish,
  websearchQueryGatewayWire, type WebsearchQueryGatewayInput } from "@/lib/crawl/translate";
import { websearchQueryLogicalWorkKey, websearchQueryInputHash, websearchQueryDispatchBindingHash, websearchQueryModelDispatchSchema,
  type WebsearchQueryInput } from "@/lib/llm/capacity";
import { prepareWebsearchQueryGatewayCall, translateQueryWithReservedGateway, readWebsearchQueryGatewayTerminal,
  readCrawlTaglineGatewayTerminal, type PreparedWebsearchQueryGatewayCall } from "@/lib/crawl/agent-review-gateway";
import type { WebsearchQueryServingContract } from "@/lib/llm/websearch-query-serving-contract";

const fixture = vi.hoisted(() => ({ contract: null as WebsearchQueryServingContract | null }));
vi.mock("@/lib/llm/websearch-query-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/websearch-query-serving-contract")>(), resolveWebsearchQueryServingContract: () => fixture.contract,
}));
vi.mock("@/lib/llm/text-capacity-admission", () => ({ assertTextModelAdmission: vi.fn() }));
const model = TRANSLATE_MODEL, requests = new Set<Promise<unknown>>();
const korean: WebsearchQueryGatewayInput = { sourceLocale: "ko", query: "헬스장 출석 체크" };
const content = "Gym attendance | gym attendance check-in app";
function envelope(change: Record<string, unknown> = {}) {
  return { id: "query-local", object: "chat.completion", created: 1, model: "served-query",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 }, usage_provenance: "upstream_reported", ...change };
}
/** The legacy leaf's actual bytes, captured through its own injected request. */
async function legacyWire(input: WebsearchQueryGatewayInput): Promise<string> {
  let wire = "";
  const request = (async (_url: unknown, init?: RequestInit) => { wire = String(init?.body); return new Response(JSON.stringify(envelope())); }) as typeof fetch;
  if (input.sourceLocale === "ko") await translateQueryToEnglish(input.query, 1000, request);
  else await translateChineseQueryToEnglish(input.query, input.sourceLocale, 1000, request);
  return wire;
}
function prepared(input: WebsearchQueryGatewayInput, timeoutMs = 1000) {
  const call = prepareWebsearchQueryGatewayCall(input, { model, timeoutMs });
  expect(call.kind).toBe("prepared"); if (call.kind !== "prepared") throw new Error("fixture_not_prepared"); return call;
}
function dispatch(input: WebsearchQueryGatewayInput, call: PreparedWebsearchQueryGatewayCall) {
  // Native shape-only fixture; actual cache/ledger authority belongs to ledger and runtime tests.
  const value: WebsearchQueryInput = { model, member: { cacheKey: "e".repeat(64), sourceLocale: input.sourceLocale, queryHash: textHash(input.query),
    promptVersion: 2, glossaryVersion: input.sourceLocale === "ko" ? 1 : null, cache: { kind: "absent" } } };
  const process = { instanceId: "web-native-unit", bootId: randomUUID(), release: "local-only" };
  const binding = { ...value, kind: "websearch_query_gateway" as const, version: 1 as const, logicalWorkKey: websearchQueryLogicalWorkKey(value.member),
    inputHash: websearchQueryInputHash(value), provider: "abcllm" as const, routeId: "search-query-translate" as const, wireHash: call.wireHash,
    servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, process };
  return websearchQueryModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: process.instanceId, bootId: process.bootId },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64), binding, bindingHash: websearchQueryDispatchBindingHash(binding) });
}
function send(...args: Parameters<typeof translateQueryWithReservedGateway>) {
  const pending = translateQueryWithReservedGateway(...args); requests.add(pending); void pending.catch(() => {}); return pending;
}
async function server(run: (state: { bodies: string[]; reply: (next: (response: ServerResponse) => void) => void }) => Promise<void>) {
  const bodies: string[] = [], responses = new Set<Promise<void>>(), errors: unknown[] = [];
  let reply = (response: ServerResponse) => { response.end(JSON.stringify(envelope())); };
  const http = createServer((request, response) => {
    const closed = new Promise<void>(resolve => response.once("close", resolve));
    const pending = (async () => { let body = ""; for await (const part of request) body += part.toString(); bodies.push(body); reply(response); await closed; })();
    responses.add(pending); void pending.catch(() => {});
  });
  let failed = false, original: unknown, watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
    fixture.contract = { version: 1, protocol: "abcllm-websearch-query-total-bound-v1", routeId: "search-query-translate", provider: "abcllm",
      model, responseModel: "served-query", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, deploymentRevision: "local-only", totalTokenBound: 4096 };
    watchdog = setTimeout(() => { errors.push(new Error("fixture_forced_close")); http.closeAllConnections(); }, 2000);
    await run({ bodies, reply: next => { reply = next; } });
  } catch (error) { failed = true; original = error; }
  finally {
    fixture.contract = null;
    try {
      while (requests.size) { const pending = [...requests]; await Promise.allSettled(pending); for (const promise of pending) requests.delete(promise); }
      const close = http.listening ? new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) : Promise.resolve();
      for (const result of await Promise.allSettled([close, ...responses])) if (result.status === "rejected") errors.push(result.reason);
    } finally { clearTimeout(watchdog); }
  }
  if (failed && errors.length) throw new AggregateError([original, ...errors], "native_fixture_failed", { cause: original });
  if (failed) throw original; if (errors.length) throw new AggregateError(errors);
}
afterEach(() => { fixture.contract = null; vi.unstubAllEnvs(); });

it.each([korean, { sourceLocale: "zh-Hans", query: "代码编辑器" }, { sourceLocale: "zh-Hant", query: "程式碼編輯器" }] as const)
  ("sends the original legacy query bytes once and issues an immutable parsed outcome: %j", async input => {
    vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies }) => {
      const call = prepared(input), owned = dispatch(input, call), response = await send(input, owned, call);
      expect(response.result).toEqual({ ok: true, keywords: "gym attendance | gym attendance check in app" });
      expect(bodies).toEqual([await legacyWire(input)]); expect(bodies[0]).toBe(websearchQueryGatewayWire(input, model));
      const wire = JSON.parse(bodies[0]);
      expect(Object.keys(wire)).toEqual(["model", "stream", "temperature", "reasoning_effort", "max_tokens", "messages"]);
      expect(wire).toMatchObject({ model, stream: false, temperature: 0, reasoning_effort: "low", max_tokens: 200 });
      expect(wire.messages[1].content).toBe(input.sourceLocale === "ko" ? `${input.query}\nIn Korean: '헬스장' means a gym.`
        : JSON.stringify({ sourceLocale: input.sourceLocale, query: input.query }));
      const proof = readWebsearchQueryGatewayTerminal(response.terminal);
      expect(proof).toMatchObject({ dispatch: owned, finishReason: "stop", outcome: response.result,
        actualUsage: { inputTokens: 80, outputTokens: 12, totalTokens: 92 }, provenance: "upstream_reported" });
      expect(Object.isFrozen(proof?.outcome)).toBe(true); expect(JSON.stringify(proof)).not.toContain(input.query);
    });
  });
it("keeps production unsupported without caller-enabled terminal authority", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only");
  const leaf = await vi.importActual<typeof import("@/lib/llm/websearch-query-serving-contract")>("@/lib/llm/websearch-query-serving-contract");
  expect(leaf.resolveWebsearchQueryServingContract(model)).toBeNull();
  expect(prepareWebsearchQueryGatewayCall(korean, { model, timeoutMs: 1000 })).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
  expect(readWebsearchQueryGatewayTerminal({ kind: "websearch_query_gateway_terminal" })).toBeNull();
  await server(async ({ bodies }) => {
    for (const input of [{ ...korean, extra: true }, { ...korean, query: " padded " }, { ...korean, query: "" }, { ...korean, sourceLocale: "ja" }])
      expect(prepareWebsearchQueryGatewayCall(input as unknown as WebsearchQueryGatewayInput, { model, timeoutMs: 1000 }).kind).toBe("unsupported");
    vi.stubEnv("ABCLLM_API_KEY", "");
    expect(prepareWebsearchQueryGatewayCall(korean, { model, timeoutMs: 1000 }).kind).toBe("unsupported"); expect(bodies).toEqual([]);
  });
});
it.each([[404, "http_404"], [429, "rate_limit"], [500, "http_500"], [307, "http_307"]] as const)
  ("performs one physical POST for HTTP %i with the original query error name and no redirect/retry", async (status, error) => {
    vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies, reply }) => {
      reply(response => { response.statusCode = status; response.setHeader("Location", "/v1/chat/completions"); response.end("failure"); });
      const call = prepared(korean);
      expect(await send(korean, dispatch(korean, call), call)).toEqual({ result: { ok: false, error }, terminal: null });
      expect(bodies).toHaveLength(1);
    });
  });
it("keeps outer JSON decoding failure as the original network error, not a content parser failure", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies, reply }) => {
    reply(response => response.end("not JSON"));
    const call = prepared(korean);
    expect(await send(korean, dispatch(korean, call), call)).toEqual({ result: { ok: false, error: "network" }, terminal: null });
    expect(bodies).toHaveLength(1);
  });
});
it.each(["", "아무 말", "!!! | ???", "<think>x</think>\n\n merge pdf | merge pdf"])
  ("keeps the original content parser and stores only its bounded outcome as a physical terminal: %j", async text => {
    vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ reply }) => {
      reply(response => response.end(JSON.stringify(envelope({ choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }))));
      const call = prepared(korean), response = await send(korean, dispatch(korean, call), call), parsed = parseQueryTranslation(text);
      expect(response.result).toEqual(parsed ? { ok: true, keywords: parsed } : { ok: false, error: "invalid_output" });
      expect(readWebsearchQueryGatewayTerminal(response.terminal)?.outcome).toEqual(response.result);
    });
  });
it.each([{ usage: { prompt_tokens: 4096, completion_tokens: 1, total_tokens: 4097 } }, { model: "wrong" },
  { choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: null }] }, { object: "list" }])
  ("refuses contradictory native terminal metadata without terminal authority: %j", async change => {
    vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies, reply }) => {
      reply(response => response.end(JSON.stringify(envelope(change)))); const call = prepared(korean);
      expect(await send(korean, dispatch(korean, call), call)).toEqual({ result: { ok: false, error: "invalid_output" }, terminal: null });
      expect(bodies).toHaveLength(1);
    });
  });
it.each([{ usage: null }, { usage_provenance: "gateway_estimated" }])("keeps full C when counters have no verified provenance: %j", async change => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ reply }) => {
    reply(response => response.end(JSON.stringify(envelope(change)))); const call = prepared(korean);
    const response = await send(korean, dispatch(korean, call), call);
    expect(readWebsearchQueryGatewayTerminal(response.terminal)).toMatchObject({ actualUsage: null, provenance: "unknown",
      dispatch: { binding: { chargedTokens: 4096 } } });
  });
});
it("leaves truncated HTTP EOF and a pending-body timeout without terminal authority", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies, reply }) => {
    reply(response => { response.writeHead(200, { "Content-Length": "1000" }); response.write("{"); response.socket?.destroy(); });
    const first = prepared(korean);
    expect(await send(korean, dispatch(korean, first), first)).toEqual({ result: { ok: false, error: "network" }, terminal: null });
    reply(response => { response.writeHead(200); response.flushHeaders(); });
    const second = prepared(korean, 80);
    expect(await send(korean, dispatch(korean, second), second)).toEqual({ result: { ok: false, error: "timeout" }, terminal: null });
    expect(bodies).toHaveLength(2);
  });
});
it("rejects copied preparation, changed query bytes, locale or reuse before POST and keeps proof private", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies }) => {
    const call = prepared(korean), owned = dispatch(korean, call);
    await expect(send(korean, owned, { ...call })).rejects.toThrow("websearch_query_gateway_call_mismatch");
    for (const changed of [{ ...korean, query: "헬스장 출석" }, { ...korean, query: "헬스장  출석 체크" }, { sourceLocale: "zh-Hans", query: korean.query }])
      await expect(send(changed as WebsearchQueryGatewayInput, owned, call)).rejects.toThrow("websearch_query_gateway_call_mismatch");
    const other = dispatch({ ...korean, query: "헬스장 출석" }, call);
    await expect(send(korean, other, call)).rejects.toThrow("websearch_query_gateway_call_mismatch");
    expect(bodies).toEqual([]);
    const original = structuredClone(owned), pending = send(korean, owned, call); (owned as { requestId: string }).requestId = randomUUID();
    const response = await pending, proof = readWebsearchQueryGatewayTerminal(response.terminal);
    expect(proof?.dispatch).toEqual(original);
    expect(readWebsearchQueryGatewayTerminal(structuredClone(response.terminal))).toBeNull();
    expect(readWebsearchQueryGatewayTerminal(JSON.parse(JSON.stringify(proof)))).toBeNull();
    expect(readCrawlTaglineGatewayTerminal(response.terminal)).toBeNull();
    await expect(send(korean, original, call)).rejects.toThrow("websearch_query_gateway_call_mismatch");
    await expect(send(korean, original, prepared(korean))).rejects.toThrow("websearch_query_gateway_call_mismatch");
    expect(bodies).toHaveLength(1); expect(JSON.stringify(proof)).not.toContain("local-test-only");
  });
});
it("makes a key removed after preparation incapable of POST or terminal issuance", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only"); await server(async ({ bodies }) => {
    const call = prepared(korean), owned = dispatch(korean, call); vi.stubEnv("ABCLLM_API_KEY", "");
    expect(await send(korean, owned, call)).toEqual({ result: { ok: false, error: "no_key" }, terminal: null }); expect(bodies).toEqual([]);
  });
});
it("keeps invalid endpoint and descriptor data outside the fixed leaf contract", async () => {
  await server(async () => {
    const leaf = await vi.importActual<typeof import("@/lib/llm/websearch-query-serving-contract")>("@/lib/llm/websearch-query-serving-contract");
    for (const change of [{ endpoint: "not a URL" }, { endpoint: "http://user:pass@127.0.0.1/v1/chat/completions" },
      { endpoint: "http://127.0.0.1/v1/chat/completions?key=local-test-only" }, { totalTokenBound: 0 }, { extra: true },
      { protocol: "abcllm-crawl-tagline-total-bound-v1" }, { routeId: "crawl-tagline" }])
      expect(leaf.websearchQueryServingContractSchema.safeParse({ ...fixture.contract, ...change }).success).toBe(false);
    expect(leaf.websearchQueryServingContractHash(fixture.contract!)).toMatch(/^[a-f0-9]{64}$/);
  });
});
