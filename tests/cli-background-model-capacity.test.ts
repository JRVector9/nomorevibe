import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { cliDispatchBindingHash, grokSessionInputHash, grokSessionLogicalWorkKey, introCheckInputHash, introCheckLogicalWorkKey,
  type CliDispatchBinding, type IntroCheckMember } from "@/lib/llm/capacity";
import { claudeCliTokenBound, type CliServingContract } from "@/lib/llm/cli-serving-contract";
import { readCliProcessTerminal } from "@/lib/llm/cli-process-runner";
import { reviewCliArgs, runReviewCli } from "@/lib/crawl/agent-review";
import type { ReviewInput } from "@/lib/crawl/agent-review-contract";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { checkProductIntros } from "@/lib/jobs/products/intro-check";
import { INTRO_CHECK_MODEL, introCheckCliArgs, introEvidence } from "@/lib/domain/products/intro-check";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { checkGrokSession, grokSessionArgs } from "@/lib/crawl/jobs/grok-session";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

/*
 * 05c-5 — 소개 검수·Claude 감사·Grok 세션 점검이 공통 모델 슬롯을 실제로 거치는지. 장부(capacity-repository)·DB 핸들·도메인 잠금/기록만
 * 바꾸고, runner 는 진짜로 가짜 CLI(tests/fixtures/fake-cli/background.mjs)를 자식 프로세스로 띄운다. 자식 PATH 는 빈 디렉터리다.
 * 실제 장부·잠금·runJob 은 tests/integration/cli-background-model-capacity.test.ts 가 본다.
 */
const mocks = vi.hoisted(() => ({ contracts: [] as CliServingContract[], read: vi.fn(), pending: vi.fn(), request: vi.fn(), lock: vi.fn(),
  finish: vi.fn(), reconcile: vi.fn(), indeterminate: vi.fn(), cancel: vi.fn(), wall: vi.fn(), pendingIntro: vi.fn(), recordIntro: vi.fn(),
  introMembers: vi.fn(), settings: vi.fn(), campaign: vi.fn(), candidates: vi.fn(), pendingAudit: vi.fn(), input: vi.fn(), recordAudit: vi.fn(),
  noSource: vi.fn(), finishCampaign: vi.fn(), auditItem: vi.fn(), observe: vi.fn(), tx: { fixture: "tx" } }));
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
vi.mock("@/lib/operations/observations", () => ({ observe: mocks.observe }));

const GROK_MODEL = "grok-4.7", AUDIT_MODEL = "sonnet", INSTANCE = "m3-reviewer", PROCESS_TEST_MS = 20_000;
const derived = (routeId: string, model: string, outputTokensPerTurn: number, costBoundUsdMicros: number): CliServingContract => {
  const shape = { maxTurns: 2, inputByteCap: 200_000, overheadTokenBound: 20_000, outputTokensPerTurn };
  return { version: 1, protocol: "cli-process-v1", routeId, provider: "claude-cli", model, cliVersion: "fake 0.0.0",
    totalTokenBound: claudeCliTokenBound(shape), costBoundUsdMicros, boundProvenance: "derived", ...shape };
};
const CONTRACTS: CliServingContract[] = [derived("product-intro-check", INTRO_CHECK_MODEL, 8_000, 1_000_000),
  derived("product-audit", AUDIT_MODEL, 2_000, 150_000),
  { version: 1, protocol: "cli-process-v1", routeId: "grok-session-check", provider: "grok-cli", model: GROK_MODEL, cliVersion: "fake 0.0.0",
    inputByteCap: 200_000, totalTokenBound: 300_000, costBoundUsdMicros: null, boundProvenance: "declared" }];
const ROUTES = [{ routeId: "product-intro-check", provider: "claude-cli", model: INTRO_CHECK_MODEL },
  { routeId: "product-audit", provider: "claude-cli", model: AUDIT_MODEL }, { routeId: "grok-session-check", provider: "grok-cli", model: GROK_MODEL }];
const control = (mode: string) => ({ mode, epoch: 1, revision: 1, policyHash: "a".repeat(64), policy: { routes: ROUTES } });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const settle = (work: Promise<unknown>) => work.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
let root = "", bin = "", empty = "", records = "", bootId = "";

