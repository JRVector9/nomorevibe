import { afterAll, afterEach, beforeAll, beforeEach, expect, it as actualIt, vi } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productHealth, productHealthDaily, uptimeControl, productEvidenceAudit, cdnPurges, uptimeGates, uptimeObservations, jobs } from "@/lib/db/schema";
import { recordPing } from "@/lib/domain/products/health";
import { autoBanUptimeProduct, nextUptimeAutoBanTargets } from "@/lib/domain/products/uptime-auto-ban";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { recordUptimeObservation, nextUptimeObservationTargets } from "@/lib/domain/products/uptime-observations";
import { uptimeSlot, type UptimeSource } from "@/lib/domain/products/uptime-policy";
import { runJob } from "@/lib/jobs/runner";
import { type JobLease } from "@/lib/jobs/control";
import { pingProducts } from "@/lib/jobs/products/uptime";
import * as observations from "@/lib/domain/products/uptime-observations";
const http = vi.hoisted(() => ({ safeFetch: vi.fn(), readBodyCapped: vi.fn(), fetchPage: vi.fn() }));
vi.mock("@/lib/net/fetch", () => http);
import { notDown } from "@/lib/domain/products/repository";

const active = new Set<Promise<unknown>>();
const track = <T>(promise: Promise<T>) => { active.add(promise); return promise; };
async function drain() {
  const snapshot = [...active];
  await Promise.allSettled(snapshot);
  snapshot.forEach(promise => active.delete(promise));
}
function it(name: string, body: () => Promise<void>) { actualIt(name, () => track(body())); }
const sources: UptimeSource[] = [
  { host: "m3", instanceId: "pr09-m3", region: "primary-region" },
  { host: "mini", instanceId: "pr09-mini", region: "primary-region" },
  { host: "oracle-osaka-smoke", instanceId: "pr09-oracle", region: "ap-osaka-1" },
];

