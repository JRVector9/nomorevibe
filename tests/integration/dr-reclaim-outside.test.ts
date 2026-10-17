import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { TRANSLATE_MODEL, QUERY_PROMPT_VERSION, GLOSSARY_VERSION, glossaryHints } from "@/lib/crawl/translate";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { WebsearchQueryServingContract } from "@/lib/llm/websearch-query-serving-contract";
import { httpOriginPolicyHash } from "@/lib/net/http-origin-policy";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * PR15d 실제 PostgreSQL. 이 파일이 만들고 지우는 임시 DB 세 개만 쓴다(공유 test DB 의 행·제어값은 건드리지 않는다).
 * - ledger: 실제 자식 프로세스 그룹의 HTTP hop 회수, 살아 있는 프로세스의 게이트웨이 시간 초과 뒤 local_call_ended 회수, 전역 보고·운영 CLI.
 * - fenced: fenced DB 에서는 보고만 읽고 아무것도 풀지 않는다.
 * - step: 0096 까지 적용한 DB 에 0099 를 더해 pg_get_constraintdef 로 기존 CHECK 가 통째로 왼쪽에 남는지 본다.
 * 게이트웨이·origin 은 loopback 서버뿐이다. 실제 provider·운영 resolver 는 쓰지 않는다(계약은 이 파일의 fixture 만).
 */
const fixture = vi.hoisted(() => ({ contract: null as WebsearchQueryServingContract | null,
  owner: null as null | { instanceId: string; bootId: string; release: string } }));
vi.mock("@/lib/llm/websearch-query-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/websearch-query-serving-contract")>(), resolveWebsearchQueryServingContract: () => fixture.contract,
}));
vi.mock("@/lib/llm/websearch-process-owner", () => ({ websearchProcessOwner: () => fixture.owner }));

