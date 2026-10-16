import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { requestJob } from "@/lib/jobs/control";
import { runJob } from "@/lib/jobs/runner";
import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";

const admin = postgres(TEST_DATABASE_URL, { max: 2 });
const prefix = `pr07c-${randomUUID().slice(0, 8)}`;
const names = new Set<string>();
const tasks = new Set<Promise<unknown>>();
let baseline: unknown;
let originalBaseline: unknown;
let baselineCaptured = false;
let originalCaptured = false;
let sentinelOwned = false;
const sentinel = `${prefix}-unrelated`;
const blocked = new HttpOriginPermitError("waiting_aborted");
function track<T>(promise: Promise<T>): Promise<T> { tasks.add(promise); void promise.catch(() => {}); return promise; }
async function settle() { const pending = [...tasks]; await Promise.allSettled(pending); pending.forEach(task => tasks.delete(task)); }
function exercise(test: () => Promise<void>) { return () => track(test()); }
function latch() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function row(name: string) { const [value] = await admin`select to_jsonb(j) as value from jobs j where name=${name}`; return value.value; }
async function restoreJobRow(tx: postgres.TransactionSql, name: string, value: Record<string, unknown>) {
  const columns = Object.keys(value).filter(key => key !== "name");
  await tx.unsafe(`update jobs set (${columns.join(",")})=(select ${columns.join(",")} from jsonb_populate_record(null::jobs,$1::text::jsonb)) where name=$2`, [JSON.stringify(value), name]);
}
async function whole() {
  const tables = await admin`select tablename from pg_tables where schemaname='public' order by tablename`;
  const data: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    const rows = await admin.unsafe(`select to_jsonb(t) as value from public."${tablename.replaceAll('"', '""')}" t order by to_jsonb(t)::text`);
    data[tablename] = rows.map(value => value.value);
  }
  const catalog = await admin`select c.relname,c.relacl::text as acl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname`;
  return { data, catalog };
}
async function seed() {
  const name = `${prefix}-${names.size}`;
  expect(await admin`select name from jobs where name=${name}`).toHaveLength(0);
  names.add(name);
  await admin`insert into jobs(name,requested_version,processed_version,cursor,last_success_at,last_error,runs,next_scheduled_at)
    values(${name},12,7,'{"attempt":3,"page":4}',timestamp '2026-10-01 01:02:03.123456','previous failure',4,timestamp '2026-10-20 01:02:03.654321')`;
  return name;
}
let cleaning: Promise<void> | undefined;
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    await settle();
    if (!baselineCaptured) return;
    for (const name of names) {
      await admin`delete from operations_observations where key=${`job:${name}`}`;
      await admin`delete from jobs where name=${name}`;
    }
    expect(await whole()).toEqual(baseline);
  })();
  try { await cleaning; } finally { cleaning = undefined; }
}
beforeAll(() => track((async () => { ensureSchema(); originalBaseline = await whole(); originalCaptured = true;
  expect(await admin`select name from jobs where name=${sentinel}`).toHaveLength(0);
  sentinelOwned = true;
  await admin`insert into jobs(name,requested_version,processed_version,cursor,runs,last_success_at,last_error,not_before,updated_at)
    values(${sentinel},91,41,'{"attempt":99,"untouched":true}',17,timestamp '2026-10-01 01:02:03.123456','foreign history',
      timestamp '2100-01-01 00:00:00.654321',timestamp '2026-10-01 01:02:03.654321')`;
  baseline = await whole();
  baselineCaptured = true;
  writeFileSync(`/tmp/nomorevibe-pr07c-runner-baseline-${prefix}.json`, JSON.stringify(baseline, null, 2)); })()));
afterEach(cleanup);
afterAll(async () => {
  const errors: unknown[] = [];
  try { await cleanup(); } catch (error) { errors.push(error); }
  try {
    if (sentinelOwned) await admin`delete from jobs where name=${sentinel}`;
    if (originalCaptured) expect(await whole()).toEqual(originalBaseline);
  } catch (error) { errors.push(error); }
  try { await admin.end(); } catch (error) { errors.push(error); }
  const global = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> };
  try { await global.pgClient?.end(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "http permit runner cleanup failed");
});
it("typed permit hold preserves requested work, current cursor and all previous history", exercise(async () => {
  const name = await seed();
  let before: Record<string, unknown> | undefined;
  const result = await runJob(name, async ctx => {
    await ctx.save({ attempt: 3, page: 5 });
    before = await row(name);
    throw blocked;
  }, { requestedOnly: true });
  expect(result).toMatchObject({ status: "deferred", reason: "http_origin_permit" });
  expect(await row(name)).toEqual({ ...before, locked_at: null, lease_token: null });
  expect(await admin`select * from operations_observations where key=${`job:${name}`}`).toHaveLength(0);
}));
it("ordinary bounded done:false still acknowledges the request", exercise(async () => {
  const name = await seed();
  expect(await runJob(name, async () => ({ done: false }), { requestedOnly: true })).toMatchObject({ status: "completed", done: false });
  expect(await row(name)).toMatchObject({ requested_version: 12, processed_version: 12, last_error: null, cursor: { attempt: 3, page: 4 } });
}));

