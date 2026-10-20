import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { uptimeSplitPolicyHash, type UptimeSplitPolicy } from "@/lib/domain/products/uptime-split-policy";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * U1a 0104: 실제 PostgreSQL 에서 0104 바로 앞 migration 까지 올린 DB 에 제품을 넣고 0104 를 더한다(백필·외래 키·CHECK·상호 배제 트리거).
 * 이 파일이 만들고 지우는 임시 DB 하나만 쓴다(공유 test DB 는 건드리지 않는다). 뒤 migration 이 생겨도 0104 직후 상태를 본다.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const name = `nomorevibe_test_u1a_${randomBytes(6).toString("hex")}`;
const url = (() => { const value = new URL(TEST_DATABASE_URL); value.pathname = `/${name}`; return value.toString(); })();
const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
/** 0104 바로 앞 migration — main 의 migration 이 먼저 들어가도(0103_social_posts) 0104 하나만 더한 차이를 본다 */
const PREVIOUS = journal.entries[journal.entries.findIndex(entry => entry.tag === "0104_uptime_split") - 1].tag;
const NEW_TABLES = ["uptime_split_control", "uptime_claims", "uptime_host_windows", "uptime_host_breakers"];
const policy: UptimeSplitPolicy = { version: 1, hosts: [{ host: "m3", instanceId: "m3-maintenance", region: "kr-home", class: "home" }],
  claim: { ttlMs: 180_000 }, confirm: { affinityDays: 7 },
  breaker: { windowMinutes: 10, minChecks: 100, openRatio: 0.08, batchMin: 30, batchOpenRatio: 0.3, coolDownMinutes: 10,
    maxCoolDownMinutes: 60, probeSize: 30, probeCloseRatio: 0.05 } };
let created = false, client: postgres.Sql | undefined, ids: Record<string, number> = {};
let before: { constraints: string[]; triggers: string[] }, after: { constraints: string[]; triggers: string[] };
let window: { start: Date; end: Date };
const sql = () => client!;

