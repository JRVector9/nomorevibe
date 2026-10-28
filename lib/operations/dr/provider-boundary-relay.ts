import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { providerBoundaryCanonicalHash, providerBoundaryPlanHash, providerBoundaryPlanSchema, providerBoundaryReceiptSchema } from '@/lib/llm/provider-boundary-contract';
import { relayBoundaryProofSchema, type RelayBoundaryProof } from '@/scripts/local-model-relay/boundary-reconcile';

/** Only a fresh primary readback of the exact committed release can unlock the relay marker.
 * Caller files/CLI success/a rolled-back dry run cannot stand in for this DB fact.
 */
export async function readCommittedRelayBoundaryProof(input: { plan: unknown; receipt: unknown; expectedPlanHash: string;
  operator: string; reference: string }): Promise<RelayBoundaryProof> {
  if (currentReplayDb()) throw new Error('relay_recovery_replay_unsupported');
  const plan = providerBoundaryPlanSchema.parse(input.plan), receipt = providerBoundaryReceiptSchema.parse(input.receipt);
  const planHash = providerBoundaryPlanHash(plan);
  if (planHash !== input.expectedPlanHash || receipt.planHash !== planHash) throw new Error('relay_recovery_plan_mismatch');
  return onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    const [row] = await tx.execute<{ state: string; binding_hash: string; binding: { wireHash?: unknown; model?: unknown; servingContractHash?: unknown };
      evidence: { kind?: unknown; plan?: unknown; receipt?: unknown; operator?: unknown; reference?: unknown }; evidence_hash: string;
      event_matches: boolean; unsettled: boolean }>(sql`
      SELECT r.state, r.dispatch_binding_hash AS binding_hash, r.dispatch_binding AS binding, r.terminal_evidence AS evidence,
        r.terminal_evidence_hash AS evidence_hash, r.settled_at IS NULL AS unsettled,
        EXISTS (SELECT 1 FROM model_capacity_events e WHERE e.request_id = r.request_id AND e.kind = 'dispatch_released'
          AND e.evidence = r.terminal_evidence) AS event_matches
      FROM model_capacity_requests r WHERE r.request_id = ${plan.request.requestId}::uuid`);
    if (!row || row.state !== 'withdrawn' || row.unsettled !== true || row.event_matches !== true
      || row.binding_hash !== plan.request.bindingHash || row.binding?.servingContractHash !== plan.request.servingContractHash
      || row.evidence?.kind !== 'provider_boundary_exit' || !isDeepStrictEqual(row.evidence.plan, plan)
      || !isDeepStrictEqual(row.evidence.receipt, receipt) || row.evidence.operator !== input.operator || row.evidence.reference !== input.reference
      || row.evidence_hash !== providerBoundaryCanonicalHash(row.evidence))
      throw new Error('relay_recovery_committed_release_missing');
    return relayBoundaryProofSchema.parse({ requestId: plan.request.requestId, planHash, bindingHash: row.binding_hash,
      wireHash: row.binding.wireHash, model: row.binding.model, releaseEvidenceHash: row.evidence_hash });
  }, { accessMode: 'read only' }));
}
