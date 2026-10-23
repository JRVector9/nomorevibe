import { and, eq, sql } from "drizzle-orm";
import { productEvidenceAudit, productRepoReviews, products } from "@/lib/db/schema";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { syncRepositoryLink } from "@/lib/domain/evidence/repository-link-sync";
import { assistHash, assistInputHash, type AssistOutcome } from "@/lib/domain/llm-assist/contracts";
import { assistPromptHash } from "@/lib/domain/llm-assist/prompts";
import { lockProductGeneration, type ProductTransaction } from "./generation";
import { findRepositoryProduct, lockProductRepository } from "./repository-identity";
import { repoGone, setStatusWithAudit } from "./repository";
import { REPO_GONE_AUTO_ACTOR, REPO_GONE_AUTO_REASON, repoGoneDailyLimitAvailable } from "./repo-reviews";
import { decideRepositoryMove, repoMoveCandidateSchema, repoMoveProtected, repoMoveSnapshotMatches,
  type RepoMoveCandidate, type RepoMoveInput } from "./repo-move-review";
import { repositoryKey, type RepoCheck } from "./repo-review";
import { readRepoMoveSnapshot } from "./repo-move-snapshots";
export { readRepoMoveSnapshot } from "./repo-move-snapshots";

export type FreshRepoMoveChecks = { oldRepository: RepoCheck; destination: RepoCheck; checkedAt: string };
export type RepoMoveApplyResult = "updated" | "delisted" | "candidate_only" | "protected" | "stale" | "daily_limit" | "human";

/** Shared dispatch calls this before acquiring a physical attempt; stale/protected work must never reach the model. */
export async function lockRepoMoveCandidate(tx: ProductTransaction, candidate: RepoMoveCandidate): Promise<boolean> {
  await lockPipelineInputStages(tx);
  await tx.select({ id: productRepoReviews.productId }).from(productRepoReviews)
    .where(eq(productRepoReviews.productId, candidate.snapshot.id)).for("update");
  if (!await lockProductGeneration(tx, candidate.snapshot.id, candidate.snapshot.slug)) return false;
  const current = await readRepoMoveSnapshot(candidate.snapshot.id, tx);
  return current !== null && repoMoveSnapshotMatches(candidate.snapshot, current) && !repoMoveProtected(current);
}

