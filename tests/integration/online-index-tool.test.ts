import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectOnlineIndex, parseIndexStatements, parseOnlineIndexOptions, runOnlineIndex,
  type OnlineIndexConnection, type OnlineIndexOptions } from "../../scripts/ops/online-index";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 온라인 인덱스 도구(scripts/ops/online-index.ts)와 0192 의 두 가드를 실제 PostgreSQL 에서 본다(2026-11-21 전수 점검 W0-3).
 * 이 파일이 만들고 지우는 임시 DB 하나만 쓴다 — CONCURRENTLY 는 트랜잭션 밖에서 돌고 실패하면 INVALID 인덱스를 남기므로 공유 시험 DB 에서 하지 않는다.
 * 표는 필요한 칸만 가진 작은 표다(0192 는 표·칸 이름만 본다).
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const name = `nomorevibe_test_online_index_${randomBytes(6).toString("hex")}`;
const url = (() => { const value = new URL(TEST_DATABASE_URL); value.pathname = `/${name}`; return value.toString(); })();
const MIGRATION = readFileSync(path.join(root, "drizzle/0192_online_missing_indexes.sql"), "utf8");
const FIVE = ["agent_scans_repository_latest_idx", "model_capacity_requests_logical_key_idx", "pipeline_item_leases_ai2_candidate_idx",
  "second_reviews_fallback_for_idx", "second_reviews_first_attempt_idx"];
type Event = Record<string, unknown> & { event: string };
let created = false;
let sql: postgres.Sql;
let other: postgres.Sql;
let connection: OnlineIndexConnection;

