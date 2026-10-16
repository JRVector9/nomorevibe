import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { prepareAi1GatewayCall, reviewWithReservedAi1Gateway, type Ai1GatewayTerminal } from "@/lib/crawl/agent-review-gateway";
import type { Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import { modelCapacityPolicyHash, type Ai1DispatchBinding, type ModelCapacityPolicy,
  type ModelCapacityRequest, type ModelCapacityReservation, type ModelSlotResult } from "@/lib/llm/capacity";
import { beginModelDispatch, cancelReservedModelSlot, finishAi1ModelCapacityDispatch, lockAi1ModelCapacityDispatch,
  markModelDispatchIndeterminate, reconcileAi1GatewayTerminal, requestAi1ModelSlot, requestModelSlot,
  type Ai1CapacityDispatchLock } from "@/lib/llm/capacity-repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const serving = vi.hoisted(() => ({ contract: null as Ai1GatewayServingContract | null }));
vi.mock("@/lib/crawl/agent-review-serving-contract", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-serving-contract")>(),
  resolveAi1GatewayServingContract: () => serving.contract,
}));
type Raw = Record<string, unknown>;
const prefix = `capacity-terminal-${randomUUID()}`, owner = { instanceId: prefix, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "capacity-terminal-fixture" } });
const owned = new Map<string, ModelCapacityRequest>(), work = new Set<Promise<unknown>>();
const bodies = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
let initial: Record<string, unknown>, baseline: Record<string, unknown>, originalControl: Raw;
let setupWork: Promise<void> | undefined, cleaning: Promise<void> | undefined, initialized = false;
let sentinel: ModelCapacityRequest | undefined, serial = 1000;
const model = "Exact Model", hash = "a".repeat(64);
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4 }, groupLimits: { engine: 4 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60_000, reservationTtlMs: 60_000, routes: [
    { routeId: "crawl-agent-review", provider: "abcllm", model, providerBudgetId: "account", groupId: "engine" },
    { routeId: "sentinel", provider: "test", model, providerBudgetId: "account", groupId: "engine" }] };
