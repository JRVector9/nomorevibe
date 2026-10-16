import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, jobs, operationsObservations, productEvidenceAudit, productHealth, productHealthDaily, products,
  uptimeControl, uptimeGates, uptimeObservations } from "@/lib/db/schema";
import { notDown } from "@/lib/domain/products/repository";
import { nextUptimeAutoBanTargets } from "@/lib/domain/products/uptime-auto-ban";
import { recordUptimeObservation } from "@/lib/domain/products/uptime-observations";
import { uptimeSlot, UptimeSourcesSchema, type UptimeDisposition, type UptimeSource } from "@/lib/domain/products/uptime-policy";
import type { JobLease } from "@/lib/jobs/control";
import { runJob } from "@/lib/jobs/runner";
import { planUptimeTransition } from "@/lib/operations/uptime-gate";
import { applyUptimeTransition, readUptimeGateSnapshot, rollbackUptimeTransition } from "@/lib/operations/uptime-gate-repository";
import { uptimeGateMain } from "../../scripts/ops/uptime-gate";
import { auditFloor, auditRowsAfter, ensureSchema, TEST_DATABASE_URL } from "./setup";

const tag = randomUUID().slice(0, 8), prefix = `pr09b-${tag}`, operator = "pr09b-test";
const sources: UptimeSource[] = [
  { host: "m3", instanceId: `pr09b-m3-${tag}`, region: "primary-region" },
  { host: "mini", instanceId: `pr09b-mini-${tag}`, region: "primary-region" },
  { host: "oracle-osaka-smoke", instanceId: `pr09b-oracle-${tag}`, region: "ap-osaka-1" },
];
const [m3, mini, oracle] = sources;
const runnerKeys = [`candidate:maintenance:${m3.instanceId}`, `candidate:maintenance:${mini.instanceId}`];
const runnerPattern = or(like(operationsObservations.key, "candidate:maintenance:%"), like(operationsObservations.key, "candidate:product-health:%"));
const owned: string[] = [];
const captured = new Map<string, Record<string, unknown> | undefined>();
let foreignRunners: Record<string, unknown>[] | undefined;
let foreign: unknown;

