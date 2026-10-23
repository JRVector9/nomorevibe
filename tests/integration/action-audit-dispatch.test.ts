import http, { type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ safeFetch: vi.fn(), fetchCapped: vi.fn(), modelOrigins: new Set<string>(),
  sourceUrls: new Set<string>(), rejectedModels: [] as string[], rejectedSources: [] as string[] }));
vi.mock("@/lib/net/fetch", async original => ({ ...await original<typeof import("@/lib/net/fetch")>(),
  safeFetch: fixture.safeFetch, fetchCapped: fixture.fetchCapped }));
vi.mock("@/lib/llm/gateway-local-end-fetch", async original => {
  const actual = await original<typeof import("@/lib/llm/gateway-local-end-fetch")>();
  const guarded: typeof actual.gatewayFetch = (id, ...args) => {
    const candidate: unknown = args[0];
    const url = typeof candidate === "string" ? candidate : candidate && typeof candidate === "object"
      && "href" in candidate && typeof candidate.href === "string" ? candidate.href
      : candidate && typeof candidate === "object" && "url" in candidate && typeof candidate.url === "string" ? candidate.url : "invalid-url";
    if (!fixture.modelOrigins.has(new URL(url).origin)) {
      fixture.rejectedModels.push(url); throw new Error("fixture_model_origin_required");
    }
    return actual.gatewayFetch(id, ...args);
  };
  return { ...actual, gatewayFetch: guarded };
});
import { db } from "@/lib/db";
import { autoBanUptimeProduct } from "@/lib/domain/products/uptime-auto-ban";
import { reviewLlmAssist, reviewLlmAssistAudit } from "@/lib/jobs/products/llm-assist-review";
import { freezeActionAuditPeriod, enqueueFrozenActionAudit, loadAutomatedDecision,
  readActionAuditProduct } from "@/lib/domain/products/automated-action-audit-repository";
import { actionAuditSourceHash, type ActionAuditCandidate, type ActionAuditPolicy } from "@/lib/domain/products/automated-action-audit";
import { ASSIST_SCHEMA_VERSION, assistHash, assistInputHash } from "@/lib/domain/llm-assist/contracts";
import { assistPromptHash } from "@/lib/domain/llm-assist/prompts";
import { collectActionAuditInput, completeActionAuditRuntime } from "@/lib/domain/llm-assist/audit-runtime";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { JobContext } from "@/lib/jobs/runner";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const prefix = `audit-native-${randomUUID().slice(0, 8)}`, reasonSecret = `ORIGINAL_DECISION_SECRET_${randomUUID()}`;
const primaryJob = "product-llm-assist-review", auditJob = "product-llm-assist-audit-review", originJob = "uptime-ping";
const jobNames = [primaryJob, auditJob, originJob], taskNames = ["uptime", "decision_audit", "semantic_exception"];
const owner = { instanceId: prefix, bootId: randomUUID() }, seed = `fixture-audit-seed-${randomUUID()}`;
const qwenId = "fixture-action-qwen", deepseekId = "fixture-action-deepseek";
const qwenModel = "fixture-original-qwen-model", deepseekModel = "fixture-auditor-deepseek-model";
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const qwenServer = http.createServer(), deepseekServer = http.createServer();
const ownedProducts: { id: number; slug: string; url: string }[] = [], ownedPeriods = new Set<string>();
const pending = new Set<Promise<unknown>>();
let qwen: LocalModelServingContract, deepseek: LocalModelServingContract, capacityPolicy: ModelCapacityPolicy;
let originalCapacity: Record<string, unknown>, originalControls: Record<string, unknown>[], originalJobs: Record<string, unknown>[];
let originalRole: Record<string, unknown> | null, primaryToken = "", auditToken = "", sequence = 0;
let originalControlTrigger = "";
let calls: { backendId: string; requestId: string; body: Record<string, unknown> }[] = [];
let holdDeepseek = false, heldDeepseek: ServerResponse | null = null;
let auditPolicy: ActionAuditPolicy;

