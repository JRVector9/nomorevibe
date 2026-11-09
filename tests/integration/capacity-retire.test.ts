import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, parseModelCapacityPolicy, type ModelCapacityPolicy, type ModelCapacityRequest } from "@/lib/llm/capacity";
import { beginModelDispatch, markModelDispatchIndeterminate, requestModelSlot } from "@/lib/llm/capacity-repository";
import { readModelCapacityDevice, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import { MODEL_CAPACITY_DEVICE_RETIRE_AUDIT_ACTION, MODEL_CAPACITY_ROUTES_PRUNE_AUDIT_ACTION, pruneStaleCapacityRoutes,
  retireCapacityDevice } from "@/lib/llm/capacity-retire-repository";
import { readAdminStaleCapacityRoutes } from "@/lib/operations/admin-capacity-retire";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 쓰지 않는 장비 은퇴·남은 정책 route 정리(2026-11-09) — 시험마다 새 DB(이 파일이 migrate 한 틀 DB 의 복사본)라 장부·감사 행이 시험끼리 섞이지 않는다
 * (장부 행을 지우는 정리가 필요 없다). OPEN 에서: 다른 route 의 dispatched 행은 그대로이고, 옛 세대 점유가 앞 판 사슬로 인증되어 새 입장이 policy_changed 로
 * 막히지 않으며, 옛 세대 waiting 행은 덧붙이기와 같이 policy_changed 사건과 함께 withdrawn 된다(버려지지 않는다).
 */
const admin = vi.hoisted(() => ({ login: { login: "jr" } as { login: string } | null }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => admin.login, localOperatorName: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const template = `nmv_retire_tpl_${randomUUID().replaceAll("-", "")}`;
const server = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
let templateCreated = false, current: { name: string; client: ReturnType<typeof postgres> } | null = null;
const urlOf = (name: string) => { const url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`; return url.toString(); };
const client = () => current!.client;

const owner = { instanceId: `retire-${randomUUID()}`, bootId: randomUUID() };
const r = (routeId: string, model: string, groupId: string) => ({ routeId, provider: "fixture", model, providerBudgetId: "acct", groupId });
const LIVE = r("crawl-tagline", "live-m", "dev-live"), ALIAS = r("crawl-tagline", "[OLD] live-m", "dev-live");
const GONE_A = r("crawl-agent-review", "gone-m", "dev-gone"), GONE_B = r("second-review", "gone-m", "dev-gone");
const policy: ModelCapacityPolicy = { version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  groupLimits: { "dev-live": 1, "dev-gone": 2 }, routes: [LIVE, ALIAS, GONE_A, GONE_B] };
const key = (route: { routeId: string; provider: string; model: string; groupId: string }) =>
  ({ routeId: route.routeId, provider: route.provider, model: route.model, groupId: route.groupId });

const request = (route: { routeId: string; model: string }, overrides: Partial<ModelCapacityRequest> = {}): ModelCapacityRequest => ({ requestId: randomUUID(),
  workKey: randomUUID(), owner, class: "background", pool: "text", routeId: route.routeId, provider: "fixture", model: route.model, ...overrides });
async function dispatched(value: ModelCapacityRequest) {
  const result = await requestModelSlot(value);
  if (result.kind !== "granted") throw new Error(`fixture_not_granted:${JSON.stringify(result)}`);
  const begun = await beginModelDispatch(result.reservation);
  if (begun.kind !== "dispatched") throw new Error("fixture_not_dispatched");
  return begun.dispatch;
}
const controlRow = async () => (await client()<{ mode: string; epoch: number; revision: number; policy: ModelCapacityPolicy; policy_hash: string }[]>`
  SELECT mode, epoch::int, revision::int, policy, policy_hash FROM model_capacity_control WHERE id = 1`)[0];
const deviceRows = () => client()<{ device_id: string; version: number }[]>`SELECT device_id, version::int FROM model_capacity_devices ORDER BY device_id`;
const roleRows = () => client()<{ device_id: string; route_id: string }[]>`SELECT device_id, route_id FROM model_capacity_device_roles ORDER BY device_id, route_id`;
const audits = (action: string) => client()<{ actor: string; target: string; detail: Record<string, unknown> }[]>`SELECT actor, target, detail FROM operations_audit
  WHERE action = ${action} ORDER BY id`;
const requestState = async (requestId: string) => (await client()<{ state: string }[]>`SELECT state FROM model_capacity_requests WHERE request_id = ${requestId}`)[0]?.state;
const events = (requestId: string) => client()<{ kind: string }[]>`SELECT kind FROM model_capacity_events WHERE request_id = ${requestId} ORDER BY id`;
/** 거절은 아무것도 남기지 않는다: 정책·장비·역할·감사 줄 수가 그대로다 */
async function unchanged(work: () => Promise<unknown>, code: string | RegExp) {
  const snapshot = async () => ({ control: await controlRow(), devices: await deviceRows(), roles: await roleRows(),
    audits: Number((await client()`SELECT count(*)::int AS n FROM operations_audit`)[0].n) });
  const before = await snapshot();
  await expect(work()).rejects.toThrow(code);
  expect(await snapshot()).toEqual(before);
}
const retire = (input: unknown, actor = "jr") => db.transaction(tx => retireCapacityDevice(tx, input, actor));
const prune = (input: unknown, actor = "jr") => db.transaction(tx => pruneStaleCapacityRoutes(tx, input, actor));
async function connection(deviceId: string, models: string[], label = `${deviceId}-conn`) {
  await client()`INSERT INTO ai_connections (id, label, kind, base_url, models, device_id, updated_by)
    VALUES (${randomUUID()}, ${label}, 'api', ${`http://${label}.test:8000/v1`}, ${JSON.stringify(models.map(id => ({ id, maxModelLen: 8192 })))}::jsonb, ${deviceId}, 'retire-test')`;
}
async function contract(routeId: string, model: string) {
  const body = { routeId, model, provider: "fixture" };
  await client()`INSERT INTO model_serving_contracts (route_id, model, contract, contract_hash, auth, transport, enabled, updated_by)
    VALUES (${routeId}, ${model}, ${JSON.stringify(body)}::jsonb, ${"a".repeat(64)}, 'none', 'direct', true, 'retire-test')`;
}

beforeAll(async () => {
  await server.unsafe(`CREATE DATABASE ${template}`); templateCreated = true;
  const setup = postgres(urlOf(template), { max: 1, prepare: false, onnotice: () => {} });
  await migrate(drizzle(setup), { migrationsFolder: path.join(path.resolve("."), "drizzle") });
  await setup.end({ timeout: 3 });
}, 180_000);
beforeEach(async () => {
  const name = `nmv_retire_${randomUUID().replaceAll("-", "")}`;
  await server.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  current = { name, client: postgres(urlOf(name), { max: 4, prepare: false, onnotice: () => {} }) };
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(current.client, { schema }); globals.pgClient = current.client;
  await client()`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(policy)}::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
  for (const [deviceId, limitSlots, roles] of [["dev-live", 1, []], ["dev-gone", 2, [{ routeId: "crawl-agent-review", rank: 1 }]]] as const)
    await db.transaction(tx => saveModelCapacityDevice(tx, { deviceId, limitSlots, secondaryCap: limitSlots, idleMs: 0, reserveSlots: 0, physicalLimit: null,
      roles: [...roles], note: null }, null, "retire-test"));
  await connection("dev-live", ["live-m"]);
  admin.login = { login: "jr" };
});
afterEach(async () => {
  if (!current) return;
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await current.client.end({ timeout: 3 });
  await server.unsafe(`DROP DATABASE ${current.name} WITH (FORCE)`);
  current = null;
});
afterAll(async () => {
  if (templateCreated) await server.unsafe(`DROP DATABASE ${template} WITH (FORCE)`);
  await server.end({ timeout: 3 });
});

describe("retireCapacityDevice", () => {
  it("removes the device's routes, groupLimits key, row and roles in OPEN — other routes' held rows keep working — with one audit row", async () => {
    // dev-live(1칸)에 dispatched 하나와 그 뒤의 waiting 하나 — 옛 세대가 된다
    const held = await dispatched(request(LIVE));
    const queued = request(LIVE);
    expect(await requestModelSlot(queued)).toEqual({ kind: "deferred", reason: "capacity" });
    expect(await requestState(queued.requestId)).toBe("waiting");
    const before = await controlRow();
    const device = (await readModelCapacityDevice("dev-gone"))!;

    const result = await retire({ deviceId: "dev-gone", expectedVersion: device.version });
    expect(result).toMatchObject({ deviceId: "dev-gone", mode: "open", deletedRow: true, removedGroupLimit: 2,
      policy: { written: true, before: { revision: before.revision }, after: { revision: before.revision + 1 } } });
    expect(result.removedRoutes).toEqual([GONE_A, GONE_B]);
    const after = await controlRow();
    expect(after).toMatchObject({ mode: "open", epoch: before.epoch, revision: before.revision + 1 });
    expect(after.policy.routes).toEqual([LIVE, ALIAS]);
    expect(after.policy.groupLimits).toEqual({ "dev-live": 1 });
    // 살아 있는 옛 세대 행(held·queued)이 있어 지금 세대를 앞 판으로 남긴다 — 덧붙이기와 같은 규칙
    expect(after.policy.compatiblePredecessors).toEqual([{ epoch: before.epoch, revision: before.revision, policyHash: before.policy_hash }]);
    expect(after.policy_hash).toBe(modelCapacityPolicyHash(parseModelCapacityPolicy(after.policy)));
    expect(await deviceRows()).toEqual([{ device_id: "dev-live", version: 1 }]);
    expect(await roleRows()).toEqual([]);
    const [audit, ...extra] = await audits(MODEL_CAPACITY_DEVICE_RETIRE_AUDIT_ACTION);
    expect(extra).toEqual([]);
    expect(audit).toMatchObject({ actor: "jr", target: "dev-gone", detail: { deviceId: "dev-gone", expectedVersion: device.version, mode: "open",
      before: { device: { version: device.version, limitSlots: 2, roles: [{ routeId: "crawl-agent-review", rank: 1 }] }, routes: [GONE_A, GONE_B], groupLimit: 2,
        policy: { revision: before.revision, policyHash: before.policy_hash } },
      after: { device: null, routes: [], groupLimit: null, policy: { revision: before.revision + 1, policyHash: after.policy_hash } } } });

    // 다른 route 의 dispatched 행은 그대로이고 그 점유는 인증된다: 새 요청은 policy_changed 가 아니라 칸이 없어(capacity) 기다린다
    expect(await requestState(held.requestId)).toBe("dispatched");
    const next = request(LIVE);
    expect(await requestModelSlot(next)).toEqual({ kind: "deferred", reason: "capacity" });
    // 옛 세대 waiting 행은 버려지지 않고 policy_changed 사건과 함께 withdrawn — 덧붙이기(appendCompatibleRoutes)와 같다. 호출자는 새 요청으로 다시 선다
    expect(await requestState(queued.requestId)).toBe("withdrawn");
    expect((await events(queued.requestId)).map(row => row.kind)).toEqual(["queued", "policy_changed"]);
    // 옛 점유가 끝나면 새 세대 대기 행이 바로 예약된다
    expect(await markModelDispatchIndeterminate(held, "transport_unknown")).toBe(true);
    expect((await requestModelSlot(next)).kind).toBe("granted");
    // 지운 장비의 route 는 더 받지 않는다
    expect(await requestModelSlot(request(GONE_A))).toEqual({ kind: "deferred", reason: "unmapped" });

    // 다시 눌러도 두 번 쓰지 않는다
    await unchanged(() => retire({ deviceId: "dev-gone", expectedVersion: device.version }), "model_capacity_device_already_retired");
    await unchanged(() => retire({ deviceId: "dev-gone", expectedVersion: null }), "model_capacity_device_already_retired");
  });

  it("refuses — writing nothing — on a stale version, a bound connection, a contract, a rank's route or an unfinished ledger row", async () => {
    const version = (await readModelCapacityDevice("dev-gone"))!.version;
    await unchanged(() => retire({ deviceId: "dev-gone", expectedVersion: version + 1 }), `model_capacity_device_retire_version_mismatch:${version}`);
    await unchanged(() => retire({ deviceId: "dev-gone", expectedVersion: null }), `model_capacity_device_retire_version_mismatch:${version}`);
    await unchanged(() => retire({ deviceId: "dev-gone" }), "model_capacity_device_retire_invalid:expectedVersion");
    await unchanged(() => retire({ deviceId: "dev-gone", expectedVersion: version }, " "), "model_capacity_device_retire_invalid:actor");

    await contract("second-review", "gone-m");
    await unchanged(() => retire({ deviceId: "dev-gone", expectedVersion: version }), /model_capacity_device_retire_blocked:contract=#\d+ second-review · gone-m\(direct\)/);
    await client()`UPDATE model_serving_contracts SET enabled = false`;

    await connection("dev-gone", ["other-m"], "gone-conn");
    await unchanged(() => retire({ deviceId: "dev-gone", expectedVersion: version }), "model_capacity_device_retire_blocked:connection=gone-conn");
    await client()`DELETE FROM ai_connections WHERE label = 'gone-conn'`;

    // 다른 장비 연결의 순위가 지금도 dev-gone route(crawl-agent-review · gone-m)로 풀린다
    const [live] = await client()<{ id: string }[]>`SELECT id::text FROM ai_connections WHERE device_id = 'dev-live'`;
    await client()`INSERT INTO ai_task_models (task, slot, rank, connection_id, model, updated_by) VALUES ('first-review', 1, 1, ${live.id}, 'gone-m', 'retire-test')`;
    await unchanged(() => retire({ deviceId: "dev-gone", expectedVersion: version }), "model_capacity_device_retire_blocked:rank=first-review#1 1순위 gone-m");
    await client()`DELETE FROM ai_task_models`;

    const unknown = await dispatched(request(GONE_A));
    expect(await markModelDispatchIndeterminate(unknown, "transport_unknown")).toBe(true);
    await unchanged(() => retire({ deviceId: "dev-gone", expectedVersion: version }),
      "model_capacity_device_retire_blocked:ledger=crawl-agent-review · gone-m indeterminate 1건");

    const { readDatabaseIdentity } = await import("@/lib/operations/dr/epoch");
    const site = await db.transaction(tx => readDatabaseIdentity(tx));
    await client()`UPDATE dr_writer_fence SET state = 'fenced', reason = 'operator_fence', fenced_db = ${JSON.stringify(site)}::jsonb WHERE id = 1`;
    await unchanged(() => retire({ deviceId: "dev-gone", expectedVersion: version }), "site_fenced");
  });

  it("retires a policy-only device (no row) with expectedVersion null", async () => {
    await client()`DELETE FROM model_capacity_devices WHERE device_id = 'dev-gone'`; // 역할 행은 FK cascade
    const result = await retire({ deviceId: "dev-gone", expectedVersion: null });
    expect(result).toMatchObject({ deletedRow: false, removedGroupLimit: 2 });
    expect((await controlRow()).policy.routes).toEqual([LIVE, ALIAS]);
    expect((await audits(MODEL_CAPACITY_DEVICE_RETIRE_AUDIT_ACTION))[0].detail).toMatchObject({ before: { device: null }, after: { device: null } });
  });
});

describe("pruneStaleCapacityRoutes", () => {
  it("lists the alias and the connection-less device's routes, prunes the alias in OPEN with one audit row and refuses everything else", async () => {
    const view = await readAdminStaleCapacityRoutes();
    expect(view.error).toBeNull();
    expect(view.candidates.map(entry => key(entry.route))).toEqual([key(ALIAS), key(GONE_A), key(GONE_B)]);
    expect(view.kept.map(entry => [key(entry.route), entry.blockers])).toEqual([[key(LIVE), [{ kind: "exposed", detail: "dev-live-conn" }]]]);
    expect(view.orphanDevices).toEqual(["dev-gone"]);
    const revision = view.revision!;
    const held = await dispatched(request(LIVE));

    await unchanged(() => prune({ routes: [key(ALIAS)], expectedRevision: revision - 1 }), `model_capacity_routes_prune_revision_mismatch:${revision}`);
    await unchanged(() => prune({ routes: [key(LIVE)], expectedRevision: revision }), "model_capacity_route_prune_blocked:crawl-tagline|fixture|live-m | exposed=dev-live-conn");
    await unchanged(() => prune({ routes: [{ ...key(ALIAS), groupId: "dev-gone" }], expectedRevision: revision }), "model_capacity_route_conflict");
    await unchanged(() => prune({ routes: [], expectedRevision: revision }), "model_capacity_routes_prune_invalid:routes");
    // a waiting row on the alias route blocks it
    const aliasWait = request(ALIAS);
    expect(await requestModelSlot(aliasWait)).toEqual({ kind: "deferred", reason: "capacity" });
    await unchanged(() => prune({ routes: [key(ALIAS)], expectedRevision: revision }), "model_capacity_route_prune_blocked:crawl-tagline|fixture|[OLD] live-m | ledger=waiting 1건");
    expect(await markModelDispatchIndeterminate(held, "transport_unknown")).toBe(true);
    expect((await requestModelSlot(aliasWait)).kind).toBe("granted");
    // the reserved alias row still blocks; once it ends (cancelled reservation → withdrawn) the alias goes
    const { cancelReservedModelSlot } = await import("@/lib/llm/capacity-repository");
    const reserved = await requestModelSlot(aliasWait);
    if (reserved.kind !== "granted") throw new Error("fixture_not_reserved");
    await unchanged(() => prune({ routes: [key(ALIAS)], expectedRevision: revision }), /ledger=reserved 1건/);
    expect(await cancelReservedModelSlot(reserved.reservation)).toBe(true);
    const other = await dispatched(request(LIVE));

    const result = await prune({ routes: [key(ALIAS)], expectedRevision: revision });
    expect(result).toMatchObject({ mode: "open", policy: { before: { revision }, after: { revision: revision + 1 } } });
    expect(result.removed.map(entry => key(entry.route))).toEqual([key(ALIAS)]);
    const after = await controlRow();
    expect(after).toMatchObject({ mode: "open", revision: revision + 1 });
    expect(after.policy.routes).toEqual([LIVE, GONE_A, GONE_B]);
    expect(after.policy.groupLimits).toEqual(policy.groupLimits);
    expect(await deviceRows()).toEqual([{ device_id: "dev-gone", version: 1 }, { device_id: "dev-live", version: 1 }]);
    expect(await requestState(other.requestId)).toBe("dispatched");
    expect(await requestModelSlot(request(LIVE))).toEqual({ kind: "deferred", reason: "capacity" }); // 옛 점유는 인증된다(policy_changed 아님)
    const [audit, ...extra] = await audits(MODEL_CAPACITY_ROUTES_PRUNE_AUDIT_ACTION);
    expect(extra).toEqual([]);
    expect(audit).toMatchObject({ actor: "jr", target: "crawl-tagline|fixture|[OLD] live-m", detail: { expectedRevision: revision, mode: "open",
      before: { policy: { revision }, routes: [{ ...ALIAS, reason: expect.stringContaining("내보내지 않고") }] },
      after: { policy: { revision: revision + 1, policyHash: after.policy_hash }, routes: [] } } });
    // 다시 눌러도 두 번 쓰지 않는다
    await unchanged(() => prune({ routes: [key(ALIAS)], expectedRevision: revision + 1 }), "model_capacity_route_missing:crawl-tagline|fixture|[OLD] live-m");
  });

  it("goes through the guarded server actions (confirm=yes, admin, expected revision/version)", async () => {
    const { pruneStaleCapacityRoutesAction, retireCapacityDeviceAction } = await import("@/app/(operator)/admin/models/devices/actions");
    const form = (entries: [string, string][]) => { const value = new FormData(); for (const [name, item] of entries) value.append(name, item); return value; };
    const revision = (await controlRow()).revision;
    const route = JSON.stringify([ALIAS.routeId, ALIAS.provider, ALIAS.model, ALIAS.groupId]);
    expect(await pruneStaleCapacityRoutesAction(null, form([["expectedRevision", String(revision)], ["route", route]])))
      .toEqual({ issues: ["확인(confirm=yes)이 없어 아무것도 지우지 않았습니다. 목록을 다시 보고 확인을 눌러주세요."] });
    admin.login = null;
    expect(await pruneStaleCapacityRoutesAction(null, form([["confirm", "yes"], ["expectedRevision", String(revision)], ["route", route]])))
      .toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    admin.login = { login: "jr" };
    const pruned = await pruneStaleCapacityRoutesAction(null, form([["confirm", "yes"], ["expectedRevision", String(revision)], ["route", route]]));
    expect(pruned).toEqual({ ok: true, message: `정책 route 1개를 뺐습니다(정책 판 ${revision} → ${revision + 1}, 접수 OPEN 그대로): crawl-tagline / [OLD] live-m → dev-live` });
    const version = (await readModelCapacityDevice("dev-gone"))!.version;
    expect(await retireCapacityDeviceAction(null, form([["confirm", "yes"], ["deviceId", "dev-live"], ["expectedVersion", "1"]])))
      .toEqual({ issues: ["아직 쓰이고 있어 장비를 지우지 않았습니다 — 이 장비에 묶인 AI 연결 dev-live-conn. 먼저 그것을 옮기거나 끈 뒤 다시 시도해주세요."] });
    expect(await retireCapacityDeviceAction(null, form([["confirm", "yes"], ["deviceId", "dev-gone"], ["expectedVersion", String(version)]])))
      .toEqual({ ok: true, message: `장비 dev-gone을(를) 지웠습니다 — 장비 행·역할 순서, 정책 route 2개, groupLimits 키(2칸)를 뺐습니다 (정책 판 ${revision + 1} → ${revision + 2}, 접수 OPEN 그대로).` });
    expect(await audits(MODEL_CAPACITY_DEVICE_RETIRE_AUDIT_ACTION)).toHaveLength(1);
  });
});
