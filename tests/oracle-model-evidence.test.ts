import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { reviewHash } from '@/lib/crawl/agent-review-contract';
import { productTaglineKoDispatchBindingHash, productTaglineKoGatewayTerminalEvidenceSchema, productTaglineKoInputHash, productTaglineKoLogicalWorkKey,
  productTranslationDispatchBindingHash, productTranslationGatewayTerminalEvidenceSchema, productTranslationInputHash, productTranslationLogicalWorkKey,
  reasonTranslationDispatchBindingHash, reasonTranslationGatewayTerminalEvidenceSchema, reasonTranslationInputHash, reasonTranslationLogicalWorkKey } from '@/lib/llm/capacity';
import { reasonTranslationServingContractHash, resolveReasonTranslationServingContract } from '@/lib/llm/reason-translation-serving-contract';
import { productTaglineKoServingContractHash, resolveProductTaglineKoServingContract } from '@/lib/llm/product-tagline-ko-serving-contract';
import { productTranslationServingContractHash, resolveProductTranslationServingContract } from '@/lib/llm/product-translation-serving-contract';
import { classifyOracleModelEvidence, ORACLE_MODEL_ROUTES, type OracleModelTick } from '@/lib/runtime/oracle-model-evidence';

const model = 'fixture-model', instanceId = 'oracle-translation', release = 'a'.repeat(40), bootId = randomUUID();
const tick: OracleModelTick = { job: 'reason-translate', instanceId, release, bootId, batchEpoch: 5, requestedVersion: 7, recordedAt: '2026-10-17T00:10:00.000Z' };
const PROTOCOL = { 'reason-translate': 'abcllm-reason-total-bound-v1', 'product-tagline-ko': 'abcllm-product-tagline-ko-total-bound-v1',
  'product-translate': 'abcllm-product-translation-total-bound-v1' } as const;
type Job = keyof typeof PROTOCOL;
const contract = (job: Job, change: Record<string, unknown> = {}) => ({ version: 1, protocol: PROTOCOL[job], routeId: job, provider: 'abcllm', model,
  responseModel: model, deploymentRevision: 'rev-1', endpoint: 'https://gateway.example/v1/chat/completions', totalTokenBound: 4096, ...change });
const contractHash = (job: Job, value: ReturnType<typeof contract>) => (job === 'reason-translate' ? reasonTranslationServingContractHash
  : job === 'product-tagline-ko' ? productTaglineKoServingContractHash : productTranslationServingContractHash)(value as never);
const role = (change: Record<string, unknown> = {}) => ({ role: 'translation', instanceId, bootId, release, kind: 'primary', epoch: 3,
  batch: { mode: 'versioned', host: 'oracle-osaka-smoke', batchEpoch: 5 }, ...change });

function row(job: Job = 'reason-translate', change: { binding?: Record<string, unknown>; row?: Record<string, unknown> } = {}) {
  const requestId = randomUUID();
  const members = job === 'reason-translate' ? [{ sourceHash: 'b'.repeat(64), cache: { kind: 'absent' } }]
    : job === 'product-tagline-ko' ? [{ productId: 1, slug: 'habit', sourceIdentityHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64), cache: { kind: 'absent' } }]
      : [{ productId: 1, slug: 'habit', locale: 'en', field: 'tagline', sourceHash: 'b'.repeat(64), demand: { rowIdentityHash: 'c'.repeat(64), attempts: 0 } }];
  const input = { members, model } as never;
  const [logicalWorkKey, inputHash] = job === 'reason-translate' ? [reasonTranslationLogicalWorkKey(members as never), reasonTranslationInputHash(input)]
    : job === 'product-tagline-ko' ? [productTaglineKoLogicalWorkKey(members as never), productTaglineKoInputHash(input)]
      : [productTranslationLogicalWorkKey(members as never), productTranslationInputHash(input)];
  const kind = { 'reason-translate': 'reason_translation_gateway', 'product-tagline-ko': 'product_tagline_ko_gateway', 'product-translate': 'product_translation_gateway' }[job];
  const binding = { members, model, kind, version: 1, logicalWorkKey, inputHash, provider: 'abcllm', routeId: job, wireHash: 'd'.repeat(64),
    servingContractHash: contractHash(job, contract(job)), totalTokenBound: 4096, chargedTokens: 4096,
    job: { name: job, token: randomUUID(), requestedVersion: 7 }, role: role(), ...change.binding } as Record<string, unknown> & { role: { instanceId: string; bootId: string } };
  const bindingHash = (job === 'reason-translate' ? reasonTranslationDispatchBindingHash : job === 'product-tagline-ko'
    ? productTaglineKoDispatchBindingHash : productTranslationDispatchBindingHash)(binding as never);
  const terminal = (job === 'reason-translate' ? reasonTranslationGatewayTerminalEvidenceSchema : job === 'product-tagline-ko'
    ? productTaglineKoGatewayTerminalEvidenceSchema : productTranslationGatewayTerminalEvidenceSchema).parse({ version: 1, kind: `${kind}_terminal`,
    dispatch: { requestId, owner: { instanceId: binding.role.instanceId, bootId: binding.role.bootId }, token: randomUUID(), epoch: 1, revision: 1, policyHash: 'e'.repeat(64), binding, bindingHash },
    finishReason: 'stop', responseHash: 'f'.repeat(64), actualUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, provenance: 'upstream_reported' });
  return { requestId, state: 'settled', routeId: job, provider: 'abcllm', model, dispatchBinding: binding, dispatchBindingHash: bindingHash,
    terminalEvidence: terminal, terminalEvidenceHash: reviewHash(terminal), settledAt: '2026-10-17T00:09:59.000Z', ...change.row };
}
const enabled = (job: string, name: string) => name === model ? contract(job as Job) : null;

