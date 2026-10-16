import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewInput, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { ai1DispatchBindingHash, ai1ModelDispatchSchema } from "@/lib/llm/capacity";
import { prepareAi1GatewayCall, readAi1GatewayTerminal, reviewWithGateway, reviewWithReservedAi1Gateway,
  type PreparedAi1GatewayCall } from "@/lib/crawl/agent-review-gateway";
import type { Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";

const fixture = vi.hoisted(() => ({ contract: null as Ai1GatewayServingContract | null }));
vi.mock("@/lib/crawl/agent-review-serving-contract", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-serving-contract")>(),
  resolveAi1GatewayServingContract: () => fixture.contract,
}));
const model = "[MLX] original-model";
const outcome = { decision: "approve", reason: "A working task tracker is shown.", evidenceIds: ["product"], confidence: 0.86 };
function input() {
  const now = new Date("2026-10-16T00:00:00.000Z");
  return createReviewInput({ repo: "native/demo", productUrl: "https://demo.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "native/demo", productUrl: "https://demo.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "Demo", textSample: "<script>untrusted</script>" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
function envelope(overrides: Record<string, unknown> = {}) {
  return { id: "local-response", object: "chat.completion", created: 1, model: "native-model",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(outcome) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, usage_provenance: "upstream_reported", ...overrides };
}
function prepared(value: ReviewInput) {
  const call = prepareAi1GatewayCall(value, { model, timeoutMs: 1_000 });
  expect(call.kind).toBe("prepared");
  if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
  return call;
}
function dispatch(value: ReviewInput, call: PreparedAi1GatewayCall) {
  // Shape fixture only: actual persisted dispatch issuance/reconciliation is tested by the ledger owner.
  const binding = { kind: "ai1_legacy_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:1", candidateId: 1, attemptId: 2,
    inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, reviewPolicyHash: value.policyHash,
    promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
    provider: "abcllm" as const, model, routeId: "crawl-agent-review" as const, stageEpoch: 1,
    wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound,
    chargedTokens: call.totalTokenBound, job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 1 } };
  return ai1ModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: "local-test", bootId: randomUUID() },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64), binding, bindingHash: ai1DispatchBindingHash(binding) });
}
type Reply = (response: ServerResponse) => void;
async function server<T>(run: (state: { bodies: string[]; setReply: (reply: Reply) => void }) => Promise<T>) {
  const bodies: string[] = [], pending = new Set<Promise<void>>();
  let reply: Reply = response => response.end(JSON.stringify(envelope()));
  const http = createServer((request, response) => {
    const task = (async () => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      bodies.push(body);
      reply(response);
    })();
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  // A mocked, local fixed descriptor is not evidence of a deployed engine contract.
  fixture.contract = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm",
    model, responseModel: "native-model", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    deploymentRevision: "local-test-only", totalTokenBound: 8_000 };
  try { return await run({ bodies, setReply: value => { reply = value; } }); }
  finally {
    fixture.contract = null;
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled([...pending]);
    expect(http.listening).toBe(false);
  }
}
afterEach(() => { fixture.contract = null; vi.unstubAllEnvs(); });

it("production resolver stays unsupported and does not consume an injected callback", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  const original = await vi.importActual<typeof import("@/lib/crawl/agent-review-serving-contract")>("@/lib/crawl/agent-review-serving-contract");
  expect(original.resolveAi1GatewayServingContract(model)).toBeNull();
  expect(prepareAi1GatewayCall(input(), { model })).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
  expect(readAi1GatewayTerminal({ kind: "ai1_gateway_terminal" })).toBeNull();
});

