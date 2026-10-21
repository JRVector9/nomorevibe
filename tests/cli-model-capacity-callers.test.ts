import { beforeEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { checkProductIntros } from "@/lib/jobs/products/intro-check";
import { INTRO_CHECK_MODEL, introCheckCliArgs, introEvidence } from "@/lib/domain/products/intro-check";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { checkGrokSession, grokSessionArgs } from "@/lib/crawl/jobs/grok-session";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

// CLI·게이트웨이 호출과 도메인 기록만 바꾼다. 실제 control SQL·runner 처리는 tests/integration/cli-model-capacity-admission.test.ts 가 본다.
const mocks = vi.hoisted(() => ({ read: vi.fn(), settings: vi.fn(), pendingIntro: vi.fn(), recordIntro: vi.fn(),
  campaign: vi.fn(), candidates: vi.fn(), pendingAudit: vi.fn(), input: vi.fn(), recordAudit: vi.fn(), noSource: vi.fn(),
  finish: vi.fn(), gateway: vi.fn(), agent: vi.fn() }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: mocks.read }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/operations/observations", () => ({ observe: vi.fn() }));
vi.mock("@/lib/domain/products/intro-checks", () => ({ pendingIntroChecks: mocks.pendingIntro, recordIntroCheck: mocks.recordIntro }));
vi.mock("@/lib/crawl/agent-review-repository", () => ({ listReviewCandidates: mocks.candidates }));
vi.mock("@/lib/crawl/agent-review", async (load) => ({ ...await load<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: mocks.agent }));
vi.mock("@/lib/crawl/agent-review-gateway", async (load) => ({ ...await load<typeof import("@/lib/crawl/agent-review-gateway")>(),
  reviewWithGateway: mocks.gateway }));
// 감사 보류 쓸기는 DB 를 쓴다 — 이 테스트는 모델 호출만 본다(tests/integration/product-audit-hold.test.ts 가 쓸기를 본다)
vi.mock("@/lib/crawl/product-audit-hold", () => ({ sweepAuditHolds: async () => 0 }));
// Qwen-v2 단계(gpu3090 직접 호출)는 DB·네트워크를 쓴다 — tests/product-audit-job.test.ts 가 감사 묻기와의 관계를 본다
vi.mock("@/lib/crawl/audit-second-opinion-auto", () => ({ runQwenSecondOpinions: async () => null }));
vi.mock("@/lib/crawl/product-audit", () => ({ runningAuditCampaign: mocks.campaign, pendingAuditItems: mocks.pendingAudit,
  loadAuditInput: mocks.input, recordAuditResult: mocks.recordAudit, markAuditNoSource: mocks.noSource, finishAuditCampaign: mocks.finish }));

type Route = { routeId: string; provider: string; model: string };
const GATEWAY_MODEL = "[MLX] gpt-oss-120b";
const control = (mode: string, routes: Route[] = []) => ({ mode, epoch: 1, revision: 1,
  policyHash: mode === "disabled" ? null : "a".repeat(64), policy: mode === "disabled" ? null : { routes } });
const disabled = control("disabled");
const latch = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const settle = (work: Promise<unknown>) => work.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
const context = (name: string, over: Partial<JobContext<null>> = {}): JobContext<null> => ({ cursor: null, save: vi.fn(),
  hasBudget: () => true, deadlineAt: Date.now() + 70_000, log: vi.fn(), lease: { name, token: "owned", requestedVersion: 1 }, ...over });

const product = (id: number) => ({ id, slug: `app-${id}`, name: `App ${id}`, url: `https://app-${id}.test`, tagline: "Plan meals for the week",
  taglineSource: "ai_page" as const, description: "Meal planner", status: "seeded" as const,
  searchTopics: null, searchPageText: `App ${id} page text`, searchReadme: null });
const introTask = (id: number) => ({ product: product(id), check: null });
const introCli = vi.fn(async (_args: string[], stdin: string) => {
  const body = JSON.parse(stdin.replace(/^<untrusted_evidence_json>\n/, "").replace(/\n<\/untrusted_evidence_json>$/, "")) as { slug: string }[];
  const results = body.map(item => ({ slug: item.slug, verdict: "ok", problem: "", corrected: "" }));
  return { kind: "exit" as const, code: 0, stdout: JSON.stringify({ is_error: false, structured_output: { results } }), stderr: "" };
});
const grokCli = vi.fn(async () => ({ kind: "exit" as const, code: 0, stdout: JSON.stringify({ text: "OK", modelUsage: { "grok-4.7-build": {} } }), stderr: "" }));
const grokRecord = vi.fn();
const verdict = { ok: true, outcome: { decision: "approve", reason: "Usable app", confidence: 0.9, evidenceIds: ["product"] }, usage: {} };
const auditInput = { snapshot: {}, inputHash: "h", source: {} };
const campaign = (provider: string, model: string) => ({ id: 4, provider, model, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION });

// route 마다 실제로 부르는 것(cli)과 그 대신 남겼을 기록(writes)
const callers = [
  { name: "intro-check claude-cli", route: { routeId: "product-intro-check", provider: "claude-cli", model: INTRO_CHECK_MODEL },
    setup: () => { mocks.pendingIntro.mockResolvedValueOnce([introTask(1)]).mockResolvedValue([]); },
    run: () => checkProductIntros(context("product-intro-check"), introCli), cli: introCli, writes: [mocks.recordIntro] },
  { name: "product-audit claude-cli", route: { routeId: "product-audit", provider: "claude-cli", model: "sonnet" },
    setup: () => { mocks.campaign.mockResolvedValue(campaign("claude-cli", "sonnet")); },
    run: () => auditPublishedProducts(context("product-audit")), cli: mocks.agent, writes: [mocks.recordAudit, mocks.noSource] },
  { name: "product-audit abcllm gateway", route: { routeId: "product-audit", provider: "abcllm", model: GATEWAY_MODEL },
    setup: () => { mocks.campaign.mockResolvedValue(campaign("abcllm", GATEWAY_MODEL)); },
    run: () => auditPublishedProducts(context("product-audit")), cli: mocks.gateway, writes: [mocks.recordAudit, mocks.noSource] },
  { name: "grok-session grok-cli", route: { routeId: "grok-session-check", provider: "grok-cli", model: "grok-4.7" },
    setup: () => {}, run: () => checkGrokSession(context("grok-session-check"), { run: grokCli, record: grokRecord }),
    cli: grokCli, writes: [grokRecord] },
];
// 같은 route 의 다른 transport, 같은 transport·model 의 다른 route 는 매핑이 아니다
const others = (route: Route): Route[] => [{ ...route, provider: route.provider === "abcllm" ? "claude-cli" : "abcllm" },
  { ...route, model: `${route.model}-other` },
  ...["product-intro-check", "product-audit", "grok-session-check", "crawl-agent-review", "second-review"]
    .filter(id => id !== route.routeId).map(routeId => ({ ...route, routeId }))];
const modes = [
  { mode: "draining", reason: "draining", routes: (route: Route) => [route] },
  { mode: "open", reason: "unmapped", routes: others },
  { mode: "open", reason: "provider_contract_unavailable", routes: (route: Route) => [...others(route), route] },
];
const matrix = callers.flatMap(caller => modes.map(mode => ({ ...caller, ...mode, label: `${caller.name} ${mode.mode}/${mode.reason}` })));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SERVICE_INSTANCE_ID", "m3-reviewer");
  vi.stubEnv("GROK_AUTH_PATH", "/nonexistent/auth.json");
  mocks.read.mockResolvedValue(disabled);
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewConcurrency: 1,
    secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "grok-cli", model: "grok-4.7" }] } });
  mocks.recordIntro.mockResolvedValue("kept");
  mocks.campaign.mockResolvedValue(campaign("claude-cli", "sonnet"));
  mocks.candidates.mockResolvedValue([]);
  mocks.pendingAudit.mockResolvedValue([{ id: 7, slug: "app" }]);
  mocks.input.mockResolvedValue(auditInput);
  mocks.gateway.mockResolvedValue(verdict);
  mocks.agent.mockResolvedValue(verdict);
});

