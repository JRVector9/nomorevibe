import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { JobLeaseLostError } from "@/lib/jobs/lease";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";
import { writeSearchProfiles } from "@/lib/jobs/products/search-profile";
import { translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { setRuntimeSettingsForTest } from "@/lib/operations/runtime-settings-store";
import { pinTextRanks, textContract } from "./text-task-ranks-fixture";

const mocks = vi.hoisted(() => ({
  tags: vi.fn(), profiles: vi.fn(), reasons: vi.fn(),
  tagCall: vi.fn(), profileCall: vi.fn(), reasonCall: vi.fn(),
  tagWrite: vi.fn(), profileWrite: vi.fn(), reasonWrite: vi.fn(),
  remainingMs: null as number | null,
}));
vi.mock("@/lib/jobs/tick-deadline", async load => {
  const actual = await load<typeof import("@/lib/jobs/tick-deadline")>();
  return { ...actual, tickRemaining: (...args: Parameters<typeof actual.tickRemaining>) => {
    const remaining = actual.tickRemaining(...args);
    return () => mocks.remainingMs ?? remaining();
  } };
});
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({ enabled: true }) }));
vi.mock("@/lib/crawl/taglines", () => ({ pendingTaglines: mocks.tags, recordTaglineResult: mocks.tagWrite }));
vi.mock("@/lib/crawl/tagline-model-capacity", () => ({ writeCrawlTaglineWithModelCapacity: mocks.tagCall }));
vi.mock("@/lib/domain/products/search-profiles", () => ({
  pendingProfiles: mocks.profiles, recordProfileResult: mocks.profileWrite, resumedProfileModel: () => null,
}));
vi.mock("@/lib/domain/products/search-profile-model-capacity", () => ({ writeKeywordsWithModelCapacity: mocks.profileCall }));
vi.mock("@/lib/crawl/translations", () => ({
  untriedTranslations: mocks.reasons, retryableTranslations: mocks.reasons, recordWorkerTranslations: mocks.reasonWrite,
}));
vi.mock("@/lib/crawl/reason-translation-model-capacity", () => ({ translateReasonsWithModelCapacity: mocks.reasonCall }));

const proof = Object.freeze({ unit: "the-adapter-issued-writer-proof" });
const expectedProfile = Object.freeze({ kind: "absent" });
const tag = { candidate: { id: 1, repo: "fixture/tool" }, document: {
  productUrl: "https://tool.test", repoMeta: {}, pageMeta: { title: "Tool", textSample: "Manage documents" },
}, written: null };
const profile = { product: { id: 1, slug: "tool", name: "Tool", url: "https://tool.test", category: "Tools",
  tagline: "Manage documents", description: "Keep documents organized", status: "verified",
  searchTopics: null, searchPageText: null, searchReadme: null }, profile: null, reviewerNote: null };
const reason = { hash: "a".repeat(64), body: "The page shows a document management tool", attempts: 0 };
const MODELS = { "crawl-tagline": "Tagline Model", "product-search-profile": "Profile Model", "reason-translate": "Reason Model" };
const scenarios = [
  { name: "crawl-tagline" as const, run: writeTaglines, pending: mocks.tags, task: tag, call: mocks.tagCall, write: mocks.tagWrite,
    success: { ok: true, tagline: "Manage documents", source: "page" },
    outcome: (result: unknown) => ({ kind: "result", askOrdinal: 1, result, expectation: proof }),
    expectedWrite: () => [tag, expect.anything(), expect.objectContaining({ kind: "success", tagline: "Manage documents" }), proof] },
  { name: "product-search-profile" as const, run: writeSearchProfiles, pending: mocks.profiles, task: profile,
    call: mocks.profileCall, write: mocks.profileWrite,
    success: { ok: true, en: ["document tool"], ko: ["문서 관리"] },
    outcome: (result: unknown) => ({ kind: "result", result, expectedProfile }),
    expectedWrite: () => [profile, expect.anything(), expect.objectContaining({ kind: "success", en: ["document tool"] }), expectedProfile] },
  { name: "reason-translate" as const, run: translateReasons, pending: mocks.reasons, task: reason,
    call: mocks.reasonCall, write: mocks.reasonWrite,
    success: { ok: true, translations: ["페이지에서 문서 관리 도구를 확인했습니다"] },
    outcome: (result: unknown) => ({ kind: "ready", result, batch: [reason], expectation: proof, unknown: false }),
    expectedWrite: () => [[expect.objectContaining({ hash: reason.hash, translated: "페이지에서 문서 관리 도구를 확인했습니다" })],
      MODELS["reason-translate"], expect.anything(), proof] },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.remainingMs = null;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  setRuntimeSettingsForTest(null);
  pinTextRanks(MODELS);
  setServingContractSnapshotForTest(Object.entries(MODELS).map(([route, model]) => textContract(route as keyof typeof MODELS, model)));
  mocks.tagWrite.mockResolvedValue({ stored: true, released: true });
  mocks.profileWrite.mockResolvedValue(true);
  mocks.reasonWrite.mockResolvedValue(1);
});
afterEach(() => {
  vi.useRealTimers();
  setRuntimeSettingsForTest(null);
  setServingContractSnapshotForTest(null);
  pinTextRanks(null);
});

