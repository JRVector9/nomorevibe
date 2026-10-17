import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { productTranslationSourceHash } from "@/lib/domain/products/translation-policy";
import { productTranslationInputHash, productTranslationLogicalWorkKey, modelCapacityReservationSchema, type ProductTranslationMember } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
const mocks = vi.hoisted(() => ({ control: vi.fn(), prepare: vi.fn(), legacy: vi.fn(), call: vi.fn(), pending: vi.fn(),
  request: vi.fn(), cancel: vi.fn(), native: vi.fn(), reconcile: vi.fn(), unknown: vi.fn(), transaction: vi.fn(), prefix: vi.fn(),
  finish: vi.fn(), batch: vi.fn(), generation: vi.fn(), jobWall: vi.fn(), product: vi.fn(), log: vi.fn(), tasks: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/domain/products/translations", () => ({ prepareProductTranslationDispatch: mocks.prepare,
  pendingProductTranslations: mocks.tasks, recordProductTranslations: mocks.write }));
vi.mock("@/lib/crawl/translate", async original => ({ ...await original<typeof import("@/lib/crawl/translate")>(), translateProductFields: mocks.legacy }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: mocks.control,
  findOwnPendingModelRequest: mocks.pending, requestProductTranslationModelSlot: mocks.request, cancelReservedModelSlot: mocks.cancel,
  markModelDispatchIndeterminate: mocks.unknown, reconcileProductTranslationGatewayTerminal: mocks.reconcile,
  lockModelCapacityCallerControl: mocks.control, lockProductTranslationModelCapacityDispatch: mocks.prefix,
  finishProductTranslationModelCapacityDispatch: mocks.finish }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ prepareProductTranslationGatewayCall: mocks.call, translateProductFieldsWithReservedGateway: mocks.native }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction }, onPrimary: (run: () => unknown) => run() }));
vi.mock("@/lib/jobs/batch-repository", () => ({ assertJobBatchAdmission: mocks.batch }));
vi.mock("@/lib/jobs/control", () => ({ assertJobLease: mocks.jobWall, assertJobLeaseAtWallTime: mocks.jobWall }));
vi.mock("@/lib/domain/products/generation", () => ({ lockProductGeneration: mocks.generation }));
vi.mock("@/lib/domain/products/repository", () => ({ findBySlug: mocks.product }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: mocks.log } }));
import { translateProductFieldsWithModelCapacity } from "@/lib/domain/products/product-translation-model-capacity";
import { TRANSLATE_MODEL } from "@/lib/crawl/translate";
const source = { id: 17, name: "Doc", tagline: "문서를 관리하는 도구" };
const task = { source, locale: "en" as const, field: "tagline" as const, sourceHash: productTranslationSourceHash(source, "tagline"), attempts: 0, eligible: true };
const item = { name: source.name, locale: task.locale, field: task.field, text: source.tagline };
const role = { role: "text" as const, instanceId: "product-unit", bootId: randomUUID(), release: "unit", epoch: 1, kind: "primary" as const };
const job = { name: "product-translate", token: randomUUID(), requestedVersion: 3 };
const members: ProductTranslationMember[] = [{ productId: source.id, slug: "product-unit", locale: task.locale, field: task.field,
  sourceHash: task.sourceHash, demand: { attempts: 0, rowIdentityHash: "a".repeat(64) } }];
