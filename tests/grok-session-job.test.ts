import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkGrokSession, grokSessionArgs } from "@/lib/crawl/jobs/grok-session";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { textRankUnusableText } from "@/lib/llm/ai-task-resolver";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { textRankRow } from "./text-task-ranks-fixture";
import { cliRankRow, pinTaskRanks } from "./fake-cli-path";

/**
 * Grok 로그인 확인 잡 — 모델은 「작업 ↔ 모델」의 Grok 로그인 유지(grok-session-check) 순위다(PR C1). 1·2차 설정(secondReview.voters·firstReview)은
 * 읽지 않는다. 순위가 있으면 짧은 호출을 하고 결과를 관측 키로 남긴다. 실행 파일은 PATH 의 grok 이다(command: "grok").
 */
const mocks = vi.hoisted(() => ({ path: null as null | ((routeId: string, model: string) => Promise<"legacy" | "native">) }));
vi.mock("@/lib/operations/observations", () => ({ observe: vi.fn() }));
// These job units do not open a database; open/draining admission is covered by cli-model-capacity-callers.test.ts.
vi.mock("@/lib/llm/capacity-repository", () => ({
  readModelCapacityCallerControl: async () => ({ mode: "disabled", epoch: 1, revision: 1, policyHash: null, policy: null }),
}));
// 순위 대체를 보는 시험만 공통 슬롯 판정(backgroundCliPath)을 바꿔 끼운다 — 그 밖에는 진짜 판정(disabled → legacy)이다
vi.mock("@/lib/llm/cli-model-capacity", async original => {
  const actual = await original<typeof import("@/lib/llm/cli-model-capacity")>();
  return { ...actual, backgroundCliPath: (routeId: never, model: string) => mocks.path ? mocks.path(routeId, model) : actual.backgroundCliPath(routeId, model) };
});

const context = () => ({ cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn(), lease: { name: "grok-session-check", token: "t", requestedVersion: 1 } });
type GrokRun = (args: string[], options: { env: NodeJS.ProcessEnv; command?: string }) => Promise<{ kind: "exit"; code: number; stdout: string; stderr: string }>;
const okRun = () => vi.fn<GrokRun>(async () =>
  ({ kind: "exit" as const, code: 0, stdout: JSON.stringify({ text: "OK", modelUsage: { "grok-4.7-build": {} } }), stderr: "" }));

beforeEach(() => { vi.stubEnv("SERVICE_INSTANCE_ID", "m3-reviewer"); vi.stubEnv("GROK_AUTH_PATH", "/nonexistent/auth.json"); mocks.path = null; });
afterEach(() => { pinTaskRanks(null); vi.unstubAllEnvs(); });

it("Grok 을 어느 순위에서도 쓰지 않으면 호출하지 않고 조용히 넘긴다", async () => {
  // 다른 작업의 순위(API 연결)는 상관없다
  pinTaskRanks([textRankRow("first-review", "qwen-review")]);
  const run = vi.fn(); const record = vi.fn();
  const ctx = context();
  expect(await checkGrokSession(ctx as never, { run, record })).toEqual({ done: true });
  expect(run).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
  expect(ctx.log).toHaveBeenCalledWith("crawl.grok_session_skipped", { reason: "no_task_models", reviewersUseGrok: false });
});

it("1·2차 순위에 Grok CLI 가 있는데 로그인 유지 순위가 없으면 제 일 못 함(no_task_models)이다 — 옛 설정의 투표자로 대신 부르지 않는다", async () => {
  for (const task of ["first-review", "second-review"]) {
    pinTaskRanks([cliRankRow(task, "grok-4.7", { slot: task === "second-review" ? 2 : 1 })]);
    const run = vi.fn(); const record = vi.fn();
    const ctx = context();
    const outcome = await checkGrokSession(ctx as never, { run, record });
    expect(outcome, task).toMatchObject({ done: true, degraded: { code: "no_task_models", detail: expect.stringContaining("Grok 로그인 유지") } });
    expect(run).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith("crawl.grok_session_skipped", { reason: "no_task_models", reviewersUseGrok: true });
  }
});

