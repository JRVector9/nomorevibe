import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import { applyUptimeResults } from "@/lib/domain/products/uptime-apply";
import { claimUptimeProducts, type UptimeClaimTicket } from "@/lib/domain/products/uptime-claims";
import type { UptimeSplitPolicy } from "@/lib/domain/products/uptime-split-policy";
import { runUptimeConsumer, type UptimeCheck } from "@/lib/jobs/products/uptime-consumer";
import { ORACLE_CONSUMER_DB_PROFILES, oracleConsumerGrantStatements } from "@/lib/runtime/oracle-db-profile";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";
import { clearSplitState, dailyRows, POLICY, product, setSplit, TAG, takeJobLease, type FixtureProduct } from "./uptime-split-fixture";

/*
 * U2 Oracle uptime consumer 를 실제 PostgreSQL 에서 본다(design-uptime §8.1 1·2·18, §9 A5~A7 준비).
 * 1) consumer 둘(probe) + M3 잡 경로(home claim·자기 결과 적용·Oracle 제출분 적용)가 동시에 돌아도 같은 제품을 두 번 열지 않고,
 *    같은 사이트를 동시에 두 곳에서 열지 않는다.
 * 2) 실제 진입점(scripts/uptime-consumer.ts)을 생성 SQL 로 만든 uptime 계정으로 띄워 claim·제출·되돌림·관측이 그 권한만으로 되고,
 *    SIGTERM 뒤 열지 않은 claim 이 idle 로 돌아간다.
 * 3) 같은 계정의 consumer preflight 준비 확인과 정식 기록(product_health·일일 집계·raw·due) 쓰기 거절.
 */
const PROFILE = ORACLE_CONSUMER_DB_PROFILES.uptime!;
const password = randomUUID(), release = createHash("sha1").update(password).digest("hex");
const PROBE = { host: "oracle-osaka-smoke" as const, region: "ap-osaka-1", class: "probe" as const, maxPerHour: 20_000, batch: 6, concurrency: 3 };
const HOME = { host: "m3" as const, instanceId: "u2-m3", region: "kr-home", class: "home" as const };
const IT = "uptime-consumer-it";
const policyWith = (...hosts: UptimeSplitPolicy["hosts"]): UptimeSplitPolicy => ({ ...POLICY, hosts });
let admin: postgres.Sql;
let original: { split: Record<string, unknown>; control: Record<string, unknown> | undefined };

async function dropPrincipal() {
  if ((await admin`select 1 from pg_roles where rolname = ${PROFILE.principal}`).length) {
    await admin.unsafe(`DROP OWNED BY ${PROFILE.principal}`);
    await admin.unsafe(`DROP ROLE ${PROFILE.principal}`);
  }
}
beforeAll(async () => {
  ensureSchema();
  admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });
  const [split] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_split_control c where id = 1`);
  const [control] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_control c where id = 1`);
  original = { split: split.row, control: control?.row };
  await dropPrincipal();
  for (const statement of oracleConsumerGrantStatements(PROFILE, { connectionLimit: 4 })) await admin.unsafe(statement);
  await admin.unsafe(`ALTER ROLE ${PROFILE.principal} PASSWORD '${password}'`);
}, 120_000);
beforeEach(async () => {
  await resetTables();
  await clearSplitState();
});
afterAll(async () => {
  try {
    await dropPrincipal();
    expect(await admin`select 1 from pg_roles where rolname = ${PROFILE.principal}`).toHaveLength(0);
    await db.execute(sql`update uptime_split_control set mode = ${original.split.mode as string}, policy = null, policy_hash = null,
      epoch = epoch + 1, updated_at = clock_timestamp() where id = 1`);
    if (original.control) {
      await db.execute(sql`update uptime_control set observations_enabled = ${original.control.observations_enabled as boolean},
        gate_enabled = ${original.control.gate_enabled as boolean} where id = 1`);
    }
    await db.execute(sql`update jobs set lease_token = null, locked_at = null where name = 'uptime-ping'`);
  } finally { await admin?.end({ timeout: 5 }); }
}, 60_000);

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Visit = { owner: string; id: number; origin: string; start: number; end: number };

