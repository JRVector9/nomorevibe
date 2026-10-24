import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { productRepoReviews } from "@/lib/db/schema";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { ASSIST_POLICY_VERSION, assistHash } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { lockProductGeneration } from "./generation";
import { repositoryMoveCandidate, repoMoveProtected, repoMoveSnapshotMatches } from "./repo-move-review";
import { readRepoMoveSnapshot } from "./repo-move-snapshots";
import { saveRepoReviewIn, type RepoReviewRecord, type RepoReviewTarget } from "./repo-reviews";
import type { RepoCheck, RepoReviewPage } from "./repo-review";

/** Save the existing human review and optional queue entry atomically; no HTTP/model work is added to the producer. */
export async function saveRepoMoveCandidate(target: RepoReviewTarget, record: RepoReviewRecord, oldRepository: RepoCheck,
  page: RepoReviewPage | null, related: readonly { key: string; check: RepoCheck }[], unchecked: readonly string[], lease?: JobLease): Promise<boolean> {
  return withJobLeaseWrite(lease, async tx => {
    await lockPipelineInputStages(tx);
    await tx.select({ id: productRepoReviews.productId }).from(productRepoReviews).where(eq(productRepoReviews.productId, target.id)).for("update");
    if (!await lockProductGeneration(tx, target.id, target.slug)) return false;
    const before = await readRepoMoveSnapshot(target.id, tx);
    if (!before || !repoMoveSnapshotMatches(target.snapshot, before)) return false;
    await saveRepoReviewIn(tx, record);
    const [control] = await tx.execute<{ mode: string; revision: number }>(sql`select mode,revision from llm_assist_controls where task='repo_move' for share`);
    if (!control || control.mode === "off" || repoMoveProtected(before)) return true;
    const snapshot = await readRepoMoveSnapshot(target.id, tx);
    if (!snapshot) return true;
    const candidate = repositoryMoveCandidate(snapshot, oldRepository, page, related, unchecked,
      new Date().toISOString());
    await tx.execute(sql`insert into llm_assist_work(id,task,product_id,origin_job,source_hash,source,policy_version,prompt_version,control_revision,priority)
      values(${randomUUID()},'repo_move',${target.id},'product-repo-review',${assistHash(candidate)},${JSON.stringify(candidate)}::jsonb,
        ${ASSIST_POLICY_VERSION},${ASSIST_PROMPT_VERSION},${control.revision},50)
      on conflict(task,product_id,source_hash) do nothing`);
    return true;
  });
}
