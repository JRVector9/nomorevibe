import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";

/**
 * JS 앱 껍데기 렌더 재수집(2026-11-17) — lib/crawl/shell-render.ts · lib/crawl/jobs/shell-render-document.ts · lib/crawl/js-shell-requeue.ts.
 * 표본의 실제 글(운영 2차 갈림 보류 hsyo830/sowondeung·daelong/mochipet-rpg·danielkim614/super-bible-verse-party)을 그대로 쓴다.
 */
const mocks = vi.hoisted(() => ({
  setRenderedPage: vi.fn(),
  getDocument: vi.fn(),
  requestJob: vi.fn(),
  lockStages: vi.fn(),
  selects: [] as unknown[],
  updates: [] as { set: Record<string, unknown> }[],
  inserts: [] as Record<string, unknown>[],
  updateReturns: [] as { id: number }[],
  countRows: [{ count: 0 }] as { count: number }[],
  holdRows: [] as unknown[],
}));

vi.mock("@/lib/crawl/repository", async (load) => ({
  ...(await load<typeof import("@/lib/crawl/repository")>()),
  setRenderedPage: mocks.setRenderedPage,
  getDocument: mocks.getDocument,
}));
vi.mock("@/lib/jobs/control", async (load) => ({ ...(await load<typeof import("@/lib/jobs/control")>()), requestJob: mocks.requestJob }));
vi.mock("@/lib/crawl/pipeline-stage-context", () => ({ lockPipelineInputStages: mocks.lockStages }));
/** drizzle 사슬의 가짜 — 어떤 메서드를 불러도 자기를 돌려주고, await 하면 정한 값을 준다 */
function chain(result: () => unknown, onCall?: (method: string, args: unknown[]) => void): unknown {
  const proxy: unknown = new Proxy(() => {}, {
    get(_target, prop) {
      if (prop === "then") return (resolve: (value: unknown) => void, reject: (error: unknown) => void) => Promise.resolve().then(result).then(resolve, reject);
      return (...args: unknown[]) => { onCall?.(String(prop), args); return proxy; };
    },
  });
  return proxy;
}
vi.mock("@/lib/db", () => {
  const select = (fields?: Record<string, unknown>) => chain(() => fields && "count" in fields ? mocks.countRows : mocks.holdRows);
  const tx = {
    update: () => chain(() => mocks.updateReturns, (method, args) => { if (method === "set") mocks.updates.push({ set: args[0] as Record<string, unknown> }); }),
    insert: () => ({ values: (value: Record<string, unknown>) => { mocks.inserts.push(value); return Promise.resolve(); } }),
  };
  return { db: { select, transaction: (work: (t: typeof tx) => unknown) => work(tx) } };
});

import { buildReviewProduct, createReviewInput } from "@/lib/crawl/agent-review-contract";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { pageTextShell, renderedPageFailure, renderedPageSuccess, renderedTextMeaningful, RENDERED_PAGE_KEY, RENDERED_PAGE_NOTE,
  shellInputOf, shellRenderState, SHELL_RENDER_ATTEMPTS } from "@/lib/crawl/shell-render";
import { ensureShellRender, resetShellRenderBackoff, shellRenderBackoff } from "@/lib/crawl/jobs/shell-render-document";
import { applyJsShellRequeue, countJsShellRequeue, dryRunJsShellRequeue, JS_SHELL_REQUEUE_ACTION } from "@/lib/crawl/js-shell-requeue";
import { REVIEW_SYSTEM_PROMPT } from "@/lib/crawl/agent-review";
import type { RenderClientResult } from "@/lib/screen-review/render-client";

const now = new Date("2026-11-17T09:00:00.000Z");
const settings = mergeWithDefaults({});
const ENV = { SCREEN_RENDER_URL: "http://100.111.160.31:8791", SCREEN_RENDER_TOKEN: "t".repeat(40) };

const SOWONDEUNG_SHELL = "소원등 | 마음을 담아, 하늘로 날려요 소원등 마음을 담아, 하늘로 날려요 숲속의 밤을 준비하고 있어요...";
const SOWONDEUNG_RENDERED = "탁자에서 소원등을 받아 보세요\n\nWASD / 방향키로 이동 · 탁자를 바라보고 E\n\n소원등\n\n마음을 담아, 하늘로 날려요\n\n숲속의 밤을 준비하고 있어요...";
const MOCHI_SHELL = "모찌펫 · 작은 친구의 큰 모험";
const MOCHI_RENDERED = "Lv.1\n모찌\n토끼\n60/60\nEXP\n0 / 55\n집 앞 마당YARD\n자유 산책\n60\n우리 집\n사냥터 입장\n쓰다듬기\n쉬기\n사냥터\n친구\n상점\n스킬\n기록\n설정\n친구 선택하기\n자동 저장 준비 완료";
const README = "모찌펫은 작은 친구를 키우는 브라우저 RPG 입니다. 산책·사냥·상점·스킬을 지원합니다.";

