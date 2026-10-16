import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, operationsObservations, products,
  productAuditAttempts, productAuditCampaigns, productAuditItems, productIntroChecks } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { saveSettings } from "@/lib/crawl/settings";
import { lockAuditDispatchItem, startProductAudit } from "@/lib/crawl/product-audit";
import { MAX_REVIEW_ATTEMPTS } from "@/lib/crawl/agent-review-contract";
import { lockIntroCheckMembers, pendingIntroChecks } from "@/lib/domain/products/intro-checks";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { checkGrokSession, grokSessionArgs } from "@/lib/crawl/jobs/grok-session";
import { reviewCliArgs } from "@/lib/crawl/agent-review";
import { checkProductIntros } from "@/lib/jobs/products/intro-check";
import { INTRO_CHECK_MODEL, introCheckCliArgs } from "@/lib/domain/products/intro-check";
import { grokSessionLogicalWorkKey, modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { claudeCliTokenBound, type CliServingContract } from "@/lib/llm/cli-serving-contract";
import { runJob } from "@/lib/jobs/runner";
import { jobRunOptions } from "@/scripts/worker";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";

/*
 * 05c-5 실제 DB driver — 실제 runJob·장부(model_capacity_*)·도메인 TX 위에서 소개 검수·Claude 감사·Grok 세션 점검이 공통 슬롯을 거친다.
 * 자식 프로세스는 tests/fixtures/fake-cli/background.mjs(가짜 CLI)뿐이고 PATH 는 빈 디렉터리다. 실제 claude/grok·provider·운영 resolver 는
 * 쓰지 않는다 — CLI 계약은 이 파일의 fixture 만 연다(운영 resolver 는 null 이라 open 이어도 미룬다).
 */
const fixture = vi.hoisted(() => ({ contracts: [] as CliServingContract[] }));
vi.mock("@/lib/llm/cli-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/cli-serving-contract")>(),
  resolveCliServingContract: (routeId: string, provider: string, model: string) =>
    fixture.contracts.find(value => value.routeId === routeId && value.provider === provider && value.model === model) ?? null,
}));

type Raw = Record<string, unknown>;
const prefix = `bg-cli-${randomUUID().slice(0, 8)}`, GROK_MODEL = "grok-4.7", AUDIT_MODEL = "sonnet", PROCESS_TEST_MS = 30_000;
const ROUTES = ["product-intro-check", "product-audit", "grok-session-check"];
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const derived = (routeId: string, model: string, outputTokensPerTurn: number, costBoundUsdMicros: number): CliServingContract => {
  const shape = { maxTurns: 2, inputByteCap: 200_000, overheadTokenBound: 20_000, outputTokensPerTurn };
  return { version: 1, protocol: "cli-process-v1", routeId, provider: "claude-cli", model, cliVersion: "fake 0.0.0",
    totalTokenBound: claudeCliTokenBound(shape), costBoundUsdMicros, boundProvenance: "derived", ...shape };
};
const CONTRACTS: CliServingContract[] = [derived("product-intro-check", INTRO_CHECK_MODEL, 8_000, 1_000_000), derived("product-audit", AUDIT_MODEL, 2_000, 150_000),
  { version: 1, protocol: "cli-process-v1", routeId: "grok-session-check", provider: "grok-cli", model: GROK_MODEL, cliVersion: "fake 0.0.0",
    inputByteCap: 200_000, totalTokenBound: 300_000, costBoundUsdMicros: null, boundProvenance: "declared" }];
// D8·D9: 계정 단위 budget, 세 route 는 background/reviewer
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { "claude-sub": 2, "grok-sub": 1 }, groupLimits: { reviewers: 4 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 2, second: 2, background: 1 }, maxWaiting: 8, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "product-intro-check", provider: "claude-cli", model: INTRO_CHECK_MODEL, providerBudgetId: "claude-sub", groupId: "reviewers" },
    { routeId: "product-audit", provider: "claude-cli", model: AUDIT_MODEL, providerBudgetId: "claude-sub", groupId: "reviewers" },
    { routeId: "grok-session-check", provider: "grok-cli", model: GROK_MODEL, providerBudgetId: "grok-sub", groupId: "reviewers" }] };
