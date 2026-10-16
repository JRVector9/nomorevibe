import { isDeepStrictEqual } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { asc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import type { ReviewCliRun } from "@/lib/crawl/agent-review";
import type { GrokCliRun } from "@/lib/crawl/agent-review-grok";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, operationsObservations, products,
  productAuditAttempts, productAuditCampaigns, productAuditItems, productIntroChecks } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { saveSettings } from "@/lib/crawl/settings";
import { startProductAudit } from "@/lib/crawl/product-audit";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { checkGrokSession } from "@/lib/crawl/jobs/grok-session";
import { checkProductIntros } from "@/lib/jobs/products/intro-check";
import { INTRO_CHECK_MODEL } from "@/lib/domain/products/intro-check";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { runJob } from "@/lib/jobs/runner";
import { jobRunOptions } from "@/scripts/worker";
import { ensureSchema, resetTables } from "./setup";

// admission 거절과 runner readback 만 본다. 슬롯 허가·종료 증거가 아니다.
// 바꾸는 것은 CLI·게이트웨이 호출뿐이고 control·job·도메인 TX 는 실제 PostgreSQL 로 돈다.
const spies = vi.hoisted(() => ({ agent: vi.fn(), gateway: vi.fn() }));
vi.mock("@/lib/crawl/agent-review", async (load) => ({ ...await load<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: spies.agent }));
vi.mock("@/lib/crawl/agent-review-gateway", async (load) => ({ ...await load<typeof import("@/lib/crawl/agent-review-gateway")>(),
  reviewWithGateway: spies.gateway }));

type Raw = Record<string, unknown>;
type Route = { routeId: string; provider: string; model: string };
const GATEWAY_MODEL = "[MLX] gpt-oss-120b";
const GROK_MODEL = "grok-4.7";
const JOB_NAMES = ["product-intro-check", "product-audit", "grok-session-check"];
const verdict = { ok: true, outcome: { decision: "approve", reason: 'pageText: "approve"', evidenceIds: ["product"], confidence: 0.9 }, usage: {} };
let originalControl: Raw | undefined;

async function rows(query: SQL): Promise<Raw[]> {
  return [...await db.execute<{ value: Raw }>(query)].map(row => row.value);
}
async function whole(): Promise<Record<string, Raw[]>> {
  const result: Record<string, Raw[]> = {};
  for (const { tablename } of await db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`))
    result[tablename] = await rows(sql.raw(`SELECT to_jsonb(t) AS value FROM public."${tablename.replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text`));
  return result;
}
const controlRow = async () => (await rows(sql`SELECT to_jsonb(c) AS value FROM model_capacity_control c WHERE id=1`))[0];
const jobRow = async (name: string) => (await rows(sql`SELECT to_jsonb(j) AS value FROM jobs j WHERE name=${name}`))[0];

async function setControl(mode: "disabled" | "open" | "draining", routes: Route[] = []) {
  if (mode === "disabled") {
    await db.execute(sql`UPDATE model_capacity_control SET mode='disabled', policy=NULL, policy_hash=NULL WHERE id=1`);
    return;
  }
  const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { engine: 1 },
    poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4, queueTtlMs: 60_000,
    reservationTtlMs: 60_000, routes: (routes.length ? routes : [{ routeId: "fixture-route", provider: "fixture", model: "fixture" }])
      .map(route => ({ ...route, providerBudgetId: "account", groupId: "engine" })) };
  await db.execute(sql`UPDATE model_capacity_control SET mode=${mode}, policy=${JSON.stringify(policy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(policy)} WHERE id=1`);
}
async function restoreControl() {
  if (!originalControl) return;
  await db.execute(sql`UPDATE model_capacity_control SET (mode,epoch,revision,policy_hash,policy,cursor,updated_at)=
    (SELECT mode,epoch,revision,policy_hash,policy,cursor,updated_at FROM jsonb_populate_record(NULL::model_capacity_control,
      ${JSON.stringify(originalControl)}::text::jsonb)) WHERE id=1`);
  expect(isDeepStrictEqual(await controlRow(), originalControl)).toBe(true);
}
async function clean() {
  await db.delete(productAuditAttempts);
  await db.delete(productAuditItems);
  await db.delete(productAuditCampaigns);
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(operationsObservations).where(or(like(operationsObservations.key, "service:grok:%"),
    inArray(operationsObservations.key, JOB_NAMES.map(name => `job:${name}`))));
  await db.delete(jobs);
  await resetTables();
}

