import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { secondReviews, secondReviewWorkloadAssignments, type SecondReview, type SecondReviewWorkloadAssignment } from '@/lib/db/schema';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import type { AiTaskExecutionConfig, AiTaskPoolSelection } from '@/lib/llm/ai-task-execution-config';
import { readAiTaskExecutionConfig } from '@/lib/llm/ai-task-execution-snapshot';
import { taskModels } from '@/lib/llm/ai-task-resolver';
import { chooseTaskWorkloadMember } from '@/lib/llm/ai-task-workload-selector';
import { bindReviewTaskRank, resolveReviewTaskRanks, reviewRouteContracts, reviewTaskRanksPinned, settingsReviewersActive, type ReviewRankCandidate, type ReviewRankReviewer } from './review-task-ranks';
import { underlyingReviewModel, reviewIndependenceKey, sameReviewModel, sameReviewIndependence } from './review-model-identity';
import { reviewIndependenceSql } from './held-qwen-retry-policy';

export type SecondReviewWorkloadSlot = Readonly<{
  slot: number; config: AiTaskExecutionConfig; candidates: readonly ReviewRankCandidate[];
  legacy: readonly ReviewRankCandidate[];
}>;
/** Slot count stays three at most. Pool alternatives are NEVER additional voter slots. */
export function secondReviewWorkloadSlots(): SecondReviewWorkloadSlot[] {
  return [1, 2, 3].map(slot => ({ slot, config: readAiTaskExecutionConfig('second-review', slot),
    candidates: resolveReviewTaskRanks('second-review', slot).candidates,
    legacy: taskModels('second-review', slot).map(rank => bindReviewTaskRank('second-review', rank)),
  }));
}
export function secondReviewHasWorkloadPool(): boolean {
  if (settingsReviewersActive() || reviewTaskRanksPinned()) return false;
  const slots = secondReviewWorkloadSlots(), pooled = slots.filter(slot => slot.config.mode === 'workload_pool');
  if (!pooled.length) return false;
  if (pooled.length !== 1 || pooled[0].slot !== 1 || slots.some(slot => slot.slot > 1 && slot.legacy.length))
    throw new ModelCapacityDeferredError('assignments_unavailable');
  return true;
}
const reviewer = (candidate: ReviewRankCandidate): ReviewRankReviewer | null => candidate.binding
  ? { provider: candidate.binding.provider, model: candidate.binding.identity } : null;
