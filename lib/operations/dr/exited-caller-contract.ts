import { z } from "zod";
import { identity, isoMillis } from "./epoch";
import { evaluateLocalCallEnded, type ProcessGroupEvent } from "./call-drain";

// Only HTTP callers run by the recorded worker child. CLI/native bindings have separate boundaries.
export const EXITED_CALLER_BINDINGS = Object.freeze(["ai1_legacy_gateway", "ai2_item_gateway", "ai1_item_gateway",
  "text_profile_gateway", "reason_translation_gateway", "product_translation_gateway", "product_tagline_ko_gateway",
  "crawl_tagline_gateway", "search_verify_gateway", "websearch_query_gateway", "publication_classify_gateway"] as const);

/** Positive group-exit proof, never age or the supervisor's lease, establishes caller loss. */
export function judgeExitedCaller(value: { bindingKind: string | null; bindingHash: string | null; dispatchAt: string | null;
  now: string; events: readonly ProcessGroupEvent[] }): { ended: true; exitedAt: string } | { ended: false; reason: string } {
  if (!value.bindingKind || !EXITED_CALLER_BINDINGS.some(kind => kind === value.bindingKind) || !value.bindingHash)
    return { ended: false, reason: "caller_binding_unsupported" };
  const dispatchAt = Date.parse(value.dispatchAt ?? ""), now = Date.parse(value.now);
  if (!Number.isFinite(dispatchAt) || !Number.isFinite(now)) return { ended: false, reason: "dispatch_time_unknown" };
  const local = evaluateLocalCallEnded(value.events, dispatchAt);
  if (!local.ended) return local;
  if (local.lastExitAtMs < dispatchAt || local.lastExitAtMs > now) return { ended: false, reason: "caller_exit_time_mismatch" };
  return { ended: true, exitedAt: new Date(local.lastExitAtMs).toISOString() };
}

export const exitedCallerEvidenceSchema = z.object({ version: z.literal(1), kind: z.literal("caller_process_exited"),
  requestId: z.uuid(), owner: z.object({ instanceId: identity(120), bootId: z.uuid() }).strict(), fromState: z.literal("dispatched"),
  dispatchAt: isoMillis, evaluatedAt: isoMillis, bindingKind: z.enum(EXITED_CALLER_BINDINGS), bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  exitedAt: isoMillis, exits: z.array(z.object({ seq: z.number().int().positive(), runId: z.uuid(), pid: z.number().int().positive(),
    exitedAt: isoMillis }).strict()).min(1), operator: identity(120) }).strict();
