import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { reviewCliArgs, reviewWithAgent } from "@/lib/crawl/agent-review";
import { grokReviewArgs, reviewWithGrokCli } from "@/lib/crawl/agent-review-grok";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { cliDispatchBindingHash, type CliDispatchBinding, type CliModelDispatch } from "@/lib/llm/capacity";
import { readCliProcessTerminal } from "@/lib/llm/cli-process-runner";
import { claudeCliTokenBound, type CliServingContract } from "@/lib/llm/cli-serving-contract";
import { prepareReviewCliCall, releaseReviewCliCall, reviewWithReservedCli, settleReviewCliNotStarted,
  type PreparedReviewCliCall } from "@/lib/crawl/review-cli-call";

/*
 * 05c-4 의 프로세스 쪽 절반: 공통 슬롯 경로(native)가 legacy reviewWithAgent·reviewWithGrokCli 와 같은 명령·argv·stdin·env·
 * 제한 시간으로 자식을 띄우고 같은 parser 결과를 내는지 실제 가짜 CLI 프로세스로 맞춘다. 실제 claude/grok 는 부르지 않는다 —
 * 명령은 절대경로 sh 래퍼이고 자식의 PATH 는 빈 디렉터리다. 장부(DB)는 쓰지 않는다.
 */
const fixture = vi.hoisted(() => ({ contracts: [] as CliServingContract[] }));
vi.mock("@/lib/llm/cli-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/cli-serving-contract")>(),
  resolveCliServingContract: (routeId: string, provider: string, model: string) =>
    fixture.contracts.find(value => value.routeId === routeId && value.provider === provider && value.model === model) ?? null,
}));
const model = "fake-model", PROCESS_TEST_MS = 20_000;
const claudeShape = { maxTurns: 2, inputByteCap: 200_000, overheadTokenBound: 20_000, outputTokensPerTurn: 2_000 };
const claude = (routeId: string): CliServingContract => ({ version: 1, protocol: "cli-process-v1", routeId, provider: "claude-cli", model,
  cliVersion: "fake 0.0.0", totalTokenBound: claudeCliTokenBound(claudeShape), costBoundUsdMicros: 150_000, boundProvenance: "derived", ...claudeShape });
const grok = (routeId: string): CliServingContract => ({ version: 1, protocol: "cli-process-v1", routeId, provider: "grok-cli", model,
  cliVersion: "fake 0.0.0", inputByteCap: 200_000, totalTokenBound: 300_000, costBoundUsdMicros: null, boundProvenance: "declared" });
let root = "", bin = "", grokAnswer = "", empty = "", records = "", files = "", tmp = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nmv-review-cli-call-"));
  empty = path.join(root, "empty-path"); records = path.join(root, "records"); files = path.join(root, "files"); tmp = path.join(root, "tmp");
  for (const dir of [empty, records, files, tmp]) await mkdir(dir);
  const fake = path.resolve("tests/fixtures/fake-cli/fake.mjs");
  for (const value of [root, fake, process.execPath]) expect(value).not.toContain("'");
  // Grok 은 prompt·agent 파일을 읽어 둔다(자식 pid 이름). PATH 가 비어 있으므로 cp 는 절대경로다.
  bin = path.join(root, "fake-cli");
  await writeFile(bin, `#!/bin/sh
prev=""
for a in "$@"; do if [ "$prev" = "--prompt-file" ]; then /bin/cp "$a" '${files}'/prompt-$$.txt 2>/dev/null; fi; prev="$a"; done
if [ -n "$GROK_HOME" ]; then /bin/cp "$GROK_HOME/agents/nmv-review.md" '${files}'/agent-$$.md 2>/dev/null; fi
exec '${process.execPath}' '${fake}' "$@"
`);
  await chmod(bin, 0o755);
  // Grok 모양의 정상 답(structuredOutput). 가짜 CLI 의 ok 는 Claude envelope 라 Grok parser 로는 invalid_output 이다.
  grokAnswer = path.join(root, "grok-answer");
  const answer = JSON.stringify({ structuredOutput: { decision: "approve", reason: "가짜 Grok 답", evidenceIds: ["product"], confidence: 0.8 },
    usage: { input_tokens: 40, output_tokens: 9 } });
  await writeFile(grokAnswer, `#!/bin/sh
exec '${process.execPath}' -e 'process.stdout.write(process.argv[1])' '${answer}'
`);
  await chmod(grokAnswer, 0o755);
});
afterAll(() => rm(root, { recursive: true, force: true }));
beforeEach(() => {
  fixture.contracts = [claude("crawl-agent-review"), claude("second-review"), grok("crawl-agent-review"), grok("second-review")];
  vi.stubEnv("TMPDIR", tmp); vi.stubEnv("PATH", empty); vi.stubEnv("FAKE_CLI_RECORD", records); vi.stubEnv("CLAUDECODE", "1");
  vi.stubEnv("CLAUDE_CLI", bin); vi.stubEnv("GROK_CLI", bin); vi.stubEnv("GROK_AUTH_PATH", path.join(root, "auth.json")); vi.stubEnv("GROK_HOME", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of [records, files]) for (const name of await readdir(dir)) await rm(path.join(dir, name));
});

