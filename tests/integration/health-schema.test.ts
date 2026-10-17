import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { GET } from "@/app/api/health/route";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * R4: 웹이 기대하는 migration(이 빌드의 journal 마지막 항목)이 DB 에 없으면 /api/health 가 503 이어야 배포 helper(status·db·release
 * 확인)가 롤아웃을 멈춘다. 0095 없이 배포되면 웹 쓰기·로그인·action·webhook 이 모두 실패하는데 select 1 만 보면 200 이었다.
 * 이 파일이 만들고 지우는 임시 DB 하나만 쓴다(공유 test DB 의 migration 기록은 건드리지 않는다). handler 는 직접 부른다.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const name = `nomorevibe_test_health_${randomBytes(6).toString("hex")}`;
const url = (() => { const value = new URL(TEST_DATABASE_URL); value.pathname = `/${name}`; return value.toString(); })();
const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
const latest = journal.entries[journal.entries.length - 1];
let created = false;
let client: postgres.Sql | undefined;

beforeAll(async () => {
  ensureSchema();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${name}`); created = true; } finally { await admin.end({ timeout: 5 }); }
  const migrator = postgres(url, { max: 1, onnotice: () => {} });
  try { await migrator.unsafe("set statement_timeout = 0"); await migrate(drizzle(migrator), { migrationsFolder: path.join(root, "drizzle") }); }
  finally { await migrator.end({ timeout: 5 }); }
  client = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
  // 태그 포함 + 적용 수 == journal 길이(개수를 하드코딩하지 않는다)
  expect(journal.entries.map(entry => entry.tag)).toContain("0095_dr_writer_fence");
  expect((await client`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0].n).toBe(journal.entries.length);
  const g = globalThis as { db?: unknown; pgClient?: unknown };
  g.pgClient = client;
  g.db = drizzle(client, { schema });
}, 600_000);

afterAll(async () => {
  const g = globalThis as { db?: unknown; pgClient?: unknown };
  delete g.db; delete g.pgClient;
  await client?.end({ timeout: 5 });
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { if (created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

it("all expected migrations applied: 200 with the existing shape (status·db·instance·release·latency)", async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = await res.json();
  expect(body).toMatchObject({ status: "ok", db: "ok", instanceId: expect.any(String), release: expect.any(String), dbLatencyMs: expect.any(Number) });
});

it("the code's latest migration missing (deployed before migrate): 503 with schema pending and a structured error log", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await client!`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${latest.when}`;
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "error", db: "ok", schema: "pending", expectedMigration: latest.tag });
    const lines = stderr.mock.calls.map(([line]) => String(line)).filter(line => line.includes("health.schema_not_ready"));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "error", event: "health.schema_not_ready", schema: "pending", expectedMigration: latest.tag });
  } finally { stderr.mockRestore(); }
});

it("migration ledger unreadable (no drizzle schema): 503 schema unverified — never a silent 200", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await client!.unsafe("DROP SCHEMA drizzle CASCADE");
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "error", db: "ok", schema: "unverified", expectedMigration: latest.tag });
  } finally { stderr.mockRestore(); }
});
