import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REVIEW_SYSTEM_PROMPT, type AgentReviewResult, type ReviewUsage } from "./agent-review";
import { validateReviewOutcome, type ReviewInput } from "./agent-review-contract";
import type { CliProcessResult } from "@/lib/llm/cli-process-runner";
import type { OpenCodeCliCapabilities } from "./opencode-cli-capabilities";

/** Existing M3 host CLI, never installed or upgraded by workers. */
export const OPENCODE_HOST_COMMAND = "/opt/homebrew/bin/opencode";
export const OPENCODE_HOST_HOME = "/Users/jr";
export const OPENCODE_REVIEW_AGENT = "nmv-review";
export function opencodeReviewArgs(model: string, effort?: string, cap?: OpenCodeCliCapabilities): string[] {
  if (!cap) return ["run", "--pure", "--format", "json", "--agent", OPENCODE_REVIEW_AGENT, "--model", model,
    ...(effort ? ["--variant", effort] : [])];
  if (!cap.pure && !cap.standalone) throw new Error("opencode_cli_unsupported");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)) throw new Error("opencode_cli_model_invalid");
  if (effort !== undefined && (!/^[a-z0-9_-]{1,32}$/.test(effort) || effort.startsWith("-"))) throw new Error("opencode_cli_variant_invalid");
  if (effort !== undefined && cap.variantSyntax === "none") throw new Error("opencode_cli_variant_unsupported");
  const variantModel = effort !== undefined && cap.variantSyntax === "suffix" ? `${model}#${effort}` : model;
  return [
    ...(cap.standalone ? ["--standalone"] : []), "run", ...(cap.pure ? ["--pure"] : []),
    "--format", "json", "--agent", OPENCODE_REVIEW_AGENT, "--model", variantModel,
    ...(effort !== undefined && cap.variantSyntax === "flag" ? ["--variant", effort] : []),
  ];
}

/**
 * OpenCode 는 agent 의 마지막 허용 step 에 「MAXIMUM STEPS 도달 — 도구 금지, 글로만 답하라」 지시를 끼워 넣는다. steps 1 이면 첫 step 이 곧
 * 마지막이라 모든 심사 호출에 그 지시가 붙는다 — 2026-11-07 운영에서 모델이 그것을 주입으로 보고 빈 답(출력 2토큰)이나 해명 글 + JSON 을
 * 내 1차 OpenCode 심사의 절반 넘게 invalid_output 이 됐다(M3 OpenCode 2.2.5 재현: steps 1 은 10건 중 5건 실패, steps 2 는 10건 모두 통과).
 * 첫 step 이 마지막이 아니게 2 로 둔다. 도구는 permission 으로 모두 거절되고 tool_use 가 보이면 결과를 버리므로 늘어나는 것은 빈 step 하나뿐이다.
 */
export const OPENCODE_REVIEW_STEPS = 2;

/** v1 configuration: deny every tool/MCP operation and prevent auxiliary LLM calls. */
export function opencodeReviewConfig(): string {
  const permission = { "*": "deny" };
  return JSON.stringify({
    permission, plugin: [], mcp: {}, snapshot: false, autoupdate: false, instructions: [],
    compaction: { auto: false, prune: false }, default_agent: OPENCODE_REVIEW_AGENT,
    agent: {
      [OPENCODE_REVIEW_AGENT]: { mode: "primary", steps: OPENCODE_REVIEW_STEPS, permission,
        prompt: `${REVIEW_SYSTEM_PROMPT}\nReturn one JSON object with decision, reason, evidenceIds, confidence. Do not use tools.` },
      title: { disable: true }, summary: { disable: true }, compaction: { disable: true },
    },
  });
}

/** Child commands inherit the original jr auth data home, never the bridge's DB, RPC or startup/config credentials. */
export function opencodeHostEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (source.HOME !== OPENCODE_HOST_HOME) throw new Error("cli_host_identity_mismatch");
  const keys = ["PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
  const env = Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  return { ...env, NODE_ENV: "production", HOME: OPENCODE_HOST_HOME, NO_COLOR: "1", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_PURE: "true" };
}