it("producer requests and a human pause survive a deferred tick verbatim", exercise(async () => {
  // A real producer only accepts catalog job names. Keep this managed row in place
  // and restore its original full JSON (including timestamp microseconds).
  const name = "news-refresh";
  const [original] = await admin`select to_jsonb(j) as value from jobs j where name=${name}`;
  const [observation] = await admin`select to_jsonb(o) as value from operations_observations o where key=${`job:${name}`}`;
  const errors: unknown[] = [];
  try {
    await admin`insert into jobs(name,requested_version,processed_version) values(${name},12,7)
      on conflict(name) do update set requested_version=12,processed_version=7,locked_at=null,lease_token=null,not_before=null`;
    let before: Record<string, unknown> | undefined;
    const result = await runJob(name, async ctx => {
      await requestJob(name);
      await ctx.save({ attempt: 9, page: 6 });
      await admin`update jobs set not_before=timestamp '2100-01-01 01:02:03.123456' where name=${name}`;
      before = await row(name);
      throw blocked;
    }, { requestedOnly: true });
    expect(result).toMatchObject({ status: "deferred", reason: "http_origin_permit" });
    expect(await row(name)).toEqual({ ...before, locked_at: null, lease_token: null });
    expect(before).toMatchObject({ requested_version: 13, processed_version: 7 });
  } catch (error) { errors.push(error); }
  finally {
    try {
      await admin.begin(async tx => {
        if (original) {
          await restoreJobRow(tx, name, original.value);
        } else await tx`delete from jobs where name=${name}`;
        if (!observation) await tx`delete from operations_observations where key=${`job:${name}`}`;
        else {
          await tx`update operations_observations set value=${tx.json(observation.value.value)},observed_at=${observation.value.observed_at}::text::timestamp where key=${`job:${name}`}`;
        }
      });
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "producer/pause body and restore failed");
  }
}));
it("restores an existing news-refresh raw row with timestamp microseconds", exercise(async () => {
  const name = "news-refresh";
  const original = await admin`select to_jsonb(j) as value from jobs j where name=${name}`;
  const rollback = new Error("rollback news-refresh restoration fixture");
  let restorationError: unknown;
  try {
    await track(admin.begin(async tx => {
      await tx`insert into jobs(name,requested_version,processed_version,cursor,last_success_at,last_error,not_before,updated_at)
        values(${name},87,42,'{"attempt":9,"untouched":true}',timestamp '2026-10-01 01:02:03.123456','original failure',
          timestamp '2100-01-01 00:00:00.654321',timestamp '2026-10-01 01:02:03.567891')
        on conflict(name) do update set requested_version=87,processed_version=42,cursor=excluded.cursor,
          last_success_at=excluded.last_success_at,last_error=excluded.last_error,not_before=excluded.not_before,updated_at=excluded.updated_at`;
      const [before] = await tx`select to_jsonb(j) as value from jobs j where name=${name}`;
      expect(before.value).toMatchObject({
        requested_version: 87, processed_version: 42, cursor: { attempt: 9, untouched: true },
        last_success_at: "2026-10-01T01:02:03.123456", not_before: "2100-01-01T00:00:00.654321",
        updated_at: "2026-10-01T01:02:03.567891",
      });
      await tx`update jobs set requested_version=88,processed_version=87,cursor=null,last_error=null,
        not_before=null,updated_at=clock_timestamp() where name=${name}`;
      try { await restoreJobRow(tx, name, before.value); }
      catch (error) { restorationError = error; throw error; }
      const [after] = await tx`select to_jsonb(j) as value from jobs j where name=${name}`;
      expect(after.value).toEqual(before.value);
      // Roll back the fixture even after success, preserving an original row or its absence.
      throw rollback;
    }));
  } catch (error) {
    if (error !== rollback && error !== restorationError) throw error;
  }
  expect(await admin`select to_jsonb(j) as value from jobs j where name=${name}`).toEqual(original);
  expect(restorationError).toBeUndefined();
}));
it("a replaced token is never released or rewritten by the old deferred runner", exercise(async () => {
  const name = await seed();
  let replacement: Record<string, unknown> | undefined;
  const result = await runJob(name, async () => {
    await admin`update jobs set lease_token=${randomUUID()},locked_at=clock_timestamp(),requested_version=requested_version+1 where name=${name}`;
    replacement = await row(name);
    throw blocked;
  }, { requestedOnly: true });
  expect(result).toMatchObject({ status: "failed", error: "job_lease_lost" });
  expect(await row(name)).toEqual(replacement);
}));
it("ordinary failures retain the existing error and retry behavior", exercise(async () => {
  const name = await seed();
  expect(await runJob(name, async () => { throw new Error("site connection reset"); }, { requestedOnly: true }))
    .toMatchObject({ status: "failed", error: "site connection reset" });
  expect(await row(name)).toMatchObject({ requested_version: 12, processed_version: 7, lease_token: null, last_error: "site connection reset" });
  const [future] = await admin`select not_before>clock_timestamp() as value from jobs where name=${name}`;
  expect(future.value).toBe(true);
}));
it("a normal empty queue still acknowledges and clears its cursor", exercise(async () => {
  const name = await seed();
  expect(await runJob(name, async () => ({ done: true }), { requestedOnly: true })).toMatchObject({ status: "completed", done: true });
  expect(await row(name)).toMatchObject({ processed_version: 12, cursor: null });
}));
it("an explicit permit-deferred outcome preserves the job like a thrown hold", exercise(async () => {
  const name = await seed();
  let before: Record<string, unknown> | undefined;
  expect(await runJob(name, async () => { before = await row(name); return { done: false, deferred: "http_origin_permit" }; }, { requestedOnly: true }))
    .toMatchObject({ status: "deferred", reason: "http_origin_permit" });
  expect(await row(name)).toEqual({ ...before, lease_token: null, locked_at: null });
}));
it("a permit defer checks actual DB wall after waiting for the job row", exercise(async () => {
  const name = await seed();
  const holder = postgres(TEST_DATABASE_URL, { max: 1, connection: { application_name: `${prefix}-holder` } });
  const started = latch(), finish = latch();
  let holding: Promise<unknown> | undefined;
  let observer: Promise<void> | undefined;
  let heldRow: Record<string, unknown> | undefined;
  let result: Awaited<ReturnType<typeof runJob>> | undefined;
  const errors: unknown[] = [];
  try {
    result = await runJob(name, async () => {
      holding = track(holder.begin(async tx => {
        await tx`update jobs set locked_at=clock_timestamp()-interval '89 seconds' where name=${name}`;
        heldRow = (await tx`select to_jsonb(j) as value from jobs j where name=${name}`)[0].value;
        started.resolve(); await finish.promise;
      }));
      await Promise.race([started.promise, holding]);
      observer = track((async () => {
        let observed = false;
        const deadline = Date.now() + 2_500;
        while (Date.now() < deadline) {
          const rows = await admin`select a.pid from pg_stat_activity a
            where a.datname=current_database() and cardinality(pg_blocking_pids(a.pid))>0 and a.query like '%jobs%'`;
          // The holder's uncommitted timestamp is not visible here; compare to the
          // exact original expiry captured on that actual holder connection instead.
          if (rows.length) {
            const [state] = await admin`select clock_timestamp()>(${String(heldRow?.locked_at)}::text::timestamp+interval '90 seconds') as expired`;
            const [txStart] = await admin`select bool_and(xact_start < (${String(heldRow?.locked_at)}::text::timestamp+interval '90 seconds')) as healthy from pg_stat_activity
              where datname=current_database() and cardinality(pg_blocking_pids(pid))>0 and query like '%jobs%'`;
            expect(txStart.healthy).toBe(true); observed = true;
            if (state.expired) break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(observed).toBe(true);
        const [expired] = await admin`select clock_timestamp()>(${String(heldRow?.locked_at)}::text::timestamp+interval '90 seconds') as value`;
        expect(expired.value).toBe(true);
        finish.resolve(); await holding;
      })());
      void observer.catch(() => finish.resolve());
      throw blocked;
    }, { requestedOnly: true });
    await observer;
    expect(result).toMatchObject({ status: "failed", error: "job_lease_lost" });
    expect(await row(name)).toEqual(heldRow);
  } catch (error) { errors.push(error); }
  finally {
    finish.resolve();
    if (holding) try { await holding; } catch (error) { errors.push(error); }
    try { await holder.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "wall wait body and cleanup failed");
  }

}));
