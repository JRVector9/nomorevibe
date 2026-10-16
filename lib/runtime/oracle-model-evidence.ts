import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { reviewHash } from '@/lib/crawl/agent-review-contract';
import { productTaglineKoDispatchBindingHash, productTaglineKoDispatchBindingSchema, productTaglineKoGatewayTerminalEvidenceSchema,
  productTranslationDispatchBindingHash, productTranslationDispatchBindingSchema, productTranslationGatewayTerminalEvidenceSchema,
  reasonTranslationDispatchBindingHash, reasonTranslationDispatchBindingSchema, reasonTranslationGatewayTerminalEvidenceSchema } from '@/lib/llm/capacity';
import { reasonTranslationServingContractHash, reasonTranslationServingContractSchema, resolveReasonTranslationServingContract } from '@/lib/llm/reason-translation-serving-contract';
import { productTaglineKoServingContractHash, productTaglineKoServingContractSchema, resolveProductTaglineKoServingContract } from '@/lib/llm/product-tagline-ko-serving-contract';
import { productTranslationServingContractHash, productTranslationServingContractSchema, resolveProductTranslationServingContract } from '@/lib/llm/product-translation-serving-contract';

/**
 * Model-bound canary evidence for the Oracle translation role. Positive only when every durable capacity row that the
 * ACKed tick (job, requestedVersion, boot, batch epoch) dispatched is settled with native terminal evidence, and each
 * row's dispatch binding names the serving contract that the current release resolves for that exact model. While a
 * route's resolver returns null (no enabled serving deployment), the result is always unknown. Legacy (capacity
 * disabled) calls leave no bound row and therefore never verify a model.
 */
const HOST = 'oracle-osaka-smoke';
type Contract = { routeId: string; provider: string; model: string; totalTokenBound: number };
type Route = { binding: z.ZodType; bindingHash: (value: never) => string; terminal: z.ZodType;
  contract: z.ZodType<Contract>; contractHash: (value: never) => string; resolve: (model: string) => unknown };
const ROUTES: Record<string, Route> = {
  'reason-translate': { binding: reasonTranslationDispatchBindingSchema, bindingHash: reasonTranslationDispatchBindingHash,
    terminal: reasonTranslationGatewayTerminalEvidenceSchema, contract: reasonTranslationServingContractSchema,
    contractHash: reasonTranslationServingContractHash, resolve: resolveReasonTranslationServingContract },
  'product-tagline-ko': { binding: productTaglineKoDispatchBindingSchema, bindingHash: productTaglineKoDispatchBindingHash,
    terminal: productTaglineKoGatewayTerminalEvidenceSchema, contract: productTaglineKoServingContractSchema,
    contractHash: productTaglineKoServingContractHash, resolve: resolveProductTaglineKoServingContract },
  'product-translate': { binding: productTranslationDispatchBindingSchema, bindingHash: productTranslationDispatchBindingHash,
    terminal: productTranslationGatewayTerminalEvidenceSchema, contract: productTranslationServingContractSchema,
    contractHash: productTranslationServingContractHash, resolve: resolveProductTranslationServingContract },
};
export const ORACLE_MODEL_ROUTES = Object.keys(ROUTES);
const rowSchema = z.object({ requestId: z.string(), state: z.string(), routeId: z.string(), provider: z.string(), model: z.string(),
  dispatchBinding: z.unknown(), dispatchBindingHash: z.string().nullable(), terminalEvidence: z.unknown(),
  terminalEvidenceHash: z.string().nullable(), settledAt: z.string().nullable() }).strict();
export type OracleModelReadbackRow = z.infer<typeof rowSchema>;
export type OracleModelTick = { job: string; instanceId: string; release: string; bootId: string; batchEpoch: number;
  requestedVersion: number; recordedAt: string };
export type OracleModelEvidence = { model: 'verified'; reason: 'model_bound_readback_verified'; modelBoundEvidenceHash: string; calls: number }
  | { model: 'unknown'; reason: string };
