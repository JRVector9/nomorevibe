import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, jobs, productEvidenceSources, productStarObservationRuns, productStarObservations,
  repositoryIdentityAnchors } from "@/lib/db/schema";
import { enqueue, dequeue, putDocument, saveFetchedDocument } from "@/lib/crawl/repository";
import * as productRepository from "@/lib/domain/products/repository";
import { upsertObservedSource } from "@/lib/domain/evidence/repository";
import { pruneStarObservations } from "@/lib/jobs/products/star-observation";
import { STAR_OBSERVATION_POLICY } from "@/lib/domain/products/star-observation-policy";
import { decideOwnership, parseRepoUrl, storedRepositoryAnchors, type RepoAnchor } from "@/lib/me/maker-claims";
import type { JobContext } from "@/lib/jobs/runner";
import type { JobLease } from "@/lib/jobs/control";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";
import { claimFetchFixtureJob } from "./fetch-fixtures";
import { clearRepositoryIdentityAnchors } from "./repository-identity-anchors-fixture";

vi.mock("server-only", () => ({}));

/**
 * 저장소 id 근거 표(0191) — 세 출처의 값이 덮이거나 지워져도 우리가 본 id 가 남는지, 근거 행은 지울 수 없는지, id 가 그대로인 갱신은 쓰지 않는지,
 * 그리고 남은 근거로 소유 확인이 «다른 저장소» 를 가려내는지 본다.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/ops/backfill-repository-identity-anchors.ts");
const DAY_MS = 86_400_000;
// 숫자 id 11·22 의 node id(R_ + msgpack [0, id]) — lib/me/maker-claims.ts repositoryIdFromNodeId 가 같은 숫자로 읽는다
const nodeIdOf = (id: number) => `R_${Buffer.from([0x92, 0x00, id]).toString("base64url")}`;
const meta = (id: number, extra: Record<string, unknown> = {}) => ({ id, node_id: nodeIdOf(id), full_name: "anchor-owner/tool",
  owner: { id: 9001, type: "User", login: "anchor-owner" }, ...extra });
const document = (repo: string, repoMeta: Record<string, unknown>) => ({ repo, repoMeta, productUrl: null, pageStatus: null, pageMeta: null });

/** DB 정렬 규칙과 무관하게 견주려고 JS 차례로 */
const sorted = (list: string[]) => [...list].sort();

let fetchLease: JobLease | undefined;

async function anchors(repoKey?: string) {
  const rows = await db.select().from(repositoryIdentityAnchors).where(repoKey ? eq(repositoryIdentityAnchors.repoKey, repoKey) : undefined);
  return sorted(rows.map((row) => `${row.repoKey} ${row.kind} ${row.value} ${row.source}`));
}
/** 근거 행이 다시 쓰였는지 — 행 버전(xmin·ctid)이 그대로면 쓰기가 없었다 */
async function anchorVersions() {
  const rows = await db.execute<{ version: string }>(sql`select repo_key || ' ' || kind || ' ' || value || ' ' || xmin::text || ' ' || ctid::text as version
    from repository_identity_anchors order by repo_key, kind, value`);
  return rows.map((row) => row.version);
}
async function product(slug: string, repoUrl: string) {
  await productRepository.insert({ slug, url: `https://${slug}.example`, name: slug, tagline: "fixture", description: "fixture", category: "Dev" as const,
    verifyToken: `v-${slug}`, editTokenHash: "e".repeat(64), repoUrl, source: "crawler", status: "seeded" });
  return (await productRepository.findBySlug(slug))!;
}
async function closedRun(endedAgoMs: number) {
  const end = new Date(Date.now() - endedAgoMs);
  const [row] = await db.insert(productStarObservationRuns).values({ cycleAt: end, windowStartsAt: new Date(end.getTime() - 3_600_000), deadlineAt: end,
    status: "closed", policyVersion: "test", policy: {} as never }).returning();
  return row;
}
function backfill(args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--sleep-ms", "0", ...args], {
    input: TEST_DATABASE_URL, encoding: "utf8", timeout: 60_000, cwd: path.resolve(__dirname, "../.."), env: { ...process.env },
  });
  const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, events,
    source: (name: string) => events.find((event) => event.event === "source" && event.source === name), done: events.find((event) => event.event === "done") };
}

