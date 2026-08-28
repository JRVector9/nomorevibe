import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const repo = await import("@/lib/domain/products/repository");
const { markClaimInvited } = await import("@/lib/domain/products/claim-invite");
const { ensureSchema, resetTables } = await import("./setup");

async function product(slug: string, over: { source?: "skill" | "crawler"; claimedAt?: Date | null } = {}) {
  await repo.insert({
    slug,
    url: `https://${slug}.test`,
    name: slug,
    tagline: "소개",
    description: "설명",
    category: "Dev",
    stack: [],
    status: over.source === "skill" ? "verified" : "seeded",
    source: over.source ?? "crawler",
    claimedAt: over.claimedAt ?? null,
    repoUrl: `https://github.com/someone/${slug}`,
    verifyToken: `nmv_verify_${slug}`,
    editTokenHash: "x".repeat(64),
  });
}

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

describe("초대 보냄 기록", () => {
  it("주인이 없는 제품에 시각을 남기고, 다시 표시해도 처음 시각을 지킨다", async () => {
    await product("found");

    const first = await markClaimInvited("found");
    expect(first.ok).toBe(true);
    const again = await markClaimInvited("found");
    expect(again.ok && again.value.invitedAt.getTime()).toBe(first.ok && first.value.invitedAt.getTime());

    expect((await repo.findBySlug("found"))?.claimInvitedAt).toBeInstanceOf(Date);
  });

  it("주인이 있는 제품에는 표시하지 않는다", async () => {
    await product("mine", { source: "skill" });
    await product("taken", { claimedAt: new Date() });

    for (const slug of ["mine", "taken"]) {
      const result = await markClaimInvited(slug);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("forbidden");
    }
    expect((await markClaimInvited("nobody")).ok).toBe(false);
  });
});