let root = "", bin = "", empty = "", records = "", originalControl: Raw, sequence = 0;
const grandchildren: number[] = [];

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  expect(journal.entries.map((entry: { tag: string }) => entry.tag)).toContain("0094_model_capacity_cli_process_terminal");
  const [applied] = await admin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  [{ row: originalControl }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  // 허가는 전체 활성 행을 센다 — 앞선 파일이 남긴 활성 호출이 있으면 이 파일의 허가·미룸 결과가 달라진다
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toHaveLength(0);
  root = await mkdtemp(path.join(os.tmpdir(), "nmv-cli-background-db-"));
  empty = path.join(root, "empty-path"); records = path.join(root, "records"); await mkdir(empty); await mkdir(records);
  const script = path.resolve("tests/fixtures/fake-cli/background.mjs");
  for (const value of [root, script, process.execPath]) expect(value).not.toContain("'");
  bin = path.join(root, "fake-cli"); await writeFile(bin, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`); await chmod(bin, 0o755);
  console.info("cli_background_migrations", { journal: journal.entries.length, applied: applied.count });
});
beforeEach(async () => {
  fixture.contracts = CONTRACTS;
  for (const [key, value] of Object.entries({ PATH: empty, CLAUDE_CLI: bin, GROK_CLI: bin, FAKE_CLI_RECORD: records, SERVICE_INSTANCE_ID: prefix,
    GROK_AUTH_PATH: "/nonexistent/auth.json", ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: prefix, ROLE_LEASE_BOOT_ID: randomUUID(),
    ROLE_LEASE_RELEASE: "local-cli-background", ROLE_LEASE_EPOCH: "1" })) vi.stubEnv(key, value);
  await cleanLedger(); await cleanDomain();
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},
    cursor=0,updated_at=clock_timestamp() WHERE id=1`;
});
afterEach(async () => {
  try {
    reap();
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
    const ids = (await tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix} AND route_id=ANY(${ROUTES}) FOR UPDATE`)
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
  await db.delete(operationsObservations).where(or(like(operationsObservations.key, "service:grok:%"),
    inArray(operationsObservations.key, ROUTES.map(name => `job:${name}`))));
  await db.delete(jobs).where(inArray(jobs.name, ROUTES));
  await resetTables();
}
function reap() {
  for (const pid of grandchildren.splice(0)) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

async function requests() {
  return Array.from(await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal`)
    .map(({ row }) => row as Raw & { dispatch_binding: Raw; terminal_evidence: { process: Raw } | null });
}
async function events(requestId: unknown) {
  return Array.from(await admin`SELECT kind,reason FROM model_capacity_events WHERE request_id=${String(requestId)}::uuid ORDER BY id`);
}
type Recorded = { mode: string; pid: number; argv: string[]; env: Record<string, string | null>; realCliOnPath: boolean; grandchild?: number };
async function recorded(): Promise<Recorded[]> {
  return Promise.all((await readdir(records)).map(async name => JSON.parse(await readFile(path.join(records, name), "utf8")) as Recorded));
}
/** 요청이 처리를 앞선 대기 상태 */
async function pendingJob(name: string) {
  await db.insert(jobs).values({ name }).onConflictDoNothing();
  await db.update(jobs).set({ requestedVersion: 10, processedVersion: 8, notBefore: null, lockedAt: null, leaseToken: null }).where(eq(jobs.name, name));
}
const jobRow = async (name: string) => (await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${name}`)[0]?.row as Raw;
async function introProduct(slug: string) {
  const [row] = await db.insert(products).values({ slug, name: slug, url: `https://${slug}.test`, tagline: "Plan meals for the week",
    description: "Meal planner", category: "Productivity", taglineSource: "ai_page", status: "seeded", source: "crawler",
    verifyToken: `token-${++sequence}`, editTokenHash: "h".repeat(64), searchPageText: `${slug} page text` }).returning({ id: products.id });
  return row.id;
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
const introTick = (wrap: (ctx: Parameters<typeof checkProductIntros>[0]) => Parameters<typeof checkProductIntros>[0] = ctx => ctx) =>
  runJob<null>("product-intro-check", ctx => checkProductIntros(wrap(ctx)), { requestedOnly: true });
