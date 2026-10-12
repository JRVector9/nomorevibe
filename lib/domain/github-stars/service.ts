import { eq } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products } from "@/lib/db/schema";
import type { GithubStarOperation } from "@/lib/db/github-star-schema";
import { PublicAuthError } from "@/lib/domain/accounts/request-auth";
import { requireGithubStarEnabled } from "@/lib/domain/github-user/config";
import { getGithubUserCredential, markGithubUserNeedsReconnect } from "@/lib/domain/github-user/credentials";
import { githubRequest } from "@/lib/github/client";
import { githubRepositoryPath, parseGithubRepository, parseGithubRepositoryResponse } from "@/lib/github/repositories";
import { parseStarWrite, StarProviderRateLimit, StarWriteFailure, starStateFromRead, type GithubStarState, type StarView } from "./contract";
import { claimStarWrite, knownStarRepositoryId, loadStarOperation, recordStarObservation, replayStarResponse, savedStarResponse, settleStarWrite, starCredentialIsCurrent, starView, type StarTarget } from "./repository";

type Credential = Awaited<ReturnType<typeof getGithubUserCredential>>;
function completedResponse(view: StarView): StarView {
  if (view.failure) throw new StarWriteFailure(view);
  return view;
}
async function resolveTarget(slug: string, userId: number): Promise<{ target: StarTarget; credential: Credential }> {
  requireGithubStarEnabled();
  const [product] = await onPrimary(() => db.select({ id: products.id, repoUrl: products.repoUrl, status: products.status }).from(products).where(eq(products.slug, slug)).limit(1));
  if (!product) throw new PublicAuthError(404, "product_not_found");
  if (product.status === "banned") throw new PublicAuthError(403, "product_unavailable");
  const name = product.repoUrl && parseGithubRepository(product.repoUrl);
  if (!name) throw new PublicAuthError(400, "star_repository_unsupported");
  const credential = await getGithubUserCredential(userId);
  let expectedId = await knownStarRepositoryId(userId, product.id, product.repoUrl!);
  let result = await githubRequest({ path: githubRepositoryPath(name), token: credential.token });
  // Existing identity wins; first visits accept only a checked GitHub API numeric destination.
  if (result.outcome === "confirmed_rejection" && result.code === "github_redirect") {
    expectedId ??= result.redirectRepositoryId;
    if (expectedId !== undefined) result = await githubRequest({ path: `/repositories/${expectedId}`, token: credential.token });
  }
  if (result.outcome !== "confirmed_success") {
    if (result.outcome === "confirmed_rejection" && result.code === "github_rate_limited") throw new StarProviderRateLimit(result.retryAt);
    if (result.status === 401) {
      await markGithubUserNeedsReconnect(userId, credential.revision);
      throw new PublicAuthError(409, "github_needs_reconnect");
    }
    throw new PublicAuthError(503, "star_repository_unavailable");
  }
  const repository = parseGithubRepositoryResponse(result.data, expectedId);
  if (!repository) throw new PublicAuthError(409, "star_repository_changed");
  if (expectedId === undefined && repository.fullName.toLowerCase() !== name.fullName.toLowerCase()) throw new PublicAuthError(409, "star_repository_changed");
  if (repository.private) throw new PublicAuthError(403, "star_public_repository_required");
  return { target: { productId: product.id, productRepoUrl: product.repoUrl!, repositoryId: repository.id, owner: repository.owner, repo: repository.repo }, credential };
}

async function observe(userId: number, target: StarTarget, credential: Credential, row: GithubStarOperation): Promise<GithubStarOperation> {
  if (row.leaseOwner || (row.state === "unknown" && row.desiredStarred !== null && row.reconcileAfter && row.reconcileAfter.getTime() > Date.now())) return row;
  const result = await githubRequest({ path: `/user/starred/${target.owner}/${target.repo}`, token: credential.token });
  if (result.outcome === "confirmed_rejection" && result.code === "github_rate_limited") throw new StarProviderRateLimit(result.retryAt);
  const state = starStateFromRead(result);
  if (state === "needs_reconnect") await markGithubUserNeedsReconnect(userId, credential.revision);
  return recordStarObservation(userId, target, row.revision, state);
}

export async function getGithubStarStatus(slug: string, userId: number): Promise<StarView> {
  const { target, credential } = await resolveTarget(slug, userId);
  return starView(await observe(userId, target, credential, await loadStarOperation(userId, target)));
}

export async function writeGithubStar(slug: string, userId: number, value: unknown): Promise<StarView> {
  requireGithubStarEnabled();
  const input = parseStarWrite(value);
  const replay = await replayStarResponse(slug, userId, input);
  if (replay) return completedResponse(replay);
  const { target, credential } = await resolveTarget(slug, userId);
  const saved = await savedStarResponse(userId, target, input);
  if (saved) return completedResponse(saved);
  let row = await loadStarOperation(userId, target);
  if (!row.leaseOwner && row.desiredStarred === null && row.revision !== input.expectedRevision) throw new PublicAuthError(409, "star_revision_conflict");
  if (!row.leaseOwner && row.desiredStarred === null) row = await observe(userId, target, credential, row);
  // An unavailable observation cannot authorize an opposite-state write.
  if (row.state === "unknown" && row.desiredStarred === null) throw new PublicAuthError(409, "star_state_unknown");
  if (row.state === "needs_reconnect") throw new PublicAuthError(409, "github_needs_reconnect");
  const claim = await claimStarWrite(userId, target, input, credential);
  if (claim.kind === "error") throw new PublicAuthError(409, claim.code);
  if (claim.kind === "complete") return completedResponse(claim.response);
  if (!await starCredentialIsCurrent(userId, credential)) {
    await settleStarWrite(userId, target, claim, "needs_reconnect");
    throw new PublicAuthError(409, "github_needs_reconnect");
  }
  const result = await githubRequest({ path: `/user/starred/${target.owner}/${target.repo}`, method: input.starred ? "PUT" : "DELETE", token: credential.token });
  let state: GithubStarState = "unknown";
  let failure: StarView["failure"];
  if (result.outcome === "confirmed_success" && result.status === 204) state = input.starred ? "starred" : "unstarred";
  else if (result.outcome === "confirmed_rejection") {
    state = result.status === 401 ? "needs_reconnect" : claim.previousState;
    if (state === "needs_reconnect") await markGithubUserNeedsReconnect(userId, credential.revision);
    else failure = { status: result.code === "github_rate_limited" ? 429 : 502, code: result.code === "github_rate_limited" ? "star_rate_limited" : "star_write_rejected" };
  }
  let response: StarView;
  try {
    response = await settleStarWrite(userId, target, claim, state, result.retryAt, failure);
  } catch {
    // The upstream write may have succeeded. The retained lease fences further writes.
    throw new PublicAuthError(503, "star_result_uncertain");
  }
  return completedResponse(response);
}
