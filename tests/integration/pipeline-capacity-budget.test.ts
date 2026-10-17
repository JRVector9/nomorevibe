import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Ai1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
const serving = vi.hoisted(() => ({ contract: undefined as Ai1GatewayServingContract | undefined }));
vi.mock("@/lib/crawl/agent-review-serving-contract", async load => {
  const original = await load<typeof import("@/lib/crawl/agent-review-serving-contract")>();
  return { ...original, resolveAi1GatewayServingContract: (model: string) => serving.contract ?? original.resolveAi1GatewayServingContract(model) };
});
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, jobs } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { claimAgentReview, loadReviewInput, recordAgentReview } from "@/lib/crawl/agent-review-repository";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { beginModelDispatch, requestModelSlot } from "@/lib/llm/capacity-repository";
import { runJob } from "@/lib/jobs/runner";
import { requestJob } from "@/lib/jobs/control";
import { tryAcquireRole, releaseRole, type RoleLease } from "@/lib/jobs/role-leader";
import { collectLiveCapacityWindow } from "@/lib/operations/pipeline-capacity-live-repository";
import { recordAi2Attempt } from "@/lib/operations/pipeline-evidence-ledger";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// 모델 슬롯 사건(0078)과 기록 시작 marker(0097)는 지울 수 없다. 공유 test DB를 더럽히지 않도록 이 파일만의 DB를 만든다(PR01b-8과 같은 방식).
const root = fileURLToPath(new URL("../..", import.meta.url));
const name = `nomorevibe_test_pr01b9_${randomBytes(6).toString("hex")}`;
const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const MODEL = "pr01b9-loopback-model", instanceId = "pr01b9-reviewer", bootId = randomUUID();
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { fixture: 1 }, groupLimits: { fixture: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 8, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model: MODEL, providerBudgetId: "fixture", groupId: "fixture" }] };
const settings = (): CrawlSettings => ({ ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "observe", reviewConcurrency: 1,
  firstReview: { provider: "abcllm", model: MODEL }, secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: false } });
let client: postgres.Sql | undefined, created = false, server: Server | undefined, role: RoleLease | null = null;

beforeAll(async () => {
  ensureSchema();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${name}`); created = true; } finally { await admin.end({ timeout: 5 }); }
  client = postgres(url.toString(), { max: 4, onnotice: () => {} });
  await client.unsafe("set statement_timeout = 0");
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  const g = globalThis as { db?: unknown; pgClient?: unknown }; g.pgClient = client; g.db = drizzle(client, { schema });
  // 실제 legacy AI1 잡이 열린 모델 슬롯으로 원 게이트웨이(loopback)를 한 번씩 부르고, 응답의 upstream_reported usage로 정산한다.
  server = createServer((request, response) => {
    request.resume(); request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "pr01b9-completion", object: "chat.completion", created: 1, model: MODEL, choices: [{ index: 0,
        finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ decision: "reject", confidence: 0.99,
          reason: "Not a deployed product", evidenceIds: ["product"] }) } }], usage_provenance: "upstream_reported",
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  serving.contract = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm", model: MODEL,
    responseModel: MODEL, deploymentRevision: "pr01b9-fixture", totalTokenBound: 8192,
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions` };
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected_external_http"); }));
  vi.stubEnv("ABCLLM_API_KEY", "pr01b9-local-only");
  await db.insert(crawlSettings).values({ id: 1, values: settings(), updatedBy: "pr01b9" });
  role = await tryAcquireRole({ role: "reviewer", instanceId, bootId, release: "pr01b9", kind: "primary" });
  expect(role).not.toBeNull();
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: instanceId, ROLE_LEASE_BOOT_ID: bootId,
    ROLE_LEASE_RELEASE: "pr01b9", ROLE_LEASE_EPOCH: String(role!.epoch) })) vi.stubEnv(key, value);
}, 600_000);
afterAll(async () => {
  if (role) await releaseRole(role);
  serving.contract = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  const g = globalThis as { db?: unknown; pgClient?: unknown }; delete g.db; delete g.pgClient;
  await client?.end({ timeout: 5 });
  if (!created) return;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

async function source(index: number) {
  const repo = `pr01b9/app-${index}`, fetchedAt = new Date(Date.now() - 2_000), productUrl = `https://pr01b9-${index}.example`;
  await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt, pageStatus: 200,
    repoMeta: { description: "A deployed task tracker", pushed_at: fetchedAt.toISOString(), owner: { type: "User" }, stargazers_count: 3 },
    pageMeta: { title: "Task tracker", description: "Create projects and manage tasks online", textSample: "Create projects and manage tasks online.",
      readmeSample: "A deployed task tracker", readmeSampleVersion: README_SAMPLE_VERSION } });
  await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed", decidedBy: "auto", judgedAt: fetchedAt, updatedAt: fetchedAt });
}
const open = async () => client!`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,
  policy_hash=${modelCapacityPolicyHash(policy)} WHERE id=1`;