const prefix = `pr09-${randomUUID().slice(0, 8)}`;
const owned: string[] = [];
let originalControl: Record<string, unknown> | undefined;
let originalJob: Record<string, unknown> | undefined;
let originalProgress: Record<string, unknown> | undefined;
let foreign: unknown;
const captured = new Set<string>();
let cleanup: Promise<void> | undefined;
async function snapshotForeign() {
  const [row] = await db.execute(sql`select jsonb_build_object(
    'products',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from products t where slug not like ${`${prefix}%`}),
    'health',(select coalesce(jsonb_agg(to_jsonb(t) order by slug),'[]') from product_health t where slug not like ${`${prefix}%`}),
    'daily',(select coalesce(jsonb_agg(to_jsonb(t) order by slug,day),'[]') from product_health_daily t where slug not like ${`${prefix}%`}),
    'raw',(select coalesce(jsonb_agg(to_jsonb(t) order by observation_id),'[]') from uptime_observations t where slug not like ${`${prefix}%`}),
    'gates',(select coalesce(jsonb_agg(to_jsonb(t) order by product_id),'[]') from uptime_gates t where product_id not in (select id from products where slug like ${`${prefix}%`}))
  ) as state`);
  return row.state;
}
async function restore(table: "uptime_control" | "jobs" | "operations_observations", key: string, value: string | number, original?: Record<string, unknown>) {
  if (!captured.has(table)) return;
  const name = sql.identifier(table), column = sql.identifier(key);
  if (!original) { await db.execute(sql`delete from ${name} where ${column}=${value}`); return; }
  const columns = Object.keys(original).filter(field => field !== key);
  const assignments = sql.join(columns.map(field => sql`${sql.identifier(field)}=x.${sql.identifier(field)}`), sql`, `);
  await db.execute(sql`update ${name} set ${assignments} from jsonb_populate_record(null::${name}, ${JSON.stringify(original)}::jsonb) x where ${name}.${column}=${value}`);
  const [row] = await db.execute(sql`select to_jsonb(t) as row from ${name} t where ${column}=${value}`);
  expect(row?.row).toEqual(original);
}
async function allSteps(steps: (() => Promise<unknown>)[], priorErrors: readonly unknown[] = []) {
  const errors: unknown[] = [...priorErrors];
  for (const step of steps) { try { await step(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, "uptime fixture cleanup failed");
}
async function waitForHolder(ready: Promise<void>, held: Promise<unknown>): Promise<void> {
  await Promise.race([ready, held]);
}
beforeAll(() => track((async () => {
  ensureSchema();
  const [row] = await db.execute(sql`select to_jsonb(c) as row from uptime_control c where id=1`);
  originalControl = row?.row as Record<string, unknown> | undefined; captured.add("uptime_control");
  const [job] = await db.execute(sql`select to_jsonb(j) as row from jobs j where name='uptime-ping'`);
  originalJob = job?.row as Record<string, unknown> | undefined; captured.add("jobs");
  const [progress] = await db.execute(sql`select to_jsonb(o) as row from operations_observations o where key='job:uptime-ping'`);
  originalProgress = progress?.row as Record<string, unknown> | undefined; captured.add("operations_observations");
  foreign = await snapshotForeign(); captured.add("foreign");
  await db.execute(sql`update jobs set locked_at=null,lease_token=null,not_before=null where name='uptime-ping'`);
})()));
beforeEach(() => track(db.update(uptimeControl).set({ observationsEnabled: true, gateEnabled: true, sources, revision: sql`${uptimeControl.revision}+1` }).then(() => {})));
afterEach(async () => { await drain(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(() => cleanup ??= (async () => {
  await drain();
  const ids = owned.length ? (await db.select({ id: products.id }).from(products).where(inArray(products.slug, owned))).map(row => row.id) : [];
  await allSteps([
    async () => { if (owned.length) await db.transaction(async tx => {
      await tx.delete(uptimeGates).where(inArray(uptimeGates.productId, ids));
      await tx.execute(sql`alter table uptime_observations disable trigger uptime_observations_no_change`);
      await tx.delete(uptimeObservations).where(inArray(uptimeObservations.slug, owned));
      await tx.execute(sql`alter table uptime_observations enable always trigger uptime_observations_no_change`);
    }); },
    async () => { if (owned.length) {
      await db.delete(productHealthDaily).where(inArray(productHealthDaily.slug, owned));
      await db.delete(productHealth).where(inArray(productHealth.slug, owned));
      await db.delete(productEvidenceAudit).where(inArray(productEvidenceAudit.slug, owned));
      await db.delete(products).where(inArray(products.slug, owned));
      await db.delete(cdnPurges).where(inArray(cdnPurges.slug, owned));
    } },
    () => restore("uptime_control", "id", 1, originalControl),
    () => restore("jobs", "name", "uptime-ping", originalJob),
    () => restore("operations_observations", "key", "job:uptime-ping", originalProgress),
    async () => { if (captured.has("foreign")) expect(await snapshotForeign()).toEqual(foreign); },
  ]);
})());
async function target(failures: number | null = 10) {
  const slug = `${prefix}-${owned.length}`;
  expect(await db.select().from(products).where(eq(products.slug, slug))).toEqual([]);
  owned.push(slug);
  const [row] = await db.insert(products).values({ slug, url: `https://${slug}.test`, name: slug, tagline: "소개", description: "설명",
    category: "Other", status: "seeded", verifyToken: "verify", editTokenHash: "x".repeat(64), updatedAt: new Date("2020-01-01Z") })
    .returning({ id: products.id, slug: products.slug, url: products.url });
  if (failures !== null) await db.insert(productHealth).values({ slug, failures, checkedAt: new Date(Date.now() - 1000), status: 404, downSince: new Date(Date.now() - 60 * 3600000) });
  return row;
}
it("gated legacy writes cannot advance authoritative state without raw evidence", async () => {
  const row = await target(2);
  const before = await db.select().from(productHealth).where(eq(productHealth.slug, row.slug));
  await recordPing(row.slug, 403, null, new Date(), row.id, undefined, row.url);
  expect(await db.select().from(productHealth).where(eq(productHealth.slug, row.slug))).toEqual(before);
  expect(await db.select().from(productHealthDaily).where(eq(productHealthDaily.slug, row.slug))).toEqual([]);
});
it("sweep excludes unproven legacy ten-failure evidence under the gate", async () => {
  const row = await target();
  expect((await nextUptimeAutoBanTargets(200)).map(value => value.id)).not.toContain(row.id);
});
it("final ban preserves product and emits no audit/purge without admitted evidence", async () => {
  const row = await target();
  expect(await autoBanUptimeProduct(row)).toBe(false);
  expect((await db.select().from(products).where(eq(products.id, row.id)))[0].status).toBe("seeded");
  expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, row.slug))).toEqual([]);
  expect(await db.select().from(cdnPurges).where(eq(cdnPurges.slug, row.slug))).toEqual([]);
});
it("disabled control preserves the existing valid ten-failure audit and CDN transition", async () => {
  await db.update(uptimeControl).set({ observationsEnabled: false, gateEnabled: false });
  const row = await target();
  expect(await autoBanUptimeProduct(row)).toBe(true);
  expect((await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, row.slug)))[0].action).toBe("admin.product.ban");
  expect(await db.select().from(cdnPurges).where(eq(cdnPurges.slug, row.slug))).toHaveLength(1);
});