/** Compatibility representatives provide one template per slot, including untouched legacy pending votes. */
export function secondReviewSlotRepresentatives(): { voters: ReviewRankReviewer[]; fallbacks: ReviewRankReviewer[] } {
  const voters: ReviewRankReviewer[] = [], fallbacks: ReviewRankReviewer[] = [];
  for (const slot of secondReviewWorkloadSlots()) {
    const legacyPrimary = slot.legacy.find(candidate => candidate.binding && !candidate.unusable);
    const primary = legacyPrimary ?? (slot.config.mode === 'workload_pool'
      ? slot.candidates.find(candidate => candidate.binding && !candidate.unusable) : undefined);
    if (primary) voters.push(reviewer(primary)!);
    fallbacks.push(...slot.legacy.filter(candidate => candidate !== legacyPrimary && candidate.binding).map(candidate => reviewer(candidate)!));
  }
  return { voters, fallbacks };
}
export async function secondReviewAssignmentMap(tx: Pick<ProductTransaction, 'select'>, rows: readonly Pick<SecondReview, 'id' | 'fallbackForId'>[]): Promise<Map<number, SecondReviewWorkloadAssignment>> {
  if (!rows.length || !secondReviewHasWorkloadPool()) return new Map();
  const ids = [...new Set(rows.flatMap(row => [row.id, ...(row.fallbackForId ? [row.fallbackForId] : [])]))];
  const assignments = await tx.select().from(secondReviewWorkloadAssignments)
    .where(inArray(secondReviewWorkloadAssignments.secondReviewId, ids));
  return new Map(assignments.map(assignment => [assignment.secondReviewId, assignment]));
}
/** Membership only. All source/generation/ownership/pending/dissent gates remain at their original call sites. */
export function secondReviewWorkloadMembership(row: Pick<SecondReview, 'provider' | 'model' | 'fallbackForId'>,
  assignment?: SecondReviewWorkloadAssignment | null): boolean {
  const slots = secondReviewWorkloadSlots();
  if (!assignment) return slots.some(slot => {
    const primary = slot.legacy.find(candidate => candidate.binding && !candidate.unusable);
    return slot.legacy.some(candidate => candidate.binding && (row.fallbackForId ? candidate !== primary : candidate === primary)
      && candidate.binding.provider === row.provider && sameReviewModel(candidate.binding.identity, row.model));
  });
  const slot = slots.find(slot => slot.slot === assignment.taskSlot);
  if (!slot || slot.config.mode !== 'workload_pool' || slot.config.revision === null
    || assignment.configRevision > slot.config.revision) return false;
  if (row.fallbackForId) {
    const primary = slot.legacy.find(candidate => candidate.binding && !candidate.unusable);
    return slot.legacy.some(candidate => candidate !== primary && candidate.binding
      && candidate.binding.provider === row.provider && sameReviewModel(candidate.binding.identity, row.model));
  }
  return slot.candidates.some(candidate => candidate.binding && candidate.poolMember?.memberId === assignment.memberId
    && candidate.poolMember.canonicalModel === assignment.canonicalModel
    && candidate.binding.provider === row.provider && sameReviewModel(candidate.binding.identity, row.model));
}
const OPAQUE_MODEL = /^(?:auto|supa)$/i;
function modelCanonical(task: 'first-review' | 'second-review', model: string): string | null {
  const candidate = resolveReviewTaskRanks(task).candidates.find(candidate => sameReviewModel(candidate.binding?.identity, model));
  const contract = reviewRouteContracts(task === 'first-review' ? 'crawl-agent-review' : 'second-review')
    .find(entry => sameReviewModel(entry.row.model, model));
  const metadata = contract?.row.contract;
  const responseModel = metadata && typeof metadata === 'object' && 'responseModel' in metadata && typeof metadata.responseModel === 'string'
    ? metadata.responseModel : null;
  const canonical = candidate?.poolMember?.canonicalModel;
  const value = canonical && !OPAQUE_MODEL.test(underlyingReviewModel(canonical)) ? canonical
    : responseModel ?? candidate?.binding?.engineModel ?? model;
  // A routing alias without observed canonical metadata cannot establish an independent vote.
  return OPAQUE_MODEL.test(underlyingReviewModel(value)) ? null : reviewIndependenceKey(value);
}
export function secondReviewFirstCanonical(model: string | null): string | null {
  return model ? modelCanonical('first-review', model) : '';
}
export function secondReviewPoolHasIndependentMember(firstModel: string | null): boolean {
  const first = secondReviewFirstCanonical(firstModel);
  return first !== null && secondReviewWorkloadSlots()[0].candidates.some(candidate => {
    const canonical = candidate.binding ? modelCanonical('second-review', candidate.binding.identity) : null;
    return canonical !== null && canonical !== first;
  });
}
export async function chooseSecondReviewWorkloadSlot(slot: SecondReviewWorkloadSlot, tx: ProductTransaction,
  excludedCanonical: ReadonlySet<string>): Promise<(ReviewRankReviewer & { selection: AiTaskPoolSelection; canonicalModel: string }) | null> {
  const candidates = slot.candidates.flatMap(candidate => {
    const binding = candidate.binding, member = candidate.poolMember;
    const canonical = binding ? modelCanonical('second-review', binding.identity) : null;
    if (!binding || !member || candidate.unusable || canonical === null || excludedCanonical.has(canonical)) return [];
    return [{ memberId: member.memberId, routeId: binding.routeId, connectionId: binding.connectionId,
      engineModel: binding.engineModel, provider: binding.provider, identity: binding.identity, deviceId: binding.deviceId }];
  });
  const chosen = await chooseTaskWorkloadMember(slot.config, candidates, { executor: tx });
  if (!chosen) return null;
  const member = slot.config.members.find(member => member.memberId === chosen.memberId)!;
  return { provider: chosen.provider as ReviewRankReviewer['provider'], model: chosen.identity,
    selection: chosen.poolSelection, canonicalModel: member.canonicalModel };
}
/** Single-voter pool: no pool member becomes an extra quorum slot. */
export function secondReviewPoolRequiredSql(firstModel: SQL): SQL {
  const slot = secondReviewWorkloadSlots()[0];
  const available = [...new Set(slot.candidates.flatMap(candidate => {
    const canonical = candidate.binding ? modelCanonical('second-review', candidate.binding.identity) : null;
    return canonical === null ? [] : [canonical];
  }))];
  return sql`CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(available)}::jsonb) m(model)
    WHERE m.model <> ${firstReviewIndependenceSql(firstModel)}) THEN 1 ELSE 0 END`;
}
export function firstReviewIndependenceSql(model: SQL): SQL {
  const identities = resolveReviewTaskRanks('first-review').candidates.flatMap(candidate => candidate.binding ? [{
    model: candidate.binding.identity, key: secondReviewFirstCanonical(candidate.binding.identity),
  }] : []);
  return sql`CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(identities)}::jsonb) m
      WHERE m->>'model' = ${model})
    THEN (SELECT m->>'key' FROM jsonb_array_elements(${JSON.stringify(identities)}::jsonb) m WHERE m->>'model' = ${model} LIMIT 1)
    WHEN lower(coalesce(${model}, '')) IN ('supa', 'auto') THEN NULL
    ELSE ${reviewIndependenceSql(model)} END`;
}
const sameNameSql = (name: SQL) => sql`regexp_replace(regexp_replace(lower(trim(${name})), '@[0-9a-f]{8}$', ''), '^\\[mlx\\][[:space:]]*', '', 'i')`;
export function secondReviewPoolRootMembershipSql(root: SQL): SQL {
  const slot = secondReviewWorkloadSlots()[0];
  const members = slot.candidates.flatMap(candidate => candidate.binding && candidate.poolMember ? [{
    id: candidate.poolMember.memberId, canonical: candidate.poolMember.canonicalModel,
    provider: candidate.binding.provider, model: candidate.binding.identity,
  }] : []);
  const legacy = slot.legacy.find(candidate => candidate.binding && !candidate.unusable)?.binding;
  return sql`(EXISTS (SELECT 1 FROM second_review_workload_assignments a,
      jsonb_array_elements(${JSON.stringify(members)}::jsonb) m
      WHERE a.second_review_id = ${root}.id AND a.task_slot = 1 AND a.config_revision <= ${slot.config.revision}
        AND a.member_id::text = m->>'id' AND a.canonical_model = m->>'canonical'
        AND ${root}.provider = m->>'provider' AND ${sameNameSql(sql`${root}.model`)} = ${sameNameSql(sql`m->>'model'`)})
    OR (${Boolean(legacy)} AND NOT EXISTS (SELECT 1 FROM second_review_workload_assignments a WHERE a.second_review_id = ${root}.id)
      AND ${root}.provider IS NOT DISTINCT FROM ${legacy?.provider ?? null}
      AND ${sameNameSql(sql`${root}.model`)} IS NOT DISTINCT FROM ${sameNameSql(sql`${legacy?.identity ?? null}`)}))`;
}
/** SQL discovery must match the controller membership; valid completed pool votes are not cleanup work. */
export function secondReviewPoolMembershipSql(row: SQL): SQL {
  const slot = secondReviewWorkloadSlots()[0];
  const primary = slot.legacy.find(candidate => candidate.binding && !candidate.unusable);
  const fallbacks = slot.legacy.flatMap(candidate => candidate !== primary && candidate.binding
    ? [{ provider: candidate.binding.provider, model: candidate.binding.identity }] : []);
  return sql`CASE WHEN ${row}.fallback_for_id IS NULL THEN ${secondReviewPoolRootMembershipSql(row)}
    ELSE EXISTS (SELECT 1 FROM second_reviews workload_root
      WHERE workload_root.id = ${row}.fallback_for_id AND workload_root.fallback_for_id IS NULL
        AND workload_root.candidate_id = ${row}.candidate_id AND workload_root.generation_key = ${row}.generation_key
        AND workload_root.input_hash = ${row}.input_hash AND workload_root.status = 'resolved' AND workload_root.resolution = 'fallback'
        AND ${secondReviewPoolRootMembershipSql(sql`workload_root`)}
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(fallbacks)}::jsonb) f
          WHERE f->>'provider' = ${row}.provider AND ${sameNameSql(sql`f->>'model'`)} = ${sameNameSql(sql`${row}.model`)})) END`;
}
export function secondReviewPoolRootExistsSql(candidateId: SQL, firstAttemptId: SQL, inputHash: SQL, trigger?: string): SQL {
  return sql`EXISTS (SELECT 1 FROM second_reviews wr
    WHERE wr.candidate_id = ${candidateId} AND wr.first_attempt_id IS NOT DISTINCT FROM ${firstAttemptId}
      AND wr.input_hash = ${inputHash} AND wr.fallback_for_id IS NULL
      ${trigger ? sql`AND wr.trigger = ${trigger}` : sql``}
      AND ${secondReviewPoolRootMembershipSql(sql`wr`)})`;
}
/** Called in the existing candidate-locked enqueue transaction only. */
export async function insertSecondReviewWorkloadRows(tx: ProductTransaction,
  proposed: readonly (typeof secondReviews.$inferInsert)[]) {
  if (!proposed.length) return [];
  if (!secondReviewHasWorkloadPool()) return tx.insert(secondReviews).values([...proposed]).onConflictDoNothing().returning();
  const slot = secondReviewWorkloadSlots()[0], grouped = new Map<string, typeof proposed[number]>();
  for (const row of proposed) grouped.set(JSON.stringify([row.candidateId, row.generationKey, row.inputHash, row.trigger, row.publishedSlug ?? null]), row);
  const inserted: (typeof secondReviews.$inferSelect)[] = [];
  for (const base of grouped.values()) {
    const existing = await tx.select().from(secondReviews).where(and(eq(secondReviews.candidateId, base.candidateId),
      base.publishedSlug ? eq(secondReviews.publishedSlug, base.publishedSlug)
        : and(eq(secondReviews.generationKey, base.generationKey ?? 'legacy'), eq(secondReviews.inputHash, base.inputHash))));
    const assignments = await secondReviewAssignmentMap(tx, existing);
    if (existing.some(row => !row.fallbackForId && secondReviewWorkloadMembership(row, assignments.get(row.id))
      && !(row.status === 'resolved' && ['superseded', 'model_removed', 'not_required'].includes(row.resolution ?? '')))) continue;
    const first = secondReviewFirstCanonical(base.firstModel ?? null);
    if (first === null) continue;
    const excluded = new Set(first ? [first] : []);
    // The existing per-model unique key also applies to closed rows of this exact generation.
    for (const row of existing) if (row.generationKey === base.generationKey && row.inputHash === base.inputHash && row.model) {
      const member = slot.candidates.find(candidate => sameReviewModel(candidate.binding?.identity, row.model));
      if (member?.binding) {
        const canonical = modelCanonical('second-review', member.binding.identity);
        if (canonical !== null) excluded.add(canonical);
      }
    }
    const selected = await chooseSecondReviewWorkloadSlot(slot, tx, excluded);
    if (!selected) continue;
    const [row] = await tx.insert(secondReviews).values({ ...base, provider: selected.provider, model: selected.model })
      .onConflictDoNothing().returning();
    if (!row) continue;
    await tx.insert(secondReviewWorkloadAssignments).values({ secondReviewId: row.id, taskSlot: 1,
      configRevision: selected.selection.configRevision, memberId: selected.selection.memberId, canonicalModel: selected.canonicalModel });
    inserted.push(row);
  }
  return inserted;
}

