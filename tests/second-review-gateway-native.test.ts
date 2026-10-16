import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewInput, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { itemBindingHash, type Ai2ItemBinding } from "@/lib/jobs/items/types";
import { ai1DispatchBindingHash, ai1ModelDispatchSchema, ai2DispatchBindingHash, ai2ModelDispatchSchema } from "@/lib/llm/capacity";
import { prepareAi1GatewayCall, readAi1GatewayTerminal, reviewWithReservedAi1Gateway, prepareAi2GatewayCall, readAi2GatewayTerminal, reviewWithGateway, reviewWithReservedAi2Gateway,
  type PreparedAi2GatewayCall } from "@/lib/crawl/agent-review-gateway";
import type { Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import type { Ai2GatewayServingContract } from "@/lib/crawl/second-review-serving-contract";

const fixture = vi.hoisted(() => ({ contract: null as Ai2GatewayServingContract | null, ai1Contract: null as Ai1GatewayServingContract | null }));
vi.mock("@/lib/crawl/second-review-serving-contract", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/second-review-serving-contract")>(),
  resolveAi2GatewayServingContract: () => fixture.contract,
}));
vi.mock("@/lib/crawl/agent-review-serving-contract", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-serving-contract")>(),
  resolveAi1GatewayServingContract: () => fixture.ai1Contract,
}));
const requests = new Set<Promise<unknown>>();
function sendNative(...args: Parameters<typeof reviewWithReservedAi2Gateway>) {
  const pending = reviewWithReservedAi2Gateway(...args);
  requests.add(pending);
  void pending.catch(() => {});
  return pending;
}
const model = "[MLX] AI2 original-model";
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
  const call = prepareAi2GatewayCall(value, { model, timeoutMs: 1_000 });
  expect(call.kind).toBe("prepared");
  if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
  return call;
}
function dispatch(value: ReviewInput, call: PreparedAi2GatewayCall) {
  // Shape fixture only: actual persisted dispatch issuance/reconciliation is tested by the ledger owner.
  const owner = { instanceId: "local-test", bootId: randomUUID() };
  const review: Ai2ItemBinding = { stage: "ai2", candidateId: 1, secondReviewId: 3, vote: 3, fallbackForId: null,
    inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash,
    policyHash: "b".repeat(64), generationKey: "c".repeat(64),
    source: { kind: "first_attempt", firstAttemptId: 2 },
    promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
    reviewer: { provider: "abcllm", model } };
  const binding = { kind: "ai2_item_gateway" as const, version: 1 as const, logicalWorkKey: "ai2:1:3", review,
    rowIdentityHash: "d".repeat(64), failureCount: 0, inputPolicyHash: value.policyHash,
    item: { workKey: "ai2:3", owner, token: randomUUID(), stageEpoch: 1, itemEpoch: 1, bindingHash: itemBindingHash(review) },
    provider: "abcllm" as const, model, routeId: "second-review" as const,
    wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound,
    chargedTokens: call.totalTokenBound };
  return ai2ModelDispatchSchema.parse({ requestId: randomUUID(), owner,
    token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64), binding, bindingHash: ai2DispatchBindingHash(binding) });
}
type Reply = (response: ServerResponse) => void;
async function server<T>(run: (state: { bodies: string[]; setReply: (reply: Reply) => void }) => Promise<T>) {
  const bodies: string[] = [], pending = new Set<Promise<void>>(), cleanupErrors: unknown[] = [];
  let reply: Reply = response => response.end(JSON.stringify(envelope()));
  const http = createServer((request, response) => {
    const closed = new Promise<void>(resolve => response.once("close", resolve));
    const task = (async () => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      bodies.push(body);
      reply(response);
      await closed;
    })();
    pending.add(task);
    void task.catch(() => {});
  });
  let bodyError: unknown, bodyFailed = false, value: T | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      http.once("error", failed);
      http.listen(0, "127.0.0.1", () => { http.off("error", failed); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("fixture_address");
    // This test allowlist mock is not evidence of an actual deployed serving bound.
    fixture.contract = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "second-review", provider: "abcllm",
      model, responseModel: "native-model", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      deploymentRevision: "local-test-only", totalTokenBound: 8_000 };
    fixture.ai1Contract = { ...fixture.contract, routeId: "crawl-agent-review" };
    value = await run({ bodies, setReply: next => { reply = next; } });
  } catch (error) { bodyFailed = true; bodyError = error; }
  finally {
    fixture.contract = null; fixture.ai1Contract = null;
    let forced = false;
    const watchdog = setTimeout(() => { forced = true; http.closeAllConnections(); }, 2000);
    try {
      await Promise.allSettled([...requests]);
      requests.clear();
      const closed = http.listening
        ? new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) : Promise.resolve();
      for (const result of await Promise.allSettled([closed, ...pending])) {
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      }
      if (forced) cleanupErrors.push(new Error("fixture_forced_socket_cleanup"));
      if (http.listening) cleanupErrors.push(new Error("fixture_server_still_listening"));
    } catch (error) { cleanupErrors.push(error); }
    finally { clearTimeout(watchdog); }
  }
  if (bodyFailed && cleanupErrors.length) throw new AggregateError([bodyError, ...cleanupErrors]);
  if (bodyFailed) throw bodyError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors);
  return value as T;
}
afterEach(() => { fixture.contract = null; fixture.ai1Contract = null; vi.unstubAllEnvs(); });

