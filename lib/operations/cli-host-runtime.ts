import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CliModelDispatch } from "@/lib/llm/capacity";
import { markModelDispatchIndeterminate, reconcileCliProcessTerminal } from "@/lib/llm/capacity-repository";
import { readCliProcessTerminal, type CliProcessTerminal } from "@/lib/llm/cli-process-runner";
import { markUnsettledDispatch } from "@/lib/llm/capacity-unsettled";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { reviewHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { prepareLocalReviewCliCall, runLocalReviewWithReservedCli, settleLocalReviewCliNotStarted, releaseLocalReviewCliCall,
  type PreparedReviewCliCall } from "@/lib/crawl/review-cli-call";
import { assertCliHostDispatch } from "@/lib/crawl/review-cli-remote";
import { readCliHostCatalog } from "./cli-host-catalog";
import { cliHostCatalogSchema, cliHostPrepareResponseSchema, cliHostRunResponseSchema, cliHostNotStartedResponseSchema,
  decodeCliHostInput, type CliHostCatalog, type CliHostHandle, type CliHostRequest } from "./cli-host-protocol";

type PrepareData = Extract<CliHostRequest, { action: "prepare" }>["data"];
type BoundData = Extract<CliHostRequest, { action: "run" }>["data"];
type Call = { handle: CliHostHandle; call: PreparedReviewCliCall; input: ReviewInput; createdAt: number; used: boolean };
const UNSUPPORTED = { kind: "unsupported", reason: "provider_contract_unavailable" } as const;
const MAX_CALLS = 64, PREPARE_TTL_MS = 120_000, CATALOG_TTL_MS = 30_000;

/** Only this process holds the native prepared call and native terminal. No JSON response can carry a settlement capability. */
export class CliHostRuntime {
  readonly bootId = randomUUID();
  private readonly calls = new Map<string, Call>();
  private readonly active = new Set<Promise<unknown>>();
  private catalogLoading: Promise<CliHostCatalog> | null = null;
  private cachedCatalog: CliHostCatalog | null = null;
  private closing = false;

  async catalog(): Promise<CliHostCatalog> {
    if (this.closing) throw new Error("cli_host_closing");
    if (this.cachedCatalog && Date.now() - Date.parse(this.cachedCatalog.observedAt) < CATALOG_TTL_MS)
      return structuredClone(this.cachedCatalog);
    this.catalogLoading ??= readCliHostCatalog(this.bootId).then(value => {
      this.cachedCatalog = cliHostCatalogSchema.parse(value);
      return this.cachedCatalog;
    }).finally(() => { this.catalogLoading = null; });
    return structuredClone(await this.catalogLoading);
  }

  private async expire(): Promise<void> {
    const now = Date.now();
    for (const [id, state] of this.calls) if (!state.used && now - state.createdAt > PREPARE_TTL_MS) {
      this.calls.delete(id);
      await releaseLocalReviewCliCall(state.call);
    }
  }
  async prepare(data: PrepareData) {
    if (this.closing) return UNSUPPORTED;
    await this.expire();
    if (this.calls.size >= MAX_CALLS) return UNSUPPORTED;
    const input = decodeCliHostInput(data.input), options = data.options;
    if (input.validUntil.getTime() <= Date.now()) return UNSUPPORTED;
    const catalog = await this.catalog(), model = catalog.models.find(entry => entry.id === options.model);
    if (!model || (options.reasoningEffort && !model.variants.includes(options.reasoningEffort))) return UNSUPPORTED;
    await ensureServingContracts();
    const call = await prepareLocalReviewCliCall(input, { ...options, catalogVariants: model.variants });
    if (call.kind !== "prepared_cli") return UNSUPPORTED;
    // A shutdown or competing prepare may have arrived while the native profile was being prepared.
    if (this.closing || this.calls.size >= MAX_CALLS) { await releaseLocalReviewCliCall(call); return UNSUPPORTED; }
    const handle = Object.freeze({ bootId: this.bootId, callId: randomUUID(), connectionId: options.connectionId });
    this.calls.set(handle.callId, { handle, call, input, createdAt: Date.now(), used: false });
    return cliHostPrepareResponseSchema.parse({ kind: "prepared", handle, call });
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
  private async unknown(data: BoundData, reason: "process_exit" | "transport_unknown" = "transport_unknown") {
    // DB failures retain occupancy; no result is exposed and the worker independently marks the dispatch unknown.
    await markModelDispatchIndeterminate(data.dispatch, reason).catch(() => {
      console.error(JSON.stringify({ event: "cli_host.indeterminate_write_failed", requestId: data.dispatch.requestId }));
      return false;
    });
    return { ...this.identity(data), kind: "indeterminate" as const, reason };
  }
  private async settledHash(dispatch: CliModelDispatch, terminal: CliProcessTerminal): Promise<string> {
    const process = readCliProcessTerminal(terminal);
    if (!process) throw new Error("invalid_cli_process_terminal");
    try { await reconcileCliProcessTerminal(terminal); }
    catch (error) { await markUnsettledDispatch(dispatch); throw error; }
    return reviewHash({ version: 1, kind: "cli_model_terminal", dispatch, process });
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    void operation.finally(() => this.active.delete(operation)).catch(() => {});
    return operation;
  }
  run(data: BoundData) { return this.track(this.execute(data, false)); }
  notStarted(data: BoundData) { return this.track(this.execute(data, true)); }
  private async execute(data: BoundData, notStarted: boolean) {
    const state = this.take(data);
    if (!state) throw new Error("cli_host_call_unavailable");
    let authorized = false;
    try {
      // A serialized dispatch alone cannot authorize spawn: it must equal the real committed primary-DB row.
      await assertCliHostDispatch(data.dispatch, notStarted);
      authorized = true;
      if (notStarted) {
        const terminal = await settleLocalReviewCliNotStarted(state.call, data.dispatch);
        if (!terminal) return await this.unknown(data);
        const terminalEvidenceHash = await this.settledHash(data.dispatch, terminal);
        return cliHostNotStartedResponseSchema.parse({ ...this.identity(data), kind: "settled", terminalEvidenceHash });
      }
      const outcome = await runLocalReviewWithReservedCli(state.input, data.dispatch, state.call);
      if (!outcome.terminal) return await this.unknown(data, outcome.indeterminate ?? "transport_unknown");
      const terminalEvidenceHash = await this.settledHash(data.dispatch, outcome.terminal);
      return cliHostRunResponseSchema.parse({ ...this.identity(data), kind: "settled", terminalEvidenceHash, result: outcome.result });
    } catch {
      if (!authorized) throw new Error("cli_host_dispatch_mismatch");
      return await this.unknown(data);
    } finally {
      this.calls.delete(data.handle.callId);
      await releaseLocalReviewCliCall(state.call);
    }
  }
  async release(handle: CliHostHandle): Promise<{ released: boolean }> {
    const state = this.calls.get(handle.callId);
    if (!state || state.used || !isDeepStrictEqual(state.handle, handle)) return { released: false };
    this.calls.delete(handle.callId);
    await releaseLocalReviewCliCall(state.call);
    return { released: true };
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active]);
    await Promise.allSettled([...this.calls.values()].map(state => releaseLocalReviewCliCall(state.call)));
    this.calls.clear();
  }
}
