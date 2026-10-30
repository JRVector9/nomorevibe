import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewInput, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { textHash } from "@/lib/crawl/translate";
import { ai1DispatchBindingHash, ai1ModelDispatchSchema, gatewayNotStartedEvidenceSchema, reasonTranslationDispatchBindingHash,
  reasonTranslationInputHash, reasonTranslationLogicalWorkKey, reasonTranslationModelDispatchSchema } from "@/lib/llm/capacity";
import { prepareAi1GatewayCall, prepareReasonTranslationGatewayCall, readGatewayNotStarted, reviewWithReservedAi1Gateway,
  translateWithReservedReasonGateway, type PreparedAi1GatewayCall, type PreparedReasonTranslationGatewayCall } from "@/lib/crawl/agent-review-gateway";
import type { Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import type { ReasonTranslationServingContract } from "@/lib/llm/reason-translation-serving-contract";

/**
 * 연결이 거부되거나 이름을 못 찾아 요청 바이트가 하나도 나가지 않은 reserved 게이트웨이 호출은 not_started 증인을 싣는다(엔진 다운·재시작 구간).
 * 요청이 소켓에 쓰인 뒤 끊긴 호출은 전송 여부를 모르므로 증인이 없다 — 그 경계가 이 테스트의 핵심이다.
 */
const fixture = vi.hoisted(() => ({ ai1: null as Ai1GatewayServingContract | null, reason: null as ReasonTranslationServingContract | null }));
vi.mock("@/lib/crawl/agent-review-serving-contract", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-serving-contract")>(),
  resolveAi1GatewayServingContract: () => fixture.ai1,
}));
vi.mock("@/lib/llm/reason-translation-serving-contract", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/llm/reason-translation-serving-contract")>(),
  resolveReasonTranslationServingContract: () => fixture.reason,
}));
vi.mock("@/lib/llm/text-capacity-admission", () => ({ assertTextModelAdmission: vi.fn() }));

const model = "[MLX] not-sent-model";
function input(): ReviewInput {
  const now = new Date("2026-10-30T00:00:00.000Z");
  return createReviewInput({ repo: "native/not-sent", productUrl: "https://ns.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "native/not-sent", productUrl: "https://ns.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "NS" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
const handle = () => ({ requestId: randomUUID(), owner: { instanceId: "not-sent-unit", bootId: randomUUID() }, token: randomUUID(),
  epoch: 1, revision: 1, policyHash: "a".repeat(64) });
function ai1Call(value: ReviewInput) {
  const call = prepareAi1GatewayCall(value, { model, timeoutMs: 5_000 });
  if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
  return call;
}
function ai1Dispatch(value: ReviewInput, call: PreparedAi1GatewayCall) {
  const binding = { kind: "ai1_legacy_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:1", candidateId: 1, attemptId: 2,
    inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, reviewPolicyHash: value.policyHash,
    promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
    provider: "abcllm" as const, model, routeId: "crawl-agent-review" as const, stageEpoch: 1,
    wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound,
    chargedTokens: call.totalTokenBound, job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 1 } };
  return ai1ModelDispatchSchema.parse({ ...handle(), binding, bindingHash: ai1DispatchBindingHash(binding) });
}
const texts = ["Repository has no visible deployment evidence."];
function reasonCall() {
  const call = prepareReasonTranslationGatewayCall(texts, { model, timeoutMs: 5_000 });
  if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
  return call;
}
function reasonDispatch(call: PreparedReasonTranslationGatewayCall) {
  const role = { role: "text" as const, instanceId: "not-sent-unit", bootId: randomUUID(), release: "local-only", kind: "primary" as const, epoch: 1,
    batch: { mode: "legacy" as const } };
  const members = texts.map(text => ({ sourceHash: textHash(text), cache: { kind: "absent" as const } }));
  const binding = { kind: "reason_translation_gateway" as const, version: 1 as const, members, model,
    inputHash: reasonTranslationInputHash({ members, model }), logicalWorkKey: reasonTranslationLogicalWorkKey(members),
    routeId: "reason-translate" as const, provider: "abcllm" as const, wireHash: call.wireHash, servingContractHash: call.servingContractHash,
    totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, role,
    job: { name: "reason-translate" as const, token: randomUUID(), requestedVersion: 1 } };
  return reasonTranslationModelDispatchSchema.parse({ ...handle(), owner: { instanceId: role.instanceId, bootId: role.bootId },
    binding, bindingHash: reasonTranslationDispatchBindingHash(binding) });
}
function contracts(endpoint: string) {
  fixture.ai1 = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm", model,
    responseModel: "native-model", endpoint, deploymentRevision: "local-test-only", totalTokenBound: 8_000 };
  fixture.reason = { version: 1, protocol: "abcllm-reason-total-bound-v1", routeId: "reason-translate", provider: "abcllm", model,
    responseModel: "served-reason", endpoint, deploymentRevision: "local-only", totalTokenBound: 8_192 };
}
/** A port that just stopped listening: connections are refused, nothing is ever written. */
async function closedPort(): Promise<number> {
  const http = createServer();
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  await new Promise<void>(resolve => http.close(() => resolve()));
  return address.port;
}
afterEach(() => { fixture.ai1 = null; fixture.reason = null; vi.unstubAllEnvs(); });

it("AI1: a refused connection returns gateway_error with a not_started witness bound to the exact dispatch", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  contracts(`http://127.0.0.1:${await closedPort()}/v1/chat/completions`);
  const value = input(), call = ai1Call(value), owned = ai1Dispatch(value, call);
  const response = await reviewWithReservedAi1Gateway(value, owned, call);
  expect(response.result).toEqual({ ok: false, error: "gateway_error" }); expect(response.terminal).toBeNull();
  const evidence = readGatewayNotStarted(response.notStarted);
  expect(evidence).toEqual({ version: 1, kind: "gateway_not_started", dispatch: owned });
  expect(gatewayNotStartedEvidenceSchema.parse(evidence)).toEqual(evidence);
  expect(readGatewayNotStarted(structuredClone(response.notStarted))).toBeNull();
});

it("reason-translate: a refused connection and an unresolvable name both return network with a not_started witness", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  for (const endpoint of [`http://127.0.0.1:${await closedPort()}/v1/chat/completions`, "http://nonexistent.invalid/v1/chat/completions"]) {
    contracts(endpoint);
    const call = reasonCall(), owned = reasonDispatch(call);
    const response = await translateWithReservedReasonGateway(texts, owned, call);
    expect(response.result).toEqual({ ok: false, error: "network" }); expect(response.terminal).toBeNull();
    expect(readGatewayNotStarted(response.notStarted)).toEqual({ version: 1, kind: "gateway_not_started", dispatch: owned });
  }
});

it("a request that reached the socket and was then cut has no witness: the call stays unproven", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "local-secret");
  const received: string[] = [];
  const http = createServer(request => { received.push(request.url ?? ""); request.socket.destroy(); });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  try {
    contracts(`http://127.0.0.1:${address.port}/v1/chat/completions`);
    const value = input(), call = ai1Call(value), owned = ai1Dispatch(value, call);
    const response = await reviewWithReservedAi1Gateway(value, owned, call);
    expect(response.result).toEqual({ ok: false, error: "gateway_error" }); expect(response.terminal).toBeNull();
    expect(response.notStarted).toBeUndefined();
    expect(received).toEqual(["/v1/chat/completions"]);
  } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
});
