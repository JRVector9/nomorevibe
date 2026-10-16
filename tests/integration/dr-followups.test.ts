import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { batchPolicyHash } from "@/lib/jobs/batches";
import { grokSessionInputHash, grokSessionLogicalWorkKey, modelCapacityPolicyHash, modelCapacityRequestIdentitySchema,
  type ModelCapacityPolicy } from "@/lib/llm/capacity";
import * as ledger from "@/lib/llm/capacity-repository";
import { prepareCliCall } from "@/lib/llm/cli-process-runner";
import type { CliServingContract } from "@/lib/llm/cli-serving-contract";
import { httpOriginPolicyHash } from "@/lib/net/http-origin-policy";
import { requestOriginHop } from "@/lib/net/origin-permits";
import * as roles from "@/lib/jobs/role-leader";
import { runJob } from "@/lib/jobs/runner";
import * as fence from "@/lib/operations/dr/epoch";
import * as repo from "@/lib/operations/dr/repository";
import * as reclaim from "@/lib/operations/dr/reclaim";
import * as permits from "@/lib/operations/dr/permits";
import type { PromotionPlan } from "@/lib/operations/dr/promotion";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * PR15b 실제 PostgreSQL. 이 파일이 만들고 지우는 임시 DB 두 개만 쓴다(공유 test DB 의 행·제어값은 건드리지 않는다).
 * - ledger: D11 프로세스 그룹 근거 → 장부 회수, 0096 CHECK, 승격 call-drain 회수 → 모델 permit open.
 * - gate: versioned batch 역할과 HTTP permit 이 fence 를 첫 lock 으로 확인하는지(operator fence 는 되돌릴 수 없어 따로 둔다).
 * 자식 프로세스는 `node -e setInterval` 뿐이다. 실제 CLI·provider·운영 resolver 는 쓰지 않는다(CLI 계약은 이 파일의 fixture 만).
 */
const fixture = vi.hoisted(() => ({ contracts: [] as CliServingContract[] }));
vi.mock("@/lib/llm/cli-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/cli-serving-contract")>(),
  resolveCliServingContract: (routeId: string, provider: string, model: string) =>
    fixture.contracts.find(value => value.routeId === routeId && value.provider === provider && value.model === model) ?? null,
}));

