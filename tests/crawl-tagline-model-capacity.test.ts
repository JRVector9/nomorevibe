import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { crawlTaglineInputHash, crawlTaglineLogicalWorkKey, modelCapacityReservationSchema, crawlTaglineMemberKeys, type CrawlTaglineMember } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
const mocks = vi.hoisted(() => ({ control: vi.fn(), prepare: vi.fn(), history: vi.fn(), resume: vi.fn(), call: vi.fn(), pending: vi.fn(),
  request: vi.fn(), cancel: vi.fn(), native: vi.fn(), reconcile: vi.fn(), unknown: vi.fn(), legacy: vi.fn(), transaction: vi.fn(),
  prefix: vi.fn(), finish: vi.fn(), batch: vi.fn(), jobWall: vi.fn(), tasks: vi.fn(), write: vi.fn(), settings: vi.fn(), stage: vi.fn(), wake: vi.fn() }));
vi.mock("@/lib/crawl/taglines", () => ({ prepareCrawlTaglineDispatch: mocks.prepare, prepareCrawlTaglineHistory: mocks.resume,
  pendingTaglines: mocks.tasks, recordTaglineResult: mocks.write }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: mocks.control, lockModelCapacityCallerControl: mocks.control,
  findOwnPendingModelRequest: mocks.pending, requestCrawlTaglineModelSlot: mocks.request, cancelReservedModelSlot: mocks.cancel,
  markModelDispatchIndeterminate: mocks.unknown, reconcileCrawlTaglineGatewayTerminal: mocks.reconcile,
  readCrawlTaglineContinuation: mocks.history, lockCrawlTaglineModelCapacityDispatch: mocks.prefix, finishCrawlTaglineModelCapacityDispatch: mocks.finish }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ prepareCrawlTaglineGatewayCall: mocks.call, writeTaglineWithReservedGateway: mocks.native,
  readCrawlTaglineGatewayTerminal: () => ({ dispatch: { ...dispatch, bindingHash: parent.bindingHash }, responseHash: parent.responseHash }) }));
vi.mock("@/lib/crawl/tagline", async load => ({ ...await load<typeof import("@/lib/crawl/tagline")>(), writeTagline: mocks.legacy }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction }, onPrimary: (run: () => unknown) => run() }));
vi.mock("@/lib/jobs/batch-repository", () => ({ assertJobBatchAdmission: mocks.batch }));
vi.mock("@/lib/jobs/control", async load => ({ ...await load<typeof import("@/lib/jobs/control")>(),
  assertJobLeaseAtWallTime: mocks.jobWall, requestJob: mocks.wake }));
vi.mock("@/lib/crawl/pipeline-stage-context", () => ({ lockPipelineInputStages: mocks.stage }));
vi.mock("@/lib/crawl/settings", async load => ({ ...await load<typeof import("@/lib/crawl/settings")>(), getSettings: mocks.settings }));
import { writeCrawlTaglineWithModelCapacity } from "@/lib/crawl/tagline-model-capacity";
import { TAGLINE_MODEL, taglineEvidence, taglineHash } from "@/lib/crawl/tagline";
import type { TaglineTask } from "@/lib/crawl/taglines";
const at = new Date("2026-10-17T01:02:03.000Z"), task: TaglineTask = { candidate: { id: 17, repo: "fixture/doc", productUrl: "https://doc.test",
  state: "needs_review", reason: "no_description", decidedBy: "auto", signals: null, publishedSlug: null, judgedAt: null, decidedAt: null, updatedAt: at },
  document: { id: 18, repo: "fixture/doc", repoMeta: {}, productUrl: "https://doc.test", pageStatus: 200,
    pageMeta: { title: "Doc", textSample: "Document manager" }, fetchedAt: at }, written: null, readyAgeMinutes: 1 };
const role = { role: "text" as const, instanceId: "crawl-unit", bootId: randomUUID(), release: "unit", epoch: 1, kind: "primary" as const };
const job = { name: "crawl-tagline", token: randomUUID(), requestedVersion: 3 };
const member: CrawlTaglineMember = { candidateId: 17, repo: task.candidate.repo, sourceHash: taglineHash(taglineEvidence(task.candidate.repo, task.document)),
  candidateRowIdentityHash: "a".repeat(64), documentRowIdentityHash: "b".repeat(64), cache: { kind: "absent" } };
