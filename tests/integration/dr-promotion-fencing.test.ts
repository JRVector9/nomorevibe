import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { httpOriginPolicyHash } from "@/lib/net/http-origin-policy";
import * as ledger from "@/lib/llm/capacity-repository";
import * as roles from "@/lib/jobs/role-leader";
import * as items from "@/lib/jobs/items/repository";
import * as jobControl from "@/lib/jobs/control";
import { requestOriginHop } from "@/lib/net/origin-permits";
import * as fence from "@/lib/operations/dr/epoch";
import * as repo from "@/lib/operations/dr/repository";
import * as permits from "@/lib/operations/dr/permits";
import type { PromotionPlan } from "@/lib/operations/dr/promotion";
import type { ItemLease } from "@/lib/jobs/items/types";
import { assertLocalTestDatabase } from "../../scripts/test-database";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// 두 DB: primary(옛 writer)와 restored(복원 사본). 선택 env가 있으면 restored를 다른 PostgreSQL 서버에 만든다.
// 둘 다 이 파일이 새로 만들고 지우는 임시 DB다(공유 test DB의 행·제어값은 건드리지 않는다).
const root = fileURLToPath(new URL("../..", import.meta.url));
const restoredServer = process.env.DR_RESTORED_TEST_DATABASE_URL;
if (restoredServer !== undefined) assertLocalTestDatabase(restoredServer);
const tag = randomBytes(6).toString("hex"), prefix = `pr15-${tag}`;
const names = { primary: `nomorevibe_test_pr15p_${tag}`, restored: `nomorevibe_test_pr15r_${tag}` } as const;
const servers = { primary: TEST_DATABASE_URL, restored: restoredServer ?? TEST_DATABASE_URL } as const;
const withDatabase = (url: string, name: string) => { const value = new URL(url); value.pathname = `/${name}`; return value.toString(); };
const urls = { primary: withDatabase(servers.primary, names.primary), restored: withDatabase(servers.restored, names.restored) } as const;
type Side = keyof typeof names;
const created: Side[] = [], pools = new Map<Side, postgres.Sql>();
const pool = (side: Side) => { let client = pools.get(side); if (!client) { client = postgres(urls[side], { max: 4, prepare: false, onnotice: () => {} }); pools.set(side, client); } return client; };
/** lib의 전역 db proxy를 이 단계의 DB로 돌린다(실제 repository/ledger API를 그대로 부르기 위해). */
function use(side: Side) { const g = globalThis as { db?: unknown; pgClient?: unknown }; g.pgClient = pool(side); g.db = drizzle(pool(side), { schema }); }

const inst = { role: `${prefix}-m3-crawler`, item: `${prefix}-m3-fetch`, model: `${prefix}-m3-reviewer`, http: `${prefix}-mini-crawler`,
  declared: `${prefix}-oracle-text`, next: `${prefix}-oracle-new`, d11: `${prefix}-m3-d11` };
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 8, providerLimits: { acct: 8 }, groupLimits: { g: 8 }, poolLimits: { reviewer: 8, text: 8 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 8, queueTtlMs: 600_000, reservationTtlMs: 600_000,
  routes: [{ routeId: "pr15-route", provider: "fixture", model: "m", providerBudgetId: "acct", groupId: "g" }] };
const httpPolicy = { version: 1 as const, instanceHosts: { [inst.http]: "mini" as const, [inst.next]: "oracle-osaka-smoke" as const } };
const ownerModel = { instanceId: inst.model, bootId: randomUUID() };
const request = (owner: { instanceId: string; bootId: string }, work: string) => ({ requestId: randomUUID(), workKey: `${prefix}:${work}`, owner,
  class: "background" as const, pool: "text" as const, routeId: "pr15-route", provider: "fixture", model: "m" });
const operator = "pr15-root-driver";
const state = {} as { pDb: fence.DbIdentity; rDb: fence.DbIdentity; lineage: string; oldBinding: fence.WriterBinding; role: roles.RoleLease;
  item: ItemLease; job: jobControl.JobLease; reserved: Extract<Awaited<ReturnType<typeof ledger.requestModelSlot>>, { kind: "granted" }>;
  dispatched: string; indeterminate: string; hops: { dispatched: string; reserved: string }; snapshotAt: string; plan: PromotionPlan;
  oldDbFenced: fence.OldDbFencedPayload };
