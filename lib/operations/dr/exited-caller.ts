import { sql } from "drizzle-orm";
import { z } from "zod";
import { operationsAudit } from "@/lib/db/schema";
import { markExitedCallerDispatchIndeterminate } from "@/lib/llm/capacity-repository";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { adminAuditRow } from "../admin-log";
import { identity, writerSiteActive } from "./epoch";
import { drTransactionMaybeDry, readProcessGroupEvents } from "./repository";
import { OWNER_GONE_MAX_REQUESTS } from "./owner-gone-contract";
import { exitedCallerEvidenceSchema, judgeExitedCaller } from "./exited-caller-contract";

/** Explicit IDs, row lock and DB-clock exit verification. Preserves terminal/token/usage and never releases a provider. */
export async function markExitedCallerIndeterminate(value: { requestIds: readonly string[]; operator: string;
  allowedOwnerInstanceIds?: readonly string[]; jobLease?: JobLease }, apply: boolean) {
  const operator = identity(120).parse(value.operator);
  const ids = z.array(z.uuid()).min(1).max(OWNER_GONE_MAX_REQUESTS).parse(value.requestIds);
  if (new Set(ids).size !== ids.length) throw new Error("exited_caller_duplicate_request");
  const rows = [];
  for (const requestId of ids) rows.push(await drTransactionMaybeDry(apply, async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL transaction_timeout = '15s'`);
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    const result = await markExitedCallerDispatchIndeterminate(tx, requestId, async candidate => {
      if (value.allowedOwnerInstanceIds && !value.allowedOwnerInstanceIds.includes(candidate.owner.instanceId))
        return { blocked: "owner_not_singleton" };
      if (value.jobLease) await assertJobLeaseAtWallTime(tx, value.jobLease);
      const events = await readProcessGroupEvents(tx, candidate.owner);
      const verdict = judgeExitedCaller({ ...candidate, events });
      if (!verdict.ended) return { blocked: verdict.reason };
      const dispatchAt = Date.parse(candidate.dispatchAt!);
      const exits = events.filter(event => event.kind === "spawn_intent" && event.recordedAtMs <= dispatchAt).map(intent => {
        const exit = events.find(event => event.kind === "group_exited" && event.seq === intent.seq)!;
        return { seq: intent.seq, runId: intent.runId, pid: exit.pid, exitedAt: new Date(exit.recordedAtMs).toISOString() };
      });
      return exitedCallerEvidenceSchema.parse({ version: 1, kind: "caller_process_exited", requestId, owner: candidate.owner,
        fromState: "dispatched", dispatchAt: candidate.dispatchAt, evaluatedAt: candidate.now, bindingKind: candidate.bindingKind,
        bindingHash: candidate.bindingHash, exitedAt: verdict.exitedAt, exits, operator });
    });
    if (result.kind === "marked") {
      if (value.jobLease) await assertJobLeaseAtWallTime(tx, value.jobLease);
      await tx.insert(operationsAudit).values(await adminAuditRow(operator, { action: "model-capacity-caller-exited", target: requestId,
        detail: { fromState: "dispatched", toState: "indeterminate", reason: "process_exit", evidence: result.evidence } }));
    }
    return { requestId, ...result };
  }));
  return { rows };
}
