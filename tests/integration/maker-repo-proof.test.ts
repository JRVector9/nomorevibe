import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productEvidenceSources, products } from "@/lib/db/schema";
import { productMakerMembers } from "@/lib/db/me-schema";
import { publicIdentities, publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { csrfForToken, newPublicSession } from "@/lib/domain/accounts/session";
import { clearAllMemos } from "@/lib/cache/memo";
import { ensureSchema, resetTables } from "./setup";
import { repositoryProofPath, signRepositoryProof } from "@/lib/me/repo-proof-token";
import type { RepositoryProofChallenge } from "@/lib/me/maker-repo-proof";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/operations/dr/epoch", async (original) => {
  const actual = await original<typeof import("@/lib/operations/dr/epoch")>();
  return { ...actual, readWriterFence: vi.fn(actual.readWriterFence) };
});
const route = await import("@/app/api/maker/claims/repo-file/route");
const personalRoute = await import("@/app/api/maker/claims/route");
const { recheckMakerMemberships } = await import("@/lib/me/maker-claims");
const epoch = await import("@/lib/operations/dr/epoch");
const ORIGIN = "https://nomorevibe.example";
const REPO_ID = 1234;
const NODE_ID = "R_repo1234";
const OWNER_ID = 900;
let githubCalls: string[];
let proofFiles: Map<string, string>;
let branchFiles: Map<string, string>;
let repoOverrides: Record<string, unknown>;
let graphqlOverrides: Record<string, unknown>;
let graphqlErrors: unknown[];
let beforeGraphql: (() => Promise<void>) | null;

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", "repository-proof-integration-secret-at-least-32-characters");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  vi.stubEnv("GITHUB_TOKEN", "test-collector-token");
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", "");
  await resetTables();
  clearAllMemos();
  githubCalls = []; proofFiles = new Map(); branchFiles = new Map();
  repoOverrides = {}; graphqlOverrides = {}; graphqlErrors = []; beforeGraphql = null;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.github.com") throw new Error(`unexpected fetch ${url.href}`);
    githubCalls.push(url.pathname);
    if (url.pathname === "/repos/acme/tool") return Response.json({ id: REPO_ID, node_id: NODE_ID, name: "tool", full_name: "acme/tool",
      private: false, default_branch: "main", owner: { id: OWNER_ID, login: "acme", type: "Organization" }, ...repoOverrides });
    if (url.pathname !== "/graphql") return Response.json({ message: "Not Found" }, { status: 404 });
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    // The test's non-default branch map is deliberately never served by a HEAD read.
    const path = /object\(expression: "HEAD:([^"]+)"\)/.exec(query)?.[1];
    expect(query).toContain(`node(id: "${NODE_ID}")`);
    expect(path).toBeTruthy();
    if (beforeGraphql) await beforeGraphql();
    const text = path ? proofFiles.get(path) : undefined;
    return Response.json({ data: { node: { id: NODE_ID, databaseId: REPO_ID, isPrivate: false, isFork: false,
      owner: { __typename: "Organization", databaseId: OWNER_ID }, defaultBranchRef: { name: "main", target: { oid: "a".repeat(40) } },
      proof: text === undefined ? null : { text, byteSize: Buffer.byteLength(text), isTruncated: false, isBinary: false }, ...graphqlOverrides } }, errors: graphqlErrors });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function account(githubId?: number) {
  const [user] = await db.insert(publicUsers).values({ displayName: "Repository operator" }).returning();
  await db.insert(publicIdentities).values({ userId: user.id, provider: githubId ? "github" : "email", subject: githubId ? String(githubId) : `${user.id}@example.test` });
  const session = newPublicSession();
  await db.insert(publicSessions).values({ userId: user.id, tokenHash: session.tokenHash, createdAt: session.createdAt, expiresAt: session.expiresAt });
  return { user, token: session.token, csrf: csrfForToken(session.token, "session") };
}
type Session = Awaited<ReturnType<typeof account>>;
async function listed(options: { anchored?: boolean; status?: "seeded" | "banned" } = {}) {
  const [product] = await db.insert(products).values({ slug: "org-tool", name: "Organization tool", accessMode: "installable",
    url: "https://github.com/acme/tool", repoUrl: "https://github.com/acme/tool", tagline: "Tool", description: "Description", category: "Other",
    status: options.status ?? "seeded", source: "crawler", verifyToken: "v-org-tool", editTokenHash: "e".repeat(64) }).returning();
  if (options.anchored !== false) await db.insert(productEvidenceSources).values({ slug: product.slug, kind: "repository", provider: "github", sourceKey: "acme/tool",
    normalizedFacts: { type: "github_repository", repositoryKey: "acme/tool", repositoryId: REPO_ID } });
  return product;
}
function request(session: Session | null, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/maker/claims/repo-file`, { method: "POST", body: JSON.stringify(body), headers: {
    origin: ORIGIN, "content-type": "application/json", ...(session ? { cookie: `nmv_user=${session.token}`, "x-csrf-token": session.csrf } : {}), ...headers,
  } });
}
async function start(session: Session, productId: number) {
  const response = await route.POST(request(session, { productId }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return await response.json() as RepositoryProofChallenge;
}
async function complete(session: Session, productId: number, token: string) {
  const response = await route.POST(request(session, { productId, token }));
  return { status: response.status, body: await response.json() };
}
async function setupProof() {
  const session = await account();
  const product = await listed();
  const challenge = await start(session, product.id);
  return { session, product, challenge };
}

describe("repository proof self-service", () => {
  it("verifies an installable organization repository through its default branch without GitHub identity or administrator approval", async () => {
    const { session, product, challenge } = await setupProof();
    expect(challenge.path).toBe(repositoryProofPath(product.id, session.user.id));
    const edit = new URL(challenge.editUrl);
    expect(edit.origin).toBe("https://github.com");
    expect(edit.pathname).toBe("/acme/tool/new/main");
    expect(edit.searchParams.get("value")).toBe(`${challenge.token}\n`);
    proofFiles.set(challenge.path, `${challenge.token}\n`);
    expect(await complete(session, product.id, challenge.token)).toEqual({ status: 200, body: { result: "verified", slug: product.slug } });
    const [member] = await db.select().from(productMakerMembers);
    expect(member).toMatchObject({ productId: product.id, userId: session.user.id, role: "owner", githubUserId: null, method: "repo_file", revokedAt: null });
    expect(member.recheckAt!.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    const [stored] = await db.select().from(products).where(eq(products.id, product.id));
    expect(stored).toMatchObject({ claimedAt: null, status: "seeded", editTokenHash: "e".repeat(64) });
    const calls = githubCalls.length;
    expect((await complete(session, product.id, challenge.token)).body.result).toBe("already_verified");
    expect(githubCalls.length).toBe(calls);
  });

  it("rejects anonymous, wrong Origin and wrong CSRF requests before GitHub calls", async () => {
    const session = await account();
    const product = await listed();
    const anonymous = await route.POST(request(null, { productId: product.id }));
    expect(anonymous.status).toBe(401);
    for (const headers of [{ origin: "https://evil.example" }, { "x-csrf-token": "bad" }] as Record<string, string>[]) {
      expect((await route.POST(request(session, { productId: product.id }, headers))).status).toBe(403);
    }
    expect(githubCalls).toEqual([]);
    expect(await db.select().from(productMakerMembers)).toHaveLength(0);
  });

  it("never uses a token from another actor or product", async () => {
    const { session, product, challenge } = await setupProof();
    const other = await account();
    proofFiles.set(repositoryProofPath(product.id, other.user.id), challenge.token);
    expect(await complete(other, product.id, challenge.token)).toMatchObject({ status: 403, body: { error: "repo_proof_invalid" } });
    const [second] = await db.insert(products).values({ slug: "other", name: "Other", url: "https://other.example", repoUrl: product.repoUrl, tagline: "Other", description: "Other description",
      category: "Other", status: "seeded", verifyToken: "v-other", editTokenHash: "e".repeat(64) }).returning();
    expect(await complete(session, second.id, challenge.token)).toMatchObject({ status: 403, body: { error: "repo_proof_invalid" } });
    expect(githubCalls).toEqual(["/repos/acme/tool"]);
    expect(await db.select().from(productMakerMembers)).toHaveLength(0);
  });

  it("rejects a proof that only exists on another branch, then succeeds after it reaches the default branch", async () => {
    const { session, product, challenge } = await setupProof();
    branchFiles.set(challenge.path, challenge.token);
    expect(await complete(session, product.id, challenge.token)).toMatchObject({ status: 409, body: { error: "repo_proof_missing" } });
    proofFiles.set(challenge.path, branchFiles.get(challenge.path)!);
    expect((await complete(session, product.id, challenge.token)).body.result).toBe("verified");
  });

  it.each([
    ["fork", { isFork: true }], ["different immutable repository", { databaseId: 9999 }],
    ["transferred owner", { owner: { __typename: "Organization", databaseId: 901 } }], ["private repository", { isPrivate: true }],
  ])("rejects %s despite matching proof text", async (_name, overrides) => {
    const { session, product, challenge } = await setupProof();
    proofFiles.set(challenge.path, challenge.token); graphqlOverrides = overrides;
    expect(await complete(session, product.id, challenge.token)).toMatchObject({ status: 409, body: { error: "repo_proof_repository_changed" } });
    expect(await db.select().from(productMakerMembers)).toHaveLength(0);
  });

  it("rejects unknown or conflicting historical repository anchors", async () => {
    const session = await account(); const product = await listed({ anchored: false });
    let response = await route.POST(request(session, { productId: product.id }));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "repo_unverified" });
    await db.insert(productEvidenceSources).values({ slug: product.slug, kind: "repository", provider: "github", sourceKey: "acme/tool",
      normalizedFacts: { type: "github_repository", repositoryKey: "acme/tool", repositoryId: 9999 } });
    response = await route.POST(request(session, { productId: product.id }));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "repo_replaced" });
  });

  it("rejects expired issuance for a new or revoked membership without calling GitHub", async () => {
    const session = await account(); const product = await listed();
    const token = signRepositoryProof({ userId: session.user.id, productId: product.id, repoUrl: product.repoUrl!, repoId: REPO_ID, nodeId: NODE_ID, ownerId: OWNER_ID }, Date.now() - 31 * 60_000);
    proofFiles.set(repositoryProofPath(product.id, session.user.id), token);
    expect(await complete(session, product.id, token)).toMatchObject({ status: 403, body: { error: "repo_proof_invalid" } });
    await db.insert(productMakerMembers).values({ productId: product.id, userId: session.user.id, role: "owner", method: "repo_file", revokedAt: new Date(), revokedReason: "manual" });
    expect(await complete(session, product.id, token)).toMatchObject({ status: 403, body: { error: "repo_proof_invalid" } });
    expect(githubCalls).toEqual([]);
    expect((await db.select().from(productMakerMembers))[0].revokedAt).not.toBeNull();
  });

  it("does not grant access from partial GraphQL errors or a truncated blob", async () => {
    const { session, product, challenge } = await setupProof(); proofFiles.set(challenge.path, challenge.token);
    graphqlErrors = [{ type: "FORBIDDEN", path: ["node", "proof"] }];
    expect((await complete(session, product.id, challenge.token)).status).toBe(503);
    graphqlErrors = []; graphqlOverrides = { proof: { text: challenge.token, byteSize: challenge.token.length, isTruncated: true, isBinary: false } };
    expect((await complete(session, product.id, challenge.token)).body.error).toBe("repo_proof_missing");
    expect(await db.select().from(productMakerMembers)).toHaveLength(0);
  });

  it("requires a fresh challenge after revocation and checks a new revocation again inside the locked write", async () => {
    const { session, product, challenge } = await setupProof(); proofFiles.set(challenge.path, challenge.token);
    const revokedAt = new Date(Date.now() + 1);
    await db.insert(productMakerMembers).values({ productId: product.id, userId: session.user.id, role: "owner", method: "repo_file", revokedAt, revokedReason: "manual" });
    expect(await complete(session, product.id, challenge.token)).toMatchObject({ status: 403, body: { error: "repo_proof_invalid" } });
    await db.update(productMakerMembers).set({ revokedAt: new Date(Date.now() - 10_000) });
    const fresh = await start(session, product.id); proofFiles.set(fresh.path, fresh.token);
    beforeGraphql = async () => { await db.update(productMakerMembers).set({ revokedAt: new Date(Date.now() + 1), revokedReason: "manual_again" }); };
    expect((await complete(session, product.id, fresh.token)).status).toBe(404);
    expect((await db.select().from(productMakerMembers))[0]).toMatchObject({ revokedReason: "manual_again" });
    beforeGraphql = null;
    await db.update(productMakerMembers).set({ revokedAt: new Date(Date.now() - 10_000) });
    const newest = await start(session, product.id); proofFiles.set(newest.path, newest.token);
    expect((await complete(session, product.id, newest.token)).body.result).toBe("verified");
  });

  it.each(["banned", "repo_changed", "account_deleted"])("rechecks %s while GitHub is in flight before recording membership", async (change) => {
    const { session, product, challenge } = await setupProof(); proofFiles.set(challenge.path, challenge.token);
    beforeGraphql = async () => {
      if (change === "account_deleted") await db.update(publicUsers).set({ deletedAt: new Date() }).where(eq(publicUsers.id, session.user.id));
      else await db.update(products).set(change === "banned" ? { status: "banned" } : { repoUrl: "https://github.com/acme/replacement" }).where(eq(products.id, product.id));
    };
    expect((await complete(session, product.id, challenge.token)).status).toBe(404);
    expect(await db.select().from(productMakerMembers)).toHaveLength(0);
  });

  it("retains only the established membership with an expired retained proof, then revokes it if the file disappears", async () => {
    const session = await account(); const product = await listed();
    const issuedAt = Date.now() - 31 * 86_400_000;
    const token = signRepositoryProof({ userId: session.user.id, productId: product.id, repoUrl: product.repoUrl!, repoId: REPO_ID, nodeId: NODE_ID, ownerId: OWNER_ID }, issuedAt);
    proofFiles.set(repositoryProofPath(product.id, session.user.id), token);
    await db.insert(productMakerMembers).values({ productId: product.id, userId: session.user.id, role: "owner", method: "repo_file",
      verifiedAt: new Date(issuedAt + 1_000), recheckAt: new Date(Date.now() - 1_000) });
    expect(await recheckMakerMemberships({ deadlineAt: Date.now() + 10_000 })).toEqual({ checked: 1, kept: 1, revoked: 0, deferred: 0 });
    await db.update(productMakerMembers).set({ recheckAt: new Date(Date.now() - 1_000) }); proofFiles.clear();
    expect(await recheckMakerMemberships({ deadlineAt: Date.now() + 10_000 })).toEqual({ checked: 1, kept: 0, revoked: 1, deferred: 0 });
    expect((await db.select().from(productMakerMembers))[0]).toMatchObject({ revokedReason: "repo_proof_missing" });
    expect((await complete(session, product.id, token)).status).toBe(403);
  });

  it("fully verifies a fresh replacement proof for an existing member and renews the established time for later rechecks", async () => {
    const session = await account(); const product = await listed();
    const establishedAt = new Date(Date.now() - 60_000);
    await db.insert(productMakerMembers).values({ productId: product.id, userId: session.user.id, role: "owner", method: "repo_file", verifiedAt: establishedAt, recheckAt: establishedAt });
    const challenge = await start(session, product.id); proofFiles.set(challenge.path, challenge.token);
    expect(await complete(session, product.id, challenge.token)).toEqual({ status: 200, body: { result: "already_verified", slug: product.slug } });
    expect(githubCalls).toContain("/graphql");
    const [member] = await db.select().from(productMakerMembers);
    expect(member.verifiedAt.getTime()).toBeGreaterThan(establishedAt.getTime());
    await db.update(productMakerMembers).set({ recheckAt: new Date(Date.now() - 1_000) });
    expect(await recheckMakerMemberships({ deadlineAt: Date.now() + 10_000 })).toEqual({ checked: 1, kept: 1, revoked: 0, deferred: 0 });
  });

  it("revokes repository file access in the same transaction when its repository URL changes", async () => {
    const { session, product, challenge } = await setupProof(); proofFiles.set(challenge.path, challenge.token);
    await complete(session, product.id, challenge.token);
    const repository = await import("@/lib/domain/products/repository");
    await repository.update(product.id, { repoUrl: "https://github.com/acme/replacement" });
    expect((await db.select().from(productMakerMembers))[0]).toMatchObject({ revokedReason: "repo_changed" });
  });

  it("keeps the existing personal numeric owner path and refuses organization identity alone", async () => {
    const session = await account(OWNER_ID); const product = await listed();
    const send = () => personalRoute.POST(request(session, { productIds: [product.id] }));
    expect((await (await send()).json()).results[0].result).toBe("org_repo_not_supported_yet");
    clearAllMemos(); repoOverrides = { owner: { id: OWNER_ID, login: "acme", type: "User" } };
    expect((await (await send()).json()).results[0].result).toBe("verified");
    expect((await (await send()).json()).results[0].result).toBe("already_verified");
  });

  it("rejects the route while the writer is fenced before GitHub or membership changes", async () => {
    const session = await account(); const product = await listed();
    vi.mocked(epoch.readWriterFence).mockResolvedValueOnce({ lineageId: "bd5b8dd5-5733-4635-98f1-8286c54238f8", writerEpoch: 1,
      state: "fenced", reason: "operator_fence", fencedDb: { systemIdentifier: "1", databaseOid: "1", databaseName: "nomorevibe_test" }, promotionId: null });
    const response = await route.POST(request(session, { productId: product.id }));
    expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ error: "public_auth_unavailable" }); expect(githubCalls).toEqual([]);
    expect(await db.select().from(productMakerMembers)).toHaveLength(0);
  });

  it("shares the existing account request limit and rejects caller-controlled refs", async () => {
    const session = await account(); const product = await listed();
    const invalid = await route.POST(request(session, { productId: product.id, ref: "feature-branch" }));
    expect(invalid.status).toBe(400);
    await db.execute(sql`INSERT INTO rate_limits (key, count, reset_at) VALUES (${`maker:claims:user:${session.user.id}`}, 12, now() + interval '1 hour')`);
    expect((await route.POST(request(session, { productId: product.id }))).status).toBe(429);
    expect(githubCalls).toEqual([]);
  });
});
