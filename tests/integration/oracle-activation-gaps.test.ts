import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { batchPolicyHash } from "@/lib/jobs/batches";
import { assertJobBatchAdmission, JobBatchBlockedError } from "@/lib/jobs/batch-repository";
import * as roles from "@/lib/jobs/role-leader";
import { runJob } from "@/lib/jobs/runner";
import * as fence from "@/lib/operations/dr/epoch";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * PR11e 실제 PostgreSQL. 이 파일이 만들고 지우는 임시 DB 하나만 쓴다(operator fence 는 API 로 되돌릴 수 없다).
 * - versioned claim(runJob)·domain writer 관문(assertJobBatchAdmission)이 fenced site 에서 멈추는지.
 * - 0098: candidates INSERT 증거 guard trigger 와 모델 readback index 가 그대로 있고 readback 질의가 그 index 를 쓰는지.
 * least-privilege principal 로 guard 를 실증하는 경로는 tests/integration/oracle-db-roles.test.ts 가 본다.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const tag = randomBytes(6).toString("hex"), name = `nomorevibe_test_pr11e_${tag}`;
const url = (() => { const value = new URL(TEST_DATABASE_URL); value.pathname = `/${name}`; return value.toString(); })();
let created = false, client: postgres.Sql | undefined;
const pool = () => client ??= postgres(url, { max: 4, prepare: false, onnotice: () => {} });

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  expect(journal.entries.map(entry => entry.tag)).toContain("0098_oracle_activation_gaps");
  const shared = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const [applied] = await shared<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(journal.entries.length);
    await shared.unsafe(`CREATE DATABASE ${name}`); created = true;
  } finally { await shared.end({ timeout: 5 }); }
  const migrator = postgres(url, { max: 1, onnotice: () => {} });
  try { await migrator.unsafe("set statement_timeout = 0"); await migrate(drizzle(migrator), { migrationsFolder: path.join(root, "drizzle") }); }
  finally { await migrator.end({ timeout: 5 }); }
  const [applied] = await pool()<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  const g = globalThis as { db?: unknown; pgClient?: unknown }; g.pgClient = pool(); g.db = drizzle(pool(), { schema });
}, 600_000);