async function rowJson(statement: ReturnType<typeof sql>) {
  const [row] = await db.execute<{ row: Record<string, unknown> }>(statement);
  return row?.row;
}
async function snapshotForeign() {
  return rowJson(sql`select jsonb_build_object(
    'products',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from products t where slug not like ${`${prefix}%`}),
    'health',(select coalesce(jsonb_agg(to_jsonb(t) order by slug),'[]') from product_health t where slug not like ${`${prefix}%`}),
    'daily',(select coalesce(jsonb_agg(to_jsonb(t) order by slug,day),'[]') from product_health_daily t where slug not like ${`${prefix}%`}),
    'raw',(select coalesce(jsonb_agg(to_jsonb(t) order by observation_id),'[]') from uptime_observations t where slug not like ${`${prefix}%`}),
    'gates',(select coalesce(jsonb_agg(to_jsonb(t) order by product_id),'[]') from uptime_gates t where product_id not in (select id from products where slug like ${`${prefix}%`}))
  ) as row`);
}
const SINGLETONS = { uptime_control: ["id", 1], jobs: ["name", "uptime-ping"], operations_observations: ["key", "job:uptime-ping"] } as const;
async function restore(table: keyof typeof SINGLETONS) {
  if (!captured.has(table)) return;
  const original = captured.get(table), [key, value] = SINGLETONS[table], name = sql.identifier(table), column = sql.identifier(key);
  if (!original) { await db.execute(sql`delete from ${name} where ${column}=${value}`); return; }
  const assignments = sql.join(Object.keys(original).filter(field => field !== key)
    .map(field => sql`${sql.identifier(field)}=x.${sql.identifier(field)}`), sql`, `);
  await db.execute(sql`update ${name} set ${assignments} from jsonb_populate_record(null::${name}, ${JSON.stringify(original)}::jsonb) x where ${name}.${column}=${value}`);
  expect(await rowJson(sql`select to_jsonb(t) as row from ${name} t where ${column}=${value}`)).toEqual(original);
}
async function allSteps(steps: (() => Promise<unknown>)[]) {
  const errors: unknown[] = [];
  for (const step of steps) { try { await step(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, "uptime gate fixture cleanup failed");
}

beforeAll(async () => {
  ensureSchema();
  for (const table of Object.keys(SINGLETONS) as (keyof typeof SINGLETONS)[]) {
    const [key, value] = SINGLETONS[table];
    captured.set(table, await rowJson(sql`select to_jsonb(t) as row from ${sql.identifier(table)} t where ${sql.identifier(key)}=${value}`));
  }
  foreign = await snapshotForeign();
  // 다른 파일이 남긴 역할 후보는 이 파일 동안만 빼 두고 원래 행 그대로 되돌린다.
  foreignRunners = (await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(o) as row from operations_observations o
    where key like 'candidate:maintenance:%' or key like 'candidate:product-health:%' order by key`)).map(row => row.row);
  await db.delete(operationsObservations).where(runnerPattern);
  await db.execute(sql`update jobs set locked_at=null,lease_token=null,not_before=null where name='uptime-ping'`);
});
beforeEach(async () => {
  await db.update(uptimeControl).set({ observationsEnabled: false, gateEnabled: false, sources: [], revision: sql`${uptimeControl.revision}+1` });
  for (const key of runnerKeys) await db.insert(operationsObservations).values({ key, value: { role: "maintenance", phase: "standby" } })
    .onConflictDoUpdate({ target: operationsObservations.key, set: { observedAt: sql`localtimestamp` } });
});
afterAll(async () => {
  const ids = owned.length ? (await db.select({ id: products.id }).from(products).where(inArray(products.slug, owned))).map(row => row.id) : [];
  await allSteps([
    async () => { await db.transaction(async tx => {
      if (ids.length) await tx.delete(uptimeGates).where(inArray(uptimeGates.productId, ids));
      await tx.execute(sql`alter table uptime_observations disable trigger uptime_observations_no_change`);
      await tx.delete(uptimeObservations).where(like(uptimeObservations.slug, `${prefix}%`));
      await tx.execute(sql`alter table uptime_observations enable always trigger uptime_observations_no_change`);
    }); },
    async () => { if (owned.length) {
      await db.delete(productHealthDaily).where(inArray(productHealthDaily.slug, owned));
      await db.delete(productHealth).where(inArray(productHealth.slug, owned));
      await db.delete(productEvidenceAudit).where(inArray(productEvidenceAudit.slug, owned));
      await db.delete(cdnPurges).where(inArray(cdnPurges.slug, owned));
      await db.delete(products).where(inArray(products.slug, owned));
    } },
    async () => {
      await db.delete(operationsObservations).where(inArray(operationsObservations.key, runnerKeys));
      if (!foreignRunners) return;
      for (const row of foreignRunners) await db.execute(sql`insert into operations_observations
        select * from jsonb_populate_record(null::operations_observations, ${JSON.stringify(row)}::jsonb)`);
      expect((await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(o) as row from operations_observations o
        where key like 'candidate:maintenance:%' or key like 'candidate:product-health:%' order by key`)).map(row => row.row)).toEqual(foreignRunners);
    },
    () => restore("uptime_control"), () => restore("jobs"), () => restore("operations_observations"),
    async () => { if (foreign !== undefined) expect(await snapshotForeign()).toEqual(foreign); },
  ]);
});

