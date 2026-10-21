import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, clickEvents, productEvidenceAudit, productEvidenceSources, products, productStarObservationRuns, productStarObservations,
  rateLimits } from "@/lib/db/schema";
import { makerReplies, notifications, productMakerMembers, productReactions, userSavedProducts } from "@/lib/db/me-schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { publicIdentities, publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { githubUserConnections } from "@/lib/db/github-user-schema";
import { csrfForToken, newPublicSession } from "@/lib/domain/accounts/session";
import { crawlDocuments } from "@/lib/db/schema";
import { clearAllMemos } from "@/lib/cache/memo";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

const claimsRoute = await import("@/app/api/maker/claims/route");
const foundRoute = await import("@/app/api/me/maker/found-repos/route");
const repliesRoute = await import("@/app/api/me/maker/replies/route");
const introRoute = await import("@/app/api/me/maker/intro/route");
const { makerInbox, makerPendingReplies, makerProjects } = await import("@/lib/me/maker");
const { notifyNewListingMine, recheckMakerMemberships } = await import("@/lib/me/maker-claims");

const ORIGIN = "https://nomorevibe.example";
const GITHUB_ID = 4810;

/** GitHub API 응답 — 경로(/repos/owner/repo, /repositories/id)마다 */
type Upstream = { status: number; body?: unknown; location?: string };
let upstream: Record<string, Upstream>;
let githubCalls: string[];
const repo = (id: number, owner: { id: number; login: string; type: string }, name: string, extra: Record<string, unknown> = {}) => ({
  status: 200, body: { id, name, full_name: `${owner.login}/${name}`, html_url: `https://github.com/${owner.login}/${name}`, private: false, owner, ...extra },
});
const hanul = { id: GITHUB_ID, login: "hanul", type: "User" };

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", "integration-public-auth-secret-at-least-32-characters");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  // 수집기 자격 — 환경 토큰 하나(lib/crawl/github-accounts.ts)
  vi.stubEnv("GITHUB_TOKEN", "integration-collector-token");
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", "");
  vi.stubEnv("PRODUCT_REACTIONS_ENABLED", "true");
  await resetTables();
  await db.delete(crawlDocuments).where(sql`lower(${crawlDocuments.repo}) like 'hanul/%' or lower(${crawlDocuments.repo}) like 'old-hanul/%' or lower(${crawlDocuments.repo}) like 'alice/%'`);
  await db.execute(sql`TRUNCATE product_star_observation_runs, product_star_observations RESTART IDENTITY CASCADE`);
  clearAllMemos();
  upstream = {};
  githubCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.github.com") throw new Error(`unexpected fetch ${url.href}`);
    githubCalls.push(url.pathname);
    const answer = upstream[url.pathname] ?? { status: 404, body: { message: "Not Found" } };
    if (answer.location) return new Response(null, { status: answer.status, headers: { location: answer.location } });
    return Response.json(answer.body ?? {}, { status: answer.status });
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function account(options: { githubId?: number | null; login?: string | null; connectionLogin?: string } = {}) {
  const [user] = await db.insert(publicUsers).values({ displayName: `사용자-${Math.random().toString(16).slice(2, 8)}` }).returning();
  const githubId = options.githubId === undefined ? GITHUB_ID : options.githubId;
  if (githubId !== null) {
    await db.insert(publicIdentities).values({ userId: user.id, provider: "github", subject: String(githubId), providerLogin: options.login === undefined ? "Hanul" : options.login });
    if (options.connectionLogin) {
      await db.insert(githubUserConnections).values({ userId: user.id, githubUserId: githubId, githubLogin: options.connectionLogin, state: "active" });
    }
  } else {
    await db.insert(publicIdentities).values({ userId: user.id, provider: "email", subject: `${user.id}@example.test` });
  }
  const session = newPublicSession();
  await db.insert(publicSessions).values({ userId: user.id, tokenHash: session.tokenHash, createdAt: session.createdAt, expiresAt: session.expiresAt });
  return { user, token: session.token, csrf: csrfForToken(session.token, "session") };
}

async function product(slug: string, repoUrl: string | null, values: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({ slug, name: slug, url: `https://${slug}.example`, tagline: `${slug} 소개`, description: `${slug} 설명`,
    category: "Other", status: "seeded", source: "crawler", builder: "Claude Code", repoUrl, verifyToken: `v-${slug}`, editTokenHash: "e".repeat(64), ...values }).returning();
  return row;
}

/** 사실 수집이 이 제품 저장소에서 본 숫자 id — 운영자 확인이 맞춰 보는 «전에 본 저장소» */
async function seen(row: { slug: string; repoUrl: string | null }, repositoryId: number) {
  const key = row.repoUrl!.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$|\/$/g, "").toLowerCase();
  await db.insert(productEvidenceSources).values({ slug: row.slug, kind: "repository", provider: "github", sourceKey: key,
    normalizedFacts: { type: "github_repository", repositoryKey: key, repositoryId } });
}

type Session = Awaited<ReturnType<typeof account>>;
function request(path: string, method: string, session: Session | null, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: {
    ...(body === undefined ? {} : { "content-type": "application/json" }), origin: ORIGIN,
    ...(session ? { cookie: `nmv_user=${session.token}`, "x-csrf-token": session.csrf } : {}), ...headers,
  } });
}
async function claim(session: Session, body: unknown, headers: Record<string, string> = {}) {
  const response = await claimsRoute.POST(request("/api/maker/claims", "POST", session, body, headers));
  return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() as { results?: { productId: number; result: string; repo: string | null }[]; error?: string } };
}

