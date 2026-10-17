import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, jobs } from "@/lib/db/schema";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";

/** 가짜 게이트웨이(loopback)와 테스트용 serving 계약. 운영 resolver는 그대로 null이며 이 파일 안에서만 대체한다. */
const fake = vi.hoisted(() => ({ origin: "", contracts: false, requests: [] as { model: string; repo: string }[], delayMs: 20 }));
const contract = (routeId: string, model: string) => ({ version: 1 as const, protocol: "abcllm-raw-total-bound-v1" as const, routeId, provider: "abcllm" as const,
  model, responseModel: model, deploymentRevision: "replay-fixture", endpoint: `${fake.origin}/v1/chat/completions`, totalTokenBound: 40_000 });
vi.mock("@/lib/crawl/agent-review-serving-contract", async load => ({ ...await load<typeof import("@/lib/crawl/agent-review-serving-contract")>(),
  resolveAi1GatewayServingContract: (model: string) => fake.contracts ? contract("crawl-agent-review", model) : null }));
vi.mock("@/lib/crawl/second-review-serving-contract", async load => ({ ...await load<typeof import("@/lib/crawl/second-review-serving-contract")>(),
  resolveAi2GatewayServingContract: (model: string) => fake.contracts ? contract("second-review", model) : null }));

const FIRST = "replay-first", SECOND = "replay-second", REPOS = ["fixture/good-one", "fixture/bad-two", "fixture/good-three", "fixture/good-four", "fixture/bad-five", "fixture/good-six"];
const TIMING = { minimumWindowMs: 10_000, leadMs: 1_500, drainMs: 60_000, collectMs: 10_000 };
let server: Server, original: { stages: Record<string, unknown>[]; capacity: Record<string, unknown> };
let modules: Awaited<ReturnType<typeof load>>, savedEnv: Record<string, string | undefined> = {};
async function load() {
  const [repository, settings, review, crawl, fixed, runner, schema, readme] = await Promise.all([
    import("@/lib/operations/pipeline-replay-fixed-input-repository"), import("@/lib/crawl/settings-schema"),
    import("@/lib/crawl/agent-review-repository"), import("@/lib/crawl/repository"), import("@/lib/operations/pipeline-replay-fixed-input"),
    import("@/lib/operations/pipeline-replay-model-runner"), import("@/lib/db/schema"), import("@/lib/crawl/readme")]);
  return { repository, settings, review, crawl, fixed, runner, schema, readme };
}

