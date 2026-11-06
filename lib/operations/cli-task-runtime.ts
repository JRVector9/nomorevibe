import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CliModelDispatch } from '@/lib/llm/capacity';
import { markModelDispatchIndeterminate, reconcileCliProcessTerminal } from '@/lib/llm/capacity-repository';
import { readCliProcessTerminal, type CliProcessTerminal } from '@/lib/llm/cli-process-runner';
import { markUnsettledDispatch } from '@/lib/llm/capacity-unsettled';
import { ensureServingContracts } from '@/lib/llm/serving-contract-store';
import { logger } from '@/lib/observability/logger';
import { reviewHash } from '@/lib/crawl/agent-review-contract';
import {
  prepareLocalCliTaskCall,
  runLocalCliTaskCall,
  settleLocalCliTaskNotStarted,
  releaseLocalCliTaskCall,
} from '@/lib/crawl/cli-task-call';
import { assertCliHostDispatch } from '@/lib/crawl/review-cli-remote';
import {
  cliHostCatalogSchema,
  type CliHostCatalog,
  type CliHostHandle,
} from '@/lib/operations/cli-host-protocol';
import {
  cliTaskPrepareDataSchema,
  cliTaskPrepareResponseSchema,
  cliTaskRunResponseSchema,
  cliTaskNotStartedResponseSchema,
  cliTaskReleaseResponseSchema,
  type CliTaskPrepareData,
  type CliTaskRequest,
  type PreparedCliTaskCall,
} from '@/lib/operations/cli-task-protocol';

type BoundData = Extract<CliTaskRequest, { action: 'taskRun' | 'taskNotStarted' }>['data'];
type Call = {
  handle: CliHostHandle;
  call: PreparedCliTaskCall;
  createdAt: number;
  used: boolean;
};

const UNSUPPORTED = { kind: 'unsupported', reason: 'provider_contract_unavailable' } as const;
const MAX_CALLS = 64;
const PREPARE_TTL_MS = 120_000;
const safeCode = (error: unknown): string =>
  error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'cli_task_error';

/** Only this process holds the native prepared call and native terminal. No JSON response can carry a settlement capability. */
export class CliTaskRuntime {
  readonly bootId: string;
  private readonly calls = new Map<string, Call>();
  private readonly active = new Set<Promise<unknown>>();
  private closing = false;

  constructor(
    bootId: string,
    private readonly loadCatalog: () => Promise<CliHostCatalog>,
    private readonly acceptPrepare: () => boolean = () => true,
  ) {
    this.bootId = bootId;
  }

  get size(): number {
    return this.calls.size;
  }

  private allowed(): boolean {
    try {
      return this.acceptPrepare();
    } catch {
      return false;
    }
  }

  private async readCatalog(): Promise<CliHostCatalog> {
    if (this.closing) throw new Error('cli_task_runtime_closing');
    const catalog = cliHostCatalogSchema.parse(await this.loadCatalog());
    if (catalog.bootId !== this.bootId) throw new Error('cli_task_catalog_mismatch');
    return catalog;
  }

  async expire(): Promise<void> {
    const now = Date.now();
    for (const [id, state] of this.calls) {
      if (state.used || now - state.createdAt <= PREPARE_TTL_MS) continue;
      this.calls.delete(id);
      try {
        await releaseLocalCliTaskCall(state.call);
      } catch (error) {
        logger.warn('cli_task.expire_release_failed', { code: safeCode(error) });
      }
    }
  }

  private async executePrepare(data: CliTaskPrepareData) {
    const parsed = cliTaskPrepareDataSchema.safeParse(data);
    if (!parsed.success) return UNSUPPORTED;
    const prepareData = { ...parsed.data };
    if (this.closing || !this.allowed()) return UNSUPPORTED;
    await this.expire();
    if (this.calls.size >= MAX_CALLS || !this.allowed()) return UNSUPPORTED;
    const catalog = await this.readCatalog();
    const model = catalog.models.find(entry => entry.id === prepareData.model);
    if (!model || (prepareData.reasoningEffort !== undefined && !model.variants.includes(prepareData.reasoningEffort)))
      return UNSUPPORTED;
    await ensureServingContracts();
    const call = await prepareLocalCliTaskCall(prepareData, model.variants);
    if (call.kind !== 'prepared_cli_task') return UNSUPPORTED;
    if (call.routeId !== prepareData.task || call.provider !== 'opencode-cli' || call.model !== prepareData.model
      || call.inputHash !== prepareData.inputHash || call.transport.timeoutMs > prepareData.timeoutMs
      || call.transport.maxStdoutBytes !== 65_536 || call.transport.maxStderrBytes !== 16_384) {
      await releaseLocalCliTaskCall(call).catch(() => {});
      return UNSUPPORTED;
    }
    // A shutdown or competing prepare may have arrived while the native profile was being prepared.
    if (this.closing || this.calls.size >= MAX_CALLS || !this.allowed()) {
      await releaseLocalCliTaskCall(call).catch(() => {});
      return UNSUPPORTED;
    }
    const handle = Object.freeze({
      bootId: this.bootId,
      callId: randomUUID(),
      connectionId: prepareData.connectionId,
    });
    let response;
    try {
      response = cliTaskPrepareResponseSchema.parse({ kind: 'prepared', handle, call });
    } catch {
      await releaseLocalCliTaskCall(call).catch(() => {});
      return UNSUPPORTED;
    }
    this.calls.set(handle.callId, {
      handle,
      call,
      createdAt: Date.now(),
      used: false,
    });
    return response;
  }

