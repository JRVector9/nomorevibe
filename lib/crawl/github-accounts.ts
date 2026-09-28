import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { githubCollectorAccounts, operationsAudit } from "@/lib/db/schema";
import { seal, unseal } from "@/lib/operations/credential-vault";

export type CoreQuota = { limit: number; used: number; remaining: number; reset: number };
export type CollectorIdentity = { userId: number; login: string; core: CoreQuota | null };
export type CollectorToken = { token: string; userId: number | null; login: string };
const lastQuotaWrite = new Map<number, number>();

export function collectorSecret(): string {
  const secret = process.env.GITHUB_COLLECTOR_SECRET;
  if (!secret || secret.length < 32) throw new Error("github_collector_secret_missing");
  return secret;
}

export function encryptCollectorToken(token: string, secret: string): string { return seal(token, secret); }
export function decryptCollectorToken(ciphertext: string, secret: string): string { return unseal(ciphertext, secret); }

export function parseCoreQuota(input: unknown): CoreQuota | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const numbers = [value.limit, value.used, value.remaining, value.reset];
  if (!numbers.every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
  return { limit: value.limit as number, used: value.used as number, remaining: value.remaining as number, reset: value.reset as number };
}

/** GitHub identity is the deduplication key; no supplied login or account ID is trusted. */
export async function inspectGitHubCollectorToken(token: string): Promise<CollectorIdentity> {
  if (token.length < 20 || token.length > 512 || /\s/.test(token)) throw new Error("github_token_invalid");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "user-agent": "NoMoreVibe/1.0" };
  const request = (path: string) => fetch(`https://api.github.com${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(10_000), cache: "no-store" });
  let user: Response;
  let rate: Response;
  try {
    user = await request("/user");
    if (user.status === 401 || user.status === 403) throw new Error("github_token_invalid");
    if (!user.ok) throw new Error("github_identity_unavailable");
    rate = await request("/rate_limit");
    if (rate.status === 401 || rate.status === 403) throw new Error("github_token_invalid");
    if (!rate.ok) throw new Error("github_quota_unavailable");
    const identity = await user.json() as { id?: unknown; login?: unknown };
    const limits = await rate.json() as { resources?: { core?: unknown } };
    if (!Number.isSafeInteger(identity.id) || (identity.id as number) <= 0 || typeof identity.login !== "string"
      || !/^[A-Za-z0-9-]{1,100}$/.test(identity.login)) throw new Error("github_identity_invalid");
    return { userId: identity.id as number, login: identity.login, core: parseCoreQuota(limits.resources?.core) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("github_")) throw error;
    throw new Error("github_identity_unavailable");
  }
}

/** An existing GitHub user ID is replaced atomically, never added as extra quota. */
export async function saveGitHubCollectorAccount(token: string, actor: string, expectedUserId?: number): Promise<CollectorIdentity> {
  const secret = collectorSecret();
  const identity = await inspectGitHubCollectorToken(token);
  if (expectedUserId !== undefined && identity.userId !== expectedUserId) throw new Error("github_account_mismatch");
  const encryptedToken = encryptCollectorToken(token, secret);
  await db.transaction(async tx => {
    await tx.insert(githubCollectorAccounts).values({
      userId: identity.userId, login: identity.login, encryptedToken,
      coreQuota: identity.core, quotaObservedAt: new Date(),
    }).onConflictDoUpdate({
      target: githubCollectorAccounts.userId,
      set: { login: identity.login, encryptedToken, enabled: true,
        coreQuota: identity.core, quotaObservedAt: new Date(), updatedAt: new Date() },
    });
    await tx.insert(operationsAudit).values({ actor, action: "github-collector-token-save", target: String(identity.userId), detail: { login: identity.login } });
  });
  return identity;
}

export async function setGitHubCollectorAccountEnabled(userId: number, enabled: boolean, actor: string): Promise<boolean> {
  return db.transaction(async tx => {
    const changed = await tx.update(githubCollectorAccounts).set({ enabled, updatedAt: new Date() })
      .where(eq(githubCollectorAccounts.userId, userId)).returning({ userId: githubCollectorAccounts.userId });
    if (changed.length === 0) return false;
    await tx.insert(operationsAudit).values({ actor, action: enabled ? "github-collector-enable" : "github-collector-disable", target: String(userId), detail: {} });
    return true;
  });
}

export async function listGitHubCollectorAccounts() {
  return db.select({ userId: githubCollectorAccounts.userId, login: githubCollectorAccounts.login,
    enabled: githubCollectorAccounts.enabled, coreQuota: githubCollectorAccounts.coreQuota,
    quotaObservedAt: githubCollectorAccounts.quotaObservedAt, updatedAt: githubCollectorAccounts.updatedAt,
    quotaStale: sql<boolean>`${githubCollectorAccounts.quotaObservedAt} is null or ${githubCollectorAccounts.quotaObservedAt} < now() - interval '1 hour'`,
  }).from(githubCollectorAccounts).orderBy(githubCollectorAccounts.userId);
}

export async function collectorTokens(): Promise<CollectorToken[]> {
  const legacy = process.env.GITHUB_TOKEN?.trim();
  // During rollout the existing worker can keep using its env token before the shared key is installed.
  if (!process.env.GITHUB_COLLECTOR_SECRET) return legacy ? [{ token: legacy, userId: null, login: "환경 토큰" }] : [];
  const rows = await db.select({ userId: githubCollectorAccounts.userId, login: githubCollectorAccounts.login,
    encryptedToken: githubCollectorAccounts.encryptedToken }).from(githubCollectorAccounts)
    .where(eq(githubCollectorAccounts.enabled, true)).orderBy(githubCollectorAccounts.userId);
  if (rows.length === 0) return legacy ? [{ token: legacy, userId: null, login: "환경 토큰" }] : [];
  const secret = collectorSecret();
  const seen = new Set<string>();
  const result: CollectorToken[] = [];
  if (legacy) { seen.add(legacy); result.push({ token: legacy, userId: null, login: "환경 토큰" }); }
  for (const row of rows) {
    const token = decryptCollectorToken(row.encryptedToken, secret);
    if (!seen.has(token)) { result.push({ token, userId: row.userId, login: row.login }); seen.add(token); }
  }
  return result;
}

/** Quota headers are account-scoped. Keep no PAT or ciphertext in this record. */
export async function observeCollectorQuota(userId: number | null, headers: Headers): Promise<void> {
  if (userId === null) return;
  if (["x-ratelimit-limit", "x-ratelimit-used", "x-ratelimit-remaining", "x-ratelimit-reset"]
    .some(name => headers.get(name) === null)) return;
  const quota = parseCoreQuota({
    limit: Number(headers.get("x-ratelimit-limit")), used: Number(headers.get("x-ratelimit-used")),
    remaining: Number(headers.get("x-ratelimit-remaining")), reset: Number(headers.get("x-ratelimit-reset")),
  });
  if (!quota || headers.get("x-ratelimit-resource") !== "core") return;
  const now = Date.now();
  if (quota.remaining > 0 && now - (lastQuotaWrite.get(userId) ?? 0) < 30_000) return;
  await db.update(githubCollectorAccounts).set({ coreQuota: quota, quotaObservedAt: new Date() })
    .where(eq(githubCollectorAccounts.userId, userId));
  lastQuotaWrite.set(userId, now);
}