function reply(model: string, content: Record<string, unknown>, index: number) {
  return JSON.stringify({ id: `chatcmpl-${index}`, object: "chat.completion", created: 1, model,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1_200, completion_tokens: 40, total_tokens: 1_240 }, usage_provenance: "upstream_reported" });
}
// PR01b-9: replay가 격리 DB에 0097 기록 시작 marker(지울 수 없다)를 남긴다. 공유 test DB에 남으면 다른 파일의 전체 DB 비교·기록이 바뀌므로
// 이 파일은 자기 DB에서 돈다. 격리 관문은 그대로 TEST_DATABASE_URL(loopback·nomorevibe_test)을 검사하고, 전역 클라이언트만 이 DB를 가리킨다.
const own = { name: `nomorevibe_test_pr01b9_replay_${randomBytes(6).toString("hex")}`, client: undefined as postgres.Sql | undefined, created: false };
beforeAll(async () => {
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${own.name}`); own.created = true; } finally { await admin.end({ timeout: 5 }); }
  const url = new URL(TEST_DATABASE_URL); url.pathname = `/${own.name}`;
  own.client = postgres(url.toString(), { max: 8, onnotice: () => {} });
  await own.client.unsafe("set statement_timeout = 0");
  await migrate(drizzle(own.client), { migrationsFolder: path.join(fileURLToPath(new URL("../..", import.meta.url)), "drizzle") });
  const g = globalThis as { db?: unknown; pgClient?: unknown }; g.pgClient = own.client; g.db = drizzle(own.client, { schema });
}, 600_000);
afterAll(async () => {
  const g = globalThis as { db?: unknown; pgClient?: unknown }; delete g.db; delete g.pgClient;
  await own.client?.end({ timeout: 5 });
  if (!own.created) return;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${own.name} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);
beforeAll(async () => {
  ensureSchema();
  server = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body) as { model: string; messages: { content: string }[] };
      const evidence = request.messages[1].content.replace(/^<untrusted_evidence_json>\n/, "").replace(/\n<\/untrusted_evidence_json>$/, "");
      const repo = (JSON.parse(evidence) as { product: { repo: string } }).product.repo;
      fake.requests.push({ model: request.model, repo });
      const decision = request.model === SECOND || repo.includes("/good-") ? "approve" : "reject";
      setTimeout(() => { res.setHeader("content-type", "application/json");
        res.end(reply(request.model, { decision, reason: "Replay fixture decision", evidenceIds: ["product"], confidence: 0.95 }, fake.requests.length)); }, fake.delayMs);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 게이트웨이 모듈은 주소를 import 때 읽는다. 아래 동적 import 전에 정한다.
  savedEnv = { ABCLLM_BASE_URL: process.env.ABCLLM_BASE_URL, ABCLLM_API_KEY: process.env.ABCLLM_API_KEY };
  process.env.ABCLLM_BASE_URL = fake.origin;
  process.env.ABCLLM_API_KEY = "replay-fixture-key";
  modules = await load();
  original = { stages: [...await db.execute<Record<string, unknown>>(sql`select stage, mode, draining_from, epoch, writer_contract_version, updated_at from pipeline_stage_modes`)],
    capacity: (await db.execute<Record<string, unknown>>(sql`select mode, policy, policy_hash, updated_at from model_capacity_control where id = 1`))[0] };
});
async function wipe() {
  await db.execute(sql`truncate second_reviews, crawl_review_attempts, crawl_candidates, crawl_documents, crawl_frontier,
    agent_repository_observations, agent_repository_scans, pipeline_item_leases cascade`);
  // 지울 수 없는 모델 슬롯 장부의 AI1 attemptId는 전역 유일이다. 공용 DB에서 다른 파일이 번호를 되감았어도 겹치지 않게 앞으로 민다.
  await db.execute(sql`select setval('crawl_review_attempts_id_seq', greatest((select last_value from crawl_review_attempts_id_seq),
    (select coalesce(max((dispatch_binding->>'attemptId')::bigint), 0) from model_capacity_requests where dispatch_binding ? 'attemptId') + 1))`);
  // 모델 슬롯 사건은 지울 수 없는 기록(0078 트리거)이라 남긴다. 후보 표와 외래 키로 묶여 있지 않다.
  await db.delete(jobs);
  await resetTables();
}
async function restoreControls() {
  for (const row of original.stages) await db.execute(sql`update pipeline_stage_modes set mode = ${row.mode}, draining_from = ${row.draining_from},
    epoch = ${row.epoch}, writer_contract_version = ${row.writer_contract_version}, updated_at = ${row.updated_at} where stage = ${row.stage}`);
  await db.execute(sql`update model_capacity_control set mode = ${original.capacity.mode}, policy = ${original.capacity.policy ? JSON.stringify(original.capacity.policy) : null}::jsonb,
    policy_hash = ${original.capacity.policy_hash}, updated_at = ${original.capacity.updated_at} where id = 1`);
}
beforeEach(async () => { await wipe(); await restoreControls(); fake.contracts = false; fake.requests.length = 0; fake.delayMs = 20; });
afterAll(async () => {
  await wipe(); await restoreControls(); await db.delete(crawlSettings);
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function settings() {
  const { DEFAULT_CRAWL_SETTINGS } = modules.settings;
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce" as const, reviewConcurrency: 2,
    firstReview: { provider: "abcllm" as const, model: FIRST }, agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enforceEligibility: false },
    secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true, voters: [{ provider: "abcllm" as const, model: SECOND }],
      fallbacks: [], sampleRate: 0 } };
}
/** 운영 원본을 흉내 낸다: 실제 판정·claim·기록 경로로 AI1 모델 심사를 마친 후보. */
async function seedSource() {
  const values = settings();
  await db.insert(crawlSettings).values({ id: 1, values: values as never, updatedBy: "fixture" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: values as never, updatedBy: "fixture" } });
  const lease = { name: "crawl-agent-review", token: "fixed-input-source", requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date(), requestedVersion: 1 })
    .onConflictDoUpdate({ target: jobs.name, set: { leaseToken: lease.token, lockedAt: new Date() } });
  for (const repo of REPOS) {
    await modules.crawl.putDocument({ repo, productUrl: `https://${repo.replace("/", "-")}.example`, pageStatus: 200,
      repoMeta: { description: "A useful product", stargazers_count: 3 }, pageMeta: { title: repo, description: "A useful product",
        readmeSample: "# Useful product", readmeSampleVersion: modules.readme.README_SAMPLE_VERSION } });
    const document = (await modules.crawl.getDocument(repo))!;
    expect(await modules.crawl.recordAutomaticJudgement({ candidate: undefined, document, settings: values,
      verdict: { state: "approved", reason: "passed", signals: {} } })).toBe(true);
    const candidate = (await modules.crawl.getCandidate(repo))!;
    const context = { candidate, document, settings: values, lease, provider: "abcllm", model: FIRST,
      input: await modules.review.loadReviewInput(candidate, document, values) };
    const claim = await modules.review.claimAgentReview(context);
    if (claim.kind === "skipped") throw new Error(claim.reason);
    await modules.review.recordAgentReview({ ...context, receipt: claim.receipt,
      outcome: { decision: repo.includes("/good-") ? "approve" : "reject", reason: "Source decision", evidenceIds: ["product"], confidence: 0.9 } });
  }
}
async function exported() {
  await seedSource();
  const now = Date.now(), artifact = await modules.repository.exportFixedInputs(db, { from: new Date(now - 3_600_000).toISOString(),
    to: new Date(now + 3_600_000).toISOString(), seed: "pr01b7", count: 10, revision: "abcdef1" });
  await wipe();
  return { artifact, sha: modules.fixed.sha256(JSON.stringify(artifact)) };
}
const policy = { version: 1 as const, globalLimit: 2, providerLimits: { fixture: 2 }, groupLimits: { fixture: 2 }, poolLimits: { reviewer: 2, text: 1 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model: FIRST, providerBudgetId: "fixture", groupId: "fixture" },
    { routeId: "second-review", provider: "abcllm", model: SECOND, providerBudgetId: "fixture", groupId: "fixture" }] };
