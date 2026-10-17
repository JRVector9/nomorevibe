import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ProfileTask } from "@/lib/domain/products/search-profiles";
import { PROFILE_MODEL, profileHash, profileEvidence } from "@/lib/domain/products/search-profile";
import { textProfileInputHash, modelCapacityReservationSchema } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), legacy: vi.fn(), pending: vi.fn(), request: vi.fn(),
  cancel: vi.fn(), native: vi.fn(), reconcile: vi.fn(), unknown: vi.fn(), transaction: vi.fn(), control: vi.fn(),
  prefix: vi.fn(), finish: vi.fn(), jobWall: vi.fn(), role: vi.fn(), batch: vi.fn(), generation: vi.fn(), gatewayPrepare: vi.fn() }));
vi.mock("@/lib/domain/products/search-profiles", () => ({ prepareProfileModelDispatch: mocks.prepare }));
vi.mock("@/lib/domain/products/search-profile", async original => ({ ...await original<typeof import("@/lib/domain/products/search-profile")>(), writeKeywords: mocks.legacy }));
vi.mock("@/lib/llm/capacity-repository", () => ({ findOwnPendingModelRequest: mocks.pending, requestTextProfileModelSlot: mocks.request,
  cancelReservedModelSlot: mocks.cancel, reconcileTextProfileGatewayTerminal: mocks.reconcile, markModelDispatchIndeterminate: mocks.unknown, lockModelCapacityCallerControl: mocks.control,
  lockTextProfileModelCapacityDispatch: mocks.prefix, finishTextProfileModelCapacityDispatch: mocks.finish }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ writeKeywordsWithReservedGateway: mocks.native, prepareTextProfileGatewayCall: mocks.gatewayPrepare }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/jobs/control", () => ({ assertJobLease: mocks.jobWall, assertJobLeaseAtWallTime: mocks.jobWall }));
vi.mock("@/lib/jobs/role-leader", () => ({ assertRoleLease: mocks.role }));
vi.mock("@/lib/jobs/batch-repository", () => ({ assertJobBatchAdmission: mocks.batch }));
vi.mock("@/lib/domain/products/generation", () => ({ lockProductGeneration: mocks.generation }));
import { writeKeywordsWithModelCapacity } from "@/lib/domain/products/search-profile-model-capacity";
const task = { product: { id: 3, slug: "unit-profile", name: "Demo", url: "https://demo.test", category: "Tools", tagline: "Budget app",
  description: "Budget app", status: "verified", searchTopics: null, searchPageText: null, searchReadme: null }, profile: null, reviewerNote: null } as ProfileTask;
const role = { role: "text" as const, instanceId: "text-unit", bootId: randomUUID(), release: "unit-release", kind: "primary" as const, epoch: 1 };
const lease = { name: "product-search-profile", token: randomUUID(), requestedVersion: 4 };
const result = { ok: true as const, en: ["budget app"], ko: ["가계부"] };
const failure = { ok: false as const, error: "invalid_output" };
const reservation = modelCapacityReservationSchema.parse({ requestId: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId },
  token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64) });
const nativeDispatch = { ...reservation, binding: { kind: "text_profile_gateway" } };
function first() {
  const evidence = profileEvidence(task.product, null), input = { productId: 3, slug: task.product.slug,
    evidenceHash: profileHash(evidence), profile: { kind: "absent" as const }, model: "profile-model" };
  return { kind: "ready", intent: { task, evidence, input }, call: { kind: "prepared", evidenceHash: input.evidenceHash,
    model: input.model, wireHash: "b".repeat(64), servingContractHash: "c".repeat(64), totalTokenBound: 4096 } };
}
const options = () => ({ timeoutMs: 1000, roleLease: role });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("ABCLLM_API_KEY", "unit-test");
  const ready = first(); mocks.prepare.mockResolvedValueOnce(ready).mockResolvedValue({ ...ready, dispatch: nativeDispatch });
  mocks.pending.mockResolvedValue(null); mocks.request.mockResolvedValue({ kind: "granted", reservation });
  mocks.native.mockResolvedValue({ result, terminal: { kind: "text_profile_gateway_terminal" } });
  mocks.reconcile.mockResolvedValue({ kind: "settled" }); mocks.cancel.mockResolvedValue(true); mocks.unknown.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());
