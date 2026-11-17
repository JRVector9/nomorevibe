import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations } from "@/lib/db/schema";
import type { JobContext } from "@/lib/jobs/runner";
import { withJobLeaseWrite } from "@/lib/jobs/control";
import { withLocalModelCapacity } from "@/lib/llm/local-model-capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { LocalModelDomainRefusedError } from "@/lib/llm/local-model-domain-refusal";
import { modelTimeoutMs } from "@/lib/llm/model-registry";
import { loadAuditInput } from "./product-audit";
import { qwenDirectConfig, QwenDirectError } from "./qwen-direct-review";
import { noteQwenCallFailure, noteQwenEndpointSuccess, qwenEndpointBackingOff, withQwenSecondarySlot } from "./qwen-endpoint-backoff";
import type { CrawlSettings } from "./settings-schema";
import { SAME_MODEL_RECHECK_PROMPT_VERSION, SAME_MODEL_RECHECK_SOURCE, sameModelRecheckModel } from "./same-model-recheck-policy";
import { sameModelRecheckTargets, writeSameModelRecheck } from "./same-model-recheck-repository";
import { reviewSameModelRecheck } from "./same-model-recheck-review";

export type SameModelRecheckTally = { asked: number; recommended: number; failed: number; inputStale: number };
type Failure = { at: number; count: number; code: string };
type Observation = { model: string; promptVersion: string; failures: Record<string, Failure>; lastRunAt?: string; tally?: SameModelRecheckTally };

/** Lower-priority, bounded advisory work in the existing audit-second-opinion job/stage/secondary slot/ledger. */
export async function runSameModelRechecks(ctx: JobContext<null>, settings: CrawlSettings): Promise<SameModelRecheckTally> {
  const tally: SameModelRecheckTally = { asked: 0, recommended: 0, failed: 0, inputStale: 0 };
  const step = settings.qwenAuto.sameModelRecheck, lease = ctx.lease;
  if (!lease || !settings.enabled || !settings.qwenAuto.auditSecondOpinion.enabled || !step.enabled || !ctx.hasBudget()) return tally;
  const primary = qwenDirectConfig();
  if (!primary) return tally;
  const choice = await sameModelRecheckModel(primary.model);
  if (!choice) return tally;
  const [saved] = await db.select({ value: operationsObservations.value }).from(operationsObservations)
    .where(eq(operationsObservations.key, SAME_MODEL_RECHECK_SOURCE));
  const old = saved?.value as Observation | undefined;
  const observation: Observation = { model: choice.config.model, promptVersion: SAME_MODEL_RECHECK_PROMPT_VERSION,
    failures: old?.model === choice.config.model && old.promptVersion === SAME_MODEL_RECHECK_PROMPT_VERSION ? old.failures ?? {} : {} };
  const start = Date.now(), left = () => (ctx.deadlineAt ?? start + 30_000) - Date.now();
  const canStart = () => !ctx.signal?.aborted && ctx.hasBudget() && Date.now() - start < 30_000 && left() >= 15_000
    && !qwenEndpointBackingOff("second_opinion");
  const skip = Object.entries(observation.failures).filter(([, f]) => f.code === "input_stale" ? start - f.at < 5 * 60_000 : f.count >= 2)
    .map(([id]) => Number(id)).filter(Number.isSafeInteger);
  const targets = await sameModelRecheckTargets(choice.config.model, step.perTick, skip);
  for (const target of targets.slice(0, step.perTick)) {
    if (!canStart()) break;
    const fail = (code: string, counted = true) => {
      const previous = observation.failures[target.item_id];
      observation.failures[target.item_id] = { at: Date.now(), count: (previous?.count ?? 0) + Number(counted), code };
    };
    let shrunk = false;
    try {
      const input = await loadAuditInput(target.slug, settings);
      if (!input) { fail("no_source"); tally.failed++; continue; }
      if (input.validUntil.getTime() - Date.now() < 30_000) { fail("input_stale", false); tally.inputStale++; continue; }
      if (!canStart()) break;
      const review = await withQwenSecondarySlot(async () => {
        if (!canStart()) return null;
        const ceiling = modelTimeoutMs("audit-second-opinion"), timeoutMs = Math.min(ceiling, left() - 5_000);
        shrunk = timeoutMs < ceiling;
        const callStart = Date.now();
        const result = await withLocalModelCapacity({ target: { kind: "audit", purpose: "second_opinion", itemId: target.item_id, slug: target.slug },
          input, lease, promptVersion: SAME_MODEL_RECHECK_PROMPT_VERSION, servingRevision: choice.servingRevision, allowLegacy: false },
        request => reviewSameModelRecheck(input, target.reason, { config: choice.config, request, timeoutMs, signal: ctx.signal }));
        await noteQwenEndpointSuccess("second_opinion", callStart);
        return result;
      });
      if (!review) break;
      tally.asked++;
      const written = await writeSameModelRecheck(target, review, input, lease);
      if (written === "switched_off") break;
      if (written === "written") {
        delete observation.failures[target.item_id];
        if (review.outcome.decision === "approve") tally.recommended++;
      } else fail("not_open");
    } catch (error) {
      if (error instanceof ModelCapacityDeferredError) { ctx.log("same_model_recheck.deferred", { reason: error.reason }); break; }
      if (error instanceof LocalModelDomainRefusedError) {
        if (["step_disabled", "crawl_disabled", "job_mismatch", "pipeline_draining"].includes(error.check)) break;
        if (error.check === "input_expired") { fail("input_stale", false); tally.inputStale++; }
        else { fail(error.check); tally.failed++; }
        continue;
      }
      if (!(error instanceof QwenDirectError)) throw error;
      if (error.code === "qwen_cancelled" || error.code === "qwen_timeout" && shrunk) break;
      if ((await noteQwenCallFailure("second_opinion", error.code)).outage) break;
      if (error.code !== "qwen_http_429") { fail(error.code); tally.failed++; }
    }
  }
  if (!targets.length) return tally;
  observation.lastRunAt = new Date().toISOString(); observation.tally = tally;
  observation.failures = Object.fromEntries(Object.entries(observation.failures).sort((a, b) => b[1].at - a[1].at).slice(0, 2000));
  await withJobLeaseWrite(lease, async tx => {
    await tx.insert(operationsObservations).values({ key: SAME_MODEL_RECHECK_SOURCE, value: observation, observedAt: new Date() })
      .onConflictDoUpdate({ target: operationsObservations.key, set: { value: observation, observedAt: new Date() } });
  });
  ctx.log("same_model_recheck.ran", tally);
  return tally;
}