const unknown = (reason: string): OracleModelEvidence => ({ model: 'unknown', reason });

/** Pure classification of every model_capacity_requests row whose dispatch binding names this tick (route, owner
 * instance/boot, job name and requestedVersion; any state). The attest and preflight queries use that same predicate.
 * One row that is not a settled, contract-bound native terminal makes the whole tick unknown. Resolvers: tests only. */
export function classifyOracleModelEvidence(tick: OracleModelTick, rows: readonly unknown[],
  resolve: (job: string, model: string) => unknown = (job, model) => ROUTES[job]?.resolve(model) ?? null): OracleModelEvidence {
  const route = ROUTES[tick.job];
  if (!route) return unknown('model_route_unsupported');
  if (!rows.length) return unknown('model_readback_empty');
  const calls: { requestId: string; servingContractHash: string; dispatchBindingHash: string; terminalEvidenceHash: string }[] = [];
  for (const value of rows) {
    const row = rowSchema.safeParse(value), binding = route.binding.safeParse(row.data?.dispatchBinding);
    const terminal = route.terminal.safeParse(row.data?.terminalEvidence);
    if (!row.success || !binding.success || !terminal.success) return unknown('model_readback_mismatch');
    const b = binding.data as { model: string; provider: string; routeId: string; servingContractHash: string; totalTokenBound: number;
      job: { name: string; requestedVersion: number }; role: { role: string; instanceId: string; bootId: string; release: string;
        batch: { mode: string; host?: string; batchEpoch?: number } } };
    const t = terminal.data as { dispatch: { requestId: string; bindingHash: string; binding: unknown } };
    const { data } = row, settledAt = Date.parse(data.settledAt ?? '');
    if (data.state !== 'settled' || data.routeId !== tick.job || b.routeId !== tick.job || data.provider !== b.provider || data.model !== b.model
      || data.dispatchBindingHash !== route.bindingHash(binding.data as never) || data.terminalEvidenceHash !== reviewHash(terminal.data)
      || t.dispatch.requestId !== data.requestId || t.dispatch.bindingHash !== data.dispatchBindingHash || !isDeepStrictEqual(t.dispatch.binding, binding.data)
      || b.job.name !== tick.job || b.job.requestedVersion !== tick.requestedVersion || b.role.role !== 'translation'
      || b.role.instanceId !== tick.instanceId || b.role.bootId !== tick.bootId || b.role.release !== tick.release
      || b.role.batch.mode !== 'versioned' || b.role.batch.host !== HOST || b.role.batch.batchEpoch !== tick.batchEpoch
      || !Number.isFinite(settledAt) || settledAt > Date.parse(tick.recordedAt)) return unknown('model_readback_mismatch');
    const resolved = resolve(tick.job, b.model);
    if (resolved === null || resolved === undefined) return unknown('serving_contract_unavailable');
    const contract = route.contract.safeParse(structuredClone(resolved));
    if (!contract.success || contract.data.routeId !== tick.job || contract.data.provider !== b.provider || contract.data.model !== b.model
      || contract.data.totalTokenBound !== b.totalTokenBound || route.contractHash(contract.data as never) !== b.servingContractHash)
      return unknown('serving_contract_mismatch');
    calls.push({ requestId: data.requestId, servingContractHash: b.servingContractHash, dispatchBindingHash: data.dispatchBindingHash!,
      terminalEvidenceHash: data.terminalEvidenceHash! });
  }
  calls.sort((a, c) => a.requestId < c.requestId ? -1 : a.requestId > c.requestId ? 1 : 0);
  const modelBoundEvidenceHash = createHash('sha256').update(JSON.stringify({ job: tick.job, requestedVersion: tick.requestedVersion, calls })).digest('hex');
  return { model: 'verified', reason: 'model_bound_readback_verified', modelBoundEvidenceHash, calls: calls.length };
}