const root = fileURLToPath(new URL("../..", import.meta.url));
const tag = randomBytes(6).toString("hex"), prefix = `pr15d-${tag}`;
const names = { ledger: `nomorevibe_test_pr15d_l_${tag}`, fenced: `nomorevibe_test_pr15d_f_${tag}`, step: `nomorevibe_test_pr15d_s_${tag}` } as const;
type Side = keyof typeof names;
const urlOf = (side: Side) => { const value = new URL(TEST_DATABASE_URL); value.pathname = `/${names[side]}`; return value.toString(); };
const created: Side[] = [], pools = new Map<Side, postgres.Sql>(), children = new Set<ChildProcess>();
const pool = (side: Side) => { let client = pools.get(side); if (!client) { client = postgres(urlOf(side), { max: 4, prepare: false, onnotice: () => {} }); pools.set(side, client); } return client; };
function use(side: Side) { const g = globalThis as { db?: unknown; pgClient?: unknown }; g.pgClient = pool(side); g.db = drizzle(pool(side), { schema }); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const operator = "pr15d-root-driver", reference = "fixture: loopback gateway closes with the client";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 8, providerLimits: { account: 1, solo: 2 }, groupLimits: { engine: 8 },
  poolLimits: { reviewer: 8, text: 8 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 600_000, reservationTtlMs: 600_000,
  routes: [{ routeId: "search-query-translate", provider: "abcllm", model: TRANSLATE_MODEL, providerBudgetId: "account", groupId: "engine" },
    { routeId: "pr15d-route", provider: "fixture", model: "m", providerBudgetId: "solo", groupId: "engine" }] };
const clientBound = (budget: string, skewBoundMs = 1) => new Map([[budget, { termination: "client_bound" as const, hardDeadlineMs: null, skewBoundMs, reference }]]);
const servers: Server[] = [];
let gatewayReply: (response: ServerResponse) => void = () => {};
const held = new Set<ServerResponse>();
async function serve(handler: (response: ServerResponse) => void): Promise<string> {
  const server = createServer((request, response) => { request.resume(); request.on("end", () => handler(response)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function hold(response: ServerResponse) { held.add(response); response.writeHead(200, { "content-type": "text/plain" }); response.write("open"); }
function envelope(content: string) {
  return { id: "pr15d", object: "chat.completion", created: 1, model: "served-query",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 60, completion_tokens: 9, total_tokens: 69 }, usage_provenance: "upstream_reported" };
}
function cli(args: string[], side: Side): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/ops/dr/promotion.ts", ...args], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(`${urlOf(side)}\n`);
  });
}
const repo = () => import("@/lib/operations/dr/repository");
async function killGroup(pid: number) {
  const { processGroupGone } = await repo();
  if (!processGroupGone(pid)) process.kill(-pid, "SIGKILL");
  for (let attempt = 0; attempt < 100 && !processGroupGone(pid); attempt++) await sleep(50);
  expect(processGroupGone(pid)).toBe(true);
}
async function constraintDefs(side: Side, names: readonly string[]) {
  return Object.fromEntries(Array.from(await pool(side)<{ name: string; def: string }[]>`SELECT conname AS name, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conname = ANY(${names as string[]}::text[])`).map(row => [row.name, row.def]));
}
const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
const LEFT = ["model_capacity_requests_dispatch_check", "model_capacity_requests_terminal_check", "model_capacity_events_kind_check"] as const;
const UNTOUCHED = ["model_capacity_requests_logical_check", "model_capacity_requests_members_check", "model_capacity_events_terminal_check",
  "http_origin_events_kind_check", "http_origin_hops_state_check"] as const;
let before0099: Record<string, string> = {};

beforeAll(async () => {
  ensureSchema();
  expect(journal.entries.map(entry => entry.tag)).toContain("0099_dispatch_local_end_hop_reclaim");
  const shared = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const [applied] = await shared<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(journal.entries.length);
    for (const side of ["ledger", "fenced", "step"] as const) { await shared.unsafe(`CREATE DATABASE ${names[side]}`); created.push(side); }
  } finally { await shared.end({ timeout: 5 }); }
  // step: 0096 까지만 담은 migrations 사본으로 먼저 올린 뒤 원래 폴더로 0099 를 더한다.
  const partial = mkdtempSync(path.join(tmpdir(), "pr15d-migrations-"));
  try {
    mkdirSync(path.join(partial, "meta"));
    const upTo = journal.entries.filter(entry => entry.idx <= 96);
    expect(upTo.at(-1)!.tag).toBe("0096_model_capacity_dispatch_release");
    for (const entry of upTo) copyFileSync(path.join(root, "drizzle", `${entry.tag}.sql`), path.join(partial, `${entry.tag}.sql`));
    writeFileSync(path.join(partial, "meta/_journal.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")), entries: upTo }));
    const client = postgres(urlOf("step"), { max: 1, onnotice: () => {} });
    try { await client.unsafe("set statement_timeout = 0"); await migrate(drizzle(client), { migrationsFolder: partial }); }
    finally { await client.end({ timeout: 5 }); }
  } finally { rmSync(partial, { recursive: true, force: true }); }
  before0099 = await constraintDefs("step", [...LEFT, ...UNTOUCHED]);
  // step 은 0099 직후 상태로 비교한다(journal 은 tag 로 찾는다). 뒤 migration 이 같은 CHECK 를 whole-left 로 넓혀도
  // "0099 은 지정한 CHECK 외에는 건드리지 않는다"는 이 테스트의 의도는 그대로다.
  const through = journal.entries.slice(0, journal.entries.findIndex(entry => entry.tag === "0099_dispatch_local_end_hop_reclaim") + 1);
  expect(through.at(-1)?.tag).toBe("0099_dispatch_local_end_hop_reclaim");
  for (const side of ["ledger", "fenced", "step"] as const) {
    const entries = side === "step" ? through : journal.entries;
    const folder = side === "step" ? mkdtempSync(path.join(tmpdir(), "0099-through-")) : path.join(root, "drizzle");
    try {
      if (side === "step") {
        mkdirSync(path.join(folder, "meta"));
        for (const entry of through) copyFileSync(path.join(root, "drizzle", `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
        writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")), entries: through }));
      }
      const client = postgres(urlOf(side), { max: 1, onnotice: () => {} });
      try { await client.unsafe("set statement_timeout = 0"); await migrate(drizzle(client), { migrationsFolder: folder }); }
      finally { await client.end({ timeout: 5 }); }
    } finally { if (side === "step") rmSync(folder, { recursive: true, force: true }); }
    const [applied] = await pool(side)<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(entries.length);
  }
  const gateway = await serve(response => gatewayReply(response));
  fixture.contract = { version: 1, protocol: "abcllm-websearch-query-total-bound-v1", routeId: "search-query-translate", provider: "abcllm", model: TRANSLATE_MODEL,
    responseModel: "served-query", endpoint: `${gateway}/v1/chat/completions`, deploymentRevision: "local-only", totalTokenBound: 4096 };
  fixture.owner = { instanceId: `${prefix}-web`, bootId: randomUUID(), release: "pr15d-fixture" };
  vi.stubEnv("ABCLLM_API_KEY", "local-test-only");
  for (const side of ["ledger", "fenced"] as const)
    await pool(side)`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(policy)}::text::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)} WHERE id = 1`;
  console.info("pr15d_migrations", { journal: journal.entries.length });
}, 600_000);

afterAll(async () => {
  for (const child of children) if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* 이미 끝남 */ }
  for (const response of held) response.destroy();
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  fixture.contract = null; vi.unstubAllEnvs();
  for (const client of pools.values()) await client.end({ timeout: 5 });
  const g = globalThis as { db?: unknown; pgClient?: unknown }; delete g.db; delete g.pgClient;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { for (const side of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${names[side]} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

it("0099: every earlier CHECK predicate stays whole on the left (pg_get_constraintdef), only new branches are added", async () => {
  const after = await constraintDefs("step", [...LEFT, ...UNTOUCHED, "http_origin_events_evidence_check"]);
  const inner = (def: string) => { expect(def.startsWith("CHECK (")).toBe(true); return def.slice("CHECK (".length, -1); };
  for (const name of LEFT) {
    const left = inner(before0099[name]), combined = inner(after[name]);
    // 0099 문장은 '(' + 0096 본문 + ') OR (' + 새 분기 + ')' 이다. PG 는 OR 사슬을 하나로 펴서 deparse 하므로, 옛 술어의 모든 disjunct 가
    // 같은 순서·같은 글자로 앞에 남고(마지막 닫는 괄호만 뒤로 밀림) 새 분기는 그 뒤에만 붙는다.
    expect(combined.length).toBeGreaterThan(left.length);
    expect(combined.startsWith(`${left.slice(0, -1)} OR `)).toBe(true);
    expect(combined).toContain("local_call_ended");
  }
  for (const name of UNTOUCHED) expect(after[name]).toBe(before0099[name]);
  expect(after.http_origin_events_evidence_check).toContain("process_group_exit");
  const indexes = Array.from(await pool("step")<{ name: string; def: string }[]>`SELECT indexname AS name, indexdef AS def FROM pg_indexes
    WHERE indexname IN ('model_capacity_events_local_end_idx','http_origin_events_reclaimed_idx') ORDER BY indexname`);
  expect(indexes.map(row => row.name)).toEqual(["http_origin_events_reclaimed_idx", "model_capacity_events_local_end_idx"]);
  expect(indexes[0].def).toContain("WHERE (evidence IS NOT NULL)");
  expect(indexes[1].def).toContain("WHERE ((kind)::text = 'dispatch_local_ended'::text)");
});

it("HTTP hop: a crashed child's dispatched hop is released only after its recorded process group is gone; a hop without proof stays listed", async () => {
  use("ledger");
  const l = pool("ledger"), { processGroupRecorder } = await repo(), { releaseProcessExitedHops, readReclaimReport } = await import("@/lib/operations/dr/reclaim");
  const instanceId = `${prefix}-m3`, owner = { instanceId, bootId: randomUUID() };
  const httpPolicy = { version: 1 as const, instanceHosts: { [instanceId]: "m3" as const } };
  await l`UPDATE http_origin_control SET mode = 'open', policy = ${JSON.stringify(httpPolicy)}::text::jsonb, policy_hash = ${httpOriginPolicyHash(httpPolicy)} WHERE id = 1`;
  const childOrigin = await serve(hold), parentOrigin = await serve(hold);
  const recorder = processGroupRecorder(owner), ticket = await recorder.intent();
  const child = spawn(process.execPath, ["--import", "tsx", "tests/integration/fixtures/dr-reclaim-hop-child.ts"], { cwd: root, detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, DATABASE_URL: urlOf("ledger"), SERVICE_INSTANCE_ID: instanceId, ALLOW_PRIVATE_URLS: "1",
      DR_RECLAIM_HOP_URL: `${childOrigin}/held`, PROCESS_GROUP_OWNER_INSTANCE_ID: owner.instanceId, PROCESS_GROUP_OWNER_BOOT_ID: owner.bootId } });
  children.add(child); child.stdout!.resume(); child.stderr!.resume();
  await recorder.spawned(ticket, child.pid!);
  const message = await new Promise<{ kind: string; status?: number; message?: string }>(resolve => child.once("message", value => resolve(value as never)));
  expect(message).toEqual({ kind: "headers", status: 200 });
  // 같은 DB 를 쓰지만 기록기 env 가 없는 이 테스트 프로세스의 hop — 근거가 없다.
  process.env.SERVICE_INSTANCE_ID = instanceId;
  try {
    const { requestOriginHop } = await import("@/lib/net/origin-permits");
    const parentHop = await requestOriginHop(`${parentOrigin}/held`, { redirect: "manual", signal: new AbortController().signal, headers: {} });
    expect(parentHop.status).toBe(200);
    const hops = Array.from(await l<{ id: string; boot_id: string; origin: string; state: string }[]>`SELECT id::text, boot_id::text, origin, state FROM http_origin_hops ORDER BY created_at`);
    expect(hops.map(hop => [hop.origin, hop.state])).toEqual([[childOrigin, "dispatched"], [parentOrigin, "dispatched"]]);
    expect(hops[0].boot_id).toBe(owner.bootId); expect(hops[1].boot_id).not.toBe(owner.bootId);
    const [childHop, parentHop2] = hops;
    // 그룹이 살아 있으면 회수하지 않는다. 시간(TTL)은 근거가 아니다.
    expect((await releaseProcessExitedHops({ skewBoundMs: 1, reference, operator }, true)).rows).toEqual([
      { hopId: childHop.id, released: false, reason: "spawn_not_exited:1" }, { hopId: parentHop2.id, released: false, reason: "owner_not_opened_before_dispatch" }]);
    await expect(recorder.exited(ticket, child.pid!)).rejects.toThrow("dr_process_group_alive");
    await killGroup(child.pid!); children.delete(child);
    await recorder.exited(ticket, child.pid!);
    await sleep(20);
    const report = await readReclaimReport(new Map(), 1);
    expect(report.http).toMatchObject({ reclaimable: 1, waiting: 0, unproven: 1 });
    // dry-run 은 같은 TX 를 실행한 뒤 ROLLBACK 한다.
    expect((await releaseProcessExitedHops({ skewBoundMs: 1, reference, operator }, false)).rows[0]).toEqual({ hopId: childHop.id, released: true, reason: null });
    expect((await l`SELECT state FROM http_origin_hops WHERE id = ${childHop.id}::uuid`)[0].state).toBe("dispatched");
    expect((await releaseProcessExitedHops({ skewBoundMs: 1, reference, operator }, true)).rows).toEqual([
      { hopId: childHop.id, released: true, reason: null }, { hopId: parentHop2.id, released: false, reason: "owner_not_opened_before_dispatch" }]);
    const [released] = await l`SELECT state, settled_at IS NOT NULL AS settled FROM http_origin_hops WHERE id = ${childHop.id}::uuid`;
    expect(released).toEqual({ state: "released", settled: true });
    const [evidence] = await l`SELECT kind, evidence FROM http_origin_events WHERE hop_id = ${childHop.id}::uuid AND evidence IS NOT NULL`;
    expect(evidence).toMatchObject({ kind: "released", evidence: { kind: "process_group_exit", hopId: childHop.id, owner, fromState: "dispatched",
      termination: "client_bound", skewBoundMs: 1, reference, exits: [{ seq: 1, runId: ticket.runId, pid: child.pid }], operator } });
    // 근거 행은 append-only·hop 당 하나다. 근거 모양이 틀리면 DB 가 거절한다.
    await expect(l`UPDATE http_origin_events SET evidence = NULL WHERE hop_id = ${childHop.id}::uuid`).rejects.toMatchObject({ code: "55000" });
    await expect(l`INSERT INTO http_origin_events (hop_id, kind, evidence) VALUES (${childHop.id}::uuid, 'released', ${JSON.stringify(evidence.evidence)}::text::jsonb)`)
      .rejects.toMatchObject({ code: "23505" });
    await expect(l`INSERT INTO http_origin_events (hop_id, kind, evidence) VALUES (${parentHop2.id}::uuid, 'released', '{"version":1,"kind":"ttl_expired"}'::jsonb)`)
      .rejects.toMatchObject({ code: "23514" });
    await expect(l`INSERT INTO http_origin_events (hop_id, kind, evidence) VALUES (${parentHop2.id}::uuid, 'dispatched', ${JSON.stringify({ ...evidence.evidence, hopId: parentHop2.id })}::text::jsonb)`)
      .rejects.toMatchObject({ code: "23514" });
    // 풀린 origin 은 실제로 다음 hop 을 받는다. 근거 없는 hop 의 origin 은 여전히 막혀 있다.
    const next = await requestOriginHop(`${childOrigin}/next`, { redirect: "manual", signal: AbortSignal.timeout(5_000), headers: {} });
    expect(next.status).toBe(200); await next.body?.cancel();
    await expect(requestOriginHop(`${parentOrigin}/next`, { redirect: "manual", signal: AbortSignal.timeout(400), headers: {} })).rejects.toThrow("http_origin_permit_waiting_aborted");
    expect((await releaseProcessExitedHops({ skewBoundMs: 1, reference, operator }, true)).rows).toEqual([
      { hopId: parentHop2.id, released: false, reason: "owner_not_opened_before_dispatch" }]);
    await parentHop.body?.cancel();
  } finally { delete process.env.SERVICE_INSTANCE_ID; }
}, 120_000);

it("local_call_ended: a live process whose gateway call timed out records its own end; release follows the provider policy and keeps C", async () => {
  use("ledger");
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", "1");
  const l = pool("ledger"), ledger = await import("@/lib/llm/capacity-repository"), gateway = await import("@/lib/crawl/agent-review-gateway");
  const { translateQueryWithModelCapacity } = await import("@/lib/domain/products/search-query-model-capacity");
  const { prepareWebsearchQueryDispatch } = await import("@/lib/domain/products/search-query-capacity-repository");
  const searchTranslation = await import("@/lib/domain/products/search-translation");
  const { releaseEvidencedDispatches, readReclaimReport } = await import("@/lib/operations/dr/reclaim");
  const target = (query: string) => ({ query, sourceLocale: "ko" as const, cacheKey: searchTranslation.queryTranslationKey(query), promptVersion: QUERY_PROMPT_VERSION,
    glossaryVersion: glossaryHints(searchTranslation.normalizeQuery(query)) ? GLOSSARY_VERSION : null });
  const rowOf = async (cacheKey: string) => (await l`SELECT to_jsonb(r) AS row FROM model_capacity_requests r
    WHERE logical_member_keys && ARRAY[${`websearch-query:${cacheKey}`}]::text[] ORDER BY queue_ordinal DESC LIMIT 1`)[0].row;
  const kinds = async (id: string) => Array.from(await l`SELECT kind FROM model_capacity_events WHERE request_id = ${id}::uuid ORDER BY id`).map(row => row.kind);
  gatewayReply = () => {}; // 게이트웨이가 답하지 않는다 — 살아 있는 웹 프로세스의 시간 제한이 요청 소켓을 끊는다.
  const first = target("회의록 요약 도구 복제본");
  expect(await translateQueryWithModelCapacity(first, 300)).toMatchObject({ kind: "result", result: { ok: false } });
  const row = await rowOf(first.cacheKey);
  expect(row).toMatchObject({ state: "indeterminate", owner_instance_id: fixture.owner!.instanceId, terminal_evidence: null, settled_at: null });
  expect(await kinds(row.request_id)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_indeterminate", "dispatch_local_ended"]);
  const [fact] = await l`SELECT from_state, to_state, reason, evidence FROM model_capacity_events WHERE request_id = ${row.request_id}::uuid AND kind = 'dispatch_local_ended'`;
  expect(fact).toEqual({ from_state: "indeterminate", to_state: "indeterminate", reason: null, evidence: { version: 1, kind: "gateway_local_end",
    requestId: row.request_id, owner: { instanceId: row.owner_instance_id, bootId: row.owner_boot_id }, bindingHash: row.dispatch_binding_hash, dispatches: 1, terminals: 1 } });
  // 한도 1: 로컬 종료만으로는 점유가 그대로다(정책 판정 전).
  await expect(translateQueryWithModelCapacity(target("강아지 산책 기록"), 300)).rejects.toMatchObject({ reason: "capacity" });
  // 정책이 없으면 provider_bound 로 보고 증명된 기한 없이는 풀지 않는다. 기한이 있으면 그만큼 기다린다.
  expect((await readReclaimReport(new Map(), 1)).model.rows.find(item => item.requestId === row.request_id))
    .toMatchObject({ status: "policy_blocked", evidence: "local_call_ended", reason: "provider_deadline_unknown" });
  expect((await releaseEvidencedDispatches({ policies: new Map(), operator }, true)).rows.find(item => item.requestId === row.request_id))
    .toEqual({ requestId: row.request_id, released: false, reason: "provider_deadline_unknown" });
  expect((await releaseEvidencedDispatches({ policies: new Map([["account", { termination: "provider_bound" as const, hardDeadlineMs: 600_000,
    skewBoundMs: 1, reference }]]), operator }, true)).rows.find(item => item.requestId === row.request_id))
    .toEqual({ requestId: row.request_id, released: false, reason: "waiting" });
  // 직접 SQL 로 다른 owner 의 근거를 붙이거나 근거 없이 풀 수는 없다.
  const forged = { version: 1, kind: "local_call_ended", requestId: row.request_id, owner: { instanceId: "someone-else", bootId: randomUUID() },
    fromState: "indeterminate", dispatchAt: "2026-10-17T00:00:00.000Z", bindingHash: row.dispatch_binding_hash, termination: "client_bound", hardDeadlineMs: null,
    skewBoundMs: 1, reference, endedAt: "2026-10-17T00:00:01.000Z", localEnd: { dispatches: 1, terminals: 1 }, notBefore: "2026-10-17T00:00:01.001Z",
    evaluatedAt: "2026-10-17T00:00:02.000Z", operator };
  await expect(l`UPDATE model_capacity_requests SET state = 'withdrawn', terminal_evidence = ${JSON.stringify(forged)}::text::jsonb, terminal_evidence_hash = ${"a".repeat(64)}
    WHERE request_id = ${row.request_id}::uuid`).rejects.toMatchObject({ code: "23514" });
  await expect(l`UPDATE model_capacity_requests SET state = 'withdrawn' WHERE request_id = ${row.request_id}::uuid`).rejects.toMatchObject({ code: "23514" });
  const released = await releaseEvidencedDispatches({ policies: clientBound("account"), operator }, true);
  expect(released.rows.find(item => item.requestId === row.request_id)).toEqual({ requestId: row.request_id, released: true, reason: null });
  const after = await rowOf(first.cacheKey);
  // 과금은 C 그대로: dispatch binding(chargedTokens = totalTokenBound)은 바뀌지 않고 settled 도 사용량 증거도 없다.
  expect(after).toMatchObject({ state: "withdrawn", settled_at: null, dispatch_binding: row.dispatch_binding, dispatch_binding_hash: row.dispatch_binding_hash,
    terminal_evidence: { kind: "local_call_ended", requestId: row.request_id, owner: { instanceId: row.owner_instance_id, bootId: row.owner_boot_id },
      fromState: "indeterminate", termination: "client_bound", hardDeadlineMs: null, localEnd: { dispatches: 1, terminals: 1 }, operator, reference } });
  expect(after.dispatch_binding.chargedTokens).toBe(4096); expect(after.dispatch_binding.totalTokenBound).toBe(4096);
  expect(after.terminal_evidence.endedAt <= after.terminal_evidence.notBefore).toBe(true);
  expect(await kinds(row.request_id)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_indeterminate", "dispatch_local_ended", "dispatch_released"]);
  await expect(l`INSERT INTO model_capacity_events (request_id, kind, epoch, revision, policy_hash, from_state, to_state, evidence)
    SELECT request_id, kind, epoch, revision, policy_hash, from_state, to_state, evidence FROM model_capacity_events
    WHERE request_id = ${row.request_id}::uuid AND kind = 'dispatch_local_ended'`).rejects.toMatchObject({ code: "23505" });
  // 풀린 자리로 대기열 머리(앞서 미뤄진 같은 owner 의 요청)가 실제로 나간다.
  gatewayReply = response => response.end(JSON.stringify(envelope("dog walk log | walking tracker")));
  expect(await translateQueryWithModelCapacity(target("강아지 산책 기록"), 5_000)).toMatchObject({ kind: "result", result: { ok: true } });

  // 소유자가 아닌 handle 은 같은 프로세스에 증인이 있어도 사실을 남기지 못한다. 소유자의 handle 만 남긴다.
  gatewayReply = () => {};
  const second = target("가족 일정 공유"), owner = fixture.owner!;
  const call = gateway.prepareWebsearchQueryGatewayCall({ sourceLocale: "ko", query: second.query }, { model: TRANSLATE_MODEL, timeoutMs: 300 });
  if (call.kind !== "prepared") throw new Error("fixture_contract_required");
  const initial = await prepareWebsearchQueryDispatch(second, { owner, call });
  if (initial.kind !== "ready" || !("input" in initial)) throw new Error(`fixture_initial_${initial.kind}`);
  const { websearchQueryLogicalWorkKey, websearchQueryInputHash } = await import("@/lib/llm/capacity");
  const identity = { owner: { instanceId: owner.instanceId, bootId: owner.bootId }, class: "background" as const, pool: "text" as const,
    routeId: "search-query-translate", provider: "abcllm", model: TRANSLATE_MODEL,
    workKey: `${websearchQueryLogicalWorkKey(initial.input.member)}:${websearchQueryInputHash(initial.input)}` };
  const slot = await ledger.requestWebsearchQueryModelSlot({ ...identity, requestId: randomUUID() }, initial.input);
  if (slot.kind !== "granted") throw new Error(`fixture_slot_${slot.reason}`);
  const prepared = await prepareWebsearchQueryDispatch(second, { owner, call, reserved: { reservation: slot.reservation, identity, input: initial.input } });
  if (prepared.kind !== "ready" || !("dispatch" in prepared)) throw new Error("fixture_dispatch_required");
  const native = await gateway.translateQueryWithReservedGateway({ sourceLocale: "ko", query: second.query }, prepared.dispatch, call, { timeoutMs: 300 });
  expect(native.terminal).toBeNull();
  const notOwner = { ...prepared.dispatch, token: randomUUID() };
  expect(await ledger.markModelDispatchIndeterminate(notOwner, "transport_unknown")).toBe(false);
  expect(await kinds(prepared.dispatch.requestId)).toEqual(["queued", "reserved", "dispatch_started"]);
  expect(await ledger.markModelDispatchIndeterminate(prepared.dispatch, "transport_unknown")).toBe(true);
  expect(await kinds(prepared.dispatch.requestId)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_indeterminate", "dispatch_local_ended"]);
  expect((await releaseEvidencedDispatches({ policies: clientBound("account"), operator }, true)).rows)
    .toContainEqual({ requestId: prepared.dispatch.requestId, released: true, reason: null });
  expect((await l`SELECT state FROM model_capacity_requests WHERE request_id = ${prepared.dispatch.requestId}::uuid`)[0].state).toBe("withdrawn");
}, 120_000);

it("report and CLI: counts proven and unproven model rows across owners; reclaim is dry-run unless --apply", async () => {
  use("ledger");
  const l = pool("ledger"), ledger = await import("@/lib/llm/capacity-repository"), { processGroupRecorder, processGroupGone } = await repo();
  const proven = { instanceId: `${prefix}-proven`, bootId: randomUUID() }, orphan = { instanceId: `${prefix}-orphan`, bootId: randomUUID() };
  const begin = async (owner: { instanceId: string; bootId: string }, work: string) => {
    const slot = await ledger.requestModelSlot({ requestId: randomUUID(), workKey: `${prefix}:${work}`, owner, class: "background", pool: "text",
      routeId: "pr15d-route", provider: "fixture", model: "m" });
    if (slot.kind !== "granted") throw new Error(`fixture_slot_${slot.kind === "deferred" ? slot.reason : "unknown"}`);
    const begun = await ledger.beginModelDispatch(slot.reservation);
    if (begun.kind !== "dispatched") throw new Error("fixture_dispatch");
    return begun.dispatch;
  };
  const recorder = processGroupRecorder(proven), ticket = await recorder.intent();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); children.add(child);
  await recorder.spawned(ticket, child.pid!);
  const dispatch = await begin(proven, "proven");
  await killGroup(child.pid!); children.delete(child); await recorder.exited(ticket, child.pid!); await sleep(20);
  expect(processGroupGone(child.pid!)).toBe(true);
  // 기록기 없이 dispatch 한 owner(근거 없음) — 회수 대상이 아니고 보고 목록에 남는다.
  const leftover = await begin(orphan, "orphan");
  const report = await cli(["reclaim-report", "--client-bound=solo", "--skew-ms=1", "--database-url-stdin"], "ledger");
  expect(report.code).toBe(0);
  const parsed = JSON.parse(report.stdout);
  expect(parsed).toMatchObject({ command: "reclaim-report", dryRun: true, blocked: false, result: { siteActive: true, model: { reclaimable: 1, unproven: 1 } } });
  expect(parsed.result.model.rows).toEqual([
    expect.objectContaining({ requestId: dispatch.requestId, owner: proven, status: "reclaimable", evidence: "process_group_exit", reason: null }),
    expect.objectContaining({ requestId: leftover.requestId, owner: orphan, status: "unproven", evidence: null, reason: "owner_not_opened_before_dispatch" })]);
  const dry = await cli(["reclaim", "--client-bound=solo", "--skew-ms=1", `--reference=${reference}`, `--operator=${operator}`, "--database-url-stdin"], "ledger");
  expect(dry.code).toBe(3); // 근거 없는 행이 남는다
  const out = JSON.parse(dry.stdout);
  expect(out).toMatchObject({ command: "reclaim", dryRun: true, blocked: true });
  expect(out.result.model.rows).toEqual([{ requestId: dispatch.requestId, released: true, reason: null },
    { requestId: leftover.requestId, released: false, reason: "owner_not_opened_before_dispatch" }]);
  expect((await l`SELECT state FROM model_capacity_requests WHERE request_id = ${dispatch.requestId}::uuid`)[0].state).toBe("dispatched");
  const applied = await cli(["reclaim", "--client-bound=solo", "--skew-ms=1", `--reference=${reference}`, `--operator=${operator}`, "--apply", "--database-url-stdin"], "ledger");
  expect(applied.code).toBe(3);
  expect(JSON.parse(applied.stdout)).toMatchObject({ dryRun: false, result: { model: { rows: [{ requestId: dispatch.requestId, released: true, reason: null },
    { requestId: leftover.requestId, released: false, reason: "owner_not_opened_before_dispatch" }] } } });
  expect((await l`SELECT state, terminal_evidence->>'kind' AS kind FROM model_capacity_requests WHERE request_id = ${dispatch.requestId}::uuid`)[0])
    .toEqual({ state: "withdrawn", kind: "process_group_exit" });
  expect((await l`SELECT state FROM model_capacity_requests WHERE request_id = ${leftover.requestId}::uuid`)[0].state).toBe("dispatched");
}, 120_000);

it("fenced DB: the report still reads, but neither model rows nor HTTP hops are released", async () => {
  use("fenced");
  const f = pool("fenced"), ledger = await import("@/lib/llm/capacity-repository"), fence = await import("@/lib/operations/dr/epoch");
  const { processGroupRecorder } = await repo(), reclaim = await import("@/lib/operations/dr/reclaim");
  const owner = { instanceId: `${prefix}-fenced`, bootId: randomUUID() }, recorder = processGroupRecorder(owner), ticket = await recorder.intent();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); children.add(child);
  await recorder.spawned(ticket, child.pid!);
  const slot = await ledger.requestModelSlot({ requestId: randomUUID(), workKey: `${prefix}:fenced`, owner, class: "background", pool: "text",
    routeId: "pr15d-route", provider: "fixture", model: "m" });
  if (slot.kind !== "granted") throw new Error("fixture_fenced_slot");
  const begun = await ledger.beginModelDispatch(slot.reservation);
  if (begun.kind !== "dispatched") throw new Error("fixture_fenced_dispatch");
  await killGroup(child.pid!); children.delete(child); await recorder.exited(ticket, child.pid!); await sleep(20);
  const site = await db.transaction(tx => fence.readDatabaseIdentity(tx)), active = await db.transaction(tx => fence.lockWriterFence(tx, "share"));
  await db.transaction(tx => fence.fenceWriterSite(tx, { lineageId: active.lineageId, writerEpoch: active.writerEpoch, db: site, operator }));
  const before = await f`SELECT to_jsonb(r) AS row FROM model_capacity_requests r ORDER BY queue_ordinal`;
  const report = await reclaim.readReclaimReport(clientBound("solo"), 1);
  expect(report.siteActive).toBe(false);
  expect(report.model.rows).toContainEqual(expect.objectContaining({ requestId: begun.dispatch.requestId, status: "reclaimable" }));
  await expect(reclaim.releaseEvidencedDispatches({ policies: clientBound("solo"), operator }, true)).rejects.toThrow("dr_writer_site_fenced");
  await expect(reclaim.releaseProcessExitedHops({ skewBoundMs: 1, reference, operator }, true)).rejects.toThrow("dr_writer_site_fenced");
  expect(await f`SELECT to_jsonb(r) AS row FROM model_capacity_requests r ORDER BY queue_ordinal`).toEqual(before);
  expect(await f`SELECT 1 FROM model_capacity_events WHERE kind = 'dispatch_released'`).toHaveLength(0);
}, 120_000);
