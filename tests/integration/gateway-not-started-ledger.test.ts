import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { createReviewInput, reviewHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { itemBindingHash, type Ai2ItemBinding, type ItemLease } from "@/lib/jobs/items/types";
import { claimItemLease, lockItemStage } from "@/lib/jobs/items/repository";
import { modelCapacityPolicyHash, type Ai1DispatchBinding, type Ai1ModelDispatch, type Ai2DispatchBinding, type ModelCapacityPolicy,
  type ModelCapacityRequest, type ModelCapacityReservation, type ModelSlotResult } from "@/lib/llm/capacity";
import { finishAi1ModelCapacityDispatch, finishAi2ItemModelCapacityDispatch, lockAi1ModelCapacityDispatch, lockAi2ItemModelCapacityDispatch,
  markModelDispatchIndeterminate, reconcileGatewayNotStarted, requestAi1ModelSlot, requestAi2ItemModelSlot } from "@/lib/llm/capacity-repository";
import { markUnsettledDispatch } from "@/lib/llm/capacity-unsettled";
import { prepareAi1GatewayCall, prepareAi2GatewayCall, readGatewayNotStarted, settleAi1GatewayNotStarted,
  type PreparedAi2GatewayCall } from "@/lib/crawl/agent-review-gateway";
import { abandonAgentReviewModelCapacity, reviewAgentReviewModelCapacity } from "@/lib/crawl/agent-review-model-capacity";
import { abandonSecondReviewModelCapacity, reviewSecondReviewModelCapacity } from "@/lib/crawl/second-review-model-capacity";
import type { Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import type { Ai2GatewayServingContract } from "@/lib/crawl/second-review-serving-contract";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/**
 * F2 결함 1·3 실제 DB driver(0102). fetch 를 부르지 않은 AI1·AI2 gateway dispatch 는 같은 owner handle 의 not_started 증인으로 settled 가 되고
 * 슬롯·후보/표 키가 풀린다. 전송 여부를 모르는 행(indeterminate)은 받지 않는다. 정산 실패는 commit_unknown 으로 표시된다.
 * 모든 행·event·item lease·control·stage 는 끝나면 whole-DB 기준선으로 되돌린다(events 는 이 fixture 의 request 만 지운다).
 */
const serving = vi.hoisted(() => ({ ai1: null as Ai1GatewayServingContract | null, ai2: null as Ai2GatewayServingContract | null }));
vi.mock("@/lib/crawl/agent-review-serving-contract", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-serving-contract")>(), resolveAi1GatewayServingContract: () => serving.ai1,
}));
vi.mock("@/lib/crawl/second-review-serving-contract", async original => ({
  ...await original<typeof import("@/lib/crawl/second-review-serving-contract")>(), resolveAi2GatewayServingContract: () => serving.ai2,
}));
type Raw = Record<string, unknown>;
const root = fileURLToPath(new URL("../..", import.meta.url));
const tag = randomBytes(6).toString("hex"), prefix = `f2-not-started-${tag}`, owner = { instanceId: prefix, bootId: randomUUID() };
const stepName = `nomorevibe_test_f2_step_${tag}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: "f2-not-started-fixture" } });
const owned = new Map<string, ModelCapacityRequest>(), items = new Map<string, ItemLease>(), work = new Set<Promise<unknown>>();
const model = "Exact Model";
let serial = Number.parseInt(randomUUID().slice(0, 7), 16), initial: Record<string, unknown> = {}, initialized = false;
let originalControl: Raw, originalStage: Raw, stepCreated = false;
let posts = 0, server: ReturnType<typeof createServer> | undefined, endpoint = "";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4 }, groupLimits: { engine: 4 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12, queueTtlMs: 60_000,
  reservationTtlMs: 60_000, routes: [
    { routeId: "crawl-agent-review", provider: "abcllm", model, providerBudgetId: "account", groupId: "engine" },
    { routeId: "second-review", provider: "abcllm", model, providerBudgetId: "account", groupId: "engine" }] };
function tracked<T>(pending: Promise<T>): Promise<T> { work.add(pending); void pending.catch(() => {}); return pending; }
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const value: Record<string, unknown> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value
      FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    value[tablename] = row.value;
  }
  return value;
}
async function cleanup() {
  if (!initialized) return;
  await Promise.allSettled([...work]); work.clear();
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = [...owned.keys()];
    for (const row of await tx`SELECT * FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[]) FOR UPDATE`) {
      const value = owned.get(row.request_id)!;
      expect([row.work_key, row.owner_instance_id, row.owner_boot_id, row.route_id]).toEqual([value.workKey, value.owner.instanceId,
        value.owner.bootId, value.routeId]);
    }
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    const events = await tx`SELECT id::text,request_id FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events WHERE id=${event.id}::bigint
        AND request_id=${event.request_id}::uuid RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
    for (const lease of items.values()) expect(await tx`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${lease.workKey}
      AND binding_hash=${lease.bindingHash} RETURNING work_key`).toHaveLength(1);
    await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,
      cursor=r.cursor,updated_at=r.updated_at FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r
      WHERE c.id=r.id`;
    await tx`UPDATE pipeline_stage_modes s SET mode=r.mode,epoch=r.epoch,writer_contract_version=r.writer_contract_version,
      draining_from=r.draining_from,updated_at=r.updated_at
      FROM jsonb_populate_record(NULL::pipeline_stage_modes,${JSON.stringify(originalStage)}::text::jsonb) r WHERE s.stage=r.stage`;
    expect(await tx`SELECT tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`)
      .toEqual([{ tgenabled: "A" }, { tgenabled: "A" }]);
    expect(await whole(tx)).toEqual(initial);
  });
  owned.clear(); items.clear();
}
async function install() {
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(policy)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1,draining_from=NULL,updated_at=clock_timestamp() WHERE stage='ai2'`;
}
function input(): ReviewInput {
  const now = new Date("2026-10-17T00:00:00.000Z");
  return createReviewInput({ repo: `${prefix}/app`, productUrl: "https://f2.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: `${prefix}/app`, productUrl: "https://f2.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "F2" }, pageStatus: 200, fetchedAt: now } as CrawlDocument, DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
function granted(result: ModelSlotResult): ModelCapacityReservation {
  expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("actual_reservation_required");
  return result.reservation;
}
function identity(value: ModelCapacityRequest) { const result = { ...value }; Reflect.deleteProperty(result, "requestId"); return result; }
function remember(value: ModelCapacityRequest) { owned.set(value.requestId, structuredClone(value)); return value; }
async function ai1(value = input(), candidateId = ++serial, who = owner) {
  const call = prepareAi1GatewayCall(value, { model, timeoutMs: 2_000 });
  if (call.kind !== "prepared") throw new Error("actual_prepared_required");
  const requested = remember({ requestId: randomUUID(), workKey: `ai1:${candidateId}:${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
    owner: { ...who }, class: "first", pool: "reviewer", routeId: "crawl-agent-review", provider: "abcllm", model });
  const handle = granted(await tracked(requestAi1ModelSlot(requested, candidateId)));
  // Ledger driver fixture: the binding commits to this actual preparation; the domain claim is the runtime driver's concern.
  const binding: Ai1DispatchBinding = { kind: "ai1_legacy_gateway", version: 1, logicalWorkKey: `ai1:${candidateId}`, candidateId,
    attemptId: ++serial, inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, reviewPolicyHash: value.policyHash,
    promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion, provider: "abcllm", model,
    routeId: "crawl-agent-review", stageEpoch: 1, wireHash: call.wireHash, servingContractHash: call.servingContractHash,
    totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, job: { name: "crawl-agent-review", token: randomUUID(), requestedVersion: 1 } };
  const dispatch = await tracked(db.transaction(async tx => {
    const lock = await lockAi1ModelCapacityDispatch(tx, { reservation: handle, identity: identity(requested), candidateId });
    if (!lock) throw new Error("actual_lock_required");
    return finishAi1ModelCapacityDispatch(tx, lock, binding);
  }));
  return { value, call, dispatch, requested, candidateId };
}
async function ai2(value = input()) {
  const call = prepareAi2GatewayCall(value, { model, timeoutMs: 2_000 }) as PreparedAi2GatewayCall;
  if (call.kind !== "prepared") throw new Error("actual_prepared_required");
  const id = ++serial;
  const review: Ai2ItemBinding = { stage: "ai2", candidateId: id, secondReviewId: id, vote: id, fallbackForId: null,
    source: { kind: "first_attempt", firstAttemptId: id }, inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash,
    policyHash: value.policyHash, promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
    generationKey: "c".repeat(64), reviewer: { provider: "abcllm", model } };
  const logical = `ai2:${id}:${id}`;
  const requested = remember({ requestId: randomUUID(), workKey: `${logical}:${itemBindingHash(review)}`, owner: { ...owner },
    class: "second", pool: "reviewer", routeId: "second-review", provider: "abcllm", model });
  const handle = granted(await tracked(requestAi2ItemModelSlot(requested, { candidateId: id, vote: id })));
  const result = await tracked(db.transaction(async tx => {
    const lock = await lockAi2ItemModelCapacityDispatch(tx, { reservation: handle, identity: identity(requested), target: { candidateId: id, vote: id } });
    if (!lock) throw new Error("actual_lock_required");
    const stage = await lockItemStage(tx, "ai2"), lease = await claimItemLease(tx, stage, review, requested.owner, 90_000);
    if (!lease) throw new Error("actual_item_claim_required");
    const binding: Ai2DispatchBinding = { kind: "ai2_item_gateway", version: 1, logicalWorkKey: logical, review, rowIdentityHash: "d".repeat(64),
      failureCount: 0, inputPolicyHash: value.policyHash, item: { workKey: lease.workKey, owner: lease.owner, token: lease.token,
        stageEpoch: lease.stageEpoch, itemEpoch: lease.itemEpoch, bindingHash: lease.bindingHash }, routeId: "second-review", provider: "abcllm",
      model, wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound,
      chargedTokens: call.totalTokenBound };
    return { lease, dispatch: await finishAi2ItemModelCapacityDispatch(tx, lock, binding) };
  }));
  items.set(result.lease.workKey, result.lease);
  return { value, call, dispatch: result.dispatch, requested, logical, id };
}
const row = async (id: string) => (await admin`SELECT to_jsonb(r) AS value FROM model_capacity_requests r WHERE request_id=${id}::uuid`)[0]?.value as Raw;
const events = async (id: string) => Array.from(await admin`SELECT kind,from_state,to_state,reason,evidence FROM model_capacity_events
  WHERE request_id=${id}::uuid ORDER BY id`);
const aborted = () => { const controller = new AbortController(); controller.abort(); return controller.signal; };
function expectSettled(raw: Raw, dispatch: unknown) {
  const evidence = { version: 1, kind: "gateway_not_started", dispatch };
  expect(raw).toMatchObject({ state: "settled", terminal_evidence: evidence, terminal_evidence_hash: reviewHash(evidence) });
  expect(raw.settled_at).not.toBeNull();
  return evidence;
}
async function constraintDefs(sql: postgres.Sql, names: readonly string[]) {
  return Object.fromEntries(Array.from(await sql<{ name: string; def: string }[]>`SELECT conname AS name, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conname = ANY(${names as string[]}::text[])`).map(value => [value.name, value.def]));
}
const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
const LEFT = ["model_capacity_requests_terminal_check", "model_capacity_events_terminal_check"] as const;
const UNTOUCHED = ["model_capacity_requests_dispatch_check", "model_capacity_requests_logical_check", "model_capacity_requests_members_check",
  "model_capacity_events_kind_check", "model_capacity_events_reason_check", "model_capacity_requests_state_check"] as const;

beforeAll(async () => {
  ensureSchema();
  expect(journal.entries.map(entry => entry.tag)).toContain("0102_model_capacity_gateway_not_started");
  const [applied] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  initial = await whole();
  if ((initial.model_capacity_requests as Raw[]).some(value => ["waiting", "reserved", "dispatched", "indeterminate"].includes(String(value.state))))
    throw new Error("f2_fixture_active_capacity");
  originalControl = (initial.model_capacity_control as Raw[])[0];
  originalStage = (initial.pipeline_stage_modes as Raw[]).find(value => value.stage === "ai2")!;
  if (!originalControl || !originalStage || (initial.pipeline_item_leases as Raw[]).some(value => value.stage === "ai2" && value.token !== null))
    throw new Error("f2_fixture_stage_busy");
  initialized = true;
  server = createServer((request, response) => { posts++; request.resume(); request.on("end", () => response.end("{}")); });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
  endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
}, 120_000);
afterEach(async () => { await cleanup(); serving.ai1 = null; serving.ai2 = null; vi.unstubAllEnvs(); });
afterAll(async () => {
  const errors: unknown[] = [];
  for (const load of [cleanup, async () => { if (initialized) expect(await whole()).toEqual(initial); },
    async () => { if (stepCreated) await admin.unsafe(`DROP DATABASE IF EXISTS ${stepName} WITH (FORCE)`); },
    async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); },
    async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); }, () => admin.end()])
    try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "f2_fixture_cleanup_failed");
}, 120_000);
function contracts() {
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only");
  const base = { version: 1 as const, protocol: "abcllm-raw-total-bound-v1" as const, provider: "abcllm" as const, model, responseModel: "native-model",
    endpoint, deploymentRevision: "local-test-only", totalTokenBound: 8_000 };
  serving.ai1 = { ...base, routeId: "crawl-agent-review" }; serving.ai2 = { ...base, routeId: "second-review" };
}

it("0102: exact migration prefixes preserve earlier CHECKs; current constraints retain the legacy branches", async () => {
  await admin.unsafe(`CREATE DATABASE ${stepName}`); stepCreated = true;
  const url = new URL(TEST_DATABASE_URL); url.pathname = `/${stepName}`;
  const step = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const partial = mkdtempSync(path.join(tmpdir(), "f2-0102-migrations-"));
  try {
    mkdirSync(path.join(partial, "meta"));
    const migrateThrough = async (index: number) => {
      const entries = journal.entries.filter(entry => entry.idx <= index);
      for (const entry of entries) copyFileSync(path.join(root, "drizzle", `${entry.tag}.sql`), path.join(partial, `${entry.tag}.sql`));
      writeFileSync(path.join(partial, "meta/_journal.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"),
        "utf8")), entries }));
      await migrate(drizzle(step), { migrationsFolder: partial });
      const [applied] = await step<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
      expect(applied.count).toBe(entries.length);
    };
    expect(journal.entries.find(entry => entry.idx === 101)!.tag).toBe("0101_dr_process_group_successor_exit");
    await step.unsafe("set statement_timeout = 0");
    await migrateThrough(101);
    const before = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    await migrateThrough(102);
    const after = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    const inner = (def: string) => { expect(def.startsWith("CHECK (")).toBe(true); return def.slice("CHECK (".length, -1); };
    for (const name of LEFT) {
      const left = inner(before[name]), combined = inner(after[name]);
      expect(left).not.toContain("gateway_not_started");
      expect(combined.length).toBeGreaterThan(left.length);
      expect(combined.startsWith(`${left.slice(0, -1)} OR `)).toBe(true);
      expect(combined.slice(left.length - 1)).toContain("gateway_not_started");
    }
    for (const name of UNTOUCHED) expect(after[name]).toBe(before[name]);

    // Later direct/assist migrations deliberately extend four CHECKs. Keep the
    // historical 0102 comparison exact, then verify its legacy predicates survive
    // those later additions on the actual latest schema as well.
    await migrate(drizzle(step), { migrationsFolder: path.join(root, "drizzle") });
    const [applied] = await step<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(journal.entries.length);
    const current = await constraintDefs(step, [...LEFT, ...UNTOUCHED]);
    for (const name of [...LEFT, ...UNTOUCHED.slice(0, 2)]) {
      const legacy = inner(after[name]), combined = inner(current[name]);
      expect(combined.startsWith(`${legacy.slice(0, -1)} OR `), `${name}: current legacy prefix`).toBe(true);
    }
    for (const name of UNTOUCHED.slice(2)) expect(current[name], `${name}: current unchanged CHECK`).toBe(after[name]);
  } finally { rmSync(partial, { recursive: true, force: true }); await step.end({ timeout: 5 }); }
}, 600_000);

it("AI1: a pre-fetch abort through the real gateway settles the exact dispatch as not_started and frees the candidate key", async () => {
  await install(); contracts();
  const first = await ai1();
  const result = await tracked(reviewAgentReviewModelCapacity(first.value, first.dispatch, first.call, { signal: aborted() }));
  expect(result).toEqual({ ok: false, error: "cancelled" }); expect(posts).toBe(0);
  const evidence = expectSettled(await row(first.requested.requestId), first.dispatch);
  expect((await row(first.requested.requestId)).dispatch_binding).toEqual(first.dispatch.binding);
  expect(await events(first.requested.requestId)).toMatchObject([{ kind: "queued" }, { kind: "reserved" }, { kind: "dispatch_started" },
    { kind: "dispatch_settled", from_state: "dispatched", to_state: "settled", reason: null, evidence }]);
  // 같은 후보의 새 boot 요청이 장부 fence 에 막히지 않는다(indeterminate 였다면 capacity 로 미뤘다)
  const next = remember({ requestId: randomUUID(), workKey: `ai1:${first.candidateId}:${"b".repeat(64)}`,
    owner: { instanceId: `${prefix}-next`, bootId: randomUUID() }, class: "first", pool: "reviewer", routeId: "crawl-agent-review", provider: "abcllm", model });
  expect((await tracked(requestAi1ModelSlot(next, first.candidateId))).kind).toBe("granted");
});

it("AI1: abandon with the unused preparation settles once; without proof it stays indeterminate(local_abort) and keeps its fence", async () => {
  await install(); contracts();
  const settled = await ai1();
  expect(await tracked(abandonAgentReviewModelCapacity(settled.dispatch, settled.call))).toBe(true);
  expectSettled(await row(settled.requested.requestId), settled.dispatch);
  const kept = await ai1();
  expect(await tracked(abandonAgentReviewModelCapacity(kept.dispatch))).toBe(true);
  expect(await row(kept.requested.requestId)).toMatchObject({ state: "indeterminate", terminal_evidence: null });
  expect((await events(kept.requested.requestId)).at(-1)).toMatchObject({ kind: "dispatch_indeterminate", reason: "local_abort" });
  const blocked = remember({ requestId: randomUUID(), workKey: `ai1:${kept.candidateId}:${"c".repeat(64)}`,
    owner: { instanceId: `${prefix}-blocked`, bootId: randomUUID() }, class: "first", pool: "reviewer", routeId: "crawl-agent-review", provider: "abcllm", model });
  expect(await tracked(requestAi1ModelSlot(blocked, kept.candidateId))).toEqual({ kind: "deferred", reason: "capacity" });
  owned.delete(blocked.requestId);
  expect(posts).toBe(0);
});

it("refuses a witness for an already-indeterminate row and is idempotent for its own settled evidence", async () => {
  await install(); contracts();
  const unknown = await ai1(), witness = settleAi1GatewayNotStarted(unknown.call, unknown.dispatch);
  expect(readGatewayNotStarted(witness)?.dispatch).toEqual(unknown.dispatch);
  expect(await tracked(markModelDispatchIndeterminate(unknown.dispatch, "transport_unknown"))).toBe(true);
  const before = await row(unknown.requested.requestId);
  await expect(tracked(reconcileGatewayNotStarted(witness!))).rejects.toThrow("gateway_not_started_state_mismatch");
  expect(await row(unknown.requested.requestId)).toEqual(before);
  const fresh = await ai1(), proof = settleAi1GatewayNotStarted(fresh.call, fresh.dispatch)!;
  expect(await tracked(reconcileGatewayNotStarted(proof))).toEqual({ kind: "settled" });
  expect(await tracked(reconcileGatewayNotStarted(proof))).toEqual({ kind: "already_settled" });
  await expect(tracked(reconcileGatewayNotStarted(structuredClone(proof)))).rejects.toThrow("invalid_gateway_not_started");
  expect((await events(fresh.requested.requestId)).filter(value => value.kind === "dispatch_settled")).toHaveLength(1);
});

it("AI2: a pre-fetch abort and an abandon with the preparation settle the item dispatch and free the vote key", async () => {
  await install(); contracts();
  const vote = await ai2();
  const result = await tracked(reviewSecondReviewModelCapacity(vote.value, vote.dispatch, vote.call, { signal: aborted() }));
  expect(result).toEqual({ ok: false, error: "cancelled" });
  const evidence = expectSettled(await row(vote.requested.requestId), vote.dispatch);
  expect((await events(vote.requested.requestId)).at(-1)).toMatchObject({ kind: "dispatch_settled", from_state: "dispatched", evidence });
  const other = await ai2();
  expect(await tracked(abandonSecondReviewModelCapacity(other.dispatch, other.call))).toBe(true);
  expectSettled(await row(other.requested.requestId), other.dispatch);
  // 같은 표의 다음 요청(다른 boot)이 표 키 fence 에 막히지 않는다
  const next = remember({ requestId: randomUUID(), workKey: `${vote.logical}:${"e".repeat(64)}`, owner: { instanceId: `${prefix}-next`, bootId: randomUUID() },
    class: "second", pool: "reviewer", routeId: "second-review", provider: "abcllm", model });
  expect((await tracked(requestAi2ItemModelSlot(next, { candidateId: vote.id, vote: vote.id }))).kind).toBe("granted");
  expect(posts).toBe(0);
});

it("CHECKs reject a forged not_started row or event that is not the row's own dispatched handle", async () => {
  await install(); contracts();
  const value = await ai1(), proof = settleAi1GatewayNotStarted(value.call, value.dispatch)!;
  const forged = { version: 1, kind: "gateway_not_started", dispatch: { ...value.dispatch, token: randomUUID() } };
  const code = (error: unknown) => { const failure = error as { code?: string; constraint_name?: string }; return `${failure.code}:${failure.constraint_name}`; };
  expect(await admin`UPDATE model_capacity_requests SET state='settled',terminal_evidence=${JSON.stringify(forged)}::text::jsonb,
    terminal_evidence_hash=${"e".repeat(64)},settled_at=clock_timestamp() WHERE request_id=${value.requested.requestId}::uuid`
    .then(() => "accepted", code)).toBe("23514:model_capacity_requests_terminal_check");
  const [current] = await admin`SELECT epoch,revision,policy_hash FROM model_capacity_requests WHERE request_id=${value.requested.requestId}::uuid`;
  const event = (fromState: string, evidence: unknown) => admin`INSERT INTO model_capacity_events (request_id,kind,epoch,revision,policy_hash,from_state,to_state,reason,evidence)
    VALUES (${value.requested.requestId}::uuid,'dispatch_settled',${current.epoch},${current.revision},${current.policy_hash},${fromState},'settled',NULL,
    ${JSON.stringify(evidence)}::text::jsonb)`.then(() => "accepted", code);
  const genuine = readGatewayNotStarted(proof);
  expect(await event("indeterminate", genuine)).toBe("23514:model_capacity_events_terminal_check");
  expect(await event("dispatched", { ...genuine, dispatch: { ...value.dispatch, requestId: randomUUID() } })).toBe("23514:model_capacity_events_terminal_check");
  expect(await event("dispatched", { ...genuine, extra: true })).toBe("23514:model_capacity_events_terminal_check");
  expect(await row(value.requested.requestId)).toMatchObject({ state: "dispatched", terminal_evidence: null });
  expect(await tracked(reconcileGatewayNotStarted(proof))).toEqual({ kind: "settled" });
});

it("a failed settlement is marked commit_unknown on a dispatched row and never rewrites a settled one", async () => {
  await install(); contracts();
  const open = await ai1();
  await markUnsettledDispatch(open.dispatch as Ai1ModelDispatch);
  expect(await row(open.requested.requestId)).toMatchObject({ state: "indeterminate", terminal_evidence: null });
  expect((await events(open.requested.requestId)).at(-1)).toMatchObject({ kind: "dispatch_indeterminate", reason: "commit_unknown" });
  const done = await ai1();
  expect(await tracked(abandonAgentReviewModelCapacity(done.dispatch, done.call))).toBe(true);
  const before = await row(done.requested.requestId), history = await events(done.requested.requestId);
  await markUnsettledDispatch(done.dispatch as Ai1ModelDispatch);
  expect(await row(done.requested.requestId)).toEqual(before); expect(await events(done.requested.requestId)).toEqual(history);
});
