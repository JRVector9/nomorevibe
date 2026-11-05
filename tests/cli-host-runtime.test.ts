import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { cliDispatchBindingHash, cliModelDispatchSchema, type CliModelDispatch } from "@/lib/llm/capacity";
import { reviewHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { encodeCliHostInput } from "@/lib/operations/cli-host-protocol";

const mocks = vi.hoisted(() => ({ catalog: vi.fn(), prepare: vi.fn(), run: vi.fn(), notStarted: vi.fn(), release: vi.fn(),
  assert: vi.fn(), mark: vi.fn(), reconcile: vi.fn(), readTerminal: vi.fn(), unsettled: vi.fn() }));
vi.mock("@/lib/operations/cli-host-catalog", () => ({ readCliHostCatalog: mocks.catalog }));
vi.mock("@/lib/crawl/review-cli-call", () => ({ prepareLocalReviewCliCall: mocks.prepare, runLocalReviewWithReservedCli: mocks.run,
  settleLocalReviewCliNotStarted: mocks.notStarted, releaseLocalReviewCliCall: mocks.release }));
vi.mock("@/lib/crawl/review-cli-remote", () => ({ assertCliHostDispatch: mocks.assert }));
vi.mock("@/lib/llm/capacity-repository", () => ({ markModelDispatchIndeterminate: mocks.mark, reconcileCliProcessTerminal: mocks.reconcile }));
vi.mock("@/lib/llm/capacity-unsettled", () => ({ markUnsettledDispatch: mocks.unsettled }));
vi.mock("@/lib/llm/cli-process-runner", () => ({ readCliProcessTerminal: mocks.readTerminal }));
vi.mock("@/lib/llm/serving-contract-store", () => ({ ensureServingContracts: async () => {} }));
import { CliHostRuntime } from "@/lib/operations/cli-host-runtime";
const hash = "a".repeat(64), model = "opencode/deepseek-v4.1-flash";
const transport = { protocol: "cli-process-v1" as const, provider: "opencode-cli" as const, model, argvHash: hash, inputHash: hash,
  envPolicyHash: hash, cliContractHash: hash, timeoutMs: 20_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384 };
const call = Object.freeze({ kind: "prepared_cli" as const, routeId: "crawl-agent-review" as const, provider: "opencode-cli" as const,
  model, inputHash: hash, transport, totalTokenBound: 200_000 });
const terminal = Object.freeze({ kind: "cli_process_terminal" });
const result = { ok: true, outcome: { decision: "approve", reason: "evidence", evidenceIds: ["product"] }, usage: {} };
const nativeProcess = { kind: "native_test_evidence" };
function data() {
  const input = { inputHash: hash, policyHash: hash, sourceRevisionHash: hash, source: {}, snapshot: {},
    validUntil: new Date(Date.now() + 3600_000) } as unknown as ReviewInput;
  return { input: encodeCliHostInput(input), options: { connectionId: randomUUID(), routeId: "crawl-agent-review" as const,
    provider: "opencode-cli" as const, model, timeoutMs: 20_000, reasoningEffort: "high" } };
}
function dispatch(): CliModelDispatch {
  const binding = { version: 1 as const, kind: "ai1_legacy_cli" as const, logicalWorkKey: "ai1:41", candidateId: 41, attemptId: 7,
    inputHash: hash, sourceRevisionHash: hash, reviewPolicyHash: hash, promptVersion: "p", rulesVersion: "r", provider: "opencode-cli" as const,
    model, routeId: "crawl-agent-review" as const, stageEpoch: 1, transport, totalTokenBound: 200_000, chargedTokens: 200_000,
    job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 1 } };
  return cliModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: "worker", bootId: randomUUID() }, token: randomUUID(), epoch: 1,
    revision: 1, policyHash: hash, binding, bindingHash: cliDispatchBindingHash(binding) });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.catalog.mockImplementation(async (bootId: string) => ({ version: 1, bootId, cliVersion: "1.19.5", observedAt: new Date().toISOString(),
    models: [{ id: model, label: "Flash", variants: ["low", "high", "max"], maxModelLen: 1_000_000 }] }));
  mocks.prepare.mockResolvedValue(call); mocks.run.mockResolvedValue({ result, terminal, indeterminate: null });
  mocks.notStarted.mockResolvedValue(terminal); mocks.readTerminal.mockImplementation(value => value === terminal ? nativeProcess : null);
  mocks.release.mockResolvedValue(undefined); mocks.assert.mockResolvedValue(undefined); mocks.reconcile.mockResolvedValue({ kind: "settled" });
  mocks.mark.mockResolvedValue(true); mocks.unsettled.mockResolvedValue(undefined);
});
async function prepared(runtime: CliHostRuntime) {
  const response = await runtime.prepare(data());
  if (response.kind !== "prepared") throw new Error("fixture_prepare_failed");
  return { handle: response.handle, dispatch: dispatch() };
}
it("passes catalog-observed variants to native preparation and rejects invented efforts before preparation", async () => {
  const runtime = new CliHostRuntime(), request = data();
  expect(await runtime.prepare({ ...request, options: { ...request.options, reasoningEffort: "medium" } })).toMatchObject({ kind: "unsupported" });
  expect(mocks.prepare).not.toHaveBeenCalled();
  await runtime.prepare(request);
  expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ catalogVariants: ["low", "high", "max"] }));
  await runtime.close();
});
it("settles the original native terminal in this process before exposing a result and returns no terminal capability", async () => {
  const runtime = new CliHostRuntime(), bound = await prepared(runtime);
  const response = await runtime.run(bound);
  expect(mocks.assert).toHaveBeenCalledWith(bound.dispatch, false);
  expect(mocks.reconcile).toHaveBeenCalledWith(terminal);
  expect(mocks.assert.mock.invocationCallOrder[0]).toBeLessThan(mocks.run.mock.invocationCallOrder[0]);
  expect(mocks.run.mock.invocationCallOrder[0]).toBeLessThan(mocks.reconcile.mock.invocationCallOrder[0]);
  expect(response).toEqual({ kind: "settled", handle: bound.handle, requestId: bound.dispatch.requestId, bindingHash: bound.dispatch.bindingHash,
    terminalEvidenceHash: reviewHash({ version: 1, kind: "cli_model_terminal", dispatch: bound.dispatch, process: nativeProcess }), result });
  expect(response).not.toHaveProperty("terminal");
  await expect(runtime.run(bound)).rejects.toThrow("cli_host_call_unavailable");
  expect(mocks.run).toHaveBeenCalledOnce(); expect(mocks.mark).not.toHaveBeenCalled();
});
it("prevents concurrent duplicate execution and does not let an invalid boot handle mutate the ledger", async () => {
  const runtime = new CliHostRuntime(), bound = await prepared(runtime);
  await expect(runtime.run({ ...bound, handle: { ...bound.handle, bootId: randomUUID() } })).rejects.toThrow("cli_host_call_unavailable");
  expect(mocks.assert).not.toHaveBeenCalled(); expect(mocks.mark).not.toHaveBeenCalled();
  let resolve!: () => void;
  mocks.assert.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const pending = runtime.run(bound);
  await expect(runtime.notStarted(bound)).rejects.toThrow("cli_host_call_unavailable");
  expect(mocks.notStarted).not.toHaveBeenCalled(); expect(mocks.mark).not.toHaveBeenCalled();
  resolve(); await pending;
  expect(mocks.run).toHaveBeenCalledOnce();
});
it("rejects a fabricated DB dispatch before spawn and before any state mutation", async () => {
  const runtime = new CliHostRuntime(), bound = await prepared(runtime);
  mocks.assert.mockRejectedValue(new Error("cli_host_dispatch_mismatch"));
  await expect(runtime.run(bound)).rejects.toThrow("cli_host_dispatch_mismatch");
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.mark).not.toHaveBeenCalled(); expect(mocks.reconcile).not.toHaveBeenCalled();
});
it("never exposes an approval when native termination or DB settlement remains unknown", async () => {
  const runtime = new CliHostRuntime(), bound = await prepared(runtime);
  mocks.run.mockResolvedValueOnce({ result, terminal: null, indeterminate: "process_exit" });
  expect(await runtime.run(bound)).toMatchObject({ kind: "indeterminate", reason: "process_exit" });
  expect(mocks.reconcile).not.toHaveBeenCalled(); expect(mocks.mark).toHaveBeenCalledWith(bound.dispatch, "process_exit");
  const second = await prepared(runtime); mocks.reconcile.mockRejectedValueOnce(new Error("db_unavailable"));
  const response = await runtime.run(second);
  expect(response).toMatchObject({ kind: "indeterminate" }); expect(response).not.toHaveProperty("result");
  expect(mocks.unsettled).toHaveBeenCalledWith(second.dispatch);
});
it("notStarted settles only an original unused native call and never starts a model process", async () => {
  const runtime = new CliHostRuntime(), bound = await prepared(runtime);
  expect(await runtime.notStarted(bound)).toMatchObject({ kind: "settled" });
  expect(mocks.assert).toHaveBeenCalledWith(bound.dispatch, true); expect(mocks.notStarted).toHaveBeenCalledWith(call, bound.dispatch);
  expect(mocks.run).not.toHaveBeenCalled();
  await expect(runtime.run(bound)).rejects.toThrow("cli_host_call_unavailable");
});