const boundRole = { ...role, batch: { mode: "legacy" as const } };
const call = { kind: "prepared" as const, wireHash: "b".repeat(64), servingContractHash: "c".repeat(64), totalTokenBound: 4096, model: TRANSLATE_MODEL };
const reservation = modelCapacityReservationSchema.parse({ requestId: randomUUID(), token: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId }, epoch: 1, revision: 1, policyHash: "d".repeat(64) });
const dispatch = { ...reservation, binding: { kind: "product_translation_gateway" } };
const expectation = { kind: "product_translation_write" };
const result = { ok: true as const, outputs: ["Doc helps people manage documents"] };
const failure = { ok: false as const, error: "network" };
const terminal = { kind: "product_translation_gateway_terminal" };
const options = () => ({ timeoutMs: 20_000, roleLease: role });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("ABCLLM_API_KEY", "unit");
  mocks.control.mockResolvedValue({ mode: "open", policy: { routes: [{ provider: "abcllm", routeId: "product-translate", model: TRANSLATE_MODEL }] } });
  mocks.call.mockReturnValue(call); mocks.prepare.mockResolvedValueOnce({ kind: "ready", members, role: boundRole })
    .mockResolvedValue({ kind: "ready", dispatch, expectation });
  mocks.pending.mockResolvedValue(null); mocks.request.mockResolvedValue({ kind: "granted", reservation });
  mocks.native.mockResolvedValue({ result, terminal }); mocks.reconcile.mockResolvedValue({ kind: "settled" });
  mocks.cancel.mockResolvedValue(true); mocks.unknown.mockResolvedValue(true); mocks.legacy.mockResolvedValue(result);
});
afterEach(() => vi.unstubAllEnvs());
it("preserves disabled legacy wire order and requires no new role", async () => {
  mocks.control.mockResolvedValue({ mode: "disabled" });
  expect(await translateProductFieldsWithModelCapacity([task], job, { timeoutMs: 20_000 })).toEqual({ kind: "result", result });
  expect(mocks.legacy).toHaveBeenCalledWith([item], 20_000, undefined, undefined);
  expect(Object.keys(mocks.legacy.mock.calls[0][0][0])).toEqual(["name", "locale", "field", "text"]);
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
});
it("preserves no_key without a model control read", async () => {
  vi.stubEnv("ABCLLM_API_KEY", ""); mocks.legacy.mockResolvedValue({ ok: false, error: "no_key" });
  expect(await translateProductFieldsWithModelCapacity([task], job, { timeoutMs: 20_000 })).toEqual({ kind: "result", result: { ok: false, error: "no_key" } });
  expect(mocks.control).not.toHaveBeenCalled();
});
it("reuses the pending ID and settles the actual terminal before returning the writer expectation", async () => {
  mocks.pending.mockResolvedValue({ requestId: reservation.requestId, state: "waiting" });
  expect(await translateProductFieldsWithModelCapacity([task], job, options())).toEqual({ kind: "result", result, expectation });
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ requestId: reservation.requestId,
    workKey: `${productTranslationLogicalWorkKey(members)}:${productTranslationInputHash({ members, model: TRANSLATE_MODEL })}` }), members);
  expect(mocks.native).toHaveBeenCalledWith([item], dispatch, call, expect.objectContaining({ timeoutMs: 20_000 }));
  expect(mocks.reconcile).toHaveBeenCalledWith(terminal); expect(mocks.legacy).not.toHaveBeenCalled();
});
it("refuses the unsupported production contract before reserving or writing", async () => {
  mocks.call.mockReturnValue({ kind: "unsupported", reason: "provider_contract_unavailable" });
  await expect(translateProductFieldsWithModelCapacity([task], job, options())).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it("preserves a queued capacity defer and never calls the legacy fallback", async () => {
  mocks.request.mockResolvedValue({ kind: "deferred", reason: "capacity" });
  await expect(translateProductFieldsWithModelCapacity([task], job, options())).rejects.toBeInstanceOf(ModelCapacityDeferredError);
  expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
});
it("holds full C for EOF and preserves a failure result together with an unknown-recording failure", async () => {
  const cleanup = new Error("unknown write failed"); mocks.native.mockResolvedValue({ result: failure, terminal: null }); mocks.unknown.mockRejectedValue(cleanup);
  await expect(translateProductFieldsWithModelCapacity([task], job, options())).rejects.toMatchObject({ errors: [failure, cleanup] });
  expect(mocks.reconcile).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
});

// Actual domain code, with the DB driver boundary recorded rather than executed.
import { PgDialect } from "drizzle-orm/pg-core";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
function domainTx(raw = { product_id: source.id, locale: "en", field: "tagline", source_hash: task.sourceHash,
  attempts: 0, status: "pending", updated_at: "2026-10-16T01:02:03.000123", retry_at: null }) {
  const queries: string[] = [];
  const execute = vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
    const text = new PgDialect().sqlToQuery(query).sql; queries.push(text);
    if (text.includes("to_jsonb(r)")) return [{ raw: { role: "text", owner_instance_id: role.instanceId, owner_boot_id: role.bootId,
      owner_release: role.release, owner_kind: "standby", epoch: 1 } }];
    if (text.includes("FROM role_leases")) return [{ live: true, role_live: true, job_live: true }];
    if (text.includes("AS eligible")) return [{ ...source, slug: "product-unit", description: "", eligible: true }];
    if (text.includes("FROM products")) return [{ id: source.id, slug: "product-unit" }];
    if (text.includes("to_jsonb(t)")) return [{ raw: structuredClone(raw), due: true }];
    if (text.includes("FROM model_capacity_requests")) return [{ live: true }];
    throw new Error("unexpected_unit_domain_query");
  });
  const tx = { execute, select: () => ({ from: () => ({ where: () => ({ for: async () => [{ ...source, eligible: true }] }) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: source.id }] }) }) }) };
  mocks.transaction.mockImplementation(async run => run(tx)); mocks.generation.mockResolvedValue(true);
  return { queries, execute, raw };
}
it("reads locked demand microseconds and actual standby identity after the product generation barrier", async () => {
  const tx = domainTx();
  const domain = await vi.importActual<typeof import("@/lib/domain/products/translations")>("@/lib/domain/products/translations");
  const actual = await domain.prepareProductTranslationDispatch([task], job, { roleLease: role, call });
  expect(actual).toMatchObject({ kind: "ready", members: [{ ...members[0], demand: { attempts: 0, rowIdentityHash: reviewHash(tx.raw) } }],
    role: { kind: "standby", instanceId: role.instanceId } });
  expect(mocks.generation).toHaveBeenCalledWith(expect.anything(), source.id, "product-unit");
  expect(tx.queries.findIndex(text => text.includes("AS eligible"))).toBeLessThan(tx.queries.findIndex(text => text.includes("to_jsonb(t)")));
});
it("rejects a microsecond-only demand replacement before finishing a reserved dispatch", async () => {
  domainTx({ product_id: source.id, locale: "en", field: "tagline", source_hash: task.sourceHash,
    attempts: 0, status: "pending", updated_at: "2026-10-16T01:02:03.000124", retry_at: null });
  mocks.prefix.mockResolvedValue({ control: await mocks.control() });
  const domain = await vi.importActual<typeof import("@/lib/domain/products/translations")>("@/lib/domain/products/translations");
  const identity = { owner: reservation.owner, workKey: `${productTranslationLogicalWorkKey(members)}:${productTranslationInputHash({ members, model: TRANSLATE_MODEL })}`,
    class: "background" as const, pool: "text" as const, provider: "abcllm", routeId: "product-translate", model: TRANSLATE_MODEL };
  expect(await domain.prepareProductTranslationDispatch([task], job, { roleLease: role, call,
    reserved: { reservation, identity, members, role: { ...boundRole, kind: "standby" } } })).toEqual({ kind: "skipped" });
  expect(mocks.finish).not.toHaveBeenCalled();
});
it("returns a failed generation recheck from takedown without inserting or logging success", async () => {
  mocks.product.mockResolvedValue({ ...source, slug: "product-unit", url: "https://product.test", status: "seeded", source: "crawler", claimedAt: null });
  mocks.generation.mockResolvedValue(false);
  const insert = vi.fn(() => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }));
  const query = { where: () => ({ for: async () => [] }) };
  mocks.transaction.mockImplementation(async run => run({ select: () => ({ from: () => query }), insert }));
  const takedown = await vi.importActual<typeof import("@/lib/domain/products/takedown")>("@/lib/domain/products/takedown");
  expect(await takedown.requestTakedown("product-unit")).toEqual({ ok: false, error: { kind: "not_found" } });
  expect(insert).not.toHaveBeenCalled(); expect(mocks.log).not.toHaveBeenCalled();
});

