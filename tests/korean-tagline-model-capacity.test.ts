import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { productTaglineKoInputHash, productTaglineKoLogicalWorkKey, modelCapacityReservationSchema, type ProductTaglineKoMember } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { leadClause } from "@/lib/domain/products/korean-tagline";
const mocks = vi.hoisted(() => ({ control: vi.fn(), prepare: vi.fn(), legacy: vi.fn(), call: vi.fn(), pending: vi.fn(),
  request: vi.fn(), cancel: vi.fn(), native: vi.fn(), reconcile: vi.fn(), unknown: vi.fn(), transaction: vi.fn(), prefix: vi.fn(),
  finish: vi.fn(), batch: vi.fn(), jobWall: vi.fn(), tasks: vi.fn(), write: vi.fn(), home: vi.fn() }));
vi.mock("@/lib/domain/products/korean-taglines", () => ({ prepareKoreanTaglineDispatch: mocks.prepare,
  koreanTaglineSource: (task: { tagline: string; lastError?: string | null }) => task.lastError && ["rejected:too_long", "rejected:empty"].includes(task.lastError) ? leadClause(task.tagline) : task.tagline,
  homeListSlugs: mocks.home, pendingKoreanTaglines: mocks.tasks, recordKoreanTaglines: mocks.write }));
vi.mock("@/lib/crawl/translate", async original => ({ ...await original<typeof import("@/lib/crawl/translate")>(), translateTaglinesToKorean: mocks.legacy }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: mocks.control,
  findOwnPendingModelRequest: mocks.pending, requestProductTaglineKoModelSlot: mocks.request, cancelReservedModelSlot: mocks.cancel,
  markModelDispatchIndeterminate: mocks.unknown, reconcileProductTaglineKoGatewayTerminal: mocks.reconcile,
  lockModelCapacityCallerControl: mocks.control, lockProductTaglineKoModelCapacityDispatch: mocks.prefix,
  finishProductTaglineKoModelCapacityDispatch: mocks.finish }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ prepareProductTaglineKoGatewayCall: mocks.call, translateTaglinesWithReservedGateway: mocks.native }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction }, onPrimary: (run: () => unknown) => run() }));
vi.mock("@/lib/jobs/batch-repository", () => ({ assertJobBatchAdmission: mocks.batch }));
vi.mock("@/lib/jobs/control", () => ({ assertJobLease: mocks.jobWall, assertJobLeaseAtWallTime: mocks.jobWall }));
vi.mock("@/lib/domain/products/repository", () => ({ listProductSlugs: vi.fn() }));
vi.mock("@/lib/domain/products/popular", () => ({ getPopularGroups: vi.fn() }));
import { translateKoreanTaglinesWithModelCapacity } from "@/lib/domain/products/korean-tagline-model-capacity";
import { TRANSLATE_MODEL } from "@/lib/crawl/translate";
const task = { productId: 17, name: "owner/Doc", tagline: "Document management tools. Additional details for teams.", repoUrl: "https://github.com/owner/Doc", attempts: 9, lastError: "rejected:too_long" };
const item = { name: "Doc", tagline: leadClause(task.tagline) };
const role = { role: "text" as const, instanceId: "korean-unit", bootId: randomUUID(), release: "unit", epoch: 1, kind: "primary" as const };
const job = { name: "product-tagline-ko", token: randomUUID(), requestedVersion: 3 };
const members: ProductTaglineKoMember[] = [{ productId: task.productId, slug: "korean-unit", sourceHash: "a".repeat(64), sourceIdentityHash: "e".repeat(64),
  cache: { kind: "present", attempts: 9, qualityRejections: 4, rowIdentityHash: "f".repeat(64) } }];
