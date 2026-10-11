import { createHash, randomBytes } from "node:crypto";
import { seal, unseal } from "@/lib/operations/credential-vault";
import { PublicAuthError } from "@/lib/domain/accounts/request-auth";

function integrationSecret(): string {
  const secret = process.env.GITHUB_INTEGRATION_SECRET;
  if (!secret || secret.length < 32) throw new PublicAuthError(503, "github_integration_unconfigured");
  return secret;
}
export function requireGithubIntegrationSecret(): void {
  integrationSecret();
}
export function encryptGithubSecret(value: string): string {
  return seal(value, integrationSecret());
}
export function decryptGithubSecret(value: string): string {
  return unseal(value, integrationSecret());
}
export function newGithubAuthorizationSecrets() {
  const state = randomBytes(32).toString("base64url");
  const browserNonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  return { state, browserNonce, verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
