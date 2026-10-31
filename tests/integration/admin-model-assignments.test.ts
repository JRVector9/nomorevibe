import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { readModelCapacityDevice, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import { MODEL_ASSIGNMENT_SAVE_AUDIT_ACTION } from "@/lib/llm/capacity-helpers";
import type { ModelAssignmentDeps } from "@/lib/llm/capacity-helpers-repository";
import type { CliServingContract } from "@/lib/llm/cli-serving-contract";
import { DEFAULT_MODEL_DEFINITIONS, readModelRegistry, type ModelDefinition, type ModelRegistry } from "@/lib/llm/model-registry";
import type { AssignmentImportPlan } from "@/lib/llm/assignment-import";
import type { EngineContractProbe } from "@/lib/operations/admin-engine-connect";
import {
  MODEL_ASSIGNMENT_REFUSAL_MESSAGES, previewAdminAssignmentImport, readModelAssignmentsAdminView, setAssignmentImportPlannerForTest,
  setModelAssignmentDepsForTest,
} from "@/lib/operations/admin-model-assignments";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 모델 배정 화면(PR 3b-D) — server action → saveAdminModelAssignment → PR 3b-A saveModelAssignment(진짜) → 계약·정책 route·장비 순위·배정 행·감사.
 * 관리자·next/cache 만 가짜이고 쓰기 관문(fence)·표·감사는 진짜다. 계약 readback·probe 와 CLI 계약은 setModelAssignmentDepsForTest 로 주입한다(네트워크 없음).
 * 자기 DB 를 만들어 끝까지 migrate 한다(공유 test DB 에 정책·장비·감사 행을 남기지 않는다 — tests/integration/model-assignments.test.ts 와 같은 꼴).
 */
const admin = vi.hoisted(() => ({ login: { login: "operator" } as { login: string } | null }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => admin.login, localOperatorName: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const name = `nomorevibe_test_admin_assign_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const pgAdmin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false;
const root = path.resolve(".");
const basePolicy: ModelCapacityPolicy = { version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "base-a", provider: "fixture", model: "m", providerBudgetId: "acct", groupId: "dev-a" }] };
const DEVICES = ["dev-a", "eng-dev", "connect-dev"];
const definition = (key: string, model: string, provider: ModelDefinition["provider"], baseUrl: string | null): ModelDefinition =>
  ({ key, equipment: key.slice(0, key.indexOf(":")), displayName: key, provider, baseUrl, model, family: model.toLowerCase(), timeoutMs: 60_000,
    maxTokens: 8_000, concurrency: 1, purposes: ["fixture"] });
const FIXTURE_MODELS = [definition("eng:qwen", "Qwen-X", "abcllm", "http://eng.test:8000/v1"), definition("eng:qwen-y", "Qwen-Y", "abcllm", "http://eng.test:8000/v1")];
const registry = (): ModelRegistry => ({ ...readModelRegistry(), models: [...DEFAULT_MODEL_DEFINITIONS, ...FIXTURE_MODELS] });
let probeCalls: string[] = [];
let failWith: string | null = null;
let cliContract: CliServingContract | null = null;
const probeContract: NonNullable<ModelAssignmentDeps["probeContract"]> = async (entry, routeId, transport) => {
  probeCalls.push(`${entry.key}|${routeId}|${transport}`);
  if (failWith) throw new Error(failWith);
  return { endpoint: `${entry.baseUrl}/chat/completions`, requestModel: entry.model, responseModel: `${entry.model}-served`, totalTokenBound: 32_768,
    totalTokenBoundFrom: "engine" } satisfies EngineContractProbe;
};

const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };
const NEW_AI1 = { expectedVersion: "", stage: "ai1", deviceId: "eng-dev", registryKey: "eng:qwen", transport: "direct", rank: "1", role: "primary", mode: "live",
  confirm: "배정", note: "엔진 직접 1차" };
const ID = "eng-dev:ai1:eng:qwen";
const controlRow = async () => (await client<{ mode: string; revision: number; policy: ModelCapacityPolicy }[]>`
  SELECT mode, revision::int, policy FROM model_capacity_control WHERE id = 1`)[0];
const assignmentRows = () => client<{ assignment_id: string; mode: string; rank: number; version: number; registry_key: string; transport: string; model: string }[]>`
  SELECT assignment_id, mode, rank, version::int, registry_key, transport, model FROM model_helper_assignments ORDER BY assignment_id`;
const contracts = () => client<{ route_id: string; model: string; transport: string; contract_hash: string }[]>`
  SELECT route_id, model, transport, contract_hash FROM model_serving_contracts ORDER BY id`;
const roleRows = (deviceId: string) => client<{ route_id: string; role_rank: number }[]>`SELECT route_id, role_rank FROM model_capacity_device_roles
  WHERE device_id = ${deviceId} ORDER BY route_id`;
let auditFloor = 0;
const audits = () => client<{ actor: string; target: string; ok: boolean; detail: Record<string, unknown> }[]>`SELECT actor, target, ok, detail FROM operations_audit
  WHERE action = ${MODEL_ASSIGNMENT_SAVE_AUDIT_ACTION} AND id > ${auditFloor} ORDER BY id`;
const snapshot = async () => ({ control: await controlRow(), rows: await assignmentRows(), contracts: await contracts(),
  roles: await Promise.all(DEVICES.map(roleRows)), audits: (await audits()).length });

async function installPolicy(value: ModelCapacityPolicy) {
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(value)}::jsonb, policy_hash = ${modelCapacityPolicyHash(value)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
}
async function configure(deviceId: string) {
  const current = await readModelCapacityDevice(deviceId);
  const input = { deviceId, limitSlots: 4, secondaryCap: 4, idleMs: 0, reserveSlots: 0, roles: [], physicalLimit: null, note: null };
  return db.transaction(tx => saveModelCapacityDevice(tx, input, current?.version ?? null, "assign-test"));
}
async function clearAll() {
  await client.begin(async tx => {
    await tx`DELETE FROM model_helper_assignments`;
    await tx`DELETE FROM model_serving_contracts`;
    await tx`DELETE FROM model_capacity_device_roles`;
    await tx`UPDATE dr_writer_fence SET state = 'active', reason = NULL, fenced_db = NULL WHERE id = 1`;
  });
}

beforeAll(async () => {
  await pgAdmin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
}, 180_000);
afterAll(async () => {
  setModelAssignmentDepsForTest(null); setAssignmentImportPlannerForTest(null);
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 });
  if (created) await pgAdmin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await pgAdmin.end({ timeout: 3 });
});
beforeEach(async () => {
  await clearAll(); await installPolicy(basePolicy);
  for (const device of DEVICES) await configure(device);
  probeCalls = []; failWith = null; cliContract = null; admin.login = { login: "operator" };
  setModelAssignmentDepsForTest({ registry, probeContract, cliContract: async () => cliContract });
  setAssignmentImportPlannerForTest(null);
  auditFloor = Number((await client`SELECT coalesce(max(id), 0) AS id FROM operations_audit`)[0].id);
});
afterEach(clearAll);

const actions = () => import("@/app/(operator)/admin/models/assignments/actions");

describe("server action → saveModelAssignment(PR 3b-A) — 한 TX", () => {
  it("새 배정(실전, 확인 「배정」) → probe 한 번·계약·정책 route·장비 역할 순위·배정 행·감사 한 줄; 화면 모형이 그 행을 보인다", async () => {
    const { saveModelAssignmentAction } = await actions();
    const before = await controlRow();
    const result = await saveModelAssignmentAction(null, form(NEW_AI1));
    expect(result).toMatchObject({ ok: true, assignmentId: ID });
    expect(result?.message).toContain(`만들었습니다(배정 ${ID}, 판 1, 모드 실전)`);
    expect(result?.message).toContain("엔진 확인(readback·1토큰)으로 새로 만든 계약");
    expect(result?.message).toContain(`정책에 경로를 덧붙였습니다(revision ${before.revision + 1}, DRAIN 없음)`);
    expect(result?.message).toContain("장비 역할 순위 없음 → 1");
    expect(result?.message).toContain("플래그 MODEL_ASSIGNMENT_TABLE 꺼짐");
    expect(probeCalls).toEqual(["eng:qwen|crawl-agent-review|direct"]);
    expect(await assignmentRows()).toEqual([{ assignment_id: ID, mode: "live", rank: 1, version: 1, registry_key: "eng:qwen", transport: "direct", model: "Qwen-X" }]);
    const [contract] = await contracts();
    expect(contract).toMatchObject({ route_id: "crawl-agent-review", model: "Qwen-X", transport: "direct" });
    const after = await controlRow();
    expect(after).toMatchObject({ mode: "open", revision: before.revision + 1 });
    expect(after.policy.routes).toContainEqual({ routeId: "crawl-agent-review", provider: "abcllm", model: "Qwen-X", providerBudgetId: "eng", groupId: "eng-dev" });
    expect(await roleRows("eng-dev")).toEqual([{ route_id: "crawl-agent-review", role_rank: 1 }]);
    const saved = await audits();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ actor: "operator", target: ID, ok: true, detail: { version: 1, expectedVersion: null, appended: true,
      after: { assignmentId: ID, mode: "live", note: "엔진 직접 1차" } } });
    const view = await readModelAssignmentsAdminView();
    const row = view.groups.find(group => group.id === "ai1")!.rows.find(entry => entry.assignmentId === ID)!;
    expect(row).toMatchObject({ role: "primary", modeLabel: "실전", transportLabel: "엔진 직접", rank: 1, deviceRoleRank: 1, version: 1,
      contract: { state: "present", hashPrefix: contract.contract_hash.slice(0, 12) }, route: { state: "present" }, settled1h: 0 });
    expect(view.errors.rows).toBeUndefined();
    expect(view.banner).toBe("읽기: 설정(legacy). 플래그 MODEL_ASSIGNMENT_TABLE 켜면 표를 읽습니다");
    expect(view.audit[0]).toMatchObject({ target: ID, version: 1, ok: true });
    expect(view.audit[0].changes).toEqual(expect.arrayContaining(["모드: 없음 → 실전", "정책 경로 덧붙임(revision " + (before.revision + 1) + ")"]));
  });

  it("CAS — 옛 판·판 없는 새 배정은 한국어로 거절하고 아무것도 바꾸지 않는다; 맞는 판이면 판이 오르고 probe 없이 저장된 계약을 쓴다", async () => {
    const { saveModelAssignmentAction } = await actions();
    await saveModelAssignmentAction(null, form(NEW_AI1));
    probeCalls = [];
    const state = await snapshot();
    expect(await saveModelAssignmentAction(null, form(NEW_AI1))).toEqual({ issues: ["다른 사람이 먼저 저장했습니다(지금 판 1). 새로고침해 바뀐 값을 확인한 뒤 다시 저장하세요."] });
    expect(await snapshot()).toEqual(state);
    const ok = await saveModelAssignmentAction(null, form({ ...NEW_AI1, expectedVersion: "1", assignmentId: ID, rank: "2", mode: "off", confirm: "" }));
    expect(ok).toMatchObject({ ok: true, message: expect.stringContaining("판 2, 모드 꺼짐") });
    expect(ok?.message).toContain("저장된 계약");
    expect(ok?.message).toContain("장비 역할 순위 1 → 2");
    expect(probeCalls).toEqual([]);
    const stale = await snapshot();
    expect(await saveModelAssignmentAction(null, form({ ...NEW_AI1, expectedVersion: "1", assignmentId: ID }))).toEqual({ issues: [expect.stringContaining("지금 판 2")] });
    expect(await snapshot()).toEqual(stale);
    expect((await audits()).map(row => row.detail.version)).toEqual([1, 2]);
  });

  it("거절 → 운영자 문장(할 일), 그리고 남는 행이 없다: 장비 없음·probe 실패·자동으로 못 만드는 계약·CLI 계약 없음·확인 글자 없음", async () => {
    const { saveModelAssignmentAction } = await actions();
    const state = await snapshot();
    expect(await saveModelAssignmentAction(null, form({ ...NEW_AI1, deviceId: "nowhere" }))).toEqual({ issues: [MODEL_ASSIGNMENT_REFUSAL_MESSAGES.device_unconfigured] });
    failWith = "engine_unreachable:timeout";
    expect(await saveModelAssignmentAction(null, form(NEW_AI1)))
      .toEqual({ issues: ["엔진 확인(readback·1토큰 시험)이 실패해 저장하지 않았습니다 — 엔진에 닿지 못했습니다(timeout) — 등록부의 주소·키·엔진 상태를 확인하세요."] });
    failWith = null;
    expect(await saveModelAssignmentAction(null, form({ ...NEW_AI1, stage: "ai2" }))).toEqual({ issues: [MODEL_ASSIGNMENT_REFUSAL_MESSAGES.contract_unbuildable] });
    expect(await saveModelAssignmentAction(null, form({ ...NEW_AI1, stage: "intro", deviceId: "connect-dev", registryKey: "connect:sonnet", transport: "cli" })))
      .toEqual({ issues: [MODEL_ASSIGNMENT_REFUSAL_MESSAGES.cli_contract_missing] });
    expect(await saveModelAssignmentAction(null, form({ ...NEW_AI1, stage: "intro" }))).toEqual({ issues: [expect.stringContaining("connect 장비")] });
    expect(await saveModelAssignmentAction(null, form({ ...NEW_AI1, confirm: "" }))).toEqual({ issues: [expect.stringContaining("「배정」")] });
    expect(await snapshot()).toEqual(state);
    admin.login = null;
    expect(await saveModelAssignmentAction(null, form(NEW_AI1))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    expect(await snapshot()).toEqual(state);
  });

  it("끄기 — 화면이 본 판으로 mode off 저장(계약·route·장비 순위는 그대로); 옛 판은 거절", async () => {
    const { saveModelAssignmentAction, turnOffModelAssignmentAction } = await actions();
    await saveModelAssignmentAction(null, form(NEW_AI1));
    const kept = { contracts: await contracts(), roles: await roleRows("eng-dev"), control: await controlRow() };
    expect(await turnOffModelAssignmentAction(null, form({ assignmentId: ID, expectedVersion: "1" })))
      .toMatchObject({ ok: true, message: `껐습니다(배정 ${ID}, 판 2). 계약·정책 경로·장비 순위는 그대로 남습니다.` });
    expect((await assignmentRows())[0]).toMatchObject({ mode: "off", version: 2 });
    expect({ contracts: await contracts(), roles: await roleRows("eng-dev"), control: await controlRow() }).toEqual(kept);
    expect(await turnOffModelAssignmentAction(null, form({ assignmentId: ID, expectedVersion: "1" }))).toEqual({ issues: [expect.stringContaining("지금 판 2")] });
    expect(await turnOffModelAssignmentAction(null, form({ assignmentId: "missing:ai1:eng:qwen", expectedVersion: "1" })))
      .toEqual({ issues: [expect.stringContaining("이 배정이 지금 없습니다")] });
    expect((await audits()).map(row => row.detail.version)).toEqual([1, 2]);
  });
});

describe("현재 설정 → 배정 표 가져오기", () => {
  it("3b-B 자리표 계획: 빈 계획 + 「3b-B 미반영」, 적용은 아무것도 쓰지 않는다; hash 가 다르면 거절, 확인 글자가 없으면 거절", async () => {
    const { applyAssignmentImportAction } = await actions();
    const preview = await previewAdminAssignmentImport();
    expect(preview).toMatchObject({ rows: [], warnings: ["3b-B 미반영"], error: null });
    const state = await snapshot();
    expect(await applyAssignmentImportAction(null, form({ planHash: preview.hash!, confirm: "배정" })))
      .toEqual({ ok: true, rows: [], message: "가져올 행이 없습니다. 경고: 3b-B 미반영" });
    expect(await applyAssignmentImportAction(null, form({ planHash: "0".repeat(64), confirm: "배정" }))).toEqual({ issues: [expect.stringContaining("계획 보기")] });
    expect(await applyAssignmentImportAction(null, form({ planHash: preview.hash! }))).toEqual({ issues: [expect.stringContaining("「배정」")] });
    expect(await snapshot()).toEqual(state);
  });

  it("행마다 같은 저장 함수 — 한 행이 거절돼도 다음 행을 계속하고, 「그대로」는 건너뛴다; 행마다 결과", async () => {
    const { applyAssignmentImportAction } = await actions();
    const plan: AssignmentImportPlan = { warnings: ["시험 계획"], rows: [
      { action: "create", origin: "firstReview", input: { assignmentId: ID, expectedVersion: null, stage: "ai1", deviceId: "eng-dev", registryKey: "eng:qwen",
        transport: "direct", rank: 1, mode: "live" } },
      { action: "create", origin: "firstReviewAdditional[0]", input: { assignmentId: "nowhere:ai1:eng:qwen-y", expectedVersion: null, stage: "ai1",
        deviceId: "nowhere", registryKey: "eng:qwen-y", transport: "direct", rank: 2, mode: "live" } },
      { action: "unchanged", origin: "stageModelPools.reason-translate[0]", input: { assignmentId: "dev-a:reason:eng:qwen", expectedVersion: 3, stage: "reason",
        deviceId: "dev-a", registryKey: "eng:qwen", transport: "direct" } },
    ] };
    setAssignmentImportPlannerForTest(() => plan);
    const preview = await previewAdminAssignmentImport();
    expect(preview.counts).toEqual({ create: 2, update: 0, unchanged: 1 });
    const result = await applyAssignmentImportAction(null, form({ planHash: preview.hash!, confirm: "배정" }));
    expect(result).toMatchObject({ ok: true, message: "가져오기를 적용했습니다 — 저장 1 · 거절 1 · 그대로 1. 경고: 시험 계획" });
    expect(result?.rows).toEqual([
      { index: 0, origin: "firstReview", assignmentId: ID, ok: true, skipped: false, version: 1, message: "저장(판 1)" },
      { index: 1, origin: "firstReviewAdditional[0]", assignmentId: "nowhere:ai1:eng:qwen-y", ok: false, skipped: false, version: null,
        message: MODEL_ASSIGNMENT_REFUSAL_MESSAGES.device_unconfigured },
      { index: 2, origin: "stageModelPools.reason-translate[0]", assignmentId: "dev-a:reason:eng:qwen", ok: true, skipped: true, version: null, message: "그대로 — 건너뜀" },
    ]);
    expect((await assignmentRows()).map(row => row.assignment_id)).toEqual([ID]);
    expect((await audits()).map(row => [row.target, row.actor])).toEqual([[ID, "operator"]]);
    // 같은 계획을 다시 적용하면 첫 행은 이제 판 1 이 있어 CAS 거절(계획이 그 사이 바뀐 것은 아니다 — 3b-B 계획이면 update 로 다시 만든다)
    const again = await applyAssignmentImportAction(null, form({ planHash: preview.hash!, confirm: "배정" }));
    expect(again?.rows?.[0]).toMatchObject({ ok: false, message: expect.stringContaining("지금 판 1") });
  });
});
