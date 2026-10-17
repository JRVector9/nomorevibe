import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { batchPolicyHash } from "@/lib/jobs/batches";
import { scheduledJobs } from "@/lib/jobs/control";
import * as fence from "@/lib/operations/dr/epoch";
import { ORACLE_DB_PRINCIPALS, oracleDbGrantStatements } from "@/lib/runtime/oracle-db-profile";
import { oracleSchedulerResultKey } from "@/lib/runtime/oracle-scheduler-evidence";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * PR11g 실제 PostgreSQL. 이 파일이 만들고 지우는 임시 DB 하나와 scheduler·attest 최소권한 role 만 쓴다.
 * 0100 이전 journal 로 먼저 migrate 해 scheduler 후보 행이 CHECK 로 거절됨(RED)을 보고, 0100 을 적용해 기존 술어가
 * 그대로 왼쪽에 남는지(pg_get_constraintdef) 확인한다. 그 뒤 실제 canary → preflight ready, 실제 scripts/scheduler.ts
 * 재시작(새 boot) → unknown, 새 canary → ready 를 scheduler 계정과 attest 계정만으로 확인한다.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATION = "0100_job_batch_candidates_scheduler_role";
const tag = randomBytes(6).toString("hex"), name = `nomorevibe_test_pr11g_canary_${tag}`, password = randomUUID();
const release = createHash("sha1").update(tag).digest("hex"), instanceId = `${tag}-oracle-scheduler`;
const SCHEDULER = ORACLE_DB_PRINCIPALS.scheduler, ATTEST = ORACLE_DB_PRINCIPALS.attest;
const policy = { version: 1 as const, release, instances: [{ instanceId, host: "oracle-osaka-smoke" as const }] };
const SCHEDULED = scheduledJobs({ mode: "versioned", writerContractVersion: 1 }).map(job => job.name);
const rolesCreated: string[] = [];
let pool: postgres.Sql | undefined, created = false, folder = "";

const urlOf = (user?: string) => {
  const value = new URL(TEST_DATABASE_URL); value.pathname = `/${name}`;
  if (user) { value.username = user; value.password = password; }
  return value.toString();
};
type Output = Record<string, unknown> & { error?: string; message?: string };
function run(argv: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...argv], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? "test", LOG_LEVEL: "error", DATABASE_URL: urlOf(SCHEDULER),
        WORKER_ROLE: "scheduler", SERVICE_INSTANCE_ID: instanceId, RELEASE_TAG: release, JOB_BATCH_VERSION: "1",
        PHYSICAL_HOST: "oracle-osaka-smoke", ORACLE_ATTEST_DATABASE_URL: urlOf(ATTEST), ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    child.once("error", reject);
    child.once("exit", code => resolve({ code, stdout, stderr }));
  });
}
/** tests/fixtures/oracle-role-db-driver.ts 의 scheduler canary 경로(운영 CLI 와 같은 함수). */
async function driver(mode: string, negatives: string[] = []): Promise<Output> {
  const { stdout, stderr } = await run(["tests/fixtures/oracle-role-db-driver.ts"],
    { ORACLE_DRIVER_INPUT: JSON.stringify({ role: "scheduler", jobs: [], httpBase: "", bootId: randomUUID(), negatives, mode }) });
  try { return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Output; }
  catch { throw new Error(`driver_output_invalid:${stdout.slice(-500)}:${stderr.slice(-2000)}`); }
}
type Workload = { ready: boolean; reason: string; evidenceHash?: string };
const preflight = async () => (await driver("preflight")).preflight as { workload: Workload; checks: Record<string, { status: string; reason: string }> };
const candidate = async () => (await pool!`SELECT boot_id AS "bootId",capability,result_evidence AS "resultEvidence"
  FROM job_batch_candidates WHERE role='scheduler' AND instance_id=${instanceId}`)[0];
