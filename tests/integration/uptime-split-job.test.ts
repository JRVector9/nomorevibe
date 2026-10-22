import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { recordPing } from "@/lib/domain/products/health";
import { claimUptimeProducts, releaseUptimeClaims, submitUptimeResults } from "@/lib/domain/products/uptime-claims";
import type { JobLease } from "@/lib/jobs/control";
import type { JobContext } from "@/lib/jobs/runner";
import { pingProducts } from "@/lib/jobs/products/uptime";
import { readMaintenanceUptimeProgress } from "@/lib/operations/maintenance-progress";
import { readUptimeSplitReadback } from "@/lib/operations/uptime-split-repository";
import { ensureSchema, resetTables } from "./setup";
import { claimRow, clearSplitState, dailyRows, healthRow, OWNERS, POLICY, product, rawRows, result, setSplit, takeJobLease,
  type FixtureProduct } from "./uptime-split-fixture";

/*
 * U1c — maintenance uptime-ping 잡의 claims 모드 틱(실제 DB). HTTP 만 가짜다.
 * 틱: 제출분 반영 → 내림 sweep → 행 동기화 → home claim → 확인 → 틱 결과를 한 번에 반영 → 못 반영한 claim 되돌림.
 */
const http = vi.hoisted(() => ({ safeFetch: vi.fn(), readBodyCapped: vi.fn(), fetchPage: vi.fn() }));
vi.mock("@/lib/net/fetch", () => http);

type Logged = { event: string; fields?: Record<string, unknown> };
let lease: JobLease;
let original: { split: Record<string, unknown>; control: Record<string, unknown> | undefined };

function tick(events: Logged[] = []): JobContext<null> {
  return { cursor: null, save: async () => {}, hasBudget: () => true, log: (event, fields) => { events.push({ event, fields }); }, lease };
}
/** dead 에 든 주소는 연결 실패(status 0), 나머지는 200 */
function respond(dead: ReadonlySet<string>, before?: (url: string) => Promise<void>) {
  http.safeFetch.mockImplementation(async (url: string) => {
    await before?.(url);
    return dead.has(url) ? null : { finalUrl: url, response: { status: 200, body: null } };
  });
}
async function products(prefix: string, count: number): Promise<FixtureProduct[]> {
  const rows: FixtureProduct[] = [];
  for (let index = 0; index < count; index++) rows.push(await product(`${prefix}-${index}`));
  return rows;
}
const failuresOf = async (target: FixtureProduct) => (await healthRow(target.slug))?.failures;
const checksOf = async (target: FixtureProduct) => (await dailyRows(target.slug)).reduce((sum, row) => sum + row.checks, 0);
async function oracleSuccess(target: FixtureProduct) {
  const batch = await claimUptimeProducts({ owner: OWNERS.oracle, limit: 40 });
  if (batch.kind !== "claimed") throw new Error(`oracle_claim_blocked:${batch.reason}`);
  const ticket = batch.claims.find(claim => claim.productId === target.id);
  if (!ticket) throw new Error("oracle_not_claimed");
  const submitted = await submitUptimeResults({ owner: OWNERS.oracle, results: [result(ticket, { status: 200 })] });
  expect(submitted).toMatchObject({ kind: "submitted", accepted: [target.id] });
  // 함께 가져간 나머지는 열지 않고 풀로 돌려준다(Oracle consumer 의 종료 정리와 같다)
  await releaseUptimeClaims({ owner: OWNERS.oracle, claims: batch.claims.filter(claim => claim.productId !== target.id) });
}

