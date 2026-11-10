import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { setAiTaskDepsForTest } from "@/lib/operations/admin-ai-tasks-repository";
import { TEST_DATABASE_URL } from "./setup";

/**
 * LG EXAONE API 를 심사 사유 번역의 작업 분산 구성원으로 붙이기(2026-11-10) — 운영과 같은 꼴의 정책(한도 선언 맵 groupLimits·providerLimits 가 있다)에서
 * server action → 저장 함수(진짜) → 연결·계약·장비 행·정책 route·분산 구성원·감사, 그리고 실행 쪽 스냅숏 묶기까지. 엔진은 가짜 fetch 다(실제 EXAONE 을 부르지 않는다).
 * 자기 DB 를 만들어 끝까지 migrate 한다(공유 test DB 에 정책·장비·감사 행을 남기지 않는다).
 */
const admin = vi.hoisted(() => ({ login: { login: "operator" } as { login: string } | null }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => admin.login, localOperatorName: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("server-only", () => ({}));

const name = `nomorevibe_test_exaone_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const pgAdmin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false;
const root = path.resolve(".");
const GEMMA_BASE = "https://m1.test/v1", EXAONE_BASE = "https://api.exaone.ai/v1", MODEL = "k-exaone_v2.5";
// 시험용 가짜 키 — 실제 키가 아니다
const GEMMA_KEY = "local-test-only-gemma", EXAONE_KEY = "local-test-only-exaone";
// 운영 정책 rev31 과 같은 꼴: 선언 맵이 있고, 사유 번역은 m1-gemma 하나
const prodShape: ModelCapacityPolicy = { version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  providerLimits: { "abcllm-m1-qwen": 2, acct: 1 }, groupLimits: { "m1-qwen": 2, "dev-a": 1 },
  routes: [{ routeId: "base-a", provider: "fixture", model: "m", providerBudgetId: "acct", groupId: "dev-a" },
    { routeId: "reason-translate", provider: "abcllm", model: "m1-gemma", providerBudgetId: "abcllm-m1-qwen", groupId: "m1-qwen" }] };
let calls: { url: string; method: string; auth: string | null; body: string | null }[] = [];
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = String(input), method = init?.method ?? "GET";
  calls.push({ url: target, method, auth: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? init.body : null });
  if (target === `${GEMMA_BASE}/models`) return Response.json({ data: [{ id: "m1-gemma" }] });
  if (target === `${GEMMA_BASE}/chat/completions` && method === "POST")
    return Response.json({ object: "chat.completion", model: "mlx-community--gemma-4-26b-a4b-it-4bit", choices: [{ message: { content: "OK" } }] });
  // EXAONE: /v1/models 는 없다(문서에 없음). chat 은 추론이 늘 켜져 1토큰이면 content 없이 length 로 끝난다
  if (target === `${EXAONE_BASE}/chat/completions` && method === "POST")
    return Response.json({ id: "x", object: "chat.completion", created: 1, model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: null, reasoning_content: "생" }, finish_reason: "length" }],
      usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10, reasoning_tokens: 1 } });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };
const EMPTY_REVISION = createHash("sha256").update("[]").digest("hex");
let auditFloor = 0;
const audits = (action: string) => client<{ action: string; detail: Record<string, unknown> }[]>`SELECT action, detail FROM operations_audit
  WHERE id > ${auditFloor} AND action = ${action} ORDER BY id`;
const controlRow = async () => (await client<{ revision: number; policy: ModelCapacityPolicy; policy_hash: string }[]>`
  SELECT revision::int, policy, policy_hash FROM model_capacity_control WHERE id = 1`)[0];
const connection = async (label: string) => (await client<{ id: string; models: unknown; models_error: string | null; options: Record<string, unknown>; version: number }[]>`
  SELECT id, models, models_error, options, version::int FROM ai_connections WHERE label = ${label}`)[0];
async function installPolicy(value: ModelCapacityPolicy) {
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(value)}::jsonb, policy_hash = ${modelCapacityPolicyHash(value)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
}
async function clearAll() {
  await client.begin(async tx => {
    await tx`DELETE FROM ai_task_pool_members`; await tx`DELETE FROM ai_task_execution_configs`;
    await tx`DELETE FROM ai_task_models`; await tx`DELETE FROM ai_connections`; await tx`DELETE FROM model_serving_contracts`;
    await tx`DELETE FROM model_capacity_device_roles`; await tx`DELETE FROM model_capacity_devices`;
    await tx`UPDATE dr_writer_fence SET state = 'active', reason = NULL, fenced_db = NULL WHERE id = 1`;
  });
}
const actions = () => import("@/app/(operator)/admin/models/tasks/actions");
const executionActions = () => import("@/app/(operator)/admin/models/tasks/execution-actions");
/** 오늘의 운영 모양: m1-gemma 연결 + 사유 번역 1순위(계약·장비 행은 이 저장이 만든다, 정책 route 는 이미 있다) */
async function gemmaToday() {
  const { saveAiConnectionAction, saveAiTaskRanksAction } = await actions();
  expect(await saveAiConnectionAction(null, form({ kind: "api", label: "m1-gemma", baseUrl: GEMMA_BASE, apiKey: GEMMA_KEY, deviceId: "m1-qwen", capacitySlots: "2",
    contextTokens: "98304" }))).toMatchObject({ ok: true });
  const gemma = await connection("m1-gemma");
  expect(await saveAiTaskRanksAction(null, form({ task: "reason-translate", slot: "1", revision: EMPTY_REVISION, rank1Connection: gemma.id, rank1Model: "m1-gemma" })))
    .toMatchObject({ ok: true });
  return gemma;
}
async function exaoneConnection(extra: Record<string, string> = {}) {
  const { saveAiConnectionAction } = await actions();
  const saved = await saveAiConnectionAction(null, form({ kind: "api", label: "LG EXAONE", baseUrl: EXAONE_BASE, apiKey: EXAONE_KEY, deviceId: "exaone-api", capacitySlots: "1",
    contextTokens: "524288", manualModels: MODEL, reasoningTokenReserve: "4096", keyValidDays: "30", "allowedTask.reason-translate": "1", ...extra }));
  expect(saved).toMatchObject({ ok: true });
  return { saved, row: await connection("LG EXAONE") };
}
const poolForm = (task: string, members: { connectionId: string; model: string }[], expectedRevision = "") =>
  form({ task, slot: "1", expectedRevision, mode: "workload_pool", members: JSON.stringify(members) });

beforeAll(async () => {
  await pgAdmin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
}, 180_000);
afterAll(async () => {
  setAiTaskDepsForTest(null);
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 });
  if (created) await pgAdmin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await pgAdmin.end({ timeout: 3 });
});
beforeEach(async () => {
  vi.stubEnv("NMV_SECRET_BOX_KEY", randomBytes(32).toString("base64"));
  // 작업 분산 저장의 목록 대조(readbackServingEndpoint)는 전역 fetch 를 쓴다
  vi.stubGlobal("fetch", fakeFetch);
  await clearAll(); await installPolicy(prodShape);
  calls = []; admin.login = { login: "operator" };
  setAiTaskDepsForTest({ request: fakeFetch, now: () => Date.parse("2026-11-10T03:00:00.000Z"), current: async () => [] });
  auditFloor = Number((await client`SELECT coalesce(max(id), 0) AS id FROM operations_audit`)[0].id);
});
afterEach(async () => { await clearAll(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("LG EXAONE 연결 — 목록 없는 서버", () => {
  it("GET /models 가 404 여도 저장하고, 적은 모델·쓸 수 있는 작업·추론 여유·키 유효 기간·키 넣은 시각을 옵션에 둔다(키는 암호문만)", async () => {
    const { saved, row } = await exaoneConnection();
    expect(saved?.message).toContain("직접 적은 모델 1개를 씁니다");
    expect(row).toMatchObject({ models: null, models_error: "http_404" });
    expect(row.options).toEqual({ contextTokens: 524_288, manualModels: [MODEL], allowedTasks: ["reason-translate"], reasoningTokenReserve: 4096, keyValidDays: 30,
      keySetAt: "2026-11-10T03:00:00.000Z" });
    expect(JSON.stringify([await client`SELECT options FROM ai_connections`, await audits("ai-connection-save")])).not.toContain(EXAONE_KEY);
    // 키를 그대로 두고 다시 저장하면 키 넣은 시각도 그대로다
    const { saveAiConnectionAction } = await actions();
    expect(await saveAiConnectionAction(null, form({ id: row.id, expectedVersion: String(row.version), kind: "api", label: "LG EXAONE", baseUrl: EXAONE_BASE,
      deviceId: "exaone-api", capacitySlots: "1", contextTokens: "524288", manualModels: MODEL, "allowedTask.reason-translate": "1" }))).toMatchObject({ ok: true });
    expect((await connection("LG EXAONE")).options).toEqual({ contextTokens: 524_288, manualModels: [MODEL], allowedTasks: ["reason-translate"],
      keySetAt: "2026-11-10T03:00:00.000Z" });
    // 배정 없는 적은 모델도 LLM 운영의 「삭제」로 목록에서 뺄 수 있다(서버 목록 모델과 같은 규칙)
    const { setAiConnectionModelsHidden, listAiConnections } = await import("@/lib/operations/admin-ai-tasks-repository");
    const current = await connection("LG EXAONE");
    expect(await setAiConnectionModelsHidden({ id: current.id, expectedVersion: current.version, models: [MODEL], hidden: true }, "operator")).toMatchObject({ ok: true });
    expect((await listAiConnections()).find(row => row.id === current.id)?.manualModels).toEqual([]);
  });
});

describe("심사 사유 번역 작업 분산(m1-gemma + EXAONE)", () => {
  it("분산 저장이 EXAONE 계약(1토큰 시험·운영자 상한·추론 여유)·1칸 장비 행·정책 route(선언 맵에 새 장비 추가, DRAIN 없음)·구성원을 한 TX 에 만든다", async () => {
    const gemma = await gemmaToday();
    const { row: exaone } = await exaoneConnection();
    const before = await controlRow();
    calls = [];
    const { saveTaskExecutionAction } = await executionActions();
    const result = await saveTaskExecutionAction(null, poolForm("reason-translate", [{ connectionId: gemma.id, model: "m1-gemma" }, { connectionId: exaone.id, model: MODEL }]));
    expect(result).toMatchObject({ ok: true });
    // EXAONE 은 목록을 읽지 않고(없다) 1토큰 시험만, m1-gemma 는 예전처럼 목록만(계약이 이미 있어 시험 없음)
    expect(calls.map(call => `${call.method} ${call.url} ${call.auth}`)).toEqual([`GET ${GEMMA_BASE}/models Bearer ${GEMMA_KEY}`,
      `POST ${EXAONE_BASE}/chat/completions Bearer ${EXAONE_KEY}`]);
    expect(JSON.parse(calls[1].body!)).toMatchObject({ model: MODEL, max_tokens: 1 });
    const [contract] = await client<{ auth: string; transport: string; contract: Record<string, unknown> }[]>`
      SELECT auth, transport, contract FROM model_serving_contracts WHERE enabled AND route_id = 'reason-translate' AND model = ${MODEL}`;
    expect(contract).toMatchObject({ auth: "stored", transport: "direct", contract: { protocol: "abcllm-reason-total-bound-v1", provider: "abcllm", model: MODEL,
      responseModel: MODEL, endpoint: `${EXAONE_BASE}/chat/completions`, totalTokenBound: 524_288, reasoningTokenReserve: 4096,
      deploymentRevision: `direct-exaone-api-${MODEL}-C524288-operator-bound` } });
    expect(await client`SELECT device_id, limit_slots, secondary_cap, enabled FROM model_capacity_devices ORDER BY device_id`).toEqual([
      { device_id: "exaone-api", limit_slots: 1, secondary_cap: 1, enabled: true }, { device_id: "m1-qwen", limit_slots: 2, secondary_cap: 2, enabled: true }]);
    const after = await controlRow();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.policy.routes).toEqual([...prodShape.routes,
      { routeId: "reason-translate", provider: "abcllm", model: MODEL, providerBudgetId: "exaone-api", groupId: "exaone-api" }]);
    // 선언 맵: 새 장비·예산 키만 장비 한도(1)로 더하고 옛 키는 그대로
    expect(after.policy.groupLimits).toEqual({ ...prodShape.groupLimits, "exaone-api": 1 });
    expect(after.policy.providerLimits).toEqual({ ...prodShape.providerLimits, "exaone-api": 1 });
    expect(after.policy_hash).toBe(modelCapacityPolicyHash(after.policy));
    expect((await client`SELECT mode FROM model_capacity_control WHERE id = 1`)[0].mode).toBe("open");
    expect(await client`SELECT position, connection_id, model, device_id, canonical_model FROM ai_task_pool_members ORDER BY position`).toEqual([
      { position: 1, connection_id: gemma.id, model: "m1-gemma", device_id: "m1-qwen", canonical_model: "m1-gemma" },
      { position: 2, connection_id: exaone.id, model: MODEL, device_id: "exaone-api", canonical_model: MODEL }]);
    const [saved] = await audits("ai-task-execution-save");
    expect(saved.detail).toMatchObject({ mode: "workload_pool", created: { devices: ["exaone-api (1칸)"], routes: [`reason-translate / abcllm / ${MODEL} → exaone-api`] } });

    // 실행 쪽: DB 스냅숏(분산 설정 JOIN 연결, 키는 메모리에서만) → 계약 스냅숏 → 구성원마다 장부 이름·키·장비
    const [{ ensureAiTaskModels }, { ensureServingContracts }, { ensureAiTaskExecutionConfigs, readAiTaskExecutionConfig }, { resolveTextTaskRanks }] = await Promise.all([
      import("@/lib/llm/ai-task-models-snapshot"), import("@/lib/llm/serving-contract-store"), import("@/lib/llm/ai-task-execution-snapshot"), import("@/lib/llm/ai-task-resolver")]);
    await Promise.all([ensureAiTaskModels(0), ensureServingContracts(0), ensureAiTaskExecutionConfigs(0)]);
    const execution = readAiTaskExecutionConfig("reason-translate");
    expect(execution?.mode).toBe("workload_pool");
    const resolved = resolveTextTaskRanks("reason-translate", execution);
    expect(resolved.candidates.map(candidate => [candidate.unusable, candidate.binding?.identity, candidate.binding?.engineModel, candidate.binding?.bearer, candidate.binding?.deviceId]))
      .toEqual([[null, "m1-gemma", "m1-gemma", GEMMA_KEY, "m1-qwen"], [null, MODEL, MODEL, EXAONE_KEY, "exaone-api"]]);
    // 보낼 wire: 예전 답 몫 식 + 계약의 추론 여유 4096(wireHash 로 확인 — 실제 EXAONE 은 부르지 않는다)
    const [{ prepareReasonTranslationGatewayCall }, { reasonTranslationGatewayWire }] = await Promise.all([import("@/lib/crawl/agent-review-gateway"), import("@/lib/crawl/translate")]);
    const texts = ["Repository has no visible deployment evidence."];
    const call = prepareReasonTranslationGatewayCall(texts, { model: MODEL, timeoutMs: 45_000 });
    expect(call).toMatchObject({ kind: "prepared", provider: "abcllm", totalTokenBound: 524_288,
      wireHash: createHash("sha256").update(reasonTranslationGatewayWire(texts, MODEL, 4096)).digest("hex") });
  });

  it("EXAONE 은 심사 사유 번역에만 — 공개 번역의 분산·순위 저장은 거절하고 아무것도 만들지 않는다", async () => {
    const gemma = await gemmaToday();
    const { row: exaone } = await exaoneConnection();
    const before = await controlRow();
    const { saveTaskExecutionAction } = await executionActions();
    const pooled = await saveTaskExecutionAction(null, poolForm("product-translate", [{ connectionId: gemma.id, model: "m1-gemma" }, { connectionId: exaone.id, model: MODEL }]));
    expect(pooled?.issues).toEqual(["이 연결은 다른 작업에만 쓰도록 제한돼 있습니다. LLM 운영에서 그 연결의 「쓸 수 있는 작업」을 확인하세요."]);
    const { saveAiTaskRanksAction } = await actions();
    const ranked = await saveAiTaskRanksAction(null, form({ task: "product-translate", slot: "1", revision: EMPTY_REVISION, rank1Connection: exaone.id, rank1Model: MODEL }));
    expect(ranked?.issues?.[0]).toContain("심사 사유 번역 작업에만 쓰도록 제한돼 있습니다");
    expect((await controlRow()).revision).toBe(before.revision);
    expect(await client`SELECT model FROM model_serving_contracts WHERE model = ${MODEL}`).toEqual([]);
    expect(await client`SELECT task FROM ai_task_pool_members`).toEqual([]);
  });

  it("컨텍스트 상한 없이 적은 모델은 계약 상한을 몰라 저장하지 않는다", async () => {
    const gemma = await gemmaToday();
    const { row: exaone } = await exaoneConnection({ contextTokens: "" });
    calls = [];
    const { saveTaskExecutionAction } = await executionActions();
    const result = await saveTaskExecutionAction(null, poolForm("reason-translate", [{ connectionId: gemma.id, model: "m1-gemma" }, { connectionId: exaone.id, model: MODEL }]));
    expect(result?.issues?.[0]).toContain("「컨텍스트 상한」을 적은 뒤");
    expect(calls.filter(call => call.method === "POST")).toEqual([]);
    expect(await client`SELECT task FROM ai_task_pool_members`).toEqual([]);
  });
});

describe("appendCompatibleRoutes 선언 맵(2026-11-10)", () => {
  const route = { routeId: "reason-translate", provider: "abcllm", model: "new-model", providerBudgetId: "new-dev", groupId: "new-dev" };
  it("값을 주지 않으면 예전처럼 정책이 파싱되지 않아 아무것도 쓰지 않고, 값을 모르면 model_capacity_route_undeclared", async () => {
    const { db } = await import("@/lib/db");
    const { appendCompatibleRoutes } = await import("@/lib/llm/capacity-repository");
    const before = await controlRow();
    await expect(db.transaction(tx => appendCompatibleRoutes(tx, [route]))).rejects.toThrow();
    await expect(db.transaction(tx => appendCompatibleRoutes(tx, [route], { declareLimit: () => undefined }))).rejects.toThrow("model_capacity_route_undeclared");
    expect(await controlRow()).toEqual(before);
    // 이미 선언된 장비의 route 는 값을 묻지 않고 덧붙인다
    const done = await db.transaction(tx => appendCompatibleRoutes(tx, [{ ...route, providerBudgetId: "abcllm-m1-qwen", groupId: "m1-qwen" }],
      { declareLimit: () => { throw new Error("must_not_ask"); } }));
    expect(done.appended).toHaveLength(1);
    expect((await controlRow()).policy.groupLimits).toEqual(prodShape.groupLimits);
  });
});
