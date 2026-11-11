import http, { type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { and, eq, getTableColumns } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/net/fetch", async original => ({ ...await original<typeof import("@/lib/net/fetch")>(), safeFetch }));
import { db } from "@/lib/db";
import { cdnPurges, llmAssistResults, llmAssistWorks, modelCapacityRequests, operationsAudit, productEvidenceAudit, productHealth, products } from "@/lib/db/schema";
import { autoBanUptimeProduct } from "@/lib/domain/products/uptime-auto-ban";
import { reviewLlmAssist } from "@/lib/jobs/products/llm-assist-review";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { requestModelSlot, requestLocalModelSlot, cancelReservedModelSlot, cancelOwnPendingLocalModelRequest } from "@/lib/llm/capacity-repository";
import { localModelContractHash, sameLocalModelFamily, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { ASSIST_SCHEMA_VERSION } from "@/lib/domain/llm-assist/contracts";
import { assistCandidateSourceHash } from "@/lib/domain/llm-assist/work";
import type { JobContext } from "@/lib/jobs/runner";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const prefix = `assist-native-${randomUUID().slice(0, 8)}`;
const backendId = "fixture-gpu-qwen", model = "qwen3.8-flash-next", routeId = `local-assist-uptime-${backendId}`;
const jobName = "product-llm-assist-review", originJob = "uptime-ping", jobNames = [jobName, originJob];
const owner = { instanceId: prefix, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const server = http.createServer();
const ownedProducts: { id: number; slug: string; url: string }[] = [];
let contract: LocalModelServingContract, policy: ModelCapacityPolicy;
let originalCapacity: Record<string, unknown>, originalAssist: Record<string, unknown>, originalRole: Record<string, unknown> | null;
let originalJobs: Record<string, unknown>[], calls: { requestId: string; body: Record<string, unknown>; auth?: string }[] = [];
let responseKind: "closed" | "alive" | "invalid" | "unclear_retain" | "hosting_disabled" | "hosting_paused" = "closed", onCall: (() => Promise<void>) | null = null;
let hold: ((res: ServerResponse) => void) | null = null;
let jobToken = "", sequence = 0;

function modelOutcome() {
  if (responseKind === "unclear_retain") return { schema_version: ASSIST_SCHEMA_VERSION, task: "uptime",
    state: { page_state: "unclear", finding: "temporary_maintenance" },
    evidence_quality: { status: "partial", limitations: ["other"] },
    evidence: [{ source_id: "current-page", quote: "Service temporarily unavailable", supports: ["/state/page_state"] }],
    action: { proposal: "retain", reason_ko: "일시 장애로 서비스 상태를 확인해야 합니다.", missing_items: ["현재 서비스 상태"] } };
  const alive = responseKind === "alive";
  const quote = responseKind === "hosting_disabled" ? "Payment required DEPLOYMENT_DISABLED"
    : responseKind === "hosting_paused" ? "The deployment is currently unavailable DEPLOYMENT_PAUSED"
    : alive ? "Start your free plan" : "permanently closed";
  return { schema_version: ASSIST_SCHEMA_VERSION, task: "uptime", state: { page_state: alive ? "alive" : "closed",
    finding: alive ? "active_product" : "explicit_shutdown" }, evidence_quality: { status: "sufficient", limitations: ["none"] },
    evidence: [{ source_id: "current-page", quote, supports: ["/state/page_state"] }],
    action: { proposal: alive ? "retain" : "delist_candidate", reason_ko: alive ? "현재 이용 경로가 있습니다." : "서비스 전체 종료가 명시되어 있습니다.", missing_items: [] } };
}
function nativeResponse() {
  return { model, choices: [{ finish_reason: "stop", message: { role: "assistant",
    content: responseKind === "invalid" ? "not JSON" : JSON.stringify(modelOutcome()) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
}
async function eventually(check: () => Promise<boolean>) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("fixture_observation_deadline");
}
function context(signal?: AbortSignal): JobContext<null> {
  return { cursor: null, lease: { name: jobName, token: jobToken, requestedVersion: 0 }, signal,
    save: async () => {}, hasBudget: () => true, log: () => {} };
}
async function fixtureProduct(options: { shadow?: boolean } = {}) {
  const slug = `${prefix}-${++sequence}`;
  const [row] = await admin`INSERT INTO products(slug,url,name,tagline,description,category,status,verify_token,edit_token_hash,updated_at)
    VALUES(${slug},${`https://${slug}.example/`},${slug},'소개','설명','Other','seeded','fixture',${"x".repeat(64)},clock_timestamp()-interval '7 days')
    RETURNING id,slug,url`;
  const product = { id: Number(row.id), slug: String(row.slug), url: String(row.url) };
  ownedProducts.push(product);
  await admin`INSERT INTO product_health(slug,failures,status,checked_at,down_since)
    VALUES(${product.slug},10,404,clock_timestamp()-interval '1 minute',clock_timestamp()-interval '3 days')`;
  expect(await autoBanUptimeProduct(product)).toBe(options.shadow ?? false);
  return product;
}
async function status(id: number) { return (await db.select().from(products).where(eq(products.id, id)))[0]?.status; }
async function work(id: number) { return (await db.select().from(llmAssistWorks).where(eq(llmAssistWorks.productId, id)))[0]; }
async function requests() { return Array.from(await admin`SELECT * FROM model_capacity_requests WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal`); }
async function recordedResults() {
  return db.select(getTableColumns(llmAssistResults)).from(llmAssistResults)
    .innerJoin(modelCapacityRequests, eq(modelCapacityRequests.requestId, llmAssistResults.capacityRequestId))
    .where(eq(modelCapacityRequests.ownerInstanceId, prefix));
}
// 가짜 HTTP fixture가 끝난 뒤 이 owner의 행만 정리한다. 이 정리는 운영의 remote terminal 증거가 아니다.
async function cleanFixture() {
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = (await tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix} FOR UPDATE`).map(row => row.request_id);
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
    expect(Array.from(await tx`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`))
      .toEqual([{ tgname: "model_capacity_events_no_change", tgenabled: "A" }, { tgname: "model_capacity_events_no_truncate", tgenabled: "A" }]);
  });
  for (const product of ownedProducts.splice(0)) {
    await admin`DELETE FROM products WHERE id=${product.id} AND slug=${product.slug}`;
    await admin`DELETE FROM product_health WHERE slug=${product.slug}`;
    await admin`DELETE FROM cdn_purges WHERE slug=${product.slug}`;
  }
}
async function restoreSingletons() {
  await admin`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
    FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalCapacity)}::text::jsonb) r WHERE c.id=r.id`;
  expect(await admin`SELECT id FROM llm_assist_work WHERE task='uptime'`).toHaveLength(0);
  await admin`DELETE FROM llm_assist_controls WHERE task='uptime'`;
  await admin`INSERT INTO llm_assist_controls SELECT * FROM jsonb_populate_record(NULL::llm_assist_controls,${JSON.stringify(originalAssist)}::text::jsonb)`;
  await admin`DELETE FROM jobs WHERE name=ANY(${jobNames})`;
  if (originalJobs.length) await admin`INSERT INTO jobs SELECT * FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs)}::text::jsonb)`;
  await admin`DELETE FROM role_leases WHERE role='reviewer' AND owner_instance_id=${prefix}`;
  if (originalRole) await admin`INSERT INTO role_leases SELECT * FROM jsonb_populate_record(NULL::role_leases,${JSON.stringify(originalRole)}::text::jsonb)`;
}

beforeAll(async () => {
  ensureSchema();
  [{ row: originalCapacity }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  [{ row: originalAssist }] = await admin`SELECT to_jsonb(c) AS row FROM llm_assist_controls c WHERE task='uptime'`;
  originalRole = (await admin`SELECT to_jsonb(c) AS row FROM role_leases c WHERE role='reviewer'`)[0]?.row ?? null;
  originalJobs = (await admin`SELECT to_jsonb(c) AS row FROM jobs c WHERE name=ANY(${jobNames})`).map(row => row.row);
  expect(await admin`SELECT id FROM llm_assist_work WHERE task='uptime'`).toHaveLength(0);
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toHaveLength(0);
  server.on("request", async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({ requestId: String(req.headers["x-nmv-relay-request-id"] ?? ""), body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        ...(req.headers.authorization ? { auth: String(req.headers.authorization) } : {}) });
      await onCall?.();
      if (hold) { hold(res); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(nativeResponse()));
    } catch { res.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_server_missing");
  contract = { version: 1, protocol: "local-openai-chat-v1", backendId, provider: "local-direct", physicalGroup: "fixture-gpu",
    endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, model, responseModel: model, modelFamily: "qwen3.8-flash-next",
    deploymentRevision: "fixture-native-1", contextWindowTokens: 50000, totalTokenBound: 50000, maxOutputTokens: 2048, maxInputBytes: 100000,
    capabilities: { vision: false, jsonSchema: true }, thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } };
  policy = { version: 1, globalLimit: 1, providerLimits: { [backendId]: 1 }, groupLimits: { "fixture-gpu": 1 }, poolLimits: { reviewer: 1, text: 1 },
    weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 60000, reservationTtlMs: 60000,
    routes: [{ routeId, provider: "local-direct", model, providerBudgetId: backendId, groupId: "fixture-gpu" },
      { routeId: "fixture-blocker", provider: "fixture-provider", model: "blocker", providerBudgetId: backendId, groupId: "fixture-gpu" }] };
});
beforeEach(async () => {
  calls = []; responseKind = "closed"; onCall = null; hold = null; jobToken = randomUUID();
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: prefix, ROLE_LEASE_BOOT_ID: owner.bootId,
    ROLE_LEASE_RELEASE: prefix, ROLE_LEASE_EPOCH: "1", LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([contract]),
    LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify({ [backendId]: localModelContractHash(contract) }),
    LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ "fixture-gpu": 1 }), LLM_ASSIST_API_KEYS: JSON.stringify({ [backendId]: "fixture-key" }),
    LLM_ASSIST_BACKENDS: JSON.stringify([{ backendId, tasks: ["uptime"], maxClaims: 1 }]) })) vi.stubEnv(key, value);
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},cursor=0 WHERE id=1`;
  await admin`UPDATE llm_assist_controls SET mode='confirm',confirmation_required=true,dispatch_enabled=true,apply_enabled=true,revision=2 WHERE task='uptime'`;
  await admin`INSERT INTO role_leases(role,owner_instance_id,owner_boot_id,owner_release,owner_kind,epoch,lease_until)
    VALUES('reviewer',${prefix},${owner.bootId},${prefix},'primary',1,clock_timestamp()+interval '1 hour')
    ON CONFLICT(role) DO UPDATE SET owner_instance_id=excluded.owner_instance_id,owner_boot_id=excluded.owner_boot_id,
      owner_release=excluded.owner_release,owner_kind=excluded.owner_kind,epoch=1,lease_until=excluded.lease_until`;
  for (const name of jobNames) await admin`INSERT INTO jobs(name,lease_token,locked_at) VALUES(${name},${name===jobName ? jobToken : null},${name===jobName ? new Date() : null})
    ON CONFLICT(name) DO UPDATE SET lease_token=excluded.lease_token,locked_at=excluded.locked_at,not_before=NULL`;
  safeFetch.mockReset().mockImplementation(async (url: string) => ({ finalUrl: url,
    response: new Response("<h1>We permanently closed the entire service.</h1>", { status: 200 }) }));
});
afterEach(async () => {
  server.closeAllConnections();
  try { await cleanFixture(); await restoreSingletons(); }
  finally { vi.unstubAllEnvs(); }
});
afterAll(async () => {
  try {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    expect((await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`)[0]?.row).toEqual(originalCapacity);
    expect((await admin`SELECT to_jsonb(c) AS row FROM llm_assist_controls c WHERE task='uptime'`)[0]?.row).toEqual(originalAssist);
    expect((await admin`SELECT to_jsonb(c) AS row FROM role_leases c WHERE role='reviewer'`)[0]?.row ?? null).toEqual(originalRole);
    const restoredJobs = (await admin`SELECT to_jsonb(c) AS row FROM jobs c WHERE name=ANY(${jobNames})`).map(row => row.row);
    expect(restoredJobs).toHaveLength(originalJobs.length);
    expect(restoredJobs).toEqual(expect.arrayContaining(originalJobs));
    expect(await requests()).toHaveLength(0);
  }
  finally { await admin.end(); }
});

