import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { getSettings } from "@/lib/crawl/settings";
import { grokAuthPath, grokFailure, runGrokCli, type GrokCliRun } from "@/lib/crawl/agent-review-grok";
import { observe } from "@/lib/operations/observations";
import { serviceInstanceId } from "@/lib/operations/instance";

/**
 * Grok 세션 확인 — 로그인 파일이 살아 있는지 4시간마다 한 번, 가장 짧은 호출로 잰다.
 *
 * Grok CLI 의 접근 토큰은 6시간짜리고 호출이 있을 때 refresh 토큰으로 갱신해 GROK_AUTH_PATH 에 다시 쓴다.
 * 2차 심사가 뜸한 시간대(수집 사이클 재시작, 새벽)에 토큰이 만료된 채 오래 두면 다음 호출이 전부 auth 로 실패한다 —
 * 그래서 심사와 무관하게 주기적으로 한 번 부른다. 결과는 `service:grok:<instance>` 관측으로 남겨 운영센터
 * 모델 카드가 Claude·Codex 처럼 "Grok 연결 확인"을 보인다. grok-cli 를 쓰는 설정이 없으면 아무것도 하지 않는다.
 */
export const GROK_SESSION_TIMEOUT_MS = 60_000;

export function grokSessionArgs(model: string): string[] {
  return ["-p", "Reply with the single word OK.", "-m", model, "--effort", "low", "--output-format", "json",
    "--max-turns", "1", "--disable-web-search", "--no-subagents", "--no-plan", "--no-auto-update"];
}

export async function checkGrokSession(ctx: JobContext<null>, deps: { run?: GrokCliRun; record?: typeof observe } = {}): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  const review = settings.secondReview;
  const uses = [...review.voters, ...(review.fallbacks ?? []), ...(settings.firstReview ? [settings.firstReview] : [])]
    .filter((item) => item.provider === "grok-cli");
  if (uses.length === 0) { ctx.log("crawl.grok_session_skipped", { reason: "no_grok_cli_in_settings" }); return { done: true }; }
  const model = uses[0].model;
  const authPath = grokAuthPath();
  const authFile = await stat(authPath).then((info) => ({ exists: true, modifiedAt: info.mtime.toISOString() })).catch(() => ({ exists: false, modifiedAt: null }));
  const directory = await mkdtemp(path.join(os.tmpdir(), "nomorevibe-grok-session-"));
  const startedAt = Date.now();
  let result: { result: "success" | string; detail?: string } = { result: "cli_error" };
  try {
    const home = path.join(directory, "home");
    await mkdir(home);
    const run = deps.run ?? runGrokCli;
    const outcome = await run(grokSessionArgs(model), { cwd: directory, env: { ...process.env, GROK_HOME: home, GROK_AUTH_PATH: authPath, RUST_LOG: "off", NO_COLOR: "1" },
      timeoutMs: GROK_SESSION_TIMEOUT_MS, signal: ctx.signal });
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