const introChecks = () => db.select({ slug: products.slug, outcome: productIntroChecks.outcome, attempts: productIntroChecks.attempts,
  errorCode: productIntroChecks.errorCode, model: productIntroChecks.model }).from(productIntroChecks)
  .innerJoin(products, eq(products.id, productIntroChecks.productId)).orderBy(asc(products.slug));

it("intro: a real tick takes a background slot, runs the fake CLI once, settles its terminal and then records the batch", async () => {
  vi.stubEnv("FAKE_CLI_MODE", "intro-ok");
  const ids = [await introProduct("intro-a"), await introProduct("intro-b")];
  await pendingJob("product-intro-check");

  expect(await introTick()).toMatchObject({ status: "completed", done: true });

  const [request, ...extra] = await requests();
  expect(extra).toEqual([]);
  expect(request).toMatchObject({ state: "settled", route_id: "product-intro-check", class: "background", pool: "reviewer", provider: "claude-cli",
    model: INTRO_CHECK_MODEL, provider_budget_id: "claude-sub", logical_member_keys: ids.map(id => `intro:${id}`).sort() });
  expect(request.logical_work_key).toMatch(/^bg:intro:[a-f0-9]{64}$/);
  expect(request.dispatch_binding).toMatchObject({ kind: "intro_check_cli", provider: "claude-cli", routeId: "product-intro-check",
    job: { name: "product-intro-check" }, members: [{ productId: ids[1], check: { kind: "absent" } }, { productId: ids[0], check: { kind: "absent" } }] });
  expect(request.terminal_evidence?.process).toMatchObject({ ending: "exited", exitCode: 0, signal: null, provenance: "cli_reported" });
  expect((await events(request.request_id)).map(event => event.kind)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
  expect(await introChecks()).toEqual([{ slug: "intro-a", outcome: "kept", attempts: 0, errorCode: null, model: INTRO_CHECK_MODEL },
    { slug: "intro-b", outcome: "kept", attempts: 0, errorCode: null, model: INTRO_CHECK_MODEL }]);
  const [spawned, ...more] = await recorded();
  expect(more).toEqual([]);
  expect(spawned).toMatchObject({ mode: "intro-ok", argv: introCheckCliArgs(INTRO_CHECK_MODEL), realCliOnPath: false });
  expect(await jobRow("product-intro-check")).toMatchObject({ processed_version: 10, locked_at: null, lease_token: null, last_error: null });
}, PROCESS_TEST_MS);

it("intro: a grandchild holding the pipe keeps the request indeterminate(process_exit); the next tick defers without spawning or counting", async () => {
  vi.stubEnv("FAKE_CLI_MODE", "grandchild-hold");
  await introProduct("intro-held");
  await pendingJob("product-intro-check");

  // 출력은 버린다 — 기존 실패 기록(cli_error, 시도 1)과 멈춤 규칙은 그대로다
  expect(await introTick()).toMatchObject({ status: "completed", done: true });
  const [first] = await recorded();
  if (first?.grandchild) grandchildren.push(first.grandchild);
  const [held] = await requests();
  expect(held).toMatchObject({ state: "indeterminate", terminal_evidence: null });
  expect(await events(held.request_id)).toEqual([{ kind: "queued", reason: null }, { kind: "reserved", reason: null },
    { kind: "dispatch_started", reason: null }, { kind: "dispatch_indeterminate", reason: "process_exit" }]);
  expect(await introChecks()).toEqual([{ slug: "intro-held", outcome: null, attempts: 1, errorCode: "cli_error", model: "" }]);

  // 재시도 때가 되어 같은 제품이 다시 대기열 머리에 와도, 점유가 남아 있으면 띄우지 않고 미룬다(재진입 0)
  await db.update(productIntroChecks).set({ retryAt: sql`now() - interval '1 minute'` });
  const [before] = await db.execute<{ row: Raw }>(sql`SELECT to_jsonb(c) AS row FROM product_intro_checks c`);
  for (const name of await readdir(records)) await rm(path.join(records, name));
  await pendingJob("product-intro-check");

  expect(await introTick()).toMatchObject({ status: "deferred", reason: "model_capacity" });

  expect(await recorded()).toEqual([]);
  expect((await requests()).map(row => [row.request_id, row.state])).toEqual([[held.request_id, "indeterminate"]]);
  const [after] = await db.execute<{ row: Raw }>(sql`SELECT to_jsonb(c) AS row FROM product_intro_checks c`);
  expect(after.row).toEqual(before.row);
  expect(await jobRow("product-intro-check")).toMatchObject({ requested_version: 10, processed_version: 8, locked_at: null });
}, PROCESS_TEST_MS);

it("intro: when the tick margin is gone after dispatch the request settles not_started and nothing is spawned or recorded", async () => {
  vi.stubEnv("FAKE_CLI_MODE", "intro-ok");
  await introProduct("intro-late");
  await pendingJob("product-intro-check");
  let checks = 0;

  // 첫 확인(루프 조건)만 여유가 있고 spawn 직전 확인에서 예산이 없다
  expect(await introTick(ctx => ({ ...ctx, hasBudget: () => checks++ === 0 && ctx.hasBudget() }))).toMatchObject({ status: "completed", done: false });

  const [request] = await requests();
  expect(request).toMatchObject({ state: "settled" });
  expect(request.terminal_evidence?.process).toMatchObject({ ending: "not_started", exitCode: null, stdoutBytes: 0 });
  expect((await events(request.request_id)).map(event => event.kind)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
  expect(await introChecks()).toEqual([]);
  expect(await recorded()).toEqual([]);
}, PROCESS_TEST_MS);

it("intro: open with no CLI contract (the production resolver) defers with no ledger row, spawn or record", async () => {
  fixture.contracts = [];
  await introProduct("intro-closed");
  await pendingJob("product-intro-check");
  expect(await introTick()).toMatchObject({ status: "deferred", reason: "model_capacity" });
  expect(await requests()).toEqual([]);
  expect(await introChecks()).toEqual([]);
  expect(await recorded()).toEqual([]);
});

it("intro dispatch proof: members follow the locked rows and turn null whenever recordIntroCheck would discard the batch", async () => {
  const id = await introProduct("intro-proof");
  const [task] = await pendingIntroChecks(10);
  const locked = (value = task) => db.transaction(tx => lockIntroCheckMembers(tx, [value]));
  const first = await locked();
  expect(first).toEqual([{ productId: id, slug: "intro-proof", sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/), taglineSource: "ai_page",
    check: { kind: "absent" } }]);
  expect(await locked()).toEqual(first);
  // 모델에게 보낼 글(페이지 글)이 바뀌면 같은 묶음이 아니다
  await db.update(products).set({ searchPageText: "changed page" }).where(eq(products.id, id));
  expect(await locked()).toBeNull();
  await db.update(products).set({ searchPageText: "intro-proof page text" }).where(eq(products.id, id));
  expect(await locked()).toEqual(first);
  await db.update(products).set({ claimedAt: new Date() }).where(eq(products.id, id));
  expect(await locked()).toBeNull();
  await db.update(products).set({ claimedAt: null }).where(eq(products.id, id));
  // 잡이 읽은 뒤 검수 행이 생겼으면 버린다
  await db.insert(productIntroChecks).values({ productId: id, checkedTagline: "older tagline", attempts: 2, errorCode: "timeout" });
  expect(await locked()).toBeNull();
  // 검수 행이 있으면 그 행 전체의 해시와 attempts 를 묶는다 — 행이 조금만 바뀌어도 구성원이 달라진다
  const [withCheck] = await pendingIntroChecks(10);
  const present = await locked(withCheck);
  expect(present?.[0].check).toEqual({ kind: "present", rowIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/), attempts: 2 });
  await db.update(productIntroChecks).set({ problem: "edited" }).where(eq(productIntroChecks.productId, id));
  const edited = await locked(withCheck);
  expect(edited?.[0].check).toMatchObject({ kind: "present", attempts: 2 });
  expect(edited?.[0].check).not.toEqual(present?.[0].check);
});