async function clock() {
  const [row] = await db.execute<{ ms: string }>(sql`select floor(extract(epoch from clock_timestamp())*1000)-1000 as ms`);
  return new Date(Number(row.ms));
}
async function withLease<T>(load: (lease: JobLease) => Promise<T>): Promise<T> {
  let value!: T, failure: unknown;
  const result = await track(runJob<null>("uptime-ping", async ctx => {
    try { value = await load(ctx.lease!); return { done: true }; }
    catch (error) { failure = error; throw error; }
  }));
  if (failure) {
    await db.update(jobs).set({ notBefore: null }).where(eq(jobs.name, "uptime-ping"));
    throw failure;
  }
  expect(result.status).toBe("completed");
  return value;
}
type Target = Awaited<ReturnType<typeof target>>;
function observation(row: Target, at: Date, source = sources[0], status = 404) {
  return { observationId: randomUUID(), productId: row.id, slug: row.slug, url: row.url,
    slot: uptimeSlot(new Date(at.getTime() - 1)), startedAt: new Date(at.getTime() - 1), observedAt: at, source,
    kind: "http" as const, status, latencyMs: 12 };
}
function record(value: ReturnType<typeof observation>, lease: JobLease) {
  return track(recordUptimeObservation(value, { lease }));
}
async function network(lease: JobLease, at: Date, source = sources[0], rows?: Target[]) {
  const probes = rows ?? [await target(null), await target(null)];
  for (const probe of probes) expect((await record(observation(probe, new Date(at.getTime() - 1000), source, 200), lease)).state).toBe("applied");
  return probes;
}
async function health(row: Target) { return db.select().from(productHealth).where(eq(productHealth.slug, row.slug)); }