beforeAll(async () => {
  ensureSchema();
  const [split] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_split_control c where id = 1`);
  const [control] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_control c where id = 1`);
  original = { split: split.row, control: control?.row };
});
beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("SERVICE_INSTANCE_ID", OWNERS.m3.instanceId);
  vi.stubEnv("UPTIME_BATCH_SIZE", "200");
  vi.stubEnv("UPTIME_CONCURRENCY", "16");
  await resetTables();
  await clearSplitState();
  await setSplit("claims");
  lease = await takeJobLease();
  http.safeFetch.mockReset();
  http.readBodyCapped.mockReset().mockResolvedValue(Buffer.from(""));
  http.fetchPage.mockReset();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.execute(sql`update uptime_split_control set mode = ${original.split.mode as string}, policy = null, policy_hash = null,
    epoch = epoch + 1, updated_at = clock_timestamp() where id = 1`);
  if (original.control) {
    await db.execute(sql`update uptime_control set observations_enabled = ${original.control.observations_enabled as boolean},
      gate_enabled = ${original.control.gate_enabled as boolean} where id = 1`);
  }
  await db.execute(sql`delete from uptime_host_breakers`);
  await db.execute(sql`delete from uptime_host_windows`);
  await db.execute(sql`update jobs set lease_token = null, locked_at = null where name = 'uptime-ping'`);
});