function documentOf(input: { repo?: string; url?: string; title: string; text: string; meta?: Record<string, unknown> }): CrawlDocument {
  return { id: 7, repo: input.repo ?? "daelong/mochipet-rpg", productUrl: input.url ?? "https://mochipet-rpg.vercel.app", pageStatus: 200,
    repoMeta: { description: "브라우저 펫 RPG", homepage: input.url ?? "https://mochipet-rpg.vercel.app", pushed_at: now.toISOString(),
      stargazers_count: 3, owner: { type: "User" } },
    pageMeta: { title: input.title, textSample: input.text, readmeSample: README, ...input.meta }, fetchedAt: now } as CrawlDocument;
}
const mochi = (meta?: Record<string, unknown>) => documentOf({ title: MOCHI_SHELL, text: MOCHI_SHELL, meta });
const candidateOf = (document: CrawlDocument) => ({ id: 924275, repo: document.repo, productUrl: document.productUrl, state: "needs_review",
  reason: "ambiguous", decidedBy: "auto", judgedAt: now, updatedAt: now, signals: {} }) as unknown as CrawlCandidate;
const withRender = (document: CrawlDocument, meta: ReturnType<typeof renderedPageSuccess>) =>
  ({ ...document, pageMeta: { ...document.pageMeta, [RENDERED_PAGE_KEY]: meta } }) as CrawlDocument;
const ok = (text: string): RenderClientResult => ({ ok: true, finalUrl: "https://mochipet-rpg.vercel.app/", status: 200, text, textLength: text.length,
  jpeg: Buffer.from([0xff, 0xd8, 0xff]), renderMs: 4_671, egress: { requests: 20, bytes: 1_000, blocked: 0 } });

beforeEach(() => {
  vi.clearAllMocks();
  resetShellRenderBackoff();
  mocks.updates.length = 0; mocks.inserts.length = 0; mocks.updateReturns = []; mocks.countRows = [{ count: 0 }]; mocks.holdRows = [];
  // 원본 쓰기는 받은 기록을 page_meta 에 그대로 붙인 원본을 돌려준다(README 와 같은 CAS — 시험에서는 늘 맞다)
  mocks.setRenderedPage.mockImplementation(async (expected: CrawlDocument, rendered: unknown) =>
    ({ ...expected, pageMeta: { ...expected.pageMeta, [RENDERED_PAGE_KEY]: rendered } }));
});

