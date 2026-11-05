import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { humanOverview } from "./fixtures/human-queue";

const fake = vi.hoisted(() => ({ causes: vi.fn(), overview: vi.fn(), list: vi.fn(), held: vi.fn(), tiebreak: vi.fn(), replace: vi.fn(), search: "" }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); }, useRouter: () => ({ replace: fake.replace }), usePathname: () => "/admin/review", useSearchParams: () => new URLSearchParams(fake.search) }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => ({ login: "admin" }) }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => DEFAULT_CRAWL_SETTINGS }));
vi.mock("@/lib/crawl/admin-review", async original => ({ ...await original<typeof import("@/lib/crawl/admin-review")>(), reviewQueueCauses: fake.causes, listAdminReviewEntries: fake.list }));
vi.mock("@/lib/crawl/review-overview", () => ({ humanQueueOverview: fake.overview }));
vi.mock("@/lib/operations/model-env", () => ({ currentModelEnv: async () => null }));
vi.mock("@/lib/crawl/held-qwen-retry", () => ({ heldQwenRetryStatus: fake.held }));
vi.mock("@/lib/crawl/gate-split-tiebreak-read", () => ({ splitTiebreakStatus: fake.tiebreak }));
vi.mock("@/app/(operator)/admin/review/PrototypeReviewConsole", () => ({ PrototypeReviewConsole: ({ title }: { title: string }) => <div data-main-queue>{title}</div> }));
vi.mock("@/app/(operator)/admin/review/ReasonText", () => ({ ReasonLanguageToggle: () => null }));
vi.mock("@/app/(operator)/admin/review/RequeueResolved", () => ({ RequeueResolved: () => null }));
vi.mock("@/app/(operator)/admin/review/SplitTiebreakSwitch", () => ({ SplitTiebreakSwitch: () => null }));
vi.mock("@/app/(operator)/admin/review/HeldQwenRetryPanel", () => ({ HeldQwenRetryPanel: () => null }));

const { default: ReviewPage } = await import("@/app/(operator)/admin/review/page");
const { DeferredReviewPanel } = await import("@/app/(operator)/admin/review/DeferredReviewPanel");
const emptyCauses = () => ({ counts: [], ids: new Map(), total: 0, truncated: false });
beforeEach(() => {
  vi.clearAllMocks();
  fake.list.mockResolvedValue({ entries: [], total: 0, hiddenByAge: 0 });
  fake.causes.mockResolvedValue(emptyCauses());
  fake.overview.mockResolvedValue(humanOverview({ human: 2, agreed: 1 }));
  fake.held.mockResolvedValue(null);
  fake.tiebreak.mockResolvedValue(null);
  fake.search = "";
});

it("finishes the default response without starting any closed-panel analysis or management reads", async () => {
  fake.causes.mockImplementation(() => new Promise(() => {}));
  const page = await ReviewPage({ searchParams: Promise.resolve({ tab: "all" }) });
  const output = new PassThrough();
  let html = "";
  output.on("data", chunk => { html += String(chunk); });
  const finished = new Promise<void>(resolve => output.once("end", resolve));
  const stream = renderToPipeableStream(page, { onShellReady: () => stream.pipe(output) });
  try {
    await finished;
    expect(html).toContain("data-main-queue");
    expect(html).toContain("갈래·AI 판단·기간으로 더 좁히기");
    expect(html).toContain("심사 운영·보류 재심사 관리");
    expect(fake.causes).not.toHaveBeenCalled();
    expect(fake.held).not.toHaveBeenCalled();
    expect(fake.tiebreak).not.toHaveBeenCalled();
  } finally { stream.abort(); }
});

it("streams the queue while explicitly opened panels load and shares their fresh analysis", async () => {
  let resolveCauses!: (value: ReturnType<typeof emptyCauses>) => void;
  fake.causes.mockReturnValue(new Promise(resolve => { resolveCauses = resolve; }));
  const page = await ReviewPage({ searchParams: Promise.resolve({ tab: "all", review_filters: "1", review_management: "1" }) });
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

it("opens and closes only the selected server panel without dropping queue filters or scrolling", () => {
  fake.search = "tab=human&cause=unknown&q=needle&review_management=1";
  const closed = DeferredReviewPanel({ panel: "filters", expanded: false, title: "필터" });
  closed.props.onToggle({ currentTarget: { open: true, closest: () => null } });
  expect(fake.replace).toHaveBeenLastCalledWith("/admin/review?tab=human&cause=unknown&q=needle&review_management=1&review_filters=1", { scroll: false });
  fake.search += "&review_filters=1";
  const opened = DeferredReviewPanel({ panel: "filters", expanded: true, title: "필터" });
  opened.props.onToggle({ currentTarget: { open: false, closest: () => null } });
  expect(fake.replace).toHaveBeenLastCalledWith("/admin/review?tab=human&cause=unknown&q=needle&review_management=1", { scroll: false });
});

it("keeps both native panels open when their toggles precede a URL commit", () => {
  fake.search = "tab=all&stage=publish&sort=wait";
  const details = [
    { dataset: { reviewPanel: "filters" }, open: true },
    { dataset: { reviewPanel: "management" }, open: true },
  ];
  const currentTarget = { open: true, closest: () => ({ querySelectorAll: () => details }) };
  DeferredReviewPanel({ panel: "filters", expanded: false, title: "필터" }).props.onToggle({ currentTarget });
  DeferredReviewPanel({ panel: "management", expanded: false, title: "관리" }).props.onToggle({ currentTarget });
  expect(fake.replace).toHaveBeenLastCalledWith("/admin/review?tab=all&stage=publish&sort=wait&review_filters=1&review_management=1", { scroll: false });
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