let http: Server, port = 0;
const dbNow = async (side: Side) => (await pool(side)<{ now: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)[0].now;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function cli(args: string[], side: Side): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/ops/dr/promotion.ts", ...args], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(`${urls[side]}\n`);
  });
}
/** 복원 흉내: 관련 장부 테이블을 primary 그대로 restored에 논리 복사한다(시퀀스는 max로 맞춘다). 전체 dump 충실도는 PR14b 범위다. */
async function copyLedger(): Promise<string> {
  const from = pool("primary"), to = pool("restored"), at = await dbNow("primary");
  const read = async (table: string) => JSON.stringify((await from.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM ${table} t`))[0].rows);
  const [fresh] = await to<{ count: number }[]>`SELECT (SELECT count(*) FROM model_capacity_requests) + (SELECT count(*) FROM http_origin_hops)
    + (SELECT count(*) FROM pipeline_item_leases) + (SELECT count(*) FROM dr_promotions) AS count`;
  expect(Number(fresh.count)).toBe(0);
  const replaced = ["dr_writer_fence", "job_batch_control", "model_capacity_control", "http_origin_control", "role_leases", "jobs", "pipeline_stage_modes"];
  const inserted = ["pipeline_item_leases", "model_capacity_requests", "model_capacity_events", "http_origin_hops", "http_origin_events"];
  const rows = new Map<string, string>();
  for (const table of [...replaced, ...inserted]) rows.set(table, await read(table));
  await to.begin(async tx => {
    for (const table of replaced) await tx.unsafe(`DELETE FROM ${table}`);
    for (const table of [...replaced, ...inserted]) await tx.unsafe(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::text::jsonb)`, [rows.get(table)!]);
    for (const [table, column] of [["model_capacity_requests", "queue_ordinal"], ["model_capacity_events", "id"], ["http_origin_events", "id"]])
      await tx.unsafe(`SELECT setval(pg_get_serial_sequence('${table}', '${column}'), coalesce((SELECT max(${column}) FROM ${table}), 1), (SELECT max(${column}) FROM ${table}) IS NOT NULL)`);
  });
  return at;
}

