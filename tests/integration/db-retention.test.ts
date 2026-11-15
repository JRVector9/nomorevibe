import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, products } from "@/lib/db/schema";
import { saveSettings, getSettings } from "@/lib/crawl/settings";
import { judgeRevision, judgeStoredDocument, accessFromDocument, factsFromRepoMeta } from "@/lib/crawl/rules";
import { spamSignals } from "@/lib/crawl/spam-signals";
import { taglineEvidence } from "@/lib/crawl/tagline";
import { planStarRejudge } from "@/lib/crawl/rejudge";
import { applyReconsideration, planReconsideration } from "@/lib/crawl/reconsider";
import { lockedInput } from "@/lib/crawl/admin-review";
import { listDiscoveryEvidence } from "@/lib/domain/evidence/agents/repository";
import { storedRepositoryAnchors } from "@/lib/me/maker-claims";
import { runDbRetention } from "@/lib/jobs/db-retention";
import type { JobContext } from "@/lib/jobs/runner";
import {
  DB_RETENTION_PARTS, ledgerRetentionReady, pruneDiscoveryEvidence, pruneHealthDaily, pruneLedger, pruneLedgerBatch, pruneScans,
  REPO_META_KEEP_KEYS, REPO_META_OWNER_KEEP_KEYS, shrinkDocuments, type DbRetentionCursor,
} from "@/lib/operations/db-retention";
import { ensureSchema, resetTables } from "./setup";

/*
 * DB 보관 정리(2026-11-15 ④⑤⑥) 실제 PostgreSQL. 장부 행은 이 파일의 owner_instance_id 로만 만들고 지운다(다른 파일의 장부 행을 건드리지 않는다).
 * 장부 고정값은 0160 의 큰 CHECK 규칙(binding·근거 모양)을 맞추지 않으려고 그 BEFORE 트리거(zz_check_guard)만 한 트랜잭션 안에서 끄고 넣는다 —
 * 보관 정리는 binding 모양을 읽지 않고 상태·시각·생성·대상 열쇠만 본다. 작은 CHECK 14개와 0187 트리거는 그대로 켜져 있다.
 */
const OWNER = `db-retention-test-${randomUUID().slice(0, 8)}`;
const HASH = "a".repeat(64);
const always = () => true;

beforeAll(ensureSchema);

// ───────────────────────── ⑤ 모델 장부 ─────────────────────────

type LedgerFixture = { state: "settled" | "withdrawn" | "indeterminate" | "waiting"; ageDays: number; routeId?: string;
  binding?: Record<string, unknown>; logicalWorkKey?: string; memberKeys?: string[]; terminal?: Record<string, unknown> };
async function insertLedger(fixtures: LedgerFixture[]): Promise<string[]> {
  const ids = fixtures.map(() => randomUUID());
  await db.transaction(async tx => {
    await tx.execute(sql`ALTER TABLE model_capacity_requests DISABLE TRIGGER model_capacity_requests_zz_check_guard`);
    await tx.execute(sql`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_zz_check_guard`);
    for (const [index, fixture] of fixtures.entries()) {
      const id = ids[index], age = sql`clock_timestamp() - ${fixture.ageDays} * interval '1 day'`, held = fixture.state !== "waiting";
      await tx.execute(sql`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
          provider_budget_id, group_id, epoch, revision, policy_hash, state, token, reserved_until, queue_until, logical_work_key, logical_member_keys,
          dispatch_binding, dispatch_binding_hash, dispatched_at, terminal_evidence, terminal_evidence_hash, settled_at, updated_at, queued_at)
        VALUES (${id}::uuid, ${`retention:${id}`}, ${OWNER}, ${randomUUID()}::uuid, 'background', 'text', ${fixture.routeId ?? "crawl-tagline"}, 'fixture', 'm',
          'fixture', 'fixture', 1, 1, ${HASH}, ${fixture.state}, ${held ? randomUUID() : null}::uuid, ${held ? age : null},
          clock_timestamp() + interval '1 minute', ${fixture.logicalWorkKey ?? null},
          ${fixture.memberKeys ? sql`ARRAY[${sql.join(fixture.memberKeys.map(key => sql`${key}`), sql`, `)}]::text[]` : sql`NULL::text[]`},
          ${fixture.binding ? JSON.stringify(fixture.binding) : null}::jsonb, ${fixture.binding ? HASH : null}, ${held ? age : null},
          ${fixture.terminal ? JSON.stringify(fixture.terminal) : fixture.state === "settled" ? JSON.stringify({ kind: "fixture" }) : null}::jsonb,
          ${fixture.terminal || fixture.state === "settled" ? HASH : null}, ${fixture.state === "settled" ? age : null}, ${age}, ${age})`);
      for (const kind of ["queued", "reserved"]) await tx.execute(sql`INSERT INTO model_capacity_events (request_id, kind, epoch, revision, policy_hash,
          from_state, to_state, created_at) VALUES (${id}::uuid, ${kind}, 1, 1, ${HASH}, ${kind === "queued" ? null : "waiting"},
          ${kind === "queued" ? "waiting" : "reserved"}, ${age})`);
    }
    await tx.execute(sql`ALTER TABLE model_capacity_requests ENABLE TRIGGER model_capacity_requests_zz_check_guard`);
    await tx.execute(sql`ALTER TABLE model_capacity_events ENABLE TRIGGER model_capacity_events_zz_check_guard`);
  });
  return ids;
}
/** 이 파일의 장부 행 정리 — 시험 정리만 쓰는 길(adversarial 시험과 같다): 추가 전용 트리거를 트랜잭션 안에서만 끈다 */
async function clearLedger() {
  await db.transaction(async tx => {
    await tx.execute(sql`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`);
    await tx.execute(sql`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`);
    await tx.execute(sql`DELETE FROM model_capacity_events WHERE request_id IN (SELECT request_id FROM model_capacity_requests WHERE owner_instance_id = ${OWNER})`);
    await tx.execute(sql`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`);
    await tx.execute(sql`DELETE FROM model_capacity_requests WHERE owner_instance_id = ${OWNER}`);
  });
}
const present = async (ids: string[]) => new Set((await db.execute<{ id: string }>(sql`SELECT request_id::text AS id FROM model_capacity_requests
  WHERE request_id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`)).map(row => row.id));
