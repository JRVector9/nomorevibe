import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { prepareTextProfileGatewayCall, writeKeywordsWithReservedGateway } from "@/lib/crawl/agent-review-gateway";
import { profileHash } from "@/lib/domain/products/search-profile";
import { modelCapacityPolicyHash, textProfileDispatchBindingSchema, textProfileInputHash, type ModelCapacityPolicy, type ModelSlotResult } from "@/lib/llm/capacity";
import { finishTextProfileModelCapacityDispatch, lockTextProfileModelCapacityDispatch, reconcileTextProfileGatewayTerminal,
  requestTextProfileModelSlot } from "@/lib/llm/capacity-repository";
import { OPENAI_CHAT_TOTAL_BOUND_PROTOCOL } from "@/lib/llm/direct-serving-contract";
import { refreshServingContracts, servingContractAuth, setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { textProfileServingProvider } from "@/lib/llm/text-profile-serving-contract";
import { setAiTaskDepsForTest } from "@/lib/operations/admin-ai-tasks-repository";
import { CONTRACT_READER_FIELD } from "@/lib/operations/contract-reader-mark";
import { abcllmContract, profileEvidence, totalBoundContract } from "../total-bound-direct-fixture";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 2026-11-21 abcllm 이름표 정리 2단계 — 실제 PostgreSQL 에서:
 * 1. 계약 읽기 관문이 실제 관측(observeService 가 쓴 행)·역할 lease·역할 후보를 읽어 연다/닫는다(관측 시각의 시간대 포함).
 * 2. 「작업 ↔ 모델」 순위 저장(server action → 저장 함수)이 관문이 열리면 엔진 직접 총량 상한 계약과 (경로, local-direct, 모델) route 를, 닫히면 예전 abcllm 형을 만든다.
 *    손 입력 저장도 관문이 닫히면 새 모양을 받지 않는다.
 * 3. 전환 계획(dry-run)·거절·실행 → 그 계약으로 실제 장부를 돈다(local-direct 행 정산) → 되돌리기 → 다시 돈다(abcllm 행 정산). 키는 앞 행의 암호문을 이어 쓴다.
 * 자기 DB 를 만든다. 엔진은 loopback 이다. operations_audit 은 지우지 않는다(트리거) — id 바닥으로 센다.
 */
const admin = vi.hoisted(() => ({ login: { login: "operator" } as { login: string } | null }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => admin.login, localOperatorName: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("server-only", () => ({}));

const name = `nomorevibe_test_contract_convert_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const pgAdmin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false;
const NEW_RELEASE = "c".repeat(40), OLD_RELEASE = "d".repeat(40), KEY = "sk-convert-secret-1";
const MODEL = "fixture-model", BUDGET = "budget-convert", DEVICE = "device-convert", RESPONSE_MODEL = "served-fixture";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };
let auditFloor = 0;
const audits = () => client<{ action: string; target: string; detail: Record<string, unknown> }[]>`SELECT action, target, detail FROM operations_audit
  WHERE id > ${auditFloor} ORDER BY id`;
const controlRow = async () => (await client<{ revision: number; policy: ModelCapacityPolicy }[]>`SELECT revision::int, policy FROM model_capacity_control WHERE id = 1`)[0];
async function installPolicy(value: ModelCapacityPolicy) {
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(value)}::jsonb, policy_hash = ${modelCapacityPolicyHash(value)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
}
/** 이 판의 표지를 실은 서비스 관측 — 실제 관측 쓰기 함수로 */
async function observeNewRelease(instance = "text-m3") {
  vi.stubEnv("SERVICE_INSTANCE_ID", instance);
  const { observeService } = await import("@/lib/operations/observations");
  await observeService("text", { status: "running", release: NEW_RELEASE });
}

/** Loopback 엔진: /models, 1토큰 시험·실제 호출(완결 응답). 받은 요청을 남긴다. */
const engine = { content: '{"keywords_en":["budget app"],"keywords_ko":["가계부"]}', requests: [] as { path: string; headers: IncomingHttpHeaders; body: string }[] };
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(chunk as Buffer));
  request.on("end", () => {
    engine.requests.push({ path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: MODEL, max_model_len: 65_536 }] })); return; }
    response.end(JSON.stringify({ id: "convert-response", object: "chat.completion", created: 1, model: RESPONSE_MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: engine.content } }],
      usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 } }));
  });
});
let origin = "";

beforeAll(async () => {
  await pgAdmin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(path.resolve("."), "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("local_address");
  origin = `http://127.0.0.1:${address.port}`;
}, 240_000);
beforeEach(async () => {
  vi.stubEnv("NMV_SECRET_BOX_KEY", randomBytes(32).toString("base64"));
  await client.begin(async tx => {
    await tx`DELETE FROM ai_task_models`; await tx`DELETE FROM ai_connections`; await tx`DELETE FROM model_serving_contracts`; await tx`DELETE FROM model_helper_assignments`;
    await tx`DELETE FROM model_capacity_device_roles`; await tx`DELETE FROM model_capacity_devices`; await tx`DELETE FROM operations_observations`;
    await tx`DELETE FROM role_leases`; await tx`DELETE FROM job_batch_candidates`;
  });
  engine.requests.length = 0; admin.login = { login: "operator" };
  auditFloor = Number((await client`SELECT coalesce(max(id), 0) AS id FROM operations_audit`)[0].id);
});
afterEach(() => { vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); setAiTaskDepsForTest(null); });
afterAll(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await pgAdmin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await pgAdmin.end({ timeout: 3 });
});

