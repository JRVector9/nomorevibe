import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import postgres from "postgres";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { aiConnections, aiTaskModels, crawlCandidates, crawlDocuments, crawlSettings, jobs, modelServingContracts, productAuditAttempts, productAuditCampaigns,
  productAuditItems, products, roleLeases } from "@/lib/db/schema";
import { putDocument } from "@/lib/crawl/repository";
import { saveSettings } from "@/lib/crawl/settings";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { auditWithQwenDirect } from "@/lib/crawl/jobs/audit-qwen";
import { noteRecheckRankPaused, resetRecheckLanes } from "@/lib/crawl/published-recheck-lanes";
import { runJob } from "@/lib/jobs/runner";
import { releaseRole, renewRole, tryAcquireRole, type RoleLease } from "@/lib/jobs/role-leader";
import { setAiTaskModelsForTest, type AiTaskModelSnapshotRow } from "@/lib/llm/ai-task-models-snapshot";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { localModelContractRouteId } from "@/lib/llm/local-model-contract-table";
import { localModelContractHash } from "@/lib/llm/local-model-serving-contract";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { auditDirectBackendId, auditDirectLocalContract } from "@/lib/operations/admin-ai-tasks-repository";
import { jobRunOptions } from "@/scripts/worker";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";

vi.mock("server-only", () => ({}));

/**
 * 공개분 변경 재판정의 API 순위(2026-11-09) — 「발행분 감사 · 변경 재판정」의 API 연결 순위가 감사 직접 경로(route local-audit)로 묻는다.
 * 순위 저장이 만드는 것과 같은 로컬 계약 행(관리 표 local-model:<backend>)·정책 route(local-audit)·OPEN 장부·역할 lease 를 두고, Qwen 직접 감사 잡(audit-qwen)의
 * 한 틱을 진짜로 돌린다. 엔진만 이 파일의 HTTP 서버다. 장부 CHECK(0155 의 audit-qwen 가지)·도메인 증명·답 기록을 실제 DB 로 본다 — 새 CHECK 가지 없이 통과한다.
 */
