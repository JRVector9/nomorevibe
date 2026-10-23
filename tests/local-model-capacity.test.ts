import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import type { JobLease } from "@/lib/jobs/control";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { localModelContractHash, localModelServingContractSchema } from "@/lib/llm/local-model-serving-contract";
import { withLocalModelCapacity, verifiedLocalModelContract, localModelRouteReady } from "@/lib/llm/local-model-capacity";

const mocks = vi.hoisted(() => ({
  control: vi.fn(), pending: vi.fn(), requestSlot: vi.fn(), dispatch: vi.fn(), cancel: vi.fn(), mark: vi.fn(), reconcile: vi.fn(), native: vi.fn(),
}));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: mocks.control,
  findOwnPendingModelRequest: mocks.pending, requestLocalModelSlot: mocks.requestSlot, dispatchLocalModelCapacity: mocks.dispatch,
  cancelReservedModelSlot: mocks.cancel, markModelDispatchIndeterminate: mocks.mark, reconcileLocalModelTerminal: mocks.reconcile }));
vi.mock("@/lib/llm/local-model-terminal", () => ({ requestReservedLocalModel: mocks.native }));

const contract = localModelServingContractSchema.parse({ version: 1, protocol: "local-openai-chat-v1", backendId: "fixture-gpu",
  provider: "local-direct", physicalGroup: "shared-device", endpoint: "http://fixture.invalid/v1/chat/completions", model: "qwen", responseModel: "qwen",
  modelFamily: "qwen3.8-flash-next", deploymentRevision: "pinned", contextWindowTokens: 8192, totalTokenBound: 8192,
  maxOutputTokens: 512, maxInputBytes: 100_000, capabilities: { vision: true, jsonSchema: true },
  thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } });
const policy = { version: 1 as const, globalLimit: 2, providerLimits: { "fixture-gpu": 2 }, groupLimits: { "shared-device": 1 },
  poolLimits: { reviewer: 2, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 20, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "local-audit", provider: "local-direct", model: "qwen", providerBudgetId: "fixture-gpu", groupId: "shared-device" }] };
const target = { kind: "audit" as const, purpose: "audit" as const, itemId: 5, slug: "demo" };
const lease: JobLease = { name: "product-audit", token: randomUUID(), requestedVersion: 1 };
function context() {
  const now = new Date();
  const input = createReviewInput({ repo: "acme/demo", productUrl: "https://demo.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "acme/demo", productUrl: "https://demo.example", repoMeta: {}, pageMeta: { title: "Demo", textSample: "A working task tracker" },
      pageStatus: 200, fetchedAt: now } as CrawlDocument, DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
  return { target, input, lease, promptVersion: "v2", env: {
    LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([contract]),
    LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify({ [contract.backendId]: localModelContractHash(contract) }),
    LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ [contract.physicalGroup]: 1 }),
    ROLE_LEASE_INSTANCE_ID: "reviewer", ROLE_LEASE_BOOT_ID: randomUUID(), ROLE_LEASE_RELEASE: "fixture", ROLE_LEASE_EPOCH: "1", ROLE_LEASE_ROLE: "reviewer",
  } };
}
const wire = JSON.stringify({ model: "qwen", stream: false, max_tokens: 64, messages: [{ role: "user", content: "untrusted evidence" }] });
const init = { method: "POST", body: wire };
const run = (request: typeof fetch) => request(contract.endpoint, init);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.control.mockResolvedValue({ mode: "open", policy }); mocks.pending.mockResolvedValue(null);
  mocks.requestSlot.mockResolvedValue({ kind: "granted", reservation: {} });
  mocks.dispatch.mockResolvedValue({ requestId: randomUUID(), binding: {} });
  mocks.mark.mockResolvedValue(true); mocks.reconcile.mockResolvedValue({ kind: "settled" });
  mocks.native.mockImplementation(async () => ({ response: new Response("native body"), terminal: {} }));
});

describe("직접 모델의 실제 admission 경계", () => {
  it("disabled 기존 호출의 주소·wire·응답을 그대로 두고 신규 작업은 전송하지 않는다", async () => {
    mocks.control.mockResolvedValue({ mode: "disabled", policy: null });
    const base = vi.fn(async () => new Response("legacy"));
    const c = context();
    expect(await (await withLocalModelCapacity(c, run, base)).text()).toBe("legacy");
    expect(base).toHaveBeenCalledExactlyOnceWith(contract.endpoint, init);
    await expect(withLocalModelCapacity({ ...c, allowLegacy: false }, run, base)).rejects.toMatchObject({ reason: "disabled" });
    expect(base).toHaveBeenCalledTimes(1); expect(mocks.requestSlot).not.toHaveBeenCalled();
  });
  it("draining과 미검증 계약·틀린 물리 상한은 HTTP를 부르지 않는다", async () => {
    mocks.control.mockResolvedValueOnce({ mode: "draining", policy });
    await expect(withLocalModelCapacity(context(), run)).rejects.toMatchObject({ reason: "draining" });
    const c = context(); delete (c.env as Record<string, string | undefined>).LOCAL_MODEL_VERIFIED_CONTRACT_HASHES;
    await expect(withLocalModelCapacity(c, run)).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
    expect(verifiedLocalModelContract(contract.endpoint, contract.model, c.env)).toBeNull();
    expect(localModelRouteReady({ ...policy, groupLimits: { "shared-device": 2 } }, target, contract, context().env)).toBe(false);
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it("기존 모델 wrapper가 defer를 통신 실패로 바꿔도 원래 defer를 보존한다", async () => {
    mocks.requestSlot.mockResolvedValue({ kind: "deferred", reason: "capacity" });
    await expect(withLocalModelCapacity(context(), async request => {
      try { await run(request); } catch { return { error: "gateway_error" }; }
      return { error: "unexpected" };
    })).rejects.toBeInstanceOf(ModelCapacityDeferredError);
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it("성공한 native terminal을 먼저 정산하고 전체 context C와 실제 wire를 묶는다", async () => {
    expect(await (await withLocalModelCapacity(context(), run)).text()).toBe("native body");
    const binding = mocks.dispatch.mock.calls[0][0].binding;
    expect(binding).toMatchObject({ totalTokenBound: 8192, chargedTokens: 8192, provider: "local-direct", physicalGroup: "shared-device" });
    const transmitted = mocks.native.mock.calls[0][3].body;
    expect(JSON.parse(transmitted).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(JSON.parse(transmitted).messages).toEqual(JSON.parse(wire).messages);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1); expect(mocks.mark).not.toHaveBeenCalled();
  });
  it("200의 읽을 수 있는 JSON이어도 원격 종료가 없으면 미확정 점유를 유지한다", async () => {
    mocks.native.mockResolvedValue({ response: new Response('{"decision":"approve"}'), terminal: null });
    await expect(withLocalModelCapacity(context(), run)).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
    expect(mocks.mark).toHaveBeenCalledWith(expect.anything(), "transport_unknown");
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("요청 abort는 로컬 종료일 뿐이며 dispatch를 해제하지 않는다", async () => {
    const controller = new AbortController();
    mocks.native.mockImplementation(async () => { controller.abort(); throw new DOMException("cancelled", "AbortError"); });
    await expect(withLocalModelCapacity(context(), request => request(contract.endpoint, { ...init, signal: controller.signal })))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.mark).toHaveBeenCalledWith(expect.anything(), "local_abort"); expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
