import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { healthFor } from "@/lib/domain/products/health";
import { applyUptimeResults } from "@/lib/domain/products/uptime-apply";
import { claimUptimeProducts, submitUptimeResults } from "@/lib/domain/products/uptime-claims";
import type { JobLease } from "@/lib/jobs/control";
import type { JobContext } from "@/lib/jobs/runner";
import { pingProducts } from "@/lib/jobs/products/uptime";
import { ensureSchema, resetTables } from "./setup";
import { claimRow, clearSplitState, dailyRows, healthRow, OWNERS, POLICY, product, result, setSplit, takeJobLease,
  type FixtureProduct } from "./uptime-split-fixture";

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

type Target = { name: string; target: FixtureProduct };
type Start = Pick<Spec, "name" | "health" | "listed">;

/** 한 모드로 처음 상태를 만든다(DB 를 비운 뒤). claims 면 제품마다 claim 행을 1분 전 due 로 둔다 */
async function setup(mode: "legacy" | "claims", specs: readonly Start[]): Promise<Target[]> {
  await resetTables();
  await clearSplitState();
  await setSplit(mode, mode === "claims" ? POLICY : null);
  lease = await takeJobLease();
  const targets: Target[] = [];
  for (const spec of specs) {
    targets.push({ name: spec.name, target: await product(spec.name, { claim: mode === "claims", status: spec.listed,
      health: spec.health === null ? null : { failures: spec.health?.failures ?? 0, status: spec.health?.status } }) });
  }
  return targets;
}
/** 주소별 응답(null 은 연결 실패)으로 한 틱 돌린다. 연 주소가 정확히 expected 인지 본다 */
async function tickWith(responses: ReadonlyMap<string, number | null>, expected: readonly string[]): Promise<Logged[]> {
  http.safeFetch.mockReset().mockImplementation(async (url: string) => {
    if (!responses.has(url)) throw new Error(`unexpected_fetch:${url}`);
    const status = responses.get(url);
    return status === null ? null : { finalUrl: url, response: { status, body: null } };
  });
  const events: Logged[] = [];
  await pingProducts(tick(events));
  expect(http.safeFetch.mock.calls.map(([url]) => url as string).sort()).toEqual([...expected].sort());
  return events;
}
type HealthBefore = Awaited<ReturnType<typeof healthRow>>;
/** 틱 전 health 행(before)에 비춘 제품 이름별 정식 기록 */
async function snapshot(mode: "legacy" | "claims", targets: readonly Target[], before: ReadonlyMap<string, HealthBefore>) {
  const hidden = await healthFor(targets.map(({ target }) => target.slug));
  const snapshots: Record<string, Snapshot> = {};
  const outcomes: Record<string, string | null> = {};
  for (const { name, target } of targets) {
    const after = await healthRow(target.slug), prior = before.get(target.slug) ?? null;
    const daily = (await dailyRows(target.slug)).reduce((sum, row) => ({ checks: sum.checks + row.checks, successes: sum.successes + row.successes,
      latencySamples: sum.latencySamples + row.latency_samples }), { checks: 0, successes: 0, latencySamples: 0 });
    const [row] = await db.execute<{ status: string }>(sql`select status from products where id = ${target.id}`);
    snapshots[name] = {
      failures: after?.failures ?? null, status: after?.status ?? null,
      latency: after ? (after.latency_ms === null ? "none" : "some") : null,
      checked: after ? (prior && after.checked_at === prior.checked_at ? "same" : "advanced") : null,
      downSince: after ? (after.down_since === null ? "none" : prior && after.down_since === prior.down_since ? "same" : "new") : null,
      daily, hidden: hidden.get(target.slug)?.down ?? false, productStatus: row.status };
    if (mode === "claims") outcomes[name] = (await claimRow(target.id)).last_outcome;
  }
  return { snapshots, outcomes };
}
const healthBefore = async (targets: readonly Target[]) =>
  new Map(await Promise.all(targets.map(async ({ target }) => [target.slug, await healthRow(target.slug)] as const)));

/**
 * 한 모드로 처음 상태를 만들고 한 틱 돌린 뒤 제품 이름별 정식 기록을 돌려준다. prepare 는 틱 전에 부른다(예: Oracle 제출분 반영)
 */