const manifest = (sha: string, mode: "legacy" | "items", patch: Record<string, unknown> = {}) => ({ version: 1, runId: `pr01b7-${mode}`, mode,
  artifactSha256: sha, upstream: fake.origin, durationMs: 40_000,
  limits: { maxCalls: 60, maxTokens: 60 * 40_000, perCallTokenUpperBound: 40_000, maxWallMs: 120_000 },
  ...(mode === "items" ? { items: { ai1Consumers: 1, ai2Consumers: 1, capacityPolicy: policy } } : {}), ...patch });
const env = () => ({ DATABASE_URL: TEST_DATABASE_URL, ABCLLM_BASE_URL: fake.origin, ABCLLM_API_KEY: "replay-fixture-key" });
const run = (artifact: Awaited<ReturnType<typeof exported>>, value: Record<string, unknown>, timing = TIMING) => modules.runner.runFixedInputReplay({
  manifest: value, artifact: artifact.artifact, artifactSha256: artifact.sha, manifestSha256: modules.fixed.sha256(JSON.stringify(value)),
  revision: "abcdef1", env: env(), timing });

it("records the 0097 marker before the window and proves the legacy budget from the meter; items stay unverified (PR01b-9)", async () => {
  const source = await exported();
  expect(await db.execute(sql`select count(*)::int as count from pipeline_evidence_events`)).toEqual([{ count: 0 }]);
  const legacy = await run(source, manifest(source.sha, "legacy", { budget: { maxConcurrentCalls: 8 } }));
  const [marker] = await db.execute<{ at: string; revision: string; operator: string }>(sql`select revision, operator,
    to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at from pipeline_evidence_events where kind = 'recorder_started'`);
  // 적재(anchor) 뒤·구간 시작 전에 이 실행이 남겼다. 30분 실행에서는 수집 시작 = 구간 시작이라 장부가 구간을 덮는다.
  expect(marker).toMatchObject({ revision: "abcdef1", operator: "pipeline-replay" });
  expect([Date.parse(marker.at) >= Date.parse(legacy.window.anchorAt), Date.parse(marker.at) < Date.parse(legacy.window.startedAt)]).toEqual([true, true]);
  // 구간 안 AI2 호출 4건이 격리 DB의 0097 장부에 쌓였다(전에는 replay에서 아무것도 기록하지 않았다).
  expect(await db.execute(sql`select count(*)::int as count from pipeline_evidence_events
    where kind = 'ai2_attempt' and created_at > ${legacy.window.startedAt}::timestamptz`)).toEqual([{ count: 4 }]);
  expect(legacy.budget).toEqual({ declaredConcurrentCalls: 8, callsAtStop: 10 });
  expect(legacy.meter).toMatchObject({ calls: 10, upstreamReportedCalls: 10, upstreamReportedTokens: 12_400 });
  expect(modules.fixed.reportFixedInputRun(legacy).budget).toEqual({ status: "verified", source: "replay_meter", calls: 10, chargedTokens: 12_400,
    reportedCalls: 10, boundCalls: 0, concurrency: { limit: 8, peak: legacy.meter.maxInFlight } });
  // 이 시험 구간은 30분보다 짧아 수집이 marker보다 앞에서 시작한다 — 장부 미적용으로 남는다.
  expect(legacy.live.ledger).toBeNull();

  // items: 적재가 슬롯 모드를 열고 grant마다 control 갱신 시각이 바뀌어, 장부 budget은 '시작 뒤 바뀜'으로 미검증이다.
  await wipe(); fake.requests.length = 0; fake.contracts = true;
  const items = await run(source, manifest(source.sha, "items", { budget: { maxConcurrentCalls: 8 } }));
  expect(await db.execute(sql`select count(*)::int as count from pipeline_evidence_events where kind = 'recorder_started'`)).toEqual([{ count: 1 }]);
  expect(modules.fixed.reportFixedInputRun(items).budget).toEqual({ status: "unverified", source: "model_capacity_ledger",
    issues: ["model_capacity_changed_since_window_start", "ai2_call_records_unverified"] });
}, 300_000);

