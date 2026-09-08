import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";

/** GitHub credentials never appear in persisted keys or logs. */
export type GitHubResource = "core" | "search" | "code_search";
export function githubResource(path: string): GitHubResource {
  return /^\/search\/code(?:\?|$)/.test(path) ? "code_search" : path.startsWith("/search/") ? "search" : "core";
}

export function githubQuotaKeys(token: string, resource: GitHubResource) {
  const credential = createHash("sha256").update(token).digest("hex");
  const prefix = `github:quota:${credential}`;
  return { primary: `${prefix}:primary:${resource}`, secondary: `${prefix}:secondary` };
}

export type GitHubCooldown = { retryAt: Date; primary: boolean; secondary: boolean };

/** Both delay forms may be supplied; never resume before the later one. */
export function githubCooldown(status: number, headers: Headers, now = new Date(), secondaryMessage = false): GitHubCooldown | null {
  const primary = headers.get("x-ratelimit-remaining") === "0";
  const retryHeader = headers.get("retry-after");
  const seconds = retryHeader?.trim() ? Number(retryHeader) : Number.NaN;
  const retryTime = Number.isFinite(seconds) && seconds >= 0
    ? now.getTime() + seconds * 1_000
    : retryHeader ? Date.parse(retryHeader) : Number.NaN;
  const secondary = (status === 403 || status === 429)
    && (Number.isFinite(retryTime) || secondaryMessage || (status === 429 && !primary));
  if (!primary && !secondary) return null;
  const resetSeconds = Number(headers.get("x-ratelimit-reset"));
  const resetTime = resetSeconds > 0 ? new Date(resetSeconds * 1_000).getTime() : 0;
  const indicated = Math.max(Number.isFinite(resetTime) ? resetTime : 0,
    Number.isFinite(new Date(retryTime).getTime()) ? retryTime : 0);
  const retryAt = new Date(indicated > now.getTime() ? indicated : now.getTime() + 60_000);
  return { retryAt, primary, secondary };
}

/** Shared across jobs/processes; a DB failure must not bypass an active cooldown. */
export async function readGitHubCooldown(token: string, resource: GitHubResource): Promise<Date | null> {
  const keys = githubQuotaKeys(token, resource);
  const rows = await db.select({ resetAt: rateLimits.resetAt }).from(rateLimits)
    .where(sql`${inArray(rateLimits.key, [keys.primary, keys.secondary])} and ${rateLimits.resetAt} > now()`);
  return rows.reduce<Date | null>((latest, row) => !latest || row.resetAt > latest ? row.resetAt : latest, null);
}

/** Late/out-of-order responses can extend a wait, never shorten an existing one. */
export async function recordGitHubCooldown(token: string, resource: GitHubResource, cooldown: GitHubCooldown): Promise<Date> {
  const keys = githubQuotaKeys(token, resource);
  const values = [cooldown.primary ? keys.primary : null, cooldown.secondary ? keys.secondary : null]
    .filter((key): key is string => key !== null)
    .map(key => ({ key, count: 0, resetAt: cooldown.retryAt }));
  if (values.length === 0 || !Number.isFinite(cooldown.retryAt.getTime())) throw new Error("invalid_github_cooldown");
  const rows = await db.insert(rateLimits).values(values).onConflictDoUpdate({
    target: rateLimits.key,
    set: { resetAt: sql`greatest(${rateLimits.resetAt}, excluded.reset_at)` },
  }).returning({ resetAt: rateLimits.resetAt });
  return rows.reduce((latest, row) => row.resetAt > latest ? row.resetAt : latest, cooldown.retryAt);
}
