import { isDeepStrictEqual } from 'node:util';
import { cliModelDispatchSchema, type CliModelDispatch } from '@/lib/llm/capacity';
import {
  cliServingContractHash,
  cliServingContractSchema,
  resolveCliServingContract,
  type CliServingContract,
} from '@/lib/llm/cli-serving-contract';
import { logger } from '@/lib/observability/logger';
import { cliHostRequest, readCliHostCatalog } from '@/lib/operations/cli-host-client';
import { readCliHostTarget, type CliHostTarget } from '@/lib/operations/cli-host-target';
import {
  type CliHostHandle,
  type CliHostSettlement,
} from '@/lib/operations/cli-host-protocol';
import {
  cliTaskPrepareDataSchema,
  cliTaskPrepareResponseSchema,
  cliTaskRunResponseSchema,
  cliTaskNotStartedResponseSchema,
  cliTaskReleaseResponseSchema,
  type CliTaskPrepareData,
  type PreparedCliTaskCall,
} from '@/lib/operations/cli-task-protocol';
import type { CliTaskOutcome as LocalCliTaskOutcome } from './cli-task-call';
import { verifyCliHostSettlement } from './review-cli-remote';

type State = {
  handle: CliHostHandle;
  target: CliHostTarget;
  used: boolean;
  released: boolean;
};

const calls = new WeakMap<PreparedCliTaskCall, State>();
const UNSUPPORTED = { kind: 'unsupported', reason: 'provider_contract_unavailable' } as const;
const safeCode = (error: unknown): string =>
  error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'transport_error';

function contractMatches(call: PreparedCliTaskCall, contract: CliServingContract): boolean {
  return contract.routeId === call.routeId
    && contract.provider === call.provider
    && contract.model === call.model
    && call.transport.provider === contract.provider
    && call.transport.model === contract.model
    && call.transport.cliContractHash === cliServingContractHash(contract)
    && contract.totalTokenBound === call.totalTokenBound;
}

/** Host admission is a read of the exact committed historical dispatch, never an authority supplied by RPC JSON. */
function own(call: PreparedCliTaskCall, value: CliModelDispatch): { state: State; dispatch: CliModelDispatch } {
  const state = calls.get(call);
  const dispatch = cliModelDispatchSchema.parse(value);
  const binding = dispatch.binding;
  if (!state || state.released) throw new Error('remote_cli_task_call_mismatch');
  if (binding.kind === 'intro_check_cli') {
    if (call.routeId !== 'product-intro-check') throw new Error('remote_cli_task_call_mismatch');
  } else if (binding.kind === 'product_audit_cli') {
    if (call.routeId !== 'product-audit') throw new Error('remote_cli_task_call_mismatch');
  } else {
    throw new Error('remote_cli_task_call_mismatch');
  }
  if (binding.routeId !== call.routeId || binding.inputHash !== call.inputHash
    || binding.provider !== call.provider || binding.model !== call.model
    || binding.totalTokenBound !== call.totalTokenBound || !isDeepStrictEqual(binding.transport, call.transport))
    throw new Error('remote_cli_task_call_mismatch');
  return { state, dispatch };
}
function responseIdentity(
  response: { handle: CliHostHandle; requestId: string; bindingHash: string },
  state: State,
  dispatch: CliModelDispatch,
): void {
  if (!isDeepStrictEqual(response.handle, state.handle) || response.requestId !== dispatch.requestId
    || response.bindingHash !== dispatch.bindingHash)
    throw new Error('cli_task_host_response_mismatch');
}

async function releasePreparedHandle(target: CliHostTarget, handle: CliHostHandle): Promise<void> {
  try {
    await cliHostRequest(target, { version: 1, action: 'taskRelease', data: { handle } }, cliTaskReleaseResponseSchema);
  } catch (error) {
    logger.warn('cli_task_host.prepare_cleanup_failed', { code: safeCode(error) });
  }
}