it("two Oracle consumers and the M3 job path share one queue: no product twice, no site opened by two places at once", async () => {
  const consumers = ["uptime-consumer-u2a", "uptime-consumer-u2b"];
  await setSplit("claims", policyWith(HOME, ...consumers.map(instanceId => ({ ...PROBE, instanceId }))));
  // 9개 사이트에 4개씩, due 순서로 이어 붙인다 — 한 묶음(6)에 같은 사이트 제품이 함께 오고(owner 안 한 줄), 묶음 경계가 사이트를
  // 가르므로 다음 owner 는 아직 잡혀 있는 사이트의 남은 제품을 건너뛰어야 한다(owner 사이 origin 배타)
  const targets: FixtureProduct[] = [];
  for (let index = 0; index < 36; index++) targets.push(await product(`ov${index}`, { url: `https://u2-${TAG}-s${Math.floor(index / 4)}.example/p${index}` }));
  const visits: Visit[] = [];
  const visit = (owner: string) => async (ticket: UptimeClaimTicket): Promise<UptimeCheck> => {
    const startedAt = new Date(), start = performance.now();
    // 시작 간격(20,000/h = 180ms)보다 길게 — 한 owner 안에서도 여러 확인이 겹쳐 열려 있다
    await sleep(250 + Math.floor(Math.random() * 150));
    visits.push({ owner, id: ticket.productId, origin: new URL(ticket.url).origin, start, end: performance.now() });
    return { startedAt, observedAt: new Date(), kind: "http", status: 200, latencyMs: 30, elapsedMs: 30 };
  };
  const stop = new AbortController();
  const running = consumers.map(instanceId => runUptimeConsumer({ owner: { instanceId, bootId: randomUUID() }, signal: stop.signal, check: visit(instanceId) }));
  // M3 잡 경로(U1c 가 uptime-ping 에 넣을 순서): 제출분 적용 → home claim → 확인 → 자기 결과 적용
  const home = (async () => {
    const lease = await takeJobLease(), owner = { instanceId: HOME.instanceId, bootId: randomUUID() }, check = visit(HOME.instanceId);
    while (!stop.signal.aborted) {
      await applyUptimeResults({ lease });
      const batch = await claimUptimeProducts({ owner, limit: 6 });
      if (batch.kind !== "claimed") throw new Error(`home_claim_blocked:${batch.reason}`);
      if (!batch.claims.length) { await sleep(50); continue; }
      const own = [];
      for (const ticket of batch.claims) {
        const seen = await check(ticket);
        own.push({ productId: ticket.productId, token: ticket.token, epoch: ticket.epoch, startedAt: seen.startedAt, observedAt: seen.observedAt,
          kind: seen.kind, status: seen.status, latencyMs: seen.latencyMs });
      }
      await applyUptimeResults({ lease, own, submittedLimit: 0 });
    }
    await applyUptimeResults({ lease });
  })();
  const ids = targets.map(target => target.id);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const [row] = await db.execute<{ applied: number }>(sql`select count(*)::int as applied from uptime_claims
      where product_id = any(${`{${ids.join(",")}}`}::int[]) and last_applied_at is not null`);
    if (row.applied === ids.length || Date.now() > deadline) break;
    await sleep(100);
  }
  stop.abort();
  const summaries = await Promise.all(running);
  await home;

  expect(visits.map(item => item.id).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
  for (const [index, first] of visits.entries()) {
    for (const second of visits.slice(index + 1)) {
      if (first.origin !== second.origin) continue;
      expect(first.end <= second.start || second.end <= first.start, `${first.owner}/${first.id} ↔ ${second.owner}/${second.id}`).toBe(true);
    }
  }
  expect(new Set(visits.map(item => item.owner)).size).toBeGreaterThanOrEqual(2);
  const probeChecked = summaries.reduce((total, summary) => total + summary.checked, 0);
  expect(summaries.reduce((total, summary) => total + summary.accepted, 0)).toBe(probeChecked);
  expect(summaries.reduce((total, summary) => total + summary.lost, 0)).toBe(0);
  for (const target of targets) expect((await dailyRows(target.slug)).map(row => row.checks), target.slug).toEqual([1]);
  const [rows] = await db.execute<{ claimed: number; submitted: number }>(sql`select count(*) filter (where state = 'claimed')::int as claimed,
    count(*) filter (where state = 'submitted')::int as submitted from uptime_claims where product_id = any(${`{${ids.join(",")}}`}::int[])`);
  expect(rows).toEqual({ claimed: 0, submitted: 0 });
}, 120_000);

