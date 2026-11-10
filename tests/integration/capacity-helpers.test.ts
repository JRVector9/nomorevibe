import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequest } from "@/lib/llm/capacity";
import { beginModelDispatch, cancelReservedModelSlot, markModelDispatchIndeterminate, requestModelSlot } from "@/lib/llm/capacity-repository";
import { deviceCandidateSql, type ModelCapacityGeneration } from "@/lib/llm/capacity-devices";
import { readModelCapacityDevice, readModelCapacityDeviceStates, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import { HELPER_MODE_AUDIT_ACTION, HELPER_SAVE_AUDIT_ACTION, SUPERVISOR_PRINCIPAL, SUPERVISOR_TOGGLE_AUDIT_ACTION, helperEvidenceKey,
  type HelperAssignmentRow } from "@/lib/llm/capacity-helpers";
import { HELPER_UNRESOLVED_CONTRACT_PREFIX, helperEvidencePartsFor, listHelperAssignments, readHelperGateStates, readHelperStatusSnapshot,
  saveHelperAssignment, setHelperMode, setSupervisorControl } from "@/lib/llm/capacity-helpers-repository";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import { TEST_DATABASE_URL } from "./setup";

/**
 * PR 2a(Layer B) 도우미 장부 핵심 — 자기 DB 를 만들어 끝까지 migrate 한다(공유 test DB 에 배정·신호·감시자 계정 행을 남기지 않는다).
 * 장비 helper-dev: 우선 own-primary(1), 자기 역할 own-secondary(2), 도우미 helper-live(3, fixture 공급자 — requestModelSlot 으로 실제 입장을 탄다),
 * 섀도 helper-shadow(4, local-direct — 2b 전에는 입장 경로가 없으므로 후보 SQL·상태로 본다). 다른 장비 other-dev 는 도우미가 없다.
 * 신호는 감시자 계정(nomorevibe_oracle_capacity_supervisor, 이 DB 에만 권한)으로 SET ROLE 해서 쓴다 — written_by 도장이 실제 계정을 찍는다.
 */
const name = `nomorevibe_test_helpers_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false, roleCreated = false;
const root = path.resolve(".");
const DEVICE = "helper-dev", OTHER = "other-dev", ASSIGNMENT = "helper-dev:ai1", BACKEND = "helper-backend";
const route = (routeId: string, provider = "fixture", groupId = DEVICE) =>
  ({ routeId, provider, model: "m", providerBudgetId: provider === "local-direct" ? BACKEND : "account", groupId });
const basePolicy: ModelCapacityPolicy = { version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [route("own-primary"), route("own-secondary"), route("helper-live"), route("helper-shadow", "local-direct"),
    route("alt-live"), route("alt-shadow", "local-direct"), route("other-route", "fixture", OTHER), route("other-shadow", "local-direct", OTHER)] };
const owner = { instanceId: `helpers-${randomUUID()}`, bootId: randomUUID() };
const ROLES = [{ routeId: "own-primary", rank: 1 }, { routeId: "own-secondary", rank: 2 }, { routeId: "helper-live", rank: 3 }, { routeId: "helper-shadow", rank: 4 }];
const assignmentInput = (overrides: Record<string, unknown> = {}) => ({ assignmentId: ASSIGNMENT, stage: "ai1", deviceId: DEVICE, model: "m",
  shadowRouteId: "helper-shadow", liveRouteId: "helper-live", liveProvider: "fixture", mode: "shadow", ...overrides });

const request = (routeId: string, overrides: Partial<ModelCapacityRequest> = {}): ModelCapacityRequest => ({ requestId: randomUUID(), workKey: randomUUID(), owner,
  class: "first", pool: "reviewer", routeId, provider: "fixture", model: "m", ...overrides });
async function granted(value: ModelCapacityRequest) {
  const result = await requestModelSlot(value);
  expect(result.kind, `${value.routeId} should be granted (${JSON.stringify(result)})`).toBe("granted");
  if (result.kind !== "granted") throw new Error("fixture_not_granted");
  return result.reservation;
}
const deferred = async (value: ModelCapacityRequest, reason: string) => expect(await requestModelSlot(value)).toEqual({ kind: "deferred", reason });
const ownRows = () => client<{ request_id: string; route_id: string; state: string }[]>`SELECT request_id, route_id, state FROM model_capacity_requests
  WHERE owner_instance_id = ${owner.instanceId} ORDER BY queue_ordinal`;
const eventsOf = (requestId: string) => client<{ kind: string }[]>`SELECT kind FROM model_capacity_events WHERE request_id = ${requestId} ORDER BY id`;
const stateOf = async (deviceId: string) => (await readModelCapacityDeviceStates()).find(state => state.deviceId === deviceId);
const generation = async (): Promise<ModelCapacityGeneration> => {
  const [row] = await client<{ epoch: number; revision: number; policy_hash: string }[]>`SELECT epoch::int, revision::int, policy_hash FROM model_capacity_control WHERE id = 1`;
  return { epoch: row.epoch, revision: row.revision, policyHash: row.policy_hash };
};
const candidate = async (deviceId: string) => {
  const gen = await generation();
  return db.transaction(async tx => (await tx.execute<{ request_id: string }>(deviceCandidateSql(deviceId, gen, "{}", 0)))[0]?.request_id ?? null);
};
async function installPolicy(value: ModelCapacityPolicy) {
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(value)}::jsonb, policy_hash = ${modelCapacityPolicyHash(value)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
}
type Settings = { limitSlots: number; secondaryCap: number; idleMs: number; reserveSlots: number; roles: { routeId: string; rank: number }[] };
async function configure(deviceId: string, settings: Partial<Settings> = {}) {
  const current = await readModelCapacityDevice(deviceId);
  const input = { deviceId, limitSlots: 1, secondaryCap: 0, idleMs: 0, reserveSlots: 0, roles: deviceId === DEVICE ? ROLES : [], physicalLimit: null, note: null, ...settings };
  return db.transaction(tx => saveModelCapacityDevice(tx, input, current?.version ?? null, "helpers-test"));
}
const save = (input: unknown, expectedVersion: number | null, env: Record<string, string | undefined> = {}, actor = "jr") =>
  db.transaction(tx => saveHelperAssignment(tx, input, expectedVersion, actor, { env }));
const assignment = async (id = ASSIGNMENT) => (await listHelperAssignments()).find(row => row.assignmentId === id)!;
/** PR 2c 의 promote 경로를 흉내 낸다(승격 기록 + mode 'live', version 그대로). */
const promote = (id = ASSIGNMENT) => client`UPDATE model_helper_assignments SET mode = 'live', promoted_at = clock_timestamp(),
  promoted_evidence = ${JSON.stringify({ fixture: true })}::jsonb, promoted_by = 'promote-fixture' WHERE assignment_id = ${id}`;

/** 감시자 계정으로 한 TX 를 돈다(SET LOCAL ROLE): current_user 가 그 계정이 되어 written_by 도장이 실제 principal 을 찍는다. */
const asSupervisor = <T>(load: (tx: postgres.TransactionSql) => Promise<T>) => client.begin(async tx => {
  await tx.unsafe(`SET LOCAL ROLE ${SUPERVISOR_PRINCIPAL}`);
  return load(tx);
}) as Promise<T>;
async function supervisor(value: { enabled?: boolean; epoch?: number; leaseMs?: number; principal?: string } = {}) {
  await client`UPDATE model_supervisor_control SET enabled = ${value.enabled ?? true}, epoch = ${value.epoch ?? 7},
    lease_until = clock_timestamp() + ${value.leaseMs ?? 60_000} * interval '1 millisecond', signal_principal = ${value.principal ?? SUPERVISOR_PRINCIPAL}
    WHERE id = 1`;
}
type Signal = { version?: number; epoch?: number; verdict?: "help" | "shadow_only" | "hold"; ttlMs?: number; id?: string; asOwner?: boolean };
async function signal(value: Signal = {}) {
  const id = value.id ?? ASSIGNMENT, version = value.version ?? (await assignment(id)).version;
  const write = (tx: postgres.TransactionSql | postgres.Sql) => tx`INSERT INTO model_helper_signals (assignment_id, assignment_version, supervisor_epoch, verdict, reason,
      streak, state_since, metrics, observed_at, valid_until, written_by)
    VALUES (${id}, ${version}, ${value.epoch ?? 7}, ${value.verdict ?? "help"}, 'primary_full', 0, clock_timestamp(), ${JSON.stringify({ fixture: 1 })}::jsonb,
      clock_timestamp(), clock_timestamp() + ${value.ttlMs ?? 30_000} * interval '1 millisecond', 'forged')
    ON CONFLICT (assignment_id) DO UPDATE SET assignment_version = excluded.assignment_version, supervisor_epoch = excluded.supervisor_epoch,
      verdict = excluded.verdict, reason = excluded.reason, valid_until = excluded.valid_until, written_by = excluded.written_by`;
  if (value.asOwner) await write(client); else await asSupervisor(write);
}
async function demand(value: { on?: boolean; epoch?: number; ttlMs?: number; asOwner?: boolean } = {}) {
  const write = (tx: postgres.TransactionSql | postgres.Sql) => tx`INSERT INTO model_device_signals (device_id, supervisor_epoch, primary_demand, backlog, metrics,
      observed_at, valid_until, written_by)
    VALUES (${DEVICE}, ${value.epoch ?? 7}, ${value.on ?? true}, 3, ${JSON.stringify({ reason: "fresh" })}::jsonb, clock_timestamp(),
      clock_timestamp() + ${value.ttlMs ?? 30_000} * interval '1 millisecond', 'forged')
    ON CONFLICT (device_id) DO UPDATE SET supervisor_epoch = excluded.supervisor_epoch, primary_demand = excluded.primary_demand,
      valid_until = excluded.valid_until`;
  if (value.asOwner) await write(client); else await asSupervisor(write);
}
const stop = (effect: "stop" | "demote_to_shadow", version: number, id = ASSIGNMENT) => asSupervisor(tx => tx`INSERT INTO model_helper_stops
  (assignment_id, assignment_version, effect, reason, evidence) VALUES (${id}, ${version}, ${effect}, 'unknown_rate', ${JSON.stringify({ n: 10 })}::jsonb)`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 도우미 표·장부를 이 DB 에서만 비운다(정지 행·event 는 append-only 트리거가 잠그므로 잠깐 풀었다가 다시 건다). */
async function clearAll() {
  await client.begin(async tx => {
    const mine = tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id = ${owner.instanceId}`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id IN (${mine})`;
    await tx`DELETE FROM model_capacity_requests WHERE owner_instance_id = ${owner.instanceId}`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`ALTER TABLE model_helper_stops DISABLE TRIGGER USER`;
    await tx`DELETE FROM model_helper_stops`;
    await tx`ALTER TABLE model_helper_stops ENABLE TRIGGER USER`;
    await tx`DELETE FROM model_helper_signals`;
    await tx`DELETE FROM model_device_signals`;
    await tx`DELETE FROM model_role_demand`;
    await tx`DELETE FROM model_helper_assignments`;
    await tx`INSERT INTO model_supervisor_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
    await tx`UPDATE model_supervisor_control SET enabled = false, epoch = 0, lease_until = NULL, signal_principal = ${SUPERVISOR_PRINCIPAL},
      signal_ttl_ms = 45000, loop_ms = 15000 WHERE id = 1`;
    await tx`UPDATE dr_writer_fence SET state = 'active', reason = NULL, fenced_db = NULL WHERE id = 1`;
  });
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  // 감시자 계정: 클러스터 전역 이름이라 남은 것이 있으면 지우고(다른 DB 권한이 없을 때만 지워진다) 이 DB 에만 권한을 준다
  if ((await admin`SELECT 1 FROM pg_roles WHERE rolname = ${SUPERVISOR_PRINCIPAL}`).length) {
    await admin.unsafe(`DROP OWNED BY ${SUPERVISOR_PRINCIPAL}`); await admin.unsafe(`DROP ROLE ${SUPERVISOR_PRINCIPAL}`);
  }
  await admin.unsafe(`CREATE ROLE ${SUPERVISOR_PRINCIPAL} NOLOGIN NOSUPERUSER NOBYPASSRLS`); roleCreated = true;
  await client.unsafe(`GRANT SELECT, INSERT, UPDATE ON model_helper_signals, model_device_signals, model_role_demand, operations_observations TO ${SUPERVISOR_PRINCIPAL}`);
  await client.unsafe(`GRANT SELECT, INSERT ON model_helper_stops TO ${SUPERVISOR_PRINCIPAL}`);
  await client.unsafe(`GRANT USAGE ON SEQUENCE model_helper_stops_id_seq TO ${SUPERVISOR_PRINCIPAL}`);
  await installPolicy(basePolicy);
  await configure(DEVICE);
  await configure(OTHER, { limitSlots: 4, secondaryCap: 4 });
}, 180_000);
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 });
  if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  if (roleCreated) await admin.unsafe(`DROP ROLE IF EXISTS ${SUPERVISOR_PRINCIPAL}`);
  await admin.end({ timeout: 3 });
});
/** 감사 표는 지울 수 없으므로(0056) 시험마다 그 시험이 쓴 줄만 본다. */
let auditFloor = 0;
const audits = <T>(action: string) => client<(T & { target: string })[]>`SELECT target, detail FROM operations_audit
  WHERE action = ${action} AND id > ${auditFloor} ORDER BY id`;