async function control() {
  const [row] = await db.select().from(uptimeControl).where(eq(uptimeControl.id, 1));
  return { observationsEnabled: row.observationsEnabled, gateEnabled: row.gateEnabled, revision: row.revision, sources: UptimeSourcesSchema.parse(row.sources) };
}
async function clock() {
  const [row] = await db.execute<{ ms: string }>(sql`select floor(extract(epoch from clock_timestamp())*1000)-1000 as ms`);
  return new Date(Number(row.ms));
}
async function target(failures: number | null) {
  const slug = `${prefix}-${owned.length}`;
  owned.push(slug);
  const [row] = await db.insert(products).values({ slug, url: `https://${slug}.test`, name: slug, tagline: "소개", description: "설명",
    category: "Other", status: "seeded", verifyToken: "verify", editTokenHash: "x".repeat(64), updatedAt: new Date("2020-01-01Z") })
    .returning({ id: products.id, slug: products.slug, url: products.url });
  if (failures !== null) await db.insert(productHealth).values({ slug, failures, checkedAt: new Date(Date.now() - 1000), status: 404,
    downSince: new Date(Date.now() - 60 * 3600000) });
  return row;
}
type Target = Awaited<ReturnType<typeof target>>;
const listed = async (row: Target) => (await db.select().from(products).where(and(eq(products.id, row.id), notDown))).length === 1;
const audits = async (floor: number) => (await auditRowsAfter(floor)).filter(row => row.action.startsWith("uptime-control-"));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

type Raw = { source: UptimeSource; minutesAgo: number; status: number; url: string; disposition: UptimeDisposition; reason?: string };
async function insertRaw(revision: number, owner: Target, now: number, rows: Raw[]) {
  await db.insert(uptimeObservations).values(rows.map(row => {
    const observedAt = new Date(now - row.minutesAgo * 60_000), startedAt = new Date(observedAt.getTime() - 1);
    return { observationId: randomUUID(), productId: owner.id, slug: owner.slug, url: row.url, urlHash: hash(row.url), slot: uptimeSlot(startedAt),
      startedAt, observedAt, host: row.source.host, instanceId: row.source.instanceId, region: row.source.region, kind: "http" as const,
      status: row.status, latencyMs: 10, payloadHash: hash(randomUUID()), disposition: row.disposition, reason: row.reason ?? null, revision };
  }));
}
/** 25h raw canary: M3 10분 간격 성공, Oracle 1시간 간격 raw_only, 최근 5h에 M3 실패 120건. */
async function seedCanary(revision: number, distinctFailingOrigins = false) {
  const owner = await target(null), now = (await clock()).getTime(), rows: Raw[] = [];
  for (let minutes = 25 * 60; minutes >= 10; minutes -= 10) rows.push({ source: m3, minutesAgo: minutes, status: 200, url: `https://${prefix}-up-${minutes}.test/`, disposition: "applied" });
  for (let minutes = 25 * 60; minutes >= 60; minutes -= 60) rows.push({ source: oracle, minutesAgo: minutes, status: 200,
    url: `https://${prefix}-osaka-${minutes}.test/`, disposition: "raw_only", reason: "oracle_comparison" });
  for (let index = 0; index < 120; index++) rows.push({ source: m3, minutesAgo: 2 + index * 2.5, status: 404, disposition: "applied",
    url: distinctFailingOrigins ? `https://${prefix}-down-${index}.test/` : `https://${prefix}-down.test/${index}` });
  await insertRaw(revision, owner, now, rows);
}
async function startRawCanary() {
  const start = await control();
  expect(await applyUptimeTransition(db, { target: "raw-only", expectRevision: start.revision, sources, operator, apply: true }))
    .toMatchObject({ kind: "applied" });
  return start.revision + 1;
}