const constraint = async () => (await pool!<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
  WHERE conrelid='job_batch_candidates'::regclass AND conname='job_batch_candidates_role_check'`)[0].def;
const insertCandidate = (role: string) => pool!`INSERT INTO job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash)
  VALUES(${role},${`${tag}-check`},'oracle-osaka-smoke','check',${release},${batchPolicyHash(policy)})`;
const sqlState = async (query: Promise<unknown>) => query.then(() => "allowed", (error: { code?: string }) => error.code ?? "unknown");

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  expect(journal.entries.map(entry => entry.tag)).toEqual(expect.arrayContaining(["0082_job_batches", "0098_oracle_activation_gaps", MIGRATION]));
  // 0100 직전 상태: 같은 migration 파일들에서 journal 만 0100 을 뺀 사본.
  folder = mkdtempSync(path.join(tmpdir(), "nmv-pr11g-"));
  cpSync(path.join(root, "drizzle"), folder, { recursive: true });
  writeFileSync(path.join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.filter(entry => entry.tag !== MIGRATION) }));
  const shared = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    // 남아 있던 같은 이름 role 은 이 파일 소유가 아니므로 쓰지도 지우지도 않는다.
    expect(await shared`SELECT rolname FROM pg_roles WHERE rolname IN (${SCHEDULER},${ATTEST})`).toHaveLength(0);
    await shared.unsafe(`CREATE DATABASE ${name}`); created = true;
  } finally { await shared.end({ timeout: 5 }); }
  const client = postgres(urlOf(), { max: 1, onnotice: () => {} });
  try { await client.unsafe("set statement_timeout = 0"); await migrate(drizzle(client), { migrationsFolder: folder }); }
  finally { await client.end({ timeout: 5 }); }
  pool = postgres(urlOf(), { max: 4, prepare: false, onnotice: () => {} });
  for (const service of ["scheduler", "attest"] as const) {
    const [create, ...grants] = oracleDbGrantStatements(service, { connectionLimit: 4 });
    await pool.unsafe(create); rolesCreated.push(ORACLE_DB_PRINCIPALS[service]);
    for (const statement of grants) await pool.unsafe(statement);
    await pool.unsafe(`ALTER ROLE ${ORACLE_DB_PRINCIPALS[service]} PASSWORD '${password}'`);
  }
  await pool`UPDATE job_batch_control SET mode='versioned',draining_from=NULL,writer_contract_version=1,policy=${pool.json(policy)},
    policy_hash=${batchPolicyHash(policy)} WHERE id=1`;
  // versioned 상태에서 scheduler 가 일정을 미는 모든 정기 잡이 due 다.
  await pool`INSERT INTO jobs(name,next_scheduled_at) SELECT n,clock_timestamp()-interval '1 hour' FROM unnest(${pool.array(SCHEDULED)}::text[]) n
    ON CONFLICT (name) DO UPDATE SET next_scheduled_at=EXCLUDED.next_scheduled_at`;
}, 600_000);

afterAll(async () => {
  const errors: unknown[] = [];
  for (const step of [async () => { await pool?.end({ timeout: 5 }); }, async () => {
    const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      for (const role of rolesCreated) await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    } finally { await admin.end({ timeout: 5 }); }
  }, async () => { if (folder) rmSync(folder, { recursive: true, force: true }); }]) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "pr11g_canary_cleanup_failed");
}, 120_000);

it("0100 keeps the existing role predicate whole and only adds the scheduler branch", async () => {
  const before = await constraint();
  expect(await sqlState(insertCandidate("scheduler"))).toBe("23514"); // RED: 0100 이전에는 scheduler 후보 행이 없다
  const client = postgres(urlOf(), { max: 1, onnotice: () => {} });
  try { await client.unsafe("set statement_timeout = 0"); await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") }); }
  finally { await client.end({ timeout: 5 }); }
  const [applied] = await pool!<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: unknown[] };
  expect(applied.count).toBe(journal.entries.length);
  expect(before.startsWith("CHECK (") && before.endsWith(")") && !before.includes("scheduler")).toBe(true);
  expect(await constraint()).toBe(`CHECK ((${before.slice("CHECK (".length, -1)} OR ((role)::text = 'scheduler'::text)))`);
  expect(await sqlState(insertCandidate("scheduler"))).toBe("allowed");
  expect(await sqlState(insertCandidate("not-a-role"))).toBe("23514");
  await pool!`DELETE FROM job_batch_candidates WHERE instance_id=${`${tag}-check`}`;
}, 120_000);

it("the scheduler principal heartbeats only candidate identity columns and cannot forge evidence (0098 trigger)", async () => {
  const hash = batchPolicyHash(policy);
  const row = (columns: string, values: string) => `INSERT INTO public.job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash${columns}) `
    + `VALUES ('scheduler','${tag}-forged','oracle-osaka-smoke','forged','${release}','${hash}'${values}) ON CONFLICT DO NOTHING`;
  const allowed = [row("", ""), "UPDATE public.job_batch_candidates SET boot_id=boot_id,observed_at=observed_at WHERE false",
    "SELECT 1 FROM public.http_origin_control LIMIT 1"];
  const denied = [row(",capability", `,'{"dbPrivileges":"verified"}'`), row(",result_evidence", `,'{"kind":"oracle_scheduler_tick"}'`),
    "UPDATE public.job_batch_candidates SET capability=capability WHERE false", "UPDATE public.job_batch_candidates SET result_evidence=result_evidence WHERE false",
    "DELETE FROM public.job_batch_candidates WHERE false", "UPDATE public.http_origin_control SET mode=mode WHERE false",
    "DELETE FROM public.operations_observations WHERE false"];
  const output = await driver("negatives", [...allowed, ...denied]);
  expect(output.principal).toBe(SCHEDULER);
  expect(output.negatives).toEqual(Object.fromEntries([...allowed.map(statement => [statement, "allowed"]), ...denied.map(statement => [statement, "42501"])]));
  expect(await pool!`SELECT capability,result_evidence FROM job_batch_candidates WHERE instance_id=${`${tag}-forged`}`).toEqual([{ capability: null, result_evidence: null }]);
  await pool!`DELETE FROM job_batch_candidates WHERE instance_id=${`${tag}-forged`}`;
}, 60_000);

it("a real scheduler canary makes the launch preflight ready, and a restarted scheduler boot needs a new canary", async () => {
  expect((await preflight()).workload).toEqual({ ready: false, reason: "candidate_unknown" });
  expect(await driver("attest")).toMatchObject({ message: expect.stringContaining("oracle_canary_result_missing") });
  const first = await driver("canary");
  if (first.error) throw new Error(`driver_failed:${JSON.stringify(first)}`);
  const canary = first.canary as { bootId: string; tick: Record<string, unknown>; after: Record<string, unknown> };
  const [control] = await pool!`SELECT epoch FROM job_batch_control WHERE id=1`;
  expect(canary.tick).toMatchObject({ role: "scheduler", instanceId, release, bootId: canary.bootId, batchEpoch: Number(control.epoch), requested: SCHEDULED.length });
  expect(canary.after).toMatchObject({ ready: true, reason: "ready", bootId: canary.bootId, requested: SCHEDULED.length, readbackRows: SCHEDULED.length,
    capability: { dbPrivileges: "verified" } });
  const stored = await candidate();
  expect(stored.bootId).toBe(canary.bootId);
  expect(stored.capability).toMatchObject({ kind: "oracle_scheduler", dbRole: SCHEDULER, dbPrivileges: "verified" });
  expect(stored.resultEvidence).toMatchObject({ kind: "oracle_scheduler_tick", bootId: canary.bootId, jobs: SCHEDULED.length });
  const [ack] = await pool!`SELECT value->'schedulerResult' AS result FROM operations_observations WHERE key=${oracleSchedulerResultKey(instanceId)}`;
  expect(ack.result).toEqual(canary.tick);
  const ready = await preflight();
  expect(ready.workload).toMatchObject({ ready: true, reason: "ready" });
  for (const check of ["identity", "batch", "database", "timeouts"]) expect(ready.checks[check].status).toBe("verified");
  expect(ready.checks.admission.status).toBe("unknown");

  // 재시작: 실제 scripts/scheduler.ts 가 첫 틱 전에 새 boot 를 기록한다. 증거 열은 그대로이고 launch readiness 는 닫힌다.
  const restarted = await run(["scripts/scheduler.ts", "--once"], {});
  expect(restarted.code, restarted.stderr.slice(-2000)).toBe(0);
  const after = await candidate();
  expect(after.bootId).not.toBe(canary.bootId);
  expect([after.capability, after.resultEvidence]).toEqual([stored.capability, stored.resultEvidence]);
  expect((await preflight()).workload).toEqual({ ready: false, reason: "result_boot_mismatch" });
  // 신선한 증거를 다시 attest 해도 재시작한 boot 를 열지 않는다(신선도만으로는 재시작을 허용하지 않는다).
  expect((await driver("attest")).attest).toMatchObject({ ready: false, reason: "result_boot_mismatch", bootId: after.bootId });
  expect((await preflight()).workload).toEqual({ ready: false, reason: "result_boot_mismatch" });
  const second = await driver("canary");
  const again = second.canary as { bootId: string; after: Record<string, unknown> };
  expect(again.bootId).not.toBe(after.bootId);
  expect(again.after).toMatchObject({ ready: true, reason: "ready", bootId: again.bootId });
  expect((await preflight()).workload).toMatchObject({ ready: true, reason: "ready" });
}, 180_000);

it("on a fenced database the scheduler canary records neither a boot nor an ACK", async () => {
  const local = drizzle(pool!, { schema });
  const before = { candidate: await candidate(), ack: await pool!`SELECT value FROM operations_observations WHERE key=${oracleSchedulerResultKey(instanceId)}` };
  const site = await local.transaction(tx => fence.readDatabaseIdentity(tx));
  const active = await local.transaction(tx => fence.lockWriterFence(tx, "share"));
  await local.transaction(tx => fence.fenceWriterSite(tx, { lineageId: active.lineageId, writerEpoch: active.writerEpoch, db: site, operator: "pr11g-fixture" }));
  expect(await driver("canary")).toMatchObject({ message: expect.stringContaining("oracle_scheduler_boot_unrecorded") });
  expect({ candidate: await candidate(), ack: await pool!`SELECT value FROM operations_observations WHERE key=${oracleSchedulerResultKey(instanceId)}` })
    .toEqual(before);
}, 60_000);
