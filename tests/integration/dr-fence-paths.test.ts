import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, modelCapacityRequestIdentitySchema, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import * as ledger from "@/lib/llm/capacity-repository";
import { runJob } from "@/lib/jobs/runner";
import { requestDueJobs } from "@/lib/jobs/control";
import { JobBatchBlockedError } from "@/lib/jobs/batch-repository";
import { claimCanonicalEvidenceSource } from "@/lib/domain/evidence/source-claims";
import * as fence from "@/lib/operations/dr/epoch";
import * as repo from "@/lib/operations/dr/repository";
import type { PromotionPlan } from "@/lib/operations/dr/promotion";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * PR15c 실제 PostgreSQL. 이 파일이 만들고 지우는 임시 DB 세 개만 쓴다(공유 test DB 의 행·제어값은 건드리지 않는다).
 * - paths: 같은 DB 에서 active 때는 기존대로 쓰고, operator fence 뒤에는 runJob claim·requestDueJobs·source claim·모델 admission 이 쓰기 0 으로 거절.
 * - order: 실제 backend 둘 이상으로 잠금 순서를 고정해 본다. control → fence(거절한 순서)는 교착, fence → control(이번 순서)은 줄만 선다.
 * - pre: 0095 이전과 같은 상태(fence 행·표 없음)에서 각 경로가 쓰기 없이 실패한다(fail-closed).
 * 실제 provider·외부 HTTP·운영 resolver 는 쓰지 않는다.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const tag = randomBytes(6).toString("hex"), prefix = `pr15c-${tag}`, operator = "pr15c-root-driver";