beforeAll(async () => {
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${name}`); created = true; } finally { await admin.end({ timeout: 5 }); }
  sql = postgres(url, { max: 1, onnotice: () => {} });
  other = postgres(url, { max: 1, onnotice: () => {} });
  connection = connectOnlineIndex(url);
}, 120_000);

afterAll(async () => {
  await connection?.close();
  await Promise.all([sql?.end({ timeout: 5 }), other?.end({ timeout: 5 })]);
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { if (created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

const options = (extra: string[] = []): OnlineIndexOptions =>
  parseOnlineIndexOptions(["fixture.sql", "--lock-timeout-ms", "300", "--lock-retries", "2", "--progress-ms", "200", ...extra]);
async function run(migration: string, extra: string[] = [], stopping: () => boolean = () => false) {
  const events: Event[] = [];
  const outcome = await runOnlineIndex(connection, parseIndexStatements(migration), options(extra), (event, fields) => { events.push({ event, ...fields }); }, stopping);
  return { ...outcome, events, statuses: Object.fromEntries(outcome.results.map((entry) => [entry.index, entry.status])) };
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
/** 인덱스 이름 → 유효한가. 없는 이름은 빠진다 */
async function indexes(names: readonly string[]): Promise<Record<string, boolean>> {
  const rows = await sql<{ name: string; ok: boolean }[]>`
    select c.relname::text as name, i.indisvalid and i.indisready and i.indislive as ok
    from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname::text = any(${names as string[]}::text[])`;
  return Object.fromEntries(rows.map((row) => [row.name, row.ok]));
}
/** 같은 이름으로 실패한 CONCURRENTLY 빌드의 흔적(INVALID 인덱스)을 남긴다 — 0 으로 나누는 식이라 빌드가 중간에 죽는다 */
async function leaveInvalid(index: string, table: string, column: string): Promise<void> {
  await expect(sql.unsafe(`create index concurrently "${index}" on "${table}" ((1 / ("${column}" - "${column}")))`)).rejects.toMatchObject({ code: "22012" });
  expect(await indexes([index])).toEqual({ [index]: false });
}

describe("online index tool on a fixture migration", () => {
  const FILE = `-- CREATE INDEX IF NOT EXISTS "commented_out_idx" ON "fixture_items" ("a");
CREATE INDEX IF NOT EXISTS "fixture_items_a_idx" ON "fixture_items" ("a") WHERE "a" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fixture_items_lower_b_idx" ON "fixture_items" (lower("b"), "id" DESC);`;
  const NAMES = ["fixture_items_a_idx", "fixture_items_lower_b_idx"];

  beforeEach(async () => {
    await sql.unsafe(`drop table if exists fixture_items`);
    await sql.unsafe(`create table fixture_items (id serial primary key, a integer, b text not null)`);
    await sql.unsafe(`insert into fixture_items (a, b) select case when g % 5 > 0 then g end, 'Row-' || g from generate_series(1, 5000) g`);
    await sql.unsafe(`analyze fixture_items`);
  });

  it("plans without creating, executes once, and does nothing on the second execute", async () => {
    const plan = await run(FILE);
    expect(plan.ok).toBe(true);
    expect(plan.statuses).toEqual({ fixture_items_a_idx: "would_create", fixture_items_lower_b_idx: "would_create" });
    const planned = plan.events.filter((event) => event.event === "index");
    // 표 크기와 어림: 부분 인덱스는 술어에 맞는 행만(5,000행의 4/5)
    expect(planned[0]).toMatchObject({ table: "fixture_items", tableRows: 5000 });
    expect(planned[0].estimatedRows).toBeGreaterThan(3500);
    expect(planned[0].estimatedRows).toBeLessThan(4500);
    expect(planned[1]).toMatchObject({ estimatedRows: 5000 });
    for (const entry of planned) {
      expect(entry.tableHeapBytes).toBeGreaterThan(0);
      expect(entry.estimatedIndexBytes).toBeGreaterThan(0);
      expect(entry.estimatedBuildDiskBytes).toBe((entry.estimatedIndexBytes as number) * 3);
    }
    expect(await indexes(NAMES)).toEqual({});

    const first = await run(FILE, ["--execute"]);
    expect(first.ok).toBe(true);
    expect(first.statuses).toEqual({ fixture_items_a_idx: "built", fixture_items_lower_b_idx: "built" });
    expect(first.events.filter((event) => event.event === "build_start")).toHaveLength(2);
    expect(await indexes(NAMES)).toEqual({ fixture_items_a_idx: true, fixture_items_lower_b_idx: true });
    const [definition] = await sql<{ def: string }[]>`select pg_get_indexdef('fixture_items_lower_b_idx'::regclass) as def`;
    expect(definition.def).toContain("USING btree (lower(b), id DESC)");

    const second = await run(FILE, ["--execute"]);
    expect(second.ok).toBe(true);
    expect(second.statuses).toEqual({ fixture_items_a_idx: "present", fixture_items_lower_b_idx: "present" });
    expect(second.events.filter((event) => event.event === "index").map((event) => event.definition)).toEqual(["same", "same"]);
    expect(second.events.some((event) => event.event === "build_start" || event.event === "dropped_invalid")).toBe(false);
    // 세션 잠금은 끝나면 놓는다
    expect(await sql`select 1 from pg_locks where locktype = 'advisory'`).toHaveLength(0);
  });

  it("builds only the named index with --only", async () => {
    const result = await run(FILE, ["--execute", "--only", "fixture_items_lower_b_idx"]);
    expect(result.statuses).toEqual({ fixture_items_a_idx: "skipped", fixture_items_lower_b_idx: "built" });
    expect(await indexes(NAMES)).toEqual({ fixture_items_lower_b_idx: true });
    await expect(run(FILE, ["--only", "unknown_idx"])).rejects.toThrow("online_index_only_not_in_file");
  });

  it("drops an INVALID remnant of the same name and rebuilds it", async () => {
    await leaveInvalid("fixture_items_a_idx", "fixture_items", "a");
    const plan = await run(FILE);
    expect(plan.statuses).toEqual({ fixture_items_a_idx: "would_rebuild_invalid", fixture_items_lower_b_idx: "would_create" });
    expect(await indexes(NAMES)).toEqual({ fixture_items_a_idx: false });

    const executed = await run(FILE, ["--execute"]);
    expect(executed.ok).toBe(true);
    expect(executed.statuses).toEqual({ fixture_items_a_idx: "built", fixture_items_lower_b_idx: "built" });
    expect(executed.events.filter((event) => event.event === "dropped_invalid").map((event) => event.index)).toEqual(["fixture_items_a_idx"]);
    expect(await indexes(NAMES)).toEqual({ fixture_items_a_idx: true, fixture_items_lower_b_idx: true });
    const [definition] = await sql<{ def: string }[]>`select pg_get_indexdef('fixture_items_a_idx'::regclass) as def`;
    expect(definition.def).toContain("USING btree (a) WHERE (a IS NOT NULL)");
  });

  it("cleans up after a failed build, retries once, and reports failure without leaving an INVALID index", async () => {
    const BAD = `CREATE INDEX IF NOT EXISTS "fixture_items_bad_idx" ON "fixture_items" ((1 / ("a" - "a")));`;
    const result = await run(BAD, ["--execute"]);
    expect(result.ok).toBe(false);
    expect(result.results).toEqual([expect.objectContaining({ index: "fixture_items_bad_idx", status: "failed", reason: "db_22012", attempts: 2 })]);
    expect(result.events.filter((event) => event.event === "build_failed").map((event) => [event.attempt, event.left])).toEqual([[1, "invalid"], [2, "invalid"]]);
    expect(result.events.filter((event) => event.event === "dropped_invalid")).toHaveLength(2);
    expect(await indexes(["fixture_items_bad_idx"])).toEqual({});
  });

  it("backs off when the table lock is held by other DDL and builds once it is free", async () => {
    const release = latch();
    const holding = other.begin(async (tx) => { await tx.unsafe("lock table fixture_items in share update exclusive mode"); await release.promise; });
    try {
      await expect.poll(async () => (await sql`select 1 from pg_locks where relation = 'fixture_items'::regclass and mode = 'ShareUpdateExclusiveLock'`).length).toBe(1);
      const blocked = await run(FILE, ["--execute", "--only", "fixture_items_a_idx"]);
      expect(blocked.ok).toBe(false);
      expect(blocked.statuses.fixture_items_a_idx).toBe("lock_unavailable");
      expect(blocked.events.filter((event) => event.event === "lock_wait")).toHaveLength(2);
      expect(blocked.events.some((event) => event.event === "build_start")).toBe(false);
      expect(await indexes(NAMES)).toEqual({});
    } finally {
      release.resolve();
      await holding;
    }
    expect((await run(FILE, ["--execute", "--only", "fixture_items_a_idx"])).statuses.fixture_items_a_idx).toBe("built");
  });

  it("waits for a writing transaction during the build and shows whom it waits for", async () => {
    // 쓰는 트랜잭션이 열려 있는 동안 CONCURRENTLY 는 기다린다. 기다림 한도가 넉넉하면 그 트랜잭션이 끝난 뒤 만든다
    const release = latch();
    const writing = other.begin(async (tx) => { await tx.unsafe("insert into fixture_items (a, b) values (1, 'open')"); await release.promise; });
    try {
      await expect.poll(async () => (await sql`select 1 from pg_locks where relation = 'fixture_items'::regclass and mode = 'RowExclusiveLock'`).length).toBe(1);
      const patient = run(FILE, ["--execute", "--only", "fixture_items_a_idx", "--wait-timeout-ms", "30000"]);
      await new Promise((done) => setTimeout(done, 900));
      release.resolve();
      const built = await patient;
      expect(built.statuses.fixture_items_a_idx).toBe("built");
      const waiting = built.events.filter((event) => event.event === "progress" && String(event.phase).startsWith("waiting for"));
      expect(waiting.length).toBeGreaterThan(0);
      expect(waiting[0].lockerPid).toEqual(expect.any(Number));
    } finally {
      release.resolve();
      await writing;
    }
    expect(await indexes(NAMES)).toEqual({ fixture_items_a_idx: true });
  });

  it("reports the INVALID index it could not remove when the wait limit passes, and clears it on the next run", async () => {
    // 기다림에도 lock_timeout 이 걸린다: 한도가 먼저 지나면 빌드는 INVALID 인덱스를 남기고 실패한다. 같은 트랜잭션이 치우기(DROP … CONCURRENTLY)도 막으므로
    // 도구는 남은 것을 보고하고 멈춘다 — 막던 트랜잭션이 끝난 뒤 다시 돌리면 치우고 만든다
    const release = latch();
    const writing = other.begin(async (tx) => { await tx.unsafe("insert into fixture_items (a, b) values (1, 'open')"); await release.promise; });
    try {
      await expect.poll(async () => (await sql`select 1 from pg_locks where relation = 'fixture_items'::regclass and mode = 'RowExclusiveLock'`).length).toBe(1);
      const expired = await run(FILE, ["--execute", "--only", "fixture_items_a_idx", "--wait-timeout-ms", "300"]);
      expect(expired.ok).toBe(false);
      expect(expired.results.find((entry) => entry.index === "fixture_items_a_idx")).toMatchObject({ status: "failed", reason: "db_55P03:invalid_index_left", attempts: 1 });
      expect(expired.events.filter((event) => event.event === "drop_invalid_failed").map((event) => event.reason)).toEqual(["db_55P03"]);
      expect(await indexes(NAMES)).toEqual({ fixture_items_a_idx: false });
    } finally {
      release.resolve();
      await writing;
    }
    const again = await run(FILE, ["--execute", "--only", "fixture_items_a_idx"]);
    expect(again.statuses.fixture_items_a_idx).toBe("built");
    expect(again.events.filter((event) => event.event === "dropped_invalid")).toHaveLength(1);
    expect(await indexes(NAMES)).toEqual({ fixture_items_a_idx: true });
  });

  it("cancels a running build when asked to stop and removes what it left", async () => {
    const release = latch();
    const writing = other.begin(async (tx) => { await tx.unsafe("insert into fixture_items (a, b) values (1, 'open')"); await release.promise; });
    let stop = false;
    try {
      await expect.poll(async () => (await sql`select 1 from pg_locks where relation = 'fixture_items'::regclass and mode = 'RowExclusiveLock'`).length).toBe(1);
      const stopped = run(FILE, ["--execute", "--wait-timeout-ms", "30000"], () => stop);
      await new Promise((done) => setTimeout(done, 500));
      stop = true;
      // 취소된 빌드가 남긴 INVALID 를 치우는 것도 열린 트랜잭션을 기다린다 — 곧 끝나게 둔다
      await new Promise((done) => setTimeout(done, 500));
      release.resolve();
      const result = await stopped;
      expect(result.ok).toBe(false);
      expect(result.results).toEqual([expect.objectContaining({ index: "fixture_items_a_idx", status: "interrupted", reason: "db_57014" })]);
      expect(result.events.filter((event) => event.event === "dropped_invalid")).toHaveLength(1);
    } finally {
      release.resolve();
      await writing;
    }
    // 다음 인덱스로 넘어가지 않았고 남은 것도 없다
    expect(await indexes(NAMES)).toEqual({});
  });

  it("stops on a valid index of the same name with another definition, and on a second concurrent run", async () => {
    await sql.unsafe(`create index fixture_items_a_idx on fixture_items (a)`);
    const differs = await run(FILE, ["--execute", "--only", "fixture_items_a_idx"]);
    expect(differs.ok).toBe(false);
    expect(differs.statuses.fixture_items_a_idx).toBe("definition_differs");
    // 지우거나 다시 만들지 않는다
    expect((await sql<{ def: string }[]>`select pg_get_indexdef('fixture_items_a_idx'::regclass) as def`)[0].def).not.toContain("WHERE");

    await other`select pg_advisory_lock(hashtextextended('nmv-online-index', 0))`;
    try { await expect(run(FILE)).rejects.toThrow("online_index_already_running"); }
    finally { await other`select pg_advisory_unlock(hashtextextended('nmv-online-index', 0))`; }
  });
});

