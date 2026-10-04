import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REVIEW_SYSTEM_PROMPT, usageFrom, type AgentReviewResult, type ReviewFailure } from "./agent-review";
import { MAX_REVIEW_INPUT_BYTES, validateReviewOutcome, type ReviewInput } from "./agent-review-contract";

/**
 * Grok Build CLI(xAI 공식, 구독 로그인)로 보는 심사 — 2차 표 제공자 "grok-cli".
 *
 * 같은 정책 글(REVIEW_SYSTEM_PROMPT)을 에이전트 정의의 시스템 프롬프트(--agent, promptMode full)로, 증거 JSON 을
 * --prompt-file 로 넘기고, 출력은 게이트웨이와 같은 JSON 스키마(--json-schema → structuredOutput)로 받는다. 실측(2026-10-03, 200건, grok-4.7 effort high):
 * 실패 0, 중앙값 23초, p90 46초, 최대 75초, 동시 3개까지 재시도·429 없음 — 그래서 제한 시간은 90초다.
 *
 * 호출마다 GROK_HOME 을 빈 임시 디렉터리로 두어 세션·로그가 쌓이지 않게 하고(200건에 39MB), 로그인 파일은
 * GROK_AUTH_PATH 하나만 함께 쓴다 — CLI 가 갱신한 토큰을 그 파일에 다시 쓰므로 쓸 수 있는 경로여야 한다.
 */
export const GROK_REVIEW_TIMEOUT_MS = 90_000;
/**
 * 추론 강도 — 기본 low, 환경변수로 바꾼다. 모델 카탈로그: minimal·low·medium·high·xhigh.
 * 50건 비교(2026-10-04, 프롬프트 2026-10-03.1): low 는 high 와 48/50 같은 판정(다른 2건은 low 가 더 엄격), 중앙값 9.6초 vs 17.2초,
 * 출력 토큰 1/3 — 심사는 한 턴짜리 분류라 긴 추론이 판정을 바꾸지 않았다.
 */
export function grokReviewEffort(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const value = env.GROK_REVIEW_EFFORT?.trim().toLowerCase();
  return value && /^(minimal|low|medium|high|xhigh)$/.test(value) ? value : "low";
}
/**
 * 에이전트 정의 — 기본 코딩 에이전트 프롬프트(도구 규약·작업 지침 ~1만 토큰) 대신 정책 글만 시스템 프롬프트로 쓴다(promptMode full).
 * 같은 사례 실측(2026-10-04): 입력 16,805 → 9,476 토큰, 비용 -25%, 판정 같음. 호출마다 임시 GROK_HOME 에 써 넣고 --agent 로 고른다.
 */
export const GROK_REVIEW_AGENT = "nmv-review";
export function grokReviewAgentDefinition(): string {
  return `---
name: ${GROK_REVIEW_AGENT}
description: NoMoreVibe product page review — structured JSON only
promptMode: full
discoverSkills: false
agentsMd: false
injectDefaultTools: false
disallowedTools: [run_terminal_cmd, search_replace, web_search, web_fetch, read_file, write_file, list_dir, grep, glob, Agent]
---
${REVIEW_SYSTEM_PROMPT}
Return one JSON object with decision, reason, evidenceIds, confidence. Do not use any tools.
`;
}
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

/** 게이트웨이(GATEWAY_SCHEMA)와 같은 모양 — 2차 합의는 confidence·evidenceIds 가 있어야 셈이 된다 */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "reason", "evidenceIds", "confidence"],
  properties: {
    decision: { type: "string", enum: ["approve", "reject", "needs_review"] },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
    evidenceIds: { type: "array", maxItems: 40, items: { type: "string", minLength: 1, maxLength: 100 } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export type GrokCliResult = { kind: "exit"; code: number | null; stdout: string; stderr: string }
  | { kind: "timeout" | "cancelled" | "output_too_large" | "missing_cli" | "cli_error" };
export type GrokCliRun = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }) => Promise<GrokCliResult>;

/** 로그인 파일 — 기본은 ~/.grok/auth.json(`grok login --device-auth` 가 쓰는 자리) */
export function grokAuthPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.GROK_AUTH_PATH?.trim() || path.join(os.homedir(), ".grok", "auth.json");
}

export function grokReviewArgs(model: string, promptFile: string, effort = grokReviewEffort()): string[] {
  return [
    "--prompt-file", promptFile, "--agent", GROK_REVIEW_AGENT,
    // 빈 허용 목록 = 도구 없음 — 도구 스키마가 빠져 입력이 9,476 → 8,324 토큰(같은 사례)
    "--tools", "",
    "-m", model, "--effort", effort, "--output-format", "json",
    // 한 턴, 도구 없음 — 도구를 부르면 구조화 출력 없이 끝나 invalid_output 으로 적힌다
    "--max-turns", "1", "--disable-web-search", "--no-subagents", "--no-plan", "--no-auto-update",
    "--disallowed-tools", "run_terminal_cmd,search_replace,web_search,web_fetch",
    "--json-schema", JSON.stringify(OUTPUT_SCHEMA),
  ];
}

