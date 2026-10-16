import { z } from "zod";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { applyReplayChanges, readinessProjectionHashes, ReplayReadinessChangeSchema, ReplayReadinessProjectionSchema, ReplayReadinessJournalSchema, reduceReplayReadinessCoverage } from "./pipeline-replay-readiness";
import { applyReplayItemStateChanges, canonicalReplayItemState, ReplayItemStateChangeSchema, ReplayItemStateSchema, replayItemStateExpiries } from "./pipeline-replay-item-state";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { secondGateRequired } from "@/lib/crawl/agent-review-repository";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { assessReplayAi2Target } from "./pipeline-replay-ai2-target";
import { replayTimestampMicros } from "./pipeline-replay-timestamp";
import type { ReplayCombinedState } from "./pipeline-replay-combined-capture";

export const ReplayCombinedExecutionSchema = z.object({ kind: z.literal("pipeline-replay-combined-state"), version: z.literal(1),
  domain: ReplayReadinessProjectionSchema, items: ReplayItemStateSchema }).strict();
export const ReplayMixedChangeSchema = z.union([ReplayReadinessChangeSchema, ReplayItemStateChangeSchema]);
export type ReplayMixedChange = z.infer<typeof ReplayMixedChangeSchema>;
export const ReplayMixedJournalSchema = ReplayReadinessJournalSchema.extend({ transactions: z.array(ReplayReadinessJournalSchema.shape.transactions.element.extend({ changes: z.array(ReplayMixedChangeSchema) }).strict()) }).strict();
export const ReplayItemCallAuthoritySchema = z.object({ callId: z.string().min(1), txKey: z.string().min(1),
  lease: ReplayItemStateSchema.shape.tables.shape.pipeline_item_leases.element }).strict()
  .refine(value => value.lease.stage === "ai2" && value.lease.token !== null, "invalid_replay_item_call_authority");

/** The existing reducers own every row policy. Preserve the single global
 * ordinal and apply one fact at a time; never independently reorder tables. */
export function applyReplayMixedChanges(value: unknown, changes: readonly unknown[]): ReplayCombinedState {
  const state = ReplayCombinedExecutionSchema.parse(value);
  state.domain = applyReplayChanges(state.domain, []); state.items = canonicalReplayItemState(state.items);
  for (const [index, raw] of changes.entries()) {
    const change = ReplayMixedChangeSchema.parse(raw);
    if (change.ordinal !== index + 1) throw new Error("replay_mixed_ordinal_mismatch");
    if (change.table_name === "pipeline_stage_modes" || change.table_name === "pipeline_item_leases")
      state.items = applyReplayItemStateChanges(state.items, [{ ...change, ordinal: 1 }]);
    else state.domain = applyReplayChanges(state.domain, [{ ...change, ordinal: 1 }]);
  }
  return state;
}

export function replayMixedProjectionHashes(value: unknown, capturedAt: string) {
  const state = applyReplayMixedChanges(value, []), domain = readinessProjectionHashes(state.domain, capturedAt);
  return { initialStateHash: reviewHash(state), comparisonStateHash: reviewHash({ domain: domain.comparisonStateHash, items: state.items }) };
}

/** Item readiness uses the same target predicate as actual target claims.
 * Commit intervals retain every possible ordered state; lock availability is
 * never inferred from these snapshots. */
