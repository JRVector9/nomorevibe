import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllMemos } from "@/lib/cache/memo";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { csrfForToken, newPublicSession } from "@/lib/domain/accounts/session";
import { analyticsUserId } from "@/lib/analytics/identity";
import { ensureSchema, resetTables } from "./setup";

/**
 * 써봤어요 쓰기의 서버 사실 이벤트(reaction_add, PR C) — 실제 DB. 처음 남긴 평가만 보내고, 바꾸기는 보내지 않는다.
 * 응답 JSON 은 그대로다(outcome 은 싣지 않는다). GA 로는 아무것도 나가지 않는다(fetch 는 가짜).
 */
vi.mock("server-only", () => ({}));

const ORIGIN = "https://nomorevibe.example";
const VISITOR = "0b6f4a1e-7d1c-4a55-9f0e-2c3d4e5f6a7b";
const GA = "_ga=GA1.1.1234567890.1760000000";
const USER_SECRET = "integration-analytics-user-id-secret-32";
const collect = vi.fn(async () => new Response(null, { status: 204 }));

const reactions = () => import("@/app/api/products/[slug]/reactions/route");
async function put(body: Record<string, unknown>, cookie: string, extra: Record<string, string> = {}) {
  const route = await reactions();
  return route.PUT(new Request(`${ORIGIN}/api/products/try-tool/reactions`, {
    method: "PUT", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: ORIGIN, "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15", cookie, ...extra },
  }), { params: Promise.resolve({ slug: "try-tool" }) });
}
const events = () => collect.mock.calls.map((call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
const write = { tags: [], comment: null, source: "panel", device: "desktop", locale: "ko" };

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("PRODUCT_REACTIONS_ENABLED", "true");
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", "integration-public-auth-secret-at-least-32-characters");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  vi.stubEnv("VISITOR_HASH_SECRET", "integration-visitor-hash-secret-32-characters");
  vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
  vi.stubEnv("GA_MEASUREMENT_ID", "G-TEST123");
  vi.stubEnv("GA_API_SECRET", "test-api-secret_ABC");
  vi.stubEnv("ANALYTICS_USER_ID_SECRET", USER_SECRET);
  collect.mockClear();
  vi.stubGlobal("fetch", collect);
  clearAllMemos();
  await resetTables();
  await db.insert(products).values({ slug: "try-tool", name: "Tool", url: "https://try-tool.example", tagline: "Try", description: "Try",
    category: "Dev", status: "verified", verifyToken: "v-try-tool", editTokenHash: "e".repeat(64) });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("reaction_add", () => {
  it("익명 브라우저의 첫 평가만 보내고, 바꾸기·같은 값은 보내지 않는다 — 응답은 그대로", async () => {
    const first = await put({ verdict: "good", ...write }, `nmv_visitor=${VISITOR}; ${GA}`);
    expect(first.status).toBe(200);
    expect(Object.keys(await first.json()).sort()).toEqual(["mine", "signedIn", "summary"]);
    expect((await put({ verdict: "bad", ...write }, `nmv_visitor=${VISITOR}; ${GA}`)).status).toBe(200);
    expect((await put({ verdict: "bad", ...write }, `nmv_visitor=${VISITOR}; ${GA}`)).status).toBe(200);
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    expect(events()).toEqual([expect.objectContaining({
      client_id: "1234567890.1760000000",
      events: [{ name: "reaction_add", params: { product_slug: "try-tool", verdict: "good", reaction_source: "panel", signed_in: "no", id_source: "ga_cookie" } }],
    })]);
    expect(events()[0]).not.toHaveProperty("user_id");
  });

  it("로그인한 사람은 가명 user_id 와 함께, 분석 쿠키가 없으면 보내지 않는다", async () => {
    const [user] = await db.insert(publicUsers).values({ displayName: "써본 사람" }).returning();
    const session = newPublicSession();
    await db.insert(publicSessions).values({ userId: user.id, tokenHash: session.tokenHash, createdAt: session.createdAt, expiresAt: session.expiresAt });
    const csrf = { "x-csrf-token": csrfForToken(session.token, "session") };

    expect((await put({ verdict: "meh", ...write }, `nmv_user=${session.token}; ${GA}`, csrf)).status).toBe(200);
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    expect(events()[0]).toMatchObject({ user_id: analyticsUserId(user.id, USER_SECRET), events: [{ name: "reaction_add", params: { signed_in: "yes" } }] });
    expect(JSON.stringify(events()[0])).not.toContain(session.token);

    await db.insert(products).values({ slug: "other-tool", name: "Other", url: "https://other-tool.example", tagline: "Try", description: "Try",
      category: "Dev", status: "verified", verifyToken: "v-other-tool", editTokenHash: "f".repeat(64) });
    const route = await reactions();
    const response = await route.PUT(new Request(`${ORIGIN}/api/products/other-tool/reactions`, {
      method: "PUT", body: JSON.stringify({ verdict: "good", ...write }),
      headers: { "content-type": "application/json", origin: ORIGIN, "user-agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15", cookie: `nmv_user=${session.token}`, ...csrf },
    }), { params: Promise.resolve({ slug: "other-tool" }) });
    expect(response.status).toBe(200);
    expect(collect).toHaveBeenCalledTimes(1);
  });
});
