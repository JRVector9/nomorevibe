import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cliModelDispatchSchema, cliModelTerminalEvidenceSchema, type CliModelDispatch } from "@/lib/llm/capacity";
import { readCliModelDispatchRecord } from "@/lib/llm/capacity-repository";
import { logger } from "@/lib/observability/logger";
import { cliHostRequest, readCliHostCatalog } from "@/lib/operations/cli-host-client";
import { validateCliHostTarget, type CliHostTarget } from "@/lib/operations/cli-host-target";
import { cliHostNotStartedResponseSchema, cliHostPrepareResponseSchema, cliHostReleaseResponseSchema, cliHostRunResponseSchema,
  encodeCliHostInput, type CliHostHandle, type CliHostPrepareOptions, type CliHostSettlement } from "@/lib/operations/cli-host-protocol";
import { reviewHash, validateReviewOutcome, type ReviewInput } from "./agent-review-contract";
import { reviewCliContractMatches, reviewCliServingContract, type PreparedReviewCliCall, type ReviewCliOutcome } from "./review-cli-call";
import { assertLiveReviewAdapterAllowed } from "./review-fixture-transport";

type State = { handle: CliHostHandle; target: CliHostTarget; inputIdentity: string; used: boolean; released: boolean };
const calls = new WeakMap<PreparedReviewCliCall, State>();
const inputIdentity = (input: ReviewInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const safeCode = (error: unknown): string => error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : "transport_error";
export const isRemoteReviewCliCall = (call: PreparedReviewCliCall): boolean => calls.has(call);

/** Host admission is a read of the exact committed historical dispatch, never an authority supplied by RPC JSON. */
export async function assertCliHostDispatch(value: CliModelDispatch, allowIndeterminate = false): Promise<void> {
  const dispatch = cliModelDispatchSchema.parse(value);
  if (dispatch.binding.provider !== "opencode-cli" || !["ai1_legacy_cli", "ai1_item_cli", "ai2_item_cli"].includes(dispatch.binding.kind))
    throw new Error("cli_host_dispatch_unsupported");
  const record = await readCliModelDispatchRecord(dispatch.requestId);
  if (!record || record.state !== "dispatched" && !(allowIndeterminate && record.state === "indeterminate")
    || !isDeepStrictEqual(record.dispatch, dispatch)) throw new Error("cli_host_dispatch_mismatch");
}

export async function prepareRemoteReviewCliCall(input: ReviewInput, options: CliHostPrepareOptions, selectedTarget: CliHostTarget) {
  assertLiveReviewAdapterAllowed();
  const unsupported = { kind: "unsupported", reason: "provider_contract_unavailable" } as const;
  try {
    const target = validateCliHostTarget(selectedTarget);
    if (target.connectionId !== options.connectionId) return unsupported;
    const catalog = await readCliHostCatalog(target);
    const selected = catalog.models.find(entry => entry.id === options.model);
    if (!selected || options.reasoningEffort && !selected.variants.includes(options.reasoningEffort)) return unsupported;
    const contract = reviewCliServingContract(options.routeId, options.provider, options.model);
    if (!contract || contract.cliVersion !== catalog.cliVersion) return unsupported;
    const response = await cliHostRequest(target, { version: 1, action: "prepare", data: { input: encodeCliHostInput(input), options } }, cliHostPrepareResponseSchema);
    if (response.kind !== "prepared") return response;
    const call = Object.freeze(response.call);
    if (response.handle.bootId !== catalog.bootId || response.handle.connectionId !== options.connectionId
      || call.routeId !== options.routeId || call.provider !== options.provider || call.model !== options.model || call.inputHash !== input.inputHash
      || call.transport.timeoutMs > options.timeoutMs || call.transport.maxStdoutBytes !== 65_536 || call.transport.maxStderrBytes !== 16_384
      || !reviewCliContractMatches(call, contract)) {
      // A prepared call has not run. Best effort cleanup is not a dispatch/terminal fact.
      await releasePreparedHandle(target, response.handle);
      throw new Error("cli_host_prepared_mismatch");
    }
    calls.set(call, { handle: response.handle, target, inputIdentity: inputIdentity(input), used: false, released: false });
    return call;
  } catch (error) {
    // No run request exists yet: connection/catalog failures retain the normal pre-admission deferred boundary.
    logger.warn("cli_host.prepare_unavailable", { code: safeCode(error) });
    return unsupported;
  }
}

function own(call: PreparedReviewCliCall, value: CliModelDispatch): { state: State; dispatch: CliModelDispatch } {
  const state = calls.get(call), dispatch = cliModelDispatchSchema.parse(value), binding = dispatch.binding;
  const hash = binding.kind === "ai1_legacy_cli" ? binding.inputHash
    : binding.kind === "ai1_item_cli" || binding.kind === "ai2_item_cli" ? binding.review.inputHash : null;
  if (!state || state.released || hash !== call.inputHash || binding.routeId !== call.routeId || binding.provider !== call.provider
    || binding.model !== call.model || binding.totalTokenBound !== call.totalTokenBound || !isDeepStrictEqual(binding.transport, call.transport))
    throw new Error("remote_review_cli_call_mismatch");
  return { state, dispatch };
}
function responseIdentity(response: { handle: CliHostHandle; requestId: string; bindingHash: string }, state: State, dispatch: CliModelDispatch): void {
  if (!isDeepStrictEqual(response.handle, state.handle) || response.requestId !== dispatch.requestId || response.bindingHash !== dispatch.bindingHash)
    throw new Error("cli_host_response_mismatch");
}
/** Acknowledgment JSON is not a terminal capability: the primary ledger must already contain the native host's settlement. */
export async function verifyCliHostSettlement(dispatch: CliModelDispatch, response: CliHostSettlement, requireNotStarted = false) {
  const record = await readCliModelDispatchRecord(dispatch.requestId);
  const parsed = cliModelTerminalEvidenceSchema.safeParse(record?.terminalEvidence);
  if (!record || record.state !== "settled" || !isDeepStrictEqual(record.dispatch, dispatch) || !parsed.success
    || !isDeepStrictEqual(parsed.data.dispatch, dispatch) || record.terminalEvidenceHash !== response.terminalEvidenceHash
    || reviewHash(parsed.data) !== response.terminalEvidenceHash || requireNotStarted && parsed.data.process.ending !== "not_started")
    throw new Error("cli_host_settlement_unverified");
  return parsed.data;
}

export async function settleRemoteReviewCliNotStarted(call: PreparedReviewCliCall, value: CliModelDispatch): Promise<CliHostSettlement | null> {
  const { state, dispatch } = own(call, value);
  if (state.used) return null;
  state.used = true;
  const response = await cliHostRequest(state.target, { version: 1, action: "notStarted", data: { handle: state.handle, dispatch } }, cliHostNotStartedResponseSchema);
  responseIdentity(response, state, dispatch);
  if (response.kind !== "settled") return null;
  await verifyCliHostSettlement(dispatch, response, true);
  return response;
}

export async function runRemoteReviewCliCall(input: ReviewInput, value: CliModelDispatch, call: PreparedReviewCliCall,
  options: { signal?: AbortSignal } = {}): Promise<ReviewCliOutcome> {
  const { state, dispatch } = own(call, value);
  if (state.used || state.inputIdentity !== inputIdentity(input)) throw new Error("remote_review_cli_call_mismatch");
  if (options.signal?.aborted) {
    const settled = await settleRemoteReviewCliNotStarted(call, dispatch);
    return settled ? { result: { ok: false, error: "cancelled" }, terminal: null, indeterminate: null, remoteSettlement: settled }
      : { result: { ok: false, error: "cli_error" }, terminal: null, indeterminate: "transport_unknown" };
  }
  state.used = true;
  try {
    const response = await cliHostRequest(state.target, { version: 1, action: "run", data: { handle: state.handle, dispatch } }, cliHostRunResponseSchema,
      call.transport.timeoutMs + 15_000);
    responseIdentity(response, state, dispatch);
    if (response.kind !== "settled") return { result: { ok: false, error: "cli_error" }, terminal: null, indeterminate: response.reason };
    const evidence = await verifyCliHostSettlement(dispatch, response);
    if (response.result.ok && (evidence.process.ending !== "exited" || evidence.process.exitCode !== 0))
      throw new Error("cli_host_success_without_exit");
    const result = response.result.ok ? { ...response.result, outcome: validateReviewOutcome(input, response.result.outcome) } : response.result;
    return { result, terminal: null, indeterminate: null, remoteSettlement: response };
  } catch (error) {
    // Once a run request was attempted, loss of the response must not cause another spawn or a not_started claim.
    logger.warn("cli_host.run_unknown", { requestId: dispatch.requestId, code: safeCode(error) });
    return { result: { ok: false, error: "cli_error" }, terminal: null, indeterminate: "transport_unknown" };
  }
}

export async function releaseRemoteReviewCliCall(call: PreparedReviewCliCall): Promise<void> {
  const state = calls.get(call);
  if (!state || state.released) return;
  state.released = true;
  // Once attempted, the host owns process cleanup and settlement. Do not send another execution-affecting RPC.
  if (state.used) return;
  await releasePreparedHandle(state.target, state.handle);
}

async function releasePreparedHandle(target: CliHostTarget, handle: CliHostHandle): Promise<void> {
  try { await cliHostRequest(target, { version: 1, action: "release", data: { handle } }, cliHostReleaseResponseSchema); }
  catch (error) {
    // This only frees unused preparation resources. The host TTL cleans up if connectivity is lost.
    logger.warn("cli_host.prepare_cleanup_failed", { code: safeCode(error) });
  }
}