it("audit dispatch proof: an open item of the running campaign yields its snapshot; answered, exhausted, stopped or moved items do not", async () => {
  await saveSettings({ enabled: true, firstReview: { provider: "claude-cli", model: AUDIT_MODEL } }, "test");
  await listed("audit/proof");
  expect(await startProductAudit({ startedBy: "jr", reason: "증명 확인", reauditKept: false })).toMatchObject({ ok: true, enrolled: 1 });
  const [campaign] = await db.select().from(productAuditCampaigns), [item] = await db.select().from(productAuditItems);
  const lock = (value: Partial<Parameters<typeof lockAuditDispatchItem>[1]> = {}) =>
    db.transaction(tx => lockAuditDispatchItem(tx, { itemId: item.id, slug: "proof", campaign, ...value }));
  expect(await lock()).toEqual({ productId: item.productId, attempts: 0 });
  expect(await lock({ slug: "other" })).toBeNull();
  expect(await lock({ campaign: { ...campaign, model: "opus" } })).toBeNull();
  await db.update(productAuditItems).set({ attempts: MAX_REVIEW_ATTEMPTS }).where(eq(productAuditItems.id, item.id));
  expect(await lock()).toBeNull();
  await db.update(productAuditItems).set({ attempts: 1 }).where(eq(productAuditItems.id, item.id));
  expect(await lock()).toEqual({ productId: item.productId, attempts: 1 });
  await db.update(productAuditItems).set({ aiDecision: "approve" }).where(eq(productAuditItems.id, item.id));
  expect(await lock()).toBeNull();
  await db.update(productAuditItems).set({ aiDecision: null }).where(eq(productAuditItems.id, item.id));
  await db.update(productAuditCampaigns).set({ status: "cancelled" }).where(eq(productAuditCampaigns.id, campaign.id));
  expect(await lock()).toBeNull();
});

