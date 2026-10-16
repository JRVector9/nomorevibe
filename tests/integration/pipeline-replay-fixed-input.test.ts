import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, jobs } from "@/lib/db/schema";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";

/** 가짜 게이트웨이(loopback)와 테스트용 serving 계약. 운영 resolver는 그대로 null이며 이 파일 안에서만 대체한다. */
const fake = vi.hoisted(() => ({ origin: "", contracts: false, requests: [] as { model: string; repo: string }[] }));
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
        res.end(reply(request.model, { decision, reason: "Replay fixture decision", evidenceIds: ["product"], confidence: 0.95 }, fake.requests.length)); }, 20);
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
beforeEach(async () => { await wipe(); await restoreControls(); fake.contracts = false; fake.requests.length = 0; });
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
const run = (artifact: Awaited<ReturnType<typeof exported>>, value: Record<string, unknown>) => modules.runner.runFixedInputReplay({
  manifest: value, artifact: artifact.artifact, artifactSha256: artifact.sha, manifestSha256: modules.fixed.sha256(JSON.stringify(value)),
  revision: "abcdef1", env: env(), timing: TIMING });

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