const prefix = `recheck-direct-${randomUUID().slice(0, 8)}`;
const admin = postgres(TEST_DATABASE_URL, { max: 3, prepare: false, onnotice: () => {} });
const CONNECTION = randomUUID(), MODEL = "fixture-api-model", GROUP = "fixture-api-device";
const BACKEND = auditDirectBackendId(CONNECTION, MODEL);
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { [BACKEND]: 4 }, groupLimits: { [GROUP]: 1 }, poolLimits: { reviewer: 4, text: 4 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 20, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "local-audit", provider: "local-direct", model: MODEL, providerBudgetId: BACKEND, groupId: GROUP }] };
let server: Server, baseUrl = "", role: RoleLease, originalControl: Record<string, unknown>, sequence = 0;
const observed: { body: Record<string, unknown>; auth: string | null }[] = [];
let answer: { decision: "approve" | "reject"; confidence: number } = { decision: "approve", confidence: 0.9 };
const realFetch = globalThis.fetch;
const reply = () => JSON.stringify({ model: MODEL, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ decision: answer.decision,
  reason: answer.decision === "approve" ? "A usable application" : 'pageText: "Acme Studio" — a marketing site for a design agency, not a usable product',
  evidenceIds: ["product"], confidence: answer.confidence }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

/** 「발행분 감사 · 변경 재판정」 순위 스냅숏 — API 연결 1순위(그리고 넘겨받은 CLI 순위). 도메인 증명은 같은 순위를 DB 에서 읽는다 */
const apiRank = (rank = 1): AiTaskModelSnapshotRow => Object.freeze({ task: "product-audit", slot: 1, rank, model: MODEL, enabled: true, options: Object.freeze({}),
  connection: Object.freeze({ id: CONNECTION, label: "fixture-api", kind: "api" as const, baseUrl, cliTool: null, deviceId: GROUP, enabled: true,
    models: [{ id: MODEL, maxModelLen: 8192 }], contextTokens: null, apiKey: "fixture-key", keyUnreadable: false }) });
const cliRank = (rank: number): AiTaskModelSnapshotRow => Object.freeze({ task: "product-audit", slot: 1, rank, model: "sonnet", enabled: true, options: Object.freeze({}),
  connection: Object.freeze({ id: randomUUID(), label: "Claude CLI", kind: "cli" as const, baseUrl: null, cliTool: "claude", deviceId: "anthropic-cli", enabled: true,
    models: null, contextTokens: null, apiKey: null, keyUnreadable: false }) });

beforeAll(async () => {
  ensureSchema();
  server = createServer(async (request, response) => {
    let wire = ""; for await (const chunk of request) { wire += chunk; }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(404).end(); return; }
    observed.push({ body: JSON.parse(wire), auth: request.headers.authorization ?? null });
    response.setHeader("content-type", "application/json");
    response.end(reply());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
  vi.stubGlobal("fetch", ((url, init) => {
    if (!String(url).startsWith(baseUrl)) throw new Error("fixture_global_endpoint_required");
    return realFetch(url, init);
  }) as typeof fetch);
  [{ row: originalControl }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  const acquired = await tryAcquireRole({ role: "reviewer", instanceId: prefix, bootId: randomUUID(), release: "fixture", kind: "primary" });
  if (!acquired) throw new Error("fixture_role"); role = acquired;
});
beforeEach(async () => {
  observed.length = 0; answer = { decision: "approve", confidence: 0.9 };
  resetRecheckLanes();
  vi.stubEnv("ROLE_LEASE_ROLE", "reviewer"); vi.stubEnv("ROLE_LEASE_INSTANCE_ID", role.instanceId); vi.stubEnv("ROLE_LEASE_BOOT_ID", role.bootId);
  vi.stubEnv("ROLE_LEASE_RELEASE", role.release); vi.stubEnv("ROLE_LEASE_EPOCH", String(role.epoch));
  // 장비 표에 물리 상한 행이 없으면 워커 env 의 상한을 본다(local-model-capacity.ts localModelRouteReady)
  vi.stubEnv("LOCAL_MODEL_PHYSICAL_LIMITS", JSON.stringify({ [GROUP]: 1 }));
  expect(await renewRole(role)).toBe(true);
  await resetTables();
  await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlSettings); await db.delete(jobs);
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: "gateway-alias" } }, "fixture");
  // 순위 저장이 만드는 것: 연결·순위 행, 로컬 계약 행(readback 한 응답 모델·문맥 상한), local-audit 정책 route(OPEN)
  await db.insert(aiConnections).values({ id: CONNECTION, label: `fixture-api-${prefix}`, kind: "api", baseUrl, deviceId: GROUP, updatedBy: "fixture",
    models: [{ id: MODEL, maxModelLen: 8192 }] });
  await db.insert(aiTaskModels).values({ task: "product-audit", slot: 1, rank: 1, connectionId: CONNECTION, model: MODEL, updatedBy: "fixture" });
  const contract = auditDirectLocalContract({ routeId: "local-audit", backendId: BACKEND, endpoint: `${baseUrl}/chat/completions`, model: MODEL, physicalGroup: GROUP },
    CONNECTION, { responseModel: MODEL, totalTokenBound: 8192 })!;
  expect(contract).toMatchObject({ protocol: "local-openai-chat-v1", deploymentRevision: `ai-connection:${CONNECTION}`,
    thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" } });
  const routeId = localModelContractRouteId(BACKEND);
  await db.insert(modelServingContracts).values({ routeId, model: MODEL, contract: { ...contract, routeId }, contractHash: localModelContractHash(contract),
    auth: "none", transport: "direct", enabled: true, updatedBy: "fixture" });
  await ensureServingContracts(0);
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(policy)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
  setAiTaskModelsForTest([apiRank()]);
});
async function clearFixtureLedger() {
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = (await tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id LIKE ${prefix + "%"} FOR UPDATE`).map(row => row.request_id);
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
  });
}
afterEach(async () => {
  setAiTaskModelsForTest(null);
  vi.unstubAllEnvs();
  await clearFixtureLedger();
  await db.delete(aiTaskModels).where(eq(aiTaskModels.connectionId, CONNECTION));
  await db.delete(aiConnections).where(eq(aiConnections.id, CONNECTION));
  await db.delete(modelServingContracts).where(eq(modelServingContracts.routeId, localModelContractRouteId(BACKEND)));
  await ensureServingContracts(0);
});
afterAll(async () => {
  try {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (originalControl) await admin.begin(async tx => {
      await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
      await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,
        updated_at=r.updated_at FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
    });
    if (role) await releaseRole(role);
    await db.delete(roleLeases).where(eq(roleLeases.role, "reviewer"));
    await resetTables();
  } finally { vi.unstubAllGlobals(); await admin.end(); }
});

/** 공개 제품 하나와 재판정 줄의 항목 하나 — 원본은 days 일 전에 받은 것(공개 제품의 원본은 대개 하루가 지났다) */
async function recheckItem(days = 3) {
  const slug = `${prefix}-${++sequence}`, repo = `${prefix}/${slug}`, url = `https://${slug}.example`;
  const [product] = await db.insert(products).values({ slug, url, name: slug, tagline: "A task tool", description: "A usable task tool",
    category: "Productivity", status: "seeded", source: "crawler", verifyToken: randomUUID(), editTokenHash: "a".repeat(64) }).returning();
  await putDocument({ repo, productUrl: url, pageStatus: 200, repoMeta: { description: "A task tool", pushed_at: new Date().toISOString(),
    stargazers_count: 5, owner: { type: "User" } }, pageMeta: { title: slug, textSample: "Open the application and manage tasks.".repeat(12) } });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - days * 86_400_000) }).where(eq(crawlDocuments.repo, repo));
  await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", publishedSlug: slug, reason: "passed", decidedBy: "auto", judgedAt: new Date() });
  let [stream] = await db.select().from(productAuditCampaigns).where(eq(productAuditCampaigns.status, "rolling"));
  stream ??= (await db.insert(productAuditCampaigns).values({ startedBy: "system:published-recheck", reason: prefix, promptVersion: REVIEW_PROMPT_VERSION,
    rulesVersion: REVIEW_RULES_VERSION, provider: "product-audit-ranks", model: "product-audit-ranks", status: "rolling" }).returning())[0];
  const [item] = await db.insert(productAuditItems).values({ campaignId: stream.id, productId: product.id, slug, round: 1, enrolledAt: sql`now()` }).returning();
  return { product, item };
}
const tick = () => runJob("audit-qwen", auditWithQwenDirect, { budgetMs: jobRunOptions("audit-qwen", { requestedOnly: true }).budgetMs });
const ledger = async () => Array.from(await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r
  WHERE owner_instance_id LIKE ${prefix + "%"} ORDER BY queue_ordinal`).map(result => result.row);
const itemOf = async (id: number) => (await db.select().from(productAuditItems).where(eq(productAuditItems.id, id)))[0];

describe("재판정의 API 순위 — 감사 직접 경로(local-audit)", () => {
  it("순위의 연결 주소·모델·키로 묻고, 장부는 audit-qwen 잡의 direct:audit 행으로 정산된다 — 하루 지난 원본도 묻는다(근거 나이로 거절하지 않음)", async () => {
    const { item, product } = await recheckItem(3);
    answer = { decision: "reject", confidence: 0.97 };
    expect(await tick()).toMatchObject({ status: "completed" });

    // 엔진: 순위 연결의 키(Bearer)·모델, 1차·감사와 같은 정책 글(Qwen-v2 덧붙임 없음), thinking 은 계약이 정한 칸
    expect(observed).toHaveLength(1);
    expect(observed[0].auth).toBe("Bearer fixture-key");
    expect(observed[0].body).toMatchObject({ model: MODEL, stream: false, chat_template_kwargs: { enable_thinking: false } });
    expect(observed[0].body).not.toHaveProperty("reasoning_effort");
    expect(observed[0].body).not.toHaveProperty("context_strategy");
    const system = (observed[0].body.messages as { content: string }[])[0].content;
    expect(system).not.toContain("SECOND-OPINION NOTES");

    // 답은 감사와 같은 길 — 재판정 항목에 지금 글 판, 확신 높은 회사 소개 거절은 감사 보류
    expect(await itemOf(item.id)).toMatchObject({ aiDecision: "reject", aiProvider: "local-direct", aiModel: MODEL, promptVersion: REVIEW_PROMPT_VERSION,
      rulesVersion: REVIEW_RULES_VERSION, attempts: 1 });
    const attempts = await db.select().from(productAuditAttempts).orderBy(asc(productAuditAttempts.id));
    expect(attempts.map(row => [row.provider, row.model, row.promptVersion, row.errorCode])).toEqual([["local-direct", MODEL, REVIEW_PROMPT_VERSION, null]]);
    const [held] = await db.select().from(products).where(eq(products.id, product.id));
    expect(held.auditHoldItemId).toBe(item.id);

    // 장부: 감사 직접 경로의 기존 binding 그대로(0155 CHECK 가지) — 잡 이름은 audit-qwen
    const [row] = await ledger();
    expect(row).toMatchObject({ state: "settled", route_id: "local-audit", provider: "local-direct", model: MODEL, class: "background", pool: "reviewer",
      group_id: GROUP, provider_budget_id: BACKEND, logical_work_key: `direct:audit:${item.id}:audit`,
      dispatch_binding: { kind: "local_model_direct", promptVersion: REVIEW_PROMPT_VERSION, job: { name: "audit-qwen" },
        target: { kind: "audit", purpose: "audit", itemId: item.id }, deploymentRevision: `ai-connection:${CONNECTION}` } });
  });

  it("도메인 증명: 그 모델이 지금 「발행분 감사 · 변경 재판정」의 API 순위가 아니면 부르기 전에 거절한다 — 항목은 그대로", async () => {
    const { item } = await recheckItem(1);
    // 순위 표에서는 지웠는데 이 프로세스의 스냅숏은 아직 옛 순위다
    await db.delete(aiTaskModels).where(eq(aiTaskModels.connectionId, CONNECTION));
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(observed).toHaveLength(0);
    expect(await itemOf(item.id)).toMatchObject({ aiDecision: null, attempts: 0, errorCode: null });
    const [row] = await ledger();
    expect(row).toMatchObject({ state: "withdrawn", route_id: "local-audit" });
    const events = Array.from(await admin`SELECT evidence FROM model_capacity_events WHERE request_id=${row.request_id}::uuid AND kind='reservation_cancelled'`);
    expect(events).toEqual([{ evidence: { version: 1, kind: "local_model_domain_refused", check: "target_not_open" } }]);
    // 거절한 항목은 그 항목에서만 이 순위를 잠시 건너뛴다 — 다음 틱이 같은 거절로 장부 행을 또 쌓지 않는다(다른 줄이 다음 순위로 묻는다)
    await db.update(jobs).set({ notBefore: null }).where(eq(jobs.name, "audit-qwen"));
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(await ledger()).toHaveLength(1);
    expect(observed).toHaveLength(0);
  });

  it("순위 차례: 1순위가 CLI 면 감사 잡에 맡기고(부르지 않음), 감사 잡이 그 순위를 쉼으로 적었으면 2순위 API 로 묻는다", async () => {
    const cli = cliRank(1);
    setAiTaskModelsForTest([cli, apiRank(2)]);
    await db.update(aiTaskModels).set({ rank: 2 }).where(eq(aiTaskModels.connectionId, CONNECTION));
    const { item } = await recheckItem(1);
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(observed).toHaveLength(0);
    expect(await itemOf(item.id)).toMatchObject({ aiDecision: null, attempts: 0 });

    noteRecheckRankPaused({ rank: 1, provider: "claude-cli", connectionId: cli.connection.id, model: "sonnet" }, "capacity");
    await db.update(jobs).set({ notBefore: null }).where(eq(jobs.name, "audit-qwen"));
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(observed).toHaveLength(1);
    expect(await itemOf(item.id)).toMatchObject({ aiDecision: "approve", aiProvider: "local-direct", aiModel: MODEL });
  });

  it("로컬 계약이 없으면(순위를 저장하기 전) 부르지 않고 그 순위를 쉰다 — 항목의 시도를 쓰지 않는다", async () => {
    await db.delete(modelServingContracts).where(eq(modelServingContracts.routeId, localModelContractRouteId(BACKEND)));
    await ensureServingContracts(0);
    const { item } = await recheckItem(1);
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(observed).toHaveLength(0);
    expect(await itemOf(item.id)).toMatchObject({ aiDecision: null, attempts: 0, errorCode: null });
    expect(await db.select().from(productAuditAttempts)).toEqual([]);
  });
});