it("audit: a real tick binds the audit item, runs the fake Claude once with reviewWithAgent's argv, settles, then records one attempt", async () => {
  vi.stubEnv("FAKE_CLI_MODE", "ok");
  await saveSettings({ enabled: true, firstReview: { provider: "claude-cli", model: AUDIT_MODEL }, reviewConcurrency: 1 }, "test");
  await listed("audit/one");
  expect(await startProductAudit({ startedBy: "jr", reason: "슬롯 확인", reauditKept: false })).toMatchObject({ ok: true, enrolled: 1 });
  await pendingJob("product-audit");
  const [item] = await db.select().from(productAuditItems);

  expect(await runJob("product-audit", auditPublishedProducts, { requestedOnly: true,
    budgetMs: jobRunOptions("product-audit", { requestedOnly: true }).budgetMs })).toMatchObject({ status: "completed" });

  const [request, ...extra] = await requests();
  expect(extra).toEqual([]);
  expect(request).toMatchObject({ state: "settled", route_id: "product-audit", class: "background", provider: "claude-cli",
    logical_work_key: `bg:audit:${item.id}`, logical_member_keys: null });
  expect(request.dispatch_binding).toMatchObject({ kind: "product_audit_cli", itemId: item.id, campaignId: item.campaignId, productId: item.productId,
    slug: "one", attempts: 0, job: { name: "product-audit" } });
  expect(request.terminal_evidence?.process).toMatchObject({ ending: "exited", exitCode: 0 });
  const attempts = await db.select().from(productAuditAttempts);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ itemId: item.id, provider: "claude-cli", model: AUDIT_MODEL, errorCode: null, outcome: { decision: "approve" } });
  expect(attempts[0].inputHash).toBe((request.dispatch_binding as { inputHash: string }).inputHash);
  expect((await db.select().from(productAuditItems))[0]).toMatchObject({ aiDecision: "approve", attempts: 1 });
  const [spawned] = await recorded();
  expect(spawned).toMatchObject({ argv: reviewCliArgs(AUDIT_MODEL), env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2000", CLAUDECODE: null } });
}, PROCESS_TEST_MS);