describe("껍데기 판정", () => {
  it("제목·로딩 문구뿐인 본문은 렌더 대상이다", () => {
    expect(pageTextShell(shellInputOf(mochi()))).toBe("title_only");
    expect(pageTextShell(shellInputOf(documentOf({ repo: "hsyo830/sowondeung", url: "https://sowondeung-wish.vercel.app",
      title: "소원등 | 마음을 담아, 하늘로 날려요", text: SOWONDEUNG_SHELL })))).toBe("title_and_loading");
    expect(pageTextShell(shellInputOf(documentOf({ title: "App", text: "Loading..." })))).toBe("loading_only");
    expect(pageTextShell(shellInputOf(documentOf({ title: "App", text: "You need to enable JavaScript to run this app." })))).toBe("javascript_shell");
    expect(pageTextShell(shellInputOf(documentOf({ title: "App", text: "" })))).toBe("empty");
  });

  it("글자가 충분한 본문은 렌더 대상이 아니다", () => {
    const rich = "Find your job before the pile does. Internships first, new-grad jobs too. Every major, pulled straight from each company's own job board.";
    expect(pageTextShell(shellInputOf(documentOf({ title: "Beat the Pile", text: rich })))).toBeNull();
    // 300자를 넘으면 로딩 문구가 섞여 있어도 껍데기가 아니다
    expect(pageTextShell(shellInputOf(documentOf({ title: "Blogify", text: `${"Share your stories with the world. ".repeat(10)} Loading...` })))).toBeNull();
    // 제목 밖 낱말이 4개 이하인 짧은 본문은 거의 빈 화면으로 보고 그려 본다 — 그린 글도 로그인 화면뿐이면 뜻있는 글이 아니다
    const login = shellInputOf(documentOf({ title: "Admin", text: "Sign in Email Password" }));
    expect(pageTextShell(login)).toBe("sparse_text");
    expect(renderedTextMeaningful(login, "Sign in\nEmail\nPassword\nForgot password?")).toBe(false);
    expect(pageTextShell(shellInputOf(documentOf({ title: "Adimat POS", text: "Adimat POS" })))).toBe("title_only");
    // 주소가 없으면(설치형) 그릴 것이 없다
    expect(shellRenderState({ ...mochi(), productUrl: null }).kind).toBe("not_shell");
  });

  it("그린 글이 뜻있는지 — 새 낱말 5개 이상이고 그린 글도 껍데기가 아니어야 한다", () => {
    const input = shellInputOf(mochi());
    expect(renderedTextMeaningful(input, MOCHI_RENDERED)).toBe(true);
    expect(renderedTextMeaningful(input, "")).toBe(false);
    expect(renderedTextMeaningful(input, MOCHI_SHELL)).toBe(false);
    expect(renderedTextMeaningful(input, "Loading…")).toBe(false);
    // 그린 글이 수집 본문보다 새 낱말이 적으면(다른 화면으로 넘어감) 쓰지 않는다
    const richer = { ...input, textSample: "모찌펫 작은 친구의 큰 모험 산책 사냥 상점 스킬 기록 설정 친구 토끼 마당" };
    expect(renderedTextMeaningful(richer, "Sign in to continue with your account today please")).toBe(false);
    expect(renderedTextMeaningful(shellInputOf(documentOf({ repo: "hsyo830/sowondeung", url: "https://sowondeung-wish.vercel.app",
      title: "소원등 | 마음을 담아, 하늘로 날려요", text: SOWONDEUNG_SHELL })), SOWONDEUNG_RENDERED)).toBe(true);
  });
});

describe("심사 입력", () => {
  it("뜻있게 그린 글은 pageText 로 들어가고 출처·예외 문구가 함께 실린다", () => {
    const base = mochi();
    const rendered = withRender(base, renderedPageSuccess(base, { text: MOCHI_RENDERED, textLength: MOCHI_RENDERED.length,
      finalUrl: "https://mochipet-rpg.vercel.app/", status: 200 }, now.getTime()));
    const product = buildReviewProduct(candidateOf(rendered), rendered, settings, now);
    expect(product.pageText).toBe(MOCHI_RENDERED);
    expect(product.renderedPage).toEqual({ source: "browser_render", note: RENDERED_PAGE_NOTE, crawlerPageText: MOCHI_SHELL,
      finalUrl: "https://mochipet-rpg.vercel.app/", renderedAt: now.toISOString() });
    expect(RENDERED_PAGE_NOTE).toContain("the empty-page rule applies to this rendered text, not to the raw HTML");
    // 1차·2차·판가름·감사는 같은 입력(createReviewInput)을 본다 — 그린 글이 입력 해시에 들어가 껍데기 입력과 다르다
    const shellInput = createReviewInput(candidateOf(base), base, settings, { scan: null, observations: [] }, now);
    const renderedInput = createReviewInput(candidateOf(rendered), rendered, settings, { scan: null, observations: [] }, now);
    expect(renderedInput.snapshot.product.pageText).toBe(MOCHI_RENDERED);
    expect(renderedInput.inputHash).not.toBe(shellInput.inputHash);
    // 정책 글은 그대로다 — 빈 화면 규칙은 방문자가 보는 글(pageText)에 걸린다
    expect(REVIEW_SYSTEM_PROMPT).toContain("A page whose visible text is empty or only the product's name or title");
  });

  it("그리지 않은 원본은 입력이 그대로다(renderedPage 칸도 없다)", () => {
    const base = mochi();
    const product = buildReviewProduct(candidateOf(base), base, settings, now);
    expect(product.pageText).toBe(MOCHI_SHELL);
    expect(product).not.toHaveProperty("renderedPage");
  });

  it("렌더 실패·그린 글도 껍데기·다른 껍데기의 기록이면 기존 규칙(수집 본문) 그대로", () => {
    const base = mochi();
    const failed = withRender(base, renderedPageFailure(base, "page_timeout", now.getTime()));
    const empty = withRender(base, renderedPageSuccess(base, { text: "", textLength: 0, finalUrl: null, status: 200 }, now.getTime()));
    const stale = withRender(base, { ...renderedPageSuccess(base, { text: MOCHI_RENDERED, textLength: MOCHI_RENDERED.length, finalUrl: null, status: 200 },
      now.getTime()), shell: "0".repeat(32) });
    for (const document of [failed, empty, stale]) {
      const product = buildReviewProduct(candidateOf(document), document, settings, now);
      expect(product.pageText).toBe(MOCHI_SHELL);
      expect(product).not.toHaveProperty("renderedPage");
    }
    expect(shellRenderState(empty).kind).toBe("rendered_empty");
    expect(shellRenderState(stale).kind).toBe("due");
  });
});

