import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { publicIdentities, publicUsers } from "@/lib/db/public-user-schema";
import { githubAuthFlows, githubUserConnections } from "@/lib/db/github-user-schema";
import { ensureSchema, resetTables } from "./setup";

async function repository() {
  const loaded = await import("@/lib/domain/github-user/repository").catch(() => null);
  expect(loaded, "GitHub identity and flow transactions are missing").not.toBeNull();
  return loaded!;
}
async function credentials() {
  const loaded = await import("@/lib/domain/github-user/credentials").catch(() => null);
  expect(loaded, "GitHub refresh leasing is missing").not.toBeNull();
  return loaded!;
}
beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("GITHUB_STAR_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", "integration-public-auth-secret-longer-than-32-characters");
  vi.stubEnv("GITHUB_INTEGRATION_SECRET", "integration-github-secret-longer-than-32-characters");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.example");
  vi.stubEnv("GITHUB_STAR_APP_CLIENT_ID", "Iv1.integration-star-id");
  vi.stubEnv("GITHUB_STAR_APP_CLIENT_SECRET", "integration-star-client-secret");
  await resetTables();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const originalTokens = () => ({ accessToken: `ghu_${"a".repeat(40)}`, refreshToken: `ghr_${"b".repeat(40)}`, accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 7_200_000) });
const freshTokenResponse = () => ({ access_token: `ghu_${"c".repeat(40)}`, refresh_token: `ghr_${"d".repeat(40)}`, expires_in: 1_800, refresh_token_expires_in: 7_200, token_type: "bearer", scope: "" });
async function actor(name = "참여자-test") {
  const [user] = await db.insert(publicUsers).values({ displayName: name }).returning();
  return user;
}
async function connect(actorUserId: number | null = null, githubUserId = 101, expired = false) {
  const loaded = await repository();
  const tokens = originalTokens();
  if (expired) tokens.accessExpiresAt = new Date(Date.now() - 1_000);
  return loaded.saveGithubUserConnection({ actorUserId, githubUser: { id: githubUserId, login: `reader-${githubUserId}` }, tokens });
}