it.each(matrix)("$label defers before any CLI or gateway call and leaves attempts, fallback and observations unwritten", async scenario => {
  scenario.setup();
  mocks.read.mockResolvedValue(control(scenario.mode, scenario.routes(scenario.route)));
  const outcome = await settle(scenario.run());
  expect(scenario.cli).not.toHaveBeenCalled();
  for (const write of scenario.writes) expect(write).not.toHaveBeenCalled();
  expect(outcome.error).toBeInstanceOf(ModelCapacityDeferredError);
  expect(outcome.error).toMatchObject({ reason: scenario.reason });
  expect(mocks.read).toHaveBeenCalledTimes(1);
});

it.each(callers)("$name keeps the original control failure and starts no call", async scenario => {
  scenario.setup();
  const failure = new Error("model_capacity_policy_hash_mismatch");
  mocks.read.mockRejectedValue(failure);
  const outcome = await settle(scenario.run());
  expect(scenario.cli).not.toHaveBeenCalled();
  for (const write of scenario.writes) expect(write).not.toHaveBeenCalled();
  expect(outcome.error).toBe(failure);
});

it("disabled intro check keeps the exact CLI argv, stdin, timeout, records and result", async () => {
  const tasks = [introTask(2), introTask(1)];
  mocks.pendingIntro.mockResolvedValueOnce(tasks).mockResolvedValue([]);
  const ctx = context("product-intro-check");
  expect(await checkProductIntros(ctx, introCli)).toEqual({ done: true });
  const items = tasks.map(task => ({ slug: task.product.slug, intro: task.product.tagline, evidence: introEvidence(task.product) }));
  const stdin = `<untrusted_evidence_json>\n${JSON.stringify(items).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}\n</untrusted_evidence_json>`;
  expect(introCli.mock.calls).toEqual([[introCheckCliArgs(INTRO_CHECK_MODEL), stdin, { timeoutMs: 90_000, signal: undefined, maxOutputTokens: 8_000 }]]);
  expect(mocks.recordIntro.mock.calls).toEqual(tasks.map(task => [task, ctx.lease,
    { kind: "success", judgement: { verdict: "ok", problem: "", corrected: "" }, model: INTRO_CHECK_MODEL }]));
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(ctx.log).toHaveBeenLastCalledWith("intro_check.done", { kept: 2, replaced: 0, needs_editor: 0, failed: 0, drained: true });
});