beforeEach(async () => {
  await clearAll(); await installPolicy(basePolicy); await configure(DEVICE);
  auditFloor = Number((await client`SELECT coalesce(max(id), 0) AS id FROM operations_audit`)[0].id);
});
afterEach(clearAll);

/** live 배정 + 살아 있는 감시자 + 신선한 help 신호: 도우미 live 경로가 열린 상태. */
async function openLiveHelper(maxSlots = 1): Promise<HelperAssignmentRow> {
  await save(assignmentInput({ maxSlots }), null);
  await promote();
  await supervisor();
  await signal();
  return assignment();
}

describe("assignment save (WP-2a-A repository)", () => {
  it("creates at version 1, bumps on every save, keeps the evidence for threshold edits and audits once per save", async () => {
    const { before, after } = await save(assignmentInput({ mode: "off" }), null);
    expect(before).toBeNull();
    expect(after).toMatchObject({ assignmentId: ASSIGNMENT, stage: "ai1", deviceId: DEVICE, mode: "off", version: 1, maxSlots: 1, minAgreement: 0.95,
      promotedAt: null, updatedBy: "jr" });
    const parts = { stage: "ai1", model: "m", promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
      wireVariant: "no_response_format", contractHash: `${HELPER_UNRESOLVED_CONTRACT_PREFIX}${BACKEND}` } as const;
    expect(await helperEvidencePartsFor({ stage: "ai1", deviceId: DEVICE, model: "m" }, BACKEND, {})).toEqual(parts);
    expect(after.evidenceKey).toBe(helperEvidenceKey(parts));
    const second = await save(assignmentInput({ mode: "shadow", minAgreement: 0.975, note: "더 엄격하게" }), 1);
    expect(second.before?.version).toBe(1);
    expect(second.after).toMatchObject({ version: 2, mode: "shadow", minAgreement: 0.975, note: "더 엄격하게", evidenceKey: after.evidenceKey });
    const saves = await audits<{ detail: { version: number; expectedVersion: number | null } }>(HELPER_SAVE_AUDIT_ACTION);
    expect(saves.map(row => [row.target, row.detail.version, row.detail.expectedVersion])).toEqual([[ASSIGNMENT, 1, null], [ASSIGNMENT, 2, 1]]);
  });

  it("refuses a stale or unexpected version, bad input and every save refusal without touching the row or the audit", async () => {
    await save(assignmentInput(), null);
    const auditCount = async () => (await audits(HELPER_SAVE_AUDIT_ACTION)).length;
    const audited = await auditCount();
    const refused = async (input: unknown, expected: number | null, code: string) => expect(save(input, expected)).rejects.toThrow(code);
    await refused(assignmentInput(), null, "model_helper_version_mismatch:1");                 // a row exists: null is not "new"
    await refused(assignmentInput(), 2, "model_helper_version_mismatch:1");
    await refused(assignmentInput({ assignmentId: "helper-dev:other", stage: "ai2", liveRouteId: "alt-live", shadowRouteId: "alt-shadow" }), 1,
      "model_helper_version_mismatch:none");
    await refused(assignmentInput({ maxSlots: 0 }), 1, "model_helper_invalid:maxSlots");
    await refused(assignmentInput({ stage: "ai2" }), 1, "model_helper_invalid:stage");          // id names device × stage
    await refused(assignmentInput({ deviceId: OTHER, shadowRouteId: "other-shadow", liveRouteId: "other-route" }), 1, "model_helper_invalid:deviceId");
    await refused(assignmentInput({ liveRouteId: "missing-route" }), 1, "model_helper_refused:helper_route_unmapped");
    await refused(assignmentInput({ liveRouteId: "other-route" }), 1, "model_helper_refused:helper_route_unmapped");   // on another device
    await refused(assignmentInput({ liveRouteId: "own-primary" }), 1, "model_helper_refused:helper_route_is_primary");
    await refused(assignmentInput({ mode: "live" }), 1, "model_helper_refused:helper_live_requires_promotion");
    // a second assignment on the device may not reuse the first one's route identities
    await refused({ ...assignmentInput({ assignmentId: "helper-dev:ai2", stage: "ai2", shadowRouteId: "alt-shadow" }) }, null, "model_helper_invalid:liveRouteId");
    await refused({ ...assignmentInput({ assignmentId: "helper-dev:ai2", stage: "ai2", liveRouteId: "alt-live" }) }, null, "model_helper_invalid:shadowRouteId");
    await client`UPDATE model_capacity_devices SET enabled = false WHERE device_id = ${DEVICE}`;
    await refused(assignmentInput(), 1, "model_helper_refused:helper_device_unconfigured");
    await client`UPDATE model_capacity_devices SET enabled = true WHERE device_id = ${DEVICE}`;
    await expect(save(assignmentInput(), 1, {}, " ")).rejects.toThrow("model_helper_invalid:actor");
    expect(await assignment()).toMatchObject({ version: 1, mode: "shadow", liveRouteId: "helper-live" });
    expect(await auditCount()).toBe(audited);
    // a different stage on the same device saves (alt routes), refuses ai2 live without promotion and without the fallback voter
    const ai2 = await save(assignmentInput({ assignmentId: "helper-dev:ai2", stage: "ai2", liveRouteId: "alt-live", shadowRouteId: "alt-shadow" }), null);
    expect(ai2.after.version).toBe(1);
    await promote("helper-dev:ai2");
    await expect(save(assignmentInput({ assignmentId: "helper-dev:ai2", stage: "ai2", liveRouteId: "alt-live", shadowRouteId: "alt-shadow", mode: "live" }), 1))
      .rejects.toThrow("model_helper_refused:helper_ai2_voter_not_in_fallbacks");
  });

  it("keeps a promoted live row live on an unchanged-evidence re-save, and drops it to shadow when the evidence changes", async () => {
    await save(assignmentInput(), null);
    await promote();
    const kept = await save(assignmentInput({ mode: "live", perTick: 3 }), 1);
    expect(kept.after).toMatchObject({ mode: "live", version: 2, perTick: 3, promotedBy: "promote-fixture" });
    expect(kept.after.promotedAt).not.toBeNull();
    // a verified contract for the shadow backend changes the contract hash and the wire variant → new evidence_key
    const contract: LocalModelServingContract = { version: 1, protocol: "local-openai-chat-v1", backendId: BACKEND, provider: "local-direct",
      physicalGroup: DEVICE, endpoint: "http://127.0.0.1:9/v1/chat/completions", model: "m", responseModel: "m", modelFamily: "fixture",
      deploymentRevision: "r1", contextWindowTokens: 8192, totalTokenBound: 8192, maxOutputTokens: 1024, maxInputBytes: 65_536,
      capabilities: { vision: false, jsonSchema: true }, thinking: { mode: "disabled", parameter: "none" }, termination: { kind: "response_only" } };
    const env = { LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([contract]) };
    const parts = await helperEvidencePartsFor({ stage: "ai1", deviceId: DEVICE, model: "m" }, BACKEND, env);
    expect(parts).toMatchObject({ wireVariant: "json_schema", contractHash: localModelContractHash(contract) });
    const demoted = await save(assignmentInput({ mode: "live" }), 2, env);
    expect(demoted.after).toMatchObject({ mode: "shadow", version: 3, evidenceKey: helperEvidenceKey(parts), promotedAt: null, promotedBy: null });
    const saves = await audits<{ detail: { evidenceChanged: boolean; modeDemoted: boolean } }>(HELPER_SAVE_AUDIT_ACTION);
    expect(saves.map(row => [row.detail.evidenceChanged, row.detail.modeDemoted])).toEqual([[false, false], [false, false], [true, true]]);
  });

  it("changes only the mode (and version) with setHelperMode; off always works, shadow re-validates the routes", async () => {
    await save(assignmentInput(), null);
    await promote();
    const off = await db.transaction(tx => setHelperMode(tx, ASSIGNMENT, "off", 1, "jr"));
    expect(off.before.mode).toBe("live");
    expect(off.after).toMatchObject({ mode: "off", version: 2, evidenceKey: off.before.evidenceKey, promotedBy: "promote-fixture" });
    await expect(db.transaction(tx => setHelperMode(tx, ASSIGNMENT, "shadow", 1, "jr"))).rejects.toThrow("model_helper_version_mismatch:2");
    await expect(db.transaction(tx => setHelperMode(tx, "helper-dev:none", "off", 1, "jr"))).rejects.toThrow("model_helper_version_mismatch:none");
    // the policy no longer maps the helper routes: shadow is refused, off still works
    await installPolicy({ ...basePolicy, routes: basePolicy.routes.filter(value => value.routeId !== "helper-live") });
    await expect(db.transaction(tx => setHelperMode(tx, ASSIGNMENT, "shadow", 2, "jr"))).rejects.toThrow("model_helper_refused:helper_route_unmapped");
    expect((await db.transaction(tx => setHelperMode(tx, ASSIGNMENT, "off", 2, "jr"))).after.version).toBe(3);
    const modes = await audits<{ detail: { from: string; to: string } }>(HELPER_MODE_AUDIT_ACTION);
    expect(modes.map(row => [row.target, row.detail.from, row.detail.to])).toEqual([[ASSIGNMENT, "live", "off"], [ASSIGNMENT, "off", "off"]]);
  });

  it("refuses every write on a fenced DB before reading anything", async () => {
    await client`UPDATE dr_writer_fence SET state = 'fenced', reason = 'operator_fence', fenced_db = jsonb_build_object(
      'systemIdentifier', (SELECT system_identifier::text FROM pg_control_system()),
      'databaseOid', (SELECT oid::text FROM pg_database WHERE datname = current_database()), 'databaseName', current_database()) WHERE id = 1`;
    await expect(save(assignmentInput(), null)).rejects.toBeInstanceOf(DrWriterFencedError);
    await expect(db.transaction(tx => setSupervisorControl(tx, { enabled: true }, "jr"))).rejects.toBeInstanceOf(DrWriterFencedError);
    expect(await listHelperAssignments()).toEqual([]);
  });

  it("toggles the supervisor switch and timing with one audit row, never touching the lease columns", async () => {
    await client`UPDATE model_supervisor_control SET epoch = 4, owner_instance_id = 'oracle-1', lease_until = clock_timestamp() + interval '1 minute' WHERE id = 1`;
    await db.transaction(tx => setSupervisorControl(tx, { enabled: true, signalTtlMs: 60_000 }, "jr"));
    let [row] = await client`SELECT enabled, signal_ttl_ms, loop_ms, epoch::int, owner_instance_id, updated_by FROM model_supervisor_control WHERE id = 1`;
    expect(row).toMatchObject({ enabled: true, signal_ttl_ms: 60_000, loop_ms: 15_000, epoch: 4, owner_instance_id: "oracle-1", updated_by: "jr" });
    await expect(db.transaction(tx => setSupervisorControl(tx, { loopMs: 40_000 }, "jr"))).rejects.toThrow("model_supervisor_invalid:loopMs");
    await expect(db.transaction(tx => setSupervisorControl(tx, { epoch: 9 } as never, "jr"))).rejects.toThrow("model_supervisor_invalid:root");
    await expect(db.transaction(tx => setSupervisorControl(tx, { signalTtlMs: 1 }, "jr"))).rejects.toThrow("model_supervisor_invalid:signalTtlMs");
    await db.transaction(tx => setSupervisorControl(tx, { enabled: false }, "jr"));
    [row] = await client`SELECT enabled, signal_ttl_ms FROM model_supervisor_control WHERE id = 1`;
    expect(row).toMatchObject({ enabled: false, signal_ttl_ms: 60_000 });
    const toggles = await audits<{ detail: { before: { enabled: boolean }; after: { enabled: boolean } } }>(SUPERVISOR_TOGGLE_AUDIT_ACTION);
    expect(toggles.map(audit => [audit.target, audit.detail.before.enabled, audit.detail.after.enabled]))
      .toEqual([["model_supervisor_control", false, true], ["model_supervisor_control", true, false]]);
    await client`DELETE FROM model_supervisor_control`;
    await expect(db.transaction(tx => setSupervisorControl(tx, { enabled: true }, "jr"))).rejects.toThrow("model_supervisor_control_missing");
    await expect(readHelperStatusSnapshot()).rejects.toThrow("model_supervisor_control_missing");
  });

  it("reads one consistent status snapshot with only the current version's stops", async () => {
    const live = await openLiveHelper();
    await stop("stop", live.version);
    await demand();
    await client`INSERT INTO model_role_demand (role_id, device_id, backlog, metrics, observed_at, valid_until, written_by)
      VALUES ('human-review', ${DEVICE}, 2, ${JSON.stringify({ devices: ["m3"] })}::jsonb, clock_timestamp(), clock_timestamp() + interval '1 minute', 'forged')`;
    const snapshot = await readHelperStatusSnapshot();
    expect(snapshot.control).toMatchObject({ enabled: true, epoch: 7, signalPrincipal: SUPERVISOR_PRINCIPAL });
    expect(snapshot.assignments.map(row => [row.assignmentId, row.mode])).toEqual([[ASSIGNMENT, "live"]]);
    expect(snapshot.signals).toHaveLength(1);
    expect(snapshot.signals[0]).toMatchObject({ assignmentId: ASSIGNMENT, verdict: "help", supervisorEpoch: 7, writtenBy: SUPERVISOR_PRINCIPAL });
    expect(snapshot.stops.map(row => [row.effect, row.assignmentVersion])).toEqual([["stop", 1]]);   // version 1 is current
    expect(snapshot.deviceSignals).toMatchObject([{ deviceId: DEVICE, primaryDemand: true, writtenBy: SUPERVISOR_PRINCIPAL }]);
    expect(snapshot.roleDemand).toMatchObject([{ roleId: "human-review", backlog: 2, writtenBy: "nomorevibe" }]);
    expect(snapshot.gates.map(gate => [gate.kind, gate.ok])).toEqual([["live", false], ["shadow", false]]);   // the stop closes both
    expect(Math.abs(snapshot.nowMs - Date.now())).toBeLessThan(60_000);
    // re-saving bumps the version: the stop no longer applies and drops out of the snapshot
    await save(assignmentInput({ mode: "live" }), live.version);
    await signal();
    const next = await readHelperStatusSnapshot();
    expect(next.stops).toEqual([]);
    expect(next.gates.map(gate => [gate.kind, gate.ok])).toEqual([["live", true], ["shadow", true]]);
    expect(await readHelperGateStates()).toEqual(next.gates);
    expect(await readHelperGateStates(DEVICE)).toEqual(next.gates);
    expect(await readHelperGateStates(OTHER)).toEqual([]);
  });
});