describe("계약 읽기 관문(실제 행)", () => {
  it("관측·lease·후보를 최근 창 안에서 읽는다 — 표지 없는 관측·증명 안 된 release 는 닫고, 창 밖의 옛 행은 보지 않는다", async () => {
    const { readContractReaderGate } = await import("@/lib/operations/contract-reader-gate");
    expect(await readContractReaderGate()).toMatchObject({ ok: false, reason: "no_observations" });
    await observeNewRelease("text-m3");
    await observeNewRelease("text-mini");
    expect(await readContractReaderGate()).toMatchObject({ ok: true, checked: { observations: 2, leases: 0, candidates: 0 }, releases: [NEW_RELEASE.slice(0, 12)] });
    const [row] = await client`SELECT value FROM operations_observations WHERE key = 'service:text:text-m3'`;
    expect(row.value[CONTRACT_READER_FIELD]).toBe(1);
    // 표지 없는 옛 판 관측(옛 판 observeService 가 쓴 모양) — 최근이면 닫고, 창(10분) 밖이면 보지 않는다
    await client`INSERT INTO operations_observations (key, value, observed_at) VALUES ('service:reviewer:ai2-consumer-mini',
      ${JSON.stringify({ status: "running", release: OLD_RELEASE })}::jsonb, (now() AT TIME ZONE 'UTC'))`;
    expect(await readContractReaderGate()).toMatchObject({ ok: false, reason: "stale_processes",
      stale: [{ source: "observation", name: "reviewer:ai2-consumer-mini", reason: "no_marker" }] });
    await client`UPDATE operations_observations SET observed_at = (now() AT TIME ZONE 'UTC') - interval '11 minutes' WHERE key = 'service:reviewer:ai2-consumer-mini'`;
    expect(await readContractReaderGate()).toMatchObject({ ok: true });
    // 관측을 남기지 않은 프로세스: 살아 있는 lease 의 release 가 새 판 관측에 없으면 닫는다 — 만료된 lease 는 보지 않는다
    await client`INSERT INTO role_leases (role, owner_instance_id, owner_boot_id, owner_kind, owner_release, epoch, lease_until)
      VALUES ('maintenance', 'maint-oracle', ${randomUUID()}, 'primary', ${OLD_RELEASE}, 1, now() + interval '45 seconds')`;
    expect(await readContractReaderGate()).toMatchObject({ ok: false, stale: [{ source: "lease", name: "maintenance:maint-oracle", reason: "release_unproven" }] });
    await client`UPDATE role_leases SET owner_release = ${NEW_RELEASE} WHERE role = 'maintenance'`;
    expect(await readContractReaderGate()).toMatchObject({ ok: true, checked: { leases: 1 } });
    await client`UPDATE role_leases SET owner_release = ${OLD_RELEASE}, lease_until = now() - interval '1 second' WHERE role = 'maintenance'`;
    expect(await readContractReaderGate()).toMatchObject({ ok: true, checked: { leases: 0 } });
    // 역할 후보(Oracle 대기 후보 포함)
    await client`INSERT INTO job_batch_candidates (role, instance_id, host, boot_id, release, policy_hash)
      VALUES ('translation', 'oracle-translation', 'oracle-osaka-smoke', ${randomUUID()}, ${OLD_RELEASE}, ${"e".repeat(64)})`;
    expect(await readContractReaderGate()).toMatchObject({ ok: false, stale: [{ source: "candidate", reason: "release_unproven" }] });
    await client`UPDATE job_batch_candidates SET observed_at = clock_timestamp() - interval '11 minutes'`;
    expect(await readContractReaderGate()).toMatchObject({ ok: true });
  });
});