it("one ID and one host/URL6h slot change health once across two real waiting backends", async () => {
  const row = await target(null), at = await clock(), value = observation(row, at, sources[0], 200);
  const holder = postgres(TEST_DATABASE_URL, { max: 1 });
  let release!: () => void, locked!: () => void, beginMonitor!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const unlock = new Promise<void>(resolve => { release = resolve; });
  const monitor = new Promise<void>(resolve => { beginMonitor = resolve; });
  let held: Promise<unknown> | undefined, writes: Promise<unknown> | undefined;
  let blocked = 0;
  const bodyErrors: unknown[] = [];
  try {
    await withLease(async lease => {
      held = holder.begin(async tx => {
        const [pid] = await tx`select pg_backend_pid() as pid`;
        await tx`select pg_advisory_xact_lock(hashtext(${`product-lifecycle:${row.slug}`}))`;
        locked(); await monitor;
        for (let n = 0; n < 100; n++) {
          await tx`select pg_stat_clear_snapshot()`;
          const [state] = await tx`with recursive waiting(pid) as (
            select ${pid.pid}::int union select a.pid from pg_stat_activity a
            join waiting w on w.pid=any(pg_blocking_pids(a.pid))
          ) select (count(distinct pid)-1)::int as count from waiting`;
          blocked = state.count;
          if (blocked === 2) break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await unlock;
      });
      await waitForHolder(ready, held);
      const pair = Promise.all([record(value, lease), record(structuredClone(value), lease)]);
      writes = pair; void pair.catch(() => {}); beginMonitor();
      // The holder performs the backend count on its own connection while both writes wait.
      for (let n = 0; n < 100 && blocked < 2; n++) await new Promise(resolve => setTimeout(resolve, 5));
      release(); await held;
      expect(blocked).toBe(2);
      expect((await pair).map(result => result.state).sort()).toEqual(["applied", "duplicate"]);
      expect((await record({ ...value, observationId: randomUUID() }, lease)).state).toBe("duplicate");
      await expect(record({ ...value, status: 404 }, lease)).rejects.toThrow("uptime_observation_identity_mismatch");
    });
    expect((await health(row))[0]).toMatchObject({ failures: 0, checkedAt: at });
    expect((await db.select().from(productHealthDaily).where(eq(productHealthDaily.slug, row.slug)))[0].checks).toBe(1);
  } catch (error) { bodyErrors.push(error); } finally {
    release?.(); beginMonitor?.();
    await allSteps([async () => { await Promise.allSettled([held, writes].filter(value => !!value)); }, () => holder.end({ timeout: 3 })], bodyErrors);
  }
});

it("holder SQL failure reaches barrier cleanup without a ready signal", async () => {
  const holder = postgres(TEST_DATABASE_URL, { max: 1 });
  let readySignal!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { readySignal = resolve; });
  const unlock = new Promise<void>(resolve => { release = resolve; });
  let cleanupReached = false, fixtureError: unknown;
  const held = holder.begin(async tx => {
    await tx`select 1 / 0`;
    readySignal(); await unlock;
  });
  const exercise = (async () => {
    try { await waitForHolder(ready, held); }
    finally { cleanupReached = true; release(); await Promise.allSettled([held]); }
  })();
  const settled = exercise.catch(error => { fixtureError = error; });
  const bodyErrors: unknown[] = [];
  try {
    const originalError = await held.then(() => undefined, error => error);
    expect(originalError).toMatchObject({ code: "22012" });
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(cleanupReached).toBe(true);
    await settled;
    expect(fixtureError).toBe(originalError);
  } catch (error) { bodyErrors.push(error); } finally {
    readySignal(); release();
    await allSteps([async () => { await Promise.allSettled([held, settled]); }, () => holder.end({ timeout: 3 })], bodyErrors);
  }
});

it("same UUID rejects timestamp-only changes without changing the original raw or health", async () => {
  const row = await target(null), at = await clock(), value = observation(row, at, sources[0], 200);
  await withLease(async lease => {
    expect((await record(value, lease)).state).toBe("applied");
    const [before] = await db.execute(sql`select to_jsonb(o) as row from uptime_observations o where observation_id=${value.observationId}`);
    const earlierStart = new Date(value.startedAt.getTime() - 1);
    const variants = [
      { ...value, observedAt: new Date(value.observedAt.getTime() + 1) },
      { ...value, startedAt: earlierStart, slot: uptimeSlot(earlierStart) },
      { ...value, startedAt: new Date(value.startedAt.getTime() - 6 * 3600000),
        observedAt: new Date(value.observedAt.getTime() - 6 * 3600000),
        slot: new Date(value.slot.getTime() - 6 * 3600000) },
    ];
    for (const changed of variants) {
      await expect(record(changed, lease)).rejects.toThrow("uptime_observation_identity_mismatch");
    }
    expect((await record(structuredClone(value), lease)).state).toBe("duplicate");
    const [after] = await db.execute(sql`select to_jsonb(o) as row from uptime_observations o where observation_id=${value.observationId}`);
    expect(after.row).toEqual(before.row);
  });
  expect((await health(row))[0]).toMatchObject({ failures: 0, checkedAt: at });
  expect((await db.select().from(productHealthDaily).where(eq(productHealthDaily.slug, row.slug)))[0].checks).toBe(1);
});

