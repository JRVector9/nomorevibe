import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PRODUCTION_APPLIED_MIGRATIONS } from "../fixtures/production-applied-migrations";
import { TEST_DATABASE_URL } from "./setup";

// 운영은 0140~0142(systemd invocation, M3/M1 complete scope)까지 적용됐다. 0143 replaced-provider 는
// (a) 빈 DB 에 0000~0143 전체 적용, (b) 0142 까지 적용된 DB 에 0143 만 적용 — 두 경로에서 같은 스키마가 되고
// 앞선 CHECK·트리거·판정 함수 분기를 하나도 지우지 않아야 한다.
const root = fileURLToPath(new URL("../..", import.meta.url));
const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
const suffix = randomBytes(4).toString("hex");
const names = { fresh: `nomorevibe_test_m0143_fresh_${suffix}`, step: `nomorevibe_test_m0143_step_${suffix}` };
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const created: string[] = [];
const clients: postgres.Sql[] = [];
const folders: string[] = [];
const CHANGED = ["model_capacity_requests_logical_check", "model_capacity_requests_members_check", "model_capacity_requests_dispatch_check",
  "model_capacity_requests_terminal_check", "model_capacity_events_kind_check"] as const;

async function database(name: string) {
  await admin.unsafe(`CREATE DATABASE ${name}`); created.push(name);
  const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 1, onnotice: () => {} }); clients.push(client);
  await client.unsafe("set statement_timeout = 0");
  return client;
}
function folder(entries: typeof journal.entries) {
  const partial = mkdtempSync(path.join(tmpdir(), "m0143-migrations-")); folders.push(partial);
  mkdirSync(path.join(partial, "meta"));
  for (const entry of entries) copyFileSync(path.join(root, "drizzle", `${entry.tag}.sql`), path.join(partial, `${entry.tag}.sql`));
  writeFileSync(path.join(partial, "meta/_journal.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")), entries }));
  return partial;
}
const through = (index: number) => folder(journal.entries.filter(entry => entry.idx <= index));
async function applied(client: postgres.Sql) {
  return Array.from(await client<{ hash: string; created_at: string }[]>`SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`);
}
/** CHECK·트리거·nmv_ 함수 정의 전체. 두 경로의 결과 스키마를 그대로 비교한다. */
async function schema(client: postgres.Sql) {
  const checks = await client<{ key: string; def: string }[]>`SELECT conrelid::regclass::text || '.' || conname AS key, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`;
  const triggers = await client<{ key: string; def: string }[]>`SELECT tgrelid::regclass::text || '.' || tgname AS key, pg_get_triggerdef(oid) AS def
    FROM pg_trigger WHERE NOT tgisinternal`;
  const functions = await client<{ key: string; def: string }[]>`SELECT p.oid::regprocedure::text AS key, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'nmv\\_%' AND p.prokind = 'f'`;
  const map = (rows: { key: string; def: string }[]) => Object.fromEntries(Array.from(rows).map(row => [row.key, row.def]).sort(([a], [b]) => a.localeCompare(b)));
  return { checks: map(checks), triggers: map(triggers), functions: map(functions) };
}
const inner = (def: string) => { expect(def.startsWith("CHECK (")).toBe(true); return def.slice("CHECK (".length, -1); };
function failure(error: unknown): string {
  const parts: string[] = [];
  for (let value = error as { message?: string; cause?: unknown } | undefined; value; value = value.cause as typeof value) parts.push(String(value.message));
  return parts.join(" | ");
}

let fresh: postgres.Sql, step: postgres.Sql;
beforeAll(async () => {
  expect(journal.entries.slice(140, 144).map(entry => [entry.idx, entry.tag, entry.when])).toEqual([
    [140, "0140_systemd_invocation_boundary", 1794086400052], [141, "0141_complete_m3_provider_scope", 1794086400053],
    [142, "0142_complete_m1_gateway_scope", 1794086400054], [143, "0143_replaced_provider_boundary_exit", 1794086400055]]);
  fresh = await database(names.fresh);
  step = await database(names.step);
}, 60_000);
afterAll(async () => {
  for (const client of clients) await client.end({ timeout: 5 });
  for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end({ timeout: 5 });
  for (const partial of folders) rmSync(partial, { recursive: true, force: true });
}, 60_000);

it("0143 refuses to run on a chain without 0140~0142 instead of rebuilding CHECKs without their branches", async () => {
  await migrate(drizzle(step), { migrationsFolder: through(139) });
  expect(await applied(step)).toHaveLength(140);
  const skipped = folder(journal.entries.filter(entry => entry.idx <= 139 || entry.idx === 143));
  const error = await migrate(drizzle(step), { migrationsFolder: skipped }).then(() => null, (value: unknown) => value);
  expect(failure(error)).toContain("replaced_provider_predecessor_0142_missing");
  // 한 transaction 이라 아무것도 남지 않는다
  expect(await applied(step)).toHaveLength(140);
  expect((await step`SELECT to_regprocedure('nmv_replaced_provider_release_valid(jsonb)') IS NULL AS absent`)[0].absent).toBe(true);
}, 600_000);