function tracked<T>(pending: Promise<T>, set = work): Promise<T> { set.add(pending); void pending.catch(() => {}); return pending; }
const exercise = (load: () => Promise<void>) => () => tracked(Promise.resolve().then(load), bodies);
async function settle(set: Set<Promise<unknown>>, keepErrors = false) {
  const pending = [...set], results = await Promise.allSettled(pending);
  for (const promise of pending) set.delete(promise);
  const errors = results.flatMap(value => value.status === "rejected" ? [value.reason] : []);
  if (keepErrors && errors.length) throw new AggregateError(errors, "terminal_fixture_work_failed");
}
async function steps(loads: readonly (() => Promise<unknown>)[]) {
  const errors: unknown[] = [];
  for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "terminal_fixture_cleanup_failed", { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const result: Record<string, unknown> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value
      FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    result[tablename] = row.value;
  }
  return result;
}
async function restoreControl(tx: postgres.TransactionSql) {
  await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,
    policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
    FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
}
async function performCleanup() {
  if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = [...owned.keys()];
    for (const row of await tx`SELECT * FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[]) ORDER BY queue_ordinal FOR UPDATE`) {
      const expected = owned.get(row.request_id)!;
      expect([row.work_key, row.owner_instance_id, row.owner_boot_id, row.class, row.pool, row.route_id, row.provider, row.model])
        .toEqual([expected.workKey, expected.owner.instanceId, expected.owner.bootId, expected.class, expected.pool,
          expected.routeId, expected.provider, expected.model]);
    }
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    expect(await tx`SELECT tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`)
      .toEqual([{ tgenabled: "A" }, { tgenabled: "A" }]);
    const events = await tx`SELECT id::text,request_id FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events WHERE id=${event.id}::bigint
        AND request_id=${event.request_id}::uuid RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
    await restoreControl(tx); expect(await whole(tx)).toEqual(baseline);
  });
  owned.clear();
}
function cleanup() {
  if (cleaning) return cleaning;
  const pending = performCleanup(); cleaning = pending;
  const clear = () => { if (cleaning === pending) cleaning = undefined; };
  void pending.then(clear, clear); return pending;
}
async function install(value = policy) {
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(value)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(value)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
}
async function request(extra: Partial<ModelCapacityRequest> = {}): Promise<ModelCapacityRequest> {
  const value = { requestId: randomUUID(), workKey: randomUUID(), owner: { ...owner }, class: "first", pool: "reviewer",
    routeId: "crawl-agent-review", provider: "abcllm", model, ...extra } as ModelCapacityRequest;
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE request_id=${value.requestId}::uuid`).toEqual([]);
  expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=${value.requestId}::uuid`).toEqual([]);
  owned.set(value.requestId, structuredClone(value)); return value;
}
function granted(result: ModelSlotResult): ModelCapacityReservation {
  expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("actual_reservation_required");
  return result.reservation;
}
function identity(value: ModelCapacityRequest) { const result = { ...value }; Reflect.deleteProperty(result, "requestId"); return result; }
function binding(candidateId: number, extra: Partial<Ai1DispatchBinding> = {}): Ai1DispatchBinding {
  // Ledger fixture values do not prove an actual domain claim/job. C's runtime driver covers that boundary.
  return { kind: "ai1_legacy_gateway", version: 1, logicalWorkKey: `ai1:${candidateId}`, candidateId, attemptId: ++serial,
    inputHash: hash, sourceRevisionHash: hash, reviewPolicyHash: hash, promptVersion: "fixture", rulesVersion: "fixture",
    provider: "abcllm", model, routeId: "crawl-agent-review", stageEpoch: 1, wireHash: hash, servingContractHash: hash,
    totalTokenBound: 8000, chargedTokens: 8000, job: { name: "crawl-agent-review", token: randomUUID(), requestedVersion: 1 }, ...extra };
}
async function dispatch(value: ModelCapacityRequest, candidateId: number, bound = binding(candidateId)) {
  const handle = granted(await tracked(requestAi1ModelSlot(value, candidateId)));
  return tracked(db.transaction(async tx => {
    const lock = await lockAi1ModelCapacityDispatch(tx, { reservation: handle, identity: identity(value), candidateId });
    if (!lock) throw new Error("actual_lock_required");
    return finishAi1ModelCapacityDispatch(tx, lock, bound);
  }));
}
async function row(id: string) { return (await admin`SELECT to_jsonb(r) AS value FROM model_capacity_requests r WHERE request_id=${id}::uuid`)[0]?.value as Raw; }

beforeAll(() => {
  setupWork = (async () => {
    ensureSchema(); initial = await whole(); baseline = initial;
    if (!Array.isArray(initial.model_capacity_requests) || initial.model_capacity_requests.length)
      throw new Error("terminal_fixture_requires_empty_requests");
    [originalControl] = initial.model_capacity_control as Raw[]; initialized = true;
    await install(); sentinel = await request({ routeId: "sentinel", provider: "test",
      owner: { instanceId: `${prefix}-foreign`, bootId: randomUUID() } });
    expect(await tracked(cancelReservedModelSlot(granted(await tracked(requestModelSlot(sentinel)))))).toBe(true);
    await admin.begin(restoreControl); baseline = await whole(); owned.delete(sentinel.requestId);
  })(); return tracked(setupWork, hooks);
});
afterEach(() => tracked(steps([async () => { await setupWork; }, () => settle(bodies), () => settle(work), cleanup,
  async () => { serving.contract = null; vi.unstubAllEnvs(); }]), hooks));
afterAll(() => steps([async () => { await setupWork; }, () => settle(hooks, true), () => settle(bodies, true),
  () => settle(work), cleanup, async () => {
    if (!initialized) return;
    if (sentinel) owned.set(sentinel.requestId, structuredClone(sentinel));
    baseline = initial; await cleanup(); expect(await whole()).toEqual(initial);
  }, async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); }, async () => { await admin.end(); }]));

it("commits an original fixed reservation binding and refuses generic unbound dispatch", exercise(async () => {
  await install(); const value = await request(), candidateId = ++serial;
  const handle = granted(await tracked(requestAi1ModelSlot(value, candidateId)));
  expect(await row(value.requestId)).toMatchObject({ logical_work_key: `ai1:${candidateId}`, state: "reserved", dispatch_binding: null });
  await expect(tracked(beginModelDispatch(handle))).rejects.toThrow("ai1_bound_dispatch_required");
  const result = await dispatch(value, candidateId);
  expect(await row(value.requestId)).toMatchObject({ state: "dispatched", dispatch_binding: result.binding,
    dispatch_binding_hash: result.bindingHash, token: handle.token });
  expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${value.requestId}::uuid ORDER BY id`)
    .toEqual([{ kind: "queued" }, { kind: "reserved" }, { kind: "dispatch_started" }]);
}));