const eventCount = async (id: string) => (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM model_capacity_events WHERE request_id = ${id}::uuid`))[0].n;
async function setLedgerDays(days: number | null) {
  await db.execute(sql`INSERT INTO runtime_settings (id, "values", revision, updated_by) VALUES (1, '{"version":1}'::jsonb, 1, 'test') ON CONFLICT (id) DO NOTHING`);
  await db.execute(days === null
    ? sql`UPDATE runtime_settings SET "values" = "values" #- '{capacity,ledgerRetentionDays}' WHERE id = 1`
    : sql`UPDATE runtime_settings SET "values" = jsonb_set(jsonb_set("values", '{capacity}', coalesce("values"->'capacity', '{}'::jsonb)), '{capacity,ledgerRetentionDays}', ${days}::text::jsonb) WHERE id = 1`);
}
async function expectSqlState(work: Promise<unknown>, code: string, message: string) {
  const error = await work.then(() => null, (caught: unknown) => caught);
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  expect(cause).toMatchObject({ code, message });
}

describe("⑤ 모델 장부 보관", () => {
  afterAll(async () => { await clearLedger(); await setLedgerDays(null); });
  beforeEach(async () => { await clearLedger(); await setLedgerDays(null); });

  it("0187 이 적용돼 있다 — 설정 없이는 지금처럼 이벤트 DELETE·UPDATE·TRUNCATE 가 55000 이다", async () => {
    expect(await ledgerRetentionReady()).toBe(true);
    const [old] = await insertLedger([{ state: "settled", ageDays: 20 }]);
    await expectSqlState(db.execute(sql`DELETE FROM model_capacity_events WHERE request_id = ${old}::uuid`), "55000", "model_capacity_events_append_only");
    await expectSqlState(db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('nmv.capacity_retention', 'on', true)`);
      await tx.execute(sql`UPDATE model_capacity_events SET kind = kind WHERE request_id = ${old}::uuid`);
    }), "55000", "model_capacity_events_append_only");
    await expectSqlState(db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('nmv.capacity_retention', 'on', true)`);
      await tx.execute(sql`TRUNCATE model_capacity_events`);
    }), "55000", "model_capacity_events_append_only");
    expect(await eventCount(old)).toBe(2);
  });

  it("설정을 켠 DELETE 도 끝난 지 8일 안 된 행·끝나지 않은 행은 트리거가 되돌린다", async () => {
    const [recent, unknown, old] = await insertLedger([{ state: "settled", ageDays: 5 }, { state: "indeterminate", ageDays: 30 }, { state: "settled", ageDays: 9 }]);
    for (const id of [recent, unknown]) {
      await expectSqlState(db.transaction(async tx => {
        await tx.execute(sql`SELECT set_config('nmv.capacity_retention', 'on', true)`);
        await tx.execute(sql`DELETE FROM model_capacity_events WHERE request_id = ${id}::uuid`);
      }), "55000", "model_capacity_retention_not_expired");
      expect(await eventCount(id)).toBe(2);
    }
    // 요청 행 DELETE 도 같은 바닥 — 이벤트를 (시험 정리 길로) 먼저 치운 5일 된 행도 설정을 켠 DELETE 로는 지우지 못한다
    await db.transaction(async tx => {
      await tx.execute(sql`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`);
      await tx.execute(sql`DELETE FROM model_capacity_events WHERE request_id = ${recent}::uuid`);
      await tx.execute(sql`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`);
    });
    await expectSqlState(db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('nmv.capacity_retention', 'on', true)`);
      await tx.execute(sql`DELETE FROM model_capacity_requests WHERE request_id = ${recent}::uuid`);
    }), "55000", "model_capacity_retention_not_expired");
    // 9일 지난 settled 는 DB 바닥(8일)을 넘었다 — 이벤트 → 요청 순서로 한 트랜잭션에서 지워진다
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('nmv.capacity_retention', 'on', true)`);
      await tx.execute(sql`DELETE FROM model_capacity_events WHERE request_id = ${old}::uuid`);
      await tx.execute(sql`DELETE FROM model_capacity_requests WHERE request_id = ${old}::uuid`);
    });
    expect([...await present([recent, unknown, old])].sort()).toEqual([recent, unknown].sort());
    // 앱 하한도 8일
    await expect(pruneLedgerBatch(undefined, 7, "settled")).rejects.toThrow("ledger_retention_days_invalid");
  });

  it("보관 기간(기본 14일)이 지난 끝난 행만 이벤트와 함께 지우고, 생성·대상·작업·사람 검토 행은 남긴다", async () => {
    const [product] = await db.insert(products).values({ slug: `retention-${randomUUID().slice(0, 8)}`, name: "R", url: `https://${randomUUID()}.example`,
      tagline: "t", description: "d", category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e".repeat(64) }).returning();
    const tagline = (generationHash: string, askOrdinal: number) => ({ kind: "crawl_tagline_gateway", generationHash, askOrdinal });
    const ids = await insertLedger([
      /* 0 */ { state: "settled", ageDays: 20 },
      /* 1 */ { state: "settled", ageDays: 10 },
      /* 2 */ { state: "withdrawn", ageDays: 20 },
      /* 3 */ { state: "withdrawn", ageDays: 20, terminal: { kind: "operator_review" } },
      /* 4 */ { state: "indeterminate", ageDays: 30 },
      /* 5 */ { state: "settled", ageDays: 21, binding: tagline("g-old", 1) },
      /* 6 */ { state: "settled", ageDays: 20, binding: tagline("g-old", 2) },
      /* 7 */ { state: "settled", ageDays: 20, binding: tagline("g-live", 1) },
      /* 8 */ { state: "settled", ageDays: 2, binding: tagline("g-live", 2) },
      /* 9 */ { state: "settled", ageDays: 20, routeId: "product-search-verify", memberKeys: ["search-verify:1"] },
      /* 10 */ { state: "waiting", ageDays: 0, routeId: "product-search-verify", memberKeys: ["search-verify:1"] },
      /* 11 */ { state: "settled", ageDays: 20, routeId: "search-query-translate", logicalWorkKey: "text:websearch:k" },
      /* 12 */ { state: "indeterminate", ageDays: 1, routeId: "search-query-translate", logicalWorkKey: "text:websearch:k" },
      /* 13 */ { state: "settled", ageDays: 20 },
      /* 14 */ { state: "settled", ageDays: 20 },
    ]);
    // 처리 중인 LLM 보조 작업이 가리키는 요청(13) · 그 작업의 결과 행이 가리키는 요청(14)
    const workId = randomUUID();
    await db.execute(sql`INSERT INTO llm_assist_work (id, task, product_id, origin_job, source_hash, source, policy_version, prompt_version, state,
        claim_token, claim_job, claim_job_token, claim_requested_version, owner_instance_id, owner_boot_id, capacity_request_id)
      VALUES (${workId}::uuid, 'uptime', ${product.id}, 'test', ${HASH}, '{"kind":"uptime"}'::jsonb, 'p', 'p', 'claimed',
        ${randomUUID()}::uuid, 'test', ${randomUUID()}::uuid, 1, ${OWNER}, ${randomUUID()}::uuid, ${ids[13]}::uuid)`);
    await db.execute(sql`INSERT INTO llm_assist_results (id, work_id, work_revision, capacity_request_id, backend_id, model_family, contract_hash, input_hash,
        prompt_hash, response_hash, outcome) VALUES (${randomUUID()}::uuid, ${workId}::uuid, 1, ${ids[14]}::uuid, 'b', 'f', ${HASH}, ${HASH}, ${HASH}, ${HASH}, '{}'::jsonb)`);
    try {
      const result = await pruneLedger(undefined, always);
      expect(result).toMatchObject({ caughtUp: true, counts: { days: 14 } });
      const kept = await present(ids);
      expect(ids.map((id, index) => kept.has(id) ? index : -1).filter(index => index >= 0)).toEqual([1, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14]);
      for (const index of [0, 2, 5, 6]) expect(await eventCount(ids[index])).toBe(0);
      for (const index of [1, 3, 7, 9, 13]) expect(await eventCount(ids[index])).toBe(2);
      // 멱등 — 다시 돌려도 지울 것이 없다
      expect((await pruneLedger(undefined, always)).counts).toMatchObject({ requests: 0, events: 0 });
      // 관리자 설정 8일 — 10일 된 행(1)도 지운다
      await setLedgerDays(8);
      expect((await pruneLedger(undefined, always)).counts).toMatchObject({ days: 8, requests: 1, events: 2 });
      expect((await present([ids[1]])).size).toBe(0);
      // 범위 밖 값(7)은 읽지 않고 기본 14일
      await setLedgerDays(7);
      expect((await pruneLedger(undefined, always)).counts).toMatchObject({ days: 14 });
    } finally {
      await db.execute(sql`DELETE FROM llm_assist_work WHERE id = ${workId}::uuid`);
    }
  });

  it("예산이 없으면 묶음을 열지 않는다", async () => {
    const [old] = await insertLedger([{ state: "settled", ageDays: 20 }]);
    expect(await pruneLedger(undefined, () => false)).toMatchObject({ caughtUp: false, counts: { requests: 0 } });
    expect((await present([old])).size).toBe(1);
  });
});

