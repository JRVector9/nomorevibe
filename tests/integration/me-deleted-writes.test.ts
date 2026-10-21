import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { productReactions, userFollows } from "@/lib/db/me-schema";
import { ensureSchema, resetTables } from "./setup";

/**
 * 탈퇴한 계정에 다시 줄을 만들지 않는다 — 세션 확인을 지난 요청이 탈퇴 뒤에 깨어나도 팔로·평가·평가 옮기기는 401 로 멈춘다
 * (저장은 tests/integration/me-saved.test.ts, 운영자 확인은 recordOwnerMembership 이 계정 행을 FOR SHARE 로 다시 본다).
 */
vi.mock("server-only", () => ({}));

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("VISITOR_HASH_SECRET", "deleted-writes-visitor-hash-secret-32chars");
  await resetTables();
});
afterEach(() => vi.unstubAllEnvs());

async function product(slug: string) {
  const [row] = await db.insert(products).values({ slug, name: slug, url: `https://${slug}.example`, tagline: slug, description: slug,
    category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e" }).returning();
  return row;
}
async function deletedUser() {
  const [user] = await db.insert(publicUsers).values({ displayName: "탈퇴한 사용자", deletedAt: sql`now()` }).returning();
  return user;
}

describe("탈퇴한 계정의 쓰기", () => {
  it("팔로는 401 로 멈추고 줄을 만들지 않는다", async () => {
    const { follow } = await import("@/lib/me/follows");
    const tool = await product("tool");
    const user = await deletedUser();
    await expect(follow(user.id, { targetType: "product", targetKey: String(tool.id) })).rejects.toMatchObject({ status: 401, code: "login_required" });
    expect(await db.select().from(userFollows).where(eq(userFollows.userId, user.id))).toEqual([]);
  });

  it("평가 쓰기와 이 브라우저 평가 옮기기는 401 로 멈추고 줄을 만들지 않는다", async () => {
    const { putReaction, mergeBrowserReactions } = await import("@/lib/domain/reactions/repository");
    await product("tool");
    const user = await deletedUser();
    await expect(putReaction("tool", { userId: user.id, visitor: null }, { verdict: "good", source: "panel", locale: "ko" } as never))
      .rejects.toMatchObject({ status: 401, code: "login_required" });
    await expect(mergeBrowserReactions(user.id, ["tool"], "visitor-deleted-writes")).rejects.toMatchObject({ status: 401, code: "login_required" });
    expect(await db.select().from(productReactions)).toEqual([]);
  });
});
