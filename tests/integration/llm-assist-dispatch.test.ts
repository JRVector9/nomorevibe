import http, { type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/net/fetch", async original => ({ ...await original<typeof import("@/lib/net/fetch")>(), safeFetch }));
import { db } from "@/lib/db";
import { cdnPurges, llmAssistResults, llmAssistWorks, operationsAudit, productEvidenceAudit, productHealth, products } from "@/lib/db/schema";
import { autoBanUptimeProduct } from "@/lib/domain/products/uptime-auto-ban";
import { reviewLlmAssist } from "@/lib/jobs/products/llm-assist-review";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { requestModelSlot } from "@/lib/llm/capacity-repository";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { ASSIST_SCHEMA_VERSION } from "@/lib/domain/llm-assist/contracts";
import type { JobContext } from "@/lib/jobs/runner";
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
let originalJobs: Record<string, unknown>[], calls: { requestId: string; body: Record<string, unknown> }[] = [];
let responseKind: "closed" | "alive" | "invalid" = "closed", onCall: (() => Promise<void>) | null = null;
let hold: ((res: ServerResponse) => void) | null = null;
let jobToken = "", sequence = 0;

function modelOutcome() {
  const alive = responseKind === "alive";
  return { schema_version: ASSIST_SCHEMA_VERSION, task: "uptime", state: { page_state: alive ? "alive" : "closed",
    finding: alive ? "active_product" : "explicit_shutdown" }, evidence_quality: { status: "sufficient", limitations: ["none"] },
    evidence: [{ source_id: "current-page", quote: alive ? "Start your free plan" : "permanently closed", supports: ["/state/page_state"] }],
    action: { proposal: alive ? "retain" : "delist_candidate", reason_ko: alive ? "현재 이용 경로가 있습니다." : "서비스 전체 종료가 명시되어 있습니다.", missing_items: [] } };
}
function context(signal?: AbortSignal): JobContext<null> {
  return { cursor: null, lease: { name: jobName, token: jobToken, requestedVersion: 0 }, signal,
    save: async () => {}, hasBudget: () => true, log: () => {} };
}
async function fixtureProduct() {
  const slug = `${prefix}-${++sequence}`;
  const [row] = await admin`INSERT INTO products(slug,url,name,tagline,description,category,status,verify_token,edit_token_hash,updated_at)
    VALUES(${slug},${`https://${slug}.example/`},${slug},'소개','설명','Other','seeded','fixture',${"x".repeat(64)},clock_timestamp()-interval '7 days')
    RETURNING id,slug,url`;
  const product = { id: Number(row.id), slug: String(row.slug), url: String(row.url) };
  ownedProducts.push(product);
  await admin`INSERT INTO product_health(slug,failures,status,checked_at,down_since)
    VALUES(${product.slug},10,404,clock_timestamp()-interval '1 minute',clock_timestamp()-interval '3 days')`;
  expect(await autoBanUptimeProduct(product)).toBe(false);
  return product;
}
async function status(id: number) { return (await db.select().from(products).where(eq(products.id, id)))[0]?.status; }
async function work(id: number) { return (await db.select().from(llmAssistWorks).where(eq(llmAssistWorks.productId, id)))[0]; }
async function requests() { return Array.from(await admin`SELECT * FROM model_capacity_requests WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal`); }
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
  server.on("request", async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({ requestId: String(req.headers["x-nmv-relay-request-id"] ?? ""), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      await onCall?.();
      if (hold) { hold(res); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model, choices: [{ finish_reason: "stop", message: { role: "assistant",
        content: responseKind === "invalid" ? "not JSON" : JSON.stringify(modelOutcome()) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
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
  try { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  finally { await admin.end(); }
});

describe("보강 소비자의 native dispatch와 최종 적용", () => {
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
    expect(await db.select().from(llmAssistResults)).toMatchObject([{ applied: true, capacityRequestId: request.request_id }]);
    expect(await db.select().from(productEvidenceAudit).where(and(eq(productEvidenceAudit.slug, product.slug), eq(productEvidenceAudit.action, "admin.product.ban")))).toHaveLength(1);
    expect(await db.select().from(operationsAudit).where(and(eq(operationsAudit.target, product.slug), eq(operationsAudit.action, "product-auto-ban-uptime")))).toHaveLength(1);
    expect(await db.select().from(cdnPurges).where(eq(cdnPurges.slug, product.slug))).toHaveLength(1);
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1);
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
    expect(await db.select().from(llmAssistResults)).toMatchObject([{ applied: false }]);
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
    await reviewLlmAssist(context());
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
    expect(await db.select().from(llmAssistResults).where(like(llmAssistResults.backendId, backendId))).toHaveLength(0);
  });
});
