import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { setServingContractSnapshotForTest, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { aiConnectionKeyAad, aiUnreadConnections, AI_KEY_CONFLICT_TEXT, type AiCurrentSlot } from "@/lib/operations/admin-ai-tasks";
import { applyAiTaskImport, previewAiTaskImport, readAiTasksAdminView, setAiTaskDepsForTest } from "@/lib/operations/admin-ai-tasks-repository";
import { AI_CONNECTION_KEY_FILL_ACTOR, fillConnectionKeysFromContracts, maybeFillConnectionKeys, resetConnectionKeyFillGateForTest,
  setConnectionKeyFillDepsForTest } from "@/lib/operations/ai-connection-key-fill";
import { openSecret, sealSecret } from "@/lib/security/secret-box";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 키 없는 연결(2026-11-02 사고) — ① 같은 주소 계약 키로 연결 키 채우기(조건부 갱신·감사·목록 다시 읽기·동시 실행·순위 스냅숏 경로)와
 * ③ 키를 옮길 수 없는 가져오기 거절을 진짜 DB(자기 DB, 끝까지 migrate)로 본다. 계약 키는 계약 스냅숏 고정(평문은 메모리 안)으로 준다. 키는 모두 가짜다.
 */
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => ({ login: "operator" }), localOperatorName: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const name = `nomorevibe_test_key_fill_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const pgAdmin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 6, prepare: false, onnotice: () => {} });
let created = false;
const M3 = "http://m3.test:8100/v1", GPU = "http://gpu.test:8090/v1", OTHER = "http://other.test:8000/v1";
const FAKE_KEY = "test-fake-contract-key-1", OTHER_FAKE_KEY = "test-fake-contract-key-2";
let calls: { url: string; auth: string | null }[] = [];
let current: AiCurrentSlot[] = [];
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const target = String(input), auth = new Headers(init?.headers).get("authorization");
  calls.push({ url: target, auth });
  if (target === `${M3}/models`) return auth === `Bearer ${FAKE_KEY}` ? Response.json({ data: [{ id: "m3-model", max_model_len: 65536 }, { id: "m3-other" }] })
    : new Response("unauthorized", { status: 401 });
  if (target === `${GPU}/models`) return Response.json({ data: [{ id: "qwen3.8-flash-next" }] });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

/** 계약 스냅숏 한 줄(auth·키·endpoint 만 본다). */
const contract = (routeId: string, model: string, base: string, auth: StoredServingContract["auth"], apiKey: string | null): StoredServingContract =>
  ({ routeId, model, auth, apiKey, transport: "direct", contract: { routeId, model, provider: "abcllm", endpoint: `${base}/chat/completions` } });
async function insertConnection(label: string, baseUrl: string | null, options: Partial<{ key: string; enabled: boolean; kind: "api" | "cli" }> = {}) {
  const id = randomUUID(), kind = options.kind ?? "api";
  await client`INSERT INTO ai_connections (id, label, kind, base_url, api_key_ciphertext, cli_tool, cli_models, models_error, device_id, enabled, updated_by)
    VALUES (${id}, ${label}, ${kind}, ${kind === "api" ? baseUrl : null}, ${options.key ? sealSecret(options.key, aiConnectionKeyAad(id)) : null},
      ${kind === "cli" ? "claude" : null}, ${kind === "cli" ? ["sonnet"] : []}, ${kind === "api" ? "http_401" : null}, ${label}, ${options.enabled ?? true}, 'test')`;
  return id;
}
const row = async (id: string) => (await client<{ api_key_ciphertext: string | null; version: number; models: { id: string }[] | null; models_error: string | null;
  updated_by: string }[]>`SELECT api_key_ciphertext, version::int, models, models_error, updated_by FROM ai_connections WHERE id = ${id}`)[0];
let auditFloor = 0;
const audits = (action: string) => client<{ actor: string; actor_kind: string; target: string; ok: boolean; detail: Record<string, unknown> }[]>`
  SELECT actor, actor_kind, target, ok, detail FROM operations_audit WHERE id > ${auditFloor} AND action = ${action} ORDER BY id`;

beforeAll(async () => {
  await pgAdmin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(path.resolve("."), "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
}, 180_000);
afterAll(async () => {
  setAiTaskDepsForTest(null); setConnectionKeyFillDepsForTest(null); setServingContractSnapshotForTest(null);
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 });
  if (created) await pgAdmin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await pgAdmin.end({ timeout: 3 });
});
beforeEach(async () => {
  vi.stubEnv("NMV_SECRET_BOX_KEY", randomBytes(32).toString("base64"));
  await client`DELETE FROM ai_task_models`; await client`DELETE FROM ai_connections`;
  await client`UPDATE dr_writer_fence SET state = 'active', reason = NULL, fenced_db = NULL WHERE id = 1`;
  calls = []; current = [];
  setConnectionKeyFillDepsForTest({ request: fakeFetch });
  setAiTaskDepsForTest({ request: fakeFetch, current: async () => current });
  resetConnectionKeyFillGateForTest();
  auditFloor = Number((await client`SELECT coalesce(max(id), 0) AS id FROM operations_audit`)[0].id);
});
afterEach(async () => {
  const { setAiTaskModelsForTest } = await import("@/lib/llm/ai-task-models-snapshot");
  setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null); vi.unstubAllEnvs();
});

describe("① 같은 주소 계약 키로 연결 키 채우기", () => {
  it("같은 주소 계약 키가 모두 같으면 연결 AAD 로 다시 잠가 한 번 채우고(판 + 1) 그 키로 목록을 다시 읽는다 — 감사에는 id·이름·주소·출처만", async () => {
    setServingContractSnapshotForTest([contract("reason-translate", "m3-model", M3, "stored", FAKE_KEY), contract("crawl-agent-review", "m3-review", M3, "stored", FAKE_KEY),
      contract("crawl-tagline", "qwen", GPU, "none", null)]);
    const m3 = await insertConnection("m3-mlx", M3), gpu = await insertConnection("gpu3090", GPU);
    const result = await fillConnectionKeysFromContracts();
    expect(result).toEqual({ skipped: null, conflicts: [], filled: [{ id: m3, label: "m3-mlx", sources: 2, models: 2, modelsError: null }] });
    const filled = await row(m3);
    expect(openSecret(filled.api_key_ciphertext!, aiConnectionKeyAad(m3))).toBe(FAKE_KEY);
    expect(openSecret(filled.api_key_ciphertext!, aiConnectionKeyAad(gpu))).toBeNull();
    expect(filled).toMatchObject({ version: 2, models_error: null, models: [{ id: "m3-model" }, { id: "m3-other" }], updated_by: AI_CONNECTION_KEY_FILL_ACTOR });
    expect(calls).toEqual([{ url: `${M3}/models`, auth: `Bearer ${FAKE_KEY}` }]);
    // 출처가 없는 서버(키 없이 도는 gpu3090 — auth none 계약뿐)는 건드리지 않는다
    expect(await row(gpu)).toMatchObject({ api_key_ciphertext: null, version: 1 });
    const [audit, ...more] = await audits("ai-connection-key-fill");
    expect(more).toEqual([]);
    expect(audit).toMatchObject({ actor: AI_CONNECTION_KEY_FILL_ACTOR, actor_kind: "token", target: "m3-mlx", ok: true });
    expect(audit.detail).toEqual({ id: m3, label: "m3-mlx", baseUrl: M3,
      sources: [{ routeId: "reason-translate", model: "m3-model" }, { routeId: "crawl-agent-review", model: "m3-review" }] });
    expect(JSON.stringify(audit)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(audit)).not.toContain(filled.api_key_ciphertext!);
    // 다시 돌면 할 일이 없다(이미 키가 있다)
    expect((await fillConnectionKeysFromContracts()).filled).toEqual([]);
    expect((await row(m3)).version).toBe(2);
  });

  it("값이 서로 다르면 채우지 않고 화면 알림 까닭에 「같은 주소의 계약 키가 서로 다름」", async () => {
    setServingContractSnapshotForTest([contract("reason-translate", "m3-model", M3, "stored", FAKE_KEY), contract("product-tagline-ko", "m3-model", M3, "stored", OTHER_FAKE_KEY)]);
    const m3 = await insertConnection("m3-mlx", M3);
    expect(await fillConnectionKeysFromContracts()).toEqual({ skipped: null, filled: [], conflicts: [{ id: m3, label: "m3-mlx", sources: 2 }] });
    expect(await row(m3)).toMatchObject({ api_key_ciphertext: null, version: 1 });
    expect(calls).toEqual([]);
    expect(await audits("ai-connection-key-fill")).toEqual([]);
    const view = await readAiTasksAdminView();
    expect(view.keyConflicts).toEqual([m3]);
    expect(aiUnreadConnections(view.connections, view.keyConflicts)).toEqual([{ id: m3, label: "m3-mlx", reason: `키 없음 · ${AI_KEY_CONFLICT_TEXT} · 거절됨(HTTP 401 — 키 확인)` }]);
  });

  it("출처 없음(다른 주소·auth none·열리지 않는 계약 키)·상자 키 없음·이미 키 있음·꺼진 연결은 아무것도 쓰지 않는다", async () => {
    setServingContractSnapshotForTest([contract("reason-translate", "m3-model", OTHER, "stored", FAKE_KEY), contract("crawl-tagline", "m3-model", M3, "none", null),
      contract("product-translate", "m3-model", M3, "stored", null)]);
    const m3 = await insertConnection("m3-mlx", M3);
    expect(await fillConnectionKeysFromContracts()).toEqual({ skipped: null, filled: [], conflicts: [] });
    expect(await row(m3)).toMatchObject({ api_key_ciphertext: null, version: 1 });

    setServingContractSnapshotForTest([contract("reason-translate", "m3-model", M3, "stored", FAKE_KEY)]);
    const keyed = await insertConnection("m3-keyed", OTHER, { key: OTHER_FAKE_KEY });
    setServingContractSnapshotForTest([contract("reason-translate", "m3-model", M3, "stored", FAKE_KEY), contract("crawl-tagline", "x", OTHER, "stored", FAKE_KEY)]);
    await client`UPDATE ai_connections SET enabled = false WHERE id = ${m3}`;
    const before = await row(keyed);
    expect(await fillConnectionKeysFromContracts()).toEqual({ skipped: null, filled: [], conflicts: [] });
    expect(await row(keyed)).toEqual(before);
    expect(await row(m3)).toMatchObject({ api_key_ciphertext: null, version: 1 });

    await client`UPDATE ai_connections SET enabled = true WHERE id = ${m3}`;
    vi.stubEnv("NMV_SECRET_BOX_KEY", "");
    expect(await fillConnectionKeysFromContracts()).toEqual({ skipped: "secret_box_key_missing", filled: [], conflicts: [] });
    expect(await maybeFillConnectionKeys()).toBeNull();
    expect(await row(m3)).toMatchObject({ api_key_ciphertext: null, version: 1 });
    expect(calls).toEqual([]);
    expect(await audits("ai-connection-key-fill")).toEqual([]);
  });

  it("여러 프로세스가 동시에 돌아도 한 번만 써진다(조건부 갱신) — 감사 한 줄, 판 + 1 한 번", async () => {
    setServingContractSnapshotForTest([contract("reason-translate", "m3-model", M3, "stored", FAKE_KEY)]);
    const m3 = await insertConnection("m3-mlx", M3);
    const results = await Promise.all([1, 2, 3, 4].map(() => fillConnectionKeysFromContracts()));
    expect(results.flatMap(result => result.filled).map(entry => entry.id)).toEqual([m3]);
    expect((await row(m3)).version).toBe(2);
    expect(await audits("ai-connection-key-fill")).toHaveLength(1);
  });

  it("쓰기 울타리가 닫힌 사이트에서는 쓰지 않는다(maybe 는 던지지 않고 null)", async () => {
    setServingContractSnapshotForTest([contract("reason-translate", "m3-model", M3, "stored", FAKE_KEY)]);
    const m3 = await insertConnection("m3-mlx", M3);
    await client`UPDATE dr_writer_fence SET state = 'fenced', reason = 'operator_fence', fenced_db = '{"db":"test"}'::jsonb WHERE id = 1`;
    await expect(fillConnectionKeysFromContracts()).rejects.toThrow();
    expect(await maybeFillConnectionKeys()).toBeNull();
    expect(await row(m3)).toMatchObject({ api_key_ciphertext: null, version: 1 });
  });

  it("프로세스마다 5분에 한 번 이하 — 순위 스냅숏을 다시 읽은 프로세스(워커)가 사람 없이 채우고 바로 다시 읽어 키를 쓴다", async () => {
    setServingContractSnapshotForTest([contract("reason-translate", "m3-model", M3, "stored", FAKE_KEY)]);
    const m3 = await insertConnection("m3-mlx", M3);
    await client`INSERT INTO ai_task_models (task, slot, rank, connection_id, model, updated_by) VALUES ('reason-translate', 1, 1, ${m3}, 'm3-model', 'test')`;
    vi.stubEnv("DATABASE_URL", url.toString());
    const { ensureAiTaskModels, taskModels } = await Promise.all([import("@/lib/llm/ai-task-models-snapshot"), import("@/lib/llm/ai-task-resolver")])
      .then(([snapshot, resolver]) => ({ ensureAiTaskModels: snapshot.ensureAiTaskModels, taskModels: resolver.taskModels }));
    await ensureAiTaskModels(0);
    expect(taskModels("reason-translate")[0].connection.apiKey).toBeNull();
    await vi.waitFor(async () => expect((await row(m3)).api_key_ciphertext).not.toBeNull(), { timeout: 10_000, interval: 50 });
    // 채웠으면 다음 읽기에서 바로 다시 읽는다 — 그 연결의 키를 연다
    await vi.waitFor(async () => { await ensureAiTaskModels(); expect(taskModels("reason-translate")[0].connection.apiKey).toBe(FAKE_KEY); },
      { timeout: 10_000, interval: 50 });
    // 같은 프로세스의 다음 부름은 간격 안이라 아무것도 하지 않는다
    expect(await maybeFillConnectionKeys()).toBeNull();
    expect(await audits("ai-connection-key-fill")).toHaveLength(1);
  });
});

describe("③ 가져오기 거절 — 키가 필요한 연결의 키를 옮길 수 없으면 아무것도 쓰지 않는다", () => {
  const keyedUse = (keyEnv: string | null, keyFrom: { routeId: string; model: string } | null = null): AiCurrentSlot => ({ task: "reason-translate", slot: 1,
    source: "설정", error: null, skip: null, notes: [], uses: [{ kind: "api", baseUrl: M3, cliTool: null, model: "m3-model", provider: "abcllm", origin: "test",
      deviceId: "m3-mlx", keyFrom, ...(keyEnv ? { keyEnv } : {}) }] });
  const counts = async () => ({ connections: Number((await client`SELECT count(*) AS n FROM ai_connections`)[0].n),
    ranks: Number((await client`SELECT count(*) AS n FROM ai_task_models`)[0].n), imports: (await audits("ai-task-models-import")).length });

  it("상자 키가 없는 프로세스(11-02 유지보수 컨테이너): 계획은 그 까닭을 보이고, 적용은 ok:false — 연결·순위·감사 0", async () => {
    vi.stubEnv("TEST_IMPORT_KEY", FAKE_KEY);
    current = [keyedUse("TEST_IMPORT_KEY")];
    vi.stubEnv("NMV_SECRET_BOX_KEY", "");
    const preview = await previewAiTaskImport();
    expect(preview.error).toBeNull();
    expect(preview.blocked).toHaveLength(1);
    expect(preview.blocked[0]).toContain("NMV_SECRET_BOX_KEY");
    expect(preview.plan!.warnings[0]).toBe(preview.blocked[0]);
    const applied = await applyAiTaskImport(preview.hash!, "operator");
    expect(applied).toEqual({ ok: false, issues: preview.blocked });
    expect(await counts()).toEqual({ connections: 0, ranks: 0, imports: 0 });
  });

  it("상자 키는 있어도 그 키(env·계약 저장 키)를 읽지 못하면 거절; 읽으면 키를 담아 만든다", async () => {
    current = [keyedUse("TEST_IMPORT_KEY_MISSING")];
    const preview = await previewAiTaskImport();
    expect(preview.blocked).toEqual([expect.stringContaining("환경변수 TEST_IMPORT_KEY_MISSING")]);
    expect(await applyAiTaskImport(preview.hash!, "operator")).toMatchObject({ ok: false });
    current = [keyedUse(null, { routeId: "reason-translate", model: "m3-model" })];
    setServingContractSnapshotForTest([contract("reason-translate", "m3-model", M3, "stored", null)]);
    const unread = await previewAiTaskImport();
    expect(unread.blocked).toEqual([expect.stringContaining("계약 reason-translate · m3-model 의 저장 키")]);
    expect(await applyAiTaskImport(unread.hash!, "operator")).toMatchObject({ ok: false });
    expect(await counts()).toEqual({ connections: 0, ranks: 0, imports: 0 });

    setServingContractSnapshotForTest([contract("reason-translate", "m3-model", M3, "stored", FAKE_KEY)]);
    const ready = await previewAiTaskImport();
    expect(ready.blocked).toEqual([]);
    expect(await applyAiTaskImport(ready.hash!, "operator")).toMatchObject({ ok: true, connections: 1, slots: 1 });
    const [created] = await client<{ id: string; api_key_ciphertext: string | null }[]>`SELECT id, api_key_ciphertext FROM ai_connections`;
    expect(openSecret(created.api_key_ciphertext!, aiConnectionKeyAad(created.id))).toBe(FAKE_KEY);
    expect(JSON.stringify((await audits("ai-task-models-import"))[0].detail)).not.toContain(FAKE_KEY);
  });

  it("회귀: 키가 필요 없는 연결(키 없는 엔진·CLI)만이면 상자 키가 없어도 가져온다", async () => {
    vi.stubEnv("NMV_SECRET_BOX_KEY", "");
    current = [{ task: "crawl-tagline", slot: 1, source: "설정", error: null, skip: null, notes: [], uses: [
      { kind: "api", baseUrl: GPU, cliTool: null, model: "qwen3.8-flash-next", provider: "abcllm", origin: "test", deviceId: "gpu3090-qwen", keyFrom: null }] }];
    const preview = await previewAiTaskImport();
    expect(preview.blocked).toEqual([]);
    expect(await applyAiTaskImport(preview.hash!, "operator")).toMatchObject({ ok: true, connections: 1, slots: 1 });
    expect(await counts()).toMatchObject({ connections: 1, ranks: 1, imports: 1 });
  });
});