it("returns no_key before DB and preserves disabled legacy execution without a role", async () => {
  vi.stubEnv("ABCLLM_API_KEY", ""); expect(await writeKeywordsWithModelCapacity(task, lease, { timeoutMs: 1000 }))
    .toEqual({ kind: "result", result: { ok: false, error: "no_key" } }); expect(mocks.prepare).not.toHaveBeenCalled();
  vi.stubEnv("ABCLLM_API_KEY", "unit-test"); mocks.prepare.mockReset().mockResolvedValue({ kind: "disabled" }); mocks.legacy.mockResolvedValue(result);
  expect(await writeKeywordsWithModelCapacity(task, lease, { timeoutMs: 1000 })).toEqual({ kind: "result", result });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.legacy).toHaveBeenCalledWith(profileEvidence(task.product, null), { timeoutMs: 1000 });
});
it("uses the original pending ID then waits for commit acknowledgement and historical settlement", async () => {
  mocks.pending.mockResolvedValue({ requestId: reservation.requestId, state: "waiting" });
  let finish!: () => void; const wait = new Promise<void>(resolve => { finish = resolve; }); mocks.reconcile.mockImplementation(() => wait);
  let settled = false; const work = writeKeywordsWithModelCapacity(task, lease, options()).finally(() => { settled = true; }); void work.catch(() => {});
  try {
    await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledTimes(1)); expect(settled).toBe(false);
    expect(mocks.request.mock.calls[0][0]).toMatchObject({ requestId: reservation.requestId, class: "background", pool: "text",
      workKey: `text:profile:3:${textProfileInputHash(first().intent.input)}`, owner: reservation.owner });
    expect(mocks.prepare.mock.calls[1][2].reserved.expected).toEqual(first().intent.input);
    expect(mocks.native).toHaveBeenCalledWith(first().intent.evidence, nativeDispatch, first().call, expect.objectContaining({ timeoutMs: 1000 }));
  } finally { finish(); }
  expect(await work).toEqual({ kind: "result", result, expectedProfile: { kind: "absent" } }); expect(mocks.unknown).not.toHaveBeenCalled();
});
it("does not send HTTP while reserved reentry commit remains pending", async () => {
  let release!: () => void; const commit = new Promise<void>(resolve => { release = resolve; });
  const ready = first(); mocks.prepare.mockReset().mockResolvedValueOnce(ready).mockImplementation(async () => { await commit; return { ...ready, dispatch: nativeDispatch }; });
  const work = writeKeywordsWithModelCapacity(task, lease, options()); void work.catch(() => {});
  try { await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2)); expect(mocks.native).not.toHaveBeenCalled(); }
  finally { release(); }
  await work; expect(mocks.native).toHaveBeenCalledTimes(1);
});
it("cancels only the unused reservation when current profile/source is stale", async () => {
  mocks.prepare.mockReset().mockResolvedValueOnce(first()).mockResolvedValueOnce({ kind: "skipped" });
  expect(await writeKeywordsWithModelCapacity(task, lease, options())).toEqual({ kind: "skipped" });
  expect(mocks.cancel).toHaveBeenCalledWith(reservation); expect(mocks.native).not.toHaveBeenCalled();
});
it("keeps capacity refusal typed without cancelling a waiting request or calling transport", async () => {
  mocks.request.mockResolvedValue({ kind: "deferred", reason: "capacity" });
  await expect(writeKeywordsWithModelCapacity(task, lease, options())).rejects.toMatchObject({ reason: "capacity" });
  expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it("marks unknown only after the actual native promise settles and retains full dispatch", async () => {
  let release!: () => void; const native = new Promise<void>(resolve => { release = resolve; });
  mocks.native.mockImplementation(async () => { await native; return { result: failure, terminal: null }; });
  const controller = new AbortController(), work = writeKeywordsWithModelCapacity(task, lease, { ...options(), signal: controller.signal }); void work.catch(() => {});
  try { await vi.waitFor(() => expect(mocks.native).toHaveBeenCalledTimes(1)); controller.abort(); expect(mocks.unknown).not.toHaveBeenCalled(); }
  finally { release(); }
  expect(await work).toMatchObject({ kind: "result", result: failure }); expect(mocks.unknown).toHaveBeenCalledWith(nativeDispatch, "local_abort");
});
it("preserves returned business failure and settlement failure as original objects", async () => {
  const error = new Error("ledger_unavailable"); mocks.native.mockResolvedValue({ result: failure, terminal: { kind: "text_profile_gateway_terminal" } }); mocks.reconcile.mockRejectedValue(error);
  let caught: unknown; try { await writeKeywordsWithModelCapacity(task, lease, options()); } catch (value) { caught = value; }
  expect(caught).toBeInstanceOf(AggregateError); expect((caught as AggregateError).errors[0]).toBe(failure); expect((caught as AggregateError).errors[1]).toBe(error);
});
it("preserves native thrown error ahead of unknown-mark failure", async () => {
  const original = new Error("native_failure"), cleanup = new Error("mark_failure"); mocks.native.mockRejectedValue(original); mocks.unknown.mockRejectedValue(cleanup);
  let caught: unknown; try { await writeKeywordsWithModelCapacity(task, lease, options()); } catch (value) { caught = value; }
  expect(caught).toBeInstanceOf(AggregateError); expect((caught as AggregateError).errors).toEqual([original, cleanup]);
});
it("refuses a positive ownerless call without request or native dispatch", async () => {
  await expect(writeKeywordsWithModelCapacity(task, lease, { timeoutMs: 1000 })).rejects.toEqual(new ModelCapacityDeferredError("owner_unavailable"));
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});

it("captures actual current profile/source and validates role/job walls before returning a prepared domain intent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/products/search-profiles")>("@/lib/domain/products/search-profiles");
  const rows: unknown[][] = [[task.product], [{ reviewerNote: null }], [], [{ due: true }]];
  const execute = vi.fn().mockResolvedValueOnce([{ row: null }]).mockResolvedValue([{ owned: true, kind: "primary" }]);
  const chain = (values: unknown[]) => { const query = { from: () => query, where: () => query, for: () => query,
    leftJoin: () => query, then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(values).then(resolve) }; return query; };
  const tx = { select: () => chain(rows.shift() ?? []), execute };
  mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(tx));
  mocks.control.mockResolvedValue({ mode: "open", policy: { routes: [{ routeId: "product-search-profile", provider: "abcllm", model: PROFILE_MODEL }] } });
  mocks.generation.mockResolvedValue(true); mocks.gatewayPrepare.mockReturnValue({ ...first().call, model: PROFILE_MODEL });
  const prepared = await actual.prepareProfileModelDispatch(task, lease, options());
  expect(prepared).toMatchObject({ kind: "ready", intent: { input: { ...first().intent.input, model: PROFILE_MODEL } } });
  expect(mocks.batch).toHaveBeenCalledWith(tx, lease.name, role); expect(mocks.role).toHaveBeenCalledWith(tx, role);
  expect(mocks.jobWall).toHaveBeenCalledWith(tx, lease, "update");
});
