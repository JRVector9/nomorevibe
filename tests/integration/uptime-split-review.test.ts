import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { downProductCount } from "@/lib/domain/products/health";
import { applyUptimeResults } from "@/lib/domain/products/uptime-apply";
import { claimUptimeProducts, releaseUptimeClaims, submitUptimeResults } from "@/lib/domain/products/uptime-claims";
import type { JobLease } from "@/lib/jobs/control";
import type { JobContext } from "@/lib/jobs/runner";
import { pingProducts } from "@/lib/jobs/products/uptime";
import { runUptimeConsumer } from "@/lib/jobs/products/uptime-consumer";
import { batchPolicyHash } from "@/lib/jobs/batches";
import { parsePipelineControlArgs, type TransitionCommand } from "@/lib/operations/pipeline-control";
import { runPipelineControl } from "@/lib/operations/pipeline-control-repository";
import { parseUptimeSplitArgs, type UptimeSplitTransition } from "@/lib/operations/uptime-split";
import { readUptimeSplitReadback, readUptimeSplitStage, runUptimeSplitControl } from "@/lib/operations/uptime-split-repository";
import { classifyStage } from "@/lib/operations/worker-progress";
import { ORACLE_CONSUMER_DB_PROFILES, oracleConsumerGrantStatements } from "@/lib/runtime/oracle-db-profile";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";
import { claimRow, clearSplitState, dbNow, healthRow, nextCycle, OWNERS, POLICY, product, rawRows, result, setSplit, takeJobLease,
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

describe("F3 제출 출처", () => {
  const PROFILE = ORACLE_CONSUMER_DB_PROFILES.uptime!;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  let oracle: ReturnType<typeof postgres>;
  const drop = async () => {
    if ((await admin`select 1 from pg_roles where rolname = ${PROFILE.principal}`).length === 0) return;
    await admin.unsafe(`DROP OWNED BY ${PROFILE.principal}`);
    await admin.unsafe(`DROP ROLE ${PROFILE.principal}`);
  };
  beforeAll(async () => {
    await drop();
    // 운영 least-privilege.sql 과 같은 문장으로 만든 Oracle uptime principal
    for (const statement of oracleConsumerGrantStatements(PROFILE, { connectionLimit: 4 })) await admin.unsafe(statement);
    const password = randomUUID();
    await admin.unsafe(`ALTER ROLE ${PROFILE.principal} PASSWORD '${password}'`);
    const url = new URL(TEST_DATABASE_URL);
    url.username = PROFILE.principal; url.password = password;
    oracle = postgres(url.toString(), { max: 1, onnotice: () => {} });
  });
  afterAll(async () => {
    await oracle?.end({ timeout: 5 });
    await drop();
    await admin.end({ timeout: 5 });
  });

  it("Oracle principal 이 home(m3) 실패 제출 행을 써도 적용기는 판정하지 않는다 — 세 번 위조해도 숨김이 없다", async () => {
    const target = await product("victim");
    // 정책에 있는 home instance·host m3·home 으로 "연결 실패" 제출 행을 한 문장으로 만든다(principal 의 열 UPDATE 권한 안)
    const forge = () => oracle`update uptime_claims c set state = 'submitted', epoch = c.epoch + 1,
        control_epoch = (select epoch from uptime_split_control where id = 1), token = gen_random_uuid(),
        owner_instance_id = ${OWNERS.m3.instanceId}, owner_boot_id = gen_random_uuid(), host = 'm3', host_class = 'home',
        claimed_at = clock_timestamp() - interval '5 seconds', claim_slug = p.slug, claim_url = p.url,
        origin = lower(substring(p.url from '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]+')),
        result_started_at = clock_timestamp() - interval '4 seconds', result_observed_at = clock_timestamp() - interval '3 seconds',
        result_kind = 'network', result_status = 0, result_latency_ms = null, lease_until = null,
        submitted_at = clock_timestamp(), updated_at = clock_timestamp()
      from products p where p.id = c.product_id and c.product_id = ${target.id} returning c.product_id`;
    for (let round = 1; round <= 3; round++) {
      expect(await forge()).toHaveLength(1);
      const summary = await applyUptimeResults({ lease });
      expect(summary).toMatchObject({ remote: 1, outcomes: { discarded: 1, applied: 0 }, reasons: { submitted_not_probe: 1 } });
      expect(await healthRow(target.slug)).toMatchObject({ failures: 0 });
      expect(await claimRow(target.id)).toMatchObject({ state: "idle", last_outcome: "submitted_not_probe" });
      await nextCycle(target);
    }
    expect(await rawRows(target.slug)).toEqual([]);
    expect(await downProductCount()).toBe(0);
  });

  it("F11: Oracle principal 은 products 에서 claim 이 쓰는 열만 읽는다(verify_token·edit_token_hash 못 읽음)", async () => {
    const target = await product("columns");
    expect(await oracle`select id, slug, url, status, access_mode from products where id = ${target.id}`).toHaveLength(1);
    for (const column of ["verify_token", "edit_token_hash", "*"]) {
      const error = await oracle.unsafe(`select ${column} from products limit 1`).then(() => null, (value: unknown) => value as { code?: string });
      expect(error?.code, column).toBe("42501");
    }
  });

  it("home instance 는 제출할 수 없다(home 결과는 잡이 적용기에 직접 넘긴다)", async () => {
    const target = await product("home-submit");
    const batch = await claimUptimeProducts({ owner: OWNERS.m3, limit: 5 });
    if (batch.kind !== "claimed") throw new Error(`home_blocked:${batch.reason}`);
    const ticket = batch.claims.find(claim => claim.productId === target.id)!;
    expect(await submitUptimeResults({ owner: OWNERS.m3, results: [result(ticket, { status: 0, kind: "network" })] }))
      .toMatchObject({ kind: "blocked", reason: "source_unconfigured" });
    expect(await claimRow(target.id)).toMatchObject({ state: "claimed" });
  });
});

describe("F5 host 시계 차", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("home 시계가 DB 보다 60초 앞서면 claim·확인을 쉬고 오류 이벤트를 남긴다 — 같은 제품을 매 틱 다시 열지 않는다", async () => {
    const rows = await products("skew-home", 10);
    respond(new Map());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const events: Logged[] = [];
    for (let n = 0; n < 3; n++) await pingProducts(tick(events));
    vi.useRealTimers();
    expect(http.safeFetch).not.toHaveBeenCalled();
    for (const row of rows) expect(await claimRow(row.id)).toMatchObject({ state: "idle", token: null, last_outcome: null });
    const skews = events.filter(row => row.event === "uptime.split_clock_skew");
    expect(skews).toHaveLength(3);
    expect(Number(skews[0].fields?.skewMs)).toBeGreaterThan(55_000);
  });

  it("Oracle 시계가 60초 늦으면 consumer 는 claim 하지 않고 쉰다(clock_skew) — 매 묶음 lost·되돌림·재확인 고리가 없다", async () => {
    const fast = { ...POLICY, hosts: POLICY.hosts.map(host => host.class === "probe" ? { ...host, maxPerHour: 20_000, batch: 5, concurrency: 5 } : host) };
    await setSplit("claims", fast);
    const rows = await products("skew-oracle", 5);
    const check = vi.fn();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() - 60_000));
    const totals = { batches: 0, claimed: 0, checked: 0 };
    for (let n = 0; n < 3; n++) {
      const summary = await runUptimeConsumer({ owner: OWNERS.oracle, once: true, check, physicalHost: "oracle-osaka-smoke" });
      totals.batches += summary.batches; totals.claimed += summary.claimed; totals.checked += summary.checked;
    }
    vi.useRealTimers();
    expect(totals).toEqual({ batches: 0, claimed: 0, checked: 0 });
    expect(check).not.toHaveBeenCalled();
    for (const row of rows) expect(await claimRow(row.id)).toMatchObject({ state: "idle", epoch: 0 });
    const [observed] = await db.execute<{ value: { reason: string; clockSkewMs: number } }>(sql`
      select value from operations_observations where key = ${`uptime-consumer:${OWNERS.oracle.instanceId}`}`);
    expect(observed.value.reason).toBe("clock_skew");
    expect(observed.value.clockSkewMs).toBeLessThan(-55_000);
  });
});