function primaryOutcome() {
  return { schema_version: ASSIST_SCHEMA_VERSION, task: "uptime", state: { page_state: "closed", finding: "explicit_shutdown" },
    evidence_quality: { status: "sufficient", limitations: ["none"] }, evidence: [{ source_id: "current-page", quote: "permanently closed",
      supports: ["/state/page_state"] }], action: { proposal: "delist_candidate", reason_ko: reasonSecret, missing_items: [] } };
}
function auditOutcome() {
  return { schema_version: ASSIST_SCHEMA_VERSION, task: "audit", state: { audit_subject: "uptime", independent_finding: "alive",
    applicable_rule_ids: ["uptime-current-page"] }, evidence_quality: { status: "sufficient", limitations: ["none"] },
    evidence: [{ source_id: "evidence-1", quote: "Start your free plan", supports: ["/state/independent_finding"] }],
    action: { proposal: "record_finding", reason_ko: "현재 사용 경로를 독립적으로 확인했습니다.", missing_items: [] } };
}
function respond(res: ServerResponse, contract: LocalModelServingContract, outcome: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: contract.responseModel, choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(outcome) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
}
function context(job: typeof primaryJob | typeof auditJob): JobContext<null> {
  return { cursor: null, lease: { name: job, token: job === primaryJob ? primaryToken : auditToken, requestedVersion: 0 },
    save: async () => {}, hasBudget: () => true, log: () => {} };
}
function run(job: typeof primaryJob | typeof auditJob) {
  const work = job === primaryJob ? reviewLlmAssist(context(job)) : reviewLlmAssistAudit(context(job));
  pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
}
async function nextPrimaryTurn() {
  primaryToken = randomUUID();
  await admin`UPDATE jobs SET lease_token=${primaryToken},locked_at=clock_timestamp() WHERE name=${primaryJob}`;
  return run(primaryJob);
}
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("fixture_observation_deadline");
}
function installBackendEnv(contracts: LocalModelServingContract[] = [qwen, deepseek], backends: unknown = [
  { backendId: qwenId, tasks: ["uptime"], maxClaims: 1 },
  { backendId: deepseekId, tasks: ["decision_audit", "semantic_exception"], maxClaims: 1 },
]) {
  vi.stubEnv("LOCAL_MODEL_SERVING_CONTRACTS", JSON.stringify(contracts));
  vi.stubEnv("LOCAL_MODEL_VERIFIED_CONTRACT_HASHES", JSON.stringify(Object.fromEntries(contracts.map(contract => [contract.backendId, localModelContractHash(contract)]))));
  vi.stubEnv("LOCAL_MODEL_PHYSICAL_LIMITS", JSON.stringify(Object.fromEntries(contracts.map(contract => [contract.physicalGroup, 1]))));
  vi.stubEnv("LLM_ASSIST_API_KEYS", JSON.stringify(Object.fromEntries(contracts.map(contract => [contract.backendId, "fixture-key"]))));
  vi.stubEnv("LLM_ASSIST_BACKENDS", JSON.stringify(backends));
}
async function product() {
  const slug = `${prefix}-${++sequence}`, url = `https://${slug}.example/`;
  const [row] = await admin`INSERT INTO products(slug,url,name,tagline,tagline_source,description,category,status,verify_token,edit_token_hash,updated_at)
    VALUES(${slug},${url},${slug},'소개','editor','설명','Other','seeded','fixture',${"x".repeat(64)},clock_timestamp()-interval '7 days') RETURNING id`;
  const item = { id: Number(row.id), slug, url }; ownedProducts.push(item); fixture.sourceUrls.add(url);
  await admin`INSERT INTO product_health(slug,failures,status,checked_at,down_since)
    VALUES(${slug},10,404,clock_timestamp()-interval '1 minute',clock_timestamp()-interval '3 days')`;
  expect(await autoBanUptimeProduct(item)).toBe(false);
  return item;
}
async function status(id: number) { return (await admin`SELECT status FROM products WHERE id=${id}`)[0]?.status; }
async function nativeRequests() { return admin`SELECT * FROM model_capacity_requests WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal`; }
async function seedAudit() {
  const item = await product(); await run(primaryJob);
  expect(await status(item.id)).toBe("banned");
  const [original] = await admin`SELECT r.id FROM llm_assist_results r JOIN llm_assist_work w ON w.id=r.work_id
    WHERE w.product_id=${item.id} AND w.task='uptime'`;
  expect(original).toBeTruthy();
  const monday = new Date("2026-10-19T00:00:00Z");
  // 이 파일의 고정 표본만 담는 별도 주 키다. 실제 현재 주의 타 파일 원장을 바꾸지 않는다.
  monday.setUTCDate(monday.getUTCDate() + 7 * (1000 + parseInt(owner.bootId.slice(0, 4), 16) + sequence));
  const periodStart = monday.toISOString().slice(0, 10); ownedPeriods.add(periodStart);
  expect(await admin`SELECT period_start FROM llm_assist_audit_periods WHERE period_start=${periodStart}::date`).toHaveLength(0);
  const queued = await db.transaction(async tx => {
    const decision = await loadAutomatedDecision(tx, original.id);
    const current = await readActionAuditProduct(tx, item.id);
    if (!decision || !current) throw new Error("fixture_original_decision_missing");
    await freezeActionAuditPeriod(tx, { periodStart, seedHash: assistHash(seed), policy: auditPolicy, selected: [decision], skippedUnknownFamily: 0, candidatesClipped: false });
    const candidate: ActionAuditCandidate = { kind: "decision_audit", product: current, decision, periodStart,
      selectedAt: new Date().toISOString(), seedHash: assistHash(seed), conflict: null };
    const work = await enqueueFrozenActionAudit(tx, candidate);
    if (!work) throw new Error("fixture_audit_not_queued");
    return { candidate, workId: work.workId };
  });
  return { ...queued, product: item, originalResultId: String(original.id) };
}
async function auditWork(id: string) { return (await admin`SELECT * FROM llm_assist_work WHERE id=${id}::uuid`)[0]; }

