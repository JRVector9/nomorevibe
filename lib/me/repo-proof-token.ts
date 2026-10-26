import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { publicAuthSecret } from "@/lib/domain/accounts/session";
import { isGithubNumericId } from "@/lib/github/repositories";

export const REPO_PROOF_TTL_MS = 30 * 60_000;
export type RepositoryProof = {
  version: 1; userId: number; productId: number; repoUrl: string;
  repoId: number; nodeId: string; ownerId: number; issuedAt: number; expiresAt: number; nonce: string;
};
type ProofIdentity = Pick<RepositoryProof, "userId" | "productId" | "repoUrl">;

function signature(payload: string): string {
  return createHmac("sha256", publicAuthSecret()).update(`maker-repo-file:v1:${payload}`).digest("base64url");
}

export function repositoryProofPath(productId: number, userId: number): string {
  return `.nomorevibe/claim-${productId}-${userId}.txt`;
}

export function signRepositoryProof(input: Omit<RepositoryProof, "version" | "issuedAt" | "expiresAt" | "nonce">, now = Date.now()): string {
  const proof: RepositoryProof = { version: 1, ...input, issuedAt: now, expiresAt: now + REPO_PROOF_TTL_MS, nonce: randomBytes(24).toString("base64url") };
  const payload = Buffer.from(JSON.stringify(proof)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

/** Expired issuance can only retain the same membership established while that issuance was valid. */
export function verifyRepositoryProof(token: unknown, identity: ProofIdentity, options: { now?: number; establishedAt?: Date } = {}): RepositoryProof | null {
  if (typeof token !== "string" || token.length > 2_048) return null;
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const expected = Buffer.from(signature(match[1]));
  const supplied = Buffer.from(match[2]);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  let proof: RepositoryProof;
  try { proof = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as RepositoryProof; } catch { return null; }
  if (!proof || proof.version !== 1 || proof.userId !== identity.userId || proof.productId !== identity.productId || proof.repoUrl !== identity.repoUrl
    || !Number.isSafeInteger(proof.userId) || proof.userId <= 0 || !Number.isSafeInteger(proof.productId) || proof.productId <= 0
    || !isGithubNumericId(proof.repoId) || !isGithubNumericId(proof.ownerId) || typeof proof.nodeId !== "string" || !proof.nodeId || proof.nodeId.length > 200
    || !Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt - proof.issuedAt !== REPO_PROOF_TTL_MS
    || typeof proof.nonce !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(proof.nonce)) return null;
  const validAt = options.establishedAt?.getTime() ?? options.now ?? Date.now();
  return proof.issuedAt <= validAt && proof.expiresAt > validAt ? proof : null;
}
