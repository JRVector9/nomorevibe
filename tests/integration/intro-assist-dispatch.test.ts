import http from "node:http";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ endpoint: "", fetchCapped: vi.fn(), afterFactual: null as (() => Promise<void>) | null }));
vi.mock("@/lib/net/fetch", async original => ({ ...await original<typeof import("@/lib/net/fetch")>(), fetchCapped: fixture.fetchCapped }));
vi.mock("@/lib/llm/gateway-local-end-fetch", async original => {
  const actual = await original<typeof import("@/lib/llm/gateway-local-end-fetch")>();
  return { ...actual, gatewayFetch: (requestId: string, ...args: Parameters<typeof actual.gatewayFetch> extends [string, ...infer T] ? T : never) => {
    if (args[0] !== fixture.endpoint) throw new Error("fixture_model_endpoint_only");
    return actual.gatewayFetch(requestId, ...args);
  } };
});
vi.mock("@/lib/domain/llm-assist/complete", async original => {
  const actual = await original<typeof import("@/lib/domain/llm-assist/complete")>();
  return { ...actual, completeAssistClaim: async (...args: Parameters<typeof actual.completeAssistClaim>) => {
    const result = await actual.completeAssistClaim(...args);
    if (result.recorded && args[1].task === "intro" && args[2].action.proposal === "rewrite_candidate") await fixture.afterFactual?.();
    return result;
  } };
});

