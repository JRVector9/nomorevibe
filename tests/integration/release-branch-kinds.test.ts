import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { modelCapacityPolicyHash, publicationClassifyMemberKeys, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { localModelBindingHash, localModelJob, localModelLogicalKey, localModelRoute, type LocalModelBinding, type LocalModelTarget } from "@/lib/llm/local-model-capacity-contract";
import { publicationClassifyReleaseLogicalSql, releaseKindsDispatchSql } from "@/lib/llm/dispatch-release-kinds-sql";
import { textLocalDirectDispatchSql, textLocalDirectEventTerminalSql, textLocalDirectTerminalSql } from "@/lib/llm/gateway-local-direct-binding-sql";
import { cliExecutorFixture } from "../fixtures/cli-executor-boundary";
import { TEST_DATABASE_URL } from "./setup";

/*
 * 0158(2026-10-31) 실제 PostgreSQL. 이 파일이 만들고 지우는 임시 DB 하나만 쓴다(공유 test DB 의 행·제어값은 건드리지 않는다).
 * 0157 까지 올린 DB 에 publisher 의 publication_classify_cli(codex-cli) dispatched 행과 gpu3090 의 local_model_direct(3a-C audit-qwen) dispatched 행을 두고,
 * 두 owner 의 dr_process_group_events(owner_opened → spawn_intent → spawned → group_exited, evaluateLocalCallEnded 의 순서)를 남긴 뒤
 * lib/operations/dr/reclaim.ts releaseEvidencedDispatches 가 process_group_exit 근거로 두 행을 withdrawn 으로 닫는지 본다.
 * 0158 전: publication_classify 행은 dispatch·logical·members CHECK 가 거절해(terminal CHECK 와 events kind CHECK 는 kind 를 보지 않는다) UPDATE 가 23514 로 깨진다
 * (2026-10-31 운영에서 publisher 컨테이너 사망 뒤 고아 행 1건을 정식 경로로 닫지 못한 바로 그 실패). local_model_direct 행은 0118 가지로 이미 통과한다.
 * 0158 뒤: 세 CHECK 는 "(0157 술어 전체) OR (가지)" 이고 나머지 CHECK 는 그대로다. 두 행이 모두 released 되고 dispatch_released 사건이 남는다.
 * 0159(PR 3b-E text local-direct 기록) 뒤: dispatch CHECK 와 두 terminal CHECK 는 "(0158 술어 전체) OR (text 가지)" 이고 logical·members·events kind 는 0158 그대로, 판정도 그대로다.
 */
const root = fileURLToPath(new URL("../..", import.meta.url)), name = `nomorevibe_test_release_kinds_${randomUUID().replaceAll("-", "")}`;
const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
const REQUESTS = ["model_capacity_requests_logical_check", "model_capacity_requests_members_check", "model_capacity_requests_dispatch_check",
  "model_capacity_requests_terminal_check"] as const;
const UNCHANGED = ["model_capacity_requests_terminal_check", "model_capacity_events_kind_check", "model_capacity_events_terminal_check"] as const;
const WIDENED: Record<string, string> = { model_capacity_requests_logical_check: publicationClassifyReleaseLogicalSql,
  model_capacity_requests_members_check: publicationClassifyReleaseLogicalSql, model_capacity_requests_dispatch_check: releaseKindsDispatchSql };
// 운영과 같은 모양: publisher(codex-cli budget) 의 분류 호출과 gpu3090 직접 호출(3a-C 뒤 audit-qwen 잡)
const fx = cliExecutorFixture(), publication = fx.binding, publisher = fx.plan.request.owner;
const gpu = { instanceId: "gpu3090-audit-qwen", bootId: randomUUID() }, deadPid = 2_000_000_000; // PID_MAX_LIMIT(4194304) 밖 — kill(-pid,0) 은 ESRCH
const target: LocalModelTarget = { kind: "audit", purpose: "audit", itemId: 4242, slug: "release-kinds-audit" };
const local: LocalModelBinding = { kind: "local_model_direct", version: 1, target, logicalWorkKey: localModelLogicalKey(target), routeId: localModelRoute(target),
  provider: "local-direct", model: "qwen3-30b", backendId: "gpu3090", physicalGroup: "gpu3090-engine", deploymentRevision: "fixture-deployment",
  inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64), reviewPolicyHash: "c".repeat(64), promptVersion: "fixture-prompt",
  wireHash: "d".repeat(64), servingContractHash: "e".repeat(64), totalTokenBound: 8192, chargedTokens: 8192,
  job: { name: localModelJob(target), token: randomUUID(), requestedVersion: 1 } };
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { "codex-cli": 2, gpu3090: 2 }, groupLimits: { "fixture-cli-group": 2, "gpu3090-engine": 2 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 4, second: 2, background: 1 }, maxWaiting: 20, queueTtlMs: 120000, reservationTtlMs: 30000,
  routes: [{ routeId: "crawl-publish-classify", provider: publication.provider, model: publication.model, providerBudgetId: "codex-cli", groupId: "fixture-cli-group" },
    { routeId: local.routeId, provider: "local-direct", model: local.model, providerBudgetId: "gpu3090", groupId: "gpu3090-engine" }] };
