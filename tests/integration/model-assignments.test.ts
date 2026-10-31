import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { MODEL_CAPACITY_ROUTES_MAX, modelCapacityPolicyHash, parseModelCapacityPolicy, type ModelCapacityPolicy, type ModelCapacityRequest } from "@/lib/llm/capacity";
import { appendCompatibleRoutes, beginModelDispatch, markModelDispatchIndeterminate, requestModelSlot, setModelCapacityPolicy } from "@/lib/llm/capacity-repository";
import { readModelCapacityDevice, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import { MODEL_ASSIGNMENT_SAVE_AUDIT_ACTION, assignmentEvidenceKey } from "@/lib/llm/capacity-helpers";
import { listHelperAssignments, readHelperGateStates, readModelAssignments, saveHelperAssignment, saveModelAssignment, setHelperMode,
  type ModelAssignmentDeps } from "@/lib/llm/capacity-helpers-repository";
import { localModelContractHash, localModelServingContractSchema } from "@/lib/llm/local-model-serving-contract";
import { DEFAULT_MODEL_DEFINITIONS, readModelRegistry, type ModelDefinition, type ModelRegistry } from "@/lib/llm/model-registry";
import { assignmentsForStage } from "@/lib/llm/stage-assignments";
import type { CliServingContract } from "@/lib/llm/cli-serving-contract";
import type { EngineContractProbe } from "@/lib/operations/admin-engine-connect";
import { TEST_DATABASE_URL } from "./setup";

/**
 * PR 3b-A 배정 표 저장 — 자기 DB 를 만들어 끝까지 migrate 한다(공유 test DB 에 정책·장비·감사 행을 남기지 않는다).
 * 계약 readback·probe 와 CLI 계약은 주입한다(네트워크 없음). 장비: dev-a·dev-b(기존 route 의 장비, 잡힌 행을 만든다), eng-dev(엔진 직접 연결 모델),
 * loc-dev(로컬 모델), connect-dev(CLI).
 */
const name = `nomorevibe_test_assign_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false;
const root = path.resolve(".");
const owner = { instanceId: `assign-${randomUUID()}`, bootId: randomUUID() };
const baseRoute = (routeId: string, groupId: string) => ({ routeId, provider: "fixture", model: "m", providerBudgetId: "acct", groupId });
const basePolicy: ModelCapacityPolicy = { version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [baseRoute("base-a", "dev-a"), baseRoute("base-b", "dev-b")] };
const DEVICES = ["dev-a", "dev-b", "eng-dev", "loc-dev", "connect-dev"];

const definition = (key: string, model: string, provider: ModelDefinition["provider"], baseUrl: string | null): ModelDefinition =>
  ({ key, equipment: key.slice(0, key.indexOf(":")), displayName: key, provider, baseUrl, model, family: model.toLowerCase(), timeoutMs: 60_000,
    maxTokens: 8_000, concurrency: 1, purposes: ["fixture"] });
const FIXTURE_MODELS = [definition("eng:qwen", "Qwen-X", "abcllm", "http://eng.test:8000/v1"), definition("eng:qwen-y", "Qwen-Y", "abcllm", "http://eng.test:8000/v1"),
  definition("eng:qwen-z", "Qwen-Z", "abcllm", "http://eng.test:8000/v1"), definition("loc:deep", "deep-1", "local-direct", "http://loc.test:8010/v1")];
const registry = (): ModelRegistry => ({ ...readModelRegistry(), models: [...DEFAULT_MODEL_DEFINITIONS, ...FIXTURE_MODELS] });

/** 주입하는 readback + probe: 부른 것을 적고, `failWith` 가 있으면 던진다. */
let probeCalls: { key: string; routeId: string; transport: string }[] = [];
let failWith: string | null = null;
const probeContract: NonNullable<ModelAssignmentDeps["probeContract"]> = async (entry, routeId, transport) => {
  probeCalls.push({ key: entry.key, routeId, transport });
  if (failWith) throw new Error(failWith);
  const requestModel = transport === "gateway" && entry.gatewayLabel ? `[${entry.gatewayLabel}] ${entry.model}` : entry.model;
  return { endpoint: `${entry.baseUrl}/chat/completions`, requestModel, responseModel: `${entry.model}-served`, totalTokenBound: 32_768,
    totalTokenBoundFrom: "engine" } satisfies EngineContractProbe;
};
const sonnet: CliServingContract = { version: 1, protocol: "cli-process-v1", routeId: "product-intro-check", provider: "claude-cli", model: "sonnet",
  cliVersion: "2.0.0", inputByteCap: 100_000, totalTokenBound: 2_000_000, costBoundUsdMicros: null, boundProvenance: "derived", maxTurns: 1,
  outputTokensPerTurn: 8_000, overheadTokenBound: 20_000 };
let cliContract: CliServingContract | null = sonnet;
const deps: ModelAssignmentDeps = { registry, probeContract, cliContract: async () => cliContract };
const save = (input: Record<string, unknown>, actor = "jr", extra: ModelAssignmentDeps = {}) =>
  db.transaction(tx => saveModelAssignment(tx, input, actor, { ...deps, ...extra }));
const engAi1 = (changes: Record<string, unknown> = {}) => ({ assignmentId: "eng-dev:ai1:qwen", expectedVersion: null, stage: "ai1", deviceId: "eng-dev",
  registryKey: "eng:qwen", transport: "direct", mode: "live", ...changes });

const request = (routeId: string, overrides: Partial<ModelCapacityRequest> = {}): ModelCapacityRequest => ({ requestId: randomUUID(), workKey: randomUUID(), owner,
  class: "first", pool: "reviewer", routeId, provider: "fixture", model: "m", ...overrides });
async function dispatched(value: ModelCapacityRequest) {
  const result = await requestModelSlot(value);
  if (result.kind !== "granted") throw new Error(`fixture_not_granted:${JSON.stringify(result)}`);
  const begun = await beginModelDispatch(result.reservation);
  if (begun.kind !== "dispatched") throw new Error("fixture_not_dispatched");
  return begun.dispatch;
}
const controlRow = async () => (await client<{ mode: string; epoch: number; revision: number; policy: ModelCapacityPolicy; policy_hash: string }[]>`
  SELECT mode, epoch::int, revision::int, policy, policy_hash FROM model_capacity_control WHERE id = 1`)[0];
async function installPolicy(value: ModelCapacityPolicy) {
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(value)}::jsonb, policy_hash = ${modelCapacityPolicyHash(value)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
}
async function configure(deviceId: string, settings: Record<string, unknown> = {}) {
  const current = await readModelCapacityDevice(deviceId);
  const input = { deviceId, limitSlots: 4, secondaryCap: 4, idleMs: 0, reserveSlots: 0, roles: [], physicalLimit: null, note: null, ...settings };
  return db.transaction(tx => saveModelCapacityDevice(tx, input, current?.version ?? null, "assign-test"));
}
const contracts = () => client<{ route_id: string; model: string; transport: string; auth: string; enabled: boolean; contract_hash: string;
  contract: Record<string, unknown> }[]>`SELECT route_id, model, transport, auth, enabled, contract_hash, contract FROM model_serving_contracts ORDER BY id`;
const assignmentRows = () => client<Record<string, unknown>[]>`SELECT assignment_id, stage, device_id, model, shadow_route_id, live_route_id, live_provider,
  mode, registry_key, transport, rank, role, vote, version::int FROM model_helper_assignments ORDER BY assignment_id`;
const roleRows = (deviceId: string) => client<{ route_id: string; role_rank: number }[]>`SELECT route_id, role_rank FROM model_capacity_device_roles
  WHERE device_id = ${deviceId} ORDER BY route_id`;
let auditFloor = 0;
const audits = (action: string) => client<{ target: string; detail: Record<string, unknown> }[]>`SELECT target, detail FROM operations_audit
  WHERE action = ${action} AND id > ${auditFloor} ORDER BY id`;
/** 실패한 저장이 아무것도 남기지 않았다: 정책·계약·배정·장비 순위·감사가 그대로다. */
async function unchanged(work: () => Promise<unknown>, code: string) {
  const before = { control: await controlRow(), contracts: await contracts(), rows: await assignmentRows(), roles: await Promise.all(DEVICES.map(roleRows)),
    audits: Number((await client`SELECT count(*)::int AS n FROM operations_audit`)[0].n) };
  await expect(work()).rejects.toThrow(code);
  expect({ control: await controlRow(), contracts: await contracts(), rows: await assignmentRows(), roles: await Promise.all(DEVICES.map(roleRows)),
    audits: Number((await client`SELECT count(*)::int AS n FROM operations_audit`)[0].n) }).toEqual(before);
}

async function clearAll() {
  await client.begin(async tx => {
    const mine = tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id = ${owner.instanceId}`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id IN (${mine})`;
    await tx`DELETE FROM model_capacity_requests WHERE owner_instance_id = ${owner.instanceId}`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_helper_assignments`;
    await tx`DELETE FROM model_serving_contracts`;
    await tx`DELETE FROM model_capacity_device_roles`;
    await tx`UPDATE dr_writer_fence SET state = 'active', reason = NULL, fenced_db = NULL WHERE id = 1`;
  });
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
}, 180_000);
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 });
  if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end({ timeout: 3 });
});
beforeEach(async () => {
  await clearAll(); await installPolicy(basePolicy);
  for (const device of DEVICES) await configure(device);
  probeCalls = []; failWith = null; cliContract = sonnet;
  auditFloor = Number((await client`SELECT coalesce(max(id), 0) AS id FROM operations_audit`)[0].id);
});
afterEach(clearAll);

