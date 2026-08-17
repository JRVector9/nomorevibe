export const OAUTH_STATE_COOKIE = "nmv_oauth_state";

/** state는 왕복 한 번에만 쓰이므로 짧게 둔다 */
export const oauthStateCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 10 * 60,
};

export type GithubUser = { login: string; name?: string | null };

/** 인증 코드를 액세스 토큰으로 바꾼다 (서버에서만 — client_secret이 필요하다) */
export async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: string };
  return body.access_token ?? null;
}

export async function fetchGithubUser(accessToken: string): Promise<GithubUser | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "NoMoreVibe/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { login?: string; name?: string | null };
  return body.login ? { login: body.login, name: body.name ?? null } : null;
}