beforeAll(ensureSchema);
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.execute(sql`TRUNCATE product_star_observation_runs, product_star_observations RESTART IDENTITY CASCADE`);
  // 출처를 지운 뒤에 비운다 — 출처 행을 DELETE 하면 그 값이 근거로 남는다
  await clearRepositoryIdentityAnchors();
  fetchLease = undefined;
});
afterEach(async () => {
  if (fetchLease) await db.delete(jobs).where(and(eq(jobs.name, fetchLease.name), eq(jobs.leaseToken, fetchLease.token)));
});

describe("수집 원본(crawl_documents)", () => {
  it("같은 이름에 다른 id 로 다시 저장하면 원본은 덮이지만 옛 id 와 새 id 가 모두 근거에 남고, 소유 확인은 repo_replaced 를 낸다", async () => {
    await putDocument(document("anchor-owner/tool", meta(11)));
    expect(await anchors()).toEqual(sorted([`anchor-owner/tool node_id ${nodeIdOf(11)} crawl_document`, "anchor-owner/tool repo_id 11 crawl_document"]));

    // 수집이 같은 이름에서 다른 저장소를 받았다(saveFetchedDocument 는 지금처럼 그대로 덮는다 — 덮지 않고 사람에게 보내는 것은 다음 단계)
    fetchLease = await claimFetchFixtureJob();
    await enqueue([{ repo: "anchor-owner/tool", signal: "test" }]);
    const [claim] = await dequeue(1, undefined, fetchLease);
    expect(await saveFetchedDocument(claim, document("anchor-owner/tool", meta(22)))).toMatchObject({ needsJudgement: true });

    const [saved] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, "anchor-owner/tool"));
    expect(saved.repoMeta.id).toBe(22);
    expect(await anchors()).toEqual(sorted([
      `anchor-owner/tool node_id ${nodeIdOf(11)} crawl_document`, `anchor-owner/tool node_id ${nodeIdOf(22)} crawl_document`,
      "anchor-owner/tool repo_id 11 crawl_document", "anchor-owner/tool repo_id 22 crawl_document",
    ]));

    const row = await product("anchor-tool", "https://github.com/anchor-owner/tool");
    const ref = parseRepoUrl(row.repoUrl)!;
    const stored = await storedRepositoryAnchors({ id: row.id, slug: row.slug, repoUrl: row.repoUrl! }, ref);
    expect(stored.flatMap((anchor: RepoAnchor) => "repoId" in anchor ? [anchor.repoId] : []).sort()).toEqual([11, 22]);
    expect(stored.flatMap((anchor: RepoAnchor) => "nodeId" in anchor ? [anchor.nodeId] : []).sort()).toEqual([nodeIdOf(11), nodeIdOf(22)].sort());
    // 지금 GitHub 이 답하는 것은 새 저장소(22)다 — 주인 id 가 내 것이어도 전에 본 저장소(11)와 달라 거절한다
    const now = { ownerId: 9001, ownerType: "User", private: false, repoId: 22, nodeId: nodeIdOf(22) };
    expect(decideOwnership([9001], now, stored)).toEqual({ ok: false, reason: "repo_replaced" });
    // 옛 저장소가 그대로 답해도 마찬가지다 — 두 저장소를 본 이름이다
    expect(decideOwnership([9001], { ...now, repoId: 11, nodeId: nodeIdOf(11) }, stored)).toEqual({ ok: false, reason: "repo_replaced" });
  });

  it("putDocument 로 덮어도 옛 id 가 남고, 옛 근거의 마지막 본 시각은 그 원본을 받은 시각이다", async () => {
    const fetchedAt = new Date(Date.now() - 40 * DAY_MS);
    await db.insert(crawlDocuments).values({ ...document("anchor-owner/tool", meta(11)), fetchedAt });
    // 근거가 아직 없는 옛 행(0191 전에 있던 행)처럼
    await clearRepositoryIdentityAnchors();
    await putDocument(document("anchor-owner/tool", meta(22)));

    const rows = await db.select().from(repositoryIdentityAnchors).where(eq(repositoryIdentityAnchors.kind, "repo_id"))
      .orderBy(asc(repositoryIdentityAnchors.value));
    expect(rows.map((row) => row.value)).toEqual(["11", "22"]);
    expect(rows[0].firstSeenAt.getTime()).toBe(fetchedAt.getTime());
    expect(rows[0].lastSeenAt.getTime()).toBe(fetchedAt.getTime());
    expect(Date.now() - rows[1].firstSeenAt.getTime()).toBeLessThan(60_000);
  });

  it("id 가 그대로인 갱신(재수집·README·줄이기)은 근거 행을 늘리지도 다시 쓰지도 않는다", async () => {
    await putDocument(document("anchor-owner/tool", meta(11, { stargazers_count: 1, html_url: "https://github.com/anchor-owner/tool" })));
    const before = await anchorVersions();
    expect(before).toHaveLength(2);

    for (let stars = 2; stars < 6; stars++) await putDocument(document("anchor-owner/tool", meta(11, { stargazers_count: stars })));
    await db.update(crawlDocuments).set({ pageMeta: { readmeSample: "hello" } }).where(eq(crawlDocuments.repo, "anchor-owner/tool"));
    // 보관 정리가 하듯 repo_meta 의 키를 줄인다(id·node_id 는 그대로)
    await db.execute(sql`update crawl_documents set repo_meta = repo_meta - 'stargazers_count' - 'full_name' where repo = 'anchor-owner/tool'`);

    expect(await anchorVersions()).toEqual(before);
  });

  it("모양이 맞지 않는 값은 남기지 않고 원래 쓰기는 그대로 된다", async () => {
    await db.insert(crawlDocuments).values([
      document("not a repository name", { id: 5 }),
      document("anchor-owner/text-id", { id: "abc", node_id: 12 }),
      document("anchor-owner/float-id", { id: 1.5, node_id: "  N1 " }),
      document("anchor-owner/long-node", { id: 0, node_id: "n".repeat(201) }),
      document("anchor-owner/no-id", { full_name: "anchor-owner/no-id" }),
      document("anchor-owner/array", [1, 2] as unknown as Record<string, unknown>),
    ]);
    expect(await db.select({ repo: crawlDocuments.repo }).from(crawlDocuments)).toHaveLength(6);
    expect(await anchors()).toEqual(sorted(["anchor-owner/float-id node_id N1 crawl_document"]));
  });

  it("원본 행을 지워도 근거는 남는다 — 근거가 없던 옛 행도 지워질 때 남긴다", async () => {
    await putDocument(document("anchor-owner/tool", meta(11)));
    await clearRepositoryIdentityAnchors();
    await db.delete(crawlDocuments).where(eq(crawlDocuments.repo, "anchor-owner/tool"));
    expect(await db.select().from(crawlDocuments)).toHaveLength(0);
    expect(await anchors()).toEqual(sorted([`anchor-owner/tool node_id ${nodeIdOf(11)} crawl_document`, "anchor-owner/tool repo_id 11 crawl_document"]));
  });
});

