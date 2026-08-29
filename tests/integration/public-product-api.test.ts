import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { GET } from "@/app/api/products/[slug]/route";
import * as repo from "@/lib/domain/products/repository";
import { ensureSchema, resetTables } from "./setup";

/**
 * 공개 제품 API가 무엇을 내보내는가.
 *
 * 이 응답은 익명 호출자에게 그대로 나간다. 전에는 토큰 둘만 빼고 행 전체를 내보냈고,
 * products에 컬럼이 늘 때마다 기본이 공개였다 — 운영자가 누구에게 언제 클레임 초대를
 * 보냈는지(claim_invited_at)가 그렇게 새어 나갔다. 그래서 나가는 필드 목록 자체를 잰다.
 */

/** 공개 응답에 있어야 하는 필드 — 스킬과 밖의 호출자가 이것을 보고 있다 */
const PUBLIC_FIELDS = [
  "id",
  "slug",
  "url",
  "name",
  "tagline",
  "description",
  "category",
  "builder",
  "stack",
  "ogImage",
  "makerName",
  "repoUrl",
  "status",
  "source",
  "claimedAt",
  "verifyMethod",
  "verifiedAt",
  "createdAt",
  "updatedAt",
].sort();

async function seeded(slug = "found-app") {
  await repo.insert({
    slug,
    url: `https://${slug}.test`,
    name: "FoundApp",
    tagline: "수집된 소개",
    description: "공개 저장소에서 찾은 제품입니다.",
    category: "Other",
    stack: [],
    status: "seeded",
    source: "crawler",
    repoUrl: `https://github.com/someone/${slug}`,
    verifyToken: `nmv_verify_${slug}`,
    editTokenHash: "x".repeat(64),
  });
}

async function get(slug: string) {
  const response = await GET(new Request(`https://nomorevibe.test/api/products/${slug}`), {
    params: Promise.resolve({ slug }),
  } as never);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

describe("GET /api/products/<slug> — 밖으로 나가는 것", () => {
  it("주인이 없는 제품에는 클레임 안내를 붙여준다", async () => {
    await seeded();

    const { status, body } = await get("found-app");

    expect(status).toBe(200);
    // 스킬의 클레임 절이 이 둘을 보고 아직 주인이 없는 제품인지 판단한다
    expect(body.claimable).toBe(true);
    expect(body.verify).toMatchObject({
      file: { path: "/.well-known/nomorevibe.txt", content: "nmv_verify_found-app" },
    });
    expect(body).toMatchObject({
      slug: "found-app",
      name: "FoundApp",
      url: "https://found-app.test",
      status: "seeded",
      source: "crawler",
      repoUrl: "https://github.com/someone/found-app",
    });
  });

  it("허용 목록에 없는 것은 나가지 않는다 — 운영자가 언제 초대했는지도", async () => {
    await seeded();
    const product = await repo.findBySlug("found-app");
    await repo.update(product!.id, { claimInvitedAt: new Date() });

    const { body } = await get("found-app");

    // 값이 null이어도 키가 나가는 것 자체가 노출이다
    expect(Object.keys(body)).not.toContain("claimInvitedAt");
    expect(Object.keys(body)).not.toContain("editTokenHash");
    expect(Object.keys(body)).not.toContain("verifyToken");
    // 컬럼을 더해도 기본은 비공개다 — 새 필드는 여기 목록에 손대야 나간다
    expect(Object.keys(body).sort()).toEqual([...PUBLIC_FIELDS, "claimable", "verify"].sort());
  });

  it("주인이 있는 제품에는 검증 규약을 다시 주지 않는다", async () => {
    await seeded("mine");
    const product = await repo.findBySlug("mine");
    await repo.update(product!.id, { source: "skill", status: "verified", verifiedAt: new Date() });

    const { body } = await get("mine");

    expect(body.claimable).toBeUndefined();
    expect(body.verify).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(PUBLIC_FIELDS);
  });

  it("차단된 제품은 없는 것으로 답한다", async () => {
    await seeded("gone");
    const product = await repo.findBySlug("gone");
    await repo.update(product!.id, { status: "banned" });

    expect((await get("gone")).status).toBe(404);
  });
});