const boundRole = { ...role, batch: { mode: "legacy" as const } };
const call = { kind: "prepared" as const, wireHash: "b".repeat(64), servingContractHash: "c".repeat(64), totalTokenBound: 4096, model: TRANSLATE_MODEL };
const reservation = modelCapacityReservationSchema.parse({ requestId: randomUUID(), token: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId }, epoch: 1, revision: 1, policyHash: "d".repeat(64) });
const dispatch = { ...reservation, binding: { kind: "product_tagline_ko_gateway" } };
const expectation = { kind: "korean_tagline_write" };
const result = { ok: true as const, outputs: ["문서를 관리하는 도구"] };
const failure = { ok: false as const, error: "network" };
const terminal = { kind: "product_tagline_ko_gateway_terminal" };
const options = () => ({ timeoutMs: 45_000, roleLease: role });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("ABCLLM_API_KEY", "unit");
  mocks.control.mockResolvedValue({ mode: "open", policy: { routes: [{ provider: "abcllm", routeId: "product-tagline-ko", model: TRANSLATE_MODEL }] } });
  mocks.call.mockReturnValue(call); mocks.prepare.mockResolvedValueOnce({ kind: "ready", members, role: boundRole })
    .mockResolvedValue({ kind: "ready", dispatch, expectation });
  mocks.pending.mockResolvedValue(null); mocks.request.mockResolvedValue({ kind: "granted", reservation });
  mocks.native.mockResolvedValue({ result, terminal }); mocks.reconcile.mockResolvedValue({ kind: "settled" });
  mocks.cancel.mockResolvedValue(true); mocks.unknown.mockResolvedValue(true); mocks.legacy.mockResolvedValue(result);
});
afterEach(() => vi.unstubAllEnvs());
it("preserves the disabled legacy ordered shortened wire and original rejection identity", async () => {
  mocks.control.mockResolvedValue({ mode: "disabled" });
  expect(await translateKoreanTaglinesWithModelCapacity([task], ["korean-unit"], job, { timeoutMs: 45_000 })).toEqual({ kind: "result", result });
  expect(mocks.legacy).toHaveBeenCalledWith([item], 45_000, undefined, undefined);
  expect(Object.keys(mocks.legacy.mock.calls[0][0][0])).toEqual(["name", "tagline"]);
  const original = new Error("legacy failure"); mocks.legacy.mockRejectedValue(original);
  await expect(translateKoreanTaglinesWithModelCapacity([task], [], job, options())).rejects.toBe(original);
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
});
it("preserves no_key without a model control read", async () => {
  vi.stubEnv("ABCLLM_API_KEY", ""); mocks.legacy.mockResolvedValue({ ok: false, error: "no_key" });
  expect(await translateKoreanTaglinesWithModelCapacity([task], [], job, options())).toEqual({ kind: "result", result: { ok: false, error: "no_key" } });
  expect(mocks.control).not.toHaveBeenCalled();
});
it("reuses the same pending ID and settles before returning a committed writer expectation", async () => {
  mocks.pending.mockResolvedValue({ requestId: reservation.requestId, state: "waiting" });
  expect(await translateKoreanTaglinesWithModelCapacity([task], ["korean-unit"], job, options())).toEqual({ kind: "result", result, expectation });
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ requestId: reservation.requestId,
    workKey: `${productTaglineKoLogicalWorkKey(members)}:${productTaglineKoInputHash({ members, model: TRANSLATE_MODEL })}` }), members);
  expect(mocks.native).toHaveBeenCalledWith([item], dispatch, call, expect.objectContaining({ timeoutMs: 45_000 }));
  expect(mocks.reconcile).toHaveBeenCalledWith(terminal); expect(mocks.legacy).not.toHaveBeenCalled();
});
it("refuses unsupported production before reserving", async () => {
  mocks.call.mockReturnValue({ kind: "unsupported", reason: "provider_contract_unavailable" });
  await expect(translateKoreanTaglinesWithModelCapacity([task], [], job, options())).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it("preserves queue defer without fallback", async () => {
  mocks.request.mockResolvedValue({ kind: "deferred", reason: "capacity" });
  await expect(translateKoreanTaglinesWithModelCapacity([task], [], job, options())).rejects.toBeInstanceOf(ModelCapacityDeferredError);
  expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
});
it("keeps a failed result and its full-C recording failure", async () => {
  const cleanup = new Error("unknown write failed"); mocks.native.mockResolvedValue({ result: failure, terminal: null }); mocks.unknown.mockRejectedValue(cleanup);
  await expect(translateKoreanTaglinesWithModelCapacity([task], [], job, options())).rejects.toMatchObject({ errors: [failure, cleanup] });
  expect(mocks.reconcile).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
});
it("waits for reserved commit acknowledgement before HTTP", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  mocks.prepare.mockReset().mockResolvedValueOnce({ kind: "ready", members, role: boundRole }).mockImplementation(async () => {
    await gate; return { kind: "ready", dispatch, expectation };
  });
  const running = translateKoreanTaglinesWithModelCapacity([task], [], job, options()); void running.catch(() => {});
  try { await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2)); expect(mocks.native).not.toHaveBeenCalled(); }
  finally { release(); }
  expect(await running).toEqual({ kind: "result", result, expectation });
});
it("cancels a reserved disabled reentry without downgrading to legacy", async () => {
  mocks.prepare.mockReset().mockResolvedValueOnce({ kind: "ready", members, role: boundRole }).mockResolvedValue({ kind: "disabled" });
  await expect(translateKoreanTaglinesWithModelCapacity([task], [], job, options())).rejects.toMatchObject({ reason: "disabled" });
  expect(mocks.cancel).toHaveBeenCalledWith(reservation); expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it("settles historical terminal even when the caller aborts", async () => {
  const controller = new AbortController(); mocks.native.mockImplementation(async () => { controller.abort(); return { result: failure, terminal }; });
  expect(await translateKoreanTaglinesWithModelCapacity([task], [], job, { ...options(), signal: controller.signal })).toEqual({ kind: "result", result: failure, expectation });
  expect(mocks.reconcile).toHaveBeenCalledWith(terminal); expect(mocks.unknown).not.toHaveBeenCalled();
});

// Recording the actual domain function at its DB driver boundary (no database).
import { PgDialect } from "drizzle-orm/pg-core";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
function domainTx(raw: Record<string, unknown> | null = { product_id: task.productId, source_tagline: task.tagline,
  attempts: 9, quality_rejections: 4, error_code: task.lastError, updated_at: "2026-10-16T01:02:03.000123", retry_at: null }) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const product = { id: task.productId, slug: "korean-unit", name: task.name, repoUrl: task.repoUrl, tagline: task.tagline, status: "seeded", needs: true };
  const execute = vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
    const q = new PgDialect().sqlToQuery(query); queries.push(q);
    if (q.sql.includes("to_jsonb(r)")) return [{ raw: { role: "text", owner_instance_id: role.instanceId, owner_boot_id: role.bootId,
      owner_release: role.release, owner_kind: "standby", epoch: 1 } }];
    if (q.sql.includes("FROM role_leases")) return [{ live: true, role_live: true, job_live: true }];
    if (q.sql.includes("FROM products")) return [product];
    if (q.sql.includes("to_jsonb(k)")) return raw ? [{ raw: structuredClone(raw), due: true }] : [];
    if (q.sql.includes("FROM model_capacity_requests")) return [{ live: true }];
    throw new Error("unexpected_korean_domain_query");
  });
  const tx = { execute, select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ for: async () => [] }), for: async () => [{ tagline: task.tagline, status: "seeded" }] }) }) }),
    insert: vi.fn(() => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) })) };
  mocks.transaction.mockImplementation(async run => run(tx));
  return { queries, execute, raw, product, tx };
}
it("derives home extra eligibility and raw counts beyond six from actual locked rows", async () => {
  const t = domainTx();
  const domain = await vi.importActual<typeof import("@/lib/domain/products/korean-taglines")>("@/lib/domain/products/korean-taglines");
  expect(await domain.prepareKoreanTaglineDispatch([task], ["korean-unit"], job, { roleLease: role, call })).toMatchObject({ kind: "ready",
    members: [{ productId: task.productId, cache: { kind: "present", attempts: 9, qualityRejections: 4, rowIdentityHash: reviewHash(t.raw) } }], role: { kind: "standby" } });
  expect(t.queries.findIndex(q => q.sql.includes("FROM products"))).toBeLessThan(t.queries.findIndex(q => q.sql.includes("to_jsonb(k)")));
});
it("keeps the ordinary four-rejection limit outside the home list", async () => {
  domainTx();
  const domain = await vi.importActual<typeof import("@/lib/domain/products/korean-taglines")>("@/lib/domain/products/korean-taglines");
  expect(await domain.prepareKoreanTaglineDispatch([task], [], job, { roleLease: role, call })).toEqual({ kind: "skipped" });
  expect(mocks.finish).not.toHaveBeenCalled();
});
it("locks every legacy product in sorted order before any cache upsert", async () => {
  const t = domainTx();
  const domain = await vi.importActual<typeof import("@/lib/domain/products/korean-taglines")>("@/lib/domain/products/korean-taglines");
  await domain.recordKoreanTaglines([{ task, result: { kind: "success", line: "문서를 관리하는 도구", model: TRANSLATE_MODEL } },
    { task: { ...task, productId: 3 }, result: { kind: "failure", error: "network", model: TRANSLATE_MODEL } }], job);
  const lock = t.queries.filter(q => q.sql.includes("FOR SHARE"));
  expect(lock.map(q => q.params[0])).toEqual([3, 17]);
  expect(t.execute.mock.invocationCallOrder.at(-1)).toBeLessThan(t.tx.insert.mock.invocationCallOrder[0]);
});
it("rejects a copied writer capability before SQL", async () => {
  const domain = await vi.importActual<typeof import("@/lib/domain/products/korean-taglines")>("@/lib/domain/products/korean-taglines");
  await expect(domain.recordKoreanTaglines([], job, { kind: "korean_tagline_write" })).rejects.toThrow("invalid_korean_tagline_write_expectation");
  expect(mocks.transaction).not.toHaveBeenCalled();
});
async function realDispatch(t: ReturnType<typeof domainTx>) {
  const domain = await vi.importActual<typeof import("@/lib/domain/products/korean-taglines")>("@/lib/domain/products/korean-taglines");
  const initial = await domain.prepareKoreanTaglineDispatch([task], ["korean-unit"], job, { roleLease: role, call });
  if (!("members" in initial)) throw new Error("unit_missing_members");
  mocks.prefix.mockResolvedValue({ control: await mocks.control() });
  mocks.finish.mockImplementation(async (_tx, _lock, binding) => ({ ...reservation, binding, bindingHash: "f".repeat(64) }));
  const identity = { owner: reservation.owner, class: "background" as const, pool: "text" as const, provider: "abcllm", routeId: "product-tagline-ko", model: TRANSLATE_MODEL,
    workKey: `${productTaglineKoLogicalWorkKey(initial.members)}:${productTaglineKoInputHash({ members: initial.members, model: TRANSLATE_MODEL })}` };
  const prepared = await domain.prepareKoreanTaglineDispatch([task], ["korean-unit"], job, { roleLease: role, call,
    reserved: { reservation, identity, members: initial.members, role: initial.role } });
  if (!("expectation" in prepared)) throw new Error("unit_missing_dispatch");
  expect(t.queries.at(-1)?.sql).toContain("reserved_until>clock_timestamp()");
  return { domain, prepared };
}
it("preserves a microsecond-only cache replacement after native dispatch and consumes writer once", async () => {
  const t = domainTx(), { domain, prepared } = await realDispatch(t);
  t.raw!.updated_at = "2026-10-16T01:02:03.000124";
  const entries = [{ task, result: { kind: "success" as const, line: "문서를 관리하는 도구", model: TRANSLATE_MODEL } }];
  expect(await domain.recordKoreanTaglines(entries, job, prepared.expectation)).toBe(0);
  expect(t.tx.insert).not.toHaveBeenCalled();
  await expect(domain.recordKoreanTaglines(entries, job, prepared.expectation)).rejects.toThrow("invalid_korean_tagline_write_expectation");
});
it("refuses a current name replacement even when tagline and cache are unchanged", async () => {
  const t = domainTx(), { domain, prepared } = await realDispatch(t);
  t.product.name = "Replacement";
  expect(await domain.recordKoreanTaglines([{ task, result: { kind: "failure", error: "network", model: TRANSLATE_MODEL } }], job, prepared.expectation)).toBe(0);
  expect(t.tx.insert).not.toHaveBeenCalled();
});
it("stops a positive zero-store before original success counters can certify work", async () => {
  mocks.home.mockResolvedValue(["korean-unit"]); mocks.tasks.mockResolvedValue([task]); mocks.write.mockResolvedValue(0);
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: "text", ROLE_LEASE_INSTANCE_ID: role.instanceId,
    ROLE_LEASE_BOOT_ID: role.bootId, ROLE_LEASE_RELEASE: role.release, ROLE_LEASE_EPOCH: "1" })) vi.stubEnv(key, value);
  const { writeKoreanTaglines } = await vi.importActual<typeof import("@/lib/jobs/products/korean-tagline")>("@/lib/jobs/products/korean-tagline");
  const log = vi.fn(); let reads = 0; mocks.tasks.mockImplementation(async () => ++reads === 1 ? [task] : []);
  expect(await writeKoreanTaglines({ lease: job, hasBudget: () => true, log } as unknown as Parameters<typeof writeKoreanTaglines>[0])).toEqual({ done: false });
  expect(mocks.write.mock.calls[0][2]).toBe(expectation); expect(mocks.native).toHaveBeenCalledTimes(1);
  expect(log.mock.calls.some(([event, data]) => event === "tagline_ko.done" && data.written > 0)).toBe(false);
});
