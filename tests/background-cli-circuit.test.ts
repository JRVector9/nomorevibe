import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ReviewCliResult } from "@/lib/crawl/agent-review";
import type { JobContext } from "@/lib/jobs/runner";
import { cliDispatchBindingHash, type CliDispatchBinding, type IntroCheckMember } from "@/lib/llm/capacity";
import { claudeCliTokenBound, type CliServingContract } from "@/lib/llm/cli-serving-contract";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { checkProductIntros } from "@/lib/jobs/products/intro-check";
import { INTRO_CHECK_MODEL } from "@/lib/domain/products/intro-check";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { withSlotOnlyModelCapacity } from "@/lib/llm/capacity-consumer-scope";
import { createProviderCircuits, withProviderOutcome, type ProviderCircuits } from "@/lib/llm/provider-circuit-breaker";
import { runWorker, type BackgroundConsumerLanes } from "@/scripts/worker";

/*
 * PR06f 배경 CLI 줄(소개 검수·Claude 감사)의 provider 회로 — 두 job 의 기존 STOP/REVIEWER_DOWN 판정 지점이 CLI 결과를 그 줄의 회로에 알린다.
 * 장부(capacity-repository)·DB 핸들·도메인 잠금/기록만 바꾸고, runner 는 가짜 CLI(tests/fixtures/fake-cli/background.mjs)를 자식으로 띄운다.
 * 실제 claude/grok 은 부르지 않는다(자식 PATH 는 빈 디렉터리). 실제 DB·runJob 은 tests/integration/background-cli-circuit.test.ts 가 본다.
 */
const mocks = vi.hoisted(() => ({ contracts: [] as CliServingContract[], read: vi.fn(), pending: vi.fn(), request: vi.fn(), lock: vi.fn(),
  finish: vi.fn(), reconcile: vi.fn(), indeterminate: vi.fn(), cancel: vi.fn(), wall: vi.fn(), pendingIntro: vi.fn(), recordIntro: vi.fn(),
  introMembers: vi.fn(), settings: vi.fn(), campaign: vi.fn(), candidates: vi.fn(), pendingAudit: vi.fn(), input: vi.fn(), recordAudit: vi.fn(),
  noSource: vi.fn(), finishCampaign: vi.fn(), auditItem: vi.fn(), gateway: vi.fn(), tx: { fixture: "tx" } }));
vi.mock("@/lib/llm/cli-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/cli-serving-contract")>(),
  resolveCliServingContract: (routeId: string, provider: string, model: string) =>
    mocks.contracts.find(value => value.routeId === routeId && value.provider === provider && value.model === model) ?? null,
}));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: mocks.read, findOwnPendingModelRequest: mocks.pending,
  requestCliModelSlot: mocks.request, lockCliModelCapacityDispatch: mocks.lock, finishCliModelCapacityDispatch: mocks.finish,
  reconcileCliProcessTerminal: mocks.reconcile, markModelDispatchIndeterminate: mocks.indeterminate, cancelReservedModelSlot: mocks.cancel }));