it("blocks duplicate logical waiting across owners and keeps the original waiting ID", exercise(async () => {
  await install({ ...policy, globalLimit: 1 });
  const busy = await request(), first = await request(), next = await request({ owner: { instanceId: `${prefix}-other`, bootId: randomUUID() } });
  const handle = granted(await tracked(requestAi1ModelSlot(busy, ++serial))), candidateId = ++serial;
  expect(await tracked(requestAi1ModelSlot(first, candidateId))).toEqual({ kind: "deferred", reason: "capacity" });
  const before = await row(first.requestId);
  expect(await tracked(requestAi1ModelSlot(next, candidateId))).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await row(next.requestId)).toBeUndefined();
  expect(await tracked(cancelReservedModelSlot(handle))).toBe(true);
  expect((await tracked(requestAi1ModelSlot(first, candidateId))).kind).toBe("granted");
  expect(await row(first.requestId)).toMatchObject({ queue_ordinal: before.queue_ordinal, logical_work_key: `ai1:${candidateId}` });
}));

it("preserves unknown charges across owner boot policy and source changes and fences old generic unknown", exercise(async () => {
  await install(); const value = await request(), candidateId = ++serial, original = await dispatch(value, candidateId);
  expect(await tracked(markModelDispatchIndeterminate(original, "transport_unknown"))).toBe(true);
  const before = await row(value.requestId), next = await request({ owner: { instanceId: `${prefix}-new`, bootId: randomUUID() } });
  await install({ ...policy, globalLimit: 5 });
  expect(await tracked(requestAi1ModelSlot(next, candidateId))).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await row(next.requestId)).toBeUndefined(); expect(await row(value.requestId)).toEqual(before);
  await install();
  const generic = await request(), genericHandle = granted(await tracked(requestModelSlot(generic)));
  const started = await tracked(beginModelDispatch(genericHandle));
  expect(started.kind).toBe("dispatched");
  const other = await request();
  expect(await tracked(requestAi1ModelSlot(other, ++serial))).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await row(other.requestId)).toBeUndefined();
}));

it("rejects forged foreign and reused transaction lock proofs without committing a dispatch", exercise(async () => {
  await install(); const value = await request(), candidateId = ++serial, handle = granted(await tracked(requestAi1ModelSlot(value, candidateId)));
  const before = await whole();
  await expect(tracked(db.transaction(tx => finishAi1ModelCapacityDispatch(tx, {} as Ai1CapacityDispatchLock, binding(candidateId)))))
    .rejects.toThrow("invalid_ai1_capacity_dispatch_lock");
  expect(await whole()).toEqual(before);
  const foreignLock = await tracked(db.transaction(tx => lockAi1ModelCapacityDispatch(tx,
    { reservation: handle, identity: identity(value), candidateId })));
  expect(foreignLock).not.toBeNull();
  await expect(tracked(db.transaction(other => finishAi1ModelCapacityDispatch(other, foreignLock!, binding(candidateId)))))
    .rejects.toThrow("invalid_ai1_capacity_dispatch_lock");
  expect(await whole()).toEqual(before);
  await expect(tracked(db.transaction(async tx => {
    const lock = await lockAi1ModelCapacityDispatch(tx, { reservation: handle, identity: identity(value), candidateId });
    expect(lock).not.toBeNull();
    await finishAi1ModelCapacityDispatch(tx, lock!, binding(candidateId));
    await finishAi1ModelCapacityDispatch(tx, lock!, binding(candidateId));
  }))).rejects.toThrow("invalid_ai1_capacity_dispatch_lock");
  expect(await whole()).toEqual(before);
}));

