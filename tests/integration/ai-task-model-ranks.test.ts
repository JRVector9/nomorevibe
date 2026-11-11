import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { aiConnectionKeyAad, type AiCurrentSlot } from "@/lib/operations/admin-ai-tasks";
import { previewAiTaskImport, setAiTaskDepsForTest } from "@/lib/operations/admin-ai-tasks-repository";
import { openSecret } from "@/lib/security/secret-box";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 작업 ↔ AI 모델(0162, PR A) — server action → 저장 함수(진짜) → ai_connections·ai_task_models·계약·정책 route·장비 행·감사.
 * 관리자·next/cache 만 가짜이고 쓰기 관문(fence)·표·감사는 진짜다. 엔진(/models·1토큰 시험)은 setAiTaskDepsForTest 의 fetch 로, 「지금 쓰는 모델」은 current 로 준다.
 * 자기 DB 를 만들어 끝까지 migrate 한다(공유 test DB 에 정책·장비·감사 행을 남기지 않는다). operations_audit 은 지우지 않는다(트리거) — id 바닥으로 센다.
 */
const admin = vi.hoisted(() => ({ login: { login: "operator" } as { login: string } | null }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => admin.login, localOperatorName: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("server-only", () => ({}));

const name = `nomorevibe_test_ai_tasks_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const pgAdmin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false;
const root = path.resolve(".");
const basePolicy: ModelCapacityPolicy = { version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "base-a", provider: "fixture", model: "m", providerBudgetId: "acct", groupId: "dev-a" }] };
const ENGINE = "http://eng.test:8000/v1", ENGINE2 = "http://eng2.test:8000/v1", EMB = "http://emb.test:18081/v1";
const KEY = "sk-engine-secret-1";
let clock = Date.parse("2026-11-02T03:00:00.000Z");
let calls: { url: string; method: string; auth: string | null }[] = [];
let current: AiCurrentSlot[] = [];
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = String(input), method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  calls.push({ url: target, method, auth: headers.get("authorization") });
  if (target.startsWith("http://down.test")) throw new TypeError("fetch failed");
  if (target === `${ENGINE}/models`) return Response.json({ data: [{ id: "Qwen-X", max_model_len: 32768 }, { id: "Qwen-Y" }] });
  if (target === `${ENGINE2}/models`) return Response.json({ data: [{ id: "Qwen-X", max_model_len: 16384 }] });
  if (target === `${EMB}/models`) return Response.json({ data: [{ id: "bge-m3" }] });
  if ((target === `${ENGINE}/chat/completions` || target === `${ENGINE2}/chat/completions`) && method === "POST") {
    const body = JSON.parse(String(init?.body)) as { model: string };
    return Response.json({ object: "chat.completion", model: `${body.model}-served`, choices: [{ message: { content: "OK" } }] });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };
const EMPTY_REVISION = createHash("sha256").update("[]").digest("hex");
let auditFloor = 0;
const audits = (action?: string) => client<{ action: string; target: string; ok: boolean; detail: Record<string, unknown> }[]>`SELECT action, target, ok, detail
  FROM operations_audit WHERE id > ${auditFloor} AND (${action ?? null}::text IS NULL OR action = ${action ?? null}) ORDER BY id`;
const connections = () => client<{ id: string; label: string; kind: string; base_url: string | null; api_key_ciphertext: string | null; cli_models: string[];
  models: { id: string; maxModelLen: number | null }[] | null; models_error: string | null; device_id: string; capacity_slots: number; version: number }[]>`
  SELECT id, label, kind, base_url, api_key_ciphertext, cli_models, models, models_error, device_id, capacity_slots, version::int FROM ai_connections ORDER BY label`;
const rankRows = () => client<{ task: string; slot: number; rank: number; connection_id: string; model: string; options: Record<string, unknown> }[]>`
  SELECT task, slot, rank, connection_id, model, options FROM ai_task_models ORDER BY task, slot, rank`;
const controlRow = async () => (await client<{ revision: number; policy: ModelCapacityPolicy }[]>`SELECT revision::int, policy FROM model_capacity_control WHERE id = 1`)[0];
const tableState = async () => ({ connections: await connections(), ranks: await rankRows(), control: await controlRow(),
  contracts: await client`SELECT route_id, model, transport, auth, enabled FROM model_serving_contracts ORDER BY id`,
  devices: await client`SELECT device_id, limit_slots FROM model_capacity_devices ORDER BY device_id`, audits: (await audits()).length });

async function installPolicy(value: ModelCapacityPolicy) {
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(value)}::jsonb, policy_hash = ${modelCapacityPolicyHash(value)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
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
const actions = () => import("@/app/(operator)/admin/models/tasks/actions");
async function makeEngine(extra: Record<string, string> = {}) {
  const { saveAiConnectionAction } = await actions();
  const result = await saveAiConnectionAction(null, form({ kind: "api", label: "엔진", baseUrl: `${ENGINE}/`, apiKey: KEY, deviceId: "eng-dev", capacitySlots: "2", ...extra }));
  expect(result).toMatchObject({ ok: true });
  return (await connections()).find(row => row.label === "엔진")!;
}

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
  await clearAll(); await installPolicy(basePolicy);
  calls = []; current = []; clock += 10 * 60_000; admin.login = { login: "operator" };
  setAiTaskDepsForTest({ request: fakeFetch, now: () => clock, current: async () => current });
  auditFloor = Number((await client`SELECT coalesce(max(id), 0) AS id FROM operations_audit`)[0].id);
});
afterEach(async () => { await clearAll(); vi.unstubAllEnvs(); });

describe("0162 표 CHECK", () => {
  it("종류별 칸·주소 꼴·순위 1~3·(작업, 칸, 순위) 하나를 DB 가 지킨다", async () => {
    const id = randomUUID();
    await expect(client`INSERT INTO ai_connections (id, label, kind, device_id, updated_by) VALUES (${id}, 'x', 'api', 'd', 't')`).rejects.toThrow(/ai_connections_api_check/);
    await expect(client`INSERT INTO ai_connections (id, label, kind, base_url, cli_tool, cli_models, device_id, updated_by)
      VALUES (${id}, 'x', 'cli', 'http://a/v1', 'claude', '{sonnet}', 'd', 't')`).rejects.toThrow(/ai_connections_cli_check/);
    await expect(client`INSERT INTO ai_connections (id, label, kind, base_url, device_id, updated_by) VALUES (${id}, 'x', 'api', 'http://a/api', 'd', 't')`)
      .rejects.toThrow(/ai_connections_base_url_check/);
    await client`INSERT INTO ai_connections (id, label, kind, base_url, device_id, updated_by) VALUES (${id}, 'x', 'api', 'http://a/v1', 'd', 't')`;
    await expect(client`INSERT INTO ai_connections (id, label, kind, base_url, device_id, updated_by) VALUES (${randomUUID()}, 'X', 'api', 'http://b/v1', 'd', 't')`)
      .rejects.toThrow(/ai_connections_label_idx/);
    await expect(client`INSERT INTO ai_task_models (task, rank, connection_id, model, updated_by) VALUES ('crawl-tagline', 4, ${id}, 'm', 't')`).rejects.toThrow(/ai_task_models_rank_check/);
    await client`INSERT INTO ai_task_models (task, rank, connection_id, model, updated_by) VALUES ('crawl-tagline', 1, ${id}, 'm', 't')`;
    await expect(client`INSERT INTO ai_task_models (task, rank, connection_id, model, updated_by) VALUES ('crawl-tagline', 1, ${id}, 'n', 't')`).rejects.toThrow(/ai_task_models_rank_key/);
    // 0167 permits the same model at another rank; the rank itself stays unique.
    await client`INSERT INTO ai_task_models (task, rank, connection_id, model, updated_by) VALUES ('crawl-tagline', 2, ${id}, 'm', 't')`;
    await expect(client`DELETE FROM ai_connections WHERE id = ${id}`).rejects.toThrow(/ai_task_models_connection_fk/);
  });
});

describe("AI 연결 저장", () => {
  it("API: 저장 전에 GET /models(키는 Bearer)를 읽어 목록을 함께 두고, 키는 암호문으로만 — 감사·결과에 키가 없다", async () => {
    const row = await makeEngine();
    expect(row).toMatchObject({ kind: "api", base_url: ENGINE, device_id: "eng-dev", capacity_slots: 2, version: 1, models_error: null,
      models: [{ id: "Qwen-X", maxModelLen: 32768 }, { id: "Qwen-Y", maxModelLen: null }] });
    expect(calls).toEqual([{ url: `${ENGINE}/models`, method: "GET", auth: `Bearer ${KEY}` }]);
    expect(row.api_key_ciphertext).not.toContain(KEY);
    expect(openSecret(row.api_key_ciphertext!, aiConnectionKeyAad(row.id))).toBe(KEY);
    expect(openSecret(row.api_key_ciphertext!, aiConnectionKeyAad(randomUUID()))).toBeNull();
    const [saved] = await audits("ai-connection-save");
    expect(saved).toMatchObject({ ok: true, target: "엔진", detail: { created: true, keyChanged: true, after: { hasKey: true, baseUrl: ENGINE }, modelsRead: { count: 2 } } });
    expect(JSON.stringify(saved.detail)).not.toContain(KEY);
  });
  it("닿지 않는 주소도 저장하고 이유를 알린다; 고치기는 판 compare-and-set, 키를 비워 두면 그대로", async () => {
    const { saveAiConnectionAction } = await actions();
    const down = await saveAiConnectionAction(null, form({ kind: "api", label: "꺼진 엔진", baseUrl: "http://down.test:1/v1" }));
    expect(down).toMatchObject({ ok: true });
    expect(down?.message).toContain("모델 목록을 읽지 못했습니다(닿지 않음(연결 실패·시간 초과))");
    const row = await makeEngine();
    const stale = await saveAiConnectionAction(null, form({ id: row.id, expectedVersion: "9", kind: "api", label: "엔진", baseUrl: ENGINE }));
    expect(stale?.issues).toEqual(["그 사이 다른 저장이 있었습니다. 새로고침한 뒤 다시 저장하세요."]);
    calls = [];
    const kept = await saveAiConnectionAction(null, form({ id: row.id, expectedVersion: "1", kind: "api", label: "엔진 2", baseUrl: ENGINE, deviceId: "eng-dev" }));
    expect(kept).toMatchObject({ ok: true });
    expect(calls[0].auth).toBe(`Bearer ${KEY}`);
    const after = (await connections()).find(entry => entry.id === row.id)!;
    expect(after).toMatchObject({ label: "엔진 2", version: 2, api_key_ciphertext: row.api_key_ciphertext });
    const taken = await saveAiConnectionAction(null, form({ kind: "api", label: "엔진 2", baseUrl: "http://other.test/v1" }));
    expect(taken?.issues).toEqual(["같은 이름의 연결이 이미 있습니다. 다른 이름을 쓰세요."]);
  });
  it("CLI: 도구 + 적은 모델 이름; 「다시 읽기」는 API 만, 1분에 한 번", async () => {
    const { saveAiConnectionAction, readAiConnectionModelsAction } = await actions();
    expect(await saveAiConnectionAction(null, form({ kind: "cli", label: "Claude CLI", cliTool: "claude", cliModels: "sonnet opus", deviceId: "anthropic-cli" })))
      .toMatchObject({ ok: true, message: expect.stringContaining("CLI 모델 2개") });
    const cli = (await connections()).find(entry => entry.kind === "cli")!;
    expect(cli).toMatchObject({ cli_models: ["sonnet", "opus"], api_key_ciphertext: null, models: null, base_url: null });
    expect((await readAiConnectionModelsAction(null, form({ id: cli.id })))?.issues).toEqual(["CLI 연결은 /models 목록이 없습니다. CLI 모델 이름을 직접 적으세요."]);
    const engine = await makeEngine();
    expect((await readAiConnectionModelsAction(null, form({ id: engine.id })))?.issues).toEqual(["1분 안에 이미 목록을 읽었습니다. 잠시 뒤 다시 읽으세요."]);
    clock += 61_000;
    expect(await readAiConnectionModelsAction(null, form({ id: engine.id }))).toMatchObject({ ok: true, message: "모델 2개를 읽었습니다." });
    expect((await connections()).find(entry => entry.id === engine.id)!.version).toBe(1);
    expect((await audits("ai-connection-models-read")).map(row => row.detail)).toEqual([{ id: engine.id, count: 2 }]);
  });
});

describe("작업 배정 읽기(2026-11-09)", () => {
  it("칸의 마지막 저장 시각(savedAt = 행 updated_at)을 화면 읽기에 싣고(감사 기록은 그대로), 진행 중인 감사 캠페인이 있는지 읽는다", async () => {
    const engine = await makeEngine();
    const { saveAiTaskRanksAction } = await actions();
    expect(await saveAiTaskRanksAction(null, form({ task: "crawl-tagline", slot: "1", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-X" })))
      .toMatchObject({ ok: true });
    const [stored] = await client<{ at: string }[]>`SELECT to_char(max(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
      FROM ai_task_models WHERE task = 'crawl-tagline' AND slot = 1`;
    const repository = await import("@/lib/operations/admin-ai-tasks-repository");
    expect((await repository.listAiTaskRows()).map(row => [row.task, row.rank, row.updatedAt])).toEqual([["crawl-tagline", 1, stored.at]]);
    const view = await repository.readAiTasksAdminView();
    expect(view.slots.find(slot => slot.task.id === "crawl-tagline")?.savedAt).toBe(stored.at);
    expect(view.slots.find(slot => slot.task.id === "reason-translate")?.savedAt).toBeNull();
    const [saved] = await audits("ai-task-models-save");
    expect(Object.keys((saved.detail.after as Record<string, unknown>[])[0])).not.toContain("updatedAt");

    const { readAuditCampaignRunning } = await import("@/lib/operations/llm-ops-read");
    // 이 파일만의 DB 라 감사 캠페인이 없다
    expect(await readAuditCampaignRunning()).toBe(false);
    const [campaign] = await client<{ id: number }[]>`INSERT INTO product_audit_campaigns (started_by, reason, prompt_version, rules_version, provider, model)
      VALUES ('ai-task-assign-test', 'test', 'p', 'r', 'opencode-cli', 'm') RETURNING id`;
    expect(await readAuditCampaignRunning()).toBe(true);
    await client`UPDATE product_audit_campaigns SET status = 'done', finished_at = now() WHERE id = ${campaign.id}`;
    expect(await readAuditCampaignRunning()).toBe(false);
    await client`DELETE FROM product_audit_campaigns WHERE id = ${campaign.id}`;
  });
});

describe("작업 ↔ 모델 순위 저장", () => {
  it("엔진 경로: 없는 엔진 직접 계약(readback + 1토큰)·장비 행·정책 route 를 한 TX 에 만들고 순위·감사를 쓴다", async () => {
    const engine = await makeEngine();
    const before = await controlRow();
    calls = [];
    const { saveAiTaskRanksAction } = await actions();
    const result = await saveAiTaskRanksAction(null, form({ task: "crawl-tagline", slot: "1", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-X" }));
    expect(result).toMatchObject({ ok: true });
    expect(result?.message).toContain("수집 소개 짓기: 1개 순위를 저장했습니다.");
    expect(result?.message).toContain("장비 행 eng-dev (2칸)");
    expect(result?.message).toContain("정책 경로 crawl-tagline / abcllm / Qwen-X → eng-dev(DRAIN 없음)");
    expect(calls.map(call => `${call.method} ${call.url} ${call.auth}`)).toEqual([`GET ${ENGINE}/models Bearer ${KEY}`, `POST ${ENGINE}/chat/completions Bearer ${KEY}`]);
    expect(await rankRows()).toEqual([{ task: "crawl-tagline", slot: 1, rank: 1, connection_id: engine.id, model: "Qwen-X", options: {} }]);
    const [contract] = await client<{ route_id: string; model: string; transport: string; auth: string; contract: Record<string, unknown> }[]>`
      SELECT route_id, model, transport, auth, contract FROM model_serving_contracts WHERE enabled`;
    expect(contract).toMatchObject({ route_id: "crawl-tagline", model: "Qwen-X", transport: "direct", auth: "stored",
      contract: { endpoint: `${ENGINE}/chat/completions`, responseModel: "Qwen-X-served", totalTokenBound: 32768, provider: "abcllm" } });
    const after = await controlRow();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.policy.routes).toContainEqual({ routeId: "crawl-tagline", provider: "abcllm", model: "Qwen-X", providerBudgetId: "eng-dev", groupId: "eng-dev" });
    expect(await client`SELECT device_id, limit_slots, secondary_cap, enabled FROM model_capacity_devices`).toEqual([{ device_id: "eng-dev", limit_slots: 2, secondary_cap: 2, enabled: true }]);
    expect(await client`SELECT * FROM model_capacity_device_roles`).toEqual([]);
    expect((await audits()).map(row => row.action)).toEqual(["ai-connection-save", "model-serving-contract-save", "model-capacity-device-save", "ai-task-models-save"]);
    const [saved] = await audits("ai-task-models-save");
    expect(saved).toMatchObject({ target: "crawl-tagline#1", detail: { task: "crawl-tagline", slot: 1, before: [], after: [{ rank: 1, model: "Qwen-X" }],
      created: { routes: ["crawl-tagline / abcllm / Qwen-X → eng-dev"] } } });
    // 같은 순위를 다시 저장하면 계약·경로·장비는 이미 있어 만들지 않는다
    const view = await (await import("@/lib/operations/admin-ai-tasks-repository")).readAiTasksAdminView();
    const line = view.slots.find(slot => slot.task.id === "crawl-tagline")!;
    expect(line.readiness).toEqual([expect.objectContaining({ blocking: [], warnings: [], createContract: null, appendRoute: null, createDevice: null })]);
    calls = [];
    const again = await saveAiTaskRanksAction(null, form({ task: "crawl-tagline", slot: "1", revision: line.revision, rank1Connection: engine.id, rank1Model: "Qwen-X" }));
    expect(again).toMatchObject({ ok: true });
    expect(again?.message).not.toContain("함께 만든 것");
    expect(calls).toEqual([]);
    expect((await controlRow()).revision).toBe(after.revision);
  });
  it("2026-11-09 「발행분 감사 · 변경 재판정」 API 순위: 연결 주소를 readback + 1토큰 시험으로 확인해 로컬 계약·local-audit 정책 route·장비 행을 한 TX 에 만들고, 다시 저장하면 만들지 않는다", async () => {
    const engine = await makeEngine();
    const { saveAiConnectionAction, saveAiTaskRanksAction } = await actions();
    expect(await saveAiConnectionAction(null, form({ kind: "cli", label: "Claude CLI", cliTool: "claude", cliModels: "sonnet", cliVersion: "2.1.0 (Claude Code)",
      deviceId: "anthropic-cli", capacitySlots: "1" }))).toMatchObject({ ok: true });
    const claude = (await connections()).find(row => row.label === "Claude CLI")!;
    const before = await controlRow();
    calls = [];
    const result = await saveAiTaskRanksAction(null, form({ task: "product-audit", slot: "1", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-X",
      rank2Connection: claude.id, rank2Model: "sonnet" }));
    expect(result).toMatchObject({ ok: true });
    expect(calls.map(call => `${call.method} ${call.url} ${call.auth}`)).toEqual([`GET ${ENGINE}/models Bearer ${KEY}`, `POST ${ENGINE}/chat/completions Bearer ${KEY}`]);
    expect(await rankRows()).toEqual([{ task: "product-audit", slot: 1, rank: 1, connection_id: engine.id, model: "Qwen-X", options: {} },
      { task: "product-audit", slot: 1, rank: 2, connection_id: claude.id, model: "sonnet", options: {} }]);
    const { auditDirectBackendId } = await import("@/lib/operations/admin-ai-tasks-repository");
    const backend = auditDirectBackendId(engine.id, "Qwen-X");
    const contracts = await client<{ route_id: string; model: string; transport: string; auth: string; api_key_ciphertext: string | null; contract: Record<string, unknown> }[]>`
      SELECT route_id, model, transport, auth, api_key_ciphertext, contract FROM model_serving_contracts WHERE enabled ORDER BY id`;
    // 로컬 계약(키는 계약에 두지 않는다 — 부를 때 연결의 키를 쓴다)과, Claude 순위의 감사 경로 CLI 계약(예전 그대로)
    expect(contracts.map(row => [row.route_id, row.model, row.transport, row.auth])).toEqual([[`local-model:${backend}`, "Qwen-X", "direct", "none"],
      ["cli:claude-cli:product-audit", "sonnet", "direct", "none"]]);
    expect(contracts[0].api_key_ciphertext).toBeNull();
    expect(contracts[0].contract).toMatchObject({ protocol: "local-openai-chat-v1", provider: "local-direct", backendId: backend, physicalGroup: "eng-dev",
      endpoint: `${ENGINE}/chat/completions`, model: "Qwen-X", responseModel: "Qwen-X-served", totalTokenBound: 32768, contextWindowTokens: 32768,
      deploymentRevision: `ai-connection:${engine.id}`, capabilities: { vision: false, jsonSchema: true } });
    const after = await controlRow();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.policy.routes).toContainEqual({ routeId: "local-audit", provider: "local-direct", model: "Qwen-X", providerBudgetId: backend, groupId: "eng-dev" });
    expect(after.policy.routes).toContainEqual(expect.objectContaining({ routeId: "product-audit", provider: "claude-cli", model: "sonnet", groupId: "anthropic-cli" }));
    expect(await client`SELECT device_id FROM model_capacity_devices ORDER BY device_id`).toEqual([{ device_id: "anthropic-cli" }, { device_id: "eng-dev" }]);
    // 워커가 읽는 그 계약 — 표의 행은 확인해 넣은 계약으로 읽힌다(감사 직접 경로가 이 주소·모델로 연다)
    const { ensureServingContracts } = await import("@/lib/llm/serving-contract-store");
    const { verifiedLocalModelContract } = await import("@/lib/llm/local-model-capacity");
    await ensureServingContracts(0);
    expect(verifiedLocalModelContract(`${ENGINE}/chat/completions`, "Qwen-X", {})).toMatchObject({ backendId: backend, responseModel: "Qwen-X-served" });
    // 다시 저장하면 계약·경로는 이미 있어 만들지 않는다(엔진도 다시 부르지 않는다). 장비의 물리 상한이 없다는 알림만 남는다
    const view = await (await import("@/lib/operations/admin-ai-tasks-repository")).readAiTasksAdminView();
    const line = view.slots.find(slot => slot.task.id === "product-audit")!;
    expect(line.readiness[0]).toMatchObject({ blocking: [], appendRoute: null, createDevice: null, provider: "local-direct" });
    expect(line.readiness[0]).not.toHaveProperty("createLocalContract");
    expect(line.readiness[0].warnings).toEqual([expect.stringContaining("장비 eng-dev에 물리 상한이 없습니다")]);
    calls = [];
    expect(await saveAiTaskRanksAction(null, form({ task: "product-audit", slot: "1", revision: line.revision, rank1Connection: engine.id, rank1Model: "Qwen-X",
      rank2Connection: claude.id, rank2Model: "sonnet" }))).toMatchObject({ ok: true });
    expect(calls).toEqual([]);
    expect((await controlRow()).revision).toBe(after.revision);
    // 직접 모델 작업(audit-review)은 그대로 「실제 적용 설정」 — 순위를 저장하지 않는다
    const local = await saveAiTaskRanksAction(null, form({ task: "audit-review", slot: "1", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-X" }));
    expect(local?.issues).toEqual([expect.stringContaining("/admin/audit")]);
  });
  it("막히면(로컬 경로 없음·옛 판·틀린 순위) 아무것도 쓰지 않고 한국어로 무엇이 없는지 보인다", async () => {
    const engine = await makeEngine();
    const { saveAiTaskRanksAction } = await actions();
    const snapshot = await tableState();
    const local = await saveAiTaskRanksAction(null, form({ task: "audit-review", slot: "1", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-X" }));
    expect(local?.issues).toEqual([expect.stringContaining("/admin/audit")]);
    const embedding = await saveAiTaskRanksAction(null, form({ task: "product-embedding", slot: "1", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-Y" }));
    expect(embedding?.issues).toEqual([expect.stringContaining("/admin/models/search")]);
    const stale = await saveAiTaskRanksAction(null, form({ task: "crawl-tagline", slot: "1", revision: "b".repeat(64), rank1Connection: engine.id, rank1Model: "Qwen-X" }));
    expect(stale?.issues).toEqual(["그 사이 이 줄이 바뀌었습니다. 새로고침한 뒤 다시 저장하세요."]);
    const gap = await saveAiTaskRanksAction(null, form({ task: "crawl-tagline", slot: "1", revision: EMPTY_REVISION, rank2Connection: engine.id, rank2Model: "Qwen-X" }));
    expect(gap?.issues).toEqual(["1순위를 비우고 그 뒤 순위만 고를 수 없습니다. 1순위부터 차례로 골라주세요."]);
    // 1차도 같은 모델을 다른 서버로 두 순위에 둘 수 있다(PR C1 — 2순위는 연결로 가른 장부 이름) — 그 서버가 닿지 않으면 계약을 만들지 못해 아무것도 쓰지 않는다
    const twoServers = await (async () => {
      const { saveAiConnectionAction } = await actions();
      await saveAiConnectionAction(null, form({ kind: "api", label: "엔진 B", baseUrl: "http://down.test:1/v1" }));
      await client`UPDATE ai_connections SET models = '[{"id":"Qwen-X","maxModelLen":null}]'::jsonb WHERE label = '엔진 B'`;
      const other = (await connections()).find(row => row.label === "엔진 B")!;
      return saveAiTaskRanksAction(null, form({ task: "first-review", slot: "1", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-X",
        rank2Connection: other.id, rank2Model: "Qwen-X" }));
    })();
    expect(twoServers?.issues).toEqual([expect.stringContaining("crawl-agent-review 경로의 엔진 직접 계약을 만들지 못했습니다: 엔진에 닿지 않습니다")]);
    const now = await tableState();
    expect({ ...now, connections: now.connections.filter(row => row.label !== "엔진 B"), audits: snapshot.audits })
      .toEqual({ ...snapshot, connections: snapshot.connections });
  });
  it("쓰는 순위가 있는 연결은 지울 수 없고, 비우면 지울 수 있다", async () => {
    const engine = await makeEngine();
    const { deleteAiConnectionAction } = await actions();
    await client`UPDATE model_capacity_control SET mode = 'disabled' WHERE id = 1`;
    // 일반 검색 설정은 짝 증거가 필요해 막히므로, 이 행은 연결 삭제 FK 동작만 보기 위한 픽스처다.
    await client`INSERT INTO ai_task_models (task, slot, rank, connection_id, model, updated_by) VALUES ('product-embedding', 1, 1, ${engine.id}, 'Qwen-Y', 'it')`;
    const refused = await deleteAiConnectionAction(null, form({ id: engine.id, label: "엔진", expectedVersion: "1", confirm: "엔진" }));
    expect(refused?.issues).toEqual(["이 연결을 쓰는 순위가 있어 지울 수 없습니다. 먼저 작업 ↔ 모델 표에서 빼거나 연결을 끄세요."]);
    await client`DELETE FROM ai_task_models WHERE task = 'product-embedding' AND slot = 1 AND rank = 1 AND connection_id = ${engine.id}`;
    expect(await deleteAiConnectionAction(null, form({ id: engine.id, label: "엔진", expectedVersion: "1", confirm: "엔진" }))).toMatchObject({ ok: true });
    expect(await connections()).toEqual([]);
    expect((await audits("ai-connection-delete")).map(row => row.target)).toEqual(["엔진"]);
  });
  it("2026-11-08 「기록 지우기」: 순위를 읽지 않는 작업의 옛 순위 행만 판을 맞춰 지우고, 순위를 읽는 작업은 거절한다", async () => {
    const engine = await makeEngine();
    const { clearUnreadAiTaskRanksAction } = await actions();
    const { aiTaskSlotRevision, listAiTaskRows } = await import("@/lib/operations/admin-ai-tasks-repository");
    await client`INSERT INTO ai_task_models (task, slot, rank, connection_id, model, updated_by) VALUES ('held-review-retry', 1, 1, ${engine.id}, 'Qwen-X', 'it'),
      ('held-review-retry', 1, 2, ${engine.id}, 'Qwen-Y', 'it')`;
    const rows = (await listAiTaskRows()).filter(row => row.task === "held-review-retry" && row.slot === 1);
    expect(rows).toHaveLength(2);
    expect((await clearUnreadAiTaskRanksAction(null, form({ task: "held-review-retry", slot: "1", revision: "0".repeat(64) })))?.issues)
      .toEqual(["그 사이 이 줄이 바뀌었습니다. 새로고침한 뒤 다시 저장하세요."]);
    expect(await rankRows()).toHaveLength(2);
    expect(await clearUnreadAiTaskRanksAction(null, form({ task: "held-review-retry", slot: "1", revision: aiTaskSlotRevision(rows) })))
      .toEqual({ ok: true, message: "옛 순위 기록 2개를 지웠습니다." });
    expect(await rankRows()).toEqual([]);
    const [audit] = await audits("ai-task-models-save");
    expect(audit).toMatchObject({ target: "held-review-retry#1", ok: true, detail: { reason: "unread_records_cleared", after: [] } });
    expect((audit.detail.before as unknown[]).length).toBe(2);
    // 순위를 읽는 작업은 이 길로 지우지 않는다(바꾸기 서랍에서 바꾼다)
    expect((await clearUnreadAiTaskRanksAction(null, form({ task: "first-review", slot: "1", revision: EMPTY_REVISION })))?.issues)
      .toEqual(["실행 쪽이 이 작업의 순위를 읽습니다 — 옛 기록이 아니므로 「바꾸기」에서 바꾸세요."]);
  });
  it("2026-11-08 모델 「삭제」: 쓰는 모델은 뺄 수 없고, 뺀 모델은 다시 읽어도 빠진 채 남으며 되돌릴 수 있다", async () => {
    const engine = await makeEngine();
    const { hideAiConnectionModelAction, saveAiConnectionAction } = await actions();
    const { listAiConnections } = await import("@/lib/operations/admin-ai-tasks-repository");
    const view = async () => (await listAiConnections()).find(row => row.id === engine.id)!;
    expect((await view()).models?.map(row => row.id)).toEqual(["Qwen-X", "Qwen-Y"]);
    await client`INSERT INTO ai_task_models (task, slot, rank, connection_id, model, updated_by) VALUES ('product-embedding', 1, 1, ${engine.id}, 'Qwen-Y', 'it')`;
    expect((await hideAiConnectionModelAction(null, form({ id: engine.id, expectedVersion: String(engine.version), hidden: "1", model: "Qwen-Y" })))?.issues)
      .toEqual(["이 모델을 쓰는 순위나 작업 분산 구성원이 있어 목록에서 뺄 수 없습니다. 먼저 작업 배정에서 바꾸세요."]);
    await client`DELETE FROM ai_task_models WHERE task = 'product-embedding' AND connection_id = ${engine.id}`;
    expect((await hideAiConnectionModelAction(null, form({ id: engine.id, expectedVersion: String(engine.version), hidden: "1", model: "없는-모델" })))?.issues)
      .toEqual(["이 연결의 목록에 없는 모델입니다. 새로고침하세요."]);
    expect(await hideAiConnectionModelAction(null, form({ id: engine.id, expectedVersion: String(engine.version), hidden: "1", model: "Qwen-Y" }))).toMatchObject({ ok: true });
    expect(await view()).toMatchObject({ version: engine.version + 1, hiddenModels: ["Qwen-Y"], models: [{ id: "Qwen-X" }] });
    // 저장된 서버 목록은 그대로 — 화면·선택지가 보는 보기에서만 빠진다
    expect((await connections()).find(row => row.id === engine.id)!.models?.map(row => row.id)).toEqual(["Qwen-X", "Qwen-Y"]);
    // 연결을 다시 저장해 서버 목록을 다시 읽어도 빠진 채로 남는다
    expect(await saveAiConnectionAction(null, form({ id: engine.id, expectedVersion: String(engine.version + 1), kind: "api", label: "엔진", baseUrl: ENGINE,
      deviceId: "eng-dev", capacitySlots: "2" }))).toMatchObject({ ok: true });
    expect(await view()).toMatchObject({ hiddenModels: ["Qwen-Y"], models: [{ id: "Qwen-X" }] });
    const version = (await view()).version;
    expect(await hideAiConnectionModelAction(null, form({ id: engine.id, expectedVersion: String(version), hidden: "0", model: "Qwen-Y" }))).toMatchObject({ ok: true });
    expect((await view()).models?.map(row => row.id)).toEqual(["Qwen-X", "Qwen-Y"]);
    expect((await view()).hiddenModels).toEqual([]);
    expect((await audits("ai-connection-model-hide")).map(row => [row.target, row.detail.hidden, row.detail.models])).toEqual([["엔진", true, ["Qwen-Y"]], ["엔진", false, ["Qwen-Y"]]]);
  });
});

describe("실행 쪽 resolver(PR B) — 저장한 순위를 DB 스냅숏으로 읽어 그 연결의 계약에 묶는다", () => {
  it("1순위 엔진 A · Qwen-X, 2순위 엔진 B · Qwen-X: B 는 연결로 가른 장부 이름의 계약·정책 경로를 따로 두고 엔진에는 Qwen-X 를 보낸다", async () => {
    const engine = await makeEngine();
    const { saveAiConnectionAction, saveAiTaskRanksAction } = await actions();
    expect(await saveAiConnectionAction(null, form({ kind: "api", label: "엔진 B", baseUrl: ENGINE2, deviceId: "eng2-dev", capacitySlots: "1" }))).toMatchObject({ ok: true });
    const second = (await connections()).find(row => row.label === "엔진 B")!;
    calls = [];
    const saved = await saveAiTaskRanksAction(null, form({ task: "crawl-tagline", slot: "1", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-X",
      rank2Connection: second.id, rank2Model: "Qwen-X" }));
    expect(saved).toMatchObject({ ok: true });
    const { aiTaskAliasIdentity } = await import("@/lib/llm/ai-tasks");
    const alias = aiTaskAliasIdentity("Qwen-X", second.id)!;
    // 두 서버 모두 엔진 이름 Qwen-X 로 1토큰 시험을 받았다
    expect(calls.filter(call => call.method === "POST").map(call => call.url)).toEqual([`${ENGINE}/chat/completions`, `${ENGINE2}/chat/completions`]);
    const contracts = await client<{ model: string; contract: Record<string, unknown> }[]>`SELECT model, contract FROM model_serving_contracts WHERE enabled ORDER BY id`;
    expect(contracts.map(row => [row.model, row.contract.endpoint, row.contract.engineModel ?? null])).toEqual([
      ["Qwen-X", `${ENGINE}/chat/completions`, null], [alias, `${ENGINE2}/chat/completions`, "Qwen-X"]]);
    expect((await controlRow()).policy.routes).toEqual(expect.arrayContaining([
      { routeId: "crawl-tagline", provider: "abcllm", model: "Qwen-X", providerBudgetId: "eng-dev", groupId: "eng-dev" },
      { routeId: "crawl-tagline", provider: "abcllm", model: alias, providerBudgetId: "eng2-dev", groupId: "eng2-dev" }]));
    // 실행 쪽: DB 스냅숏(순위 JOIN 연결, 키는 메모리에서만 연다) → 계약 스냅숏 → 순위마다 장부 이름·키
    const [{ ensureAiTaskModels }, { ensureServingContracts }, { resolveTextTaskRanks, taskModels }] = await Promise.all([
      import("@/lib/llm/ai-task-models-snapshot"), import("@/lib/llm/serving-contract-store"), import("@/lib/llm/ai-task-resolver")]);
    await Promise.all([ensureAiTaskModels(0), ensureServingContracts(0)]);
    expect(taskModels("crawl-tagline").map(row => [row.rank, row.connection.label, row.model, row.connection.apiKey])).toEqual([[1, "엔진", "Qwen-X", KEY], [2, "엔진 B", "Qwen-X", null]]);
    const resolved = resolveTextTaskRanks("crawl-tagline");
    expect(resolved.status).toBe("ok");
    expect(resolved.candidates.map(candidate => [candidate.unusable, candidate.binding?.identity, candidate.binding?.engineModel, candidate.binding?.bearer,
      candidate.binding?.deviceId])).toEqual([[null, "Qwen-X", "Qwen-X", KEY, "eng-dev"], [null, alias, "Qwen-X", null, "eng2-dev"]]);
    // 다른 작업에는 순위가 없다 — 그 작업은 no_task_models 로 멈춘다
    expect(resolveTextTaskRanks("reason-translate").status).toBe("no_task_models");
  });
});

describe("1차·2차 심사(PR C1) — 순위 저장이 심사 계약·CLI 계약을 만들고, 실행 쪽이 DB 스냅숏으로 묶는다", () => {
  it("2차 투표자 칸마다 엔진 직접 계약(abcllm 형, transport direct)·정책 경로를 만들고, 한 모델은 한 칸에만 — 실행 쪽은 칸마다 1순위, 키는 연결의 키", async () => {
    const { pinReviewRanks } = await import("../review-task-ranks-fixture");
    pinReviewRanks(null); // 통합 시험의 설정 기반 고정을 풀고 진짜 순위 표·계약 스냅숏을 읽는다
    // Qwen-Y 는 /models 가 최대 길이를 알려 주지 않는다 — 연결의 컨텍스트 상한(Qwen-X 의 32768 과 같은 값)으로 계약을 만든다
    const engine = await makeEngine({ contextTokens: "32768" });
    const { saveAiTaskRanksAction } = await actions();
    expect(await saveAiTaskRanksAction(null, form({ task: "second-review", slot: "1", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-X" })))
      .toMatchObject({ ok: true });
    const contracts = await client<{ route_id: string; model: string; transport: string; auth: string; contract: Record<string, unknown> }[]>`
      SELECT route_id, model, transport, auth, contract FROM model_serving_contracts WHERE enabled ORDER BY id`;
    expect(contracts.map(row => [row.route_id, row.model, row.transport, row.auth, row.contract.provider, row.contract.protocol, row.contract.endpoint])).toEqual([
      ["second-review", "Qwen-X", "direct", "stored", "abcllm", "abcllm-raw-total-bound-v1", `${ENGINE}/chat/completions`]]);
    expect((await controlRow()).policy.routes).toEqual(expect.arrayContaining([
      { routeId: "second-review", provider: "abcllm", model: "Qwen-X", providerBudgetId: "eng-dev", groupId: "eng-dev" }]));
    // 같은 모델은 다른 투표자 칸에 둘 수 없다(2·3순위도) — 한 항목에 두 표를 낼 수 있어서
    const clash = await saveAiTaskRanksAction(null, form({ task: "second-review", slot: "2", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-Y",
      rank2Connection: engine.id, rank2Model: "Qwen-X" }));
    expect(clash?.issues).toEqual([expect.stringContaining("2순위: 투표자 1의 1순위와 같은 모델(Qwen-X)입니다")]);
    expect(await saveAiTaskRanksAction(null, form({ task: "second-review", slot: "2", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-Y" })))
      .toMatchObject({ ok: true });
    const [{ ensureAiTaskModels }, { ensureServingContracts, textRouteAccess }, { secondReviewRanks, secondReviewRankSets }] = await Promise.all([
      import("@/lib/llm/ai-task-models-snapshot"), import("@/lib/llm/serving-contract-store"), import("@/lib/crawl/review-task-ranks")]);
    await Promise.all([ensureAiTaskModels(0), ensureServingContracts(0)]);
    const ranks = secondReviewRanks();
    expect(ranks.status).toBe("ok");
    expect(ranks.slots.map(slot => [slot.slot, slot.voter?.provider ?? null, slot.voter?.identity ?? null])).toEqual([
      [1, "abcllm", "Qwen-X"], [2, "abcllm", "Qwen-Y"], [3, null, null]]);
    expect(secondReviewRankSets(ranks)).toEqual({ voters: [{ provider: "abcllm", model: "Qwen-X" }, { provider: "abcllm", model: "Qwen-Y" }], fallbacks: [] });
    // 보내는 키 = 연결에 저장한 키(계약 행의 키가 아니라 연결의 키 — 같은 값으로 만들었지만 판정은 연결에서 온다)
    expect(textRouteAccess("second-review", "Qwen-X")).toEqual({ block: null, bearer: KEY });
  });
  it("CLI 순위: 연결에 CLI 버전이 없으면 막고, 있으면 cli:<provider>:<route> 계약 행을 만든다 — 실행 쪽은 그 행으로 묶고 버전은 워커가 견준다", async () => {
    const { pinReviewRanks } = await import("../review-task-ranks-fixture");
    pinReviewRanks(null);
    const { saveAiConnectionAction, saveAiTaskRanksAction } = await actions();
    expect(await saveAiConnectionAction(null, form({ kind: "cli", label: "Claude CLI", cliTool: "claude", cliModels: "sonnet", deviceId: "anthropic-cli" })))
      .toMatchObject({ ok: true });
    const cli = (await connections()).find(entry => entry.kind === "cli")!;
    const missing = await saveAiTaskRanksAction(null, form({ task: "first-review", slot: "1", revision: EMPTY_REVISION, rank1Connection: cli.id, rank1Model: "sonnet" }));
    expect(missing?.issues).toEqual([expect.stringContaining("1순위 Claude CLI · sonnet: 연결에 CLI 버전이 없습니다.")]);
    expect(await saveAiConnectionAction(null, form({ id: cli.id, expectedVersion: "1", kind: "cli", label: "Claude CLI", cliTool: "claude", cliModels: "sonnet",
      cliVersion: "2.1.263 (Claude Code)", deviceId: "anthropic-cli" }))).toMatchObject({ ok: true });
    const saved = await saveAiTaskRanksAction(null, form({ task: "first-review", slot: "1", revision: EMPTY_REVISION, rank1Connection: cli.id, rank1Model: "sonnet" }));
    expect(saved).toMatchObject({ ok: true });
    const rows = await client<{ route_id: string; model: string; transport: string; auth: string; contract: Record<string, unknown> }[]>`
      SELECT route_id, model, transport, auth, contract FROM model_serving_contracts WHERE enabled ORDER BY id`;
    expect(rows.map(row => [row.route_id, row.model, row.transport, row.auth, row.contract.routeId, row.contract.provider, row.contract.cliVersion,
      row.contract.boundProvenance])).toEqual([["cli:claude-cli:crawl-agent-review", "sonnet", "direct", "none", "cli:claude-cli:crawl-agent-review", "claude-cli",
      "2.1.263 (Claude Code)", "derived"]]);
    expect((await controlRow()).policy.routes).toEqual(expect.arrayContaining([expect.objectContaining({ routeId: "crawl-agent-review", provider: "claude-cli",
      model: "sonnet", groupId: "anthropic-cli" })]));
    const [{ ensureAiTaskModels }, { ensureServingContracts }, { cliContractFromRow, cliServingContractStatus }, { firstReviewRanks }] = await Promise.all([
      import("@/lib/llm/ai-task-models-snapshot"), import("@/lib/llm/serving-contract-store"), import("@/lib/llm/cli-serving-contract"),
      import("@/lib/crawl/review-task-ranks")]);
    await Promise.all([ensureAiTaskModels(0), ensureServingContracts(0)]);
    expect(cliContractFromRow({ routeId: rows[0].route_id, model: rows[0].model, contract: rows[0].contract })).toMatchObject({ routeId: "crawl-agent-review",
      provider: "claude-cli", model: "sonnet" });
    // 이 시험 프로세스는 CLI 버전 확인을 띄우지 않았다(워커만 띄운다) — 확인 전이라 쓸 수 있는 것으로 둔다
    expect(cliServingContractStatus("crawl-agent-review", "claude-cli", "sonnet")).toBe("probe_pending");
    const first = firstReviewRanks();
    expect(first.pool).toEqual([{ provider: "claude-cli", model: "sonnet" }]);
    expect(first.unusable.size).toBe(0);
    // 같은 버전으로 다시 저장하면 계약 행을 바꾸지 않는다
    const { aiTaskSlotRevision, listAiTaskRows } = await import("@/lib/operations/admin-ai-tasks-repository");
    const revision = aiTaskSlotRevision((await listAiTaskRows()).filter(row => row.task === "first-review"));
    expect(await saveAiTaskRanksAction(null, form({ task: "first-review", slot: "1", revision, rank1Connection: cli.id, rank1Model: "sonnet" }))).toMatchObject({ ok: true });
    expect((await client`SELECT count(*)::int AS n FROM model_serving_contracts WHERE route_id = 'cli:claude-cli:crawl-agent-review'`)[0].n).toBe(1);
  });
});

describe("지금 실제로 쓰는 모델(오늘의 고르기 코드 그대로)", () => {
  it("모든 작업 × 칸을 내고, 주소는 계약·등록부·env 에서만 온다(계약 없는 text 경로는 주소 모름)", async () => {
    vi.stubEnv("CONNECT_AGENT_URL", "http://down.test:1");
    vi.stubEnv("EMBEDDING_URL", "http://emb.test:18081");
    vi.stubEnv("RERANK_URL", "");
    const { buildAiCurrentSlots, readAiCurrentSources } = await import("@/lib/operations/admin-ai-task-current");
    const slots = buildAiCurrentSlots(await readAiCurrentSources(null));
    expect(slots.map(slot => `${slot.task}#${slot.slot}`)).toEqual((await import("@/lib/llm/ai-tasks")).aiTaskSlots().map(({ task, slot }) => `${task.id}#${slot}`));
    expect(slots.filter(slot => slot.error === "task_unmapped" || slot.error === "stage_unmapped")).toEqual([]);
    const by = (task: string, slot = 1) => slots.find(entry => entry.task === task && entry.slot === slot)!;
    // 2차 가져오기 출처는 옛 설정이다(PR C1) — 기본 투표자는 없다(예전의 등록부 기본 Claude CLI 투표자를 없앴다)
    expect(by("second-review")).toMatchObject({ uses: [], skip: "투표자 1이(가) 없습니다." });
    expect(by("second-review", 2).skip).toBe("투표자 2이(가) 없습니다.");
    expect(by("product-intro-check").uses.map(use => [use.kind, use.cliTool])).toEqual([["cli", "claude"]]);
    // PR B: text 경로는 실행 쪽이 작업 ↔ 모델 순위를 읽는다 — 순위가 없으면 지금 쓰는 모델도 없다(기본값으로 대신 부르지 않는다)
    expect(by("crawl-tagline")).toMatchObject({ uses: [], skip: expect.stringContaining("no_task_models") });
    // 직접 모델 단계는 그 단계가 실제로 부르는 등록부 주소
    expect(by("audit-review").uses.every(use => use.kind === "api" && use.provider === "local-direct" && use.baseUrl?.endsWith("/v1"))).toBe(true);
    expect(by("product-embedding").uses).toEqual([expect.objectContaining({ baseUrl: "http://emb.test:18081/v1", serverNamed: true })]);
    expect(by("search-rerank").skip).toContain("RERANK_URL");
    expect(by("publish-classify").error).toBe("connect 에이전트 설정을 읽지 못했습니다");
    expect(by("product-audit").skip).toContain("실행 중인 감사가 없습니다");
  }, 60_000);
});