it("disabled intro failures keep the existing per-product failure record and stop rule", async () => {
  const tasks = [introTask(1)];
  mocks.pendingIntro.mockResolvedValueOnce(tasks).mockResolvedValue([]);
  mocks.recordIntro.mockResolvedValue("failed");
  const ctx = context("product-intro-check");
  const timeout = vi.fn(async () => ({ kind: "timeout" as const }));
  expect(await checkProductIntros(ctx, timeout)).toEqual({ done: true });
  expect(timeout).toHaveBeenCalledTimes(1);
  expect(mocks.recordIntro.mock.calls).toEqual([[tasks[0], ctx.lease, { kind: "failure", error: "timeout" }]]);
  expect(ctx.log).toHaveBeenLastCalledWith("intro_check.blocked", { kept: 0, replaced: 0, needs_editor: 0, failed: 1, error: "timeout" });
});

it("an intro defer after a recorded batch keeps that batch and starts no second CLI call", async () => {
  mocks.pendingIntro.mockResolvedValueOnce([introTask(2)]).mockResolvedValueOnce([introTask(1)]).mockResolvedValue([]);
  mocks.read.mockResolvedValueOnce(disabled).mockResolvedValue(control("open", [{ routeId: "product-intro-check", provider: "claude-cli", model: INTRO_CHECK_MODEL }]));
  const outcome = await settle(checkProductIntros(context("product-intro-check"), introCli));
  expect(introCli).toHaveBeenCalledTimes(1);
  expect(mocks.recordIntro).toHaveBeenCalledTimes(1);
  expect(mocks.recordIntro.mock.calls[0][0]).toEqual(introTask(2));
  expect(outcome.error).toMatchObject({ name: "ModelCapacityDeferredError", reason: "provider_contract_unavailable" });
});

it.each([
  { name: "claude-cli", provider: "claude-cli", model: "sonnet", cli: mocks.agent, timeoutMs: 20_000 },
  { name: "abcllm gateway", provider: "abcllm", model: GATEWAY_MODEL, cli: mocks.gateway, timeoutMs: 60_000 },
])("disabled $name audit keeps the exact call options and attempt record", async ({ provider, model, cli, timeoutMs }) => {
  mocks.campaign.mockResolvedValue(campaign(provider, model));
  const ctx = context("product-audit");
  expect(await auditPublishedProducts(ctx)).toEqual({ done: false });
  expect(cli.mock.calls).toEqual([[auditInput, { model, timeoutMs, signal: expect.any(AbortSignal) }]]);
  expect(mocks.recordAudit.mock.calls).toEqual([[{ itemId: 7, startedAt: expect.any(Date), provider, model, input: auditInput,
    ok: true, outcome: verdict.outcome }, ctx.lease, DEFAULT_CRAWL_SETTINGS.auditHold]]);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(ctx.log).toHaveBeenCalledWith("product_audit.reviewed", { campaign: 4, reviewed: 1, failed: 0, noSource: 0 });
});

it("disabled reviewer-down audit failure is still recorded uncounted and fails the job", async () => {
  mocks.agent.mockResolvedValue({ ok: false, error: "auth" });
  await expect(auditPublishedProducts(context("product-audit"))).rejects.toThrow("product_audit_reviewer_unavailable:auth");
  expect(mocks.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "auth", counted: false }), expect.anything());
});