it("rolls back the original reservation when its final wall expires after the lock prefix", exercise(async () => {
  await install(); const value = await request(), candidateId = ++serial, handle = granted(await tracked(requestAi1ModelSlot(value, candidateId)));
  const before = await whole();
  await expect(tracked(db.transaction(async tx => {
    const lock = await lockAi1ModelCapacityDispatch(tx, { reservation: handle, identity: identity(value), candidateId });
    const { sql } = await import("drizzle-orm");
    await tx.execute(sql`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()-interval '1 millisecond'
      WHERE request_id=${value.requestId}::uuid`);
    await finishAi1ModelCapacityDispatch(tx, lock!, binding(candidateId));
  }))).rejects.toThrow("ai1_model_reservation_lost");
  expect(await whole()).toEqual(before);
}));

it("rolls back dispatched binding when the append-only event INSERT faults", exercise(async () => {
  await install(); const value = await request(), candidateId = ++serial;
  const handle = granted(await tracked(requestAi1ModelSlot(value, candidateId))), before = await whole();
  expect(await admin`SELECT to_regprocedure('public.pr05b3_terminal_fixture_event_fault()') AS fn`).toEqual([{ fn: null }]);
  await expect(tracked(db.transaction(async tx => {
    const lock = await lockAi1ModelCapacityDispatch(tx, { reservation: handle, identity: identity(value), candidateId });
    expect(lock).not.toBeNull();
    const { sql } = await import("drizzle-orm");
    // A genuine transaction-local trigger; rollback removes it and the dispatch.
    await tx.execute(sql`CREATE FUNCTION public.pr05b3_terminal_fixture_event_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'terminal_fixture_event_fault'; END $$`);
    await tx.execute(sql`CREATE TRIGGER terminal_fixture_fault BEFORE INSERT ON model_capacity_events
      FOR EACH ROW EXECUTE FUNCTION public.pr05b3_terminal_fixture_event_fault()`);
    await finishAi1ModelCapacityDispatch(tx, lock!, binding(candidateId));
  }))).rejects.toMatchObject({ cause: { message: "terminal_fixture_event_fault" } });
  expect(await admin`SELECT to_regprocedure('public.pr05b3_terminal_fixture_event_fault()') AS fn`).toEqual([{ fn: null }]);
  expect(await whole()).toEqual(before);
}));

