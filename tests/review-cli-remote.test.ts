import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cliDispatchBindingHash, cliModelDispatchSchema, type CliModelDispatch } from "@/lib/llm/capacity";
import { cliServingContractHash, EMPTY_SHA256, type CliServingContract } from "@/lib/llm/cli-serving-contract";
import { readCliProcessTerminal } from "@/lib/llm/cli-process-runner";
import { reviewHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import type { CliHostRequest } from "@/lib/operations/cli-host-protocol";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), catalog: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/operations/cli-host-client", () => ({ cliHostRequest: mocks.rpc, readCliHostCatalog: mocks.catalog }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readCliModelDispatchRecord: mocks.record }));
const fixture = vi.hoisted(() => ({ contract: null as CliServingContract | null }));
vi.mock("@/lib/llm/cli-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/cli-serving-contract")>(),
  resolveCliServingContract: () => fixture.contract,
}));
import { assertCliHostDispatch, prepareRemoteReviewCliCall, releaseRemoteReviewCliCall, runRemoteReviewCliCall,
  settleRemoteReviewCliNotStarted } from "@/lib/crawl/review-cli-remote";

const model = "opencode/deepseek-v4.1-flash", hash = "a".repeat(64), connectionId = randomUUID();
const target = { connectionId, baseUrl: "http://100.92.77.66:3031/v1", apiKey: "test-only-bridge-secret-32-characters" };
const handle = { bootId: randomUUID(), callId: randomUUID(), connectionId };
const contract: CliServingContract = { version: 1, protocol: "cli-process-v1", provider: "opencode-cli", routeId: "crawl-agent-review", model,
  cliVersion: "1.19.5", inputByteCap: 200_000, totalTokenBound: 200_000, costBoundUsdMicros: null, boundProvenance: "declared" };
const input = { inputHash: hash, policyHash: hash, sourceRevisionHash: hash, source: {}, validUntil: new Date("2026-11-06T00:00:00.000Z"),
  snapshot: { evidence: [], evidenceSummary: { eligible: false }, policy: { enforceEligibility: false } } } as unknown as ReviewInput;
const transport = { protocol: "cli-process-v1" as const, provider: "opencode-cli" as const, model, argvHash: hash, inputHash: hash,
  envPolicyHash: hash, cliContractHash: cliServingContractHash(contract), timeoutMs: 20_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384 };
const call = { kind: "prepared_cli" as const, routeId: "crawl-agent-review" as const, provider: "opencode-cli" as const, model,
  inputHash: hash, transport, totalTokenBound: contract.totalTokenBound };