beforeAll(async () => {
  ensureSchema();
  [{ row: originalCapacity }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  originalControls = (await admin`SELECT to_jsonb(c) AS row FROM llm_assist_controls c WHERE task=ANY(${taskNames})`).map(row => row.row);
  originalJobs = (await admin`SELECT to_jsonb(c) AS row FROM jobs c WHERE name=ANY(${jobNames})`).map(row => row.row);
  originalRole = (await admin`SELECT to_jsonb(c) AS row FROM role_leases c WHERE role='reviewer'`)[0]?.row ?? null;
  originalControlTrigger = (await admin`SELECT tgenabled FROM pg_trigger WHERE tgrelid='llm_assist_controls'::regclass
    AND tgname='llm_assist_preserve_confirmation'`)[0].tgenabled;
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toHaveLength(0);
  const start = async (server: http.Server, backendId: string) => {
    server.on("request", async (req, res) => {
      try {
        if (req.method !== "POST" || req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer fixture-key") throw new Error("fixture_request_invalid");
        const chunks: Buffer[] = []; for await (const raw of req) chunks.push(Buffer.from(raw));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const contract = backendId === qwenId ? qwen : deepseek;
        if (body.model !== contract.model) throw new Error("fixture_model_mismatch");
        calls.push({ backendId, requestId: String(req.headers["x-nmv-relay-request-id"] ?? ""), body });
        if (backendId === deepseekId && holdDeepseek) { heldDeepseek = res; return; }
        respond(res, contract, backendId === qwenId ? primaryOutcome() : auditOutcome());
      } catch { res.destroy(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_server_missing");
    const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`; fixture.modelOrigins.add(new URL(endpoint).origin); return endpoint;
  };
  const [qwenEndpoint, deepseekEndpoint] = await Promise.all([start(qwenServer, qwenId), start(deepseekServer, deepseekId)]);
  const shared = { version: 1 as const, protocol: "local-openai-chat-v1" as const, provider: "local-direct" as const,
    deploymentRevision: "fixture-action-audit-1", contextWindowTokens: 64000, totalTokenBound: 64000, maxOutputTokens: 2048, maxInputBytes: 200000,
    capabilities: { vision: false, jsonSchema: true }, thinking: { mode: "disabled" as const, parameter: "chat_template_kwargs.enable_thinking" as const },
    termination: { kind: "response_only" as const } };
  qwen = { ...shared, backendId: qwenId, physicalGroup: "fixture-action-gpu", endpoint: qwenEndpoint, model: qwenModel,
    responseModel: qwenModel, modelFamily: "qwen3.8-flash-next" };
  deepseek = { ...shared, backendId: deepseekId, physicalGroup: "fixture-action-m3", endpoint: deepseekEndpoint, model: deepseekModel,
    responseModel: deepseekModel, modelFamily: "deepseek-v4.1-flash-1017" };
  capacityPolicy = { version: 1, globalLimit: 2, providerLimits: { [qwenId]: 1, [deepseekId]: 1 },
    groupLimits: { [qwen.physicalGroup]: 1, [deepseek.physicalGroup]: 1 }, poolLimits: { reviewer: 2, text: 2 },
    weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 60000, reservationTtlMs: 60000,
    routes: [{ routeId: `local-assist-uptime-${qwenId}`, provider: "local-direct", model: qwenModel, providerBudgetId: qwenId, groupId: qwen.physicalGroup },
      ...["decision_audit", "semantic_exception"].map(task => ({ routeId: `local-assist-${task}-${deepseekId}`, provider: "local-direct", model: deepseekModel,
        providerBudgetId: deepseekId, groupId: deepseek.physicalGroup }))] };
});
beforeEach(async () => {
  calls = []; holdDeepseek = false; heldDeepseek = null; fixture.rejectedModels = []; fixture.rejectedSources = [];
  primaryToken = randomUUID(); auditToken = randomUUID();
  auditPolicy = { enabled: true, lookbackDays: 7, perStratum: 1, maxAuditsPerWeek: 1, maxExceptionsPerWeek: 0, maxCandidates: 100 };
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: prefix, ROLE_LEASE_BOOT_ID: owner.bootId,
    ROLE_LEASE_RELEASE: prefix, ROLE_LEASE_EPOCH: "1", LLM_ACTION_AUDIT_POLICY: JSON.stringify(auditPolicy), LLM_ACTION_AUDIT_SEED: seed })) vi.stubEnv(key, value);
  installBackendEnv();
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(capacityPolicy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(capacityPolicy)},cursor=0 WHERE id=1`;
  await admin`UPDATE llm_assist_controls SET mode='confirm',confirmation_required=true,dispatch_enabled=true,apply_enabled=true,revision=2 WHERE task='uptime'`;
  await admin`UPDATE llm_assist_controls SET mode='shadow',dispatch_enabled=true,apply_enabled=false,revision=2 WHERE task IN ('decision_audit','semantic_exception')`;
  await admin`INSERT INTO role_leases(role,owner_instance_id,owner_boot_id,owner_release,owner_kind,epoch,lease_until)
    VALUES('reviewer',${prefix},${owner.bootId},${prefix},'primary',1,clock_timestamp()+interval '1 hour') ON CONFLICT(role) DO UPDATE
    SET owner_instance_id=excluded.owner_instance_id,owner_boot_id=excluded.owner_boot_id,owner_release=excluded.owner_release,
      owner_kind=excluded.owner_kind,epoch=1,lease_until=excluded.lease_until`;
  for (const name of jobNames) await admin`INSERT INTO jobs(name,lease_token,locked_at)
    VALUES(${name},${name===primaryJob ? primaryToken : name===auditJob ? auditToken : null},${name===originJob ? null : new Date()})
    ON CONFLICT(name) DO UPDATE SET lease_token=excluded.lease_token,locked_at=excluded.locked_at,not_before=NULL`;
  fixture.safeFetch.mockReset().mockImplementation(async (url: string) => {
    if (!fixture.sourceUrls.has(url)) { fixture.rejectedSources.push(url); throw new Error("fixture_source_required"); }
    return { finalUrl: url, response: new Response("<h1>We permanently closed the entire service.</h1>") };
  });
  fixture.fetchCapped.mockReset().mockImplementation(async (url: string) => {
    if (!fixture.sourceUrls.has(url)) { fixture.rejectedSources.push(url); throw new Error("fixture_source_required"); }
    return { ok: true, status: 200, finalUrl: url, body: Buffer.from("<h1>Start your free plan</h1>"), truncated: false };
  });
});
afterEach(async () => {
  if (heldDeepseek) { respond(heldDeepseek, deepseek, auditOutcome()); heldDeepseek = null; }
  qwenServer.closeAllConnections(); deepseekServer.closeAllConnections(); await Promise.allSettled([...pending]);
  try {
    // 가짜 HTTP fixture가 끝난 뒤 이 owner의 행만 지운다. 이 테스트 정리는 운영의 원격 종료 증거가 아니다.
    await admin.begin(async tx => {
      await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
      const ids = (await tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix} FOR UPDATE`).map(row => row.request_id);
      await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      await tx`DELETE FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`;
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
      await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
      expect(Array.from(await tx`SELECT tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
        AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate')`).every(row => row.tgenabled === "A")).toBe(true);
    });
    for (const item of ownedProducts.splice(0)) {
      await admin`DELETE FROM products WHERE id=${item.id} AND slug=${item.slug}`;
      await admin`DELETE FROM product_health WHERE slug=${item.slug}`; await admin`DELETE FROM cdn_purges WHERE slug=${item.slug}`;
    }
    for (const period of ownedPeriods) await admin`DELETE FROM llm_assist_audit_periods WHERE period_start=${period}::date
      AND seed_hash=${assistHash(seed)} AND policy_hash=${assistHash(auditPolicy)}`;
    ownedPeriods.clear(); fixture.sourceUrls.clear();
    await admin`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
      FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalCapacity)}::text::jsonb) r WHERE c.id=r.id`;
    expect(await admin`SELECT id FROM llm_assist_work WHERE product_id IN (SELECT id FROM products WHERE slug LIKE ${`${prefix}%`})`).toHaveLength(0);
    // 이 파일이 일시 변경한 제어 singleton만 원복한다. 다른 파일의 work FK와 제어 행은 삭제하지 않는다.
    await admin.begin(async tx => {
      await tx`ALTER TABLE llm_assist_controls DISABLE TRIGGER llm_assist_preserve_confirmation`;
      await tx`UPDATE llm_assist_controls c SET mode=r.mode,confirmation_required=r.confirmation_required,
        dispatch_enabled=r.dispatch_enabled,apply_enabled=r.apply_enabled,revision=r.revision,updated_at=r.updated_at
        FROM jsonb_populate_recordset(NULL::llm_assist_controls,${JSON.stringify(originalControls)}::text::jsonb) r WHERE c.task=r.task`;
      if (originalControlTrigger === "A") await tx`ALTER TABLE llm_assist_controls ENABLE ALWAYS TRIGGER llm_assist_preserve_confirmation`;
      else if (originalControlTrigger === "O") await tx`ALTER TABLE llm_assist_controls ENABLE TRIGGER llm_assist_preserve_confirmation`;
      else throw new Error("fixture_control_trigger_expected_enabled");
    });
    await admin`DELETE FROM jobs WHERE name=ANY(${jobNames})`;
    if (originalJobs.length) await admin`INSERT INTO jobs SELECT * FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs)}::text::jsonb)`;
    await admin`DELETE FROM role_leases WHERE role='reviewer' AND owner_instance_id=${prefix}`;
    if (originalRole) await admin`INSERT INTO role_leases SELECT * FROM jsonb_populate_record(NULL::role_leases,${JSON.stringify(originalRole)}::text::jsonb)`;
    expect(fixture.rejectedModels).toEqual([]); expect(fixture.rejectedSources).toEqual([]);
  } finally { vi.unstubAllEnvs(); }
});
afterAll(async () => {
  try {
    await Promise.all([qwenServer, deepseekServer].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    expect((await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`)[0]?.row).toEqual(originalCapacity);
    expect((await admin`SELECT to_jsonb(c) AS row FROM role_leases c WHERE role='reviewer'`)[0]?.row ?? null).toEqual(originalRole);
    const restored = (await admin`SELECT to_jsonb(c) AS row FROM llm_assist_controls c WHERE task=ANY(${taskNames})`).map(row => row.row);
    expect(restored).toHaveLength(originalControls.length); expect(restored).toEqual(expect.arrayContaining(originalControls));
    expect((await admin`SELECT tgenabled FROM pg_trigger WHERE tgrelid='llm_assist_controls'::regclass
      AND tgname='llm_assist_preserve_confirmation'`)[0].tgenabled).toBe(originalControlTrigger);
    const restoredJobs = (await admin`SELECT to_jsonb(c) AS row FROM jobs c WHERE name=ANY(${jobNames})`).map(row => row.row);
    expect(restoredJobs).toHaveLength(originalJobs.length); expect(restoredJobs).toEqual(expect.arrayContaining(originalJobs));
    expect(await nativeRequests()).toHaveLength(0);
  } finally { await admin.end(); }
});

describe("분리된 독립 감사 native 소비자", () => {
  it("실제 Qwen 원 결정과 별도 DeepSeek 종료를 묶어 불일치만 기록하고 차단을 자동 해제하지 않는다", async () => {
    const value = await seedAudit(); const before = (await admin`SELECT updated_at::text AS revision FROM products WHERE id=${value.product.id}`)[0].revision;
    await run(auditJob);
    const requests = await nativeRequests(); expect(requests.map(row => row.state)).toEqual(["settled", "settled"]);
    expect(requests[1].dispatch_binding).toMatchObject({ job: { name: auditJob }, target: { task: "decision_audit", workId: value.workId } });
    const [finding] = await admin`SELECT * FROM llm_assist_audit_findings WHERE work_id=${value.workId}::uuid`;
    expect(finding).toMatchObject({ original_result_id: value.originalResultId, original_model_family: "qwen3.8-flash-next",
      auditor_model_family: "deepseek-v4.1-flash-1017", comparison: { status: "human_review", authority: "record_only",
        interpretation: "current_evidence_comparison", originalFinding: "closed", currentFinding: "alive" } });
    expect(await status(value.product.id)).toBe("banned");
    expect((await admin`SELECT updated_at::text AS revision FROM products WHERE id=${value.product.id}`)[0].revision).toBe(before);
    expect(await admin`SELECT id FROM product_evidence_audit WHERE slug=${value.product.slug} AND action='admin.product.unban'`).toHaveLength(0);
    expect(await auditWork(value.workId)).toMatchObject({ state: "human" });
    const [result] = await admin`SELECT applied FROM llm_assist_results WHERE id=${finding.audit_result_id}::uuid`; expect(result.applied).toBe(false);
    const input = (await auditWork(value.workId)).input;
    expect(Object.keys(input.context).sort()).toEqual(["administratorReleased", "makerProtected", "ruleIds", "subject"]);
    expect(input.sources.filter((source: { kind: string }) => source.kind === "metadata")).toMatchObject([{ text: JSON.stringify({ task: "uptime", requestedUrl: value.product.url }) }]);
    const user = JSON.stringify(calls.find(call => call.backendId === deepseekId)!.body.messages);
    for (const secret of [reasonSecret, qwenModel, qwenId, value.originalResultId, "permanently closed"]) expect(user).not.toContain(secret);
    await run(auditJob); expect(calls).toHaveLength(2);
  });
  it("DeepSeek 응답을 기다리는 동안 일반 Qwen job이 별도 lease로 완료하고 다음 호출도 처리한다", async () => {
    const audited = await seedAudit(); holdDeepseek = true;
    const auditing = run(auditJob);
    await eventually(async () => heldDeepseek !== null && (await nativeRequests()).some(row => row.model === deepseekModel && row.state === "dispatched"));
    const one = await product(); await nextPrimaryTurn(); expect(await status(one.id)).toBe("banned");
    const two = await product(); await nextPrimaryTurn(); expect(await status(two.id)).toBe("banned");
    expect(await auditWork(audited.workId)).toMatchObject({ state: "claimed" });
    expect((await nativeRequests()).filter(row => row.model === qwenModel).every(row => row.state === "settled")).toBe(true);
    expect(heldDeepseek).not.toBeNull(); respond(heldDeepseek!, deepseek, auditOutcome()); heldDeepseek = null;
    await auditing; expect(await auditWork(audited.workId)).toMatchObject({ state: "human" });
  });
  it("같은 Qwen family의 다른 backend를 독립 감사로 claim하지 않는다", async () => {
    const value = await seedAudit();
    const m1 = { ...deepseek, backendId: "fixture-action-m1", physicalGroup: "fixture-action-m1", model: "fixture-m1-qwen", responseModel: "fixture-m1-qwen",
      modelFamily: "qwen3.8-flash-next" as const };
    installBackendEnv([qwen, m1], [{ backendId: m1.backendId, tasks: ["decision_audit"], maxClaims: 1 }]);
    await run(auditJob); expect(calls).toHaveLength(1); expect(await auditWork(value.workId)).toMatchObject({ state: "queued", attempts: 0 });
  });
  it("원 모델 family가 unknown이면 임의로 채우거나 DeepSeek를 호출하지 않는다", async () => {
    const value = await seedAudit();
    await admin`UPDATE llm_assist_results SET model_family='unknown-fixture' WHERE id=${value.originalResultId}::uuid`;
    // source의 당시 family도 unknown을 그대로 보존한다. 원 결과 변경은 별도 snapshot proof에서도 감지한다.
    const changed = { ...value.candidate, decision: { ...value.candidate.decision, modelFamily: "unknown-fixture" } };
    await admin`UPDATE llm_assist_work SET source=${JSON.stringify(changed)}::text::jsonb,source_hash=${actionAuditSourceHash(changed)} WHERE id=${value.workId}::uuid`;
    await run(auditJob); expect(calls).toHaveLength(1); expect(await auditWork(value.workId)).toMatchObject({ state: "queued", attempts: 0 });
  });
  it("현재 근거가 접근 차단이면 빈 자료로 DeepSeek를 부르지 않는다", async () => {
    const value = await seedAudit(); fixture.fetchCapped.mockImplementation(async (url: string) => {
      if (!fixture.sourceUrls.has(url)) { fixture.rejectedSources.push(url); throw new Error("fixture_source_required"); }
      return { ok: false, reason: "http", status: 403 };
    });
    await run(auditJob); expect(calls).toHaveLength(1); expect(await auditWork(value.workId)).toMatchObject({ state: "waiting_evidence", attempts: 0 });
  });
  it("정책 off와 원 업무 pause는 이미 큐에 있는 감사도 새 호출하지 않는다", async () => {
    const value = await seedAudit(); vi.stubEnv("LLM_ACTION_AUDIT_POLICY", JSON.stringify({ enabled: false }));
    await run(auditJob); expect(calls).toHaveLength(1); expect(await auditWork(value.workId)).toMatchObject({ state: "queued" });
    vi.stubEnv("LLM_ACTION_AUDIT_POLICY", JSON.stringify(auditPolicy));
    await admin`UPDATE jobs SET not_before=clock_timestamp()+interval '1 hour' WHERE name=${originJob}`;
    await run(auditJob); expect(calls).toHaveLength(1); expect(await auditWork(value.workId)).toMatchObject({ state: "queued", attempts: 0 });
  });
  it("주간 1건으로 고정된 표본 밖의 새 원 결정은 재실행해도 감사 호출을 추가하지 않는다", async () => {
    const first = await seedAudit(), secondProduct = await product(); await run(primaryJob);
    const [row] = await admin`SELECT r.id FROM llm_assist_results r JOIN llm_assist_work w ON w.id=r.work_id
      WHERE w.task='uptime' AND w.product_id=${secondProduct.id}`;
    const attempted = await db.transaction(async tx => {
      const one = await loadAutomatedDecision(tx, first.originalResultId), two = await loadAutomatedDecision(tx, row.id);
      const current = await readActionAuditProduct(tx, secondProduct.id);
      if (!one || !two || !current) throw new Error("fixture_original_decisions_missing");
      const frozen = await freezeActionAuditPeriod(tx, { periodStart: first.candidate.periodStart, seedHash: assistHash(seed), policy: auditPolicy,
        selected: [one, two], skippedUnknownFamily: 0, candidatesClipped: false });
      expect(frozen.selectedResultIds).toEqual([first.originalResultId]);
      return enqueueFrozenActionAudit(tx, { ...first.candidate, product: current, decision: two, selectedAt: new Date().toISOString() });
    });
    expect(attempted).toBeNull(); await run(auditJob);
    expect(calls.filter(call => call.backendId === deepseekId)).toHaveLength(1);
    expect(await admin`SELECT id FROM llm_assist_work WHERE task='decision_audit' AND product_id=${secondProduct.id}`).toHaveLength(0);
  });
  it("실제 UTC 주의 감사 호출 상한은 다른 frozen period 키나 재시작으로 우회하지 않는다", async () => {
    const first = await seedAudit(); await run(auditJob);
    expect(await auditWork(first.workId)).toMatchObject({ state: "human" });
    const second = await seedAudit(); expect(second.candidate.periodStart).not.toBe(first.candidate.periodStart);
    await run(auditJob);
    expect(calls.filter(call => call.backendId === deepseekId)).toHaveLength(1);
    expect(await auditWork(second.workId)).toMatchObject({ state: "obsolete", attempts: 0, last_error: "audit_weekly_budget_exhausted" });
    const requests = await nativeRequests();
    expect(requests.filter(row => row.model === deepseekModel && row.dispatched_at !== null)).toHaveLength(1);
    expect(requests.filter(row => row.model === deepseekModel && row.dispatched_at === null)).toMatchObject([{ state: "withdrawn" }]);
    await run(auditJob); expect(calls.filter(call => call.backendId === deepseekId)).toHaveLength(1);
    expect(await status(second.product.id)).toBe("banned");
  });
  it("근거 수집 도중 감사 소비자를 pause하면 새 native dispatch가 열리지 않는다", async () => {
    const value = await seedAudit();
    fixture.fetchCapped.mockImplementation(async (url: string) => {
      if (!fixture.sourceUrls.has(url)) { fixture.rejectedSources.push(url); throw new Error("fixture_source_required"); }
      await admin`UPDATE jobs SET not_before=clock_timestamp()+interval '1 hour' WHERE name=${auditJob}`;
      return { ok: true, status: 200, finalUrl: url, body: Buffer.from("Start your free plan"), truncated: false };
    });
    await run(auditJob); expect(calls).toHaveLength(1);
    expect(await auditWork(value.workId)).toMatchObject({ state: "waiting_capacity", attempts: 0 });
    const requests = await nativeRequests();
    expect(requests.filter(row => row.model === qwenModel)).toMatchObject([{ state: "settled" }]);
    expect(requests.filter(row => row.model === deepseekModel)).toMatchObject([{ state: "withdrawn", dispatched_at: null, terminal_evidence: null }]);
  });
  it("정상 업무 JSON과 공통 결과 행만으로는 실제 별도 native 종료 없는 감사를 기록하지 않는다", async () => {
    const value = await seedAudit();
    const collected = await collectActionAuditInput(value.candidate);
    if (collected.kind !== "ready") throw new Error("fixture_current_evidence_missing");
    const input = collected.input, outcome = auditOutcome(), resultId = randomUUID(), capacityId = randomUUID(), token = randomUUID();
    const before = await auditWork(value.workId), revision = Number(before.revision)+1;
    const result = await db.transaction(async tx => {
      await tx.execute(sql`update llm_assist_work set state='claimed',revision=${revision},claim_token=${token}::uuid,
        claim_job=${auditJob},claim_job_token=${auditToken}::uuid,claim_requested_version=0,owner_instance_id=${prefix},owner_boot_id=${owner.bootId}::uuid,
        backend_id=${deepseekId},capacity_request_id=${capacityId}::uuid,input=${JSON.stringify(input)}::jsonb,input_hash=${assistInputHash(input)}
        where id=${value.workId}::uuid`);
      await tx.execute(sql`insert into llm_assist_results(id,work_id,work_revision,capacity_request_id,backend_id,model_family,
        contract_hash,input_hash,prompt_hash,response_hash,input,outcome)
        values(${resultId}::uuid,${value.workId}::uuid,${revision},${capacityId}::uuid,${deepseekId},'deepseek-v4.1-flash-1017',
          ${localModelContractHash(deepseek)},${assistInputHash(input)},${assistPromptHash("audit")},${assistHash(outcome)},
          ${JSON.stringify(input)}::jsonb,${JSON.stringify(outcome)}::jsonb)`);
      return completeActionAuditRuntime(tx, { candidate: value.candidate, workId: value.workId, resultId, input,
        auditorFamily: "deepseek-v4.1-flash-1017", outcome });
    });
    expect(result).toBeNull(); expect(calls).toHaveLength(1);
    expect(await admin`SELECT audit_result_id FROM llm_assist_audit_findings WHERE work_id=${value.workId}::uuid`).toHaveLength(0);
    expect(await status(value.product.id)).toBe("banned");
  });
});
