import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { db } from "@/lib/db";
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments, products, takedownRequests } from "@/lib/db/schema";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";
import { requestTakedown } from "@/lib/domain/products/takedown";
import { generateMetadata } from "@/app/p/[slug]/page";
import { ensureSchema, resetTables } from "./setup";

/**
 * 상세 메타데이터의 robots(UX-08, C7) — 상세 페이지가 실제로 내는 값을 갈래마다 본다.
 * 규칙 자체(JS 판과 sitemap SQL 판이 같은지)는 product-indexing.test.ts 가 본다. 여기서는 페이지가 그 규칙에 이어졌는지다.
 */

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(takedownRequests);
});

async function product(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.example`, tagline: "Useful project", description: "Project tools", category: "Dev",
    repoUrl: `https://github.com/acme/${slug}`, status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", ...values,
  });
  if ((values.source ?? "crawler") === "crawler") {
    await db.insert(crawlCandidates).values({ repo: `acme/${slug}`, state: "published", publishedSlug: slug });
  }
}

/** 이름 있는 AI 도구 흔적이 남은 완료 루트 조사 */
async function evidence(slug: string) {
  const [scan] = await db.insert(agentRepositoryScans).values({
    githubRepositoryId: BigInt(1), repositoryKey: `acme/${slug}`, commitSha: "c".repeat(40), detectorVersion: "v",
    scopeHash: slug, state: "complete", completedAt: new Date("2026-09-02"),
  }).returning();
  await db.insert(agentRepositoryObservations).values({ scanId: scan.id, observationKey: "k", facts: { kind: "instruction_file", client: "claude-code" } as AgentObservation });
}

const metadata = (slug: string) => generateMetadata({ params: Promise.resolve({ slug }) });
const NOINDEX = { index: false, follow: false };

describe("상세 robots", () => {
  it("주인 있는 제품과 AI 근거가 확인된 미확인 제품은 색인하고, 근거가 없거나 개인 프로필이면 noindex", async () => {
    await product("owned", { status: "verified", source: "skill" });
    await product("seeded-evidence"); await evidence("seeded-evidence");
    await product("seeded-plain");
    await product("seeded-profile", { category: "Profile" }); await evidence("seeded-profile");

    const owned = await metadata("owned");
    expect(owned.robots).toBeUndefined();
    expect(owned.title).toBe("owned — nomorevibe");
    expect((await metadata("seeded-evidence")).robots).toBeUndefined();
    expect((await metadata("seeded-plain")).robots).toEqual(NOINDEX);
    expect((await metadata("seeded-profile")).robots).toEqual(NOINDEX);
  });

  it("저장소가 사라졌다고 확정된 미확인 제품은 noindex", async () => {
    await product("seeded-gone", { repoStatus: "not_found", repoMissingSince: new Date("2026-09-01"), repoCheckedAt: new Date("2026-09-03") });
    await evidence("seeded-gone");
    expect((await metadata("seeded-gone")).robots).toEqual(NOINDEX);
  });

  it("내려달라는 요청이 들어오는 즉시 noindex — 근거가 있어도", async () => {
    await product("asked"); await evidence("asked");
    // 메타데이터는 30초 읽기 캐시를 거친다 — 요청 전 값을 담아 두지 않게 요청부터 넣고 처음 읽는다
    await requestTakedown("asked", "내려 주세요", null, "owner");
    expect((await metadata("asked")).robots).toEqual(NOINDEX);
  });

  it("없는 제품은 메타데이터를 비운다(본문이 404 를 낸다)", async () => {
    expect(await metadata("nothing-here")).toEqual({});
  });
});