it("Oracle raw-only mode records facts without health or daily writes", async () => {
  await db.update(uptimeControl).set({ gateEnabled: false });
  const row = await target(null), at = await clock();
  expect(await withLease(lease => record(observation(row, at, sources[2], 403), lease))).toMatchObject({ state: "raw_only" });
  expect(await health(row)).toEqual([]);
  expect(await db.select().from(productHealthDaily).where(eq(productHealthDaily.slug, row.slug))).toEqual([]);
});

it("Oracle-only403 and evidence gaps hold the authoritative counter, timestamp and3/10 action", async () => {
  const row = await target(null), at = await clock();
  await withLease(async lease => {
    await network(lease, at, sources[2]);
    expect(await record(observation(row, at, sources[2], 403), lease)).toMatchObject({ state: "observation_hold", reason: "independent_evidence_missing" });
  });
  expect(await health(row)).toEqual([]);
  expect((await db.select().from(products).where(and(eq(products.id, row.id), notDown)))).toHaveLength(1);
  expect(await autoBanUptimeProduct(row)).toBe(false);
  expect((await db.select().from(uptimeGates).where(eq(uptimeGates.productId, row.id)))[0].recheckRequestedAt).not.toBeNull();
});

it("broad network failures hold even a primary observer with two earlier successes", async () => {
  const row = await target(null), at = await clock();
  await withLease(async lease => {
    await network(lease, at);
    for (let i = 0; i < 3; i++) await record(observation(await target(null), new Date(at.getTime() - 100), sources[0], 500), lease);
    expect(await record(observation(row, at, sources[0], 500), lease)).toMatchObject({ state: "observation_hold", reason: "broad_network_failure" });
  });
  expect(await health(row)).toEqual([]);
});

it("stale URL/generation, future results and out-of-order results cannot alter health", async () => {
  const row = await target(null), at = await clock();
  await withLease(async lease => {
    expect((await record(observation(row, at, sources[0], 200), lease)).state).toBe("applied");
    const before = await health(row);
    expect((await record(observation(row, new Date(at.getTime() - 7 * 3600000)), lease)).state).toBe("stale");
    expect((await record(observation(row, new Date(at.getTime() + 24 * 3600000)), lease)).state).toBe("stale");
    await db.update(products).set({ url: `${row.url}/changed` }).where(eq(products.id, row.id));
    expect((await record(observation(row, new Date(at.getTime() + 7 * 3600000)), lease)).state).toBe("stale");
    expect(await health(row)).toEqual(before);
    expect((await record({ ...observation(row, at), productId: 2147483647 }, lease)).state).toBe("stale");
  });
});

it("a different slot less than6h later holds; stale human status is never overwritten", async () => {
  const row = await target(null), at = await clock();
  const first = new Date(at.getTime() - 5 * 3600000);
  await withLease(async lease => {
    expect((await record(observation(row, first, sources[0], 200), lease)).state).toBe("applied");
    const before = await health(row);
    expect((await record(observation(row, at, sources[1], 404), lease)).reason).toBe("minimum_interval");
    await db.update(products).set({ status: "banned" }).where(eq(products.id, row.id));
    expect((await record(observation(row, at, sources[2], 200), lease)).state).toBe("stale");
    expect(await health(row)).toEqual(before);
  });
});

it("ten valid6h failures preserve threshold10, audits and one CDN invalidation", async () => {
  const row = await target(null), at = await clock();
  await withLease(async lease => {
    let probes: Target[] | undefined;
    for (let index = 0; index < 10; index++) {
      const time = new Date(at.getTime() - (9 - index) * 6 * 3600000);
      probes = await network(lease, time, sources[0], probes);
      expect((await record(observation(row, time), lease)).state).toBe("applied");
      expect((await health(row))[0].failures).toBe(index + 1);
    }
    expect((await db.select().from(products).where(and(eq(products.id, row.id), notDown)))).toHaveLength(0);
    expect(await autoBanUptimeProduct(row, { lease })).toBe(true);
    expect(await autoBanUptimeProduct(row, { lease })).toBe(false);
  });
  expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, row.slug))).toHaveLength(1);
  expect(await db.select().from(cdnPurges).where(eq(cdnPurges.slug, row.slug))).toHaveLength(1);
});