const rows = { publication: fx.plan.request.requestId, local: randomUUID() };
const clientBound = (budget: string) => new Map([[budget, { termination: "client_bound" as const, hardDeadlineMs: null, skewBoundMs: 1000, reference: "test" }]]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let created = false, before: Record<string, string> = {}, exitedAt = 0;
const row = async (id: string) => (await client`SELECT state, dispatch_binding, dispatch_binding_hash, settled_at, terminal_evidence, terminal_evidence_hash
  FROM model_capacity_requests WHERE request_id=${id}::uuid`)[0];
const defs = async () => Object.fromEntries((await client<{ conname: string; def: string }[]>`SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint
  WHERE conname=ANY(${[...REQUESTS, ...UNCHANGED]}::text[])`).map(item => [item.conname, item.def]));
/** journal 을 주어진 항목까지만 잘라 그 지점까지 올린다(drizzle 은 마지막 created_at 뒤의 항목만 이어서 적용한다). */
async function migrateThrough(entries: { idx: number; tag: string }[]) {
  const partial = mkdtempSync(path.join(tmpdir(), "release-kinds-predecessor-"));
  try {
    mkdirSync(path.join(partial, "meta"));
    for (const entry of entries) copyFileSync(path.join(root, "drizzle", `${entry.tag}.sql`), path.join(partial, `${entry.tag}.sql`));
    writeFileSync(path.join(partial, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    await migrate(drizzle(client), { migrationsFolder: partial });
  } finally { rmSync(partial, { recursive: true, force: true }); }
}
const reclaim = () => import("@/lib/operations/dr/reclaim");
/** 가상의 withdrawn 행(process_group_exit 근거)에 대해 네 요청 CHECK 술어를 각각 평가한다 — PostgreSQL 은 첫 위반만 알려 준다. */
async function judge(id: string, owner: { instanceId: string; bootId: string }, runId: string) {
  const [{ hash, at }] = await client<{ hash: string; at: string }[]>`SELECT dispatch_binding_hash hash,
    to_char(dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at FROM model_capacity_requests WHERE request_id=${id}::uuid`;
  const stamp = new Date(exitedAt + 1000).toISOString();
  const evidence = { version: 1, kind: "process_group_exit", requestId: id, owner, fromState: "dispatched", dispatchAt: at, bindingHash: hash, notBefore: stamp, evaluatedAt: stamp,
    operator: "test", termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 1000, reference: "test", exits: [{ seq: 1, runId, pid: deadPid, exitedAt: new Date(exitedAt).toISOString() }] };
  const columns = (await client<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name='model_capacity_requests' ORDER BY ordinal_position`)
    .map(item => item.column_name).filter(column => !["state", "terminal_evidence", "terminal_evidence_hash"].includes(column));
  const current = await defs(), verdict: Record<string, boolean> = {};
  for (const name of REQUESTS) {
    const [{ ok }] = await client.unsafe<{ ok: boolean }[]>(`SELECT coalesce((${current[name].slice("CHECK ".length)}),false) ok FROM (SELECT ${columns.join(",")},
      'withdrawn'::varchar(13) state, $1::jsonb terminal_evidence, $2::varchar(64) terminal_evidence_hash FROM model_capacity_requests WHERE request_id=$3::uuid) model_capacity_requests`,
      [JSON.stringify(evidence), "f".repeat(64), id]);
    verdict[name] = ok;
  }
  return verdict;
}
async function dispatchedRow(id: string, owner: { instanceId: string; bootId: string }, binding: typeof publication | typeof local, bindingHash: string,
  budget: string, group: string, members: string[] | null) {
  await client`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,provider_budget_id,group_id,
      epoch,revision,policy_hash,state,logical_work_key,logical_member_keys,dispatch_binding,dispatch_binding_hash,dispatched_at,token,reserved_until,queue_until)
    VALUES(${id},${`${binding.logicalWorkKey}:${binding.inputHash}`},${owner.instanceId},${owner.bootId},'background','reviewer',${binding.routeId},${binding.provider},${binding.model},
      ${budget},${group},1,1,${modelCapacityPolicyHash(policy)},'dispatched',${binding.logicalWorkKey},${members}::text[],${JSON.stringify(binding)}::jsonb,${bindingHash},
      clock_timestamp(),${randomUUID()},clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 minute')`;
}
const tickets: Record<"publisher" | "gpu", { seq: number; runId: string }> = {} as never;

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  const entries = journal.entries.filter(entry => entry.idx <= 157);
  expect(entries.at(-1)!.tag).toBe("0157_ai1_provider_enum");
  await migrateThrough(entries);
  const g = globalThis as { db?: unknown; pgClient?: unknown }; g.db = drizzle(client, { schema }); g.pgClient = client;
  await client`UPDATE model_capacity_control SET mode='open',epoch=1,revision=1,policy=${JSON.stringify(policy)}::jsonb,policy_hash=${modelCapacityPolicyHash(policy)} WHERE id=1`;
  // 운영 supervisor 와 같은 순서: owner_opened → spawn_intent → spawned 뒤에 그 child 가 행을 dispatch 하고, child 그룹이 사라진 뒤 group_exited.
  const { processGroupRecorder } = await import("@/lib/operations/dr/repository");
  const recorders = { publisher: processGroupRecorder(publisher), gpu: processGroupRecorder(gpu) };
  for (const key of ["publisher", "gpu"] as const) { tickets[key] = await recorders[key].intent(); await recorders[key].spawned(tickets[key], deadPid); }
  await sleep(25);
  await dispatchedRow(rows.publication, publisher, publication, fx.plan.request.bindingHash, "codex-cli", "fixture-cli-group", publicationClassifyMemberKeys(publication.members));
  await dispatchedRow(rows.local, gpu, local, localModelBindingHash(local), "gpu3090", "gpu3090-engine", null);
  await sleep(25);
  for (const key of ["publisher", "gpu"] as const) await recorders[key].exited(tickets[key], deadPid);
  exitedAt = Date.now();
  before = await defs();
}, 120_000);
afterAll(async () => { await client.end({ timeout: 5 }); if (created) await admin.unsafe(`DROP DATABASE ${name}`); await admin.end({ timeout: 5 }); });

it("0157 까지: publication_classify_cli 행은 process_group_exit 회수 UPDATE 가 dispatch CHECK(그리고 logical·members)에 막히고, local_model_direct 는 통과한다", async () => {
  expect(await judge(rows.publication, publisher, tickets.publisher.runId)).toEqual({ model_capacity_requests_logical_check: false, model_capacity_requests_members_check: false,
    model_capacity_requests_dispatch_check: false, model_capacity_requests_terminal_check: true });
  expect(await judge(rows.local, gpu, tickets.gpu.runId)).toEqual({ model_capacity_requests_logical_check: true, model_capacity_requests_members_check: true,
    model_capacity_requests_dispatch_check: true, model_capacity_requests_terminal_check: true });
  await sleep(Math.max(0, exitedAt + 1100 - Date.now()));
  const { releaseEvidencedDispatches } = await reclaim();
  // 운영 2026-10-31 과 같은 실패: 근거는 충분하지만(판정 reclaimable) 장부 UPDATE 가 23514 로 깨지고 TX 전체가 되돌아간다.
  const failure = await releaseEvidencedDispatches({ policies: clientBound("codex-cli"), operator: "test" }, true)
    .then(() => null, (error: unknown) => (error as { cause?: unknown }).cause ?? error);
  expect(failure).toMatchObject({ code: "23514", constraint_name: "model_capacity_requests_dispatch_check", table_name: "model_capacity_requests" });
  expect(await row(rows.publication)).toMatchObject({ state: "dispatched", terminal_evidence: null });
  expect((await client`SELECT count(*)::int n FROM model_capacity_events WHERE kind='dispatch_released'`)[0].n).toBe(0);
});

it("0158 은 세 요청 CHECK 를 '(0157 술어 전체) OR (가지)' 로 다시 만들고 나머지 CHECK·행·해시는 그대로 둔다", async () => {
  const snapshot = await client`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY request_id`;
  // 0158 alone first (journal truncated after it, as beforeAll did at 0157); 0159 follows at the end of this test.
  const through0158 = journal.entries.filter(entry => entry.idx <= 158);
  expect(through0158.at(-1)).toMatchObject({ idx: 158, tag: "0158_release_branch_kinds" });
  await migrateThrough(through0158);
  expect((await client`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)[0].n).toBe(through0158.length);
  const after = await defs();
  for (const name of UNCHANGED) expect(after[name], `${name}: 0158 unchanged`).toBe(before[name]);
  for (const [name, branch] of Object.entries(WIDENED)) {
    await client.unsafe(`ALTER TABLE model_capacity_requests ADD CONSTRAINT release_kinds_expected CHECK ((${before[name].slice("CHECK ".length)}) OR (${branch}))`);
    try { expect(after[name], `${name}: 0157 predicate plus the 0158 branch`).toBe((await client`SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='release_kinds_expected'`)[0].def); }
    finally { await client.unsafe(`ALTER TABLE model_capacity_requests DROP CONSTRAINT release_kinds_expected`); }
    expect(before[name]).not.toContain("'publication_classify_cli'::text, 'local_model_direct'::text");
  }
  expect(after.model_capacity_requests_dispatch_check).toContain("'publication_classify_cli'::text, 'local_model_direct'::text");
  expect(await client`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY request_id`).toEqual(snapshot);
  const sql = readFileSync(path.join(root, "drizzle/0158_release_branch_kinds.sql"), "utf8");
  expect(sql).not.toMatch(/\b(?:CREATE|REPLACE)\s+(?:OR\s+REPLACE\s+)?FUNCTION\b|\b(?:CREATE|DROP|ALTER)\s+(?:TRIGGER|INDEX|COLUMN)\b|^\s*(?:UPDATE|INSERT|DELETE|TRUNCATE)\b/im);
  for (const [name, branch] of Object.entries(WIDENED)) {
    const statement = sql.split("--> statement-breakpoint").find(part => part.includes(`conname='${name}'`))!;
    expect(statement).toContain("substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate");
    expect(statement).toContain(`ADD CONSTRAINT ${name} CHECK ((%s) OR (%s))`);
    expect(statement).toContain(`$ai2_local$${branch}$ai2_local$`);
  }
  expect(await judge(rows.publication, publisher, tickets.publisher.runId)).toEqual(Object.fromEntries(REQUESTS.map(name => [name, true])));
  // 0159 (PR 3b-E text local-direct 기록) then rebuilds the dispatch CHECK and both terminal CHECKs the same way on the live 0158 predicate;
  // logical/members and the events kind CHECK stay as 0158 left them, rows are untouched and the release verdict is unchanged.
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  expect((await client`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`)[0].n).toBe(journal.entries.length);
  expect(journal.entries.at(-1)).toMatchObject({ idx: 159, tag: "0159_text_local_direct_binding" });
  const after0159 = await defs();
  const TEXT: Record<string, string> = { model_capacity_requests_dispatch_check: textLocalDirectDispatchSql,
    model_capacity_requests_terminal_check: textLocalDirectTerminalSql, model_capacity_events_terminal_check: textLocalDirectEventTerminalSql };
  for (const name of new Set<string>([...REQUESTS, ...UNCHANGED])) {
    const branch = TEXT[name];
    if (!branch) { expect(after0159[name], `${name}: 0159 unchanged`).toBe(after[name]); continue; }
    const table = name.startsWith("model_capacity_events_") ? "model_capacity_events" : "model_capacity_requests";
    await client.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT text_local_direct_expected CHECK ((${after[name].slice("CHECK ".length)}) OR (${branch}))`);
    try { expect(after0159[name], `${name}: 0158 predicate plus the 0159 text local-direct branches`).toBe((await client`SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='text_local_direct_expected'`)[0].def); }
    finally { await client.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT text_local_direct_expected`); }
  }
  expect(await client`SELECT to_jsonb(r) value FROM model_capacity_requests r ORDER BY request_id`).toEqual(snapshot);
  expect(await judge(rows.publication, publisher, tickets.publisher.runId)).toEqual(Object.fromEntries(REQUESTS.map(name => [name, true])));
});

it("0158 뒤 releaseEvidencedDispatches 가 publication_classify_cli 행을 process_group_exit 근거로 withdrawn 으로 닫고 dispatch_released 사건을 남긴다", async () => {
  const { releaseEvidencedDispatches } = await reclaim();
  const result = await releaseEvidencedDispatches({ policies: clientBound("codex-cli"), operator: "test" }, true);
  expect(result.rows).toEqual([{ requestId: rows.publication, released: true, reason: null }, { requestId: rows.local, released: false, reason: "provider_deadline_unknown" }]);
  const released = await row(rows.publication);
  expect(released).toMatchObject({ state: "withdrawn", settled_at: null, dispatch_binding: publication, dispatch_binding_hash: fx.plan.request.bindingHash });
  expect(released.terminal_evidence).toMatchObject({ version: 1, kind: "process_group_exit", requestId: rows.publication, owner: publisher, fromState: "dispatched",
    bindingHash: fx.plan.request.bindingHash, termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 1000, reference: "test", operator: "test",
    exits: [{ seq: tickets.publisher.seq, runId: tickets.publisher.runId, pid: deadPid }] });
  expect(released.terminal_evidence_hash).toMatch(/^[a-f0-9]{64}$/);
  const events = await client`SELECT kind, from_state, to_state, reason, evidence FROM model_capacity_events WHERE request_id=${rows.publication}::uuid AND kind='dispatch_released'`;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ from_state: "dispatched", to_state: "withdrawn", reason: null, evidence: released.terminal_evidence });
  expect(await row(rows.local)).toMatchObject({ state: "dispatched", terminal_evidence: null });
});

it("0158 뒤 local_model_direct(3a-C audit-qwen) 행도 같은 길로 닫힌다", async () => {
  const { releaseEvidencedDispatches } = await reclaim();
  const result = await releaseEvidencedDispatches({ policies: clientBound("gpu3090"), operator: "test" }, true);
  expect(result.rows).toEqual([{ requestId: rows.local, released: true, reason: null }]);
  const released = await row(rows.local);
  expect(released).toMatchObject({ state: "withdrawn", settled_at: null, dispatch_binding: local, dispatch_binding_hash: localModelBindingHash(local) });
  expect(released.terminal_evidence).toMatchObject({ kind: "process_group_exit", requestId: rows.local, owner: gpu, fromState: "dispatched",
    exits: [{ seq: tickets.gpu.seq, runId: tickets.gpu.runId, pid: deadPid }] });
  const events = await client`SELECT from_state, to_state, reason, evidence FROM model_capacity_events WHERE request_id=${rows.local}::uuid AND kind='dispatch_released'`;
  expect(events).toEqual([{ from_state: "dispatched", to_state: "withdrawn", reason: null, evidence: released.terminal_evidence }]);
  expect((await client`SELECT count(*)::int n FROM model_capacity_requests WHERE state IN ('dispatched','indeterminate')`)[0].n).toBe(0);
});
