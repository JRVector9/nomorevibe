import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { applyUptimeResults } from "@/lib/domain/products/uptime-apply";
import { claimUptimeProducts, releaseUptimeClaims, submitUptimeResults } from "@/lib/domain/products/uptime-claims";
import type { JobLease } from "@/lib/jobs/control";
import type { JobContext } from "@/lib/jobs/runner";
import { pingProducts } from "@/lib/jobs/products/uptime";
import { readUptimeSplitReadback, readUptimeSplitStage } from "@/lib/operations/uptime-split-repository";
import { classifyStage } from "@/lib/operations/worker-progress";
import { ensureSchema, resetTables } from "./setup";
import { claimRow, clearSplitState, dbNow, healthRow, OWNERS, product, rawRows, result, setSplit, takeJobLease,
  type FixtureProduct } from "./uptime-split-fixture";

/*
 * 독립 리뷰(review-uptime.md) 발견의 회귀 테스트(실제 DB). HTTP 만 가짜다. 각 describe 가 발견 하나다.
 */
const http = vi.hoisted(() => ({ safeFetch: vi.fn(), readBodyCapped: vi.fn(), fetchPage: vi.fn(), FETCH_TIMEOUT_MS: 10_000 }));
vi.mock("@/lib/net/fetch", () => http);

type Logged = { event: string; fields?: Record<string, unknown> };
let lease: JobLease;
let original: { split: Record<string, unknown>; control: Record<string, unknown> | undefined };

function tick(events: Logged[] = []): JobContext<null> {
  return { cursor: null, save: async () => {}, hasBudget: () => true, log: (event, fields) => { events.push({ event, fields }); }, lease };
}
/** status 표에 든 주소는 그 상태로, null 이면 연결 실패, 나머지는 200 */
function respond(statuses: ReadonlyMap<string, number | null>) {
  http.safeFetch.mockImplementation(async (url: string) => {
    const status = statuses.has(url) ? statuses.get(url)! : 200;
    return status === null ? null : { finalUrl: url, response: { status, body: null } };
  });
}
async function products(prefix: string, count: number): Promise<FixtureProduct[]> {
  const rows: FixtureProduct[] = [];
  for (let index = 0; index < count; index++) rows.push(await product(`${prefix}-${index}`));
  return rows;
}
const fetchedUrls = () => http.safeFetch.mock.calls.map(([url]) => url as string);

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
  await db.execute(sql`delete from role_leases where role = 'maintenance'`);
});

describe("F1 비표준 HTTP 상태", () => {
  it("999·600 은 legacy 처럼 그 상태 그대로 실패로 기록하고, 틱의 나머지도 반영한다 — 다음 틱이 같은 사이트를 다시 열지 않는다", async () => {
    const healthy = await products("ok", 20);
    const linkedin = await product("li999"), odd = await product("s600");
    respond(new Map([[linkedin.url, 999], [odd.url, 600]]));
    const events: Logged[] = [];
    await pingProducts(tick(events));

    for (const row of healthy) {
      expect(await healthRow(row.slug)).toMatchObject({ failures: 0, status: 200 });
      expect(await claimRow(row.id)).toMatchObject({ state: "idle", last_outcome: "split_success" });
    }
    // 정식 기록은 legacy(recordPing)와 같은 값·같은 의미: 상태 그대로, 실패 1
    expect(await healthRow(linkedin.slug)).toMatchObject({ status: 999, failures: 1, latency_ms: null });
    expect(await healthRow(odd.slug)).toMatchObject({ status: 600, failures: 1 });
    expect(await claimRow(linkedin.id)).toMatchObject({ state: "idle", last_outcome: "split_counted" });
    // raw 표는 100..599 만 담는다 — 그 표에만 unknown/0
    expect(await rawRows(linkedin.slug)).toMatchObject([{ host: "m3", disposition: "applied", reason: "split_counted", kind: "unknown", status: 0 }]);
    expect(events.map(row => row.event)).toEqual(["uptime.checked"]);

    http.safeFetch.mockClear();
    await pingProducts(tick());
    expect(http.safeFetch).not.toHaveBeenCalled();
  });

  it("legacy 도 999 를 같은 값으로 쓴다(두 경로의 정식 기록이 같다)", async () => {
    await setSplit("legacy", null);
    const linkedin = await product("legacy-li999", { claim: false });
    respond(new Map([[linkedin.url, 999]]));
    await pingProducts(tick());
    expect(await healthRow(linkedin.slug)).toMatchObject({ status: 999, failures: 1, latency_ms: null });
  });

  it("모양이 틀린 결과 한 건은 그 건만 빼고 반영한다 — 그 claim 은 되돌리지 않아 TTL 전에는 다시 열지 않는다", async () => {
    const healthy = await products("iso", 5);
    // 실제로는 나오지 않는 kind http·status 0 — 적용기 입력 검사에 걸리는 결과의 대역
    const broken = await product("broken");
    respond(new Map([[broken.url, 0]]));
    const events: Logged[] = [];
    await pingProducts(tick(events));
    for (const row of healthy) expect(await claimRow(row.id)).toMatchObject({ state: "idle", last_outcome: "split_success" });
    expect(await healthRow(broken.slug)).toMatchObject({ status: 200, failures: 0 }); // 7시간 전 기록 그대로
    expect(await claimRow(broken.id)).toMatchObject({ state: "claimed", owner_instance_id: OWNERS.m3.instanceId });
    expect(events.find(row => row.event === "uptime.split_result_invalid")?.fields).toEqual({ invalid: 1 });

    http.safeFetch.mockClear();
    await pingProducts(tick());
    expect(fetchedUrls()).not.toContain(broken.url);
  });
});