describe("사실 수집(product_evidence_sources)", () => {
  const source = (slug: string, repositoryId: number | null) => ({ slug, kind: "repository", provider: "github", sourceKey: "anchor-owner/tool",
    state: repositoryId === null ? "failed" : "ok", ...(repositoryId === null ? {}
      : { lastSuccessAt: new Date(), normalizedFacts: { type: "github_repository", repositoryKey: "anchor-owner/tool", repositoryId, stars: 1 } }) });

  it("repositoryId 가 바뀌어도, 사실이 비워져도 옛 값이 남는다", async () => {
    const row = await product("anchor-tool", "https://github.com/anchor-owner/tool");
    await upsertObservedSource(source(row.slug, 11), undefined, row.id);
    expect(await anchors()).toEqual(sorted(["anchor-owner/tool repo_id 11 evidence_source"]));

    await upsertObservedSource(source(row.slug, 22), undefined, row.id);
    const [stored] = await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, row.slug));
    expect(stored.normalizedFacts?.repositoryId).toBe(22);
    expect(await anchors()).toEqual(sorted(["anchor-owner/tool repo_id 11 evidence_source", "anchor-owner/tool repo_id 22 evidence_source"]));

    // 같은 id 의 갱신(별 수만 바뀜)은 근거를 다시 쓰지 않는다
    const before = await anchorVersions();
    await upsertObservedSource({ ...source(row.slug, 22), normalizedFacts: { type: "github_repository", repositoryKey: "anchor-owner/tool", repositoryId: 22, stars: 9 } }, undefined, row.id);
    expect(await anchorVersions()).toEqual(before);

    await db.update(productEvidenceSources).set({ normalizedFacts: null, state: "disconnected" }).where(eq(productEvidenceSources.slug, row.slug));
    await db.delete(productEvidenceSources).where(eq(productEvidenceSources.slug, row.slug));
    expect(await anchors()).toEqual(sorted(["anchor-owner/tool repo_id 11 evidence_source", "anchor-owner/tool repo_id 22 evidence_source"]));

    const kept = await storedRepositoryAnchors({ id: row.id, slug: row.slug, repoUrl: row.repoUrl! }, parseRepoUrl(row.repoUrl)!);
    expect(decideOwnership([9001], { ownerId: 9001, ownerType: "User", private: false, repoId: 22 }, kept)).toEqual({ ok: false, reason: "repo_replaced" });
  });

  it("저장소가 아닌 출처와, 근거 표 권한이 없는 계정의 id 를 바꾸지 않는 쓰기는 근거 트리거에 닿지 않는다", async () => {
    const row = await product("anchor-tool", "https://github.com/anchor-owner/tool");
    await upsertObservedSource(source(row.slug, 11), undefined, row.id);
    const before = await anchorVersions();
    // 사이트 근거만 쓰는 좁은 계정(Oracle site-evidence 와 같은 권한 모양): 출처 표에는 쓰지만 근거 표 권한은 없다
    await db.execute(sql`drop role if exists anchor_narrow_writer`);
    await db.execute(sql`create role anchor_narrow_writer nologin`);
    try {
      await db.execute(sql`grant select, insert, update on product_evidence_sources to anchor_narrow_writer`);
      await db.execute(sql`grant usage on sequence product_evidence_sources_id_seq to anchor_narrow_writer`);
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local role anchor_narrow_writer`);
        await tx.execute(sql`insert into product_evidence_sources (slug, kind, provider, source_key, state, normalized_facts)
          values (${row.slug}, 'documentation', 'product_site', 'canonical_site', 'ok', '{"type":"site_fingerprint","repositoryId":77}'::jsonb)`);
        // 저장소 출처의 관계 칸만 고친다(recomputeRepositoryRelationships 와 같은 쓰기) — repositoryId 는 그대로
        await tx.execute(sql`update product_evidence_sources set normalized_facts = normalized_facts || '{"relationshipState":"site_link"}'::jsonb
          where slug = ${row.slug} and kind = 'repository'`);
      });
    } finally {
      await db.execute(sql`drop owned by anchor_narrow_writer`);
      await db.execute(sql`drop role anchor_narrow_writer`);
    }
    const [repository] = await db.select().from(productEvidenceSources).where(and(eq(productEvidenceSources.slug, row.slug), eq(productEvidenceSources.kind, "repository")));
    expect(repository.normalizedFacts).toMatchObject({ repositoryId: 11, relationshipState: "site_link" });
    expect(await anchorVersions()).toEqual(before);
  });
});

describe("스타 관측(product_star_observations)", () => {
  it("관측이 보관 기간 뒤 지워져도 node id 근거가 남는다", async () => {
    const row = await product("anchor-tool", "https://github.com/anchor-owner/tool");
    const run = await closedRun((STAR_OBSERVATION_POLICY.retentionDays + 1) * DAY_MS);
    // 잡이 하듯: 대상 행을 먼저 넣고(id 없음) 관측 결과로 채운다
    await db.insert(productStarObservations).values({ runId: run.id, productId: row.id, slug: row.slug, repoUrl: row.repoUrl!,
      repositoryKey: "anchor-owner/tool", repoLinkVersion: 1 });
    expect(await anchors()).toEqual(sorted([]));
    await db.update(productStarObservations).set({ status: "ok", stars: 3, repositoryId: nodeIdOf(11), observedAt: run.cycleAt, archived: false })
      .where(eq(productStarObservations.runId, run.id));
    expect(await anchors()).toEqual(sorted([`anchor-owner/tool node_id ${nodeIdOf(11)} star_observation`]));

    expect(await pruneStarObservations({ cursor: null, save: async () => {}, hasBudget: () => true, log: () => {} } as JobContext<null>)).toBe(1);
    expect(await db.select().from(productStarObservations)).toHaveLength(0);
    expect(await anchors()).toEqual(sorted([`anchor-owner/tool node_id ${nodeIdOf(11)} star_observation`]));

    // 관측이 사라진 뒤 그 이름에 다른 저장소가 답해도, 남은 근거로 가려낸다
    const kept = await storedRepositoryAnchors({ id: row.id, slug: row.slug, repoUrl: row.repoUrl! }, parseRepoUrl(row.repoUrl)!);
    expect(kept).toEqual([{ nodeId: nodeIdOf(11) }]);
    expect(decideOwnership([9001], { ownerId: 9001, ownerType: "User", private: false, repoId: 22, nodeId: nodeIdOf(22) }, kept))
      .toEqual({ ok: false, reason: "repo_replaced" });
    expect(decideOwnership([9001], { ownerId: 9001, ownerType: "User", private: false, repoId: 11, nodeId: nodeIdOf(11) }, kept))
      .toEqual({ ok: true, githubUserId: 9001 });
  });

  it("한 문장으로 여러 관측을 채워도 저장소마다 남고, 주기마다 같은 값이면 마지막 본 시각만 하루에 한 번 옮긴다", async () => {
    const first = await product("anchor-a", "https://github.com/anchor-owner/a");
    const second = await product("anchor-b", "https://github.com/anchor-owner/b");
    const old = await closedRun(3 * DAY_MS);
    await db.insert(productStarObservations).values([first, second].map((row, index) => ({ runId: old.id, productId: row.id, slug: row.slug,
      repoUrl: row.repoUrl!, repositoryKey: `anchor-owner/${index ? "b" : "a"}`, repoLinkVersion: 1, status: "ok" as const, stars: 1,
      repositoryId: nodeIdOf(31 + index), observedAt: old.cycleAt, archived: false })));
    expect(await anchors()).toEqual(sorted([`anchor-owner/a node_id ${nodeIdOf(31)} star_observation`, `anchor-owner/b node_id ${nodeIdOf(32)} star_observation`]));
    const seenAt = async () => (await db.select().from(repositoryIdentityAnchors).orderBy(asc(repositoryIdentityAnchors.repoKey))).map((row) => row.lastSeenAt.getTime());
    expect(await seenAt()).toEqual([old.cycleAt.getTime(), old.cycleAt.getTime()]);

    // 한 시간 뒤 주기: 하루가 안 지났다 — 쓰지 않는다
    const soon = await closedRun(3 * DAY_MS - 3_600_000);
    const versions = await anchorVersions();
    await db.insert(productStarObservations).values({ runId: soon.id, productId: first.id, slug: first.slug, repoUrl: first.repoUrl!,
      repositoryKey: "anchor-owner/a", repoLinkVersion: 1, status: "ok", stars: 1, repositoryId: nodeIdOf(31), observedAt: soon.cycleAt, archived: false });
    expect(await anchorVersions()).toEqual(versions);

    // 이틀 뒤 주기: 마지막 본 시각만 앞으로
    const later = await closedRun(DAY_MS);
    await db.insert(productStarObservations).values({ runId: later.id, productId: first.id, slug: first.slug, repoUrl: first.repoUrl!,
      repositoryKey: "anchor-owner/a", repoLinkVersion: 1, status: "ok", stars: 1, repositoryId: nodeIdOf(31), observedAt: later.cycleAt, archived: false });
    expect(await seenAt()).toEqual([later.cycleAt.getTime(), old.cycleAt.getTime()]);
    expect(await anchors()).toHaveLength(2);
  });
});

describe("근거 표는 덧붙이기만 한다", () => {
  it("DELETE·TRUNCATE 와 값·처음 본 시각 고치기, 마지막 본 시각 되돌리기를 거절한다", async () => {
    await putDocument(document("anchor-owner/tool", meta(11)));
    const one = and(eq(repositoryIdentityAnchors.repoKey, "anchor-owner/tool"), eq(repositoryIdentityAnchors.kind, "repo_id"));
    await expect(db.delete(repositoryIdentityAnchors).where(one)).rejects.toThrow();
    await expect(db.delete(repositoryIdentityAnchors)).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE repository_identity_anchors`)).rejects.toThrow();
    await expect(db.update(repositoryIdentityAnchors).set({ value: "22" }).where(one)).rejects.toThrow();
    await expect(db.update(repositoryIdentityAnchors).set({ repoKey: "anchor-owner/other" }).where(one)).rejects.toThrow();
    await expect(db.update(repositoryIdentityAnchors).set({ source: "manual" }).where(one)).rejects.toThrow();
    await expect(db.update(repositoryIdentityAnchors).set({ firstSeenAt: new Date(0) }).where(one)).rejects.toThrow();
    await expect(db.update(repositoryIdentityAnchors).set({ lastSeenAt: sql`${repositoryIdentityAnchors.lastSeenAt} - interval '1 hour'` }).where(one)).rejects.toThrow();
    expect(await anchors()).toEqual(sorted([`anchor-owner/tool node_id ${nodeIdOf(11)} crawl_document`, "anchor-owner/tool repo_id 11 crawl_document"]));
    // 모양이 맞지 않는 행은 직접 넣어도 들어가지 않는다
    await expect(db.insert(repositoryIdentityAnchors).values({ repoKey: "Anchor-Owner/Tool", kind: "repo_id", value: "33", source: "manual" })).rejects.toThrow();
    await expect(db.insert(repositoryIdentityAnchors).values({ repoKey: "anchor-owner/tool", kind: "repo_id", value: "-3", source: "manual" })).rejects.toThrow();
  });
});