/** 요청이 처리를 앞선 대기 상태와 지난 기록 — deferred 는 이것을 하나도 바꾸면 안 된다 */
async function pendingJob(name: string) {
  await db.insert(jobs).values({ name }).onConflictDoNothing();
  await db.update(jobs).set({ requestedVersion: 10, processedVersion: 8, cursor: { fixture: name }, notBefore: null,
    lastError: "preserved history", lastSuccessAt: new Date("2026-01-02T03:04:05.123Z"), lockedAt: null, leaseToken: null })
    .where(eq(jobs.name, name));
}

let sequence = 0;
async function introProduct(slug: string) {
  await db.insert(products).values({ slug, name: slug, url: `https://${slug}.test`, tagline: "Plan meals for the week", description: "Meal planner",
    category: "Productivity", taglineSource: "ai_page", status: "seeded", source: "crawler", verifyToken: `token-${++sequence}`,
    editTokenHash: "h".repeat(64), searchPageText: `${slug} page text` });
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

const introCli = vi.fn<ReviewCliRun>(async (_args, stdin) => {
  const body = JSON.parse(stdin.replace(/^<untrusted_evidence_json>\n/, "").replace(/\n<\/untrusted_evidence_json>$/, "")) as { slug: string }[];
  const results = body.map(item => ({ slug: item.slug, verdict: "ok", problem: "", corrected: "" }));
  return { kind: "exit", code: 0, stdout: JSON.stringify({ is_error: false, structured_output: { results } }), stderr: "" };
});
const grokCli = vi.fn<GrokCliRun>(async () => ({ kind: "exit", code: 0, stdout: JSON.stringify({ text: "OK", modelUsage: { "grok-4.7-build": {} } }), stderr: "" }));

const audit = (provider: "claude-cli" | "abcllm", model: string, cli: typeof spies.agent) => ({
  job: "product-audit", route: { routeId: "product-audit", provider, model }, cli,
  prepare: async () => {
    await saveSettings({ enabled: true, firstReview: { provider, model }, reviewConcurrency: 2 }, "test");
    await listed("audit/one");
    expect(await startProductAudit({ startedBy: "jr", reason: "슬롯 확인", reauditKept: false })).toMatchObject({ ok: true, enrolled: 1 });
  },
  tick: () => runJob("product-audit", auditPublishedProducts, { requestedOnly: true,
    budgetMs: jobRunOptions("product-audit", { requestedOnly: true }).budgetMs }),
  written: async () => (await db.select().from(productAuditAttempts)).length,
});
const callers = [
  { name: "intro-check claude-cli", job: "product-intro-check", route: { routeId: "product-intro-check", provider: "claude-cli", model: INTRO_CHECK_MODEL },
    cli: introCli, prepare: () => introProduct("intro-one"),
    tick: () => runJob<null>("product-intro-check", ctx => checkProductIntros(ctx, introCli), { requestedOnly: true }),
    written: async () => (await db.select().from(productIntroChecks)).length },
  { name: "product-audit claude-cli", ...audit("claude-cli", "sonnet", spies.agent) },
  { name: "product-audit abcllm gateway", ...audit("abcllm", GATEWAY_MODEL, spies.gateway) },
  { name: "grok-session grok-cli", job: "grok-session-check", route: { routeId: "grok-session-check", provider: "grok-cli", model: GROK_MODEL },
    cli: grokCli, prepare: async () => { await saveSettings({ enabled: true, firstReview: { provider: "grok-cli", model: GROK_MODEL } }, "test"); },
    tick: () => runJob<null>("grok-session-check", ctx => checkGrokSession(ctx, { run: grokCli }), { requestedOnly: true }),
    written: async () => (await db.select().from(operationsObservations).where(like(operationsObservations.key, "service:grok:%"))).length },
];
const modes = [
  { mode: "draining" as const, routes: (route: Route) => [route] },
  { mode: "open" as const, routes: (route: Route) => [{ ...route, provider: route.provider === "abcllm" ? "claude-cli" : "abcllm" }, { ...route, model: "other" }] },
  { mode: "open" as const, routes: (route: Route) => [route] },
];
const matrix = callers.flatMap(caller => modes.map((mode, index) => ({ ...caller, ...mode,
  label: `${caller.name} ${mode.mode}${index === 1 ? " unmapped" : index === 2 ? " mapped" : ""}` })));

beforeAll(async () => {
  ensureSchema();
  originalControl = await controlRow();
  expect(originalControl).toMatchObject({ id: 1 });
});
beforeEach(async () => {
  vi.stubEnv("SERVICE_INSTANCE_ID", "m3-reviewer");
  vi.stubEnv("GROK_AUTH_PATH", "/nonexistent/auth.json");
  spies.agent.mockReset().mockResolvedValue(verdict);
  spies.gateway.mockReset().mockResolvedValue(verdict);
  introCli.mockClear(); grokCli.mockClear();
  await restoreControl();
  await clean();
});
afterEach(async () => { try { await restoreControl(); await clean(); } finally { vi.unstubAllEnvs(); } });
afterAll(async () => { await restoreControl(); });

it.each(matrix)("$label: a real tick defers before the call and keeps producer, cursor, history and every other row", async scenario => {
  await scenario.prepare();
  await pendingJob(scenario.job);
  await setControl(scenario.mode, scenario.routes(scenario.route));
  const before = await whole();
  const jobBefore = await jobRow(scenario.job);

  expect(await scenario.tick()).toMatchObject({ status: "deferred", reason: "model_capacity" });

  expect(scenario.cli).not.toHaveBeenCalled();
  expect(spies.agent).not.toHaveBeenCalled();
  expect(spies.gateway).not.toHaveBeenCalled();
  expect(await scenario.written()).toBe(0);
  const after = await whole();
  // runner 가 잠금을 잡았다 놓은 흔적(runs·last_run_at·updated_at)만 다르다
  const jobAfter = await jobRow(scenario.job);
  expect(jobAfter).toEqual({ ...jobBefore, runs: Number(jobBefore.runs) + 1, last_run_at: expect.any(String), updated_at: expect.any(String),
    locked_at: null, lease_token: null });
  expect(jobAfter).toMatchObject({ requested_version: 10, processed_version: 8, cursor: { fixture: scenario.job }, not_before: null,
    last_error: "preserved history" });
  delete before.jobs; delete after.jobs;
  expect(after).toStrictEqual(before);
});

it.each(callers)("$name disabled still calls once, records and acknowledges as before", async scenario => {
  await scenario.prepare();
  await pendingJob(scenario.job);
  await setControl("disabled");

  expect(await scenario.tick()).toMatchObject({ status: "completed" });

  expect(scenario.cli).toHaveBeenCalledTimes(1);
  expect(await scenario.written()).toBe(1);
  expect(await jobRow(scenario.job)).toMatchObject({ processed_version: 10, last_error: null, locked_at: null, lease_token: null });
});

it("an intro tick keeps the batch recorded before a mid-tick defer and leaves the next product untouched", async () => {
  for (let index = 1; index <= 11; index++) await introProduct(`intro-${String(index).padStart(2, "0")}`);
  await pendingJob("product-intro-check");
  await setControl("disabled");
  const switching = vi.fn<ReviewCliRun>(async (args, stdin, options) => {
    await setControl("open", [{ routeId: "product-intro-check", provider: "claude-cli", model: INTRO_CHECK_MODEL }]);
    return introCli(args, stdin, options);
  });
  const jobBefore = await jobRow("product-intro-check");

  expect(await runJob<null>("product-intro-check", ctx => checkProductIntros(ctx, switching), { requestedOnly: true }))
    .toMatchObject({ status: "deferred", reason: "model_capacity" });

  expect(switching).toHaveBeenCalledTimes(1);
  const checks = await db.select({ slug: products.slug, outcome: productIntroChecks.outcome, attempts: productIntroChecks.attempts })
    .from(productIntroChecks).innerJoin(products, eq(products.id, productIntroChecks.productId)).orderBy(asc(products.slug));
  expect(checks).toHaveLength(10);
  expect(checks.every(check => check.outcome === "kept" && check.attempts === 0)).toBe(true);
  expect(checks.map(check => check.slug)).not.toContain("intro-01");
  expect(await jobRow("product-intro-check")).toEqual({ ...jobBefore, runs: Number(jobBefore.runs) + 1, last_run_at: expect.any(String),
    updated_at: expect.any(String), locked_at: null, lease_token: null });
});
