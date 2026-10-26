import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPO_PROOF_TTL_MS, repositoryProofPath, signRepositoryProof, verifyRepositoryProof } from "@/lib/me/repo-proof-token";
import { repositoryProofQuery } from "@/lib/me/maker-repo-proof";

const now = Date.parse("2026-10-26T00:00:00Z");
const identity = { userId: 7, productId: 12, repoUrl: "https://github.com/acme/tool" };
const input = { ...identity, repoId: 1234, nodeId: "R_immutable1234", ownerId: 900 };
beforeEach(() => vi.stubEnv("PUBLIC_AUTH_SECRET", "repo-proof-unit-secret-at-least-32-characters"));
afterEach(() => vi.unstubAllEnvs());

describe("signed repository file proof", () => {
  it("binds a random 30-minute challenge to the actor, product, repository URL and immutable IDs", () => {
    const token = signRepositoryProof(input, now);
    expect(verifyRepositoryProof(token, identity, { now })).toMatchObject({ ...input, version: 1, issuedAt: now, expiresAt: now + REPO_PROOF_TTL_MS });
    expect(signRepositoryProof(input, now)).not.toBe(token);
    expect(repositoryProofPath(12, 7)).toBe(".nomorevibe/claim-12-7.txt");
    for (const target of [{ ...identity, userId: 8 }, { ...identity, productId: 13 }, { ...identity, repoUrl: "https://github.com/acme/replaced" }]) {
      expect(verifyRepositoryProof(token, target, { now })).toBeNull();
    }
  });

  it("rejects edits, malformed tokens, rotated secrets, expiry and future issuance", () => {
    const token = signRepositoryProof(input, now);
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), userId: 8 })).toString("base64url");
    expect(verifyRepositoryProof(`${forged}.${signature}`, { ...identity, userId: 8 }, { now })).toBeNull();
    for (const invalid of [null, {}, "", `${token}.extra`, "x".repeat(2049), `${payload}.${"A".repeat(43)}`]) expect(verifyRepositoryProof(invalid, identity, { now })).toBeNull();
    expect(verifyRepositoryProof(token, identity, { now: now - 1 })).toBeNull();
    expect(verifyRepositoryProof(token, identity, { now: now + REPO_PROOF_TTL_MS })).toBeNull();
    vi.stubEnv("PUBLIC_AUTH_SECRET", "rotated-repo-proof-secret-at-least-32-characters");
    expect(verifyRepositoryProof(token, identity, { now })).toBeNull();
  });

  it("only permits expired issuance to retain the same membership verified during its valid window", () => {
    const token = signRepositoryProof(input, now);
    expect(verifyRepositoryProof(token, identity, { now: now + 31 * 86_400_000 })).toBeNull();
    expect(verifyRepositoryProof(token, identity, { now: now + 31 * 86_400_000, establishedAt: new Date(now + 1000) })).not.toBeNull();
    expect(verifyRepositoryProof(token, identity, { establishedAt: new Date(now - 1) })).toBeNull();
    expect(verifyRepositoryProof(token, identity, { establishedAt: new Date(now + REPO_PROOF_TTL_MS) })).toBeNull();
    expect(verifyRepositoryProof(token, { ...identity, userId: 8 }, { establishedAt: new Date(now + 1000) })).toBeNull();
  });

  it("reads only the bound repository node and its default branch HEAD, without accepting a caller ref or mutable repository name", () => {
    const query = repositoryProofQuery(input.nodeId, repositoryProofPath(12, 7));
    expect(query).toContain('node(id: "R_immutable1234")');
    expect(query).toContain('object(expression: "HEAD:.nomorevibe/claim-12-7.txt")');
    expect(query).toContain("defaultBranchRef");
    expect(query).toContain("isFork");
    expect(query).not.toContain("repository(owner:");
  });
});
