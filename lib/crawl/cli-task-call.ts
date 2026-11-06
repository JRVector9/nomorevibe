import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { cliModelDispatchSchema, type CliModelDispatch } from "@/lib/llm/capacity";
import { setCliHostObservedVersion } from "@/lib/llm/cli-serving-contract";
import {
  prepareCliCall,
  runReservedCliCall,
  settleCliNotStarted,
  type CliProcessResult,
  type CliProcessTerminal,
  type PreparedCliCall,
} from "@/lib/llm/cli-process-runner";
import {
  cliTaskPrepareDataSchema,
  cliTaskPreparedCallSchema,
  type CliTaskPrepareData,
  type CliTaskResult,
  type PreparedCliTaskCall,
} from "@/lib/operations/cli-task-protocol";
import {
  OPENCODE_REVIEW_AGENT,
  opencodeReportedUsage,
  opencodeReviewArgs,
  opencodeReviewProfile,
  releaseOpencodeReviewProfile,
} from "./agent-review-opencode";
import { readOpenCodeCliCapabilities } from "./opencode-cli-capabilities";

export type CliTaskOutcome = Readonly<{
  result: CliTaskResult;
  terminal: CliProcessTerminal | null;
  indeterminate: "process_exit" | "transport_unknown" | null;
}>;

const MAX_STDOUT_BYTES = 65_536;
const MAX_STDERR_BYTES = 16_384;
const OPENCODE_CONFIG_PATH = path.join("config", "opencode", "opencode.json");

type Unsupported = Readonly<{ kind: "unsupported"; reason: "provider_contract_unavailable" }>;
type TaskError = Extract<CliTaskResult, { ok: false }>["error"];
type TaskUsage = Extract<CliTaskResult, { ok: true }>["usage"];
type ProfileFile = Readonly<{ path: string; content: string }>;
type ResponseFormat = NonNullable<CliTaskPrepareData["responseFormat"]>;
type LocalTaskState = {
  cli: PreparedCliCall;
  directory: string;
  used: boolean;
  released: boolean;
  releasePromise?: Promise<void>;
  active?: Promise<void>;
};

const calls = new WeakMap<PreparedCliTaskCall, LocalTaskState>();

function unsupported(): Unsupported {
  return { kind: "unsupported", reason: "provider_contract_unavailable" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stopError(kind: Exclude<CliProcessResult["kind"], "exit">): TaskError {
  switch (kind) {
    case "cancelled": return "cancelled";
    case "timeout": return "timeout";
    case "output_too_large": return "output_too_large";
    case "missing_cli": return "missing_cli";
    case "cli_error": return "cli_error";
    default: return "cli_error";
  }
}

function failure(error: TaskError, usage?: TaskUsage): CliTaskResult {
  return usage ? { ok: false, error, usage } : { ok: false, error };
}

type OpenCodeEvent = { type?: unknown; part?: Record<string, unknown> };

function readEvents(stdout: string): OpenCodeEvent[] {
  return stdout.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid_opencode_event");
    return parsed as OpenCodeEvent;
  });
}

function parseTaskExit(result: Extract<CliProcessResult, { kind: "exit" }>): CliTaskResult {
  const usage = opencodeReportedUsage(result.stdout) ?? undefined;
  try {
    const stream = readEvents(result.stdout);
    if (stream.some(event => event.type === "error") || result.code !== 0) {
      const auth = /auth|unauthenticated|not logged in|api.?key/i.test(`${result.stdout}\n${result.stderr}`);
      return failure(auth ? "auth" : "cli_error", usage);
    }
    if (stream.some(event => event.type === "tool_use")) return failure("invalid_output", usage);
    const finishAt = stream.findLastIndex(event => event.type === "step_finish");
    const last = stream[finishAt]?.part;
    if (!last || last.reason !== "stop" || typeof last.messageID !== "string"
      || stream.slice(finishAt + 1).some(event => ["step_start", "text", "reasoning"].includes(String(event.type)) && event.part?.messageID !== last.messageID)) {
      return failure("invalid_output", usage);
    }
    const content = stream
      .filter(event => event.type === "text" && event.part?.messageID === last.messageID)
      .map(event => typeof event.part?.text === "string" ? event.part.text : "")
      .join("")
      .trim();
    return { ok: true, content, usage: usage ?? {} };
  } catch {
    return failure(result.code === 0 ? "invalid_output" : "cli_error", usage);
  }
}