type Recorded = { mode: string; pid: number; argv: string[]; env: Record<string, string | null>; realCliOnPath: boolean; stdin?: string; grandchild?: number };
async function recorded(): Promise<Recorded[]> {
  const names = (await readdir(records)).sort();
  return Promise.all(names.map(async name => JSON.parse(await readFile(path.join(records, name), "utf8")) as Recorded));
}
async function captured(pid: number) {
  const read = (name: string) => readFile(path.join(files, name), "utf8").catch(() => null);
  return { prompt: await read(`prompt-${pid}.txt`), agent: await read(`agent-${pid}.md`) };
}
async function clear() { for (const dir of [records, files]) for (const name of await readdir(dir)) await rm(path.join(dir, name)); }
function input() {
  const now = new Date("2026-10-17T00:00:00.000Z"), settings = structuredClone({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "observe" as const });
  const candidate = { id: 41, repo: "cli-call/app", productUrl: "https://cli-call.example", state: "approved", decidedBy: "auto",
    judgedAt: now, updatedAt: now } as CrawlCandidate;
  const document = { id: 42, repo: candidate.repo, productUrl: candidate.productUrl, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: "Task <tracker> & 한글 ✓", stargazers_count: 3 }, pageMeta: { title: "Tracker", textSample: "Manage <tasks>" } } as CrawlDocument;
  return createReviewInput(candidate, document, settings, { scan: null, observations: [] });
}
/** runner 가 받는 dispatch 모양 — 장부 없이 binding 만 진짜 schema 로 만든다 */
function dispatchFor(call: PreparedReviewCliCall, value = input()): CliModelDispatch {
  const binding: CliDispatchBinding = { kind: "ai1_legacy_cli", version: 1, logicalWorkKey: "ai1:41", candidateId: 41, attemptId: 7,
    inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, reviewPolicyHash: value.policyHash, promptVersion: "p", rulesVersion: "r",
    provider: call.provider, model: call.model, routeId: "crawl-agent-review", stageEpoch: 1, transport: call.transport,
    totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, job: { name: "crawl-agent-review", token: randomUUID(), requestedVersion: 1 } };
  return { requestId: randomUUID(), owner: { instanceId: "unit", bootId: randomUUID() }, token: randomUUID(), epoch: 1, revision: 1,
    policyHash: "f".repeat(64), binding, bindingHash: cliDispatchBindingHash(binding) } as CliModelDispatch;
}
async function prepared(provider: "claude-cli" | "grok-cli", timeoutMs: number, value = input()) {
  const call = await prepareReviewCliCall(value, { routeId: "crawl-agent-review", provider, model, timeoutMs });
  if (call.kind !== "prepared_cli") throw new Error("fixture_contract_required");
  return call;
}