it("sends one native POST with exactly the legacy wire and issues only an immutable original terminal", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ bodies }) => {
    const value = input(), call = prepared(value), owned = dispatch(value, call);
    let legacyWire = "";
    const request = vi.fn(async (_url, init) => { legacyWire = String(init?.body); return new Response(JSON.stringify(envelope())); });
    const legacy = await reviewWithGateway(value, { model, request: request as typeof fetch });
    const native = await reviewWithReservedAi1Gateway(value, owned, call);
    expect(native.result).toEqual(legacy);
    expect(bodies).toEqual([legacyWire]);
    expect(Object.isFrozen(call)).toBe(true);
    const proof = readAi1GatewayTerminal(native.terminal);
    expect(proof).toMatchObject({ dispatch: owned, finishReason: "stop", provenance: "upstream_reported",
      actualUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
    expect(Object.isFrozen(proof?.dispatch.binding.job)).toBe(true);
    expect(JSON.stringify(proof)).not.toContain("local-secret");
    expect(readAi1GatewayTerminal(structuredClone(native.terminal))).toBeNull();
    expect(readAi1GatewayTerminal(JSON.parse(JSON.stringify(native.terminal)))).toBeNull();
    expect(readAi1GatewayTerminal(legacy)).toBeNull();
  });
});

it.each(["length", "invalid-outcome"])("separates %s review failure from strict physical completion", async kind => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ setReply }) => {
    setReply(response => response.end(JSON.stringify(envelope({ choices: [{ index: 0, message: { role: "assistant",
      content: kind === "length" ? "unfinished" : "invalid judgment" }, finish_reason: kind === "length" ? "length" : "stop" }] }))));
    const value = input(), call = prepared(value);
    const result = await reviewWithReservedAi1Gateway(value, dispatch(value, call), call);
    expect(result.result).toMatchObject({ ok: false, error: kind === "length" ? "output_too_large" : "invalid_output" });
    expect(readAi1GatewayTerminal(result.terminal)?.finishReason).toBe(kind === "length" ? "length" : "stop");
  });
});

it.each([
  { usage_provenance: "gateway_estimated" }, { usage: undefined },
  { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 99 } },
  { usage: { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER + 1 } },
])("retains full charge with unknown usage instead of inventing actual usage: %j", async change => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ setReply }) => {
    setReply(response => response.end(JSON.stringify(envelope(change))));
    const value = input(), call = prepared(value);
    const result = await reviewWithReservedAi1Gateway(value, dispatch(value, call), call);
    expect(readAi1GatewayTerminal(result.terminal)).toMatchObject({ actualUsage: null, provenance: "unknown" });
  });
});

it.each([
  { model: "other-model" }, { choices: [] }, { error: { message: "upstream failure" } },
  { choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: null }] },
  { usage: { prompt_tokens: 8_000, completion_tokens: 1, total_tokens: 8_001 } },
])("rejects protocol/serving-bound violations without terminal proof: %j", async change => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ bodies, setReply }) => {
    setReply(response => response.end(JSON.stringify(envelope(change))));
    const value = input(), call = prepared(value);
    const result = await reviewWithReservedAi1Gateway(value, dispatch(value, call), call);
    expect(result).toMatchObject({ result: { ok: false, error: "invalid_output" }, terminal: null });
    expect(bodies).toHaveLength(1);
  });
});

it("rejects copied preparations, different inputs/bindings and repeats before any extra POST", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ bodies }) => {
    const value = input(), call = prepared(value), owned = dispatch(value, call);
    await expect(reviewWithReservedAi1Gateway(value, owned, { ...call })).rejects.toThrow("ai1_gateway_call_mismatch");
    const changed = structuredClone(value); changed.snapshot.product.description += " changed";
    await expect(reviewWithReservedAi1Gateway(changed, owned, call)).rejects.toThrow("ai1_gateway_call_mismatch");
    const wrong = { ...owned, binding: { ...owned.binding, wireHash: "b".repeat(64) } };
    await expect(reviewWithReservedAi1Gateway(value, wrong, call)).rejects.toThrow("ai1_gateway_call_mismatch");
    expect(bodies).toHaveLength(0);
    await reviewWithReservedAi1Gateway(value, owned, call);
    await expect(reviewWithReservedAi1Gateway(value, owned, call)).rejects.toThrow("ai1_gateway_call_mismatch");
    await expect(reviewWithReservedAi1Gateway(value, owned, prepared(value))).rejects.toThrow("ai1_gateway_call_mismatch");
    expect(bodies).toHaveLength(1);
  });
});

