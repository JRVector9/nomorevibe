import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { ai1DispatchBindingHash, ai1ModelDispatchSchema } from "@/lib/llm/capacity";
import { prepareAi1GatewayCall, reviewWithGateway, reviewWithReservedAi1Gateway } from "@/lib/crawl/agent-review-gateway";
import type { Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import { createProviderCircuits, nativeTerminalFailure, NATIVE_TERMINAL_FAILURE, providerOutcome } from "@/lib/llm/provider-circuit-breaker";

/**
 * F2 결함 2: native 게이트웨이 계약 위반(envelope·terminal)은 결과 모양(invalid_output + detail invalid_native_terminal)은 그대로 두고
 * 회로에는 provider 장애로 센다. 모델 판정 실패(내용 parse·schema)와 legacy 경로의 분류는 바뀌지 않는다.
 */
const fixture = vi.hoisted(() => ({ contract: null as Ai1GatewayServingContract | null }));
vi.mock("@/lib/crawl/agent-review-serving-contract", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-serving-contract")>(),
  resolveAi1GatewayServingContract: () => fixture.contract,
}));
afterEach(() => { fixture.contract = null; vi.unstubAllEnvs(); });
const model = "[MLX] f2-contract";
function input() {
  const now = new Date("2026-10-17T00:00:00.000Z");
  return createReviewInput({ repo: "native/f2c", productUrl: "https://f2c.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "native/f2c", productUrl: "https://f2c.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "F2" }, pageStatus: 200, fetchedAt: now } as CrawlDocument, DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
const outcome = { decision: "approve", reason: "A working task tracker is shown.", evidenceIds: ["product"], confidence: 0.9 };
const envelope = (overrides: Record<string, unknown> = {}) => ({ id: "f2", object: "chat.completion", created: 1, model: "native-model",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(outcome) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, usage_provenance: "upstream_reported", ...overrides });

/** 바꾸기 전 규칙 그대로(기본 env 불변 비교용) */
const LEGACY_DOWN = new Set(["timeout", "gateway_error", "rate_limited", "budget", "not_configured", "auth", "missing_cli",
  "model_unavailable", "no_key", "rate_limit", "network"]);
const before = (result: { ok: boolean; error?: string }) => result.ok ? "up"
  : typeof result.error === "string" && (LEGACY_DOWN.has(result.error) || /^http_5\d\d$/.test(result.error)) ? "down" : "none";

it("counts only the native contract diagnostic as provider down and keeps every other classification", () => {
  expect(NATIVE_TERMINAL_FAILURE).toBe("invalid_native_terminal");
  expect(providerOutcome({ ok: false, error: "invalid_output", detail: "invalid_native_terminal" })).toBe("down");
  expect(nativeTerminalFailure({ ok: false, error: "invalid_output", detail: "invalid_native_terminal" })).toBe(true);
  for (const detail of [undefined, "invalid_json", "invalid_envelope", "missing_content", "schema_validation", "review_unknown_evidence"])
    expect(providerOutcome({ ok: false, error: "invalid_output", detail })).toBe("none");
  for (const result of [{ ok: true }, { ok: false, error: "cancelled" }, { ok: false, error: "input_too_large" }, { ok: false, error: "cli_error" },
    { ok: false, error: "output_too_large", detail: "invalid_native_terminal" }, { ok: false, error: "timeout" }, { ok: false, error: "http_502" },
    { ok: false, error: "http_404" }, { ok: false, error: "gateway_error" }, { ok: false, error: "invalid_output" }])
    expect(providerOutcome(result)).toBe(before(result));
});

it("opens the AI1 circuit after consecutive contract violations and never for judgment failures", () => {
  const logs: string[] = [];
  const circuits = createProviderCircuits({ mode: "enabled", failures: 2, openMs: 60_000 }, { now: () => 0, log: event => logs.push(event) });
  for (let index = 0; index < 3; index++) {
    const admission = circuits.admit("ai1"); if (!admission.admitted) throw new Error("unexpected_open");
    admission.record({ ok: false, error: "invalid_output", detail: "invalid_json" }); admission.done();
  }
  expect(logs).toEqual([]);
  for (let index = 0; index < 2; index++) {
    const admission = circuits.admit("ai1"); if (!admission.admitted) throw new Error("unexpected_open");
    admission.record({ ok: false, error: "invalid_output", detail: "invalid_native_terminal" }); admission.done();
  }
  expect(logs).toEqual(["provider_circuit.opened"]);
  expect(circuits.admit("ai1")).toEqual({ admitted: false, reason: "provider_circuit_open" });
});

it("native envelope violations keep the original result shape with the contract diagnostic; content failures stay judgment failures", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  let reply = JSON.stringify(envelope({ model: "other-model" }));
  const http = createServer((request, response) => { request.resume(); request.on("end", () => response.end(reply)); });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
  fixture.contract = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm", model,
    responseModel: "native-model", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, deploymentRevision: "local-test-only",
    totalTokenBound: 8_000 };
  const send = async () => {
    const value = input(), call = prepareAi1GatewayCall(value, { model, timeoutMs: 2_000 });
    if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
    const binding = { kind: "ai1_legacy_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:1", candidateId: 1, attemptId: 2,
      inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, reviewPolicyHash: value.policyHash,
      promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion, provider: "abcllm" as const, model,
      routeId: "crawl-agent-review" as const, stageEpoch: 1, wireHash: call.wireHash, servingContractHash: call.servingContractHash,
      totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound,
      job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 1 } };
    const dispatch = ai1ModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: "f2", bootId: randomUUID() },
      token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64), binding, bindingHash: ai1DispatchBindingHash(binding) });
    return reviewWithReservedAi1Gateway(value, dispatch, call);
  };
  try {
    for (const body of [envelope({ model: "other-model" }), envelope({ error: { message: "upstream" } }), envelope({ choices: [] })]) {
      reply = JSON.stringify(body);
      const result = await send();
      expect(result).toEqual({ result: { ok: false, error: "invalid_output", detail: "invalid_native_terminal" }, terminal: null });
      expect(providerOutcome(result.result)).toBe("down");
    }
    reply = JSON.stringify(envelope({ choices: [{ index: 0, message: { role: "assistant", content: "not a verdict" }, finish_reason: "stop" }] }));
    const judged = await send();
    expect(judged.result).toMatchObject({ ok: false, error: "invalid_output", detail: "invalid_json" });
    expect(providerOutcome(judged.result)).toBe("none");
    // 기본 env(legacy) 경로: 같은 위반 응답은 지금처럼 판정·형식 오류로 남고 회로 분류도 바뀌지 않는다
    const request = (async () => new Response("<html>bad gateway page</html>")) as unknown as typeof fetch;
    const legacy = await reviewWithGateway(input(), { model, request });
    expect(legacy).toEqual({ ok: false, error: "invalid_output", detail: "invalid_envelope" });
    expect(providerOutcome(legacy)).toBe("none");
  } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
});