describe("1차 직전 그리기(ensureShellRender)", () => {
  const deadlineAt = () => Date.now() + 60_000;

  it("껍데기를 그려 원본에 붙이고, 그린 글로 심사하게 한다", async () => {
    const render = vi.fn(async () => ok(MOCHI_RENDERED));
    const step = await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render });
    expect(render).toHaveBeenCalledWith("https://mochipet-rpg.vercel.app", expect.objectContaining({ timeoutMs: 45_000 }));
    expect(step.kind).toBe("ready");
    if (step.kind !== "ready") return;
    expect(step.state.kind).toBe("rendered");
    expect(buildReviewProduct(candidateOf(step.document), step.document, settings, now).pageText).toBe(MOCHI_RENDERED);
  });

  it("렌더 실패는 한 번 기다린 뒤 다시 그리고, 두 번 실패하면 기존 규칙대로 수집 본문으로 심사한다", async () => {
    const render = vi.fn(async (): Promise<RenderClientResult> => ({ ok: false, kind: "page", code: "page_timeout" }));
    const first = await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render });
    expect(first).toMatchObject({ kind: "wait", reason: "render_wait" });
    const afterFirst = mocks.setRenderedPage.mock.results[0]!.value as Promise<CrawlDocument>;
    const stored = await afterFirst;
    // 기다리는 동안에는 부르지 않는다
    expect(await ensureShellRender(stored, { deadlineAt: deadlineAt(), env: ENV, render })).toMatchObject({ kind: "wait", reason: "render_wait" });
    expect(render).toHaveBeenCalledTimes(1);
    const later = Date.now() + 11 * 60_000;
    const second = await ensureShellRender(stored, { deadlineAt: later + 60_000, env: ENV, render, now: () => later });
    expect(render).toHaveBeenCalledTimes(2);
    expect(second.kind).toBe("ready");
    if (second.kind !== "ready") return;
    expect(second.state).toMatchObject({ kind: "unavailable", attempts: SHELL_RENDER_ATTEMPTS });
    expect(buildReviewProduct(candidateOf(second.document), second.document, settings, now).pageText).toBe(MOCHI_SHELL);
  });

  it("화면 서버 설정이 없으면 그리지 않고 지금처럼 심사한다", async () => {
    const render = vi.fn(async () => ok(MOCHI_RENDERED));
    const step = await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: {}, render });
    expect(render).not.toHaveBeenCalled();
    expect(step).toMatchObject({ kind: "ready", state: { kind: "due" } });
    if (step.kind === "ready") expect(buildReviewProduct(candidateOf(step.document), step.document, settings, now).pageText).toBe(MOCHI_SHELL);
  });

  it("화면 서버 탈은 물러나고, 물러나는 동안은 부르지 않고 실패로 센다", async () => {
    const render = vi.fn(async (): Promise<RenderClientResult> => ({ ok: false, kind: "outage", code: "render_unreachable" }));
    await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render });
    expect(shellRenderBackoff.retryAt).toBeGreaterThan(Date.now());
    const other = documentOf({ repo: "danielkim614/super-bible-verse-party", url: "https://super-bible-verse-party-614.vercel.app",
      title: "2026 더드림 성경 암송 파티", text: "2026 더드림 성경 암송 파티" });
    expect(await ensureShellRender(other, { deadlineAt: deadlineAt(), env: ENV, render })).toMatchObject({ kind: "wait", reason: "render_wait" });
    expect(render).toHaveBeenCalledTimes(1);
    expect(mocks.setRenderedPage.mock.calls[1]![1]).toMatchObject({ ok: false, code: "render_backoff", attempts: 1 });
  });

  it("틱 끝이 가까우면 그리지 않고 다음 틱으로 미룬다(세지 않는다)", async () => {
    const render = vi.fn(async () => ok(MOCHI_RENDERED));
    expect(await ensureShellRender(mochi(), { deadlineAt: Date.now() + 5_000, env: ENV, render })).toEqual({ kind: "wait", reason: "render_window" });
    expect(render).not.toHaveBeenCalled();
    expect(mocks.setRenderedPage).not.toHaveBeenCalled();
  });

  it("껍데기가 아닌 원본은 부르지 않는다", async () => {
    const render = vi.fn(async () => ok(MOCHI_RENDERED));
    const rich = documentOf({ title: "Beat the Pile", text: "Find your job before the pile does. Internships first, new-grad jobs too, every major." });
    expect(await ensureShellRender(rich, { deadlineAt: deadlineAt(), env: ENV, render })).toMatchObject({ kind: "ready", state: { kind: "not_shell" } });
    expect(render).not.toHaveBeenCalled();
  });
});