describe("보강 소비자의 native dispatch와 최종 적용", () => {
  async function initialShadow() {
    // confirm latch는 UPDATE로 되돌리지 않는다. 이 파일의 격리 fixture에서 최초 shadow 상태를 만든다.
    await admin`DELETE FROM llm_assist_controls WHERE task='uptime'`;
    await admin`INSERT INTO llm_assist_controls(task,mode,dispatch_enabled,revision) VALUES('uptime','shadow',true,2)`;
    return fixtureProduct({ shadow: true });
  }
  for (const finding of ["closed", "alive"] as const) it(`최초 shadow는 legacy 내림 뒤에도 ${finding} 결과를 계량·저장하고 적용하지 않는다`, async () => {
    const product = await initialShadow(); responseKind = finding;
    if (finding === "alive") safeFetch.mockResolvedValue({ finalUrl: product.url, response: new Response("<h1>Start your free plan</h1>") });
    expect(await status(product.id)).toBe("banned");
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1);
    expect((await requests())[0]).toMatchObject({ state: "settled" });
    expect(await work(product.id)).toMatchObject({ state: "done", attempts: 1 });
    expect(await recordedResults()).toMatchObject([{ applied: false, outcome: { state: { page_state: finding } } }]);
    expect(await status(product.id)).toBe("banned");
    expect(await db.select().from(productEvidenceAudit).where(and(eq(productEvidenceAudit.slug, product.slug), eq(productEvidenceAudit.action, "admin.product.ban")))).toHaveLength(1);
    expect(await db.select().from(operationsAudit).where(and(eq(operationsAudit.target, product.slug), eq(operationsAudit.action, "product-auto-ban-uptime")))).toHaveLength(1);
    await reviewLlmAssist(context()); expect(calls).toHaveLength(1);
  });
  it("shadow 후보를 confirm이나 confirmation latch가 열린 shadow로 승격하지 않는다", async () => {
    const product = await initialShadow();
    await admin`UPDATE llm_assist_controls SET mode='confirm',confirmation_required=true,apply_enabled=true WHERE task='uptime'`;
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(0); expect(await status(product.id)).toBe("banned");
    await admin`UPDATE llm_assist_controls SET mode='shadow',apply_enabled=false WHERE task='uptime'`;
    // 한 번 열린 confirmation latch가 있는 shadow도 과거 즉시 내림 후보를 재사용할 수 없다.
    await reviewLlmAssist(context()); expect(calls).toHaveLength(0);
  });
  for (const change of ["audit_id", "observed_revision", "administrator_release"] as const) it(`shadow의 ${change} 불일치도 모델 dispatch를 막는다`, async () => {
    const product = await initialShadow();
    if (change === "administrator_release") {
      await admin`INSERT INTO product_evidence_audit(slug,actor,action,created_at)
        VALUES(${product.slug},'admin','admin.product.unban',clock_timestamp())`;
    } else {
      const queued = await work(product.id), source = structuredClone(queued.source);
      if (source.kind !== "uptime" || !source.shadowBan) throw new Error("shadow_provenance_missing");
      if (change === "audit_id") source.shadowBan.auditId += 1_000_000;
      else source.shadowBan.observedProductUpdatedAt = "2000-01-01 00:00:00";
      await db.update(llmAssistWorks).set({ source, sourceHash: assistCandidateSourceHash(source) }).where(eq(llmAssistWorks.id, queued.id));
    }
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(0); expect(await recordedResults()).toHaveLength(0);
    expect(await status(product.id)).toBe("banned");
  });
  it("shadow 수집 중 제품 세대가 바뀌면 native dispatch를 거절한다", async () => {
    const product = await initialShadow();
    safeFetch.mockImplementationOnce(async () => {
      await admin`UPDATE products SET updated_at=updated_at+interval '1 microsecond' WHERE id=${product.id}`;
      return { finalUrl: product.url, response: new Response("<h1>We permanently closed the entire service.</h1>") };
    });
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(0); expect(await recordedResults()).toHaveLength(0);
    expect(await status(product.id)).toBe("banned");
  });
  it("충분한 종료 근거만 native 종료 원장·결과·두 감사·purge와 함께 한 번 적용한다", async () => {
    const product = await fixtureProduct();
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1);
    const [request] = await requests();
    expect(request).toMatchObject({ state: "settled", logical_work_key: `direct:assist:${product.id}:uptime` });
    expect(calls[0].requestId).toBe(request.request_id);
    expect(calls[0].body).toMatchObject({ stream: false, chat_template_kwargs: { enable_thinking: false } });
    expect(request.dispatch_binding).toMatchObject({ totalTokenBound: 50000, chargedTokens: 50000 });
    expect(await status(product.id)).toBe("banned");
    expect(await work(product.id)).toMatchObject({ state: "done", attempts: 1 });
    expect(await recordedResults()).toMatchObject([{ applied: true, capacityRequestId: request.request_id }]);
    expect(await db.select().from(productEvidenceAudit).where(and(eq(productEvidenceAudit.slug, product.slug), eq(productEvidenceAudit.action, "admin.product.ban")))).toHaveLength(1);
    expect(await db.select().from(operationsAudit).where(and(eq(operationsAudit.target, product.slug), eq(operationsAudit.action, "product-auto-ban-uptime")))).toHaveLength(1);
    expect(await db.select().from(cdnPurges).where(eq(cdnPurges.slug, product.slug))).toHaveLength(1);
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1);
  });
  it("2026-11-11 「작업 ↔ 모델」 LLM 보강 순위가 있으면 env(LLM_ASSIST_BACKENDS·LLM_ASSIST_API_KEYS)를 읽지 않고 그 순위의 연결 키로 같은 장부 route 를 부른다", async () => {
    const product = await fixtureProduct();
    // env 길이면 없는 backend 라 던진다 — 순위 길이 env 를 읽지 않는다는 증거
    vi.stubEnv("LLM_ASSIST_BACKENDS", JSON.stringify([{ backendId: "env-only-missing", tasks: ["uptime"], maxClaims: 1 }]));
    vi.stubEnv("LLM_ASSIST_API_KEYS", JSON.stringify({ [backendId]: "env-key" }));
    const logged: { event: string; data: Record<string, unknown> }[] = [];
    setAiTaskModelsForTest([{ task: "assist-review", slot: 1, rank: 1, model, enabled: true, options: {}, connection: { id: randomUUID(), label: "gpu fixture",
      kind: "api", baseUrl: contract.endpoint.replace(/\/chat\/completions$/, ""), cliTool: null, deviceId: "fixture-gpu", enabled: true, models: null,
      contextTokens: null, apiKey: "rank-key", keyUnreadable: false } }]);
    try {
      await reviewLlmAssist({ ...context(), log: (event: string, data?: Record<string, unknown>) => { logged.push({ event, data: data ?? {} }); } } as JobContext<null>);
    } finally { setAiTaskModelsForTest(null); }
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe("Bearer rank-key");
    const [request] = await requests();
    expect(request).toMatchObject({ state: "settled", route_id: routeId, provider: "local-direct", model });
    expect(await work(product.id)).toMatchObject({ state: "done", attempts: 1 });
    expect(await recordedResults()).toMatchObject([{ applied: true, backendId, capacityRequestId: request.request_id }]);
    // 작업 배정 「실행」 줄 — 1순위가 한 건을 맡았다
    expect(logged.find(entry => entry.event === "ai_task.ranks")?.data).toEqual({ ranks: 1, "served.1": 1 });
  });
  it("alive는 정식 실패 관측을 조작하지 않고 유지한다", async () => {
    const product = await fixtureProduct(); responseKind = "alive";
    safeFetch.mockResolvedValue({ finalUrl: product.url, response: new Response("<h1>Start your free plan</h1>") });
    await reviewLlmAssist(context());
    expect(await status(product.id)).toBe("seeded");
    expect(await work(product.id)).toMatchObject({ state: "done", attempts: 1 });
    expect((await db.select().from(productHealth).where(eq(productHealth.slug, product.slug)))[0]).toMatchObject({ failures: 10, status: 404 });
    expect((await requests())[0]).toMatchObject({ state: "settled" });
  });
  it("접근 차단은 모델 호출 없이 추가 근거로 남긴다", async () => {
    const product = await fixtureProduct();
    safeFetch.mockResolvedValue({ finalUrl: product.url, response: new Response("Please retry later", { status: 403 }) });
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(0); expect(await requests()).toHaveLength(0);
    expect(await status(product.id)).toBe("seeded");
    expect(await work(product.id)).toMatchObject({ state: "waiting_evidence", attempts: 0 });
  });
  it.each([
    { status: 402, kind: "hosting_disabled" as const, body: "Payment required DEPLOYMENT_DISABLED" },
    { status: 503, kind: "hosting_paused" as const, body: "The deployment is currently unavailable DEPLOYMENT_PAUSED" },
  ])("HTTP $status 호스팅 중단을 종료로 답해도 사람 큐로 보내고 내리지 않는다", async ({ status: httpStatus, kind, body }) => {
    const product = await fixtureProduct(); responseKind = kind;
    safeFetch.mockResolvedValue({ finalUrl: product.url, response: new Response(`${body} icn1::example-request`, { status: httpStatus }) });
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1);
    expect((await requests())[0].state).toBe("settled");
    expect(await work(product.id)).toMatchObject({ state: "human", attempts: 1, lastError: "uptime_hosting_notice_requires_review" });
    expect(await status(product.id)).toBe("seeded");
    expect(await recordedResults()).toHaveLength(0);
    expect(await db.select().from(productEvidenceAudit).where(and(eq(productEvidenceAudit.slug, product.slug), eq(productEvidenceAudit.action, "admin.product.ban")))).toHaveLength(0);
    expect(await db.select().from(operationsAudit).where(and(eq(operationsAudit.target, product.slug), eq(operationsAudit.action, "product-auto-ban-uptime")))).toHaveLength(0);
    expect(await db.select().from(cdnPurges).where(eq(cdnPurges.slug, product.slug))).toHaveLength(0);
  });
  it("unclear를 retain으로 답해도 완료하지 않고 사람 확인으로 남긴다", async () => {
    const product = await fixtureProduct(); responseKind = "unclear_retain";
    safeFetch.mockResolvedValue({ finalUrl: product.url,
      response: new Response("Service temporarily unavailable. Please try again later.", { status: 503 }) });
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1);
    expect((await requests())[0].state).toBe("settled");
    expect(await work(product.id)).toMatchObject({ state: "human", attempts: 1, lastError: "unclear_requires_review" });
    expect(await status(product.id)).toBe("seeded");
    expect(await db.select().from(operationsAudit).where(and(eq(operationsAudit.target, product.slug), eq(operationsAudit.action, "product-auto-ban-uptime")))).toHaveLength(0);
    expect(await db.select().from(cdnPurges).where(eq(cdnPurges.slug, product.slug))).toHaveLength(0);
  });
  it("업무 JSON 오류는 실제 물리 종료를 정산하되 사람 검토로 남긴다", async () => {
    const product = await fixtureProduct(); responseKind = "invalid";
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await requests())[0].state).toBe("settled");
    expect(await status(product.id)).toBe("seeded");
    expect(await work(product.id)).toMatchObject({ state: "human", attempts: 1, lastError: "invalid_model_json" });
  });
  for (const change of ["url", "microsecond", "administrator_release"] as const) it(`응답 도중 ${change} 변경은 최종 내림을 막는다`, async () => {
    const product = await fixtureProduct();
    onCall = async () => {
      if (change === "url") await admin`UPDATE products SET url='https://replacement.example/',updated_at=clock_timestamp() WHERE id=${product.id}`;
      else if (change === "microsecond") await admin`UPDATE product_health SET checked_at=checked_at+interval '1 microsecond' WHERE slug=${product.slug}`;
      else await db.insert(productEvidenceAudit).values({ slug: product.slug, actor: "fixture:operator", action: "admin.product.unban", reason: prefix });
    };
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await requests())[0].state).toBe("settled");
    expect(await status(product.id)).toBe("seeded");
    expect(await recordedResults()).toMatchObject([{ applied: false }]);
  });
  it("원 업무 pause는 새 claim을 멈추고 소비자 pause는 dispatch를 멈춘다", async () => {
    const product = await fixtureProduct();
    await admin`UPDATE jobs SET not_before=clock_timestamp()+interval '1 hour' WHERE name=${originJob}`;
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(0); expect(await work(product.id)).toMatchObject({ state: "queued", attempts: 0 });
    await admin`UPDATE jobs SET not_before=NULL WHERE name=${originJob}`;
    safeFetch.mockImplementation(async (url: string) => {
      await admin`UPDATE jobs SET not_before=clock_timestamp()+interval '1 hour' WHERE name=${jobName}`;
      return { finalUrl: url, response: new Response("We permanently closed the entire service.") };
    });
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(0); expect(await status(product.id)).toBe("seeded");
    expect(await work(product.id)).toMatchObject({ state: "waiting_capacity", attempts: 0 });
  });
  for (const mode of ["disabled", "unmapped", "capacity"] as const) it(`${mode}는 무계량 우회와 업무 시도 소모를 허용하지 않는다`, async () => {
    const product = await fixtureProduct();
    if (mode === "disabled") await admin`UPDATE model_capacity_control SET mode='disabled' WHERE id=1`;
    if (mode === "unmapped") {
      const changed = { ...policy, routes: policy.routes.filter(route => route.routeId !== routeId) };
      await admin`UPDATE model_capacity_control SET policy=${JSON.stringify(changed)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(changed)} WHERE id=1`;
    }
    if (mode === "capacity") expect(await requestModelSlot({ requestId: randomUUID(), workKey: randomUUID(), owner,
      class: "background", pool: "reviewer", routeId: "fixture-blocker", provider: "fixture-provider", model: "blocker" })).toMatchObject({ kind: "granted" });
    await reviewLlmAssist(context(mode === "capacity" ? AbortSignal.timeout(150) : undefined));
    expect(calls).toHaveLength(0); expect(await status(product.id)).toBe("seeded");
    expect(await work(product.id)).toMatchObject({ state: "waiting_capacity", attempts: 0 });
  });
  it("client abort는 실제 remote terminal 없이 원장·작업의 unknown을 유지한다", async () => {
    const product = await fixtureProduct(), controller = new AbortController();
    hold = res => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"model":'); controller.abort(); };
    await reviewLlmAssist(context(controller.signal));
    expect(calls).toHaveLength(1);
    expect((await requests())[0]).toMatchObject({ state: "indeterminate", terminal_evidence: null, settled_at: null });
    expect(await work(product.id)).toMatchObject({ state: "indeterminate", attempts: 0 });
    expect(await status(product.id)).toBe("seeded");
    expect(await recordedResults()).toHaveLength(0);
  });
  it("M1 응답이 대기 중이어도 GPU 결과는 먼저 commit되며 같은 Qwen family가 두 독립 모델이 되지 않는다", async () => {
    const first = await fixtureProduct(), second = await fixtureProduct();
    let pendingM1: ServerResponse | null = null;
    const m1 = http.createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        calls.push({ requestId: String(req.headers["x-nmv-relay-request-id"] ?? ""), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        pendingM1 = res;
      } catch { res.destroy(); }
    });
    await new Promise<void>(resolve => m1.listen(0, "127.0.0.1", resolve));
    const address = m1.address();
    if (!address || typeof address === "string") throw new Error("fixture_m1_server_missing");
    const m1Contract: LocalModelServingContract = { ...contract, backendId: "fixture-m1-qwen", physicalGroup: "fixture-m1",
      endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, deploymentRevision: "fixture-m1-q4" };
    const parallelPolicy: ModelCapacityPolicy = { ...policy, globalLimit: 2,
      providerLimits: { [backendId]: 1, [m1Contract.backendId]: 1 }, groupLimits: { "fixture-gpu": 1, "fixture-m1": 1 },
      poolLimits: { reviewer: 2, text: 1 }, routes: [...policy.routes,
        { routeId: `local-assist-uptime-${m1Contract.backendId}`, provider: "local-direct", model,
          providerBudgetId: m1Contract.backendId, groupId: "fixture-m1" }] };
    for (const [key, value] of Object.entries({ LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([contract, m1Contract]),
      LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify({ [backendId]: localModelContractHash(contract), [m1Contract.backendId]: localModelContractHash(m1Contract) }),
      LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ "fixture-gpu": 1, "fixture-m1": 1 }),
      LLM_ASSIST_API_KEYS: JSON.stringify({ [backendId]: "fixture-key", [m1Contract.backendId]: "fixture-m1-key" }),
      LLM_ASSIST_BACKENDS: JSON.stringify([{ backendId, tasks: ["uptime"], maxClaims: 1 }, { backendId: m1Contract.backendId, tasks: ["uptime"], maxClaims: 1 }]) })) vi.stubEnv(key, value);
    await admin`UPDATE model_capacity_control SET policy=${JSON.stringify(parallelPolicy)}::text::jsonb,
      policy_hash=${modelCapacityPolicyHash(parallelPolicy)} WHERE id=1`;
    const running = reviewLlmAssist(context());
    void running.catch(() => {});
    try {
      await eventually(async () => Boolean(pendingM1) && (await requests()).some(row => row.group_id === "fixture-gpu" && row.state === "settled")
        && (await recordedResults()).length === 1);
      const middle = await requests();
      expect(middle).toEqual(expect.arrayContaining([expect.objectContaining({ group_id: "fixture-gpu", state: "settled" }),
        expect.objectContaining({ group_id: "fixture-m1", state: "dispatched" })]));
      expect(await recordedResults()).toMatchObject([{ backendId, modelFamily: model, applied: true }]);
      expect([await status(first.id), await status(second.id)].sort()).toEqual(["banned", "seeded"]);
      const m1Response = pendingM1 as ServerResponse | null;
      if (!m1Response) throw new Error("fixture_m1_response_missing");
      m1Response.writeHead(200, { "content-type": "application/json" }); m1Response.end(JSON.stringify(nativeResponse()));
      await running;
      expect(calls).toHaveLength(2);
      expect((await requests()).map(row => row.state)).toEqual(["settled", "settled"]);
      expect([await status(first.id), await status(second.id)]).toEqual(["banned", "banned"]);
      const results = await recordedResults();
      expect(results).toHaveLength(2);
      expect(new Set(results.map(result => result.modelFamily))).toEqual(new Set([model]));
      expect(sameLocalModelFamily(contract, m1Contract)).toBe(true);
      expect(localModelContractHash(contract)).not.toBe(localModelContractHash(m1Contract));
    } finally {
      (pendingM1 as ServerResponse | null)?.destroy(); m1.closeAllConnections();
      await running.catch(() => {});
      await new Promise<void>(resolve => m1.close(() => resolve()));
    }
  });
});


