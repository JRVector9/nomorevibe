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
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { httpOriginPolicyHash } from "@/lib/net/http-origin-policy";
import type { ProcessAttestation } from "@/lib/operations/dr/process-attestation";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * PR15f 실제 PostgreSQL + 실제 자식 프로세스 그룹. 이 파일이 만들고 지우는 임시 DB 두 개만 쓴다.
 * - ledger: supervisor 가 child 와 함께 죽어 종료 기록이 없는 boot 를, 같은 커널·같은 PID namespace 의 후속 boot 가 직접 본 ESRCH 로만 회수한다.
 * - step: 0100 까지 적용한 DB 에 0101 을 더해 pg_get_constraintdef 로 기존 CHECK 가 통째로 왼쪽에 남는지 본다.
 * macOS 에는 /proc 가 없어 attestation 은 fixture 값이다. 이 테스트 프로세스와 자식은 실제로 같은 커널·같은 PID namespace 에 있으므로 사실과 같다.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const tag = randomBytes(6).toString("hex"), prefix = `pr15f-${tag}`;
const names = { ledger: `nomorevibe_test_pr15f_l_${tag}`, step: `nomorevibe_test_pr15f_s_${tag}` } as const;
type Side = keyof typeof names;
const urlOf = (side: Side) => { const value = new URL(TEST_DATABASE_URL); value.pathname = `/${names[side]}`; return value.toString(); };
const created: Side[] = [], pools = new Map<Side, postgres.Sql>(), children = new Set<ChildProcess>(), servers: Server[] = [], held = new Set<ServerResponse>();
const pool = (side: Side) => { let client = pools.get(side); if (!client) { client = postgres(urlOf(side), { max: 4, prepare: false, onnotice: () => {} }); pools.set(side, client); } return client; };
function use(side: Side) { const g = globalThis as { db?: unknown; pgClient?: unknown }; g.pgClient = pool(side); g.db = drizzle(pool(side), { schema }); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const operator = "pr15f-root-driver", reference = "fixture: loopback origin closes with the client";
const attestation: ProcessAttestation = { version: 1, kernelBootId: randomUUID(), pidNamespace: 4026531836 };
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 8, providerLimits: { solo: 8 }, groupLimits: { engine: 8 },
  poolLimits: { reviewer: 8, text: 8 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 600_000, reservationTtlMs: 600_000,
  routes: [{ routeId: "pr15f-route", provider: "fixture", model: "m", providerBudgetId: "solo", groupId: "engine" }] };
const clientBound = new Map([["solo", { termination: "client_bound" as const, hardDeadlineMs: null, skewBoundMs: 1, reference }]]);
const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
const PRESERVED = ["dr_process_group_events_method_check"] as const;
const UNTOUCHED = ["dr_process_group_events_shape_check", "dr_process_group_events_kind_check", "dr_process_group_events_seq_check",
  "dr_process_group_events_pid_check", "dr_process_group_events_owner_instance_id_check", "model_capacity_requests_dispatch_check",
  "model_capacity_requests_terminal_check", "model_capacity_requests_logical_check", "model_capacity_requests_members_check",
  "model_capacity_events_kind_check", "http_origin_events_evidence_check"] as const;
let before0101: Record<string, string> = {};
const repo = () => import("@/lib/operations/dr/repository");
const reclaim = () => import("@/lib/operations/dr/reclaim");

async function constraintDefs(side: Side, list: readonly string[]) {
  return Object.fromEntries(Array.from(await pool(side)<{ name: string; def: string }[]>`SELECT conname AS name, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conname = ANY(${list as string[]}::text[])`).map(row => [row.name, row.def]));
}
async function serve(handler: (response: ServerResponse) => void): Promise<string> {
  const server = createServer((request, response) => { request.resume(); request.on("end", () => handler(response)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function hold(response: ServerResponse) { held.add(response); response.writeHead(200, { "content-type": "text/plain" }); response.write("open"); }
/** supervisor 가 child 그룹째 SIGKILL 당한 상황: 그룹은 사라지지만 기록기의 exited 는 불리지 않는다. */
async function crash(child: ChildProcess) {
  const { processGroupGone } = await repo();
  process.kill(-child.pid!, "SIGKILL");
  for (let attempt = 0; attempt < 100 && !processGroupGone(child.pid!); attempt++) await sleep(50);
  expect(processGroupGone(child.pid!)).toBe(true);
  children.delete(child);
}
function idle() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  children.add(child); return child;
}
async function begin(owner: { instanceId: string; bootId: string }, work: string) {
  const ledger = await import("@/lib/llm/capacity-repository");
  const slot = await ledger.requestModelSlot({ requestId: randomUUID(), workKey: `${prefix}:${work}`, owner, class: "background", pool: "text",
    routeId: "pr15f-route", provider: "fixture", model: "m" });
  if (slot.kind !== "granted") throw new Error(`fixture_slot_${slot.kind === "deferred" ? slot.reason : "unknown"}`);
  const begun = await ledger.beginModelDispatch(slot.reservation);
  if (begun.kind !== "dispatched") throw new Error("fixture_dispatch");
  return begun.dispatch;
}
/** 옛 boot: 기록기로 의도·spawned 를 남기고 실제 자식 그룹을 띄운 뒤, 그 owner 로 장부 행 하나를 dispatch 하고 종료 기록 없이 죽는다. */
async function crashedBoot(instanceId: string, options: { attestation?: ProcessAttestation | null } = {}) {
  const { processGroupRecorder } = await repo();
  const owner = { instanceId, bootId: randomUUID() }, recorder = processGroupRecorder(owner, { attestation: options.attestation ?? null });
  const ticket = await recorder.intent(), child = idle();
  await recorder.spawned(ticket, child.pid!);
  const dispatch = await begin(owner, `${instanceId}:${owner.bootId}`);
  await crash(child);
  return { owner, ticket, pid: child.pid!, dispatch };
}
const exitRow = async (owner: { instanceId: string; bootId: string }) => (await pool("ledger")<{ method: string; detail: unknown; pid: number; run_id: string }[]>`
  SELECT method, detail, pid, run_id::text FROM dr_process_group_events WHERE owner_instance_id = ${owner.instanceId} AND owner_boot_id = ${owner.bootId}::uuid
    AND kind = 'group_exited'`)[0] ?? null;
const reportRow = async (requestId: string) => (await (await reclaim()).readReclaimReport(clientBound, 1)).model.rows.find(row => row.requestId === requestId);

beforeAll(async () => {
  ensureSchema();
  expect(journal.entries.map(entry => entry.tag)).toContain("0101_dr_process_group_successor_exit");
  const shared = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const [applied] = await shared<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(journal.entries.length);
    for (const side of ["ledger", "step"] as const) { await shared.unsafe(`CREATE DATABASE ${names[side]}`); created.push(side); }
  } finally { await shared.end({ timeout: 5 }); }
  // step: 0100 까지만 담은 migrations 사본으로 먼저 올린 뒤 원래 폴더로 0101 을 더한다.
  const partial = mkdtempSync(path.join(tmpdir(), "pr15f-migrations-"));
  try {
    mkdirSync(path.join(partial, "meta"));
    const upTo = journal.entries.filter(entry => entry.idx <= 100);
    expect(upTo.at(-1)!.tag).toBe("0100_job_batch_candidates_scheduler_role");
    for (const entry of upTo) copyFileSync(path.join(root, "drizzle", `${entry.tag}.sql`), path.join(partial, `${entry.tag}.sql`));
    writeFileSync(path.join(partial, "meta/_journal.json"), JSON.stringify({ ...JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")), entries: upTo }));
    const client = postgres(urlOf("step"), { max: 1, onnotice: () => {} });
    try { await client.unsafe("set statement_timeout = 0"); await migrate(drizzle(client), { migrationsFolder: partial }); }
    finally { await client.end({ timeout: 5 }); }
  } finally { rmSync(partial, { recursive: true, force: true }); }
  before0101 = await constraintDefs("step", [...PRESERVED, ...UNTOUCHED]);
  // step 은 0101 직후 상태로 비교한다(journal 은 tag 로 찾는다). 뒤 migration 이 같은 CHECK 를 whole-left 로 넓혀도
  // "0101 은 지정한 CHECK 외에는 건드리지 않는다"는 이 테스트의 의도는 그대로다.
  const through = journal.entries.slice(0, journal.entries.findIndex(entry => entry.tag === "0101_dr_process_group_successor_exit") + 1);
  expect(through.at(-1)?.tag).toBe("0101_dr_process_group_successor_exit");
  for (const side of ["ledger", "step"] as const) {
    const entries = side === "step" ? through : journal.entries;
    const folder = side === "step" ? mkdtempSync(path.join(tmpdir(), "0101-through-")) : path.join(root, "drizzle");
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
  await pool("ledger")`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(policy)}::text::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)} WHERE id = 1`;
  console.info("pr15f_migrations", { journal: journal.entries.length });
}, 600_000);

afterAll(async () => {
  for (const child of children) if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* 이미 끝남 */ }
  for (const response of held) response.destroy();
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const client of pools.values()) await client.end({ timeout: 5 });
  const g = globalThis as { db?: unknown; pgClient?: unknown }; delete g.db; delete g.pgClient;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { for (const side of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${names[side]} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

it("0101: the 0095 method predicate stays whole on the left (pg_get_constraintdef), the detail column and its CHECK are new, nothing else changes", async () => {
  const after = await constraintDefs("step", [...PRESERVED, ...UNTOUCHED, "dr_process_group_events_detail_check"]);
  const inner = (def: string) => { expect(def.startsWith("CHECK (")).toBe(true); return def.slice("CHECK (".length, -1); };
  for (const name of PRESERVED) {
    const left = inner(before0101[name]), combined = inner(after[name]);
    expect(left).toContain("pgid_esrch_after_sigkill");
    // '(' + 0095 본문 + ') OR (' + 새 분기 + ')' 를 PG 가 OR 사슬 하나로 펴서 deparse 한다: 옛 disjunct 가 같은 글자로 앞에 남고 새 분기는 뒤에만 붙는다.
    expect(combined.length).toBeGreaterThan(left.length);
    expect(combined.startsWith(`${left.slice(0, -1)} OR `)).toBe(true);
    expect(combined.slice(left.length - 1)).toBe(" OR ((method)::text = 'pgid_esrch_by_successor'::text))");
  }
  for (const name of UNTOUCHED) expect(after[name]).toBe(before0101[name]);
  expect(after.dr_process_group_events_detail_check).toContain("pgid_esrch_by_successor");
  expect(after.dr_process_group_events_detail_check).toContain("observerBootId");
  const [column] = await pool("step")`SELECT data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_name = 'dr_process_group_events' AND column_name = 'detail'`;
  expect(column).toEqual({ data_type: "jsonb", is_nullable: "YES", column_default: null });
  const triggers = Array.from(await pool("step")`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'dr_process_group_events'::regclass AND NOT tgisinternal ORDER BY tgname`);
  expect(triggers).toEqual([{ tgname: "dr_process_group_events_no_change", tgenabled: "A" }, { tgname: "dr_process_group_events_no_truncate", tgenabled: "A" }]);
});

it("crash: supervisor and child die without an exit record; the hop and slot stay unproven until a successor boot in the same kernel and PID namespace sees ESRCH", async () => {
  use("ledger");
  const l = pool("ledger"), { processGroupRecorder } = await repo(), { readReclaimReport, releaseEvidencedDispatches, releaseProcessExitedHops } = await reclaim();
  const instanceId = `${prefix}-oracle`, old = { instanceId, bootId: randomUUID() };
  const httpPolicy = { version: 1 as const, instanceHosts: { [instanceId]: "oracle-osaka-smoke" as const } };
  await l`UPDATE http_origin_control SET mode = 'open', policy = ${JSON.stringify(httpPolicy)}::text::jsonb, policy_hash = ${httpOriginPolicyHash(httpPolicy)} WHERE id = 1`;
  const origin = await serve(hold);
  const recorder = processGroupRecorder(old, { attestation }), ticket = await recorder.intent();
  const [openedRow] = await l`SELECT detail FROM dr_process_group_events WHERE owner_boot_id = ${old.bootId}::uuid AND kind = 'owner_opened'`;
  expect(openedRow.detail).toEqual(attestation);
  const child = spawn(process.execPath, ["--import", "tsx", "tests/integration/fixtures/dr-reclaim-hop-child.ts"], { cwd: root, detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, DATABASE_URL: urlOf("ledger"), SERVICE_INSTANCE_ID: instanceId, ALLOW_PRIVATE_URLS: "1",
      DR_RECLAIM_HOP_URL: `${origin}/held`, PROCESS_GROUP_OWNER_INSTANCE_ID: old.instanceId, PROCESS_GROUP_OWNER_BOOT_ID: old.bootId } });
  children.add(child); child.stdout!.resume(); child.stderr!.resume();
  await recorder.spawned(ticket, child.pid!);
  const message = await new Promise<{ kind: string; status?: number }>(resolve => child.once("message", value => resolve(value as never)));
  expect(message).toEqual({ kind: "headers", status: 200 });
  const dispatch = await begin(old, "crash");
  const [hop] = await l<{ id: string }[]>`SELECT id::text FROM http_origin_hops WHERE boot_id = ${old.bootId}::uuid AND state = 'dispatched'`;
  expect(hop).toBeDefined();
  await crash(child); // supervisor 도 함께 죽었다: recorder.exited 는 영영 불리지 않는다
  await sleep(20);
  // RED: 종료 기록이 없으면 시간이 지나도 근거가 아니다
  expect(await reportRow(dispatch.requestId)).toMatchObject({ status: "unproven", evidence: null, reason: "spawn_not_exited:1" });
  expect((await readReclaimReport(clientBound, 1)).http.rows.find(row => row.hopId === hop.id)).toMatchObject({ status: "unproven", reason: "spawn_not_exited:1" });
  expect((await releaseEvidencedDispatches({ policies: clientBound, operator }, true)).rows.find(row => row.requestId === dispatch.requestId))
    .toEqual({ requestId: dispatch.requestId, released: false, reason: "spawn_not_exited:1" });
  expect((await releaseProcessExitedHops({ skewBoundMs: 1, reference, operator }, true)).rows.find(row => row.hopId === hop.id))
    .toEqual({ hopId: hop.id, released: false, reason: "spawn_not_exited:1" });
  // 후속 boot(같은 instance, 같은 커널·PID namespace)가 attestation 을 남긴 뒤 옛 그룹의 ESRCH 를 직접 본다
  const next = { instanceId, bootId: randomUUID() }, successor = processGroupRecorder(next, { attestation });
  expect(await successor.probePredecessors!()).toEqual({ recorded: [{ bootId: old.bootId, seq: 1, runId: ticket.runId, pid: child.pid }], alive: 0 });
  expect(await exitRow(old)).toEqual({ method: "pgid_esrch_by_successor", pid: child.pid, run_id: ticket.runId,
    detail: { version: 1, observerBootId: next.bootId, kernelBootId: attestation.kernelBootId, pidNamespace: attestation.pidNamespace } });
  const [nextOpened] = await l`SELECT detail FROM dr_process_group_events WHERE owner_boot_id = ${next.bootId}::uuid AND kind = 'owner_opened'`;
  expect(nextOpened.detail).toEqual(attestation);
  expect(await successor.probePredecessors!()).toEqual({ recorded: [], alive: 0 }); // 이미 종료가 있는 seq 는 다시 쓰지 않는다
  await sleep(20);
  // GREEN: 기존 판정·정책(client_bound)으로 회수한다. 근거 kind 는 process_group_exit 그대로다
  expect(await reportRow(dispatch.requestId)).toMatchObject({ status: "reclaimable", evidence: "process_group_exit", reason: null });
  expect((await releaseEvidencedDispatches({ policies: new Map(), operator }, true)).rows.find(row => row.requestId === dispatch.requestId))
    .toEqual({ requestId: dispatch.requestId, released: false, reason: "provider_deadline_unknown" });
  expect((await releaseEvidencedDispatches({ policies: clientBound, operator }, true)).rows.find(row => row.requestId === dispatch.requestId))
    .toEqual({ requestId: dispatch.requestId, released: true, reason: null });
  const [row] = await l`SELECT state, terminal_evidence FROM model_capacity_requests WHERE request_id = ${dispatch.requestId}::uuid`;
  expect(row).toMatchObject({ state: "withdrawn", terminal_evidence: { kind: "process_group_exit", owner: old, termination: "client_bound",
    exits: [{ seq: 1, runId: ticket.runId, pid: child.pid }], operator, reference } });
  expect((await releaseProcessExitedHops({ skewBoundMs: 1, reference, operator }, true)).rows.find(item => item.hopId === hop.id))
    .toEqual({ hopId: hop.id, released: true, reason: null });
  const [hopEvidence] = await l`SELECT evidence FROM http_origin_events WHERE hop_id = ${hop.id}::uuid AND evidence IS NOT NULL`;
  expect(hopEvidence.evidence).toMatchObject({ kind: "process_group_exit", owner: old, exits: [{ seq: 1, runId: ticket.runId, pid: child.pid }] });
  // 기록은 append-only 다
  await expect(l`UPDATE dr_process_group_events SET detail = NULL WHERE owner_boot_id = ${old.bootId}::uuid`).rejects.toMatchObject({ code: "55000" });
}, 120_000);

it("rejects: a live group, another instance, a different kernel boot or PID namespace, unattested owners and inconsistent successor rows", async () => {
  use("ledger");
  const l = pool("ledger"), { processGroupRecorder, recordSuccessorExits, openProcessGroupOwner } = await repo();
  // 살아 있는 그룹: 후속 boot 가 보아도 ESRCH 가 아니므로 기록하지 않는다. 죽은 뒤에는 같은 후속 boot 가 다시 보아 기록한다
  const liveInstance = `${prefix}-live`, live = { instanceId: liveInstance, bootId: randomUUID() }, liveRecorder = processGroupRecorder(live, { attestation });
  const liveTicket = await liveRecorder.intent(), liveChild = idle();
  await liveRecorder.spawned(liveTicket, liveChild.pid!);
  const watcher = processGroupRecorder({ instanceId: liveInstance, bootId: randomUUID() }, { attestation });
  expect(await watcher.probePredecessors!()).toEqual({ recorded: [], alive: 1 });
  expect(await exitRow(live)).toBeNull();
  await crash(liveChild);
  expect((await watcher.probePredecessors!()).recorded).toEqual([{ bootId: live.bootId, seq: 1, runId: liveTicket.runId, pid: liveChild.pid }]);

  // 다른 instance 의 owner 는 보지 않는다
  const other = await crashedBoot(`${prefix}-other`, { attestation });
  expect(await processGroupRecorder({ instanceId: `${prefix}-elsewhere`, bootId: randomUUID() }, { attestation }).probePredecessors!())
    .toEqual({ recorded: [], alive: 0 });
  expect(await exitRow(other.owner)).toBeNull();

  // 다른 커널 boot·다른 PID namespace 에서 본 ESRCH 는 그 그룹에 대한 사실이 아니다
  const mismatch = await crashedBoot(`${prefix}-mismatch`, { attestation });
  for (const differs of [{ ...attestation, kernelBootId: randomUUID() }, { ...attestation, pidNamespace: 4026532211 }])
    expect(await processGroupRecorder({ instanceId: mismatch.owner.instanceId, bootId: randomUUID() }, { attestation: differs }).probePredecessors!())
      .toEqual({ recorded: [], alive: 0 });
  expect(await exitRow(mismatch.owner)).toBeNull();

  // attestation 없이 연 옛 boot(flag 꺼짐·옛 코드)는 대상이 아니다
  const unattested = await crashedBoot(`${prefix}-unattested`);
  expect(await processGroupRecorder({ instanceId: unattested.owner.instanceId, bootId: randomUUID() }, { attestation }).probePredecessors!())
    .toEqual({ recorded: [], alive: 0 });
  expect(await exitRow(unattested.owner)).toBeNull();
  expect(await reportRow(unattested.dispatch.requestId)).toMatchObject({ status: "unproven", reason: "spawn_not_exited:1" });

  // 관측자는 자기 attestation 을 그 값 그대로 먼저 남겨야 한다
  const bare = { instanceId: mismatch.owner.instanceId, bootId: randomUUID() };
  await openProcessGroupOwner(bare);
  await expect(recordSuccessorExits(bare, attestation)).rejects.toThrow("dr_process_owner_not_attested");
  const attestedBoot = { instanceId: mismatch.owner.instanceId, bootId: randomUUID() };
  await openProcessGroupOwner(attestedBoot, attestation);
  await expect(recordSuccessorExits(attestedBoot, { ...attestation, pidNamespace: 4026532211 })).rejects.toThrow("dr_process_owner_not_attested");
  expect(await exitRow(mismatch.owner)).toBeNull();

  // 직접 SQL: 모양이 틀린 successor 행은 DB 가 거절하고, 모양만 맞고 옛 owner 의 attestation 과 다른 행은 판정이 거절한다
  const forged = await crashedBoot(`${prefix}-forged`, { attestation });
  const insert = (method: string | null, detail: unknown, kind = "group_exited", seq = 1) => l`INSERT INTO dr_process_group_events
    (owner_instance_id, owner_boot_id, kind, seq, run_id, pid, method, detail) VALUES (${forged.owner.instanceId}, ${forged.owner.bootId}::uuid, ${kind}, ${seq},
    ${forged.ticket.runId}::uuid, ${kind === "spawn_intent" ? null : forged.pid}, ${method}, ${detail === null ? null : JSON.stringify(detail)}::text::jsonb)`;
  const observerDetail = { version: 1, observerBootId: randomUUID(), kernelBootId: attestation.kernelBootId, pidNamespace: attestation.pidNamespace };
  await expect(insert("pgid_esrch_by_successor", null)).rejects.toMatchObject({ code: "23514" });
  await expect(insert("pgid_esrch_by_successor", { ...observerDetail, observerBootId: forged.owner.bootId })).rejects.toMatchObject({ code: "23514" });
  await expect(insert("pgid_esrch_by_successor", { ...observerDetail, extra: true })).rejects.toMatchObject({ code: "23514" });
  await expect(insert("pgid_esrch_by_successor", { ...observerDetail, pidNamespace: 0 })).rejects.toMatchObject({ code: "23514" });
  await expect(insert("pgid_esrch_after_sigkill", observerDetail)).rejects.toMatchObject({ code: "23514" });
  await expect(insert("ttl_expired", null)).rejects.toMatchObject({ code: "23514" });
  await expect(insert(null, attestation, "spawn_intent", 2)).rejects.toMatchObject({ code: "23514" });
  await expect(l`INSERT INTO dr_process_group_events (owner_instance_id, owner_boot_id, kind, seq, detail)
    VALUES (${forged.owner.instanceId}, ${randomUUID()}::uuid, 'owner_opened', 0, ${JSON.stringify({ ...attestation, kernelBootId: "NOT-A-UUID" })}::text::jsonb)`)
    .rejects.toMatchObject({ code: "23514" });
  await insert("pgid_esrch_by_successor", { ...observerDetail, kernelBootId: randomUUID() });
  await sleep(20);
  expect(await reportRow(forged.dispatch.requestId)).toMatchObject({ status: "unproven", evidence: null, reason: "exit_unverified:1" });
  expect((await (await reclaim()).releaseEvidencedDispatches({ policies: clientBound, operator }, true)).rows.find(row => row.requestId === forged.dispatch.requestId))
    .toEqual({ requestId: forged.dispatch.requestId, released: false, reason: "exit_unverified:1" });
  expect((await l`SELECT state FROM model_capacity_requests WHERE request_id = ${forged.dispatch.requestId}::uuid`)[0].state).toBe("dispatched");
}, 120_000);