const names = { paths: `nomorevibe_test_pr15c_p_${tag}`, order: `nomorevibe_test_pr15c_o_${tag}`, pre: `nomorevibe_test_pr15c_x_${tag}` } as const;
type Side = keyof typeof names;
const urlOf = (side: Side) => { const value = new URL(TEST_DATABASE_URL); value.pathname = `/${names[side]}`; return value.toString(); };
const created: Side[] = [], pools = new Map<Side, postgres.Sql>();
const pool = (side: Side) => { let client = pools.get(side); if (!client) { client = postgres(urlOf(side), { max: 10, prepare: false, onnotice: () => {} }); pools.set(side, client); } return client; };
function bindDb(side: Side) { const g = globalThis as { db?: unknown; pgClient?: unknown }; g.pgClient = pool(side); g.db = drizzle(pool(side), { schema }); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pgCode = (error: unknown): string | undefined => {
  const value = error as { code?: string; cause?: { code?: string } } | undefined;
  return value?.code ?? value?.cause?.code;
};
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 16, providerLimits: { acct: 8 }, groupLimits: { g: 16 }, poolLimits: { reviewer: 8, text: 8 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 600_000, reservationTtlMs: 600_000,
  routes: [{ routeId: "pr15c-route", provider: "fixture", model: "m", providerBudgetId: "acct", groupId: "g" },
    { routeId: "crawl-agent-review", provider: "abcllm", model: "pr15c-ai1", providerBudgetId: "acct", groupId: "g" }] };
const modelOwner = { instanceId: `${prefix}-model`, bootId: randomUUID() }, sourceOwner = { instanceId: `${prefix}-site`, bootId: "boot-1" };
const request = (work: string, owner = modelOwner) => ({ requestId: randomUUID(), workKey: `${prefix}:${work}`, owner, class: "background" as const,
  pool: "text" as const, routeId: "pr15c-route", provider: "fixture", model: "m" });
const ai1Identity = (candidateId: number) => modelCapacityRequestIdentitySchema.parse({ workKey: `${prefix}:ai1:${candidateId}`, owner: modelOwner,
  class: "first", pool: "reviewer", routeId: "crawl-agent-review", provider: "abcllm", model: "pr15c-ai1" });
/** 경로가 건드릴 수 있는 모든 장부의 내용 digest. fence 의 FOR SHARE 는 행 내용을 바꾸지 않는다. */
const WATCHED = ["jobs", "job_batch_control", "role_leases", "model_capacity_control", "model_capacity_requests", "model_capacity_events",
  "evidence_source_control", "evidence_source_claims", "product_refresh_requests", "product_evidence_sources", "operations_observations",
  "dr_writer_fence", "dr_fence_events"] as const;
async function digest(side: Side): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of WATCHED) {
    const [row] = await pool(side).unsafe(`SELECT count(*)::int AS n, md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY to_jsonb(t)::text), '')) AS h FROM ${table} t`);
    out[table] = `${row.n}:${row.h}`;
  }
  return out;
}
async function seedProduct(side: Side, n: number) {
  const slug = `${prefix}-${side}-${n}`;
  const [row] = await pool(side)<{ id: number }[]>`INSERT INTO products (slug, url, name, tagline, description, category, status, verify_token, edit_token_hash)
    VALUES (${slug}, ${`https://${slug}.example`}, ${slug}, 'Evidence', 'Evidence', 'Other', 'verified', 'test', ${"a".repeat(64)}) RETURNING id`;
  return row.id;
}
async function openLedger(side: Side) {
  await pool(side)`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(policy)}::text::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)} WHERE id = 1`;
}
/** 실제 backend 의 lock 대기 그래프. */
async function waiters(side: Side): Promise<{ pid: number; blockers: number[]; query: string }[]> {
  return Array.from(await pool(side)<{ pid: number; blockers: number[]; query: string }[]>`SELECT pid, pg_blocking_pids(pid) AS blockers, query
    FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' ORDER BY pid`);
}
async function waitFor<T>(probe: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) { const value = await probe(); if (value !== undefined) return value; await sleep(25); }
  throw new Error(`timeout:${label}`);
}
async function planFor(side: Side): Promise<PromotionPlan> {
  bindDb(side);
  const here = await db.transaction(tx => fence.readDatabaseIdentity(tx)), active = await db.transaction(tx => fence.lockWriterFence(tx, "share"));
  const [now] = await pool(side)<{ now: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  return { version: 1, promotionId: randomUUID(), lineageId: active.lineageId, fromEpoch: active.writerEpoch, knownActiveEpoch: active.writerEpoch,
    restoredDb: here, oldDbs: [{ systemIdentifier: "7000000000000000001", databaseOid: "16384", databaseName: "pr15c_former_primary" }],
    oldInstances: [`${prefix}-declared`], snapshotAt: now.now, operator };
}

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  expect(journal.entries.map(entry => entry.tag)).toContain("0095_dr_writer_fence");
  const shared = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const [applied] = await shared<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(journal.entries.length);
    for (const side of Object.keys(names) as Side[]) { await shared.unsafe(`CREATE DATABASE ${names[side]}`); created.push(side); }
  } finally { await shared.end({ timeout: 5 }); }
  for (const side of Object.keys(names) as Side[]) {
    const client = postgres(urlOf(side), { max: 1, onnotice: () => {} });
    try { await client.unsafe("set statement_timeout = 0"); await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") }); }
    finally { await client.end({ timeout: 5 }); }
    const [applied] = await pool(side)<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(journal.entries.length);
    expect((await pool(side)`SELECT state FROM dr_writer_fence WHERE id = 1`)[0].state).toBe("active");
  }
  console.info("pr15c_migrations", { journal: journal.entries.length });
}, 600_000);