it("a hold does not advance checkedAt or permit immediate same-host HTTP retry", async () => {
  const row = await target(null), at = await clock();
  await withLease(lease => record(observation(row, at), lease));
  expect(await health(row)).toEqual([]);
  expect((await nextUptimeObservationTargets(200, sources[0])).map(value => value.id)).not.toContain(row.id);
});

it("wrong/lost job authority and abort roll back the raw, gate and counter", async () => {
  const row = await target(null), at = await clock();
  await expect(recordUptimeObservation(observation(row, at), { lease: { name: "second-review", token: randomUUID(), requestedVersion: 1 } })).rejects.toThrow("uptime_job_required");
  await withLease(async lease => {
    const controller = new AbortController(); controller.abort();
    await expect(recordUptimeObservation(observation(row, at, sources[0], 200), { lease, signal: controller.signal })).rejects.toThrow("uptime cancelled");
    await expect(record(observation(row, at, sources[0], 200), { ...lease, token: randomUUID() })).rejects.toThrow("job_lease_lost");
  });
  expect(await health(row)).toEqual([]);
  expect(await db.select().from(uptimeObservations).where(eq(uptimeObservations.productId, row.id))).toEqual([]);
  expect(await db.select().from(uptimeGates).where(eq(uptimeGates.productId, row.id))).toEqual([]);
});

it("independent regional403 evidence admits one Oracle failure and a later success recovers", async () => {
  const row = await target(null), now = await clock(), at = new Date(now.getTime() - 6 * 3600000);
  await withLease(async lease => {
    await network(lease, at, sources[0]);
    await network(lease, at, sources[2]);
    expect((await record(observation(row, new Date(at.getTime() - 10), sources[0], 403), lease)).state).toBe("observation_hold");
    expect((await record(observation(row, at, sources[2], 403), lease)).state).toBe("applied");
    expect((await health(row))[0].failures).toBe(1);
    expect((await record(observation(row, now, sources[1], 200), lease)).state).toBe("applied");
    expect((await health(row))[0]).toMatchObject({ failures: 0, downSince: null, checkedAt: now });
  });
});

it("three admitted failures hide; a later machine hold preserves health and protects the list", async () => {
  const row = await target(null), at = await clock();
  await withLease(async lease => {
    let probes: Target[] | undefined;
    for (let index = 0; index < 3; index++) {
      const time = new Date(at.getTime() - (3 - index) * 6 * 3600000 + index * 1000);
      probes = await network(lease, time, sources[0], probes);
      expect((await record(observation(row, time), lease)).state).toBe("applied");
    }
    expect((await health(row))[0].failures).toBe(3);
    expect(await db.select().from(products).where(and(eq(products.id, row.id), notDown))).toHaveLength(0);
    const before = await health(row);
    expect((await record(observation(row, at), lease)).state).toBe("observation_hold");
    expect(await health(row)).toEqual(before);
    expect(await db.select().from(products).where(and(eq(products.id, row.id), notDown))).toHaveLength(1);
  });
});

it("raw facts are immutable even for zero-row UPDATE/DELETE and TRUNCATE", async () => {
  await expect(db.execute(sql`update uptime_observations set reason='changed' where false`)).rejects.toMatchObject({ cause: { code: "55000" } });
  await expect(db.execute(sql`delete from uptime_observations where false`)).rejects.toMatchObject({ cause: { code: "55000" } });
  await expect(db.execute(sql`truncate uptime_observations`)).rejects.toMatchObject({ cause: { code: "55000" } });
});

