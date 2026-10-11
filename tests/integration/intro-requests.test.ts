import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRepositoryObservations, agentRepositoryScans, cdnPurges, crawlCandidates, introCorrectionRequests, products,
  productSearchProfiles, takedownRequests } from "@/lib/db/schema";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";
import { indexableProduct, indexingFields, productIndexable } from "@/lib/domain/products/indexing";
import { fixIntroFromRequest, introRequestQueue, MAX_PENDING_PER_PRODUCT, pendingIntroRequestCount, requestIntroCorrection,
  resolveIntroRequest } from "@/lib/domain/products/intro-requests";
import { repoGoneField } from "@/lib/domain/products/repository";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

/**
 * 소개 수정 요청(UX-18, 0065) — 따로 된 표에 쌓이고, 내려달라는 요청과 달리 검색엔진 노출(noindex)과 CDN 지우기에
 * 아무 영향이 없다. 관리자가 고치면 소개가 바뀌고 그 제품의 대기 요청이 닫힌다.
 */

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(takedownRequests);
});

/** 주인 없는 수집 제품 — 루트 조사에 이름 있는 도구 흔적이 있어 색인된다(indexing.ts 4번) */
async function seeded(slug = "hwp-tool", values: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({
    slug, name: "HWP 도구", url: `https://github.com/acme/${slug}`, accessMode: "installable", tagline: "Web service for HWP",
    description: "Web service for HWP", category: "Dev", repoUrl: `https://github.com/acme/${slug}`, status: "seeded", source: "crawler",
    verifyToken: "v", editTokenHash: "e", createdAt: new Date("2026-09-01"), ...values,
  }).returning();
  await db.insert(crawlCandidates).values({ repo: `Acme/${slug}`, state: "published", publishedSlug: slug });
  const [scan] = await db.insert(agentRepositoryScans).values({
    githubRepositoryId: BigInt(1), repositoryKey: `acme/${slug}`, commitSha: "c".repeat(40), detectorVersion: "v",
    scopeHash: `${slug}-${Math.random()}`, state: "complete", completedAt: new Date("2026-09-02"),
  }).returning();
  await db.insert(agentRepositoryObservations).values({ scanId: scan.id, observationKey: "k0",
    facts: { kind: "instruction_file", client: "claude-code" } as AgentObservation });
  return row;
}

/** 상세(JS)와 sitemap(SQL) 두 판의 색인 판단 */
async function indexable(slug: string): Promise<{ detail: boolean; sitemap: boolean }> {
  const row = await db.query.products.findFirst({
    where: eq(products.slug, slug),
    columns: { status: true, source: true, claimedAt: true, accessMode: true, category: true },
    extras: { ...repoGoneField, ...indexingFields },
  });
  const listed = await db.select({ slug: products.slug }).from(products).where(indexableProduct);
  return { detail: productIndexable(row!), sitemap: listed.some((item) => item.slug === slug) };
}

describe("소개 수정 요청 받기", () => {
  it("요청마다 한 행으로 쌓고, 보낸이는 해시만 남긴다", async () => {
    const product = await seeded();
    expect(await requestIntroCorrection("hwp-tool", "  설치형 CLI 입니다. 웹 서비스가 아닙니다  ", "a".repeat(64))).toMatchObject({ ok: true });
    expect(await requestIntroCorrection("hwp-tool", "이름 뒤 설명도 틀렸습니다", null)).toMatchObject({ ok: true });

    const rows = await db.select().from(introCorrectionRequests).orderBy(introCorrectionRequests.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ productId: product.id, slug: "hwp-tool", message: "설치형 CLI 입니다. 웹 서비스가 아닙니다",
      requesterHash: "a".repeat(64), handledAt: null, outcome: null });
    expect(await pendingIntroRequestCount()).toBe(2);
  });

  it("처리 전 요청이 있어도 noindex 가 되지 않고 CDN 지우기를 적지 않으며, 내려달라는 요청 표도 비어 있다", async () => {
    await seeded();
    expect(await indexable("hwp-tool")).toEqual({ detail: true, sitemap: true });

    await requestIntroCorrection("hwp-tool", "설치형 CLI 입니다. 웹 서비스가 아닙니다");
    expect(await indexable("hwp-tool")).toEqual({ detail: true, sitemap: true });
    expect(await db.select().from(cdnPurges)).toEqual([]);
    expect(await db.select().from(takedownRequests)).toEqual([]);
  });

  it("글이 짧거나 길면, 없는 제품·내려간 제품이면, 주인이 있는 제품이면 받지 않는다", async () => {
    await seeded();
    await seeded("banned-tool", { status: "banned" });
    await seeded("owned-tool", { status: "verified", claimedAt: new Date("2026-09-05") });

    expect(await requestIntroCorrection("hwp-tool", "짧음")).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(await requestIntroCorrection("hwp-tool", "가".repeat(501))).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(await requestIntroCorrection("nope", "소개가 틀렸습니다")).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await requestIntroCorrection("banned-tool", "소개가 틀렸습니다")).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await requestIntroCorrection("owned-tool", "소개가 틀렸습니다")).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await db.select().from(introCorrectionRequests)).toEqual([]);
  });

  it(`한 제품에 처리 전 요청이 ${MAX_PENDING_PER_PRODUCT}건 쌓이면 더 받지 않는다 — 처리하면 다시 받는다`, async () => {
    const product = await seeded();
    await db.insert(introCorrectionRequests).values(Array.from({ length: MAX_PENDING_PER_PRODUCT }, (_, index) => ({
      productId: product.id, slug: "hwp-tool", message: `장난 ${index}`,
    })));
    expect(await requestIntroCorrection("hwp-tool", "소개가 틀렸습니다")).toMatchObject({ ok: false, error: { kind: "forbidden" } });

    const [first] = await db.select().from(introCorrectionRequests).limit(1);
    await resolveIntroRequest(first.id, "dismissed", "jr");
    expect(await requestIntroCorrection("hwp-tool", "소개가 틀렸습니다")).toMatchObject({ ok: true });
  });
});

