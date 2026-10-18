import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { healthFor } from "@/lib/domain/products/health";
import type { JobLease } from "@/lib/jobs/control";
import type { JobContext } from "@/lib/jobs/runner";
import { pingProducts } from "@/lib/jobs/products/uptime";
import { ensureSchema, resetTables } from "./setup";
import { claimRow, clearSplitState, dailyRows, healthRow, OWNERS, POLICY, product, setSplit, takeJobLease } from "./uptime-split-fixture";

/*
 * 쌍둥이 시험(실제 DB): legacy 틱(nextToCheck → recordPing, 틱 광역 보류)과 split claims home 틱(claim → 묶음 적용기)이 같은 확인 결과에
 * 같은 정식 기록 — product_health·일일 집계·숨김·자동 내림 — 을 내는지 본다. HTTP 만 가짜다.
 * 같은 이름·같은 처음 상태의 제품을 legacy 로 한 번, DB 를 비운 뒤 claims 로 한 번 돌린다. 두 실행의 시각이 다르므로 확인 시각은
 * "넘어갔는가", 첫 실패 시각은 "없음·그대로·새로" 로, 지연은 있는지로 비교한다.
 */
const http = vi.hoisted(() => ({ safeFetch: vi.fn(), readBodyCapped: vi.fn(), fetchPage: vi.fn(), FETCH_TIMEOUT_MS: 10_000 }));
vi.mock("@/lib/net/fetch", () => http);

type Logged = { event: string; fields?: Record<string, unknown> };
/** 처음 상태와 이번 응답. health null 은 확인한 적 없는 새 제품, response null 은 연결 실패 */
type Spec = { name: string; health?: { failures: number; status?: number } | null; listed?: "seeded" | "verified"; response: number | null };
type Snapshot = {
  failures: number | null; status: number | null; latency: "none" | "some" | null; checked: "advanced" | "same" | null;
  downSince: "none" | "same" | "new" | null; daily: { checks: number; successes: number; latencySamples: number };
  hidden: boolean; productStatus: string;
};

let lease: JobLease;
let original: { split: Record<string, unknown>; control: Record<string, unknown> | undefined };

function tick(events: Logged[]): JobContext<null> {
  return { cursor: null, save: async () => {}, hasBudget: () => true, log: (event, fields) => { events.push({ event, fields }); }, lease };
}

/** 한 모드로 처음 상태를 만들고 한 틱 돌린 뒤 제품 이름별 정식 기록을 돌려준다 */
async function run(mode: "legacy" | "claims", specs: readonly Spec[]) {
  await resetTables();
  await clearSplitState();
  await setSplit(mode, mode === "claims" ? POLICY : null);
  lease = await takeJobLease();
  const targets = [];
  for (const spec of specs) {
    const target = await product(spec.name, { claim: mode === "claims", status: spec.listed,
      health: spec.health === null ? null : { failures: spec.health?.failures ?? 0, status: spec.health?.status } });
    targets.push({ spec, target, before: await healthRow(target.slug) });
  }
  const responses = new Map(targets.map(({ spec, target }) => [target.url, spec.response]));
  http.safeFetch.mockReset().mockImplementation(async (url: string) => {
    if (!responses.has(url)) throw new Error(`unexpected_fetch:${url}`);
    const status = responses.get(url);
    return status === null ? null : { finalUrl: url, response: { status, body: null } };
  });
  const events: Logged[] = [];
  await pingProducts(tick(events));
  expect(http.safeFetch).toHaveBeenCalledTimes(specs.length);

  const hidden = await healthFor(targets.map(({ target }) => target.slug));
  const snapshots: Record<string, Snapshot> = {};
  const outcomes: Record<string, string | null> = {};
  for (const { spec, target, before } of targets) {
    const after = await healthRow(target.slug);
    const daily = (await dailyRows(target.slug)).reduce((sum, row) => ({ checks: sum.checks + row.checks, successes: sum.successes + row.successes,
      latencySamples: sum.latencySamples + row.latency_samples }), { checks: 0, successes: 0, latencySamples: 0 });
    const [row] = await db.execute<{ status: string }>(sql`select status from products where id = ${target.id}`);
    snapshots[spec.name] = {
      failures: after?.failures ?? null, status: after?.status ?? null,
      latency: after ? (after.latency_ms === null ? "none" : "some") : null,
      checked: after ? (before && after.checked_at === before.checked_at ? "same" : "advanced") : null,
      downSince: after ? (after.down_since === null ? "none" : before && after.down_since === before.down_since ? "same" : "new") : null,
      daily, hidden: hidden.get(target.slug)?.down ?? false, productStatus: row.status };
    if (mode === "claims") outcomes[spec.name] = (await claimRow(target.id)).last_outcome;
  }
  return { snapshots, events, outcomes };
}