it("a recheck outbox failure rolls back raw facts, hold metadata and health together", async () => {
  const row = await target(null), at = await clock();
  await db.transaction(async tx => {
  await tx.execute(sql`create function pr09_uptime_request_fault() returns trigger language plpgsql as $$ begin
    if new.name='uptime-ping' and new.lease_token=old.lease_token and new.requested_version>old.requested_version then raise exception 'pr09_request_fault'; end if;
    return new; end $$`);
  await tx.execute(sql`create trigger pr09_uptime_request_fault before update on jobs for each row execute function pr09_uptime_request_fault()`);
  });
  const errors: unknown[] = [], bodyErrors: unknown[] = [];
  try {
    await withLease(async lease => {
      try { await record(observation(row, at), lease); } catch (error) { errors.push(error); }
    });
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as { cause?: unknown }).cause)).toContain("pr09_request_fault");
    expect(await health(row)).toEqual([]);
    expect(await db.select().from(uptimeObservations).where(eq(uptimeObservations.productId, row.id))).toEqual([]);
    expect(await db.select().from(uptimeGates).where(eq(uptimeGates.productId, row.id))).toEqual([]);
  } catch (error) { bodyErrors.push(error); } finally {
    await allSteps([
      () => db.execute(sql`drop trigger pr09_uptime_request_fault on jobs`),
      () => db.execute(sql`drop function pr09_uptime_request_fault()`),
    ], bodyErrors);
  }
});