/** Caller owns the common result transaction. Model output is never itself write authority. */
export async function applyRepoMoveResult(tx: ProductTransaction, value: RepoMoveCandidate, input: RepoMoveInput,
  outcome: AssistOutcome, binding: { resultId: string; workId: string }, fresh: FreshRepoMoveChecks): Promise<RepoMoveApplyResult> {
  const candidate = repoMoveCandidateSchema.parse(value);
  const decision = decideRepositoryMove(candidate, input, outcome);
  if (decision.kind === "human" || decision.kind === "collect_evidence") return "human";
  const { snapshot } = candidate;
  // The result row is inserted before this call and committed with the product write and audit.
  const [authorization] = await tx.execute<{ mode: string; dispatch: boolean; apply: boolean; control_revision: number;
    current_revision: number; input_hash: string; prompt_hash: string; source_hash: string; policy_version: string;
    prompt_version: string; input: unknown; source: unknown; outcome: unknown; applied: boolean }>(sql`
    select c.mode,c.dispatch_enabled dispatch,c.apply_enabled apply,w.control_revision,c.revision current_revision,
      r.input_hash,r.prompt_hash,w.source_hash,w.policy_version,w.prompt_version,w.input,w.source,r.outcome,r.applied
    from llm_assist_results r join llm_assist_work w on w.id=r.work_id join llm_assist_controls c on c.task=w.task
    where r.id=${binding.resultId} and w.id=${binding.workId} and w.task='repo_move' and w.product_id=${snapshot.id}
      and r.work_revision=w.revision and r.capacity_request_id=w.capacity_request_id
      and w.input_hash=r.input_hash and w.state='claimed' for update of r for share of c`);
  if (!authorization || authorization.applied || authorization.input_hash !== assistInputHash(input)
    || authorization.prompt_hash !== assistPromptHash("repo") || assistHash(authorization.source) !== assistHash(candidate)
    || authorization.source_hash !== assistHash(candidate) || authorization.policy_version !== input.policyVersion
    || authorization.prompt_version !== input.promptVersion || assistHash(authorization.input) !== assistHash(input)
    || assistHash(authorization.outcome) !== assistHash(outcome)) return "stale";
  if (authorization.mode !== "confirm" || !authorization.dispatch || !authorization.apply
    || Number(authorization.control_revision) !== Number(authorization.current_revision)) return "candidate_only";
  const ageMs = Date.now() - Date.parse(fresh.checkedAt);
  if (!Number.isFinite(ageMs) || ageMs < -5_000 || ageMs > 60_000 || fresh.destination.state !== "alive"
    || assistHash(fresh.oldRepository) !== assistHash(candidate.oldRepository)) return "stale";

  await lockPipelineInputStages(tx);
  if (decision.kind === "update_repo_candidate") await lockProductRepository(tx, decision.url);
  // Match the existing operator review order: review row, then lifecycle/product lock.
  await tx.select({ id: productRepoReviews.productId }).from(productRepoReviews).where(eq(productRepoReviews.productId, snapshot.id)).for("update");
  if (!await lockProductGeneration(tx, snapshot.id, snapshot.slug)) return "stale";
  const current = await readRepoMoveSnapshot(snapshot.id, tx);
  if (!current || !repoMoveSnapshotMatches(snapshot, current)) return "stale";
  if (repoMoveProtected(current)) return "protected";
  const audit = { workId: binding.workId, resultId: binding.resultId, sourceHash: assistHash(candidate), inputHash: assistInputHash(input),
    previousRepositoryUrl: snapshot.repoUrl, previousRepoLinkVersion: snapshot.repoLinkVersion, previousUpdatedAt: snapshot.updatedAt,
    previousRepoCheckedAt: snapshot.repoCheckedAt, repositoryChecks: fresh };
  if (decision.kind === "unrelated_candidate") {
    const [row] = await tx.select({ gone: sql<boolean>`${repoGone}` }).from(products).where(eq(products.id, snapshot.id));
    if (!row?.gone || fresh.oldRepository.state !== "gone") return "stale";
    if (!await repoGoneDailyLimitAvailable(tx)) return "daily_limit";
    if (!await setStatusWithAudit({ id: snapshot.id, slug: snapshot.slug, status: "banned", action: "admin.product.ban",
      actor: REPO_GONE_AUTO_ACTOR, reason: REPO_GONE_AUTO_REASON, metadata: { ...audit, relationship: "unrelated" } }, tx)) return "stale";
    await tx.update(productRepoReviews).set({ decision: "delist_candidate", reason: "repo_unrelated", reviewedAt: sql`clock_timestamp()`,
      operatorDecision: "delist", operatorBy: REPO_GONE_AUTO_ACTOR, operatorAt: sql`clock_timestamp()`, nextReviewAt: null })
      .where(eq(productRepoReviews.productId, snapshot.id));
    return "delisted";
  }

  // An installable product uses repoUrl as its public identity too. That requires a separate URL/health migration policy.
  if (snapshot.accessMode !== "website") return "candidate_only";
  const duplicate = await findRepositoryProduct(repositoryKey(decision.url)!, null, tx);
  if (duplicate && duplicate.id !== snapshot.id) return "human";
  const link = await syncRepositoryLink({ productId: snapshot.id, slug: snapshot.slug, repoUrl: decision.url, declarationSource: "discovered", mode: "explicit" }, tx);
  if (link.action === "preserved_hidden" || link.action === "review_required") return "human";
  const [updated] = await tx.update(products).set({ repoUrl: decision.url, stars: null, starsAt: null, starsPrevious: null,
    starsPreviousAt: null, ownerType: null, starsCheckedAt: null, repoStatus: null, repoCheckedAt: null, repoMissingSince: null,
    repoArchived: null, repoPushedAt: null, repoRenamedTo: null, repoChangedAt: null, aiLevel: null, updatedAt: sql`clock_timestamp()` })
    .where(and(eq(products.id, snapshot.id), eq(products.repoUrl, snapshot.repoUrl), eq(products.repoLinkVersion, snapshot.repoLinkVersion),
      sql`${products.updatedAt}::text=${snapshot.updatedAt}`, eq(products.url, snapshot.url))).returning({ id: products.id });
  if (!updated) throw new Error("repo_move_locked_compare_and_swap_failed");
  await tx.delete(productRepoReviews).where(eq(productRepoReviews.productId, snapshot.id));
  await tx.insert(productEvidenceAudit).values({ slug: snapshot.slug, actor: "auto:repo-move", action: "product.repository.move",
    reason: "official_repository_move", metadata: { ...audit, nextRepositoryUrl: decision.url, officialEvidenceHash: decision.officialEvidenceHash } });
  return "updated";
}