describe("지금 설정 → 작업 ↔ 모델 가져오기", () => {
  it("계획(쓰지 않음, 새 엔진만 /models) → 같은 hash 로 적용: 연결·키(env)·목록·순위 한 TX; 다시 적용하면 계획이 바뀌었다고 거절", async () => {
    vi.stubEnv("TEST_ENGINE_KEY", "sk-from-env");
    current = [
      { task: "first-review", slot: 1, source: "설정", error: null, skip: null, notes: [], uses: [
        { kind: "api", baseUrl: ENGINE, cliTool: null, model: "Qwen-X", provider: "abcllm", origin: "firstReview", deviceId: "eng-dev", keyFrom: null, keyEnv: "TEST_ENGINE_KEY" },
        { kind: "cli", baseUrl: null, cliTool: "claude", model: "sonnet", provider: "claude-cli", origin: "firstReviewAdditional[0]", deviceId: "anthropic-cli", keyFrom: null }] },
      { task: "product-embedding", slot: 1, source: "env", error: null, skip: null, notes: [], uses: [
        { kind: "api", baseUrl: EMB, cliTool: null, model: "bge-m3-f16@daec91ff", provider: "llama-server", origin: "env EMBEDDING_URL", deviceId: null, keyFrom: null, serverNamed: true }] },
      { task: "screen-review", slot: 1, source: "env", error: null, skip: "지금 꺼져 있습니다.", notes: [], uses: [] },
    ];
    const preview = await previewAiTaskImport();
    expect(preview.error).toBeNull();
    expect(preview.plan!.connections.map(row => [row.action, row.label, row.deviceId, row.keyEnv])).toEqual([["create", "eng-dev", "eng-dev", "TEST_ENGINE_KEY"],
      ["create", "Claude CLI", "anthropic-cli", null]]);
    expect(preview.plan!.slots.map(row => [row.task, row.action, row.ranks.map(rank => rank.model)])).toEqual([["first-review", "create", ["Qwen-X", "sonnet"]]]);
    expect(calls.map(call => `${call.url} ${call.auth}`).sort()).toEqual([`${ENGINE}/models Bearer sk-from-env`]);
    expect(await connections()).toEqual([]);
    const { applyAiTaskImportAction } = await actions();
    expect((await applyAiTaskImportAction(null, form({ planHash: preview.hash!, confirm: "아니오" })))?.issues).toEqual(["확인 칸에 「가져오기」를 적어야 적용합니다."]);
    const applied = await applyAiTaskImportAction(null, form({ planHash: preview.hash!, confirm: "가져오기" }));
    expect(applied).toMatchObject({ ok: true, message: expect.stringContaining("연결 2개 · 순위를 채운 칸 1개") });
    const rows = await connections();
    const engine = rows.find(row => row.base_url === ENGINE)!;
    expect(openSecret(engine.api_key_ciphertext!, aiConnectionKeyAad(engine.id))).toBe("sk-from-env");
    expect(engine.models?.map(model => model.id)).toEqual(["Qwen-X", "Qwen-Y"]);
    expect((await rankRows()).map(row => [row.task, row.rank, row.model])).toEqual([["first-review", 1, "Qwen-X"], ["first-review", 2, "sonnet"]]);
    const [audit] = await audits("ai-task-models-import");
    expect(audit.detail).toMatchObject({ hash: preview.hash, skipped: 0 });
    expect(JSON.stringify(audit.detail)).not.toContain("sk-from-env");
    expect((await applyAiTaskImportAction(null, form({ planHash: preview.hash!, confirm: "가져오기" })))?.issues)
      .toEqual(["계획을 보여 준 뒤 설정이 바뀌었습니다. 계획을 다시 보고 적용하세요."]);
    const again = await previewAiTaskImport();
    expect(again.plan!.slots.map(row => row.action)).toEqual(["unchanged"]);
    expect(again.plan!.connections.map(row => row.action)).toEqual(["existing", "existing"]);
  });
});