it('keeps every translation route unknown while its serving contract resolver returns null', () => {
  expect(ORACLE_MODEL_ROUTES).toEqual(['reason-translate', 'product-tagline-ko', 'product-translate']);
  for (const resolve of [resolveReasonTranslationServingContract, resolveProductTaglineKoServingContract, resolveProductTranslationServingContract])
    expect(resolve(model)).toBeNull();
  for (const job of ORACLE_MODEL_ROUTES as Job[]) {
    // A fully valid settled, bound native terminal is still not model evidence without an enabled contract.
    expect(classifyOracleModelEvidence({ ...tick, job }, [row(job)])).toEqual({ model: 'unknown', reason: 'serving_contract_unavailable' });
    expect(classifyOracleModelEvidence({ ...tick, job }, [])).toEqual({ model: 'unknown', reason: 'model_readback_empty' });
  }
  expect(classifyOracleModelEvidence({ ...tick, job: 'news-refresh' }, [row()], enabled)).toEqual({ model: 'unknown', reason: 'model_route_unsupported' });
});

it('verifies only the tick rows bound to the contract the release resolves, with an order-independent hash', () => {
  for (const job of ORACLE_MODEL_ROUTES as Job[]) {
    const rows = [row(job), row(job)];
    const result = classifyOracleModelEvidence({ ...tick, job }, rows, enabled);
    expect(result).toMatchObject({ model: 'verified', reason: 'model_bound_readback_verified', calls: 2 });
    expect(classifyOracleModelEvidence({ ...tick, job }, [...rows].reverse(), enabled)).toEqual(result);
    expect(classifyOracleModelEvidence({ ...tick, job }, rows.slice(0, 1), enabled)).not.toEqual(result);
  }
});

it.each([
  ['indeterminate state', { row: { state: 'indeterminate' } }, 'model_readback_mismatch'],
  ['other boot', { binding: { role: role({ bootId: randomUUID() }) } }, 'model_readback_mismatch'],
  ['other batch epoch', { binding: { role: role({ batch: { mode: 'versioned', host: 'oracle-osaka-smoke', batchEpoch: 6 } }) } }, 'model_readback_mismatch'],
  ['M3 host', { binding: { role: role({ batch: { mode: 'versioned', host: 'm3', batchEpoch: 5 } }) } }, 'model_readback_mismatch'],
  ['legacy text parent', { binding: { role: { role: 'text', instanceId, bootId, release, kind: 'primary', epoch: 3, batch: { mode: 'legacy' } } } }, 'model_readback_mismatch'],
  ['other release', { binding: { role: role({ release: 'b'.repeat(40) }) } }, 'model_readback_mismatch'],
  ['other requested version', { binding: { job: { name: 'reason-translate', token: randomUUID(), requestedVersion: 8 } } }, 'model_readback_mismatch'],
  ['settled after the ACK', { row: { settledAt: '2026-10-17T00:10:01.000Z' } }, 'model_readback_mismatch'],
  ['tampered terminal hash', { row: { terminalEvidenceHash: '0'.repeat(64) } }, 'model_readback_mismatch'],
  ['tampered binding hash', { row: { dispatchBindingHash: '0'.repeat(64) } }, 'model_readback_mismatch'],
  ['row model drift', { row: { model: 'other-model' } }, 'model_readback_mismatch'],
  ['older contract deployment', { binding: { servingContractHash: reasonTranslationServingContractHash(contract('reason-translate', { deploymentRevision: 'rev-0' }) as never) } }, 'serving_contract_mismatch'],
] as const)('one %s row makes the whole tick unknown', (_name, change, reason) => {
  expect(classifyOracleModelEvidence(tick, [row(), row('reason-translate', change as never)], enabled)).toEqual({ model: 'unknown', reason });
});

it('rejects a contract whose bound total differs from the dispatched charge', () => {
  const smaller = (job: string, name: string) => name === model ? contract(job as Job, { totalTokenBound: 2048 }) : null;
  expect(classifyOracleModelEvidence(tick, [row()], smaller)).toEqual({ model: 'unknown', reason: 'serving_contract_mismatch' });
});