beforeAll(async () => {
  ensureSchema();
  for (const side of ["primary", "restored"] as const) {
    const admin = postgres(servers[side], { max: 1, onnotice: () => {} });
    try { await admin.unsafe(`CREATE DATABASE ${names[side]}`); created.push(side); } finally { await admin.end({ timeout: 5 }); }
    const client = postgres(urls[side], { max: 1, onnotice: () => {} });
    try { await client.unsafe("set statement_timeout = 0"); await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") }); }
    finally { await client.end({ timeout: 5 }); }
  }
  http = createServer((_request, response) => response.end("ok"));
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  port = (http.address() as { port: number }).port;
}, 600_000);

afterAll(async () => {
  await new Promise<void>(resolve => http ? http.close(() => resolve()) : resolve());
  for (const client of pools.values()) await client.end({ timeout: 5 });
  const g = globalThis as { db?: unknown; pgClient?: unknown }; delete g.db; delete g.pgClient;
  for (const side of created) {
    const admin = postgres(servers[side], { max: 1, onnotice: () => {} });
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${names[side]} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
  }
}, 120_000);

it("applies 0095 with every journal entry on both fresh databases and keeps DR evidence append-only", async () => {
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  expect(journal.entries.map(entry => entry.tag)).toContain("0095_dr_writer_fence");
  for (const side of ["primary", "restored"] as const) {
    const [applied] = await pool(side)<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(journal.entries.length);
    const [row] = await pool(side)`SELECT writer_epoch::int, state FROM dr_writer_fence WHERE id = 1`;
    expect(row).toEqual({ writer_epoch: 1, state: "active" });
    await expect(pool(side)`UPDATE dr_writer_fence SET state = 'fenced' WHERE id = 1`).rejects.toMatchObject({ code: "23514" });
    await expect(pool(side)`UPDATE dr_fence_events SET operator = 'x'`).rejects.toMatchObject({ code: "55000" });
    await expect(pool(side)`DELETE FROM dr_promotion_evidence`).rejects.toMatchObject({ code: "55000" });
    await expect(pool(side)`TRUNCATE dr_process_group_events`).rejects.toMatchObject({ code: "55000" });
  }
  console.info("pr15_migrations", { journal: journal.entries.length, restoredServer: restoredServer ? "separate" : "same" });
});

it("builds the old writer's live authority on the primary through the real ledgers", async () => {
  use("primary");
  state.pDb = await db.transaction(tx => fence.readDatabaseIdentity(tx));
  state.oldBinding = await db.transaction(tx => fence.bindWriterFence(tx));
  state.lineage = state.oldBinding.lineageId;
  const p = pool("primary");
  await p`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(policy)}::text::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)} WHERE id = 1`;
  await p`UPDATE http_origin_control SET mode = 'open', policy = ${JSON.stringify(httpPolicy)}::text::jsonb, policy_hash = ${httpOriginPolicyHash(httpPolicy)} WHERE id = 1`;
  await p`UPDATE pipeline_stage_modes SET mode = 'items', writer_contract_version = 1 WHERE stage = 'fetch'`;
  const role = await roles.tryAcquireRole({ role: "crawler", instanceId: inst.role, bootId: randomUUID(), release: "pr15", kind: "primary" });
  expect(role).not.toBeNull(); state.role = role!;
  state.job = { name: `${prefix}-job`, token: randomUUID(), requestedVersion: 0 };
  await p`INSERT INTO jobs (name, lease_token, locked_at) VALUES (${state.job.name}, ${state.job.token}, now())`;
  const claimed = await db.transaction(async tx => items.claimItemLease(tx, await items.lockItemStage(tx, "fetch"),
    { stage: "fetch", frontierId: 4242, repo: "pr15/fixture", claim: { attempts: 1, nextAttemptAt: new Date().toISOString() } },
    { instanceId: inst.item, bootId: randomUUID() }, 600_000));
  expect(claimed).not.toBeNull(); state.item = claimed!;
  const reserved = await ledger.requestModelSlot(request(ownerModel, "reserved"));
  if (reserved.kind !== "granted") throw new Error("fixture_reserved");
  state.reserved = reserved;
  const begin = async (work: string) => {
    const slot = await ledger.requestModelSlot(request(ownerModel, work));
    if (slot.kind !== "granted") throw new Error("fixture_slot");
    const dispatched = await ledger.beginModelDispatch(slot.reservation);
    if (dispatched.kind !== "dispatched") throw new Error("fixture_dispatch");
    return dispatched.dispatch;
  };
  state.dispatched = (await begin("dispatched")).requestId;
  const lost = await begin("indeterminate");
  expect(await ledger.markModelDispatchIndeterminate(lost, "process_exit")).toBe(true);
  state.indeterminate = lost.requestId;
  state.hops = { dispatched: randomUUID(), reserved: randomUUID() };
  const hash = httpOriginPolicyHash(httpPolicy), bootId = randomUUID();
  await p`INSERT INTO http_origin_hops (id, token, instance_id, boot_id, host_id, origin, epoch, revision, policy_hash, state, reserved_until, dispatched_at) VALUES
    (${state.hops.dispatched}, ${randomUUID()}, ${inst.http}, ${bootId}, 'mini', 'https://pr15-a.example', 1, 1, ${hash}, 'dispatched', clock_timestamp() + interval '5 seconds', clock_timestamp()),
    (${state.hops.reserved}, ${randomUUID()}, ${inst.http}, ${bootId}, 'mini', 'https://pr15-b.example', 1, 1, ${hash}, 'reserved', clock_timestamp() + interval '1 hour', NULL)`;
  await p`INSERT INTO http_origin_events (hop_id, kind) VALUES (${state.hops.dispatched}, 'reserved'), (${state.hops.dispatched}, 'dispatched'), (${state.hops.reserved}, 'reserved')`;
}, 60_000);

it("a restored ledger accepts copied tokens until seal, then rejects every copied authority and blocks new permits", async () => {
  state.snapshotAt = await copyLedger();
  use("restored");
  state.rDb = await db.transaction(tx => fence.readDatabaseIdentity(tx));
  expect(fence.sameDatabase(state.rDb, state.pDb)).toBe(false);
  // 위험 구간의 실제 관측: seal 전 복원본은 옛 owner의 item/role/job token을 그대로 받는다.
  await db.transaction(async tx => items.assertItemLease(tx, await items.lockItemStage(tx, "fetch"), state.item));
  await db.transaction(tx => roles.assertRoleLease(tx, state.role));
  await db.transaction(tx => jobControl.assertJobLease(tx, state.job));
  state.plan = { version: 1, promotionId: randomUUID(), lineageId: state.lineage, fromEpoch: 1, knownActiveEpoch: 1, restoredDb: state.rDb,
    oldDbs: [state.pDb], oldInstances: [inst.declared], snapshotAt: state.snapshotAt, operator };
  const preview = await repo.sealRestoredDatabase(state.plan, false);
  expect(preview).toMatchObject({ state: "sealed", sealSnapshot: { modelBudgets: ["acct"], activeModelCalls: 3, activeHttpHops: 2,
    revoked: { roles: 1, jobs: 1, items: 1, sourceClaims: 0 }, modelControl: { epoch: 2, revision: 2, mode: "draining" }, httpControl: { epoch: 2, mode: "draining" } } });
  expect(preview.sealSnapshot.instances).toEqual([inst.http, inst.item, inst.model, inst.role].sort());
  // dry-run은 ROLLBACK이다: fence와 token이 그대로다.
  expect((await db.transaction(tx => fence.lockWriterFence(tx, "share"))).state).toBe("active");
  await db.transaction(async tx => items.assertItemLease(tx, await items.lockItemStage(tx, "fetch"), state.item));
  const sealed = await repo.sealRestoredDatabase(state.plan, true);
  expect({ ...sealed.sealSnapshot, sealedAt: preview.sealSnapshot.sealedAt }).toEqual(preview.sealSnapshot);
  expect(await db.transaction(tx => fence.lockWriterFence(tx, "share"))).toMatchObject({ state: "fenced", reason: "promotion_sealed", promotionId: state.plan.promotionId, writerEpoch: 1 });
  await expect(db.transaction(async tx => items.assertItemLease(tx, await items.lockItemStage(tx, "fetch"), state.item))).rejects.toThrow("item_lease_lost");
  await expect(db.transaction(tx => roles.assertRoleLease(tx, state.role))).rejects.toThrow("role_lease_lost");
  await expect(db.transaction(tx => jobControl.assertJobLease(tx, state.job))).rejects.toThrow("job_lease_lost");
  expect(await roles.renewRole(state.role)).toBe(false);
  expect(await roles.tryAcquireRole({ role: "crawler", instanceId: inst.next, bootId: randomUUID(), release: "pr15", kind: "primary" })).toBeNull();
  await expect(db.transaction(tx => fence.assertWriterFence(tx, state.oldBinding))).rejects.toThrow("dr_writer_site_fenced");
  expect(await ledger.beginModelDispatch(state.reserved.reservation)).toEqual({ kind: "ownership_lost" });
  expect(await ledger.requestModelSlot(request({ instanceId: inst.next, bootId: randomUUID() }, "new"))).toEqual({ kind: "deferred", reason: "draining" });
  process.env.SERVICE_INSTANCE_ID = inst.next;
  try { await expect(requestOriginHop(`http://127.0.0.1:${port}/before`, { redirect: "manual", signal: AbortSignal.timeout(5_000), headers: {} })).rejects.toThrow("http_origin_permit_unavailable"); }
  finally { delete process.env.SERVICE_INSTANCE_ID; }
  await expect(repo.sealRestoredDatabase(state.plan, true)).rejects.toThrow("dr_in_place_promotion_forbidden");
  await expect(permits.openHttpPermitsAfterDrain({ promotionId: state.plan.promotionId, operator }, true)).rejects.toThrow("dr_promotion_not_active");
}, 60_000);

it("D11: reclaims only calls whose whole possible process group has recorded ESRCH evidence", async () => {
  use("primary");
  const owner = { instanceId: inst.d11, bootId: randomUUID() };
  await expect(repo.recordSpawnIntent(owner)).rejects.toThrow("dr_process_owner_not_opened");
  await repo.openProcessGroupOwner(owner);
  const spawnRecord = await repo.recordSpawnIntent(owner);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  try {
    await repo.recordSpawned(owner, spawnRecord, pid);
    const slot = await ledger.requestModelSlot(request(owner, "d11"));
    if (slot.kind !== "granted") throw new Error("fixture_d11_slot");
    const begun = await ledger.beginModelDispatch(slot.reservation);
    if (begun.kind !== "dispatched") throw new Error("fixture_d11_dispatch");
    await expect(repo.recordGroupExited(owner, spawnRecord, pid)).rejects.toThrow("dr_process_group_alive");
    const unexited = await repo.readProcessReclaimReport(owner, new Map([["acct", { termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 1 }]]));
    expect(unexited.rows).toMatchObject([{ requestId: begun.dispatch.requestId, reclaimable: false, reason: "spawn_not_exited:1" }]);
    process.kill(-pid, "SIGKILL");
    for (let attempt = 0; attempt < 100 && !repo.processGroupGone(pid); attempt++) await sleep(50);
    expect(repo.processGroupGone(pid)).toBe(true);
    await repo.recordGroupExited(owner, spawnRecord, pid);
    await sleep(20);
    const report = await repo.readProcessReclaimReport(owner, new Map([["acct", { termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 1 }]]));
    expect(report.rows).toMatchObject([{ requestId: begun.dispatch.requestId, state: "dispatched", reclaimable: true, reason: null }]);
    expect((await repo.readProcessReclaimReport(owner, new Map())).rows).toMatchObject([{ reclaimable: false, reason: "provider_deadline_unknown" }]);
    const older = await repo.readProcessReclaimReport(ownerModel, new Map([["acct", { termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 1 }]]));
    expect(older.rows.map(row => [row.requestId, row.reclaimable, row.reason]).sort()).toEqual(
      [[state.dispatched, false, "owner_not_opened_before_dispatch"], [state.indeterminate, false, "owner_not_opened_before_dispatch"]].sort());
    // 보고는 읽기 전용이다. 장부 해제 hook이 없으므로 행은 그대로 dispatched다.
    expect((await pool("primary")`SELECT state FROM model_capacity_requests WHERE request_id = ${begun.dispatch.requestId}`)[0].state).toBe("dispatched");
  } finally { if (!repo.processGroupGone(pid)) process.kill(-pid, "SIGKILL"); }
  const plan = path.join(mkdtempSync(path.join(tmpdir(), "pr15-cli-")), "plan.json");
  try {
    writeFileSync(plan, JSON.stringify({ ...state.plan, promotionId: randomUUID() }));
    const sealOld = await cli(["seal", `--plan=${plan}`, "--database-url-stdin"], "primary");
    expect(sealOld.code).toBe(1);
    expect(JSON.parse(sealOld.stderr)).toEqual({ code: "dr_database_identity_mismatch" });
  } finally { rmSync(path.dirname(plan), { recursive: true, force: true }); }
}, 60_000);

it("fences the old primary one way: old writers lose roles there and it can never be promoted in place", async () => {
  use("primary");
  const want = { lineageId: state.lineage, writerEpoch: 1, db: state.pDb, operator };
  await expect(db.transaction(tx => fence.fenceWriterSite(tx, { ...want, db: state.rDb }))).rejects.toThrow("dr_database_identity_mismatch");
  state.oldDbFenced = await db.transaction(tx => fence.fenceWriterSite(tx, want));
  expect(state.oldDbFenced).toMatchObject({ db: state.pDb, fencedDb: state.pDb, lineageId: state.lineage, writerEpoch: 1, state: "fenced" });
  expect(await db.transaction(tx => fence.fenceWriterSite(tx, want))).toMatchObject({ db: state.pDb, writerEpoch: 1 });
  expect(await roles.renewRole(state.role)).toBe(false);
  expect(await roles.tryAcquireRole({ role: "publisher", instanceId: inst.role, bootId: randomUUID(), release: "pr15", kind: "primary" })).toBeNull();
  await expect(db.transaction(tx => fence.assertWriterFence(tx, state.oldBinding))).rejects.toThrow("dr_writer_site_fenced");
  await expect(repo.sealRestoredDatabase({ ...state.plan, promotionId: randomUUID(), restoredDb: state.pDb, oldDbs: [state.rDb] }, true))
    .rejects.toThrow("dr_in_place_promotion_forbidden");
  const [events] = await pool("primary")<{ count: number }[]>`SELECT count(*)::int AS count FROM dr_fence_events WHERE reason = 'operator_fence'`;
  expect(events.count).toBe(1);
}, 60_000);

it("promotes only with independent fencing, proven drain time and RPO reconciliation; dry-run and CLI do not commit", async () => {
  use("restored");
  const id = state.plan.promotionId;
  const blocked = await repo.promoteSealedDatabase({ promotionId: id, operator }, true);
  expect(blocked.kind).toBe("blocked");
  expect(blocked.status.evaluation.blockers).toEqual(["old_db_unfenced:0", ...[inst.declared, inst.http, inst.item, inst.model, inst.role].sort().map(i => `writer_process_unfenced:${i}`),
    "drain_blocked:http:writer_process_unfenced", "drain_blocked:model:acct:writer_process_unfenced", "external_effects_unreconciled"]);
  await expect(repo.recordPromotionEvidence({ promotionId: id, kind: "old_db_fenced", subject: "db:1:2", payload: state.oldDbFenced, operator }, true)).rejects.toThrow("dr_evidence_subject_mismatch");
  await expect(repo.recordPromotionEvidence({ promotionId: id, kind: "writer_process_stopped", subject: inst.role,
    payload: { version: 1, instanceId: inst.role, method: "lease_expired", reference: "x", autoRestartDisabled: true, stoppedAt: await dbNow("restored"), skewBoundMs: 1 }, operator }, true)).rejects.toThrow();
  const record = (kind: Parameters<typeof repo.recordPromotionEvidence>[0]["kind"], subject: string, payload: unknown) =>
    repo.recordPromotionEvidence({ promotionId: id, kind, subject, payload, operator }, true);
  await record("old_db_fenced", `db:${state.pDb.systemIdentifier}:${state.pDb.databaseOid}`, state.oldDbFenced);
  const stoppedAt = await dbNow("restored");
  for (const instanceId of [inst.declared, inst.http, inst.item, inst.model, inst.role])
    await record("writer_process_stopped", instanceId, { version: 1, instanceId, method: "container_removed", reference: `fixture stop ${instanceId}`,
      autoRestartDisabled: true, stoppedAt, skewBoundMs: 8_000 });
  await record("provider_deadline", "model:acct", { version: 1, scope: "model:acct", termination: "provider_bound", hardDeadlineMs: 1_000, reference: "fixture provider hard deadline" });
  await record("external_effects_reconciled", "rpo-window", { version: 1, windowFrom: state.snapshotAt, windowTo: stoppedAt, method: "old_db_compared",
    reference: "fixture effects diff", reviewed: 0, corrective: "none" });
  const waiting = await repo.promoteSealedDatabase({ promotionId: id, operator }, true);
  expect(waiting.kind === "blocked" && waiting.status.evaluation.blockers).toEqual(["drain_waiting:http", "drain_waiting:model:acct"]);
  const status = await cli(["status", `--promotion=${id}`, "--database-url-stdin"], "restored");
  expect(status.code).toBe(3);
  expect(JSON.parse(status.stdout)).toMatchObject({ command: "status", blocked: true, result: { evaluation: { ready: false } } });
  expect((await cli(["status", `--promotion=${id}`, `--database-url=${urls.restored}`], "restored")).stderr).toContain("dr_cli_unknown_option");
  const notBefore = Date.parse(stoppedAt) + 8_000 + 1_000;
  for (let attempt = 0; attempt < 200 && !(await repo.readPromotionStatus(id)).evaluation.ready; attempt++) await sleep(100);
  const ready = await repo.readPromotionStatus(id);
  expect(ready.evaluation).toMatchObject({ ready: true, blockers: [] });
  expect(Date.parse(ready.now)).toBeGreaterThanOrEqual(notBefore);
  const dry = await cli(["promote", `--promotion=${id}`, `--operator=${operator}`, "--database-url-stdin"], "restored");
  expect(dry.code).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({ command: "promote", dryRun: true, result: { kind: "promoted", fence: { state: "active", writerEpoch: 2 } } });
  expect(await db.transaction(tx => fence.lockWriterFence(tx, "share"))).toMatchObject({ state: "fenced", writerEpoch: 1 });
  const promoted = await repo.promoteSealedDatabase({ promotionId: id, operator }, true);
  expect(promoted).toMatchObject({ kind: "promoted", fence: { state: "active", writerEpoch: 2, lineageId: state.lineage, promotionId: id } });
  expect((await repo.promoteSealedDatabase({ promotionId: id, operator }, true)).kind).toBe("blocked");
  await expect(db.transaction(tx => fence.assertWriterFence(tx, state.oldBinding))).rejects.toThrow("dr_writer_epoch_stale");
  const binding = await db.transaction(tx => fence.bindWriterFence(tx));
  expect(binding).toEqual({ lineageId: state.lineage, writerEpoch: 2 });
  await db.transaction(tx => fence.assertWriterFence(tx, binding));
  const identity = await cli(["identity", "--database-url-stdin"], "restored");
  expect(identity.code).toBe(0);
  expect(JSON.parse(identity.stdout).result).toMatchObject({ db: state.rDb, fence: { state: "active", writerEpoch: 2 } });
  const role = await roles.tryAcquireRole({ role: "crawler", instanceId: inst.next, bootId: randomUUID(), release: "pr15", kind: "primary" });
  expect(role?.epoch).toBe(state.role.epoch + 2);
  await expect(db.transaction(tx => roles.assertRoleLease(tx, state.role))).rejects.toThrow("role_lease_lost");
}, 120_000);

it("reopens HTTP only after settling old hops; keeps model permits closed while old dispatches are unreleased", async () => {
  use("restored");
  const id = state.plan.promotionId;
  const dryHttp = await permits.openHttpPermitsAfterDrain({ promotionId: id, operator }, false);
  expect(dryHttp).toMatchObject({ kind: "opened", released: [state.hops.dispatched], cancelled: [state.hops.reserved] });
  expect((await pool("restored")`SELECT mode FROM http_origin_control`)[0].mode).toBe("draining");
  const opened = await permits.openHttpPermitsAfterDrain({ promotionId: id, operator }, true);
  expect(opened).toEqual({ kind: "opened", controlEpoch: 2, released: [state.hops.dispatched], cancelled: [state.hops.reserved], mode: "open" });
  expect(Array.from(await pool("restored")`SELECT id::text, state FROM http_origin_hops ORDER BY id`)).toEqual(
    [{ id: state.hops.dispatched, state: "released" }, { id: state.hops.reserved, state: "cancelled" }].sort((a, b) => a.id < b.id ? -1 : 1));
  process.env.SERVICE_INSTANCE_ID = inst.next;
  try {
    const response = await requestOriginHop(`http://127.0.0.1:${port}/after`, { redirect: "manual", signal: AbortSignal.timeout(5_000), headers: {} });
    expect(await response.text()).toBe("ok");
  } finally { delete process.env.SERVICE_INSTANCE_ID; }
  let fresh: { state: string; epoch: number }[] = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    fresh = Array.from(await pool("restored")<{ state: string; epoch: number }[]>`SELECT state, epoch::int FROM http_origin_hops WHERE instance_id = ${inst.next}`);
    if (fresh[0]?.state === "released") break; await sleep(50);
  }
  expect(fresh).toEqual([{ state: "released", epoch: 2 }]);
  const dryModel = await permits.openModelCapacityAfterDrain({ promotionId: id, operator }, false);
  expect(dryModel).toMatchObject({ kind: "blocked", reason: "model_capacity_old_dispatch_unreleased:2", cancelledReservations: [state.reserved.reservation.requestId] });
  expect((await pool("restored")`SELECT state FROM model_capacity_requests WHERE request_id = ${state.reserved.reservation.requestId}`)[0].state).toBe("reserved");
  const model = await permits.openModelCapacityAfterDrain({ promotionId: id, operator }, true);
  expect(model).toMatchObject({ kind: "blocked", reason: "model_capacity_old_dispatch_unreleased:2", cancelledReservations: [state.reserved.reservation.requestId] });
  expect(Array.from(await pool("restored")`SELECT r.state, e.kind FROM model_capacity_requests r JOIN model_capacity_events e ON e.request_id = r.request_id
    WHERE r.request_id = ${state.reserved.reservation.requestId} ORDER BY e.id DESC LIMIT 1`)).toEqual([{ state: "withdrawn", kind: "reservation_cancelled" }]);
  expect(Array.from(await pool("restored")`SELECT state FROM model_capacity_requests WHERE request_id IN (${state.dispatched}, ${state.indeterminate}) ORDER BY state`))
    .toEqual([{ state: "dispatched" }, { state: "indeterminate" }]);
  expect((await pool("restored")`SELECT mode FROM model_capacity_control`)[0].mode).toBe("draining");
  expect(await ledger.requestModelSlot(request({ instanceId: inst.next, bootId: randomUUID() }, "after"))).toEqual({ kind: "deferred", reason: "draining" });
}, 60_000);