it.each(["http", "redirect", "eof", "json"])("keeps %s failures unknown and never retries", async kind => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ bodies, setReply }) => {
    setReply(response => {
      if (kind === "http") { response.statusCode = 502; response.end("failure"); }
      else if (kind === "redirect") { response.statusCode = 307; response.setHeader("Location", "/v1/chat/completions"); response.end(); }
      else if (kind === "eof") { response.writeHead(200, { "Content-Length": "1000" }); response.write("{"); response.socket?.destroy(); }
      else response.end("{");
    });
    const value = input(), call = prepared(value), owned = dispatch(value, call);
    const result = await reviewWithReservedAi1Gateway(value, owned, call);
    expect(result.terminal).toBeNull(); expect(result.result.ok).toBe(false);
    await expect(reviewWithReservedAi1Gateway(value, owned, call)).rejects.toThrow("ai1_gateway_call_mismatch");
    expect(bodies).toHaveLength(1);
  });
});

it("snapshots input/dispatch/contract before await and ignores global fetch injection", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ bodies }) => {
    const value = input(), call = prepared(value), owned = dispatch(value, call), originalDispatch = structuredClone(owned);
    const globalRequest = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("injected_request_not_allowed"));
    try {
      const result = reviewWithReservedAi1Gateway(value, owned, call);
      value.snapshot.product.description += " changed after entry";
      Object.assign(owned.binding, { wireHash: "b".repeat(64) });
      Object.assign(fixture.contract!, { endpoint: "http://127.0.0.1:1/v1/chat/completions" });
      const completed = await result;
      expect(completed.result.ok).toBe(true);
      expect(readAi1GatewayTerminal(completed.terminal)?.dispatch).toEqual(originalDispatch);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toContain("changed after entry");
      expect(globalRequest).not.toHaveBeenCalled();
    } finally { globalRequest.mockRestore(); }
  });
});

it("settles an actual aborted native request without proof or retry", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ bodies, setReply }) => {
    let arrived!: () => void;
    const accepted = new Promise<void>(resolve => { arrived = resolve; });
    setReply(() => arrived());
    const value = input(), call = prepared(value), owned = dispatch(value, call), controller = new AbortController();
    const running = reviewWithReservedAi1Gateway(value, owned, call, { signal: controller.signal });
    try {
      await Promise.race([accepted, running.then(() => { throw new Error("native_finished_before_request"); })]);
      controller.abort();
      expect(await running).toEqual({ result: { ok: false, error: "cancelled" }, terminal: null });
    } finally { controller.abort(); await Promise.allSettled([running]); }
    await expect(reviewWithReservedAi1Gateway(value, owned, call)).rejects.toThrow("ai1_gateway_call_mismatch");
    expect(bodies).toHaveLength(1);
  });
});


// AI1 item additions: the original legacy driver above stays byte exact.
import { ai1ItemDispatchBindingHash, ai1ItemModelDispatchSchema,
  type Ai1ItemModelDispatch } from "@/lib/llm/capacity";
import { itemBindingHash, type Ai1ItemBinding } from "@/lib/jobs/items/types";
import { readAi1ItemGatewayTerminal, reviewWithReservedAi1ItemGateway,
  readAi2GatewayTerminal } from "@/lib/crawl/agent-review-gateway";