describe("0192 guards with the tool", () => {
  /** drizzle 마이그레이터처럼: 문장 구분 표식으로 나눠 한 트랜잭션에서 차례로 */
  const migrate = () => sql.begin(async (tx) => { for (const statement of MIGRATION.split("--> statement-breakpoint")) await tx.unsafe(statement); });

  beforeEach(async () => {
    await sql.unsafe(`drop table if exists second_reviews, model_capacity_requests, pipeline_item_leases, agent_repository_scans`);
    await sql.unsafe(`create table second_reviews (id serial primary key, first_attempt_id integer, fallback_for_id integer)`);
    await sql.unsafe(`create table model_capacity_requests (request_id uuid primary key default gen_random_uuid(), logical_work_key varchar(160))`);
    await sql.unsafe(`create table pipeline_item_leases (stage varchar(8) not null, work_key varchar(160) not null, binding jsonb not null, filler text, primary key (stage, work_key))`);
    await sql.unsafe(`create table agent_repository_scans (id serial primary key, repository_key varchar(200) not null, scope text not null default '', started_at timestamp not null default now())`);
  });
  const fillSecondReviews = async () => {
    await sql.unsafe(`insert into second_reviews (first_attempt_id, fallback_for_id) select g / 3, case when g % 10 = 0 then g end from generate_series(1, 60000) g`);
    await sql.unsafe(`analyze second_reviews`);
  };

  it("builds everything in place on small tables (a fresh or test database)", async () => {
    await sql.unsafe(`insert into second_reviews (first_attempt_id) select g from generate_series(1, 100) g`);
    await migrate();
    expect(await indexes(FIVE)).toEqual(Object.fromEntries(FIVE.map((index) => [index, true])));
    // 다시 돌려도 같다
    await migrate();
  });

  it("refuses to build inside the migration when a table is large by row statistics, and leaves nothing behind", async () => {
    await fillSecondReviews();
    await expect(migrate()).rejects.toMatchObject({ code: "55000",
      message: expect.stringMatching(/0192 stopped: large table without its index \(second_reviews_fallback_for_idx, second_reviews_first_attempt_idx\).*scripts\/ops\/online-index\.ts/) });
    expect(await indexes(FIVE)).toEqual({});
  });

  it("refuses by table size when the table has never been analyzed", async () => {
    // 통계가 아직 없는(reltuples -1) 큰 표: 행 수로는 걸리지 않고 본문 32MB 로 걸린다
    await sql.unsafe(`insert into pipeline_item_leases (stage, work_key, binding, filler)
      select 'ai2', 'ai2:' || g, jsonb_build_object('candidateId', g::text), repeat(md5(g::text), 28) from generate_series(1, 40000) g`);
    const [stats] = await sql<{ rows: number; bytes: number }[]>`select reltuples::float8 as rows, pg_relation_size(oid)::float8 as bytes from pg_class where relname = 'pipeline_item_leases'`;
    expect(stats.rows).toBeLessThan(50_000);
    expect(stats.bytes).toBeGreaterThan(33_554_432);
    await expect(migrate()).rejects.toMatchObject({ message: expect.stringMatching(/large table without its index \(pipeline_item_leases_ai2_candidate_idx\)/) });
    expect(await indexes(FIVE)).toEqual({});
  });

  it("after the tool has built them, records the migration without touching the tables — even under an open writer", async () => {
    await fillSecondReviews();
    const plan = await run(MIGRATION);
    expect(Object.values(plan.statuses)).toEqual(Array(5).fill("would_create"));
    const executed = await run(MIGRATION, ["--execute"]);
    expect(executed.ok).toBe(true);
    expect(Object.values(executed.statuses)).toEqual(Array(5).fill("built"));
    expect(await indexes(FIVE)).toEqual(Object.fromEntries(FIVE.map((index) => [index, true])));

    // 쓰는 트랜잭션이 열려 있어도 migrate 가 기다리지 않는다 — 인덱스 문을 실행하지 않으므로 표 잠금을 잡지 않는다.
    // (IF NOT EXISTS 만 믿고 문장을 실행하면 SHARE 잠금을 기다리다 lock_timeout 5초에 실패한다)
    const release = latch();
    const writing = other.begin(async (tx) => {
      await tx.unsafe("insert into second_reviews (first_attempt_id) values (1)");
      await tx.unsafe("insert into model_capacity_requests (logical_work_key) values ('ai1:1')");
      await release.promise;
    });
    try {
      await expect.poll(async () => (await sql`select 1 from pg_locks where relation = 'model_capacity_requests'::regclass and mode = 'RowExclusiveLock'`).length).toBe(1);
      const started = Date.now();
      await migrate();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      release.resolve();
      await writing;
    }
    expect(Object.values((await run(MIGRATION, ["--execute"])).statuses)).toEqual(Array(5).fill("present"));
  });

  it("refuses to record an INVALID index, and passes once the tool has rebuilt it", async () => {
    await sql.unsafe(`insert into second_reviews (first_attempt_id) select g from generate_series(1, 100) g`);
    await leaveInvalid("second_reviews_first_attempt_idx", "second_reviews", "first_attempt_id");
    await expect(migrate()).rejects.toMatchObject({ code: "55000",
      message: expect.stringMatching(/0192 stopped: index missing or INVALID \(second_reviews_first_attempt_idx\)/) });
    // 실패한 migrate 는 다른 인덱스도 남기지 않는다(한 트랜잭션)
    expect(await indexes(FIVE)).toEqual({ second_reviews_first_attempt_idx: false });

    const executed = await run(MIGRATION, ["--execute"]);
    expect(executed.ok).toBe(true);
    expect(executed.events.filter((event) => event.event === "dropped_invalid").map((event) => event.index)).toEqual(["second_reviews_first_attempt_idx"]);
    await migrate();
    expect(await indexes(FIVE)).toEqual(Object.fromEntries(FIVE.map((index) => [index, true])));
  });
});
