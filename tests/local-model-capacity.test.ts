import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import type { JobLease } from "@/lib/jobs/control";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { localModelContractHash, localModelServingContractSchema } from "@/lib/llm/local-model-serving-contract";
import { withLocalModelCapacity, verifiedLocalModelContract, localModelRouteReady } from "@/lib/llm/local-model-capacity";

const mocks = vi.hoisted(() => ({
  cancelPending: vi.fn(), control: vi.fn(), pending: vi.fn(), requestSlot: vi.fn(), dispatch: vi.fn(), cancel: vi.fn(), mark: vi.fn(), reconcile: vi.fn(), native: vi.fn(),
}));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: mocks.control,
  cancelOwnPendingLocalModelRequest: mocks.cancelPending, findOwnPendingModelRequest: mocks.pending, requestLocalModelSlot: mocks.requestSlot, dispatchLocalModelCapacity: mocks.dispatch,
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
const lease: JobLease = { name: "audit-qwen", token: randomUUID(), requestedVersion: 1 };
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
  mocks.requestSlot.mockReset().mockResolvedValue({ kind: "granted", reservation: {} });
  mocks.dispatch.mockResolvedValue({ requestId: randomUUID(), binding: {} });
  mocks.cancelPending.mockResolvedValue(true); mocks.mark.mockResolvedValue(true); mocks.reconcile.mockResolvedValue({ kind: "settled" });
  mocks.native.mockImplementation(async () => ({ response: new Response("native body"), terminal: {} }));
});

