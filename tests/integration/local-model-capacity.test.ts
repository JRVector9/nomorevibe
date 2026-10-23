import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { products, productAuditCampaigns, productAuditItems, crawlCandidates, jobs, roleLeases } from "@/lib/db/schema";
import { putDocument } from "@/lib/crawl/repository";
import { saveSettings, getSettings } from "@/lib/crawl/settings";
import { loadAuditInput } from "@/lib/crawl/product-audit";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { reviewWithQwenDirect } from "@/lib/crawl/qwen-direct-review";
import { tryAcquireRole, renewRole, releaseRole, type RoleLease } from "@/lib/jobs/role-leader";
import { withLocalModelCapacity } from "@/lib/llm/local-model-capacity";
import { localModelContractHash, localModelServingContractSchema } from "@/lib/llm/local-model-serving-contract";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { cancelReservedModelSlot, reconcileLocalModelTerminal, requestLocalModelSlot, requestAi1ModelSlot, requestCliModelSlot,
  beginModelDispatch } from "@/lib/llm/capacity-repository";
import { releaseEvidencedDispatches } from "@/lib/operations/dr/reclaim";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/llm/gateway-local-end-fetch", async original => {
  const actual = await original<typeof import("@/lib/llm/gateway-local-end-fetch")>();
  return { ...actual, gatewayFetch: (...args: Parameters<typeof actual.gatewayFetch>) => {
    if (String(args[1]) !== endpoint) throw new Error("fixture_native_endpoint_required");
    return actual.gatewayFetch(...args);
  } };
});
const prefix = `direct-${randomUUID().slice(0, 8)}`;
const admin = postgres(TEST_DATABASE_URL, { max: 3, prepare: false, onnotice: () => {} });
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { "fixture-direct": 4, "fixture-gateway": 4, "fixture-other": 4 },
  groupLimits: { "same-hardware": 1, "other-hardware": 1 }, poolLimits: { reviewer: 4, text: 4 }, weights: { first: 1, second: 1, background: 1 },
  maxWaiting: 20, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "local-audit", provider: "local-direct", model: "qwen", providerBudgetId: "fixture-direct", groupId: "same-hardware" },
    { routeId: "local-held-qwen", provider: "local-direct", model: "qwen", providerBudgetId: "fixture-direct", groupId: "same-hardware" },
    { routeId: "local-human-deepseek", provider: "local-direct", model: "deepseek", providerBudgetId: "fixture-other", groupId: "other-hardware" },
    { routeId: "crawl-agent-review", provider: "abcllm", model: "gateway-alias", providerBudgetId: "fixture-other", groupId: "other-hardware" },
    { routeId: "product-audit", provider: "claude-cli", model: "sonnet", providerBudgetId: "fixture-other", groupId: "other-hardware" },
    { routeId: "fixture-text", provider: "abcllm", model: "gateway-alias", providerBudgetId: "fixture-gateway", groupId: "same-hardware" }] };