describe("같은 보강 입력으로 늦은 예약을 소비하고 전송 전 포기를 정산한다", () => {
  const blocker = () => requestModelSlot({ requestId: randomUUID(), workKey: randomUUID(), owner,
    class: "background", pool: "reviewer", routeId: "fixture-blocker", provider: "fixture-provider", model: "blocker" });
  async function pendingFixture() {
    const product = await fixtureProduct(), queued = await work(product.id);
    if (!queued) throw new Error("fixture_work_required");
    const target = { kind: "assist" as const, purpose: "assist_review" as const, workId: queued.id, workRevision: queued.revision,
      claimToken: randomUUID(), task: "uptime" as const, subjectId: product.id, backendId };
    const request = { requestId: randomUUID(), owner, class: "background" as const, pool: "reviewer" as const,
      routeId, provider: "local-direct", model, workKey: `direct:assist:${product.id}:uptime:${"a".repeat(64)}` };
    return { product, target, request };
  }
  it("실제 경합과 타 caller의 늦은 grant 후 같은 입력·ID로 딱 한 번 native dispatch한다", async () => {
    const product = await fixtureProduct(), occupied = await blocker();
    expect(occupied.kind).toBe("granted");
    const controller = new AbortController(), running = reviewLlmAssist(context(controller.signal));
    try {
      await eventually(async () => (await requests()).some(r => r.route_id === routeId && r.state === "waiting"));
      const [waiting] = (await requests()).filter(r => r.route_id === routeId), prepared = await work(product.id);
      expect(prepared?.state).toBe("claimed"); expect(prepared?.inputHash).toBeTruthy(); expect(calls).toHaveLength(0);
      if (occupied.kind !== "granted") throw new Error("fixture_capacity_required");
      expect(await cancelReservedModelSlot(occupied.reservation)).toBe(true);
      expect(await blocker()).toMatchObject({ kind: "deferred", reason: "capacity" }); // grants the older assist, not this caller
      await running;
      const rows = (await requests()).filter(r => r.route_id === routeId);
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ request_id: waiting.request_id, state: "settled" });
      expect(rows[0].dispatch_binding.inputHash).toBe(prepared?.inputHash);
      expect(calls).toHaveLength(1); expect(calls[0].requestId).toBe(waiting.request_id);
      expect(safeFetch).toHaveBeenCalledTimes(1); // source observedAt is not regenerated while pending
      expect(await work(product.id)).toMatchObject({ state: "done", attempts: 1 });
    } finally { controller.abort(); await running; }
  });
  it("bounded deadline은 자기 waiting만 취소하고 시도·HTTP·terminal을 만들지 않는다", async () => {
    const product = await fixtureProduct(); expect((await blocker()).kind).toBe("granted");
    const controller = new AbortController(), running = reviewLlmAssist(context(controller.signal));
    await eventually(async () => (await requests()).some(r => r.route_id === routeId && r.state === "waiting"));
    controller.abort(); await running;
    const [row] = (await requests()).filter(r => r.route_id === routeId);
    expect(row).toMatchObject({ state: "withdrawn", dispatched_at: null, dispatch_binding: null, terminal_evidence: null, settled_at: null });
    expect(await admin`SELECT kind,from_state,to_state FROM model_capacity_events WHERE request_id=${row.request_id} ORDER BY id`)
      .toEqual([{ kind: "queued", from_state: null, to_state: "waiting" }, { kind: "wait_cancelled", from_state: "waiting", to_state: "withdrawn" }]);
    expect(calls).toHaveLength(0); expect(await work(product.id)).toMatchObject({ state: "waiting_capacity", attempts: 0 });
  });
  it("runner deadlineAt가 짧으면 native 60초를 남기고 늦은 grant도 전송하지 않는다", async () => {
    const product = await fixtureProduct(), occupied = await blocker();
    if (occupied.kind !== "granted") throw new Error("fixture_capacity_required");
    const controller = new AbortController(), deadlineAt = Date.now() + 80_000;
    const running = reviewLlmAssist({ ...context(controller.signal), deadlineAt });
    try {
      await eventually(async () => (await requests()).some(r => r.route_id === routeId && r.state === "waiting"));
      // Native signal is still live; advance only the wall-clock admission budget, not DB clocks or HTTP.
      vi.spyOn(Date, "now").mockReturnValue(deadlineAt - 59_999);
      await cancelReservedModelSlot(occupied.reservation); await blocker();
      await running;
      expect(controller.signal.aborted).toBe(false);
      expect((await requests()).find(r => r.route_id === routeId)).toMatchObject({ state: "withdrawn", dispatched_at: null });
      expect(calls).toHaveLength(0); expect(await work(product.id)).toMatchObject({ state: "waiting_capacity", attempts: 0 });
    } finally { vi.restoreAllMocks(); controller.abort(); await running; }
  });
  it("수집에 31초를 쓰면 native 60초가 남지 않아 capacity 등록 전 보류한다", async () => {
    const product = await fixtureProduct(), started = Date.now();
    safeFetch.mockImplementationOnce(async (url: string) => {
      vi.spyOn(Date, "now").mockReturnValue(started + 31_000);
      return { finalUrl: url, response: new Response("<h1>We permanently closed the entire service.</h1>", { status: 200 }) };
    });
    try {
      await reviewLlmAssist(context());
      expect(calls).toHaveLength(0); expect(await requests()).toHaveLength(0);
      expect(await work(product.id)).toMatchObject({ state: "waiting_capacity", attempts: 0, lastError: "tick_budget" });
      expect(await status(product.id)).toBe("seeded");
    } finally { vi.restoreAllMocks(); }
  });
  it("수집과 대기 시간을 합쳐 native 60초가 남지 않으면 늦은 예약을 취소한다", async () => {
    const product = await fixtureProduct(), occupied = await blocker(), started = Date.now();
    if (occupied.kind !== "granted") throw new Error("fixture_capacity_required");
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    safeFetch.mockImplementationOnce(async (url: string) => {
      clock.mockReturnValue(started + 20_000);
      return { finalUrl: url, response: new Response("<h1>We permanently closed the entire service.</h1>", { status: 200 }) };
    });
    const controller = new AbortController(), running = reviewLlmAssist(context(controller.signal));
    try {
      await eventually(async () => (await requests()).some(r => r.route_id === routeId && r.state === "waiting"));
      clock.mockReturnValue(started + 31_000);
      await cancelReservedModelSlot(occupied.reservation); await blocker();
      await running;
      const row = (await requests()).find(r => r.route_id === routeId);
      expect(row).toMatchObject({ state: "withdrawn", dispatched_at: null, dispatch_binding: null, terminal_evidence: null });
      expect(calls).toHaveLength(0); expect(safeFetch).toHaveBeenCalledTimes(1);
      expect(await work(product.id)).toMatchObject({ state: "waiting_capacity", attempts: 0 });
      expect(await status(product.id)).toBe("seeded");
    } finally { vi.restoreAllMocks(); controller.abort(); await running; }
  });
  it("타 caller가 grant한 직후 abort하면 예약만 취소하고 전송하지 않는다", async () => {
    await fixtureProduct(); const occupied = await blocker();
    if (occupied.kind !== "granted") throw new Error("fixture_capacity_required");
    const controller = new AbortController(), running = reviewLlmAssist(context(controller.signal));
    try {
      await eventually(async () => (await requests()).some(r => r.route_id === routeId && r.state === "waiting"));
      await cancelReservedModelSlot(occupied.reservation); await blocker();
      expect((await requests()).find(r => r.route_id === routeId)?.state).toBe("reserved");
      controller.abort(); await running;
      const row = (await requests()).find(r => r.route_id === routeId);
      expect(row).toMatchObject({ state: "withdrawn", dispatch_binding: null, dispatched_at: null });
      expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${row!.request_id} ORDER BY id`)
        .toEqual([{ kind: "queued" }, { kind: "reserved" }, { kind: "reservation_cancelled" }]);
      expect(calls).toHaveLength(0);
    } finally { controller.abort(); await running; }
  });
  for (const change of ["source", "role", "job", "freshness", "control"] as const) it(`폴링 중 ${change} 세대가 바뀌면 늦은 grant도 실제 dispatch 증명을 통과하지 못한다`, async () => {
    const product = await fixtureProduct(), occupied = await blocker();
    if (occupied.kind !== "granted") throw new Error("fixture_capacity_required");
    const controller = new AbortController(), running = reviewLlmAssist(context(controller.signal));
    try {
      await eventually(async () => (await requests()).some(r => r.route_id === routeId && r.state === "waiting"));
      if (change === "source") await admin`UPDATE products SET url='https://changed.example/',updated_at=clock_timestamp() WHERE id=${product.id}`;
      else if (change === "role") await admin`UPDATE role_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE role='reviewer'`;
      else if (change === "job") await admin`UPDATE jobs SET lease_token=${randomUUID()} WHERE name=${jobName}`;
      else if (change === "control") await admin`UPDATE llm_assist_controls SET dispatch_enabled=false,apply_enabled=false,revision=revision+1 WHERE task='uptime'`;
      else vi.spyOn(Date, "now").mockReturnValue(Date.now() - 1000); // observedAt is now in the future; do not recollect it
      await cancelReservedModelSlot(occupied.reservation); await blocker();
      if (change === "job") await expect(running).rejects.toThrow("assist_backend_drain_failed");
      else await running;
      expect((await requests()).find(r => r.route_id === routeId)).toMatchObject({ state: "withdrawn", dispatch_binding: null, dispatched_at: null });
      expect(calls).toHaveLength(0); expect(await recordedResults()).toHaveLength(0);
    } finally { vi.restoreAllMocks(); controller.abort(); await running.catch(() => {}); }
  });
  it("dispatch가 먼저 이긴 경합에서는 취소가 실제 binding과 unknown을 지우지 않는다", async () => {
    await fixtureProduct(); const controller = new AbortController();
    hold = res => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"model":'); };
    const running = reviewLlmAssist(context(controller.signal));
    try {
      await eventually(async () => calls.length === 1);
      const row = (await requests()).find(r => r.route_id === routeId);
      const checked = { requestId: row!.request_id, owner, class: "background" as const, pool: "reviewer" as const,
        routeId, provider: "local-direct", model, workKey: row!.work_key };
      const target = row!.dispatch_binding.target;
      expect(row!.state).toBe("dispatched");
      expect(await cancelOwnPendingLocalModelRequest(checked, target)).toBe(false);
      expect((await requests()).find(r => r.request_id === checked.requestId)?.state).toBe("dispatched");
      controller.abort(); await running;
      expect(await cancelOwnPendingLocalModelRequest(checked, target)).toBe(false);
      expect((await requests()).find(r => r.request_id === checked.requestId)).toMatchObject({ state: "indeterminate",
        dispatch_binding: row!.dispatch_binding, dispatch_binding_hash: row!.dispatch_binding_hash, terminal_evidence: null });
      expect(calls).toHaveLength(1);
    } finally { controller.abort(); await running; }
  });
  it("다른 owner·boot·논리작업은 취소하지 않고 own unbound waiting만 취소한다", async () => {
    const { request, target } = await pendingFixture(); expect((await blocker()).kind).toBe("granted");
    expect(await requestLocalModelSlot(request,target)).toMatchObject({ kind: "deferred", reason: "capacity" });
    expect(await cancelOwnPendingLocalModelRequest({ ...request, owner: { ...owner, bootId: randomUUID() } },target)).toBe(false);
    expect(await cancelOwnPendingLocalModelRequest(request,{ ...target, subjectId: target.subjectId+1 })).toBe(false);
    await expect(cancelOwnPendingLocalModelRequest({ ...request, workKey: "different" },target)).rejects.toThrow("identity_mismatch");
    expect(await cancelOwnPendingLocalModelRequest(request,target)).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it("wait_cancelled DB 분기는 waiting→withdrawn과 null reason/evidence만 허용한다", async () => {
    const { request, target } = await pendingFixture(); expect((await blocker()).kind).toBe("granted");
    await requestLocalModelSlot(request, target);
    for (const [from, to, reason, evidence] of [
      ["reserved", "withdrawn", null, null], [null, "withdrawn", null, null],
      ["waiting", "reserved", null, null], ["waiting", null, null, null],
      ["waiting", "withdrawn", "transport_unknown", null], ["waiting", "withdrawn", null, {}],
    ] as const) {
      await expect(admin`INSERT INTO model_capacity_events(request_id,kind,epoch,revision,policy_hash,from_state,to_state,reason,evidence)
        SELECT request_id,'wait_cancelled',epoch,revision,policy_hash,${from},${to},${reason},${evidence === null ? null : JSON.stringify(evidence)}::text::jsonb
        FROM model_capacity_requests WHERE request_id=${request.requestId}`).rejects.toMatchObject({ code: "23514", constraint_name: "model_capacity_events_kind_check" });
    }
    expect(await cancelOwnPendingLocalModelRequest(request, target)).toBe(true);
  });
  it("fenced DB에서는 own waiting도 변경하거나 취소 event를 남기지 않는다", async () => {
    const { request, target } = await pendingFixture(); expect((await blocker()).kind).toBe("granted");
    await requestLocalModelSlot(request,target);
    const [{ row: original }] = await admin`SELECT to_jsonb(f) AS row FROM dr_writer_fence f WHERE id=1`;
    const [{ identity }] = await admin`SELECT jsonb_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
      'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'databaseName',current_database()) AS identity`;
    try {
      await admin`UPDATE dr_writer_fence SET state='fenced',reason='operator_fence',fenced_db=${JSON.stringify(identity)}::text::jsonb WHERE id=1`;
      expect(await cancelOwnPendingLocalModelRequest(request,target)).toBe(false);
      expect((await requests()).find(r=>r.request_id===request.requestId)?.state).toBe("waiting");
      expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${request.requestId}`).toEqual([{ kind: "queued" }]);
    } finally {
      await admin`UPDATE dr_writer_fence f SET state=r.state,reason=r.reason,fenced_db=r.fenced_db,promotion_id=r.promotion_id
        FROM jsonb_populate_record(NULL::dr_writer_fence,${JSON.stringify(original)}::text::jsonb)r WHERE f.id=r.id`;
    }
  });
});
