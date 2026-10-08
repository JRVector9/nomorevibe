import { beforeAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments, products, takedownRequests } from "@/lib/db/schema";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";
import { indexableProduct, indexingFields, listIndexableSlugs, productIndexable } from "@/lib/domain/products/indexing";
import { repoGoneField } from "@/lib/domain/products/repository";
import { ensureSchema, resetTables } from "./setup";

/**
 * 색인 판단(UX-08, D1·D2) — 상세의 JS 판(productIndexable + indexingFields 로 읽은 행)과 sitemap 의 SQL 판(indexableProduct)이
 * 갈래마다 같은 답을 내는지. 하나만 고치면 sitemap 에 실린 주소가 noindex 를 낸다.
 */

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(takedownRequests);
});

let serial = 0;
async function product(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.example`, tagline: "Useful project", description: "Project tools", category: "Dev",
    repoUrl: `https://github.com/acme/${slug}`, status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e",
    createdAt: new Date(Date.UTC(2026, 8, 1) + ++serial * 60_000), ...values,
  });
  if ((values.source ?? "crawler") === "crawler") {
    await db.insert(crawlCandidates).values({ repo: `Acme/${slug}`, state: "published", publishedSlug: slug });
  }
}

/** 루트 조사 하나와 그 관찰 — client 가 null 이면 도구를 모르는 공유 형식(AGENTS.md 등)이다 */
async function scan(slug: string, clients: (string | null)[], values: Partial<typeof agentRepositoryScans.$inferInsert> = {}) {
  const [row] = await db.insert(agentRepositoryScans).values({
    githubRepositoryId: BigInt(1), repositoryKey: `acme/${slug}`, commitSha: "c".repeat(40), detectorVersion: "v",
    scopeHash: `${slug}-${Math.random()}`, state: "complete", completedAt: new Date("2026-09-02"), ...values,
  }).returning();
  for (const [index, client] of clients.entries()) {
    await db.insert(agentRepositoryObservations).values({ scanId: row.id, observationKey: `k${index}`, facts: { kind: "instruction_file", client } as AgentObservation });
  }
}

const takedown = (slug: string, handledAt: Date | null = null) =>
  db.insert(takedownRequests).values({ slug, handledAt, outcome: handledAt ? "dismissed" : null });

/** 하루 넘게 이어진 없음 — repository.ts repoGone */
const GONE = { repoStatus: "not_found" as const, repoMissingSince: new Date("2026-09-01"), repoCheckedAt: new Date("2026-09-03") };

/** 상세가 할 일 — 제품 행에 판정 값을 실어 읽고 JS 판으로 가른다 */
async function detailVerdict(slug: string): Promise<boolean> {
  const row = await db.query.products.findFirst({
    where: eq(products.slug, slug),
    columns: { status: true, source: true, claimedAt: true, accessMode: true, category: true },
    extras: { ...repoGoneField, ...indexingFields },
  });
  return productIndexable(row!);
}

async function sqlIndexable(): Promise<string[]> {
  const rows = await db.select({ slug: products.slug }).from(products).where(indexableProduct).orderBy(products.slug);
  return rows.map((row) => row.slug);
}