// ───────────────────────── ④ 수집 원본 줄이기 ─────────────────────────

/** GitHub GET /repos/{owner}/{repo} 응답 모양(2026-11 실측 키 91개 중 대표) */
function githubRepo(fullName: string, id: number, extra: Record<string, unknown> = {}) {
  const [login, name] = fullName.split("/");
  const url = (path: string) => `https://api.github.com/repos/${fullName}${path}`;
  return {
    id, node_id: `R_kgDO${id}`, name, full_name: fullName, private: false, fork: false, archived: false, disabled: false,
    owner: { login, id: id + 1, node_id: `U_${id + 1}`, avatar_url: "https://avatars.githubusercontent.com/u/1", gravatar_id: "", url: `https://api.github.com/users/${login}`,
      html_url: `https://github.com/${login}`, followers_url: "f", following_url: "f", gists_url: "g", starred_url: "s", subscriptions_url: "s", organizations_url: "o",
      repos_url: "r", events_url: "e", received_events_url: "r", type: "User", user_view_type: "public", site_admin: false },
    html_url: `https://github.com/${fullName}`, description: "A useful command line tool for teams", homepage: "", topics: ["cli", "productivity"], language: "TypeScript",
    stargazers_count: 12, watchers_count: 12, watchers: 12, forks_count: 1, forks: 1, open_issues_count: 0, open_issues: 0, size: 120, network_count: 1, subscribers_count: 1,
    created_at: "2026-01-02T03:04:05Z", updated_at: "2026-09-01T00:00:00Z", pushed_at: "2026-09-01T00:00:00Z", default_branch: "main", has_issues: true,
    has_projects: true, has_wiki: true, has_pages: false, has_downloads: true, has_discussions: false, is_template: false, allow_forking: true, visibility: "public",
    web_commit_signoff_required: false, mirror_url: null, temp_clone_token: "", license: { key: "mit", name: "MIT License", spdx_id: "MIT", url: "u", node_id: "n" },
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    url: url(""), forks_url: url("/forks"), keys_url: url("/keys{/key_id}"), collaborators_url: url("/collaborators{/collaborator}"), teams_url: url("/teams"),
    hooks_url: url("/hooks"), issue_events_url: url("/issues/events{/number}"), events_url: url("/events"), assignees_url: url("/assignees{/user}"),
    branches_url: url("/branches{/branch}"), tags_url: url("/tags"), blobs_url: url("/git/blobs{/sha}"), git_tags_url: url("/git/tags{/sha}"),
    git_refs_url: url("/git/refs{/sha}"), trees_url: url("/git/trees{/sha}"), statuses_url: url("/statuses/{sha}"), languages_url: url("/languages"),
    stargazers_url: url("/stargazers"), contributors_url: url("/contributors"), subscribers_url: url("/subscribers"), subscription_url: url("/subscription"),
    commits_url: url("/commits{/sha}"), git_commits_url: url("/git/commits{/sha}"), comments_url: url("/comments{/number}"), issue_comment_url: url("/issues/comments{/number}"),
    contents_url: url("/contents/{+path}"), compare_url: url("/compare/{base}...{head}"), merges_url: url("/merges"), archive_url: url("/{archive_format}{/ref}"),
    downloads_url: url("/downloads"), issues_url: url("/issues{/number}"), pulls_url: url("/pulls{/number}"), milestones_url: url("/milestones{/number}"),
    notifications_url: url("/notifications{?since,all,participating}"), labels_url: url("/labels{/name}"), releases_url: url("/releases{/id}"),
    deployments_url: url("/deployments"), git_url: `git://github.com/${fullName}.git`, ssh_url: `git@github.com:${fullName}.git`,
    clone_url: `https://github.com/${fullName}.git`, svn_url: `https://github.com/${fullName}`,
    ...extra,
  };
}
type Seed = { repo: string; ageDays?: number; candidate?: Partial<typeof crawlCandidates.$inferInsert> | null; meta?: Record<string, unknown>;
  productUrl?: string | null; pageStatus?: number | null; pageMeta?: Record<string, unknown> | null };