function itemDispatch(value: ReviewInput, call: PreparedAi1GatewayCall, handle = dispatch(value, call)) {
  // Shape only; the ledger/domain lanes prove actual persisted attempt+item authority.
  const review: Ai1ItemBinding = { stage: "ai1", candidateId: 1, inputHash: value.inputHash,
    sourceRevisionHash: value.sourceRevisionHash, policyHash: value.policyHash,
    promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
    reviewer: { provider: "abcllm", model } };
  const binding = { kind: "ai1_item_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:1", attemptId: 2,
    review, item: { workKey: "ai1:1", owner: handle.owner, token: randomUUID(), stageEpoch: 1, itemEpoch: 1,
      bindingHash: itemBindingHash(review) }, routeId: "crawl-agent-review" as const, provider: "abcllm" as const,
    model, wireHash: call.wireHash, servingContractHash: call.servingContractHash,
    totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound };
  return ai1ItemModelDispatchSchema.parse({ requestId: handle.requestId, owner: handle.owner, token: handle.token,
    epoch: handle.epoch, revision: handle.revision, policyHash: handle.policyHash, binding,
    bindingHash: ai1ItemDispatchBindingHash(binding) });
}
async function itemServer(run: (state: { bodies: string[]; setReply: (value: Reply) => void;
  track: <T>(promise: Promise<T>) => Promise<T> }) => Promise<void>) {
  const bodies: string[] = [], tasks = new Set<Promise<unknown>>(), calls = new Set<Promise<unknown>>();
  let reply: Reply = response => response.end(JSON.stringify(envelope()));
  const http = createServer((request, response) => {
    const closed = new Promise<void>(resolve => response.once("close", resolve));
    const task = (async () => {
      let body = ""; for await (const chunk of request) body += chunk.toString(); bodies.push(body);
      reply(response); await closed;
    })();
    tasks.add(task); void task.catch(() => {});
  });
  const track = <T>(promise: Promise<T>) => { calls.add(promise); void promise.catch(() => {}); return promise; };
  const errors: unknown[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error); http.once("error", failed);
      http.listen(0, "127.0.0.1", () => { http.off("error", failed); resolve(); });
    });
    const address = http.address(); if (!address || typeof address === "string") throw new Error("item_fixture_address");
    fixture.contract = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm",
      model, responseModel: "native-model", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      deploymentRevision: "item-local-test-only", totalTokenBound: 8_000 };
    await run({ bodies, setReply: value => { reply = value; }, track });
  } catch (error) { errors.push(error); }
  finally {
    await Promise.allSettled([...calls]);
    const closing = http.listening ? new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    void closing.catch(() => {});
    for (const result of await Promise.allSettled([...tasks, closing])) if (result.status === "rejected") errors.push(result.reason);
    fixture.contract = null;
    expect(http.listening).toBe(false);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "item_native_fixture_failed", { cause: errors[0] });
}

it("AI1 item native: production remains unsupported and shape/JSON has no terminal authority", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  const original = await vi.importActual<typeof import("@/lib/crawl/agent-review-serving-contract")>("@/lib/crawl/agent-review-serving-contract");
  expect(original.resolveAi1GatewayServingContract(model)).toBeNull();
  expect(prepareAi1GatewayCall(input(), { model }).kind).toBe("unsupported");
  expect(readAi1ItemGatewayTerminal({ kind: "ai1_item_gateway_terminal" })).toBeNull();
  expect(readAi1ItemGatewayTerminal({ kind: "ai1_gateway_terminal" })).toBeNull();
  expect(readAi1ItemGatewayTerminal({ kind: "ai2_gateway_terminal" })).toBeNull();
});

it("AI1 item native: sends one exact original wire and issues a separate immutable item terminal", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await itemServer(async ({ bodies, track }) => {
    const value = input(), originalInput = JSON.stringify(value), call = prepared(value), owned = itemDispatch(value, call);
    let legacyWire = "";
    const request = vi.fn(async (_url, init) => { legacyWire = String(init?.body); return new Response(JSON.stringify(envelope())); });
    const legacy = await reviewWithGateway(value, { model, request: request as typeof fetch });
    const actual = await track(reviewWithReservedAi1ItemGateway(value, owned, call));
    expect(actual.result).toEqual(legacy); expect(bodies).toEqual([legacyWire]);
    expect(JSON.stringify(value)).toBe(originalInput);
    const proof = readAi1ItemGatewayTerminal(actual.terminal);
    expect(proof).toMatchObject({ kind: "ai1_item_gateway_terminal", dispatch: owned, finishReason: "stop",
      actualUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, provenance: "upstream_reported" });
    expect(Object.isFrozen(proof?.dispatch.binding.item.owner)).toBe(true);
    expect(JSON.stringify(proof)).not.toContain("local-secret");
    expect(readAi1GatewayTerminal(actual.terminal)).toBeNull(); expect(readAi2GatewayTerminal(actual.terminal)).toBeNull();
    expect(readAi1ItemGatewayTerminal(structuredClone(actual.terminal))).toBeNull();
    expect(readAi1ItemGatewayTerminal(JSON.parse(JSON.stringify(actual.terminal)))).toBeNull();
    expect(readAi1ItemGatewayTerminal(legacy)).toBeNull(); expect(request).toHaveBeenCalledOnce();
  });
});