const root = fileURLToPath(new URL("../..", import.meta.url));
const tag = randomBytes(6).toString("hex"), prefix = `pr15b-${tag}`;
const names = { ledger: `nomorevibe_test_pr15b_l_${tag}`, gate: `nomorevibe_test_pr15b_g_${tag}` } as const;
type Side = keyof typeof names;
const urlOf = (side: Side) => { const value = new URL(TEST_DATABASE_URL); value.pathname = `/${names[side]}`; return value.toString(); };
const created: Side[] = [], pools = new Map<Side, postgres.Sql>();
const pool = (side: Side) => { let client = pools.get(side); if (!client) { client = postgres(urlOf(side), { max: 4, prepare: false, onnotice: () => {} }); pools.set(side, client); } return client; };
function use(side: Side) { const g = globalThis as { db?: unknown; pgClient?: unknown }; g.pgClient = pool(side); g.db = drizzle(pool(side), { schema }); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const dbNow = async (side: Side) => (await pool(side)<{ now: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)[0].now;
const operator = "pr15b-root-driver";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 16, providerLimits: { acct: 4, solo: 1, "grok-sub": 2 }, groupLimits: { g: 16 },
  poolLimits: { reviewer: 8, text: 8 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 600_000, reservationTtlMs: 600_000,
  routes: [{ routeId: "pr15b-route", provider: "fixture", model: "m", providerBudgetId: "acct", groupId: "g" },
    { routeId: "pr15b-solo", provider: "fixture", model: "m", providerBudgetId: "solo", groupId: "g" },
    { routeId: "grok-session-check", provider: "grok-cli", model: "grok-4", providerBudgetId: "grok-sub", groupId: "g" }] };
const request = (owner: { instanceId: string; bootId: string }, work: string, routeId = "pr15b-route") => ({ requestId: randomUUID(),
  workKey: `${prefix}:${work}`, owner, class: "background" as const, pool: "text" as const, routeId, provider: "fixture", model: "m" });
const clientBound = (budget: string) => new Map([[budget, { termination: "client_bound" as const, hardDeadlineMs: null, skewBoundMs: 1, reference: "fixture local client" }]]);
let http: Server, port = 0;
function cli(args: string[], side: Side): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/ops/dr/promotion.ts", ...args], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(`${urlOf(side)}\n`);
  });
}
async function groupChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  return child.pid!;
}
async function killGroup(pid: number) {
  if (!repo.processGroupGone(pid)) process.kill(-pid, "SIGKILL");
  for (let attempt = 0; attempt < 100 && !repo.processGroupGone(pid); attempt++) await sleep(50);
  expect(repo.processGroupGone(pid)).toBe(true);
}
async function requestRow(side: Side, requestId: string) {
  return (await pool(side)`SELECT state, dispatch_binding_hash, terminal_evidence, terminal_evidence_hash, settled_at FROM model_capacity_requests
    WHERE request_id = ${requestId}::uuid`)[0];
}

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  expect(journal.entries.map(entry => entry.tag)).toContain("0096_model_capacity_dispatch_release");
  const shared = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const [applied] = await shared<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(journal.entries.length);
    for (const side of ["ledger", "gate"] as const) { await shared.unsafe(`CREATE DATABASE ${names[side]}`); created.push(side); }
  } finally { await shared.end({ timeout: 5 }); }
  for (const side of ["ledger", "gate"] as const) {
    const client = postgres(urlOf(side), { max: 1, onnotice: () => {} });
    try { await client.unsafe("set statement_timeout = 0"); await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") }); }
    finally { await client.end({ timeout: 5 }); }
    const [applied] = await pool(side)<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(journal.entries.length);
  }
  fixture.contracts = [{ version: 1, protocol: "cli-process-v1", routeId: "grok-session-check", provider: "grok-cli", model: "grok-4",
    cliVersion: "fake 0.0.0", inputByteCap: 200_000, totalTokenBound: 300_000, costBoundUsdMicros: null, boundProvenance: "declared" }];
  http = createServer((_request, response) => response.end("ok"));
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  port = (http.address() as { port: number }).port;
  console.info("pr15b_migrations", { journal: journal.entries.length });
}, 600_000);