const options = { routeId: "crawl-agent-review" as const, provider: "opencode-cli" as const, model, timeoutMs: 20_000, reasoningEffort: "high", connectionId };
function dispatch(): CliModelDispatch {
  const binding = { version: 1 as const, kind: "ai1_legacy_cli" as const, logicalWorkKey: "ai1:41", candidateId: 41, attemptId: 7,
    inputHash: hash, sourceRevisionHash: hash, reviewPolicyHash: hash, promptVersion: "p", rulesVersion: "r", provider: "opencode-cli" as const,
    model, routeId: "crawl-agent-review" as const, stageEpoch: 1, transport, totalTokenBound: contract.totalTokenBound,
    chargedTokens: contract.totalTokenBound, job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 1 } };
  return cliModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: "unit", bootId: randomUUID() }, token: randomUUID(), epoch: 1, revision: 1,
    policyHash: hash, binding, bindingHash: cliDispatchBindingHash(binding) });
}
function settlement(value: CliModelDispatch, ending: "exited" | "not_started" = "exited") {
  const process = { version: 1, kind: "cli_process_terminal", requestId: value.requestId, transport, totalTokenBound: contract.totalTokenBound,
    ending, exitCode: ending === "exited" ? 0 : null, signal: null, killReason: null, stdoutHash: ending === "exited" ? hash : EMPTY_SHA256,
    stderrHash: EMPTY_SHA256, stdoutBytes: ending === "exited" ? 100 : 0, stderrBytes: 0, actualUsage: null, provenance: "unknown", reportedCostUsdMicros: null };
  const evidence = { version: 1, kind: "cli_model_terminal", dispatch: value, process }, terminalEvidenceHash = reviewHash(evidence);
  return { record: { state: "settled", dispatch: value, terminalEvidence: evidence, terminalEvidenceHash },
    ack: { kind: "settled" as const, handle, requestId: value.requestId, bindingHash: value.bindingHash, terminalEvidenceHash } };
}
beforeEach(() => {
  fixture.contract = contract;
  mocks.catalog.mockResolvedValue({ version: 1, bootId: handle.bootId, cliVersion: "1.19.5", observedAt: new Date().toISOString(),
    models: [{ id: model, label: "DeepSeek", variants: ["low", "high"], maxModelLen: null }] });
  mocks.rpc.mockImplementation(async (_target, request: CliHostRequest) => {
    if (request.action === "prepare") return { kind: "prepared", handle, call: structuredClone(call) };
    if (request.action === "release") return { released: true };
    throw new Error("unexpected_rpc");
  });
});
afterEach(() => vi.resetAllMocks());
async function prepared() {
  const result = await prepareRemoteReviewCliCall(input, options, target);
  if (result.kind !== "prepared_cli") throw new Error("fixture_prepared_required");
  return result;
}