it("raw-only apply is dry-run by default, CAS-switches once with an audit, and refuses a stale revision or uncovered runner", async () => {
  const before = await control(), floor = await auditFloor();
  expect(await applyUptimeTransition(db, { target: "raw-only", expectRevision: before.revision, sources: [m3, oracle], operator, apply: true }))
    .toMatchObject({ kind: "blocked", plan: { blocked: [`uptime_runner_unconfigured:${mini.instanceId}`] } });
  expect(await applyUptimeTransition(db, { target: "raw-only", expectRevision: before.revision, sources, operator, apply: false })).toMatchObject({
    kind: "dry_run", before, after: { observationsEnabled: true, gateEnabled: false, revision: before.revision + 1, sources } });
  expect(await control()).toEqual(before);
  expect(await audits(floor)).toEqual([]);
  const applied = await applyUptimeTransition(db, { target: "raw-only", expectRevision: before.revision, sources, operator, apply: true });
  expect(applied).toMatchObject({ kind: "applied", after: { observationsEnabled: true, gateEnabled: false, revision: before.revision + 1, sources } });
  expect(await control()).toEqual({ observationsEnabled: true, gateEnabled: false, revision: before.revision + 1, sources });
  const rows = await audits(floor);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor: operator, action: "uptime-control-transition", target: "uptime_control",
    detail: { target: "raw-only", before: { revision: before.revision, observationsEnabled: false }, after: { revision: before.revision + 1 } } });
  await expect(applyUptimeTransition(db, { target: "raw-only", expectRevision: before.revision, sources: [m3, mini], operator, apply: true }))
    .rejects.toThrow("uptime_control_revision_conflict");
  expect(await control()).toEqual({ observationsEnabled: true, gateEnabled: false, revision: before.revision + 1, sources });
});

it("gate needs a fresh two-region 24h canary; apply drops uncertified hides and rollback steps down to disabled", async () => {
  const revision = await startRawCanary();
  const hidden = await target(4);
  expect(await listed(hidden)).toBe(false);
  expect(planUptimeTransition("gate", await readUptimeGateSnapshot(db)).blocked).toEqual(expect.arrayContaining(["uptime_canary_missing",
    "uptime_canary_slot_gap", "uptime_region_coverage_insufficient", "uptime_shadow_evidence_insufficient"]));
  expect(await applyUptimeTransition(db, { target: "gate", expectRevision: revision, operator, apply: true })).toMatchObject({ kind: "blocked" });
  expect((await control()).revision).toBe(revision);
  await seedCanary(revision);
  const snapshot = await readUptimeGateSnapshot(db);
  expect(snapshot.hosts.map(host => [host.instanceId, host.configured])).toEqual([[m3.instanceId, true], [oracle.instanceId, true]]);
  expect(snapshot.observations.slots.length).toBeGreaterThanOrEqual(5);
  expect(snapshot.shadow).toEqual({ negatives: 120, held: 0, admitted: 120, holdRatio: 0, reasons: {} });
  expect(snapshot.impact.hiddenNow).toBeGreaterThanOrEqual(1);
  expect(planUptimeTransition("gate", snapshot)).toMatchObject({ allowed: true, blocked: [] });
  const floor = await auditFloor();
  expect(await applyUptimeTransition(db, { target: "gate", expectRevision: revision, operator, apply: false }))
    .toMatchObject({ kind: "dry_run", after: { gateEnabled: true, revision: revision + 1 } });
  expect((await control()).gateEnabled).toBe(false);
  expect(await applyUptimeTransition(db, { target: "gate", expectRevision: revision, operator, apply: true })).toMatchObject({ kind: "applied" });
  expect(await control()).toEqual({ observationsEnabled: true, gateEnabled: true, revision: revision + 1, sources });
  expect(await listed(hidden)).toBe(true);
  expect(await rollbackUptimeTransition(db, { expectRevision: revision + 1, operator, apply: false }))
    .toMatchObject({ kind: "dry_run", after: { observationsEnabled: true, gateEnabled: false } });
  expect((await control()).gateEnabled).toBe(true);
  expect(await rollbackUptimeTransition(db, { expectRevision: revision + 1, operator, apply: true })).toMatchObject({ kind: "applied" });
  expect(await control()).toEqual({ observationsEnabled: true, gateEnabled: false, revision: revision + 2, sources });
  expect(await listed(hidden)).toBe(false);
  expect((await db.select().from(productHealth).where(eq(productHealth.slug, hidden.slug)))[0].failures).toBe(4);
  expect(await rollbackUptimeTransition(db, { expectRevision: revision + 2, operator, apply: true })).toMatchObject({ kind: "applied" });
  expect(await control()).toEqual({ observationsEnabled: false, gateEnabled: false, revision: revision + 3, sources });
  expect(await rollbackUptimeTransition(db, { expectRevision: revision + 3, operator, apply: true }))
    .toMatchObject({ kind: "blocked", blocked: ["uptime_already_disabled"] });
  expect((await audits(floor)).map(row => row.action)).toEqual(["uptime-control-transition", "uptime-control-rollback", "uptime-control-rollback"]);
});