describe("2026-11-11 LLM 보강(assist-review·assist-audit) — 순위 저장이 로컬 계약·보강 일마다의 장부 route 를 만들고, 실행 쪽이 순위로 고른다", () => {
  // 보강 판정 계열은 등록부 assist-primary 의 family(기본 qwen3.8-flash-next) — 그 모델을 내놓는 엔진을 하나 더 둔다
  const QWEN = "http://qwen.test:8000/v1";
  const qwenFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input), method = init?.method ?? "GET";
    if (target === `${QWEN}/models`) { calls.push({ url: target, method, auth: null }); return Response.json({ data: [{ id: "qwen3.8-flash-next", max_model_len: 65536 }] }); }
    if (target === `${QWEN}/chat/completions` && method === "POST") {
      calls.push({ url: target, method, auth: null });
      return Response.json({ object: "chat.completion", model: "qwen3.8-flash-next", choices: [{ message: { content: "OK" } }] });
    }
    return fakeFetch(input, init);
  }) as typeof fetch;
  it("보강 순위: readback + 1토큰 시험 뒤 로컬 계약 하나와 local-assist-<일>-<backend> 네 route·장비 행을 한 TX 에 — 다시 저장하면 만들지 않고, 실행 쪽은 그 순위로 줄을 고른다", async () => {
    setAiTaskDepsForTest({ request: qwenFetch, now: () => clock, current: async () => current });
    const { saveAiConnectionAction, saveAiTaskRanksAction } = await actions();
    expect(await saveAiConnectionAction(null, form({ kind: "api", label: "gpu", baseUrl: QWEN, deviceId: "gpu-dev", capacitySlots: "4" }))).toMatchObject({ ok: true });
    const gpu = (await connections()).find(row => row.label === "gpu")!;
    const before = await controlRow();
    calls = [];
    const saved = await saveAiTaskRanksAction(null, form({ task: "assist-review", slot: "1", revision: EMPTY_REVISION, rank1Connection: gpu.id, rank1Model: "qwen3.8-flash-next" }));
    expect(saved).toMatchObject({ ok: true, message: expect.stringContaining("워커는 30초 주기로") });
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([`GET ${QWEN}/models`, `POST ${QWEN}/chat/completions`]);
    const { auditDirectBackendId } = await import("@/lib/operations/admin-ai-tasks-repository");
    const backend = auditDirectBackendId(gpu.id, "qwen3.8-flash-next");
    const contracts = await client<{ route_id: string; model: string; auth: string; contract: Record<string, unknown> }[]>`
      SELECT route_id, model, auth, contract FROM model_serving_contracts WHERE enabled ORDER BY id`;
    expect(contracts.map(row => [row.route_id, row.model, row.auth])).toEqual([[`local-model:${backend}`, "qwen3.8-flash-next", "none"]]);
    expect(contracts[0].contract).toMatchObject({ protocol: "local-openai-chat-v1", backendId: backend, physicalGroup: "gpu-dev", modelFamily: "qwen3.8-flash-next",
      capabilities: { jsonSchema: true } });
    const after = await controlRow();
    expect(after.revision).toBe(before.revision + 1);
    for (const work of ["uptime", "repo_move", "intro_recheck", "news"])
      expect(after.policy.routes).toContainEqual({ routeId: `local-assist-${work}-${backend}`, provider: "local-direct", model: "qwen3.8-flash-next",
        providerBudgetId: backend, groupId: "gpu-dev" });
    expect(after.policy.routes.some(route => route.routeId.startsWith("local-assist-decision_audit-"))).toBe(false);
    expect(await client`SELECT device_id FROM model_capacity_devices ORDER BY device_id`).toEqual([{ device_id: "gpu-dev" }]);
    const [audit] = await audits("ai-task-models-save");
    expect(audit).toMatchObject({ target: "assist-review#1", detail: { created: { routes: expect.arrayContaining([expect.stringContaining(`local-assist-news-${backend}`)]) } } });
    // 화면: 이제 순위를 읽는 줄(대체 실행) — 만들 것은 남지 않았다(물리 상한 알림만)
    const view = await (await import("@/lib/operations/admin-ai-tasks-repository")).readAiTasksAdminView();
    const line = view.slots.find(slot => slot.task.id === "assist-review")!;
    expect(line).toMatchObject({ live: true });
    expect(line.readiness[0]).toMatchObject({ blocking: [], appendRoute: null, createDevice: null, provider: "local-direct" });
    expect(line.readiness[0].warnings).toEqual([expect.stringContaining("장비 gpu-dev에 물리 상한이 없습니다")]);
    expect(view.slots.find(slot => slot.task.id === "assist-audit")).toMatchObject({ live: false });
    calls = [];
    expect(await saveAiTaskRanksAction(null, form({ task: "assist-review", slot: "1", revision: line.revision, rank1Connection: gpu.id, rank1Model: "qwen3.8-flash-next" })))
      .toMatchObject({ ok: true });
    expect(calls).toEqual([]);
    expect((await controlRow()).revision).toBe(after.revision);
    // 실행 쪽: DB 스냅숏의 순위 → 표의 로컬 계약 → 정책 route(장비 물리 상한은 env 로 준다) → 줄 하나, 키 없음(연결에 키를 두지 않았다)
    const [{ ensureAiTaskModels }, { ensureServingContracts }, { assistLanePlan }] = await Promise.all([
      import("@/lib/llm/ai-task-models-snapshot"), import("@/lib/llm/serving-contract-store"), import("@/lib/domain/llm-assist/rank-backends")]);
    await Promise.all([ensureAiTaskModels(0), ensureServingContracts(0)]);
    const plan = await assistLanePlan("regular", { LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ "gpu-dev": 2 }) });
    expect(plan).toMatchObject({ source: "ranks", degraded: null, drains: [{ backendId: backend, tasks: ["uptime", "repo_move", "intro_recheck", "news"], maxClaims: 1,
      apiKey: null, rank: { rank: 1, connectionId: gpu.id, model: "qwen3.8-flash-next" } }] });
    // 물리 상한이 없으면 경로가 열리지 않는다 — 다른 길로 부르지 않고 까닭을 남긴다
    expect(await assistLanePlan("regular", {})).toMatchObject({ source: "ranks", drains: [], degraded: { code: "all_ranks_unusable" } });
    // 독립 감사 줄은 순위가 없어 옛 env 길(여기서는 비어 있음)
    expect(await assistLanePlan("audit", {})).toEqual({ source: "env", drains: [] });
  });
  it("판정 계열이 아닌 모델은 저장하지 않는다 — 아무것도 쓰지 않는다", async () => {
    const engine = await makeEngine();
    const { saveAiTaskRanksAction } = await actions();
    const snapshot = await tableState();
    const refused = await saveAiTaskRanksAction(null, form({ task: "assist-review", slot: "1", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-X" }));
    expect(refused?.issues).toEqual([expect.stringContaining("모델 계열 Qwen-X은(는) 보강 판정 계열(qwen3.8-flash-next)이 아닙니다")]);
    expect({ ...await tableState(), audits: snapshot.audits }).toEqual(snapshot);
  });
  it("없앤 작업(korean-translation-direct)의 남은 순위 행은 화면을 깨뜨리지 않고, 판을 맞춰 지울 수 있다", async () => {
    const engine = await makeEngine();
    await client`INSERT INTO ai_task_models (task, slot, rank, connection_id, model, updated_by) VALUES ('korean-translation-direct', 1, 1, ${engine.id}, 'Qwen-X', 'it')`;
    const { readAiTasksAdminView, aiTaskSlotRevision, listAiTaskRows, aiTaskTargetLabel } = await import("@/lib/operations/admin-ai-tasks-repository");
    const view = await readAiTasksAdminView();
    expect(view.rows.map(row => row.task)).toContain("korean-translation-direct");
    expect(view.slots.some(slot => slot.task.id === "korean-translation-direct")).toBe(false);
    expect(aiTaskTargetLabel("korean-translation-direct#1")).toBe("한국어 소개 번역 · 직접 경로(없앤 작업)");
    const { clearUnreadAiTaskRanksAction, saveAiTaskRanksAction } = await actions();
    // 없앤 작업에는 순위를 저장하지 않는다
    expect((await saveAiTaskRanksAction(null, form({ task: "korean-translation-direct", slot: "1", revision: EMPTY_REVISION, rank1Connection: engine.id, rank1Model: "Qwen-X" })))?.issues)
      .toEqual(["입력을 확인하세요: 작업."]);
    const rows = (await listAiTaskRows()).filter(row => row.task === "korean-translation-direct");
    expect(await clearUnreadAiTaskRanksAction(null, form({ task: "korean-translation-direct", slot: "1", revision: aiTaskSlotRevision(rows) })))
      .toEqual({ ok: true, message: "옛 순위 기록 1개를 지웠습니다." });
    expect(await rankRows()).toEqual([]);
    const [audit] = await audits("ai-task-models-save");
    expect(audit).toMatchObject({ target: "korean-translation-direct#1", detail: { reason: "unread_records_cleared", after: [] } });
  });
});

describe("2026-11-11 LLM 보강 제어(llm_assist_controls) — 관리자 저장", () => {
  const control = async (task: string) => (await client<{ mode: string; confirmation_required: boolean; dispatch_enabled: boolean; apply_enabled: boolean; revision: number }[]>`
    SELECT mode, confirmation_required, dispatch_enabled, apply_enabled, revision::int FROM llm_assist_controls WHERE task = ${task}`)[0];
  const assistAction = () => import("@/app/(operator)/admin/models/tasks/assist-actions");
  afterEach(async () => {
    // 확인 필수는 한 번 켜지면 끌 수 없다(트리거) — 이 DB 는 이 파일만 쓴다. 다른 칸만 되돌린다
    await client`UPDATE llm_assist_controls SET mode = CASE WHEN confirmation_required THEN 'shadow' ELSE 'off' END, dispatch_enabled = false, apply_enabled = false`;
  });
  it("단계·보내기·반영을 판 compare-and-set 으로 바꾸고 감사 한 줄을 남긴다 — DB 규칙과 같은 거절은 아무것도 쓰지 않는다", async () => {
    const { saveAssistControlAction } = await assistAction();
    const start = await control("news");
    expect(start).toMatchObject({ mode: "off", dispatch_enabled: false, apply_enabled: false, confirmation_required: false });
    // 끔에서 보내기·반영은 받지 않는다
    expect((await saveAssistControlAction(null, form({ task: "news", revision: String(start.revision), mode: "off", dispatch: "on" })))?.issues)
      .toEqual(["보내기는 그림자·확인 후 반영 단계에서만 켤 수 있습니다."]);
    expect((await saveAssistControlAction(null, form({ task: "news", revision: String(start.revision), mode: "shadow", dispatch: "on", apply: "on" })))?.issues)
      .toEqual(["반영은 「확인 후 반영」 단계에서 보내기가 켜져 있을 때만 켤 수 있습니다."]);
    expect(await control("news")).toEqual(start);
    const shadow = await saveAssistControlAction(null, form({ task: "news", revision: String(start.revision), mode: "shadow", dispatch: "on" }));
    expect(shadow).toMatchObject({ ok: true, message: expect.stringContaining("소식: 그림자(묻고 기록만) · 보내기 켜짐 · 반영 꺼짐") });
    expect(await control("news")).toEqual({ mode: "shadow", dispatch_enabled: true, apply_enabled: false, confirmation_required: false, revision: start.revision + 1 });
    const [audit] = await audits("llm-assist-control");
    expect(audit).toMatchObject({ target: "news", ok: true, detail: { task: "news", aiTask: "assist-review",
      before: { mode: "off", dispatchEnabled: false, revision: start.revision }, after: { mode: "shadow", dispatchEnabled: true, revision: start.revision + 1 } } });
    // 옛 판·바뀐 것 없음은 거절
    expect((await saveAssistControlAction(null, form({ task: "news", revision: String(start.revision), mode: "off" })))?.issues)
      .toEqual(["다른 곳에서 이 보강 제어가 바뀌었습니다. 새로고침한 뒤 다시 저장하세요."]);
    expect((await saveAssistControlAction(null, form({ task: "news", revision: String(start.revision + 1), mode: "shadow", dispatch: "on" })))?.issues)
      .toEqual(["바뀐 것이 없습니다."]);
    // 보내기 판정은 claimAssistWork 와 같다
    const { assistLaneDispatching } = await import("@/lib/domain/llm-assist/repository");
    expect(await assistLaneDispatching(["uptime", "news"])).toBe(true);
    expect(await assistLaneDispatching(["decision_audit", "semantic_exception"])).toBe(false);
    expect(await assistLaneDispatching([])).toBe(false);
  });
  it("「확인 후 반영」은 확인 필수를 켜고, 그 뒤로 확인 필수는 그대로다(끌 수 없는 DB 규칙) — 반영은 그 단계 + 보내기에서만", async () => {
    const { saveAssistControlAction } = await assistAction();
    const start = await control("repo_move");
    const confirm = await saveAssistControlAction(null, form({ task: "repo_move", revision: String(start.revision), mode: "confirm", dispatch: "on", apply: "on" }));
    expect(confirm).toMatchObject({ ok: true, message: expect.stringContaining("확인 필수") });
    expect(await control("repo_move")).toMatchObject({ mode: "confirm", confirmation_required: true, dispatch_enabled: true, apply_enabled: true });
    const back = await saveAssistControlAction(null, form({ task: "repo_move", revision: String(start.revision + 1), mode: "shadow" }));
    expect(back).toMatchObject({ ok: true });
    expect(await control("repo_move")).toMatchObject({ mode: "shadow", confirmation_required: true, dispatch_enabled: false, apply_enabled: false });
    const { readAssistControls, assistTasksOff } = await import("@/lib/operations/llm-assist-controls");
    const read = await readAssistControls();
    expect(read.error).toBeNull();
    expect(read.controls.map(row => row.task)).toEqual(["uptime", "repo_move", "intro_recheck", "decision_audit", "semantic_exception", "news"]);
    expect(read.controls.find(row => row.task === "repo_move")).toMatchObject({ label: "저장소 이동", aiTask: "assist-review", confirmationRequired: true, queue: {} });
    expect(assistTasksOff(read.controls)).toEqual({ "assist-review": true, "assist-audit": true });
  });
  it("관리자가 아니면 아무것도 쓰지 않는다", async () => {
    const { saveAssistControlAction } = await assistAction();
    const start = await control("uptime");
    admin.login = null;
    expect((await saveAssistControlAction(null, form({ task: "uptime", revision: String(start.revision), mode: "shadow" })))?.issues)
      .toEqual(["관리자 확인이 필요합니다. 다시 로그인하세요."]);
    expect(await control("uptime")).toEqual(start);
  });
});
