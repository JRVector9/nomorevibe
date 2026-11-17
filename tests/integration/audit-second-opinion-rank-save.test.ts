import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { localModelContractRouteId } from "@/lib/llm/local-model-contract-table";
import { localModelContractHash } from "@/lib/llm/local-model-serving-contract";
import { localModelRouteIdReady, verifiedLocalModelContract } from "@/lib/llm/local-model-capacity";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { rejudgeSecondOpinionModels } from "@/lib/crawl/rejudge-second-opinion-models";
import { auditDirectBackendId, auditDirectLocalContract, saveAiTaskRanks, setAiTaskDepsForTest } from "@/lib/operations/admin-ai-tasks-repository";
import { runAiTaskRanks } from "@/scripts/ops/ai-task-ranks";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 2026-11-17 「deepseek 2순위로 넣어」(PR #988 이어서) — 운영 명령 그대로(scripts/ops/ai-task-ranks.ts set)
 * 감사 두 번째 의견 1순위 gpu3090-qwen · qwen3.8-flash-next, 2순위 m3-deepseek · deepseek-v4.1-flash-1017 을 저장하면
 * 2순위의 로컬 계약(이미 있으면 그것)과 local-second-opinion 정책 route 가 생겨, 실행 쪽(PR #988 rejudgeSecondOpinionModels)의
 * verifiedLocalModelContract·localModelRouteReady 검사를 실제로 통과한다. 1순위가 기본 설정과 다르면 아무것도 쓰지 않고 거절한다.
 * 자기 DB 를 만들어 끝까지 migrate 한다(공유 시험 DB 에 정책·계약·감사 행을 남기지 않는다).
 */
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const name = `nomorevibe_test_aso_ranks_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const pgAdmin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false;
const QWEN_BASE = "http://qwen.test:8090/v1", DS_BASE = "http://m3.test:8010/v1";
const QWEN_MODEL = "qwen3.8-flash-next", DS_MODEL = "deepseek-v4.1-flash-1017";
const QWEN_ID = randomUUID(), DS_ID = randomUUID();
const QWEN_BACKEND = "gpu3090-qwen-direct", DS_BACKEND = "m3-deepseek-direct";
const RANK1 = `--rank1=gpu3090-qwen|${QWEN_MODEL}`, RANK2 = `--rank2=m3-deepseek|${DS_MODEL}`;
const SET = ["set", "--operator=it", "--task=audit-second-opinion", "--slot=1"];
const qwenRoute = { routeId: "local-second-opinion", provider: "local-direct", model: QWEN_MODEL, providerBudgetId: QWEN_BACKEND, groupId: "gpu3090-qwen" };
const humanDeepseek = { routeId: "local-human-deepseek", provider: "local-direct", model: DS_MODEL, providerBudgetId: DS_BACKEND, groupId: "m3" };
const basePolicy = (routes: ModelCapacityPolicy["routes"]): ModelCapacityPolicy => ({ version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000, routes });
const physical = { "gpu3090-qwen": 2, m3: 1 };
let calls: string[] = [];
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = String(input), method = init?.method ?? "GET";
  calls.push(`${method} ${target}`);
  if (target === `${DS_BASE}/models`) return Response.json({ data: [{ id: DS_MODEL, max_model_len: 65536 }] });
  if (target === `${DS_BASE}/chat/completions` && method === "POST")
    return Response.json({ object: "chat.completion", model: DS_MODEL, choices: [{ message: { content: "OK" } }] });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const controlRow = async () => (await client<{ revision: number; policy: ModelCapacityPolicy }[]>`SELECT revision::int, policy FROM model_capacity_control WHERE id = 1`)[0];
const rankRows = () => client<{ rank: number; connection_id: string; model: string }[]>`
  SELECT rank, connection_id, model FROM ai_task_models WHERE task = 'audit-second-opinion' AND slot = 1 ORDER BY rank`;
const contractRows = () => client<{ route_id: string; model: string }[]>`SELECT route_id, model FROM model_serving_contracts WHERE enabled ORDER BY id`;
async function installPolicy(value: ModelCapacityPolicy) {
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(value)}::jsonb, policy_hash = ${modelCapacityPolicyHash(value)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
}
/** 관리 표의 로컬 계약 한 장(저장이 만드는 것과 같은 모양) — 운영의 「이미 위임 검수·보강 감사가 쓰는 M3 DeepSeek 계약」 자리 */
async function seedLocalContract(backendId: string, connectionId: string, base: string, model: string, group: string) {
  const contract = auditDirectLocalContract({ routeId: "fixture", backendId, endpoint: `${base}/chat/completions`, model, physicalGroup: group },
    connectionId, { responseModel: model, totalTokenBound: 65536 })!;
  const routeId = localModelContractRouteId(backendId);
  await client`INSERT INTO model_serving_contracts (route_id, model, contract, contract_hash, auth, transport, enabled, updated_by)
    VALUES (${routeId}, ${model}, ${JSON.stringify({ ...contract, routeId })}::jsonb, ${localModelContractHash(contract)}, 'none', 'direct', true, 'fixture')`;
}
async function clearAll() {
  await client.begin(async tx => {
    await tx`DELETE FROM ai_task_models`;
    await tx`DELETE FROM ai_connections`;
    await tx`DELETE FROM model_serving_contracts`;
    await tx`DELETE FROM model_capacity_device_roles`;
    await tx`DELETE FROM model_capacity_devices`;
    await tx`UPDATE dr_writer_fence SET state = 'active', reason = NULL, fenced_db = NULL WHERE id = 1`;
  });
}
/** 운영 명령 그대로 — stdout JSON 한 줄과 stderr 줄을 받는다 */
async function cli(argv: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {}), err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await runAiTaskRanks(argv);
    return { code, out: log.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>), err: err.mock.calls.map(call => String(call[0])) };
  } finally { log.mockRestore(); err.mockRestore(); }
}
/** 실행 쪽이 순위를 DB 에서 다시 읽게(고정 풀기) — PR #988 의 고르기·계약·정책 검사를 그대로 부른다 */
async function runtimeView() {
  setAiTaskModelsForTest(null);
  await ensureServingContracts(0);
  const models = await rejudgeSecondOpinionModels(QWEN_MODEL);
  const contract = verifiedLocalModelContract(`${DS_BASE}/chat/completions`, DS_MODEL, {});
  const policy = (await controlRow()).policy;
  return { models, contract, routeReady: contract ? localModelRouteIdReady(policy, "local-second-opinion", contract, { LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify(physical) }) : false };
}

beforeAll(async () => {
  await pgAdmin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(path.resolve("."), "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
}, 180_000);
afterAll(async () => {
  setAiTaskDepsForTest(null); setAiTaskModelsForTest(null);
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 });
  if (created) await pgAdmin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await pgAdmin.end({ timeout: 3 });
});
beforeEach(async () => {
  vi.stubEnv("NMV_SECRET_BOX_KEY", randomBytes(32).toString("base64"));
  // 기본 Qwen 직접 설정(qwenDirectConfig) — 운영 reviewer·웹이 같은 값을 쓴다
  vi.stubEnv("AUDIT_SECOND_OPINION_URL", QWEN_BASE);
  vi.stubEnv("AUDIT_SECOND_OPINION_MODEL", QWEN_MODEL);
  vi.stubEnv("LOCAL_MODEL_SERVING_CONTRACTS", "");
  await clearAll();
  calls = [];
  setAiTaskDepsForTest({ request: fakeFetch, current: async () => [] });
  await client`INSERT INTO ai_connections (id, label, kind, base_url, device_id, capacity_slots, models, updated_by) VALUES
    (${QWEN_ID}, 'gpu3090-qwen', 'api', ${QWEN_BASE}, 'gpu3090-qwen', 2, ${JSON.stringify([{ id: QWEN_MODEL, maxModelLen: 131072 }])}::jsonb, 'fixture'),
    (${DS_ID}, 'm3-deepseek', 'api', ${DS_BASE}, 'm3', 1, ${JSON.stringify([{ id: DS_MODEL, maxModelLen: 65536 }])}::jsonb, 'fixture')`;
  await client`INSERT INTO model_capacity_devices (device_id, limit_slots, secondary_cap, idle_ms, reserve_slots, physical_limit, updated_by)
    VALUES ('gpu3090-qwen', 2, 2, 60000, 0, 2, 'fixture'), ('m3', 1, 1, 60000, 0, 1, 'fixture')`;
  await seedLocalContract(QWEN_BACKEND, QWEN_ID, QWEN_BASE, QWEN_MODEL, "gpu3090-qwen");
  await installPolicy(basePolicy([qwenRoute]));
});
afterEach(async () => { setAiTaskModelsForTest(null); await clearAll(); vi.unstubAllEnvs(); });

describe("감사 두 번째 의견 순위 저장 → PR #988 실행 쪽 검사", () => {
  it("이미 있는 M3 DeepSeek 계약을 다시 쓰고 local-second-opinion route 만 덧붙인다 — 실행 쪽이 2순위를 고르고 계약·정책 검사를 통과한다. --rank1 만 다시 저장하면 되돌아간다", async () => {
    await seedLocalContract(DS_BACKEND, DS_ID, DS_BASE, DS_MODEL, "m3");
    await installPolicy(basePolicy([qwenRoute, humanDeepseek]));
    const before = await controlRow(), contractsBefore = await contractRows();
    // 저장 전: 순위가 없어 실행 쪽은 다른 모델을 고르지 않고, 계약은 있어도 local-second-opinion 경로가 없다
    expect((await runtimeView())).toMatchObject({ models: [], routeReady: false });

    const saved = await cli([...SET, RANK1, RANK2]);
    expect(saved.code).toBe(0);
    expect(saved.out).toHaveLength(1);
    expect(saved.out[0]).toMatchObject({ task: "audit-second-opinion", slot: 1, ok: true,
      created: { devices: [], contracts: [], routes: [`local-second-opinion / local-direct / ${DS_MODEL} → m3`] } });
    expect(String(saved.out[0].scope)).toContain(`2순위 m3-deepseek · ${DS_MODEL}은(는) 변경 재판정 거절을 1순위와 같은 모델이 냈을 때 그 항목의 두 번째 의견에만 씁니다`);
    expect(saved.err).toEqual([`범위 ${saved.out[0].scope}`]);
    // 엔진을 부르지 않았고(계약 재사용) 새 계약도 없다
    expect(calls).toEqual([]);
    expect(await contractRows()).toEqual(contractsBefore);
    expect(await rankRows()).toEqual([{ rank: 1, connection_id: QWEN_ID, model: QWEN_MODEL }, { rank: 2, connection_id: DS_ID, model: DS_MODEL }]);
    const after = await controlRow();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.policy.routes).toEqual([qwenRoute, humanDeepseek,
      { routeId: "local-second-opinion", provider: "local-direct", model: DS_MODEL, providerBudgetId: DS_BACKEND, groupId: "m3" }]);

    const runtime = await runtimeView();
    expect(runtime.models).toEqual([{ config: { baseUrl: DS_BASE, model: DS_MODEL, apiKey: null }, servingRevision: null }]);
    expect(runtime.contract).toMatchObject({ backendId: DS_BACKEND, physicalGroup: "m3", model: DS_MODEL });
    expect(runtime.routeReady).toBe(true);

    // 다시 같은 명령: 이미 있어 아무것도 만들지 않는다
    expect((await cli([...SET, RANK1, RANK2])).out[0]).toMatchObject({ ok: true, created: { contracts: [], routes: [], devices: [] } });
    expect((await controlRow()).revision).toBe(after.revision);

    // 되돌리기: --rank1 만 — 2순위가 빠져 실행 쪽은 다시 다른 모델을 고르지 않는다(정책 route·계약은 남아도 쓰이지 않는다)
    const reverted = await cli([...SET, RANK1]);
    expect(reverted).toMatchObject({ code: 0, out: [{ ok: true }] });
    expect(String(reverted.out[0].scope)).toContain("2순위가 없어 변경 재판정 거절에 다른 모델을 고르지 않습니다");
    expect(await rankRows()).toEqual([{ rank: 1, connection_id: QWEN_ID, model: QWEN_MODEL }]);
    expect((await runtimeView()).models).toEqual([]);
  });

  it("2순위 계약이 없으면 연결 주소를 readback + 1토큰 시험으로 확인해 로컬 계약을 만들고, 실행 쪽 계약·정책 검사를 통과한다", async () => {
    const saved = await cli([...SET, RANK1, RANK2]);
    expect(saved.code).toBe(0);
    const backend = auditDirectBackendId(DS_ID, DS_MODEL);
    expect(calls).toEqual([`GET ${DS_BASE}/models`, `POST ${DS_BASE}/chat/completions`]);
    expect(saved.out[0]).toMatchObject({ ok: true, created: { routes: [`local-second-opinion / local-direct / ${DS_MODEL} → m3`] } });
    expect((saved.out[0].created as { contracts: string[] }).contracts).toEqual([expect.stringContaining(`local-model:${backend} · ${DS_MODEL} 로컬 계약`)]);
    expect((await controlRow()).policy.routes).toContainEqual({ routeId: "local-second-opinion", provider: "local-direct", model: DS_MODEL, providerBudgetId: backend, groupId: "m3" });
    const runtime = await runtimeView();
    expect(runtime.models.map(model => model.config.model)).toEqual([DS_MODEL]);
    expect(runtime.contract).toMatchObject({ backendId: backend, deploymentRevision: `ai-connection:${DS_ID}`, model: DS_MODEL });
    expect(runtime.routeReady).toBe(true);
  });

  it("1순위가 기본 Qwen 직접 설정과 다르면 거절하고 아무것도 쓰지 않는다 — 공개분 추가 검수 순위 저장은 예전처럼 거절", async () => {
    await seedLocalContract(DS_BACKEND, DS_ID, DS_BASE, DS_MODEL, "m3");
    await installPolicy(basePolicy([qwenRoute, humanDeepseek]));
    const before = { control: await controlRow(), contracts: await contractRows(), ranks: await rankRows() };
    const refused = await cli([...SET, `--rank1=m3-deepseek|${DS_MODEL}`]);
    expect(refused.code).toBe(1);
    expect(refused.out[0]).toMatchObject({ ok: false, issues: [expect.stringContaining("1순위는 기본 Qwen 직접 설정(qwen.test:8090 · qwen3.8-flash-next)과 같은 서버·모델이어야 합니다")] });
    // 기본 설정이 바뀌면(예: 다른 Qwen 서버) 지금 1순위도 거절된다 — 실행이 읽는 값과 순위가 갈라지지 않게
    vi.stubEnv("AUDIT_SECOND_OPINION_URL", "http://other-qwen.test:8090/v1");
    expect((await cli([...SET, RANK1, RANK2])).code).toBe(1);
    expect({ control: await controlRow(), contracts: await contractRows(), ranks: await rankRows() }).toEqual(before);
    expect(calls).toEqual([]);
    const published = await saveAiTaskRanks({ task: "published-filter", slot: 1, revision: "0".repeat(64), ranks: [{ provider: DS_ID, model: DS_MODEL }] }, "it");
    expect(published).toEqual({ ok: false, issues: [expect.stringContaining("공개분 추가 검수의 모델 순위는 지금 실행 쪽이 읽지 않아 저장해도 동작이 바뀌지 않습니다")] });
  });
});
