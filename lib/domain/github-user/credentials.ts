import { PublicAuthError } from "@/lib/domain/accounts/request-auth";
import { githubStarAppConfig, requireGithubStarEnabled } from "./config";
import { claimGithubRefresh, completeGithubRefresh, markGithubConnectionNeedsReconnect } from "./repository";
import { decryptGithubSecret, requireGithubIntegrationSecret } from "./secrets";

export { encryptGithubSecret, decryptGithubSecret } from "./secrets";
export type GithubUserTokens = { accessToken: string; refreshToken: string; accessExpiresAt: Date; refreshExpiresAt: Date };
export type GithubOAuthResult = { outcome: "confirmed_success"; tokens: GithubUserTokens } | { outcome: "confirmed_rejection" | "unknown"; code: "github_oauth_rejected" | "github_oauth_unknown" | "github_oauth_timeout" };

function parseTokens(value: unknown, receivedAt: number): GithubUserTokens | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.access_token !== "string" || !/^ghu_[A-Za-z0-9_-]{20,4092}$/.test(body.access_token)
    || typeof body.refresh_token !== "string" || !/^ghr_[A-Za-z0-9_-]{20,4092}$/.test(body.refresh_token)
    || typeof body.expires_in !== "number" || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0 || body.expires_in > 31_536_000
    || typeof body.refresh_token_expires_in !== "number" || !Number.isSafeInteger(body.refresh_token_expires_in) || body.refresh_token_expires_in <= 0 || body.refresh_token_expires_in > 63_072_000
    || body.token_type !== "bearer" || body.scope !== "") return null;
  return { accessToken: body.access_token, refreshToken: body.refresh_token, accessExpiresAt: new Date(receivedAt + body.expires_in * 1000), refreshExpiresAt: new Date(receivedAt + body.refresh_token_expires_in * 1000) };
}

async function oauthGrant(parameters: Record<string, string>, fetcher: typeof fetch, timeoutMs = 8_000): Promise<GithubOAuthResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<GithubOAuthResult>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ outcome: "unknown", code: "github_oauth_timeout" }); }, Math.max(1, Math.min(10_000, timeoutMs)));
  });
  const dispatch = async (): Promise<GithubOAuthResult> => {
    const response = await fetcher("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(parameters), redirect: "manual", signal: controller.signal, cache: "no-store" });
    if (response.status >= 400 && response.status < 500 && response.status !== 408) { void response.body?.cancel().catch(() => {}); return { outcome: "confirmed_rejection", code: "github_oauth_rejected" }; }
    if (response.status !== 200) { void response.body?.cancel().catch(() => {}); return { outcome: "unknown", code: "github_oauth_unknown" }; }
    const receivedAt = Date.now();
    const reader = response.body?.getReader();
    if (!reader) return { outcome: "unknown", code: "github_oauth_unknown" };
    const cancel = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) { cancel(); return { outcome: "unknown", code: "github_oauth_unknown" }; }
        chunks.push(value);
      }
      const tokens = parseTokens(JSON.parse(Buffer.concat(chunks).toString("utf8")), receivedAt);
      if (controller.signal.aborted || !tokens) return { outcome: "unknown", code: "github_oauth_unknown" };
      return { outcome: "confirmed_success", tokens };
    } catch {
      return { outcome: "unknown", code: "github_oauth_unknown" };
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  };
  try {
    return await Promise.race([dispatch().catch(() => ({ outcome: "unknown", code: "github_oauth_unknown" } as const)), deadline]);
  } finally { clearTimeout(timer); }
}

export async function exchangeGithubAppCode(input: { code: string; verifier: string; clientId: string; clientSecret: string; callbackUrl: string }, fetcher: typeof fetch = fetch): Promise<GithubOAuthResult> {
  return oauthGrant({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, code_verifier: input.verifier, redirect_uri: input.callbackUrl }, fetcher);
}
export async function exchangeGithubCode(input: { code: string; verifier: string }, fetcher: typeof fetch = fetch): Promise<GithubOAuthResult> {
  return exchangeGithubAppCode({ ...input, ...githubStarAppConfig() }, fetcher);
}
export async function refreshGithubToken(refreshToken: string, fetcher: typeof fetch = fetch, timeoutMs?: number): Promise<GithubOAuthResult> {
  const config = githubStarAppConfig();
  return oauthGrant({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }, fetcher, timeoutMs);
}

export async function getGithubUserCredential(userId: number): Promise<{ token: string; revision: number; githubUserId: number }> {
  requireGithubStarEnabled();
  requireGithubIntegrationSecret();
  githubStarAppConfig();
  const claim = await claimGithubRefresh(userId);
  if (claim.kind === "error") throw new PublicAuthError(409, claim.code);
  const connection = claim.connection;
  if (claim.kind === "ready") {
    try {
      return { token: decryptGithubSecret(connection.encryptedAccessToken!), revision: connection.revision, githubUserId: connection.githubUserId };
    } catch {
      await markGithubConnectionNeedsReconnect(userId, connection.revision);
      throw new PublicAuthError(409, "github_needs_reconnect");
    }
  }
  try {
    const result = await refreshGithubToken(decryptGithubSecret(connection.encryptedRefreshToken!));
    if (result.outcome !== "confirmed_success") {
      await markGithubConnectionNeedsReconnect(userId, connection.revision);
      throw new PublicAuthError(409, "github_needs_reconnect");
    }
    const updated = await completeGithubRefresh(userId, { owner: claim.owner, revision: connection.revision }, result.tokens);
    if (!updated) throw new PublicAuthError(409, "github_needs_reconnect");
    return { token: result.tokens.accessToken, revision: connection.revision + 1, githubUserId: connection.githubUserId };
  } catch (error) {
    if (error instanceof PublicAuthError) throw error;
    // The refresh token may have been consumed even when token persistence fails.
    await markGithubConnectionNeedsReconnect(userId, connection.revision);
    throw new PublicAuthError(409, "github_needs_reconnect");
  }
}

export async function markGithubUserNeedsReconnect(userId: number, expectedRevision: number): Promise<void> {
  await markGithubConnectionNeedsReconnect(userId, expectedRevision);
}