it("순위를 읽지 못했으면 task_models_unreadable, 순위가 모두 쓸 수 없으면(꺼짐·CLI 아님) all_ranks_unusable 이다", async () => {
  setAiTaskModelsForTest(null);
  const run = vi.fn();
  expect(await checkGrokSession(context() as never, { run, record: vi.fn() })).toMatchObject({ done: true, degraded: { code: "task_models_unreadable" } });
  pinTaskRanks([cliRankRow("grok-session-check", "grok-4.7", { enabled: false }),
    cliRankRow("grok-session-check", "grok-4.8", { rank: 2, connectionEnabled: false }),
    textRankRow("grok-session-check", "api-model", { rank: 3 })]);
  const outcome = await checkGrokSession(context() as never, { run, record: vi.fn() });
  expect(outcome).toMatchObject({ done: true, degraded: { code: "all_ranks_unusable" } });
  const detail = (outcome as { degraded: { detail: string } }).degraded.detail;
  expect(detail).toContain("1순위 test-grok-cli · grok-4.7: 순위가 꺼져 있음");
  expect(detail).toContain("2순위 test-grok-cli · grok-4.8: 연결이 꺼져 있음");
  expect(detail).toContain("3순위 test-engine · api-model: Grok CLI 연결이 아님");
  expect(run).not.toHaveBeenCalled();
});

it("짧은 호출이 OK 를 돌려주면 success 를, 로그인이 끊겼으면 auth 를 관측에 남긴다 — PATH 의 grok 으로 띄운다", async () => {
  vi.stubEnv("GROK_CLI", "/nonexistent/grok");
  pinTaskRanks([cliRankRow("grok-session-check", "grok-4.7")]);
  const record = vi.fn();
  const ok = vi.fn(async (args: string[], options: { env: NodeJS.ProcessEnv; command?: string }) => {
    expect(args).toEqual(grokSessionArgs("grok-4.7"));
    expect(options.command).toBe("grok");
    expect(options.env.GROK_AUTH_PATH).toBe("/nonexistent/auth.json");
    expect(options.env.GROK_HOME).toMatch(/nomorevibe-grok-session-/);
    return { kind: "exit" as const, code: 0, stdout: JSON.stringify({ text: "OK", modelUsage: { "grok-4.7-build": {} } }), stderr: "" };
  });
  await checkGrokSession(context() as never, { run: ok, record });
  expect(ok).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledWith("service:grok:m3-reviewer", expect.objectContaining({ provider: "grok-cli", model: "grok-4.7", resolvedModel: "grok-4.7-build", result: "success", authFile: { exists: false, modifiedAt: null } }));
  const signedOut = vi.fn(async () => ({ kind: "exit" as const, code: 1, stdout: "", stderr: "Error: Not signed in. To authenticate without a browser, run: grok login --device-code" }));
  await checkGrokSession(context() as never, { run: signedOut, record });
  expect(record).toHaveBeenLastCalledWith("service:grok:m3-reviewer", expect.objectContaining({ result: "auth" }));
});

it("순위 대체: 1순위가 그 모델만의 까닭(정책에 없음)으로 거절되면 2순위 모델로 부르고, 전역 거절(draining)은 그대로 던진다", async () => {
  pinTaskRanks([cliRankRow("grok-session-check", "grok-4.7"), cliRankRow("grok-session-check", "grok-4.8", { rank: 2 })]);
  const asked: string[] = [];
  mocks.path = async (_routeId, model) => {
    asked.push(model);
    if (model === "grok-4.7") throw new ModelCapacityDeferredError("unmapped");
    return "legacy";
  };
  const run = okRun(), record = vi.fn();
  expect(await checkGrokSession(context() as never, { run, record })).toEqual({ done: true });
  expect(asked).toEqual(["grok-4.7", "grok-4.8"]);
  expect(run.mock.calls.map(([args, options]) => [args, options.command])).toEqual([[grokSessionArgs("grok-4.8"), "grok"]]);
  expect(record).toHaveBeenCalledWith("service:grok:m3-reviewer", expect.objectContaining({ model: "grok-4.8", result: "success" }));

  // 모든 순위가 그 모델만의 까닭으로 거절되면 부르지 않고 순위마다 까닭을 남긴다
  mocks.path = async () => { throw new ModelCapacityDeferredError("provider_contract_unavailable"); };
  const none = okRun();
  expect(await checkGrokSession(context() as never, { run: none, record })).toEqual({ done: true, degraded: { code: "all_ranks_unusable",
    detail: `Grok 로그인 유지: 1순위 test-grok-cli · grok-4.7: ${textRankUnusableText("provider_contract_unavailable")} / 2순위 test-grok-cli · grok-4.8: ${textRankUnusableText("provider_contract_unavailable")}` } });
  expect(none).not.toHaveBeenCalled();

  // 전역 미룸은 다음 순위로 넘기지 않는다
  asked.length = 0;
  mocks.path = async (_routeId, model) => { asked.push(model); throw new ModelCapacityDeferredError("draining"); };
  await expect(checkGrokSession(context() as never, { run: none, record })).rejects.toMatchObject({ reason: "draining" });
  expect(asked).toEqual(["grok-4.7"]);
  expect(none).not.toHaveBeenCalled();
});
