import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { GET } from "@/app/api/products/[slug]/route";
import { db } from "@/lib/db";
import { runtimeSettings } from "@/lib/db/operations-schema";
import * as repo from "@/lib/domain/products/repository";
import { ensureSchema, resetTables } from "./setup";

/**
 * 공개 제품 API가 무엇을 내보내는가.
 *
 * 이 응답은 익명 호출자에게 그대로 나간다. 전에는 토큰 둘만 빼고 행 전체를 내보냈고,
 * products에 컬럼이 늘 때마다 기본이 공개였다 — 운영자가 누구에게 언제 클레임 초대를
 * 보냈는지(claim_invited_at)가 그렇게 새어 나갔다. 그래서 나가는 필드 목록 자체를 잰다.
 */

/**
 * 공개 응답에 있어야 하는 필드 — 스킬의 클레임 확인이 이것을 보고 있다.
 * 2026-11-14 외부 수집 방지: 우리 화면은 이 JSON 을 부르지 않으므로 스킬이 보여 주는 이름·소개까지만 남겼다
 * 2026-11-16: 모든 세션·관문 모드에서 원래 주소 제외, 주인 없는 제품의 주소 일치 때만 verify 공개.
 */
const PUBLIC_FIELDS = [
  "slug",
  "name",
  "tagline",
  "category",
  "status",
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

async function get(slug: string, candidate?: string) {
  // 스킬은 curl 에 자기 이름을 싣는다(skill/SKILL.md) — 이름 없는 curl 은 공개 읽기 관문이 거절한다
  const response = await GET(new Request(`https://nomorevibe.test/api/products/${slug}${candidate === undefined ? "" : `?url=${encodeURIComponent(candidate)}`}`, { headers: { "user-agent": "nomorevibe-skill/1" } }), {
    params: Promise.resolve({ slug }),
  } as never);
  return { response, status: response.status, body: (await response.json()) as Record<string, unknown> };
}

let previousSettings: typeof runtimeSettings.$inferSelect | undefined;
beforeAll(async () => {
  ensureSchema();
  [previousSettings] = await db.select().from(runtimeSettings);
});
afterAll(async () => {
  await db.delete(runtimeSettings);
  if (previousSettings) await db.insert(runtimeSettings).values(previousSettings);
});
beforeEach(async () => {
  await resetTables();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.test");
  vi.stubEnv("TURNSTILE_SITE_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/products/<slug> — 밖으로 나가는 것", () => {
  describe.each(["unconfigured", "enforce without session"])("%s", mode => {
    beforeEach(async () => {
      if (mode === "enforce without session") {
        vi.stubEnv("TURNSTILE_SITE_KEY", "test-only-site-key");
        vi.stubEnv("TURNSTILE_SECRET_KEY", "test-only-turnstile-secret");
        vi.stubEnv("PUBLIC_API_SESSION_SECRET", "test-only-signing-secret");
        await db.insert(runtimeSettings).values({ id: 1, updatedBy: "product-api-privacy-test", values: { version: 1, publicApi: { mode: "enforce" } } })
          .onConflictDoUpdate({ target: runtimeSettings.id, set: { values: { version: 1, publicApi: { mode: "enforce" } } } });
      }
    });

    it.each([
      [undefined, undefined], ["http://www.found-app.test/?tracking=1#section", true],
      ["https://github.com/someone/found-app/", true], ["https://different.test", false],
      ["javascript:alert(1)", false], ["", false],
    ] as const)("주인 없는 제품 주소 %s — 일치할 때만 verify 공개", async (candidate, matches) => {
      await seeded();
      const { status, body, response } = await get("found-app", candidate);
      expect(status).toBe(200);
      expect(body).toMatchObject({ slug: "found-app", name: "FoundApp", status: "seeded", claimable: true });
      expect(body.matches).toBe(matches);
      expect(Object.keys(body).sort()).toEqual([
        ...PUBLIC_FIELDS, "claimable", matches ? "verify" : "message",
        ...(candidate === undefined ? [] : ["matches"]),
      ].sort());
      expect(body).not.toHaveProperty("url");
      expect(body).not.toHaveProperty("repoUrl");
      if (matches) {
        expect(body.verify).toMatchObject({
          file: { path: "/.well-known/nomorevibe.txt", content: "nmv_verify_found-app" },
        });
        expect(body).not.toHaveProperty("message");
      } else {
        expect(body).not.toHaveProperty("verify");
        expect(body.message).toBe("최신 스킬(https://nomorevibe.test/skill.md)로 ?url=<내 주소>를 붙여 다시 확인하세요.");
        expect(JSON.stringify(body)).not.toContain("nmv_verify_found-app");
      }
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    });

    it.each([undefined, "https://mine.test", "https://different.test"])("주인 있는 제품은 주소 %s에도 클레임 필드 없음", async candidate => {
      await seeded("mine");
      const product = await repo.findBySlug("mine");
      await repo.update(product!.id, { source: "skill", status: "verified", verifiedAt: new Date() });
      const { body } = await get("mine", candidate);
      expect(Object.keys(body).sort()).toEqual([
        ...PUBLIC_FIELDS, ...(candidate === undefined ? [] : ["matches"]),
      ].sort());
      for (const key of ["claimable", "verify", "message", "url"]) expect(body).not.toHaveProperty(key);
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
    expect(Object.keys(body).sort()).toEqual([...PUBLIC_FIELDS, "claimable", "message"].sort());
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
