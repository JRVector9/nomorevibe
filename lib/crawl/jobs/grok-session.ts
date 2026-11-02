import { modelTimeoutMs } from "@/lib/llm/model-registry";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { backgroundCliPath } from "@/lib/llm/cli-model-capacity";
import { ensureAiTaskModels, aiTaskModelsReadState } from "@/lib/llm/ai-task-models-snapshot";
import { taskModels, textRankUnusableText } from "@/lib/llm/ai-task-resolver";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerModel } from "@/lib/llm/capacity-deferred";
import { CLI_TOOL_COMMANDS } from "@/lib/llm/cli-serving-contract";
import { grokAuthPath, grokFailure, runGrokCli, type GrokCliRun } from "@/lib/crawl/agent-review-grok";
import { grokSessionCliRun } from "@/lib/crawl/grok-session-model-capacity";
import { observe } from "@/lib/operations/observations";
import { serviceInstanceId } from "@/lib/operations/instance";

/**
 * Grok 세션 확인 — 로그인 파일이 살아 있는지 4시간마다 한 번, 가장 짧은 호출로 잰다.
 *
 * Grok CLI 의 접근 토큰은 6시간짜리고 호출이 있을 때 refresh 토큰으로 갱신해 GROK_AUTH_PATH 에 다시 쓴다.
 * 2차 심사가 뜸한 시간대(수집 사이클 재시작, 새벽)에 토큰이 만료된 채 오래 두면 다음 호출이 전부 auth 로 실패한다 —
 * 그래서 심사와 무관하게 주기적으로 한 번 부른다. 결과는 `service:grok:<instance>` 관측으로 남겨 운영센터
 * 모델 카드가 Claude·Codex 처럼 "Grok 연결 확인"을 보인다. 모델은 「작업 ↔ 모델」의 Grok 로그인 유지 순위다(PR C1).
 */
/** 호출 상한 — 틱마다 등록부 경로 grok-session 을 읽는다(관리자 실시간 한도, 재배포 없이 다음 틱에 반영) */
export function grokSessionTimeoutMs(): number { return modelTimeoutMs("grok-session"); }

export function grokSessionArgs(model: string): string[] {
  return ["-p", "Reply with the single word OK.", "-m", model, "--effort", "low", "--output-format", "json",
    "--max-turns", "1", "--disable-web-search", "--no-subagents", "--no-plan", "--no-auto-update"];
}

