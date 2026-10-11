import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { githubStarOperations, githubStarOperationReceipts } from "@/lib/db/github-star-schema";
import { githubUserConnections } from "@/lib/db/github-user-schema";
import { disconnectGithubUser, saveGithubUserConnection } from "@/lib/domain/github-user/repository";
import { ensureSchema, resetTables } from "./setup";

async function service() {
  const loaded = await import("@/lib/domain/github-stars/service").catch(() => null);
  expect(loaded, "personal star service is missing").not.toBeNull();
  return loaded!;
}
let userId: number;
let productId: number;
let starred: boolean;
let repositoryId: number;
let token: string;
let csrfToken: string;
const upstreamWrites: { method: string; path: string }[] = [];
let repoName: string;
const metadata = () => ({ id: repositoryId, owner: { login: "example" }, name: repoName, full_name: `example/${repoName}`, html_url: `https://github.com/example/${repoName}`, private: false, archived: false, has_issues: true });
const upstream = async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  const method = init?.method ?? "GET";
  if (path.startsWith("/repos/") || path.startsWith("/repositories/")) return Response.json(metadata());
  if (path === "/user/starred/example/project") {
    if (method === "GET") return new Response(null, { status: starred ? 204 : 404 });
    upstreamWrites.push({ method, path });
    starred = method === "PUT";
    return new Response(null, { status: 204 });
  }
  throw new Error("unexpected mocked endpoint");
};
beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true"); vi.stubEnv("GITHUB_STAR_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", "integration-public-auth-secret-longer-than-32-characters");
  vi.stubEnv("GITHUB_INTEGRATION_SECRET", "integration-github-secret-longer-than-32-characters");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.example");
  vi.stubEnv("GITHUB_STAR_APP_CLIENT_ID", "Iv1.integration-star-id"); vi.stubEnv("GITHUB_STAR_APP_CLIENT_SECRET", "integration-star-secret");
  await resetTables();
  const user = await saveGithubUserConnection({ actorUserId: null, githubUser: { id: 101, login: "reader" }, tokens: { accessToken: `ghu_${"a".repeat(40)}`, refreshToken: `ghr_${"b".repeat(40)}`, accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 7_200_000) } });
  userId = user.user.id; token = user.token; csrfToken = user.csrfToken;
  const [product] = await db.insert(products).values({ slug: "star-project", url: "https://project.example", name: "Star Project", tagline: "A test project", description: "Test", category: "other", status: "verified", verifyToken: "star-project-test-token", editTokenHash: "star-project-test-hash", repoUrl: "https://github.com/example/project", stars: 100 }).returning();
  productId = product.id;
  starred = false; repositoryId = 1_000; repoName = "project"; upstreamWrites.length = 0;
  vi.stubGlobal("fetch", vi.fn(upstream));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function view() { return (await service()).getGithubStarStatus("star-project", userId); }
async function write(desired: boolean, expectedRevision: number, operationId = randomUUID()) { return (await service()).writeGithubStar("star-project", userId, { starred: desired, expectedRevision, operationId }); }

