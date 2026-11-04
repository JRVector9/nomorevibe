import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { humanOverview } from "./fixtures/human-queue";

const fake = vi.hoisted(() => ({ causes: vi.fn(), overview: vi.fn(), list: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => ({ login: "admin" }) }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => DEFAULT_CRAWL_SETTINGS }));
vi.mock("@/lib/crawl/admin-review", async original => ({ ...await original<typeof import("@/lib/crawl/admin-review")>(), reviewQueueCauses: fake.causes, listAdminReviewEntries: fake.list }));
vi.mock("@/lib/crawl/review-overview", () => ({ humanQueueOverview: fake.overview }));
vi.mock("@/lib/operations/model-env", () => ({ currentModelEnv: async () => null }));
vi.mock("@/lib/crawl/held-qwen-retry", () => ({ heldQwenRetryStatus: async () => null }));
vi.mock("@/lib/crawl/gate-split-tiebreak-read", () => ({ splitTiebreakStatus: async () => null }));
vi.mock("@/app/(operator)/admin/review/PrototypeReviewConsole", () => ({ PrototypeReviewConsole: ({ title }: { title: string }) => <div data-main-queue>{title}</div> }));
vi.mock("@/app/(operator)/admin/review/ReasonText", () => ({ ReasonLanguageToggle: () => null }));
vi.mock("@/app/(operator)/admin/review/RequeueResolved", () => ({ RequeueResolved: () => null }));
vi.mock("@/app/(operator)/admin/review/SplitTiebreakSwitch", () => ({ SplitTiebreakSwitch: () => null }));
vi.mock("@/app/(operator)/admin/review/HeldQwenRetryPanel", () => ({ HeldQwenRetryPanel: () => null }));

const { default: ReviewPage } = await import("@/app/(operator)/admin/review/page");
const emptyCauses = () => ({ counts: [], ids: new Map(), total: 0, truncated: false });
beforeEach(() => {
  vi.clearAllMocks();
  fake.list.mockResolvedValue({ entries: [], total: 0, hiddenByAge: 0 });
  fake.causes.mockResolvedValue(emptyCauses());
  fake.overview.mockResolvedValue(humanOverview({ human: 2, agreed: 1 }));
});

it("streams the all-stage queue while nonessential cause analysis is still pending and shares its read", async () => {
  let resolveCauses!: (value: ReturnType<typeof emptyCauses>) => void;
  fake.causes.mockReturnValue(new Promise(resolve => { resolveCauses = resolve; }));
  const page = await ReviewPage({ searchParams: Promise.resolve({ tab: "all" }) });
  expect(fake.overview).not.toHaveBeenCalled();
  expect(fake.causes).not.toHaveBeenCalled();
  expect(fake.list).toHaveBeenCalledWith(DEFAULT_CRAWL_SETTINGS, expect.objectContaining({ state: "all", ids: undefined }));

  const output = new PassThrough();
  let html = "";
  const firstChunk = new Promise<void>(resolve => output.once("data", () => resolve()));
  output.on("data", chunk => { html += String(chunk); });
  const finished = new Promise<void>(resolve => output.once("end", resolve));
  const errors: unknown[] = [];
  const stream = renderToPipeableStream(page, { onShellReady: () => stream.pipe(output), onError: error => { errors.push(error); } });
  try {
    await firstChunk;
    expect(html).toContain("data-main-queue");
    expect(html).toContain("모든 단계의 후보");
    expect(html).toContain("갈래 집계를 읽는 중");
    expect(fake.causes).toHaveBeenCalledTimes(1);
    resolveCauses(emptyCauses());
    await finished;
    expect(errors).toEqual([]);
  } finally {
    stream.abort();
  }
});

it("still loads fresh human/agreed membership before reading the human queue", async () => {
  await ReviewPage({ searchParams: Promise.resolve({ tab: "human" }) });
  expect(fake.overview).toHaveBeenCalledTimes(1);
  expect(fake.list).toHaveBeenCalledWith(DEFAULT_CRAWL_SETTINGS, expect.objectContaining({ state: "needs_review", ids: [1, 2, 3] }));
  expect(fake.causes).not.toHaveBeenCalled();
});

it("does not read an unfiltered queue when active cause membership is unavailable", async () => {
  fake.causes.mockRejectedValue(new Error("unavailable"));
  await ReviewPage({ searchParams: Promise.resolve({ tab: "all", cause: "unknown" }) });
  expect(fake.causes).toHaveBeenCalledTimes(1);
  expect(fake.list).not.toHaveBeenCalled();
});