/** 두 모드를 차례로 돌려 정식 기록이 같은지 본다 */
async function twin(specs: readonly Spec[]) {
  const legacy = await run("legacy", specs);
  const claims = await run("claims", specs);
  expect(claims.snapshots).toEqual(legacy.snapshots);
  return { legacy, claims, snapshots: legacy.snapshots };
}
const many = (prefix: string, count: number, spec: Omit<Spec, "name">): Spec[] =>
  Array.from({ length: count }, (_, index) => ({ name: `${prefix}-${index}`, ...spec }));

beforeAll(async () => {
  ensureSchema();
  const [split] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_split_control c where id = 1`);
  const [control] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_control c where id = 1`);
  original = { split: split.row, control: control?.row };
});
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SERVICE_INSTANCE_ID", OWNERS.m3.instanceId);
  vi.stubEnv("UPTIME_BATCH_SIZE", "200");
  vi.stubEnv("UPTIME_CONCURRENCY", "16");
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

describe("legacy ↔ claims 쌍둥이", () => {
  it("평소 틱: 성공·실패·비표준 600·새 제품·숨김·10회째 자동 내림이 같다", async () => {
    const { snapshots, claims } = await twin([
      ...many("ok", 30, { response: 200 }),
      { name: "f404", response: 404 },
      { name: "net", health: { failures: 2, status: 503 }, response: null },
      { name: "ban", health: { failures: 9, status: 503 }, response: 500 },
      { name: "s600", response: 600 },
      { name: "fresh-ok", health: null, response: 200 },
      { name: "fresh-fail", health: null, response: 503 },
      { name: "recover", health: { failures: 4, status: 503 }, response: 200 },
    ]);
    // 두 경로가 아무것도 안 해서 같은 것이 아니다
    expect(snapshots["ok-0"]).toMatchObject({ failures: 0, status: 200, checked: "advanced", latency: "some", daily: { checks: 1, successes: 1 } });
    expect(snapshots.f404).toMatchObject({ failures: 1, status: 404, downSince: "new", daily: { checks: 1, successes: 0 } });
    expect(snapshots.net).toMatchObject({ failures: 3, status: 0, downSince: "same", hidden: true });
    expect(snapshots.ban).toMatchObject({ failures: 10, productStatus: "banned" });
    expect(snapshots.s600).toMatchObject({ failures: 1, status: 600 });
    expect(snapshots["fresh-fail"]).toMatchObject({ failures: 1, downSince: "new" });
    expect(snapshots.recover).toMatchObject({ failures: 0, downSince: "none", hidden: false });
    expect(claims.outcomes.f404).toBe("split_counted");
  });

  it("광역 실패 틱(39건 중 15건 실패): 실패는 판정 보류 — 확인 시각만 넘기고, 연속 실패 10회 행은 시각까지 그대로다(F4)", async () => {
    const { snapshots, legacy, claims } = await twin([
      ...many("ok", 24, { response: 200 }),
      ...many("dead", 6, { response: null }),
      ...many("down", 6, { response: 503 }),
      { name: "sick", health: { failures: 2, status: 503 }, response: 503 },
      { name: "unbanned", health: { failures: 10, status: 503 }, response: null },
      { name: "fresh", health: null, response: 503 },
    ]);
    expect(snapshots["dead-0"]).toEqual({ failures: 0, status: 200, latency: "none", checked: "advanced", downSince: "none",
      daily: { checks: 0, successes: 0, latencySamples: 0 }, hidden: false, productStatus: "seeded" });
    expect(snapshots.sick).toMatchObject({ failures: 2, status: 503, checked: "advanced", downSince: "same", daily: { checks: 0 } });
    expect(snapshots.unbanned).toMatchObject({ failures: 10, checked: "same", downSince: "same", productStatus: "seeded", daily: { checks: 0 } });
    expect(snapshots.fresh).toMatchObject({ failures: 0, status: 503, checked: "advanced", downSince: "none", daily: { checks: 0 } });
    expect(snapshots["ok-0"]).toMatchObject({ failures: 0, daily: { checks: 1, successes: 1 } });
    // 두 경로 모두 보류로 판단했다
    expect(legacy.events.find(row => row.event === "uptime.broad_failure_held")?.fields).toMatchObject({ attempted: 39, down: 15 });
    expect(claims.outcomes["dead-0"]).toBe("split_broad_failure");
    expect(claims.outcomes.unbanned).toBe("split_broad_failure");
  });

  // F7(401·403·429·999 미집계)는 legacy(recordPing → writeHealthUnknown)와 claims(판정 unknown → writeHealthUnknowns)가 같은 목록·같은 기록을
  // 써야 한다. 한쪽만 바뀌면 판정과 쓴 값이 달라 적용기가 uptime_split_health_mismatch 로 틱 전체를 되돌린다 — 그러면 claims 틱(pingProducts)이
  // 던져 이 시험이 실패한다.
  it("봇·로그인 차단 응답(401·403·429·999)은 두 경로 모두 세지도 끊지도 않고 확인 시각·응답 코드만 남긴다 — 숨김·내림도 같다(F7, F1 999)", async () => {
    const { snapshots, claims } = await twin([
      ...many("ok", 30, { response: 200 }),
      { name: "u403", response: 403 },
      { name: "u401", health: { failures: 3, status: 503 }, response: 401 },
      { name: "u429", health: { failures: 9, status: 503 }, response: 429 },
      { name: "u999", health: { failures: 1, status: 503 }, response: 999 },
      { name: "fresh403", health: null, response: 403 },
      { name: "unbanned403", health: { failures: 10, status: 503 }, response: 403 },
      { name: "f404", response: 404 },
    ]);
    expect(snapshots.u403).toEqual({ failures: 0, status: 403, latency: "none", checked: "advanced", downSince: "none",
      daily: { checks: 0, successes: 0, latencySamples: 0 }, hidden: false, productStatus: "seeded" });
    expect(snapshots.u401).toMatchObject({ failures: 3, status: 401, downSince: "same", hidden: true, daily: { checks: 0 } });
    expect(snapshots.u429).toMatchObject({ failures: 9, status: 429, productStatus: "seeded" });
    expect(snapshots.u999).toMatchObject({ failures: 1, status: 999, downSince: "same" });
    expect(snapshots.fresh403).toMatchObject({ failures: 0, status: 403, downSince: "none" });
    // 연속 실패 10회 행도 시각·응답 코드는 넘어가지만 자동 내림 sweep 이 고르지 않는다(마지막 응답이 차단 응답)
    expect(snapshots.unbanned403).toMatchObject({ failures: 10, status: 403, checked: "advanced", productStatus: "seeded" });
    expect(snapshots.f404).toMatchObject({ failures: 1, daily: { checks: 1 } });
    for (const name of ["u403", "u401", "u429", "u999", "fresh403", "unbanned403"]) expect(claims.outcomes[name]).toBe("split_unknown");
    expect(claims.events.find(row => row.event === "uptime.checked")?.fields).toMatchObject({ alive: 30, down: 1, unknown: 6 });
  });

  it("광역 비율에서 알 수 없는 응답은 실패 쪽이다 — 30건 중 403 7 + 503 3 이면 503 은 판정 보류, 403 은 그대로 기록한다", async () => {
    const { snapshots, legacy, claims } = await twin([
      ...many("ok", 20, { response: 200 }),
      ...many("blocked", 7, { response: 403 }),
      ...many("down", 3, { health: { failures: 1, status: 503 }, response: 503 }),
    ]);
    expect(snapshots["down-0"]).toMatchObject({ failures: 1, checked: "advanced", downSince: "same", daily: { checks: 0 } });
    expect(snapshots["blocked-0"]).toMatchObject({ failures: 0, status: 403, checked: "advanced", daily: { checks: 0 } });
    expect(legacy.events.find(row => row.event === "uptime.broad_failure_held")?.fields).toEqual({ attempted: 30, down: 3, unknown: 7 });
    expect(claims.outcomes["down-0"]).toBe("split_broad_failure");
    expect(claims.outcomes["blocked-0"]).toBe("split_unknown");
  });
});