it("exports only reproducible model-reviewed inputs and replays legacy then item consumers to one judgment", async () => {
  const source = await exported();
  expect(source.artifact.inputs.map(row => row.repo).sort()).toEqual([...REPOS].sort());
  expect(source.artifact.export).toMatchObject({ population: 6, selected: 6, exclusions: { inputDrift: 0, documentChanged: 0, readmeMissing: 0 } });
  expect(source.artifact.inputs.every(row => row.inputHash === row.production.inputHash)).toBe(true);

  const legacy = await run(source, manifest(source.sha, "legacy"));
  const legacyRequests = fake.requests.length;
  expect(legacy).toMatchObject({ mode: "legacy", stop: { reason: "window_end", drainExceeded: false }, writes: { products: 0, publishRuns: 0 }, failures: [],
    inputs: { loaded: 6, excluded: { notReviewable: 0, inputDrift: 0 } } });
  expect(legacy.inputs.items).toHaveLength(6);
  expect(legacy.meter.calls).toBe(legacyRequests);
  expect(fake.requests.filter(row => row.model === FIRST)).toHaveLength(6);
  expect(fake.requests.filter(row => row.model === SECOND)).toHaveLength(4);
  expect(legacy.meter).toMatchObject({ refused: 0, egressRejected: 0, usageKnownCalls: legacyRequests, chargedTokens: 1_240 * legacyRequests });
  const legacyReport = modules.fixed.reportFixedInputRun(legacy);
  expect(legacyReport.finals).toMatchObject({ newCandidates: 6, approvals: 4, rejections: 2 });
  expect(legacyReport.evidenceIssues).toContain("replay_window_under_30_minutes");
  expect(legacyReport.stageModes.every(row => row.mode === "legacy")).toBe(true);

  await wipe(); fake.requests.length = 0; fake.contracts = true;
  const items = await run(source, manifest(source.sha, "items"));
  expect(items).toMatchObject({ mode: "items", stop: { reason: "window_end" }, writes: { products: 0, publishRuns: 0 }, failures: [],
    inputSetHash: legacy.inputSetHash });
  expect(fake.requests.filter(row => row.model === FIRST)).toHaveLength(6);
  expect(fake.requests.filter(row => row.model === SECOND)).toHaveLength(4);
  const itemsReport = modules.fixed.reportFixedInputRun(items);
  expect(itemsReport.finals).toMatchObject({ newCandidates: 6, approvals: 4, rejections: 2 });
  expect(itemsReport.stageModes.filter(row => row.stage !== "fetch").every(row => row.mode === "items")).toBe(true);
  expect(itemsReport.modelCapacity).toMatchObject({ mode: "open" });
  const leases = await db.execute<{ count: number }>(sql`select count(*)::int as count from pipeline_item_leases where stage in ('ai1', 'ai2')`);
  expect(leases[0].count).toBeGreaterThan(0);

  const compared = modules.fixed.compareFixedInputRuns(legacy, items);
  expect(compared).toMatchObject({ status: "incomplete", performance: "incomplete", modes: { baseline: "legacy", candidate: "items" } });
  expect(compared.reasons).toEqual(expect.arrayContaining(["replay_window_under_30_minutes", "quality_unverified", "budget_evidence_unverified"]));
  expect(compared.reasons).not.toContain("replay_input_set_mismatch");
  expect(compared.labelTemplate).toHaveLength(6);

  // 재사용 DB에서 attempt 번호가 되감기면 지울 수 없는 슬롯 장부와 겹친다. 적재 전에 거부해야 한다.
  await wipe(); fake.requests.length = 0;
  await db.execute(sql`select setval('crawl_review_attempts_id_seq', 1, false)`);
  await expect(run(source, manifest(source.sha, "items"))).rejects.toThrow("replay_database_not_empty");
  expect(fake.requests).toEqual([]);
}, 300_000);