it("(a) 0000~0143 on an empty DB and (b) 0143 alone on a 0142 DB give the same schema and keep every predecessor branch", async () => {
  // (b) 운영과 같은 0142 상태
  await migrate(drizzle(step), { migrationsFolder: through(142) });
  const production = await applied(step);
  expect(production.map(row => [row.hash, Number(row.created_at)])).toEqual(PRODUCTION_APPLIED_MIGRATIONS.map(([, , when, hash]) => [hash, when]));
  const before = await schema(step);
  for (const version of ["5", "6", "7"])
    expect(before.functions["nmv_provider_boundary_transition_guard()"], `0140~0142 plan v${version} owner guard`)
      .toContain(`NEW.terminal_evidence->'plan'->'version'='${version}'::jsonb`);
  // 0143 하나만의 효과를 본다. 뒤의 0144·0145는 아래에서 전체 체인으로 비교한다.
  await migrate(drizzle(step), { migrationsFolder: through(143) });
  const stepped = await schema(step);
  expect(await applied(step)).toHaveLength(144);

  // 0143 은 다섯 CHECK 에 replaced-provider 분기만 덧붙이고 0142 의 전체 술어를 그대로 감싼다
  for (const name of CHANGED) {
    const table = name.startsWith("model_capacity_events") ? "model_capacity_events" : "model_capacity_requests";
    const key = `${table}.${name}`;
    const branch = table === "model_capacity_events" ? "nmv_replaced_provider_event_valid(to_jsonb(model_capacity_events))"
      : "nmv_replaced_provider_request_valid(to_jsonb(model_capacity_requests))";
    await step.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT m0143_expected CHECK ((${inner(before.checks[key])}) OR ${branch})`);
    try {
      const [expected] = await step<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'm0143_expected'`;
      expect(stepped.checks[key], `${name}: entire 0142 predicate plus strict 0143 branch`).toBe(expected.def);
    } finally { await step.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT m0143_expected`); }
  }
  for (const key of Object.keys(before.checks).filter(key => !CHANGED.some(name => key.endsWith(`.${name}`))))
    expect(stepped.checks[key], `${key}: unchanged by 0143`).toBe(before.checks[key]);
  // 트리거와 기존 판정 함수(0140~0142 의 v5/v6/v7·pre_0140~pre_0142 포함)는 그대로, 0143 은 새 것만 더한다
  expect(stepped.triggers).toEqual({ ...before.triggers,
    "model_capacity_requests.model_capacity_replaced_provider_guard": expect.stringContaining("EXECUTE FUNCTION nmv_replaced_provider_transition_guard()") });
  for (const [key, def] of Object.entries(before.functions)) expect(stepped.functions[key], `${key}: unchanged by 0143`).toBe(def);
  for (const key of ["nmv_systemd_invocation_boundary_valid(jsonb,jsonb,jsonb)", "nmv_complete_m3_provider_scope_valid(jsonb,jsonb)",
    "nmv_complete_m1_gateway_scope_valid(jsonb,jsonb)", "nmv_historical_m1_native_exit_valid(jsonb,jsonb)",
    "nmv_provider_boundary_release_v5_valid(jsonb)", "nmv_provider_boundary_release_v6_valid(jsonb)", "nmv_provider_boundary_release_v7_valid(jsonb)",
    "nmv_provider_boundary_release_pre_0140(jsonb)", "nmv_provider_boundary_release_pre_0141(jsonb)", "nmv_provider_boundary_release_pre_0142(jsonb)"])
    expect(stepped.functions[key], key).toBeDefined();
  const added = Object.keys(stepped.functions).filter(key => !(key in before.functions)).sort();
  expect(added).toEqual(["nmv_replaced_provider_event_valid(jsonb)", "nmv_replaced_provider_predecessor_valid(jsonb)",
    "nmv_replaced_provider_records_valid(jsonb,jsonb)", "nmv_replaced_provider_release_valid(jsonb)",
    "nmv_replaced_provider_request_valid(jsonb)", "nmv_replaced_provider_shape_valid(jsonb,jsonb,integer)", "nmv_replaced_provider_transition_guard()"]);

  // (a) 빈 DB 전체 적용과 (b) 0142 위에 나머지 적용이 같은 기록·스키마를 만든다
  await migrate(drizzle(step), { migrationsFolder: path.join(root, "drizzle") });
  await migrate(drizzle(fresh), { migrationsFolder: path.join(root, "drizzle") });
  expect(await applied(step)).toHaveLength(journal.entries.length);
  expect(await applied(fresh)).toEqual(await applied(step));
  expect(await schema(fresh)).toEqual(await schema(step));
}, 600_000);