describe("재심사 도구(scripts/js-shell-review-requeue.ts)", () => {
  const hold = (id: number, document: CrawlDocument) => ({ id, repo: document.repo, productUrl: document.productUrl, document });
  const rich = documentOf({ repo: "a/rich", url: "https://rich.example", title: "Rich", text: "Track every invoice, send reminders and export reports for your shop." });
  const bible = documentOf({ repo: "danielkim614/super-bible-verse-party", url: "https://super-bible-verse-party-614.vercel.app",
    title: "2026 더드림 성경 암송 파티", text: "2026 더드림 성경 암송 파티" });
  const emptyRendered = withRender(bible, renderedPageSuccess(bible, { text: "", textLength: 0, finalUrl: null, status: 200 }, now.getTime()));

  beforeEach(() => {
    mocks.countRows = [{ count: 3_691 }];
    mocks.holdRows = [hold(1, mochi()), hold(2, rich), hold(3, { ...emptyRendered, repo: "x/empty", productUrl: "https://empty.example" } as CrawlDocument)];
  });

  it("count·dry-run 은 껍데기 유형만 고른다(읽기만)", async () => {
    // x/empty 는 다른 주소로 바꿔 지문이 어긋났다 — 껍데기(제목만)는 맞고 그린 기록은 없는 것으로 본다
    const counts = await countJsShellRequeue();
    expect(counts).toMatchObject({ splitHolds: 3_691, shell: 2, byKind: { title_only: 2 } });
    const dry = await dryRunJsShellRequeue({ limit: 30 });
    expect(dry.sample.map(row => row.repo)).toEqual(["daelong/mochipet-rpg", "x/empty"]);
    expect(dry.sample.map(row => row.repo)).not.toContain("a/rich");
    expect(mocks.inserts).toHaveLength(0);
    expect(mocks.updates).toHaveLength(0);
  });

  it("apply 는 그려서 뜻있는 것만 되돌리고 감사 한 줄을 남긴다", async () => {
    mocks.holdRows = [hold(1, mochi()), hold(2, rich), hold(3, bible)];
    mocks.updateReturns = [{ id: 1 }];
    const render = vi.fn(async (url: string): Promise<RenderClientResult> => url.includes("mochipet") ? ok(MOCHI_RENDERED) : ok(""));
    const result = await applyJsShellRequeue({ limit: 10, actor: "operator", env: ENV, renderDeps: { render } });
    expect(render).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ examined: 2, rendered: 1, renderedEmpty: 1, renderFailed: 0, requeued: 1, render: true });
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0]!.set).toMatchObject({ state: "new", reason: "source_changed", decidedAt: null });
    expect(mocks.inserts).toHaveLength(1);
    expect(mocks.inserts[0]).toMatchObject({ actor: "operator", action: JS_SHELL_REQUEUE_ACTION, target: "crawl_candidates",
      detail: expect.objectContaining({ examined: 2, rendered: 1, requeued: 1 }) });
    expect(mocks.requestJob).toHaveBeenCalledWith("crawl-judge", expect.anything());
  });

  it("--no-render 는 이미 안 될 것(그린 글도 껍데기)만 빼고 되돌리며, 렌더 설정 없이 그리라 하면 거절한다", async () => {
    mocks.holdRows = [hold(1, mochi()), hold(3, emptyRendered)];
    mocks.updateReturns = [{ id: 1 }];
    const result = await applyJsShellRequeue({ limit: 10, actor: "operator", render: false, env: {} });
    expect(result).toMatchObject({ examined: 2, skipped: 1, requeued: 1, render: false });
    expect(mocks.inserts).toHaveLength(1);
    await expect(applyJsShellRequeue({ limit: 10, actor: "operator", env: {} })).rejects.toThrow("js_shell_requeue_render_not_configured");
    await expect(applyJsShellRequeue({ limit: 0, actor: "operator", render: false })).rejects.toThrow("js_shell_requeue_invalid_limit");
  });
});