type Recorded = { mode: string; pid: number; argv: string[]; env: Record<string, string | null>; realCliOnPath: boolean; stdin?: string; grandchild?: number };
async function recorded(): Promise<Recorded[]> {
  return Promise.all((await readdir(records)).map(async name => JSON.parse(await readFile(path.join(records, name), "utf8")) as Recorded));
}
async function clearRecords() { for (const name of await readdir(records)) await rm(path.join(records, name)); }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
/** 테스트가 남긴 손자를 지우고 ESRCH 까지 확인한다 */
async function reap(pids: (number | undefined)[]) {
  for (const pid of pids) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  for (const pid of pids) if (pid) { for (let i = 0; i < 300 && alive(pid); i++) await sleep(10); expect(alive(pid)).toBe(false); }
}
const fake = (mode: string) => { vi.stubEnv("FAKE_CLI_MODE", mode); };
const context = (name: string, over: Partial<JobContext<null>> = {}): JobContext<null> => ({ cursor: null, save: vi.fn(), hasBudget: () => true,
  deadlineAt: Date.now() + 70_000, log: vi.fn(), lease: { name, token: randomUUID(), requestedVersion: 3 }, ...over });
const product = (id: number) => ({ id, slug: `app-${id}`, name: `App ${id}`, url: `https://app-${id}.test`, tagline: "Plan meals for the week",
  taglineSource: "ai_page" as const, description: "Meal planner", status: "seeded" as const, searchTopics: null, searchPageText: `App ${id} page`, searchReadme: null });
const introTask = (id: number) => ({ product: product(id), check: null });
const member = (id: number): IntroCheckMember => ({ productId: id, slug: `app-${id}`, sourceHash: sha(`source-${id}`), taglineSource: "ai_page",
  check: { kind: "absent" } });
const introStdin = (tasks: ReturnType<typeof introTask>[]) => `<untrusted_evidence_json>\n${JSON.stringify(tasks.map(task => ({ slug: task.product.slug,
  intro: task.product.tagline, evidence: introEvidence(task.product) }))).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}\n</untrusted_evidence_json>`;
const auditInput = { snapshot: { product: { url: "https://app.test", name: "app", pageText: "A usable <app>" }, evidence: [],
  policy: { enforceEligibility: false }, evidenceSummary: { eligible: true } }, inputHash: sha("audit-input"), policyHash: sha("policy"),
sourceRevisionHash: sha("source"), source: {}, validUntil: new Date(Date.now() + 60_000) } as unknown as ReviewInput;
const campaign = () => ({ id: 4, provider: "claude-cli", model: AUDIT_MODEL, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION });
const reservation = () => ({ requestId: randomUUID(), owner: { instanceId: INSTANCE, bootId }, token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64) });
const finishedBinding = (): CliDispatchBinding => mocks.finish.mock.calls[0][2];
const terminalEvidence = () => readCliProcessTerminal(mocks.reconcile.mock.calls[0][0]);

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nmv-cli-background-"));
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
  await clearRecords();
  bootId = randomUUID();
  mocks.contracts = CONTRACTS;
  for (const [key, value] of Object.entries({ PATH: empty, CLAUDE_CLI: bin, GROK_CLI: bin, FAKE_CLI_RECORD: records, CLAUDECODE: "1",
    SERVICE_INSTANCE_ID: INSTANCE, GROK_AUTH_PATH: "/nonexistent/auth.json", ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: INSTANCE,
    ROLE_LEASE_BOOT_ID: bootId, ROLE_LEASE_RELEASE: "fixture", ROLE_LEASE_EPOCH: "1" })) vi.stubEnv(key, value);
  mocks.read.mockResolvedValue(control("open"));
  mocks.pending.mockResolvedValue(null);
  mocks.request.mockImplementation(async () => ({ kind: "granted", reservation: reservation() }));
  mocks.lock.mockResolvedValue(Object.freeze({ control: control("open") }));
  mocks.finish.mockImplementation(async (_tx: unknown, _lock: unknown, binding: CliDispatchBinding) => ({ ...reservation(), binding,
    bindingHash: cliDispatchBindingHash(binding) }));
  mocks.reconcile.mockResolvedValue({ kind: "settled" });
  mocks.indeterminate.mockResolvedValue(true);
  mocks.cancel.mockResolvedValue(true);
  mocks.recordIntro.mockResolvedValue("kept");
  mocks.introMembers.mockImplementation(async (_tx: unknown, tasks: ReturnType<typeof introTask>[]) => tasks.map(task => member(task.product.id)));
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewConcurrency: 1,
    secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "grok-cli", model: GROK_MODEL }] } });
  mocks.campaign.mockResolvedValue(campaign());
  mocks.candidates.mockResolvedValue([]);
  mocks.pendingAudit.mockResolvedValue([{ id: 7, slug: "app" }]);
  mocks.input.mockResolvedValue(auditInput);
  mocks.auditItem.mockResolvedValue({ productId: 70, attempts: 1 });
});
afterEach(() => { vi.unstubAllEnvs(); });