/** 픽스처: 모드·정책은 구간 시작 전부터 그대로였다는 전제(grant의 cursor 갱신만 지운다). 실제 동작은 첫 it이 보인다. */
const backdateControl = async () => client!`UPDATE model_capacity_control SET updated_at=clock_timestamp()-interval '2 days' WHERE id=1`;
async function budget() {
  await new Promise(resolve => setTimeout(resolve, 20));
  const [{ now }] = await client!`SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  const end = Date.parse(now as string);
  const artifact = await collectLiveCapacityWindow(db, { runId: "pr01b9", revision: "9e13341", target: "primary",
    startedAt: new Date(end - 40 * 60_000).toISOString(), endedAt: new Date(end).toISOString() });
  return { budget: artifact.budget, modelCapacity: artifact.modelCapacity };
}

it("counts real AI1 dispatches, yet a grant's cursor write already marks the control row changed (PR01b-9 blocker)", async () => {
  // 0097 기록 시작은 구간보다 2시간 앞선다(운영자가 미리 남긴 marker를 흉내 낸다). AI2 호출 기록이 구간을 덮는다.
  await client!`INSERT INTO pipeline_evidence_events (kind, revision, operator, created_at)
    VALUES ('recorder_started', '9e13341', 'pr01b9-root', clock_timestamp() - interval '2 hours')`;
  await client!`UPDATE pipeline_stage_modes SET updated_at=clock_timestamp()-interval '2 days'`;
  for (let index = 1; index <= 3; index++) await source(index);
  await open(); await backdateControl();
  for (let tick = 0; tick < 8; tick++) {
    const [{ count }] = await client!`SELECT count(*)::int AS count FROM crawl_review_attempts WHERE state <> 'running'`;
    if (count === 3) break;
    await requestJob("crawl-agent-review");
    await runJob("crawl-agent-review", reviewCrawlCandidates, { requestedOnly: true, roleLease: role! });
  }
  const rows = await client!`SELECT r.state, r.dispatch_binding->>'attemptId' AS attempt_id, r.terminal_evidence->'actualUsage'->'totalTokens' AS total,
    a.state AS attempt_state FROM model_capacity_requests r JOIN crawl_review_attempts a ON a.id::text = r.dispatch_binding->>'attemptId' ORDER BY a.id`;
  expect(rows.map(row => [row.state, row.total, row.attempt_state])).toEqual([["settled", 120, "succeeded"], ["settled", 120, "succeeded"],
    ["settled", 120, "succeeded"]]);
  // 실제 grant는 control.cursor와 updated_at을 함께 쓴다. 그래서 열린 모드의 어느 구간도 '시작 뒤 바뀜'으로 보이고 budget이 막힌다.
  expect(await budget()).toEqual({ modelCapacity: { mode: "open", changedSinceStart: true },
    budget: { status: "unverified", source: "model_capacity_ledger", issues: ["model_capacity_changed_since_window_start"] } });
}, 120_000);

it("verifies the same window once the control row is unchanged since its start, without writing", async () => {
  await backdateControl();
  const before = await client!`SELECT (SELECT count(*) FROM model_capacity_events)::int AS events, (SELECT count(*) FROM pipeline_evidence_events)::int AS ledger`;
  expect(await budget()).toEqual({ modelCapacity: { mode: "open", changedSinceStart: false }, budget: { status: "verified",
    source: "model_capacity_ledger", calls: 3, chargedTokens: 360, reportedCalls: 3, boundCalls: 0, concurrency: { limit: 1, peak: 1 } } });
  expect(await client!`SELECT (SELECT count(*) FROM model_capacity_events)::int AS events, (SELECT count(*) FROM pipeline_evidence_events)::int AS ledger`)
    .toEqual(before);
});

it("stays unverified for one recorded AI2 call that no ledger dispatch covers", async () => {
  await db.transaction(tx => recordAi2Attempt(tx, { stage: "ai2", secondReviewId: 999 }, { rootReviewId: 999, failed: true, code: "timeout" }));
  expect((await budget()).budget).toEqual({ status: "unverified", source: "model_capacity_ledger", issues: ["unattributed_ai2_calls"] });
});

it("stays unverified for one AI1 call made outside the ledger", async () => {
  // 슬롯을 끈 사이 원래 legacy 경로로 한 번 심사한다(장부 dispatch 없음). 모드는 다시 연 뒤 구간 전부터 그대로였다고 둔다.
  await client!`UPDATE model_capacity_control SET mode='disabled' WHERE id=1`;
  await source(4);
  const lease = { name: "crawl-agent-review", token: "pr01b9-legacy", requestedVersion: 1 };
  await db.update(jobs).set({ leaseToken: lease.token, lockedAt: new Date() }).where(sql`${jobs.name} = ${lease.name}`);
  const [candidate] = await db.select().from(crawlCandidates).where(sql`${crawlCandidates.repo} = 'pr01b9/app-4'`);
  const [document] = await db.select().from(crawlDocuments).where(sql`${crawlDocuments.repo} = 'pr01b9/app-4'`);
  const context = { candidate, document, settings: settings(), lease, provider: "abcllm", model: MODEL,
    input: await loadReviewInput(candidate, document, settings()) };
  const claim = await claimAgentReview(context);
  if (claim.kind === "skipped") throw new Error(claim.reason);
  await recordAgentReview({ ...context, receipt: claim.receipt, outcome: { decision: "reject", reason: "Fixture", evidenceIds: ["product"], confidence: .9 } });
  await db.update(jobs).set({ leaseToken: null, lockedAt: null }).where(sql`${jobs.name} = ${lease.name}`);
  await open(); await backdateControl();
  expect((await budget()).budget).toEqual({ status: "unverified", source: "model_capacity_ledger",
    issues: ["unattributed_ai1_calls", "unattributed_ai2_calls"] });
}, 60_000);

it("stays unverified for a generic dispatch on a review route that carries no bound C", async () => {
  const value = { requestId: randomUUID(), workKey: randomUUID(), owner: { instanceId: `${instanceId}-generic`, bootId: randomUUID() },
    class: "first" as const, pool: "reviewer" as const, routeId: "crawl-agent-review", provider: "abcllm", model: MODEL };
  const granted = await requestModelSlot(value);
  if (granted.kind !== "granted") throw new Error(`generic_slot_${granted.reason}`);
  expect((await beginModelDispatch(granted.reservation)).kind).toBe("dispatched");
  await backdateControl();
  expect((await budget()).budget).toEqual({ status: "unverified", source: "model_capacity_ledger",
    issues: ["unattributed_ai1_calls", "unattributed_ai2_calls", "token_bound_missing"] });
});