describe("triggers (0154)", () => {
  it("stamps written_by and observed_at on every signal write and bounds valid_until by the TTL CHECK", async () => {
    await save(assignmentInput(), null);
    await client`INSERT INTO model_helper_signals (assignment_id, assignment_version, supervisor_epoch, verdict, reason, state_since, metrics, observed_at, valid_until, written_by)
      VALUES (${ASSIGNMENT}, 1, 1, 'help', 'primary_full', clock_timestamp(), '{}'::jsonb, '2000-01-01T00:00:00Z', clock_timestamp() + interval '30 seconds', ${SUPERVISOR_PRINCIPAL})`;
    const [row] = await client<{ written_by: string; age_ms: number }[]>`SELECT written_by, (extract(epoch FROM clock_timestamp() - observed_at) * 1000)::int AS age_ms
      FROM model_helper_signals WHERE assignment_id = ${ASSIGNMENT}`;
    expect(row.written_by).toBe("nomorevibe");                  // the forged principal is replaced by the real writer
    expect(row.age_ms).toBeGreaterThanOrEqual(0);
    expect(row.age_ms).toBeLessThan(10_000);                    // not backdated to 2000
    await signal();                                             // UPDATE path as the supervisor role restamps
    expect((await client`SELECT written_by FROM model_helper_signals`)[0].written_by).toBe(SUPERVISOR_PRINCIPAL);
    await expect(client`UPDATE model_helper_signals SET valid_until = clock_timestamp() + interval '6 minutes'`).rejects.toMatchObject({ code: "23514" });
    for (const table of ["model_device_signals", "model_role_demand"] as const) {
      const insert = table === "model_device_signals"
        ? client`INSERT INTO model_device_signals (device_id, supervisor_epoch, primary_demand, backlog, metrics, observed_at, valid_until, written_by)
            VALUES (${DEVICE}, 1, true, 1, '{}'::jsonb, '2000-01-01T00:00:00Z', clock_timestamp() + interval '1 minute', 'forged')`
        : client`INSERT INTO model_role_demand (role_id, device_id, backlog, metrics, observed_at, valid_until, written_by)
            VALUES ('ai1', 'ai1-pool', 1, '{}'::jsonb, '2000-01-01T00:00:00Z', clock_timestamp() + interval '1 minute', 'forged')`;
      await insert;
      const [stamped] = await client.unsafe(`SELECT written_by, observed_at > clock_timestamp() - interval '10 seconds' AS fresh FROM ${table}`);
      expect(stamped, table).toMatchObject({ written_by: "nomorevibe", fresh: true });
      await expect(client.unsafe(`UPDATE ${table} SET valid_until = clock_timestamp() + interval '10 minutes'`)).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("keeps model_helper_stops append-only (update, delete, truncate and the assignment cascade all raise 42501) and stamps the writer", async () => {
    await save(assignmentInput(), null);
    await client`INSERT INTO model_helper_stops (assignment_id, assignment_version, effect, reason, evidence, written_by, created_at)
      VALUES (${ASSIGNMENT}, 1, 'stop', 'unknown_rate', '{}'::jsonb, 'forged', '2000-01-01T00:00:00Z')`;
    const [row] = await client`SELECT written_by, created_at > clock_timestamp() - interval '10 seconds' AS fresh FROM model_helper_stops`;
    expect(row).toMatchObject({ written_by: "nomorevibe", fresh: true });
    for (const statement of ["UPDATE model_helper_stops SET reason = 'other'", "DELETE FROM model_helper_stops", "TRUNCATE model_helper_stops",
      `DELETE FROM model_helper_assignments WHERE assignment_id = '${ASSIGNMENT}'`]) {
      await expect(client.unsafe(statement), statement).rejects.toMatchObject({ code: "42501" });
    }
    expect(await client`SELECT id FROM model_helper_stops`).toHaveLength(1);
  });

  it("limits the supervisor principal's observation keys to its own consumer keys", async () => {
    const observe = (key: string) => asSupervisor(tx => tx`INSERT INTO operations_observations (key, value, observed_at)
      VALUES (${key}, ${JSON.stringify({ probe: true })}::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
    await observe("service:maintenance:capacity-supervisor-consumer-oracle");
    await observe("capacity-supervisor:capacity-supervisor-consumer-oracle");
    await observe(`capacity-supervisor:capacity-supervisor-consumer-${"x".repeat(19)}`);
    for (const key of ["service:maintenance:m3-maintenance", `capacity-supervisor:capacity-supervisor-consumer-${"x".repeat(20)}`, "job:uptime-ping",
      "service:maintenance:uptime-consumer-oracle"]) await expect(observe(key), key).rejects.toMatchObject({ code: "42501" });
    await client`DELETE FROM operations_observations WHERE key LIKE '%capacity-supervisor-consumer-%'`;
  });
});

describe("Layer A gate (requestSlot early refusal)", () => {
  it("refuses a helper request as helper_ineligible without a row or an event for every closed-gate reason, and admits it with a fresh signal", async () => {
    const live = await openLiveHelper();
    const liveOk = async () => (await readHelperGateStates(DEVICE)).find(gate => gate.kind === "live")?.ok;
    const closed = async (label: string, setup: () => Promise<unknown>) => {
      expect(await liveOk(), `${label}: starts open`).toBe(true);   // each case closes the gate for its own reason only
      await setup();
      expect(await liveOk(), label).toBe(false);
      const value = request("helper-live");
      expect(await requestModelSlot(value), label).toEqual({ kind: "deferred", reason: "helper_ineligible" });
      expect(await eventsOf(value.requestId), label).toEqual([]);
      expect(await ownRows(), label).toEqual([]);
      await supervisor(); await signal(); await client`UPDATE model_helper_assignments SET mode = 'live' WHERE assignment_id = ${ASSIGNMENT}`;
    };
    await closed("no signal row", () => client`DELETE FROM model_helper_signals`);
    await closed("stale signal", async () => { await signal({ ttlMs: 150 }); await sleep(300); });
    await closed("wrong version", () => signal({ version: live.version + 1 }));
    await closed("wrong epoch", () => signal({ epoch: 6 }));
    await closed("written by another principal", () => signal({ asOwner: true }));
    await closed("principal changed in control", () => supervisor({ principal: "nomorevibe" }));
    await closed("kill switch off", () => supervisor({ enabled: false }));
    await closed("lease expired", () => supervisor({ leaseMs: -1_000 }));
    await closed("supervisor control row missing", () => client`DELETE FROM model_supervisor_control`);
    await client`INSERT INTO model_supervisor_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING`; await supervisor();
    await closed("verdict shadow_only on the live route", () => signal({ verdict: "shadow_only" }));
    await closed("verdict hold", () => signal({ verdict: "hold" }));
    await closed("live route in shadow mode", () => client`UPDATE model_helper_assignments SET mode = 'shadow' WHERE assignment_id = ${ASSIGNMENT}`);
    await closed("mode off", () => client`UPDATE model_helper_assignments SET mode = 'off' WHERE assignment_id = ${ASSIGNMENT}`);
    await closed("demote_to_shadow stop closes the live route", () => stop("demote_to_shadow", live.version));
    // the stops are for the current version: both close; a re-save (version + 1) clears them
    expect((await readHelperGateStates(DEVICE)).map(gate => [gate.kind, gate.ok])).toEqual([["live", false], ["shadow", true]]);
    await stop("stop", live.version);
    expect((await readHelperGateStates(DEVICE)).map(gate => [gate.kind, gate.ok])).toEqual([["live", false], ["shadow", false]]);
    await deferred(request("helper-live"), "helper_ineligible");
    const resaved = await save(assignmentInput({ mode: "live" }), live.version);
    await signal({ version: resaved.after.version });
    await granted(request("helper-live"));
  });

  it("holds helper occupancy to max_slots; an indeterminate helper row holds it for the unknown hold window (2026-11-10), none with a window of 0", async () => {
    await configure(DEVICE, { limitSlots: 3, secondaryCap: 0 });
    await openLiveHelper(1);
    const first = await granted(request("helper-live"));
    await deferred(request("helper-live"), "helper_ineligible");                  // active 1 >= max_slots 1
    expect((await readHelperGateStates(DEVICE)).find(gate => gate.kind === "live")).toMatchObject({ ok: true, active: 1, maxSlots: 1 });
    const begun = await beginModelDispatch(first);
    if (begun.kind !== "dispatched") throw new Error("fixture_dispatch");
    expect(await markModelDispatchIndeterminate(begun.dispatch, "transport_unknown")).toBe(true);
    // 기본 유지 시간(600초) 안: 미확정 도우미 행이 배정 칸을 계속 쥔다
    expect((await readHelperGateStates(DEVICE)).find(gate => gate.kind === "live")).toMatchObject({ active: 1 });
    await deferred(request("helper-live"), "helper_ineligible");
    expect(await stateOf(DEVICE)).toMatchObject({ active: 1, heldUnknown: 1 });
    await client`UPDATE runtime_settings SET values = jsonb_set(values, '{capacity}', '{"unknownHoldSeconds":0}'::jsonb) WHERE id = 1`;
    try {
      // 유지 시간 0(10-30 규칙): 미확정 행은 점유가 아니다
      expect((await readHelperGateStates(DEVICE)).find(gate => gate.kind === "live")).toMatchObject({ active: 0 });
      await granted(request("helper-live"));
      expect(await stateOf(DEVICE)).toMatchObject({ active: 1, heldUnknown: 0, secondaryActive: 1, primaryBusy: false });
    } finally { await client`UPDATE runtime_settings SET values = values - 'capacity' WHERE id = 1`; }
  });

  it("is grant-or-nothing: a helper that is not granted in its pass leaves no waiting row", async () => {
    await openLiveHelper();
    const blocker = await granted(request("own-secondary"));                       // the only slot (lending: the primary is idle)
    const helper = request("helper-live");
    await deferred(helper, "capacity");
    expect((await ownRows()).filter(row => row.state === "waiting")).toEqual([]);
    expect((await ownRows()).find(row => row.request_id === helper.requestId)?.state).toBe("withdrawn");
    expect((await eventsOf(helper.requestId)).map(event => event.kind)).toEqual(["queued", "wait_cancelled"]);
    expect(await stateOf(DEVICE)).toMatchObject({ waiting: 0, active: 1 });
    expect(await cancelReservedModelSlot(blocker)).toBe(true);
    await granted(request("helper-live"));
  });

  it("never ranks a helper above the device's own roles, even with a stale rank-1 role row on the helper route", async () => {
    await openLiveHelper();
    const blocker = await granted(request("own-secondary"));
    const waitingOwn = request("own-secondary");
    await deferred(waitingOwn, "capacity");                                      // own role waits (not a helper: it stays waiting)
    expect(await cancelReservedModelSlot(blocker)).toBe(true);
    const helper = request("helper-live");
    await deferred(helper, "capacity");                                          // the helper's own pass grants the waiting own role first
    expect((await ownRows()).filter(row => row.state === "reserved").map(row => row.request_id)).toEqual([waitingOwn.requestId]);
    expect((await ownRows()).find(row => row.request_id === helper.requestId)?.state).toBe("withdrawn");
    // an older waiting helper row (written outside requestSlot) still sorts after a newer own-role row
    await clearAll(); await openLiveHelper();
    const gen = await generation();
    const rawHelper = randomUUID(), rawOwn = randomUUID();
    for (const [id, routeId] of [[rawHelper, "helper-live"], [rawOwn, "own-secondary"]] as const) {
      await client`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
          provider_budget_id, group_id, epoch, revision, policy_hash, state, queue_until)
        VALUES (${id}, ${`raw-${id}`}, ${owner.instanceId}, ${owner.bootId}, 'first', 'reviewer', ${routeId}, 'fixture', 'm', 'account', ${DEVICE},
          ${gen.epoch}, ${gen.revision}, ${gen.policyHash}, 'waiting', clock_timestamp() + interval '1 minute')`;
    }
    expect(await candidate(DEVICE)).toBe(rawOwn);
    await client`DELETE FROM model_capacity_requests WHERE request_id = ${rawOwn}`;
    expect(await candidate(DEVICE)).toBe(rawHelper);
    await client`DELETE FROM model_capacity_requests WHERE request_id = ${rawHelper}`;
    // a rank-1 role row on the helper route gives it no primary bypass: while the primary is busy (cap 0) the helper is not granted
    await configure(DEVICE, { limitSlots: 2, secondaryCap: 0, roles: [{ routeId: "own-primary", rank: 1 }, { routeId: "helper-live", rank: 1 }] });
    await granted(request("own-primary"));
    await deferred(request("helper-live"), "capacity");
    expect(await stateOf(DEVICE)).toMatchObject({ primaryBusy: true, waitingPrimary: 0, waiting: 0 });
    await granted(request("own-primary"));                                      // the real primary still takes the second slot
  });

  it("never blocks primary work through any helper or supervisor state", async () => {
    const live = await openLiveHelper();
    const primaryGranted = async (label: string, setup: () => Promise<unknown>) => {
      await setup();
      const reservation = await granted(request("own-primary"));
      expect(await cancelReservedModelSlot(reservation), label).toBe(true);
    };
    await primaryGranted("fresh help signal", async () => undefined);
    await primaryGranted("stop row", () => stop("stop", live.version));
    await primaryGranted("fresh primary demand", () => demand());
    await primaryGranted("stale signals", async () => { await signal({ ttlMs: 100 }); await demand({ ttlMs: 100 }); await sleep(200); });
    await primaryGranted("wrong principal", () => supervisor({ principal: "nomorevibe" }));
    await primaryGranted("kill switch off", () => supervisor({ enabled: false }));
    await primaryGranted("supervisor control row missing", () => client`DELETE FROM model_supervisor_control`);
    await primaryGranted("on another device with no assignment", async () => {
      expect((await requestModelSlot(request("other-route"))).kind).toBe("granted");
    });
  });

  it("ends lending on a fresh primary_demand and ignores a stale, foreign or old-epoch one", async () => {
    await configure(DEVICE, { limitSlots: 2, secondaryCap: 0 });
    await supervisor();
    const lent = await granted(request("own-secondary"));                        // primary idle: lending
    expect(await stateOf(DEVICE)).toMatchObject({ primaryBusy: false, secondaryBound: 2, lending: true });
    await demand();
    expect(await stateOf(DEVICE)).toMatchObject({ primaryBusy: true, secondaryBound: 0, lending: false });
    await deferred(request("own-secondary"), "capacity");
    expect(await cancelReservedModelSlot(lent)).toBe(true);
    await granted(request("own-primary"));                                       // the primary itself is never refused
    for (const [label, setup] of [["stale", async () => { await demand({ ttlMs: 100 }); await sleep(200); }],
      ["foreign writer", () => demand({ asOwner: true })], ["old epoch", () => demand({ epoch: 6 })],
      ["supervisor off", async () => { await demand(); await supervisor({ enabled: false }); }]] as const) {
      await clearAll(); await installPolicy(basePolicy); await configure(DEVICE, { limitSlots: 2, secondaryCap: 0 }); await supervisor();
      await setup();
      expect(await stateOf(DEVICE), label).toMatchObject({ primaryBusy: false });
      await granted(request("own-secondary"));
    }
  });

  it("never grants a waiting helper row whose signal expired while it waited, for the live and the shadow route", async () => {
    await openLiveHelper();
    const gen = await generation();
    const raw = randomUUID();
    await client`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
        provider_budget_id, group_id, epoch, revision, policy_hash, state, queue_until)
      VALUES (${raw}, ${`raw-${raw}`}, ${owner.instanceId}, ${owner.bootId}, 'first', 'reviewer', 'helper-live', 'fixture', 'm', 'account', ${DEVICE},
        ${gen.epoch}, ${gen.revision}, ${gen.policyHash}, 'waiting', clock_timestamp() + interval '1 minute')`;
    expect(await candidate(DEVICE)).toBe(raw);
    await signal({ ttlMs: 100 }); await sleep(200);
    expect(await candidate(DEVICE)).toBeNull();
    await granted(request("other-route"));                                        // a pass over every waiting device: helper-dev grants nothing
    expect((await ownRows()).find(row => row.request_id === raw)?.state).toBe("waiting");
    await client`DELETE FROM model_capacity_requests WHERE request_id = ${raw}`;
    // the shadow route (local-direct) opens for shadow_only, closes for hold
    const shadow = randomUUID();
    await client`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
        provider_budget_id, group_id, epoch, revision, policy_hash, state, queue_until)
      VALUES (${shadow}, ${`raw-${shadow}`}, ${owner.instanceId}, ${owner.bootId}, 'background', 'reviewer', 'helper-shadow', 'local-direct', 'm', ${BACKEND}, ${DEVICE},
        ${gen.epoch}, ${gen.revision}, ${gen.policyHash}, 'waiting', clock_timestamp() + interval '1 minute')`;
    await signal({ verdict: "shadow_only" });
    expect(await candidate(DEVICE)).toBe(shadow);
    await signal({ verdict: "hold" });
    expect(await candidate(DEVICE)).toBeNull();
    await signal({ verdict: "shadow_only" });
    await client`UPDATE model_helper_assignments SET mode = 'off' WHERE assignment_id = ${ASSIGNMENT}`;
    expect(await candidate(DEVICE)).toBeNull();
    expect((await stateOf(DEVICE))?.helpers?.map(gate => [gate.kind, gate.ok])).toEqual([["live", false], ["shadow", false]]);
  });
});