function principalUrl() {
  const url = new URL(TEST_DATABASE_URL);
  url.username = PROFILE.principal; url.password = password;
  return url.toString();
}
const baseEnv = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? "test", LOG_LEVEL: "error",
  DATABASE_URL: principalUrl(), DB_POOL_MAX: "2", DB_POOLER_MODE: "direct", TZ: "UTC", SERVICE_INSTANCE_ID: IT, ...extra });
function exited(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("child_timeout")); }, ms);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
}

it("the real entry point as the uptime principal claims, submits the in-flight check after SIGTERM and returns unopened claims to idle", async () => {
  const requests: string[] = [];
  let first!: () => void;
  const arrived = new Promise<void>(resolve => { first = resolve; });
  const server: Server = createServer((request, response) => {
    requests.push(request.url ?? "");
    first();
    setTimeout(() => { response.writeHead(200, { "content-type": "text/html" }); response.end("<html>ok</html>"); }, 400);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await setSplit("claims", policyWith(HOME, { ...PROBE, instanceId: IT }));
    // 한 사이트의 6건 — 한 줄로 차례로 연다. 첫 요청이 닿으면 SIGTERM
    const targets: FixtureProduct[] = [];
    for (let index = 0; index < 6; index++) targets.push(await product(`sig${index}`, { url: `${origin}/p${index}` }));
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/uptime-consumer.ts"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
      env: baseEnv({ UPTIME_CONSUMER_VERSION: "1", ALLOW_PRIVATE_URLS: "1", HTTP_ORIGIN_PERMITS: "0", PHYSICAL_HOST: "oracle-osaka-smoke" }) });
    let output = "";
    child.stdout?.on("data", data => { output += String(data); });
    child.stderr?.on("data", data => { output += String(data); });
    const exit = exited(child, 60_000);
    await Promise.race([arrived, exit.then(() => { throw new Error(`child_exited_early:${output.slice(-2000)}`); })]);
    child.kill("SIGTERM");
    expect(await exit, output.slice(-2000)).toBe(0);
    expect(requests).toEqual(["/p0"]);

    const rows = await db.execute<{ product_id: number; state: string; token: string | null; owner_instance_id: string | null; host: string | null;
      epoch: number; result_status: number | null; lease_until: string | null }>(sql`select product_id, state, token::text as token, owner_instance_id,
      host, epoch::int as epoch, result_status, lease_until::text as lease_until from uptime_claims
      where product_id = any(${`{${targets.map(target => target.id).join(",")}}`}::int[]) order by product_id`);
    expect(rows.map(row => [row.state, row.owner_instance_id, row.host, row.epoch])).toEqual([
      ["submitted", IT, "oracle-osaka-smoke", 1], ...Array.from({ length: 5 }, () => ["idle", IT, "oracle-osaka-smoke", 1])]);
    expect(rows[0].result_status).toBe(200);
    expect(rows.slice(1).every(row => row.token === null && row.lease_until === null)).toBe(true);
    // 정식 기록은 쓰지 않았다(적용기는 home 잡 몫)
    for (const target of targets) expect(await dailyRows(target.slug)).toEqual([]);
    const [observation] = await db.execute<{ value: Record<string, unknown> }>(sql`select value from operations_observations
      where key = ${`uptime-consumer:${IT}`}`);
    expect(observation.value).toMatchObject({ state: "stopped", host: "oracle-osaka-smoke", class: "probe", claimed5m: 6, checked5m: 1,
      accepted5m: 1, released5m: 5, lost5m: 0, negatives5m: 0, pacing: { maxPerHour: 20_000, batch: 6, concurrency: 3 } });
    expect(observation.value.dbReadP50Ms).toEqual(expect.any(Number));
    expect(observation.value.claimTxP50Ms).toEqual(expect.any(Number));
    expect(observation.value.rssBytes).toEqual(expect.any(Number));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 120_000);

type Report = { checks: Record<string, { status: string; reason: string }>; workload: { ready: boolean; reason: string } };
function preflight(negatives: string[], extra: Record<string, string> = {}): Promise<{ preflight: Report; negatives: Record<string, string>; principal: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/oracle-consumer-preflight-driver.ts"], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
      env: baseEnv({ WORKER_ROLE: "maintenance", RELEASE_TAG: release, PHYSICAL_HOST: "oracle-osaka-smoke", DB_STATEMENT_TIMEOUT_MS: "10000",
        ORACLE_DRIVER_INPUT: JSON.stringify({ consumer: "uptime", role: "maintenance", negatives }), ...extra }),
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    child.once("error", reject);
    child.once("exit", () => {
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
        if ("error" in parsed) throw new Error(JSON.stringify(parsed));
        resolve(parsed);
      } catch (error) { reject(new Error(`driver_failed:${String(error)}:${stderr.slice(-2000)}`)); }
    });
  });
}

