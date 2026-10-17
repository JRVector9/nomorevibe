import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { clearAllMemos } from "@/lib/cache/memo";
import * as fence from "@/lib/operations/dr/epoch";
import * as repo from "@/lib/operations/dr/repository";
import type { PromotionPlan } from "@/lib/operations/dr/promotion";
import { assertWebWritable, webWritable } from "@/lib/operations/dr/web-gate";
import { runJob } from "@/lib/jobs/runner";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { claimItemLease, lockItemStage } from "@/lib/jobs/items/repository";
import { claimFetchItem } from "@/lib/crawl/repository";
import { recordSearch } from "@/lib/domain/products/search-log";
import { POST as cronPost } from "@/app/api/cron/[job]/route";
import { GET as goGet } from "@/app/go/[slug]/route";
import { POST as feedbackWebhook } from "@/app/api/github/webhooks/feedback/route";
import { POST as userLogout } from "@/app/api/auth/user/logout/route";
import { requestOperation } from "@/app/(operator)/admin/status/actions";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => ({ login: "pr15e-operator" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

/*
 * PR15e 실제 PostgreSQL. 이 파일이 만들고 지우는 임시 DB 세 개만 쓴다(공유 test DB 의 행·제어값은 건드리지 않는다).
 * - web: route handler·server action 을 직접 부른다. active 면 기존대로 쓰고, fenced 면 쓰기 전에 503/거절·DB 무변경.
 *   캐시가 아직 active 인 창에서도 관리자 쓰기 TX 는 첫 lock(fence SHARE)에서 거절된다. fence 행이 없으면 fail-closed.
 * - worker: item lease claim·runJob ACK·lease 를 든 withJobLeaseWrite 가 fenced DB 에 아무것도 쓰지 않는다.
 * - order: 실제 backend 로 잠금 순서를 고정해 본다. 역순(jobs/item → fence)은 seal 과 40P01, 출하 순서(fence 먼저)는 줄만 선다.
 * 실제 provider·외부 HTTP·운영 resolver 는 쓰지 않는다.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));
const tag = randomBytes(6).toString("hex"), prefix = `pr15e-${tag}`, operator = "pr15e-root-driver";
const names = { web: `nomorevibe_test_pr15e_w_${tag}`, worker: `nomorevibe_test_pr15e_k_${tag}`, order: `nomorevibe_test_pr15e_o_${tag}` } as const;
type Side = keyof typeof names;
const urlOf = (side: Side) => { const value = new URL(TEST_DATABASE_URL); value.pathname = `/${names[side]}`; return value.toString(); };
const created: Side[] = [], pools = new Map<Side, postgres.Sql>();
const pool = (side: Side) => { let client = pools.get(side); if (!client) { client = postgres(urlOf(side), { max: 10, prepare: false, onnotice: () => {} }); pools.set(side, client); } return client; };
/** lib/db 를 이 쪽 DB 로 돌리고, 다른 DB 에서 읽은 fence 캐시를 버린다. */
function bindDb(side: Side) { const g = globalThis as { db?: unknown; pgClient?: unknown }; g.pgClient = pool(side); g.db = drizzle(pool(side), { schema }); clearAllMemos(); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pgCode = (error: unknown): string | undefined => {
  const value = error as { code?: string; cause?: { code?: string } } | undefined;
  return value?.code ?? value?.cause?.code;
};
const itemOwner = { instanceId: `${prefix}-items`, bootId: randomUUID() };
const CRON = "pr15e-cron-secret-0123456789";
/** 경로가 건드릴 수 있는 장부의 내용 digest. fence 의 FOR SHARE 는 행 내용을 바꾸지 않는다. */
const WATCHED = ["jobs", "operations_audit", "operations_observations", "click_events", "rate_limits", "visit_collection_state", "search_queries",
  "github_webhook_events", "public_sessions", "crawl_frontier", "pipeline_item_leases", "pipeline_stage_modes", "dr_writer_fence", "dr_fence_events"] as const;
async function digest(side: Side, tables: readonly string[] = WATCHED): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    const [row] = await pool(side).unsafe(`SELECT count(*)::int AS n, md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY to_jsonb(t)::text), '')) AS h FROM ${table} t`);
    out[table] = `${row.n}:${row.h}`;
  }
  return out;
}
async function seedProduct(side: Side, n: number) {
  const slug = `${prefix}-${side}-${n}`;
  await pool(side)`INSERT INTO products (slug, url, name, tagline, description, category, status, verify_token, edit_token_hash)
    VALUES (${slug}, ${`https://${slug}.example`}, ${slug}, 'Fence', 'Fence', 'Other', 'verified', 'test', ${"a".repeat(64)})`;
  return slug;
}
async function seedFrontier(side: Side, n: number) {
  const [row] = await pool(side)<{ id: number }[]>`INSERT INTO crawl_frontier (repo, signal, state, next_attempt_at)
    VALUES (${`${prefix}-${side}/r${n}`}, 'pr15e', 'pending', now() - interval '1 minute') RETURNING id`;
  return row.id;
}
async function itemStages(side: Side) {
  await pool(side)`UPDATE pipeline_stage_modes SET mode = 'items', writer_contract_version = 1 WHERE stage = 'fetch'`;
}
/** 지금 묶인 DB 를 운영자 fence 한다. 웹 캐시는 버리지 않는다(TTL 창을 그대로 둔다). */
async function fenceSite() {
  const site = await db.transaction(tx => fence.readDatabaseIdentity(tx)), active = await db.transaction(tx => fence.lockWriterFence(tx, "share"));
  await db.transaction(tx => fence.fenceWriterSite(tx, { lineageId: active.lineageId, writerEpoch: active.writerEpoch, db: site, operator }));
}
/** 실제 backend 의 lock 대기 그래프. */
async function waiters(side: Side): Promise<{ pid: number; blockers: number[]; query: string }[]> {
  return Array.from(await pool(side)<{ pid: number; blockers: number[]; query: string }[]>`SELECT pid, pg_blocking_pids(pid) AS blockers, query
    FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' ORDER BY pid`);
}
async function waitFor<T>(probe: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) { const value = await probe(); if (value !== undefined) return value; await sleep(25); }
  throw new Error(`timeout:${label}`);
}
async function planFor(side: Side): Promise<PromotionPlan> {
  bindDb(side);
  const here = await db.transaction(tx => fence.readDatabaseIdentity(tx)), active = await db.transaction(tx => fence.lockWriterFence(tx, "share"));
  const [now] = await pool(side)<{ now: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  return { version: 1, promotionId: randomUUID(), lineageId: active.lineageId, fromEpoch: active.writerEpoch, knownActiveEpoch: active.writerEpoch,
    restoredDb: here, oldDbs: [{ systemIdentifier: "7000000000000000001", databaseOid: "16384", databaseName: "pr15e_former_primary" }],
    oldInstances: [`${prefix}-declared`], snapshotAt: now.now, operator };
}
const cron = (job: string) => cronPost(new Request(`https://nomorevibe.test/api/cron/${job}`, { method: "POST", headers: { authorization: `Bearer ${CRON}` } }),
  { params: Promise.resolve({ job }) });
const go = (slug: string) => goGet(new Request(`https://nomorevibe.test/go/${slug}`, { headers: { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" } }),
  { params: Promise.resolve({ slug }) });
const search = () => recordSearch({ query: `${prefix} search`, keywords: null, results: 2, filtered: false, startedAt: new Date() });

beforeAll(async () => {
  ensureSchema();
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("VISITOR_HASH_SECRET", "pr15e-visitor-secret-0123456789abcdef");
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  expect(journal.entries.map(entry => entry.tag)).toContain("0095_dr_writer_fence");
  const shared = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const [applied] = await shared<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(applied.count).toBe(journal.entries.length);
    for (const side of Object.keys(names) as Side[]) { await shared.unsafe(`CREATE DATABASE ${names[side]}`); created.push(side); }
  } finally { await shared.end({ timeout: 5 }); }
  for (const side of Object.keys(names) as Side[]) {
    const client = postgres(urlOf(side), { max: 1, onnotice: () => {} });
    try { await client.unsafe("set statement_timeout = 0"); await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") }); }
    finally { await client.end({ timeout: 5 }); }
    expect((await pool(side)`SELECT state FROM dr_writer_fence WHERE id = 1`)[0].state).toBe("active");
  }
  console.info("pr15e_migrations", { journal: journal.entries.length });
}, 600_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  for (const client of pools.values()) await client.end({ timeout: 5 });
  const g = globalThis as { db?: unknown; pgClient?: unknown }; delete g.db; delete g.pgClient;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { for (const side of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${names[side]} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

const web = { slug: "" };

it("active site: web writes go through exactly as before (cron request, admin TX, click, search record)", async () => {
  bindDb("web");
  const w = pool("web");
  web.slug = await seedProduct("web", 1);
  const res = await cron("news-refresh");
  expect(res.status).toBe(202);
  expect(await requestOperation("crawl-fetch")).toEqual({ message: "실행 요청을 기록했습니다. 담당 워커가 순서대로 처리합니다." });
  const clicked = await go(web.slug);
  expect(clicked.status).toBe(302);
  expect(clicked.headers.get("location")).toBe(`https://${web.slug}.example/`);
  await search();
  expect((await w`SELECT requested_version FROM jobs WHERE name = 'news-refresh'`)[0].requested_version).toBe("1");
  expect((await w`SELECT requested_version FROM jobs WHERE name = 'crawl-fetch'`)[0].requested_version).toBe("1");
  expect((await w`SELECT count(*)::int AS n FROM operations_audit WHERE action = 'request-job' AND target = 'crawl-fetch'`)[0].n).toBe(1);
  expect((await w`SELECT count(*)::int AS n FROM click_events WHERE slug = ${web.slug}`)[0].n).toBe(1);
  expect((await w`SELECT count(*)::int AS n FROM search_queries WHERE query = ${`${prefix} search`}`)[0].n).toBe(1);
}, 120_000);

it("inside the cache TTL a just-fenced DB still refuses the admin write TX at its first lock: nothing changes", async () => {
  bindDb("web");
  // 캐시 수명(5초)은 Date 로 잰다 — 이 테스트 동안 시계를 세워 두어 "아직 TTL 안" 을 실행 속도와 무관하게 만든다
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  try {
    await assertWebWritable(); // 캐시: active
    await fenceSite();
    const before = await digest("web");
    // 같은 프로세스의 캐시는 active 로 남아 있다 — 관리자 TX 는 첫 문장(fence SHARE)에서 fenced 를 보고 되돌린다.
    // 이 action 은 실패를 받아 기존 실패 문구를 돌려준다. 그 catch 의 실패 감사 로그(단일 insert)도 같은 요청 안이라 막힌다
    expect(await requestOperation("click-rollup")).toEqual({ error: "작업 요청을 처리하지 못했습니다." });
    expect(await digest("web")).toEqual(before);
    // 그 거절이 캐시도 버렸다: 다음 요청은 TTL 을 기다리지 않고 fenced 를 본다
    expect(await webWritable()).toBe(false);
  } finally { vi.useRealTimers(); }
}, 120_000);

it("fenced site: write routes answer 503 + Retry-After, actions throw, hot paths skip their writes, reads keep serving — DB unchanged", async () => {
  bindDb("web"); // 캐시를 버린다(= TTL 이 지났다)
  const before = await digest("web");
  const res = await cron("news-refresh");
  expect(res.status).toBe(503);
  expect(res.headers.get("retry-after")).toBe("60");
  expect(await res.json()).toMatchObject({ error: "잠시 이용할 수 없습니다. 잠시 후 다시 시도해주세요." });
  await expect(requestOperation("news-refresh")).rejects.toBeInstanceOf(fence.DrWriterFencedError);
  // GitHub webhook: 5xx 라 GitHub 에 실패 전달로 남는다(자동 재전송은 없다 — 3일 안 수동·API 재전송만, 놓친 해지는 15분 reconcile). 서명 검증·수신 기록 전에 끝난다
  const hook = await feedbackWebhook(new Request("https://nomorevibe.test/api/github/webhooks/feedback", { method: "POST", body: "{}" }));
  expect(hook.status).toBe(503);
  expect(hook.headers.get("retry-after")).toBe("60");
  const logout = await userLogout(new Request("https://nomorevibe.test/api/auth/user/logout", { method: "POST" }));
  expect(logout.status).toBe(503);
  expect(await logout.json()).toEqual({ error: "public_auth_unavailable" });
  // 공개 클릭은 그대로 제품으로 보낸다 — 세지만 않는다
  const clicked = await go(web.slug);
  expect(clicked.status).toBe(302);
  expect(clicked.headers.get("location")).toBe(`https://${web.slug}.example/`);
  await search();
  expect(await digest("web")).toEqual(before);
}, 120_000);

it("without a fence row (before 0095) the web gate fails closed: the write route errors, the click is not counted, nothing changes", async () => {
  bindDb("web");
  await pool("web")`DELETE FROM dr_writer_fence`;
  const before = await digest("web");
  expect((await cron("news-refresh")).status).toBe(500);
  await expect(requestOperation("news-refresh")).rejects.toThrow("dr_writer_fence_missing");
  expect((await go(web.slug)).status).toBe(302);
  expect(await digest("web")).toEqual(before);
}, 120_000);

const worker = { lease: null as JobLease | null };

it("worker: an active site claims fetch items as before; a fence that lands during a job refuses its ACK — no ACK, no observation, no failure write", async () => {
  bindDb("worker");
  const k = pool("worker");
  await itemStages("worker");
  const frontier = await seedFrontier("worker", 1);
  const claim = await claimFetchItem({ owner: itemOwner, ttlMs: 60_000 });
  expect(claim).toMatchObject({ id: frontier, ownership: { kind: "item" } });
  const observed = await digest("worker", ["operations_observations"]);
  const result = await runJob("news-refresh", async ctx => {
    worker.lease = ctx.lease ?? null;
    await fenceSite(); // handler 가 도는 사이 운영자가 이 DB 를 fence 한다
    return { done: true };
  });
  expect(result).toEqual({ status: "skipped", reason: "stopping" });
  const [job] = await k<{ requested_version: string; processed_version: string; last_error: string | null; last_success_at: Date | null; lease_token: string | null }[]>`
    SELECT requested_version, processed_version, last_error, last_success_at, lease_token FROM jobs WHERE name = 'news-refresh'`;
  expect(job).toMatchObject({ requested_version: "1", processed_version: "0", last_error: null, last_success_at: null, lease_token: worker.lease?.token });
  expect(await digest("worker", ["operations_observations"])).toEqual(observed);
}, 120_000);

it("worker: on a fenced site item claims, lease-held writes and job claims write nothing", async () => {
  bindDb("worker");
  await seedFrontier("worker", 2);
  const before = await digest("worker");
  expect(await claimFetchItem({ owner: itemOwner, ttlMs: 60_000 })).toBeNull();
  await expect(withJobLeaseWrite(worker.lease!, tx => tx.execute(sql`UPDATE jobs SET cursor = '{"pr15e":1}'::jsonb WHERE name = 'news-refresh'`)))
    .rejects.toBeInstanceOf(fence.DrWriterFencedError);
  // fence 를 첫 lock 으로 잡지 않은 호출자라도 claimItemLease 의 재확인이 소유권을 내주지 않는다
  const [frontier] = await pool("worker")<{ id: number; repo: string }[]>`SELECT id, repo FROM crawl_frontier WHERE repo = ${`${prefix}-worker/r2`}`;
  expect(await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "fetch"),
    { stage: "fetch", frontierId: frontier.id, repo: frontier.repo, claim: { attempts: 1, nextAttemptAt: "2026-10-17T00:10:00.000Z" } }, itemOwner, 60_000))).toBeNull();
  expect(await runJob("crawl-fetch", async () => ({ done: true }))).toEqual({ status: "skipped", reason: "stopping" });
  expect(await digest("worker")).toEqual(before);
}, 120_000);

const order = { claim: null as Awaited<ReturnType<typeof claimFetchItem>> };

it("lock order: the admin write TX waits at the fence holding nothing; jobs → fence (requestJob taking the fence) deadlocks with seal", async () => {
  bindDb("order");
  const o = pool("order");
  await o`INSERT INTO jobs (name) VALUES ('news-refresh'), ('crawl-fetch') ON CONFLICT (name) DO NOTHING`;
  // 1) seal·fence-old 가 fence UPDATE 를 쥔 동안 관리자 TX 는 fence 에서 기다리고 jobs 행은 잡지 않는다(캐시 관문의 읽기는 기다리지 않는다)
  const holder = await o.reserve();
  try {
    await holder`BEGIN`;
    const [{ pid }] = await holder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await holder`SELECT id FROM dr_writer_fence WHERE id = 1 FOR UPDATE`;
    const action = requestOperation("news-refresh");
    const waiting = await waitFor(async () => (await waiters("order")).find(row => row.blockers.includes(pid)), "admin_waits_fence");
    expect(waiting.query).toContain("dr_writer_fence");
    await holder`SELECT name FROM jobs WHERE name = 'news-refresh' FOR UPDATE NOWAIT`;
    await holder`ROLLBACK`;
    expect(await action).toEqual({ message: "실행 요청을 기록했습니다. 담당 워커가 순서대로 처리합니다." });
  } finally { await holder`ROLLBACK`.catch(() => {}); holder.release(); }

  // 2) 거절한 순서: requestJob 이 호출자 TX 의 jobs 행 lock 뒤에 fence 를 잡으면 seal(fence UPDATE → … → jobs)과 실제로 교착한다
  await o`UPDATE jobs SET lease_token = ${randomUUID()} WHERE name = 'news-refresh'`;
  const plan = await planFor("order");
  const mutant = await o.reserve();
  try {
    await mutant`BEGIN`;
    const [{ pid }] = await mutant<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await mutant`SELECT name FROM jobs WHERE name = 'news-refresh' FOR UPDATE`;
    const seal = repo.sealRestoredDatabase(plan, false);
    await waitFor(async () => (await waiters("order")).find(row => row.blockers.includes(pid)), "seal_waits_jobs");
    const results = await Promise.allSettled([mutant`SELECT id FROM dr_writer_fence WHERE id = 1 FOR SHARE`, seal]);
    expect(results.filter(result => result.status === "rejected").map(result => pgCode((result as PromiseRejectedResult).reason))).toEqual(["40P01"]);
  } finally { await mutant`ROLLBACK`.catch(() => {}); mutant.release(); }

  // 3) 출하 순서: 관리자 TX 가 fence SHARE 뒤 jobs 행에서 기다리는 동안 seal 은 fence 에서 기다린다 — seal → 관리자 TX → holder, 순환 없음
  await o`UPDATE jobs SET requested_version = processed_version WHERE name = 'news-refresh'`;
  const jobs = await o.reserve();
  try {
    await jobs`BEGIN`;
    const [{ pid }] = await jobs<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await jobs`SELECT name FROM jobs WHERE name = 'news-refresh' FOR UPDATE`;
    const action = requestOperation("news-refresh");
    const adminWait = await waitFor(async () => (await waiters("order")).find(row => row.blockers.includes(pid)), "admin_waits_jobs");
    expect(adminWait.query).toContain("jobs");
    const seal = repo.sealRestoredDatabase(plan, false);
    const sealWait = await waitFor(async () => (await waiters("order")).find(row => row.blockers.includes(adminWait.pid)), "seal_waits_admin");
    expect(sealWait.query).toContain("dr_writer_fence");
    await jobs`ROLLBACK`;
    const [done, sealed] = await Promise.all([action, seal]);
    expect(done).toEqual({ message: "실행 요청을 기록했습니다. 담당 워커가 순서대로 처리합니다." });
    expect(sealed).toMatchObject({ state: "sealed" });
  } finally { await jobs`ROLLBACK`.catch(() => {}); jobs.release(); }
  expect((await o`SELECT state FROM dr_writer_fence WHERE id = 1`)[0].state).toBe("active");
}, 120_000);

it("lock order: the item claim and the runJob ACK wait at the fence holding nothing; item → fence deadlocks with seal", async () => {
  bindDb("order");
  const o = pool("order");
  await itemStages("order");
  const frontier = await seedFrontier("order", 1);
  // 1) claimFetchItem 은 fence 에서 기다리며 stage·도메인·item 행을 잡지 않는다
  const holder = await o.reserve();
  try {
    await holder`BEGIN`;
    const [{ pid }] = await holder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await holder`SELECT id FROM dr_writer_fence WHERE id = 1 FOR UPDATE`;
    const claim = claimFetchItem({ owner: itemOwner, ttlMs: 60_000 });
    const waiting = await waitFor(async () => (await waiters("order")).find(row => row.blockers.includes(pid)), "claim_waits_fence");
    expect(waiting.query).toContain("dr_writer_fence");
    await holder`SELECT stage FROM pipeline_stage_modes WHERE stage = 'fetch' FOR UPDATE NOWAIT`;
    await holder`SELECT id FROM crawl_frontier WHERE id = ${frontier} FOR UPDATE NOWAIT`;
    await holder`ROLLBACK`;
    order.claim = await claim;
    expect(order.claim).toMatchObject({ id: frontier, ownership: { kind: "item" } });
  } finally { await holder`ROLLBACK`.catch(() => {}); holder.release(); }

  // 2) 거절한 순서: item 행을 잡은 뒤 fence 를 확인하면 seal(fence UPDATE → … → item 회수)과 교착한다
  const plan = await planFor("order");
  const mutant = await o.reserve();
  try {
    await mutant`BEGIN`;
    const [{ pid }] = await mutant<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await mutant`SELECT work_key FROM pipeline_item_leases WHERE stage = 'fetch' AND token IS NOT NULL FOR UPDATE`;
    const seal = repo.sealRestoredDatabase(plan, false);
    await waitFor(async () => (await waiters("order")).find(row => row.blockers.includes(pid)), "seal_waits_item");
    const results = await Promise.allSettled([mutant`SELECT id FROM dr_writer_fence WHERE id = 1 FOR SHARE`, seal]);
    expect(results.filter(result => result.status === "rejected").map(result => pgCode((result as PromiseRejectedResult).reason))).toEqual(["40P01"]);
  } finally { await mutant`ROLLBACK`.catch(() => {}); mutant.release(); }

  // 3) runJob ACK TX 도 fence 에서 기다리며 jobs 행을 잡지 않는다(handler 가 끝난 뒤 seal 이 fence 를 쥐었다)
  const sealer = await o.reserve();
  try {
    let sealerPid = 0;
    const run = runJob("news-refresh", async () => {
      await sealer`BEGIN`;
      [{ pid: sealerPid }] = await sealer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await sealer`SELECT id FROM dr_writer_fence WHERE id = 1 FOR UPDATE`;
      return { done: true };
    });
    const waiting = await waitFor(async () => sealerPid ? (await waiters("order")).find(row => row.blockers.includes(sealerPid)) : undefined, "ack_waits_fence");
    expect(waiting.query).toContain("dr_writer_fence");
    await sealer`SELECT name FROM jobs WHERE name = 'news-refresh' FOR UPDATE NOWAIT`;
    await sealer`ROLLBACK`;
    expect(await run).toMatchObject({ status: "completed", done: true });
  } finally { await sealer`ROLLBACK`.catch(() => {}); sealer.release(); }
  expect((await o`SELECT state FROM dr_writer_fence WHERE id = 1`)[0].state).toBe("active");
}, 120_000);

it("lock order under concurrency: seal (dry-run) races the web admin TX, item claim, runJob ACK and a lease-held write without a deadlock", async () => {
  bindDb("order");
  const o = pool("order");
  const plan = await planFor("order");
  const rejected: unknown[] = [];
  for (let round = 0; round < 10; round++) {
    await seedFrontier("order", 100 + round);
    const token = randomUUID();
    await o`INSERT INTO jobs (name, lease_token, locked_at) VALUES ('click-rollup', ${token}, now())
      ON CONFLICT (name) DO UPDATE SET lease_token = excluded.lease_token, locked_at = excluded.locked_at`;
    await o`UPDATE jobs SET requested_version = processed_version WHERE name = 'crawl-fetch'`;
    const settled = await Promise.allSettled([
      repo.sealRestoredDatabase(plan, false),
      requestOperation("crawl-fetch"),
      claimFetchItem({ owner: { instanceId: `${prefix}-race`, bootId: randomUUID() }, ttlMs: 60_000 }),
      runJob("news-refresh", async () => ({ done: true })),
      withJobLeaseWrite({ name: "click-rollup", token, requestedVersion: 1 }, tx => tx.execute(sql`SELECT 1`)),
      repo.sealRestoredDatabase(plan, false),
    ]);
    rejected.push(...settled.filter(result => result.status === "rejected").map(result => (result as PromiseRejectedResult).reason));
  }
  expect(rejected.map(error => [pgCode(error), String(error)])).toEqual([]);
  expect((await o`SELECT state FROM dr_writer_fence WHERE id = 1`)[0].state).toBe("active");
}, 180_000);