describe("saveModelAssignment (PR 3b-A)", () => {
  it("creates contract, route, device role, row and one audit in one TX — without DRAIN — and keeps the row out of the helper gate", async () => {
    const before = await controlRow();
    const deviceBefore = (await readModelCapacityDevice("eng-dev"))!.version;
    const result = await save(engAi1());
    // (b) probe once, contract row stored as a direct engine contract of the stage route
    expect(probeCalls).toEqual([{ key: "eng:qwen", routeId: "crawl-agent-review", transport: "direct" }]);
    const [contract] = await contracts();
    expect(contract).toMatchObject({ route_id: "crawl-agent-review", model: "Qwen-X", transport: "direct", auth: "none", enabled: true });
    expect(contract.contract).toMatchObject({ protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm", model: "Qwen-X",
      responseModel: "Qwen-X-served", endpoint: "http://eng.test:8000/v1/chat/completions", totalTokenBound: 32_768 });
    expect(result.contract).toMatchObject({ routeId: "crawl-agent-review", model: "Qwen-X", contractHash: contract.contract_hash, source: "probed" });
    // (c) route appended with a predecessor; mode stays open (no DRAIN)
    const after = await controlRow();
    const route = { routeId: "crawl-agent-review", provider: "abcllm", model: "Qwen-X", providerBudgetId: "eng", groupId: "eng-dev" };
    expect(result).toMatchObject({ route, appended: [route], policyRevision: before.revision + 1 });
    expect(after).toMatchObject({ mode: "open", epoch: before.epoch, revision: before.revision + 1 });
    expect(after.policy.routes).toEqual([...basePolicy.routes, route]);
    // nothing was held in the old generation: no chain is written (an old parser still reads this policy)
    expect(after.policy.compatiblePredecessor).toBeUndefined();
    expect(after.policy.compatiblePredecessors).toBeUndefined();
    expect(after.policy_hash).toBe(modelCapacityPolicyHash(parseModelCapacityPolicy(after.policy)));
    // (d) device role rank and the device version
    expect(await roleRows("eng-dev")).toEqual([{ route_id: "crawl-agent-review", role_rank: 1 }]);
    expect((await readModelCapacityDevice("eng-dev"))!.version).toBe(deviceBefore + 1);
    expect(result.deviceRole).toEqual({ routeId: "crawl-agent-review", before: null, after: 1 });
    // the row
    expect(await assignmentRows()).toEqual([{ assignment_id: "eng-dev:ai1:qwen", stage: "ai1", device_id: "eng-dev", model: "Qwen-X", shadow_route_id: "primary:ai1",
      live_route_id: "crawl-agent-review", live_provider: "abcllm", mode: "live", registry_key: "eng:qwen", transport: "direct", rank: 1, role: "primary", vote: false,
      version: 1 }]);
    expect(result.before).toBeNull();
    expect(result.after).toMatchObject({ assignmentId: "eng-dev:ai1:qwen", stage: "ai1", registryKey: "eng:qwen", transport: "direct", rank: 1, role: "primary",
      vote: false, mode: "live", model: "Qwen-X", routeId: "crawl-agent-review", provider: "abcllm", version: 1, updatedBy: "jr",
      evidenceKey: assignmentEvidenceKey({ stage: "ai1", transport: "direct", routeId: "crawl-agent-review", provider: "abcllm", model: "Qwen-X",
        contractHash: contract.contract_hash }) });
    // (e) one assignment audit (the new contract keeps its own save audit)
    const saved = await audits(MODEL_ASSIGNMENT_SAVE_AUDIT_ACTION);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ target: "eng-dev:ai1:qwen", detail: { version: 1, expectedVersion: null, before: null, appended: true,
      policyRevision: before.revision + 1, route, deviceRole: { routeId: "crawl-agent-review", before: null, after: 1 },
      contract: { source: "probed", routeId: "crawl-agent-review", model: "Qwen-X" } } });
    expect(await audits("model-serving-contract-save")).toHaveLength(1);
    // readers: the stage table sees it, the helper gate/list/snapshot do not, and the route is admitted like any other
    expect((await readModelAssignments({ stage: "ai1" })).map(row => row.assignmentId)).toEqual(["eng-dev:ai1:qwen"]);
    expect((await assignmentsForStage("ai1")).map(row => row.assignmentId)).toEqual(["eng-dev:ai1:qwen"]);
    expect(await assignmentsForStage("ai1", { mode: "off" })).toEqual([]);
    expect(await listHelperAssignments()).toEqual([]);
    expect(await readHelperGateStates("eng-dev")).toEqual([]);
    expect(await readHelperGateStates()).toEqual([]);
    const admitted = await requestModelSlot(request("crawl-agent-review", { provider: "abcllm", model: "Qwen-X" }));
    expect(admitted.kind).toBe("granted");
  });

  it("is idempotent on a second save of the same tuple: no probe, no route, no revision, no device bump — only the row version", async () => {
    await save(engAi1());
    const control = await controlRow(), device = (await readModelCapacityDevice("eng-dev"))!.version, stored = await contracts();
    probeCalls = [];
    const again = await save(engAi1({ expectedVersion: 1, note: "다시" }));
    expect(probeCalls).toEqual([]);
    expect(again).toMatchObject({ appended: [], policyRevision: control.revision, contract: { source: "stored" }, deviceRole: { before: 1, after: 1 } });
    expect(again.after).toMatchObject({ version: 2, note: "다시", evidenceKey: again.before!.evidenceKey });
    expect(await controlRow()).toEqual(control);
    expect(await contracts()).toEqual(stored);
    expect((await readModelCapacityDevice("eng-dev"))!.version).toBe(device);
    expect((await audits(MODEL_ASSIGNMENT_SAVE_AUDIT_ACTION)).map(row => row.detail.appended)).toEqual([true, false]);
    expect(await audits("model-serving-contract-save")).toHaveLength(1);
    // a rank change bumps only the device role (and the device version), not the policy
    const ranked = await save(engAi1({ expectedVersion: 2, rank: 2 }));
    expect(ranked).toMatchObject({ appended: [], policyRevision: control.revision, deviceRole: { before: 1, after: 2 } });
    expect(await roleRows("eng-dev")).toEqual([{ route_id: "crawl-agent-review", role_rank: 2 }]);
    expect((await readModelCapacityDevice("eng-dev"))!.version).toBe(device + 1);
  });

  it("keeps dispatched holds valid across successive appends (compatiblePredecessors chain) under constant load", async () => {
    const gen1 = await controlRow();
    const generation = (row: { epoch: number; revision: number; policy_hash: string }) => ({ epoch: row.epoch, revision: row.revision, policyHash: row.policy_hash });
    const h1 = await dispatched(request("base-a"));
    // P2 = P1 + r1: the gen-1 hold is authenticated by the chain, new work is admitted, mode stays open
    await save(engAi1());
    const gen2 = await controlRow();
    expect(gen2.policy.compatiblePredecessors).toEqual([generation(gen1)]);
    expect(gen2.policy.compatiblePredecessor).toBeUndefined();
    expect(gen2.mode).toBe("open");
    expect((await client`SELECT state, revision::int FROM model_capacity_requests WHERE request_id = ${h1.requestId}`)[0]).toEqual({ state: "dispatched", revision: gen1.revision });
    const h2 = await dispatched(request("base-b"));
    // the second append under load (the single-predecessor form refused it with model_capacity_append_predecessor_busy) keeps both generations
    await save(engAi1({ assignmentId: "eng-dev:ai1:qwen-y", registryKey: "eng:qwen-y" }));
    const gen3 = await controlRow();
    expect(gen3.revision).toBe(gen2.revision + 1);
    expect(gen3.policy.compatiblePredecessors).toEqual([generation(gen1), generation(gen2)]);
    const r3 = await requestModelSlot(request("base-b"));
    expect(r3.kind).toBe("granted");                                                           // not policy_changed: gen-1 and gen-2 holds are proven
    // a third append while gen-1, gen-2 and a gen-3 reservation are all held
    await save(engAi1({ assignmentId: "eng-dev:ai1:qwen-z", registryKey: "eng:qwen-z" }));
    const gen4 = await controlRow();
    expect(gen4.policy.compatiblePredecessors).toEqual([generation(gen1), generation(gen2), generation(gen3)]);
    expect(gen4.mode).toBe("open");
    expect((await client`SELECT request_id, state FROM model_capacity_requests WHERE request_id IN (${h1.requestId}, ${h2.requestId}) ORDER BY revision`))
      .toEqual([{ request_id: h1.requestId, state: "dispatched" }, { request_id: h2.requestId, state: "dispatched" }]);
    expect((await requestModelSlot(request("base-a"))).kind).toBe("granted");
    expect(gen4.policy.routes.map(route => route.model)).toEqual(["m", "m", "Qwen-X", "Qwen-Y", "Qwen-Z"]);
  });

  it("prunes generations without ledger rows, drops the chain when nothing is held, and refuses a full chain without writing", async () => {
    const generation = (row: { epoch: number; revision: number; policy_hash: string }) => ({ epoch: row.epoch, revision: row.revision, policyHash: row.policy_hash });
    const gen1 = await controlRow();
    const h1 = await dispatched(request("base-a"));
    await db.transaction(tx => appendCompatibleRoutes(tx, [baseRoute("p-1", "dev-a")]));
    const h2 = await dispatched(request("base-b"));
    const gen2 = await controlRow();
    await db.transaction(tx => appendCompatibleRoutes(tx, [baseRoute("p-2", "dev-a")]));
    expect((await controlRow()).policy.compatiblePredecessors).toEqual([generation(gen1), generation(gen2)]);
    // gen 2 ends (indeterminate does not occupy and is not live), gen 3 never had a row: both are pruned, gen 1 stays
    expect(await markModelDispatchIndeterminate(h2, "transport_unknown")).toBe(true);
    await db.transaction(tx => appendCompatibleRoutes(tx, [baseRoute("p-3", "dev-a")]));
    expect((await controlRow()).policy.compatiblePredecessors).toEqual([generation(gen1)]);
    // nothing live in any old generation: the chain field is dropped altogether
    expect(await markModelDispatchIndeterminate(h1, "transport_unknown")).toBe(true);
    await db.transaction(tx => appendCompatibleRoutes(tx, [baseRoute("p-4", "dev-a")]));
    const cleared = await controlRow();
    expect(cleared.policy.compatiblePredecessors).toBeUndefined();
    expect(cleared.policy.compatiblePredecessor).toBeUndefined();
    // fill the chain: every generation keeps a live hold (enough slots on both devices)
    await configure("dev-a", { limitSlots: 32, secondaryCap: 32 }); await configure("dev-b", { limitSlots: 32, secondaryCap: 32 });
    const held: Awaited<ReturnType<typeof dispatched>>[] = [];
    for (let index = 0; index < 16; index++) {
      held.push(await dispatched(request(index % 2 ? "base-b" : "base-a")));
      await db.transaction(tx => appendCompatibleRoutes(tx, [baseRoute(`q-${index}`, "dev-a")]));
    }
    const full = await controlRow();
    expect(full.policy.compatiblePredecessors).toHaveLength(16);
    expect((await requestModelSlot(request("base-a"))).kind).toBe("granted");               // every one of the 16 old generations is proven
    // the 17th generation with a live row cannot be added: refused, nothing written
    await unchanged(() => db.transaction(tx => appendCompatibleRoutes(tx, [baseRoute("q-overflow", "dev-a")])), "model_capacity_append_chain_full");
    // once the oldest hold ends the same append succeeds and the chain slides
    expect(await markModelDispatchIndeterminate(held[0], "transport_unknown")).toBe(true);
    await db.transaction(tx => appendCompatibleRoutes(tx, [baseRoute("q-overflow", "dev-a")]));
    const slid = await controlRow();
    expect(slid.policy.compatiblePredecessors).toHaveLength(16);
    expect(slid.policy.compatiblePredecessors![0]).toEqual(full.policy.compatiblePredecessors![1]);
    expect(slid.policy.compatiblePredecessors!.at(-1)).toEqual(generation(full));
  });

  it("reads an old single predecessor as a chain of one and keeps it while its hold lives", async () => {
    const h1 = await dispatched(request("base-a"));
    const gen1 = await controlRow();
    const legacy: ModelCapacityPolicy = { ...basePolicy, routes: [...basePolicy.routes, baseRoute("legacy-add", "dev-b")],
      compatiblePredecessor: { epoch: gen1.epoch, revision: gen1.revision, policy: { ...basePolicy, routes: [...basePolicy.routes] } } };
    await installPolicy(legacy);
    const gen2 = await controlRow();
    expect((await requestModelSlot(request("base-b"))).kind).toBe("granted");
    await db.transaction(tx => appendCompatibleRoutes(tx, [baseRoute("after-legacy", "dev-a")]));
    const gen3 = await controlRow();
    expect(gen3.policy.compatiblePredecessor).toBeUndefined();
    expect(gen3.policy.compatiblePredecessors).toEqual([{ epoch: gen1.epoch, revision: gen1.revision, policyHash: modelCapacityPolicyHash(basePolicy) },
      { epoch: gen2.epoch, revision: gen2.revision, policyHash: gen2.policy_hash }]);
    expect((await requestModelSlot(request("base-a"))).kind).toBe("granted");
    expect(await markModelDispatchIndeterminate(h1, "transport_unknown")).toBe(true);
  });

  it("lets the operator policy write carry only a chain it can prove", async () => {
    const h1 = await dispatched(request("base-a"));
    await db.transaction(tx => appendCompatibleRoutes(tx, [baseRoute("op-1", "dev-a")]));
    const gen2 = await controlRow();
    const chain = gen2.policy.compatiblePredecessors!;
    await client`UPDATE model_capacity_control SET mode = 'draining' WHERE id = 1`;
    const write = (value: unknown) => db.transaction(tx => setModelCapacityPolicy(tx, value));
    const { compatiblePredecessors: _drop, ...gen2Base } = gen2.policy; void _drop;
    const grown = { ...gen2Base, routes: [...gen2.policy.routes, baseRoute("op-2", "dev-b")] };
    await unchanged(() => write({ ...grown, compatiblePredecessors: [{ epoch: gen2.epoch, revision: 1, policyHash: "f".repeat(64) }] }), "model_capacity_predecessor_unproven");
    await unchanged(() => write({ ...gen2Base, routes: [...gen2.policy.routes].reverse().slice(1), compatiblePredecessors: chain }), "model_capacity_predecessor_unproven");
    await write({ ...grown, compatiblePredecessors: [...chain, { epoch: gen2.epoch, revision: gen2.revision, policyHash: gen2.policy_hash }] });
    const gen3 = await controlRow();
    expect(gen3.policy.compatiblePredecessors).toHaveLength(2);
    await client`UPDATE model_capacity_control SET mode = 'open' WHERE id = 1`;
    expect((await requestModelSlot(request("base-b"))).kind).toBe("granted");
    expect(await markModelDispatchIndeterminate(h1, "transport_unknown")).toBe(true);
  });

  it("enforces the route cap and refuses a conflicting route without writing", async () => {
    const full: ModelCapacityPolicy = { ...basePolicy, routes: Array.from({ length: MODEL_CAPACITY_ROUTES_MAX }, (_, index) => baseRoute(`fill-${index}`, "dev-a")) };
    await installPolicy(full);
    await unchanged(() => save(engAi1()), "model_capacity_routes_cap");
    await installPolicy(basePolicy);
    await unchanged(() => db.transaction(tx => appendCompatibleRoutes(tx, [{ ...baseRoute("base-a", "dev-b") }])), "model_capacity_route_conflict");
    await unchanged(() => db.transaction(tx => appendCompatibleRoutes(tx, [baseRoute("x", "dev-a"), { ...baseRoute("x", "dev-a"), providerBudgetId: "other" }])),
      "model_capacity_route_conflict");
    // an identical route is a no-op that does not bump the revision
    const control = await controlRow();
    expect(await db.transaction(tx => appendCompatibleRoutes(tx, [baseRoute("base-a", "dev-a")]))).toEqual({ appended: [], policyRevision: control.revision });
    expect(await controlRow()).toEqual(control);
    // a route that already exists for the stage model on another device is not moved
    await installPolicy({ ...basePolicy, routes: [...basePolicy.routes, { routeId: "crawl-agent-review", provider: "abcllm", model: "Qwen-X",
      providerBudgetId: "eng", groupId: "dev-a" }] });
    await unchanged(() => save(engAi1()), "model_assignment_refused:route_device_mismatch");
  });

  it("refuses an unconfigured device, a failed or mismatched probe, CAS and helper collisions — leaving no partial rows", async () => {
    await unchanged(() => save(engAi1({ deviceId: "nowhere" })), "model_assignment_refused:device_unconfigured");
    await client`UPDATE model_capacity_devices SET enabled = false WHERE device_id = 'eng-dev'`;
    await unchanged(() => save(engAi1()), "model_assignment_refused:device_unconfigured");
    await client`UPDATE model_capacity_devices SET enabled = true WHERE device_id = 'eng-dev'`;
    failWith = "engine_unreachable:unreachable";
    await unchanged(() => save(engAi1()), "model_assignment_refused:contract_probe_failed:engine_unreachable:unreachable");
    failWith = null;
    const wrongName: ModelAssignmentDeps = { probeContract: async (...args) => ({ ...await probeContract(...args), requestModel: "other" }) };
    await unchanged(() => save(engAi1(), "jr", wrongName), "model_assignment_refused:contract_probe_failed");
    // routes engine connect never builds a contract for (AI2's adapter contract) are not probed
    await unchanged(() => save(engAi1({ assignmentId: "eng-dev:ai2:qwen", stage: "ai2" })), "model_assignment_refused:contract_unbuildable");
    expect(probeCalls.filter(call => call.routeId === "second-review")).toEqual([]);
    // CAS
    await save(engAi1());
    await unchanged(() => save(engAi1()), "model_assignment_version_mismatch:1");
    await unchanged(() => save(engAi1({ expectedVersion: 7 })), "model_assignment_version_mismatch:1");
    await unchanged(() => save(engAi1({ expectedVersion: 1, stage: "tagline", transport: "direct" })), "model_assignment_invalid:stage");
    await unchanged(() => save(engAi1({ assignmentId: "eng-dev:ai1:dup" })), "model_assignment_invalid:registryKey");
    // a helper row of the same name is never overwritten by the assignment save, and the helper save/mode never touch a primary row
    await client`INSERT INTO model_helper_assignments (assignment_id, stage, device_id, model, shadow_route_id, live_route_id, live_provider, evidence_key, updated_by)
      VALUES ('loc-dev:ai2', 'ai2', 'loc-dev', 'deep-1', 'local-helper-shadow-ai2', 'second-review', 'local-direct', ${"a".repeat(64)}, 'fixture')`;
    await unchanged(() => save({ assignmentId: "loc-dev:ai2", expectedVersion: null, stage: "ai2", deviceId: "loc-dev", registryKey: "loc:deep",
      transport: "local-direct" }), "model_assignment_refused:assignment_is_helper");
    await unchanged(() => save({ assignmentId: "loc-dev:ai2:deep", expectedVersion: null, stage: "ai2", deviceId: "loc-dev", registryKey: "loc:deep",
      transport: "local-direct" }), "model_assignment_refused:route_is_helper_route");
    // a different model on that device may not raise the helper's live route to rank 1 either (rank 2 is fine)
    await client`UPDATE model_helper_assignments SET model = 'other-model' WHERE assignment_id = 'loc-dev:ai2'`;
    await unchanged(() => save({ assignmentId: "loc-dev:ai2:deep", expectedVersion: null, stage: "ai2", deviceId: "loc-dev", registryKey: "loc:deep",
      transport: "local-direct" }), "model_assignment_refused:route_is_helper_route");
    expect((await save({ assignmentId: "loc-dev:ai2:deep", expectedVersion: null, stage: "ai2", deviceId: "loc-dev", registryKey: "loc:deep",
      transport: "local-direct", rank: 2 })).deviceRole).toEqual({ routeId: "second-review", before: null, after: 2 });
    await expect(db.transaction(tx => saveHelperAssignment(tx, { assignmentId: "eng-dev:ai1:qwen", stage: "ai1", deviceId: "eng-dev", model: "Qwen-X",
      shadowRouteId: "s", liveRouteId: "l", liveProvider: "local-direct" }, 1, "jr"))).rejects.toThrow("model_helper_invalid:assignmentId");
    await expect(db.transaction(tx => setHelperMode(tx, "eng-dev:ai1:qwen", "off", 1, "jr"))).rejects.toThrow("model_helper_invalid:assignmentId");
    expect((await listHelperAssignments()).map(row => row.assignmentId)).toEqual(["loc-dev:ai2"]);
    expect((await readModelAssignments()).map(row => row.assignmentId)).toEqual(["eng-dev:ai1:qwen", "loc-dev:ai2:deep"]);
  });

  it("checks cli contracts and connect equipment, votes only on ai2 rank 1, and stores local-direct contracts under their own route id", async () => {
    await unchanged(() => save({ assignmentId: "connect-dev:intro:opus", expectedVersion: null, stage: "intro", deviceId: "connect-dev",
      registryKey: "supa:review", transport: "cli" }), "model_assignment_invalid:transport");
    cliContract = null;
    await unchanged(() => save({ assignmentId: "connect-dev:intro:sonnet", expectedVersion: null, stage: "intro", deviceId: "connect-dev",
      registryKey: "connect:sonnet", transport: "cli" }), "model_assignment_refused:cli_contract_missing");
    cliContract = sonnet;
    const cli = await save({ assignmentId: "connect-dev:intro:sonnet", expectedVersion: null, stage: "intro", deviceId: "connect-dev",
      registryKey: "connect:sonnet", transport: "cli" });
    expect(cli).toMatchObject({ contract: { source: "cli", id: null }, route: { routeId: "product-intro-check", provider: "claude-cli", model: "sonnet",
      providerBudgetId: "connect", groupId: "connect-dev" } });
    expect(await contracts()).toEqual([]);                                                   // CLI contracts stay in CLI_SERVING_CONTRACTS
    await unchanged(() => save(engAi1({ vote: true })), "model_assignment_invalid:vote");
    // local-direct AI2 voter: a local-openai-chat-v1 contract under local-direct:second-review, providerBudgetId = backendId
    const voter = await save({ assignmentId: "loc-dev:ai2:deep", expectedVersion: null, stage: "ai2", deviceId: "loc-dev", registryKey: "loc:deep",
      transport: "local-direct", vote: true, mode: "live" });
    const [stored] = await contracts();
    expect(stored).toMatchObject({ route_id: "local-direct:second-review", model: "deep-1", transport: "direct", auth: "none" });
    const local = localModelServingContractSchema.parse(Object.fromEntries(Object.entries(stored.contract).filter(([key]) => key !== "routeId")));
    expect(stored.contract).toMatchObject({ routeId: "local-direct:second-review", protocol: "local-openai-chat-v1" });
    expect(local).toMatchObject({ backendId: "loc-deep", physicalGroup: "loc-dev", provider: "local-direct", endpoint: "http://loc.test:8010/v1/chat/completions",
      model: "deep-1", responseModel: "deep-1-served", totalTokenBound: 32_768, contextWindowTokens: 32_768, maxOutputTokens: 8_000 });
    expect(stored.contract_hash).toBe(localModelContractHash(local));
    expect(voter).toMatchObject({ route: { routeId: "second-review", provider: "local-direct", model: "deep-1", providerBudgetId: "loc-deep", groupId: "loc-dev" },
      after: { vote: true, rank: 1, transport: "local-direct" }, contract: { routeId: "local-direct:second-review", source: "probed" } });
    // the same model on another device cannot reuse that device-bound local contract
    await unchanged(() => save({ assignmentId: "eng-dev:ai2:deep", expectedVersion: null, stage: "ai2", deviceId: "eng-dev", registryKey: "loc:deep",
      transport: "local-direct" }), "model_assignment_refused:contract_device_mismatch");
    // a gateway-labelled wire name for the gateway transport
    const tagline = await save({ assignmentId: "eng-dev:tagline:mlx", expectedVersion: null, stage: "tagline", deviceId: "eng-dev", registryKey: "mlx:tagline",
      transport: "gateway" });
    expect(tagline.route).toEqual({ routeId: "crawl-tagline", provider: "abcllm", model: "[MLX] qwen3.6-35b-heretic", providerBudgetId: "mlx", groupId: "eng-dev" });
    expect((await contracts()).find(row => row.route_id === "crawl-tagline")).toMatchObject({ transport: "gateway", auth: "gateway", model: "[MLX] qwen3.6-35b-heretic" });
  });
});