function parseTaskResult(result: CliProcessResult): CliTaskResult {
  if (result.kind !== "exit") return failure(stopError(result.kind));
  return parseTaskExit(result);
}

async function cleanupDirectory(directory: string): Promise<void> {
  let failureValue: unknown;
  try {
    await releaseOpencodeReviewProfile(directory);
  } catch (error) {
    failureValue = error;
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    failureValue ??= error;
  }
  if (failureValue !== undefined) throw failureValue;
}

function formatInstruction(format: ResponseFormat): string {
  const schema = JSON.stringify(format.json_schema.schema);
  const strict = format.json_schema.strict === true ? " The JSON value must satisfy strict mode." : "";
  const separator = String.fromCharCode(10, 10);
  return `${separator}Return exactly one JSON value${strict} conforming to JSON Schema '${format.json_schema.name}': ${schema}. Do not use Markdown fences or add any other text.`;
}

function updateAgentPrompt(config: Record<string, unknown>, prompt: string): string {
  const agents = config.agent;
  if (!isRecord(agents)) throw new Error("cli_task_profile_invalid");
  const agent = agents[OPENCODE_REVIEW_AGENT];
  if (!isRecord(agent)) throw new Error("cli_task_profile_invalid");
  agent.prompt = prompt;
  return JSON.stringify(config);
}

function buildTaskProfile(
  files: readonly ProfileFile[],
  env: Readonly<Record<string, string | undefined>>,
  prompt: string,
): { file: ProfileFile; files: readonly ProfileFile[]; memoryContent: string } {
  const file = files.find(candidate => candidate.path === OPENCODE_CONFIG_PATH);
  if (!file) throw new Error("cli_task_profile_invalid");

  const diskParsed = JSON.parse(file.content) as unknown;
  if (!isRecord(diskParsed)) throw new Error("cli_task_profile_invalid");

  const memoryRaw = env.OPENCODE_CONFIG_CONTENT;
  if (typeof memoryRaw !== "string") throw new Error("cli_task_profile_invalid");
  const memoryParsed = JSON.parse(memoryRaw) as unknown;
  if (!isRecord(memoryParsed)) throw new Error("cli_task_profile_invalid");

  const diskContent = updateAgentPrompt(diskParsed, prompt);
  const memoryContent = updateAgentPrompt(memoryParsed, prompt);
  const nextFile: ProfileFile = { path: file.path, content: diskContent };
  return {
    file: nextFile,
    files: files.map(candidate => candidate.path === file.path ? nextFile : candidate),
    memoryContent,
  };
}

function releaseState(state: LocalTaskState): Promise<void> {
  if (state.releasePromise) return state.releasePromise;
  state.released = true;
  state.releasePromise = (async () => {
    const active = state.active;
    if (active) await active;
    await cleanupDirectory(state.directory);
  })();
  return state.releasePromise;
}

function assertTaskDispatch(call: PreparedCliTaskCall, dispatch: unknown): { requestId: string; transport: PreparedCliCall["transport"] } {
  const parsed = cliModelDispatchSchema.safeParse(dispatch);
  if (!parsed.success) throw new Error("cli_task_dispatch_invalid");
  const value: CliModelDispatch = parsed.data;
  const binding = value.binding;
  if (binding.kind !== "intro_check_cli" && binding.kind !== "product_audit_cli") {
    throw new Error("cli_task_dispatch_invalid");
  }
  const expectedKind = call.routeId === "product-intro-check" ? "intro_check_cli"
    : call.routeId === "product-audit" ? "product_audit_cli"
    : null;
  if (expectedKind === null || binding.kind !== expectedKind
    || !isDeepStrictEqual(binding.inputHash, call.inputHash)
    || !isDeepStrictEqual(binding.provider, call.provider)
    || !isDeepStrictEqual(binding.model, call.model)
    || !isDeepStrictEqual(binding.routeId, call.routeId)
    || !isDeepStrictEqual(binding.totalTokenBound, call.totalTokenBound)
    || !isDeepStrictEqual(binding.transport, call.transport)) {
    throw new Error("cli_task_dispatch_mismatch");
  }
  return { requestId: value.requestId, transport: call.transport };
}

