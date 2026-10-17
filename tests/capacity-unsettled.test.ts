import { beforeEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

/**
 * F2 결함 3: 물리 종료(terminal·not_started)를 가진 호출의 정산 TX 가 실패하면 행을 dispatched 로 두지 않고 indeterminate(commit_unknown)
 * 표시를 시도한다. 표시 실패는 남기고 삼키며 원 오류가 그대로 나간다. AI1·AI2 는 gateway-not-started-coordinator.test.ts 가 본다.
 */
const mocks = vi.hoisted(() => ({ unknown: vi.fn(), reconcileCli: vi.fn(), reconcileReason: vi.fn(), pending: vi.fn(), requestCli: vi.fn(),
  cancel: vi.fn(), lock: vi.fn(), finish: vi.fn(), control: vi.fn(), requestReason: vi.fn(), prepare: vi.fn(), run: vi.fn(),
  notStarted: vi.fn(), read: vi.fn(), reasonPrepare: vi.fn(), reasonNative: vi.fn(), domain: vi.fn(), role: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/llm/capacity-repository", () => ({ markModelDispatchIndeterminate: mocks.unknown, reconcileCliProcessTerminal: mocks.reconcileCli,
  reconcileReasonTranslationGatewayTerminal: mocks.reconcileReason, findOwnPendingModelRequest: mocks.pending, requestCliModelSlot: mocks.requestCli,
  cancelReservedModelSlot: mocks.cancel, lockCliModelCapacityDispatch: mocks.lock, finishCliModelCapacityDispatch: mocks.finish,
  readModelCapacityCallerControl: mocks.control, requestReasonTranslationModelSlot: mocks.requestReason }));
vi.mock("@/lib/llm/cli-process-runner", () => ({ prepareCliCall: mocks.prepare, runReservedCliCall: mocks.run,
  settleCliNotStarted: mocks.notStarted, readCliProcessTerminal: mocks.read }));
vi.mock("@/lib/db", () => ({ db: { transaction: (load: (tx: unknown) => unknown) => load({ boundary: "tx" }) }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ prepareReasonTranslationGatewayCall: mocks.reasonPrepare,
  translateWithReservedReasonGateway: mocks.reasonNative }));
vi.mock("@/lib/crawl/translations", () => ({ prepareReasonTranslationDispatch: mocks.domain }));
vi.mock("@/lib/crawl/translate", () => ({ TRANSLATE_MODEL: "Reason Model", translateToKorean: vi.fn(),
  textHash: (value: string) => createHash("sha256").update(value).digest("hex") }));
vi.mock("@/lib/jobs/role-leader", () => ({ roleLeaseFromEnv: mocks.role }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() } }));
import { markUnsettledDispatch } from "@/lib/llm/capacity-unsettled";
import { runCliWithModelCapacity } from "@/lib/llm/cli-model-capacity";
import { translateReasonsWithModelCapacity } from "@/lib/crawl/reason-translation-model-capacity";

const dispatch = Object.freeze({ requestId: randomUUID(), binding: { transport: { boundary: "transport" } }, boundary: "committed-dispatch" });
const terminal = Object.freeze({ kind: "cli_process_terminal" }), cleanup = new Error("settlement write failed");
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  mocks.unknown.mockResolvedValue(true); mocks.prepare.mockReturnValue({ kind: "prepared" }); mocks.pending.mockResolvedValue(null);
  mocks.requestCli.mockResolvedValue({ kind: "granted", reservation: { boundary: "reservation" } });
  mocks.lock.mockResolvedValue({ boundary: "lock" }); mocks.finish.mockResolvedValue(dispatch);
});
const work = (beforeSpawn = true) => ({ beforeSpawn: () => beforeSpawn,
  plan: async () => ({ identity: { boundary: "identity" }, target: { kind: "ai1", candidateId: 1 } }) as never,
  prove: async () => ({ boundary: "binding" }) as never });

