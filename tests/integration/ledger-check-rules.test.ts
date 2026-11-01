import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LEDGER_RULE_CHECKS, ledgerCheckDefs, ledgerCheckExpressions } from "./ledger-check-defs";
import { TEST_DATABASE_URL } from "./setup";

/*
 * 0160(2026-11-01) 실제 PostgreSQL. 이 파일이 만들고 지우는 임시 DB 하나만 쓴다.
 * 0158 까지 올린 DB 에서 (1) 여섯 CHECK 의 pg_get_expr 술어를 적어 두고 (2) 받아들여지는 행·거절되는 행(어느 제약이 거절하는지)을 기록한 뒤
 * 0160 을 적용해 (a) pg_constraint 에서 여섯 CHECK 가 사라지고 작은 CHECK 14개는 남는지, (b) model_capacity_check_rules 의 술어가 글자 그대로 같은지,
 * (c) 트리거가 각 표의 BEFORE 트리거 가운데 마지막 이름인지, (d) 같은 행들의 판정(23514·제약 이름)이 하나도 바뀌지 않는지,
 * (e) 오류 모양(code·constraint_name·table_name·schema_name·message) 이 CHECK 와 같은지, (f) rebuild 가 멱등이고 rules 행 하나로 가지가 더해지는지,
 * (g) 같은 400 문장 묶음이 더 빨라지는지 본다. 판정 비교는 손으로 만든 행 9건 — 어느 제약에 닿았는지는 결과에 기록한다.
 */
const root = fileURLToPath(new URL("../..", import.meta.url)), name = `nomorevibe_test_ledger_rules_${randomUUID().replaceAll("-", "")}`;
const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
const MOVED = [...LEDGER_RULE_CHECKS.model_capacity_requests, ...LEDGER_RULE_CHECKS.model_capacity_events];
const SMALL = ["model_capacity_requests_class_check", "model_capacity_requests_epoch_check", "model_capacity_requests_hash_check", "model_capacity_requests_identity_check",
  "model_capacity_requests_ordinal_check", "model_capacity_requests_pool_check", "model_capacity_requests_state_check", "model_capacity_requests_token_check",
  "model_capacity_events_epoch_check", "model_capacity_events_evidence_check", "model_capacity_events_hash_check", "model_capacity_events_id_check",
  "model_capacity_events_reason_check", "model_capacity_events_state_check"];
const hash = "a".repeat(64), id = "00000000-0000-4000-8000-000000000001";
const base = `INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model, provider_budget_id, group_id,
  epoch, revision, policy_hash, state, queue_until, logical_work_key, logical_member_keys, dispatch_binding, terminal_evidence, settled_at)
  VALUES ('${id}', 'probe:1', 'probe', '00000000-0000-4000-8000-000000000000', 'first', 'reviewer', 'crawl-agent-review', 'abcllm', 'bench-model', 'fixture', 'fixture',
  1, 1, '${hash}', $STATE$, clock_timestamp() + interval '1 minute', $LOGICAL$, $MEMBERS$, $BINDING$, $TERMINAL$, $SETTLED$)`;
const request = (over: Partial<Record<"STATE" | "LOGICAL" | "MEMBERS" | "BINDING" | "TERMINAL" | "SETTLED", string>>) => {
  const values = { STATE: "'waiting'", LOGICAL: "NULL", MEMBERS: "NULL", BINDING: "NULL", TERMINAL: "NULL", SETTLED: "NULL", ...over };
  return base.replace(/\$(STATE|LOGICAL|MEMBERS|BINDING|TERMINAL|SETTLED)\$/g, (_, key: keyof typeof values) => values[key]);
};
const event = (kind: string, from: string, to: string, evidence = "NULL") => `INSERT INTO model_capacity_events (request_id, kind, epoch, revision, policy_hash, from_state, to_state, evidence)
  VALUES ('${id}', '${kind}', 1, 1, '${hash}', ${from}, '${to}', ${evidence})`;
/** 판정 비교용 행 — 받아들여져야 하는 것과 여섯 CHECK 가운데 하나에 거절돼야 하는 것. */
const probes: Record<string, string[]> = {
  waiting_ok: [request({})],
  waiting_with_empty_binding: [request({ BINDING: "'{}'::jsonb" })],
  waiting_with_bogus_logical_key: [request({ LOGICAL: "'bogus'" })],
  waiting_with_member_keys_but_no_logical_key: [request({ MEMBERS: "ARRAY['a']::text[]" })],
  withdrawn_with_terminal_evidence_only: [request({ STATE: "'withdrawn'", TERMINAL: "'{}'::jsonb" })],
  queued_event_ok: [request({}), event("queued", "NULL", "waiting")],
  settled_event_with_empty_evidence: [request({}), event("dispatch_settled", "'dispatched'", "settled", "'{}'::jsonb")],
  bogus_event_kind: [request({}), event("bogus", "NULL", "waiting")],
  released_event_without_evidence: [request({}), event("dispatch_released", "'dispatched'", "withdrawn")],
};
type Verdict = "ok" | `${string}:${string}`;
let created = false, before: Record<string, Verdict> = {}, expressionsBefore: Record<string, string> = {}, defsBefore: Record<string, string> = {};
let lastError: Record<string, unknown> | null = null;