async function migrateThrough(tag: string) {
  const through = journal.entries.slice(0, journal.entries.findIndex(entry => entry.tag === tag) + 1);
  expect(through.at(-1)?.tag).toBe(tag);
  const folder = mkdtempSync(path.join(tmpdir(), "u1a-migrations-"));
  try {
    mkdirSync(path.join(folder, "meta"));
    for (const entry of through) copyFileSync(path.join(root, "drizzle", `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
    writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")), entries: through }));
    const migrator = postgres(url, { max: 1, onnotice: () => {} });
    try { await migrator.unsafe("set statement_timeout = 0"); await migrator.unsafe("set lock_timeout = '10s'"); await migrate(drizzle(migrator), { migrationsFolder: folder }); }
    finally { await migrator.end({ timeout: 5 }); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
  return through.length;
}
async function catalog() {
  const constraints = await sql()<{ row: string }[]>`SELECT conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) AS row
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid <> 0 AND NOT (conrelid::regclass::text = ANY(${NEW_TABLES}::text[])) ORDER BY 1`;
  const triggers = await sql()<{ row: string }[]>`SELECT tgrelid::regclass::text || ':' || tgname AS row FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`;
  return { constraints: constraints.map(value => value.row), triggers: triggers.map(value => value.row) };
}
async function product(slug: string, status: string, accessMode: string) {
  const [row] = await sql()<{ id: number }[]>`INSERT INTO products (slug, url, name, tagline, description, category, verify_token, edit_token_hash, status, access_mode)
    VALUES (${slug}, ${`https://${slug}.example`}, ${slug}, 't', 'd', 'tool', 'v', ${"a".repeat(64)}, ${status}, ${accessMode}) RETURNING id`;
  return row.id;
}
const rejects = async (statement: Promise<unknown>, code: string, message?: string) => {
  const error = await statement.then(() => null, (failure: { code?: string; message?: string }) => failure);
  expect(error?.code).toBe(code);
  if (message) expect(error?.message).toContain(message);
};

beforeAll(async () => {
  ensureSchema();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${name}`); created = true; } finally { await admin.end({ timeout: 5 }); }
  await migrateThrough(PREVIOUS);
  client = postgres(url, { max: 4, prepare: false, onnotice: () => {} });
  ids = { listed: await product("u1a-listed", "verified", "website"), fresh: await product("u1a-fresh", "seeded", "website"),
    banned: await product("u1a-banned", "banned", "website"), installable: await product("u1a-installable", "verified", "installable"),
    unverified: await product("u1a-unverified", "unverified", "website") };
  await sql()`INSERT INTO product_health (slug, checked_at, status, failures) VALUES ('u1a-listed', '2026-10-18 21:00:00.123', 200, 0),
    ('u1a-banned', '2026-10-18 21:00:00', 500, 4)`;
  before = await catalog();
  const [start] = await sql()<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
  expect(await migrateThrough("0104_uptime_split")).toBe(journal.entries.findIndex(entry => entry.tag === "0104_uptime_split") + 1);
  const [end] = await sql()<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
  window = { start: start.at, end: end.at };
  after = await catalog();
}, 600_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { if (created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

it("re-running the migrator is a no-op (journal records 0104 once)", async () => {
  const count = async () => (await sql()<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0].n;
  const applied = await count();
  await migrateThrough("0104_uptime_split");
  expect(await count()).toBe(applied);
  expect((await sql()<{ n: number }[]>`SELECT count(*)::int AS n FROM uptime_split_control`)[0].n).toBe(1);
});

it("starts in legacy with no policy, so deploying it changes nothing", async () => {
  expect(await sql()`SELECT id, mode, epoch::int AS epoch, policy, policy_hash FROM uptime_split_control`)
    .toEqual([{ id: 1, mode: "legacy", epoch: 1, policy: null, policy_hash: null }]);
});

it("backfills one idle row per public website product, due six hours after the last check (UTC) or now", async () => {
  const rows = await sql()<{ product_id: number; state: string; epoch: number; due_at: Date; token: string | null }[]>`
    SELECT product_id, state, epoch::int AS epoch, due_at, token FROM uptime_claims ORDER BY product_id`;
  expect(rows.map(row => row.product_id)).toEqual([ids.listed, ids.fresh]);
  expect(rows.every(row => row.state === "idle" && row.epoch === 0 && row.token === null)).toBe(true);
  expect(rows[0].due_at).toEqual(new Date("2026-10-19T03:00:00.123Z"));
  expect(rows[1].due_at.getTime()).toBeGreaterThanOrEqual(window.start.getTime());
  expect(rows[1].due_at.getTime()).toBeLessThanOrEqual(window.end.getTime());
});

it("changes no existing constraint and adds only the split guard trigger to an existing table", () => {
  expect(after.constraints).toEqual(before.constraints);
  expect(after.triggers.filter(row => !before.triggers.includes(row))).toEqual(
    ["uptime_control:uptime_control_split_exclusive", "uptime_split_control:uptime_split_control_exclusive"]);
  expect(before.triggers.filter(row => !after.triggers.includes(row))).toEqual([]);
});

it("deleting a product removes its claim row (ON DELETE CASCADE)", async () => {
  const id = await product(`u1a-gone-${randomUUID().slice(0, 8)}`, "verified", "website");
  await sql()`INSERT INTO uptime_claims (product_id) VALUES (${id})`;
  await sql()`DELETE FROM products WHERE id = ${id}`;
  expect(await sql()`SELECT 1 FROM uptime_claims WHERE product_id = ${id}`).toHaveLength(0);
  await rejects(sql()`INSERT INTO uptime_claims (product_id) VALUES (${id})`, "23503");
});

it("enforces the claim row shapes: claimed/submitted fields, Oracle is always probe, result and slot shape", async () => {
  const id = await product(`u1a-shape-${randomUUID().slice(0, 8)}`, "verified", "website");
  await sql()`INSERT INTO uptime_claims (product_id) VALUES (${id})`;
  const claim = (host: string, hostClass: string, change: { slot?: string; lease?: string | null; kind?: string; status?: number } = {}) => sql()`
    UPDATE uptime_claims SET state = 'claimed', epoch = 1, control_epoch = 1, token = ${randomUUID()}, owner_instance_id = 'm3-maintenance',
    owner_boot_id = ${randomUUID()}, host = ${host}, host_class = ${hostClass}, claimed_at = clock_timestamp(),
    lease_until = ${change.lease === undefined ? "2099-01-01 00:00:00+00" : change.lease}::timestamptz, claim_slug = 's', claim_url = 'https://s.example',
    origin = 'https://s.example', claim_slot = ${change.slot ?? "2026-10-19 00:00:00+00"}::timestamptz,
    result_kind = ${change.kind ?? null}, result_status = ${change.status ?? null} WHERE product_id = ${id}`;
  await rejects(claim("oracle-osaka-smoke", "home"), "23514", "uptime_claims_host");
  await rejects(claim("m3", "probe"), "23514", "uptime_claims_host");
  await rejects(claim("m3", "home", { slot: "2026-10-19 01:00:00+00" }), "23514", "uptime_claims_slot");
  await rejects(claim("m3", "home", { kind: "http", status: 200 }), "23514", "uptime_claims_state");
  await rejects(claim("m3", "home", { lease: null }), "23514", "uptime_claims_state");
  await claim("oracle-osaka-smoke", "probe");
  const submit = (kind: string, status: number) => sql()`UPDATE uptime_claims SET state = 'submitted', lease_until = NULL, submitted_at = clock_timestamp(),
    result_started_at = clock_timestamp(), result_observed_at = clock_timestamp(), result_kind = ${kind}, result_status = ${status} WHERE product_id = ${id}`;
  await rejects(submit("timeout", 504), "23514", "uptime_claims_result");
  await rejects(submit("http", 0), "23514", "uptime_claims_result");
  await submit("http", 403);
  await rejects(sql()`UPDATE uptime_claims SET state = 'idle' WHERE product_id = ${id}`, "23514", "uptime_claims_state");
  await sql()`UPDATE uptime_claims SET state = 'idle', token = NULL, confirm_class = 'home', confirm_reason = 'http:403',
    confirm_requested_at = clock_timestamp(), due_at = clock_timestamp() WHERE product_id = ${id}`;
  await rejects(sql()`UPDATE uptime_claims SET confirm_class = 'probe' WHERE product_id = ${id}`, "23514", "uptime_claims_confirm");
  await rejects(sql()`UPDATE uptime_claims SET confirm_requested_at = NULL WHERE product_id = ${id}`, "23514", "uptime_claims_confirm");
  await rejects(sql()`UPDATE uptime_claims SET conflict_count = -1 WHERE product_id = ${id}`, "23514", "uptime_claims_epochs");
});

it("enforces breaker and window shapes", async () => {
  await rejects(sql()`INSERT INTO uptime_host_windows VALUES ('m3', '2026-10-19 03:00:30+00', 10, 1, 0)`, "23514", "uptime_host_windows_counts");
  await rejects(sql()`INSERT INTO uptime_host_windows VALUES ('m3', '2026-10-19 03:00:00+00', 10, 11, 0)`, "23514", "uptime_host_windows_counts");
  await rejects(sql()`INSERT INTO uptime_host_windows VALUES ('oracle', '2026-10-19 03:00:00+00', 10, 1, 0)`, "23514", "uptime_host_windows_counts");
  await sql()`INSERT INTO uptime_host_windows VALUES ('oracle-osaka-smoke', '2026-10-19 03:00:00+00', 10, 2, 1)`;
  await rejects(sql()`INSERT INTO uptime_host_breakers (host, state, opened_at) VALUES ('m3', 'open', clock_timestamp())`, "23514", "uptime_host_breakers_shape");
  await rejects(sql()`INSERT INTO uptime_host_breakers (host, state, probe_checks, probe_failures) VALUES ('m3', 'closed', 3, 0)`, "23514", "uptime_host_breakers_shape");
  await rejects(sql()`INSERT INTO uptime_host_breakers (host, state, opened_at, probe_after, probe_checks, probe_failures)
    VALUES ('m3', 'probing', clock_timestamp(), clock_timestamp(), 3, 4)`, "23514", "uptime_host_breakers_shape");
  await sql()`INSERT INTO uptime_host_breakers (host, state, opened_at, probe_after, reason, ratio)
    VALUES ('m3', 'open', clock_timestamp(), clock_timestamp() + interval '10 minutes', 'batch_ratio', 0.33333)`;
  expect((await sql()<{ ratio: string }[]>`SELECT ratio::text FROM uptime_host_breakers WHERE host = 'm3'`)[0].ratio).toBe("0.3333");
});

it("split claims and PR09 observations/gate exclude each other in both directions", async () => {
  const hash = uptimeSplitPolicyHash(policy);
  await rejects(sql()`UPDATE uptime_split_control SET mode = 'claims' WHERE id = 1`, "23514", "uptime_split_control_policy");
  await rejects(sql()`UPDATE uptime_split_control SET policy = ${sql().json(policy)} WHERE id = 1`, "23514", "uptime_split_control_policy");
  try {
    await sql()`UPDATE uptime_control SET observations_enabled = true WHERE id = 1`;
    await rejects(sql()`UPDATE uptime_split_control SET mode = 'claims', policy = ${sql().json(policy)}, policy_hash = ${hash}, epoch = epoch + 1 WHERE id = 1`,
      "55000", "uptime_split_requires_uptime_control_disabled");
    // legacy 로 policy 만 두는 것은 막지 않는다
    await sql()`UPDATE uptime_split_control SET policy = ${sql().json(policy)}, policy_hash = ${hash} WHERE id = 1`;
    await sql()`UPDATE uptime_control SET observations_enabled = false, gate_enabled = false WHERE id = 1`;
    await sql()`UPDATE uptime_split_control SET mode = 'claims', epoch = epoch + 1 WHERE id = 1`;
    await rejects(sql()`UPDATE uptime_control SET observations_enabled = true WHERE id = 1`, "55000", "uptime_control_requires_split_legacy");
    await rejects(sql()`UPDATE uptime_control SET observations_enabled = true, gate_enabled = true WHERE id = 1`, "55000", "uptime_control_requires_split_legacy");
    // 다른 칸(sources·revision)은 split 중에도 바꿀 수 있다
    await sql()`UPDATE uptime_control SET revision = revision + 1 WHERE id = 1`;
  } finally {
    await sql()`UPDATE uptime_split_control SET mode = 'legacy', epoch = epoch + 1 WHERE id = 1`;
    await sql()`UPDATE uptime_control SET observations_enabled = false, gate_enabled = false WHERE id = 1`;
  }
  await sql()`UPDATE uptime_control SET observations_enabled = true WHERE id = 1`;
  await sql()`UPDATE uptime_control SET observations_enabled = false WHERE id = 1`;
});

it("a concurrent enable waits for the uncommitted split switch and then refuses", async () => {
  const hash = uptimeSplitPolicyHash(policy);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let switched!: () => void;
  const ready = new Promise<void>(resolve => { switched = resolve; });
  const split = sql().begin(async tx => {
    await tx`UPDATE uptime_split_control SET mode = 'claims', policy = ${tx.json(policy)}, policy_hash = ${hash}, epoch = epoch + 1 WHERE id = 1`;
    switched();
    await held;
  });
  try {
    await ready;
    let settled = false;
    const enable = sql()`UPDATE uptime_control SET observations_enabled = true WHERE id = 1`.then(
      () => { settled = true; return null; }, (error: { code?: string; message?: string }) => { settled = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    const [waiting] = await sql()<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    expect(waiting.n).toBe(1);
    release();
    await split;
    const error = await enable;
    expect(error?.code).toBe("55000");
    expect(error?.message).toContain("uptime_control_requires_split_legacy");
  } finally {
    release();
    await split.catch(() => {});
    await sql()`UPDATE uptime_split_control SET mode = 'legacy', epoch = epoch + 1 WHERE id = 1`;
    await sql()`UPDATE uptime_control SET observations_enabled = false, gate_enabled = false WHERE id = 1`;
  }
  expect((await sql()<{ observations_enabled: boolean }[]>`SELECT observations_enabled FROM uptime_control WHERE id = 1`)[0].observations_enabled).toBe(false);
});