it.each(["length", "invalid-outcome"])("AI1 item native: %s can finish physically without passing original review quality", async kind => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await itemServer(async ({ setReply, track, bodies }) => {
    setReply(response => response.end(JSON.stringify(envelope({ choices: [{ index: 0, message: { role: "assistant",
      content: kind === "length" ? "unfinished" : "invalid judgment" }, finish_reason: kind === "length" ? "length" : "stop" }] }))));
    const value = input(), call = prepared(value);
    const result = await track(reviewWithReservedAi1ItemGateway(value, itemDispatch(value, call), call));
    expect(result.result).toMatchObject({ ok: false, error: kind === "length" ? "output_too_large" : "invalid_output" });
    expect(readAi1ItemGatewayTerminal(result.terminal)?.finishReason).toBe(kind === "length" ? "length" : "stop");
    expect(bodies).toHaveLength(1);
  });
});

it.each([{ usage_provenance: "gateway_estimated" }, { usage: undefined },
  { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 9 } },
])("AI1 item native: uncertain usage retains nullable usage and the original full bound: %j", async change => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await itemServer(async ({ setReply, track }) => {
    setReply(response => response.end(JSON.stringify(envelope(change))));
    const value = input(), call = prepared(value);
    const actual = await track(reviewWithReservedAi1ItemGateway(value, itemDispatch(value, call), call));
    expect(readAi1ItemGatewayTerminal(actual.terminal)).toMatchObject({ actualUsage: null, provenance: "unknown",
      dispatch: { binding: { totalTokenBound: 8_000, chargedTokens: 8_000 } } });
  });
});

it.each([{ model: "other-model" }, { choices: [] },
  { usage: { prompt_tokens: 8_000, completion_tokens: 1, total_tokens: 8_001 } },
])("AI1 item native: strict protocol or bound violation issues no terminal: %j", async change => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await itemServer(async ({ bodies, setReply, track }) => {
    setReply(response => response.end(JSON.stringify(envelope(change))));
    const value = input(), call = prepared(value);
    expect(await track(reviewWithReservedAi1ItemGateway(value, itemDispatch(value, call), call)))
      .toMatchObject({ result: { ok: false, error: "invalid_output" }, terminal: null });
    expect(bodies).toHaveLength(1);
  });
});

it.each(["http", "redirect", "eof"])("AI1 item native: %s remains unknown with POST1 and no repeat", async kind => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await itemServer(async ({ setReply, bodies, track }) => {
    setReply(response => {
      if (kind === "http") { response.statusCode = 502; response.end("failure"); }
      else if (kind === "redirect") { response.statusCode = 307; response.setHeader("Location", "/v1/chat/completions"); response.end(); }
      else { response.writeHead(200, { "Content-Length": "1000" }); response.write("{"); response.socket?.destroy(); }
    });
    const value = input(), call = prepared(value), owned = itemDispatch(value, call);
    const result = await track(reviewWithReservedAi1ItemGateway(value, owned, call));
    expect(result.result.ok).toBe(false); expect(result.terminal).toBeNull();
    await expect(track(reviewWithReservedAi1ItemGateway(value, owned, call))).rejects.toThrow("ai1_item_gateway_call_mismatch");
    expect(bodies).toHaveLength(1);
  });
});

it.each(["item", "legacy"])("AI1 item native: shares prepared and request one-use when %s sends first", async first => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await itemServer(async ({ track, bodies }) => {
    const value = input(), call = prepared(value), old = dispatch(value, call), owned = itemDispatch(value, call, old);
    if (first === "item") {
      await track(reviewWithReservedAi1ItemGateway(value, owned, call));
      await expect(track(reviewWithReservedAi1Gateway(value, old, call))).rejects.toThrow("ai1_gateway_call_mismatch");
      await expect(track(reviewWithReservedAi1Gateway(value, old, prepared(value)))).rejects.toThrow("ai1_gateway_call_mismatch");
    } else {
      const actual = await track(reviewWithReservedAi1Gateway(value, old, call));
      expect(readAi1ItemGatewayTerminal(actual.terminal)).toBeNull();
      await expect(track(reviewWithReservedAi1ItemGateway(value, owned, call))).rejects.toThrow("ai1_item_gateway_call_mismatch");
      await expect(track(reviewWithReservedAi1ItemGateway(value, owned, prepared(value)))).rejects.toThrow("ai1_item_gateway_call_mismatch");
    }
    expect(bodies).toHaveLength(1);
  });
});