async function verdicts(): Promise<Record<string, Verdict>> {
  const result: Record<string, Verdict> = {};
  for (const [probe, statements] of Object.entries(probes)) {
    await client.unsafe("BEGIN");
    try {
      let verdict: Verdict = "ok";
      for (const statement of statements) {
        try { await client.unsafe(statement); }
        catch (error) { const e = error as { code?: string; constraint_name?: string }; verdict = `${e.code ?? "?"}:${e.constraint_name ?? "?"}`; lastError = e as Record<string, unknown>; break; }
      }
      result[probe] = verdict;
    } finally { await client.unsafe("ROLLBACK"); }
  }
  return result;
}
async function migrateThrough(limit: number) {
  const partial = mkdtempSync(path.join(tmpdir(), "ledger-rules-partial-"));
  try {
    mkdirSync(path.join(partial, "meta")); const entries = journal.entries.filter(entry => entry.idx <= limit);
    for (const entry of entries) copyFileSync(path.join(root, "drizzle", `${entry.tag}.sql`), path.join(partial, `${entry.tag}.sql`));
    writeFileSync(path.join(partial, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    await migrate(drizzle(client), { migrationsFolder: partial });
  } finally { rmSync(partial, { recursive: true, force: true }); }
}
/** 같은 세션에서 INSERT n + UPDATE n 을 한 트랜잭션으로 돌리고 되돌린다 — 문장당 ms. */
async function perStatementMs(n: number) {
  await client.unsafe("BEGIN");
  try {
    const started = performance.now();
    for (let i = 1; i <= n; i++) await client.unsafe(request({}).replace(`'${id}'`, `'00000000-0000-4000-8000-${String(i).padStart(12, "0")}'`).replace("'probe:1'", `'probe:${i}'`));
    for (let i = 1; i <= n; i++) await client.unsafe(`UPDATE model_capacity_requests SET state='withdrawn', updated_at=clock_timestamp() WHERE request_id='00000000-0000-4000-8000-${String(i).padStart(12, "0")}'`);
    return (performance.now() - started) / (2 * n);
  } finally { await client.unsafe("ROLLBACK"); }
}
const constraintNames = async () => (await client<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE contype='c'
  AND conrelid IN ('model_capacity_requests'::regclass,'model_capacity_events'::regclass) ORDER BY conname`).map(row => row.conname);
const guardSource = async (table: string) => (await client<{ src: string }[]>`SELECT prosrc src FROM pg_proc WHERE proname=${`nmv_${table}_check_guard`}`)[0]?.src;
let msBefore = 0;

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrateThrough(158);
  expect(await constraintNames()).toEqual([...MOVED, ...SMALL].sort());
  expressionsBefore = await ledgerCheckExpressions(client, MOVED); defsBefore = await ledgerCheckDefs(client, MOVED);
  before = await verdicts();
  msBefore = await perStatementMs(20);
}, 180_000);
afterAll(async () => { await client.end({ timeout: 5 }); if (created) await admin.unsafe(`DROP DATABASE ${name}`); await admin.end({ timeout: 5 }); });

it("0158 까지: 아홉 행 가운데 받아들여지는 것 두 건, 나머지는 여섯 CHECK 가운데 하나가 23514 로 거절한다", () => {
  expect(before.waiting_ok).toBe("ok"); expect(before.queued_event_ok).toBe("ok");
  const rejecting = new Set(Object.values(before).filter(verdict => verdict !== "ok").map(verdict => verdict.split(":")[1]));
  for (const constraint of rejecting) expect(MOVED, `${constraint}: one of the moved CHECKs`).toContain(constraint);
  expect(rejecting).toContain("model_capacity_requests_dispatch_check"); expect(rejecting).toContain("model_capacity_events_terminal_check");
  expect(rejecting).toContain("model_capacity_events_kind_check");
  console.info("ledger_check_rules_probes_before", before);
});

it("0160 은 여섯 CHECK 를 지우고 같은 술어를 rules 행·트리거로 두며 작은 CHECK·행·판정은 그대로다", async () => {
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  expect((await client`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)[0].n).toBe(journal.entries.length);
  expect(await constraintNames()).toEqual([...SMALL].sort());
  const rules = await client<{ table_name: string; constraint_name: string; ordinal: number; predicate: string; source: string }[]>`SELECT table_name, constraint_name, ordinal, predicate, source
    FROM model_capacity_check_rules ORDER BY table_name, constraint_name, ordinal`;
  expect(rules.map(rule => [rule.table_name, rule.constraint_name, rule.ordinal, rule.source])).toEqual([
    ...LEDGER_RULE_CHECKS.model_capacity_events.map(n => ["model_capacity_events", n, 1, "0160_ledger_check_rules"]),
    ...LEDGER_RULE_CHECKS.model_capacity_requests.map(n => ["model_capacity_requests", n, 1, "0160_ledger_check_rules"])]);
  for (const rule of rules) expect(rule.predicate, `${rule.constraint_name}: byte-identical predicate`).toBe(expressionsBefore[rule.constraint_name]);
  expect(await ledgerCheckDefs(client, MOVED)).toEqual(defsBefore);
  for (const table of ["model_capacity_requests", "model_capacity_events"] as const) {
    const triggers = (await client<{ tgname: string; def: string }[]>`SELECT tgname, pg_get_triggerdef(oid) def FROM pg_trigger WHERE tgrelid=${table}::regclass AND NOT tgisinternal ORDER BY tgname`);
    expect(triggers.at(-1)?.tgname, `${table}: the check guard fires after every other BEFORE trigger`).toBe(`${table}_zz_check_guard`);
    expect(triggers.at(-1)?.def).toContain(`BEFORE INSERT OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION nmv_${table}_check_guard()`);
    const source = await guardSource(table);
    for (const constraint of LEDGER_RULE_CHECKS[table]) expect(source).toContain(`CONSTRAINT = '${constraint}'`);
    expect((await client<{ cfg: string[] }[]>`SELECT proconfig cfg FROM pg_proc WHERE proname=${`nmv_${table}_check_guard`}`)[0].cfg).toEqual(["plan_cache_mode=force_generic_plan"]);
  }
  const after = await verdicts();
  expect(after).toEqual(before);
  console.info("ledger_check_rules_probes_after", after);
});

