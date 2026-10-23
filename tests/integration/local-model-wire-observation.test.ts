import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { crawlCandidates, productAuditCampaigns, productAuditItems, products } from "@/lib/db/schema";
import { saveSettings, getSettings, setQwenAutoStep } from "@/lib/crawl/settings";
import { putDocument } from "@/lib/crawl/repository";
import { loadAuditInput } from "@/lib/crawl/product-audit";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { reviewWithQwenDirect, QWEN_V2_PROMPT_VERSION, QWEN_V3_PROMPT_VERSION } from "@/lib/crawl/qwen-direct-review";
import { reviewWithScreenshot, SCREEN_REVIEW_SHOT2_PROMPT_VERSION } from "@/lib/screen-review/vision-review";
import { withLocalModelCapacity } from "@/lib/llm/local-model-capacity";
import { observedLocalModelWireHash } from "@/lib/llm/local-model-wire-observation";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/llm/gateway-local-end-fetch", async original => {
  const actual = await original<typeof import("@/lib/llm/gateway-local-end-fetch")>();
  return { ...actual, gatewayFetch: (...args: Parameters<typeof actual.gatewayFetch>) => {
    if (String(args[1]) !== endpoint) throw new Error("fixture_native_endpoint_required");
    return actual.gatewayFetch(...args);
  } };
});

const prefix = `wire-${randomUUID().slice(0, 8)}`, owner = { instanceId: prefix, bootId: randomUUID() };
const names = ["product-audit", "audit-screen-review"], release = "wire-test", token = randomUUID();
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const server = http.createServer(), realFetch = globalThis.fetch;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let endpoint = "", campaignId = 0, sequence = 0, strictRelay = true;
let env: Record<string, string>, contract: LocalModelServingContract;
let originalControl: Record<string, unknown>, originalRole: Record<string, unknown> | null, originalSettings: Record<string, unknown> | null;
let originalJobs: Record<string, unknown>[], received: { raw: string; body: Record<string, unknown>; requestId: string }[] = [];
const nativeBody = JSON.stringify({ model: "qwen", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
  decision: "approve", reason: "A usable application", evidenceIds: ["product"], confidence: 0.9 }) } }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });

beforeAll(async () => {
  ensureSchema();
  [{ row: originalControl }] = await admin`select to_jsonb(c) row from model_capacity_control c where id=1`;
  originalRole = (await admin`select to_jsonb(c) row from role_leases c where role='reviewer'`)[0]?.row ?? null;
  originalSettings = (await admin`select to_jsonb(c) row from crawl_settings c where id=1`)[0]?.row ?? null;
  originalJobs = (await admin`select to_jsonb(c) row from jobs c where name=any(${names})`).map(row => row.row);
  expect(await admin`select request_id from model_capacity_requests where state in ('waiting','reserved','dispatched','indeterminate')`).toHaveLength(0);
  server.on("request", async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8"), body = JSON.parse(raw) as Record<string, unknown>;
    received.push({ raw, body, requestId: String(request.headers["x-nmv-relay-request-id"] ?? "") });
    const supported = new Set(["model", "messages", "temperature", "max_tokens", "stream", "response_format", "chat_template_kwargs"]);
    if (request.url !== "/v1/chat/completions" || request.method !== "POST" || strictRelay && Object.keys(body).some(key => !supported.has(key))) {
      response.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_request"}'); return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(nativeBody);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
  endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  contract = { version: 1, protocol: "local-openai-chat-v1", provider: "local-direct", backendId: "wire-qwen", physicalGroup: "wire-device",
    endpoint, model: "qwen", responseModel: "qwen", modelFamily: "qwen3.8-flash-next", deploymentRevision: "wire-test-1",
    contextWindowTokens: 65536, totalTokenBound: 65536, maxOutputTokens: 4096, maxInputBytes: 1_000_000,
    capabilities: { vision: true, jsonSchema: true }, thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" },
    termination: { kind: "response_only" } };
  env = { LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([contract]), LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify({ "wire-qwen": localModelContractHash(contract) }),
    LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ "wire-device": 1 }), AUDIT_SECOND_OPINION_URL: endpoint.replace(/\/chat\/completions$/, ""),
    AUDIT_SECOND_OPINION_MODEL: "qwen", ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: prefix, ROLE_LEASE_BOOT_ID: owner.bootId,
    ROLE_LEASE_RELEASE: release, ROLE_LEASE_EPOCH: "1" };
  const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { "wire-qwen": 1 }, groupLimits: { "wire-device": 1 },
    poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 8, queueTtlMs: 60000, reservationTtlMs: 60000,
    routes: ["local-audit", "local-screen"].map(routeId => ({ routeId, provider: "local-direct", model: "qwen", providerBudgetId: "wire-qwen", groupId: "wire-device" })) };
  await admin`update model_capacity_control set mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},cursor=0 where id=1`;
  await admin`insert into role_leases(role,owner_instance_id,owner_boot_id,owner_release,owner_kind,epoch,lease_until)
    values('reviewer',${prefix},${owner.bootId},${release},'primary',1,clock_timestamp()+interval '1 hour')
    on conflict(role) do update set owner_instance_id=excluded.owner_instance_id,owner_boot_id=excluded.owner_boot_id,
      owner_release=excluded.owner_release,owner_kind=excluded.owner_kind,epoch=1,lease_until=excluded.lease_until`;
  for (const name of names) await admin`insert into jobs(name,lease_token,locked_at) values(${name},${token},clock_timestamp())
    on conflict(name) do update set lease_token=excluded.lease_token,locked_at=excluded.locked_at,not_before=null`;
  expect(await saveSettings({ enabled: true }, "wire-fixture")).toMatchObject({ ok: true });
  const screen = (await getSettings()).qwenAuto.screenReview;
  expect(await setQwenAutoStep({ step: "screenReview", expected: screen, next: { ...screen, enabled: true },
    actor: "wire-fixture", reason: "isolated native wire fixture" })).toMatchObject({ ok: true });
  [{ id: campaignId }] = await db.insert(productAuditCampaigns).values({ startedBy: prefix, reason: prefix,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: "qwen-direct", model: "qwen" }).returning();
  vi.stubGlobal("fetch", ((input, init) => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : input.href;
    if (url !== endpoint) throw new Error("fixture_global_endpoint_required");
    return realFetch(input, init);
  }) as typeof fetch);
});