afterAll(async () => {
  for (const client of pools.values()) await client.end({ timeout: 5 });
  const g = globalThis as { db?: unknown; pgClient?: unknown }; delete g.db; delete g.pgClient;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { for (const side of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${names[side]} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

const paths = { products: [] as number[], liveReq: null as ReturnType<typeof request> | null, liveRes: null as unknown, staleId: "",
  ai1: null as unknown, dispatch: null as unknown };

it("active site: runJob, requestDueJobs, source claim and model admission write exactly as before", async () => {
  bindDb("paths");
  const p = pool("paths");
  await openLedger("paths");
  await p`UPDATE evidence_source_control SET enabled = true, cursor = 0 WHERE id = 1`;
  paths.products = [await seedProduct("paths", 1), await seedProduct("paths", 2)];
  expect(await requestDueJobs()).toBeGreaterThan(0);
  const handler = vi.fn(async () => ({ done: true }));
  expect(await runJob("news-refresh", handler)).toMatchObject({ status: "completed", done: true });
  expect(handler).toHaveBeenCalledOnce();
  const claim = await claimCanonicalEvidenceSource({ owner: sourceOwner, productId: paths.products[0] });
  expect(claim).toMatchObject({ binding: { productId: paths.products[0] }, owner: sourceOwner, epoch: 1 });
  expect(await ledger.readModelCapacityCallerControl()).toMatchObject({ mode: "open" });
  paths.liveReq = request("live");
  const live = await ledger.requestModelSlot(paths.liveReq);
  if (live.kind !== "granted") throw new Error("fixture_live");
  paths.liveRes = live.reservation;
  const stale = await ledger.requestModelSlot(request("stale"));
  if (stale.kind !== "granted") throw new Error("fixture_stale");
  paths.staleId = stale.reservation.requestId;
  const begun = await ledger.requestModelSlot(request("begun"));
  if (begun.kind !== "granted") throw new Error("fixture_begun");
  const dispatched = await ledger.beginModelDispatch(begun.reservation);
  expect(dispatched.kind).toBe("dispatched");
  paths.dispatch = dispatched.kind === "dispatched" ? dispatched.dispatch : null;
  const ai1 = await ledger.requestAi1ModelSlot({ ...ai1Identity(4242), requestId: randomUUID() }, 4242);
  if (ai1.kind !== "granted") throw new Error("fixture_ai1");
  paths.ai1 = ai1.reservation;
  // active: 같은 TX 의 dispatch lock 이 실제로 나온다(이 TX 는 되돌린다).
  await expect(db.transaction(async tx => {
    expect(await ledger.lockAi1ModelCapacityDispatch(tx, { reservation: ai1.reservation, identity: ai1Identity(4242), candidateId: 4242 })).not.toBeNull();
    throw new Error("pr15c_rollback");
  })).rejects.toThrow("pr15c_rollback");
}, 120_000);

it("fenced site: no path starts a write — claims, schedules, source claims, model admission/dispatch and expiry are all refused", async () => {
  bindDb("paths");
  const p = pool("paths");
  const site = await db.transaction(tx => fence.readDatabaseIdentity(tx)), active = await db.transaction(tx => fence.lockWriterFence(tx, "share"));
  await db.transaction(tx => fence.fenceWriterSite(tx, { lineageId: active.lineageId, writerEpoch: active.writerEpoch, db: site, operator }));
  // fence 뒤에도 할 일이 있게 만든다: 모든 정기 잡을 due 로, 한 예약은 만료로(active 라면 다음 장부 호출이 withdrawn 으로 쓴다).
  await p`UPDATE jobs SET next_scheduled_at = clock_timestamp() - interval '1 hour' WHERE next_scheduled_at IS NOT NULL`;
  await p`UPDATE model_capacity_requests SET reserved_until = clock_timestamp() - interval '1 second' WHERE request_id = ${paths.staleId}::uuid`;
  const before = await digest("paths");
  const handler = vi.fn(async () => ({ done: true }));
  expect(await runJob("news-refresh", handler)).toEqual({ status: "skipped", reason: "stopping" });
  expect(handler).not.toHaveBeenCalled();
  expect(await requestDueJobs()).toBe(0);
  await expect(claimCanonicalEvidenceSource({ owner: sourceOwner, productId: paths.products[1] })).rejects.toBeInstanceOf(JobBatchBlockedError);
  expect(await ledger.readModelCapacityCallerControl()).toMatchObject({ mode: "draining" });
  expect(await ledger.requestModelSlot(request("new"))).toEqual({ kind: "deferred", reason: "draining" });
  // active 였다면 granted(살아 있는 예약)였다.
  expect(await ledger.requestModelSlot(paths.liveReq!)).toEqual({ kind: "deferred", reason: "draining" });
  expect(await ledger.beginModelDispatch(paths.liveRes as never)).toEqual({ kind: "ownership_lost" });
  expect(await db.transaction(tx => ledger.lockAi1ModelCapacityDispatch(tx, { reservation: paths.ai1 as never, identity: ai1Identity(4242), candidateId: 4242 }))).toBeNull();
  expect(await digest("paths")).toEqual(before);
  // policy 없는 disabled 장부도 fenced 면 draining 이다(원래 transport 로 가는 disabled 가 아니다).
  await p`UPDATE model_capacity_control SET mode = 'disabled', policy = NULL, policy_hash = NULL WHERE id = 1`;
  const disabled = await digest("paths");
  expect(await ledger.readModelCapacityCallerControl()).toEqual({ mode: "draining", epoch: 1, revision: 1, policyHash: null, policy: null });
  expect(await ledger.requestModelSlot(request("new-disabled"))).toEqual({ kind: "deferred", reason: "draining" });
  expect(await runJob("news-refresh", handler)).toEqual({ status: "skipped", reason: "stopping" });
  expect(await digest("paths")).toEqual(disabled);
  // 이미 시작한 호출의 owner 정산은 계속된다(자기 행 한 줄 + event 한 줄). 남의 만료 예약은 그대로다.
  expect(await ledger.markModelDispatchIndeterminate(paths.dispatch as never, "process_exit")).toBe(true);
  const after = await digest("paths");
  expect(Object.keys(after).filter(table => after[table] !== disabled[table]).sort()).toEqual(["model_capacity_events", "model_capacity_requests"]);
  expect((await p`SELECT state FROM model_capacity_requests WHERE request_id = ${paths.staleId}::uuid`)[0].state).toBe("reserved");
}, 120_000);

it("lock order on real backends: control → fence deadlocks with a fence UPDATE; the shipped fence → control order only queues", async () => {
  bindDb("order");
  const o = pool("order");
  await openLedger("order");
  // 거절한 순서(장부 control 을 먼저 잡고 fence 를 나중에 확인)는 seal 의 fence UPDATE → control UPDATE 와 실제로 교착한다.
  const a = await o.reserve(), b = await o.reserve();
  try {
    await a`BEGIN`; await b`BEGIN`;
    await a`SELECT id FROM model_capacity_control WHERE id = 1 FOR UPDATE`;
    await b`SELECT id FROM dr_writer_fence WHERE id = 1 FOR UPDATE`;
    const results = await Promise.allSettled([a`SELECT id FROM dr_writer_fence WHERE id = 1 FOR SHARE`, (async () => {
      await waitFor(async () => (await waiters("order")).length === 1 ? true : undefined, "hazard_first_wait");
      return b`SELECT id FROM model_capacity_control WHERE id = 1 FOR UPDATE`;
    })()]);
    expect(results.filter(result => result.status === "rejected").map(result => pgCode((result as PromiseRejectedResult).reason))).toEqual(["40P01"]);
  } finally { await a`ROLLBACK`.catch(() => {}); await b`ROLLBACK`.catch(() => {}); a.release(); b.release(); }

  // 1) fence UPDATE 를 쥔 동안(= seal/fence-old 진행 중) 장부 호출은 fence 에서 기다리고 control 은 잡지 않는다.
  const holder = await o.reserve();
  try {
    await holder`BEGIN`;
    const [{ pid }] = await holder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await holder`SELECT id FROM dr_writer_fence WHERE id = 1 FOR UPDATE`;
    const slot = ledger.requestModelSlot(request("queued-behind-fence"));
    const waiting = await waitFor(async () => (await waiters("order")).find(row => row.blockers.includes(pid)), "ledger_waits_fence");
    expect(waiting.query).toContain("dr_writer_fence");
    // 기다리는 장부 TX 는 control 을 쥐지 않았다: seal 의 다음 lock 이 바로 잡힌다.
    await holder`SELECT id FROM model_capacity_control WHERE id = 1 FOR UPDATE NOWAIT`;
    await holder`ROLLBACK`;
    expect((await slot).kind).toBe("granted");
  } finally { await holder`ROLLBACK`.catch(() => {}); holder.release(); }

  // 2) 장부가 fence SHARE 뒤 control 에서 기다리는 동안 실제 seal(dry-run) 은 fence 에서 기다린다: seal → 장부 → holder, 순환 없음.
  const plan = await planFor("order");
  const control = await o.reserve();
  try {
    await control`BEGIN`;
    const [{ pid }] = await control<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await control`SELECT id FROM model_capacity_control WHERE id = 1 FOR UPDATE`;
    const slot = ledger.requestModelSlot(request("holding-fence-share"));
    const ledgerWait = await waitFor(async () => (await waiters("order")).find(row => row.blockers.includes(pid)), "ledger_waits_control");
    expect(ledgerWait.query).toContain("model_capacity_control");
    const seal = repo.sealRestoredDatabase(plan, false);
    const sealWait = await waitFor(async () => (await waiters("order")).find(row => row.blockers.includes(ledgerWait.pid)), "seal_waits_ledger");
    expect(sealWait.query).toContain("dr_writer_fence");
    expect(sealWait.blockers).toEqual([ledgerWait.pid]);
    await control`ROLLBACK`;
    const [granted, sealed] = await Promise.all([slot, seal]);
    expect(granted.kind).toBe("granted");
    expect(sealed).toMatchObject({ state: "sealed" });
  } finally { await control`ROLLBACK`.catch(() => {}); control.release(); }
  // dry-run seal 은 ROLLBACK 이다.
  expect((await o`SELECT state FROM dr_writer_fence WHERE id = 1`)[0].state).toBe("active");

  // 3) runJob claim 도 같다: jobs 행에서 기다리는 claim(fence SHARE 보유) 뒤에 seal 이 줄 선다.
  await o`INSERT INTO jobs (name) VALUES ('news-refresh') ON CONFLICT (name) DO NOTHING`;
  const jobHolder = await o.reserve();
  try {
    await jobHolder`BEGIN`;
    const [{ pid }] = await jobHolder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await jobHolder`SELECT name FROM jobs WHERE name = 'news-refresh' FOR UPDATE`;
    const run = runJob("news-refresh", async () => ({ done: true }));
    const claimWait = await waitFor(async () => (await waiters("order")).find(row => row.blockers.includes(pid)), "claim_waits_job");
    const seal = repo.sealRestoredDatabase(plan, false);
    const sealWait = await waitFor(async () => (await waiters("order")).find(row => row.blockers.includes(claimWait.pid)), "seal_waits_claim");
    expect(sealWait.query).toContain("dr_writer_fence");
    await jobHolder`ROLLBACK`;
    const [ran, sealed] = await Promise.all([run, seal]);
    expect(ran).toMatchObject({ status: "completed" });
    expect(sealed).toMatchObject({ state: "sealed" });
  } finally { await jobHolder`ROLLBACK`.catch(() => {}); jobHolder.release(); }
}, 120_000);

it("lock order under concurrency: seal (dry-run) races every fenced path without a deadlock", async () => {
  bindDb("order");
  const o = pool("order");
  await o`UPDATE evidence_source_control SET enabled = true, cursor = 0 WHERE id = 1`;
  const plan = await planFor("order");
  const rejected: unknown[] = [];
  for (let round = 0; round < 12; round++) {
    const product = await seedProduct("order", round);
    const settled = await Promise.allSettled([
      repo.sealRestoredDatabase(plan, false),
      requestDueJobs(),
      runJob("news-refresh", async () => ({ done: true })),
      claimCanonicalEvidenceSource({ owner: { instanceId: `${prefix}-race`, bootId: `boot-${round}` }, productId: product }),
      (async () => {
        const slot = await ledger.requestModelSlot(request(`race-${round}`));
        if (slot.kind === "granted") await ledger.cancelReservedModelSlot(slot.reservation);
        return slot.kind;
      })(),
      ledger.readModelCapacityCallerControl(),
      repo.sealRestoredDatabase(plan, false),
    ]);
    rejected.push(...settled.filter(result => result.status === "rejected").map(result => (result as PromiseRejectedResult).reason));
  }
  expect(rejected.map(error => [pgCode(error), String(error)])).toEqual([]);
  expect((await o`SELECT state FROM dr_writer_fence WHERE id = 1`)[0].state).toBe("active");
}, 180_000);

it("before 0095 (no fence row / no fence table) every path fails closed without writing", async () => {
  bindDb("pre");
  const x = pool("pre");
  await openLedger("pre");
  await x`UPDATE evidence_source_control SET enabled = true, cursor = 0 WHERE id = 1`;
  const product = await seedProduct("pre", 1);
  const attempts = () => [
    runJob("news-refresh", async () => ({ done: true })),
    requestDueJobs(),
    claimCanonicalEvidenceSource({ owner: sourceOwner, productId: product }),
    ledger.readModelCapacityCallerControl(),
    ledger.requestModelSlot(request("pre")),
  ];
  await x`DELETE FROM dr_writer_fence`;
  const before = await digest("pre");
  for (const result of await Promise.allSettled(attempts())) {
    expect(result.status).toBe("rejected");
    expect(String((result as PromiseRejectedResult).reason)).toContain("dr_writer_fence_missing");
  }
  expect(await digest("pre")).toEqual(before);
  await x`ALTER TABLE dr_writer_fence RENAME TO dr_writer_fence_pr15c_absent`;
  const tables = WATCHED.filter(table => table !== "dr_writer_fence");
  const rows = async () => Object.fromEntries(await Promise.all(tables.map(async table =>
    [table, (await x.unsafe(`SELECT count(*)::int AS n, md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY to_jsonb(t)::text), '')) AS h FROM ${table} t`))[0]] as const)));
  const snapshot = await rows();
  for (const result of await Promise.allSettled(attempts())) {
    expect(result.status).toBe("rejected");
    expect(pgCode((result as PromiseRejectedResult).reason)).toBe("42P01");
  }
  expect(await rows()).toEqual(snapshot);
}, 120_000);
