import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, operationsObservations, products,
  productAuditAttempts, productAuditCampaigns, productAuditItems } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { saveSettings } from "@/lib/crawl/settings";
import { startProductAudit } from "@/lib/crawl/product-audit";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { backgroundConsumerLanes } from "@/lib/jobs/background-consumer";
import { markWorkerSeen, pendingJobNames } from "@/lib/jobs/control";
import { runJob } from "@/lib/jobs/runner";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { claudeCliTokenBound, type CliServingContract } from "@/lib/llm/cli-serving-contract";
import { createProviderCircuits } from "@/lib/llm/provider-circuit-breaker";
import { jobRunOptions, runWorker } from "@/scripts/worker";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";

/*
 * PR06f 실제 DB driver — 실제 배경 consumer 줄(runWorker·backgroundConsumerLanes·pendingJobNames·runJob·공통 슬롯 장부) 위에서 Claude 감사가
 * 연속으로 심사자 없음(REVIEWER_DOWN: missing_cli)을 내면 그 줄의 회로가 열리고, 열린 동안은 job 을 claim 하지 않아 감사 항목·시도·슬롯·잡 행이
 * 그대로이며, half-open 시험 하나로 닫힌다. 자식 프로세스는 tests/fixtures/fake-cli/background.mjs(가짜 CLI)뿐이고 PATH 는 빈 디렉터리다.
 * CLI 계약은 이 파일의 fixture 만 연다(운영 resolver 는 null). 회로 시계는 주입한다.
 */
const fixture = vi.hoisted(() => ({ contracts: [] as CliServingContract[] }));
// Qwen-v2 단계(gpu3090 직접 호출)는 감사 잡 틱 안에서 돈다 — tests/integration/audit-second-opinion-auto.test.ts 가 본다. 여기 틱은 쓸기·감사 묻기만
vi.mock("@/lib/crawl/audit-second-opinion-auto", () => ({ runQwenSecondOpinions: async () => null }));
vi.mock("@/lib/llm/cli-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/cli-serving-contract")>(),
  resolveCliServingContract: (routeId: string, provider: string, model: string) =>
    fixture.contracts.find(value => value.routeId === routeId && value.provider === provider && value.model === model) ?? null,
}));

type Raw = Record<string, unknown>;
const prefix = `pr06f-circuit-${randomUUID().slice(0, 8)}`, ROUTE = "product-audit", AUDIT_MODEL = "sonnet", PROCESS_TEST_MS = 40_000;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const shape = { maxTurns: 2, inputByteCap: 200_000, overheadTokenBound: 20_000, outputTokensPerTurn: 2_000 };
const CONTRACT: CliServingContract = { version: 1, protocol: "cli-process-v1", routeId: ROUTE, provider: "claude-cli", model: AUDIT_MODEL,
  cliVersion: "fake 0.0.0", totalTokenBound: claudeCliTokenBound(shape), costBoundUsdMicros: 150_000, boundProvenance: "derived", ...shape };
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { "claude-sub": 2 }, groupLimits: { reviewers: 4 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 2, second: 2, background: 1 }, maxWaiting: 8, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: ROUTE, provider: "claude-cli", model: AUDIT_MODEL, providerBudgetId: "claude-sub", groupId: "reviewers" }] };
let root = "", bin = "", empty = "", records = "", originalControl: Raw, sequence = 0;

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const tags = journal.entries.map((entry: { tag: string }) => entry.tag);
  for (const tag of ["0082_job_batches", "0094_model_capacity_cli_process_terminal"]) expect(tags).toContain(tag);
  const [applied] = await admin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  [{ row: originalControl }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  // 허가는 전체 활성 행을 센다 — 앞선 파일이 남긴 활성 호출이 있으면 이 파일의 허가 결과가 달라진다
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toHaveLength(0);
  root = await mkdtemp(path.join(os.tmpdir(), "nmv-bg-cli-circuit-db-"));
  empty = path.join(root, "empty-path"); records = path.join(root, "records"); await mkdir(empty); await mkdir(records);
  const script = path.resolve("tests/fixtures/fake-cli/background.mjs");
  for (const value of [root, script, process.execPath]) expect(value).not.toContain("'");
  bin = path.join(root, "fake-cli"); await writeFile(bin, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`); await chmod(bin, 0o755);
});
beforeEach(async () => {
  fixture.contracts = [CONTRACT];
  for (const [key, value] of Object.entries({ PATH: empty, CLAUDE_CLI: bin, FAKE_CLI_RECORD: records, SERVICE_INSTANCE_ID: prefix,
    ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: prefix, ROLE_LEASE_BOOT_ID: randomUUID(), ROLE_LEASE_RELEASE: "local-cli-circuit",
    ROLE_LEASE_EPOCH: "1" })) vi.stubEnv(key, value);
  await cleanLedger(); await cleanDomain();
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},
    cursor=0,updated_at=clock_timestamp() WHERE id=1`;
});
afterEach(async () => {
  try {
    for (const name of await readdir(records)) await rm(path.join(records, name));
    await cleanLedger(); await restoreControl(); await cleanDomain();
  } finally { vi.unstubAllEnvs(); }
});
afterAll(async () => {
  try { await cleanLedger(); await restoreControl(); }
  finally { fixture.contracts = []; await rm(root, { recursive: true, force: true }); await admin.end(); }
});