export async function checkGrokSession(ctx: JobContext<null>, deps: { run?: GrokCliRun; record?: typeof observe } = {}): Promise<JobOutcome<null>> {
  // 부를 모델 = 「작업 ↔ 모델」의 Grok 로그인 유지 순위(PR C1) — 예전처럼 1·2차 설정에서 찾지 않는다. 순위가 없는데 1·2차 순위에 Grok CLI 가 있으면
  // 로그인이 갱신 없이 만료될 수 있어 제 일 못 함(no_task_models)으로 보인다. Grok 을 아무 데서도 쓰지 않으면 예전처럼 조용히 넘긴다.
  await ensureAiTaskModels();
  const all = taskModels("grok-session-check");
  const ranks = all.filter(rank => rank.enabled && rank.connection.enabled && rank.connection.kind === "cli" && rank.connection.cliTool === "grok");
  if (!ranks.length) {
    if (!aiTaskModelsReadState().loaded) return { done: true, degraded: { code: "task_models_unreadable",
      detail: "Grok 로그인 유지: 작업 ↔ 모델 표를 아직 읽지 못했습니다(권한·migration 0162 확인)" } };
    const reviewersUseGrok = ["first-review", "second-review"].some(task => [1, 2, 3].some(slot => taskModels(task, slot)
      .some(rank => rank.enabled && rank.connection.enabled && rank.connection.kind === "cli" && rank.connection.cliTool === "grok")));
    ctx.log("crawl.grok_session_skipped", { reason: all.length ? "all_ranks_unusable" : "no_task_models", reviewersUseGrok });
    if (all.length) return { done: true, degraded: { code: "all_ranks_unusable",
      detail: `Grok 로그인 유지: ${all.map(rank => `${rank.rank}순위 ${rank.connection.label} · ${rank.model}: ${!rank.enabled ? "순위가 꺼져 있음"
        : !rank.connection.enabled ? "연결이 꺼져 있음" : "Grok CLI 연결이 아님"}`).join(" / ")}`.slice(0, 300) } };
    if (reviewersUseGrok) return { done: true, degraded: { code: "no_task_models",
      detail: "Grok 로그인 유지: 1·2차 순위에 Grok CLI 가 있는데 이 작업의 순위가 없습니다(/admin/models/tasks) — 로그인이 갱신 없이 만료될 수 있습니다" } };
    return { done: true };
  }
  // 공통 모델 슬롯: disabled 면 원 호출 그대로. open 이고 CLI 계약이 있으면 이 인스턴스의 슬롯을 얻어 부르고, 그 밖과 슬롯 대기는
  // 부르지 않고 미룬다 — 관측을 남기지 않으므로 마지막 확인 시각이 그대로다(오래 미뤄지면 토큰이 갱신 없이 만료될 수 있다, 설계 D3).
  // 순위 대체: 그 모델만의 까닭(정책에 경로 없음·CLI 계약 없음)이면 다음 순위로 넘긴다. 모두 그렇면 제 일 못 함(all_ranks_unusable)이다
  let model = ranks[0].model, capacity: "legacy" | "native" | null = null;
  const refused: string[] = [];
  for (const rank of ranks) {
    try { capacity = await backgroundCliPath("grok-session-check", rank.model); model = rank.model; break; }
    catch (error) {
      if (!(error instanceof ModelCapacityDeferredError) || !modelCapacityDeferralIsPerModel(error.reason)) throw error;
      refused.push(`${rank.rank}순위 ${rank.connection.label} · ${rank.model}: ${textRankUnusableText(error.reason)}`);
    }
  }
  if (!capacity) return { done: true, degraded: { code: "all_ranks_unusable", detail: `Grok 로그인 유지: ${refused.join(" / ")}`.slice(0, 300) } };
  if (capacity === "native" && !ctx.lease) throw new Error("Grok session check requires a job lease");
  const authPath = grokAuthPath();
  const authFile = await stat(authPath).then((info) => ({ exists: true, modifiedAt: info.mtime.toISOString() })).catch(() => ({ exists: false, modifiedAt: null }));
  const directory = await mkdtemp(path.join(os.tmpdir(), "nomorevibe-grok-session-"));
  const startedAt = Date.now();
  let result: { result: "success" | string; detail?: string } = { result: "cli_error" };
  try {
    const home = path.join(directory, "home");
    await mkdir(home);
    const run = capacity === "native" && ctx.lease ? grokSessionCliRun(model, ctx.lease) : deps.run ?? runGrokCli;
    // 실행 파일은 PATH 의 grok(env 경로 GROK_CLI 를 읽지 않는다, PR C1). 로그인 파일 자리는 CLI 의 로그인 그대로다(GROK_AUTH_PATH — PR E 가 정리)
    const outcome = await run(grokSessionArgs(model), { cwd: directory, env: { ...process.env, GROK_HOME: home, GROK_AUTH_PATH: authPath, RUST_LOG: "off", NO_COLOR: "1" },
      timeoutMs: grokSessionTimeoutMs(), signal: ctx.signal, command: CLI_TOOL_COMMANDS["grok-cli"] });
    if (outcome.kind !== "exit") result = { result: outcome.kind };
    else if (outcome.code !== 0) result = { result: grokFailure(outcome.stdout, outcome.stderr) };
    else {
      try {
        const start = outcome.stdout.indexOf("{");
        const parsed = JSON.parse(outcome.stdout.slice(start)) as { text?: unknown; modelUsage?: Record<string, unknown> };
        result = typeof parsed.text === "string" && /\bOK\b/i.test(parsed.text)
          ? { result: "success", detail: Object.keys(parsed.modelUsage ?? {})[0] }
          : { result: "invalid_output" };
      } catch { result = { result: "invalid_output" }; }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  const value = { provider: "grok-cli", model, resolvedModel: result.detail ?? null, result: result.result, checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt, authFile };
  await (deps.record ?? observe)(`service:grok:${serviceInstanceId() ?? "unknown"}`, value);
  ctx.log(result.result === "success" ? "crawl.grok_session_ok" : "crawl.grok_session_failed", value);
  return { done: true };
}
