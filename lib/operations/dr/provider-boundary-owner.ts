import { sql } from "drizzle-orm";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { ModelDispatchReleaseCandidate } from "@/lib/llm/capacity-repository";
import type { providerBoundaryPlanV2Schema } from "@/lib/llm/provider-boundary-contract";
import type { z } from "zod";
import { evaluateLocalCallEnded } from "./call-drain";
import { readProcessGroupEvents } from "./repository";

/** Called only after fence/control/request locks. Durable DB facts, not supplied JSON/CID absence, establish the old local end. */
export async function assertHistoricalBoundaryOwner(tx: ProductTransaction, plan: z.infer<typeof providerBoundaryPlanV2Schema>,
  candidate: Pick<ModelDispatchReleaseCandidate, "owner" | "dispatchAt" | "bindingHash" | "localEnd">) {
  const events = await readProcessGroupEvents(tx, candidate.owner), local = candidate.localEnd;
  const ended = candidate.dispatchAt && evaluateLocalCallEnded(events, Date.parse(candidate.dispatchAt));
  if (!ended || !ended.ended || !local || local.owner.instanceId !== candidate.owner.instanceId || local.owner.bootId !== candidate.owner.bootId
    || local.bindingHash !== candidate.bindingHash || local.dispatches !== local.terminals)
    throw new Error("provider_boundary_original_owner_unproven");
  const [facts] = await tx.execute<{ valid: boolean }>(sql`SELECT nmv_boundary_original_owner_records_valid(${JSON.stringify(plan)}::text::jsonb,to_jsonb(r)) valid
    FROM model_capacity_requests r WHERE request_id=${plan.request.requestId}::uuid`);
  if (facts?.valid !== true) throw new Error("provider_boundary_original_owner_records_mismatch");
}
