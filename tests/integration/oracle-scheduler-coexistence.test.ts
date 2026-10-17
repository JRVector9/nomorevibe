import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import * as fence from "@/lib/operations/dr/epoch";
import { ORACLE_DB_PRINCIPALS, oracleDbGrantStatements } from "@/lib/runtime/oracle-db-profile";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * PR11g 실제 PostgreSQL. 이 파일이 만들고 지우는 임시 DB 하나와 scheduler 최소권한 role 하나만 쓴다.
 * Oracle scheduler(nomorevibe_oracle_scheduler)와 M3 scheduler 두 복제본(소유자 계정)을 각자 별도 프로세스로 띄워
 * DR fence lock 뒤에 세운 뒤 동시에 풀어 같은 due 요청을 경합시킨다. role lease 없이 jobs 행 잠금과 due 조건만으로
 * 요청이 한 번만 생기는지, fence 된 DB 에서는 세 scheduler 모두 요청 0건인지 확인한다.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const tag = randomBytes(6).toString("hex"), name = `nomorevibe_test_pr11g_${tag}`, password = randomUUID();
const release = createHash("sha1").update(tag).digest("hex");
const ORACLE = ORACLE_DB_PRINCIPALS.scheduler;
const OWNER = decodeURIComponent(new URL(TEST_DATABASE_URL).username);
// 비교 대상 M3 복제본은 fence lock 대기 동안 끊기지 않게 lock 한도만 늘린다. Oracle 자식은 기본 한도 그대로다.
const PEER_TIMEOUTS = { DB_STATEMENT_TIMEOUT_MS: "60000", DB_LOCK_TIMEOUT_MS: "60000" };
const LEGACY = JOB_CATALOG.filter(job => job.intervalMs !== null && job.batchVersion !== 1).map(job => job.name);
const VERSIONED = JOB_CATALOG.filter(job => job.intervalMs !== null && job.batchVersion === 1).map(job => job.name);
const PENDING = "crawl-fetch", RESUMING = "news-refresh";
let pool: postgres.Sql | undefined, created = false, roleCreated = false;