afterAll(async () => {
  fixture.contracts = [];
  await new Promise<void>(resolve => http ? http.close(() => resolve()) : resolve());
  for (const client of pools.values()) await client.end({ timeout: 5 });
  const g = globalThis as { db?: unknown; pgClient?: unknown }; delete g.db; delete g.pgClient;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { for (const side of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${names[side]} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

it("0096 adds only release branches: every earlier CHECK alternative stays, plus one released-event unique index", async () => {
  const defs = Object.fromEntries(Array.from(await pool("ledger")<{ name: string; def: string }[]>`SELECT conname AS name, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conname IN ('model_capacity_requests_dispatch_check','model_capacity_requests_terminal_check','model_capacity_events_kind_check')`)
    .map(row => [row.name, row.def]));
  expect(Object.keys(defs).sort()).toEqual(["model_capacity_events_kind_check", "model_capacity_requests_dispatch_check", "model_capacity_requests_terminal_check"]);
  expect(defs.model_capacity_events_kind_check).toContain("dispatch_settled"); expect(defs.model_capacity_events_kind_check).toContain("dispatch_released");
  for (const name of ["model_capacity_requests_dispatch_check", "model_capacity_requests_terminal_check"]) {
    expect(defs[name]).toContain("websearch_query_gateway"); expect(defs[name]).toContain("process_group_exit");
  }
  const [index] = await pool("ledger")`SELECT indexdef FROM pg_indexes WHERE indexname = 'model_capacity_events_released_idx'`;
  expect(index.indexdef).toContain("WHERE ((kind)::text = 'dispatch_released'::text)");
});

it("gate: versioned batch roles and HTTP origin permits stop at a fenced site before touching batch, role or permit rows", async () => {
  use("gate");
  const g = pool("gate"), batch = { version: 1 as const, release: "pr15b", instances: [{ instanceId: "pr15b-oracle", host: "oracle-osaka-smoke" as const }] };
  await g`UPDATE job_batch_control SET mode = 'legacy', draining_from = NULL, writer_contract_version = 1, policy = ${JSON.stringify(batch)}::text::jsonb,
    policy_hash = ${batchPolicyHash(batch)} WHERE id = 1`;
  // 실제 runner 결과 + 운영자 근거로 versioned 후보를 준비한다(tests/integration/job-batches.test.ts seedReadiness 와 같은 경로).
  const legacy = await roles.tryAcquireRole({ role: "text", instanceId: "pr15b-oracle", bootId: "pr15b-boot", release: "pr15b", kind: "primary" });
  expect(legacy).not.toBeNull();
  const run = await runJob("reason-translate", async ctx => { await ctx.save({ fixture: "pr15b" }); ctx.log("translate.done", { translated: 1 }); return { done: false }; },
    { roleLease: legacy! });
  expect(run.status).toBe("completed"); expect(await roles.releaseRole(legacy!)).toBe(true);
  const at = await dbNow("gate"), [saved] = await g`SELECT requested_version, cursor FROM jobs WHERE name = 'reason-translate'`;
  const capability = { host: "oracle-osaka-smoke", release: "pr15b", instanceId: "pr15b-oracle", dbPrivileges: "verified", dbRole: "fixture-only",
    effectivePrivilegeHash: "a".repeat(64), modelBoundEvidenceHash: "b".repeat(64), http: "verified", model: "verified", observedAt: at };
  const readback = { host: "oracle-osaka-smoke", release: "pr15b", instanceId: "pr15b-oracle", job: "reason-translate", requestedVersion: Number(saved.requested_version),
    domainReadbackHash: createHash("sha256").update(JSON.stringify(saved.cursor)).digest("hex"), observedAt: at };
  await g`INSERT INTO job_batch_candidates (role, instance_id, host, boot_id, release, policy_hash, capability, result_evidence) VALUES ('translation', 'pr15b-oracle',
    'oracle-osaka-smoke', 'pr15b-boot', 'pr15b', ${batchPolicyHash(batch)}, ${JSON.stringify(capability)}::text::jsonb, ${JSON.stringify(readback)}::text::jsonb)`;
  await g`UPDATE job_batch_control SET mode = 'versioned' WHERE id = 1`;
  const oracle = { role: "translation" as const, instanceId: "pr15b-oracle", bootId: "pr15b-boot", release: "pr15b", kind: "primary" as const,
    batchVersion: 1 as const, host: "oracle-osaka-smoke" as const };
  const lease = await roles.tryAcquireRole(oracle);
  expect(lease).toMatchObject({ instanceId: "pr15b-oracle", batchVersion: 1 });
  expect(await roles.renewRole(lease!)).toBe(true);
  const httpPolicy = { version: 1 as const, instanceHosts: { "pr15b-oracle": "oracle-osaka-smoke" as const } };
  await g`UPDATE http_origin_control SET mode = 'open', policy = ${JSON.stringify(httpPolicy)}::text::jsonb, policy_hash = ${httpOriginPolicyHash(httpPolicy)} WHERE id = 1`;
  const hop = (pathname: string) => requestOriginHop(`http://127.0.0.1:${port}/${pathname}`, { redirect: "manual", signal: AbortSignal.timeout(5_000), headers: {} });
  process.env.SERVICE_INSTANCE_ID = "pr15b-oracle";
  try {
    expect(await (await hop("active")).text()).toBe("ok");
    const site = await db.transaction(tx => fence.readDatabaseIdentity(tx)), active = await db.transaction(tx => fence.lockWriterFence(tx, "share"));
    await db.transaction(tx => fence.fenceWriterSite(tx, { lineageId: active.lineageId, writerEpoch: active.writerEpoch, db: site, operator }));
    const before = await g`SELECT to_jsonb(r) AS row FROM role_leases r WHERE role = 'translation'`;
    const [hops] = await g<{ count: number }[]>`SELECT count(*)::int AS count FROM http_origin_hops`;
    // lease 행은 아직 유효하다(45초) — false/null 은 fence 관문 때문이다.
    expect(await roles.renewRole(lease!)).toBe(false);
    expect(await roles.tryAcquireRole(oracle)).toBeNull();
    expect(await g`SELECT to_jsonb(r) AS row FROM role_leases r WHERE role = 'translation'`).toEqual(before);
    await expect(hop("fenced")).rejects.toThrow("http_origin_permit_unavailable");
    expect((await g<{ count: number }[]>`SELECT count(*)::int AS count FROM http_origin_hops`)[0].count).toBe(hops.count);
  } finally { delete process.env.SERVICE_INSTANCE_ID; }
}, 120_000);

const d11 = { owner: { instanceId: `${prefix}-d11`, bootId: randomUUID() }, requestId: "", waiting: null as ReturnType<typeof request> | null };
it("D11: releases a dispatched call only after every possible process group has recorded ESRCH, never by TTL or missing policy", async () => {
  use("ledger");
  const l = pool("ledger");
  await l`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(policy)}::text::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)} WHERE id = 1`;
  const recorder = repo.processGroupRecorder(d11.owner), ticket = await recorder.intent();
  expect(ticket.seq).toBe(1);
  const pid = await groupChild();
  try {
    await recorder.spawned(ticket, pid);
    const slot = await ledger.requestModelSlot(request(d11.owner, "d11", "pr15b-solo"));
    if (slot.kind !== "granted") throw new Error("fixture_d11_slot");
    const begun = await ledger.beginModelDispatch(slot.reservation);
    if (begun.kind !== "dispatched") throw new Error("fixture_d11_dispatch");
    d11.requestId = begun.dispatch.requestId;
    // solo 한도 1: dispatched 행이 자리를 쥐고 있는 동안 다른 owner 는 들어오지 못한다.
    d11.waiting = request({ instanceId: `${prefix}-next`, bootId: randomUUID() }, "after-d11", "pr15b-solo");
    expect(await ledger.requestModelSlot(d11.waiting)).toEqual({ kind: "deferred", reason: "capacity" });
    const release = (policies: ReadonlyMap<string, reclaim.ReclaimPolicyWithReference>, apply = true) =>
      reclaim.releaseProcessExitedDispatches({ owner: d11.owner, policies, operator }, apply);
    expect(await release(clientBound("solo"))).toEqual({ rows: [{ requestId: d11.requestId, released: false, reason: "spawn_not_exited:1" }] });
    await expect(recorder.exited(ticket, pid)).rejects.toThrow("dr_process_group_alive");
    await killGroup(pid);
    await recorder.exited(ticket, pid);
    await sleep(20);
    expect((await release(new Map())).rows).toEqual([{ requestId: d11.requestId, released: false, reason: "provider_deadline_unknown" }]);
    expect((await release(new Map([["solo", { termination: "provider_bound" as const, hardDeadlineMs: 600_000, skewBoundMs: 1, reference: "fixture" }]]))).rows)
      .toEqual([{ requestId: d11.requestId, released: false, reason: "waiting" }]);
    expect(await release(clientBound("solo"), false)).toEqual({ rows: [{ requestId: d11.requestId, released: true, reason: null }] });
    expect((await requestRow("ledger", d11.requestId)).state).toBe("dispatched");
    expect(await l`SELECT 1 FROM model_capacity_events WHERE request_id = ${d11.requestId}::uuid AND kind = 'dispatch_released'`).toHaveLength(0);
    // 운영 CLI(기본 dry-run)도 같은 판정을 낸다.
    const viaCli = await cli(["process-reclaim", `--instance=${d11.owner.instanceId}`, `--boot=${d11.owner.bootId}`, "--client-bound=solo", "--skew-ms=1",
      "--reference=fixture local client", `--operator=${operator}`, "--database-url-stdin"], "ledger");
    expect(viaCli.code).toBe(0);
    expect(JSON.parse(viaCli.stdout)).toMatchObject({ command: "process-reclaim", dryRun: true, blocked: false, result: { rows: [{ requestId: d11.requestId, released: true }] } });
    expect((await requestRow("ledger", d11.requestId)).state).toBe("dispatched");
    expect(await release(clientBound("solo"))).toEqual({ rows: [{ requestId: d11.requestId, released: true, reason: null }] });
    const row = await requestRow("ledger", d11.requestId);
    expect(row).toMatchObject({ state: "withdrawn", dispatch_binding_hash: null, settled_at: null,
      terminal_evidence: { kind: "process_group_exit", requestId: d11.requestId, owner: d11.owner, fromState: "dispatched", bindingHash: null,
        termination: "client_bound", hardDeadlineMs: null, exits: [{ seq: 1, runId: ticket.runId, pid }], operator } });
    const [event] = await l`SELECT kind, from_state, to_state, reason, evidence FROM model_capacity_events WHERE request_id = ${d11.requestId}::uuid ORDER BY id DESC LIMIT 1`;
    expect(event).toEqual({ kind: "dispatch_released", from_state: "dispatched", to_state: "withdrawn", reason: null, evidence: row.terminal_evidence });
    expect(Date.parse(row.terminal_evidence.dispatchAt)).toBeGreaterThan(0);
    // 풀린 자리는 실제로 다음 요청에 돌아간다. 두 번째 회수는 대상이 없다.
    const next = await ledger.requestModelSlot(d11.waiting);
    expect(next.kind).toBe("granted");
    if (next.kind === "granted") expect(await ledger.cancelReservedModelSlot(next.reservation)).toBe(true);
    expect(await release(clientBound("solo"))).toEqual({ rows: [] });
  } finally { if (!repo.processGroupGone(pid)) process.kill(-pid, "SIGKILL"); }
}, 120_000);

it("D11: a CLI-bound dispatch can leave the active states only with release evidence on the row; events stay append-only and single", async () => {
  use("ledger");
  const l = pool("ledger"), owner = { instanceId: `${prefix}-grok`, bootId: randomUUID() }, recorder = repo.processGroupRecorder(owner);
  const ticket = await recorder.intent(), pid = await groupChild();
  try {
    await recorder.spawned(ticket, pid);
    const prepared = prepareCliCall({ routeId: "grok-session-check", provider: "grok-cli", model: "grok-4", command: path.join(tmpdir(), "pr15b-never-run"),
      args: ["-p", "Reply with the single word OK.", "-m", "grok-4", "--output-format", "json"], stdin: null, cwd: tmpdir(), env: { PATH: "/nonexistent" },
      boundEnvKeys: [], timeoutMs: 5_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384 });
    if (prepared.kind !== "prepared") throw new Error("fixture_contract_required");
    const logical = grokSessionLogicalWorkKey(owner.instanceId), inputHash = grokSessionInputHash({ instanceId: owner.instanceId, model: "grok-4" });
    const identity = modelCapacityRequestIdentitySchema.parse({ owner, workKey: `${logical}:${inputHash}`, class: "background", pool: "reviewer",
      routeId: "grok-session-check", provider: "grok-cli", model: "grok-4" });
    const slot = await ledger.requestCliModelSlot({ ...identity, requestId: randomUUID() }, { kind: "grok-session", instanceId: owner.instanceId });
    if (slot.kind !== "granted") throw new Error(`fixture_cli_slot_${slot.reason}`);
    const dispatch = await db.transaction(async tx => {
      const lock = await ledger.lockCliModelCapacityDispatch(tx, { reservation: slot.reservation, identity, target: { kind: "grok-session", instanceId: owner.instanceId } });
      if (!lock) throw new Error("fixture_cli_lock");
      return ledger.finishCliModelCapacityDispatch(tx, lock, { instanceId: owner.instanceId, model: "grok-4", kind: "grok_session_cli", version: 1,
        logicalWorkKey: logical, inputHash, provider: "grok-cli", routeId: "grok-session-check", transport: prepared.transport,
        totalTokenBound: prepared.totalTokenBound, chargedTokens: prepared.totalTokenBound, job: { name: "grok-session-check", token: randomUUID(), requestedVersion: 1 } });
    });
    const id = dispatch.requestId;
    // 근거 없는 dispatched→withdrawn, 모양이 틀린 근거, 틀린 released event 는 DB 가 거절한다(PR05a: TTL·owner 죽음으로 풀지 않음).
    await expect(l`UPDATE model_capacity_requests SET state = 'withdrawn' WHERE request_id = ${id}::uuid`).rejects.toMatchObject({ code: "23514" });
    await expect(l`UPDATE model_capacity_requests SET state = 'withdrawn', terminal_evidence = '{"version":1,"kind":"process_group_exit"}'::jsonb,
      terminal_evidence_hash = ${"a".repeat(64)} WHERE request_id = ${id}::uuid`).rejects.toMatchObject({ code: "23514" });
    await expect(l`INSERT INTO model_capacity_events (request_id, kind, epoch, revision, policy_hash, from_state, to_state, evidence)
      VALUES (${id}::uuid, 'dispatch_released', 1, 1, ${"a".repeat(64)}, 'dispatched', 'withdrawn', '{"version":1,"kind":"dr_call_drain"}'::jsonb)`)
      .rejects.toMatchObject({ code: "23514" });
    await killGroup(pid);
    await recorder.exited(ticket, pid);
    await sleep(20);
    expect((await reclaim.releaseProcessExitedDispatches({ owner, policies: clientBound("grok-sub"), operator }, true)).rows)
      .toEqual([{ requestId: id, released: true, reason: null }]);
    const row = await requestRow("ledger", id);
    expect(row).toMatchObject({ state: "withdrawn", dispatch_binding_hash: dispatch.bindingHash,
      terminal_evidence: { kind: "process_group_exit", bindingHash: dispatch.bindingHash, owner, exits: [{ seq: 1, runId: ticket.runId, pid }] } });
    const [binding] = await l`SELECT dispatch_binding FROM model_capacity_requests WHERE request_id = ${id}::uuid`;
    expect(binding.dispatch_binding).toEqual(dispatch.binding);
    await expect(l`INSERT INTO model_capacity_events (request_id, kind, epoch, revision, policy_hash, from_state, to_state, evidence)
      SELECT request_id, kind, epoch, revision, policy_hash, from_state, to_state, evidence FROM model_capacity_events
      WHERE request_id = ${id}::uuid AND kind = 'dispatch_released'`).rejects.toMatchObject({ code: "23505" });
    await expect(l`UPDATE model_capacity_events SET reason = NULL WHERE request_id = ${id}::uuid`).rejects.toMatchObject({ code: "55000" });
    // 근거 행을 바꾸면 terminal CHECK 가 거절한다.
    await expect(l`UPDATE model_capacity_requests SET terminal_evidence = jsonb_set(terminal_evidence, '{requestId}', to_jsonb(${randomUUID()}::text))
      WHERE request_id = ${id}::uuid`).rejects.toMatchObject({ code: "23514" });
  } finally { if (!repo.processGroupGone(pid)) process.kill(-pid, "SIGKILL"); }
}, 120_000);

it("DR: after promotion, only call-drained old-generation dispatches are released, then model permits open", async () => {
  use("ledger");
  const old = { instanceId: `${prefix}-old`, bootId: randomUUID() };
  const begin = async (work: string) => {
    const slot = await ledger.requestModelSlot(request(old, work));
    if (slot.kind !== "granted") throw new Error("fixture_old_slot");
    const begun = await ledger.beginModelDispatch(slot.reservation);
    if (begun.kind !== "dispatched") throw new Error("fixture_old_dispatch");
    return begun.dispatch;
  };
  const dispatched = (await begin("old-dispatched")).requestId, lost = await begin("old-indeterminate");
  expect(await ledger.markModelDispatchIndeterminate(lost, "process_exit")).toBe(true);
  const reserved = await ledger.requestModelSlot(request(old, "old-reserved"));
  if (reserved.kind !== "granted") throw new Error("fixture_old_reserved");
  const here = await db.transaction(tx => fence.readDatabaseIdentity(tx)), active = await db.transaction(tx => fence.lockWriterFence(tx, "share"));
  const formerPrimary = { systemIdentifier: "7000000000000000001", databaseOid: "16384", databaseName: "pr15b_former_primary" };
  const plan: PromotionPlan = { version: 1, promotionId: randomUUID(), lineageId: active.lineageId, fromEpoch: active.writerEpoch, knownActiveEpoch: active.writerEpoch,
    restoredDb: here, oldDbs: [formerPrimary], oldInstances: [`${prefix}-declared`], snapshotAt: await dbNow("ledger"), operator };
  const sealed = await repo.sealRestoredDatabase(plan, true);
  // 승격 전(봉인된 사본)에는 어떤 회수도 장부를 바꾸지 않는다.
  await expect(reclaim.releaseDrainedDispatches({ promotionId: plan.promotionId, operator }, true)).rejects.toThrow("dr_promotion_not_active");
  await expect(reclaim.releaseProcessExitedDispatches({ owner: old, policies: clientBound("acct"), operator }, true)).rejects.toThrow("dr_writer_site_fenced");
  const record = (kind: Parameters<typeof repo.recordPromotionEvidence>[0]["kind"], subject: string, payload: unknown) =>
    repo.recordPromotionEvidence({ promotionId: plan.promotionId, kind, subject, payload, operator }, true);
  await record("old_db_isolated", `db:${formerPrimary.systemIdentifier}:${formerPrimary.databaseOid}`, { version: 1, db: formerPrimary, method: "host_powered_off",
    reference: "fixture power off", autoRestartDisabled: true, rejoinFenceRequired: true, observedAt: await dbNow("ledger") });
  const stoppedAt = await dbNow("ledger");
  for (const instanceId of [...new Set([...plan.oldInstances, ...sealed.sealSnapshot.instances])])
    await record("writer_process_stopped", instanceId, { version: 1, instanceId, method: "container_removed", reference: `fixture stop ${instanceId}`,
      autoRestartDisabled: true, stoppedAt, skewBoundMs: 1 });
  for (const budget of sealed.sealSnapshot.modelBudgets)
    await record("provider_deadline", `model:${budget}`, { version: 1, scope: `model:${budget}`, termination: "provider_bound", hardDeadlineMs: 1_000, reference: "fixture hard deadline" });
  await record("external_effects_reconciled", "rpo-window", { version: 1, windowFrom: plan.snapshotAt, windowTo: stoppedAt, method: "old_db_compared",
    reference: "fixture effects diff", reviewed: 0, corrective: "none" });
  for (let attempt = 0; attempt < 100 && !(await repo.readPromotionStatus(plan.promotionId)).evaluation.ready; attempt++) await sleep(100);
  expect(await repo.promoteSealedDatabase({ promotionId: plan.promotionId, operator }, true)).toMatchObject({ kind: "promoted", fence: { writerEpoch: active.writerEpoch + 1 } });
  // 기존 의미 그대로: 옛 dispatched/indeterminate 가 남으면 모델 permit 은 열리지 않는다(옛 reserved 는 장부 API 로 취소).
  expect(await permits.openModelCapacityAfterDrain({ promotionId: plan.promotionId, operator }, true))
    .toMatchObject({ kind: "blocked", reason: "model_capacity_old_dispatch_unreleased:2", cancelledReservations: [reserved.reservation.requestId] });
  const dry = await cli(["release-drained", `--promotion=${plan.promotionId}`, `--operator=${operator}`, "--database-url-stdin"], "ledger");
  expect(dry.code).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({ command: "release-drained", dryRun: true, blocked: false,
    result: { rows: [{ requestId: dispatched, released: true }, { requestId: lost.requestId, released: true }] } });
  expect((await requestRow("ledger", dispatched)).state).toBe("dispatched");
  expect(await reclaim.releaseDrainedDispatches({ promotionId: plan.promotionId, operator }, true)).toEqual({ rows: [
    { requestId: dispatched, released: true, reason: null }, { requestId: lost.requestId, released: true, reason: null }] });
  for (const [requestId, fromState] of [[dispatched, "dispatched"], [lost.requestId, "indeterminate"]] as const)
    expect(await requestRow("ledger", requestId)).toMatchObject({ state: "withdrawn", terminal_evidence: { kind: "dr_call_drain", fromState, scope: "model:acct",
      promotionId: plan.promotionId, writerEpoch: active.writerEpoch + 1, requestId, owner: old } });
  expect(await permits.openModelCapacityAfterDrain({ promotionId: plan.promotionId, operator }, true)).toMatchObject({ kind: "opened" });
  const fresh = await ledger.requestModelSlot(request({ instanceId: `${prefix}-new`, bootId: randomUUID() }, "after-promotion"));
  expect(fresh.kind).toBe("granted");
  if (fresh.kind === "granted") expect(fresh.reservation.epoch).toBe(sealed.sealSnapshot.modelControl.epoch);
}, 120_000);