afterAll(async () => {
  const g = globalThis as { db?: unknown; pgClient?: unknown }; delete g.db; delete g.pgClient;
  await client?.end({ timeout: 5 });
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { if (created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

it("0098 adds only the candidate evidence INSERT guard and a model readback index that the readback query uses", async () => {
  const g = pool();
  const [trigger] = await g`SELECT pg_get_triggerdef(t.oid) AS def, t.tgenabled AS enabled, p.prosecdef AS definer FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgname = 'job_batch_candidates_evidence_insert_guard' AND NOT t.tgisinternal`;
  expect(trigger).toEqual({ def: "CREATE TRIGGER job_batch_candidates_evidence_insert_guard BEFORE INSERT ON public.job_batch_candidates FOR EACH ROW EXECUTE FUNCTION job_batch_candidates_evidence_insert_guard()",
    enabled: "O", definer: false });
  const [index] = await g`SELECT indexdef FROM pg_indexes WHERE indexname = 'model_capacity_requests_job_readback_idx'`;
  expect(index.indexdef).toBe("CREATE INDEX model_capacity_requests_job_readback_idx ON public.model_capacity_requests USING btree (route_id, owner_instance_id, (((dispatch_binding -> 'job'::text) ->> 'requestedVersion'::text)))");
  // The attest/preflight readback predicate (lib/runtime/oracle-canary.ts modelEvidence, oracle-preflight.ts) with seq scans disabled:
  // the planner must be able to answer it from the new index alone.
  const plan = await g.begin(async tx => {
    await tx`SET LOCAL enable_seqscan = off`;
    const [row] = await tx.unsafe(`EXPLAIN (FORMAT JSON) SELECT request_id::text FROM model_capacity_requests
      WHERE route_id=$1 AND owner_instance_id=$2 AND owner_boot_id::text=$3 AND dispatch_binding->'job'->>'name'=$1
      AND dispatch_binding->'job'->>'requestedVersion'=$4 ORDER BY request_id`, ["product-translate", "oracle-translation", "boot", "7"]);
    return JSON.stringify(row);
  });
  expect(plan).toContain("model_capacity_requests_job_readback_idx");
  // Owner (the migration/admin role) keeps every evidence write; the guard only binds evidence INSERTs to evidence UPDATE rights.
  const policyHash = "a".repeat(64);
  await g`INSERT INTO job_batch_candidates (role, instance_id, host, boot_id, release, policy_hash, capability, result_evidence)
    VALUES ('product-health', ${`pr11e-${tag}`}, 'oracle-osaka-smoke', 'boot', 'r', ${policyHash}, '{}'::jsonb, '{}'::jsonb)`;
  await g`DELETE FROM job_batch_candidates WHERE instance_id = ${`pr11e-${tag}`}`;
});

it("a versioned claim and its domain admission stop at a fenced site while the earlier role lease is still valid", async () => {
  const g = pool(), release = "pr11e", instanceId = "pr11e-oracle", boot = "pr11e-boot";
  const batch = { version: 1 as const, release, instances: [{ instanceId, host: "oracle-osaka-smoke" as const }] };
  await g`UPDATE job_batch_control SET mode = 'legacy', draining_from = NULL, writer_contract_version = 1, policy = ${JSON.stringify(batch)}::text::jsonb,
    policy_hash = ${batchPolicyHash(batch)} WHERE id = 1`;
  // FIXTURE readiness, the same real path as tests/integration/dr-followups.test.ts: one legacy-parent ACK + operator evidence rows.
  const legacy = await roles.tryAcquireRole({ role: "text", instanceId, bootId: boot, release, kind: "primary" });
  expect(legacy).not.toBeNull();
  const seeded = await runJob("reason-translate", async ctx => { await ctx.save({ fixture: "pr11e" }); ctx.log("translate.done", { translated: 1 }); return { done: false }; },
    { roleLease: legacy! });
  expect(seeded.status).toBe("completed"); expect(await roles.releaseRole(legacy!)).toBe(true);
  const [clock] = await g<{ now: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  const [saved] = await g`SELECT requested_version, cursor FROM jobs WHERE name = 'reason-translate'`;
  const capability = { host: "oracle-osaka-smoke", release, instanceId, dbPrivileges: "verified", dbRole: "fixture-only", effectivePrivilegeHash: "a".repeat(64),
    modelBoundEvidenceHash: "b".repeat(64), http: "verified", model: "verified", observedAt: clock.now };
  const readback = { host: "oracle-osaka-smoke", release, instanceId, job: "reason-translate", requestedVersion: Number(saved.requested_version),
    domainReadbackHash: createHash("sha256").update(JSON.stringify(saved.cursor)).digest("hex"), observedAt: clock.now };
  await g`INSERT INTO job_batch_candidates (role, instance_id, host, boot_id, release, policy_hash, capability, result_evidence) VALUES ('translation', ${instanceId},
    'oracle-osaka-smoke', ${boot}, ${release}, ${batchPolicyHash(batch)}, ${JSON.stringify(capability)}::text::jsonb, ${JSON.stringify(readback)}::text::jsonb)`;
  await g`UPDATE job_batch_control SET mode = 'versioned' WHERE id = 1`;
  const lease = await roles.tryAcquireRole({ role: "translation", instanceId, bootId: boot, release, kind: "primary", batchVersion: 1, host: "oracle-osaka-smoke" });
  expect(lease).toMatchObject({ instanceId, batchVersion: 1 });
  let ticks = 0;
  const handler = async (ctx: { log: (event: string, fields?: Record<string, unknown>) => void }) => { ticks += 1; ctx.log("translate.done", { translated: 1 }); return { done: false }; };
  // Positive control on the active site: the same lease claims and ACKs.
  expect((await runJob("reason-translate", handler, { roleLease: lease! })).status).toBe("completed");
  expect(ticks).toBe(1);
  const site = await db.transaction(tx => fence.readDatabaseIdentity(tx)), active = await db.transaction(tx => fence.lockWriterFence(tx, "share"));
  await db.transaction(tx => fence.fenceWriterSite(tx, { lineageId: active.lineageId, writerEpoch: active.writerEpoch, db: site, operator: "pr11e-root-driver" }));
  const before = await g`SELECT to_jsonb(j) AS row FROM jobs j WHERE name = 'reason-translate'`;
  const [owner] = await g`SELECT owner_instance_id, owner_boot_id, lease_until > clock_timestamp() AS valid FROM role_leases WHERE role = 'translation'`;
  // The role row still names this owner and is unexpired: only the writer fence can stop the claim.
  expect(owner).toEqual({ owner_instance_id: instanceId, owner_boot_id: boot, valid: true });
  expect(await runJob("reason-translate", handler, { roleLease: lease! })).toEqual({ status: "skipped", reason: "stopping" });
  expect(ticks).toBe(1);
  expect(await g`SELECT to_jsonb(j) AS row FROM jobs j WHERE name = 'reason-translate'`).toEqual(before);
  // A domain result writer re-checks the same admission inside its result TX.
  await expect(db.transaction(tx => assertJobBatchAdmission(tx, "reason-translate", lease!))).rejects.toBeInstanceOf(JobBatchBlockedError);
  expect(await roles.tryAcquireRole({ role: "translation", instanceId, bootId: boot, release, kind: "primary", batchVersion: 1, host: "oracle-osaka-smoke" })).toBeNull();
}, 120_000);
