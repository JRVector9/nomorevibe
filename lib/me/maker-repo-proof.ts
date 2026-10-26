import { and, eq } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { productMakerMembers } from "@/lib/db/me-schema";
import { githubGraphql } from "@/lib/crawl/github";
import { PublicAuthError } from "@/lib/domain/accounts/errors";
import { isGithubNumericId } from "@/lib/github/repositories";
import { rateLimit } from "@/lib/rate-limit";
import { CLAIM_LOOKUPS_PER_HOUR, CLAIM_LOOKUPS_PER_USER_HOUR, lookupRepositoryOwner, productRepoRef, recordOwnerMembership,
  sameRepository, storedRepositoryAnchors, type ClaimProduct, type Lookup, type RepoOwnerFact } from "./maker-claims";
import { repositoryProofPath, signRepositoryProof, verifyRepositoryProof, type RepositoryProof } from "./repo-proof-token";

export type RepositoryProofChallenge = { token: string; path: string; expiresAt: string; repositoryUrl: string; editUrl: string };
type ReadProof = { kind: "found"; fact: RepoOwnerFact; isFork: boolean; proofText: string | null } | { kind: "missing" | "unavailable" };
const HOUR_MS = 60 * 60_000;
const PUBLIC_STATUSES = ["seeded", "verified"];
const failure = (code: string, status = 400): never => { throw new PublicAuthError(status, code); };

async function budget(userId: number): Promise<void> {
  if (!(await rateLimit(`maker:claims:github:user:${userId}`, CLAIM_LOOKUPS_PER_USER_HOUR, HOUR_MS))
    || !(await rateLimit("maker:claims:github", CLAIM_LOOKUPS_PER_HOUR, HOUR_MS))) failure("rate_limited", 429);
}

async function listedProduct(productId: number): Promise<ClaimProduct> {
  const [product] = await onPrimary(() => db.select({ id: products.id, slug: products.slug, name: products.name, status: products.status,
    repoUrl: products.repoUrl, repoRenamedTo: products.repoRenamedTo }).from(products).where(eq(products.id, productId)));
  if (!product || !PUBLIC_STATUSES.includes(product.status) || !productRepoRef(product.repoUrl)) return failure("product_not_found", 404);
  return product;
}

async function ownMembership(userId: number, productId: number) {
  const [row] = await onPrimary(() => db.select({ method: productMakerMembers.method, verifiedAt: productMakerMembers.verifiedAt, revokedAt: productMakerMembers.revokedAt }).from(productMakerMembers)
    .where(and(eq(productMakerMembers.productId, productId), eq(productMakerMembers.userId, userId))).limit(1));
  return row;
}

async function anchored(product: { id: number; slug: string; repoUrl: string }, fact: RepoOwnerFact): Promise<void> {
  if (fact.private) failure("repo_not_public", 403);
  const anchors = await storedRepositoryAnchors(product, productRepoRef(product.repoUrl)!);
  if (!anchors.length) failure("repo_unverified", 409);
  if (!anchors.every((anchor) => sameRepository(anchor, fact))) failure("repo_replaced", 409);
}

/** The ID identifies the historical repository. HEAD resolves its default branch, never a caller-selected ref or fork. */
export function repositoryProofQuery(nodeId: string, path: string): string {
  return `query { node(id: ${JSON.stringify(nodeId)}) { ... on Repository { id databaseId isPrivate isFork
    owner { __typename ... on User { databaseId } ... on Organization { databaseId } }
    defaultBranchRef { name target { ... on Commit { oid } } }
    proof: object(expression: ${JSON.stringify(`HEAD:${path}`)}) { ... on Blob { text byteSize isTruncated isBinary } }
  } } }`;
}

/**
 * Verified schema: https://docs.github.com/en/graphql/reference/repos#repository
 * and https://docs.github.com/en/graphql/reference/git#blob. Partial errors cannot grant access.
 */