it("AI1 item native: rejects copied calls, changed full input or semantic binding and foreign dispatch before POST", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await itemServer(async ({ track, bodies }) => {
    const value = input(), call = prepared(value), owned = itemDispatch(value, call);
    await expect(track(reviewWithReservedAi1ItemGateway(value, owned, { ...call }))).rejects.toThrow("ai1_item_gateway_call_mismatch");
    const changed = structuredClone(value); changed.source.productUrl = "https://changed.example";
    await expect(track(reviewWithReservedAi1ItemGateway(changed, owned, call))).rejects.toThrow("ai1_item_gateway_call_mismatch");
    const policyBinding = { ...owned.binding, review: { ...owned.binding.review, policyHash: "b".repeat(64) } };
    policyBinding.item = { ...policyBinding.item, bindingHash: itemBindingHash(policyBinding.review) };
    const wrong = ai1ItemModelDispatchSchema.parse({ ...owned, binding: policyBinding, bindingHash: ai1ItemDispatchBindingHash(policyBinding) });
    await expect(track(reviewWithReservedAi1ItemGateway(value, wrong, call))).rejects.toThrow("ai1_item_gateway_call_mismatch");
    await expect(track(reviewWithReservedAi1ItemGateway(value, dispatch(value, call) as unknown as Ai1ItemModelDispatch, call)))
      .rejects.toThrow("ai1_item_gateway_call_mismatch");
    expect(bodies).toHaveLength(0);
    expect((await track(reviewWithReservedAi1ItemGateway(value, owned, call))).result.ok).toBe(true);
    expect(bodies).toHaveLength(1);
  });
});

it("AI1 item native: snapshots full input, item owner and fixed contract before await", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await itemServer(async ({ track, bodies }) => {
    const value = input(), call = prepared(value), owned = itemDispatch(value, call), original = structuredClone(owned);
    const injected = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("injected_native_request"));
    let running: Promise<unknown> | undefined;
    try {
      running = track(reviewWithReservedAi1ItemGateway(value, owned, call));
      value.snapshot.product.description += " changed after entry"; Object.assign(owned.binding.item.owner, { instanceId: "changed" });
      Object.assign(fixture.contract!, { endpoint: "http://127.0.0.1:1/v1/chat/completions" });
      const actual = await running as Awaited<ReturnType<typeof reviewWithReservedAi1ItemGateway>>;
      expect(actual.result.ok).toBe(true); expect(readAi1ItemGatewayTerminal(actual.terminal)?.dispatch).toEqual(original);
      expect(bodies).toHaveLength(1); expect(bodies[0]).not.toContain("changed after entry"); expect(injected).not.toHaveBeenCalled();
    } finally { await Promise.allSettled(running ? [running] : []); injected.mockRestore(); }
  });
});

it("AI1 item native: actual caller abort drains its request but supplies no terminal or second send", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await itemServer(async ({ setReply, bodies, track }) => {
    let arrived!: () => void; const received = new Promise<void>(resolve => { arrived = resolve; });
    setReply(() => arrived());
    const value = input(), call = prepared(value), owned = itemDispatch(value, call), abort = new AbortController();
    const running = track(reviewWithReservedAi1ItemGateway(value, owned, call, { signal: abort.signal }));
    try {
      await Promise.race([received, running.then(() => { throw new Error("item_native_finished_before_request"); })]);
      abort.abort(); expect(await running).toEqual({ result: { ok: false, error: "cancelled" }, terminal: null });
    } finally { abort.abort(); await Promise.allSettled([running]); }
    await expect(track(reviewWithReservedAi1ItemGateway(value, owned, call))).rejects.toThrow("ai1_item_gateway_call_mismatch");
    expect(bodies).toHaveLength(1);
  });
});