  prepare(data: CliTaskPrepareData) {
    return this.track(this.executePrepare(data));
  }

  private take(data: BoundData): Call | null {
    const state = this.calls.get(data.handle.callId);
    if (!state || state.used || !isDeepStrictEqual(state.handle, data.handle) || this.closing) return null;
    // Close the race before the first asynchronous DB check; run/notStarted are both one-use.
    state.used = true;
    return state;
  }

  private identity(data: BoundData) {
    return { handle: data.handle, requestId: data.dispatch.requestId, bindingHash: data.dispatch.bindingHash };
  }

  private async unknown(
    data: BoundData,
    reason: 'process_exit' | 'transport_unknown' = 'transport_unknown',
  ) {
    // DB failures retain occupancy; no result is exposed and the worker independently marks the dispatch unknown.
    await markModelDispatchIndeterminate(data.dispatch, reason).catch(error => {
      logger.warn('cli_task.indeterminate_write_failed', {
        requestId: data.dispatch.requestId,
        code: safeCode(error),
      });
      return false;
    });
    return { ...this.identity(data), kind: 'indeterminate' as const, reason };
  }

  private async settledHash(dispatch: CliModelDispatch, terminal: CliProcessTerminal): Promise<string> {
    const process = readCliProcessTerminal(terminal);
    if (!process) {
      await markUnsettledDispatch(dispatch);
      throw new Error('invalid_cli_process_terminal');
    }
    try {
      await reconcileCliProcessTerminal(terminal);
    } catch (error) {
      await markUnsettledDispatch(dispatch);
      throw error;
    }
    return reviewHash({ version: 1, kind: 'cli_model_terminal', dispatch, process });
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    void operation.finally(() => this.active.delete(operation)).catch(() => {});
    return operation;
  }

  run(data: BoundData) {
    return this.track(this.execute(data, false));
  }

  notStarted(data: BoundData) {
    return this.track(this.execute(data, true));
  }

  private async execute(data: BoundData, notStarted: boolean) {
    const state = this.take(data);
    if (!state) throw new Error('cli_task_call_unavailable');
    let authorized = false;
    try {
      // A serialized dispatch alone cannot authorize spawn: it must equal the real committed primary-DB row.
      await assertCliHostDispatch(data.dispatch, notStarted);
      authorized = true;
      if (notStarted) {
        const terminal = await settleLocalCliTaskNotStarted(state.call, data.dispatch);
        if (!terminal) return await this.unknown(data);
        const terminalEvidenceHash = await this.settledHash(data.dispatch, terminal);
        return cliTaskNotStartedResponseSchema.parse({
          ...this.identity(data),
          kind: 'settled',
          terminalEvidenceHash,
        });
      }
      const outcome = await runLocalCliTaskCall(state.call, data.dispatch);
      if (!outcome.terminal)
        return cliTaskRunResponseSchema.parse(
          await this.unknown(data, outcome.indeterminate ?? 'transport_unknown'),
        );
      const terminalEvidenceHash = await this.settledHash(data.dispatch, outcome.terminal);
      return cliTaskRunResponseSchema.parse({
        ...this.identity(data),
        kind: 'settled',
        terminalEvidenceHash,
        result: outcome.result,
      });
    } catch {
      if (!authorized) throw new Error('cli_task_dispatch_mismatch');
      const indeterminate = await this.unknown(data);
      return notStarted ? indeterminate : cliTaskRunResponseSchema.parse(indeterminate);
    } finally {
      this.calls.delete(data.handle.callId);
      await releaseLocalCliTaskCall(state.call).catch(error => {
        logger.warn('cli_task.release_failed', { code: safeCode(error) });
      });
    }
  }

  async release(handle: CliHostHandle) {
    const state = this.calls.get(handle.callId);
    if (!state || state.used || !isDeepStrictEqual(state.handle, handle))
      return cliTaskReleaseResponseSchema.parse({ released: false });
    this.calls.delete(handle.callId);
    await releaseLocalCliTaskCall(state.call).catch(error => {
      logger.warn('cli_task.release_failed', { code: safeCode(error) });
    });
    return cliTaskReleaseResponseSchema.parse({ released: true });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active]);
    const remaining = [...this.calls.values()];
    this.calls.clear();
    await Promise.allSettled(remaining.map(state => releaseLocalCliTaskCall(state.call)));
  }
}