describe("직접 모델의 실제 admission 경계", () => {
  it("화면 caller는 방금 받은 스크린샷 증거 없이는 예약하지 않는다", async () => {
    const c = context(), jpeg = Buffer.from("rendered screenshot");
    const screen = { ...c, target: { ...target, purpose: "screen" as const }, lease: { ...lease, name: "audit-screen-review" } };
    mocks.control.mockResolvedValue({ mode: "open", policy: { ...policy, routes: [{ ...policy.routes[0], routeId: "local-screen" }] } });
    const imageWire = JSON.stringify({ ...JSON.parse(wire), messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
    ] }] });
    const send = (request: typeof fetch) => request(contract.endpoint, { ...init, body: imageWire });
    await expect(withLocalModelCapacity(screen, send)).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
    const now = new Date().toISOString(), proof = { requestedUrl: c.input.snapshot.product.url!, requestedAt: now, receivedAt: now,
      screenshotHash: createHash("sha256").update(jpeg).digest("hex") };
    for (const screenProof of [
      { ...proof, receivedAt: new Date(Date.now() - 120_000).toISOString(), requestedAt: new Date(Date.now() - 130_000).toISOString() },
      { ...proof, receivedAt: new Date(Date.now() + 60_000).toISOString() },
      { ...proof, requestedUrl: "https://other.example" }, { ...proof, screenshotHash: "a".repeat(64) },
    ]) await expect(withLocalModelCapacity({ ...screen, screenProof }, send)).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
    await expect(withLocalModelCapacity({ ...screen, screenProof: proof }, run)).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
    expect(mocks.requestSlot).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
    await withLocalModelCapacity({ ...screen, screenProof: proof }, send);
    expect(mocks.dispatch.mock.calls[0][0].screenProof).toEqual(proof);
    expect(mocks.dispatch.mock.calls[0][0].binding).not.toHaveProperty("screenProof");
    expect(mocks.dispatch.mock.calls[0][0].binding.wireHash).toBe(createHash("sha256").update(mocks.native.mock.calls[0][3].body).digest("hex"));
    expect(mocks.native).toHaveBeenCalledTimes(1);
  });
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
    // PR 1b: 장비 한도는 정책이 아니라 model_capacity_devices 에 있으므로 정책 groupLimits 와 물리 상한을 비교하지 않는다 — 물리 상한 자체가 없으면 준비 안 됨.
    expect(localModelRouteReady({ ...policy, groupLimits: { "shared-device": 2 } }, target, contract, context().env)).toBe(true);
    expect(localModelRouteReady(policy, target, contract, { ...context().env, LOCAL_MODEL_PHYSICAL_LIMITS: undefined })).toBe(false);
    expect(localModelRouteReady(policy, target, contract, { ...context().env, LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ other: 1 }) })).toBe(false);
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
  it("미뤄진 갈림 확인은 자기 대기 행을 거두고, dispatch 가 null 이면 예약을 물린다 — 다른 대상의 대기 행은 예전처럼 남긴다(2026-11-09)", async () => {
    const split = { kind: "split" as const, purpose: "deepseek_confirm" as const, tiebreakId: 7, candidateId: 9, generationKey: "a".repeat(64), repo: "acme/demo" };
    const c = { ...context(), target: split, lease: { ...lease, name: "split-confirm" } };
    mocks.control.mockResolvedValue({ mode: "open", policy: { ...policy, routes: [...policy.routes, { ...policy.routes[0], routeId: "local-deepseek-confirm" }] } });
    mocks.requestSlot.mockResolvedValue({ kind: "deferred", reason: "capacity" });
    await expect(withLocalModelCapacity(c, run)).rejects.toMatchObject({ reason: "capacity" });
    expect(mocks.cancelPending).toHaveBeenCalledTimes(1);
    expect(mocks.cancelPending.mock.calls[0][1]).toEqual(split);
    expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
    // 다른 대상(감사)은 바꾸지 않았다 — 대기 행을 남긴다
    await expect(withLocalModelCapacity(context(), run)).rejects.toMatchObject({ reason: "capacity" });
    expect(mocks.cancelPending).toHaveBeenCalledTimes(1);
    // 장부 쪽 경합으로 dispatch 가 null 이면(정책·fence·만료) 받은 예약을 바로 물린다 — 만료를 기다리지 않는다
    mocks.requestSlot.mockResolvedValue({ kind: "granted", reservation: { requestId: "r" } });
    mocks.dispatch.mockResolvedValue(null);
    await expect(withLocalModelCapacity(c, run)).rejects.toMatchObject({ reason: "reservation_lost" });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({ requestId: "r" }); expect(mocks.native).not.toHaveBeenCalled();
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


describe("assist의 같은 준비 입력·요청을 유지하는 admission 대기", () => {
  function assistContext() {
    const c = context();
    const assist = { kind: "assist" as const, purpose: "assist_review" as const, workId: randomUUID(), workRevision: 2,
      claimToken: randomUUID(), task: "uptime" as const, subjectId: 42, backendId: contract.backendId };
    mocks.control.mockResolvedValue({ mode: "open", policy: { ...policy,
      routes: [{ ...policy.routes[0], routeId: `local-assist-uptime-${contract.backendId}` }] } });
    return { ...c, target: assist, lease: { ...c.lease, name: "product-llm-assist-review" }, waitForCapacity: true,
      admissionDeadlineAt: Date.now() + 10_000 };
  }
  it("다른 caller의 늦은 예약을 같은 ID·input으로 소비하고 모델은 한 번만 보낸다", async () => {
    vi.useFakeTimers();
    try {
      const c = assistContext(), id = randomUUID(), signal = new AbortController().signal;
      mocks.pending.mockResolvedValue({ requestId: id, state: "waiting" });
      mocks.requestSlot.mockResolvedValueOnce({ kind: "deferred", reason: "capacity" }).mockResolvedValueOnce({ kind: "granted", reservation: {} });
      const pending = withLocalModelCapacity(c, request => request(contract.endpoint, { ...init, signal }));
      const observed = pending.then(response => ({ response }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.native).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await observed).toMatchObject({ response: expect.any(Response) });
      expect(mocks.requestSlot).toHaveBeenCalledTimes(2);
      expect(mocks.requestSlot.mock.calls.map(row => row[0].requestId)).toEqual([id, id]);
      expect(mocks.requestSlot.mock.calls[0][0]).toEqual(mocks.requestSlot.mock.calls[1][0]);
      expect(mocks.dispatch.mock.calls[0][0].input).toEqual(c.input);
      expect(mocks.native).toHaveBeenCalledTimes(1);
      expect(mocks.cancelPending).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("전송 전 deadline은 자기 pending만 정리하고 모델·terminal을 만들지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const c = assistContext(), id = randomUUID(), controller = new AbortController();
      mocks.pending.mockResolvedValue({ requestId: id, state: "waiting" });
      mocks.requestSlot.mockResolvedValue({ kind: "deferred", reason: "capacity" });
      const pending = withLocalModelCapacity(c, request => request(contract.endpoint, { ...init, signal: controller.signal }));
      const stopped = pending.then(response => ({ response }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(0); controller.abort(); await vi.advanceTimersByTimeAsync(1000); expect(await stopped).toMatchObject({ error: expect.any(ModelCapacityDeferredError) });
      expect(mocks.cancelPending).toHaveBeenCalledTimes(1);
      expect(mocks.cancelPending.mock.calls[0][0]).toMatchObject({ requestId: id });
      expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.mark).not.toHaveBeenCalled(); expect(mocks.reconcile).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("대기에는 signal과 실제 절대 deadline이 둘 다 있어야 하며 없으면 등록하지 않는다", async () => {
    const c = assistContext(), signal = new AbortController().signal;
    await expect(withLocalModelCapacity(c, run)).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
    await expect(withLocalModelCapacity({ ...c, admissionDeadlineAt: undefined }, request => request(contract.endpoint, { ...init, signal })))
      .rejects.toMatchObject({ reason: "provider_contract_unavailable" });
    expect(mocks.requestSlot).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
  });
  it("이미 abort된 호출은 새 예약·HTTP 없이 기존 자기 pending만 정리한다", async () => {
    const c = assistContext(), controller = new AbortController(); controller.abort();
    await expect(withLocalModelCapacity(c, request => request(contract.endpoint, { ...init, signal: controller.signal })))
      .rejects.toMatchObject({ reason: "capacity" });
    expect(mocks.requestSlot).not.toHaveBeenCalled(); expect(mocks.cancelPending).toHaveBeenCalledTimes(1);
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it("signal이 살아 있어도 admission deadline이 끝나면 자기 대기를 취소한다", async () => {
    const c = { ...assistContext(), admissionDeadlineAt: Date.now() + 30 }, signal = new AbortController().signal;
    mocks.requestSlot.mockResolvedValue({ kind: "deferred", reason: "capacity" });
    await expect(withLocalModelCapacity(c, request => request(contract.endpoint, { ...init, signal }))).rejects.toMatchObject({ reason: "capacity" });
    expect(signal.aborted).toBe(false); expect(mocks.cancelPending).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
  });
  it("마지막 예약이 headroom 경계를 넘으면 dispatch하지 않고 자기 예약만 정리한다", async () => {
    vi.useFakeTimers();
    try {
      const c = assistContext(), signal = new AbortController().signal;
      mocks.requestSlot.mockImplementation(async () => {
        vi.setSystemTime(c.admissionDeadlineAt + 1);
        return { kind: "granted", reservation: {} };
      });
      await expect(withLocalModelCapacity(c, request => request(contract.endpoint, { ...init, signal }))).rejects.toMatchObject({ reason: "capacity" });
      expect(mocks.cancelPending).toHaveBeenCalledTimes(1); expect(mocks.dispatch).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("cleanup 오류는 원래 defer와 함께 보존해 고아 대기 정리 실패를 숨기지 않는다", async () => {
    const c = assistContext(), controller = new AbortController(); controller.abort();
    const cleanup = new Error("database_unavailable"); mocks.cancelPending.mockRejectedValueOnce(cleanup);
    const error = await withLocalModelCapacity(c, request => request(contract.endpoint, { ...init, signal: controller.signal })).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([expect.any(ModelCapacityDeferredError), cleanup]);
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it("기존 nonassist 호출은 opt-in 값이 있어도 한 번 defer하고 대기·신규 취소를 하지 않는다", async () => {
    mocks.requestSlot.mockResolvedValue({ kind: "deferred", reason: "capacity" });
    await expect(withLocalModelCapacity({ ...context(), waitForCapacity: true }, run)).rejects.toMatchObject({ reason: "capacity" });
    expect(mocks.requestSlot).toHaveBeenCalledTimes(1); expect(mocks.cancelPending).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
  });
});