const boundRole = { ...role, batch: { mode: "legacy" as const } };
const call = { kind: "prepared" as const, model: TAGLINE_MODEL, sourceHash: member.sourceHash, wireHash: "c".repeat(64), servingContractHash: "d".repeat(64), totalTokenBound: 4096 };
const reservation = modelCapacityReservationSchema.parse({ requestId: randomUUID(), token: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId }, epoch: 1, revision: 1, policyHash: "e".repeat(64) });
const dispatch = { ...reservation, binding: { kind: "crawl_tagline_gateway" } }, expectation = { kind: "crawl_tagline_write" as const };
const result = { ok: true as const, tagline: "Document manager", source: "page" as const }, empty = { ...result, tagline: "" };
const parent = { requestId: reservation.requestId, bindingHash: "f".repeat(64), responseHash: "1".repeat(64) };
const terminal = { kind: "crawl_tagline_gateway_terminal" };
const options = () => ({ timeoutMs: 45_000, roleLease: role });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("ABCLLM_API_KEY", "unit");
  mocks.control.mockResolvedValue({ mode: "open", policy: { routes: [{ routeId: "crawl-tagline", provider: "abcllm", model: TAGLINE_MODEL }] } });
  mocks.call.mockReturnValue(call); mocks.prepare.mockResolvedValueOnce({ kind: "ready", member, role: boundRole, snapshot: {} })
    .mockResolvedValue({ kind: "ready", dispatch, expectation });
  mocks.pending.mockResolvedValue(null); mocks.history.mockResolvedValue(null);
  mocks.request.mockResolvedValue({ kind: "granted", reservation }); mocks.native.mockResolvedValue({ result, terminal });
  mocks.reconcile.mockResolvedValue({ kind: "settled" }); mocks.unknown.mockResolvedValue(true); mocks.cancel.mockResolvedValue(true);
  mocks.resume.mockResolvedValue({ kind: "result", result: empty, askOrdinal: 1, parent, expectation });
  mocks.settings.mockResolvedValue({ enabled: true }); mocks.write.mockResolvedValue({ stored: true, released: true });
});
afterEach(() => vi.unstubAllEnvs());
it("defers an unsupported production contract before request, attempt or POST", async () => {
  mocks.call.mockReturnValue({ kind: "unsupported", reason: "provider_contract_unavailable" });
  await expect(writeCrawlTaglineWithModelCapacity(task, job, options())).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
});
it("returns disabled without reading positive history or preparing a model", async () => {
  mocks.control.mockResolvedValue({ mode: "disabled" });
  expect(await writeCrawlTaglineWithModelCapacity(task, job, options())).toEqual({ kind: "disabled" });
  expect(mocks.call).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled();
});
it("reuses the same waiting ID with exact phase input", async () => {
  mocks.pending.mockResolvedValue({ requestId: reservation.requestId, state: "waiting" });
  mocks.request.mockResolvedValue({ kind: "deferred", reason: "capacity" });
  await expect(writeCrawlTaglineWithModelCapacity(task, job, options())).rejects.toBeInstanceOf(ModelCapacityDeferredError);
  const input = { member, model: TAGLINE_MODEL, askOrdinal: 1 as const, parent: null };
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ requestId: reservation.requestId,
    workKey: `${crawlTaglineLogicalWorkKey(input)}:${crawlTaglineInputHash(input)}` }), input);
  expect(mocks.native).not.toHaveBeenCalled();
});
it("never retransmits a dispatched or indeterminate full work key", async () => {
  mocks.pending.mockResolvedValue({ requestId: reservation.requestId, state: "indeterminate" });
  await expect(writeCrawlTaglineWithModelCapacity(task, job, options())).rejects.toMatchObject({ reason: "dispatched" });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it("settles physical history before returning a current writer", async () => {
  expect(await writeCrawlTaglineWithModelCapacity(task, job, options())).toMatchObject({ kind: "result", askOrdinal: 1, result, expectation });
  expect(mocks.reconcile).toHaveBeenCalledWith(terminal);
  expect(mocks.native.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.prepare.mock.invocationCallOrder.at(-1)!);
});
it("keeps the returned failure identity ahead of cleanup error", async () => {
  const failure = { ok: false, error: "network" }, cleanup = new Error("cleanup");
  mocks.native.mockResolvedValue({ result: failure, terminal: null }); mocks.unknown.mockRejectedValue(cleanup);
  const error = await writeCrawlTaglineWithModelCapacity(task, job, options()).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0]).toBe(failure); expect(error.errors[1]).toBe(cleanup);
});
it("preserves reservation rejection and cleanup identity", async () => {
  const failure = new Error("admission"), cleanup = new Error("cancel"); mocks.prepare.mockReset().mockRejectedValueOnce(failure); // initial read failure owns no slot
  await expect(writeCrawlTaglineWithModelCapacity(task, job, options())).rejects.toBe(failure);
  expect(mocks.cancel).not.toHaveBeenCalled();
  mocks.prepare.mockResolvedValueOnce({ kind: "ready", member, role: boundRole, snapshot: {} }).mockRejectedValueOnce(failure);
  mocks.cancel.mockRejectedValueOnce(cleanup);
  const error = await writeCrawlTaglineWithModelCapacity(task, job, options()).catch(error => error);
  expect(error.errors).toEqual([failure, cleanup]);
});
it("resumes a settled second with writer only and no third ask", async () => {
  const second = { ...parent, requestId: randomUUID() }; mocks.history.mockResolvedValue({ first: { ...parent, outcome: empty }, second: { ...second, outcome: result } });
  mocks.resume.mockResolvedValue({ kind: "result", askOrdinal: 2, result, parent: second, expectation });
  expect(await writeCrawlTaglineWithModelCapacity(task, job, options())).toMatchObject({ askOrdinal: 2, result });
  expect(mocks.resume).toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it("resumes a settled first nonempty with writer only", async () => {
  mocks.history.mockResolvedValue({ first: { ...parent, outcome: result }, second: null });
  mocks.resume.mockResolvedValue({ kind: "result", askOrdinal: 1, result, parent, expectation });
  expect(await writeCrawlTaglineWithModelCapacity(task, job, options())).toMatchObject({ result });
  expect(mocks.native).not.toHaveBeenCalled();
});
it("rejects outcome JSON as writer authority before any SQL", async () => {
  const domain = await vi.importActual<typeof import("@/lib/crawl/taglines")>("@/lib/crawl/taglines");
  const failure = await domain.recordTaglineResult(task, job, { kind: "success", tagline: result.tagline, source: "page", model: TAGLINE_MODEL },
    { kind: "crawl_tagline_write" }).catch(error => error);
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(failure.message).toBe("invalid_crawl_tagline_write_expectation");
});
it("does not downgrade a positive first to legacy ask2 after disabled transition", async () => {
  mocks.native.mockResolvedValue({ result: empty, terminal });
  const first = await writeCrawlTaglineWithModelCapacity(task, job, options());
  if (first.kind !== "result") throw new Error("unit_first_required");
  mocks.control.mockResolvedValue({ mode: "disabled" });
  await expect(writeCrawlTaglineWithModelCapacity(task, job, { ...options(), previous: first })).rejects.toMatchObject({ reason: "disabled" });
  expect(mocks.native).toHaveBeenCalledTimes(1); expect(mocks.legacy).not.toHaveBeenCalled();
});
it("re-enters a deferred second on the next tick without asking first again", async () => {
  mocks.history.mockResolvedValue({ first: { ...parent, outcome: empty }, second: null });
  const first = await writeCrawlTaglineWithModelCapacity(task, job, options());
  if (first.kind !== "result") throw new Error("unit_history_first_required");
  mocks.prepare.mockResolvedValueOnce({ kind: "ready", member, role: boundRole, snapshot: {} });
  const waiting = randomUUID(); mocks.pending.mockResolvedValue({ requestId: waiting, state: "waiting" });
  mocks.request.mockResolvedValueOnce({ kind: "deferred", reason: "capacity" });
  await expect(writeCrawlTaglineWithModelCapacity(task, job, { ...options(), previous: first })).rejects.toMatchObject({ reason: "capacity" });
  // 새 tick: reader가 first-empty를 다시 주며 job은 ask2 조건을 다시 평가한다.
  mocks.prepare.mockResolvedValueOnce({ kind: "ready", member, role: boundRole, snapshot: {} });
  const resumed = await writeCrawlTaglineWithModelCapacity(task, job, options());
  if (resumed.kind !== "result") throw new Error("unit_history_first_required");
  mocks.prepare.mockResolvedValueOnce({ kind: "ready", member, role: boundRole, snapshot: {} }).mockResolvedValueOnce({ kind: "ready", dispatch, expectation });
  expect(await writeCrawlTaglineWithModelCapacity(task, job, { ...options(), previous: resumed })).toMatchObject({ askOrdinal: 2, result });
  expect(mocks.request.mock.calls.map(([request, input]) => [request.requestId, input.askOrdinal])).toEqual([[waiting, 2], [waiting, 2]]);
  expect(mocks.native).toHaveBeenCalledTimes(1); expect(mocks.write).not.toHaveBeenCalled();
});
it("no-key, settings-disabled, reuse and no-evidence jobs remain model-free", async () => {
  const { writeTaglines } = await import("@/lib/crawl/jobs/tagline");
  const ctx = { lease: job, cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn() };
  // 키가 없으면 부르지 않는다 — 성공이 아니라 제 일 못 함(no_key)으로 넘긴다
  vi.stubEnv("ABCLLM_API_KEY", ""); expect(await writeTaglines(ctx)).toEqual({ done: true, degraded: { code: "no_key", detail: "text 워커에 ABCLLM_API_KEY 가 없습니다" } });
  vi.stubEnv("ABCLLM_API_KEY", "unit"); mocks.settings.mockResolvedValueOnce({ enabled: false });
  expect(await writeTaglines(ctx)).toEqual({ done: true });
  const reuse = { ...task, written: { sourceHash: member.sourceHash, errorCode: null } } as TaglineTask;
  const noEvidence = { ...task, document: { ...task.document, pageMeta: {} } };
  mocks.tasks.mockResolvedValueOnce([reuse, noEvidence]).mockResolvedValue([]);
  expect(await writeTaglines(ctx)).toEqual({ done: true });
  expect(mocks.control).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
  expect(mocks.write.mock.calls.map(call => call[2].kind)).toEqual(["reuse", "success"]);
});
it("disabled job forwards the original evidence, signal and recalculated timeout for two asks", async () => {
  const { writeTaglines } = await import("@/lib/crawl/jobs/tagline"); mocks.control.mockResolvedValue({ mode: "disabled" });
  mocks.tasks.mockResolvedValueOnce([task]).mockResolvedValue([]); mocks.legacy.mockResolvedValueOnce(empty).mockResolvedValueOnce(result);
  const controller = new AbortController();
  expect(await writeTaglines({ lease: job, cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn(), signal: controller.signal })).toEqual({ done: true });
  expect(mocks.legacy).toHaveBeenCalledTimes(2);
  for (const [evidence, options] of mocks.legacy.mock.calls) {
    expect(evidence).toEqual(taglineEvidence(task.candidate.repo, task.document)); expect(options.timeoutMs).toBe(45_000);
    expect(options.signal).toBeInstanceOf(AbortSignal); expect(options.signal.aborted).toBe(false);
  }
  expect(mocks.write).toHaveBeenCalledTimes(1); expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
});

import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { crawlTaglineDispatchBindingHash, crawlTaglineGenerationHash } from "@/lib/llm/capacity";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
function domainTx(present = false) {
  const candidate = { row: structuredClone(task.candidate), raw: { ...task.candidate, updated_at: "2026-10-17T01:02:03.000123" } };
  const document = { row: structuredClone(task.document), raw: { ...task.document, fetched_at: "2026-10-17T01:02:03.000123" } };
  const written = { repo: task.candidate.repo, tagline: "", source: "page" as const, model: "fixture", sourceHash: "0".repeat(64), documentAt: at,
    attempts: 2, errorCode: "network", retryAt: null, writtenBy: null, createdAt: at, updatedAt: at };
  const state = { cache: present ? { row: written, raw: { ...written, document_at: "2026-10-17T01:02:03.000123", updated_at: "2026-10-17T01:02:03.000123", attempts: 2 }, due: true } : null,
    request: null as Record<string, unknown> | null, second: null as string | null, insertWins: true, roleLive: true, jobLive: true, requestLive: true };
  const queries: { sql: string; params: unknown[] }[] = [], tables: string[] = [], writes: string[] = [];
  const tx = {
    execute: vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const q = new PgDialect().sqlToQuery(query); queries.push(q);
      if (q.sql.includes("to_jsonb(r)")) return [{ raw: { owner_instance_id: role.instanceId, owner_boot_id: role.bootId, owner_release: role.release, epoch: role.epoch, owner_kind: "standby" } }];
      if (q.sql.includes("AS role_live")) return [{ role_live: state.roleLive, job_live: state.jobLive, live: state.requestLive }];
      throw new Error("unexpected_crawl_query");
    }),
    select: vi.fn(() => ({ from: (table: Parameters<typeof getTableName>[0]) => {
      const name = getTableName(table); tables.push(name);
      const rows = () => name === "crawl_candidates" ? [structuredClone(candidate)] : name === "crawl_documents" ? [structuredClone(document)]
        : name === "crawl_settings" ? [{ values: { enabled: true } }] : name === "crawl_taglines" ? state.cache ? [structuredClone(state.cache)] : []
        : name === "model_capacity_requests" ? state.request ? [structuredClone(state.request)] : [] : [];
      return { where: (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        const q = new PgDialect().sqlToQuery(query); queries.push(q);
        return { for: async () => rows(), orderBy: () => ({ for: async () => [] }), limit: async () => state.second && q.params.includes(state.second) ? [{ id: randomUUID() }] : [] };
      } };
    } })),
    insert: vi.fn((table: Parameters<typeof getTableName>[0]) => ({ values: () => ({ onConflictDoNothing: () => {
      if (getTableName(table) === "jobs") return Promise.resolve([]);
      writes.push("cache"); return { returning: async () => state.insertWins ? [{ repo: task.candidate.repo }] : [] };
    } }) })),
    update: vi.fn((table: Parameters<typeof getTableName>[0]) => ({ set: () => ({ where: (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      queries.push(new PgDialect().sqlToQuery(query)); writes.push(getTableName(table));
      return { returning: async () => [{ repo: task.candidate.repo, id: task.candidate.id }] };
    } }) })),
  };
  mocks.transaction.mockImplementation(async run => run(tx));
  return { state, candidate, document, queries, tables, writes, tx, task: present ? { ...task, written } : task };
}
async function domainDispatch(t: ReturnType<typeof domainTx>) {
  const domain = await vi.importActual<typeof import("@/lib/crawl/taglines")>("@/lib/crawl/taglines");
  const initial = await domain.prepareCrawlTaglineDispatch(t.task, job, { roleLease: role });
  if (!("snapshot" in initial)) throw new Error("unit_initial_required");
  mocks.prefix.mockResolvedValue({ control: await mocks.control() });
  mocks.finish.mockImplementation(async (_tx, _lock, binding) => ({ ...reservation, binding, bindingHash: crawlTaglineDispatchBindingHash(binding) }));
  const input = { member: initial.member, model: TAGLINE_MODEL, askOrdinal: 1 as const, parent: null };
  const identity = { owner: reservation.owner, class: "background" as const, pool: "text" as const, routeId: "crawl-tagline", provider: "abcllm", model: TAGLINE_MODEL,
    workKey: `${crawlTaglineLogicalWorkKey(input)}:${crawlTaglineInputHash(input)}` };
  const reserved = { reservation, identity, input, initial };
  const prepared = await domain.prepareCrawlTaglineDispatch(t.task, job, { roleLease: role, call: { ...call, sourceHash: initial.member.sourceHash }, reserved });
  if (!("dispatch" in prepared)) throw new Error("unit_dispatch_required");
  const d = prepared.dispatch;
  t.state.request = { ...d, state: "indeterminate", dispatchBinding: d.binding, dispatchBindingHash: d.bindingHash,
    ownerInstanceId: d.owner.instanceId, ownerBootId: d.owner.bootId, class: "background", pool: "text", routeId: "crawl-tagline", provider: "abcllm", model: TAGLINE_MODEL,
    workKey: `${d.binding.logicalWorkKey}:${d.binding.inputHash}`, logicalWorkKey: d.binding.logicalWorkKey, logicalMemberKeys: crawlTaglineMemberKeys(d.binding.member) };
  return { domain, initial, prepared, reserved };
}
it("uses locked raw microseconds and actual standby kind and checks the wall after dispatch event", async () => {
  const t = domainTx(), { initial, prepared } = await domainDispatch(t);
  expect(initial.member.candidateRowIdentityHash).toBe(reviewHash(t.candidate.raw));
  expect(initial.role.kind).toBe("standby"); expect(prepared.dispatch.binding.role.kind).toBe("standby");
  expect(t.tx.execute.mock.invocationCallOrder.at(-1)).toBeGreaterThan(mocks.finish.mock.invocationCallOrder[0]);
  expect(t.queries.at(-1)!.sql).toContain("reserved_until>clock_timestamp()");
  expect(t.tables.slice(0, 5)).toEqual(["crawl_candidates", "crawl_documents", "crawl_settings", "crawl_taglines", "jobs"]);
});
it("rejects a microsecond-only change before POST reentry", async () => {
  const t = domainTx(true), { domain, reserved } = await domainDispatch(t);
  t.state.cache!.raw.updated_at = "2026-10-17T01:02:03.000124";
  mocks.finish.mockClear();
  expect(await domain.prepareCrawlTaglineDispatch(t.task, job, { roleLease: role, call, reserved })).toMatchObject({ kind: "skipped" });
  expect(mocks.finish).not.toHaveBeenCalled();
});
it("lets disabled legacy replacement win against an older positive full raw writer", async () => {
  const t = domainTx(true), { domain, prepared } = await domainDispatch(t);
  mocks.control.mockResolvedValue({ mode: "disabled" }); t.state.cache!.raw.updated_at = "2026-10-17T01:02:03.000124";
  expect(await domain.recordTaglineResult(t.task, job, { kind: "failure", error: "network" }, prepared.expectation)).toEqual({ stored: false, released: false });
  expect(t.writes).toEqual([]); expect(mocks.wake).not.toHaveBeenCalled();
});
it("preserves an absent-cache insert winner and never wakes publish", async () => {
  const t = domainTx(), { domain, prepared } = await domainDispatch(t); t.state.insertWins = false;
  expect(await domain.recordTaglineResult(t.task, job, { kind: "success", tagline: result.tagline, source: "page", model: TAGLINE_MODEL }, prepared.expectation))
    .toEqual({ stored: false, released: false });
  expect(t.writes).toEqual(["cache"]); expect(mocks.wake).not.toHaveBeenCalled();
});
it.each(["waiting", "reserved", "dispatched", "indeterminate", "settled"])("never writes final first-empty past a %s second", async state => {
  const t = domainTx(), { domain, prepared } = await domainDispatch(t); t.state.second = state;
  await expect(domain.recordTaglineResult(t.task, job, { kind: "success", tagline: "", source: "page", model: TAGLINE_MODEL }, prepared.expectation))
    .rejects.toMatchObject({ reason: "dispatched" });
  expect(t.writes).toEqual([]); expect(mocks.wake).not.toHaveBeenCalled();
});
it("keeps full raw cache CAS and the original backoff expression on a positive failure", async () => {
  const t = domainTx(true), { domain, prepared } = await domainDispatch(t);
  expect(await domain.recordTaglineResult(t.task, job, { kind: "failure", error: "network" }, prepared.expectation)).toEqual({ stored: true, released: false });
  const cas = t.queries.find(q => q.sql.includes("to_jsonb(\"crawl_taglines\")="));
  expect(cas?.params).toContain(JSON.stringify(t.state.cache!.raw)); expect(t.writes).toEqual(["crawl_taglines"]);
  await expect(domain.recordTaglineResult(t.task, job, { kind: "failure", error: "network" }, prepared.expectation)).rejects.toThrow("invalid_crawl_tagline_write_expectation");
});
function settleDomain(t: ReturnType<typeof domainTx>, prepared: Awaited<ReturnType<typeof domainDispatch>>["prepared"], outcome = result) {
  const d = prepared.dispatch, evidence = { version: 1, kind: "crawl_tagline_gateway_terminal", dispatch: d, finishReason: "stop",
    responseHash: parent.responseHash, actualUsage: null, provenance: "unknown", outcome };
  t.state.request = { ...t.state.request, state: "settled", settledAt: at, dispatchedAt: at, terminalEvidence: evidence, terminalEvidenceHash: reviewHash(evidence),
    ownerInstanceId: d.owner.instanceId, ownerBootId: d.owner.bootId, class: "background", pool: "text", routeId: "crawl-tagline", provider: "abcllm", model: TAGLINE_MODEL,
    workKey: `${d.binding.logicalWorkKey}:${d.binding.inputHash}`, logicalWorkKey: d.binding.logicalWorkKey, logicalMemberKeys: [`crawl-tagline:${task.candidate.id}`] };
  return { generationHash: crawlTaglineGenerationHash(d.binding), first: { requestId: d.requestId, bindingHash: d.bindingHash, responseHash: evidence.responseHash, outcome }, second: null };
}
it("rereads actual terminal rows before issuing a historical writer and denies a copied outcome", async () => {
  const t = domainTx(), { domain, initial, prepared } = await domainDispatch(t), history = settleDomain(t, prepared);
  const forged = structuredClone(history); forged.first.outcome.tagline = "Forged line";
  expect(await domain.prepareCrawlTaglineHistory(t.task, job, { initial, history: forged })).toMatchObject({ kind: "skipped" });
  const resumed = await domain.prepareCrawlTaglineHistory(t.task, job, { initial, history });
  expect(resumed).toMatchObject({ kind: "result", result, askOrdinal: 1 });
  expect(t.writes).toEqual([]); expect(mocks.native).not.toHaveBeenCalled();
});
it("allows first-empty to resume waiting phase2 but refuses its final writer", async () => {
  const t = domainTx(), { domain, initial, prepared } = await domainDispatch(t), history = settleDomain(t, prepared, empty);
  t.state.second = "waiting";
  const resumed = await domain.prepareCrawlTaglineHistory(t.task, job, { initial, history });
  if (resumed.kind !== "result") throw new Error("unit_history_required");
  expect(resumed.askOrdinal).toBe(1); expect(resumed.result).toEqual(empty);
  await expect(domain.recordTaglineResult(t.task, job, { kind: "success", tagline: "", source: "page", model: TAGLINE_MODEL }, resumed.expectation))
    .rejects.toMatchObject({ reason: "dispatched" });
  expect(t.writes).toEqual([]);
});
it("withholds current business write after settled history when the final job wall is expired", async () => {
  const t = domainTx(), { domain, prepared } = await domainDispatch(t); settleDomain(t, prepared); t.state.jobLive = false;
  await expect(domain.recordTaglineResult(t.task, job, { kind: "success", tagline: result.tagline, source: "page", model: TAGLINE_MODEL }, prepared.expectation))
    .rejects.toThrow("job_lease_lost");
  // Recording TX cannot prove rollback; actual PostgreSQL driver asserts final domain/outbox absence.
  expect(t.state.request?.state).toBe("settled");
});
it("never creates a third ask or retries an empty unknown transport", async () => {
  const previous = { kind: "result" as const, result: empty, parent, askOrdinal: 2 as const, expectation };
  await expect(writeCrawlTaglineWithModelCapacity(task, job, { ...options(), previous })).rejects.toThrow("invalid_crawl_tagline_second_ask");
  await expect(writeCrawlTaglineWithModelCapacity(task, job, { ...options(), previous: { ...previous, askOrdinal: 1, parent: null } }))
    .rejects.toMatchObject({ reason: "dispatched" });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});
it("refuses a mutated historical result even with its genuine writer capability", async () => {
  const t = domainTx(), { domain, initial, prepared } = await domainDispatch(t), history = settleDomain(t, prepared);
  const resumed = await domain.prepareCrawlTaglineHistory(t.task, job, { initial, history });
  if (resumed.kind !== "result") throw new Error("unit_history_required");
  expect(await domain.recordTaglineResult(t.task, job, { kind: "success", tagline: "Forged line", source: "page", model: TAGLINE_MODEL }, resumed.expectation))
    .toEqual({ stored: false, released: false });
  expect(t.writes).toEqual([]); expect(mocks.wake).not.toHaveBeenCalled();
});