it.skipIf(process.platform === "win32")("Claude: native 는 legacy reviewWithAgent 와 같은 argv·stdin·env·제한 시간으로 띄우고 같은 결과를 낸다", async () => {
  for (const [mode, timeoutMs] of [["ok", 20_000], ["fail", 20_000], ["empty", 20_000], ["hang", 300], ["flood", 20_000]] as const) {
    vi.stubEnv("FAKE_CLI_MODE", mode);
    const value = input(), legacy = await reviewWithAgent(value, { model, timeoutMs });
    const legacyRecords = await recorded(); await clear();
    const call = await prepared("claude-cli", timeoutMs, value), dispatch = dispatchFor(call, value);
    expect(call.transport).toMatchObject({ provider: "claude-cli", model, timeoutMs, maxStdoutBytes: 65_536, maxStderrBytes: 16_384 });
    const native = await reviewWithReservedCli(value, dispatch, call);
    const nativeRecords = await recorded(); await clear();
    expect(native.result, mode).toEqual(legacy);
    expect(nativeRecords.map(record => ({ ...record, pid: 0 })), mode).toEqual(legacyRecords.map(record => ({ ...record, pid: 0 })));
    expect(nativeRecords).toHaveLength(1);
    expect(nativeRecords[0]).toMatchObject({ argv: reviewCliArgs(model), realCliOnPath: false,
      env: { PATH: empty, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2000", CLAUDECODE: null } });
    expect(native.indeterminate).toBeNull();
    expect(readCliProcessTerminal(native.terminal)).toMatchObject({ requestId: dispatch.requestId, transport: call.transport,
      ending: mode === "hang" || mode === "flood" ? "killed" : "exited" });
  }
  // 정상 답은 legacy parser 를 거친 승인이다
  vi.stubEnv("FAKE_CLI_MODE", "ok");
  const call = await prepared("claude-cli", 20_000);
  expect((await reviewWithReservedCli(input(), dispatchFor(call), call)).result).toMatchObject({ ok: true, outcome: { decision: "approve" } });
  expect(await readdir(tmp)).toEqual([]);
}, PROCESS_TEST_MS * 2);

it.skipIf(process.platform === "win32")("Grok: native 는 legacy reviewWithGrokCli 와 임시 경로만 다르고 argv·prompt·agent 파일·env·결과가 같다", async () => {
  for (const mode of ["ok", "fail", "stderr-only"] as const) {
    vi.stubEnv("FAKE_CLI_MODE", mode);
    const value = input(), legacy = await reviewWithGrokCli(value, { model });
    const [legacyRecord] = await recorded(), legacyFiles = await captured(legacyRecord.pid); await clear();
    const call = await prepared("grok-cli", 90_000, value);
    const native = await reviewWithReservedCli(value, dispatchFor(call, value), call);
    const [nativeRecord] = await recorded(), nativeFiles = await captured(nativeRecord.pid); await clear();
    expect(native.result, mode).toEqual(legacy);
    const normalize = (argv: string[]) => argv.map(arg => arg.endsWith(`${path.sep}prompt.txt`) ? "<prompt-file>" : arg);
    expect(normalize(nativeRecord.argv)).toEqual(normalize(legacyRecord.argv));
    expect(normalize(nativeRecord.argv)).toEqual(normalize(grokReviewArgs(model, "/x/prompt.txt")));
    expect(nativeRecord.env).toEqual(legacyRecord.env);
    expect(nativeFiles.prompt).not.toBeNull(); expect(nativeFiles.agent).not.toBeNull();
    expect(nativeFiles).toEqual(legacyFiles);
    expect(call.transport.timeoutMs).toBe(90_000);
    expect(readCliProcessTerminal(native.terminal)).toMatchObject({ ending: "exited" });
  }
  vi.stubEnv("GROK_CLI", grokAnswer);
  const value = input(), legacy = await reviewWithGrokCli(value, { model }), call = await prepared("grok-cli", 90_000, value);
  const native = await reviewWithReservedCli(value, dispatchFor(call, value), call);
  expect(legacy).toMatchObject({ ok: true, outcome: { decision: "approve", confidence: 0.8 } });
  expect(native.result).toEqual(legacy);
  expect(readCliProcessTerminal(native.terminal)).toMatchObject({ ending: "exited", provenance: "cli_reported",
    actualUsage: { inputTokens: 40, outputTokens: 9, totalTokens: 49 } });
  expect(await readdir(tmp)).toEqual([]);
}, PROCESS_TEST_MS);

it("운영 resolver(null)·계약 밖 입력은 준비하지 않고 임시 디렉터리도 남기지 않는다", async () => {
  fixture.contracts = [];
  for (const provider of ["claude-cli", "grok-cli"] as const)
    expect(await prepareReviewCliCall(input(), { routeId: "crawl-agent-review", provider, model, timeoutMs: 20_000 }))
      .toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
  fixture.contracts = [claude("crawl-agent-review")];
  for (const change of [{ model: "bad model" }, { routeId: "product-audit" as "second-review" }, { provider: "abcllm" as "grok-cli" }, { timeoutMs: Number.NaN }])
    expect(await prepareReviewCliCall(input(), { routeId: "crawl-agent-review", provider: "claude-cli", model, timeoutMs: 20_000, ...change }))
      .toMatchObject({ kind: "unsupported" });
  // 제한 시간은 legacy 상한을 넘지 못한다
  const longer = await prepared("claude-cli", 60_000);
  expect(longer.transport.timeoutMs).toBe(20_000);
  await releaseReviewCliCall(longer); await releaseReviewCliCall(longer);
  expect(await readdir(tmp)).toEqual([]);
});

it.skipIf(process.platform === "win32")("spawn 전 포기: settle 은 not_started 로 닫고 spawn 0, 같은 호출의 재실행·다른 dispatch 는 거절한다", async () => {
  vi.stubEnv("FAKE_CLI_MODE", "ok");
  const call = await prepared("claude-cli", 20_000), dispatch = dispatchFor(call);
  await expect(settleReviewCliNotStarted(call, { ...dispatch, binding: { ...dispatch.binding, model: "other" } } as CliModelDispatch))
    .rejects.toThrow("review_cli_call_mismatch");
  const terminal = await settleReviewCliNotStarted(call, dispatch);
  expect(readCliProcessTerminal(terminal)).toMatchObject({ ending: "not_started", requestId: dispatch.requestId, transport: call.transport });
  await expect(reviewWithReservedCli(input(), dispatch, call)).rejects.toThrow("review_cli_call_mismatch");
  expect(await settleReviewCliNotStarted(call, dispatch)).toBeNull();
  // 이미 abort 된 신호는 runner 가 spawn 하지 않고 not_started 로 닫는다(legacy 결과 cancelled)
  const aborted = new AbortController(); aborted.abort();
  const next = await prepared("grok-cli", 90_000), outcome = await reviewWithReservedCli(input(), dispatchFor(next), next, { signal: aborted.signal });
  expect(outcome.result).toEqual({ ok: false, error: "cancelled" });
  expect(readCliProcessTerminal(outcome.terminal)).toMatchObject({ ending: "not_started" });
  // 다른 입력으로 만든 dispatch·다른 입력으로 부른 실행은 spawn 하지 않는다
  const other = await prepared("claude-cli", 20_000), changed = input();
  changed.snapshot.product.name = "changed";
  await expect(reviewWithReservedCli(changed, dispatchFor(other), other)).rejects.toThrow("review_cli_call_mismatch");
  expect(await recorded()).toEqual([]);
  await releaseReviewCliCall(other);
  expect(await readdir(tmp)).toEqual([]);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("pipe 쥔 손자: terminal 없이 process_exit 이고 출력은 버린다(cli_error)", async () => {
  vi.stubEnv("FAKE_CLI_MODE", "grandchild-hold");
  const call = await prepared("claude-cli", 10_000), outcome = await reviewWithReservedCli(input(), dispatchFor(call), call);
  const [child] = await recorded();
  try {
    expect(outcome).toEqual({ result: { ok: false, error: "cli_error" }, terminal: null, indeterminate: "process_exit" });
  } finally { if (child?.grandchild) try { process.kill(child.grandchild, "SIGKILL"); } catch { /* already gone */ } }
  expect(await readdir(tmp)).toEqual([]);
}, PROCESS_TEST_MS);