describe("저장이 새 모양을 만든다", () => {
  const ENGINE = "http://eng.test:8000/v1";
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input), method = init?.method ?? "GET";
    if (target === `${ENGINE}/models`) return Response.json({ data: ["Qwen-X", "Qwen-Y", "Qwen-Z"].map(id => ({ id, max_model_len: 32768 })) });
    if (target === `${ENGINE}/chat/completions` && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { model: string };
      return Response.json({ object: "chat.completion", model: `${body.model}-served`, choices: [{ message: { content: "OK" } }] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const EMPTY_REVISION = createHash("sha256").update("[]").digest("hex");
  beforeEach(() => installPolicy({ version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
    routes: [{ routeId: "base-a", provider: "fixture", model: "m", providerBudgetId: "acct", groupId: "dev-a" }] }));
  async function saveRank(model = "Qwen-X") {
    setAiTaskDepsForTest({ request: fakeFetch, now: () => Date.now(), current: async () => [] });
    const actions = await import("@/app/(operator)/admin/models/tasks/actions");
    let [connection] = await client<{ id: string }[]>`SELECT id FROM ai_connections WHERE label = '엔진'`;
    if (!connection) {
      expect(await actions.saveAiConnectionAction(null, form({ kind: "api", label: "엔진", baseUrl: `${ENGINE}/`, apiKey: KEY, deviceId: "eng-dev", capacitySlots: "2" })))
        .toMatchObject({ ok: true });
      [connection] = await client<{ id: string }[]>`SELECT id FROM ai_connections WHERE label = '엔진'`;
    }
    const view = await (await import("@/lib/operations/admin-ai-tasks-repository")).readAiTasksAdminView();
    const revision = view.slots.find(slot => slot.task.id === "crawl-tagline" && slot.slot === 1)?.revision ?? EMPTY_REVISION;
    return actions.saveAiTaskRanksAction(null, form({ task: "crawl-tagline", slot: "1", revision, rank1Connection: connection.id, rank1Model: model }));
  }
  const enabledShape = async (model: string) => (await client<{ provider: string }[]>`SELECT contract->>'provider' AS provider FROM model_serving_contracts
    WHERE enabled AND route_id = 'crawl-tagline' AND model = ${model}`)[0]?.provider;

  it("관문이 열려 있으면 순위 저장이 엔진 직접 총량 상한 계약(장비 이름 없음)과 (경로, local-direct, 모델) route 를 만든다", async () => {
    await observeNewRelease();
    const before = await controlRow();
    const result = await saveRank();
    expect(result).toMatchObject({ ok: true });
    expect(result?.message).toContain("정책 경로 crawl-tagline / local-direct / Qwen-X → eng-dev(DRAIN 없음)");
    const [contract] = await client<{ model: string; transport: string; auth: string; contract: Record<string, unknown>; api_key_ciphertext: string | null }[]>`
      SELECT model, transport, auth, contract, api_key_ciphertext FROM model_serving_contracts WHERE enabled`;
    expect(contract).toMatchObject({ model: "Qwen-X", transport: "direct", auth: "stored", contract: { protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, provider: "local-direct",
      model: "Qwen-X", endpoint: `${ENGINE}/chat/completions`, responseModel: "Qwen-X-served", totalTokenBound: 32768, deploymentRevision: "direct-Qwen-X-C32768" } });
    expect(contract.contract).not.toHaveProperty("strictTerminalOptIn");
    expect(contract.api_key_ciphertext).not.toContain(KEY);
    const after = await controlRow();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.policy.routes).toContainEqual({ routeId: "crawl-tagline", provider: "local-direct", model: "Qwen-X", providerBudgetId: "eng-dev", groupId: "eng-dev" });
    expect(after.policy.routes.some(route => route.provider === "abcllm")).toBe(false);
    // 화면 읽기: 다시 저장할 것이 없다(있는 계약을 엔진 이름으로 찾는다)
    const view = await (await import("@/lib/operations/admin-ai-tasks-repository")).readAiTasksAdminView();
    expect(view.slots.find(slot => slot.task.id === "crawl-tagline")!.readiness).toEqual([expect.objectContaining({ blocking: [], provider: "local-direct",
      createContract: null, appendRoute: null })]);
  });

  it("관문이 닫혀 있으면 예전 abcllm 형으로 만들고, 옛 판 프로세스가 보이면 그 이름을 알린다", async () => {
    await observeNewRelease();
    await client`INSERT INTO operations_observations (key, value, observed_at) VALUES ('service:text:text-mini',
      ${JSON.stringify({ status: "running", release: OLD_RELEASE })}::jsonb, (now() AT TIME ZONE 'UTC'))`;
    const result = await saveRank();
    expect(result).toMatchObject({ ok: true });
    expect(result?.message).toContain("정책 경로 crawl-tagline / abcllm / Qwen-X → eng-dev(DRAIN 없음)");
    expect(JSON.stringify(result)).toContain("새 계약은 abcllm 형으로 만듭니다");
    expect(JSON.stringify(result)).toContain("text:text-mini(옛 판(계약 읽기 표지 없음)");
    const [contract] = await client<{ contract: Record<string, unknown> }[]>`SELECT contract FROM model_serving_contracts WHERE enabled`;
    expect(contract.contract).toMatchObject({ provider: "abcllm", protocol: "abcllm-crawl-tagline-total-bound-v1", deploymentRevision: "direct-eng-dev-Qwen-X-C32768" });
  });

  it("관문이 열려 있어도 경로가 아직 전환 전이면 abcllm 형 — 일부만 옮긴 동안도 abcllm 형, 전환 도구가 경로를 끝낸 뒤에야 새 모양", async () => {
    await observeNewRelease();
    await installPolicy({ version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000, routes: ["model-a", "model-b"].map(model =>
      ({ routeId: "crawl-tagline", provider: "abcllm", model, providerBudgetId: "eng-dev", groupId: "eng-dev" })) });
    const { saveAdminServingContract } = await import("@/lib/operations/admin-serving-contracts");
    for (const model of ["model-a", "model-b"]) await saveAdminServingContract({ routeId: "crawl-tagline",
      contract: abcllmContract("crawl-tagline", { model, endpoint: `${origin}/v1/chat/completions` }), auth: "none", transport: "direct" }, "operator");
    // 전환 전: 평범한 순위 저장은 경로를 옮기지 않는다
    const before = await saveRank("Qwen-X");
    expect(before).toMatchObject({ ok: true });
    expect(JSON.stringify(before)).toContain("crawl-tagline: 이 경로는 아직 전환 전 — abcllm 모양으로 저장합니다(켜진 abcllm 계약 2개)");
    expect(await enabledShape("Qwen-X")).toBe("abcllm");
    const { applyServingContractConversion, planServingContractConversion } = await import("@/lib/operations/serving-contract-convert");
    const convert = async (model: string | null) => applyServingContractConversion({ action: "convert", routeId: "crawl-tagline", model,
      planHash: (await planServingContractConversion({ action: "convert", routeId: "crawl-tagline", model })).planHash }, "operator");
    // 일부만 옮김: 아직 abcllm 형
    await convert("model-a");
    expect(await enabledShape("model-a")).toBe("local-direct");
    expect(JSON.stringify(await saveRank("Qwen-Y"))).toContain("이 경로는 아직 전환 전");
    expect(await enabledShape("Qwen-Y")).toBe("abcllm");
    // 경로를 끝까지 옮기면(켜진 abcllm 계약 0) 새 저장이 새 모양이다
    expect((await convert(null)).saved.map(row => row.model).sort()).toEqual(["Qwen-X", "Qwen-Y", "model-b"]);
    const after = await saveRank("Qwen-Z");
    expect(after).toMatchObject({ ok: true });
    expect(JSON.stringify(after)).not.toContain("전환 전");
    expect(await enabledShape("Qwen-Z")).toBe("local-direct");
    expect((await controlRow()).policy.routes).toContainEqual({ routeId: "crawl-tagline", provider: "local-direct", model: "Qwen-Z", providerBudgetId: "eng-dev", groupId: "eng-dev" });
  });

  it("손 입력 저장도 관문이 닫혀 있으면 새 모양을 받지 않는다(abcllm 형은 그대로 받는다)", async () => {
    const { saveAdminServingContract } = await import("@/lib/operations/admin-serving-contracts");
    const direct = totalBoundContract("crawl-tagline", { endpoint: `${origin}/v1/chat/completions` });
    await expect(saveAdminServingContract({ routeId: "crawl-tagline", contract: direct, auth: "none", transport: "direct" }, "operator"))
      .rejects.toThrow("contract_reader_gate_closed");
    await saveAdminServingContract({ routeId: "crawl-tagline", contract: abcllmContract("crawl-tagline", { endpoint: `${origin}/v1/chat/completions` }),
      auth: "none", transport: "direct" }, "operator");
    await observeNewRelease();
    // 관문이 열려도 켜진 abcllm 계약이 남은 경로에는 손으로 새 모양을 저장하지 않는다 — 전환 도구로만 옮긴다
    await expect(saveAdminServingContract({ routeId: "crawl-tagline", contract: direct, auth: "none", transport: "direct" }, "operator"))
      .rejects.toThrow("contract_route_not_converted");
    const { saveServingContract } = await import("@/app/(operator)/admin/models/contracts/actions");
    expect((await saveServingContract(null, form({ routeId: "crawl-tagline", contract: JSON.stringify(direct), auth: "none", transport: "direct" })))?.issues?.[0])
      .toContain("「abcllm 계약 → 직접 연결 전환」으로 경로를 옮겨주세요");
    // 그 경로의 abcllm 계약이 없으면(새 경로) 받는다
    const { disableAdminServingContract } = await import("@/lib/operations/admin-serving-contracts");
    expect(await disableAdminServingContract("crawl-tagline", "fixture-model", "operator")).toBe(true);
    await expect(saveAdminServingContract({ routeId: "crawl-tagline", contract: direct, auth: "none", transport: "direct" }, "operator")).resolves.toMatchObject({ id: expect.any(Number) });
  });
});

describe("엔진 연결(등록부 키)", () => {
  it("관문이 열려 있으면 고른 경로마다 엔진 직접 총량 상한 계약을 만들고, 같은 모델의 abcllm route 가 있으면 그 예산·장비로 local-direct route 를 덧붙인다", async () => {
    const { connectAdminEngine } = await import("@/lib/operations/admin-engine-connect");
    const ENGINE = "engine-model-x", BASE = "http://engine-connect.test:8000/v1";
    vi.stubEnv("DATABASE_URL", url.toString());
    await installPolicy({ version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
      routes: [{ routeId: "reason-translate", provider: "abcllm", model: ENGINE, providerBudgetId: "budget-m1", groupId: "dev-m1" }] });
    await observeNewRelease();
    const probe = (async (_target: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ object: "chat.completion", model: `${ENGINE}-served` }) : Response.json({ data: [{ id: ENGINE, max_model_len: 98304 }] })) as typeof fetch;
    const result = await connectAdminEngine({ registryKey: "m1:translation", baseUrl: `${BASE}/`, auth: "none", engineModel: ENGINE,
      routes: ["product-translate", "reason-translate"], selectStages: false }, "jr", probe);
    expect(result).toMatchObject({ directShapeNote: null, missingPolicyRoutes: [`product-translate / local-direct / ${ENGINE}`],
      contracts: [{ routeId: "product-translate", provider: "local-direct" }, { routeId: "reason-translate", provider: "local-direct" }] });
    const rows = await client<{ route_id: string; contract: Record<string, unknown> }[]>`SELECT route_id, contract FROM model_serving_contracts WHERE enabled ORDER BY route_id`;
    expect(rows.map(row => [row.route_id, row.contract.protocol, row.contract.provider, row.contract.deploymentRevision, "strictTerminalOptIn" in row.contract])).toEqual([
      ["product-translate", OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, "local-direct", `direct-${ENGINE}-C98304`, false],
      ["reason-translate", OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, "local-direct", `direct-${ENGINE}-C98304`, false]]);
    expect((await controlRow()).policy.routes).toEqual([{ routeId: "reason-translate", provider: "abcllm", model: ENGINE, providerBudgetId: "budget-m1", groupId: "dev-m1" },
      { routeId: "reason-translate", provider: "local-direct", model: ENGINE, providerBudgetId: "budget-m1", groupId: "dev-m1" }]);
    await client`DELETE FROM model_registry_overrides`;
  });
});

