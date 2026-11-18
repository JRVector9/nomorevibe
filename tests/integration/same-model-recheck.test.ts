import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { aiConnections, aiTaskModels, crawlCandidates, crawlDocuments, crawlSettings, jobs, modelServingContracts, operationsObservations, productAuditCampaigns,
  productAuditItems, productAuditSecondOpinions, productAuditSameModelRechecks, products, roleLeases } from "@/lib/db/schema";
import { putDocument } from "@/lib/crawl/repository";
import { getSettings, saveSettings, setQwenAutoStep } from "@/lib/crawl/settings";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { reviewAuditSecondOpinions } from "@/lib/crawl/jobs/audit-second-opinion";
import { resetQwenAuditBackoff } from "@/lib/crawl/qwen-endpoint-backoff";
import { qwenSecondOpinionStatus } from "@/lib/crawl/audit-second-opinion-auto";
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

/** 실제 SQL 선택·HTTP·계약·용량 장부·의견 쓰기를 작업 전용 Postgres에서 검증한다. */
const prefix = `same-recheck-${randomUUID().slice(0, 8)}`;
const admin = postgres(TEST_DATABASE_URL, { max: 3, prepare: false, onnotice: () => {} });
const CONNECTION = randomUUID(), MODEL = "fixture-api-model", GROUP = "fixture-api-device";
const BACKEND = auditDirectBackendId(CONNECTION, MODEL);
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { [BACKEND]: 4 }, groupLimits: { [GROUP]: 1 }, poolLimits: { reviewer: 4, text: 4 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 20, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "local-second-opinion", provider: "local-direct", model: MODEL, providerBudgetId: BACKEND, groupId: GROUP }] };
let server: Server, baseUrl = "", role: RoleLease, originalControl: Record<string, unknown>, sequence = 0;
const observed: { body: Record<string, unknown>; auth: string | null }[] = [];
let answer: { decision: "approve" | "reject"; confidence: number } = { decision: "approve", confidence: 0.9 };
let beforeReply: (() => Promise<void>) | null = null;
const OTHER_MODEL = "fixture-other-api-model";
const realFetch = globalThis.fetch;
const reply = () => JSON.stringify({ model: MODEL, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ decision: answer.decision,
  reason: answer.decision === "approve" ? "A usable application" : 'pageText: "Acme Studio" — a marketing site for a design agency, not a usable product',
  evidenceIds: ["product"], confidence: answer.confidence }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

/** 「발행분 감사 · 변경 재판정」 순위 스냅숏 — API 연결 1순위(그리고 넘겨받은 CLI 순위). 도메인 증명은 같은 순위를 DB 에서 읽는다 */
const apiRank = (rank = 1): AiTaskModelSnapshotRow => Object.freeze({ task: "audit-second-opinion", slot: 1, rank, model: MODEL, enabled: true, options: Object.freeze({}),
  connection: Object.freeze({ id: CONNECTION, label: "fixture-api", kind: "api" as const, baseUrl, cliTool: null, deviceId: GROUP, enabled: true,
    models: [{ id: MODEL, maxModelLen: 8192 }], contextTokens: null, apiKey: "fixture-key", keyUnreadable: false }) });

beforeAll(async () => {
  ensureSchema();
  server = createServer(async (request, response) => {
    let wire = ""; for await (const chunk of request) { wire += chunk; }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(404).end(); return; }
    observed.push({ body: JSON.parse(wire), auth: request.headers.authorization ?? null });
    await beforeReply?.();
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
  beforeReply = null;
  observed.length = 0; answer = { decision: "approve", confidence: 0.9 };
  resetQwenAuditBackoff();
  vi.stubEnv("ROLE_LEASE_ROLE", "reviewer"); vi.stubEnv("ROLE_LEASE_INSTANCE_ID", role.instanceId); vi.stubEnv("ROLE_LEASE_BOOT_ID", role.bootId);
  vi.stubEnv("ROLE_LEASE_RELEASE", role.release); vi.stubEnv("ROLE_LEASE_EPOCH", String(role.epoch));
  // 장비 표에 물리 상한 행이 없으면 워커 env 의 상한을 본다(local-model-capacity.ts localModelRouteReady)
  vi.stubEnv("LOCAL_MODEL_PHYSICAL_LIMITS", JSON.stringify({ [GROUP]: 1 }));
  expect(await renewRole(role)).toBe(true);
  await resetTables();
  await db.delete(operationsObservations).where(eq(operationsObservations.key, "same-model-recheck"));
  await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlSettings); await db.delete(jobs);
  expect(await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: "gateway-alias" } }, "fixture")).toMatchObject({ ok: true });
  expect(await setQwenAutoStep({ step: "auditSecondOpinion", expected: (await getSettings()).qwenAuto.auditSecondOpinion,
    next: { enabled: true, perTick: 10, scope: "all", autoClose: false, recollectPerTick: 1 }, actor: "fixture", reason: "회귀 시험" })).toMatchObject({ ok: true });
  // 순위 저장이 만드는 것: 연결·순위 행, 로컬 계약 행(readback 한 응답 모델·문맥 상한), local-audit 정책 route(OPEN)
  await db.insert(aiConnections).values({ id: CONNECTION, label: `fixture-api-${prefix}`, kind: "api", baseUrl, deviceId: GROUP, updatedBy: "fixture",
    models: [{ id: MODEL, maxModelLen: 8192 }] });
  await db.insert(aiTaskModels).values({ task: "audit-second-opinion", slot: 1, rank: 1, connectionId: CONNECTION, model: MODEL, updatedBy: "fixture" });
  const contract = auditDirectLocalContract({ routeId: "local-second-opinion", backendId: BACKEND, endpoint: `${baseUrl}/chat/completions`, model: MODEL, physicalGroup: GROUP },
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
  vi.stubEnv("AUDIT_SECOND_OPINION_MODEL", MODEL); vi.stubEnv("AUDIT_SECOND_OPINION_URL", baseUrl);
  expect(await setQwenAutoStep({ step: "sameModelRecheck", expected: (await getSettings()).qwenAuto.sameModelRecheck,
    next: { enabled: true, perTick: 1 }, actor: "fixture", reason: "같은 모델 재검토 시험" })).toMatchObject({ ok: true });
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
  await db.delete(modelServingContracts).where(sql`${modelServingContracts.routeId} in (${localModelContractRouteId(BACKEND)}, ${localModelContractRouteId(auditDirectBackendId(CONNECTION, OTHER_MODEL))})`);
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
async function recheckItem(days = 0) {
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
  const [item] = await db.insert(productAuditItems).values({ campaignId: stream.id, productId: product.id, slug, round: 1, enrolledAt: sql`now()`, aiDecision: "reject", aiProvider: "local-direct", aiModel: MODEL,
    aiConfidence: 0.97, aiReason: 'A company website, not a usable product', reviewedAt: new Date() }).returning();
  return { product, item };
}
const tick = () => runJob("audit-second-opinion", reviewAuditSecondOpinions, { budgetMs: jobRunOptions("audit-second-opinion", { requestedOnly: true }).budgetMs });
const ledger = async () => Array.from(await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r
  WHERE owner_instance_id LIKE ${prefix + "%"} ORDER BY queue_ordinal`).map(result => result.row);
const opinions = () => db.select().from(productAuditSecondOpinions);


const rechecks = () => db.select().from(productAuditSameModelRechecks);
const unchanged = async (itemId: number, productId: number) => {
  expect((await db.select().from(productAuditItems).where(eq(productAuditItems.id, itemId)))[0]).toMatchObject({ aiDecision: "reject", humanDecision: null });
  expect((await db.select().from(products).where(eq(products.id, productId)))[0]).toMatchObject({ status: "seeded", auditHoldAt: null });
};
describe("같은 모델 재검토의 실제 SQL·HTTP·장부·쓰기는 권고만", () => {
  it("켜짐 + 유지 — 별도 권고·출처/actor, 독립 집계 0, 원본 결정/상태/보류 불변", async () => {
    const { item, product } = await recheckItem();
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(observed).toHaveLength(1);
    expect((observed[0].body.messages as {content: string}[])[0].content).toContain("SAME-MODEL RECHECK");
    expect((observed[0].body.messages as {content: string}[])[1].content).toContain("A company website");
    expect(await rechecks()).toMatchObject([{ itemId: item.id, decision: "approve", source: "same-model-recheck", actor: "same-model-recheck", model: MODEL }]);
    expect(await opinions()).toEqual([]);
    expect((await qwenSecondOpinionStatus(await getSettings())).audit).toMatchObject({ lastDay: 0, remaining: 0 });
    expect(await ledger()).toMatchObject([{ state: "settled", route_id: "local-second-opinion", model: MODEL,
      dispatch_binding: { promptVersion: "2026-11-17.same-model-recheck.v1" } }]);
    await unchanged(item.id, product.id);
    const { listAuditFindings } = await import("@/lib/crawl/product-audit");
    expect(await listAuditFindings(item.campaignId, "reject", { limit: 20, offset: 0 })).toMatchObject([{ sameModelRecheck: { model: MODEL, source: "same-model-recheck" }, second: [] }]);
    await db.update(jobs).set({ notBefore: null }).where(eq(jobs.name, "audit-second-opinion"));
    await tick(); expect(observed).toHaveLength(1);
  });
  it("켜짐 + 거절 — 기록 외 아무 변화 없고 표시·독립 의견·숨김 없음", async () => {
    answer = { decision: "reject", confidence: 0.99 };
    const { item, product } = await recheckItem(); await tick();
    expect(observed).toHaveLength(1); expect(await rechecks()).toMatchObject([{ decision: "reject" }]);
    await unchanged(item.id, product.id); expect(await opinions()).toEqual([]);
    const { listAuditFindings } = await import("@/lib/crawl/product-audit");
    expect(await listAuditFindings(item.campaignId, "reject", { limit: 20, offset: 0 })).toMatchObject([{ sameModelRecheck: null, second: [] }]);
  });
  it("받는 동안 스위치를 끄면 응답을 기록하지 않는다", async () => {
    const { item, product } = await recheckItem();
    beforeReply = async () => {
      expect(await setQwenAutoStep({ step: "sameModelRecheck", expected: (await getSettings()).qwenAuto.sameModelRecheck,
        next: { enabled: false, perTick: 1 }, actor: "fixture" })).toMatchObject({ ok: true });
    };
    await tick(); expect(observed).toHaveLength(1); expect(await rechecks()).toEqual([]); expect(await opinions()).toEqual([]);
    await unchanged(item.id, product.id);
  });
  it("처음 거절 사유가 바뀌면 예전 사유의 유지 권고를 붙이지 않는다", async () => {
    const { item, product } = await recheckItem();
    beforeReply = async () => { await db.update(productAuditItems).set({ aiReason: "New rejection evidence" }).where(eq(productAuditItems.id, item.id)); };
    await tick(); expect(observed).toHaveLength(1); expect(await rechecks()).toEqual([]); await unchanged(item.id, product.id);
  });
  it("꺼짐 — 사람 몫 그대로, 예약·HTTP·기록 없음", async () => {
    const { item, product } = await recheckItem();
    await setQwenAutoStep({ step: "sameModelRecheck", expected: (await getSettings()).qwenAuto.sameModelRecheck,
      next: { enabled: false, perTick: 1 }, actor: "fixture" });
    await tick(); expect(observed).toEqual([]); expect(await ledger()).toEqual([]); expect(await rechecks()).toEqual([]);
    await unchanged(item.id, product.id);
  });
  it("틱당 1건 — 세 항목이어도 한 번만", async () => {
    await recheckItem(); await recheckItem(); await recheckItem();
    await tick(); expect(observed).toHaveLength(1); expect(await rechecks()).toHaveLength(1);
  });
  it("다른 검증된 모델이 있으면 same-model로 넘어가지 않는다(다른 모델의 용량 부족도 예외 아님)", async () => {
    await recheckItem();
    const backend = auditDirectBackendId(CONNECTION, OTHER_MODEL);
    const contract = auditDirectLocalContract({ routeId: "local-second-opinion", backendId: backend,
      endpoint: `${baseUrl}/chat/completions`, model: OTHER_MODEL, physicalGroup: GROUP }, CONNECTION,
      { responseModel: OTHER_MODEL, totalTokenBound: 8192 })!;
    const routeId = localModelContractRouteId(backend);
    await db.insert(modelServingContracts).values({ routeId, model: OTHER_MODEL, contract: { ...contract, routeId },
      contractHash: localModelContractHash(contract), auth: "none", transport: "direct", enabled: true, updatedBy: "fixture" });
    await ensureServingContracts(0);
    await db.insert(aiTaskModels).values({ task: "audit-second-opinion", slot: 1, rank: 2, connectionId: CONNECTION, model: OTHER_MODEL, updatedBy: "fixture" });
    setAiTaskModelsForTest([apiRank(), { ...apiRank(2), model: OTHER_MODEL }]);
    await tick();
    // Independent rank has no capacity-policy route. Wait for that rank, never reuse the rejecting model.
    expect(observed).toEqual([]); expect(await rechecks()).toEqual([]); expect(await opinions()).toEqual([]);
  });
  it("지난 입력은 거절 의견을 만들지 않고 사람에게 남긴다", async () => {
    const { item, product } = await recheckItem(2); await tick();
    expect(observed).toEqual([]); expect(await ledger()).toEqual([]); expect(await rechecks()).toEqual([]);
    await unchanged(item.id, product.id);
  });
});