let githubId = 10_000;
async function seedDocument(seed: Seed) {
  const meta = seed.meta ?? githubRepo(seed.repo, ++githubId);
  const [document] = await db.insert(crawlDocuments).values({ repo: seed.repo, repoMeta: meta, productUrl: seed.productUrl ?? null,
    pageStatus: seed.pageStatus ?? null, pageMeta: seed.pageMeta ?? null }).returning();
  await db.execute(sql`UPDATE crawl_documents SET fetched_at = (now() AT TIME ZONE 'UTC') - ${seed.ageDays ?? 40} * interval '1 day' WHERE id = ${document.id}`);
  const candidate = seed.candidate === null ? null : (await db.insert(crawlCandidates).values({ repo: seed.repo, productUrl: seed.productUrl ?? null,
    state: "rejected", reason: "no_homepage", decidedBy: "auto", ...seed.candidate }).returning())[0];
  return { document: (await db.select().from(crawlDocuments).where(eq(crawlDocuments.id, document.id)))[0], candidate };
}
const documentOf = async (repo: string) => (await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, repo)))[0];
const shrinkAll = () => shrinkDocuments(undefined, undefined, always);

describe("④ 수집 원본 줄이기 — 행·id 근거는 남긴다", () => {
  beforeEach(async () => {
    await resetTables();
    await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlSettings);
    await saveSettings({ judge: { maxStars: 2000, excludeOrganizations: false } }, "test");
  });

  it("오래된 자동 거절 원본만 읽는 키로 줄이고, 다른 원본은 글자 하나 바꾸지 않는다", async () => {
    const target = await seedDocument({ repo: "retention-test/old-reject" });
    const deepseek = await seedDocument({ repo: "retention-test/deepseek-reject", candidate: { decidedBy: "deepseek", reason: "not_a_product" } });
    const untouched = await Promise.all([
      seedDocument({ repo: "retention-test/recent-reject", ageDays: 10 }),
      seedDocument({ repo: "retention-test/admin-reject", candidate: { decidedBy: "admin" } }),
      seedDocument({ repo: "retention-test/published", candidate: { state: "published", publishedSlug: "published-one", reason: "passed" } }),
      seedDocument({ repo: "retention-test/review", candidate: { state: "needs_review", reason: "ambiguous" } }),
      seedDocument({ repo: "retention-test/no-candidate", candidate: null }),
      seedDocument({ repo: "retention-test/published-slug", candidate: { publishedSlug: "kept-slug" } }),
    ]);
    // 같은 이름(대소문자만 다름)의 거절 아닌 후보가 있다 · 같은 저장소의 제품이 있다 · 이름 바꾼 제품의 새 이름이다
    const variant = await seedDocument({ repo: "retention-test/Variant" });
    await db.insert(crawlCandidates).values({ repo: "Retention-Test/variant", state: "approved", reason: "passed", decidedBy: "auto" });
    const listed = await seedDocument({ repo: "retention-test/listed" });
    await db.insert(products).values({ slug: "listed", name: "Listed", url: "https://listed.example", repoUrl: "https://github.com/Retention-Test/Listed/",
      tagline: "t", description: "d", category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e".repeat(64) });
    const renamed = await seedDocument({ repo: "retention-test/renamed-new" });
    await db.insert(products).values({ slug: "renamed", name: "Renamed", url: "https://renamed.example", repoUrl: "https://github.com/retention-test/renamed-old",
      repoRenamedTo: "Retention-Test/Renamed-New", tagline: "t", description: "d", category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e".repeat(64) });
    const before = await db.select().from(crawlDocuments);

    const result = await shrinkAll();
    expect(result).toMatchObject({ caughtUp: true, counts: { shrunk: 2, passDone: true } });
    const after = await db.select().from(crawlDocuments);
    expect(after.length).toBe(before.length);
    for (const row of after) {
      const old = before.find(item => item.id === row.id)!;
      expect(row.fetchedAt).toEqual(old.fetchedAt);
      expect(row.pageMeta).toEqual(old.pageMeta);
      if (row.id === target.document.id || row.id === deepseek.document.id) continue;
      expect(row.repoMeta).toEqual(old.repoMeta);
    }
    for (const kept of [...untouched, variant, listed, renamed]) expect(after.find(row => row.id === kept.document.id)!.repoMeta).toEqual(kept.document.repoMeta);

    const shrunk = after.find(row => row.id === target.document.id)!.repoMeta;
    const original = target.document.repoMeta as Record<string, unknown>;
    expect(Object.keys(shrunk).sort()).toEqual(REPO_META_KEEP_KEYS.filter(key => key in original).sort());
    for (const key of Object.keys(shrunk)) if (key !== "owner") expect(shrunk[key]).toEqual(original[key]);
    expect(shrunk.owner).toEqual(Object.fromEntries(REPO_META_OWNER_KEEP_KEYS.map(key => [key, (original.owner as Record<string, unknown>)[key]])));
    expect(Buffer.byteLength(JSON.stringify(shrunk))).toBeLessThan(Buffer.byteLength(JSON.stringify(original)) / 5);

    // 멱등 — 한 바퀴를 마친 뒤 20시간 안에는 쉬고, 새로 돌아도 이미 줄인 행은 다시 쓰지 않는다
    expect((await shrinkDocuments(undefined, result.state, always)).counts).toMatchObject({ shrunk: 0, waiting: true });
    expect((await shrinkAll()).counts).toMatchObject({ shrunk: 0 });
  });

  it("메이커 소유 근거(저장소 id)·새 등재 알림이 읽는 주인 사실은 줄인 뒤에도 같다", async () => {
    const { document } = await seedDocument({ repo: "Hanul/Tiny-Cron" });
    await seedDocument({ repo: "hanul/tiny-cron", candidate: null, meta: githubRepo("hanul/tiny-cron", 4242) });
    const product = { id: 999_001, slug: "tiny-cron-anchor", repoUrl: "https://github.com/hanul/tiny-cron" };
    const ref = { owner: "hanul", repo: "tiny-cron", fullName: "hanul/tiny-cron", url: "https://github.com/hanul/tiny-cron" };
    const anchorsBefore = await storedRepositoryAnchors(product, ref);
    expect(anchorsBefore).toEqual(expect.arrayContaining([{ repoId: (document.repoMeta as { id: number }).id }, { repoId: 4242 }]));
    expect((await shrinkAll()).counts).toMatchObject({ shrunk: 1 });
    expect(await storedRepositoryAnchors(product, ref)).toEqual(anchorsBefore);
    const shrunk = (await documentOf("Hanul/Tiny-Cron")).repoMeta as { id: unknown; full_name: unknown; owner: Record<string, unknown> };
    expect({ id: shrunk.id, fullName: shrunk.full_name, owner: shrunk.owner }).toEqual({ id: (document.repoMeta as { id: number }).id, fullName: "Hanul/Tiny-Cron",
      owner: { login: "Hanul", id: (document.repoMeta as { owner: { id: number } }).owner.id, node_id: (document.repoMeta as { owner: { node_id: string } }).owner.node_id, type: "User" } });
    // 이름 바뀐 저장소 막기(crawl_documents_github_id_idx)도 그대로 찾는다
    const [byId] = await db.execute<{ repo: string }>(sql`SELECT repo FROM crawl_documents WHERE repo_meta->>'id' = ${String(shrunk.id)}`);
    expect(byId.repo).toBe("Hanul/Tiny-Cron");
  });

  it("판정·재판정·재고·관리자 심사 입력이 줄이기 전과 같다", async () => {
    const settings = await getSettings();
    const page = { title: "Tool", description: "A useful command line tool", textSample: "Install the CLI and run it every day.", readmeSample: "# Tool\nUse it." };
    const big = await seedDocument({ repo: "retention-test/large", productUrl: "https://large.example", pageStatus: 200, pageMeta: page,
      meta: githubRepo("retention-test/large", 77, { stargazers_count: 5000 }), candidate: { reason: "large_oss", productUrl: "https://large.example" } });
    const pkgRepo = `retention-test/package-${randomUUID().slice(0, 8)}`;
    const pkg = await seedDocument({ repo: pkgRepo, meta: githubRepo(pkgRepo, 78, { stargazers_count: 40,
      nmv_package_proof: [{ kind: "skill", path: "SKILL.md" }] }) });
    const spam = await seedDocument({ repo: "retention-test/spammy", productUrl: "https://spammy.github.io", pageStatus: 200,
      pageMeta: { title: "Download Now", textSample: "free download crack" }, meta: githubRepo("retention-test/spammy", 79, { stargazers_count: 0, has_issues: false }) });
    const docs = [big, pkg, spam].map(item => item.document);
    const pure = (document: typeof docs[number]) => ({
      facts: factsFromRepoMeta(document.repo, document.repoMeta), revision: judgeRevision(document), spam: spamSignals(document),
      tagline: taglineEvidence(document.repo, document), access: accessFromDocument(document, settings, new Date("2026-11-15T00:00:00Z")),
      verdict: judgeStoredDocument(document, settings, new Date("2026-11-15T00:00:00Z")),
    });
    const pureBefore = docs.map(pure);
    const rejudgeBefore = await planStarRejudge();
    const reconsiderBefore = await planReconsideration(100, { policy: "package" });
    const reviewBefore = await db.transaction(async tx => (await lockedInput(tx, pkg.document.repo))!.input);
    expect(rejudgeBefore.entries).toHaveLength(1);
    expect(reconsiderBefore.entries.map(entry => entry.repo)).toEqual([pkgRepo]);

    expect((await shrinkAll()).counts).toMatchObject({ shrunk: 3 });
    const after = await Promise.all(docs.map(document => documentOf(document.repo)));
    expect(after.map(pure)).toEqual(pureBefore);
    const rejudgeAfter = await planStarRejudge();
    const strip = (entry: (typeof rejudgeBefore.entries)[number]) => ({ ...entry, documentHash: undefined });
    expect(rejudgeAfter.entries.map(strip)).toEqual(rejudgeBefore.entries.map(strip));
    const reconsiderAfter = await planReconsideration(100, { policy: "package" });
    expect(reconsiderAfter.entries.map(entry => ({ ...entry, revision: undefined }))).toEqual(reconsiderBefore.entries.map(entry => ({ ...entry, revision: undefined })));
    const reviewAfter = await db.transaction(async tx => (await lockedInput(tx, pkg.document.repo))!.input);
    expect({ inputHash: reviewAfter.inputHash, sourceRevisionHash: reviewAfter.sourceRevisionHash, snapshot: reviewAfter.snapshot })
      .toEqual({ inputHash: reviewBefore.inputHash, sourceRevisionHash: reviewBefore.sourceRevisionHash, snapshot: reviewBefore.snapshot });
    // 재고 적용(다시 수집 대기)도 줄인 원본에서 그대로 된다 — 다시 받으면 repo_meta 전체를 새로 쓴다
    expect(await applyReconsideration(reconsiderAfter, "test")).toEqual({ queued: [pkgRepo], changed: [] });
  });

  it("예산이 다하면 id 자리를 커서에 남기고 다음 틱에 이어 한다", async () => {
    await seedDocument({ repo: "retention-test/resume" });
    const stopped = await shrinkDocuments(undefined, undefined, () => false);
    expect(stopped).toMatchObject({ caughtUp: false, state: { afterId: 0 } });
    let calls = 0;
    const first = await shrinkDocuments(undefined, undefined, () => calls++ < 1);
    expect(first.state.afterId).toBe(5_000);
    expect((await shrinkDocuments(undefined, first.state, always)).counts).toMatchObject({ passDone: true });
  });
});

// ───────────────────────── 발굴 근거 · 스캔 · 가동 집계 ─────────────────────────

describe("⑥ 발굴 근거·스캔·가동 집계", () => {
  beforeEach(resetTables);

  async function evidence(key: string, hoursAgo: number, commitSha: string | null) {
    const [row] = await db.execute<{ id: number }>(sql`INSERT INTO crawl_discovery_evidence (repository_key, signal_id, evidence_key, source_url, commit_sha, observed_at)
      VALUES (${key}, 'claude-trailer', ${randomUUID().replaceAll("-", "")}, ${`https://github.com/${key}/commit/${commitSha ?? "x"}`}, ${commitSha},
        (now() AT TIME ZONE 'UTC') - ${hoursAgo} * interval '1 hour') RETURNING id`);
    return Number(row.id);
  }
  const sha = (n: number) => n.toString(16).padStart(40, "0");
  const readerShas = async (key: string) => [...new Set((await listDiscoveryEvidence(key)).flatMap(row => row.commitSha ? [row.commitSha] : []))]
    .filter(value => /^[a-f0-9]{40,64}$/.test(value)).slice(0, 5);

  it("발굴 근거: 24시간 안 + 저장소마다 최근 서로 다른 commit 5개(마지막 행)만 남기고, 읽는 쪽의 commit 5개는 그대로다", async () => {
    const key = "retention-test/evidence";
    const ids: Record<string, number> = {};
    ids.nullOld = await evidence(key, 60, null);
    ids.badOld = await evidence(key, 59, "zzz");
    for (let n = 7; n >= 1; n -= 1) ids[`sha${n}`] = await evidence(key, 30 + n, sha(n));
    ids.sha1dup = await evidence(key, 30.5, sha(1));
    ids.other = await evidence("retention-test/single", 30, sha(99));
    ids.recentNull = await evidence(key, 2, null);
    const readerBefore = await readerShas(key);

    const first = await pruneDiscoveryEvidence(undefined, undefined, always);
    expect(first).toMatchObject({ caughtUp: true, counts: { deleted: 5 } });
    expect(first.state.afterId).toBe(ids.other);
    const left = new Set((await db.execute<{ id: number }>(sql`SELECT id FROM crawl_discovery_evidence`)).map(row => Number(row.id)));
    expect([...left].sort((a, b) => a - b)).toEqual([ids.sha5, ids.sha4, ids.sha3, ids.sha2, ids.sha1dup, ids.other, ids.recentNull].sort((a, b) => a - b));
    expect(await readerShas(key)).toEqual(readerBefore);
    // 커서 뒤 새 행이 없으면 다시 돌아도 지우지 않는다
    expect((await pruneDiscoveryEvidence(undefined, first.state, always)).counts).toMatchObject({ deleted: 0 });
  });

  it("스캔: 7일 지난 scope '' 중 보존 집합(최신 2·끝난 최신·complete 최신·제품 근거·30일 심사 시도) 밖만 관측과 함께 지운다", async () => {
    const key = "retention-test/scan";
    const scan = async (n: number, days: number, state: string, scope = "") => {
      const [row] = await db.execute<{ id: number }>(sql`INSERT INTO agent_repository_scans (github_repository_id, repository_key, commit_sha, detector_version, scope,
          scope_hash, state, started_at, completed_at) VALUES (555, ${key}, ${sha(n)}, 'v1', ${scope}, ${scope ? "b".repeat(64) : HASH}, ${state},
          (now() AT TIME ZONE 'UTC') - ${days} * interval '1 day', (now() AT TIME ZONE 'UTC') - ${days} * interval '1 day' + interval '1 minute') RETURNING id`);
      await db.execute(sql`INSERT INTO agent_repository_observations (scan_id, observation_key, facts) VALUES (${row.id}, ${HASH}, '{}'::jsonb)`);
      return Number(row.id);
    };
    const s = { old: await scan(1, 30, "complete"), partial: await scan(2, 20, "partial"), latestComplete: await scan(3, 15, "complete"),
      linked: await scan(4, 12, "failed"), reviewed: await scan(5, 10, "failed"), second: await scan(6, 9, "failed"), first: await scan(7, 2, "failed"),
      scoped: await scan(8, 40, "complete", "docs/") };
    await db.execute(sql`INSERT INTO product_evidence_sources (slug, kind, provider, source_key, normalized_facts)
      VALUES ('scan-product', 'repository', 'github', ${key}, ${JSON.stringify({ agentScanId: s.linked })}::jsonb)`);
    const [candidate] = await db.insert(crawlCandidates).values({ repo: "retention-test/scan-candidate", state: "rejected", reason: "no_homepage", decidedBy: "auto" })
      .onConflictDoNothing().returning();
    const candidateId = candidate?.id ?? (await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, "retention-test/scan-candidate")))[0].id;
    await db.execute(sql`INSERT INTO crawl_review_attempts (candidate_id, state, input_hash, policy_hash, source_revision_hash, snapshot, source, prompt_version,
        rules_version, attempt_number, valid_until) VALUES (${candidateId}, 'succeeded', ${HASH}, ${HASH}, ${HASH}, '{}'::jsonb,
        ${JSON.stringify({ scanId: s.reviewed })}::jsonb, 'p', 'r', 1, now())`);
    try {
      const result = await pruneScans(undefined, undefined, always);
      expect(result).toMatchObject({ caughtUp: true, counts: { scans: 2, observations: 2, passDone: true } });
      const left = new Set((await db.execute<{ id: number }>(sql`SELECT id FROM agent_repository_scans`)).map(row => Number(row.id)));
      expect(left).toEqual(new Set([s.latestComplete, s.linked, s.reviewed, s.second, s.first, s.scoped]));
      const [{ n }] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM agent_repository_observations`);
      expect(n).toBe(6);
      expect((await pruneScans(undefined, result.state, always)).counts).toMatchObject({ waiting: true });
    } finally {
      await db.delete(crawlCandidates).where(eq(crawlCandidates.id, candidateId));
    }
  });

  it("가동 집계: KST 오늘 − 40일보다 이른 날만 지운다", async () => {
    const day = (offset: number) => sql`(now() AT TIME ZONE 'Asia/Seoul')::date - ${offset}::int`;
    for (const offset of [45, 41, 40, 0]) await db.execute(sql`INSERT INTO product_health_daily (slug, day, checks, successes) VALUES ('h', ${day(offset)}, 1, 1)`);
    const result = await pruneHealthDaily(undefined, undefined, always);
    expect(result).toMatchObject({ caughtUp: true, counts: { rows: 2, days: 2, passDone: true } });
    const [{ n }] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM product_health_daily`);
    expect(n).toBe(2);
  });

  it("잡: 다섯 부분을 차례로 돌고 한 줄 기록·다음 커서(먼저 설 부분 돌리기)를 남긴다", async () => {
    const logs: { event: string; fields?: Record<string, unknown> }[] = [];
    const ctx = (cursor: DbRetentionCursor | null): JobContext<DbRetentionCursor> => ({ cursor, save: async () => {}, hasBudget: always,
      log: (event, fields) => { logs.push({ event, fields }); } });
    const first = await runDbRetention(ctx(null));
    expect(first.done).toBe(true);
    const cursor = first.cursor as DbRetentionCursor;
    expect(cursor).toMatchObject({ v: 1, lead: 1, documents: { afterId: 0 }, scans: { afterId: 0 } });
    expect(cursor.health?.passDoneAt).toEqual(expect.any(String));
    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe("db.retention");
    expect(Object.keys(logs[0].fields ?? {})).toEqual(expect.arrayContaining(DB_RETENTION_PARTS.map(part => `${part}.caughtUp`)));
    const second = await runDbRetention(ctx(cursor));
    expect((second.cursor as DbRetentionCursor).lead).toBe(2);
    // 예산이 없으면 아무 부분도 열지 않는다
    const idle = await runDbRetention({ ...ctx(cursor), hasBudget: () => false });
    expect((idle.cursor as DbRetentionCursor).documents).toEqual(cursor.documents);
  });
});