const urlOf = (user?: string) => {
  const value = new URL(TEST_DATABASE_URL); value.pathname = `/${name}`;
  if (user) { value.username = user; value.password = password; }
  return value.toString();
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Run = { code: number | null; output: { principal?: string; requested?: number; error?: string; message?: string } };

/** 기존 tests/fixtures/oracle-role-db-driver.ts 의 scheduler 경로(observeService → markSchedulerSeen → requestDueJobs). */
function scheduler(instanceId: string, user?: string, extra: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/oracle-role-db-driver.ts"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? "test", LOG_LEVEL: "error", DATABASE_URL: urlOf(user),
        WORKER_ROLE: "scheduler", SERVICE_INSTANCE_ID: instanceId, RELEASE_TAG: release, PHYSICAL_HOST: user ? "oracle-osaka-smoke" : "m3",
        ORACLE_DRIVER_INPUT: JSON.stringify({ role: "scheduler", jobs: [], httpBase: "", bootId: randomUUID(), negatives: [] }), ...extra },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    child.once("error", reject);
    child.once("exit", code => {
      try { resolve({ code, output: JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") }); }
      catch { reject(new Error(`driver_output_invalid:${stdout.slice(-500)}:${stderr.slice(-2000)}`)); }
    });
  });
}
/** holder 가 쥔 dr_writer_fence 행을 실제로 기다리는 backend 수. */
async function waitForWaiters(holder: number, count: number, label: string) {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const [row] = await pool!<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = ${name} AND wait_event_type = 'Lock' AND ${holder} = ANY(pg_blocking_pids(pid))`;
    if (row.n >= count) return;
    await sleep(25);
  }
  throw new Error(`timeout:${label}`);
}
type Schedule = { name: string; requested: number; processed: number; next: string; notBefore: string | null; cursor: unknown };
// jobs 의 naive timestamp 는 세션 TimeZone 기준이다. 비교는 같은 세션에서 같은 형식으로 읽은 값끼리만 한다.
const schedules = async () => [...await pool!<Schedule[]>`SELECT name, requested_version::int AS requested, processed_version::int AS processed,
  to_char(next_scheduled_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next, to_char(not_before, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "notBefore",
  cursor FROM jobs WHERE name = ANY(${pool!.array([...LEGACY, ...VERSIONED])}::text[]) ORDER BY name`];
const rows = async (query: Promise<readonly postgres.Row[]>) => [...await query];

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  expect(journal.entries.map(entry => entry.tag)).toEqual(expect.arrayContaining(["0082_job_batches", "0095_dr_writer_fence", "0098_oracle_activation_gaps"]));
  const shared = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    // 남아 있던 같은 이름 role 은 이 파일 소유가 아니므로 쓰지도 지우지도 않는다.
    expect(await shared`SELECT rolname FROM pg_roles WHERE rolname = ${ORACLE}`).toHaveLength(0);
    await shared.unsafe(`CREATE DATABASE ${name}`); created = true;
  } finally { await shared.end({ timeout: 5 }); }
  const client = postgres(urlOf(), { max: 1, onnotice: () => {} });
  try { await client.unsafe("set statement_timeout = 0"); await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") }); }
  finally { await client.end({ timeout: 5 }); }
  pool = postgres(urlOf(), { max: 4, prepare: false, onnotice: () => {} });
  const [applied] = await pool<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  expect(await rows(pool`SELECT mode FROM job_batch_control WHERE id = 1`)).toEqual([{ mode: "legacy" }]);
  expect(await rows(pool`SELECT state FROM dr_writer_fence WHERE id = 1`)).toEqual([{ state: "active" }]);
  const [create, ...grants] = oracleDbGrantStatements("scheduler", { connectionLimit: 4 });
  await pool.unsafe(create); roleCreated = true;
  for (const statement of grants) await pool.unsafe(statement);
  await pool.unsafe(`ALTER ROLE ${ORACLE} PASSWORD '${password}'`);
  // 모든 정기 잡이 같은 요청 번호에서 due 다. 한 잡은 이미 미처리 요청이 있고, 한 잡은 cursor·not_before 로 재개 대기 중이다.
  await pool`INSERT INTO jobs (name, requested_version, processed_version, next_scheduled_at)
    SELECT n, 3, 3, clock_timestamp() - interval '1 hour' FROM unnest(${pool.array([...LEGACY, ...VERSIONED])}::text[]) n`;
  await pool`UPDATE jobs SET requested_version = 4 WHERE name = ${PENDING}`;
  await pool`UPDATE jobs SET cursor = '{"page":2}'::jsonb, not_before = clock_timestamp() + interval '10 minutes' WHERE name = ${RESUMING}`;
}, 600_000);

afterAll(async () => {
  const errors: unknown[] = [];
  for (const step of [async () => { await pool?.end({ timeout: 5 }); }, async () => {
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      if (roleCreated) await admin.unsafe(`DROP ROLE IF EXISTS ${ORACLE}`);
    } finally { await admin.end({ timeout: 5 }); }
  }]) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "pr11g_cleanup_failed");
}, 120_000);

it("an Oracle scheduler racing two M3 replicas adds each due request exactly once without any role lease", async () => {
  const before = new Map((await schedules()).map(row => [row.name, row]));
  const leases = await rows(pool!`SELECT to_jsonb(r) AS row FROM role_leases r ORDER BY role`);
  const holder = await pool!.reserve();
  const runs: Promise<Run>[] = [];
  try {
    await holder`BEGIN`;
    const [{ pid }] = await holder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await holder`SELECT id FROM dr_writer_fence WHERE id = 1 FOR UPDATE`;
    runs.push(scheduler(`${tag}-m3-a`, undefined, PEER_TIMEOUTS), scheduler(`${tag}-m3-b`, undefined, PEER_TIMEOUTS));
    await waitForWaiters(pid, 2, "m3_replicas_wait_fence");
    runs.push(scheduler(`${tag}-oracle`, ORACLE));
    await waitForWaiters(pid, 3, "oracle_waits_fence");
  } finally { await holder`ROLLBACK`.catch(() => {}); holder.release(); }
  const [m3a, m3b, oracle] = await Promise.all(runs);
  for (const run of [m3a, m3b, oracle]) expect(run.output.error).toBeUndefined();
  expect([m3a.code, m3b.code, oracle.code]).toEqual([0, 0, 0]);
  expect([m3a.output.principal, m3b.output.principal, oracle.output.principal]).toEqual([OWNER, OWNER, ORACLE]);
  // 세 scheduler 의 due 수 합이 정기 잡 수와 같다: 같은 due 를 두 scheduler 가 함께 세지 않았다.
  expect([m3a, m3b, oracle].reduce((sum, run) => sum + Number(run.output.requested), 0)).toBe(LEGACY.length);
  const after = await schedules();
  const [clock] = await pool!<{ now: string }[]>`SELECT to_char(clock_timestamp()::timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  for (const row of after) {
    const old = before.get(row.name)!, interval = JOB_CATALOG.find(job => job.name === row.name)!.intervalMs!;
    if (VERSIONED.includes(row.name)) { expect(row).toEqual(old); continue; } // legacy 배치 상태의 versioned 잡은 건드리지 않는다
    // 3→4 정확히 한 번. 이미 미처리 요청(4)이 있던 잡은 그 요청에 합쳐진다.
    expect({ name: row.name, requested: row.requested, processed: row.processed }).toEqual({ name: row.name, requested: 4, processed: 3 });
    expect(Date.parse(row.next)).toBeGreaterThan(Date.parse(old.next));
    expect(Date.parse(row.next)).toBeLessThanOrEqual(Date.parse(clock.now) + interval);
    expect([row.cursor, row.notBefore]).toEqual([old.cursor, old.notBefore]);
  }
  expect(after.find(row => row.name === RESUMING)).toMatchObject({ cursor: { page: 2 }, notBefore: before.get(RESUMING)!.notBefore });
  expect(await rows(pool!`SELECT to_jsonb(r) AS row FROM role_leases r ORDER BY role`)).toEqual(leases);
  const services = await pool!`SELECT key FROM operations_observations WHERE key LIKE 'service:scheduler:%' ORDER BY key`;
  expect(services.map(row => row.key)).toEqual([`service:scheduler:${tag}-m3-a`, `service:scheduler:${tag}-m3-b`, `service:scheduler:${tag}-oracle`]);
}, 120_000);

it("on a fenced database the Oracle scheduler and both M3 replicas request nothing and every schedule stays as it was", async () => {
  const local = drizzle(pool!, { schema });
  const site = await local.transaction(tx => fence.readDatabaseIdentity(tx));
  const active = await local.transaction(tx => fence.lockWriterFence(tx, "share"));
  await local.transaction(tx => fence.fenceWriterSite(tx, { lineageId: active.lineageId, writerEpoch: active.writerEpoch, db: site, operator: "pr11g-fixture" }));
  expect(await rows(pool!`SELECT state FROM dr_writer_fence WHERE id = 1`)).toEqual([{ state: "fenced" }]);
  // fence 뒤에도 할 일이 있게 모든 정기 잡을 다시 due 로 만든다.
  await pool!`UPDATE jobs SET next_scheduled_at = clock_timestamp() - interval '1 hour' WHERE name = ANY(${pool!.array([...LEGACY, ...VERSIONED])}::text[])`;
  const before = await schedules();
  const runs = await Promise.all([scheduler(`${tag}-m3-a`, undefined, PEER_TIMEOUTS), scheduler(`${tag}-m3-b`, undefined, PEER_TIMEOUTS),
    scheduler(`${tag}-oracle`, ORACLE)]);
  for (const run of runs) expect(run.output.error).toBeUndefined();
  expect(runs.map(run => [run.code, run.output.principal, run.output.requested])).toEqual([[0, OWNER, 0], [0, OWNER, 0], [0, ORACLE, 0]]);
  expect(await schedules()).toEqual(before);
}, 120_000);