it("stops at the call cap without sending the refused call and marks the run incomparable", async () => {
  const source = await exported();
  const capped = await run(source, manifest(source.sha, "legacy", { durationMs: 60_000,
    limits: { maxCalls: 2, maxTokens: 2 * 40_000, perCallTokenUpperBound: 40_000, maxWallMs: 180_000 } }));
  expect(fake.requests.length).toBeLessThanOrEqual(2);
  expect(capped.meter.calls).toBe(fake.requests.length);
  expect(capped.stop.reason).toBe("call_cap");
  expect(capped.writes).toEqual({ products: 0, publishRuns: 0 });
  expect(modules.fixed.reportFixedInputRun(capped).evidenceIssues).toContain("replay_stopped_early");
}, 240_000);

it("refuses item consumers before loading or any call while the serving resolvers stay null", async () => {
  const source = await exported();
  await expect(run(source, manifest(source.sha, "items"))).rejects.toThrow("consumer_mode_blocked");
  const preflight = modules.runner.fixedInputPreflight(manifest(source.sha, "items"), source.artifact, env(), TIMING);
  expect(preflight.blocked).toEqual(["ai1_serving_contract_unavailable", "ai2_serving_contract_unavailable"]);
  expect(fake.requests).toEqual([]);
  expect(await db.select().from(crawlCandidates)).toEqual([]);
  await expect(run(source, manifest(source.sha, "legacy", { upstream: "http://127.0.0.1:9" }))).rejects.toThrow("replay_upstream_mismatch");
  await expect(run(source, manifest("0".repeat(64), "legacy"))).rejects.toThrow("replay_artifact_sha_mismatch");
  await db.insert(crawlDocuments).values({ repo: "other/existing", repoMeta: {} });
  await expect(run(source, manifest(source.sha, "legacy"))).rejects.toThrow("replay_database_not_empty");
  expect(fake.requests).toEqual([]);
  await db.delete(crawlDocuments).where(eq(crawlDocuments.repo, "other/existing"));
}, 120_000);