async function clearLedger() {
  await admin.begin(async tx => {
    await tx`select id from model_capacity_control where id=1 for update`;
    const ids = (await tx`select request_id from model_capacity_requests where owner_instance_id=${prefix} for update`).map(row => row.request_id);
    await tx`lock table model_capacity_events in access exclusive mode`;
    await tx`alter table model_capacity_events disable trigger model_capacity_events_no_change`;
    await tx`delete from model_capacity_events where request_id=any(${ids}::uuid[])`;
    await tx`alter table model_capacity_events enable always trigger model_capacity_events_no_change`;
    await tx`delete from model_capacity_requests where request_id=any(${ids}::uuid[])`;
  });
}
beforeEach(() => { received = []; strictRelay = true; });
afterEach(async () => {
  await clearLedger();
  await admin`update model_capacity_control set mode='open' where id=1`;
});
afterAll(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  try {
    await clearLedger();
    if (campaignId) { await db.delete(productAuditItems).where(eq(productAuditItems.campaignId, campaignId)); await db.delete(productAuditCampaigns).where(eq(productAuditCampaigns.id, campaignId)); }
    await db.delete(crawlCandidates).where(sql`${crawlCandidates.repo} like ${prefix + "/%"}`);
    await db.delete(products).where(sql`${products.slug} like ${prefix + "-%"}`);
    await admin`delete from crawl_documents where repo like ${prefix + "/%"}`;
    await admin`delete from crawl_frontier where repo like ${prefix + "/%"}`;
    await admin`update model_capacity_control c set mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
      from jsonb_populate_record(null::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r where c.id=r.id`;
    await admin`delete from jobs where name=any(${names})`;
    if (originalJobs.length) await admin`insert into jobs select * from jsonb_populate_recordset(null::jobs,${JSON.stringify(originalJobs)}::text::jsonb)`;
    await admin`delete from role_leases where role='reviewer' and owner_instance_id=${prefix}`;
    if (originalRole) await admin`insert into role_leases select * from jsonb_populate_record(null::role_leases,${JSON.stringify(originalRole)}::text::jsonb)`;
    await admin`delete from crawl_settings where id=1`;
    if (originalSettings) await admin`insert into crawl_settings select * from jsonb_populate_record(null::crawl_settings,${JSON.stringify(originalSettings)}::text::jsonb)`;
    expect((await admin`select to_jsonb(c) row from model_capacity_control c where id=1`)[0].row).toEqual(originalControl);
    expect((await admin`select to_jsonb(c) row from role_leases c where role='reviewer'`)[0]?.row ?? null).toEqual(originalRole);
    expect((await admin`select to_jsonb(c) row from crawl_settings c where id=1`)[0]?.row ?? null).toEqual(originalSettings);
    expect(await admin`select request_id from model_capacity_requests where owner_instance_id=${prefix}`).toHaveLength(0);
    expect((await admin`select tgenabled from pg_trigger where tgname='model_capacity_events_no_change'`)[0].tgenabled).toBe("A");
  } finally { vi.unstubAllGlobals(); await admin.end(); }
});