export function reduceReplayMixedCoverage(initial: { projection: unknown; capturedAt: string; initialStateHash: string; comparisonStateHash: string },
  value: unknown, window: { from: string; until: string }) {
  const journal = ReplayMixedJournalSchema.parse(value), state = applyReplayMixedChanges(initial.projection, []);
  const expected = replayMixedProjectionHashes(state, initial.capturedAt);
  if (expected.initialStateHash !== initial.initialStateHash || expected.comparisonStateHash !== initial.comparisonStateHash)
    throw new Error("replay_readiness_initial_hash_mismatch");
  const domainInitial = { projection: state.domain, capturedAt: initial.capturedAt,
    ...readinessProjectionHashes(state.domain, initial.capturedAt) };
  const domainJournal = { ...journal, transactions: journal.transactions.map(tx => ({ ...tx,
    changes: tx.changes.filter(change => change.table_name !== "pipeline_stage_modes" && change.table_name !== "pipeline_item_leases")
      .map((change, index) => ({ ...change, ordinal: index + 1 })) })) };
  const legacy = reduceReplayReadinessCoverage(domainInitial, domainJournal, window);
  const states = [state], points = new Set([window.from, window.until]);
  for (const tx of journal.transactions) {
    states.push(applyReplayMixedChanges(states.at(-1), tx.changes));
    points.add(tx.txStartedAt); if (tx.confirmedAt) points.add(tx.confirmedAt);
  }
  for (const interval of legacy.intervals) { points.add(interval.from); points.add(interval.until); }
  for (const projection of states) for (const expiry of replayItemStateExpiries(projection.items)) points.add(expiry);
  const from = replayTimestampMicros(window.from), until = replayTimestampMicros(window.until);
  const ordered = [...points].map(value => ({ text: value, at: replayTimestampMicros(value) }))
    .filter(point => point.at >= from && point.at <= until).sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0)
    .filter((point, index, all) => !index || point.at !== all[index - 1].at);
  const intervals = [];
  const assessments = new Map<string, { ready: number; unknown: boolean; firstOwnerUnknown: boolean }>();
  for (let i = 0; i + 1 < ordered.length; i++) {
    const left = ordered[i], right = ordered[i + 1];
    let lower = 0, upper = 0;
    for (const [index, tx] of journal.transactions.entries()) {
      if (tx.confirmedAt && replayTimestampMicros(tx.confirmedAt) <= left.at) lower = index + 1;
      if (replayTimestampMicros(tx.txStartedAt) < right.at) upper = index + 1;
    }
    while (upper > lower && journal.transactions.slice(0, upper).some(tx => replayTimestampMicros(tx.txStartedAt) >= right.at)) upper--;
    const possible = states.slice(lower, Math.max(lower, upper) + 1).map(state => {
      const key = `${states.indexOf(state)}:${replayItemStateExpiries(state.items).filter(expiry => replayTimestampMicros(expiry) <= left.at).length}`;
      const cached = assessments.get(key); if (cached) return cached;
      const members = new Set(state.domain.universe.map(row => row.candidateId));
      const assessed = state.domain.tables.second_reviews.filter(row => members.has(Number(row.candidate_id)))
        .map(row => assessReplayAi2Target(state, Number(row.id), left.text));
      const derived = { ready: assessed.filter(row => row.kind === "eligible" && row.inputMembership === "included").length,
        unknown: assessed.some(row => row.kind === "unknown"),
        firstOwnerUnknown: state.items.tables.pipeline_item_leases.some(item => item.stage === "ai1" && item.binding.stage === "ai1"
          && members.has(item.binding.candidateId) && item.token !== null && replayTimestampMicros(item.lease_until!) > left.at) };
      assessments.set(key, derived); return derived;
    });
    const base = legacy.intervals.find(row => replayTimestampMicros(row.from) <= left.at && replayTimestampMicros(row.until) >= right.at)!;
    const secondReadyLower = Math.min(...possible.map(row => row.ready));
    const reasons = [...base.reasons];
    if (possible.some(row => row.unknown)) reasons.push("item_target_unknown");
    if (possible.some(row => row.firstOwnerUnknown)) reasons.push("legacy_item_owner_unmodeled");
    if (lower !== upper && base.firstReadyLower + secondReadyLower === 0 && possible.some(row => row.ready > 0)) reasons.push("commit_unconfirmed");
    intervals.push({ from: left.text, until: right.text, firstReadyLower: possible.some(row => row.firstOwnerUnknown) ? 0 : base.firstReadyLower,
      secondReadyLower, status: reasons.length ? "unknown" as const : "known" as const, reasons });
  }
  return { ...legacy, intervals, coverage: intervals.some(row => row.status === "unknown") ? "missing" as const
    : intervals.some(row => row.firstReadyLower + row.secondReadyLower === 0) ? "starved" as const : "covered" as const };
}

/** Structural evidence is replayed from the complete protected journal. It
 * grants no capability: the verified loader still reads the authentic DB. */