describe("배정 표 저장(direct 전송)", () => {
  const entry = { key: "eng:qwen", equipment: "eng", displayName: "eng:qwen", provider: "abcllm" as const, baseUrl: "http://eng.test:8000/v1", model: "Qwen-X",
    family: "qwen-x", timeoutMs: 60_000, maxTokens: 8_000, concurrency: 1, purposes: ["fixture"] };
  async function saveAssignment() {
    const { saveModelAssignment } = await import("@/lib/llm/capacity-helpers-repository");
    const { saveModelCapacityDevice } = await import("@/lib/llm/capacity-devices-repository");
    const { readModelRegistry } = await import("@/lib/llm/model-registry");
    await installPolicy({ version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
      routes: [{ routeId: "base-a", provider: "fixture", model: "m", providerBudgetId: "acct", groupId: "eng-dev" }] });
    await db.transaction(tx => saveModelCapacityDevice(tx, { deviceId: "eng-dev", limitSlots: 4, secondaryCap: 4, idleMs: 0, reserveSlots: 0, roles: [],
      physicalLimit: null, note: null }, null, "assign-test"));
    return db.transaction(tx => saveModelAssignment(tx, { assignmentId: "eng-dev:tagline:qwen", expectedVersion: null, stage: "tagline", deviceId: "eng-dev",
      registryKey: "eng:qwen", transport: "direct", mode: "live" }, "jr", { registry: () => ({ ...readModelRegistry(), models: [...readModelRegistry().models, entry] }),
      probeContract: async () => ({ endpoint: `${entry.baseUrl}/chat/completions`, requestModel: "Qwen-X", responseModel: "Qwen-X-served", totalTokenBound: 32_768,
        totalTokenBoundFrom: "engine" as const }) }));
  }
  it("관문이 열려 있으면 엔진 직접 총량 상한 계약과 (경로, local-direct, 모델) route·배정 행을 만든다; 닫혀 있으면 예전 abcllm 형", async () => {
    await observeNewRelease();
    const saved = await saveAssignment();
    expect(saved).toMatchObject({ route: { routeId: "crawl-tagline", provider: "local-direct", model: "Qwen-X", providerBudgetId: "eng", groupId: "eng-dev" },
      after: { provider: "local-direct" } });
    const [row] = await client`SELECT contract FROM model_serving_contracts WHERE enabled AND route_id = 'crawl-tagline'`;
    expect(row.contract).toMatchObject({ protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, provider: "local-direct", model: "Qwen-X", deploymentRevision: "direct-Qwen-X-C32768" });
    const [assignment] = await client`SELECT live_provider FROM model_helper_assignments WHERE assignment_id = 'eng-dev:tagline:qwen'`;
    expect(assignment.live_provider).toBe("local-direct");

    await client.begin(async tx => { await tx`DELETE FROM model_helper_assignments`; await tx`DELETE FROM model_serving_contracts`; await tx`DELETE FROM operations_observations`;
      await tx`DELETE FROM model_capacity_device_roles`; await tx`DELETE FROM model_capacity_devices`; });
    const legacy = await saveAssignment();
    expect(legacy).toMatchObject({ route: { provider: "abcllm" }, after: { provider: "abcllm" } });
    const [old] = await client`SELECT contract FROM model_serving_contracts WHERE enabled AND route_id = 'crawl-tagline'`;
    expect(old.contract).toMatchObject({ provider: "abcllm", deploymentRevision: "direct-eng-Qwen-X-C32768" });
    await client.begin(async tx => { await tx`DELETE FROM model_helper_assignments`; await tx`DELETE FROM model_capacity_device_roles`; await tx`DELETE FROM model_capacity_devices`; });
  });
});