export async function prepareRemoteCliTaskCall(
  data: CliTaskPrepareData,
): Promise<PreparedCliTaskCall | { kind: 'unsupported'; reason: 'provider_contract_unavailable' }> {
  try {
    const parsed = cliTaskPrepareDataSchema.safeParse(data);
    if (!parsed.success) return UNSUPPORTED;
    const prepareData = parsed.data;
    const target = await readCliHostTarget(prepareData.connectionId);
    if (target.connectionId !== prepareData.connectionId) return UNSUPPORTED;
    const catalog = await readCliHostCatalog(target);
    const model = catalog.models.find(entry => entry.id === prepareData.model);
    if (!model || prepareData.reasoningEffort && !model.variants.includes(prepareData.reasoningEffort))
      return UNSUPPORTED;
    const resolved = resolveCliServingContract(prepareData.task, 'opencode-cli', prepareData.model);
    if (!resolved) return UNSUPPORTED;
    const parsedContract = cliServingContractSchema.safeParse(resolved);
    if (!parsedContract.success) return UNSUPPORTED;
    const contract = parsedContract.data;
    if (contract.routeId !== prepareData.task || contract.provider !== 'opencode-cli'
      || contract.model !== prepareData.model || contract.cliVersion !== catalog.cliVersion
      || !(contract.totalTokenBound > 0))
      return UNSUPPORTED;
    const response = await cliHostRequest(
      target,
      { version: 1, action: 'taskPrepare', data: prepareData },
      cliTaskPrepareResponseSchema,
    );
    if (response.kind !== 'prepared') return response;
    const call = Object.freeze({
      ...response.call,
      transport: Object.freeze({ ...response.call.transport }),
    });
    if (response.handle.bootId !== catalog.bootId || response.handle.connectionId !== prepareData.connectionId
      || call.kind !== 'prepared_cli_task' || call.routeId !== prepareData.task || call.provider !== 'opencode-cli'
      || call.model !== prepareData.model || call.inputHash !== prepareData.inputHash
      || call.transport.timeoutMs > prepareData.timeoutMs || call.transport.maxStdoutBytes !== 65_536
      || call.transport.maxStderrBytes !== 16_384 || !contractMatches(call, contract)) {
      await releasePreparedHandle(target, response.handle);
      throw new Error('cli_task_prepared_mismatch');
    }
    calls.set(call, { handle: response.handle, target, used: false, released: false });
    return call;
  } catch (error) {
    logger.warn('cli_task_host.prepare_unavailable', { code: safeCode(error) });
    return UNSUPPORTED;
  }
}

export async function settleRemoteCliTaskNotStarted(
  call: PreparedCliTaskCall,
  value: CliModelDispatch,
): Promise<CliHostSettlement | null> {
  const { state, dispatch } = own(call, value);
  if (state.used) return null;
  state.used = true;
  const response = await cliHostRequest(
    state.target,
    { version: 1, action: 'taskNotStarted', data: { handle: state.handle, dispatch } },
    cliTaskNotStartedResponseSchema,
  );
  responseIdentity(response, state, dispatch);
  if (response.kind !== 'settled') return null;
  await verifyCliHostSettlement(dispatch, response, true);
  return response;
}

export async function runRemoteCliTaskCall(
  call: PreparedCliTaskCall,
  value: CliModelDispatch,
  options: { signal?: AbortSignal } = {},
): Promise<LocalCliTaskOutcome & { remoteSettlement?: CliHostSettlement; notStarted?: boolean }> {
  const { state, dispatch } = own(call, value);
  if (state.used) throw new Error('remote_cli_task_call_mismatch');
  if (options.signal?.aborted) {
    try {
      const settled = await settleRemoteCliTaskNotStarted(call, dispatch);
      return settled
        ? {
            result: { ok: false, error: 'cancelled' },
            terminal: null,
            indeterminate: null,
            remoteSettlement: settled,
            notStarted: true,
          }
        : { result: { ok: false, error: 'cli_error' }, terminal: null, indeterminate: 'transport_unknown' };
    } catch (error) {
      logger.warn('cli_task_host.not_started_unknown', {
        requestId: dispatch.requestId,
        code: safeCode(error),
      });
      return { result: { ok: false, error: 'cli_error' }, terminal: null, indeterminate: 'transport_unknown' };
    }
  }
  state.used = true;
  try {
    const response = await cliHostRequest(
      state.target,
      { version: 1, action: 'taskRun', data: { handle: state.handle, dispatch } },
      cliTaskRunResponseSchema,
      call.transport.timeoutMs + 15_000,
    );
    responseIdentity(response, state, dispatch);
    if (response.kind !== 'settled')
      return { result: { ok: false, error: 'cli_error' }, terminal: null, indeterminate: response.reason };
    const evidence = await verifyCliHostSettlement(dispatch, response);
    if (response.result.ok && (evidence.process.ending !== 'exited' || evidence.process.exitCode !== 0))
      throw new Error('cli_task_success_without_exit');
    return { result: response.result, terminal: null, indeterminate: null, remoteSettlement: response,
      notStarted: evidence.process.ending === 'not_started' };
  } catch (error) {
    logger.warn('cli_task_host.run_unknown', { requestId: dispatch.requestId, code: safeCode(error) });
    return { result: { ok: false, error: 'cli_error' }, terminal: null, indeterminate: 'transport_unknown' };
  }
}

export async function releaseRemoteCliTaskCall(call: PreparedCliTaskCall): Promise<void> {
  const state = calls.get(call);
  if (!state || state.released) return;
  state.released = true;
  if (state.used) return;
  await releasePreparedHandle(state.target, state.handle);
}