describe("GitHub user identity and refresh lifecycle with migrated PostgreSQL", () => {
  it("binds one-shot state to browser, actor, purpose and expiry while encrypting the PKCE verifier", async () => {
    const loaded = await repository();
    const user = await actor();
    const flow = await loaded.createGithubAuthFlow({ purpose: "star", actorUserId: user.id, returnTo: "/p/one" });
    const [stored] = await db.select().from(githubAuthFlows);
    expect(stored.stateHash).not.toBe(flow.state);
    expect(stored.browserNonceHash).not.toBe(flow.browserNonce);
    for (const input of [{ state: "forged" }, { browserNonce: "forged" }, { actorUserId: null }, { purpose: "maker" as const }]) {
      await expect(loaded.consumeGithubAuthFlow({ state: flow.state, browserNonce: flow.browserNonce, actorUserId: user.id, purpose: "star", ...input })).rejects.toMatchObject({ code: "invalid_github_flow" });
    }
    const consumed = await loaded.consumeGithubAuthFlow({ state: flow.state, browserNonce: flow.browserNonce, actorUserId: user.id, purpose: "star" });
    expect(consumed.returnTo).toBe("/p/one");
    expect(consumed.pkceVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.encryptedPkceVerifier).not.toContain(consumed.pkceVerifier);
    await expect(loaded.consumeGithubAuthFlow({ state: flow.state, browserNonce: flow.browserNonce, actorUserId: user.id, purpose: "star" })).rejects.toMatchObject({ code: "invalid_github_flow" });
  });
  it("rejects expired flows and allows only one concurrent callback consumption", async () => {
    const loaded = await repository();
    const expired = await loaded.createGithubAuthFlow({ purpose: "star", actorUserId: null });
    await db.update(githubAuthFlows).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(githubAuthFlows.id, expired.id));
    await expect(loaded.consumeGithubAuthFlow({ ...expired, actorUserId: null, purpose: "star" })).rejects.toMatchObject({ code: "invalid_github_flow" });
    const flow = await loaded.createGithubAuthFlow({ purpose: "star", actorUserId: null });
    const input = { ...flow, actorUserId: null, purpose: "star" as const };
    const outcomes = await Promise.allSettled([loaded.consumeGithubAuthFlow(input), loaded.consumeGithubAuthFlow(input)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  });
  it("supports maker flows with a caller transaction independently of the star flag", async () => {
    const loaded = await repository();
    const user = await actor();
    vi.stubEnv("GITHUB_STAR_ENABLED", "false");
    const flow = await db.transaction((tx) => loaded.createGithubAuthFlow({ purpose: "maker", actorUserId: user.id, productId: 123 }, tx));
    const consumed = await loaded.consumeGithubAuthFlow({ ...flow, actorUserId: user.id, purpose: "maker" });
    expect(consumed.productId).toBe(123);
    await expect(loaded.createGithubAuthFlow({ purpose: "maker", actorUserId: null })).rejects.toMatchObject({ status: 400 });
  });
  it("links a verified GitHub numeric identity without merging a matching email account", async () => {
    const existing = await actor("참여자-email");
    await db.insert(publicIdentities).values({ provider: "email", subject: "reader@example.com", userId: existing.id });
    const first = await connect();
    expect(first.user.id).not.toBe(existing.id);
    expect(first.user.displayName).not.toContain("reader");
    const again = await connect();
    expect(again.user.id).toBe(first.user.id);
    const [connection] = await db.select().from(githubUserConnections);
    expect(connection.revision).toBe(2);
    expect(connection.encryptedAccessToken).not.toContain(originalTokens().accessToken);
    expect(connection.encryptedRefreshToken).not.toContain(originalTokens().refreshToken);
  });
  it("refuses linking a GitHub identity owned by a different public user", async () => {
    const first = await actor("참여자-one");
    const second = await actor("참여자-two");
    await connect(first.id);
    await expect(connect(second.id)).rejects.toMatchObject({ status: 409, code: "github_identity_conflict" });
    expect((await db.select().from(githubUserConnections))[0].userId).toBe(first.id);
  });
  it("serializes concurrent GitHub identity claims so the losing actor cannot take over", async () => {
    const first = await actor("참여자-one");
    const second = await actor("참여자-two");
    const outcomes = await Promise.allSettled([connect(first.id), connect(second.id)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(githubUserConnections)).toHaveLength(1);
    expect(await db.select().from(publicIdentities)).toHaveLength(1);
  });
  it("uses an active credential without refresh or exposing ciphertext in the public connection", async () => {
    const user = await connect();
    const loaded = await credentials();
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await loaded.getGithubUserCredential(user.user.id)).toEqual({ token: originalTokens().accessToken, revision: 1, githubUserId: 101 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await (await repository()).getGithubConnection(user.user.id)).toEqual({ githubUserId: 101, login: "reader-101", state: "active" });
  });
  it("allows one refresh owner, rotates both tokens using CAS and keeps HTTP outside the transaction", async () => {
    const user = await connect(null, 101, true);
    const loaded = await credentials();
    let release!: (response: Response) => void;
    let announce!: () => void;
    const dispatched = new Promise<void>((resolve) => { announce = resolve; });
    const fetcher = vi.fn(async () => { announce(); return new Promise<Response>((resolve) => { release = resolve; }); });
    vi.stubGlobal("fetch", fetcher);
    const first = loaded.getGithubUserCredential(user.user.id);
    await dispatched;
    await expect(loaded.getGithubUserCredential(user.user.id)).rejects.toMatchObject({ status: 409, code: "github_refresh_in_progress" });
    // This committed read sees the lease while HTTP remains blocked.
    expect((await db.select().from(githubUserConnections))[0].refreshLeaseOwner).not.toBeNull();
    release(Response.json(freshTokenResponse()));
    expect(await first).toEqual({ token: freshTokenResponse().access_token, revision: 2, githubUserId: 101 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [stored] = await db.select().from(githubUserConnections);
    expect(stored.refreshLeaseOwner).toBeNull();
    expect(stored.revision).toBe(2);
  });
  it("makes ambiguous refreshes require reconnect and never repeats the possibly consumed token", async () => {
    const user = await connect(null, 101, true);
    const loaded = await credentials();
    const fetcher = vi.fn(async () => { throw new Error("secret-provider-error"); }); vi.stubGlobal("fetch", fetcher);
    await expect(loaded.getGithubUserCredential(user.user.id)).rejects.toMatchObject({ code: "github_needs_reconnect" });
    await expect(loaded.getGithubUserCredential(user.user.id)).rejects.toMatchObject({ code: "github_needs_reconnect" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await db.select().from(githubUserConnections))[0].state).toBe("needs_reconnect");
  });
  it("treats an expired refresh lease as uncertain and fences a late token response", async () => {
    const user = await connect(null, 101, true);
    const loaded = await credentials();
    const owner = randomUUID();
    await db.update(githubUserConnections).set({ refreshLeaseOwner: owner, refreshLeaseExpiresAt: new Date(Date.now() - 1_000) });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(loaded.getGithubUserCredential(user.user.id)).rejects.toMatchObject({ code: "github_needs_reconnect" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await (await repository()).completeGithubRefresh(user.user.id, { owner, revision: 1 }, originalTokens())).toBe(false);
    expect((await db.select().from(githubUserConnections))[0].state).toBe("needs_reconnect");
  });
  it("invalidates only the expected credential revision on 401 and clears credentials on disconnect", async () => {
    const user = await connect();
    const loaded = await credentials();
    await connect(user.user.id);
    await loaded.markGithubUserNeedsReconnect(user.user.id, 1);
    expect((await db.select().from(githubUserConnections))[0].state).toBe("active");
    await loaded.markGithubUserNeedsReconnect(user.user.id, 2);
    expect((await db.select().from(githubUserConnections))[0].state).toBe("needs_reconnect");
    await connect(user.user.id);
    await (await repository()).disconnectGithubUser(user.user.id);
    const [stored] = await db.select().from(githubUserConnections);
    expect(stored.state).toBe("revoked");
    expect(stored.encryptedAccessToken).toBeNull();
    expect(stored.encryptedRefreshToken).toBeNull();
    await expect(loaded.getGithubUserCredential(user.user.id)).rejects.toMatchObject({ code: "github_needs_reconnect" });
  });
});