/** 이 파일의 주인(prefix)이 남긴 장부 행만 지운다. 사건 표는 지울 수 없게 막혀 있어 트리거를 잠깐 끄고 되돌린 것까지 확인한다 */
async function cleanLedger() {
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = (await tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix} AND route_id=${ROUTE} FOR UPDATE`)
      .map(row => row.request_id);
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    expect(Array.from(await tx`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`))
      .toEqual([{ tgname: "model_capacity_events_no_change", tgenabled: "A" }, { tgname: "model_capacity_events_no_truncate", tgenabled: "A" }]);
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
  });
}
async function restoreControl() {
  await admin`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,
    updated_at=r.updated_at FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
  const [{ row }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  expect(row).toEqual(originalControl);
}
async function cleanDomain() {
  await db.delete(productAuditAttempts); await db.delete(productAuditItems); await db.delete(productAuditCampaigns);
  await db.delete(crawlReviewAttempts); await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(operationsObservations).where(eq(operationsObservations.key, `job:${ROUTE}`));
  await db.delete(jobs).where(eq(jobs.name, ROUTE));
  await resetTables();
}
async function listed(repo: string) {
  const slug = repo.split("/")[1], url = `https://${slug}.test`;
  await db.insert(products).values({ slug, url, name: slug, tagline: "한 줄", description: "소개", category: "Productivity",
    status: "seeded", source: "crawler", verifyToken: `token-${++sequence}`, editTokenHash: "h".repeat(64) });
  await crawl.putDocument({ repo, productUrl: url, pageStatus: 200,
    repoMeta: { description: "레포", stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: "User" } },
    pageMeta: { title: slug, textSample: "쓸 수 있는 앱" } });
  await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", reason: "passed", decidedBy: "auto",
    publishedSlug: slug, judgedAt: new Date(), decidedAt: new Date() });
}
/** scheduler 의 다음 요청 — 실패 뒤 30초 유예도 지난 것으로 둔다 */
async function arm() {
  await db.insert(jobs).values({ name: ROUTE }).onConflictDoNothing();
  await db.update(jobs).set({ requestedVersion: 10, processedVersion: 8, notBefore: null, lockedAt: null, leaseToken: null }).where(eq(jobs.name, ROUTE));
}
const rows = async (query: Promise<{ row: unknown }[]>) => (await query).map(({ row }) => row as Raw);
const items = () => rows(admin`SELECT to_jsonb(i) AS row FROM product_audit_items i ORDER BY id`);
const attempts = () => rows(admin`SELECT to_jsonb(a) AS row FROM product_audit_attempts a ORDER BY id`);
const requests = () => rows(admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal`);
// worker_seen_at 은 poll 마다 바뀌는 생존 표시다 — claim(runs·last_run_at·lease)과 요청 상태만 본다
const jobRow = async () => (await rows(admin`SELECT to_jsonb(j) - 'worker_seen_at' AS row FROM jobs j WHERE name=${ROUTE}`))[0];
const snapshot = async () => ({ items: await items(), attempts: await attempts(), requests: await requests(), job: await jobRow(),
  campaigns: await rows(admin`SELECT to_jsonb(c) AS row FROM product_audit_campaigns c ORDER BY id`) });

it("consecutive REVIEWER_DOWN in the real consumer lane opens its circuit; while open nothing is claimed and no item, attempt, slot or job row moves; a passing trial closes it", async () => {
  await saveSettings({ enabled: true, firstReview: { provider: "claude-cli", model: AUDIT_MODEL }, reviewConcurrency: 1 }, "test");
  await listed("audit/first"); await listed("audit/second");
  expect(await startProductAudit({ startedBy: "jr", reason: "회로 확인", reauditKept: false })).toMatchObject({ ok: true, enrolled: 2 });
  const clock = { now: 0 }, events: Raw[] = [], logs: Raw[] = [];
  const circuits = createProviderCircuits({ mode: "enabled", failures: 2, openMs: 30_000 }, { now: () => clock.now,
    log: (event, fields) => events.push({ event, ...fields }) });
  // scripts/worker.ts main 과 같은 연결(roleLease 만 뺀다 — 역할 lease 행은 이 파일의 대상이 아니다)
  const consumer = { ...backgroundConsumerLanes([ROUTE], (name, options) => runJob(name, auditPublishedProducts, jobRunOptions(name, options))), circuits };
  const tick = () => runWorker({ role: "reviewer", once: true }, { names: [ROUTE], pending: () => pendingJobNames("reviewer"), seen: markWorkerSeen,
    run: async () => { throw new Error("legacy_lane_unused"); }, consumer, log: (event, fields) => { logs.push({ event, ...fields }); } });

  // 없는 CLI(ENOENT) — 감사의 기존 REVIEWER_DOWN(missing_cli)
  vi.stubEnv("CLAUDE_CLI", path.join(root, "absent-cli"));
  await arm(); await tick();
  expect(events).toEqual([]);
  await arm(); await tick();
  expect(events).toEqual([{ event: "provider_circuit.opened", key: ROUTE, failures: 2, error: "missing_cli", openMs: 30_000 }]);
  // 기존 동작 그대로: 틱마다 claim 하고 슬롯을 얻어 띄우려다 실패, 세지 않는 시도 행, 잡은 실패로 남는다
  expect(logs).toEqual([{ event: "worker.job", role: "reviewer", name: ROUTE, status: "failed", consumer: true },
    { event: "worker.job", role: "reviewer", name: ROUTE, status: "failed", consumer: true }]);
  expect((await attempts()).map(row => row.error_code)).toEqual(["missing_cli", "missing_cli"]);
  expect((await items()).map(row => [row.attempts, row.ai_decision])).toEqual([[0, null], [0, null]]);
  expect(await jobRow()).toMatchObject({ runs: 2, processed_version: 8, last_error: "product_audit_reviewer_unavailable:missing_cli" });
  expect((await requests()).map(row => [row.state, (row.terminal_evidence as { process?: Raw } | null)?.process?.ending]))
    .toEqual([["settled", "spawn_failed"], ["settled", "spawn_failed"]]);

  // 열린 동안: 요청이 있어도(유예 지남) claim 하지 않는다 — 항목·시도·슬롯·잡 행이 그대로다
  await arm();
  const before = await snapshot();
  logs.length = 0;
  await tick();
  expect(logs).toEqual([{ event: "worker.job", role: "reviewer", name: ROUTE, status: "deferred", reason: "provider_circuit_open", consumer: true }]);
  expect(await snapshot()).toEqual(before);
  expect(await readdir(records)).toEqual([]);

  // half-open 시험 하나가 실제 CLI 결과를 내면 닫힌다 — 같은 틱의 다음 항목은 닫힌 회로에서 돈다
  clock.now = 30_000; vi.stubEnv("CLAUDE_CLI", bin); vi.stubEnv("FAKE_CLI_MODE", "ok");
  logs.length = 0;
  await arm(); await tick();
  expect(events.map(row => row.event)).toEqual(["provider_circuit.opened", "provider_circuit.half_open", "provider_circuit.closed"]);
  expect(logs).toEqual([{ event: "worker.job", role: "reviewer", name: ROUTE, status: "completed", consumer: true }]);
  expect((await items()).map(row => [row.attempts, row.ai_decision])).toEqual([[1, "approve"], [1, "approve"]]);
  expect(await jobRow()).toMatchObject({ runs: 3, processed_version: 10, last_error: null });
  expect(await readdir(records)).toHaveLength(2);
}, PROCESS_TEST_MS);