it("marks commit_unknown and swallows a second failure with a log", async () => {
  await markUnsettledDispatch(dispatch as never);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(dispatch, "commit_unknown"); expect(mocks.warn).not.toHaveBeenCalled();
  mocks.unknown.mockRejectedValueOnce(new Error("ledger down"));
  await expect(markUnsettledDispatch(dispatch as never)).resolves.toBeUndefined();
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith("model_capacity.unsettled_mark_failed", { requestId: dispatch.requestId, error: "ledger down" });
});

it("CLI runner: a ran terminal whose settlement fails is marked commit_unknown and the settlement error stays primary", async () => {
  mocks.run.mockResolvedValue({ result: { kind: "exit", code: 0, stdout: "{}", stderr: "" }, terminal, indeterminate: null });
  mocks.reconcileCli.mockRejectedValue(cleanup);
  await expect(runCliWithModelCapacity({} as never, undefined, work())).rejects.toBe(cleanup);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(dispatch, "commit_unknown");
});

it("CLI runner: a not_started settlement failure is marked commit_unknown; success keeps the original single settlement", async () => {
  mocks.notStarted.mockReturnValue(terminal); mocks.reconcileCli.mockRejectedValueOnce(cleanup);
  await expect(runCliWithModelCapacity({} as never, undefined, work(false))).rejects.toBe(cleanup);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(dispatch, "commit_unknown"); expect(mocks.run).not.toHaveBeenCalled();
  vi.clearAllMocks(); mocks.reconcileCli.mockResolvedValue({ kind: "settled" });
  expect(await runCliWithModelCapacity({} as never, undefined, work(false))).toEqual({ kind: "not_started" });
  expect(mocks.reconcileCli).toHaveBeenCalledExactlyOnceWith(terminal); expect(mocks.unknown).not.toHaveBeenCalled();
});

it("text coordinator (reason translation): a failed terminal settlement is marked commit_unknown with both errors kept", async () => {
  const body = "This original reason describes a deployed useful task tracker.", hash = createHash("sha256").update(body).digest("hex");
  vi.stubEnv("ABCLLM_API_KEY", "test-key"); vi.stubEnv("ROLE_LEASE_ROLE", "text");
  const role = { role: "text", instanceId: "f2-reason", bootId: randomUUID(), release: "unit", epoch: 1, kind: "primary" };
  const reservation = { requestId: randomUUID(), token: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId },
    epoch: 1, revision: 1, policyHash: "c".repeat(64) };
  const reasonDispatch = { ...reservation, unitBoundary: "committed-dispatch" };
  mocks.control.mockResolvedValue({ mode: "open", policy: { routes: [{ routeId: "reason-translate", provider: "abcllm", model: "Reason Model" }] } });
  mocks.role.mockReturnValue(role);
  mocks.reasonPrepare.mockReturnValue({ kind: "prepared", model: "Reason Model", wireHash: "a".repeat(64), servingContractHash: "b".repeat(64),
    totalTokenBound: 8192, sourceHashes: [hash] });
  mocks.domain.mockImplementation(async (_batch, _lease, options) => options.reserved
    ? { kind: "ready", dispatch: reasonDispatch, expectation: { unitBoundary: "writer" } } : { kind: "ready", members: [{ sourceHash: hash, cache: { kind: "absent" } }], role });
  mocks.requestReason.mockResolvedValue({ kind: "granted", reservation });
  const failed = { ok: false, error: "invalid_output" };
  mocks.reasonNative.mockResolvedValue({ result: failed, terminal: Object.freeze({ native: "opaque" }) });
  mocks.reconcileReason.mockRejectedValue(cleanup);
  const error = await translateReasonsWithModelCapacity([{ hash, body, attempts: 0 }], { name: "reason-translate", token: randomUUID(), requestedVersion: 1 },
    { timeoutMs: 45_000 }).catch(value => value);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([failed, cleanup]);
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(reasonDispatch, "commit_unknown");
});