it("갈래마다 상세(JS)와 sitemap(SQL)이 같은 답을 낸다", async () => {
  const expected: Record<string, boolean> = {};
  const add = async (slug: string, indexable: boolean, values: Partial<typeof products.$inferInsert> = {}) => {
    await product(slug, values);
    expected[slug] = indexable;
  };

  // 주인 있는 제품 — 근거 없이도 색인
  await add("owned-skill", true, { status: "verified", source: "skill" });
  await add("owned-claimed", true, { status: "verified", claimedAt: new Date("2026-09-05") });
  await add("owned-profile", true, { status: "verified", source: "skill", category: "Profile" });

  // 주인 없는 제품 — 마지막 완료·부분 루트 조사에 이름 있는 도구 흔적이 있어야
  await add("seeded-evidence", true); await scan("seeded-evidence", ["claude-code"]);
  await add("seeded-partial", true); await scan("seeded-partial", ["codex"], { state: "partial" });
  await add("seeded-no-scan", false);
  await add("seeded-shared-format", false); await scan("seeded-shared-format", [null]);
  await add("seeded-latest-clean", false);
  await scan("seeded-latest-clean", ["claude-code"]);
  await scan("seeded-latest-clean", [], { completedAt: new Date("2026-09-03") });
  await add("seeded-latest-failed", true);
  await scan("seeded-latest-failed", ["claude-code"]);
  await scan("seeded-latest-failed", [], { state: "failed", completedAt: new Date("2026-09-03") });
  await add("seeded-subdir-only", false); await scan("seeded-subdir-only", ["claude-code"], { scope: "packages/web" });
  await add("seeded-profile", false, { category: "Profile" }); await scan("seeded-profile", ["claude-code"]);

  // 내려달라는 요청 — 처리 전이면 누구 것이든 빼고, 둠으로 처리되면 돌아온다
  await add("takedown-pending", false); await scan("takedown-pending", ["claude-code"]); await takedown("takedown-pending");
  await add("takedown-dismissed", true); await scan("takedown-dismissed", ["claude-code"]); await takedown("takedown-dismissed", new Date("2026-09-04"));
  await add("owned-takedown-pending", false, { status: "verified", source: "skill" }); await takedown("owned-takedown-pending");

  // 공개가 아님
  await add("banned", false, { status: "banned" }); await scan("banned", ["claude-code"]);
  await add("unverified", false, { status: "unverified", source: "skill" });

  // 저장소가 사라짐 — 설치형은 목록처럼 빼고, 주인 없는 웹사이트는 근거를 더 확인할 수 없어 뺀다
  await add("seeded-gone", false, GONE); await scan("seeded-gone", ["claude-code"]);
  await add("seeded-missing-today", true, { ...GONE, repoCheckedAt: new Date("2026-09-01T12:00:00Z") }); await scan("seeded-missing-today", ["claude-code"]);
  await add("seeded-installable", true, { accessMode: "installable" }); await scan("seeded-installable", ["claude-code"]);
  await add("owned-gone-website", true, { status: "verified", source: "skill", ...GONE });
  await add("owned-gone-installable", false, { status: "verified", source: "skill", accessMode: "installable", ...GONE });

  const fromDetail = Object.fromEntries(await Promise.all(Object.keys(expected).map(async (slug) => [slug, await detailVerdict(slug)] as const)));
  expect(fromDetail).toEqual(expected);
  const yes = Object.keys(expected).filter((slug) => expected[slug]).sort();
  expect(await sqlIndexable()).toEqual(yes);
  // sitemap 목록 — 같은 조건, 등재가 늦은 것부터, 상한을 지킨다
  const listed = await listIndexableSlugs(50_000);
  expect(listed.map((row) => row.slug).sort()).toEqual(yes);
  expect(listed[0].slug).toBe("owned-gone-website");
  expect(listed[0].updatedAt).toBeInstanceOf(Date);
  expect(await listIndexableSlugs(2)).toHaveLength(2);
});

it("별칭 후보 중 하나에만 근거가 있어도 근거로 친다", async () => {
  await product("aliased");
  await db.insert(crawlCandidates).values({ repo: "Acme/aliased-old", state: "published", publishedSlug: "aliased" });
  await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(2), repositoryKey: "acme/aliased-old", commitSha: "d".repeat(40),
    detectorVersion: "v", scopeHash: "alias", state: "complete", completedAt: new Date("2026-09-02") }).returning()
    .then(([row]) => db.insert(agentRepositoryObservations).values({ scanId: row.id, observationKey: "k", facts: { kind: "commit_attribution", client: "codex" } as AgentObservation }));
  expect(await detailVerdict("aliased")).toBe(true);
  expect(await sqlIndexable()).toEqual(["aliased"]);
});