describe("claims 모드 틱", () => {
  it("제출분을 먼저 반영하고, home 이 claim 한 것만 열어 틱 결과를 한 번에 정식 기록한다", async () => {
    const [a, b, c, d] = await products("tick", 4);
    const oracle = await product("tick-oracle");
    await oracleSuccess(oracle);
    respond(new Set([d.url]));
    const events: Logged[] = [];
    await pingProducts(tick(events));

    // Oracle 결과는 이 틱의 적용기가 반영했고, 그래서 home 은 그 제품을 다시 열지 않았다
    expect((await claimRow(oracle.id))).toMatchObject({ state: "idle", last_outcome: "split_success", last_applied_host: "oracle-osaka-smoke" });
    expect(http.safeFetch.mock.calls.map(([url]) => url).sort()).toEqual([a, b, c, d].map(row => row.url).sort());
    for (const alive of [a, b, c]) {
      expect(await failuresOf(alive)).toBe(0);
      expect(await claimRow(alive.id)).toMatchObject({ state: "idle", token: null, last_outcome: "split_success", last_applied_host: "m3" });
    }
    expect(await failuresOf(d)).toBe(1);
    expect(await claimRow(d.id)).toMatchObject({ state: "idle", last_outcome: "split_counted" });
    expect(await rawRows(d.slug)).toMatchObject([{ host: "m3", disposition: "applied", reason: "split_counted" }]);
    for (const target of [a, b, c, d, oracle]) expect(await checksOf(target)).toBe(1);
    expect(events.map(row => row.event)).toEqual(["uptime.split_applied", "uptime.checked"]);
    expect(events[0].fields).toMatchObject({ remote: 1, applied: 1 });
    expect(events[1].fields).toMatchObject({ alive: 3, down: 1, autoBanned: 0 });
    // 다음 틱: 모두 6시간 안에 확인했다 — 열 것이 없다
    http.safeFetch.mockClear();
    const next: Logged[] = [];
    await pingProducts(tick(next));
    expect(http.safeFetch).not.toHaveBeenCalled();
    expect(next.map(row => row.event)).toEqual(["uptime.idle"]);
  });

  it("새 공개 제품은 그 틱에 claim 행을 만들어 확인한다", async () => {
    const fresh = await product("tick-new", { claim: false, health: null });
    respond(new Set());
    await pingProducts(tick());
    expect(await claimRow(fresh.id)).toMatchObject({ state: "idle", last_outcome: "split_success" });
    expect(await failuresOf(fresh)).toBe(0);
  });

  it("광역 실패 기준은 legacy 와 같다: 30건 중 9건(30%) 실패는 센다", async () => {
    const rows = await products("broad-9", 30);
    respond(new Set(rows.slice(0, 9).map(row => row.url)));
    const events: Logged[] = [];
    await pingProducts(tick(events));
    for (const row of rows.slice(0, 9)) expect(await failuresOf(row)).toBe(1);
    expect(events.map(row => row.event)).not.toContain("uptime.broad_failure_held");
    expect((await readUptimeSplitReadback(db)).breakers.filter(row => row.state !== "closed")).toEqual([]);
  });

  it("30건 중 10건(30% 초과) 실패는 보류하고 차단기를 열어 다음 틱은 확인을 쉰다(제출분 반영은 계속)", async () => {
    const rows = await products("broad-10", 30);
    const dead = rows.slice(0, 10);
    respond(new Set(dead.map(row => row.url)));
    const events: Logged[] = [];
    // 판정을 보류한 회차는 성공이 아니다 — 차단기가 열린 다음 회차도 같은 보류로 이어 센다(조치할 일 uptime-held)
    expect(await pingProducts(tick(events))).toEqual({ done: false, degraded: { code: "broad_failure_held", detail: "확인 30 · 보류 10 · 모름 0" } });
    for (const row of dead) {
      expect(await failuresOf(row)).toBe(0);
      expect(await claimRow(row.id)).toMatchObject({ state: "idle", last_outcome: "split_broad_failure" });
      expect(await rawRows(row.slug)).toMatchObject([{ host: "m3", disposition: "observation_hold", reason: "split_broad_failure" }]);
    }
    for (const row of rows.slice(10)) expect(await claimRow(row.id)).toMatchObject({ last_outcome: "split_success" });
    expect(events.find(row => row.event === "uptime.broad_failure_held")?.fields).toEqual({ attempted: 30, down: 10, unknown: 0 });
    const readback = await readUptimeSplitReadback(db);
    expect(readback.breakers).toMatchObject([{ host: "m3", state: "open", reason: "batch_ratio" }]);
    expect(readback.outcomes1h).toMatchObject({ split_broad_failure: 10, split_success: 20 });
    // 감시: 차단기가 일부러 쉬게 한 동안은 저장이 없어도 멈춤이 아니다
    expect((await readMaintenanceUptimeProgress()).splitHeld).toBe(true);

    const oracle = await product("broad-oracle");
    await oracleSuccess(oracle);
    http.safeFetch.mockClear();
    const next: Logged[] = [];
    expect(await pingProducts(tick(next))).toEqual({ done: false, degraded: { code: "broad_failure_held", detail: "광역 실패 차단기가 열려 확인을 쉽니다" } });
    expect(http.safeFetch).not.toHaveBeenCalled();
    expect(next.map(row => row.event)).toEqual(["uptime.split_applied", "uptime.split_blocked"]);
    expect(next[1].fields).toEqual({ breakerOpen: 1, unconfigured: 0, fenced: 0 });
    expect(await claimRow(oracle.id)).toMatchObject({ last_outcome: "split_success" });
  });

  it("policy 에 없거나 probe 로 적힌 instance 는 claim·확인하지 않는다", async () => {
    await products("stranger", 2);
    respond(new Set());
    for (const instance of ["u1c-stranger", OWNERS.oracle.instanceId]) {
      vi.stubEnv("SERVICE_INSTANCE_ID", instance);
      const events: Logged[] = [];
      expect(await pingProducts(tick(events))).toMatchObject({ done: false, degraded: { code: "split_unconfigured" } });
      expect(events).toEqual([{ event: "uptime.split_blocked", fields: { unconfigured: 1 } }]);
    }
    expect(http.safeFetch).not.toHaveBeenCalled();
    expect((await readUptimeSplitReadback(db)).queue).toMatchObject({ claimed: 0, due: 2 });
  });

  it("확인 중 잡 lease 를 잃으면 정식 기록·raw 를 하나도 쓰지 않고 claim 을 풀로 돌려준다", async () => {
    const [alive, dead] = await products("lease", 2);
    const before = { alive: await healthRow(alive.slug), dead: await healthRow(dead.slug) };
    respond(new Set([dead.url]), async () => {
      await db.execute(sql`update jobs set lease_token = null where name = 'uptime-ping'`);
    });
    await expect(pingProducts(tick())).rejects.toThrow("job_lease_lost");
    expect(await healthRow(alive.slug)).toEqual(before.alive);
    expect(await healthRow(dead.slug)).toEqual(before.dead);
    for (const row of [alive, dead]) {
      expect(await dailyRows(row.slug)).toEqual([]);
      expect(await rawRows(row.slug)).toEqual([]);
      // 다음 틱이 바로 다시 가져간다(due 그대로, token 없음)
      expect(await claimRow(row.id)).toMatchObject({ state: "idle", token: null, last_outcome: null });
    }
    expect((await readUptimeSplitReadback(db)).queue).toMatchObject({ due: 2, claimed: 0 });
  });
});