/**
 * Keep jr's credentials in their existing data directory, while isolating project/user plugins, agents and MCP.
 * v1 scans ~/.opencode even with project config disabled; refuse it rather than changing the user's directory.
 * Its built-in npm bootstrap skips nonwritable config directories, so the isolated profile installs no packages.
 */
const ownedProfiles = new Set<string>();
export async function opencodeReviewProfile(directory: string) {
  const env = opencodeHostEnv(process.env);
  try { await lstat(path.join(OPENCODE_HOST_HOME, ".opencode")); throw new Error("cli_host_user_profile_not_isolated"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const configRoot = path.join(directory, "config"), configDir = path.join(configRoot, "opencode");
  const config = opencodeReviewConfig();
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  ownedProfiles.add(directory);
  await writeFile(path.join(configDir, "opencode.json"), config, { mode: 0o600 });
  await chmod(configDir, 0o500);
  // v2 standalone does not resolve Go API auth from the user profile in the isolated config.
  // Reuse the existing login in memory only. Neither the temporary file nor the registry stores its key.
  let runtimeConfig = config;
  try {
    const auth = JSON.parse(await readFile(path.join(env.XDG_DATA_HOME ?? path.join(OPENCODE_HOST_HOME, ".local", "share"), "opencode", "auth.json"), "utf8"));
    const go = auth?.["opencode-go"];
    if (go?.type === "api" && typeof go.key === "string" && go.key.length > 0) {
      runtimeConfig = JSON.stringify({ ...JSON.parse(config), provider: { "opencode-go": { options: { apiKey: go.key } } } });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("cli_host_auth_unreadable");
  }
  const flags = { OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_AUTOCOMPACT: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true", OPENCODE_CONFIG_CONTENT: runtimeConfig, OPENCODE_PERMISSION: JSON.stringify({ "*": "deny" }) };
  return { command: OPENCODE_HOST_COMMAND,
    env: { ...env, ...flags, XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: env.XDG_DATA_HOME ?? path.join(OPENCODE_HOST_HOME, ".local", "share"),
      XDG_CACHE_HOME: path.join(directory, "cache"), XDG_STATE_HOME: path.join(directory, "state") },
    files: [{ path: path.join("config", "opencode", "opencode.json"), content: config }],
    boundEnvKeys: ["NO_COLOR", "OPENCODE_PURE", "OPENCODE_DISABLE_AUTOUPDATE", ...Object.keys(flags)] };
}
export async function releaseOpencodeReviewProfile(directory: string): Promise<void> {
  if (!ownedProfiles.has(directory)) return;
  await chmod(path.join(directory, "config", "opencode"), 0o700).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  ownedProfiles.delete(directory);
}

type Event = Record<string, unknown> & { part?: Record<string, unknown> };
function events(stdout: string): Event[] {
  return stdout.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const event: unknown = JSON.parse(line);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("invalid_opencode_event");
    return event as Event;
  });
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Reconcile can repeat a completed step; never count the same assistant message twice. */
export function opencodeReportedUsage(stdout: string): { inputTokens: number; outputTokens: number; costUsd?: number } | null {
  try {
    const steps = new Map<string, Record<string, unknown>>();
    for (const event of events(stdout)) {
      const part = event.part;
      if (event.type === "step_finish" && part && typeof part.messageID === "string") steps.set(part.messageID, part);
    }
    if (!steps.size) return null;
    let inputTokens = 0, outputTokens = 0, costUsd = 0, hasCost = true;
    for (const part of steps.values()) {
      const tokens = part.tokens as Record<string, unknown> | undefined;
      const cache = tokens?.cache as Record<string, unknown> | undefined;
      if (!tokens || !count(tokens.input) || !count(tokens.output) || !count(tokens.reasoning)
        || !cache || !count(cache.read) || !count(cache.write)) return null;
      // Include cache and reasoning in the conservative capacity total, rather than counting visible text alone.
      inputTokens += tokens.input + cache.read + cache.write; outputTokens += tokens.output + tokens.reasoning;
      if (typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost >= 0) costUsd += part.cost;
      else hasCost = false;
    }
    if (!count(inputTokens) || !count(outputTokens)) return null;
    return { inputTokens, outputTokens, ...(hasCost ? { costUsd } : {}) };
  } catch { return null; }
}

/**
 * invalid_output 이 어느 검사에서 났는지 — 고정 코드만(출력 내용은 싣지 않는다). 결과의 detail 로 워커에 가고 워커 로그 crawl.agent_reviewed 에 남는다.
 * (2026-11-07: 이 구분이 없어 운영 실패의 원인을 출력 원문 재현으로만 알 수 있었다.)
 */
export const OPENCODE_OUTPUT_ISSUES = ["event_invalid", "tool_use", "no_finish", "finish_not_stop", "trailing_message", "no_text", "not_json",
  "outcome_invalid"] as const;
export type OpencodeOutputIssue = (typeof OPENCODE_OUTPUT_ISSUES)[number];
const issue = (code: OpencodeOutputIssue, usage?: ReviewUsage): AgentReviewResult =>
  ({ ok: false, error: "invalid_output", detail: `opencode_output:${code}`, ...(usage ? { usage } : {}) });

/**
 * 답 글에서 JSON 객체 하나를 꺼낸다. 그대로 → ```json 울타리 하나 → 마지막으로 줄 머리에서 시작해 글 끝까지 이어지는 객체(앞에 해명 글이
 * 붙은 답) 순서로만 본다. 꺼낸 값은 validateReviewOutcome 이 그대로 검사한다(근거 id·결정·신뢰도) — 여기서 뜻을 고치지 않는다.
 */
export function opencodeAnswerJson(text: string): unknown {
  const attempt = (value: string): { ok: true; value: unknown } | { ok: false } => {
    try { return { ok: true, value: JSON.parse(value) }; } catch { return { ok: false }; }
  };
  const whole = attempt(text);
  if (whole.ok) return whole.value;
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(text);
  if (fenced) { const inner = attempt(fenced[1].trim()); if (inner.ok) return inner.value; }
  if (text.endsWith("}")) {
    for (let at = text.lastIndexOf("\n{"); at >= 0; at = at > 0 ? text.lastIndexOf("\n{", at - 1) : -1) {
      const tail = attempt(text.slice(at + 1));
      if (tail.ok && tail.value && typeof tail.value === "object" && !Array.isArray(tail.value)) return tail.value;
    }
  }
  throw new Error("opencode_answer_not_json");
}

export function opencodeReviewResult(input: ReviewInput, result: CliProcessResult): AgentReviewResult {
  if (result.kind !== "exit") return { ok: false, error: result.kind };
  let stream: Event[];
  try { stream = events(result.stdout); }
  catch { return result.code === 0 ? issue("event_invalid") : { ok: false, error: "cli_error" }; }
  const usage = opencodeReportedUsage(result.stdout) ?? undefined;
  if (stream.some(event => event.type === "error") || result.code !== 0) {
    const auth = /auth|unauthenticated|not logged in|api.?key/i.test(`${result.stdout}\n${result.stderr}`);
    return { ok: false, error: auth ? "auth" : "cli_error", usage };
  }
  if (stream.some(event => event.type === "tool_use")) return issue("tool_use", usage);
  const finishAt = stream.findLastIndex(event => event.type === "step_finish");
  const last = stream[finishAt]?.part;
  if (!last || typeof last.messageID !== "string") return issue("no_finish", usage);
  if (last.reason !== "stop") return issue("finish_not_stop", usage);
  if (stream.slice(finishAt + 1).some(event => ["step_start", "text", "reasoning"].includes(String(event.type)) && event.part?.messageID !== last.messageID))
    return issue("trailing_message", usage);
  const text = stream.filter(event => event.type === "text" && event.part?.messageID === last.messageID)
    .map(event => typeof event.part?.text === "string" ? event.part.text : "").join("").trim();
  if (!text) return issue("no_text", usage);
  let answer: unknown;
  try { answer = opencodeAnswerJson(text); } catch { return issue("not_json", usage); }
  try { return { ok: true, outcome: validateReviewOutcome(input, answer), usage: usage ?? {} }; }
  catch { return issue("outcome_invalid", usage); }
}