it("an audit lane defer lets started lanes finish and record but starts no further call", async () => {
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewConcurrency: 4 });
  mocks.pendingAudit.mockResolvedValue(Array.from({ length: 8 }, (_, index) => ({ id: index + 1, slug: `app-${index + 1}` })));
  const finish = latch(), entered = latch();
  // 넷째 자리의 control 읽기는 앞의 세 호출이 시작된 뒤에 open 을 본다
  mocks.read.mockResolvedValueOnce(disabled).mockResolvedValueOnce(disabled).mockResolvedValueOnce(disabled)
    .mockImplementation(async () => { await entered.promise; return control("open", [{ routeId: "product-audit", provider: "claude-cli", model: "sonnet" }]); });
  const signals: AbortSignal[] = [];
  mocks.agent.mockImplementation(async (_input, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    if (signals.length >= 3) entered.resolve();
    await finish.promise;
    return verdict;
  });
  const ctx = context("product-audit");
  const work = settle(auditPublishedProducts(ctx));
  try {
    await Promise.race([entered.promise, work]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mocks.agent).toHaveBeenCalledTimes(3);
    expect(signals.every(signal => !signal.aborted)).toBe(true);
  } finally { finish.resolve(); }
  const outcome = await work;
  expect(mocks.agent).toHaveBeenCalledTimes(3);
  expect(mocks.recordAudit).toHaveBeenCalledTimes(3);
  expect(mocks.recordAudit.mock.calls.every(call => call[0].ok === true)).toBe(true);
  expect(mocks.noSource).not.toHaveBeenCalled();
  expect(outcome.error).toMatchObject({ name: "ModelCapacityDeferredError", reason: "provider_contract_unavailable" });
});

it("a genuine audit lane error still wins over a peer capacity defer", async () => {
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewConcurrency: 2 });
  mocks.pendingAudit.mockResolvedValue([{ id: 1, slug: "app-1" }, { id: 2, slug: "app-2" }]);
  const entered = latch(), finish = latch();
  mocks.read.mockResolvedValueOnce(disabled).mockImplementation(async () => { await entered.promise; return control("draining"); });
  mocks.agent.mockImplementation(async () => { entered.resolve(); await finish.promise; return verdict; });
  const failure = new Error("audit_record_failed");
  mocks.recordAudit.mockRejectedValue(failure);
  const work = settle(auditPublishedProducts(context("product-audit")));
  try {
    await Promise.race([entered.promise, work]);
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { finish.resolve(); }
  const outcome = await work;
  expect(mocks.agent).toHaveBeenCalledTimes(1);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(outcome.error).toBe(failure);
});

it("disabled grok session keeps the exact CLI call and observation", async () => {
  expect(await checkGrokSession(context("grok-session-check"), { run: grokCli, record: grokRecord })).toEqual({ done: true });
  expect(grokCli.mock.calls).toEqual([[grokSessionArgs("grok-4.7"), { cwd: expect.stringMatching(/nomorevibe-grok-session-/),
    env: expect.objectContaining({ GROK_HOME: expect.stringMatching(/nomorevibe-grok-session-.*\/home$/), GROK_AUTH_PATH: "/nonexistent/auth.json",
      RUST_LOG: "off", NO_COLOR: "1" }), timeoutMs: 60_000, signal: undefined }]]);
  expect(grokRecord.mock.calls).toEqual([["service:grok:m3-reviewer", { provider: "grok-cli", model: "grok-4.7", resolvedModel: "grok-4.7-build",
    result: "success", checkedAt: expect.any(String), durationMs: expect.any(Number), authFile: { exists: false, modifiedAt: null } }]]);
  expect(mocks.read).toHaveBeenCalledTimes(1);
});

it("jobs with no model work never read the capacity control", async () => {
  mocks.read.mockResolvedValue(control("draining"));
  mocks.pendingIntro.mockResolvedValue([]);
  expect(await checkProductIntros(context("product-intro-check"), introCli)).toEqual({ done: true });
  mocks.pendingAudit.mockResolvedValue([]);
  mocks.finish.mockResolvedValue(true);
  expect(await auditPublishedProducts(context("product-audit"))).toEqual({ done: true });
  mocks.candidates.mockResolvedValue([{ id: 99 }]);
  expect(await auditPublishedProducts(context("product-audit"))).toEqual({ done: true });
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true });
  expect(await checkGrokSession(context("grok-session-check"), { run: grokCli, record: grokRecord })).toEqual({ done: true });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(introCli).not.toHaveBeenCalled();
  expect(grokCli).not.toHaveBeenCalled();
});