let server: Server, endpoint: string, campaignId: number, role: RoleLease, originalControl: Record<string, unknown>;
let env: Record<string, string>, sequence = 0, mode: "ok" | "bad_business" | "missing_terminal" | "hang" | "half" = "ok", calls = 0;
let upstreamActive = false, heldResponse: ServerResponse | null = null, started = () => {};
const observedWire: unknown[] = [];
const realFetch = globalThis.fetch;
const lease = { name: "product-audit", token: randomUUID(), requestedVersion: 1 };
const body = () => JSON.stringify({ model: "qwen", choices: [{ finish_reason: "stop", message: { content: mode === "bad_business" ? "invalid business json"
  : JSON.stringify({ decision: "approve", reason: "A usable application", evidenceIds: ["product"], confidence: 0.9 }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

beforeAll(async () => {
  ensureSchema();
  vi.stubGlobal("fetch", ((url, init) => {
    if (String(url) !== endpoint) throw new Error("fixture_global_endpoint_required");
    return realFetch(url, init);
  }) as typeof fetch);
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", "1");
  const journal = JSON.parse(readFileSync(path.resolve("drizzle/meta/_journal.json"), "utf8"));
  expect(journal.entries.at(-1).tag).toBe("0118_local_model_capacity_terminal");
  expect((await admin`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0].n).toBe(journal.entries.length);
  [{ row: originalControl }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  // 이전 실패가 남긴 이 파일의 fixture만 정리한다. DB 주소는 setup이 로컬 전용으로 제한한다.
  await db.execute(sql`DELETE FROM product_audit_items WHERE campaign_id IN (SELECT id FROM product_audit_campaigns WHERE reason LIKE 'direct-%')`);
  await db.execute(sql`DELETE FROM product_audit_campaigns WHERE reason LIKE 'direct-%'`);
  server = createServer(async (request, response) => {
    let wire = ""; for await (const chunk of request) { wire += chunk; }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(400).end(); return; }
    observedWire.push(JSON.parse(wire));
    calls++; upstreamActive = true; started();
    if (mode === "hang") { heldResponse = response; return; }
    response.setHeader("content-type", "application/json");
    if (mode === "half") { response.write('{"model":"qwen","choices":['); setTimeout(() => { upstreamActive = false; response.destroy(); }, 10); return; }
    upstreamActive = false;
    response.end(mode === "missing_terminal" ? '{"decision":"approve"}' : body());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
  endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const contract = localModelServingContractSchema.parse({ version: 1, protocol: "local-openai-chat-v1", provider: "local-direct",
    backendId: "fixture-direct", physicalGroup: "same-hardware", endpoint, model: "qwen", responseModel: "qwen", modelFamily: "qwen3.8-flash-next",
    deploymentRevision: "fixture-deployment", contextWindowTokens: 8192, totalTokenBound: 8192, maxOutputTokens: 3000, maxInputBytes: 100_000,
    capabilities: { vision: true, jsonSchema: true }, thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" },
    termination: { kind: "response_only" } });
  const acquired = await tryAcquireRole({ role: "reviewer", instanceId: prefix, bootId: randomUUID(), release: "fixture", kind: "primary" });
  if (!acquired) throw new Error("fixture_role"); role = acquired;
  env = { LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([contract]),
    AUDIT_SECOND_OPINION_URL: endpoint.replace(/\/chat\/completions$/, ""), AUDIT_SECOND_OPINION_MODEL: "qwen",
    LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify({ [contract.backendId]: localModelContractHash(contract) }),
    LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ [contract.physicalGroup]: 1 }), ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: role.instanceId,
    ROLE_LEASE_BOOT_ID: role.bootId, ROLE_LEASE_RELEASE: role.release, ROLE_LEASE_EPOCH: String(role.epoch) };
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: "gateway-alias" } }, "fixture");
  [ { id: campaignId } ] = await db.insert(productAuditCampaigns).values({ startedBy: "fixture", reason: prefix,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: "qwen-direct", model: "qwen" }).returning();
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date() })
    .onConflictDoUpdate({ target: jobs.name, set: { leaseToken: lease.token, lockedAt: new Date() } });
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(policy)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
});
beforeEach(async () => {
  mode = "ok"; calls = 0; started = () => {}; observedWire.length = 0;
  expect(await renewRole(role)).toBe(true);
  await db.update(jobs).set({ leaseToken: lease.token, lockedAt: new Date() }).where(eq(jobs.name, lease.name));
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
  // fixture 엔진 작업을 명시적으로 끝낸 뒤 다음 독립 사례를 위한 테스트 행만 삭제한다.
  if (heldResponse) { heldResponse.end(body()); heldResponse = null; upstreamActive = false; }
  expect(upstreamActive).toBe(false);
  await clearFixtureLedger();
});
afterAll(async () => {
  if (heldResponse) { upstreamActive = false; heldResponse.end(body()); heldResponse = null; }
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  // fixture 원격 엔진을 끝낸 뒤에만 장부를 청소한다. 이 SQL은 운영 회수 증거가 아니다.
  try {
    await clearFixtureLedger();
    await admin.begin(async tx => {
      await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
      await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,
        updated_at=r.updated_at FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
    });
    if (role) await releaseRole(role);
    await db.delete(roleLeases).where(eq(roleLeases.role, "reviewer"));
    if (campaignId) {
      await db.delete(productAuditItems).where(eq(productAuditItems.campaignId, campaignId));
      await db.delete(productAuditCampaigns).where(eq(productAuditCampaigns.id, campaignId));
    }
    await db.delete(crawlCandidates).where(sql`${crawlCandidates.repo} LIKE ${prefix + "/%"}`);
    await db.delete(products).where(sql`${products.slug} LIKE ${prefix + "-%"}`);
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await admin.end(); }
});

async function fixture() {
  const slug = `${prefix}-${++sequence}`, repo = `${prefix}/${slug}`, url = `https://${slug}.example`;
  const [product] = await db.insert(products).values({ slug, url, name: slug, tagline: "A task tool", description: "A usable task tool",
    category: "Productivity", status: "seeded", source: "crawler", verifyToken: randomUUID(), editTokenHash: "a".repeat(64) }).returning();
  await putDocument({ repo, productUrl: url, pageStatus: 200, repoMeta: { description: "A task tool", pushed_at: new Date().toISOString(),
    stargazers_count: 5, owner: { type: "User" } }, pageMeta: { title: slug, textSample: "Open the application and manage tasks.".repeat(12) } });
  await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", publishedSlug: slug, reason: "passed", judgedAt: new Date() });
  const [item] = await db.insert(productAuditItems).values({ campaignId, productId: product.id, slug }).returning();
  const input = await loadAuditInput(slug, await getSettings()); if (!input) throw new Error("fixture_input");
  const target = { kind: "audit" as const, purpose: "audit" as const, itemId: item.id, slug };
  return { repo, target, input, lease, promptVersion: "2026-10-21.v2", env };
}
const call = async (context: Awaited<ReturnType<typeof fixture>>, signal?: AbortSignal) => withLocalModelCapacity(context,
  request => reviewWithQwenDirect(context.input, { env: context.env, signal, request: (async (url, init) => {
    if (String(url) !== endpoint) throw new Error("fixture_endpoint_required");
    return request(url, init);
  }) as typeof fetch }));
const rows = async () => Array.from(await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r
  WHERE owner_instance_id LIKE ${prefix + "%"} ORDER BY queue_ordinal`).map(result => result.row);

it("실제 발행 원본·job/role lease로 dispatch하고 native 종료를 업무 JSON과 분리한다", async () => {
  const context = await fixture();
  expect(await call(context)).toMatchObject({ outcome: { decision: "approve" }, model: "qwen" });
  let row = (await rows()).at(-1);
  expect(row).toMatchObject({ state: "settled", group_id: "same-hardware", terminal_evidence: { kind: "local_model_terminal",
    provenance: "upstream_reported", actualUsage: { totalTokens: 15 } }, dispatch_binding: { chargedTokens: 8192 } });
  expect(calls).toBe(1);
  expect(observedWire).toEqual([expect.objectContaining({ model: "qwen", stream: false, chat_template_kwargs: { enable_thinking: false } })]);
  expect(row.terminal_evidence.responseHash).toBe(createHash("sha256").update(body()).digest("hex"));
  const changedBinding = { ...row.dispatch_binding, backendId: "different-backend" };
  await expect(admin.begin(async tx => {
    await tx`UPDATE model_capacity_requests SET state='dispatched',settled_at=NULL,terminal_evidence=NULL,terminal_evidence_hash=NULL,
      dispatch_binding=${JSON.stringify(changedBinding)}::text::jsonb WHERE request_id=${row.request_id}::uuid`;
    throw new Error("invalid_binding_was_accepted");
  })).rejects.toMatchObject({ code: "23514", constraint_name: "model_capacity_requests_dispatch_check" });
  await expect(admin.begin(async tx => {
    await tx`INSERT INTO model_capacity_events (request_id,kind,epoch,revision,policy_hash,from_state,to_state,evidence)
      SELECT request_id,kind,epoch+1,revision,policy_hash,from_state,to_state,evidence FROM model_capacity_events
      WHERE request_id=${row.request_id}::uuid AND kind='dispatch_settled'`;
    throw new Error("invalid_event_was_accepted");
  })).rejects.toMatchObject({ code: "23514", constraint_name: "model_capacity_events_terminal_check" });
  await expect(reconcileLocalModelTerminal(structuredClone(row.terminal_evidence))).rejects.toThrow("invalid_local_model_terminal");
  mode = "bad_business";
  await expect(call(await fixture())).rejects.toThrow("qwen_invalid_json");
  row = (await rows()).at(-1); expect(row.state).toBe("settled");
  expect(calls).toBe(2);
});

it("도메인 원본·소유권 변경과 fake generic dispatch를 HTTP 전에 거절한다", async () => {
  const context = await fixture();
  await db.update(crawlCandidates).set({ judgedAt: new Date(Date.now() + 500) }).where(eq(crawlCandidates.repo, context.repo));
  await expect(call(context)).rejects.toMatchObject({ reason: "reservation_lost" }); expect(calls).toBe(0);
  const clean = await fixture();
  await db.update(jobs).set({ leaseToken: randomUUID() }).where(eq(jobs.name, lease.name));
  await expect(call(clean)).rejects.toThrow("job_lease_lost"); expect(calls).toBe(0);
  const reservation = await requestLocalModelSlot({ requestId: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId },
    class: "background", pool: "reviewer", routeId: "local-audit", provider: "local-direct", model: "qwen", workKey: `direct-generic-${randomUUID()}` }, clean.target);
  expect(reservation.kind).toBe("granted");
  if (reservation.kind === "granted") {
    await expect(beginModelDispatch(reservation.reservation)).rejects.toThrow("local_model_bound_dispatch_required");
    expect(await cancelReservedModelSlot(reservation.reservation)).toBe(true);
  }
});

function child(value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "tests/integration/fixtures/local-model-slot-child.ts"],
      { cwd: path.resolve("."), env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    processChild.stdout.on("data", value => { stdout += value; }); processChild.stderr.on("data", value => { stderr += value; });
    processChild.on("error", reject); processChild.on("exit", code => {
      if (code !== 0) reject(new Error(`slot_child_${code}:${stderr}`)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
    processChild.stdin.end(JSON.stringify(value));
  });
}
it("별도 reviewer/text 프로세스와 gateway alias가 같은 물리 cap1을 넘지 않는다", async () => {
  const context = await fixture();
  const request = { requestId: randomUUID(), owner: { instanceId: `${prefix}-child-reviewer`, bootId: randomUUID() }, class: "background", pool: "reviewer",
    routeId: "local-audit", provider: "local-direct", model: "qwen", workKey: `${randomUUID()}` };
  const results = await Promise.all([child({ request, target: context.target }), child({ request: { ...request, requestId: randomUUID(),
    owner: { instanceId: `${prefix}-child-text`, bootId: randomUUID() }, pool: "text", routeId: "fixture-text", provider: "abcllm", model: "gateway-alias" } })]);
  expect(results.map(value => (value as { kind: string }).kind).sort()).toEqual(["deferred", "granted"]);
  expect((await admin`SELECT count(*)::int AS n FROM model_capacity_requests WHERE group_id='same-hardware'
    AND state IN ('reserved','dispatched','indeterminate')`)[0].n).toBe(1);
  for (const result of results as Awaited<ReturnType<typeof requestLocalModelSlot>>[]) if (result.kind === "granted")
    expect(await cancelReservedModelSlot(result.reservation)).toBe(true);
  // 대기 행은 다음 테스트의 grant를 앞서지 않게 fixture owner별로 만료시킨다.
  await admin`UPDATE model_capacity_requests SET queue_until=clock_timestamp()-interval '1 second' WHERE owner_instance_id LIKE ${prefix + "-child%"} AND state='waiting'`;
});

it("후보의 목적·attempt·model·물리 group 변경과 AI1 재진입도 원래 예약을 우회하지 못한다", async () => {
  const context = await fixture();
  const [{ id: candidateId }] = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(eq(crawlCandidates.repo, context.repo));
  const held = { kind: "candidate" as const, purpose: "held_qwen" as const, candidateId, attemptId: 1, repo: context.repo };
  const human = { ...held, purpose: "human_deepseek" as const, attemptId: 2 };
  const base = { owner: { instanceId: prefix, bootId: role.bootId }, class: "background" as const, pool: "reviewer" as const,
    routeId: "local-held-qwen", provider: "local-direct", model: "qwen", workKey: randomUUID() };
  const first = await requestLocalModelSlot({ ...base, requestId: randomUUID() }, held);
  expect(first.kind).toBe("granted");
  expect(await requestLocalModelSlot({ ...base, requestId: randomUUID(), model: "deepseek", routeId: "local-human-deepseek", workKey: randomUUID() }, human))
    .toEqual({ kind: "deferred", reason: "capacity" });
  const ai1 = { ...base, class: "first" as const, provider: "abcllm", routeId: "crawl-agent-review", model: "gateway-alias",
    workKey: `ai1:${candidateId}:${"a".repeat(64)}` };
  expect(await requestAi1ModelSlot({ ...ai1, requestId: randomUUID() }, candidateId)).toEqual({ kind: "deferred", reason: "capacity" });
  if (first.kind === "granted") expect(await cancelReservedModelSlot(first.reservation)).toBe(true);
  const second = await requestAi1ModelSlot({ ...ai1, requestId: randomUUID() }, candidateId);
  expect(second.kind).toBe("granted");
  expect(await requestLocalModelSlot({ ...base, requestId: randomUUID(), workKey: randomUUID() }, held)).toEqual({ kind: "deferred", reason: "capacity" });
  if (second.kind === "granted") expect(await cancelReservedModelSlot(second.reservation)).toBe(true);
  expect(calls).toBe(0); // 예약 모양은 도메인 dispatch 권한을 발급하지 않는다.
});

it("같은 감사 항목의 CLI와 direct 예약도 두 방향에서 서로 막는다", async () => {
  const context = await fixture();
  const base = { owner: { instanceId: prefix, bootId: role.bootId }, class: "background" as const, pool: "reviewer" as const,
    routeId: "local-audit", provider: "local-direct", model: "qwen", workKey: randomUUID() };
  const direct = await requestLocalModelSlot({ ...base, requestId: randomUUID() }, context.target);
  expect(direct.kind).toBe("granted");
  const cli = { ...base, routeId: "product-audit", provider: "claude-cli", model: "sonnet",
    workKey: `bg:audit:${context.target.itemId}:${"b".repeat(64)}` };
  const target = { kind: "audit" as const, itemId: context.target.itemId };
  expect(await requestCliModelSlot({ ...cli, requestId: randomUUID() }, target)).toEqual({ kind: "deferred", reason: "capacity" });
  if (direct.kind === "granted") expect(await cancelReservedModelSlot(direct.reservation)).toBe(true);
  const second = await requestCliModelSlot({ ...cli, requestId: randomUUID() }, target);
  expect(second.kind).toBe("granted");
  expect(await requestLocalModelSlot({ ...base, requestId: randomUUID(), workKey: randomUUID() }, context.target)).toEqual({ kind: "deferred", reason: "capacity" });
  if (second.kind === "granted") expect(await cancelReservedModelSlot(second.reservation)).toBe(true);
  expect(calls).toBe(0);
});

it("실제 엔진이 계속 생성하는 중 abort는 unknown 점유를 유지하고 정책 변경도 해제하지 않는다", async () => {
  const context = await fixture(); mode = "hang";
  const controller = new AbortController();
  const signalStarted = new Promise<void>(resolve => { started = resolve; });
  const pending = call(context, controller.signal); await signalStarted;
  expect(upstreamActive).toBe(true); controller.abort();
  await expect(pending).rejects.toThrow("qwen_cancelled");
  expect(upstreamActive).toBe(true);
  const active = (await rows()).at(-1); expect(active).toMatchObject({ state: "indeterminate", terminal_evidence: null });
  const reclaimed = await releaseEvidencedDispatches({ policies: new Map(), operator: "fixture" }, true);
  expect(reclaimed.rows.find(row => row.requestId === active.request_id)).toMatchObject({ released: false });
  expect((await rows()).find(row => row.request_id === active.request_id).state).toBe("indeterminate");
  // 새 owner와 input을 써도 물리 cap의 unknown을 우회하지 못한다.
  const next = await fixture();
  await expect(call(next)).rejects.toMatchObject({ reason: "capacity" }); expect(calls).toBe(1);
  await admin`UPDATE model_capacity_requests SET queue_until=clock_timestamp()-interval '1 second' WHERE owner_instance_id=${prefix} AND state='waiting'`;
  heldResponse!.end(body()); heldResponse = null; upstreamActive = false;
  expect((await rows()).find(row => row.request_id === active.request_id).state).toBe("indeterminate");
  // 미확정 호출이 있을 때 정책 변경은 새로운 grant를 막는다.
  await admin`UPDATE model_capacity_control SET policy=jsonb_set(policy,'{groupLimits,same-hardware}','2'),
    policy_hash=${modelCapacityPolicyHash({ ...policy, groupLimits: { ...policy.groupLimits, "same-hardware": 2 } })} WHERE id=1`;
  const changed = await fixture(); changed.env = { ...env, LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ "same-hardware": 2 }) };
  await expect(call(changed)).rejects.toMatchObject({ reason: "policy_changed" }); expect(calls).toBe(1);
  await admin`UPDATE model_capacity_control SET policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)} WHERE id=1`;
});
it("실제 HTTP 반쪽 응답도 socket 종료로 정산하지 않는다", async () => {
  mode = "half";
  await expect(call(await fixture())).rejects.toThrow("qwen_unreachable");
  expect(calls).toBe(1);
  expect((await rows()).at(-1)).toMatchObject({ state: "indeterminate", terminal_evidence: null });
});