export async function readRepositoryProof(nodeId: string, path: string, options: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<ReadProof> {
  const answer = await githubGraphql<{ node?: Record<string, unknown> | null }>(repositoryProofQuery(nodeId, path), options);
  if (!answer.ok || answer.errors.length) return { kind: "unavailable" };
  const node = answer.data?.node;
  if (!node) return { kind: "missing" };
  const owner = node.owner as { __typename?: unknown; databaseId?: unknown } | null;
  const branch = node.defaultBranchRef as { name?: unknown; target?: { oid?: unknown } | null } | null;
  if (node.id !== nodeId || !isGithubNumericId(node.databaseId) || typeof node.isPrivate !== "boolean" || typeof node.isFork !== "boolean"
    || !owner || !isGithubNumericId(owner.databaseId) || !["User", "Organization"].includes(String(owner.__typename))) return { kind: "unavailable" };
  const blob = node.proof as { text?: unknown; byteSize?: unknown; isTruncated?: unknown; isBinary?: unknown } | null;
  const usable = branch && typeof branch.name === "string" && branch.name && /^[a-f0-9]{40}$/.test(String(branch.target?.oid))
    && blob && typeof blob.text === "string" && typeof blob.byteSize === "number" && blob.byteSize <= 2_048 && blob.byteSize > 0
    && blob.isTruncated === false && blob.isBinary === false;
  return { kind: "found", isFork: node.isFork, fact: { repoId: node.databaseId, nodeId, ownerId: owner.databaseId,
    ownerType: String(owner.__typename), private: node.isPrivate }, proofText: usable ? (blob.text as string).trim() : null };
}

export async function startRepositoryProof(userId: number, productId: number, signal?: AbortSignal): Promise<RepositoryProofChallenge> {
  const product = await listedProduct(productId);
  const ref = productRepoRef(product.repoUrl)!;
  await budget(userId);
  const answer = await lookupRepositoryOwner(ref, { deadlineAt: Date.now() + 10_000, signal });
  if (answer.kind !== "found") return failure("github_unavailable", 503);
  await anchored({ ...product, repoUrl: product.repoUrl! }, answer.fact);
  const { repoId, nodeId, ownerId, defaultBranch } = answer.fact;
  if (!repoId || !nodeId || !defaultBranch) return failure("github_unavailable", 503);
  const token = signRepositoryProof({ userId, productId, repoUrl: product.repoUrl!, repoId, nodeId, ownerId });
  const proof = verifyRepositoryProof(token, { userId, productId, repoUrl: product.repoUrl! })!;
  const path = repositoryProofPath(productId, userId);
  return { token, path, expiresAt: new Date(proof.expiresAt).toISOString(), repositoryUrl: ref.url,
    editUrl: `${ref.url}/new/${encodeURIComponent(defaultBranch)}?${new URLSearchParams({ filename: path, value: `${token}\n` })}` };
}

function matchesRepository(proof: RepositoryProof, fact: RepoOwnerFact): boolean {
  return !fact.private && fact.repoId === proof.repoId && fact.nodeId === proof.nodeId && fact.ownerId === proof.ownerId;
}

export async function completeRepositoryProof(userId: number, productId: number, token: string, signal?: AbortSignal): Promise<{ result: "verified" | "already_verified"; slug: string }> {
  const product = await listedProduct(productId);
  const identity = { userId, productId, repoUrl: product.repoUrl! };
  const previous = await ownMembership(userId, productId);
  const active = previous && !previous.revokedAt;
  // Retrying the established file is a no-op. A newly issued replacement must be checked and renew verifiedAt.
  if (active && (previous.method !== "repo_file" || verifyRepositoryProof(token, identity, { establishedAt: previous.verifiedAt }))) {
    return { result: "already_verified", slug: product.slug };
  }
  const proof = verifyRepositoryProof(token, identity);
  if (!proof) return failure("repo_proof_invalid", 403);
  if (previous?.revokedAt && proof.issuedAt <= previous.revokedAt.getTime()) return failure("repo_proof_invalid", 403);
  await budget(userId);
  const answer = await readRepositoryProof(proof.nodeId, repositoryProofPath(productId, userId), { deadlineAt: Date.now() + 10_000, signal });
  if (answer.kind === "unavailable") return failure("github_unavailable", 503);
  if (answer.kind !== "found" || answer.isFork || !matchesRepository(proof, answer.fact)) return failure("repo_proof_repository_changed", 409);
  if (answer.proofText !== token) return failure("repo_proof_missing", 409);
  await anchored({ ...product, repoUrl: product.repoUrl! }, answer.fact);
  // The external lookup must not extend the issuance window.
  if (!verifyRepositoryProof(token, { userId, productId, repoUrl: product.repoUrl! })) return failure("repo_proof_invalid", 403);
  if (!(await recordOwnerMembership(product, userId, null, "repo_file", { issuedAt: proof.issuedAt, expiresAt: proof.expiresAt }))) return failure("product_not_found", 404);
  return { result: active ? "already_verified" : "verified", slug: product.slug };
}

/** Only called for an existing active repo_file row; expired issuance never establishes or revives membership. */
export async function recheckRepositoryProof(row: { productId: number; userId: number; slug: string; repoUrl: string | null; verifiedAt: Date },
  options: { lookup?: Lookup; deadlineAt: number; signal?: AbortSignal }): Promise<{ keep: true } | { keep: false; reason: string } | null> {
  const ref = productRepoRef(row.repoUrl);
  if (!ref || !row.repoUrl) return { keep: false, reason: "repo_changed" };
  const answer = await (options.lookup ?? lookupRepositoryOwner)(ref, { deadlineAt: Math.min(options.deadlineAt, Date.now() + 10_000), signal: options.signal });
  if (answer.kind === "unavailable") return null;
  if (answer.kind !== "found" || !answer.fact.nodeId) return { keep: false, reason: "repo_not_found" };
  const file = await readRepositoryProof(answer.fact.nodeId, repositoryProofPath(row.productId, row.userId), { deadlineAt: options.deadlineAt, signal: options.signal });
  if (file.kind === "unavailable") return null;
  if (file.kind !== "found" || file.isFork || !file.proofText) return { keep: false, reason: "repo_proof_missing" };
  const proof = verifyRepositoryProof(file.proofText, { userId: row.userId, productId: row.productId, repoUrl: row.repoUrl }, { establishedAt: row.verifiedAt });
  if (!proof || !matchesRepository(proof, file.fact)) return { keep: false, reason: "repo_proof_changed" };
  try { await anchored({ id: row.productId, slug: row.slug, repoUrl: row.repoUrl }, file.fact); }
  catch (error) { if (error instanceof PublicAuthError) return { keep: false, reason: error.code }; throw error; }
  return { keep: true };
}
