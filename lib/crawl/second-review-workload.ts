import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { secondReviews, secondReviewWorkloadAssignments, type SecondReview, type SecondReviewWorkloadAssignment } from '@/lib/db/schema';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { logger } from '@/lib/observability/logger';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import type { AiTaskExecutionConfig, AiTaskPoolSelection } from '@/lib/llm/ai-task-execution-config';
import { readAiTaskExecutionConfig } from '@/lib/llm/ai-task-execution-snapshot';
import { taskModels } from '@/lib/llm/ai-task-resolver';
import { chooseTaskWorkloadMember } from '@/lib/llm/ai-task-workload-selector';
import { bindReviewTaskRank, resolveReviewTaskRanks, reviewRouteContracts, reviewTaskRanksPinned, settingsReviewersActive, type ReviewRankCandidate, type ReviewRankReviewer } from './review-task-ranks';
import { underlyingReviewModel, reviewIndependenceKey, sameReviewModel } from './review-model-identity';
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
    && candidate.binding.provider === row.provider && candidate.binding.identity === row.model);
}
const OPAQUE_MODEL = /^(?:auto|supa)$/i;
function modelCanonical(task: 'first-review' | 'second-review', model: string): string | null {
  const candidate = resolveReviewTaskRanks(task).candidates.find(candidate => candidate.binding?.identity === model);
  const contract = reviewRouteContracts(task === 'first-review' ? 'crawl-agent-review' : 'second-review')
    .find(entry => entry.row.model === model);
  const metadata = contract?.row.contract;
  const responseModel = metadata && typeof metadata === 'object' && 'responseModel' in metadata && typeof metadata.responseModel === 'string'
    ? metadata.responseModel : null;
  const canonical = candidate?.poolMember?.canonicalModel;
  const value = canonical && !OPAQUE_MODEL.test(underlyingReviewModel(canonical)) ? canonical
    : responseModel ?? candidate?.binding?.engineModel ?? model;
  // A routing alias without observed canonical metadata cannot establish an independent vote.
  return OPAQUE_MODEL.test(underlyingReviewModel(value)) ? null : reviewIndependenceKey(value);
}
export function secondReviewPoolHasEligibleMember(): boolean {
  return secondReviewWorkloadSlots()[0].candidates.some(candidate => {
    const canonical = candidate.binding ? modelCanonical('second-review', candidate.binding.identity) : null;
    return !candidate.unusable && canonical !== null;
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
  // 표를 배정할 뿐 지금 부르지 않는다(호출은 나중에 소비자가 장부 줄에 서서 한다) — 빈 칸이 없어도 줄에 설 수 있는 구성원을 고르고(queueWhenFull),
  // 장부에 행을 쓰지 않고 잇달아 고르므로 같은 장비 상태를 본 한 묶음이 한 구성원에 몰리지 않게 돌림 차례를 먼저 본다(rotate). 2026-11-12 검토:
  // 예전에는 모든 구성원의 장비가 그 순간 가득이면 표를 만들지 않고 말없이 넘겨, 소비자가 장비를 채우는 동안 새 후보가 표를 얻지 못했다.
  const chosen = await chooseTaskWorkloadMember(slot.config, candidates, { executor: tx, queueWhenFull: true, rotate: true });
  if (!chosen) return null;
  const member = slot.config.members.find(member => member.memberId === chosen.memberId)!;
  return { provider: chosen.provider as ReviewRankReviewer['provider'], model: chosen.identity,
    selection: chosen.poolSelection, canonicalModel: member.canonicalModel };
}
/** Single-voter pool: no pool member becomes an extra quorum slot. */
export function secondReviewPoolRequiredSql(): SQL {
  const slot = secondReviewWorkloadSlots()[0];
  const available = [...new Set(slot.candidates.flatMap(candidate => {
    const canonical = candidate.binding ? modelCanonical('second-review', candidate.binding.identity) : null;
    return canonical === null ? [] : [canonical];
  }))];
  return sql`CASE WHEN jsonb_array_length(${JSON.stringify(available)}::jsonb) > 0 THEN 1 ELSE 0 END`;
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
        AND ${root}.provider = m->>'provider' AND ${root}.model = m->>'model')
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
    // The first stage may use the same model. Only existing second-stage work
    // excludes a member here; each stage still obtains its own call/result.
    const excluded = new Set<string>();
    // The existing per-model unique key also applies to closed rows of this exact generation.
    for (const row of existing) if (row.generationKey === base.generationKey && row.inputHash === base.inputHash && row.model) {
      const member = slot.candidates.find(candidate => sameReviewModel(candidate.binding?.identity, row.model));
      if (member?.binding) {
        const canonical = modelCanonical('second-review', member.binding.identity);
        if (canonical !== null) excluded.add(canonical);
      }
    }
    let selected: Awaited<ReturnType<typeof chooseSecondReviewWorkloadSlot>>;
    try { selected = await chooseSecondReviewWorkloadSlot(slot, tx, excluded); }
    catch (error) {
      // 용량 장부가 열려 있지 않다(배포 창 DRAIN·꺼짐)·정책 세대가 바뀌었다 — 이 틱에는 표를 배정하지 않는다(OPEN 뒤 다음 틱이 배정한다).
      // 예전에는 이 미룸이 유지보수 틱 전체(정산·고아 정리·실패 표 재시도·발행분 표본)를 던졌다. 이 셋은 SQL 실패 없이 던지는 미룸이라 TX 는 그대로다.
      if (error instanceof ModelCapacityDeferredError && ['draining', 'disabled', 'policy_changed'].includes(error.reason)) {
        logger.info('second_review.workload_assignment_deferred', { reason: error.reason, candidateId: base.candidateId });
        break;
      }
      throw error;
    }
    if (!selected) {
      // 줄에 설 수 있는 구성원도 없다(장비 없음·꺼짐, 모델 상한·경로 몫이 참) — 다음 틱에 다시 고른다
      logger.info('second_review.workload_unassigned', { candidateId: base.candidateId });
      continue;
    }
    const [row] = await tx.insert(secondReviews).values({ ...base, provider: selected.provider, model: selected.model })
      .onConflictDoNothing().returning();
    if (!row) continue;
    await tx.insert(secondReviewWorkloadAssignments).values({ secondReviewId: row.id, taskSlot: 1,
      configRevision: selected.selection.configRevision, memberId: selected.selection.memberId, canonicalModel: selected.canonicalModel });
    inserted.push(row);
  }
  return inserted;
}

export function secondReviewVoteEligible(model: string | null,
  assignment?: SecondReviewWorkloadAssignment | null, fallback = false): boolean {
  if (!model) return false;
  if (!assignment) return true;
  const actual = fallback ? modelCanonical('second-review', model) : secondReviewAssignedVoteCanonical(model, assignment);
  return actual !== null;
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
        AND ${roots} AND (wa.second_review_id IS NULL OR ${actual} IS NOT NULL)
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