it("rejects a copied positive writer capability before any transaction", async () => {
  const domain = await vi.importActual<typeof import("@/lib/domain/products/translations")>("@/lib/domain/products/translations");
  await expect(domain.recordProductTranslations([], job, { kind: "product_translation_write" })).rejects.toThrow("invalid_product_translation_write_expectation");
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("does not overwrite a microsecond-only demand replacement after native dispatch", async () => {
  const tx = domainTx();
  mocks.prefix.mockResolvedValue({ control: await mocks.control() });
  mocks.finish.mockImplementation(async (_tx, _lock, binding) => ({ ...reservation, binding, bindingHash: "f".repeat(64) }));
  const domain = await vi.importActual<typeof import("@/lib/domain/products/translations")>("@/lib/domain/products/translations");
  const actualMembers = [{ ...members[0], demand: { rowIdentityHash: reviewHash(tx.raw), attempts: 0 } }];
  const identity = { owner: reservation.owner,
    workKey: `${productTranslationLogicalWorkKey(actualMembers)}:${productTranslationInputHash({ members: actualMembers, model: TRANSLATE_MODEL })}`,
    class: "background" as const, pool: "text" as const, provider: "abcllm", routeId: "product-translate", model: TRANSLATE_MODEL };
  const prepared = await domain.prepareProductTranslationDispatch([task], job, { roleLease: role, call,
    reserved: { reservation, identity, members: actualMembers, role: { ...boundRole, kind: "standby" } } });
  expect(prepared.kind).toBe("ready"); if (!("expectation" in prepared)) throw new Error("unit_missing_dispatch");
  tx.raw.updated_at = "2026-10-16T01:02:03.000124";
  expect(await domain.recordProductTranslations([{ task, result: { ok: true, text: result.outputs[0], model: TRANSLATE_MODEL } }], job, prepared.expectation)).toBe(0);
});
it("routes the real product job through capacity and carries the committed writer expectation", async () => {
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: "text", ROLE_LEASE_INSTANCE_ID: role.instanceId,
    ROLE_LEASE_BOOT_ID: role.bootId, ROLE_LEASE_RELEASE: role.release, ROLE_LEASE_EPOCH: String(role.epoch) })) vi.stubEnv(key, value);
  mocks.tasks.mockResolvedValue([task]); mocks.write.mockResolvedValue(1);
  const { translateDemandedProductFields } = await vi.importActual<typeof import("@/lib/jobs/products/translations")>("@/lib/jobs/products/translations");
  await translateDemandedProductFields({ lease: job, hasBudget: () => true, log: vi.fn() } as unknown as Parameters<typeof translateDemandedProductFields>[0]);
  expect(mocks.native).toHaveBeenCalledTimes(1);
  expect(mocks.write.mock.calls[0][2]).toBe(expectation);
});
it("waits for reserved commit acknowledgement before native HTTP", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  mocks.prepare.mockReset().mockResolvedValueOnce({ kind: "ready", members, role: boundRole }).mockImplementation(async () => {
    await gate; return { kind: "ready", dispatch, expectation };
  });
  const running = translateProductFieldsWithModelCapacity([task], job, options()); void running.catch(() => {});
  try { await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2)); expect(mocks.native).not.toHaveBeenCalled(); }
  finally { release(); }
  expect(await running).toEqual({ kind: "result", result, expectation });
});
it("does not downgrade a reserved admission to legacy when disabled during reentry", async () => {
  mocks.prepare.mockReset().mockResolvedValueOnce({ kind: "ready", members, role: boundRole }).mockResolvedValue({ kind: "disabled" });
  await expect(translateProductFieldsWithModelCapacity([task], job, options())).rejects.toMatchObject({ reason: "disabled" });
  expect(mocks.cancel).toHaveBeenCalledWith(reservation); expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it("preserves the actual native thrown error and a failed unknown recording together", async () => {
  const original = new Error("original native failure"), cleanup = new Error("recording failure");
  mocks.native.mockRejectedValue(original); mocks.unknown.mockRejectedValue(cleanup);
  await expect(translateProductFieldsWithModelCapacity([task], job, options())).rejects.toMatchObject({ errors: [original, cleanup] });
  expect(mocks.cancel).not.toHaveBeenCalled();
});
it("refuses an already indeterminate pending ID without another reservation or POST", async () => {
  mocks.pending.mockResolvedValue({ requestId: reservation.requestId, state: "indeterminate" });
  await expect(translateProductFieldsWithModelCapacity([task], job, options())).rejects.toMatchObject({ reason: "dispatched" });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it("settles a terminal even if the caller aborts before native returns", async () => {
  const controller = new AbortController();
  mocks.native.mockImplementation(async () => { controller.abort(); return { result: failure, terminal }; });
  expect(await translateProductFieldsWithModelCapacity([task], job, { ...options(), signal: controller.signal }))
    .toEqual({ kind: "result", result: failure, expectation });
  expect(mocks.reconcile).toHaveBeenCalledWith(terminal); expect(mocks.unknown).not.toHaveBeenCalled();
});
