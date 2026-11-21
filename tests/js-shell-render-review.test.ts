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
import { pageTextShell, renderedPageFailure, renderedPageSuccess, renderedTextMeaningful, renderStayedOnSite, RENDERED_PAGE_KEY, RENDERED_PAGE_NOTE,
  reviewRenderedPage, shellInputOf, shellRenderState, SHELL_RENDER_ATTEMPTS, SHELL_RENDER_COOLDOWN_MS, SHELL_RENDER_MAX_AGE_MS } from "@/lib/crawl/shell-render";
import { ensureShellRender, resetShellRenderBackoff, shellRenderBackoff, shellRenderEnabled, SHELL_RENDER_BUSY_PAUSE_MS, SHELL_RENDER_REQUEST_MS,
  SHELL_RENDER_WAIT_MAX_MS } from "@/lib/crawl/jobs/shell-render-document";
import { applyJsShellRequeue, countJsShellRequeue, dryRunJsShellRequeue, JS_SHELL_REQUEUE_ACTION } from "@/lib/crawl/js-shell-requeue";
import { setRuntimeSettingsForTest } from "@/lib/operations/runtime-settings-store";
import { resolveRuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { readFileSync } from "node:fs";
import { REVIEW_SYSTEM_PROMPT } from "@/lib/crawl/agent-review";
import type { RenderClientResult } from "@/lib/screen-review/render-client";

const now = new Date("2026-11-17T09:00:00.000Z");
const settings = mergeWithDefaults({});
const ENV = { SCREEN_RENDER_URL: "http://100.64.0.9:8791", SCREEN_RENDER_TOKEN: "t".repeat(40) };

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
  setRuntimeSettingsForTest(null);
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
    // 그린 시각은 입력에 싣지 않는다 — 나이가 차 다시 그려도 글이 같으면 입력 해시가 같다
    expect(product.renderedPage).toEqual({ source: "browser_render", note: RENDERED_PAGE_NOTE, crawlerPageText: MOCHI_SHELL,
      finalUrl: "https://mochipet-rpg.vercel.app/" });
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
  const outage = (code = "render_unreachable") => vi.fn(async (): Promise<RenderClientResult> => ({ ok: false, kind: "outage", code }));
  const bible = () => documentOf({ repo: "danielkim614/super-bible-verse-party", url: "https://super-bible-verse-party-614.vercel.app",
    title: "2026 더드림 성경 암송 파티", text: "2026 더드림 성경 암송 파티" });

  it("껍데기를 그려 원본에 붙이고, 그린 글로 심사하게 한다", async () => {
    const render = vi.fn(async () => ok(MOCHI_RENDERED));
    const step = await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render });
    expect(render).toHaveBeenCalledWith("https://mochipet-rpg.vercel.app", expect.objectContaining({ timeoutMs: SHELL_RENDER_REQUEST_MS }));
    expect(step.kind).toBe("ready");
    if (step.kind !== "ready") return;
    expect(step.state.kind).toBe("rendered");
    expect(buildReviewProduct(candidateOf(step.document), step.document, settings, now).pageText).toBe(MOCHI_RENDERED);
  });

  it("페이지 실패는 10분 뒤 다시 그리고, 두 번이면 수집 본문으로 심사하며, 24시간 뒤 새 바퀴로 다시 그린다", async () => {
    const render = vi.fn(async (): Promise<RenderClientResult> => ({ ok: false, kind: "page", code: "page_timeout" }));
    const first = await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render });
    expect(first).toMatchObject({ kind: "wait", reason: "render_wait" });
    const stored = await (mocks.setRenderedPage.mock.results[0]!.value as Promise<CrawlDocument>);
    expect(stored.pageMeta?.[RENDERED_PAGE_KEY]).toMatchObject({ ok: false, code: "page_timeout", attempts: 1 });
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
    // 쉬는 동안(24시간)은 부르지 않고 지금 원본으로 — 지나면 새 바퀴(시도 1)로 다시 그린다
    expect(await ensureShellRender(second.document, { deadlineAt: later + 3_600_000, env: ENV, render, now: () => later + 3_600_000 }))
      .toMatchObject({ kind: "ready", state: { kind: "unavailable" } });
    expect(render).toHaveBeenCalledTimes(2);
    const nextDay = Date.now() + SHELL_RENDER_COOLDOWN_MS + 60_000;
    expect(shellRenderState(second.document, nextDay)).toEqual({ kind: "due", attempts: 0 });
    render.mockResolvedValueOnce(ok(MOCHI_RENDERED));
    const revived = await ensureShellRender(second.document, { deadlineAt: nextDay + 60_000, env: ENV, render, now: () => nextDay });
    expect(revived).toMatchObject({ kind: "ready", state: { kind: "rendered" } });
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("새 바퀴의 첫 실패는 시도 1부터 센다", () => {
    const base = mochi();
    const failure = renderedPageFailure(base, "page_http_500", now.getTime()) as Extract<ReturnType<typeof renderedPageFailure>, { ok: false }>;
    const exhausted = withRender(base, { ...failure, attempts: SHELL_RENDER_ATTEMPTS });
    const again = renderedPageFailure(exhausted, "page_http_500", now.getTime() + SHELL_RENDER_COOLDOWN_MS + 1);
    expect(again).toMatchObject({ ok: false, attempts: 1, since: now.getTime() + SHELL_RENDER_COOLDOWN_MS + 1 });
  });

  it("화면 서버 설정이 없으면 그리지 않고 지금처럼 심사한다", async () => {
    const render = vi.fn(async () => ok(MOCHI_RENDERED));
    const step = await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: {}, render });
    expect(render).not.toHaveBeenCalled();
    expect(step).toMatchObject({ kind: "ready", state: { kind: "due" }, skipped: "not_configured" });
    if (step.kind === "ready") expect(buildReviewProduct(candidateOf(step.document), step.document, settings, now).pageText).toBe(MOCHI_SHELL);
  });

  it("화면 서버 탈은 프로세스를 물러나게 하되 후보의 시도로 세지 않고 적지도 않는다", async () => {
    const render = outage();
    expect(await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render }))
      .toMatchObject({ kind: "wait", reason: "render_deferred", code: "render_unreachable" });
    expect(shellRenderBackoff).toMatchObject({ failures: 1 });
    expect(shellRenderBackoff.retryAt).toBeGreaterThan(Date.now());
    // 물러나는 동안 다른 후보는 부르지도 적지도 않는다(시도를 깎지 않는다)
    expect(await ensureShellRender(bible(), { deadlineAt: deadlineAt(), env: ENV, render }))
      .toMatchObject({ kind: "wait", reason: "render_deferred", code: "render_backoff" });
    expect(render).toHaveBeenCalledTimes(1);
    expect(mocks.setRenderedPage).not.toHaveBeenCalled();
    // 서버가 돌아오면 바로 그린다 — 물러나기는 성공으로 풀린다
    const back = Date.now() + 2 * 60_000;
    render.mockResolvedValueOnce(ok(MOCHI_RENDERED));
    expect(await ensureShellRender(mochi(), { deadlineAt: back + 60_000, env: ENV, render, now: () => back }))
      .toMatchObject({ kind: "ready", state: { kind: "rendered" } });
    expect(shellRenderBackoff).toEqual({ failures: 0, retryAt: 0 });
  });

  it("우리 쪽 사정의 기다림은 1시간까지 — 넘으면 지금 원본으로 심사하고, 그 뒤에도 그릴 수 있으면 그린다", async () => {
    const render = outage();
    const start = Date.now();
    expect(await ensureShellRender(mochi(), { deadlineAt: start + 60_000, env: ENV, render, now: () => start })).toMatchObject({ kind: "wait" });
    const halfway = start + 30 * 60_000;
    shellRenderBackoff.retryAt = 0;
    expect(await ensureShellRender(mochi(), { deadlineAt: halfway + 60_000, env: ENV, render, now: () => halfway })).toMatchObject({ kind: "wait" });
    const late = start + SHELL_RENDER_WAIT_MAX_MS;
    shellRenderBackoff.retryAt = 0;
    const expired = await ensureShellRender(mochi(), { deadlineAt: late + 60_000, env: ENV, render, now: () => late });
    expect(expired).toMatchObject({ kind: "ready", state: { kind: "due" }, skipped: "wait_expired", code: "render_unreachable" });
    if (expired.kind === "ready") expect(buildReviewProduct(candidateOf(expired.document), expired.document, settings, now).pageText).toBe(MOCHI_SHELL);
    expect(mocks.setRenderedPage).not.toHaveBeenCalled();
    // 다른 후보의 기다림은 따로 센다
    shellRenderBackoff.retryAt = 0;
    expect(await ensureShellRender(bible(), { deadlineAt: late + 60_000, env: ENV, render, now: () => late })).toMatchObject({ kind: "wait" });
    // 서버가 돌아오면 기다림이 끝난 후보도 그린다
    shellRenderBackoff.retryAt = 0;
    render.mockResolvedValueOnce(ok(MOCHI_RENDERED));
    expect(await ensureShellRender(mochi(), { deadlineAt: late + 120_000, env: ENV, render, now: () => late + 60_000 }))
      .toMatchObject({ kind: "ready", state: { kind: "rendered" } });
  });

  it("붐빔(429)은 세지 않고 적지 않으며, 잠깐 쉬는 동안 다른 후보를 부르지 않는다", async () => {
    const render = vi.fn(async (): Promise<RenderClientResult> => ({ ok: false, kind: "busy", code: "render_busy" }));
    expect(await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render })).toMatchObject({ kind: "wait", reason: "render_deferred",
      code: "render_busy" });
    expect(shellRenderBackoff.failures).toBe(0);
    expect(shellRenderBackoff.retryAt).toBeGreaterThan(Date.now() + SHELL_RENDER_BUSY_PAUSE_MS - 1_000);
    expect(await ensureShellRender(bible(), { deadlineAt: deadlineAt(), env: ENV, render })).toMatchObject({ kind: "wait", code: "render_backoff" });
    expect(render).toHaveBeenCalledTimes(1);
    expect(mocks.setRenderedPage).not.toHaveBeenCalled();
  });

  it("틱 끝 때문에 줄인 상한의 시간 초과는 물러나기를 켜지 않고, 온전한 상한의 시간 초과만 서버 탈로 본다", async () => {
    const render = outage("render_timeout");
    // 남은 시간 20초 — 상한을 줄여 불렀다
    expect(await ensureShellRender(mochi(), { deadlineAt: Date.now() + 20_000, env: ENV, render }))
      .toMatchObject({ kind: "wait", reason: "render_window", code: "render_timeout_shortened" });
    expect(((render.mock.calls[0] as unknown[])[1] as { timeoutMs: number }).timeoutMs).toBeLessThan(SHELL_RENDER_REQUEST_MS);
    expect(shellRenderBackoff).toEqual({ failures: 0, retryAt: 0 });
    expect(mocks.setRenderedPage).not.toHaveBeenCalled();
    // 다른 후보는 곧바로 그릴 수 있다
    expect(await ensureShellRender(bible(), { deadlineAt: deadlineAt(), env: ENV, render })).toMatchObject({ kind: "wait", reason: "render_deferred" });
    expect(render).toHaveBeenCalledTimes(2);
    expect(shellRenderBackoff.failures).toBe(1);
  });

  it("취소(틱 끝·워커 멈춤)는 적지 않고 다음 틱에", async () => {
    const render = vi.fn(async (): Promise<RenderClientResult> => ({ ok: false, kind: "busy", code: "render_cancelled" }));
    expect(await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render })).toMatchObject({ kind: "wait", reason: "render_window" });
    expect(shellRenderBackoff).toEqual({ failures: 0, retryAt: 0 });
    expect(mocks.setRenderedPage).not.toHaveBeenCalled();
  });

  it("페이지 실패는 서버가 살아 있다는 뜻이라 연속 탈 수를 푼다", async () => {
    shellRenderBackoff.failures = 3;
    const render = vi.fn(async (): Promise<RenderClientResult> => ({ ok: false, kind: "page", code: "page_http_404" }));
    await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render });
    expect(shellRenderBackoff.failures).toBe(0);
  });

  it("틱 끝이 가까우면 그리지 않고 다음 틱으로 미룬다(세지 않는다)", async () => {
    const render = vi.fn(async () => ok(MOCHI_RENDERED));
    expect(await ensureShellRender(mochi(), { deadlineAt: Date.now() + 5_000, env: ENV, render }))
      .toEqual({ kind: "wait", reason: "render_window", code: "render_window" });
    expect(render).not.toHaveBeenCalled();
    expect(mocks.setRenderedPage).not.toHaveBeenCalled();
  });

  it("껍데기가 아닌 원본은 부르지 않는다", async () => {
    const render = vi.fn(async () => ok(MOCHI_RENDERED));
    const rich = documentOf({ title: "Beat the Pile", text: "Find your job before the pile does. Internships first, new-grad jobs too, every major." });
    expect(await ensureShellRender(rich, { deadlineAt: deadlineAt(), env: ENV, render })).toMatchObject({ kind: "ready", state: { kind: "not_shell" } });
    expect(render).not.toHaveBeenCalled();
  });

  it("스팸 의심은 m1 에서 그리지 않고, 부르는 쪽 규칙 관문이 까닭을 주면 그리지 않는다", async () => {
    const render = vi.fn(async () => ok(MOCHI_RENDERED));
    // 프로드 /p/codex-deepseek 를 줄인 것(tests/integration/spam-gate.test.ts) — 본문이 비어 껍데기이고 README 가 캠페인 꼴이다
    const spam = { ...documentOf({ repo: "Promisedlandsubtraction2856/codex-deepseek", url: "https://promisedlandsubtraction2856.github.io",
      title: "codex-deepseek", text: "", meta: { readmeSample: "🤖 codex-deepseek - Run Codex on DeepSeek Models\n\n"
        + "1. **Download** – Visit this link to download the application: https://promisedlandsubtraction2856.github.io" } }),
      repoMeta: { name: "codex-deepseek", owner: { login: "Promisedlandsubtraction2856", type: "User" }, stargazers_count: 1, has_issues: false,
        description: "Run the real OpenAI Codex CLI on DeepSeek models.", pushed_at: now.toISOString() } } as CrawlDocument;
    expect(shellRenderState(spam).kind).toBe("due");
    const gate = vi.fn(async () => null);
    expect(await ensureShellRender(spam, { deadlineAt: deadlineAt(), env: ENV, render, gate })).toMatchObject({ kind: "ready", skipped: "suspected_spam" });
    expect(gate).not.toHaveBeenCalled();
    const ruled = await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render, gate: async () => "rule_fork" });
    expect(ruled).toMatchObject({ kind: "ready", state: { kind: "due" }, skipped: "rule_fork" });
    expect(render).not.toHaveBeenCalled();
    // 관문이 통과시키면 그린다
    expect(await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render, gate })).toMatchObject({ state: { kind: "rendered" } });
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("끄는 스위치(실시간 한도) — 새로 그리지 않고, 이미 그린 글은 입력에 그대로 쓴다", async () => {
    const render = vi.fn(async () => ok(MOCHI_RENDERED));
    expect(shellRenderEnabled()).toBe(true);
    setRuntimeSettingsForTest({ version: 1, jobs: { "crawl-agent-review": { shellRender: 0 } } });
    expect(shellRenderEnabled()).toBe(false);
    expect(await ensureShellRender(mochi(), { deadlineAt: deadlineAt(), env: ENV, render })).toMatchObject({ kind: "ready", skipped: "switched_off" });
    expect(render).not.toHaveBeenCalled();
    const base = mochi();
    const rendered = withRender(base, renderedPageSuccess(base, { text: MOCHI_RENDERED, textLength: MOCHI_RENDERED.length,
      finalUrl: "https://mochipet-rpg.vercel.app/", status: 200 }, now.getTime()));
    const before = createReviewInput(candidateOf(rendered), rendered, settings, { scan: null, observations: [] }, now);
    expect(await ensureShellRender(rendered, { deadlineAt: deadlineAt(), env: ENV, render })).toMatchObject({ kind: "ready", state: { kind: "rendered" } });
    expect(createReviewInput(candidateOf(rendered), rendered, settings, { scan: null, observations: [] }, now).inputHash).toBe(before.inputHash);
    expect(before.snapshot.product.pageText).toBe(MOCHI_RENDERED);
    // 저장 문서의 범위 — 0·1 만
    expect(resolveRuntimeSettings({ version: 1, jobs: { "crawl-agent-review": { shellRender: 2 } } }).issues)
      .toContain("runtime_settings_invalid:jobs.crawl-agent-review.shellRender");
    setRuntimeSettingsForTest(null);
    expect(shellRenderEnabled()).toBe(true);
  });

  it("감사 화면 판별은 그리기 스위치를 읽지 않는다(끄기가 감사 쪽을 함께 끄지 않는다)", () => {
    const source = readFileSync("lib/screen-review/job.ts", "utf8") + readFileSync("lib/crawl/audit-screen-review.ts", "utf8");
    expect(source).not.toMatch(/shellRender|shell-render-document/);
  });
});