/** 0이 아닌 종료 코드의 이유 — 원문은 싣지 않고 종류만 남긴다(cliFailure 와 같은 원칙) */
export function grokFailure(stdout: string, stderr: string): ReviewFailure {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (/sign(ed)? in|signed out|grok login|not authenticated|unauthori|auth\.json|\b401\b|\b403\b/.test(text)) return "auth";
  if (/\b429\b|rate limit|too many requests/.test(text)) return "rate_limited";
  if (/quota|credit|usage limit|budget/.test(text)) return "budget";
  return "cli_error";
}

/** 기한·초과분은 죽이고, 자식의 close 가 확인된 뒤에만 돌아온다(runReviewCli 와 같은 규율) */
export const runGrokCli: GrokCliRun = (args, options) => new Promise((resolve) => {
  if (options.signal?.aborted) { resolve({ kind: "cancelled" }); return; }
  const child = spawn(process.env.GROK_CLI ?? "grok", args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: false });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let stdoutBytes = 0, stderrBytes = 0;
  let stopped: Exclude<GrokCliResult, { kind: "exit" }> | null = null;
  const stop = (kind: "timeout" | "cancelled" | "output_too_large" | "cli_error") => {
    stopped ??= { kind };
    if (!child.pid) return;
    try { child.kill("SIGKILL"); } catch { /* OS 가 거부하면 close 가 끝을 알린다 */ }
  };
  const abort = () => stop("cancelled");
  const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.byteLength; if (stdoutBytes > MAX_STDOUT_BYTES) stop("output_too_large"); else stdout.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > MAX_STDERR_BYTES) stop("output_too_large"); else stderr.push(chunk); });
  child.on("error", (error: NodeJS.ErrnoException) => { stopped ??= { kind: error.code === "ENOENT" ? "missing_cli" : "cli_error" }; });
  child.on("close", (code) => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    resolve(stopped ?? { kind: "exit", code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
  });
});

export async function reviewWithGrokCli(input: ReviewInput, options: { model: string; timeoutMs?: number; signal?: AbortSignal; run?: GrokCliRun }): Promise<AgentReviewResult> {
  const model = options.model.trim();
  if (!MODEL_NAME.test(model)) return { ok: false, error: "not_configured" };
  const serialized = JSON.stringify(input.snapshot);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REVIEW_INPUT_BYTES) return { ok: false, error: "input_too_large" };
  // 꺾쇠를 막아 두어야 증거 안의 글이 구분자를 끝내지 못한다 — CLI·게이트웨이 쪽과 같은 처리다
  const prompt = `<untrusted_evidence_json>\n${serialized.replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}\n</untrusted_evidence_json>`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "nomorevibe-grok-"));
  try {
    const promptFile = path.join(directory, "prompt.txt");
    const home = path.join(directory, "home");
    await mkdir(path.join(home, "agents"), { recursive: true });
    await Promise.all([writeFile(promptFile, prompt, "utf8"), writeFile(path.join(home, "agents", `${GROK_REVIEW_AGENT}.md`), grokReviewAgentDefinition(), "utf8")]);
    const env = { ...process.env, GROK_HOME: home, GROK_AUTH_PATH: grokAuthPath(), RUST_LOG: "off", NO_COLOR: "1" };
    let result: GrokCliResult;
    try {
      result = await (options.run ?? runGrokCli)(grokReviewArgs(model, promptFile), {
        cwd: directory, env, timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? GROK_REVIEW_TIMEOUT_MS, GROK_REVIEW_TIMEOUT_MS)), signal: options.signal,
      });
    } catch { return { ok: false, error: "cli_error" }; }
    if (result.kind !== "exit") return { ok: false, error: result.kind };
    let output: Record<string, unknown>;
    try {
      const start = result.stdout.indexOf("{");
      const parsed: unknown = JSON.parse(start >= 0 ? result.stdout.slice(start) : result.stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_envelope");
      output = parsed as Record<string, unknown>;
    } catch { return { ok: false, error: result.code === 0 ? "invalid_output" : grokFailure(result.stdout, result.stderr) }; }
    const usage = usageFrom(output);
    if (result.code !== 0) return { ok: false, error: grokFailure(result.stdout, result.stderr), usage };
    try {
      const value = output.structuredOutput ?? JSON.parse(typeof output.text === "string" ? output.text : "");
      return { ok: true, outcome: validateReviewOutcome(input, value), usage };
    } catch { return { ok: false, error: "invalid_output", usage }; }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
