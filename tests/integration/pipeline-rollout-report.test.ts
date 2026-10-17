import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { collectPipelineObservation, collectPipelineSnapshot } from "@/lib/operations/pipeline-observation-repository";
import { reportPipelineObservation } from "@/lib/operations/pipeline-observation";
import { collectDrillReport } from "@/lib/operations/dr/drill-report-repository";
import { reportDrill } from "@/lib/operations/dr/drill-report";
import { contentHash, promotionPlanHash, type PromotionPlan } from "@/lib/operations/dr/promotion";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// DR·모델 장부 근거는 지울 수 없다(append-only). 공유 test DB를 건드리지 않도록 이 파일만의 DB를 만들고 끝에 지운다.
const root = fileURLToPath(new URL("../..", import.meta.url));
const name = `nomorevibe_test_pr17a_${randomBytes(6).toString("hex")}`;
const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
let client: postgres.Sql, created = false, ledgerPreexisting = false, journalLength = 0, promotedId = "";
const database = () => drizzle(client, { schema });
const MIN = 60_000, HOUR = 3_600_000;
let S = 0, E = 0;
const t = (ms: number) => new Date(S + ms).toISOString();

/** 공개·drizzle 스키마의 모든 표 내용과 sequence 값. 수집 전후가 같아야 쓰기 0이다. */
async function digest(): Promise<string> {
  const tables = await client<{ name: string }[]>`select format('%I.%I', schemaname, tablename) as name from pg_tables
    where schemaname in ('public', 'drizzle') order by 1`;
  const parts: string[] = [];
  for (const table of tables) {
    const [row] = await client.unsafe(`select count(*)::text as count, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as hash from ${table.name} t`);
    parts.push(`${table.name}:${row.count}:${row.hash}`);
  }
  const sequences = await client`select schemaname, sequencename, last_value::text from pg_sequences where schemaname in ('public', 'drizzle') order by 1, 2`;
  return JSON.stringify([parts, sequences]);
}
const naive = (iso: string) => client`(${iso}::timestamptz at time zone 'utc')`;
const jsonb = (value: unknown) => client`${JSON.stringify(value)}::text::jsonb`;