it("keeps the production second-review resolver unsupported", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  const original = await vi.importActual<typeof import("@/lib/crawl/second-review-serving-contract")>("@/lib/crawl/second-review-serving-contract");
  expect(original.resolveAi2GatewayServingContract(model)).toBeNull();
  expect(prepareAi2GatewayCall(input(), { model })).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
  expect(readAi2GatewayTerminal({ kind: "ai2_gateway_terminal" })).toBeNull();
});

it("sends one native POST with exactly the legacy wire and issues only an immutable original terminal", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ bodies }) => {
    const value = input(), call = prepared(value), owned = dispatch(value, call);
    let legacyWire = "";
    const request = vi.fn(async (_url, init) => { legacyWire = String(init?.body); return new Response(JSON.stringify(envelope())); });
    const legacy = await reviewWithGateway(value, { model, request: request as typeof fetch });
    const native = await sendNative(value, owned, call);
    expect(native.result).toEqual(legacy);
    expect(bodies).toEqual([legacyWire]);
    expect(Object.isFrozen(call)).toBe(true);
    const proof = readAi2GatewayTerminal(native.terminal);
    expect(proof).toMatchObject({ dispatch: owned, finishReason: "stop", provenance: "upstream_reported",
      actualUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
    expect(Object.isFrozen(proof?.dispatch.binding.item.owner)).toBe(true);
    expect(JSON.stringify(proof)).not.toContain("local-secret");
    expect(readAi2GatewayTerminal(structuredClone(native.terminal))).toBeNull();
    expect(readAi2GatewayTerminal(JSON.parse(JSON.stringify(native.terminal)))).toBeNull();
    expect(readAi2GatewayTerminal(legacy)).toBeNull();
  });
});

it.each(["length", "invalid-outcome"])("separates %s review failure from strict physical completion", async kind => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ setReply }) => {
    setReply(response => response.end(JSON.stringify(envelope({ choices: [{ index: 0, message: { role: "assistant",
      content: kind === "length" ? "unfinished" : "invalid judgment" }, finish_reason: kind === "length" ? "length" : "stop" }] }))));
    const value = input(), call = prepared(value);
    const result = await sendNative(value, dispatch(value, call), call);
    expect(result.result).toMatchObject({ ok: false, error: kind === "length" ? "output_too_large" : "invalid_output" });
    expect(readAi2GatewayTerminal(result.terminal)?.finishReason).toBe(kind === "length" ? "length" : "stop");
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
    const result = await sendNative(value, dispatch(value, call), call);
    expect(readAi2GatewayTerminal(result.terminal)).toMatchObject({ actualUsage: null, provenance: "unknown" });
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
    const result = await sendNative(value, dispatch(value, call), call);
    expect(result).toMatchObject({ result: { ok: false, error: "invalid_output" }, terminal: null });
    expect(bodies).toHaveLength(1);
  });
});