it("the uptime principal passes its consumer preflight only as an Oracle probe in claims mode and cannot write authoritative records", async () => {
  await setSplit("claims", policyWith(HOME, { ...PROBE, instanceId: IT }));
  // 정식 기록·판정 열·다른 표는 모두 권한 없음(42501). claim 열 갱신·읽기는 된다
  const denied = ["INSERT INTO public.product_health(slug, checked_at, status, failures) SELECT 'x', now(), 200, 0 WHERE false",
    "UPDATE public.product_health SET failures = failures WHERE false", "INSERT INTO public.product_health_daily(slug, day) SELECT 'x', current_date WHERE false",
    "INSERT INTO public.uptime_observations(observation_id) SELECT gen_random_uuid() WHERE false",
    "UPDATE public.uptime_claims SET due_at = due_at WHERE false", "UPDATE public.uptime_claims SET last_outcome = last_outcome WHERE false",
    "UPDATE public.uptime_claims SET confirm_class = confirm_class WHERE false", "INSERT INTO public.uptime_claims(product_id) SELECT 1 WHERE false",
    "DELETE FROM public.uptime_claims WHERE false", "UPDATE public.uptime_host_breakers SET state = state WHERE false",
    "SELECT 1 FROM public.uptime_host_windows LIMIT 1", "UPDATE public.uptime_split_control SET mode = mode WHERE false",
    "SELECT 1 FROM public.uptime_control LIMIT 1", "UPDATE public.products SET status = status WHERE false",
    "SELECT 1 FROM public.product_health_daily LIMIT 1", "SELECT 1 FROM public.http_origin_control LIMIT 1"];
  const allowed = ["UPDATE public.uptime_claims SET state = state WHERE false", "SELECT 1 FROM public.product_health LIMIT 1",
    "SELECT 1 FROM public.uptime_host_breakers LIMIT 1"];
  const ready = await preflight([...denied, ...allowed]);
  expect(ready.principal).toBe(PROFILE.principal);
  expect(ready.preflight.checks.database).toMatchObject({ status: "verified", reason: "approved_privilege_profile_matches" });
  expect(ready.preflight.checks.consumer).toEqual({ status: "verified", reason: "split_claims_probe_ready" });
  expect(ready.preflight.workload).toEqual({ ready: true, reason: "ready" });
  expect(ready.negatives).toEqual({ ...Object.fromEntries(denied.map(statement => [statement, "42501"])),
    ...Object.fromEntries(allowed.map(statement => [statement, "allowed"])) });

  expect((await preflight([], { HTTP_ORIGIN_PERMITS: "1" })).preflight.checks.consumer).toEqual({ status: "rejected", reason: "http_origin_permits_enabled" });
  // 운영(PgBouncer)은 계정 기본값(10초)으로 열린다. direct 모드에서 maintenance pool 기본(120초)을 그대로 두면 닫힌다
  expect((await preflight([], { DB_POOLER_MODE: "pgbouncer" })).preflight.checks.timeouts).toEqual({ status: "verified", reason: "role_server_timeouts_bounded" });
  const unbounded = await preflight([], { DB_STATEMENT_TIMEOUT_MS: "120000" });
  expect(unbounded.preflight.checks.timeouts).toEqual({ status: "rejected", reason: "effective_session_timeouts_unbounded" });
  expect(unbounded.preflight.workload).toEqual({ ready: false, reason: "timeouts_rejected" });
  await setSplit("claims", policyWith(HOME, { ...HOME, instanceId: IT }));
  const home = await preflight([]);
  expect(home.preflight.checks.consumer).toEqual({ status: "rejected", reason: "instance_not_oracle_probe" });
  expect(home.preflight.workload).toEqual({ ready: false, reason: "consumer_rejected" });
  await setSplit("claims", policyWith(HOME));
  expect((await preflight([])).preflight.checks.consumer).toEqual({ status: "unknown", reason: "instance_not_in_split_policy" });
  await setSplit("legacy", null);
  const legacy = await preflight([]);
  expect(legacy.preflight.checks.consumer).toEqual({ status: "unknown", reason: "split_mode_legacy" });
  expect(legacy.preflight.workload).toEqual({ ready: false, reason: "consumer_unknown" });
}, 120_000);