describe("F2 home 차단기 시험 표본", () => {
  async function breaker() {
    const [row] = await db.execute<{ state: string; cool_down_ms: number; probe_checks: number; probe_failures: number }>(sql`
      select state, cool_down_ms, probe_checks, probe_failures from uptime_host_breakers where host = 'm3'`);
    return row ?? null;
  }

  it("Oracle 이 만든 재확인 요청(실제로 죽은 사이트)이 있어도 시험은 건강한 제품만 열어 닫히고, 닫힌 뒤 재확인을 먼저 센다", async () => {
    // 죽은 제품 4개(어디서 보든 실패) — due 가 일러 Oracle 이 먼저 가져간다
    const dead: FixtureProduct[] = [];
    for (let i = 0; i < 4; i++) dead.push(await product(`dead-${i}`, { dueMinutes: -30 }));
    const alive: FixtureProduct[] = [];
    for (let i = 0; i < 80; i++) alive.push(await product(`alive-${i}`, { dueMinutes: -5 }));
    const deadUrls = new Set(dead.map(row => row.url));
    respond(new Map(dead.map(row => [row.url, null])));

    const batch = await claimUptimeProducts({ owner: OWNERS.oracle, limit: 40 });
    if (batch.kind !== "claimed") throw new Error(`oracle_blocked:${batch.reason}`);
    const mine = batch.claims.filter(ticket => deadUrls.has(ticket.url));
    expect(mine).toHaveLength(4);
    await submitUptimeResults({ owner: OWNERS.oracle, results: mine.map(ticket => result(ticket, { status: 0, kind: "network" })) });
    await releaseUptimeClaims({ owner: OWNERS.oracle, claims: batch.claims.filter(ticket => !deadUrls.has(ticket.url)) });
    expect((await applyUptimeResults({ lease })).outcomes.confirm_requested).toBe(4);

    // 앞선 home 광역 장애로 m3 차단기가 열렸고 cool-down 이 막 끝났다
    await db.execute(sql`insert into uptime_host_breakers (host, state, opened_at, probe_after, cool_down_ms, reason, ratio)
      values ('m3', 'open', clock_timestamp() - interval '11 minutes', clock_timestamp() - interval '1 second', 600000, 'batch_ratio', 0.8)`);
    await pingProducts(tick());
    // 시험 30건은 건강한 제품만 — 죽은 재확인 요청은 열지 않았다
    expect(http.safeFetch).toHaveBeenCalledTimes(30);
    expect(fetchedUrls().some(url => deadUrls.has(url))).toBe(false);
    expect(await breaker()).toMatchObject({ state: "closed", cool_down_ms: 600_000 });
    for (const row of dead) expect(await claimRow(row.id)).toMatchObject({ confirm_class: "home" });

    // 닫힌 뒤 틱은 재확인 요청을 먼저 가져가 실제로 죽은 사이트를 센다
    http.safeFetch.mockClear();
    await pingProducts(tick());
    for (const row of dead) {
      expect(await healthRow(row.slug)).toMatchObject({ failures: 1 });
      expect(await claimRow(row.id)).toMatchObject({ confirm_class: null, last_outcome: "split_confirmed" });
    }
    expect(await breaker()).toMatchObject({ state: "closed" });
  });

  it("확인을 맡은 home 의 차단기가 60분 넘게 열려 있으면 Oracle 반영이 진행을 채워도 경보(재시작 대상 아님)다", async () => {
    await product("stuck-due", { dueMinutes: -90 });
    await db.execute(sql`insert into role_leases (role, owner_instance_id, lease_until) values ('maintenance', ${OWNERS.m3.instanceId},
      (clock_timestamp() at time zone 'UTC') + interval '45 seconds')
      on conflict (role) do update set owner_instance_id = excluded.owner_instance_id, lease_until = excluded.lease_until`);
    // probing 에서 다시 열려도 처음 연 시각(61분 전)을 이어 간다
    await db.execute(sql`insert into uptime_host_breakers (host, state, opened_at, probe_after, cool_down_ms, reason, ratio)
      values ('m3', 'open', clock_timestamp() - interval '61 minutes', clock_timestamp() + interval '20 minutes', 2400000, 'probe_ratio', 0.1)`);
    // Oracle 성공 반영이 5분 진행을 채운 상태
    await db.execute(sql`update uptime_claims set last_applied_at = clock_timestamp() - interval '1 minute', last_applied_host = 'oracle-osaka-smoke'
      where product_id = (select min(product_id) from uptime_claims)`);
    const readback = await readUptimeSplitReadback(db);
    expect(readback.maintenanceOwner).toBe(OWNERS.m3.instanceId);
    expect(readback.queue.applied5m).toBe(1);
    const stage = (await readUptimeSplitStage(db))!;
    expect(classifyStage(stage, null, true, await dbNow())).toMatchObject({ stage: "uptime", reason: "upstream_stalled", alarm: true, restartEligible: false });

    // 역할이 다른 home(mini)으로 넘어갔으면 m3 차단기는 시험할 사람이 없을 뿐이다 — 경보가 아니다
    await db.execute(sql`update role_leases set owner_instance_id = ${OWNERS.mini.instanceId} where role = 'maintenance'`);
    expect(classifyStage((await readUptimeSplitStage(db))!, null, true, await dbNow())).toMatchObject({ reason: "progressing", alarm: false });
  });
});