it("intro: open with a contract takes a background slot, runs the fake CLI once with the legacy argv/stdin/env, settles, then records", async () => {
  fake("intro-ok");
  const tasks = [introTask(2), introTask(1)];
  mocks.pendingIntro.mockResolvedValueOnce(tasks).mockResolvedValue([]);
  const ctx = context("product-intro-check");

  expect(await checkProductIntros(ctx)).toEqual({ done: true });

  const members = [member(2), member(1)], logical = introCheckLogicalWorkKey(members), inputHash = introCheckInputHash({ members, model: INTRO_CHECK_MODEL });
  expect(mocks.request.mock.calls).toEqual([[{ requestId: expect.any(String), owner: { instanceId: INSTANCE, bootId }, class: "background",
    pool: "reviewer", routeId: "product-intro-check", provider: "claude-cli", model: INTRO_CHECK_MODEL, workKey: `${logical}:${inputHash}` },
  { kind: "intro", members }]]);
  expect(mocks.introMembers).toHaveBeenCalledTimes(2);
  expect(mocks.introMembers.mock.calls[1][0]).toBe(mocks.tx);
  expect(mocks.wall).toHaveBeenCalledWith(mocks.tx, ctx.lease, "update");
  expect(finishedBinding()).toMatchObject({ kind: "intro_check_cli", version: 1, members, model: INTRO_CHECK_MODEL, logicalWorkKey: logical, inputHash,
    provider: "claude-cli", routeId: "product-intro-check", job: ctx.lease, transport: { provider: "claude-cli", model: INTRO_CHECK_MODEL, timeoutMs: 90_000 } });
  expect(terminalEvidence()).toMatchObject({ ending: "exited", exitCode: 0, signal: null, provenance: "cli_reported",
    transport: finishedBinding().transport, requestId: (await mocks.finish.mock.results[0].value).requestId });
  expect(mocks.indeterminate).not.toHaveBeenCalled();
  expect(mocks.cancel).not.toHaveBeenCalled();
  // 물리 종료 정산이 업무 기록보다 먼저다
  expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(mocks.recordIntro.mock.invocationCallOrder[0]);
  expect(mocks.recordIntro.mock.calls).toEqual(tasks.map(task => [task, ctx.lease,
    { kind: "success", judgement: { verdict: "ok", problem: "", corrected: "" }, model: INTRO_CHECK_MODEL }]));
  const [native, ...extra] = await recorded();
  expect(extra).toEqual([]);
  expect(native).toMatchObject({ mode: "intro-ok", argv: introCheckCliArgs(INTRO_CHECK_MODEL), realCliOnPath: false,
    env: { PATH: empty, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000", CLAUDECODE: null } });
  expect(Buffer.from(native.stdin!, "base64").toString("utf8")).toBe(introStdin(tasks));
  // legacy runReviewCli 에 같은 argv·stdin·출력 상한을 주면 자식이 받는 것이 byte 단위로 같다
  await clearRecords();
  await runReviewCli(introCheckCliArgs(INTRO_CHECK_MODEL), introStdin(tasks), { timeoutMs: 90_000, maxOutputTokens: 8_000 });
  const [legacy] = await recorded();
  expect({ ...legacy, pid: 0 }).toEqual({ ...native, pid: 0 });
}, PROCESS_TEST_MS);

it("intro: open with no CLI contract (production resolver) still defers before any ledger call, spawn or record", async () => {
  mocks.contracts = [];
  mocks.pendingIntro.mockResolvedValueOnce([introTask(1)]).mockResolvedValue([]);
  const outcome = await settle(checkProductIntros(context("product-intro-check")));
  expect(outcome.error).toBeInstanceOf(ModelCapacityDeferredError);
  expect(outcome.error).toMatchObject({ reason: "provider_contract_unavailable" });
  for (const ledger of [mocks.pending, mocks.request, mocks.lock, mocks.finish, mocks.reconcile, mocks.indeterminate, mocks.cancel, mocks.introMembers])
    expect(ledger).not.toHaveBeenCalled();
  expect(mocks.recordIntro).not.toHaveBeenCalled();
  expect(await recorded()).toEqual([]);
  expect(mocks.read).toHaveBeenCalledTimes(1);
});

it("intro: when the tick margin is gone after dispatch, the call is settled not_started without a spawn and nothing is recorded", async () => {
  fake("intro-ok");
  mocks.pendingIntro.mockResolvedValueOnce([introTask(1)]).mockResolvedValue([]);
  let budget = 1;
  const ctx = context("product-intro-check", { hasBudget: () => budget-- > 0 });

  expect(await checkProductIntros(ctx)).toEqual({ done: false });

  expect(mocks.finish).toHaveBeenCalledTimes(1);
  expect(terminalEvidence()).toMatchObject({ ending: "not_started", exitCode: null, signal: null, stdoutBytes: 0, provenance: "unknown" });
  expect(mocks.indeterminate).not.toHaveBeenCalled();
  expect(mocks.recordIntro).not.toHaveBeenCalled();
  expect(await recorded()).toEqual([]);
});

it("intro: a grandchild holding the pipe leaves the dispatch indeterminate (process_exit) and the next tick spawns nothing", async () => {
  fake("grandchild-hold");
  const tasks = [introTask(1)];
  mocks.pendingIntro.mockResolvedValue(tasks);
  mocks.recordIntro.mockResolvedValue("failed");
  const ctx = context("product-intro-check");
  let grandchild: number | undefined;
  try {
    // 출력은 버리고 기존 실패 기록·멈춤 규칙(cli_error)을 그대로 탄다 — 성공이 아니라 제 일 못 함으로 넘긴다
    expect(await checkProductIntros(ctx)).toEqual({ done: true, degraded: { code: "cli_error", detail: expect.stringContaining("소개 검수") } });
    const [spawned] = await recorded();
    grandchild = spawned.grandchild;
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.indeterminate).toHaveBeenCalledTimes(1);
    expect(mocks.indeterminate.mock.calls[0][1]).toBe("process_exit");
    expect(mocks.indeterminate.mock.calls[0][0]).toBe(await mocks.finish.mock.results[0].value);
    expect(mocks.recordIntro.mock.calls).toEqual([[tasks[0], ctx.lease, { kind: "failure", error: "cli_error" }]]);
    expect(ctx.log).toHaveBeenLastCalledWith("intro_check.blocked", { kept: 0, replaced: 0, needs_editor: 0, failed: 1, error: "cli_error" });

    // 장부가 같은 구성원을 막으면(indeterminate 점유) 다음 틱은 띄우지 않고 미룬다
    await clearRecords();
    mocks.request.mockResolvedValue({ kind: "deferred", reason: "capacity" });
    const next = await settle(checkProductIntros(context("product-intro-check")));
    expect(next.error).toMatchObject({ name: "ModelCapacityDeferredError", reason: "capacity" });
    expect(mocks.finish).toHaveBeenCalledTimes(1);
    expect(mocks.recordIntro).toHaveBeenCalledTimes(1);
    expect(await recorded()).toEqual([]);
  } finally { await reap([grandchild]); }
}, PROCESS_TEST_MS);

it("intro: a defer on the second batch keeps the first batch's records and starts no second process", async () => {
  fake("intro-ok");
  mocks.pendingIntro.mockResolvedValueOnce([introTask(2)]).mockResolvedValueOnce([introTask(1)]).mockResolvedValue([]);
  mocks.request.mockImplementationOnce(async () => ({ kind: "granted", reservation: reservation() }))
    .mockResolvedValue({ kind: "deferred", reason: "capacity" });
  const ctx = context("product-intro-check");

  const outcome = await settle(checkProductIntros(ctx));

  expect(outcome.error).toMatchObject({ name: "ModelCapacityDeferredError", reason: "capacity" });
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(mocks.reconcile).toHaveBeenCalledTimes(1);
  expect(mocks.recordIntro.mock.calls).toEqual([[introTask(2), ctx.lease,
    { kind: "success", judgement: { verdict: "ok", problem: "", corrected: "" }, model: INTRO_CHECK_MODEL }]]);
  expect(await recorded()).toHaveLength(1);
}, PROCESS_TEST_MS);

it.each([
  { name: "no longer eligible", locked: () => null },
  { name: "check row changed", locked: () => [{ ...member(1), check: { kind: "present" as const, rowIdentityHash: sha("other"), attempts: 0 } }] },
])("intro: a batch that changed between the slot and the dispatch lock ($name) is skipped — reservation cancelled, nothing spawned or recorded", async ({ locked }) => {
  fake("intro-ok");
  mocks.pendingIntro.mockResolvedValueOnce([introTask(1)]).mockResolvedValue([]);
  mocks.introMembers.mockResolvedValueOnce([member(1)]).mockResolvedValueOnce(locked());

  expect(await checkProductIntros(context("product-intro-check"))).toEqual({ done: false });

  expect(mocks.finish).not.toHaveBeenCalled();
  expect(mocks.cancel).toHaveBeenCalledTimes(1);
  expect(mocks.cancel.mock.calls[0][0]).toEqual((await mocks.request.mock.results[0].value).reservation);
  expect(mocks.reconcile).not.toHaveBeenCalled();
  expect(mocks.recordIntro).not.toHaveBeenCalled();
  expect(await recorded()).toEqual([]);
});

it("audit: open with a contract binds the audit item, runs reviewWithAgent's exact argv/stdin through the runner, settles, then records", async () => {
  fake("ok");
  const ctx = context("product-audit");

  expect(await auditPublishedProducts(ctx)).toEqual({ done: false });

  expect(mocks.request.mock.calls).toEqual([[expect.objectContaining({ owner: { instanceId: INSTANCE, bootId }, class: "background", pool: "reviewer",
    routeId: "product-audit", provider: "claude-cli", model: AUDIT_MODEL, workKey: `bg:audit:7:${auditInput.inputHash}` }), { kind: "audit", itemId: 7 }]]);
  expect(mocks.auditItem).toHaveBeenCalledWith(mocks.tx, { itemId: 7, slug: "app", campaign: campaign() });
  expect(finishedBinding()).toMatchObject({ kind: "product_audit_cli", logicalWorkKey: "bg:audit:7", itemId: 7, campaignId: 4, productId: 70,
    slug: "app", inputHash: auditInput.inputHash, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, attempts: 1,
    provider: "claude-cli", model: AUDIT_MODEL, routeId: "product-audit", job: ctx.lease, transport: { timeoutMs: 20_000 } });
  expect(terminalEvidence()).toMatchObject({ ending: "exited", exitCode: 0 });
  expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(mocks.recordAudit.mock.invocationCallOrder[0]);
  expect(mocks.recordAudit.mock.calls).toEqual([[{ itemId: 7, startedAt: expect.any(Date), provider: "claude-cli", model: AUDIT_MODEL,
    promptVersion: REVIEW_PROMPT_VERSION, input: auditInput, ok: true, outcome: expect.objectContaining({ decision: "approve", evidenceIds: ["product"] }) }, ctx.lease,
    DEFAULT_CRAWL_SETTINGS.auditHold]]);
  const [spawned] = await recorded();
  expect(spawned.argv).toEqual(reviewCliArgs(AUDIT_MODEL));
  const serialized = JSON.stringify(auditInput.snapshot).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  expect(Buffer.from(spawned.stdin!, "base64").toString("utf8")).toBe(`<untrusted_evidence_json>\n${serialized}\n</untrusted_evidence_json>`);
  expect(spawned.env).toMatchObject({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2000", CLAUDECODE: null });
}, PROCESS_TEST_MS);

it("audit: a lane whose start condition is lost after dispatch settles not_started and inserts no attempt row", async () => {
  fake("ok");
  // canStart 는 자리 시작·원본 조회 뒤·호출 직전에 한 번씩 본다 — 그 셋은 여유가 있고 dispatch 뒤 spawn 직전 확인에서 예산이 없다
  let budget = 3;
  expect(await auditPublishedProducts(context("product-audit", { hasBudget: () => budget-- > 0 }))).toEqual({ done: false });
  expect(mocks.finish).toHaveBeenCalledTimes(1);
  expect(terminalEvidence()).toMatchObject({ ending: "not_started", exitCode: null });
  expect(mocks.recordAudit).not.toHaveBeenCalled();
  expect(await recorded()).toEqual([]);
});

it("audit: a slot defer records nothing for that lane and defers the job", async () => {
  mocks.request.mockResolvedValue({ kind: "deferred", reason: "capacity" });
  const outcome = await settle(auditPublishedProducts(context("product-audit")));
  expect(outcome.error).toMatchObject({ name: "ModelCapacityDeferredError", reason: "capacity" });
  expect(mocks.finish).not.toHaveBeenCalled();
  expect(mocks.recordAudit).not.toHaveBeenCalled();
  expect(mocks.noSource).not.toHaveBeenCalled();
  expect(await recorded()).toEqual([]);
});

it("grok session: open with a contract runs the session call in the instance's slot, settles, then observes", async () => {
  fake("grok-ok");
  const ctx = context("grok-session-check");

  expect(await checkGrokSession(ctx)).toEqual({ done: true });

  const logical = grokSessionLogicalWorkKey(INSTANCE), inputHash = grokSessionInputHash({ instanceId: INSTANCE, model: GROK_MODEL });
  expect(mocks.request.mock.calls).toEqual([[expect.objectContaining({ owner: { instanceId: INSTANCE, bootId }, class: "background", pool: "reviewer",
    routeId: "grok-session-check", provider: "grok-cli", model: GROK_MODEL, workKey: `${logical}:${inputHash}` }), { kind: "grok-session", instanceId: INSTANCE }]]);
  expect(finishedBinding()).toMatchObject({ kind: "grok_session_cli", instanceId: INSTANCE, model: GROK_MODEL, logicalWorkKey: logical, inputHash,
    provider: "grok-cli", routeId: "grok-session-check", job: ctx.lease, transport: { provider: "grok-cli", timeoutMs: 60_000 } });
  expect(terminalEvidence()).toMatchObject({ ending: "exited", exitCode: 0 });
  expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(mocks.observe.mock.invocationCallOrder[0]);
  expect(mocks.observe.mock.calls).toEqual([[`service:grok:${INSTANCE}`, expect.objectContaining({ provider: "grok-cli", model: GROK_MODEL,
    resolvedModel: "grok-4.7-build", result: "success" })]]);
  const [spawned] = await recorded();
  expect(spawned).toMatchObject({ argv: grokSessionArgs(GROK_MODEL), env: { NO_COLOR: "1", RUST_LOG: "off" }, realCliOnPath: false });
}, PROCESS_TEST_MS);

it("grok session (D3): while its slot is deferred nothing runs and no observation is written — a long defer lets the 6h Grok token expire", async () => {
  // 위험(설계 D3): 세션 점검은 토큰 갱신을 위해 4시간마다 부르는 호출이다. 슬롯이 오래 막히면 갱신 호출도 없고 관측도 늙는다 —
  // 그 사이 6시간 토큰이 만료되면 다음 Grok 심사가 auth 로 실패한다. 그래서 policy 에서 background 가중을 최소로 두되 0 으로 막지 않는다.
  mocks.request.mockResolvedValue({ kind: "deferred", reason: "capacity" });
  const outcome = await settle(checkGrokSession(context("grok-session-check")));
  expect(outcome.error).toMatchObject({ name: "ModelCapacityDeferredError", reason: "capacity" });
  expect(mocks.finish).not.toHaveBeenCalled();
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(await recorded()).toEqual([]);
});

it("grok session: the slot owner must be this service instance (the auth file and observation key are per instance)", async () => {
  vi.stubEnv("ROLE_LEASE_INSTANCE_ID", "mini-reviewer");
  const outcome = await settle(checkGrokSession(context("grok-session-check")));
  expect(outcome.error).toMatchObject({ name: "ModelCapacityDeferredError", reason: "owner_unavailable" });
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(await recorded()).toEqual([]);
});