async function fixture(purpose: "audit" | "screen") {
  const slug = `${prefix}-${++sequence}`, repo = `${prefix}/${slug}`, url = `https://${slug}.example/`;
  const [product] = await db.insert(products).values({ slug, url, name: slug, tagline: "A task tool", description: "A usable task tool",
    category: "Productivity", status: "seeded", source: "crawler", verifyToken: randomUUID(), editTokenHash: "a".repeat(64) }).returning();
  await putDocument({ repo, productUrl: url, pageStatus: 200, repoMeta: { description: "A task tool", pushed_at: new Date().toISOString(),
    stargazers_count: 5, owner: { type: "User" } }, pageMeta: { title: slug, textSample: "Open the application and manage tasks.".repeat(12) } });
  await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", publishedSlug: slug, reason: "passed", judgedAt: new Date() });
  const [item] = await db.insert(productAuditItems).values({ campaignId, productId: product.id, slug,
    ...(purpose === "screen" ? { aiDecision: "reject" } : {}) }).returning();
  const input = await loadAuditInput(slug, await getSettings()); if (!input) throw new Error("fixture_input");
  const name = purpose === "audit" ? "product-audit" : "audit-screen-review";
  const [{ requested_version: requestedVersion }] = await admin`select requested_version from jobs where name=${name}`;
  return { target: { kind: "audit" as const, purpose, itemId: item.id, slug }, input, env,
    lease: { name, token, requestedVersion: Number(requestedVersion) } };
}
async function latest() {
  return (await admin`select state,dispatch_binding from model_capacity_requests where owner_instance_id=${prefix} order by queue_ordinal desc limit 1`)[0];
}

it("records the actual normalized native text wire in both adapter and ledger", async () => {
  const context = await fixture("audit");
  const result = await withLocalModelCapacity({ ...context, promptVersion: QWEN_V3_PROMPT_VERSION }, request =>
    reviewWithQwenDirect(context.input, { env, request, promptVersion: QWEN_V3_PROMPT_VERSION }));
  expect(received).toHaveLength(1);
  expect(received[0].body).not.toHaveProperty("context_strategy");
  expect(received[0].body).not.toHaveProperty("reasoning_effort");
  expect(received[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(result.wireHash).toBe(sha(received[0].raw));
  expect(await latest()).toMatchObject({ state: "settled", dispatch_binding: { wireHash: result.wireHash } });
});

it("records the normalized image request rather than the pre-normalization screenshot body", async () => {
  const context = await fixture("screen"), now = new Date().toISOString();
  const result = await withLocalModelCapacity({ ...context, promptVersion: SCREEN_REVIEW_SHOT2_PROMPT_VERSION }, request =>
    reviewWithScreenshot(context.input, Buffer.from([255, 216, 255, 217]), { request, timeoutMs: 5000,
      config: { baseUrl: endpoint.replace(/\/chat\/completions$/, ""), model: "qwen", apiKey: null, screenPromptVersion: SCREEN_REVIEW_SHOT2_PROMPT_VERSION },
      rendered: { text: "Open the application and manage tasks.", textLength: 38, requestedUrl: context.input.snapshot.product.url!,
        finalUrl: context.input.snapshot.product.url!, status: 200, requestedAt: now, receivedAt: now } }));
  expect(received).toHaveLength(1);
  expect(received[0].body).not.toHaveProperty("context_strategy");
  expect(JSON.stringify(received[0].body.messages)).toContain("image_url");
  expect(result.wireHash).toBe(sha(received[0].raw));
  expect(await latest()).toMatchObject({ state: "settled", dispatch_binding: { wireHash: result.wireHash, promptVersion: SCREEN_REVIEW_SHOT2_PROMPT_VERSION } });
});

it("refuses unverified context strategies before reservation or HTTP", async () => {
  const context = await fixture("audit");
  for (const context_strategy of ["summarized", "RAW", null]) await expect(withLocalModelCapacity({ ...context, promptVersion: QWEN_V2_PROMPT_VERSION }, request =>
    request(endpoint, { method: "POST", body: JSON.stringify({ model: "qwen", stream: false, max_tokens: 1024, messages: [], context_strategy }) })))
    .rejects.toMatchObject({ reason: "provider_contract_unavailable" });
  expect(received).toHaveLength(0);
  expect(await latest()).toBeUndefined();
});

it("keeps the disabled legacy wire and fallback hash unchanged", async () => {
  strictRelay = false;
  await admin`update model_capacity_control set mode='disabled' where id=1`;
  const context = await fixture("audit");
  const result = await withLocalModelCapacity({ ...context, promptVersion: QWEN_V2_PROMPT_VERSION }, request =>
    reviewWithQwenDirect(context.input, { env, request, promptVersion: QWEN_V2_PROMPT_VERSION }));
  expect(received[0].body).toMatchObject({ context_strategy: "raw", reasoning_effort: "low", chat_template_kwargs: { enable_thinking: false } });
  expect(result.wireHash).toBe(sha(received[0].raw));
  expect(observedLocalModelWireHash(new Response(nativeBody))).toBeUndefined();
  expect(await latest()).toBeUndefined();
});