describe("그린 글의 나이·다른 사이트", () => {
  const base = mochi();
  const success = (at: number, text = MOCHI_RENDERED, finalUrl: string | null = "https://mochipet-rpg.vercel.app/") =>
    withRender(base, renderedPageSuccess(base, { text, textLength: text.length, finalUrl, status: 200 }, at));

  it("7일이 지난 그린 글은 1차가 다시 그린다 — 입력은 다시 그릴 때까지 그 글을 쓰고, 글이 같으면 입력 해시가 같다", async () => {
    const old = success(now.getTime());
    const later = now.getTime() + SHELL_RENDER_MAX_AGE_MS + 1;
    expect(shellRenderState(old, now.getTime() + SHELL_RENDER_MAX_AGE_MS - 1).kind).toBe("rendered");
    expect(shellRenderState(old, later)).toEqual({ kind: "due", attempts: 0, stale: true });
    expect(reviewRenderedPage(old)?.pageText).toBe(MOCHI_RENDERED);
    const before = createReviewInput(candidateOf(old), old, settings, { scan: null, observations: [] }, now);
    const render = vi.fn(async () => ok(MOCHI_RENDERED));
    const step = await ensureShellRender(old, { deadlineAt: later + 60_000, env: ENV, render, now: () => later });
    expect(render).toHaveBeenCalledTimes(1);
    expect(step).toMatchObject({ kind: "ready", state: { kind: "rendered" } });
    if (step.kind !== "ready") return;
    expect(step.document.pageMeta?.[RENDERED_PAGE_KEY]).toMatchObject({ at: new Date(later).toISOString() });
    expect(createReviewInput(candidateOf(step.document), step.document, settings, { scan: null, observations: [] }, now).inputHash).toBe(before.inputHash);
  });

  it("다시 그린 글이 바뀌면 입력 해시가 바뀐다(기존 재심사 흐름)", () => {
    const changed = success(now.getTime(), `${MOCHI_RENDERED}\n새 기능 펫 상점 이벤트 공지 추가 안내`);
    expect(createReviewInput(candidateOf(changed), changed, settings, { scan: null, observations: [] }, now).inputHash)
      .not.toBe(createReviewInput(candidateOf(success(now.getTime())), success(now.getTime()), settings, { scan: null, observations: [] }, now).inputHash);
  });

  it("JS 가 다른 사이트로 넘긴 화면의 글은 제품의 글로 쓰지 않는다", () => {
    expect(renderStayedOnSite("https://mochi.example", "https://www.mochi.example/home")).toBe(true);
    expect(renderStayedOnSite("https://mochi.example", "https://app.mochi.example/")).toBe(true);
    expect(renderStayedOnSite("https://www.mochi.example", "https://mochi.example/")).toBe(true);
    expect(renderStayedOnSite("https://mochi.example", null)).toBe(true);
    expect(renderStayedOnSite("https://mochi.example", "https://accounts.google.com/signin")).toBe(false);
    expect(renderStayedOnSite("https://mochi-rpg.vercel.app", "https://vercel.app/")).toBe(false);
    expect(renderStayedOnSite("https://mochi-rpg.vercel.app", "https://other-app.vercel.app/")).toBe(false);
    const offsite = success(now.getTime(), MOCHI_RENDERED, "https://marketplace.example/listing/42");
    expect(shellRenderState(offsite, now.getTime())).toEqual({ kind: "rendered_offsite", finalUrl: "https://marketplace.example/listing/42" });
    expect(reviewRenderedPage(offsite)).toBeNull();
    const product = buildReviewProduct(candidateOf(offsite), offsite, settings, now);
    expect(product.pageText).toBe(MOCHI_SHELL);
    expect(product).not.toHaveProperty("renderedPage");
  });
});

