import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { listCandidates } from "@/lib/crawl/repository";
import { reviewApprovalPredicate } from "@/lib/crawl/agent-review-repository";
import { admitLegacySecondReview } from "@/lib/crawl/second-review-ownership";
import { closeSettledSecondReviews } from "@/lib/crawl/second-review";
import { requestCrawlTaglineModelSlot } from "@/lib/llm/capacity-repository";
import { crawlTaglineInputHash, crawlTaglineLogicalWorkKey, modelCapacityPolicyHash,
  type CrawlTaglineInput, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/**
 * 0192 의 다섯 인덱스가 migrate 뒤에 유효하게 있고, 앱이 실제로 보내는 문장이 그 인덱스를 탄다(2026-11-21 전수 점검 W1-2).
 *
 * 손으로 옮겨 적은 SQL 이 아니라 앱 함수가 만든 문장 그대로를 본다. 이 파일이 만들고 지우는 임시 DB 하나에(health-schema 시험과 같은 방식) 진짜 마이그레이터로
 * 전체를 적용하고, lib/db 의 `db` 를 「보낸 문장을 받아 적는」 drizzle 로 바꿔 끼운 뒤 앱 함수를 실제로 부른다. 받아 적은 (문장, 값)을 운영과 비슷한 모양으로
 * 채운 표 위에서 enable_seqscan = off 로 EXPLAIN 한다. 값은 drizzle 이 드라이버에 넘긴 그대로 넘긴다 — 운영의 postgres.js unsafe 도 문장을 준비해 두지 않아
 * 값이 보이는 채로 계획한다(부분 인덱스의 stage = 'ai2' 가 값으로 온 조건과 그래서 맞는다).
 */
type Captured = { query: string; params: unknown[] };

const root = fileURLToPath(new URL("../..", import.meta.url));
const name = `nomorevibe_test_index_plans_${randomBytes(6).toString("hex")}`;
const url = (() => { const value = new URL(TEST_DATABASE_URL); value.pathname = `/${name}`; return value.toString(); })();
const INDEXES = ["agent_scans_repository_latest_idx", "model_capacity_requests_logical_key_idx", "pipeline_item_leases_ai2_candidate_idx",
  "second_reviews_fallback_for_idx", "second_reviews_first_attempt_idx"];
const statements: Captured[] = [];
const holder = globalThis as { db?: unknown; pgClient?: unknown };
const sent: Record<"gate" | "claim" | "cleanup" | "fence", Captured[]> = { gate: [], claim: [], cleanup: [], fence: [] };
let created = false;
let client: postgres.Sql | undefined;

/** 앱 함수를 실제로 부르고 그동안 보낸 문장을 돌려준다. 앱 함수의 실패는 삼킨다 — 보려는 것은 보낸 문장이고, 거기까지 못 갔으면 시험이 문장을 찾지 못해 실패한다 */
async function capture(run: () => Promise<unknown>): Promise<Captured[]> {
  const from = statements.length;
  try { await run(); } catch { /* 문장만 모은다 */ }
  return statements.slice(from);
}

async function plansOf(captured: readonly Captured[]): Promise<string[]> {
  const plans: string[] = [];
  await client!.begin(async (tx) => {
    await tx.unsafe("set local enable_seqscan = off");
    for (const { query, params } of captured) {
      const rows = await tx.unsafe(`explain (costs off) ${query}`, params as never[]);
      plans.push(rows.map((row) => row["QUERY PLAN"]).join("\n"));
    }
  });
  return plans;
}

/**
 * 계획에서 이 표를 통째로 읽는 노드(Seq Scan, 또는 인덱스 조건 없이 인덱스를 처음부터 끝까지 걷는 Index Scan).
 * enable_seqscan = off 에서는 길이 없는 문장이 «Seq Scan» 대신 «조건 없는 Index Scan + Filter» 로 나오므로 인덱스 이름만 찾아서는 모자라다
 */
function fullScans(plan: string, relation: string): string[] {
  const lines = plan.split("\n"), node = new RegExp(`(Seq Scan|Index (?:Only )?Scan(?: Backward)? using \\w+) on ${relation}$`);
  return lines.filter((line, index) => {
    const match = node.exec(line.trim());
    return match !== null && (match[1] === "Seq Scan" || !/^\s*Index Cond:/.test(lines[index + 1] ?? ""));
  }).map((line) => line.trim());
}

/** 운영과 비슷한 모양으로 표를 채운다 — 문장을 다 받아 적은 뒤에(앱 함수가 이 행들을 일감으로 집지 않게) */
async function fillTables(sql: postgres.Sql): Promise<void> {
  // 2차 표: 1차 시도 하나에 표 서너 줄, 열에 하나는 대체 표
  await sql.unsafe(`insert into second_reviews (candidate_id, repo, trigger, first_decision, input_hash, generation_key, provider, model, status, first_attempt_id, fallback_for_id)
    select 1000000 + g, 'plan-fixture/repo-' || g, 'ai_approved', 'approve', md5(g::text) || md5(g::text), md5('g' || g) || md5('k' || g), 'abcllm', 'model-' || (g % 3),
      case when g % 7 = 0 then 'pending' when g % 5 = 0 then 'agreed' else 'resolved' end, 1000000 + g / 3, case when g % 10 = 0 then 1000000 + g end
    from generate_series(1, 12000) g`);
  // 아이템: ai2 가 대부분, 후보 하나에 표 한두 줄
  await sql.unsafe(`insert into pipeline_item_leases (stage, work_key, binding, binding_hash)
    select 'ai2', 'ai2:' || (1000000 + g), jsonb_build_object('stage', 'ai2', 'secondReviewId', (1000000 + g)::text, 'candidateId', (1000000 + g / 2)::text), md5(g::text) || md5(g::text)
    from generate_series(1, 12000) g`);
  await sql.unsafe(`insert into pipeline_item_leases (stage, work_key, binding, binding_hash)
    select 'ai1', 'ai1:' || (1000000 + g), jsonb_build_object('stage', 'ai1', 'candidateId', (1000000 + g)::text), md5(g::text) || md5(g::text) from generate_series(1, 3000) g`);
  // 스캔: 저장소 하나에 두세 줄
  await sql.unsafe(`insert into agent_repository_scans (github_repository_id, repository_key, commit_sha, detector_version, scope, scope_hash, state, started_at)
    select 1 + g / 3, 'plan-fixture/repo-' || (1 + g / 3), md5(g::text), 'v1', '', md5(''), 'complete', now() - make_interval(hours => g % 300)
    from generate_series(1, 12000) g`);
  // 장부: 대부분 끝난 행(여기서는 거둔 행)이고 넷에 셋은 작업 키가 있다. 장부의 행 검사 트리거는 행마다 6ms 라(12,000행 = 70초) 이 임시 DB 에서만 끄고 넣는다 —
  // 앱 함수는 이미 다 불렀고, 이 뒤로는 계획만 본다
  await sql.unsafe("alter table model_capacity_requests disable trigger user");
  await sql.unsafe(`insert into model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
      provider_budget_id, group_id, epoch, revision, policy_hash, state, queue_until, logical_work_key)
    select gen_random_uuid(), 'plan-fixture:' || g, 'plan-fixture', gen_random_uuid(), 'first', 'reviewer', 'crawl-agent-review', 'abcllm', 'model',
      'account', 'engine', 1, 1, repeat('a', 64), 'withdrawn', now(), case when g % 4 > 0 then 'ai1:' || (1000000 + g) end
    from generate_series(1, 12000) g`);
  await sql.unsafe("analyze second_reviews, pipeline_item_leases, agent_repository_scans, model_capacity_requests");
}

function settings(): CrawlSettings {
  // mergeWithDefaults 를 거쳐야 시험 env 가 이 설정의 심사자를 「작업 ↔ 모델」 순위로 고정한다(tests/integration/env.ts)
  return mergeWithDefaults({ ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first-model" }, secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: "abcllm", model: "second-model" }], fallbacks: [{ provider: "abcllm", model: "backup-model" }] } });
}
const lease = () => ({ name: "second-review", token: randomUUID(), requestedVersion: 1 });
const touching = (captured: readonly Captured[], pattern: RegExp) => captured.filter((item) => pattern.test(item.query));

/** 앱 함수들을 한 번씩 실제로 불러 문장을 받아 적는다 */
async function captureAll(): Promise<void> {
  // 발행 대기열: 승인 후보 고르기 + 발행 관문 술어(crawl-publish 가 틱마다 보내는 문장)
  sent.gate = await capture(() => listCandidates(["approved"], 20, reviewApprovalPredicate(settings())));

  // 후보 하나와 그 2차 표 둘(뿌리 + 대체 표). 후보가 승인 상태가 아니라 claim 은 건너뛰고 정리는 이 후보를 집는다
  const repo = `plan-capture/${randomUUID().slice(0, 8)}`;
  const [candidate] = await db.insert(schema.crawlCandidates).values({ repo, state: "rejected" }).returning({ id: schema.crawlCandidates.id });
  const vote = { candidateId: candidate.id, repo, trigger: "ai_approved" as const, firstDecision: "approve", inputHash: "a".repeat(64),
    firstAttemptId: 2_000_000_000, provider: "abcllm" as const, status: "pending" as const };
  const [first] = await db.insert(schema.secondReviews).values({ ...vote, model: "second-model" }).returning({ id: schema.secondReviews.id });
  const [fallback] = await db.insert(schema.secondReviews).values({ ...vote, model: "backup-model", fallbackForId: first.id }).returning({ id: schema.secondReviews.id });
  // 2차 심사 claim(옛 방식 입구 — 아이템 방식도 같은 claimReview 를 탄다): 행 잠금(lockSecondReviewRows) → 사슬 점검(chainIsBusy)
  sent.claim = await capture(() => admitLegacySecondReview(fallback.id, lease()));
  // 2차 정리: 정리 대상 고르기 → 후보마다 controllerWrite(lockControllerDomain 의 최신 스캔 → candidateItemsBusy)
  sent.cleanup = await capture(() => closeSettledSecondReviews(new Date(), lease()));

  // 장부 입장: 소개 짓기 한 건(requestSlot → crawlTaglineFence)
  const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4 }, groupLimits: { engine: 4 },
    poolLimits: { reviewer: 4, text: 4 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12, queueTtlMs: 60_000, reservationTtlMs: 60_000,
    routes: [{ routeId: "crawl-tagline", provider: "abcllm", model: "plan-capture-model", providerBudgetId: "account", groupId: "engine" }] };
  await client!`update model_capacity_control set mode = 'open', policy = ${JSON.stringify(policy)}::text::jsonb,
    policy_hash = ${modelCapacityPolicyHash(policy)}, cursor = 0, updated_at = clock_timestamp() where id = 1`;
  const input: CrawlTaglineInput = { member: { candidateId: 21, repo: "plan-capture/project", sourceHash: "a".repeat(64),
    candidateRowIdentityHash: "b".repeat(64), documentRowIdentityHash: "c".repeat(64), cache: { kind: "absent" } }, model: "plan-capture-model", askOrdinal: 1, parent: null };
  sent.fence = await capture(() => requestCrawlTaglineModelSlot({ requestId: randomUUID(), owner: { instanceId: "plan-capture", bootId: randomUUID() },
    workKey: `${crawlTaglineLogicalWorkKey(input)}:${crawlTaglineInputHash(input)}`, class: "background", pool: "text",
    routeId: "crawl-tagline", provider: "abcllm", model: "plan-capture-model" }, input));
}

beforeAll(async () => {
  ensureSchema();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${name}`); created = true; } finally { await admin.end({ timeout: 5 }); }
  const migrator = postgres(url, { max: 1, onnotice: () => {} });
  try { await migrator.unsafe("set statement_timeout = 0"); await migrate(drizzle(migrator), { migrationsFolder: path.join(root, "drizzle") }); }
  finally { await migrator.end({ timeout: 5 }); }
  client = postgres(url, { max: 2, onnotice: () => {} });
  holder.pgClient = client;
  holder.db = drizzle(client, { schema, logger: { logQuery: (query, params) => { statements.push({ query, params: [...params] }); } } });
}, 600_000);

// 받아 적기는 첫 시험 앞에서 한 번 — 시험 env 의 beforeEach(심사자 순위 고정)가 먼저 돈 뒤여야 관문 술어를 만들 수 있다
let prepared: Promise<void> | undefined;
beforeEach(() => prepared ??= captureAll().then(() => fillTables(client!)));

afterAll(async () => {
  delete holder.db;
  delete holder.pgClient;
  await client?.end({ timeout: 5 });
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try { if (created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
}, 120_000);

it("migrate 뒤 다섯 인덱스가 제 표에 유효하게 있다", async () => {
  const rows = await client!<{ name: string; tbl: string; ok: boolean; definition: string }[]>`
    select c.relname::text as name, i.indrelid::regclass::text as tbl, i.indisvalid and i.indisready and i.indislive as ok, pg_get_indexdef(i.indexrelid) as definition
    from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname::text = any(${INDEXES}::text[]) order by c.relname`;
  expect(rows.map((row) => [row.name, row.tbl, row.ok])).toEqual([
    ["agent_scans_repository_latest_idx", "agent_repository_scans", true],
    ["model_capacity_requests_logical_key_idx", "model_capacity_requests", true],
    ["pipeline_item_leases_ai2_candidate_idx", "pipeline_item_leases", true],
    ["second_reviews_fallback_for_idx", "second_reviews", true],
    ["second_reviews_first_attempt_idx", "second_reviews", true],
  ]);
  const definition = Object.fromEntries(rows.map((row) => [row.name, row.definition.slice(row.definition.indexOf("USING"))]));
  expect(definition).toEqual({
    agent_scans_repository_latest_idx: "USING btree (repository_key, scope, started_at DESC, id DESC)",
    model_capacity_requests_logical_key_idx: "USING btree (logical_work_key) WHERE (logical_work_key IS NOT NULL)",
    pipeline_item_leases_ai2_candidate_idx: "USING btree (((binding ->> 'candidateId'::text))) WHERE ((stage)::text = 'ai2'::text)",
    second_reviews_fallback_for_idx: "USING btree (fallback_for_id) WHERE (fallback_for_id IS NOT NULL)",
    second_reviews_first_attempt_idx: "USING btree (first_attempt_id) WHERE (first_attempt_id IS NOT NULL)",
  });
});

it("발행 관문 문장이 1차 시도의 2차 표와 저장소의 최신 스캔을 인덱스로 찾는다", async () => {
  const gate = touching(sent.gate, /from "crawl_candidates"/);
  expect(gate).toHaveLength(1);
  expect(gate[0].query).toMatch(/g\.first_attempt_id = /);
  expect(gate[0].query).toMatch(/s\.repository_key = lower\([^)]*\) AND s\.scope = ''\s+ORDER BY s\.started_at DESC, s\.id DESC LIMIT 1/);
  const [plan] = await plansOf(gate);
  expect(plan).toContain("Index Scan using second_reviews_first_attempt_idx on second_reviews g");
  expect(plan).toContain("Index Scan using agent_scans_repository_latest_idx on agent_repository_scans s");
  expect(fullScans(plan, "second_reviews \\w+")).toEqual([]);
  expect(fullScans(plan, "agent_repository_scans \\w+")).toEqual([]);
});

it("2차 심사 claim 의 행 잠금과 사슬 점검이 first_attempt_id · fallback_for_id 인덱스를 탄다", async () => {
  // lockSecondReviewRows: id = … OR first_attempt_id = … OR id = 뿌리 OR id IN (같은 1차 시도의 대체 표가 가리키는 뿌리)
  const rowLock = touching(sent.claim, /from "second_reviews" where [\s\S]*"first_attempt_id" = \$\d+ or [\s\S]*= ANY\(ARRAY\(SELECT g\.fallback_for_id FROM second_reviews g/);
  // chainIsBusy: id = … OR id = 표 OR fallback_for_id = 표
  const chain = touching(sent.claim, /^select "id" from "second_reviews" where \([\s\S]*"id" = \$\d+ or [\s\S]*"id" = \$\d+ or [\s\S]*"fallback_for_id" = \$\d+\)$/);
  expect(rowLock).toHaveLength(1);
  expect(chain).toHaveLength(1);
  const plans = await plansOf([...rowLock, ...chain]);
  // 네 가지(세 가지)가 모두 인덱스 조건이어야 BitmapOr 로 묶인다 — 한 가지라도 길이 없으면 표 전체를 읽는다
  expect(plans[0]).toContain("BitmapOr");
  expect(plans[0]).toContain("Bitmap Index Scan on second_reviews_first_attempt_idx");
  expect(plans[1]).toContain("BitmapOr");
  expect(plans[1]).toContain("Bitmap Index Scan on second_reviews_fallback_for_idx");
  for (const plan of plans) expect(fullScans(plan, "second_reviews(?: \\w+)?")).toEqual([]);
});

it("2차 정리가 대체 표를 뿌리 id 로, 후보의 ai2 아이템을 candidateId 로, 최신 스캔을 정렬 없이 찾는다", async () => {
  const cleanup = touching(sent.cleanup, /^select distinct "candidate_id" from "second_reviews" where [\s\S]*child\.fallback_for_id=/);
  const items = touching(sent.cleanup, /from "pipeline_item_leases" where [\s\S]*"binding"->>'candidateId' = \$\d+/);
  const latestScan = touching(sent.cleanup, /from "agent_repository_scans" where [\s\S]*"repository_key" = \$\d+ and [\s\S]*"scope" = \$\d+\) order by [\s\S]*"started_at" desc, [\s\S]*"id" desc limit/);
  expect(cleanup).toHaveLength(1);
  // candidateItemsBusy 는 같은 조건을 두 번 보낸다(잠그며 한 번, 그대로 한 번)
  expect(items).toHaveLength(2);
  expect(latestScan).toHaveLength(1);
  const plans = await plansOf([...cleanup, ...items, ...latestScan]);
  // 정리 쿼리의 바깥 훑기는 상태 조건으로 고른다(이 인덱스의 몫이 아니다) — 받치는 것은 뿌리마다 도는 child 하위 질의다
  expect(plans[0]).toContain("Index Scan using second_reviews_fallback_for_idx on second_reviews child");
  expect(fullScans(plans[0], "second_reviews child(?:_\\d+)?")).toEqual([]);
  for (const plan of plans.slice(1, 3)) {
    expect(plan).toContain("BitmapOr");
    expect(plan).toContain("Bitmap Index Scan on pipeline_item_leases_ai2_candidate_idx");
    expect(fullScans(plan, "pipeline_item_leases")).toEqual([]);
  }
  expect(plans[3]).toContain("Index Scan using agent_scans_repository_latest_idx on agent_repository_scans");
  expect(fullScans(plans[3], "agent_repository_scans")).toEqual([]);
  expect(plans[3]).not.toContain("Sort");
});

it("장부 fence 의 「같은 단계를 이미 보냄」 가지가 logical_work_key 인덱스를 타 문장 전체가 표를 읽지 않는다", async () => {
  const fence = touching(sent.fence, /from "model_capacity_requests" where [\s\S]*"logical_member_keys" && ARRAY\[[\s\S]*"logical_work_key" = \$\d+\s+AND [\s\S]*"state" IN \('dispatched'/);
  expect(fence).toHaveLength(1);
  const [plan] = await plansOf(fence);
  expect(plan).toContain("BitmapOr");
  expect(plan).toContain("Bitmap Index Scan on model_capacity_requests_logical_key_idx");
  expect(fullScans(plan, "model_capacity_requests")).toEqual([]);
});
