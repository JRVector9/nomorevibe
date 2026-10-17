import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// F1 #5: 0097 기록 시작 marker는 지울 수 없다(append-only). 공유 test DB를 더럽히지 않도록 이 파일만의 DB에서 운영자 CLI를 실제로 돌린다.
const root = fileURLToPath(new URL("../..", import.meta.url));
const name = `nomorevibe_test_f1_marker_${randomBytes(6).toString("hex")}`;
const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
let client: postgres.Sql | undefined, created = false;
beforeAll(async () => {
  ensureSchema();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${name}`); created = true; } finally { await admin.end({ timeout: 5 }); }
  client = postgres(url.toString(), { max: 2, onnotice: () => {} });
  await client.unsafe("set statement_timeout = 0");
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
}, 600_000);
afterAll(async () => {
  await client?.end({ timeout: 5 });
  if (!created) return;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

// CLI는 앱 DATABASE_URL·PG* 없이 전용 변수 하나로만 붙는다.
const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL$|READ_DATABASE_URL$)/.test(key))),
  NODE_ENV: "test", PIPELINE_CONTROL_DATABASE_URL: url.toString() };
function cli(...args: string[]) {
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/ops/pipeline-evidence-marker.ts", ...args, "--json"],
    { cwd: root, encoding: "utf8", env, timeout: 60_000 });
  return { status: run.status, stderr: run.stderr.trim(), out: run.stdout.trim() ? JSON.parse(run.stdout) as Record<string, unknown> : null };
}
/** 장부 행·이 CLI의 관리자 작업 로그·marker 행 전체(쓰기 0 확인용). */
async function state() {
  const [row] = await client!`SELECT (SELECT count(*) FROM pipeline_evidence_events)::int AS events,
    (SELECT count(*) FROM operations_audit WHERE action = 'pipeline-evidence-recorder-start')::int AS audits,
    (SELECT to_jsonb(e) FROM pipeline_evidence_events e WHERE kind = 'recorder_started') AS marker`;
  return row;
}

it("refuses without a revision or operator, and on a fenced database, writing nothing", async () => {
  expect(cli("--operator=f1-root")).toMatchObject({ status: 1, stderr: JSON.stringify({ code: "pipeline_evidence_marker_revision_required" }), out: null });
  expect(cli("--revision=abcdef1", "--operator= padded")).toMatchObject({ status: 1, stderr: JSON.stringify({ code: "pipeline_evidence_marker_operator_required" }) });
  expect(cli("--revision=abcdef1", "--operator=f1-root", `--execute=${url}`).stderr)
    .toBe(JSON.stringify({ code: "pipeline_evidence_marker_url_argument_rejected" }));
  const before = await state();
  await client!`UPDATE dr_writer_fence SET state = 'fenced', reason = 'operator_fence', fenced_db = jsonb_build_object(
    'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
    'databaseOid', (SELECT oid::text FROM pg_database WHERE datname = current_database()), 'databaseName', current_database()) WHERE id = 1`;
  try {
    expect(cli("--revision=abcdef1", "--operator=f1-root", "--execute")).toMatchObject({ status: 1,
      stderr: JSON.stringify({ code: "dr_writer_site_fenced" }), out: null });
  } finally { await client!`UPDATE dr_writer_fence SET state = 'active', reason = NULL, fenced_db = NULL WHERE id = 1`; }
  expect(await state()).toEqual(before);
}, 120_000);

it("dry-runs read-only, records the marker once with one audit row, and leaves an existing marker as it is", async () => {
  const before = await state();
  expect(before).toMatchObject({ events: 0, audits: 0, marker: null });
  const dry = cli("--revision=abcdef1", "--operator=f1-root");
  expect(dry).toMatchObject({ status: 0, out: { dryRun: true, readable: true, marker: null, revision: "abcdef1", operator: "f1-root" } });
  expect(await state()).toEqual(before);

  const first = cli("--revision=abcdef1", "--operator=f1-root", "--execute");
  expect(first.status, first.stderr).toBe(0);
  expect(first.out).toMatchObject({ dryRun: false, inserted: true, marker: { revision: "abcdef1", operator: "f1-root" } });
  const marker = (first.out as { marker: { startedAt: string } }).marker;
  const [audit] = await client!`SELECT id, actor, actor_kind, action, target, detail, ok FROM operations_audit
    WHERE action = 'pipeline-evidence-recorder-start'`;
  expect(audit).toMatchObject({ id: (first.out as { auditId: number }).auditId, actor: "f1-root", actor_kind: null, target: "pipeline_evidence_events",
    detail: { revision: "abcdef1", startedAt: marker.startedAt }, ok: true });

  // 이미 있으면 그대로 둔다: 다른 revision·운영자로 다시 실행해도 marker·시각은 처음 것이고 작업 로그도 늘지 않는다.
  const after = await state();
  const second = cli("--revision=1234567", "--operator=someone-else", "--execute");
  expect(second).toMatchObject({ status: 0, out: { dryRun: false, inserted: false, marker, auditId: null } });
  expect(await state()).toEqual(after);
  expect(after).toMatchObject({ events: 1, audits: 1 });
  expect(cli("--revision=1234567", "--operator=someone-else").out).toMatchObject({ dryRun: true, readable: true, marker });
}, 120_000);