describe("personal star operations through primary PostgreSQL and mocked GitHub", () => {
  it("observes existing remote state and adds/cancels the actual user star without editing public totals", async () => {
    const initial = await view();
    expect(initial.state).toBe("unstarred");
    const added = await write(true, initial.revision);
    expect(added.state).toBe("starred"); expect(starred).toBe(true);
    const removed = await write(false, added.revision);
    expect(removed.state).toBe("unstarred"); expect(starred).toBe(false);
    expect(upstreamWrites.map((entry) => entry.method)).toEqual(["PUT", "DELETE"]);
    expect((await db.select().from(products))[0].stars).toBe(100);
  });
  it("makes an already-starred desired state a no-op", async () => {
    starred = true;
    const initial = await view();
    expect(initial.state).toBe("starred");
    expect((await write(true, initial.revision)).state).toBe("starred");
    expect(upstreamWrites).toEqual([]);
  });
  it("returns saved operation receipts even after later writes, and rejects same-ID different intent", async () => {
    const initial = await view(); const id = randomUUID();
    const first = await write(true, initial.revision, id);
    const second = await write(false, first.revision);
    expect(await write(true, initial.revision, id)).toEqual(first);
    expect(starred).toBe(false);
    expect(second.revision).toBeGreaterThan(first.revision);
    await expect(write(false, initial.revision, id)).rejects.toMatchObject({ status: 409, code: "star_operation_conflict" });
    expect(upstreamWrites).toHaveLength(2);
    expect(await db.select().from(githubStarOperationReceipts)).toHaveLength(2);
  });
  it("rejects stale revisions and stale intent after a product changes repositories", async () => {
    const initial = await view();
    const written = await write(true, initial.revision);
    await expect(write(false, initial.revision)).rejects.toMatchObject({ status: 409, code: "star_revision_conflict" });
    await db.update(products).set({ repoUrl: "https://github.com/example/replacement" }).where(eq(products.id, productId));
    repositoryId = 2_000; repoName = "replacement";
    await expect(write(false, written.revision)).rejects.toMatchObject({ status: 409, code: "star_revision_conflict" });
    expect(upstreamWrites).toHaveLength(1);
  });
  it("allows one of two simultaneous tabs to dispatch and rejects the opposite operation during flight", async () => {
    const initial = await view();
    let release!: () => void; let announce!: () => void;
    const dispatched = new Promise<void>((resolve) => { announce = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (init?.method === "PUT") { announce(); await new Promise<void>((resolve) => { release = resolve; }); }
      return upstream(input, init);
    }));
    const first = write(true, initial.revision);
    await dispatched;
    await expect(write(false, initial.revision)).rejects.toMatchObject({ status: 409, code: "star_operation_in_progress" });
    const pending = await view();
    expect(pending.pending).toBe(true);
    release(); const complete = await first;
    expect(complete.revision).toBeGreaterThan(pending.revision);
    expect(upstreamWrites).toHaveLength(1);
  });
  it("preserves the uncertain dispatch fence even when a delayed read matches its desired state", async () => {
    const initial = await view();
    vi.stubGlobal("fetch", vi.fn(async (input, init) => { if (init?.method === "PUT") throw new Error("private-token-error"); return upstream(input, init); }));
    const result = await write(true, initial.revision);
    expect(result.state).toBe("unknown");
    await expect(write(false, result.revision)).rejects.toMatchObject({ status: 409, code: "star_result_uncertain" });
    expect((await view()).state).toBe("unknown");
    await db.update(githubStarOperations).set({ reconcileAfter: new Date(Date.now() - 1_000) });
    // Seeing the opposite state does not prove a timed-out PUT can never complete.
    expect((await view()).state).toBe("unknown");
    starred = true;
    expect((await view()).state).toBe("unknown");
    await expect(write(false, result.revision)).rejects.toMatchObject({ code: "star_result_uncertain" });
  });
  it("fences an expired lease against a late successful upstream response", async () => {
    const initial = await view();
    let release!: () => void; let announce!: () => void;
    const dispatched = new Promise<void>((resolve) => { announce = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input, init) => { if (init?.method === "PUT") { announce(); await new Promise<void>((resolve) => { release = resolve; }); } return upstream(input, init); }));
    const first = write(true, initial.revision);
    await dispatched;
    await db.update(githubStarOperations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) });
    await expect(write(false, initial.revision)).rejects.toMatchObject({ code: "star_result_uncertain" });
    release(); expect((await first).state).toBe("unknown");
    expect((await db.select().from(githubStarOperations))[0].state).toBe("unknown");
  });
  it("marks 401 credentials for reconnect and does not display a successful star", async () => {
    const initial = await view();
    vi.stubGlobal("fetch", vi.fn(async (input, init) => { if (init?.method === "PUT") return new Response(null, { status: 401 }); return upstream(input, init); }));
    const result = await write(true, initial.revision);
    expect(result.state).toBe("needs_reconnect");
    expect((await db.select().from(githubUserConnections))[0].state).toBe("needs_reconnect");
  });
  it("uses only the product repository and handles a confirmed upstream rate limit without fake success", async () => {
    const initial = await view();
    vi.stubGlobal("fetch", vi.fn(async (input, init) => { if (init?.method === "PUT") return new Response(null, { status: 429, headers: { "retry-after": "60" } }); return upstream(input, init); }));
    const operationId = randomUUID();
    await expect(write(true, initial.revision, operationId)).rejects.toMatchObject({ status: 429, code: "star_rate_limited" });
    await expect(write(true, initial.revision, operationId)).rejects.toMatchObject({ status: 429, code: "star_rate_limited" });
    expect(starred).toBe(false);
  });
  it.each([429, 403])("returns provider rate limits (%i) as private HTTP 429 with Retry-After and a persisted failed receipt", async (providerStatus) => {
    const route = await import("@/app/api/products/[slug]/github-star/route");
    const initial = await view(); const operationId = randomUUID(); let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (init?.method === "PUT") { attempts++; return new Response(null, { status: providerStatus, headers: { "retry-after": "60" } }); }
      return upstream(input, init);
    }));
    for (let retry = 0; retry < 2; retry++) {
      const response = await route.PUT(new Request("https://nomorevibe.example/api/products/star-project/github-star", { method: "PUT", headers: { "content-type": "application/json", origin: "https://nomorevibe.example", cookie: `nmv_user=${token}`, "x-csrf-token": csrfToken }, body: JSON.stringify({ starred: true, expectedRevision: initial.revision, operationId }) }), { params: Promise.resolve({ slug: "star-project" }) });
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({ error: "star_rate_limited", star: { state: "unstarred" } });
    }
    expect(attempts).toBe(1);
  });
  it.each([429, 403])("preserves the retry deadline when repository resolution is rate limited (%i)", async (providerStatus) => {
    const route = await import("@/app/api/products/[slug]/github-star/route");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: providerStatus, headers: { "retry-after": "60" } })));
    const response = await route.GET(new Request("https://nomorevibe.example/api/products/star-project/github-star", { headers: { cookie: `nmv_user=${token}` } }), { params: Promise.resolve({ slug: "star-project" }) });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ error: "star_rate_limited" });
    expect(upstreamWrites).toEqual([]);
  });
  it.each([{ status: 429, uncertain: false }, { status: 403, uncertain: false }, { status: 429, uncertain: true }, { status: 403, uncertain: true }])("returns a proven observation rate limit ($status) without losing state or uncertainty ($uncertain)", async ({ status, uncertain }) => {
    const route = await import("@/app/api/products/[slug]/github-star/route");
    const initial = await view();
    if (uncertain) {
      vi.stubGlobal("fetch", vi.fn(async (input, init) => {
        if (init?.method === "PUT") throw new Error("ambiguous write");
        return upstream(input, init);
      }));
      await write(true, initial.revision);
      await db.update(githubStarOperations).set({ reconcileAfter: new Date(Date.now() - 1_000) });
    }
    const [before] = await db.select().from(githubStarOperations);
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (new URL(String(input)).pathname.startsWith("/user/starred/")) return new Response(null, { status, headers: { "retry-after": "60" } });
      return upstream(input, init);
    }));
    const response = await route.GET(new Request("https://nomorevibe.example/api/products/star-project/github-star", { headers: { cookie: `nmv_user=${token}` } }), { params: Promise.resolve({ slug: "star-project" }) });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ error: "star_rate_limited" });
    const [after] = await db.select().from(githubStarOperations);
    expect(after).toMatchObject({ state: before.state, revision: before.revision, desiredStarred: before.desiredStarred, operationId: before.operationId });
  });
  it("rejects banned, private, unsupported or missing products before dispatch", async () => {
    await db.update(products).set({ status: "banned" });
    await expect(view()).rejects.toMatchObject({ status: 403 });
    await db.update(products).set({ status: "verified", repoUrl: "https://evil.example/example/project" });
    await expect(view()).rejects.toMatchObject({ status: 400 });
    await db.update(products).set({ repoUrl: "https://github.com/example/project" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...metadata(), private: true })));
    await expect(view()).rejects.toMatchObject({ status: 403 });
    await expect((await service()).getGithubStarStatus("missing", userId)).rejects.toMatchObject({ status: 404 });
    expect(upstreamWrites).toEqual([]);
  });
  it("requires a connected credential and enforces the shared 30-per-minute user limit", async () => {
    await expect((await service()).getGithubStarStatus("star-project", 999)).rejects.toMatchObject({ code: "github_not_connected" });
    const initial = await view();
    await db.execute(sql`insert into rate_limits (key, count, reset_at) values (${`github-star:${userId}`}, 30, now() + interval '1 minute')`);
    await expect(write(true, initial.revision)).rejects.toMatchObject({ status: 429, code: "star_rate_limited" });
    expect(upstreamWrites).toEqual([]);
  });
  it("rejects mismatched initial repository metadata and refuses to dispatch after an unknown read", async () => {
    repoName = "other";
    await expect(view()).rejects.toMatchObject({ code: "star_repository_changed" });
    repoName = "project";
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (new URL(String(input)).pathname.startsWith("/user/starred/") && (init?.method ?? "GET") === "GET") throw new Error("read unavailable");
      return upstream(input, init);
    }));
    const result = await view();
    expect(result.state).toBe("unknown");
    await expect(write(true, result.revision)).rejects.toMatchObject({ code: "star_state_unknown" });
    expect(upstreamWrites).toEqual([]);
  });
  it("follows a renamed repository only through a persisted numeric identity", async () => {
    const initial = await view();
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname; seen.push(path);
      if (path === "/repos/example/project") return new Response(null, { status: 301, headers: { location: "https://evil.example/leak" } });
      if (path === "/repositories/1000") return Response.json({ ...metadata(), name: "renamed", full_name: "example/renamed", html_url: "https://github.com/example/renamed" });
      if (path === "/user/starred/example/renamed") {
        if ((init?.method ?? "GET") === "GET") return new Response(null, { status: 404 });
        upstreamWrites.push({ method: init!.method!, path }); return new Response(null, { status: 204 });
      }
      throw new Error("unexpected renamed endpoint");
    }));
    expect((await write(true, initial.revision)).state).toBe("starred");
    expect(seen).toContain("/repositories/1000");
    expect(upstreamWrites).toEqual([{ method: "PUT", path: "/user/starred/example/renamed" }]);
  });
  it("requires the public session, exact origin and CSRF for writes and keeps responses private", async () => {
    const route = await import("@/app/api/products/[slug]/github-star/route");
    const url = "https://nomorevibe.example/api/products/star-project/github-star";
    const context = { params: Promise.resolve({ slug: "star-project" }) };
    expect((await route.GET(new Request(url), context)).status).toBe(401);
    const initialResponse = await route.GET(new Request(url, { headers: { cookie: `nmv_user=${token}` } }), context);
    expect(initialResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(initialResponse.headers.get("vary")).toBe("Cookie");
    const initial = await initialResponse.json();
    const body = JSON.stringify({ starred: true, operationId: randomUUID(), expectedRevision: initial.revision });
    const validHeaders = { "content-type": "application/json", origin: "https://nomorevibe.example", cookie: `nmv_user=${token}`, "x-csrf-token": csrfToken };
    for (const headers of [{ ...validHeaders, origin: "https://evil.example" }, { ...validHeaders, "x-csrf-token": "forged" }, { ...validHeaders, cookie: "nmv_admin=unrelated" }]) {
      const response = await route.PUT(new Request(url, { method: "PUT", headers, body }), context);
      expect([401, 403]).toContain(response.status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(upstreamWrites).toEqual([]);
    const response = await route.PUT(new Request(url, { method: "PUT", headers: validHeaders, body }), context);
    expect(response.status).toBe(200); expect((await response.json()).state).toBe("starred");
  });
  it("retains a fence when GitHub succeeds but persisting the result fails", async () => {
    const repository = await import("@/lib/domain/github-stars/repository");
    const initial = await view();
    const failure = vi.spyOn(repository, "settleStarWrite").mockRejectedValueOnce(new Error("private persistence failure"));
    try {
      await expect(write(true, initial.revision)).rejects.toMatchObject({ status: 503, code: "star_result_uncertain" });
      expect(starred).toBe(true);
      const [stored] = await db.select().from(githubStarOperations);
      expect(stored.leaseOwner).not.toBeNull();
      await expect(write(false, stored.revision)).rejects.toMatchObject({ code: "star_operation_in_progress" });
      expect(upstreamWrites).toHaveLength(1);
    } finally { failure.mockRestore(); }
  });
  it("does not dispatch a saved credential after the connection is revoked during metadata lookup", async () => {
    const initial = await view();
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (new URL(String(input)).pathname.startsWith("/repos/")) await disconnectGithubUser(userId);
      return upstream(input, init);
    }));
    await expect(write(true, initial.revision)).rejects.toMatchObject({ code: "github_needs_reconnect" });
    expect(upstreamWrites).toEqual([]);
    expect((await db.select().from(githubStarOperations))[0].leaseOwner).toBeNull();
  });
  it("advances revision when a product returns to a previously observed repository", async () => {
    const original = await view();
    await db.update(products).set({ repoUrl: "https://github.com/example/replacement" });
    repositoryId = 2000; repoName = "replacement";
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (new URL(String(input)).pathname === "/user/starred/example/replacement") return new Response(null, { status: 404 });
      return upstream(input, init);
    }));
    const replacement = await view();
    expect(replacement.revision).toBeGreaterThan(original.revision);
    await db.update(products).set({ repoUrl: "https://github.com/example/project" });
    repositoryId = 1000; repoName = "project";
    const returned = await view();
    expect(returned.revision).toBeGreaterThan(replacement.revision);
    expect(returned.repositoryId).toBe(original.repositoryId);
    expect((await write(true, returned.revision)).state).toBe("starred");
  });
  it("checks the captured numeric GitHub identity inside the dispatch claim", async () => {
    const credentials = await import("@/lib/domain/github-user/credentials");
    const initial = await view();
    const captured = await credentials.getGithubUserCredential(userId);
    const changed = vi.spyOn(credentials, "getGithubUserCredential").mockResolvedValueOnce({ ...captured, githubUserId: 999 });
    try {
      await expect(write(true, initial.revision)).rejects.toMatchObject({ code: "github_needs_reconnect" });
      expect(upstreamWrites).toEqual([]);
      expect((await db.select().from(githubStarOperationReceipts))).toHaveLength(0);
    } finally { changed.mockRestore(); }
  });
  it.each([false, true])("replays a completed receipt without provider access and enforces local snapshot conflicts (failed=$boolean)", async (failed) => {
    const route = await import("@/app/api/products/[slug]/github-star/route");
    const initial = await view();
    const input = { starred: true, expectedRevision: initial.revision, operationId: randomUUID() };
    const request = (body = input) => new Request("https://nomorevibe.example/api/products/star-project/github-star", { method: "PUT", headers: { "content-type": "application/json", origin: "https://nomorevibe.example", cookie: `nmv_user=${token}`, "x-csrf-token": csrfToken }, body: JSON.stringify(body) });
    const context = { params: Promise.resolve({ slug: "star-project" }) };
    if (failed) vi.stubGlobal("fetch", vi.fn(async (input, init) => init?.method === "PUT" ? new Response(null, { status: 429, headers: { "retry-after": "60" } }) : upstream(input, init)));
    const first = await route.PUT(request(), context);
    const originalBody = await first.json();
    expect(first.status).toBe(failed ? 429 : 200);
    const unavailable = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", unavailable);
    const replay = await route.PUT(request(), context);
    expect(replay.status).toBe(first.status);
    expect(await replay.json()).toEqual(originalBody);
    if (failed) expect(Number(replay.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(unavailable).not.toHaveBeenCalled();
    expect((await route.PUT(request({ ...input, starred: false }), context)).status).toBe(409);
    await db.update(products).set({ repoUrl: "https://github.com/example/replacement" });
    expect((await route.PUT(request(), context)).status).toBe(409);
    expect(unavailable).not.toHaveBeenCalled();
    expect(JSON.stringify(originalBody)).not.toContain("productRepoUrl");
  });
});