export function secondReviewVoteIndependent(firstModel: string | null, model: string | null,
  assignment?: SecondReviewWorkloadAssignment | null, fallback = false): boolean {
  if (!firstModel || !model) return true;
  if (!assignment) return !sameReviewIndependence(firstModel, model);
  const first = secondReviewFirstCanonical(firstModel), actual = fallback
    ? modelCanonical('second-review', model) : secondReviewAssignedVoteCanonical(model, assignment);
  return first !== null && actual !== null && first !== actual;
}

/** Exact slot1 publication gate. Pool members provide alternatives for ONE required vote. */
export function secondReviewPoolApprovedSql(attempt: { id: SQL; model: SQL }): SQL {
  const legacy = secondReviewWorkloadSlots()[0].legacy;
  const primary = legacy.find(candidate => candidate.binding && !candidate.unusable);
  const fallbacks = legacy.flatMap(candidate => candidate !== primary && candidate.binding
    ? [{ provider: candidate.binding.provider, model: candidate.binding.identity }] : []);
  const roots = secondReviewPoolRootMembershipSql(sql`wr`);
  const models = [...new Set([...secondReviewWorkloadSlots()[0].candidates.flatMap(candidate => candidate.binding
    ? [candidate.binding.identity] : []), ...reviewRouteContracts('second-review').map(entry => entry.row.model)])]
    .map(model => ({ model, key: modelCanonical('second-review', model) }));
  const actual = sql`CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(models)}::jsonb) m WHERE m->>'model' = g.model)
    THEN (SELECT m->>'key' FROM jsonb_array_elements(${JSON.stringify(models)}::jsonb) m WHERE m->>'model' = g.model LIMIT 1)
    WHEN lower(coalesce(g.model, '')) IN ('supa', 'auto') THEN NULL ELSE ${reviewIndependenceSql(sql`g.model`)} END`;
  return sql`(EXISTS (SELECT 1 FROM second_reviews g JOIN second_reviews wr ON wr.id = coalesce(g.fallback_for_id, g.id)
      LEFT JOIN second_review_workload_assignments wa ON wa.second_review_id = wr.id
      WHERE g.first_attempt_id = ${attempt.id} AND g.trigger = 'ai_approved' AND g.status = 'agreed' AND g.second_decision = 'approve'
        AND wr.fallback_for_id IS NULL AND wr.first_attempt_id = g.first_attempt_id AND wr.candidate_id = g.candidate_id
        AND wr.trigger = g.trigger AND wr.generation_key = g.generation_key AND wr.input_hash = g.input_hash
        AND ${roots} AND (CASE WHEN wa.second_review_id IS NULL THEN ${reviewIndependenceSql(sql`g.model`)}
          ELSE ${actual} END) <> (CASE WHEN wa.second_review_id IS NULL THEN ${reviewIndependenceSql(attempt.model)}
          ELSE ${firstReviewIndependenceSql(attempt.model)} END)
        AND (g.fallback_for_id IS NULL OR (wr.status = 'resolved' AND wr.resolution = 'fallback'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(fallbacks)}::jsonb) f
            WHERE f->>'provider' = g.provider AND ${sameNameSql(sql`f->>'model'`)} = ${sameNameSql(sql`g.model`)}))))
    AND NOT EXISTS (SELECT 1 FROM second_reviews g WHERE g.first_attempt_id = ${attempt.id}
      AND g.trigger = 'ai_approved' AND g.status IN ('pending', 'failed', 'needs_human')))`;
}

export function secondReviewAssignedVoteCanonical(model: string | null, assignment?: SecondReviewWorkloadAssignment, fallback = false): string | null {
  if (!assignment) return model;
  if (fallback) return model ? modelCanonical('second-review', model) : null;
  return OPAQUE_MODEL.test(underlyingReviewModel(assignment.canonicalModel))
    ? model ? modelCanonical('second-review', model) : null : reviewIndependenceKey(assignment.canonicalModel);
}
