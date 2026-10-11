import { githubRequest } from "@/lib/github/client";
import { isGithubNumericId } from "@/lib/github/repositories";
import { PublicAuthError } from "@/lib/domain/accounts/request-auth";
import { exchangeGithubCode } from "./credentials";
import { consumeGithubAuthFlow, createGithubAuthFlow, saveGithubUserConnection } from "./repository";
import { githubStarAppConfig, requireGithubStarEnabled } from "./config";

export { newGithubAuthorizationSecrets } from "./secrets";
export { requireGithubStarEnabled } from "./config";
export const GITHUB_NONCE_COOKIE = "nmv_github_nonce";
export function githubNonceCookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: 10 * 60 };
}

export function githubAuthorizeUrl(input: { state: string; challenge: string }): string {
  const config = githubStarAppConfig();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("scope", "offline_access");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function startGithubAuthorization(input: { actorUserId: number | null; returnTo?: string; consent: boolean }) {
  requireGithubStarEnabled();
  githubStarAppConfig();
  if (!input.consent) throw new PublicAuthError(400, "github_star_consent_required");
  const flow = await createGithubAuthFlow({ purpose: "star", actorUserId: input.actorUserId, returnTo: input.returnTo });
  return { authorizeUrl: githubAuthorizeUrl({ state: flow.state, challenge: flow.codeChallenge }), browserNonce: flow.browserNonce };
}

export async function finishGithubAuthorization(input: { state: string; code: string; browserNonce: string; actorUserId: number | null; previousToken?: string }) {
  requireGithubStarEnabled();
  const flow = await consumeGithubAuthFlow({ state: input.state, browserNonce: input.browserNonce, actorUserId: input.actorUserId, purpose: "star" });
  if (!input.code || input.code.length > 512 || /[\s\u0000-\u001f\u007f]/.test(input.code)) throw new PublicAuthError(400, "invalid_github_code");
  const exchange = await exchangeGithubCode({ code: input.code, verifier: flow.pkceVerifier });
  if (exchange.outcome !== "confirmed_success") throw new PublicAuthError(400, "github_authorization_failed");
  const profile = await githubRequest<{ id?: unknown; login?: unknown }>({ path: "/user", token: exchange.tokens.accessToken });
  if (profile.outcome !== "confirmed_success" || !profile.data || !isGithubNumericId(profile.data.id) || typeof profile.data.login !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(profile.data.login)) throw new PublicAuthError(400, "github_identity_unavailable");
  const login = await saveGithubUserConnection({ actorUserId: flow.actorUserId, githubUser: { id: profile.data.id, login: profile.data.login }, tokens: exchange.tokens, previousToken: input.previousToken });
  return { ...login, returnTo: flow.returnTo };
}
