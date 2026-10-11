import { PublicAuthError, requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";
import { githubStarEnabled } from "@/lib/domain/github-integration/flags";

export function requireGithubStarEnabled(): void {
  requirePublicAuthEnabled();
  if (!githubStarEnabled()) throw new PublicAuthError(404, "github_star_disabled");
}

export function githubStarAppConfig() {
  const clientId = process.env.GITHUB_STAR_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_STAR_APP_CLIENT_SECRET;
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (!clientId || !clientSecret || !site) throw new PublicAuthError(503, "github_integration_unconfigured");
  try {
    const origin = new URL(site);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error();
    return { clientId, clientSecret, callbackUrl: `${origin.origin}/api/auth/user/github/callback` };
  } catch {
    throw new PublicAuthError(503, "github_integration_unconfigured");
  }
}