it("settles only the original native proof once despite policy changes and rejects copied JSON", exercise(async () => {
  await install(); vi.stubEnv("ABCLLM_API_KEY", "local-fixture-secret");
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const body = (async () => { for await (const chunk of request) { void chunk; }
      response.end(JSON.stringify({ id: "local-ledger-response", object: "chat.completion", created: 1,
        model: "native-model", choices: [{ index: 0, finish_reason: "stop",
        message: { role: "assistant", content: "invalid judgment but complete transport" } }], usage_provenance: "gateway_estimated" })); })();
    pending.add(body); void body.catch(() => {});
  });
  let primary: unknown;
  try {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("local_address");
  serving.contract = { version: 1, protocol: "abcllm-raw-total-bound-v1", provider: "abcllm", routeId: "crawl-agent-review",
    model, responseModel: "native-model", endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    deploymentRevision: "local-ledger-fixture", totalTokenBound: 8000 };
    const now = new Date("2026-10-16T00:00:00.000Z");
    const input = createReviewInput({ repo: "native/ledger", productUrl: "https://ledger.example", judgedAt: now } as CrawlCandidate,
      { id: 1, repo: "native/ledger", repoMeta: {}, productUrl: "https://ledger.example", pageMeta: { title: "Ledger" },
        pageStatus: 200, fetchedAt: now } as CrawlDocument, DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
    const call = prepareAi1GatewayCall(input, { model }); if (call.kind !== "prepared") throw new Error("prepared_required");
    const value = await request(), candidateId = ++serial;
    const bound = binding(candidateId, { inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      reviewPolicyHash: input.policyHash, promptVersion: input.snapshot.policy.promptVersion, rulesVersion: input.snapshot.policy.rulesVersion,
      wireHash: call.wireHash, servingContractHash: call.servingContractHash });
    const sent = await dispatch(value, candidateId, bound);
    const actual = await tracked(reviewWithReservedAi1Gateway(input, sent, call)); expect(actual.terminal).not.toBeNull();
    expect(pending.size).toBe(1);
    const before = await whole();
    await expect(tracked(reconcileAi1GatewayTerminal(structuredClone(actual.terminal) as Ai1GatewayTerminal)))
      .rejects.toThrow("invalid_ai1_gateway_terminal"); expect(await whole()).toEqual(before);
    await install({ ...policy, globalLimit: 3 }); await admin`UPDATE model_capacity_control SET mode='draining',revision=revision+1 WHERE id=1`;
    expect(await tracked(reconcileAi1GatewayTerminal(actual.terminal!))).toEqual({ kind: "settled" });
    expect(await tracked(reconcileAi1GatewayTerminal(actual.terminal!))).toEqual({ kind: "already_settled" });
    expect(await row(value.requestId)).toMatchObject({ state: "settled", token: sent.token, terminal_evidence: {
      provenance: "unknown", actualUsage: null, dispatch: { binding: { chargedTokens: 8000 } } } });
    expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${value.requestId}::uuid AND kind='dispatch_settled'`)
      .toEqual([{ kind: "dispatch_settled" }]);
  } catch (error) { primary = error; throw error; }
  finally {
    const errors: unknown[] = [];
    serving.contract = null; server.closeAllConnections();
    try { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { errors.push(error); }
    for (const result of await Promise.allSettled([...pending])) if (result.status === "rejected") errors.push(result.reason);
    if (errors.length) throw new AggregateError(primary === undefined ? errors : [primary, ...errors]);
  }
}));

it("rejects incomplete unsafe and mismatched terminal JSON in both durable CHECKs", exercise(async () => {
  await install(); const value = await request(), candidateId = ++serial, sent = await dispatch(value, candidateId);
  const complete = { kind: "ai1_gateway_terminal", version: 1, dispatch: sent, finishReason: "stop", responseHash: hash,
    actualUsage: null, provenance: "unknown" };
  // Raw JSON has no authority. These explicit owner-only savepoint faults verify storage shape, not physical completion.
  const missing = { ...complete } as Record<string, unknown>; delete missing.finishReason;
  const invalid = [missing, { ...complete, finishReason: "eof" }, { ...complete, responseHash: null },
    { ...complete, provenance: "upstream_reported" }, { ...complete, extra: true },
    { ...complete, actualUsage: { inputTokens: 8000, outputTokens: 1, totalTokens: 8001 }, provenance: "upstream_reported" },
    { ...complete, actualUsage: { inputTokens: true, outputTokens: 1, totalTokens: 2 }, provenance: "upstream_reported" }];
  const before = await whole();
  await tracked(admin.begin(async tx => {
    for (const evidence of invalid) {
      await expect(tx.savepoint(async sp => {
        await sp`UPDATE model_capacity_requests SET state='settled',terminal_evidence=${JSON.stringify(evidence)}::text::jsonb,
          terminal_evidence_hash=${hash},settled_at=clock_timestamp() WHERE request_id=${value.requestId}::uuid`;
      })).rejects.toMatchObject({ code: "23514" });
      await expect(tx.savepoint(async sp => {
        await sp`INSERT INTO model_capacity_events(request_id,kind,epoch,revision,policy_hash,from_state,to_state,evidence)
          VALUES(${value.requestId}::uuid,'dispatch_settled',${sent.epoch},${sent.revision},${sent.policyHash},
            'dispatched','settled',${JSON.stringify(evidence)}::text::jsonb)`;
      })).rejects.toMatchObject({ code: "23514" });
    }
    for (const invalidBinding of [{ ...sent.binding, chargedTokens: null }, { ...sent.binding, totalTokenBound: true },
      { ...sent.binding, candidateId: Number.MAX_SAFE_INTEGER + 1 }])
      await expect(tx.savepoint(async sp => {
        await sp`UPDATE model_capacity_requests SET dispatch_binding=${JSON.stringify(invalidBinding)}::text::jsonb
          WHERE request_id=${value.requestId}::uuid`;
      })).rejects.toMatchObject({ code: "23514" });
    expect(await whole(tx)).toEqual(before);
  }));
  expect(await whole()).toEqual(before);
}));