it("expiry during an actual job-row wait rolls back the positive raw/gate/counter transaction", async () => {
  const row = await target(null), at = await clock();
  const holder = postgres(TEST_DATABASE_URL, { max: 1 });
  let release!: () => void;
  let locked!: () => void;
  const holding = new Promise<void>(resolve => { locked = resolve; });
  const unlock = new Promise<void>(resolve => { release = resolve; });
  let held: Promise<unknown> | undefined, write: Promise<unknown> | undefined, error: unknown;
  let waiter = false, expired = false;
  let expiry!: string, holderPid!: number;
  const bodyErrors: unknown[] = [];
  try {
    const result = await track(runJob<null>("uptime-ping", async ctx => {
      held = holder.begin(async tx => {
        const [anchor] = await tx`update jobs set locked_at=clock_timestamp()-interval '90 seconds'+interval '500 milliseconds' where name='uptime-ping' returning (locked_at+interval '90 seconds')::text as expiry`;
        expiry = anchor.expiry;
        const [pid] = await tx`select pg_backend_pid() as pid`; holderPid = pid.pid;
        locked(); await unlock;
      });
      await waitForHolder(holding, held);
      write = record(observation(row, at, sources[0], 200), ctx.lease!);
      void write.catch(() => {});
      for (let n = 0; n < 100; n++) {
        const [state] = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${holderPid}=any(pg_blocking_pids(pid))) as waiting`);
        if (state.waiting) { waiter = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      for (let n = 0; n < 100; n++) {
        const [state] = await db.execute<{ expired: boolean }>(sql`select clock_timestamp()>=${expiry}::timestamp as expired`);
        if (state.expired) { expired = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      release(); await held;
      try { await write; } catch (failure) { error = failure; }
      return { done: true };
    }));
    expect(waiter).toBe(true);
    expect(expired).toBe(true);
    expect(result.status).toBe("failed");
    expect(String(error)).toContain("job_lease_lost");
    expect(await health(row)).toEqual([]);
    expect(await db.select().from(uptimeObservations).where(eq(uptimeObservations.productId, row.id))).toEqual([]);
    expect(await db.select().from(uptimeGates).where(eq(uptimeGates.productId, row.id))).toEqual([]);
  } catch (error) { bodyErrors.push(error); } finally {
    release?.();
    await allSteps([
      async () => { await Promise.allSettled([held, write].filter(value => !!value)); },
      () => holder.end({ timeout: 3 }),
      () => db.update(jobs).set({ notBefore: null }).where(eq(jobs.name, "uptime-ping")),
    ], bodyErrors);
  }
});

it("the actual Oracle raw-only handler records403 without legacy sweep, health, sample or ban", async () => {
  await db.update(uptimeControl).set({ gateEnabled: false });
  const row = await target(10);
  const before = await health(row);
  vi.stubEnv("SERVICE_INSTANCE_ID", sources[2].instanceId);
  vi.spyOn(observations, "nextUptimeObservationTargets").mockResolvedValue([row]);
  http.safeFetch.mockResolvedValue({ finalUrl: row.url, response: { status: 403, body: { cancel: vi.fn().mockResolvedValue(undefined) } } });
  const result = await track(runJob<null>("uptime-ping", pingProducts));
  expect(result.status).toBe("completed");
  expect(http.safeFetch).toHaveBeenCalledWith(row.url, "background");
  expect(await health(row)).toEqual(before);
  const [raw] = await db.select().from(uptimeObservations).where(eq(uptimeObservations.productId, row.id));
  expect(raw).toMatchObject({ host: "oracle-osaka-smoke", status: 403 });
  expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, row.slug))).toEqual([]);
  expect(await db.select().from(cdnPurges).where(eq(cdnPurges.slug, row.slug))).toEqual([]);
});

it("an unconfigured physical source fails before the actual handler opens HTTP", async () => {
  vi.stubEnv("SERVICE_INSTANCE_ID", "not-configured");
  http.safeFetch.mockClear();
  const result = await track(runJob<null>("uptime-ping", pingProducts));
  expect(result.status).toBe("failed");
  expect(http.safeFetch).not.toHaveBeenCalled();
  await db.update(jobs).set({ notBefore: null }).where(eq(jobs.name, "uptime-ping"));
});

it("evidence that expires during the final job-row wait rolls back ban, both audits and CDN", async () => {
  const row = await target(null), at = await clock();
  const holder = postgres(TEST_DATABASE_URL, { max: 1 });
  let release!: () => void, locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const unlock = new Promise<void>(resolve => { release = resolve; });
  let held: Promise<unknown> | undefined, ban: Promise<unknown> | undefined;
  let blocked = false, expired = false, holderPid!: number;
  const errors: unknown[] = [], bodyErrors: unknown[] = [];
  try {
    await withLease(async lease => {
      let probes: Target[] | undefined;
      for (let index = 0; index < 9; index++) {
        const time = new Date(at.getTime() - (10 - index) * 6 * 3600000 - 10000);
        probes = await network(lease, time, sources[0], probes);
        expect((await record(observation(row, time), lease)).state).toBe("applied");
      }
      const final = new Date((await clock()).getTime() - 6 * 3600000 + 1700);
      await network(lease, final, sources[0], probes);
      expect((await record(observation(row, final), lease)).state).toBe("applied");
      expect((await health(row))[0].failures).toBe(10);
      held = holder.begin(async tx => {
        const [pid] = await tx`select pg_backend_pid() as pid`; holderPid = pid.pid;
        await tx`select name from jobs where name='uptime-ping' for update`; locked(); await unlock;
      });
      await waitForHolder(ready, held);
      ban = autoBanUptimeProduct(row, { lease }).catch(error => { errors.push(error); });
      track(ban);
      for (let n = 0; n < 100; n++) {
        const [state] = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where ${holderPid}=any(pg_blocking_pids(pid))) as waiting`);
        if (state.waiting) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      for (let n = 0; n < 100; n++) {
        const [state] = await db.execute<{ expired: boolean }>(sql`select clock_timestamp()>=${new Date(final.getTime() + 6 * 3600000).toISOString()}::timestamptz as expired`);
        if (state.expired) { expired = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      release(); await held; await ban;
    });
    expect(blocked).toBe(true); expect(expired).toBe(true);
    expect(errors.map(String)).toEqual(["Error: uptime_observation_hold"]);
    expect((await db.select().from(products).where(eq(products.id, row.id)))[0].status).toBe("seeded");
    expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, row.slug))).toEqual([]);
    expect(await db.select().from(cdnPurges).where(eq(cdnPurges.slug, row.slug))).toEqual([]);
    expect((await db.execute(sql`select id from operations_audit where target=${row.slug}`))).toEqual([]);
  } catch (error) { bodyErrors.push(error); } finally {
    release?.();
    await allSteps([async () => { await Promise.allSettled([held, ban].filter(value => !!value)); }, () => holder.end({ timeout: 3 })], bodyErrors);
  }
});