export async function prepareLocalCliTaskCall(
  data: CliTaskPrepareData,
  catalogVariants?: readonly string[],
): Promise<PreparedCliTaskCall | Unsupported> {
  const parsedResult = cliTaskPrepareDataSchema.safeParse(data);
  if (!parsedResult.success) return unsupported();
  const parsed = parsedResult.data;
  if (parsed.reasoningEffort !== undefined && catalogVariants !== undefined && !catalogVariants.includes(parsed.reasoningEffort)) {
    return unsupported();
  }
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(tmpdir(), "nmv-cli-task-"));
    const profile = await opencodeReviewProfile(directory);
    const capabilities = await readOpenCodeCliCapabilities(profile.command, directory, profile.env);
    setCliHostObservedVersion(capabilities.version);
    let args: string[];
    try {
      args = opencodeReviewArgs(parsed.model, parsed.reasoningEffort, capabilities);
    } catch (error) {
      if (error instanceof Error && /^opencode_cli_(unsupported|variant_unsupported|variant_invalid|model_invalid)$/.test(error.message)) {
        await cleanupDirectory(directory).catch(() => undefined);
        directory = undefined;
        return unsupported();
      }
      throw error;
    }
    const prompt = parsed.responseFormat
      ? `${parsed.messages[0].content}${formatInstruction(parsed.responseFormat)}`
      : parsed.messages[0].content;
    const profileTask = buildTaskProfile(profile.files, profile.env, prompt);
    await writeFile(path.join(directory, profileTask.file.path), profileTask.file.content, { mode: 0o600 });
    const env = { ...profile.env, OPENCODE_CONFIG_CONTENT: profileTask.memoryContent };
    const cli = await prepareCliCall({
      routeId: parsed.task,
      provider: "opencode-cli",
      model: parsed.model,
      command: capabilities.command,
      args,
      stdin: parsed.messages[1].content,
      files: profileTask.files,
      cwd: directory,
      env,
      boundEnvKeys: profile.boundEnvKeys,
      timeoutMs: parsed.timeoutMs,
      maxStdoutBytes: MAX_STDOUT_BYTES,
      maxStderrBytes: MAX_STDERR_BYTES,
    });
    if (cli.kind !== "prepared") {
      await cleanupDirectory(directory).catch(() => undefined);
      directory = undefined;
      return unsupported();
    }
    const call: PreparedCliTaskCall = cliTaskPreparedCallSchema.parse({
      kind: "prepared_cli_task",
      routeId: parsed.task,
      provider: "opencode-cli",
      model: parsed.model,
      inputHash: parsed.inputHash,
      transport: cli.transport,
      totalTokenBound: cli.totalTokenBound,
    });
    Object.freeze(call);
    calls.set(call, { cli, directory, used: false, released: false });
    directory = undefined;
    return call;
  } catch (error) {
    if (directory) await cleanupDirectory(directory).catch(() => undefined);
    throw error;
  }
}

export async function runLocalCliTaskCall(
  call: PreparedCliTaskCall,
  dispatch: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<CliTaskOutcome> {
  const state = calls.get(call);
  if (!state) throw new Error("cli_task_call_unknown");
  if (state.released) throw new Error("cli_task_call_released");
  if (state.used) throw new Error("cli_task_call_used");
  const dispatchRef = assertTaskDispatch(call, dispatch);

  let resolveActive!: () => void;
  const active = new Promise<void>(resolve => { resolveActive = resolve; });
  state.active = active;
  state.used = true;
  try {
    const outcome = await runReservedCliCall(state.cli, dispatchRef, { signal: options.signal });
    if (!outcome.terminal) {
      return {
        result: failure(stopError(outcome.result.kind)),
        terminal: null,
        indeterminate: outcome.indeterminate ?? "transport_unknown",
      };
    }
    return { result: parseTaskResult(outcome.result), terminal: outcome.terminal, indeterminate: null };
  } finally {
    resolveActive();
    if (state.active === active) state.active = undefined;
  }
}

export async function settleLocalCliTaskNotStarted(call: PreparedCliTaskCall, dispatch: unknown): Promise<CliProcessTerminal | null> {
  const state = calls.get(call);
  if (!state) throw new Error("cli_task_call_unknown");
  if (state.released) throw new Error("cli_task_call_released");
  if (state.used) return null;
  const dispatchRef = assertTaskDispatch(call, dispatch);
  state.used = true;
  return await settleCliNotStarted(state.cli, dispatchRef);
}

export async function releaseLocalCliTaskCall(call: PreparedCliTaskCall): Promise<void> {
  const state = calls.get(call);
  if (!state) return;
  await releaseState(state);
}