describe("POST /api/maker/claims — GitHub 저장소 주인 확인", () => {
  it("개인 저장소 주인이면 owner 로 확인한다 — 제품의 claimed_at·builder·상태는 그대로(도메인 검증의 수정 키 발급을 막지 않는다)", async () => {
    const session = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    await seen(tiny, 11);
    upstream["/repos/hanul/tiny-cron"] = repo(11, hanul, "tiny-cron");
    const result = await claim(session, { productIds: [tiny.id] });
    expect(result.status).toBe(200);
    expect(result.cache).toBe("private, no-store");
    expect(result.body.results).toEqual([{ productId: tiny.id, slug: "tiny-cron", name: "tiny-cron", repo: "hanul/tiny-cron", result: "verified" }]);
    const [member] = await db.select().from(productMakerMembers);
    expect(member).toMatchObject({ productId: tiny.id, userId: session.user.id, role: "owner", method: "github_repo_owner", githubUserId: GITHUB_ID, revokedAt: null });
    expect(member.recheckAt!.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const [stored] = await db.select().from(products).where(eq(products.id, tiny.id));
    expect(stored.claimedAt).toBeNull();
    expect(stored.builder).toBe("Claude Code");
    expect(stored.status).toBe("seeded");
  });

  it("같은 요청을 다시 보내면 GitHub 을 부르지 않고 already_verified (멱등)", async () => {
    const session = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    await seen(tiny, 11);
    upstream["/repos/hanul/tiny-cron"] = repo(11, hanul, "tiny-cron");
    await claim(session, { productIds: [tiny.id] });
    const calls = githubCalls.length;
    const again = await claim(session, { productIds: [tiny.id, tiny.id] });
    expect(again.body.results?.map((item) => item.result)).toEqual(["already_verified"]);
    expect(githubCalls.length).toBe(calls);
    expect(await db.select().from(productMakerMembers)).toHaveLength(1);
  });

  it("조직 저장소·주인 id 가 다른 저장소(이전)·없는 저장소(404)는 거절하고 아무것도 적지 않는다", async () => {
    const session = await account();
    const org = await product("org-tool", "https://github.com/acme/org-tool");
    const moved = await product("moved-tool", "https://github.com/hanul/moved-tool");
    const gone = await product("gone-tool", "https://github.com/hanul/gone-tool");
    const site = await product("site-only", null);
    upstream["/repos/acme/org-tool"] = repo(21, { id: GITHUB_ID, login: "acme", type: "Organization" }, "org-tool");
    upstream["/repos/hanul/moved-tool"] = { status: 301, location: "https://api.github.com/repositories/22" };
    upstream["/repositories/22"] = repo(22, { id: 999, login: "someone", type: "User" }, "moved-tool");
    const result = await claim(session, { productIds: [org.id, moved.id, gone.id, site.id, 987654] });
    expect(result.body.results?.map((item) => [item.productId, item.result])).toEqual([
      [org.id, "org_repo_not_supported_yet"], [moved.id, "owner_mismatch"], [gone.id, "repo_not_found"], [site.id, "no_github_repo"], [987654, "not_found"],
    ]);
    expect(await db.select().from(productMakerMembers)).toHaveLength(0);
    expect((await db.select().from(products).where(eq(products.id, org.id)))[0].claimedAt).toBeNull();
  });

  it("이름이 바뀐 계정 — 옛 주소를 GitHub 이 넘겨 주고 숫자 id 가 같으면 통과", async () => {
    const session = await account({ login: "old-hanul" });
    const renamed = await product("renamed", "https://github.com/old-hanul/renamed");
    // 수집 원본은 옛 이름으로 남아 있다 — 숫자 id 는 그대로
    await db.insert(crawlDocuments).values({ repo: "old-hanul/renamed", repoMeta: { id: 33, owner: { id: GITHUB_ID, type: "User" } } });
    upstream["/repos/old-hanul/renamed"] = { status: 301, location: "https://api.github.com/repositories/33" };
    upstream["/repositories/33"] = repo(33, { id: GITHUB_ID, login: "new-hanul", type: "User" }, "renamed");
    const result = await claim(session, { productIds: [renamed.id] });
    expect(result.body.results?.[0].result).toBe("verified");
  });

  it("주소로 찾기 — 대소문자를 가리지 않고 공개 제품을 찾는다. 없는 저장소는 404, 잘못된 주소는 400", async () => {
    const session = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    await seen(tiny, 11);
    upstream["/repos/hanul/tiny-cron"] = repo(11, hanul, "tiny-cron");
    const found = await claim(session, { repoUrl: "github.com/Hanul/Tiny-Cron" });
    expect(found.body.results).toEqual([expect.objectContaining({ productId: tiny.id, result: "verified" })]);
    expect(await claim(session, { repoUrl: "https://github.com/hanul/unlisted" })).toMatchObject({ status: 404, body: { error: "repo_not_listed" } });
    expect(await claim(session, { repoUrl: "https://gitlab.com/hanul/tiny-cron" })).toMatchObject({ status: 400, body: { error: "invalid_repo_url" } });
  });

  it("GitHub 로그인 신원이 없는 계정은 403, CSRF·Origin 이 틀리면 403, 로그인 없으면 401", async () => {
    const email = await account({ githubId: null });
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    expect(await claim(email, { productIds: [tiny.id] })).toMatchObject({ status: 403, body: { error: "github_login_required" } });
    const session = await account();
    expect(await claim(session, { productIds: [tiny.id] }, { "x-csrf-token": "f".repeat(64) })).toMatchObject({ status: 403, body: { error: "invalid_csrf" } });
    expect(await claim(session, { productIds: [tiny.id] }, { origin: "https://evil.example" })).toMatchObject({ status: 403, body: { error: "invalid_origin" } });
    const anonymous = await claimsRoute.POST(request("/api/maker/claims", "POST", null, { productIds: [tiny.id] }));
    expect(anonymous.status).toBe(401);
    expect(githubCalls).toEqual([]);
  });

  it("계정마다 시간당 12번까지 — 넘으면 429 이고 GitHub 을 부르지 않는다", async () => {
    const session = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    upstream["/repos/hanul/tiny-cron"] = repo(11, hanul, "tiny-cron");
    await db.insert(rateLimits).values({ key: `maker:claims:user:${session.user.id}`, count: 11, resetAt: sql`now() + interval '1 hour'` });
    expect((await claim(session, { productIds: [tiny.id] })).status).toBe(200);
    const calls = githubCalls.length;
    expect(await claim(session, { productIds: [tiny.id] })).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(githubCalls.length).toBe(calls);
  });

  it("GitHub 이 답하지 못하면(5xx) github_unavailable 로 두고 적지 않는다", async () => {
    const session = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    await seen(tiny, 11);
    upstream["/repos/hanul/tiny-cron"] = { status: 502, body: {} };
    expect((await claim(session, { productIds: [tiny.id] })).body.results?.[0].result).toBe("github_unavailable");
    expect(await db.select().from(productMakerMembers)).toHaveLength(0);
    // 답하지 못한 것은 담지 않는다 — 다시 누르면 다시 묻는다
    upstream["/repos/hanul/tiny-cron"] = repo(11, hanul, "tiny-cron");
    expect((await claim(session, { productIds: [tiny.id] })).body.results?.[0].result).toBe("verified");
  });

  it("저장소 주소가 바뀌면 그 제품의 GitHub 주인 확인을 같은 쓰기에서 푼다(repo_changed) — 다른 고치기·다른 제품은 그대로", async () => {
    const productsRepo = await import("@/lib/domain/products/repository");
    const session = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    const other = await product("other-tool", "https://github.com/hanul/other-tool");
    await seen(tiny, 11);
    await seen(other, 12);
    upstream["/repos/hanul/tiny-cron"] = repo(11, hanul, "tiny-cron");
    upstream["/repos/hanul/other-tool"] = repo(12, hanul, "other-tool");
    expect((await claim(session, { productIds: [tiny.id, other.id] })).body.results?.map((item) => item.result)).toEqual(["verified", "verified"]);
    await productsRepo.update(tiny.id, { tagline: "새 소개", repoUrl: "https://github.com/hanul/tiny-cron" });
    expect((await db.select().from(productMakerMembers).where(eq(productMakerMembers.productId, tiny.id)))[0]).toMatchObject({ revokedAt: null });
    await productsRepo.update(tiny.id, { repoUrl: "https://github.com/someone/else" });
    const rows = new Map((await db.select().from(productMakerMembers)).map((row) => [row.productId, row]));
    expect(rows.get(tiny.id)).toMatchObject({ revokedReason: "repo_changed" });
    expect(rows.get(tiny.id)!.revokedAt).not.toBeNull();
    expect(rows.get(other.id)).toMatchObject({ revokedAt: null, revokedReason: null });
    expect((await makerProjects(session.user.id)).map((row) => row.productId)).toEqual([other.id]);
  });

  it("수집 때 본 저장소 숫자 id 와 GitHub 의 답이 다르면(옛 이름을 차지해 새로 만든 저장소) repo_replaced", async () => {
    const session = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    const same = await product("same-id", "https://github.com/hanul/same-id");
    await db.insert(crawlDocuments).values([
      { repo: "Hanul/tiny-cron", repoMeta: { id: 11, owner: { id: 1, type: "User" } } },
      { repo: "hanul/same-id", repoMeta: { id: 12, owner: { id: 1, type: "User" } } },
    ]);
    upstream["/repos/hanul/tiny-cron"] = repo(99, hanul, "tiny-cron");
    upstream["/repos/hanul/same-id"] = repo(12, hanul, "same-id");
    const result = await claim(session, { productIds: [tiny.id, same.id] });
    expect(result.body.results?.map((item) => [item.productId, item.result])).toEqual([[tiny.id, "repo_replaced"], [same.id, "verified"]]);
    expect((await db.select().from(productMakerMembers)).map((row) => row.productId)).toEqual([same.id]);
  });

  it("전에 본 저장소 id 가 하나도 없으면(수집하지 않은 등록 제품) 이름 주인을 믿지 않는다 — 옛 이름을 차지한 계정이 운영자가 되지 못한다", async () => {
    // alice 가 등록한 제품(skill)은 수집 원본이 없다. alice 가 이름을 바꾸자 다른 사람이 alice 를 차지해 같은 이름의 저장소를 만들었다
    const squatter = await account({ githubId: 66601, login: "alice" });
    const tool = await product("alice-tool", "https://github.com/alice/tool", { source: "skill", status: "verified" });
    upstream["/repos/alice/tool"] = repo(990, { id: 66601, login: "alice", type: "User" }, "tool");
    const result = await claim(squatter, { productIds: [tool.id] });
    expect(result.body.results?.[0]).toMatchObject({ productId: tool.id, result: "repo_unverified" });
    expect(await db.select().from(productMakerMembers)).toEqual([]);
    expect((await introRoute.PUT(request("/api/me/maker/intro", "PUT", squatter, { productId: tool.id, tagline: "차지한 소개" }))).status).toBe(403);
    // 사실 수집이 등록 때의 저장소를 본 뒤에는 그 id 와 맞춘다 — 차지한 저장소는 다른 저장소다
    await seen(tool, 501);
    clearAllMemos();
    expect((await claim(squatter, { productIds: [tool.id] })).body.results?.[0].result).toBe("repo_replaced");
    expect(await db.select().from(productMakerMembers)).toEqual([]);
  });

  it("스타 관측의 node id 도 전에 본 저장소다 — 같은 저장소면 통과, 섞여 있으면(이름 차지 전후) 거절", async () => {
    const session = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron", { source: "skill" });
    const closedRun = async (endedAgoMs: number) => {
      const end = new Date(Date.now() - endedAgoMs);
      const [row] = await db.insert(productStarObservationRuns).values({ cycleAt: end, windowStartsAt: new Date(end.getTime() - 3_600_000), deadlineAt: end,
        status: "closed", policyVersion: "test", policy: {} as never }).returning();
      return row;
    };
    const run = await closedRun(3_600_000);
    const legacyNodeId = Buffer.from("010:Repository11").toString("base64");
    await db.insert(productStarObservations).values({ runId: run.id, productId: tiny.id, slug: tiny.slug, repoUrl: tiny.repoUrl!, repositoryKey: "hanul/tiny-cron",
      repositoryId: legacyNodeId, repoLinkVersion: 1, status: "ok", stars: 3, observedAt: new Date(), archived: false });
    upstream["/repos/hanul/tiny-cron"] = repo(11, hanul, "tiny-cron", { node_id: legacyNodeId });
    expect((await claim(session, { productIds: [tiny.id] })).body.results?.[0].result).toBe("verified");

    await db.delete(productMakerMembers);
    const later = await closedRun(60_000);
    await db.insert(productStarObservations).values({ runId: later.id, productId: tiny.id, slug: tiny.slug, repoUrl: tiny.repoUrl!, repositoryKey: "hanul/tiny-cron",
      repositoryId: "R_kgDOAAAAYw", repoLinkVersion: 1, status: "ok", stars: 0, observedAt: new Date(), archived: false });
    clearAllMemos();
    expect((await claim(session, { productIds: [tiny.id] })).body.results?.[0].result).toBe("repo_replaced");
  });

  it("하위 경로 주소의 제품은 저장소 주인이 확인하지 못한다 — 공용 저장소 한 폴더의 남의 앱", async () => {
    const alice = await account({ githubId: 66602, login: "alice" });
    const bobApp = await product("bob-app", "https://github.com/alice/hackathon/tree/main/teams/bob-app", { source: "skill" });
    await db.insert(crawlDocuments).values({ repo: "alice/hackathon", repoMeta: { id: 777, owner: { id: 66602, type: "User" } } });
    upstream["/repos/alice/hackathon"] = repo(777, { id: 66602, login: "alice", type: "User" }, "hackathon");
    expect((await claim(alice, { productIds: [bobApp.id] })).body.results?.[0].result).toBe("no_github_repo");
    expect(githubCalls).toEqual([]);
    expect(await db.select().from(productMakerMembers)).toEqual([]);
  });

  it("주소로 찾기 — ?·# 가 붙은 주소로 등록한 제품도 찾아 저장소로 읽지 않는다고 답한다(repo_not_listed 가 아니다)", async () => {
    const session = await account();
    const tool = await product("query-tool", "https://github.com/hanul/query-tool?tab=readme-ov-file", { source: "skill" });
    const found = await claim(session, { repoUrl: "github.com/hanul/query-tool" });
    expect(found.status).toBe(200);
    expect(found.body.results).toEqual([expect.objectContaining({ productId: tool.id, result: "no_github_repo" })]);
    expect(githubCalls).toEqual([]);
  });

  it("같은 저장소를 동시에 물으면 GitHub 부르기 하나를 나눠 쓴다 — 먼저 부른 사람이 요청을 끊어도 다른 사람은 답을 받는다", async () => {
    const { claimProducts } = await import("@/lib/me/maker-claims");
    const first = await account({ githubId: 7101, login: "first" });
    const owner = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    await seen(tiny, 11);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lookup = vi.fn(async (_ref: unknown, options: { signal?: AbortSignal } = {}) => {
      await gate;
      if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return { kind: "found" as const, fact: { ownerId: GITHUB_ID, ownerType: "User", private: false, repoId: 11 } };
    });
    const abort = new AbortController();
    const firstClaim = claimProducts(first.user.id, { productIds: [tiny.id] }, { lookup, signal: abort.signal });
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    const ownerClaim = claimProducts(owner.user.id, { productIds: [tiny.id] }, { lookup });
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    expect((await firstClaim)[0].result).toBe("github_unavailable");
    release();
    expect((await ownerClaim)[0].result).toBe("verified");
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  /** 감사 보류(0110)는 주인 없는 것에만 건다 — 운영자 확인으로 주인이 생기면 같은 세대 잠금 안에서 풀고, 카드도 공유할 수 있다 */
  it("감사 보류된 제품을 운영자로 확인하면 보류를 풀고 기록·지우기 줄을 남긴다 — 배지·공유 카드도 내준다", async () => {
    const session = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron", { auditHoldAt: new Date(), auditHoldItemId: 9 });
    await seen(tiny, 11);
    upstream["/repos/hanul/tiny-cron"] = repo(11, hanul, "tiny-cron");
    expect((await claim(session, { productIds: [tiny.id] })).body.results?.map((item) => item.result)).toEqual(["verified"]);
    const [after] = await db.select().from(products).where(eq(products.id, tiny.id));
    expect(after.auditHoldAt).toBeNull();
    const [release] = await db.select().from(productEvidenceAudit).where(and(eq(productEvidenceAudit.slug, "tiny-cron"),
      eq(productEvidenceAudit.action, "audit.hold.release")));
    expect(release).toMatchObject({ actor: `maker:${session.user.id}`, reason: "owned" });
    expect(await db.select({ slug: cdnPurges.slug, reason: cdnPurges.reason }).from(cdnPurges)).toEqual([{ slug: "tiny-cron", reason: "audit_release" }]);
    expect((await makerProjects(session.user.id))[0]).toMatchObject({ slug: "tiny-cron", shareable: true });
  });

  it("같은 저장소의 답(있음·없음)은 10분 담아 GitHub 을 다시 부르지 않는다", async () => {
    const first = await account();
    const second = await account({ githubId: 7002, login: "second" });
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    const gone = await product("gone-tool", "https://github.com/hanul/gone-tool");
    await seen(tiny, 11);
    upstream["/repos/hanul/tiny-cron"] = repo(11, hanul, "tiny-cron");
    expect((await claim(first, { productIds: [tiny.id, gone.id] })).body.results?.map((item) => item.result)).toEqual(["verified", "repo_not_found"]);
    expect(githubCalls).toEqual(["/repos/hanul/tiny-cron", "/repos/hanul/gone-tool"]);
    expect((await claim(second, { productIds: [tiny.id, gone.id] })).body.results?.map((item) => item.result)).toEqual(["owner_mismatch", "repo_not_found"]);
    expect(githubCalls).toHaveLength(2);
  });

  it("GitHub 을 실제로 부르는 수는 전체 시간당 300번·계정마다 40번 — 넘으면 github_unavailable 이고 부르지 않는다", async () => {
    const { CLAIM_LOOKUPS_PER_HOUR, CLAIM_LOOKUPS_PER_USER_HOUR } = await import("@/lib/me/maker-claims");
    const session = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    await seen(tiny, 11);
    upstream["/repos/hanul/tiny-cron"] = repo(11, hanul, "tiny-cron");
    const counts = async () => new Map((await db.select().from(rateLimits)).map((row) => [row.key, row.count]));
    await db.insert(rateLimits).values({ key: `maker:claims:github:user:${session.user.id}`, count: CLAIM_LOOKUPS_PER_USER_HOUR, resetAt: sql`now() + interval '1 hour'` });
    expect((await claim(session, { productIds: [tiny.id] })).body.results?.[0].result).toBe("github_unavailable");
    expect(githubCalls).toEqual([]);
    // 계정 한도에 걸린 요청은 전체 한도를 쓰지 않는다
    expect((await counts()).get("maker:claims:github")).toBeUndefined();
    await db.delete(rateLimits);
    await db.insert(rateLimits).values({ key: "maker:claims:github", count: CLAIM_LOOKUPS_PER_HOUR, resetAt: sql`now() + interval '1 hour'` });
    expect((await claim(session, { productIds: [tiny.id] })).body.results?.[0].result).toBe("github_unavailable");
    expect(githubCalls).toEqual([]);
    await db.delete(rateLimits);
    expect((await claim(session, { productIds: [tiny.id] })).body.results?.[0].result).toBe("verified");
    expect((await counts()).get("maker:claims:github")).toBe(1);
    expect((await counts()).get(`maker:claims:github:user:${session.user.id}`)).toBe(1);
  });
});

describe("GET /api/me/maker/found-repos — 내 저장소 찾기", () => {
  it("GitHub 이름(대소문자 무시)이 주인인 공개 제품 중 아직 확인하지 않은 것만", async () => {
    const session = await account({ login: "HANUL" });
    const mine = await product("mine", "https://github.com/hanul/mine");
    const claimed = await product("claimed", "https://github.com/Hanul/claimed");
    await product("banned", "https://github.com/hanul/banned", { status: "banned" });
    await product("other", "https://github.com/hanul-other/other");
    await product("moved-away", "https://github.com/hanul/moved-away", { repoRenamedTo: "acme/moved-away" });
    const movedIn = await product("moved-in", "https://github.com/old/moved-in", { repoRenamedTo: "Hanul/moved-in" });
    await db.insert(productMakerMembers).values({ productId: claimed.id, userId: session.user.id, role: "owner", method: "github_repo_owner", githubUserId: GITHUB_ID });
    const response = await foundRoute.GET(request("/api/me/maker/found-repos", "GET", session));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as { login: string; repos: { productId: number; repo: string }[] };
    expect(body.login).toBe("HANUL");
    expect(body.repos.map((item) => item.productId).sort()).toEqual([mine.id, movedIn.id].sort());
    expect(body.repos.find((item) => item.productId === movedIn.id)?.repo).toBe("Hanul/moved-in");
  });

  it("provider_login 이 없으면 스타 연결의 이름을 쓰고, 둘 다 없으면 빈 목록", async () => {
    const connected = await account({ login: null, connectionLogin: "hanul" });
    const mine = await product("mine", "https://github.com/hanul/mine");
    const body = await (await foundRoute.GET(request("/api/me/maker/found-repos", "GET", connected))).json() as { repos: { productId: number }[] };
    expect(body.repos.map((item) => item.productId)).toEqual([mine.id]);
    await db.delete(publicIdentities);
    const unknown = await account({ githubId: 5555, login: null });
    expect(await (await foundRoute.GET(request("/api/me/maker/found-repos", "GET", unknown))).json()).toEqual({ linked: true, login: null, repos: [] });
    expect((await foundRoute.GET(request("/api/me/maker/found-repos", "GET", null))).status).toBe(401);
  });
});

/** 운영자로 확인된 제품 하나와 그 제품에 들어온 공개 의견·한 줄 */
async function makerWithInbox() {
  const maker = await account();
  const author = await account({ githubId: 7001, login: "author" });
  const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron", { stars: 214 });
  await db.insert(productMakerMembers).values({ productId: tiny.id, userId: maker.user.id, role: "owner", method: "github_repo_owner", githubUserId: GITHUB_ID });
  const [feedback] = await db.insert(productFeedback).values({ productId: tiny.id, authorUserId: author.user.id, requestId: crypto.randomUUID(), requestHash: "a".repeat(64),
    normalizedBodyHash: "b".repeat(64), kind: "question", title: "시간대", body: "한국 시간으로 고를 수 있나요?", serviceDisclosureConsent: true, reviewState: "accepted" }).returning();
  await db.insert(productFeedback).values({ productId: tiny.id, authorUserId: author.user.id, requestId: crypto.randomUUID(), requestHash: "c".repeat(64),
    normalizedBodyHash: "d".repeat(64), kind: "bug", title: "보류", body: "보류된 글", serviceDisclosureConsent: true, reviewState: "held" });
  const [reaction] = await db.insert(productReactions).values({ productId: tiny.id, visitorHash: "1".repeat(64), verdict: "meh", comment: "마지막 금요일은 못 바꾸네요", commentState: "accepted",
    source: "panel", locale: "ko", triedVerified: true }).returning();
  await db.insert(productReactions).values([
    { productId: tiny.id, visitorHash: "2".repeat(64), verdict: "good", source: "panel", locale: "ko" },
    { productId: tiny.id, userId: author.user.id, verdict: "bad", source: "panel", locale: "ko", comment: "검토 중", commentState: "held" },
    { productId: tiny.id, visitorHash: "3".repeat(64), verdict: "good", source: "panel", locale: "ko", rankingExcluded: true },
  ]);
  await db.insert(userSavedProducts).values({ userId: author.user.id, productId: tiny.id });
  await db.insert(clickEvents).values([{ slug: "tiny-cron", occurredAt: new Date(Date.now() - 3_600_000) }, { slug: "tiny-cron", occurredAt: new Date(Date.now() - 7_200_000) },
    { slug: "tiny-cron", occurredAt: new Date(Date.now() - 9 * 86_400_000) }]);
  return { maker, author, tiny, feedback, reaction };
}

describe("내 프로젝트 탭 데이터", () => {
  it("확인한 프로젝트 카드 — 스타·7일 유효 방문·써본 사람과 평가 셋(랭킹 제외 행 빼고)·공개 의견·답장 기다림·저장", async () => {
    const { maker, tiny } = await makerWithInbox();
    const [card] = await makerProjects(maker.user.id);
    expect(card).toMatchObject({ productId: tiny.id, status: "public", role: "owner", method: "github_repo_owner", stars: 214, visits7d: 2,
      tried: 3, good: 1, meh: 1, bad: 1, feedback: 1, waiting: 2, saves: 1 });
    expect(await makerPendingReplies(maker.user.id)).toBe(2);
    const other = await account({ githubId: 9999, login: "nobody" });
    expect(await makerProjects(other.user.id)).toEqual([]);
    expect(await makerPendingReplies(other.user.id)).toBe(0);
  });

  it("받은 의견 — 공개된 의견과 한 줄만, 풀린 운영자에게는 보이지 않는다", async () => {
    const { maker, feedback, reaction } = await makerWithInbox();
    const inbox = await makerInbox(maker.user.id, { limit: 10, waitingFirst: true });
    expect(inbox).toMatchObject({ total: 2, waiting: 2 });
    expect(inbox.items.map((item) => [item.targetType, item.targetId]).sort()).toEqual([["feedback", feedback.id], ["reaction", reaction.id]].sort());
    expect(inbox.items.find((item) => item.targetType === "reaction")).toMatchObject({ verdict: "meh", triedVerified: true, authorName: null, reply: null });
    // 전체 보기는 쪽으로 넘긴다 — 둘째 쪽은 첫 쪽에 없던 것
    const [page1, page2] = [await makerInbox(maker.user.id, { limit: 1 }), await makerInbox(maker.user.id, { limit: 1, offset: 1 })];
    expect(page1.total).toBe(2);
    expect([page1.items[0].targetId, page2.items[0].targetId].sort()).toEqual([feedback.id, reaction.id].sort());
    await db.update(productMakerMembers).set({ revokedAt: new Date(), revokedReason: "owner_mismatch" });
    expect(await makerInbox(maker.user.id, { limit: 10 })).toMatchObject({ total: 0, waiting: 0, items: [] });
  });
});

describe("PUT /api/me/maker/replies — 메이커 답장", () => {
  async function reply(session: Session, body: unknown) {
    const response = await repliesRoute.PUT(request("/api/me/maker/replies", "PUT", session, body));
    return { status: response.status, body: await response.json() as { reply?: { id: string; reviewState: string; created: boolean }; error?: string } };
  }

  it("운영자는 답장을 쓰고 글쓴이에게 알림이 한 번 간다. 고치기는 알림을 다시 만들지 않는다", async () => {
    const { maker, author, feedback, tiny } = await makerWithInbox();
    const first = await reply(maker, { targetType: "feedback", targetId: feedback.id, body: "  다음 버전에 넣을게요.  " });
    expect(first.status).toBe(201);
    expect(first.body.reply).toMatchObject({ reviewState: "accepted", created: true });
    const [stored] = await db.select().from(makerReplies);
    expect(stored).toMatchObject({ productId: tiny.id, targetType: "feedback", targetId: feedback.id, authorUserId: maker.user.id, body: "다음 버전에 넣을게요." });
    expect(first.body.reply).toMatchObject({ notified: true });
    const sent = await db.select().from(notifications);
    expect(sent).toEqual([expect.objectContaining({ userId: author.user.id, kind: "maker_reply", productId: tiny.id, dedupeKey: `maker_reply:${stored.id}`,
      payload: expect.objectContaining({ name: "tiny-cron", excerpt: "다음 버전에 넣을게요.", feedbackId: feedback.id }) })]);

    const edited = await reply(maker, { targetType: "feedback", targetId: feedback.id, body: "다음 주 업데이트에 넣을게요." });
    expect(edited.status).toBe(200);
    expect(edited.body.reply).toMatchObject({ id: stored.id, created: false, notified: false });
    expect(await db.select().from(makerReplies)).toEqual([expect.objectContaining({ id: stored.id, body: "다음 주 업데이트에 넣을게요." })]);
    expect(await db.select().from(notifications)).toHaveLength(1);
    expect(await makerPendingReplies(maker.user.id)).toBe(1);
  });

  it("익명 한 줄에 답하면 알릴 계정이 없어 알림이 없고(notified=false), 받은 의견도 알림이 가지 않는다고 안다", async () => {
    const { maker, reaction } = await makerWithInbox();
    const inbox = await makerInbox(maker.user.id, { limit: 10 });
    expect(inbox.items.find((item) => item.targetType === "reaction")).toMatchObject({ notifiable: false, authorDeleted: false, authorName: null });
    expect(inbox.items.find((item) => item.targetType === "feedback")).toMatchObject({ notifiable: true, authorDeleted: false });
    const sent = await reply(maker, { targetType: "reaction", targetId: reaction.id, body: "고마워요" });
    expect(sent.body.reply).toMatchObject({ reviewState: "accepted", created: true, notified: false });
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("링크가 넷 이상인 답장은 받지 않는다(검토할 곳이 없다) — 예전에 보류된 답장은 답장 기다림으로 센다", async () => {
    const { maker, feedback, tiny } = await makerWithInbox();
    const links = "https://a.test https://b.test https://c.test https://d.test";
    expect(await reply(maker, { targetType: "feedback", targetId: feedback.id, body: `참고: ${links}` })).toMatchObject({ status: 400, body: { error: "reply_too_many_links" } });
    expect(await db.select().from(makerReplies)).toHaveLength(0);
    await db.insert(makerReplies).values({ productId: tiny.id, targetType: "feedback", targetId: feedback.id, authorUserId: maker.user.id, body: `옛 답장 ${links}`, reviewState: "held" });
    expect(await makerPendingReplies(maker.user.id)).toBe(2);
    const inbox = await makerInbox(maker.user.id, { limit: 10, waitingFirst: true });
    expect(inbox).toMatchObject({ total: 2, waiting: 2 });
    expect(inbox.items.find((item) => item.targetType === "feedback")?.reply).toMatchObject({ reviewState: "held" });
    // 고쳐 저장하면 공개되고 그때 글쓴이에게 알린다
    const fixed = await reply(maker, { targetType: "feedback", targetId: feedback.id, body: "링크를 줄였어요 https://a.test" });
    expect(fixed.body.reply).toMatchObject({ reviewState: "accepted", created: false, notified: true });
    expect(await makerPendingReplies(maker.user.id)).toBe(1);
  });

  it("답장 앞부분은 글자로 자른다 — 이모지가 경계에 걸려도 알림이 들어간다", async () => {
    const { maker, author, feedback } = await makerWithInbox();
    const body = `${"가".repeat(119)}🚀 다음 버전에 넣을게요`;
    expect((await reply(maker, { targetType: "feedback", targetId: feedback.id, body })).body.reply).toMatchObject({ notified: true });
    const [sent] = await db.select().from(notifications);
    expect(sent).toMatchObject({ userId: author.user.id, kind: "maker_reply" });
    expect(sent.payload.excerpt).toBe(`${"가".repeat(119)}🚀`);
  });

  it("탈퇴한 글쓴이의 의견은 «탈퇴한 사용자»로, 답해도 알림을 넣지 않는다", async () => {
    const { maker, author, feedback } = await makerWithInbox();
    await db.update(publicUsers).set({ deletedAt: new Date() }).where(eq(publicUsers.id, author.user.id));
    const inbox = await makerInbox(maker.user.id, { limit: 10 });
    expect(inbox.items.find((item) => item.targetType === "feedback")).toMatchObject({ authorName: null, authorDeleted: true, notifiable: false });
    expect((await reply(maker, { targetType: "feedback", targetId: feedback.id, body: "답장" })).body.reply).toMatchObject({ notified: false });
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("써봤어요를 끄면 한 줄은 받은 의견·숫자에서 빠지고 답할 수 없다", async () => {
    const { maker, reaction } = await makerWithInbox();
    vi.stubEnv("PRODUCT_REACTIONS_ENABLED", "false");
    expect(await makerInbox(maker.user.id, { limit: 10 })).toMatchObject({ total: 1, waiting: 1 });
    expect(await makerPendingReplies(maker.user.id)).toBe(1);
    expect((await makerProjects(maker.user.id))[0]).toMatchObject({ tried: 0, good: 0, meh: 0, bad: 0, waiting: 1 });
    expect(await reply(maker, { targetType: "reaction", targetId: reaction.id, body: "고마워요" })).toMatchObject({ status: 404, body: { error: "target_not_found" } });
  });

  it("운영자가 아니면 403, 풀린 운영자도 403, 공개되지 않은 대상은 404, 형식이 틀리면 400", async () => {
    const { maker, author, feedback } = await makerWithInbox();
    expect(await reply(author, { targetType: "feedback", targetId: feedback.id, body: "남의 제품" })).toMatchObject({ status: 403, body: { error: "not_a_member" } });
    const [held] = await db.select({ id: productFeedback.id }).from(productFeedback).where(eq(productFeedback.reviewState, "held"));
    expect(await reply(maker, { targetType: "feedback", targetId: held.id, body: "보류 글" })).toMatchObject({ status: 404, body: { error: "target_not_found" } });
    for (const body of [{ targetType: "feedback", targetId: feedback.id, body: " " }, { targetType: "feedback", targetId: feedback.id, body: "가".repeat(1001) },
      { targetType: "comment", targetId: feedback.id, body: "x" }, { targetType: "feedback", targetId: "not-a-uuid", body: "x" }]) {
      expect((await reply(maker, body)).status).toBe(400);
    }
    await db.update(productMakerMembers).set({ revokedAt: new Date(), revokedReason: "owner_mismatch" }).where(eq(productMakerMembers.userId, maker.user.id));
    expect((await reply(maker, { targetType: "feedback", targetId: feedback.id, body: "풀린 뒤" })).status).toBe(403);
    expect(await db.select().from(makerReplies)).toHaveLength(0);
  });
});

describe("PUT /api/me/maker/intro — 소개 고치기", () => {
  it("운영자는 수정 키 경로와 같은 쓰기로 바로 고치고(«AI가 요약» 표시를 뗀다), 아니면 403", async () => {
    const { maker, author, tiny } = await makerWithInbox();
    await db.update(products).set({ taglineSource: "ai_readme" }).where(eq(products.id, tiny.id));
    const put = (session: Session, body: unknown) => introRoute.PUT(request("/api/me/maker/intro", "PUT", session, body));
    const ok = await put(maker, { productId: tiny.id, tagline: "  자연어 일정을 cron 식으로  " });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ state: "applied" });
    const [stored] = await db.select().from(products).where(eq(products.id, tiny.id));
    expect(stored).toMatchObject({ tagline: "자연어 일정을 cron 식으로", taglineSource: "maker", description: "tiny-cron 설명" });
    expect((await put(author, { productId: tiny.id, tagline: "남의 소개" })).status).toBe(403);
    expect((await put(maker, { productId: tiny.id, tagline: "" })).status).toBe(400);
    expect((await put(maker, { productId: tiny.id, name: "이름은 안 됨" })).status).toBe(400);
    expect((await put(maker, { productId: 999999, tagline: "없는 제품" })).status).toBe(404);
  });
});

describe("재확인 잡 — recheckMakerMemberships", () => {
  it("날짜가 지난 행만 보고, 주인이 같으면 30일 뒤로·다르면(이전) 풀고·없으면 풀고·GitHub 이 답하지 못하면 6시간 뒤로", async () => {
    const maker = await account();
    const keep = await product("keep", "https://github.com/hanul/keep");
    const moved = await product("moved", "https://github.com/hanul/moved");
    const gone = await product("gone", "https://github.com/hanul/gone");
    const flaky = await product("flaky", "https://github.com/hanul/flaky");
    const later = await product("later", "https://github.com/hanul/later");
    const past = sql`now() - interval '1 day'`;
    for (const item of [keep, moved, gone, flaky]) {
      await db.insert(productMakerMembers).values({ productId: item.id, userId: maker.user.id, role: "owner", method: "github_repo_owner", githubUserId: GITHUB_ID, recheckAt: past });
    }
    await db.insert(productMakerMembers).values({ productId: later.id, userId: maker.user.id, role: "owner", method: "github_repo_owner", githubUserId: GITHUB_ID,
      recheckAt: sql`now() + interval '10 days'` });
    for (const [item, id] of [[keep, 1], [moved, 2], [gone, 3], [flaky, 4]] as const) await seen(item, id);
    upstream["/repos/hanul/keep"] = repo(1, hanul, "keep");
    upstream["/repos/hanul/moved"] = { status: 301, location: "https://api.github.com/repositories/2" };
    upstream["/repositories/2"] = repo(2, { id: 31337, login: "buyer", type: "User" }, "moved");
    upstream["/repos/hanul/flaky"] = { status: 503, body: {} };

    const summary = await recheckMakerMemberships({ deadlineAt: Date.now() + 20_000 });
    expect(summary).toEqual({ checked: 4, kept: 1, revoked: 2, deferred: 1 });
    expect(githubCalls).not.toContain("/repos/hanul/later");
    const rows = new Map((await db.select().from(productMakerMembers)).map((row) => [row.productId, row]));
    expect(rows.get(keep.id)).toMatchObject({ revokedAt: null });
    expect(rows.get(keep.id)!.recheckAt!.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(rows.get(moved.id)).toMatchObject({ revokedReason: "owner_mismatch" });
    expect(rows.get(moved.id)!.revokedAt).not.toBeNull();
    expect(rows.get(gone.id)).toMatchObject({ revokedReason: "repo_not_found" });
    expect(rows.get(flaky.id)).toMatchObject({ revokedAt: null });
    expect(rows.get(flaky.id)!.recheckAt!.getTime() - Date.now()).toBeGreaterThan(5 * 3_600_000);

    // 풀린 운영자는 답장할 수 없고 탭에서도 빠진다
    expect((await makerProjects(maker.user.id)).map((row) => row.productId).sort()).toEqual([flaky.id, keep.id, later.id].sort());
    // 날짜가 지난 행이 없으면 GitHub 을 부르지 않는다
    githubCalls = [];
    expect(await recheckMakerMemberships({ deadlineAt: Date.now() + 20_000 })).toEqual({ checked: 0, kept: 0, revoked: 0, deferred: 0 });
    expect(githubCalls).toEqual([]);
  });

  it("같은 이름에 다른 저장소가 생겼으면(repo_replaced), 맞춰 볼 저장소 id 가 없으면(repo_unverified), 하위 경로 주소면(repo_changed) 푼다", async () => {
    const maker = await account();
    const swapped = await product("swapped", "https://github.com/hanul/swapped");
    const unseen = await product("unseen", "https://github.com/hanul/unseen", { source: "skill" });
    const subpath = await product("subpath", "https://github.com/hanul/mono/tree/main/apps/x", { source: "skill" });
    for (const item of [swapped, unseen, subpath]) {
      await db.insert(productMakerMembers).values({ productId: item.id, userId: maker.user.id, role: "owner", method: "github_repo_owner", githubUserId: GITHUB_ID,
        recheckAt: sql`now() - interval '1 hour'` });
    }
    await seen(swapped, 50);
    // 주인 숫자 id 는 그대로지만 저장소 id 가 다르다 — 지우고 다시 만들었거나 옛 이름을 차지했다
    upstream["/repos/hanul/swapped"] = repo(51, hanul, "swapped");
    upstream["/repos/hanul/unseen"] = repo(52, hanul, "unseen");
    expect(await recheckMakerMemberships({ deadlineAt: Date.now() + 20_000 })).toEqual({ checked: 3, kept: 0, revoked: 3, deferred: 0 });
    const rows = new Map((await db.select().from(productMakerMembers)).map((row) => [row.productId, row]));
    expect(rows.get(swapped.id)).toMatchObject({ revokedReason: "repo_replaced" });
    expect(rows.get(unseen.id)).toMatchObject({ revokedReason: "repo_unverified" });
    expect(rows.get(subpath.id)).toMatchObject({ revokedReason: "repo_changed" });
    expect(githubCalls).not.toContain("/repos/hanul/mono");
  });

  it("GitHub 로그인 신원이 사라진 계정의 행은 GitHub 을 부르지 않고 푼다", async () => {
    const maker = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    await db.insert(productMakerMembers).values({ productId: tiny.id, userId: maker.user.id, role: "owner", method: "github_repo_owner", githubUserId: GITHUB_ID,
      recheckAt: sql`now() - interval '1 hour'` });
    await db.delete(publicIdentities).where(and(eq(publicIdentities.userId, maker.user.id), eq(publicIdentities.provider, "github")));
    expect(await recheckMakerMemberships({ deadlineAt: Date.now() + 20_000 })).toMatchObject({ revoked: 1 });
    expect((await db.select().from(productMakerMembers))[0]).toMatchObject({ revokedReason: "identity_removed" });
    expect(githubCalls).toEqual([]);
  });
});

describe("내 저장소 찾기·소개 검수와 운영자", () => {
  it("?·# 가 붙은 주소는 저장소로 읽지 않아 찾기 목록에 넣지 않는다(확인하면 no_github_repo 라서)", async () => {
    const session = await account({ login: "hanul" });
    const plain = await product("plain", "https://github.com/hanul/plain");
    await product("query", "https://github.com/hanul/query?tab=readme-ov-file");
    await product("hash", "https://github.com/hanul/hash#readme");
    const body = await (await foundRoute.GET(request("/api/me/maker/found-repos", "GET", session))).json() as { repos: { productId: number }[] };
    expect(body.repos.map((item) => item.productId)).toEqual([plain.id]);
  });

  it("GitHub 로 확인한 운영자가 있는 제품은 소개 검수가 다시 보지 않는다 — 운영자가 고친 짧은 소개를 AI 가 덮지 않는다", async () => {
    const { pendingIntroChecks } = await import("@/lib/domain/products/intro-checks");
    const maker = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    await db.insert(productMakerMembers).values({ productId: tiny.id, userId: maker.user.id, role: "owner", method: "github_repo_owner", githubUserId: GITHUB_ID });
    const put = await introRoute.PUT(request("/api/me/maker/intro", "PUT", maker, { productId: tiny.id, tagline: "cron 도우미" }));
    expect(put.status).toBe(200);
    expect((await db.select().from(products).where(eq(products.id, tiny.id)))[0]).toMatchObject({ tagline: "cron 도우미", taglineSource: "maker", claimedAt: null });
    expect((await pendingIntroChecks(50)).map((task) => task.product.id)).not.toContain(tiny.id);
    // 운영자 확인이 풀리면 다시 검수 대상이다
    await db.update(productMakerMembers).set({ revokedAt: new Date(), revokedReason: "owner_mismatch" });
    expect((await pendingIntroChecks(50)).map((task) => task.product.id)).toContain(tiny.id);
  });
});

describe("notify — 계정 한 명에게 알림", () => {
  it("탈퇴한 계정에는 넣지 않고, 같은 dedupe 는 한 번", async () => {
    const { notify } = await import("@/lib/me/notify");
    const live = await account();
    const gone = await account({ githubId: 7301, login: "gone" });
    await db.update(publicUsers).set({ deletedAt: new Date() }).where(eq(publicUsers.id, gone.user.id));
    expect(await notify({ userId: gone.user.id, kind: "maker_reply", dedupeKey: "maker_reply:x" })).toBe(false);
    expect(await notify({ userId: live.user.id, kind: "maker_reply", payload: { excerpt: "🚀" }, dedupeKey: "maker_reply:x" })).toBe(true);
    expect(await notify({ userId: live.user.id, kind: "maker_reply", dedupeKey: "maker_reply:x" })).toBe(false);
    expect(await db.select().from(notifications)).toEqual([expect.objectContaining({ userId: live.user.id, payload: { excerpt: "🚀" } })]);
  });
});

describe("새 등재 알림 — notifyNewListingMine", () => {
  it("저장소 주인 숫자 id 가 GitHub 로그인 계정이면 한 번만 알린다. 조직·모르는 계정은 알리지 않는다", async () => {
    const maker = await account();
    const tiny = await product("tiny-cron", "https://github.com/hanul/tiny-cron");
    const meta = { id: 11, full_name: "hanul/tiny-cron", owner: { id: GITHUB_ID, login: "hanul", type: "User" } };
    expect(await notifyNewListingMine({ slug: "tiny-cron", repoMeta: meta })).toBe(true);
    expect(await notifyNewListingMine({ slug: "tiny-cron", repoMeta: meta })).toBe(false);
    expect(await db.select().from(notifications)).toEqual([expect.objectContaining({ userId: maker.user.id, kind: "new_listing_mine", productId: tiny.id,
      dedupeKey: `new_listing_mine:${tiny.id}`, payload: { name: "tiny-cron", repo: "hanul/tiny-cron" } })]);
    await product("org-app", "https://github.com/acme/org-app");
    expect(await notifyNewListingMine({ slug: "org-app", repoMeta: { owner: { id: GITHUB_ID, type: "Organization" } } })).toBe(false);
    await product("stranger", "https://github.com/stranger/app");
    expect(await notifyNewListingMine({ slug: "stranger", repoMeta: { owner: { id: 123456, type: "User" } } })).toBe(false);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });
});