describe("재심사 도구(scripts/js-shell-review-requeue.ts)", () => {
  const hold = (id: number, document: CrawlDocument) => ({ id, repo: document.repo, productUrl: document.productUrl, document });
  const rich = documentOf({ repo: "a/rich", url: "https://rich.example", title: "Rich", text: "Track every invoice, send reminders and export reports for your shop." });
  const bible = documentOf({ repo: "danielkim614/super-bible-verse-party", url: "https://super-bible-verse-party-614.vercel.app",
    title: "2026 더드림 성경 암송 파티", text: "2026 더드림 성경 암송 파티" });
  const emptyRendered = withRender(bible, renderedPageSuccess(bible, { text: "", textLength: 0, finalUrl: null, status: 200 }, Date.now()));
  const on = async () => "on" as const;
  const shellDoc = (n: number) => documentOf({ repo: `shell/app-${n}`, url: `https://app-${n}.example`, title: `App ${n}`, text: `App ${n}` });

  beforeEach(() => {
    mocks.countRows = [{ count: 3_691 }];
    mocks.holdRows = [hold(1, mochi()), hold(2, rich), hold(3, { ...emptyRendered, repo: "x/empty", productUrl: "https://empty.example" } as CrawlDocument)];
  });

  it("count·dry-run 은 껍데기 유형만 고르고, 스위치·설정 여부와 상태 설명을 싣는다(읽기만)", async () => {
    // x/empty 는 다른 주소로 바꿔 지문이 어긋났다 — 껍데기(제목만)는 맞고 그린 기록은 없는 것으로 본다
    const counts = await countJsShellRequeue({ env: ENV, readSwitch: on });
    expect(counts).toMatchObject({ readOnly: true, splitHolds: 3_691, shell: 2, byKind: { title_only: 2 }, byRenderState: { due: 2 },
      alreadyRendered: 0, requeueableWithoutRender: 2, renderSwitch: "on", renderConfigured: true });
    expect(counts.legend).toHaveProperty("rendered_offsite");
    expect(JSON.stringify(counts)).not.toContain(ENV.SCREEN_RENDER_TOKEN);
    expect(await countJsShellRequeue({ env: {}, readSwitch: async () => "off" })).toMatchObject({ renderSwitch: "off", renderConfigured: false });
    const dry = await dryRunJsShellRequeue({ limit: 30, env: ENV, readSwitch: on });
    expect(dry.sample.map(row => [row.repo, row.noRenderApply])).toEqual([["daelong/mochipet-rpg", "requeue"], ["x/empty", "requeue"]]);
    expect(dry.applyBounds).toMatchObject({ maxLimit: 1_000, batchDefault: 25, batchMax: 100, intervalDefaultMs: 2_000 });
    expect(mocks.inserts).toHaveLength(0);
    expect(mocks.updates).toHaveLength(0);
    expect(mocks.setRenderedPage).not.toHaveBeenCalled();
  });

  it("apply 는 그려서 뜻있는 것만 되돌리고 커밋마다 감사 한 줄을 남긴다", async () => {
    mocks.holdRows = [hold(1, mochi()), hold(2, rich), hold(3, bible)];
    mocks.updateReturns = [{ id: 1 }];
    const render = vi.fn(async (url: string): Promise<RenderClientResult> => url.includes("mochipet") ? ok(MOCHI_RENDERED) : ok(""));
    const sleep = vi.fn(async () => {});
    const result = await applyJsShellRequeue({ limit: 10, actor: "operator", env: ENV, renderDeps: { render }, readSwitch: on, sleep });
    expect(render).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(result).toMatchObject({ examined: 2, rendered: 1, renderedEmpty: 1, renderFailed: 0, renderDeferred: 0, requeued: 1, render: true, parts: 1 });
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0]!.set).toMatchObject({ state: "new", reason: "source_changed", decidedAt: null });
    expect(mocks.inserts).toHaveLength(1);
    expect(mocks.inserts[0]).toMatchObject({ actor: "operator", action: JS_SHELL_REQUEUE_ACTION, target: "crawl_candidates",
      detail: expect.objectContaining({ runId: result.runId, part: 1, final: true, examined: 2, rendered: 1, requeued: 1, batch: 25, intervalMs: 2_000 }) });
    expect(mocks.requestJob).toHaveBeenCalledWith("crawl-judge", expect.anything());
  });

  it("apply 는 batch 건마다 커밋하고, 되돌린 것이 없어도 마지막 감사 줄을 남긴다", async () => {
    mocks.holdRows = [1, 2, 3, 4, 5].map(n => hold(n, shellDoc(n)));
    mocks.updateReturns = [{ id: 1 }, { id: 2 }];
    const text = "대시보드 주문 목록 재고 관리 보고서 내보내기 설정 도움말";
    const render = vi.fn(async (url: string): Promise<RenderClientResult> => ({ ok: true, finalUrl: `${url}/`, status: 200, text, textLength: text.length,
      jpeg: Buffer.from([0xff, 0xd8, 0xff]), renderMs: 1, egress: { requests: 1, bytes: 1, blocked: 0 } }));
    const result = await applyJsShellRequeue({ limit: 5, actor: "operator", env: ENV, batch: 2, intervalMs: 0, renderDeps: { render }, readSwitch: on });
    expect(result).toMatchObject({ examined: 5, rendered: 5, parts: 3 });
    expect(mocks.inserts.map(row => (row.detail as { part: number; final: boolean; partIds: number }))
      .map(detail => [detail.part, detail.final, detail.partIds])).toEqual([[1, false, 2], [2, false, 2], [3, true, 1]]);
    mocks.inserts.length = 0;
    mocks.holdRows = [];
    expect(await applyJsShellRequeue({ limit: 5, actor: "operator", env: ENV, readSwitch: on })).toMatchObject({ examined: 0, requeued: 0, parts: 1 });
    expect(mocks.inserts).toHaveLength(1);
  });

  it("apply 는 화면 서버 탈이 이어지면 멈추고, 미룬 것은 되돌리지 않는다", async () => {
    mocks.holdRows = [1, 2, 3, 4, 5].map(n => hold(n, shellDoc(n)));
    const render = vi.fn(async (): Promise<RenderClientResult> => ({ ok: false, kind: "outage", code: "render_unreachable" }));
    const result = await applyJsShellRequeue({ limit: 5, actor: "operator", env: ENV, intervalMs: 0, renderDeps: { render }, readSwitch: on });
    expect(result).toMatchObject({ examined: 3, renderDeferred: 3, requeued: 0, stoppedEarly: "render_server_unavailable" });
    expect(render).toHaveBeenCalledTimes(1);
    expect(mocks.setRenderedPage).not.toHaveBeenCalled();
    expect(mocks.inserts[0]).toMatchObject({ detail: expect.objectContaining({ final: true, stoppedEarly: "render_server_unavailable" }) });
  });

  it("--no-render 는 이미 안 될 것(그린 글도 껍데기)만 빼고 되돌리며, 렌더 설정·스위치·범위를 지킨다", async () => {
    mocks.holdRows = [hold(1, mochi()), hold(3, emptyRendered)];
    mocks.updateReturns = [{ id: 1 }];
    const result = await applyJsShellRequeue({ limit: 10, actor: "operator", render: false, env: {}, readSwitch: on });
    expect(result).toMatchObject({ examined: 2, skipped: 1, requeued: 1, render: false });
    expect(mocks.inserts).toHaveLength(1);
    await expect(applyJsShellRequeue({ limit: 10, actor: "operator", env: {}, readSwitch: on })).rejects.toThrow("js_shell_requeue_render_not_configured");
    await expect(applyJsShellRequeue({ limit: 10, actor: "operator", render: false, readSwitch: async () => "off" }))
      .rejects.toThrow("js_shell_requeue_render_switched_off");
    await expect(applyJsShellRequeue({ limit: 10, actor: "operator", render: false, readSwitch: async () => "unreadable" }))
      .rejects.toThrow("js_shell_requeue_switch_unreadable");
    await expect(applyJsShellRequeue({ limit: 0, actor: "operator", render: false, readSwitch: on })).rejects.toThrow("js_shell_requeue_invalid_limit");
    await expect(applyJsShellRequeue({ limit: 1_001, actor: "operator", render: false, readSwitch: on })).rejects.toThrow("js_shell_requeue_invalid_limit");
    await expect(applyJsShellRequeue({ limit: 10, actor: "operator", batch: 101, readSwitch: on })).rejects.toThrow("js_shell_requeue_invalid_batch");
    await expect(applyJsShellRequeue({ limit: 10, actor: "operator", intervalMs: 60_001, readSwitch: on })).rejects.toThrow("js_shell_requeue_invalid_interval");
    expect(mocks.inserts).toHaveLength(1);
  });
});