async function run(mode: "legacy" | "claims", specs: readonly Spec[], prepare?: (targets: readonly Target[]) => Promise<void>) {
  const targets = await setup(mode, specs);
  const before = await healthBefore(targets);
  await prepare?.(targets);
  const byName = new Map(specs.map(spec => [spec.name, spec.response]));
  const events = await tickWith(new Map(targets.map(({ name, target }) => [target.url, byName.get(name)!])), targets.map(({ target }) => target.url));
  return { ...await snapshot(mode, targets, before), events };
}

/**
 * 여러 바퀴. 바퀴마다 응답을 바꿔 한 틱씩 돌리고, 바퀴 사이에는 6시간이 지난 것처럼 확인 시각·첫 실패 시각·제품 수정 시각을 7시간 앞당긴다
 * (claims 는 claim 을 다시 due 로, 10분 차단기 창은 비운다 — 6시간 전 칸은 창에 없다). changeBefore 바퀴 전에는 그 제품을 고친다
 * (products.updated_at = 지금 − 1초). 공개 제품만 확인한다(내린 제품은 두 경로 모두 고르지 않는다).
 */
type CycleSpec = Start & { responses: readonly (number | null)[]; changeBefore?: number };
async function cycles(mode: "legacy" | "claims", specs: readonly CycleSpec[]) {
  const targets = await setup(mode, specs), rounds = Math.max(...specs.map(spec => spec.responses.length));
  const result: Array<Awaited<ReturnType<typeof snapshot>> & { events: Logged[] }> = [];
  for (let round = 0; round < rounds; round++) {
    if (round > 0) {
      // 시각 기준을 모두 같이 옮긴다 — 제품 수정 시각만 그대로 두면 지난 확인·첫 실패가 수정보다 앞선 것처럼 보여 매 바퀴 다시 센다
      await db.execute(sql`update product_health set checked_at = checked_at - interval '7 hours', down_since = down_since - interval '7 hours'`);
      await db.execute(sql`update products set updated_at = updated_at - interval '7 hours'`);
      if (mode === "claims") {
        await db.execute(sql`update uptime_claims set due_at = clock_timestamp() - interval '1 minute' where state = 'idle'`);
        await db.execute(sql`delete from uptime_host_windows`);
      }
    }
    for (const { name, target } of targets) {
      if (specs.find(spec => spec.name === name)!.changeBefore === round) {
        await db.execute(sql`update products set updated_at = (clock_timestamp() at time zone 'UTC') - interval '1 second' where id = ${target.id}`);
      }
    }
    const listed = new Set(Array.from(await db.execute<{ id: number }>(sql`select id from products where status in ('verified', 'seeded')`), row => row.id));
    const live = targets.filter(({ target }) => listed.has(target.id));
    const before = await healthBefore(targets);
    const responses = new Map(live.map(({ name, target }) => [target.url, specs.find(spec => spec.name === name)!.responses[round]]));
    const events = await tickWith(responses, live.map(({ target }) => target.url));
    result.push({ ...await snapshot(mode, targets, before), events });
  }
  return result;
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

  // 한 틱으로는 숨김(3)·내림(10)·제품 수정 뒤 다시 세기까지 이어지는 의미를 다 볼 수 없다 — 6시간 바퀴를 넷 돌려 바퀴마다 비교한다
  it("여러 바퀴: 알 수 없는 응답을 사이에 둔 숨김·10회째 내림·회복·제품 수정 뒤 1부터 다시 세기가 바퀴마다 같다(F7·F1 999)", async () => {
    const specs: CycleSpec[] = [
      { name: "hide", responses: [503, 503, 403, 503] },
      { name: "ban", health: { failures: 8, status: 503 }, responses: [403, 503, 429, 503] },
      { name: "recover", health: { failures: 5, status: 503 }, responses: [999, 401, 200, 200] },
      { name: "changed", responses: [503, 503, 503, 503], changeBefore: 2 },
      { name: "changed-unknown", responses: [503, 403, 503, 503], changeBefore: 1 },
      { name: "stuck999", health: { failures: 9, status: 503 }, responses: [999, 999, 999, 999] },
      { name: "fresh", health: null, responses: [403, 503, 401, null] },
    ];
    const legacy = await cycles("legacy", specs);
    const claims = await cycles("claims", specs);
    for (let round = 0; round < 4; round++) expect(claims[round].snapshots, `round ${round}`).toEqual(legacy[round].snapshots);
    const failures = (name: string) => legacy.map(round => round.snapshots[name].failures);
    expect(failures("hide")).toEqual([1, 2, 2, 3]);
    expect(legacy.map(round => round.snapshots.hide.hidden)).toEqual([false, false, false, true]);
    expect(failures("ban")).toEqual([8, 9, 9, 10]);
    expect(legacy.map(round => round.snapshots.ban.productStatus)).toEqual(["seeded", "seeded", "seeded", "banned"]);
    expect(failures("recover")).toEqual([5, 5, 0, 0]);
    expect(legacy.map(round => round.snapshots.recover.hidden)).toEqual([true, true, false, false]);
    expect(failures("changed")).toEqual([1, 2, 1, 2]);
    expect(legacy[2].snapshots.changed.downSince).toBe("new");
    // 수정 뒤의 알 수 없는 응답은 연속 실패를 끊지도 잇지도 않는다 — 그다음 실패가 수정 전 첫 실패에 이어 붙지 않고 1부터다
    expect(failures("changed-unknown")).toEqual([1, 1, 1, 2]);
    expect(legacy.map(round => round.snapshots["changed-unknown"].downSince)).toEqual(["new", "same", "new", "same"]);
    expect(failures("stuck999")).toEqual([9, 9, 9, 9]);
    expect(legacy[3].snapshots.stuck999).toMatchObject({ status: 999, productStatus: "seeded" });
    expect(failures("fresh")).toEqual([0, 1, 1, 2]);
    expect(claims.map(round => round.outcomes.recover)).toEqual(["split_unknown", "split_unknown", "split_success", "split_success"]);
    expect(claims[3].outcomes.ban).toBe("split_counted");
  });

  // claims 에는 legacy 에 없는 길이 있다: Oracle 이 실패로 보면 home 이 다시 본다(재확인). 최종 기록은 home 이 한 번 본 legacy 와 같아야 한다
  it("Oracle 실패 → home 재확인 경로의 최종 기록이 home 한 번 확인(legacy)과 같다 — 200·403·999·503", async () => {
    const plan = [
      { name: "regional", oracle: { status: 403 }, home: 200 },
      { name: "blocked", oracle: { status: 0, kind: "timeout" as const }, home: 403 },
      { name: "linkedin", oracle: { status: 403 }, home: 999 },
      { name: "dead", oracle: { status: 0, kind: "dns" as const }, home: 503 },
    ];
    const specs: Spec[] = plan.map(({ name, home }) => ({ name, response: home }));
    const legacy = await run("legacy", specs);
    const claims = await run("claims", specs, async targets => {
      const batch = await claimUptimeProducts({ owner: OWNERS.oracle, limit: 40 });
      if (batch.kind !== "claimed") throw new Error(`oracle_claim_blocked:${batch.reason}`);
      const outcomes = new Map(targets.map(({ name, target }) => [target.id, plan.find(row => row.name === name)!.oracle]));
      expect(batch.claims.map(ticket => ticket.productId).sort()).toEqual(targets.map(({ target }) => target.id).sort());
      expect(await submitUptimeResults({ owner: OWNERS.oracle, results: batch.claims.map(ticket => result(ticket, outcomes.get(ticket.productId)!)) }))
        .toMatchObject({ kind: "submitted" });
      expect((await applyUptimeResults({ lease })).outcomes).toMatchObject({ confirm_requested: 4, applied: 0 });
    });
    expect(claims.snapshots).toEqual(legacy.snapshots);
    expect(claims.outcomes).toEqual({ regional: "split_confirm_success", blocked: "split_unknown", linkedin: "split_unknown", dead: "split_confirmed" });
    expect(legacy.snapshots).toMatchObject({ regional: { failures: 0, status: 200 }, blocked: { failures: 0, status: 403 },
      linkedin: { failures: 0, status: 999 }, dead: { failures: 1, status: 503 } });
    expect(claims.events.find(row => row.event === "uptime.checked")?.fields).toMatchObject({ alive: 1, down: 1, unknown: 2 });
  });
});