vi.mock("@/lib/db", () => ({ db: { transaction: async (load: (tx: unknown) => unknown) => load(mocks.tx) }, onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/jobs/control", async original => ({ ...await original<typeof import("@/lib/jobs/control")>(), assertJobLeaseAtWallTime: mocks.wall }));
vi.mock("@/lib/domain/products/intro-checks", () => ({ pendingIntroChecks: mocks.pendingIntro, recordIntroCheck: mocks.recordIntro,
  lockIntroCheckMembers: mocks.introMembers }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/crawl/agent-review-repository", () => ({ listReviewCandidates: mocks.candidates }));
// 감사 보류 쓸기는 DB 를 쓴다 — 이 테스트는 모델 호출만 본다(tests/integration/product-audit-hold.test.ts 가 쓸기를 본다)
vi.mock("@/lib/crawl/product-audit-hold", () => ({ sweepAuditHolds: async () => 0 }));
// Qwen-v2 단계(gpu3090 직접 호출)는 DB·네트워크를 쓴다 — tests/product-audit-job.test.ts 가 감사 묻기와의 관계를 본다
vi.mock("@/lib/crawl/audit-second-opinion-auto", () => ({ runQwenSecondOpinions: async () => null }));
vi.mock("@/lib/crawl/product-audit", () => ({ runningAuditCampaign: mocks.campaign, pendingAuditItems: mocks.pendingAudit, loadAuditInput: mocks.input,
  recordAuditResult: mocks.recordAudit, markAuditNoSource: mocks.noSource, finishAuditCampaign: mocks.finishCampaign, lockAuditDispatchItem: mocks.auditItem }));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({ reviewWithGateway: mocks.gateway, REVIEW_GATEWAY_TIMEOUT_MS: 60_000 }));

type Raw = Record<string, unknown>;
type Name = "product-intro-check" | "product-audit";
const AUDIT_MODEL = "sonnet", INSTANCE = "m3-reviewer", PROCESS_TEST_MS = 30_000;
const derived = (routeId: string, model: string, outputTokensPerTurn: number, costBoundUsdMicros: number): CliServingContract => {
  const shape = { maxTurns: 2, inputByteCap: 200_000, overheadTokenBound: 20_000, outputTokensPerTurn };
  return { version: 1, protocol: "cli-process-v1", routeId, provider: "claude-cli", model, cliVersion: "fake 0.0.0",
    totalTokenBound: claudeCliTokenBound(shape), costBoundUsdMicros, boundProvenance: "derived", ...shape };
};
const CONTRACTS = [derived("product-intro-check", INTRO_CHECK_MODEL, 8_000, 1_000_000), derived("product-audit", AUDIT_MODEL, 2_000, 150_000)];
const ROUTES = [{ routeId: "product-intro-check", provider: "claude-cli", model: INTRO_CHECK_MODEL },
  { routeId: "product-audit", provider: "claude-cli", model: AUDIT_MODEL }];
const control = (mode: string) => ({ mode, epoch: 1, revision: 1, policyHash: "a".repeat(64), policy: { routes: ROUTES } });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let root = "", bin = "", empty = "", records = "", bootId = "", serial = 0;

async function recorded(): Promise<Raw[]> {
  return Promise.all((await readdir(records)).map(async name => JSON.parse(await readFile(path.join(records, name), "utf8")) as Raw));
}
const fake = (mode: string) => { vi.stubEnv("FAKE_CLI_MODE", mode); };
const context = (name: string, token: string = randomUUID()): JobContext<null> => ({ cursor: null, save: vi.fn(), hasBudget: () => true,
  deadlineAt: Date.now() + 70_000, log: vi.fn(), lease: { name, token, requestedVersion: 3 } });
const product = (id: number) => ({ id, slug: `app-${id}`, name: `App ${id}`, url: `https://app-${id}.test`, tagline: "Plan meals for the week",
  taglineSource: "ai_page" as const, description: "Meal planner", status: "seeded" as const, searchTopics: null, searchPageText: `App ${id} page`, searchReadme: null });
const introTask = (id: number) => ({ product: product(id), check: null });
const member = (id: number): IntroCheckMember => ({ productId: id, slug: `app-${id}`, sourceHash: sha(`source-${id}`), taglineSource: "ai_page",
  check: { kind: "absent" } });
const auditInput = { snapshot: { product: { url: "https://app.test", name: "app", pageText: "A usable app" }, evidence: [],
  policy: { enforceEligibility: false }, evidenceSummary: { eligible: true } }, inputHash: sha("audit-input"), policyHash: sha("policy"),
sourceRevisionHash: sha("source"), source: {}, validUntil: new Date(Date.now() + 60_000) } as unknown as ReviewInput;
const reservation = () => ({ requestId: randomUUID(), owner: { instanceId: INSTANCE, bootId }, token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64) });

/** 배경 consumer 줄 하나(runWorker 의 실제 runConsumerLane). 틱은 실제 job 함수를 슬롯 전용 범위 안에서 돌린다(backgroundConsumerLanes 와 같다) */
function consumerLane(names: Name[], circuits: ProviderCircuits) {
  const logs: Raw[] = [];
  const consumer: BackgroundConsumerLanes = { names, open: async () => true, circuits, request: async () => {},
    run: name => withSlotOnlyModelCapacity(async () => {
      const outcome = name === "product-audit" ? await auditPublishedProducts(context(name)) : await checkProductIntros(context(name));
      return { status: "completed", done: outcome.done };
    }) };
  const tick = () => runWorker({ role: "reviewer", once: true }, { names, seen: async () => {}, pending: async () => names,
    run: async () => { throw new Error("legacy_lane_unused"); }, consumer, log: (event, fields) => { logs.push({ event, ...fields }); } });
  return { logs, tick };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nmv-bg-cli-circuit-"));
  empty = path.join(root, "empty-path"); records = path.join(root, "records");
  await mkdir(empty); await mkdir(records);
  const script = path.resolve("tests/fixtures/fake-cli/background.mjs");
  for (const value of [root, script, process.execPath]) expect(value).not.toContain("'");
  bin = path.join(root, "fake-cli");
  await writeFile(bin, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`); await chmod(bin, 0o755);
});
afterAll(() => rm(root, { recursive: true, force: true }));
beforeEach(async () => {
  vi.resetAllMocks();
  for (const name of await readdir(records)) await rm(path.join(records, name));
  bootId = randomUUID();
  mocks.contracts = CONTRACTS;
  for (const [key, value] of Object.entries({ PATH: empty, CLAUDE_CLI: bin, FAKE_CLI_RECORD: records, CLAUDECODE: "1", SERVICE_INSTANCE_ID: INSTANCE,
    ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: INSTANCE, ROLE_LEASE_BOOT_ID: bootId, ROLE_LEASE_RELEASE: "fixture", ROLE_LEASE_EPOCH: "1" }))
    vi.stubEnv(key, value);
  mocks.read.mockResolvedValue(control("open"));
  mocks.pending.mockResolvedValue(null);
  mocks.request.mockImplementation(async () => ({ kind: "granted", reservation: reservation() }));
  mocks.lock.mockResolvedValue(Object.freeze({ control: control("open") }));
  mocks.finish.mockImplementation(async (_tx: unknown, _lock: unknown, binding: CliDispatchBinding) => ({ ...reservation(), binding,
    bindingHash: cliDispatchBindingHash(binding) }));
  mocks.reconcile.mockResolvedValue({ kind: "settled" });
  mocks.indeterminate.mockResolvedValue(true);
  mocks.cancel.mockResolvedValue(true);
  mocks.pendingIntro.mockResolvedValue([]);
  mocks.recordIntro.mockResolvedValue("failed");
  mocks.introMembers.mockImplementation(async (_tx: unknown, tasks: ReturnType<typeof introTask>[]) => tasks.map(task => member(task.product.id)));
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewConcurrency: 1 });
  mocks.campaign.mockResolvedValue({ id: 4, provider: "claude-cli", model: AUDIT_MODEL, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION });
  mocks.candidates.mockResolvedValue([]);
  // 감사 job 이 받은 배열을 shift 로 비운다 — 틱마다 새 배열
  mocks.pendingAudit.mockImplementation(async () => [{ id: 7, slug: "app" }]);
  mocks.input.mockResolvedValue(auditInput);
  mocks.auditItem.mockResolvedValue({ productId: 70, attempts: 1 });
});
afterEach(() => { vi.unstubAllEnvs(); });

it("audit: consecutive REVIEWER_DOWN in the consumer lane opens its circuit, the open tick claims nothing, and a passing half-open trial closes it", async () => {
  const clock = { now: 0 }, events: Raw[] = [];
  const circuits = createProviderCircuits({ mode: "enabled", failures: 2, openMs: 30_000 }, { now: () => clock.now,
    log: (event, fields) => events.push({ event, ...fields }) });
  const { logs, tick } = consumerLane(["product-audit"], circuits);
  // 없는 CLI(ENOENT) — 기존 REVIEWER_DOWN(missing_cli)
  vi.stubEnv("CLAUDE_CLI", path.join(root, "absent-cli"));
  await tick();
  expect(events).toEqual([]);
  await tick();
  expect(events).toEqual([{ event: "provider_circuit.opened", key: "product-audit", failures: 2, error: "missing_cli", openMs: 30_000 }]);
  // 기존 동작 그대로: 세지 않는 시도 기록, 심사자 없음으로 틱 실패
  expect(mocks.recordAudit.mock.calls.map(([call]) => [call.ok, call.error, call.counted])).toEqual([[false, "missing_cli", false], [false, "missing_cli", false]]);
  expect(logs.map(row => row.status)).toEqual(["failed", "failed"]);

  const calls = () => [mocks.campaign, mocks.settings, mocks.pendingAudit, mocks.input, mocks.request, mocks.finish, mocks.recordAudit]
    .map(mock => mock.mock.calls.length);
  const before = calls();
  logs.length = 0;
  await tick();
  expect(logs).toEqual([{ event: "worker.job", role: "reviewer", name: "product-audit", status: "deferred", reason: "provider_circuit_open", consumer: true }]);
  expect(calls()).toEqual(before);
  expect(await recorded()).toEqual([]);

  clock.now = 30_000; vi.stubEnv("CLAUDE_CLI", bin); fake("ok");
  logs.length = 0;
  await tick();
  expect(events.map(row => row.event)).toEqual(["provider_circuit.opened", "provider_circuit.half_open", "provider_circuit.closed"]);
  expect(mocks.recordAudit.mock.calls.at(-1)?.[0]).toMatchObject({ itemId: 7, ok: true, outcome: { decision: "approve" } });
  expect(logs).toEqual([{ event: "worker.job", role: "reviewer", name: "product-audit", status: "completed", consumer: true }]);
  expect(await recorded()).toHaveLength(1);
}, PROCESS_TEST_MS);

it("intro: judgment errors never count, consecutive STOP failures open, a trial without a verdict hands over to the next tick, and a passing one closes", async () => {
  const clock = { now: 0 }, events: string[] = [];
  const circuits = createProviderCircuits({ mode: "enabled", failures: 2, openMs: 30_000 }, { now: () => clock.now, log: event => events.push(event) });
  const { logs, tick } = consumerLane(["product-intro-check"], circuits);
  const batch = (mode: string) => { fake(mode); mocks.pendingIntro.mockResolvedValueOnce([introTask(++serial)]); };
  // 빈 출력(invalid_output)은 판정 오류다 — 몇 번이든 세지 않는다
  for (let index = 0; index < 3; index++) { batch("empty"); await tick(); }
  expect(events).toEqual([]);
  // 한도 실패(rate_limited)는 기존 STOP 그대로 틱을 접고, 연속 둘에 연다
  batch("fail"); await tick();
  batch("fail"); await tick();
  expect(events).toEqual(["provider_circuit.opened"]);
  expect(mocks.recordIntro.mock.calls.map(([, , outcome]) => outcome.error)).toEqual(["invalid_output", "invalid_output", "invalid_output", "rate_limited", "rate_limited"]);
  expect(await recorded()).toHaveLength(5);

  const calls = () => [mocks.pendingIntro, mocks.request, mocks.finish, mocks.recordIntro].map(mock => mock.mock.calls.length);
  const before = calls();
  logs.length = 0;
  await tick();
  expect(logs).toEqual([{ event: "worker.job", role: "reviewer", name: "product-intro-check", status: "deferred", reason: "provider_circuit_open",
    consumer: true }]);
  expect(calls()).toEqual(before);
  expect(await recorded()).toHaveLength(5);

  clock.now = 30_000;
  batch("empty"); await tick();
  // 판정 오류로 끝난 시험은 닫지도 다시 열지도 않는다 — 다음 틱이 다시 시험이다
  expect(events).toEqual(["provider_circuit.opened", "provider_circuit.half_open"]);
  batch("intro-ok"); await tick();
  expect(events).toEqual(["provider_circuit.opened", "provider_circuit.half_open", "provider_circuit.closed"]);
  expect(mocks.recordIntro.mock.calls.at(-1)?.[2]).toMatchObject({ kind: "success", judgement: { verdict: "ok" } });
  expect(await recorded()).toHaveLength(7);
}, PROCESS_TEST_MS);

const exit = (code: number, change: Raw): ReviewCliResult => ({ kind: "exit", code, stderr: "", stdout: JSON.stringify({ type: "result",
  subtype: "error_during_execution", is_error: true, result: "", ...change }) });
it.each<[string, ReviewCliResult, boolean]>([
  ["timeout", { kind: "timeout" }, true],
  ["missing_cli", { kind: "missing_cli" }, true],
  ["rate_limited", exit(1, { result: "API Error: 429 rate_limit_error" }), true],
  ["auth", exit(1, { result: "Not logged in · Please run /login" }), true],
  ["budget", exit(1, { subtype: "error_max_budget_usd" }), true],
  ["max_turns", exit(1, { subtype: "error_max_turns" }), false],
  ["invalid_output", { kind: "exit", code: 0, stdout: "", stderr: "" }, false],
  ["cli_error", { kind: "cli_error" }, false],
  ["cancelled", { kind: "cancelled" }, false],
  ["output_too_large", { kind: "output_too_large" }, false],
])("intro: a CLI %s result counts toward the circuit: %s", async (error, result, counts) => {
  const events: Raw[] = [];
  const circuits = createProviderCircuits({ mode: "enabled", failures: 1, openMs: 30_000 }, { log: (event, fields) => events.push({ event, ...fields }) });
  mocks.read.mockResolvedValue(control("disabled"));
  mocks.pendingIntro.mockResolvedValueOnce([introTask(1)]);
  const admission = circuits.admit("product-intro-check");
  if (!admission.admitted) throw new Error("fixture_circuit_closed");
  await withProviderOutcome(admission.record, () => checkProductIntros(context("product-intro-check"), async () => result));
  admission.done();
  expect(mocks.recordIntro.mock.calls.map(([, , outcome]) => outcome.error)).toEqual([error]);
  expect(events).toEqual(counts ? [{ event: "provider_circuit.opened", key: "product-intro-check", failures: 1, error, openMs: 30_000 }] : []);
});

it("audit: a gateway (abcllm) campaign's result is not reported again — its transport step already reports it", async () => {
  mocks.read.mockResolvedValue(control("disabled"));
  mocks.campaign.mockResolvedValue({ id: 4, provider: "abcllm", model: "[MLX] gpt-oss-120b", promptVersion: REVIEW_PROMPT_VERSION,
    rulesVersion: REVIEW_RULES_VERSION });
  mocks.gateway.mockResolvedValue({ ok: false, error: "gateway_error" });
  const seen: unknown[] = [];
  expect(await withProviderOutcome(result => seen.push(result), () => auditPublishedProducts(context("product-audit")))).toEqual({ done: false });
  expect(mocks.recordAudit.mock.calls.map(([call]) => [call.provider, call.error, call.counted])).toEqual([["abcllm", "gateway_error", true]]);
  expect(seen).toEqual([]);
});

it("outside the consumer lane nothing is reported: a failing legacy lane beside a consumer lane leaves that circuit closed", async () => {
  const events: string[] = [], logs: Raw[] = [];
  const circuits = createProviderCircuits({ mode: "enabled", failures: 1, openMs: 30_000 }, { log: event => events.push(event) });
  fake("fail");
  // 소비 줄(소개 검수)의 틱이 범위 안에서 기다리는 동안 기존 줄(감사)이 같은 프로세스에서 한도 실패를 낸다
  let audited!: () => void;
  const auditRecorded = new Promise<void>(resolve => { audited = resolve; });
  mocks.recordAudit.mockImplementation(async () => { audited(); });
  mocks.pendingIntro.mockImplementation(async () => { await auditRecorded; return []; });
  const consumer: BackgroundConsumerLanes = { names: ["product-intro-check"], open: async () => true, circuits, request: async () => {},
    run: name => withSlotOnlyModelCapacity(async () => ({ status: "completed", done: (await checkProductIntros(context(name))).done })) };
  await runWorker({ role: "reviewer", once: true }, { names: ["product-audit", "product-intro-check"], seen: async () => {},
    pending: async () => ["product-audit", "product-intro-check"], consumer, log: (event, fields) => { logs.push({ event, ...fields }); },
    run: async name => ({ status: "completed", done: (await auditPublishedProducts(context(name))).done }) });
  expect(mocks.recordAudit.mock.calls.map(([call]) => [call.ok, call.error, call.counted])).toEqual([[false, "rate_limited", true]]);
  expect(logs).toEqual(expect.arrayContaining([{ event: "worker.job", role: "reviewer", name: "product-audit", status: "completed" },
    { event: "worker.job", role: "reviewer", name: "product-intro-check", status: "completed", consumer: true }]));
  expect(events).toEqual([]);
  // 같은 실패가 소비 줄 안에서 나면 연다 — 위 결과가 범위 덕분임을 보인다
  await consumerLane(["product-audit"], circuits).tick();
  expect(events).toEqual(["provider_circuit.opened"]);
}, PROCESS_TEST_MS);

it("the job's return, logs and records are identical with and without a consumer scope (legacy CLI path)", async () => {
  mocks.read.mockResolvedValue(control("disabled"));
  fake("fail");
  const run = async (name: Name, scope: ((result: unknown) => void) | null) => {
    if (name === "product-intro-check") mocks.pendingIntro.mockResolvedValueOnce([introTask(1)]);
    const records = name === "product-audit" ? mocks.recordAudit : mocks.recordIntro, from = records.mock.calls.length;
    const ctx = context(name, "same-lease");
    const work = () => name === "product-audit" ? auditPublishedProducts(ctx) : checkProductIntros(ctx);
    const returned = await (scope ? withProviderOutcome(scope, work) : work());
    return JSON.stringify({ returned, logs: vi.mocked(ctx.log).mock.calls,
      records: records.mock.calls.slice(from).map(([call, ...rest]) => [{ ...call, startedAt: call.startedAt ? "started" : undefined }, ...rest]) });
  };
  for (const name of ["product-audit", "product-intro-check"] as const) {
    const seen: unknown[] = [];
    const outside = await run(name, null);
    const inside = await run(name, result => seen.push(result));
    expect(inside).toBe(outside);
    expect(seen).toEqual([expect.objectContaining({ ok: false, error: "rate_limited" })]);
  }
}, PROCESS_TEST_MS);