it("grok session: a real tick runs the session call in this instance's slot and observes success after the terminal settles", async () => {
  vi.stubEnv("FAKE_CLI_MODE", "grok-ok");
  await saveSettings({ enabled: true, firstReview: { provider: "grok-cli", model: GROK_MODEL } }, "test");
  await pendingJob("grok-session-check");

  expect(await runJob<null>("grok-session-check", ctx => checkGrokSession(ctx), { requestedOnly: true })).toMatchObject({ status: "completed", done: true });

  const [request] = await requests();
  expect(request).toMatchObject({ state: "settled", route_id: "grok-session-check", provider: "grok-cli", provider_budget_id: "grok-sub",
    logical_work_key: grokSessionLogicalWorkKey(prefix) });
  expect(request.dispatch_binding).toMatchObject({ kind: "grok_session_cli", instanceId: prefix, model: GROK_MODEL });
  expect(request.terminal_evidence?.process).toMatchObject({ ending: "exited", exitCode: 0 });
  const [observation] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, `service:grok:${prefix}`));
  expect(observation.value).toMatchObject({ provider: "grok-cli", model: GROK_MODEL, resolvedModel: "grok-4.7-build", result: "success" });
  const [spawned] = await recorded();
  expect(spawned).toMatchObject({ argv: grokSessionArgs(GROK_MODEL), env: { NO_COLOR: "1", RUST_LOG: "off" } });
}, PROCESS_TEST_MS);

it("grok session (D3): while this instance's earlier session call is still held, the next check defers and the observation does not move", async () => {
  // 위험: 세션 점검은 4시간마다 토큰을 갱신하는 호출이다. 점유가 풀리지 않거나 슬롯이 오래 막히면 갱신 호출도 관측 갱신도 없다 —
  // 6시간 토큰이 그사이 만료되면 다음 Grok 심사가 auth 로 실패한다(설계 D3, 회수는 D11).
  vi.stubEnv("FAKE_CLI_MODE", "grandchild-hold");
  await saveSettings({ enabled: true, firstReview: { provider: "grok-cli", model: GROK_MODEL } }, "test");
  await pendingJob("grok-session-check");
  expect(await runJob<null>("grok-session-check", ctx => checkGrokSession(ctx), { requestedOnly: true })).toMatchObject({ status: "completed" });
  const [first] = await recorded();
  if (first?.grandchild) grandchildren.push(first.grandchild);
  const [held] = await requests();
  expect(held).toMatchObject({ state: "indeterminate" });
  const [observed] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, `service:grok:${prefix}`));
  expect(observed.value).toMatchObject({ result: "cli_error" });
  for (const name of await readdir(records)) await rm(path.join(records, name));
  vi.stubEnv("FAKE_CLI_MODE", "grok-ok");
  await pendingJob("grok-session-check");

  expect(await runJob<null>("grok-session-check", ctx => checkGrokSession(ctx), { requestedOnly: true }))
    .toMatchObject({ status: "deferred", reason: "model_capacity" });

  expect(await recorded()).toEqual([]);
  expect((await requests()).map(row => row.request_id)).toEqual([held.request_id]);
  const [after] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, `service:grok:${prefix}`));
  expect(after).toEqual(observed);
}, PROCESS_TEST_MS);