function context(name: string) {
  let budget = true;
  const outside = new AbortController();
  const ctx: JobContext<null> = { cursor: null, lease: { name, token: "fixture-token", requestedVersion: 1 },
    signal: outside.signal, hasBudget: () => budget, log: vi.fn(), save: vi.fn() };
  return { ctx, outside, exhaust: () => { budget = false; } };
}

it.each(scenarios)("$name keeps an already completed response when only its tick budget aborts", async scenario => {
  const { ctx, exhaust } = context(scenario.name);
  scenario.pending.mockResolvedValue([scenario.task]);
  scenario.call.mockImplementation(async (_task, _lease, options: { signal: AbortSignal }) => {
    exhaust();
    await vi.advanceTimersByTimeAsync(300); // Run the real caller's 250ms ownership poll.
    expect(options.signal.aborted).toBe(true);
    expect(ctx.signal!.aborted).toBe(false);
    return scenario.outcome(scenario.success);
  });

  await scenario.run(ctx);

  expect(scenario.call).toHaveBeenCalledTimes(1);
  expect(scenario.write).toHaveBeenCalledExactlyOnceWith(...scenario.expectedWrite());
  expect(vi.getTimerCount()).toBe(0);
});

it.each(scenarios)("$name still discards completed work after an external shutdown signal", async scenario => {
  const { ctx, outside } = context(scenario.name);
  scenario.pending.mockResolvedValue([scenario.task]);
  scenario.call.mockImplementation(async () => {
    outside.abort();
    return scenario.outcome(scenario.success);
  });

  await scenario.run(ctx);

  expect(scenario.call).toHaveBeenCalledTimes(1);
  expect(scenario.write).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(scenarios.flatMap(scenario => ["cancelled", "timeout"].map(error => ({ ...scenario, error }))))(
  "$name does not convert an aborted $error outcome into a counted domain failure", async scenario => {
    const { ctx, exhaust } = context(scenario.name);
    scenario.pending.mockResolvedValue([scenario.task]);
    scenario.call.mockImplementation(async (_task, _lease, options: { signal: AbortSignal }) => {
      exhaust();
      await vi.advanceTimersByTimeAsync(300);
      expect(options.signal.aborted).toBe(true);
      return { ...scenario.outcome({ ok: false, error: scenario.error }), unknown: true };
    });

    await scenario.run(ctx);

    expect(scenario.call).toHaveBeenCalledTimes(1);
    expect(scenario.write).not.toHaveBeenCalled();
  },
);

it.each(scenarios)("$name preserves the fenced writer's lease rejection after budget expiry", async scenario => {
  const { ctx, exhaust } = context(scenario.name);
  const lost = new JobLeaseLostError();
  scenario.pending.mockResolvedValue([scenario.task]);
  scenario.call.mockImplementation(async () => {
    exhaust();
    await vi.advanceTimersByTimeAsync(300);
    return scenario.outcome(scenario.success);
  });
  scenario.write.mockRejectedValue(lost);

  await expect(scenario.run(ctx)).rejects.toBe(lost);

  expect(scenario.write).toHaveBeenCalledTimes(1);
});

it("product-search-profile still defers a shorter tick timeout without spending a retry", async () => {
  const { ctx, exhaust } = context("product-search-profile");
  // The job may admit work with less than the full route timeout remaining.
  setRuntimeSettingsForTest({ budgets: { "product-search-profile": 20_000 } });
  mocks.profiles.mockResolvedValue([profile]);
  mocks.profileCall.mockImplementation(async () => {
    exhaust();
    return { kind: "result", result: { ok: false, error: "timeout" }, expectedProfile };
  });

  await writeSearchProfiles(ctx);

  expect(mocks.profileWrite).not.toHaveBeenCalled();
  expect(ctx.log).toHaveBeenCalledWith("search_profile.budget_deferred", expect.any(Object));
});

it("reason-translate does not start accepting unknown results after its internal budget abort", async () => {
  const { ctx, exhaust } = context("reason-translate");
  mocks.reasons.mockResolvedValue([reason]);
  mocks.reasonCall.mockImplementation(async () => {
    exhaust();
    await vi.advanceTimersByTimeAsync(300);
    // The current native parser cannot return ok:true without terminal evidence. Keep that
    // invariant explicit at this boundary if an adapter ever exposes such a contradictory result.
    return { kind: "ready", batch: [reason], result: { ok: true, translations: ["한국어 사유"] }, expectation: proof, unknown: true };
  });

  await translateReasons(ctx);

  expect(mocks.reasonWrite).not.toHaveBeenCalled();
});

it("crawl-tagline leaves the first empty phase uncommitted when only the second-question window is too short", async () => {
  const { ctx } = context("crawl-tagline");
  mocks.remainingMs = 30_000;
  mocks.tags.mockResolvedValue([tag]);
  mocks.tagCall.mockImplementation(async () => {
    mocks.remainingMs = 14_000; // hasBudget and signal stay live; minCallMs is 15 seconds.
    return { kind: "result", askOrdinal: 1, result: { ok: true, tagline: "", source: "page" }, expectation: proof };
  });

  expect(await writeTaglines(ctx)).toEqual({ done: false });

  expect(mocks.tagCall).toHaveBeenCalledTimes(1);
  expect(mocks.tagWrite).not.toHaveBeenCalled();
  expect(ctx.signal!.aborted).toBe(false);
  expect(ctx.hasBudget()).toBe(true);
});