import { db } from "@/lib/db";
import { llmAssistResults, llmAssistWorks, operationsAudit, products, productMakerMembers, publicUsers } from "@/lib/db/schema";
import { introAssistCorrections } from "@/lib/db/intro-assist-schema";
import { planIntroRechecks, requestIntroRecheck } from "@/lib/domain/products/intro-assist-repository";
import { reviewLlmAssist } from "@/lib/jobs/products/llm-assist-review";
import { requestModelSlot } from "@/lib/llm/capacity-repository";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { ASSIST_SCHEMA_VERSION } from "@/lib/domain/llm-assist/contracts";
import type { JobContext } from "@/lib/jobs/runner";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const prefix = `intro-native-${randomUUID().slice(0, 8)}`;
const backendId = "fixture-intro-qwen", model = "qwen3.8-flash-next", routeId = `local-assist-intro_recheck-${backendId}`;
const jobName = "product-llm-assist-review", originJob = "product-intro-check", jobNames = [jobName, originJob];
const owner = { instanceId: prefix, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const server = http.createServer();
const ownedProducts: { id: number; slug: string; url: string; repoUrl: string }[] = [], ownedUsers: number[] = [];
type ModelStage = "facts" | "correction";
let contract: LocalModelServingContract, policy: ModelCapacityPolicy, sequence = 0, jobToken = "";
let originalCapacity: Record<string, unknown>, originalAssist: Record<string, unknown>, originalRole: Record<string, unknown> | null;
let originalJobs: Record<string, unknown>[];
let calls: { requestId: string; body: Record<string, unknown>; stage: ModelStage }[] = [];
let mode: "rewrite" | "retain" | "invalid_correction" = "rewrite";
let onCall: ((stage: ModelStage) => Promise<void>) | null = null;
let blockedEvidence = false;
const originalLine = "Edit World of Warcraft items", correctedLine = "Edit items in the game Margonem";
const pageText = "Edit items in the game Margonem. Create and edit game items using the online editor. Export items for Margonem players.";
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function responseStage(body: Record<string, unknown>): ModelStage {
  const format = body.response_format;
  if (!object(format) || !object(format.json_schema)) throw new Error("fixture_schema_missing");
  return format.json_schema.name === "intro_correction" ? "correction" : "facts";
}
function factualOutcome() {
  const keep = mode === "retain";
  return { schema_version: ASSIST_SCHEMA_VERSION, task: "intro", state: { factual_match: keep ? "supported" : "explicit_mismatch",
    content_kind: "descriptive", author_protection: "server_operator", treatment: keep ? "keep" : "rewrite_candidate" },
    evidence_quality: { status: "sufficient", limitations: ["none"] },
    evidence: [{ source_id: "current-page", quote: "game Margonem", supports: ["/state/factual_match"] }],
    action: { proposal: keep ? "retain" : "rewrite_candidate", reason_ko: keep ? "현재 소개를 유지합니다." : "대상 게임이 다릅니다.", missing_items: [] } };
}
function nativeResponse(body: Record<string, unknown>, stage: ModelStage) {
  let content: string;
  if (stage === "facts") content = JSON.stringify(factualOutcome());
  else if (mode === "invalid_correction") content = "not JSON";
  else {
    if (!Array.isArray(body.messages)) throw new Error("fixture_messages_missing");
    const last: unknown = body.messages.at(-1);
    if (!object(last) || typeof last.content !== "string") throw new Error("fixture_correction_prompt_missing");
    const data: unknown = JSON.parse(last.content);
    if (!object(data) || !object(data.binding)) throw new Error("fixture_correction_binding_missing");
    content = JSON.stringify({ schema_version: ASSIST_SCHEMA_VERSION, kind: "intro_correction", ...data.binding,
      corrected: correctedLine, reason_ko: "현재 원문에 나온 게임 이름을 사용합니다.", evidence: [{ source_id: "current-page", quote: "game Margonem" }] });
  }
  return { model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 } };
}
function context(): JobContext<null> {
  return { cursor: null, lease: { name: jobName, token: jobToken, requestedVersion: 0 },
    save: async () => {}, hasBudget: () => true, log: () => {} };
}
async function rawCheck(productId: number) {
  return (await admin`SELECT to_jsonb(c) AS row FROM product_intro_checks c WHERE product_id=${productId}`)[0]?.row as Record<string, unknown>;
}
async function fixtureProduct() {
  const slug = `${prefix}-${++sequence}`, repoUrl = `https://github.com/fixture/${slug}`;
  const [row] = await admin`INSERT INTO products(slug,url,repo_url,name,tagline,tagline_source,description,category,source,status,
      verify_token,edit_token_hash,updated_at,search_page_text,search_readme)
    VALUES(${slug},${`https://${slug}.example/`},${repoUrl},'Margonem editor',${originalLine},'ai_page',${originalLine},'Other','crawler','seeded',
      'fixture',${"x".repeat(64)},'2026-10-23 01:02:03.123456'::timestamp,'Old incomplete excerpt','Old README excerpt')
    RETURNING id,slug,url`;
  const product = { id: Number(row.id), slug: String(row.slug), url: String(row.url), repoUrl };
  ownedProducts.push(product);
  await admin`INSERT INTO product_intro_checks(product_id,checked_tagline,outcome,verdict,problem,model,attempts,
      original_tagline,original_source,original_description,updated_at)
    VALUES(${product.id},${originalLine},'needs_editor','wrong','기존 Sonnet 근거 부족','sonnet',2,
      'Earlier original','ai_readme','Earlier description','2026-10-23 01:02:03.234567'::timestamp)`;
  const before = await rawCheck(product.id), [plan] = await planIntroRechecks([product.id]);
  expect(plan).toBeDefined();
  expect(await requestIntroRecheck(plan, `${prefix}:operator`)).toBe("queued");
  return { ...product, before };
}
async function work(productId: number) { return (await db.select().from(llmAssistWorks).where(eq(llmAssistWorks.productId, productId)))[0]; }
async function product(productId: number) { return (await db.select().from(products).where(eq(products.id, productId)))[0]; }
async function requests() { return Array.from(await admin`SELECT * FROM model_capacity_requests WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal`); }
async function assertUnchanged(f: Awaited<ReturnType<typeof fixtureProduct>>) {
  expect((await product(f.id)).tagline).toBe(originalLine);
  expect(await rawCheck(f.id)).toEqual(f.before);
}

// 가짜 HTTP fixture가 모두 끝난 뒤 자신의 원장만 정리한다. 운영의 remote terminal 정산 경로가 아니다.
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
  for (const p of ownedProducts.splice(0)) await admin`DELETE FROM products WHERE id=${p.id} AND slug=${p.slug}`;
  for (const id of ownedUsers.splice(0)) await admin`DELETE FROM public_users WHERE id=${id}`;
}
async function restoreSingletons() {
  await admin`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
    FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalCapacity)}::text::jsonb) r WHERE c.id=r.id`;
  expect(await admin`SELECT id FROM llm_assist_work WHERE task='intro_recheck'`).toHaveLength(0);
  await admin`DELETE FROM llm_assist_controls WHERE task='intro_recheck'`;
  await admin`INSERT INTO llm_assist_controls SELECT * FROM jsonb_populate_record(NULL::llm_assist_controls,${JSON.stringify(originalAssist)}::text::jsonb)`;
  await admin`DELETE FROM jobs WHERE name=ANY(${jobNames})`;
  if (originalJobs.length) await admin`INSERT INTO jobs SELECT * FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs)}::text::jsonb)`;
  await admin`DELETE FROM role_leases WHERE role='reviewer' AND owner_instance_id=${prefix}`;
  if (originalRole) await admin`INSERT INTO role_leases SELECT * FROM jsonb_populate_record(NULL::role_leases,${JSON.stringify(originalRole)}::text::jsonb)`;
}

beforeAll(async () => {
  ensureSchema();
  [{ row: originalCapacity }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  [{ row: originalAssist }] = await admin`SELECT to_jsonb(c) AS row FROM llm_assist_controls c WHERE task='intro_recheck'`;
  expect(originalAssist).toBeDefined();
  originalRole = (await admin`SELECT to_jsonb(c) AS row FROM role_leases c WHERE role='reviewer'`)[0]?.row ?? null;
  originalJobs = (await admin`SELECT to_jsonb(c) AS row FROM jobs c WHERE name=ANY(${jobNames})`).map(row => row.row);
  expect(await admin`SELECT id FROM llm_assist_work WHERE task='intro_recheck'`).toHaveLength(0);
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toHaveLength(0);
  server.on("request", async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer fixture-intro-key") throw new Error("fixture_route_only");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!object(body)) throw new Error("fixture_body_invalid");
      const stage = responseStage(body);
      calls.push({ requestId: String(req.headers["x-nmv-relay-request-id"] ?? ""), body, stage });
      await onCall?.(stage);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(nativeResponse(body, stage)));
    } catch { res.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_server_missing");
  fixture.endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  contract = { version: 1, protocol: "local-openai-chat-v1", backendId, provider: "local-direct", physicalGroup: "fixture-intro-gpu",
    endpoint: fixture.endpoint, model, responseModel: model, modelFamily: "qwen3.8-flash-next", deploymentRevision: "fixture-intro-1",
    contextWindowTokens: 64000, totalTokenBound: 64000, maxOutputTokens: 2048, maxInputBytes: 100000,
    capabilities: { vision: true, jsonSchema: true }, thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } };
  policy = { version: 1, globalLimit: 1, providerLimits: { [backendId]: 1 }, groupLimits: { "fixture-intro-gpu": 1 }, poolLimits: { reviewer: 1, text: 1 },
    weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 60000, reservationTtlMs: 60000,
    routes: [{ routeId, provider: "local-direct", model, providerBudgetId: backendId, groupId: "fixture-intro-gpu" },
      { routeId: "fixture-intro-blocker", provider: "fixture-provider", model: "blocker", providerBudgetId: backendId, groupId: "fixture-intro-gpu" }] };
});
beforeEach(async () => {
  calls = []; mode = "rewrite"; onCall = null; fixture.afterFactual = null; blockedEvidence = false; jobToken = randomUUID();
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: prefix, ROLE_LEASE_BOOT_ID: owner.bootId,
    ROLE_LEASE_RELEASE: prefix, ROLE_LEASE_EPOCH: "1", LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([contract]),
    LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify({ [backendId]: localModelContractHash(contract) }),
    LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ "fixture-intro-gpu": 1 }), LLM_ASSIST_API_KEYS: JSON.stringify({ [backendId]: "fixture-intro-key" }),
    LLM_ASSIST_BACKENDS: JSON.stringify([{ backendId, tasks: ["intro_recheck"], maxClaims: 1 }]), SCREEN_RENDER_URL: "", SCREEN_RENDER_TOKEN: "" })) vi.stubEnv(key, value);
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},cursor=0 WHERE id=1`;
  await admin`UPDATE llm_assist_controls SET mode='confirm',confirmation_required=true,dispatch_enabled=true,apply_enabled=true,revision=2 WHERE task='intro_recheck'`;
  await admin`INSERT INTO role_leases(role,owner_instance_id,owner_boot_id,owner_release,owner_kind,epoch,lease_until)
    VALUES('reviewer',${prefix},${owner.bootId},${prefix},'primary',1,clock_timestamp()+interval '1 hour')
    ON CONFLICT(role) DO UPDATE SET owner_instance_id=excluded.owner_instance_id,owner_boot_id=excluded.owner_boot_id,
      owner_release=excluded.owner_release,owner_kind=excluded.owner_kind,epoch=1,lease_until=excluded.lease_until`;
  for (const name of jobNames) await admin`INSERT INTO jobs(name,lease_token,locked_at) VALUES(${name},${name===jobName ? jobToken : null},${name===jobName ? new Date() : null})
    ON CONFLICT(name) DO UPDATE SET lease_token=excluded.lease_token,locked_at=excluded.locked_at,not_before=NULL`;
  fixture.fetchCapped.mockReset().mockImplementation(async (url: string) => {
    const current = ownedProducts.find(p => url === p.url || url === `https://raw.githubusercontent.com/fixture/${p.slug}/HEAD/README.md`);
    if (!current) throw new Error("fixture_evidence_endpoint_only");
    if (blockedEvidence) return { ok: false, reason: "http", status: 403 };
    return { ok: true, status: 200, finalUrl: url, headers: new Headers({ "content-type": url === current.url ? "text/html" : "text/plain" }),
      body: Buffer.from(url === current.url ? `<main>${pageText}</main>` : pageText), truncated: false };
  });
});
afterEach(async () => {
  server.closeAllConnections();
  try { await cleanFixture(); await restoreSingletons(); } finally { vi.unstubAllEnvs(); }
});
afterAll(async () => {
  try {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    expect((await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`)[0]?.row).toEqual(originalCapacity);
    expect((await admin`SELECT to_jsonb(c) AS row FROM llm_assist_controls c WHERE task='intro_recheck'`)[0]?.row).toEqual(originalAssist);
    expect((await admin`SELECT to_jsonb(c) AS row FROM role_leases c WHERE role='reviewer'`)[0]?.row ?? null).toEqual(originalRole);
    const restoredJobs = (await admin`SELECT to_jsonb(c) AS row FROM jobs c WHERE name=ANY(${jobNames})`).map(row => row.row);
    expect(restoredJobs).toHaveLength(originalJobs.length); expect(restoredJobs).toEqual(expect.arrayContaining(originalJobs));
    expect(await requests()).toHaveLength(0);
  } finally { await admin.end(); }
});

describe("명시 소개 재검수의 실제 native 두 단계", () => {
  it("별도 사실·교정 호출이 정산된 뒤 소개를 한 번 바꾸고 Sonnet 성공행을 그대로 보존한다", async () => {
    const f = await fixtureProduct();
    await reviewLlmAssist(context());
    expect(calls.map(call => call.stage)).toEqual(["facts", "correction"]);
    const native = await requests();
    expect(native.map(row => row.state)).toEqual(["settled", "settled"]);
    expect(new Set(native.map(row => row.request_id)).size).toBe(2);
    expect(new Set(native.map(row => row.logical_work_key))).toEqual(new Set([`direct:assist:${f.id}:intro_recheck`]));
    expect(native.map(row => row.dispatch_binding.target.purpose)).toEqual(["assist_review", "intro_correction"]);
    expect(native[0].dispatch_binding.inputHash).not.toBe(native[1].dispatch_binding.inputHash);
    expect(calls.map(call => call.requestId)).toEqual(native.map(row => row.request_id));
    expect(await product(f.id)).toMatchObject({ tagline: correctedLine, taglineSource: "ai_fixed", description: correctedLine });
    expect(await rawCheck(f.id)).toEqual(f.before);
    const facts = await db.select().from(llmAssistResults).where(eq(llmAssistResults.workId, (await work(f.id)).id));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ modelFamily: model, backendId, capacityRequestId: native[0].request_id });
    expect(facts[0].input).toBeTruthy();
    const corrections = await db.select().from(introAssistCorrections).where(eq(introAssistCorrections.productId, f.id));
    expect(corrections).toMatchObject([{ factualResultId: facts[0].id, capacityRequestId: native[1].request_id, applied: true,
      requestHash: native[1].dispatch_binding.inputHash, responseHash: native[1].terminal_evidence.responseHash }]);
    expect(await db.select().from(operationsAudit).where(eq(operationsAudit.target, f.slug))).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "product-intro-assist-corrected" }),
    ]));
    await reviewLlmAssist(context()); expect(calls).toHaveLength(2);
  });
  it("유지 판정은 별도 교정 호출을 열지 않는다", async () => {
    const f = await fixtureProduct(); mode = "retain";
    await reviewLlmAssist(context());
    expect(calls.map(call => call.stage)).toEqual(["facts"]); expect((await requests())[0].state).toBe("settled");
    await assertUnchanged(f);
    expect(await db.select().from(introAssistCorrections).where(eq(introAssistCorrections.productId, f.id))).toHaveLength(0);
  });
  it("잘못된 교정 JSON도 물리 호출은 정산하되 제품은 바꾸지 않는다", async () => {
    const f = await fixtureProduct(); mode = "invalid_correction";
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(2); expect((await requests()).map(row => row.state)).toEqual(["settled", "settled"]);
    await assertUnchanged(f); expect((await work(f.id)).state).toBe("human");
  });
  for (const change of ["human_edit", "maker", "claimed", "origin_pause", "factual_change", "check_microsecond"] as const) {
    it(`교정 응답 도중 ${change} 변경은 최종 교체를 막는다`, async () => {
      const f = await fixtureProduct();
      onCall = async stage => {
        if (stage !== "correction") return;
        if (change === "human_edit") await admin`UPDATE products SET tagline='A human supplied introduction',tagline_source='editor',updated_at=clock_timestamp() WHERE id=${f.id}`;
        else if (change === "maker") {
          const [user] = await db.insert(publicUsers).values({ displayName: `${prefix}-maker` }).returning({ id: publicUsers.id });
          ownedUsers.push(user.id); await db.insert(productMakerMembers).values({ productId: f.id, userId: user.id, role: "owner", method: "admin" });
        } else if (change === "claimed") await admin`UPDATE products SET claimed_at=clock_timestamp() WHERE id=${f.id}`;
        else if (change === "origin_pause") await admin`UPDATE jobs SET not_before=clock_timestamp()+interval '1 hour' WHERE name=${originJob}`;
        else if (change === "check_microsecond") await admin`UPDATE product_intro_checks SET updated_at=updated_at+interval '1 microsecond' WHERE product_id=${f.id}`;
        else await admin`UPDATE llm_assist_results SET outcome=jsonb_set(outcome,'{action,reason_ko}','"fixture changed factual result"'::jsonb)
          WHERE work_id=(SELECT id FROM llm_assist_work WHERE product_id=${f.id} AND task='intro_recheck')`;
      };
      await reviewLlmAssist(context());
      expect(calls).toHaveLength(2); expect((await requests()).map(row => row.state)).toEqual(["settled", "settled"]);
      expect((await product(f.id)).tagline).toBe(change === "human_edit" ? "A human supplied introduction" : originalLine);
      const after = await rawCheck(f.id);
      if (change === "check_microsecond") expect({ ...after, updated_at: f.before.updated_at }).toEqual(f.before);
      else expect(after).toEqual(f.before);
      expect((await db.select().from(introAssistCorrections).where(eq(introAssistCorrections.productId, f.id))).every(row => !row.applied)).toBe(true);
    });
  }
  it("사실 완료 뒤 공통 슬롯이 차면 무계량 교정으로 우회하지 않고 시도를 추가 소모하지 않는다", async () => {
    const f = await fixtureProduct();
    fixture.afterFactual = async () => {
      expect(await requestModelSlot({ requestId: randomUUID(), workKey: randomUUID(), owner, class: "background", pool: "reviewer",
        routeId: "fixture-intro-blocker", provider: "fixture-provider", model: "blocker" })).toMatchObject({ kind: "granted" });
    };
    await reviewLlmAssist(context());
    expect(calls.map(call => call.stage)).toEqual(["facts"]); await assertUnchanged(f);
    expect(await work(f.id)).toMatchObject({ state: "waiting_capacity", attempts: 1 });
  });
  it("사실 완료 뒤 소비자를 pause하면 새 교정 dispatch를 멈춘다", async () => {
    const f = await fixtureProduct();
    fixture.afterFactual = async () => { await admin`UPDATE jobs SET not_before=clock_timestamp()+interval '1 hour' WHERE name=${jobName}`; };
    await reviewLlmAssist(context());
    expect(calls.map(call => call.stage)).toEqual(["facts"]); await assertUnchanged(f);
  });
  it("현재 원문이 차단되면 사실·교정 모델을 모두 호출하지 않는다", async () => {
    const f = await fixtureProduct(); blockedEvidence = true;
    await reviewLlmAssist(context()); expect(calls).toHaveLength(0); expect(await requests()).toHaveLength(0);
    await assertUnchanged(f); expect((await work(f.id)).state).toBe("waiting_evidence");
  });
});