// 구간 끝 drain: 정지 신호는 새 claim·새 호출만 막고, 구간 안에서 이미 보낸 호출은 drain 상한 안에서 upstream이 끝나 usage가 남는다.
// 가짜 게이트웨이가 모든 답을 구간(12초)보다 늦게(20초) 주므로 첫 호출들이 구간 끝에 반드시 진행 중이다.
// 그 수는 legacy가 심사 동시 수(reviewConcurrency 2), items가 AI1 consumer 하나의 호출 1건이다.
const HELD = { durationMs: 12_000, budget: { maxConcurrentCalls: 8 } };
it("drains legacy calls in flight at the window end into the budget, never into finals, and cuts what outlives the drain limit", async () => {
  const source = await exported();
  fake.delayMs = 20_000;
  const legacy = await run(source, manifest(source.sha, "legacy", HELD)), calls = legacy.meter.calls;
  expect(fake.requests.length).toBe(2);
  expect(calls).toBe(2);
  expect(legacy).toMatchObject({ stop: { reason: "window_end", drainExceeded: false }, budget: { declaredConcurrentCalls: 8, callsAtStop: calls },
    windowEndDrain: { limitMs: TIMING.drainMs, inFlightAtStop: calls, cutAtLimit: 0, meterStop: null, accounting: "drain_calls_in_budget_not_in_finals" },
    meter: { refused: 0, indeterminate: 0, upstreamFailed: 0, upstreamReportedCalls: calls, upstreamReportedTokens: 1_240 * calls },
    writes: { products: 0, publishRuns: 0 }, failures: [] });
  const report = modules.fixed.reportFixedInputRun(legacy);
  expect(report.budget).toEqual({ status: "verified", source: "replay_meter", calls, chargedTokens: 1_240 * calls, reportedCalls: calls,
    boundCalls: 0, concurrency: { limit: 8, peak: legacy.meter.maxInFlight } });
  // drain 중 끝난 답은 워커가 이미 놓았다. 구간 안 최종·처리량은 0이다.
  expect(report.finals).toMatchObject({ newCandidates: 0 });
  expect(report.evidenceIssues).not.toContain("replay_calls_refused");

  await wipe(); fake.requests.length = 0;
  const cut = await run(source, manifest(source.sha, "legacy", HELD), { ...TIMING, drainMs: 2_000 }), cutCalls = cut.meter.calls;
  expect(cutCalls).toBe(2);
  expect(cut).toMatchObject({ stop: { reason: "window_end" }, windowEndDrain: { limitMs: 2_000, inFlightAtStop: cutCalls, cutAtLimit: cutCalls },
    meter: { indeterminate: cutCalls, upstreamReportedCalls: 0, chargedTokens: 40_000 * cutCalls } });
  expect(modules.fixed.reportFixedInputRun(cut).budget).toEqual({ status: "unverified", source: "replay_meter",
    issues: ["usage_unreported_without_bound", "replay_drain_calls_cut"] });
}, 300_000);

it("applies the same window-end drain rule to item consumers", async () => {
  const source = await exported();
  fake.contracts = true; fake.delayMs = 20_000;
  const items = await run(source, manifest(source.sha, "items", HELD)), calls = items.meter.calls;
  expect(fake.requests.length).toBe(1);
  expect(calls).toBe(1);
  expect(items).toMatchObject({ stop: { reason: "window_end", drainExceeded: false }, budget: { callsAtStop: calls },
    windowEndDrain: { limitMs: TIMING.drainMs, inFlightAtStop: calls, cutAtLimit: 0, meterStop: null },
    meter: { refused: 0, indeterminate: 0, upstreamReportedCalls: calls, upstreamReportedTokens: 1_240 * calls }, writes: { products: 0, publishRuns: 0 } });
  const report = modules.fixed.reportFixedInputRun(items);
  expect(report.finals).toMatchObject({ newCandidates: 0 });
  // consumer가 놓은 호출이라 장부는 실제 usage 대신 C(40,000)로 센다 — items의 drain 호출은 계량기 usage보다 보수적으로 잡힌다.
  expect([...await db.execute(sql`select r.state, r.terminal_evidence->'actualUsage' as usage, (r.dispatch_binding->>'totalTokenBound')::int as bound
    from model_capacity_events e join model_capacity_requests r on r.request_id = e.request_id
    where e.kind = 'dispatch_started' and e.created_at > ${items.window.startedAt}::timestamptz`)]).toEqual([{ state: "indeterminate", usage: null, bound: 40_000 }]);
  // 짧은 시험 구간이라 장부 budget은 첫 시험과 같은 이유로만 미검증이다(drain 이유는 없다).
  expect(report.budget).toEqual({ status: "unverified", source: "model_capacity_ledger",
    issues: ["model_capacity_changed_since_window_start", "ai2_call_records_unverified"] });

  await wipe(); fake.requests.length = 0;
  const cut = await run(source, manifest(source.sha, "items", HELD), { ...TIMING, drainMs: 2_000 }), cutCalls = cut.meter.calls;
  expect(cutCalls).toBe(1);
  expect(cut).toMatchObject({ windowEndDrain: { limitMs: 2_000, inFlightAtStop: cutCalls, cutAtLimit: cutCalls }, meter: { indeterminate: cutCalls } });
  expect(modules.fixed.reportFixedInputRun(cut).budget).toEqual({ status: "unverified", source: "model_capacity_ledger",
    issues: ["model_capacity_changed_since_window_start", "ai2_call_records_unverified", "replay_drain_calls_cut"] });
}, 300_000);
