import { createHash } from 'node:crypto';
import { gatewayFetch } from '@/lib/llm/gateway-local-end-fetch';
import { observeProviderTransport } from '@/lib/llm/provider-circuit-breaker';
import { gatewayNotSentWitness, issueGatewayNotStarted, type GatewayNotStarted } from '@/lib/llm/gateway-not-started';
import { publicationClassifyApiDispatchSchema, publicationClassifyApiTerminalSchema,
  type PublicationClassifyApiDispatch, type PublicationClassifyApiTerminalEvidence } from '@/lib/llm/capacity';
import { publicationClassifyRouteServingContractSchema, publicationClassifyServingContractHash,
  resolvePublicationClassifyServingContract, type PublicationClassifyServingContract } from '@/lib/llm/publication-classify-serving-contract';
import type { GatewayContractProvider } from '@/lib/llm/direct-serving-contract';
import { contractBearer, directBudgetExceeded, directTextBudgetFailure, directTransport, nativeTerminal,
  textRedirect, textWireFor, wireMaxTokens } from './agent-review-gateway';
import { assertLiveReviewAdapterAllowed } from './review-fixture-transport';
import { OUTPUT_SCHEMA, parseCategories, promptFor, type ClassifyInput } from './classify';
import type { CategoryDefinitions } from './settings-schema';
import { reviewHash } from './agent-review-contract';
import type { Category } from '@/lib/domain/products/schema';

type Payload = { inputs: ClassifyInput[]; definitions: CategoryDefinitions };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function wire(payload: Payload, model: string) {
  return JSON.stringify({ model, stream: false, temperature: 0, max_tokens: 2000,
    messages: [{ role: 'user', content: promptFor(payload.inputs, payload.definitions) }],
    response_format: { type: 'json_schema', json_schema: { name: 'publication_categories', strict: true, schema: OUTPUT_SCHEMA } } });
}
export type PreparedPublicationClassifyCall = Readonly<{ kind: 'prepared'; provider: GatewayContractProvider;
  model: string; wireHash: string; servingContractHash: string; totalTokenBound: number; payloadHash: string; definitionsHash: string }>;
export type PublicationClassifyGatewayTerminal = Readonly<{ kind: 'publication_classify_gateway_terminal' }>;
const calls = new WeakMap<PreparedPublicationClassifyCall, { wire: string; contract: PublicationClassifyServingContract; used: boolean; timeoutMs: number }>();
const terminals = new WeakMap<PublicationClassifyGatewayTerminal, PublicationClassifyApiTerminalEvidence>();
const dispatched = new Set<string>();
export function preparePublicationClassifyCall(payload: Payload, options: { model: string; provider: GatewayContractProvider; timeoutMs: number }):
  PreparedPublicationClassifyCall | { kind: 'unsupported'; reason: 'provider_contract_unavailable' } {
  assertLiveReviewAdapterAllowed();
  const unsupported = { kind: 'unsupported', reason: 'provider_contract_unavailable' } as const;
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || payload.inputs.length < 1 || payload.inputs.length > 10) return unsupported;
  const resolved = resolvePublicationClassifyServingContract(options.model, options.provider);
  if (!resolved) return unsupported;
  const contract = publicationClassifyRouteServingContractSchema.parse(structuredClone(resolved));
  if (contract.provider !== options.provider || contractBearer(contract) === undefined) return unsupported;
  const serialized = textWireFor(contract, options.model, model => wire(payload, model));
  const call = Object.freeze({ kind: 'prepared' as const, model: options.model, provider: options.provider, wireHash: hash(serialized),
    servingContractHash: publicationClassifyServingContractHash(contract), totalTokenBound: contract.totalTokenBound,
    payloadHash: reviewHash(payload.inputs), definitionsHash: reviewHash(payload.definitions) });
  calls.set(call, { wire: serialized, contract: Object.freeze(contract), used: false, timeoutMs: options.timeoutMs });
  return call;
}
export function readPublicationClassifyTerminal(value: unknown): PublicationClassifyApiTerminalEvidence | null {
  return value && typeof value === 'object' ? terminals.get(value as PublicationClassifyGatewayTerminal) ?? null : null;
}
export async function runPublicationClassifyCall(payload: Payload, dispatch: PublicationClassifyApiDispatch, call: PreparedPublicationClassifyCall,
  options: { signal?: AbortSignal; canStart: () => boolean }): Promise<{ categories: Category[] | null;
    terminal: PublicationClassifyGatewayTerminal | null; notStarted?: GatewayNotStarted }> {
  assertLiveReviewAdapterAllowed();
  const state = calls.get(call), checked = publicationClassifyApiDispatchSchema.safeParse(structuredClone(dispatch));
  if (!state || state.used || !checked.success) throw new Error('publication_classify_call_mismatch');
  const owned = checked.data, b = owned.binding;
  if (b.provider !== call.provider || b.model !== call.model || b.wireHash !== call.wireHash || b.servingContractHash !== call.servingContractHash
    || b.totalTokenBound !== call.totalTokenBound || b.payloadHash !== call.payloadHash || b.definitionsHash !== call.definitionsHash
    || reviewHash(payload.inputs) !== call.payloadHash || reviewHash(payload.definitions) !== call.definitionsHash
    || textWireFor(state.contract, call.model, model => wire(payload, model)) !== state.wire || dispatched.has(owned.requestId))
    throw new Error('publication_classify_call_mismatch');
  state.used = true; dispatched.add(owned.requestId);
  const notStarted = () => ({ categories: null, terminal: null, notStarted: issueGatewayNotStarted(owned) });
  if (options.signal?.aborted || !options.canStart()) return notStarted();
  const key = contractBearer(state.contract);
  if (key === undefined) return notStarted();
  const timeout = AbortSignal.timeout(state.timeoutMs), signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let body: string;
  try {
    if (await directTextBudgetFailure(state.contract, state.wire, { timeoutMs: state.timeoutMs, signal })) return notStarted();
    if (signal.aborted || !options.canStart()) return notStarted();
    const response = await observeProviderTransport(gatewayFetch(owned.requestId, state.contract.endpoint, { method: 'POST',
      redirect: textRedirect(state.contract), headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: state.wire, signal }), signal);
    if (response.status !== 200) { try { await response.body?.cancel(); } catch { /* Unknown completion retains C. */ }
      return { categories: null, terminal: null }; }
    body = await response.text();
  } catch (error) { return { categories: null, terminal: null, ...gatewayNotSentWitness(owned, error) }; }
  const completed = nativeTerminal(body, state.contract, directTransport(state.contract));
  if (!completed) return { categories: null, terminal: null };
  const terminal: PublicationClassifyGatewayTerminal = Object.freeze({ kind: 'publication_classify_gateway_terminal' });
  terminals.set(terminal, freeze(publicationClassifyApiTerminalSchema.parse({ version: 1,
    kind: 'publication_classify_gateway_terminal', dispatch: owned, responseHash: hash(body), ...completed })));
  const content = (JSON.parse(body) as { choices: { message: { content: string | null } }[] }).choices[0].message.content;
  const parsed = completed.finishReason === 'stop' && !directBudgetExceeded(state.contract, wireMaxTokens(state.wire), completed.actualUsage)
    ? parseCategories({ kind: 'exit', code: 0, stdout: content ?? '', stderr: '' }, payload.inputs.length) : null;
  return { categories: parsed?.map(item => item.category) ?? null, terminal };
}