export function validateReplayItemEvidence(artifact: import("./pipeline-replay-artifact").ReplayAnyArtifact): void {
  if (artifact.version !== 2) throw new Error("invalid_replay_item_artifact");
  const ensure = (ok: unknown) => { if (!ok) throw new Error("invalid_replay_item_authority"); };
  const journal = ReplayMixedJournalSchema.parse(artifact.readiness);
  ensure(journal.gaps.length === 0 && journal.transactions.every(tx => tx.confirmedAt !== null));
  for (const [index, packet] of journal.transactions.entries()) {
    const event = artifact.journal.find(event => event.seq === packet.seq);
    ensure((!index || journal.transactions[index - 1].seq < packet.seq) && event?.kind === "transaction"
      && event.txKey === packet.txKey && reviewHash(event.payload) === reviewHash({ txKey: packet.txKey })
      && replayTimestampMicros(event.at) === replayTimestampMicros(packet.recordedAt));
  }
  let state = applyReplayMixedChanges(artifact.initial.projection, []);
  const states = new Map<string, ReplayCombinedState>();
  const walls = new Map<string, Array<z.infer<typeof ReplayItemCallAuthoritySchema>["lease"] & { released: boolean }>>();
  const wallSchema = z.object({ txKey: z.string().min(1), checkedAt: ReplayReadinessJournalSchema.shape.transactions.element.shape.recordedAt,
    items: z.array(ReplayItemCallAuthoritySchema.shape.lease.extend({ released: z.boolean() }).strict()).min(1) }).strict();
  const packets = new Map(journal.transactions.map(tx => [tx.txKey, tx]));
  for (const event of artifact.journal) {
    ensure(reviewHash(event.payload) === event.payloadHash);
    if (event.kind === "item_final_authority") {
      const proof = wallSchema.parse(event.payload), packet = packets.get(proof.txKey);
      ensure(event.txKey === proof.txKey && packet && event.seq > packet.seq
        && replayTimestampMicros(proof.checkedAt) >= replayTimestampMicros(packet!.recordedAt)
        && replayTimestampMicros(proof.checkedAt) <= replayTimestampMicros(packet!.confirmedAt!));
      ensure(!walls.has(proof.txKey));
      for (const item of proof.items) ensure(item.stage === "ai2" && item.token !== null && item.lease_until !== null
        && replayTimestampMicros(item.lease_until!) > replayTimestampMicros(proof.checkedAt));
      walls.set(proof.txKey, proof.items);
    }
  }
  for (const packet of journal.transactions) {
    state = applyReplayMixedChanges(state, packet.changes);
    states.set(packet.txKey, state);
    const itemChanges = packet.changes.filter(change => change.table_name === "pipeline_item_leases");
    for (const change of itemChanges) {
      const identity = change.new_row ?? change.old_row!;
      const proof = walls.get(packet.txKey)?.find(item => item.work_key === identity.work_key && item.stage === identity.stage);
      ensure(proof);
      const row = state.items.tables.pipeline_item_leases.find(item => item.stage === identity.stage && item.work_key === identity.work_key);
      ensure(row && row.binding_hash === proof!.binding_hash && row.stage_epoch === proof!.stage_epoch && row.item_epoch === proof!.item_epoch);
      if (proof!.released) ensure(row!.token === null && change.old_row?.token === proof!.token && change.new_row?.token === null);
      else ensure(row!.token === proof!.token && row!.owner_instance_id === proof!.owner_instance_id && row!.owner_boot_id === proof!.owner_boot_id);
    }
  }
  const authorities = artifact.journal.filter(event => event.kind === "item_call_authority").map(event => {
    const proof = ReplayItemCallAuthoritySchema.parse(event.payload);
    ensure(event.txKey === proof.txKey);
    const current = states.get(proof.txKey);
    const row = current?.items.tables.pipeline_item_leases.find(item => item.stage === "ai2" && item.work_key === proof.lease.work_key);
    ensure(row && reviewHash(row) === reviewHash(proof.lease));
    const wall = walls.get(proof.txKey)?.find(item => item.work_key === proof.lease.work_key && !item.released);
    ensure(wall && reviewHash(wall.binding) === reviewHash(proof.lease.binding) && wall.token === proof.lease.token);
    const packet = packets.get(proof.txKey)!;
    ensure(event.seq < packet.seq && replayTimestampMicros(event.at) <= replayTimestampMicros(packet.recordedAt));
    const admission = journal.transactions.filter(tx => tx.seq < packet.seq).flatMap(tx => tx.changes.map(change => ({ tx, change })))
      .find(({ change }) => change.table_name === "pipeline_item_leases" && change.new_row?.token === proof.lease.token
        && change.new_row.work_key === proof.lease.work_key && change.new_row.item_epoch === proof.lease.item_epoch
        && (change.operation === "INSERT" && change.new_row.item_epoch === 1 || change.operation === "UPDATE"
          && change.old_row!.token !== change.new_row.token && change.new_row.item_epoch === change.old_row!.item_epoch + 1));
    if (!admission || admission.change.table_name !== "pipeline_item_leases") throw new Error("invalid_replay_item_authority");
    ensure(!admission.change.old_row?.token || replayTimestampMicros(admission.change.old_row.lease_until!)
      <= replayTimestampMicros(admission.tx.recordedAt));
    const assessment = assessReplayAi2Target({ ...current!, items: { ...current!.items, tables: { ...current!.items.tables,
      pipeline_item_leases: current!.items.tables.pipeline_item_leases.filter(item => item.stage !== proof.lease.stage || item.work_key !== proof.lease.work_key) } } },
    proof.lease.binding.stage === "ai2" ? proof.lease.binding.secondReviewId : 0, packet.recordedAt);
    ensure(assessment.kind === "eligible" && assessment.inputMembership === "included" && reviewHash(assessment.binding) === reviewHash(proof.lease.binding));
    return proof;
  });
  ensure(new Set(authorities.map(row => row.callId)).size === authorities.length
    && new Set(authorities.map(row => JSON.stringify([row.lease.work_key,row.lease.token,row.lease.item_epoch]))).size === authorities.length);
  for (const call of artifact.calls) if (call.stage === "second") {
    const proof = authorities.find(row => row.callId === call.callId), binding = proof?.lease.binding;
    ensure(binding?.stage === "ai2" && binding.secondReviewId === call.secondReviewId && binding.candidateId === call.candidateId
      && call.firstAttemptId === (binding.source.kind === "first_attempt" ? binding.source.firstAttemptId : null)
      && binding.vote === call.vote && binding.generationKey === call.generationKey && binding.inputHash === call.inputHash
      && binding.sourceRevisionHash === call.sourceRevisionHash && binding.reviewer.provider === call.provider && binding.reviewer.model === call.model);
    const insertion = packets.get(proof!.txKey)!.changes.find(change => change.table_name === "capacity_calls"
      && change.operation === "INSERT" && change.new_row?.call_id === call.callId);
    if (!insertion || insertion.table_name !== "capacity_calls" || !insertion.new_row) throw new Error("invalid_replay_item_authority");
    const inserted = insertion.new_row;
    ensure(Object.entries({ call_id: call.callId, candidate_id: call.candidateId, first_attempt_id: call.firstAttemptId,
      stage: call.stage, second_review_id: call.secondReviewId, generation_key: call.generationKey, vote: call.vote,
      input_hash: call.inputHash, source_revision_hash: call.sourceRevisionHash, provider: call.provider, model: call.model,
      request_hash: call.requestHash, token_upper_bound: call.tokenUpperBound, state: "reserved" })
      .every(([key, expected]) => inserted[key] === expected));
  }
  ensure(authorities.length === artifact.calls.filter(call => call.stage === "second").length);
  ensure(artifact.journal.filter(row => row.kind === "final").length === artifact.finals.length);
  for (const final of artifact.finals) {
    const finalEvent = artifact.journal.find(row => row.seq === final.seq)!;
    const { seq: ignoredSeq, at: ignoredAt, ...expected } = final; void ignoredSeq; void ignoredAt;
    ensure(reviewHash(finalEvent.payload) === reviewHash(expected));
    if (final.decision === "approve" && secondGateRequired(mergeWithDefaults(artifact.initial.projection.domain.tables.crawl_settings.find(row => row.id === 1)?.values))) {
      const required = artifact.manifest.models.second.filter(slot => slot.canonicalModel !== canonicalReviewModel(artifact.manifest.models.first.model));
      ensure(required.length === final.secondWitnesses.length && required.every(slot => final.secondWitnesses.some(witness =>
        witness.slotProvider === slot.provider && witness.slotModel === slot.model)));
    }
    for (const witness of final.secondWitnesses) {
    const original = authorities.find(row => row.callId === witness.callId)!;
    const event = artifact.journal.find(row => row.seq === final.seq)!;
    const released = [...walls].find(([txKey, rows]) => packets.get(txKey)!.seq <= event.seq && rows.some(row => row.work_key === original.lease.work_key
      && row.released && row.token === original.lease.token && row.item_epoch === original.lease.item_epoch));
    const packet = released && packets.get(released[0]);
    const proof = released?.[1].find(row => row.work_key === original.lease.work_key && row.released);
    ensure(proof && packet && proof.token === original.lease.token && proof.item_epoch === original.lease.item_epoch
      && proof.owner_boot_id === original.lease.owner_boot_id && proof.stage_epoch === original.lease.stage_epoch);
    ensure(packet!.changes.some(change => change.table_name === "pipeline_item_leases" && change.old_row?.token === proof!.token
      && change.new_row?.token === null));
  }
  }
}