describe("백필(scripts/ops/backfill-repository-identity-anchors.ts)", () => {
  it("세 출처에 남아 있는 값을 옮기고, 두 번 돌려도 같다", async () => {
    const fetchedAt = new Date(Date.now() - 30 * DAY_MS);
    await db.insert(crawlDocuments).values([
      { ...document("Anchor-Owner/Tool", meta(11)), fetchedAt },
      { ...document("anchor-owner/second", { id: 12 }), fetchedAt },
      { ...document("anchor-owner/no-id", { full_name: "anchor-owner/no-id" }), fetchedAt },
      { ...document("not a repository name", { id: 13 }), fetchedAt },
    ]);
    const row = await product("anchor-tool", "https://github.com/anchor-owner/tool");
    await db.insert(productEvidenceSources).values([
      { slug: row.slug, kind: "repository", provider: "github", sourceKey: "anchor-owner/tool",
        normalizedFacts: { type: "github_repository", repositoryKey: "anchor-owner/tool", repositoryId: 21 } },
      { slug: row.slug, kind: "documentation", provider: "product_site", sourceKey: "canonical_site", normalizedFacts: { type: "site_fingerprint", repositoryId: 99 } },
    ]);
    const run = await closedRun(DAY_MS);
    await db.insert(productStarObservations).values({ runId: run.id, productId: row.id, slug: row.slug, repoUrl: row.repoUrl!, repositoryKey: "anchor-owner/tool",
      repoLinkVersion: 1, status: "ok", stars: 1, repositoryId: nodeIdOf(31), observedAt: run.cycleAt, archived: false });
    // 0191 전에 있던 행처럼 — 근거 없이 출처만 남긴다
    await clearRepositoryIdentityAnchors();

    const plan = backfill(["--span", "2"]);
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.source("crawl")).toMatchObject({ complete: true, anchors: 3, missing: 3 });
    expect(plan.source("evidence")).toMatchObject({ complete: true, anchors: 1, missing: 1 });
    expect(plan.source("stars")).toMatchObject({ complete: true, anchors: 1, missing: 1 });
    expect(await anchors()).toEqual(sorted([]));
    expect(plan.stdout + plan.stderr).not.toContain("nomorevibe:");

    const expected = sorted([
      "anchor-owner/second repo_id 12 crawl_document",
      `anchor-owner/tool node_id ${nodeIdOf(11)} crawl_document`, `anchor-owner/tool node_id ${nodeIdOf(31)} star_observation`,
      "anchor-owner/tool repo_id 11 crawl_document", "anchor-owner/tool repo_id 21 evidence_source",
    ]);
    const first = backfill(["--execute", "--span", "2"]);
    expect(first.status, first.stderr).toBe(0);
    expect([first.source("crawl")?.added, first.source("evidence")?.added, first.source("stars")?.added]).toEqual([3, 1, 1]);
    expect(first.done).toMatchObject({ mode: "execute", anchorRows: 5, anchorRepos: 2 });
    expect(await anchors()).toEqual(expected);
    const [crawled] = await db.select().from(repositoryIdentityAnchors).where(and(eq(repositoryIdentityAnchors.kind, "repo_id"), eq(repositoryIdentityAnchors.value, "11")));
    expect([crawled.firstSeenAt.getTime(), crawled.lastSeenAt.getTime()]).toEqual([fetchedAt.getTime(), fetchedAt.getTime()]);

    const versions = await anchorVersions();
    const second = backfill(["--execute"]);
    expect(second.status, second.stderr).toBe(0);
    expect([second.source("crawl")?.added, second.source("evidence")?.added, second.source("stars")?.added]).toEqual([0, 0, 0]);
    expect(await anchorVersions()).toEqual(versions);
    expect(backfill([]).events.filter((event) => event.event === "source").map((event) => event.missing)).toEqual([0, 0, 0]);
  });

  it("묶음 수를 정해 멈추고, 찍힌 커서에서 이어 한다", async () => {
    await db.insert(crawlDocuments).values(Array.from({ length: 6 }, (_, index) => document(`anchor-owner/r${index}`, { id: 100 + index })));
    await clearRepositoryIdentityAnchors();
    const ids = (await db.select({ id: crawlDocuments.id }).from(crawlDocuments).orderBy(asc(crawlDocuments.id))).map((row) => row.id);

    const part = backfill(["--execute", "--only", "crawl", "--from", String(ids[0] - 1), "--span", "2", "--max-batches", "1"]);
    expect(part.status, part.stderr).toBe(0);
    expect(part.source("crawl")).toMatchObject({ complete: false, cursor: ids[0] + 1, added: 2 });
    expect(await anchors()).toHaveLength(2);

    const rest = backfill(["--execute", "--only", "crawl", "--from", String(part.source("crawl")!.cursor), "--span", "2"]);
    expect(rest.source("crawl")).toMatchObject({ complete: true, added: 4 });
    expect(await anchors()).toHaveLength(6);

    const refused = backfill(["--from", "3"]);
    expect(refused.status).toBe(2);
  });

  it("--no-crawl-node-id 는 수집 원본의 숫자 id 만 옮긴다 — node id 는 원본에 남아 있다가 덮일 때 트리거가 남긴다", async () => {
    await db.insert(crawlDocuments).values(document("anchor-owner/tool", meta(11)));
    await clearRepositoryIdentityAnchors();
    const run = backfill(["--execute", "--no-crawl-node-id"]);
    expect(run.status, run.stderr).toBe(0);
    expect(await anchors()).toEqual(["anchor-owner/tool repo_id 11 crawl_document"]);

    await putDocument(document("anchor-owner/tool", meta(22)));
    expect(await anchors()).toEqual(sorted([
      `anchor-owner/tool node_id ${nodeIdOf(11)} crawl_document`, `anchor-owner/tool node_id ${nodeIdOf(22)} crawl_document`,
      "anchor-owner/tool repo_id 11 crawl_document", "anchor-owner/tool repo_id 22 crawl_document",
    ]));
  });
});