it("0160 뒤 거절 오류는 CHECK 와 같은 code·constraint_name·table_name·schema_name·message 를 가진다", async () => {
  await client.unsafe("BEGIN");
  try { await client.unsafe(probes.waiting_with_empty_binding[0]); throw new Error("accepted"); }
  catch (error) {
    expect(error).toMatchObject({ code: "23514", constraint_name: "model_capacity_requests_dispatch_check", table_name: "model_capacity_requests", schema_name: "public",
      message: 'new row for relation "model_capacity_requests" violates check constraint "model_capacity_requests_dispatch_check"' });
    expect((error as { detail?: string }).detail).toMatch(/^Failing row contains \(/);
  } finally { await client.unsafe("ROLLBACK"); }
  expect(lastError).toMatchObject({ code: "23514" });
});

it("rebuild 는 멱등이고, 가지는 rules 행 하나로 더해지고 지워진다 — 통째 OR 재조립이 없다", async () => {
  const source = await guardSource("model_capacity_requests");
  await client`SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests')`;
  expect(await guardSource("model_capacity_requests")).toBe(source);
  await client`INSERT INTO model_capacity_check_rules(table_name, constraint_name, ordinal, predicate, source)
    VALUES ('model_capacity_requests', 'model_capacity_requests_dispatch_check', 2, ${"dispatch_binding = '{}'::jsonb"}, 'test')`;
  await client`SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests')`;
  expect((await ledgerCheckDefs(client, ["model_capacity_requests_dispatch_check"])).model_capacity_requests_dispatch_check)
    .toBe(`CHECK ((${expressionsBefore.model_capacity_requests_dispatch_check}) OR (dispatch_binding = '{}'::jsonb))`);
  const widened = await verdicts();
  expect(widened).toEqual({ ...before, waiting_with_empty_binding: "ok" });
  await client`DELETE FROM model_capacity_check_rules WHERE source='test'`;
  await client`SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests')`;
  expect(await guardSource("model_capacity_requests")).toBe(source);
  expect(await verdicts()).toEqual(before);
  await expect(client`SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_devices')`).rejects.toMatchObject({ message: expect.stringContaining("model_capacity_check_rules_table_unknown") });
});

it("같은 INSERT 20 + UPDATE 20 묶음이 0160 뒤에 문장당 더 빠르다(첫 호출의 계획 비용 포함)", async () => {
  const msAfter = await perStatementMs(20);
  console.info("ledger_check_rules_per_statement_ms", { before: Number(msBefore.toFixed(2)), after: Number(msAfter.toFixed(2)) });
  expect(msAfter).toBeLessThan(msBefore);
});