it("rejects copied preparations, different inputs/bindings and repeats before any extra POST", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ bodies }) => {
    const value = input(), call = prepared(value), owned = dispatch(value, call);
    await expect(sendNative(value, owned, { ...call })).rejects.toThrow("ai2_gateway_call_mismatch");
    const changed = structuredClone(value); changed.snapshot.product.description += " changed";
    await expect(sendNative(changed, owned, call)).rejects.toThrow("ai2_gateway_call_mismatch");
    const wrong = { ...owned, binding: { ...owned.binding, wireHash: "b".repeat(64) } };
    await expect(sendNative(value, wrong, call)).rejects.toThrow("ai2_gateway_call_mismatch");
    expect(bodies).toHaveLength(0);
    await sendNative(value, owned, call);
    await expect(sendNative(value, owned, call)).rejects.toThrow("ai2_gateway_call_mismatch");
    await expect(sendNative(value, owned, prepared(value))).rejects.toThrow("ai2_gateway_call_mismatch");
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
    const result = await sendNative(value, owned, call);
    expect(result.terminal).toBeNull(); expect(result.result.ok).toBe(false);
    await expect(sendNative(value, owned, call)).rejects.toThrow("ai2_gateway_call_mismatch");
    expect(bodies).toHaveLength(1);
  });
});

it("snapshots input/dispatch/contract before await and ignores global fetch injection", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ bodies }) => {
    const value = input(), call = prepared(value), owned = dispatch(value, call), originalDispatch = structuredClone(owned);
    const globalRequest = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("injected_request_not_allowed"));
    try {
      const result = sendNative(value, owned, call);
      value.snapshot.product.description += " changed after entry";
      Object.assign(owned.binding, { wireHash: "b".repeat(64) });
      Object.assign(fixture.contract!, { endpoint: "http://127.0.0.1:1/v1/chat/completions" });
      const completed = await result;
      expect(completed.result.ok).toBe(true);
      expect(readAi2GatewayTerminal(completed.terminal)?.dispatch).toEqual(originalDispatch);
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
    const running = sendNative(value, owned, call, { signal: controller.signal });
    try {
      await Promise.race([accepted, running.then(() => { throw new Error("native_finished_before_request"); })]);
      controller.abort();
      expect(await running).toEqual({ result: { ok: false, error: "cancelled" }, terminal: null });
    } finally { controller.abort(); await Promise.allSettled([running]); }
    await expect(sendNative(value, owned, call)).rejects.toThrow("ai2_gateway_call_mismatch");
    expect(bodies).toHaveLength(1);
  });
});


it("keeps genuine AI1 and AI2 preparations and terminal capabilities separate", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  await server(async ({ bodies }) => {
    const value = input(), call = prepared(value), owned = dispatch(value, call);
    const ai1Call = prepareAi1GatewayCall(value, { model, timeoutMs: 1_000 });
    if (ai1Call.kind !== "prepared") throw new Error("fixture_ai1_not_prepared");
    await expect(sendNative(value, owned, ai1Call)).rejects.toThrow("ai2_gateway_call_mismatch");
    expect(bodies).toHaveLength(0);
    const binding = { kind: "ai1_legacy_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:1", candidateId: 1, attemptId: 2,
      inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, reviewPolicyHash: value.policyHash,
      promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
      provider: "abcllm" as const, model, routeId: "crawl-agent-review" as const, stageEpoch: 1,
      wireHash: ai1Call.wireHash, servingContractHash: ai1Call.servingContractHash, totalTokenBound: ai1Call.totalTokenBound,
      chargedTokens: ai1Call.totalTokenBound, job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 1 } };
    const ai1Dispatch = ai1ModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: "local-test", bootId: randomUUID() },
      token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64), binding, bindingHash: ai1DispatchBindingHash(binding) });
    const ai1Pending = reviewWithReservedAi1Gateway(value, ai1Dispatch, ai1Call);
    requests.add(ai1Pending); void ai1Pending.catch(() => {});
    const ai1 = await ai1Pending;
    expect(readAi1GatewayTerminal(ai1.terminal)).not.toBeNull();
    expect(readAi2GatewayTerminal(ai1.terminal)).toBeNull();
    const ai2 = await sendNative(value, owned, call);
    expect(readAi2GatewayTerminal(ai2.terminal)).not.toBeNull();
    expect(readAi1GatewayTerminal(ai2.terminal)).toBeNull();
    expect(bodies).toHaveLength(2);
  });
});