describe("전환 → 호출 → 정산 → 되돌리기 → 호출 → 정산", () => {
  const ROUTE = "product-search-profile";
  const owner = { instanceId: `convert-${randomUUID()}`, bootId: randomUUID() };
  const policy = (): ModelCapacityPolicy => ({ version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000, groupLimits: { [DEVICE]: 8 }, routes: [
    { routeId: ROUTE, provider: "abcllm", model: MODEL, providerBudgetId: BUDGET, groupId: DEVICE },
    { routeId: "second-review", provider: "abcllm", model: "voter-model", providerBudgetId: BUDGET, groupId: DEVICE }] });
  const granted = (result: ModelSlotResult) => { expect(result).toMatchObject({ kind: "granted" }); if (result.kind !== "granted") throw new Error("granted"); return result.reservation; };
  let seed = 5000;
  /** 계약 스냅숏을 DB 에서 다시 읽고(실제 resolver), 그 경로의 provider 로 한 번 부른 뒤 정산한다 — 장부 행을 돌려준다 */
  async function callOnce() {
    vi.stubEnv("DATABASE_URL", url.toString());
    await refreshServingContracts();
    const provider = textProfileServingProvider(MODEL);
    const evidence = profileEvidence(), call = prepareTextProfileGatewayCall(evidence, { model: MODEL, timeoutMs: 5_000, provider });
    expect(call).toMatchObject({ kind: "prepared" }); if (call.kind !== "prepared") throw new Error("prepared");
    const productId = ++seed, fixed = { productId, slug: `convert-${productId}`, evidenceHash: profileHash(evidence), profile: { kind: "absent" as const }, model: MODEL };
    const request = { requestId: randomUUID(), workKey: `text:profile:${productId}:${textProfileInputHash(fixed)}`, owner: { ...owner }, class: "background" as const,
      pool: "text" as const, routeId: ROUTE, provider, model: MODEL };
    const reservation = granted(await requestTextProfileModelSlot(request, productId));
    const identity = { ...request } as Record<string, unknown>; delete identity.requestId;
    const dispatch = await db.transaction(async tx => {
      const lock = await lockTextProfileModelCapacityDispatch(tx, { reservation, identity: identity as never, productId });
      if (!lock) throw new Error("lock_required");
      return finishTextProfileModelCapacityDispatch(tx, lock, textProfileDispatchBindingSchema.parse({ ...fixed, kind: "text_profile_gateway", version: 1,
        logicalWorkKey: `text:profile:${productId}`, inputHash: textProfileInputHash(fixed), routeId: ROUTE, provider, wireHash: call.wireHash,
        servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound,
        job: { name: "product-search-profile", token: randomUUID(), requestedVersion: 1 },
        role: { role: "text", instanceId: owner.instanceId, bootId: owner.bootId, release: NEW_RELEASE, kind: "primary", epoch: 1, batch: { mode: "legacy" } } }));
    });
    engine.requests.length = 0;
    const sent = await writeKeywordsWithReservedGateway(evidence, dispatch, call);
    expect(sent.terminal).not.toBeNull();
    expect(await reconcileTextProfileGatewayTerminal(sent.terminal as never)).toEqual({ kind: "settled" });
    const [row] = await client`SELECT state, provider, model, provider_budget_id, group_id, dispatch_binding->>'provider' AS bound FROM model_capacity_requests
      WHERE request_id = ${request.requestId}::uuid`;
    const chat = engine.requests.find(entry => entry.path === "/v1/chat/completions")!;
    return { provider, row, chat, wireHash: call.wireHash };
  }

  it("dry-run 으로 대상·거절·덧붙일 route 를 보이고, 계획 hash 로만 실행한다", async () => {
    await installPolicy(policy());
    const { saveAdminServingContract } = await import("@/lib/operations/admin-serving-contracts");
    const { applyServingContractConversion, conversionPlanLines, planServingContractConversion } = await import("@/lib/operations/serving-contract-convert");
    const endpoint = `${origin}/v1/chat/completions`;
    const first = await saveAdminServingContract({ routeId: ROUTE, contract: abcllmContract(ROUTE, { model: MODEL, endpoint, responseModel: RESPONSE_MODEL }),
      auth: "stored", transport: "direct", apiKey: KEY }, "operator");
    // 거절 대상: 옛 게이트웨이 전송 행, 정책 route 가 없는 모델, 2차 tokenizer 이름이 다른 계약
    await saveAdminServingContract({ routeId: ROUTE, contract: abcllmContract(ROUTE, { model: "gateway-only", endpoint }), auth: "none", transport: "gateway" }, "operator");
    await saveAdminServingContract({ routeId: ROUTE, contract: abcllmContract(ROUTE, { model: "no-policy", endpoint }), auth: "none", transport: "direct" }, "operator");
    await saveAdminServingContract({ routeId: "second-review", contract: abcllmContract("second-review", { model: "voter-model", endpoint, extra: { requestBudget: {
      requestTokenBound: 32_000, maxOutputTokens: 4096, tokenizerEndpoint: `${origin}/tokenize`, tokenizerModel: "voter-alias" } } }), auth: "none", transport: "direct" }, "operator");
    const [{ api_key_ciphertext: firstCipher }] = await client`SELECT api_key_ciphertext FROM model_serving_contracts WHERE id = ${first.id}`;

    // 관문이 닫혀 있으면 계획은 보이되 실행할 수 없다
    const closed = await planServingContractConversion({ action: "convert", routeId: ROUTE });
    expect(closed).toMatchObject({ blocked: "contract_reader_gate_closed", gate: { ok: false, reason: "no_observations" } });
    await expect(applyServingContractConversion({ action: "convert", routeId: ROUTE, planHash: closed.planHash }, "operator"))
      .rejects.toThrow("serving_contract_convert_blocked:contract_reader_gate_closed");

    await observeNewRelease();
    const plan = await planServingContractConversion({ action: "convert", routeId: ROUTE });
    expect(plan).toMatchObject({ blocked: null, gate: { ok: true }, targets: [{ id: first.id, model: MODEL, nextAuth: "stored", wireModel: MODEL, endpoint }],
      appendRoutes: [{ routeId: ROUTE, provider: "local-direct", model: MODEL, providerBudgetId: BUDGET, groupId: DEVICE }] });
    expect(plan.refusals.map(row => [row.model, row.reason])).toEqual([["gateway-only", "transport_not_direct"], ["no-policy", "policy_route_missing"]]);
    expect(plan.targets[0].next).toMatchObject({ protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, provider: "local-direct", model: MODEL, endpoint, totalTokenBound: 65_536 });
    expect(conversionPlanLines(plan).join("\n")).toContain(`정책 덧붙임 ${ROUTE} / local-direct / ${MODEL} → 예산 ${BUDGET} · 장비 ${DEVICE}`);
    const ai2 = await planServingContractConversion({ action: "convert", routeId: "second-review" });
    expect(ai2).toMatchObject({ blocked: "nothing_to_do", targets: [], refusals: [{ model: "voter-model", reason: "tokenizer_model_differs" }] });
    expect(ai2.notes.join("\n")).toContain("2차: 전환 전에 capacity 대체");

    // 계획 뒤에 정책이 바뀌면(같은 local-direct route 를 다른 장비로) 실행은 거절된다 — 아무것도 쓰지 않는다
    await installPolicy({ ...policy(), groupLimits: { [DEVICE]: 8, other: 1 },
      routes: [...policy().routes, { routeId: ROUTE, provider: "local-direct", model: MODEL, providerBudgetId: "other", groupId: "other" }] });
    await expect(applyServingContractConversion({ action: "convert", routeId: ROUTE, planHash: plan.planHash }, "operator")).rejects.toThrow("serving_contract_convert_plan_changed");
    expect((await planServingContractConversion({ action: "convert", routeId: ROUTE })).refusals.map(row => row.reason)).toContain("local_direct_route_conflict");
    await installPolicy(policy());
    await expect(applyServingContractConversion({ action: "convert", routeId: ROUTE, planHash: "0".repeat(64) }, "operator")).rejects.toThrow("serving_contract_convert_plan_changed");
    expect(await client`SELECT id FROM model_serving_contracts WHERE enabled AND contract->>'provider' = 'local-direct'`).toEqual([]);

    // 전환 전: abcllm 으로 불린다
    const beforeCall = await callOnce();
    expect(beforeCall).toMatchObject({ provider: "abcllm", row: { state: "settled", provider: "abcllm", bound: "abcllm", provider_budget_id: BUDGET, group_id: DEVICE } });

    // 실행
    const fresh = await planServingContractConversion({ action: "convert", routeId: ROUTE });
    const revision = (await controlRow()).revision;
    const done = await applyServingContractConversion({ action: "convert", routeId: ROUTE, planHash: fresh.planHash }, "operator");
    expect(done).toMatchObject({ saved: [{ model: MODEL, previousId: first.id }], appended: [{ routeId: ROUTE, provider: "local-direct", model: MODEL }], policyRevision: revision + 1 });
    const rows = await client<{ id: number; enabled: boolean; auth: string; transport: string; contract: Record<string, unknown>; api_key_ciphertext: string | null }[]>`
      SELECT id::int AS id, enabled, auth, transport, contract, api_key_ciphertext FROM model_serving_contracts WHERE route_id = ${ROUTE} AND model = ${MODEL} ORDER BY id`;
    expect(rows.map(row => [row.enabled, row.contract.provider, row.auth, row.transport])).toEqual([[false, "abcllm", "stored", "direct"], [true, "local-direct", "stored", "direct"]]);
    // 키는 다시 넣지 않았다 — 앞 행의 암호문 그대로(같은 경로·모델 AAD)
    expect(rows[1].api_key_ciphertext).toBe(firstCipher);
    expect((await controlRow()).policy.routes).toEqual([...policy().routes, { routeId: ROUTE, provider: "local-direct", model: MODEL, providerBudgetId: BUDGET, groupId: DEVICE }]);
    expect((await audits()).map(row => row.action).slice(-2)).toEqual(["model-serving-contract-save", "model-serving-contract-convert"]);
    const [convertAudit] = (await audits()).filter(row => row.action === "model-serving-contract-convert");
    expect(convertAudit).toMatchObject({ target: ROUTE, detail: { planHash: fresh.planHash, saved: [{ model: MODEL, previousId: first.id }],
      refusals: [{ reason: "transport_not_direct" }, { reason: "policy_route_missing" }], gate: { releases: [NEW_RELEASE.slice(0, 12)] } } });
    expect(JSON.stringify(convertAudit)).not.toContain(KEY);

    // 전환 뒤: local-direct 로 불리고(장부 행 local-direct, 같은 예산·장비), 같은 키가 열린다, 엔진에는 같은 모델 이름이 간다
    const afterCall = await callOnce();
    expect(afterCall).toMatchObject({ provider: "local-direct", row: { state: "settled", provider: "local-direct", bound: "local-direct", provider_budget_id: BUDGET, group_id: DEVICE } });
    expect(servingContractAuth(ROUTE, MODEL)).toEqual({ mode: "stored", apiKey: KEY, transport: "direct" });
    expect(afterCall.chat.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(afterCall.chat.body).model).toBe(JSON.parse(beforeCall.chat.body).model);
    expect(sha(afterCall.chat.body)).toBe(afterCall.wireHash);
    expect(await planServingContractConversion({ action: "convert", routeId: ROUTE, model: MODEL })).toMatchObject({ blocked: "nothing_to_do", targets: [] });

    // 되돌리기: 꺼진 앞 abcllm 행을 그 JSON·인증 그대로 다시 저장한다(관문을 보지 않는다 — 관측을 지워도 된다)
    await client`DELETE FROM operations_observations`;
    const back = await planServingContractConversion({ action: "revert", routeId: ROUTE, model: MODEL });
    expect(back).toMatchObject({ blocked: null, gate: null, targets: [{ id: rows[1].id, restoreId: first.id, nextAuth: "stored", nextHash: first.contractHash }], refusals: [] });
    const reverted = await applyServingContractConversion({ action: "revert", routeId: ROUTE, model: MODEL, planHash: back.planHash }, "operator");
    expect(reverted).toMatchObject({ saved: [{ model: MODEL, previousId: rows[1].id, contractHash: first.contractHash }], appended: [], policyRevision: null });
    const [restored] = await client<{ contract_hash: string; api_key_ciphertext: string | null; contract: Record<string, unknown> }[]>`
      SELECT contract_hash, api_key_ciphertext, contract FROM model_serving_contracts WHERE enabled AND route_id = ${ROUTE} AND model = ${MODEL}`;
    expect(restored).toMatchObject({ contract_hash: first.contractHash, api_key_ciphertext: firstCipher, contract: { provider: "abcllm" } });
    expect((await audits()).map(row => row.action).slice(-2)).toEqual(["model-serving-contract-save", "model-serving-contract-revert"]);
    const backCall = await callOnce();
    expect(backCall).toMatchObject({ provider: "abcllm", row: { state: "settled", provider: "abcllm", bound: "abcllm" } });
    expect(backCall.chat.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(await planServingContractConversion({ action: "revert", routeId: ROUTE })).toMatchObject({ blocked: "nothing_to_do" });
    // 정책의 local-direct route 는 남는다(덧붙이기만 했다 — 다시 전환하면 그대로 쓴다)
    expect((await controlRow()).policy.routes).toContainEqual({ routeId: ROUTE, provider: "local-direct", model: MODEL, providerBudgetId: BUDGET, groupId: DEVICE });
  });

  it("같은 장비·모델의 실전 도우미 배정이 있으면 그 계약은 전환하지 않는다(그 경로가 도우미 실전 경로와 겹친다) — 끄면 다시 대상이다", async () => {
    await installPolicy(policy());
    const { saveAdminServingContract } = await import("@/lib/operations/admin-serving-contracts");
    const { conversionPlanLines, planServingContractConversion } = await import("@/lib/operations/serving-contract-convert");
    await saveAdminServingContract({ routeId: "second-review", contract: abcllmContract("second-review", { model: "voter-model", endpoint: `${origin}/v1/chat/completions` }),
      auth: "none", transport: "direct" }, "operator");
    await observeNewRelease();
    expect(await planServingContractConversion({ action: "convert", routeId: "second-review" })).toMatchObject({ blocked: null, targets: [{ model: "voter-model" }] });
    await client`INSERT INTO model_capacity_devices (device_id, limit_slots, secondary_cap, updated_by) VALUES (${DEVICE}, 4, 4, 'convert-test')`;
    await client`INSERT INTO model_helper_assignments (assignment_id, stage, device_id, model, shadow_route_id, live_route_id, live_provider, mode, evidence_key,
      promoted_evidence, promoted_at, promoted_by, updated_by) VALUES ('device-convert:ai2', 'ai2', ${DEVICE}, 'voter-model', 'local-helper-shadow-ai2', 'second-review',
      'local-direct', 'live', ${"f".repeat(64)}, '{}'::jsonb, clock_timestamp(), 'convert-test', 'convert-test')`;
    const plan = await planServingContractConversion({ action: "convert", routeId: "second-review" });
    expect(plan).toMatchObject({ blocked: "nothing_to_do", targets: [], appendRoutes: [],
      refusals: [{ model: "voter-model", reason: "helper_live_route_overlap", detail: "device-convert:ai2" }] });
    expect(conversionPlanLines(plan).join("\n")).toContain("실전 도우미 배정이 있어");
    // 그림자(shadow)·꺼진 도우미, 다른 장비의 도우미는 겹치지 않는다
    await client`UPDATE model_helper_assignments SET mode = 'shadow' WHERE assignment_id = 'device-convert:ai2'`;
    expect(await planServingContractConversion({ action: "convert", routeId: "second-review" })).toMatchObject({ blocked: null, targets: [{ model: "voter-model" }] });
    await client`DELETE FROM model_helper_assignments`;
  });

  it("관리 화면 동작: 미리 보기 → 그 hash 로 실행(관리자만)", async () => {
    await installPolicy(policy());
    const { saveAdminServingContract } = await import("@/lib/operations/admin-serving-contracts");
    await saveAdminServingContract({ routeId: ROUTE, contract: abcllmContract(ROUTE, { model: MODEL, endpoint: `${origin}/v1/chat/completions` }), auth: "none", transport: "direct" }, "operator");
    await observeNewRelease();
    const actions = await import("@/app/(operator)/admin/models/contracts/actions");
    const preview = await actions.previewContractConversion(null, form({ action: "convert", routeId: ROUTE, model: MODEL }));
    expect(preview?.plan).toMatchObject({ action: "convert", routeId: ROUTE, model: MODEL, blocked: null, targets: 1 });
    expect(preview?.plan?.lines.join("\n")).toContain("관문: 모든 프로세스가 새 판입니다");
    admin.login = null;
    expect(await actions.applyContractConversion(null, form({ action: "convert", routeId: ROUTE, model: MODEL, planHash: preview!.plan!.planHash })))
      .toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    admin.login = { login: "operator" };
    const applied = await actions.applyContractConversion(null, form({ action: "convert", routeId: ROUTE, model: MODEL, planHash: preview!.plan!.planHash }));
    expect(applied).toMatchObject({ ok: true });
    expect(applied?.message).toContain("전환했습니다: 계약 1개");
    const stale = await actions.applyContractConversion(null, form({ action: "convert", routeId: ROUTE, model: MODEL, planHash: preview!.plan!.planHash }));
    expect(stale?.issues?.[0]).toContain("미리 본 뒤 계약·정책이 바뀌었습니다");
  });
});