beforeAll(async () => {
  ensureSchema();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${name}`); created = true; } finally { await admin.end({ timeout: 5 }); }
  client = postgres(url.toString(), { max: 4, onnotice: () => {} });
  await client.unsafe("set statement_timeout = 0");
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const [applied] = await client`select count(*)::int as count from drizzle.__drizzle_migrations`;
  journalLength = journal.entries.length;
  expect(applied.count).toBe(journalLength);
  [{ present: ledgerPreexisting }] = await client`select to_regclass('public.pipeline_evidence_events') is not null as present`;
  const [clock] = await client`select to_char(date_trunc('second', now()) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`;
  E = Date.parse(clock.now) - 5 * MIN; S = E - HOUR;
}, 600_000);
afterAll(async () => {
  await client?.end({ timeout: 5 });
  if (!created) return;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { acct: 1, acct2: 1 }, groupLimits: { g: 2, g2: 1 },
  poolLimits: { reviewer: 2, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 8, queueTtlMs: 600_000, reservationTtlMs: 600_000,
  routes: [{ routeId: "r1", provider: "p", model: "m", providerBudgetId: "acct", groupId: "g" },
    { routeId: "r2", provider: "p", model: "m2", providerBudgetId: "acct2", groupId: "g2" }] };
const policyHash = modelCapacityPolicyHash(policy), oldHash = "c".repeat(64);
type Ledger = { route: "r1" | "r2"; kind: "first" | "second" | "background"; state: string; reservedUntil: number | null; queueUntil: number;
  hash?: string; events: [string, string | null, string, number][] };
/** 시각은 구간 시작 S 기준 ms. 이벤트: [kind, from, to, at]. */
async function ledger(rows: Ledger[]) {
  for (const row of rows) {
    const id = randomUUID(), r2 = row.route === "r2", queued = row.events[0][3];
    const hash = row.hash ?? policyHash, token = row.reservedUntil === null ? null : randomUUID();
    await client`insert into model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
        provider_budget_id, group_id, epoch, revision, policy_hash, state, token, reserved_until, queued_at, queue_until, updated_at)
      values (${id}, ${`pr17a:${id}`}, 'pr17a-owner', ${randomUUID()}, ${row.kind}, ${row.kind === "background" ? "text" : "reviewer"}, ${row.route}, 'p',
        ${r2 ? "m2" : "m"}, ${r2 ? "acct2" : "acct"}, ${r2 ? "g2" : "g"}, 1, 1, ${hash}, ${row.state}, ${token},
        ${row.reservedUntil === null ? null : t(row.reservedUntil)}::timestamptz, ${t(queued)}::timestamptz, ${t(row.queueUntil)}::timestamptz,
        ${t(row.events.at(-1)![3])}::timestamptz)`;
    for (const [kind, from, to, at] of row.events) await client`insert into model_capacity_events (request_id, kind, epoch, revision, policy_hash,
      from_state, to_state, created_at) values (${id}, ${kind}, 1, 1, ${hash}, ${from}, ${to}, ${t(at)}::timestamptz)`;
  }
}

async function fixtures() {
  const candidates = await client<{ id: number }[]>`insert into crawl_candidates (repo) values ('pr17a/c1'), ('pr17a/c2'), ('pr17a/c3') returning id`;
  const [c1, c2, c3] = candidates.map(row => row.id);
  const attempt = async (candidate: number, number: number, state: string, completed: number, extra: { error?: string | null; provider?: string;
    reused?: number } = {}) => (await client<{ id: number }[]>`insert into crawl_review_attempts (candidate_id, state, input_hash, policy_hash,
      source_revision_hash, snapshot, source, prompt_version, rules_version, attempt_number, valid_until, provider, error_code, reused_from_attempt_id,
      started_at, completed_at) values (${candidate}, ${state}, ${"a".repeat(64)}, ${"a".repeat(64)}, ${"a".repeat(64)}, '{}'::jsonb, '{}'::jsonb, 'p1', 'r1',
      ${number}, ${naive(t(HOUR * 48))}, ${extra.provider ?? "abcllm"}, ${extra.error ?? null}, ${extra.reused ?? null}, ${naive(t(completed - 1000))},
      ${naive(t(completed))}) returning id`)[0].id;
  const a1 = await attempt(c1, 1, "succeeded", 10 * MIN);
  await attempt(c2, 1, "failed", 20 * MIN, { error: "timeout" });
  await attempt(c3, 1, "failed", 30 * MIN, { error: "cancelled" });
  await attempt(c1, 2, "succeeded", -10 * MIN);
  await attempt(c2, 2, "succeeded", 40 * MIN, { reused: a1 });
  await attempt(c3, 2, "succeeded", 41 * MIN, { provider: "rules" });
  await attempt(c3, 3, "failed", HOUR);
  for (const [repo, at] of [["d1", 5 * MIN], ["d2", 50 * MIN], ["d3", -MIN], ["d4", HOUR], ["d5", 0]] as const)
    await client`insert into crawl_documents (repo, repo_meta, fetched_at) values (${`pr17a/${repo}`}, '{}'::jsonb, ${naive(t(at))})`;
  for (const [slug, source, repoUrl, at] of [["p1", "crawler", "https://github.com/pr17a/dup", 15 * MIN],
    ["p2", "crawler", "https://www.github.com/PR17A/dup.git/", 16 * MIN], ["p3", "crawler", "https://github.com/pr17a/other", 17 * MIN],
    ["p4", "skill", "https://github.com/pr17a/skill", 18 * MIN]] as const)
    await client`insert into products (slug, url, name, tagline, description, category, verify_token, edit_token_hash, source, repo_url, created_at)
      values (${`pr17a-${slug}`}, ${`https://${slug}.example`}, ${slug}, 'tag', 'desc', 'other', ${`v-${slug}`}, ${`h-${slug}`}, ${source}, ${repoUrl}, ${naive(t(at))})`;
  await client`insert into second_reviews (candidate_id, repo, trigger, first_decision, input_hash, reviewed_at)
    values (${c1}, 'pr17a/c1', 'ai_approved', 'approve', ${"a".repeat(64)}, ${naive(t(25 * MIN))}),
      (${c2}, 'pr17a/c2', 'ai_approved', 'approve', ${"b".repeat(64)}, null)`;
  await client`insert into role_leases (role, owner_instance_id, owner_boot_id, epoch) values ('reviewer', 'm3-reviewer', 'b-m3', 5)`;
  await client`insert into jobs (name, runs, last_run_at, last_success_at, last_error) values
    ('crawl-agent-review', 10, ${naive(t(50 * MIN))}, ${naive(t(50 * MIN))}, null),
    ('crawl-fetch', 3, ${naive(t(55 * MIN))}, ${naive(t(-5 * MIN))}, 'boom'),
    ('second-review', 1, ${naive(t(HOUR + 2 * MIN))}, ${naive(t(HOUR + 2 * MIN))}, null)`;
  await client`insert into operations_observations (key, value) values
    ('batch-result:mini-reviewer:crawl-agent-review', ${jsonb({ batchResult: { role: "reviewer", batchEpoch: 1, job: "crawl-agent-review",
      instanceId: "mini-reviewer", host: "mini", release: "r1", bootId: "b", recordedAt: t(20 * MIN), count: 1, requestedVersion: 1 } })}),
    ('batch-result:bad:x', '{}'::jsonb)`;
  await client`insert into dr_fence_events (lineage_id, from_epoch, to_epoch, from_state, to_state, reason, db_identity, operator, created_at) values
    (${randomUUID()}, 1, 1, 'active', 'fenced', 'operator_fence', '{}'::jsonb, 'pr17a', ${t(5 * MIN)}::timestamptz),
    (${randomUUID()}, 1, 1, 'active', 'fenced', 'operator_fence', '{}'::jsonb, 'pr17a', ${t(-5 * MIN)}::timestamptz)`;
  await client`update model_capacity_control set mode = 'open', policy = ${jsonb(policy)}, policy_hash = ${policyHash},
    updated_at = ${t(-HOUR)}::timestamptz where id = 1`;
  await client`update pipeline_stage_modes set updated_at = ${t(-HOUR)}::timestamptz`;
  await ledger([
    // q1: 구간 전부터 대기 → 1분에 예약 → 보낸 뒤 indeterminate로 끝까지 점유(acct 한도 1을 채운다).
    { route: "r1", kind: "first", state: "indeterminate", reservedUntil: 11 * MIN, queueUntil: 30 * MIN, events: [["queued", null, "waiting", -5 * MIN],
      ["reserved", "waiting", "reserved", MIN], ["dispatch_started", "reserved", "dispatched", MIN + 1000],
      ["dispatch_indeterminate", "dispatched", "indeterminate", 10 * MIN]] },
    // q2: 같은 acct라 포화 대기. queue_until(15분)에서 끝난 것으로 보고 늦은 만료 이벤트(20분)는 대기로 세지 않는다.
    { route: "r1", kind: "second", state: "withdrawn", reservedUntil: null, queueUntil: 15 * MIN, events: [["queued", null, "waiting", 2 * MIN],
      ["wait_expired", "waiting", "withdrawn", 20 * MIN]] },
    // q3: 다른 budget·text pool — 빈 슬롯이 있는데 5분 대기, 보내지 않은 예약은 reserved_until(40분)까지만 점유.
    { route: "r2", kind: "background", state: "withdrawn", reservedUntil: 40 * MIN, queueUntil: HOUR, events: [["queued", null, "waiting", 30 * MIN],
      ["reserved", "waiting", "reserved", 35 * MIN], ["reservation_expired", "reserved", "withdrawn", 50 * MIN]] },
    // q4: 옛 정책 hash — 한도를 알 수 없어 unknown.
    { route: "r1", kind: "first", state: "withdrawn", reservedUntil: null, queueUntil: 2 * HOUR, hash: oldHash,
      events: [["queued", null, "waiting", 45 * MIN], ["policy_changed", "waiting", "withdrawn", 48 * MIN]] },
    // q5: 구간 전에 끝난 요청은 읽지 않는다.
    { route: "r1", kind: "first", state: "withdrawn", reservedUntil: null, queueUntil: -10 * MIN, events: [["queued", null, "waiting", -30 * MIN],
      ["wait_expired", "waiting", "withdrawn", -20 * MIN]] },
  ]);
}

const EXPECTED_SLOTS = {
  all: { waitingMs: 1_320_000, freeWhileWaitingMs: 360_000, fullWhileWaitingMs: 780_000, unknownWhileWaitingMs: 180_000, busyMs: 3_540_000 },
  scopes: [
    { routeId: "r1", class: "first", waitingMs: 240_000, freeWhileWaitingMs: 60_000, fullWhileWaitingMs: 0, unknownWhileWaitingMs: 180_000, busyMs: 3_540_000 },
    { routeId: "r1", class: "second", waitingMs: 780_000, freeWhileWaitingMs: 0, fullWhileWaitingMs: 780_000, unknownWhileWaitingMs: 0, busyMs: 0 },
    { routeId: "r2", class: "background", waitingMs: 300_000, freeWhileWaitingMs: 300_000, fullWhileWaitingMs: 0, unknownWhileWaitingMs: 0, busyMs: 300_000 },
  ] };

it("collects a fixed 24h-style observation with exact values and leaves the database byte-identical", async () => {
  await fixtures();
  const before = await digest();
  const snapshot = await collectPipelineSnapshot(database(), "primary");
  expect(snapshot).toMatchObject({ scope: "pipeline_snapshot", roles: [{ role: "reviewer", epoch: 5, ownerInstanceId: "m3-reviewer" }],
    controls: { modelCapacity: { mode: "open", epoch: 1, revision: 1 }, writerFence: { state: "active", writerEpoch: 1 } } });
  expect(await digest()).toBe(before);

  // 스냅숏 뒤 인계 한 번(epoch 5→7, 소유자 변경)과 잡 실행 15회.
  await client`update role_leases set epoch = 7, owner_instance_id = 'mini-reviewer', owner_boot_id = 'b-mini' where role = 'reviewer'`;
  await client`update jobs set runs = 25 where name = 'crawl-agent-review'`;
  const changed = await digest();
  const options = { runId: "pr17a-it", revision: "10238904", endedAt: new Date(E).toISOString(), hours: 1, target: "primary" as const };
  const late = await collectPipelineObservation(database(), { ...options, baseline: snapshot });
  // 실제 스냅숏은 구간 시작 뒤에 찍혔다: 인계는 미검증으로 남아야 한다.
  expect(reportPipelineObservation(late).roles.find(row => row.role === "reviewer")).toMatchObject({ handoff: { status: "unverified" } });
  expect(reportPipelineObservation(late).evidenceIssues).toContain("baseline_after_window_start");
  // 같은 스냅숏 값을 구간 시작 전 기준으로 놓으면 차이가 그대로 인계·실행 수가 된다.
  const artifact = await collectPipelineObservation(database(), { ...options, baseline: { ...snapshot, capturedAt: t(-MIN) } });
  expect(await digest()).toBe(changed);

  expect(artifact.window).toMatchObject({ startedAt: t(0), endedAt: t(HOUR), durationMs: HOUR });
  expect(artifact.schema).toEqual({ appliedMigrations: journalLength, absentTables: ledgerPreexisting ? [] : ["pipeline_evidence_events"] });
  expect(artifact.ai1).toEqual({ calls: 3, technicalFailures: 2, cancelled: 1 });
  expect(artifact.duplicatePublications).toBe(2);
  expect(artifact.acks).toEqual({ rows: [{ role: "reviewer", job: "crawl-agent-review", instanceId: "mini-reviewer", host: "mini", recordedMs: 20 * MIN }],
    invalid: 1 });
  expect(artifact.fenceEvents).toEqual([{ reason: "operator_fence", fromEpoch: 1, toEpoch: 1, atMs: 5 * MIN }]);
  expect(artifact.ledger.status).toBe(ledgerPreexisting ? "marker_missing" : "absent");

  const report = reportPipelineObservation(artifact);
  expect(report.roles.find(row => row.role === "reviewer")).toEqual({ role: "reviewer", owner: "mini-reviewer", epoch: 7,
    handoff: { status: "verified", epochDelta: 2, ownerChanged: true },
    jobs: [{ name: "crawl-agent-review", ranInWindow: true, succeededInWindow: true, failingAtCollection: false, runsDelta: 15 },
      { name: "second-review", ranInWindow: null, succeededInWindow: null, failingAtCollection: false, runsDelta: 0 }],
    acks: [{ instanceId: "mini-reviewer", job: "crawl-agent-review", host: "mini", latestInWindow: true }],
    readback: [{ stage: "crawl-agent-review", rows: 6 }, { stage: "second-review", rows: 1 }] });
  expect(report.roles.find(row => row.role === "crawler")).toMatchObject({ handoff: { status: "verified", epochDelta: 0, ownerChanged: false },
    jobs: [{ name: "crawl-fetch", ranInWindow: true, succeededInWindow: false, failingAtCollection: true, runsDelta: 0 }],
    readback: [{ stage: "crawl-fetch", rows: 3 }] });
  expect(report.roles.find(row => row.role === "publisher")?.readback).toEqual([{ stage: "crawl-publish", rows: 3 }]);
  expect(report.roles.find(row => row.role === "translation")?.readback.map(row => row.rows)).toEqual([0, 0, 0]);
  expect(report.controls.writerFence).toEqual({ state: "active", now: 1, delta: 0, eventsInWindow: [{ reason: "operator_fence", fromEpoch: 1, toEpoch: 1 }] });
  expect(report.stageFailures).toEqual([
    { stage: "ai1", status: "verified", calls: 3, failed: 2, rate: 2 / 3 }, { stage: "ai2", status: "unverified", calls: null, failed: null, rate: null },
    { stage: "model:r1:first", status: "verified", calls: 1, failed: 1, rate: 1 },
    { stage: "model:r1:second", status: "verified", calls: 0, failed: 0, rate: null },
    { stage: "model:r2:background", status: "verified", calls: 0, failed: 0, rate: null }]);
  expect(report.modelLedger).toEqual({ mode: "open", openAtCollection: [{ routeId: "r1", class: "first", state: "indeterminate", count: 1 }], routes: [
    { routeId: "r1", class: "first", queued: 1, reserved: 1, dispatched: 1, settled: 0, indeterminate: 1, released: 0, withdrawn: 1, indeterminateRate: 1 },
    { routeId: "r1", class: "second", queued: 1, reserved: 0, dispatched: 0, settled: 0, indeterminate: 0, released: 0, withdrawn: 1, indeterminateRate: null },
    { routeId: "r2", class: "background", queued: 1, reserved: 1, dispatched: 0, settled: 0, indeterminate: 0, released: 0, withdrawn: 1, indeterminateRate: null }] });
  expect({ all: report.slots?.all, scopes: report.slots?.scopes }).toEqual(EXPECTED_SLOTS);
  expect(report.safety).toEqual({ duplicatePublications: { status: "verified", count: 2 }, humanDecisionOverrides: { status: "unverified" },
    leaseViolations: { status: "unverified" } });
  expect(report.violations).toEqual(["duplicatePublications"]);
  expect(report.evidenceIssues).toEqual(expect.arrayContaining([`evidence_ledger_${ledgerPreexisting ? "marker_missing" : "absent"}`, "slot_limits_unknown"]));
}, 120_000);

it("counts the 0097 evidence ledger only when its recorder marker precedes the window", async () => {
  // 0097(PR01b-8)이 아직 이 base에 없으면 같은 열의 표를 이 임시 DB에만 만든다(migration 아님).
  if (!ledgerPreexisting) await client.unsafe(`create table pipeline_evidence_events (id bigserial primary key, kind varchar(28) not null,
    stage varchar(3), candidate_id integer, first_attempt_id integer, second_review_id integer, root_review_id integer, failed boolean,
    code varchar(60), revision varchar(40), operator varchar(120), created_at timestamptz(3) not null default clock_timestamp())`);
  const options = { runId: "pr17a-ledger", revision: "10238904", endedAt: t(HOUR), hours: 1, target: "primary" as const, baseline: null };
  expect((await collectPipelineObservation(database(), options)).ledger).toEqual({ status: "marker_missing", startedAt: null, counts: null });
  await client`insert into pipeline_evidence_events (kind, revision, operator, created_at) values ('recorder_started', '10238904', 'pr17a', ${t(-HOUR)}::timestamptz)`;
  const event = (kind: string, at: number, extra: { root?: number; failed?: boolean } = {}) => client`insert into pipeline_evidence_events
    (kind, stage, candidate_id, first_attempt_id, second_review_id, root_review_id, failed, code, created_at)
    values (${kind}, ${kind === "ai2_attempt" ? "ai2" : "ai1"}, 1, 1, 1, ${extra.root ?? null}, ${extra.failed ?? null}, 'x', ${t(at)}::timestamptz)`;
  await event("lease_violation", 10 * MIN); await event("human_decision_refused", 11 * MIN); await event("human_decision_refused", 12 * MIN);
  await event("late_write_refused", 13 * MIN); await event("ai2_attempt", 14 * MIN, { root: 1, failed: true });
  await event("ai2_attempt", 15 * MIN, { root: 1, failed: false }); await event("ai2_attempt", 16 * MIN, { root: 2, failed: false });
  await event("ai2_attempt", -MIN, { root: 3, failed: true }); await event("lease_violation", HOUR + 1);
  const before = await digest();
  const artifact = await collectPipelineObservation(database(), options);
  expect(await digest()).toBe(before);
  expect(artifact.ledger).toEqual({ status: "covered", startedAt: t(-HOUR), counts: { humanDecisionOverrides: 0, leaseViolations: 1,
    humanDecisionRefusals: 2, lateWritesRefused: 1, ai2Calls: 3, ai2Failed: 1, ai2Chains: 2 } });
  const report = reportPipelineObservation(artifact);
  expect(report.violations).toEqual(["duplicatePublications", "leaseViolations"]);
  expect(report.stageFailures[1]).toEqual({ stage: "ai2", status: "verified", calls: 3, failed: 1, rate: 1 / 3 });
  // marker가 구간 시작 뒤면 장부로 세지 않는다.
  expect((await collectPipelineObservation(database(), { ...options, endedAt: t(-50 * MIN), hours: .25 })).ledger)
    .toEqual({ status: "marker_after_start", startedAt: t(-HOUR), counts: null });
}, 120_000);

const P = () => E + 3 * MIN, F = () => P() - 30 * MIN;
const at = (ms: number) => new Date(ms).toISOString();
async function promotion(input: { state: "sealed" | "promoted"; stops: [string, number, number][]; badHash?: boolean }) {
  const promotionId = randomUUID(), lineageId = randomUUID();
  const plan: PromotionPlan = { version: 1, promotionId, lineageId, fromEpoch: 1, knownActiveEpoch: 1,
    restoredDb: { systemIdentifier: "7000000000000000001", databaseOid: "16384", databaseName: "restored" },
    oldDbs: [{ systemIdentifier: "7000000000000000002", databaseOid: "16384", databaseName: "nomorevibe" }], oldInstances: ["m3-reviewer"],
    snapshotAt: at(F() - 4 * MIN), operator: "pr17a-test" };
  const seal = { version: 1, sealedAt: at(F() + 10 * MIN), instances: ["m3-reviewer", "mini-crawler"], modelBudgets: [], activeModelCalls: 0, activeHttpHops: 0,
    revoked: { roles: 0, jobs: 0, items: 0, sourceClaims: 0 }, modelControl: { epoch: 2, revision: 2, mode: "disabled" }, httpControl: { epoch: 2, mode: "disabled" } };
  await client`insert into dr_promotions (promotion_id, lineage_id, from_epoch, to_epoch, state, plan, plan_hash, db_identity, seal_snapshot, operator, sealed_at, promoted_at)
    values (${promotionId}, ${lineageId}, 1, 2, ${input.state}, ${jsonb(plan)}, ${promotionPlanHash(plan)}, ${jsonb(plan.restoredDb)},
      ${jsonb(seal)}, 'pr17a-test', ${at(F() + 10 * MIN)}::timestamptz, ${input.state === "promoted" ? at(P()) : null}::timestamptz)`;
  for (const [instanceId, stoppedAt, skewBoundMs] of input.stops) {
    const payload = { version: 1, instanceId, method: "control_plane_stopped", reference: "drill-log#1", autoRestartDisabled: true, stoppedAt: at(stoppedAt), skewBoundMs };
    await client`insert into dr_promotion_evidence (promotion_id, kind, subject, payload, payload_hash, operator)
      values (${promotionId}, 'writer_process_stopped', ${instanceId}, ${jsonb(payload)}, ${input.badHash ? "0".repeat(64) : contentHash(payload)}, 'pr17a-test')`;
  }
  return promotionId;
}

it("records DR drill RPO/RTO from promotion evidence and leaves missing values unknown", async () => {
  // 승격 완료 뒤 첫 잡 성공: 마이크로초가 있어도 ms 올림(상한 유지).
  await client`insert into jobs (name, runs, last_success_at) values ('dr-probe', 1, ${naive(at(P()))} + interval '90.0005 seconds'),
    ('dr-old', 1, ${naive(at(P() - 1000))})`;
  const promoted = promotedId = await promotion({ state: "promoted", stops: [["m3-reviewer", F() + MIN, 1000], ["mini-crawler", F() + 30_000, 2000],
    ["m3-reviewer", F() + 2 * MIN, 1000]] });
  const sealed = await promotion({ state: "sealed", stops: [["m3-reviewer", F() + MIN, 1000]] });
  const tampered = await promotion({ state: "promoted", stops: [["m3-reviewer", F() + MIN, 1000]], badHash: true });
  const before = await digest();
  const artifact = await collectDrillReport(database(), { promotionId: promoted, failureAt: at(F()), target: "primary" });
  expect(artifact.writers).toEqual({ required: ["m3-reviewer", "mini-crawler"], stops: [
    { instanceId: "m3-reviewer", stoppedAt: at(F() + 2 * MIN), skewBoundMs: 1000, method: "control_plane_stopped" },
    { instanceId: "mini-crawler", stoppedAt: at(F() + 30_000), skewBoundMs: 2000, method: "control_plane_stopped" }] });
  expect(reportDrill(artifact)).toMatchObject({ state: "promoted", rpoMs: 240_000, writeWindowMs: 360_000, maxSkewMs: 2000,
    rtoPromotionMs: 1_800_000, rtoFirstJobSuccessAtMostMs: 1_890_001, unknown: {}, issues: [] });
  expect(reportDrill(await collectDrillReport(database(), { promotionId: promoted, failureAt: null, target: "primary" })).unknown)
    .toEqual({ rpo: "failure_time_undeclared", rtoPromotion: "failure_time_undeclared", rtoFirstJobSuccess: "failure_time_undeclared" });
  expect(reportDrill(await collectDrillReport(database(), { promotionId: sealed, failureAt: at(F()), target: "primary" }))).toMatchObject({
    rpoMs: 240_000, writeWindowMs: null, unknown: { writeWindow: "writer_stop_evidence_missing", rtoPromotion: "promotion_not_completed",
      rtoFirstJobSuccess: "promotion_not_completed" } });
  await expect(collectDrillReport(database(), { promotionId: tampered, failureAt: at(F()), target: "primary" })).rejects.toThrow("dr_evidence_hash_mismatch");
  await expect(collectDrillReport(database(), { promotionId: randomUUID(), failureAt: null, target: "primary" })).rejects.toThrow("dr_promotion_missing");
  await expect(collectDrillReport(database(), { promotionId: promoted, failureAt: null, target: "replica" })).rejects.toThrow("report_target_mismatch");
  expect(await digest()).toBe(before);
}, 120_000);

it("runs every CLI command against an explicit URL without writing to the database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nomorevibe-pr17a-cli-"));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL$|READ_DATABASE_URL$)/.test(key)));
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/pipeline-rollout-report.ts", ...args],
      { encoding: "utf8", env: { ...env, NODE_ENV: "test", PIPELINE_REPORT_DATABASE_URL: url.toString() }, timeout: 60_000 });
    const file = (base: string) => join(directory, base);
    const before = await digest();
    const snapshot = run("snapshot", `--output=${file("snapshot.json")}`);
    expect([snapshot.status, snapshot.stderr]).toEqual([0, ""]);
    expect(JSON.parse(snapshot.stdout)).toMatchObject({ captured: true, roles: 1 });
    const observe = run("observe", "--run=cli", `--end=${t(HOUR)}`, "--hours=1", `--baseline=${file("snapshot.json")}`, `--output=${file("obs.json")}`);
    expect([observe.status, observe.stderr]).toEqual([0, ""]);
    expect(JSON.parse(observe.stdout)).toMatchObject({ collected: true, violations: ["duplicatePublications", "leaseViolations"] });
    const summary = run("report", `--artifact=${file("obs.json")}`);
    expect(summary.status).toBe(3);
    expect(summary.stdout).toContain("## 슬롯 대기 적분");
    const json = run("report", `--artifact=${file("obs.json")}`, "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({ scope: "pipeline_observation", violations: ["duplicatePublications", "leaseViolations"] });
    const drill = run("dr-drill", `--promotion=${promotedId}`, `--failure-at=${at(F())}`, `--output=${file("drill.json")}`);
    expect([drill.status, drill.stderr]).toEqual([0, ""]);
    const drillReport = run("report", `--artifact=${file("drill.json")}`);
    expect([drillReport.status, drillReport.stdout.includes("RPO")]).toEqual([0, true]);
    expect(run("snapshot", `--output=${file("snapshot.json")}`).stderr.trim()).toBe("report_output_exists");
    const future = run("observe", "--run=cli", `--end=${at(Date.now() + HOUR)}`, `--output=${file("future.json")}`);
    expect([future.status, future.stderr.trim()]).toEqual([1, "observation_window_not_finished"]);
    expect(await digest()).toBe(before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