it("production-like spread of failing origins makes regional-v1 hold most failures, so the gate is refused", async () => {
  const revision = await startRawCanary();
  await seedCanary(revision, true);
  const snapshot = await readUptimeGateSnapshot(db);
  expect(snapshot.shadow!.reasons.broad_network_failure).toBeGreaterThan(100);
  expect(snapshot.shadow!.holdRatio).toBeGreaterThan(0.5);
  expect(await applyUptimeTransition(db, { target: "gate", expectRevision: revision, operator, apply: true }))
    .toMatchObject({ kind: "blocked", plan: { blocked: ["uptime_shadow_hold_ratio_exceeded"] } });
  expect(await control()).toEqual({ observationsEnabled: true, gateEnabled: false, revision, sources });
});

it("a concurrent control change while apply waits for the row lock aborts without a write or audit", async () => {
  await startRawCanary();
  const changes: [string, (tx: postgres.TransactionSql) => Promise<unknown>][] = [
    ["versioned", async tx => tx`update uptime_control set revision=revision+1 where id=1`],
    ["unversioned", async tx => tx`update uptime_control set sources=${tx.json([oracle, mini, m3])} where id=1`],
  ];
  for (const [name, change] of changes) {
    const before = await control(), floor = await auditFloor(), holder = postgres(TEST_DATABASE_URL, { max: 1 });
    let release!: () => void, locked!: () => void, holderPid = 0, blocked = false;
    const ready = new Promise<void>(resolve => { locked = resolve; }), unlock = new Promise<void>(resolve => { release = resolve; });
    let held: Promise<unknown> | undefined, attempt: Promise<unknown> | undefined;
    try {
      held = holder.begin(async tx => {
        const [pid] = await tx`select pg_backend_pid() as pid`; holderPid = pid.pid;
        await tx`select id from uptime_control where id=1 for update`;
        locked(); await unlock; await change(tx);
      });
      await Promise.race([ready, held]);
      attempt = applyUptimeTransition(db, { target: "raw-only", expectRevision: before.revision, sources: [m3, mini], operator, apply: true });
      void attempt.catch(() => {});
      for (let n = 0; n < 200 && !blocked; n++) {
        const [state] = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${holderPid}=any(pg_blocking_pids(pid))) as waiting`);
        blocked = state.waiting;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      release(); await held;
      expect(blocked, name).toBe(true);
      await expect(attempt, name).rejects.toThrow("uptime_control_revision_conflict");
      const after = await control();
      expect(after, name).toEqual(name === "versioned" ? { ...before, revision: before.revision + 1 } : { ...before, sources: [oracle, mini, m3] });
      expect(await audits(floor), name).toEqual([]);
    } finally {
      release?.();
      await Promise.allSettled([held, attempt].filter(value => !!value));
      await holder.end({ timeout: 3 });
    }
  }
});

async function withLease<T>(load: (lease: JobLease) => Promise<T>): Promise<T> {
  let value!: T, failure: unknown;
  const result = await runJob<null>("uptime-ping", async ctx => {
    try { value = await load(ctx.lease!); return { done: true }; } catch (error) { failure = error; throw error; }
  });
  if (failure) { await db.update(jobs).set({ notBefore: null }).where(eq(jobs.name, "uptime-ping")); throw failure; }
  expect(result.status).toBe("completed");
  return value;
}
function observation(row: Target, at: Date, source: UptimeSource, status: number) {
  return { observationId: randomUUID(), productId: row.id, slug: row.slug, url: row.url, slot: uptimeSlot(new Date(at.getTime() - 1)),
    startedAt: new Date(at.getTime() - 1), observedAt: at, source, kind: "http" as const, status, latencyMs: 12 };
}
async function network(lease: JobLease, at: Date, source: UptimeSource) {
  for (const probe of [await target(null), await target(null)]) {
    expect((await recordUptimeObservation(observation(probe, new Date(at.getTime() - 1000), source, 200), { lease })).state).toBe("applied");
  }
}

it("a primary-host failure right after an independent-region success is a machine hold, not a product failure", async () => {
  await db.update(uptimeControl).set({ observationsEnabled: true, gateEnabled: true, sources, revision: sql`${uptimeControl.revision}+1` });
  const row = await target(null), now = (await clock()).getTime();
  const first = new Date(now - (6 * 60 + 20) * 60_000), osaka = new Date(now - 25 * 60_000), failure = new Date(now - 10 * 60_000);
  await withLease(async lease => {
    await network(lease, first, m3);
    expect((await recordUptimeObservation(observation(row, first, m3, 200), { lease })).state).toBe("applied");
    expect(await recordUptimeObservation(observation(row, osaka, oracle, 200), { lease })).toEqual({ state: "observation_hold", reason: "minimum_interval" });
    await network(lease, failure, m3);
    expect(await recordUptimeObservation(observation(row, failure, m3, 500), { lease })).toEqual({ state: "observation_hold", reason: "regional_conflict" });
  });
  expect((await db.select().from(productHealth).where(eq(productHealth.slug, row.slug)))[0]).toMatchObject({ failures: 0, checkedAt: first, downSince: null });
  expect((await db.select().from(uptimeGates).where(eq(uptimeGates.productId, row.id)))[0]).toMatchObject({ state: "observation_hold", reason: "regional_conflict" });
  expect(await listed(row)).toBe(true);
  expect((await nextUptimeAutoBanTargets(200)).map(value => value.id)).not.toContain(row.id);
});

it("the operator CLI reads only UPTIME_GATE_DATABASE_URL, keeps writes dry by default and exits 3 when refused", async () => {
  const lines: string[] = [], env = { UPTIME_GATE_DATABASE_URL: TEST_DATABASE_URL };
  const run = (args: string[], override: Record<string, string | undefined> = {}) => uptimeGateMain(args, { ...env, ...override }, line => { lines.push(line); });
  const last = () => JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  const directory = mkdtempSync(join(tmpdir(), "pr09b-")), file = join(directory, "sources.json");
  writeFileSync(file, JSON.stringify(sources));
  try {
    const start = await control();
    expect(await run(["status"])).toBe(0);
    expect(last()).toMatchObject({ command: "status", blocked: false, result: { control: { revision: start.revision, observationsEnabled: false } } });
    expect(await run(["plan", "gate"])).toBe(3);
    expect((last().result as { plan: { blocked: string[] } }).plan.blocked).toContain("uptime_gate_requires_raw_only");
    expect(await run(["apply", "raw-only", `--sources=${file}`, `--expect-revision=${start.revision}`, `--operator=${operator}`])).toBe(0);
    expect(last()).toMatchObject({ command: "apply", dryRun: true, blocked: false, result: { kind: "dry_run" } });
    expect(await control()).toEqual(start);
    expect(await run(["rollback", `--expect-revision=${start.revision}`, `--operator=${operator}`, "--apply"])).toBe(3);
    await expect(run(["apply", "raw-only", `--sources=${file}`, `--expect-revision=${start.revision + 5}`, `--operator=${operator}`]))
      .rejects.toThrow("uptime_control_revision_conflict");
    await expect(run(["status"], { PGHOST: "elsewhere" })).rejects.toThrow("database_override_rejected");
    await expect(run(["status"], { UPTIME_GATE_DATABASE_URL: undefined, DATABASE_URL: TEST_DATABASE_URL })).rejects.toThrow("explicit_UPTIME_GATE_DATABASE_URL_required");
    expect(await control()).toEqual(start);
    expect(lines.join("")).not.toContain("postgres://");
    expect(lines.join("")).not.toContain(TEST_DATABASE_URL);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