describe("legacy ↔ claims 전환 중 이중 확인은 무해하다", () => {
  it("legacy 틱이 막 본 제품은 claims 첫 틱이 다시 열지 않는다", async () => {
    await setSplit("legacy");
    const rows = await products("to-claims", 3);
    respond(new Set([rows[2].url]));
    await pingProducts(tick());
    expect(http.safeFetch).toHaveBeenCalledTimes(3);
    expect(await failuresOf(rows[2])).toBe(1);

    await setSplit("claims");
    http.safeFetch.mockClear();
    await pingProducts(tick());
    expect(http.safeFetch).not.toHaveBeenCalled();
    for (const row of rows) expect(await checksOf(row)).toBe(1);
    expect(await failuresOf(rows[2])).toBe(1);
  });

  it("claims 틱 도중 legacy 로 돌아가면 그 틱 결과는 버려지고 legacy 틱이 한 번만 센다", async () => {
    const [alive, dead] = await products("to-legacy", 2);
    let switched = false;
    respond(new Set([dead.url]), async () => {
      if (!switched) { switched = true; await setSplit("legacy", POLICY); }
    });
    await pingProducts(tick());
    for (const row of [alive, dead]) {
      expect(await checksOf(row)).toBe(0);
      expect(await claimRow(row.id)).toMatchObject({ state: "idle", last_outcome: "mode_legacy" });
    }
    await pingProducts(tick());
    for (const row of [alive, dead]) expect(await checksOf(row)).toBe(1);
    expect(await failuresOf(dead)).toBe(1);
  });

  it("claim 과 늦은 legacy 기록이 겹치면 6시간 최소 간격으로 보류해 두 번 세지 않는다", async () => {
    const late = await product("late-legacy");
    respond(new Set([late.url]), async () => {
      // 전환 직전 legacy 틱의 늦은 기록이 claims 확인 사이에 commit 됐다
      await recordPing(late.slug, 0, null, new Date(Date.now() - 1_000), late.id, undefined, late.url);
    });
    await pingProducts(tick());
    expect(await failuresOf(late)).toBe(1);
    expect(await checksOf(late)).toBe(1);
    expect(await claimRow(late.id)).toMatchObject({ state: "idle", last_outcome: "minimum_interval" });
  });

  it("legacy 동안 남은 Oracle 제출은 반영되지 않고, 다시 claims 가 되면 첫 틱이 epoch 불일치로 버린다", async () => {
    const oracle = await product("left-over");
    await oracleSuccess(oracle);
    await setSplit("legacy", POLICY);
    respond(new Set());
    await pingProducts(tick());
    // legacy 잡은 uptime_claims 를 보지 않는다 — 제품은 legacy 로 한 번 확인된다
    expect((await readUptimeSplitReadback(db)).queue.submitted).toBe(1);
    expect(await checksOf(oracle)).toBe(1);
    await setSplit("claims");
    await pingProducts(tick());
    expect(await claimRow(oracle.id)).toMatchObject({ state: "idle", last_outcome: "control_epoch" });
    expect(await checksOf(oracle)).toBe(1);
    expect((await readUptimeSplitReadback(db)).queue.submitted).toBe(0);
  });
});