describe("F6 claims 와 batch versioned 의 상호 배제", () => {
  const raw = postgres(TEST_DATABASE_URL, { max: 2, onnotice: () => {} });
  const audit = ["--operator=fxu-test", "--reason=review F6"];
  const BATCH_POLICY = { version: 1 as const, release: "fxu-test", instances: [{ instanceId: "fxu-m3-maintenance", host: "m3" as const }] };
  let batchBefore: Record<string, unknown>;
  const batchRow = async () => (await raw`select mode, draining_from, epoch::int as epoch from job_batch_control where id = 1`)[0];
  const control = (...args: string[]) => parsePipelineControlArgs([...args, ...audit]) as TransitionCommand;
  const split = (...args: string[]) => parseUptimeSplitArgs([...args, ...audit]) as UptimeSplitTransition;
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  beforeAll(async () => {
    [batchBefore] = await raw`select to_jsonb(b) as row from job_batch_control b where id = 1`;
  });
  beforeEach(async () => {
    // legacy·계약 1·유효한 batch policy — 판정이 split 말고는 막을 것이 없는 출발점
    await raw`update job_batch_control set mode = 'legacy', draining_from = null, writer_contract_version = 1,
      policy = ${JSON.stringify(BATCH_POLICY)}::text::jsonb, policy_hash = ${batchPolicyHash(BATCH_POLICY)} where id = 1`;
  });
  afterAll(async () => {
    const row = (batchBefore as { row: Record<string, unknown> }).row;
    await raw`update job_batch_control set mode = ${row.mode as string}, draining_from = ${row.draining_from as string | null},
      writer_contract_version = ${row.writer_contract_version as number}, policy = ${row.policy === null ? null : JSON.stringify(row.policy)}::text::jsonb,
      policy_hash = ${row.policy_hash as string | null} where id = 1`;
    await raw.end({ timeout: 5 });
  });

  it("claims 동안 batch drain(legacy→)·complete(→versioned)을 거절한다", async () => {
    const { epoch } = await batchRow();
    const drain = await runPipelineControl(db, control("batch", "drain", "--from-mode=legacy", `--expect-epoch=${epoch}`, "--execute"));
    expect(drain).toMatchObject({ executed: false, blocked: true, plan: { blocked: ["uptime_split_claims_active"] } });
    await raw`update job_batch_control set mode = 'draining', draining_from = 'legacy' where id = 1`;
    const complete = await runPipelineControl(db, control("batch", "complete", "--draining-from=legacy", "--to=versioned", `--expect-epoch=${epoch}`, "--execute"));
    expect(complete.plan.blocked).toContain("uptime_split_claims_active");
    expect(await batchRow()).toMatchObject({ mode: "draining", epoch });
  });

  it("경합: batch drain 실행이 commit 안 된 split claims 전환을 기다렸다가 잠근 뒤 다시 판정해 쓰지 않는다", async () => {
    await setSplit("legacy");
    const { epoch } = await batchRow();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = raw.begin(async tx => {
      await tx`update uptime_split_control set mode = 'claims', epoch = epoch + 1 where id = 1`;
      await gate;
    });
    await pause(100);
    // 처음 읽기(dry-run 판정)는 commit 전 legacy 를 본다 → 실행 TX 는 split SHARE 에서 기다린다
    const running = runPipelineControl(db, control("batch", "drain", "--from-mode=legacy", `--expect-epoch=${epoch}`, "--execute"));
    await pause(300);
    release();
    await holder;
    const result = await running;
    expect(result).toMatchObject({ executed: false, blocked: true, plan: { blocked: ["uptime_split_claims_active"] } });
    expect(await batchRow()).toMatchObject({ mode: "legacy", epoch });
  });

  it("경합: split claims 실행이 commit 안 된 batch drain 을 기다렸다가 잠근 뒤 다시 판정해 쓰지 않는다", async () => {
    const epoch = await setSplit("legacy");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = raw.begin(async tx => {
      await tx`update job_batch_control set mode = 'draining', draining_from = 'legacy' where id = 1`;
      await gate;
    });
    await pause(100);
    const running = runUptimeSplitControl(db, split("mode", "--to=claims", "--from-mode=legacy", `--expect-epoch=${epoch}`, "--execute"));
    await pause(300);
    release();
    await holder;
    const result = await running;
    expect(result).toMatchObject({ executed: false, blocked: true });
    expect(result.plan.blocked).toContain("batch_mode_not_legacy:draining");
    expect((await raw`select mode, epoch::int as epoch from uptime_split_control where id = 1`)[0]).toMatchObject({ mode: "legacy", epoch });
  });
});

describe("F9 재확인 대기 지표", () => {
  it("재확인 요청 중 비공개가 된 제품은 대기 수·최장에서 빠진다", async () => {
    const [kept, hidden] = [await product("confirm-kept"), await product("confirm-hidden")];
    for (const [target, minutes] of [[kept, 5], [hidden, 120]] as const) {
      await db.execute(sql`update uptime_claims set confirm_class = 'home', confirm_reason = 'timeout:0',
        confirm_requested_at = clock_timestamp() - ${minutes} * interval '1 minute' where product_id = ${target.id}`);
    }
    await db.execute(sql`update products set status = 'banned' where id = ${hidden.id}`);
    const { queue } = await readUptimeSplitReadback(db);
    expect(queue.confirm).toBe(1);
    expect(queue.confirmOldestMinutes).toBeGreaterThan(4.9);
    expect(queue.confirmOldestMinutes).toBeLessThan(6);
  });
});