it("binds the exact selected connection, model and host variant without issuing a native capability", async () => {
  const preparedCall = await prepared();
  expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ action: "prepare", data: { options: { connectionId, model, reasoningEffort: "high" } } });
  expect(mocks.catalog).toHaveBeenCalledWith(target);
  expect(readCliProcessTerminal(preparedCall)).toBeNull();
  expect(await prepareRemoteReviewCliCall(input, { ...options, reasoningEffort: "invented" }, target)).toMatchObject({ kind: "unsupported" });
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  await releaseRemoteReviewCliCall(preparedCall);
});
it("pre-admission catalog or prepare RPC loss preserves the unsupported/deferred boundary", async () => {
  const catalog = mocks.catalog.getMockImplementation();
  mocks.catalog.mockRejectedValueOnce(new Error("catalog_unreachable"));
  expect(await prepareRemoteReviewCliCall(input, options, target)).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
  expect(mocks.rpc).not.toHaveBeenCalled();
  mocks.catalog.mockImplementation(catalog!);
  mocks.rpc.mockRejectedValueOnce(new Error("prepare_unreachable"));
  expect(await prepareRemoteReviewCliCall(input, options, target)).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
it("unused preparation cleanup failure cannot replace the original deferred result or trigger a retry", async () => {
  const preparedCall = await prepared();
  mocks.rpc.mockRejectedValueOnce(new Error("release_unreachable"));
  const original = new Error("original_deferred");
  await expect((async () => { try { throw original; } finally { await releaseRemoteReviewCliCall(preparedCall); } })()).rejects.toBe(original);
  await releaseRemoteReviewCliCall(preparedCall);
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
});
it("uses a result only after the primary ledger verifies the exact native settlement", async () => {
  const preparedCall = await prepared(), value = dispatch(), settled = settlement(value);
  const result = { ok: true, outcome: { decision: "approve", reason: "product", evidenceIds: ["product"] }, usage: {} };
  mocks.record.mockResolvedValue(settled.record);
  mocks.rpc.mockResolvedValue({ ...settled.ack, result });
  const outcome = await runRemoteReviewCliCall(input, value, preparedCall);
  expect(outcome.result).toEqual(result);
  expect(outcome.terminal).toBeNull();
  expect(readCliProcessTerminal(outcome.remoteSettlement)).toBeNull();
  expect(mocks.record).toHaveBeenCalledWith(value.requestId);
  await expect(runRemoteReviewCliCall(input, value, preparedCall)).rejects.toThrow("remote_review_cli_call_mismatch");
});
it("pins the selected connection endpoint and secret through run and unused release even if the source object changes", async () => {
  const selected = { ...target }, preparedCall = await prepareRemoteReviewCliCall(input, options, selected);
  if (preparedCall.kind !== "prepared_cli") throw new Error("fixture_prepared_required");
  selected.baseUrl = "http://another-host:3031/v1"; selected.apiKey = "another-test-only-bridge-secret-32";
  const value = dispatch(), settled = settlement(value);
  mocks.record.mockResolvedValue(settled.record);
  mocks.rpc.mockResolvedValueOnce({ ...settled.ack, result: { ok: false, error: "cli_error" } });
  await runRemoteReviewCliCall(input, value, preparedCall);
  expect(mocks.rpc.mock.calls.at(-1)![0]).toEqual(target);
  const nextTarget = { ...target }, unused = await prepareRemoteReviewCliCall(input, options, nextTarget);
  if (unused.kind !== "prepared_cli") throw new Error("fixture_prepared_required");
  nextTarget.baseUrl = "http://another-host:3031/v1"; nextTarget.apiKey = "another-test-only-bridge-secret-32";
  await releaseRemoteReviewCliCall(unused);
  expect(mocks.rpc.mock.calls.at(-1)![0]).toEqual(target);
});
it("rejects a settled RPC result whose primary ledger has not settled, without retrying the run", async () => {
  const preparedCall = await prepared(), value = dispatch(), settled = settlement(value);
  mocks.record.mockResolvedValue({ ...settled.record, state: "dispatched" });
  mocks.rpc.mockResolvedValue({ ...settled.ack, result: { ok: true, outcome: { decision: "approve", reason: "unverified", evidenceIds: ["product"] }, usage: {} } });
  expect(await runRemoteReviewCliCall(input, value, preparedCall)).toMatchObject({ result: { ok: false }, terminal: null, indeterminate: "transport_unknown" });
  expect(await settleRemoteReviewCliNotStarted(preparedCall, value)).toBeNull();
  await releaseRemoteReviewCliCall(preparedCall);
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
});
it("lost run response never authorizes notStarted or another spawn", async () => {
  const preparedCall = await prepared(), value = dispatch();
  mocks.rpc.mockRejectedValue(new Error("connection_lost"));
  expect(await runRemoteReviewCliCall(input, value, preparedCall)).toMatchObject({ indeterminate: "transport_unknown" });
  expect(await settleRemoteReviewCliNotStarted(preparedCall, value)).toBeNull();
  await expect(runRemoteReviewCliCall(input, value, preparedCall)).rejects.toThrow();
  await releaseRemoteReviewCliCall(preparedCall);
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
});
it("notStarted is acknowledged only after its exact native D5 settlement exists; it cannot be reused to run", async () => {
  const preparedCall = await prepared(), value = dispatch(), settled = settlement(value, "not_started");
  mocks.record.mockResolvedValue(settled.record);
  mocks.rpc.mockResolvedValue(settled.ack);
  expect(await settleRemoteReviewCliNotStarted(preparedCall, value)).toEqual(settled.ack);
  await expect(runRemoteReviewCliCall(input, value, preparedCall)).rejects.toThrow();
  expect(readCliProcessTerminal(settled.ack)).toBeNull();
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
});
it("first spawn requires dispatched state; historical indeterminate is only allowed for a native notStarted reconciliation", async () => {
  const value = dispatch();
  mocks.record.mockResolvedValue({ state: "indeterminate", dispatch: value });
  await expect(assertCliHostDispatch(value)).rejects.toThrow("cli_host_dispatch_mismatch");
  await expect(assertCliHostDispatch(value, true)).resolves.toBeUndefined();
  mocks.record.mockResolvedValue({ state: "dispatched", dispatch: { ...value, token: randomUUID() } });
  await expect(assertCliHostDispatch(value)).rejects.toThrow("cli_host_dispatch_mismatch");
});