describe("관리자 처리", () => {
  it("목록은 처리 전 요청에 지금 소개를 붙이고, 시각을 UTC ISO 로 준다", async () => {
    await seeded();
    const before = Date.now();
    await requestIntroCorrection("hwp-tool", "설치형 CLI 입니다", "b".repeat(64));
    const [entry] = await introRequestQueue();
    expect(entry).toMatchObject({ slug: "hwp-tool", message: "설치형 CLI 입니다", requesterHash: "b".repeat(64),
      product: { name: "HWP 도구", tagline: "Web service for HWP", status: "seeded" } });
    expect(Math.abs(Date.parse(entry.createdAt) - before)).toBeLessThan(60_000);
    expect(entry.ageHours).toBeLessThan(0.1);
  });

  it("처리함·둠은 한 번만 — 이미 처리한 요청은 null 이고 목록에서 빠진다", async () => {
    await seeded();
    await requestIntroCorrection("hwp-tool", "설치형 CLI 입니다");
    const [entry] = await introRequestQueue();
    expect(await resolveIntroRequest(entry.id, "dismissed", "jr", "맞는 소개")).toEqual({ id: entry.id, slug: "hwp-tool" });
    expect(await resolveIntroRequest(entry.id, "fixed", "jr")).toBeNull();
    const [row] = await db.select().from(introCorrectionRequests);
    expect(row).toMatchObject({ outcome: "dismissed", handledBy: "jr", note: "맞는 소개" });
    expect(row.handledAt).not.toBeNull();
    expect(await introRequestQueue()).toEqual([]);
    expect(await pendingIntroRequestCount()).toBe(0);
  });

  it("소개 고치기는 소개를 바꾸고(출처 editor, 같은 글이던 설명도) 검색 프로필을 지우며 그 제품의 대기 요청을 모두 닫는다", async () => {
    const product = await seeded();
    const other = await seeded("other-tool");
    await db.insert(productSearchProfiles).values({ productId: product.id, sourceHash: "h" });
    await requestIntroCorrection("hwp-tool", "설치형 CLI 입니다");
    await requestIntroCorrection("hwp-tool", "웹 서비스가 아닙니다");
    await requestIntroCorrection("other-tool", "다른 제품 요청입니다");
    const queue = await introRequestQueue();
    const mine = queue.filter((entry) => entry.slug === "hwp-tool").map((entry) => entry.id);

    const fixed = await fixIntroFromRequest(mine[0], "  HWP 파일을 다루는 설치형 CLI  ", "jr");
    expect(fixed).toEqual({ slug: "hwp-tool", before: "Web service for HWP", closed: mine });

    const [after] = await db.select().from(products).where(eq(products.id, product.id));
    expect(after).toMatchObject({ tagline: "HWP 파일을 다루는 설치형 CLI", taglineSource: "editor", description: "HWP 파일을 다루는 설치형 CLI",
      searchKeywords: null });
    expect(await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, product.id))).toEqual([]);
    expect((await introRequestQueue()).map((entry) => entry.slug)).toEqual(["other-tool"]);
    const closed = await db.select().from(introCorrectionRequests).where(eq(introCorrectionRequests.productId, product.id));
    expect(closed.every((row) => row.outcome === "fixed" && row.handledBy === "jr")).toBe(true);
    // 다른 제품은 그대로
    expect((await db.select().from(products).where(eq(products.id, other.id)))[0].tagline).toBe("Web service for HWP");
    // 고친 뒤에도 노출은 그대로, CDN 지우기도 없다
    expect(await indexable("hwp-tool")).toEqual({ detail: true, sitemap: true });
    expect(await db.select().from(cdnPurges)).toEqual([]);

    // 이미 닫힌 요청으로 다시 고치지 않는다
    expect(await fixIntroFromRequest(mine[1], "또 다른 소개", "jr")).toBeNull();
  });

  it("그 사이 주인이 생겼거나 내려간 제품, 빈 소개·너무 긴 소개는 고치지 않는다", async () => {
    await seeded();
    await seeded("gone-tool");
    await requestIntroCorrection("hwp-tool", "설치형 CLI 입니다");
    await requestIntroCorrection("gone-tool", "설치형 CLI 입니다");
    const [mine, gone] = await introRequestQueue();
    await db.update(products).set({ claimedAt: new Date(), status: "verified" }).where(eq(products.slug, "hwp-tool"));
    await db.update(products).set({ status: "banned" }).where(eq(products.slug, "gone-tool"));

    expect(await fixIntroFromRequest(mine.id, "새 소개", "jr")).toBeNull();
    expect(await fixIntroFromRequest(gone.id, "새 소개", "jr")).toBeNull();
    expect(await fixIntroFromRequest(gone.id, "   ", "jr")).toBeNull();
    expect(await fixIntroFromRequest(gone.id, "x".repeat(201), "jr")).toBeNull();
    expect(await pendingIntroRequestCount()).toBe(2);
  });

  it("제품을 지우면 요청도 함께 지워진다", async () => {
    await seeded();
    await requestIntroCorrection("hwp-tool", "설치형 CLI 입니다");
    await db.delete(products).where(eq(products.slug, "hwp-tool"));
    expect(await db.select().from(introCorrectionRequests)).toEqual([]);
  });
});
