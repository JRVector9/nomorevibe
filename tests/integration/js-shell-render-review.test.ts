import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, operationsAudit } from "@/lib/db/schema";
import { dequeueWithAdmission, enqueue, getDocument, saveFetchedDocument } from "@/lib/crawl/repository";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { ensureShellRender, resetShellRenderBackoff } from "@/lib/crawl/jobs/shell-render-document";
import { applyJsShellRequeue, countJsShellRequeue, dryRunJsShellRequeue, JS_SHELL_REQUEUE_ACTION, readShellRenderSwitch } from "@/lib/crawl/js-shell-requeue";
import { RENDERED_PAGE_KEY, SHELL_RENDER_ATTEMPTS, SHELL_RENDER_MAX_AGE_MS, shellRenderState } from "@/lib/crawl/shell-render";
import { readRuntimeSettingsRow, saveRuntimeSettings } from "@/lib/operations/runtime-settings";
import type { RenderClientResult } from "@/lib/screen-review/render-client";
import { ensureSchema } from "./setup";
import { claimFetchFixtureJob } from "./fetch-fixtures";

/**
 * JS 앱 껍데기 렌더(2026-11-17)의 DB 쪽 — 그린 기록 쓰기는 README 와 같은 원본 판 대조(마이크로초 fetched_at 에서도 맞아야 한다),
 * 다시 수집은 껍데기가 그대로면 그린 기록을 옮기고 후보를 new 로 되돌리지 않는다, 재심사 도구는 껍데기 갈림 보류만 고르고 감사 한 줄을 남긴다.
 */
const ENV = { SCREEN_RENDER_URL: "http://render.test:8791", SCREEN_RENDER_TOKEN: "t".repeat(40) };
const SHELL = "모찌펫 · 작은 친구의 큰 모험";
const RENDERED = "Lv.1 모찌 토끼 60/60 EXP 집 앞 마당 자유 산책 우리 집 사냥터 입장 쓰다듬기 쉬기 친구 상점 스킬 기록 설정 친구 선택하기 자동 저장 준비 완료";
const ok = (text: string): RenderClientResult => ({ ok: true, finalUrl: "https://mochi.example/", status: 200, text, textLength: text.length,
  jpeg: Buffer.from([0xff, 0xd8, 0xff]), renderMs: 10, egress: { requests: 1, bytes: 1, blocked: 0 } });

async function clean() {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
}
// operations_audit 는 지울 수 없다(append-only) — 이 실행의 actor 로만 센다
const ACTOR = `integration-${randomUUID().slice(0, 8)}`;
beforeAll(() => ensureSchema());
beforeEach(async () => { resetShellRenderBackoff(); await clean(); });
afterAll(clean);

/** saveFetchedDocument 처럼 fetched_at 을 DB 시계(마이크로초)로 쓴다 */
async function seed(repo: string, productUrl: string, text: string, candidate: Partial<typeof crawlCandidates.$inferInsert> = {}) {
  await db.insert(crawlDocuments).values({ repo, productUrl, pageStatus: 200, pageMeta: { title: text.length < 40 ? text : "Tool", textSample: text, readmeSample: "README" },
    repoMeta: { stargazers_count: 3, description: "tool" }, fetchedAt: sql`date_trunc('milliseconds', clock_timestamp()) + interval '456 microseconds'` } as never);
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "needs_review", reason: "second_review_split", decidedBy: "auto",
    judgedAt: new Date(), ...candidate }).returning();
  return row;
}

it("attaches the rendered text to a microsecond document and the review input uses it", async () => {
  const candidate = await seed("daelong/mochipet-rpg", "https://mochi.example", SHELL, { state: "needs_review", reason: "ambiguous" });
  const step = await ensureShellRender((await getDocument(candidate.repo))!, { deadlineAt: Date.now() + 60_000, env: ENV, render: async () => ok(RENDERED) });
  expect(step).toMatchObject({ kind: "ready", state: { kind: "rendered" } });
  const stored = await getDocument(candidate.repo);
  expect(stored?.pageMeta?.[RENDERED_PAGE_KEY]).toMatchObject({ ok: true, text: RENDERED });
  const input = await loadReviewInput(candidate, stored!, mergeWithDefaults({}));
  expect(input.snapshot.product.pageText).toBe(RENDERED);
  expect(input.snapshot.product.renderedPage).toMatchObject({ source: "browser_render", crawlerPageText: SHELL });
});

it("a recrawl with the same shell carries the render and does not reopen the candidate; a changed page drops it", async () => {
  const repo = "acme/shell-app";
  const candidate = await seed(repo, "https://shell.example", SHELL, { state: "approved", reason: "passed" });
  await ensureShellRender((await getDocument(repo))!, { deadlineAt: Date.now() + 60_000, env: ENV, render: async () => ok(RENDERED) });
  const before = await getDocument(repo);
  const refetch = async (pageMeta: Record<string, unknown>) => {
    await db.delete(crawlFrontier);
    await enqueue([{ repo, signal: "commit-trailer" }]);
    const claimed = await dequeueWithAdmission(1, undefined, await claimFetchFixtureJob());
    expect(claimed.kind).toBe("ready");
    const claim = claimed.kind === "ready" ? claimed.entries[0] : undefined;
    expect(claim).toBeDefined();
    expect(await saveFetchedDocument(claim!, { repo, repoMeta: before!.repoMeta, productUrl: "https://shell.example", pageStatus: 200, pageMeta })).not.toBeNull();
  };
  await refetch({ title: SHELL, textSample: SHELL, readmeSample: "README" });
  expect((await getDocument(repo))?.pageMeta?.[RENDERED_PAGE_KEY]).toEqual(before?.pageMeta?.[RENDERED_PAGE_KEY]);
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id)))[0].state).toBe("approved");
  await refetch({ title: SHELL, textSample: `${SHELL} 새 화면`, readmeSample: "README" });
  expect((await getDocument(repo))?.pageMeta).not.toHaveProperty(RENDERED_PAGE_KEY);
});

it("count/dry-run pick only shell split holds and apply requeues rendered ones with one audit row", async () => {
  const shell = await seed("daelong/mochipet-rpg", "https://mochi.example", SHELL);
  const empty = await seed("x/empty-app", "https://empty.example", "Empty App");
  await seed("a/rich-app", "https://rich.example", "Track every invoice, send reminders and export monthly reports for your shop and team.");
  await seed("b/other-hold", "https://other.example", SHELL, { reason: "no_description" });
  await seed("c/human", "https://human.example", SHELL, { decidedBy: "admin" });
  expect(await countJsShellRequeue()).toMatchObject({ splitHolds: 3, shell: 2, byRenderState: { due: 2 } });
  expect((await dryRunJsShellRequeue({ limit: 30 })).sample.map(row => row.id)).toEqual([shell.id, empty.id]);
  expect(await db.select().from(operationsAudit).where(and(eq(operationsAudit.action, JS_SHELL_REQUEUE_ACTION), eq(operationsAudit.actor, ACTOR)))).toHaveLength(0);

  const result = await applyJsShellRequeue({ limit: 10, actor: ACTOR, env: ENV, intervalMs: 0,
    renderDeps: { render: async (url: string) => ok(url.includes("mochi") ? RENDERED : "") } });
  expect(result).toMatchObject({ examined: 2, rendered: 1, renderedEmpty: 1, requeued: 1 });
  const rows = await db.select().from(crawlCandidates).where(eq(crawlCandidates.reason, "source_changed"));
  expect(rows.map(row => [row.id, row.state])).toEqual([[shell.id, "new"]]);
  expect(rows[0].signals).toMatchObject({ shellRenderRequeue: { actor: ACTOR } });
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, empty.id)))[0]).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  const audit = await db.select().from(operationsAudit).where(and(eq(operationsAudit.action, JS_SHELL_REQUEUE_ACTION), eq(operationsAudit.actor, ACTOR)));
  expect(audit).toHaveLength(1);
  expect(audit[0].detail).toMatchObject({ examined: 2, rendered: 1, renderedEmpty: 1, requeued: 1, render: true, final: true, part: 1,
    runId: result.runId });
});

it("records only page failures on the document; a busy server writes nothing", async () => {
  const candidate = await seed("daelong/mochipet-rpg", "https://mochi.example", SHELL, { reason: "ambiguous" });
  const busy = await ensureShellRender((await getDocument(candidate.repo))!, { deadlineAt: Date.now() + 60_000, env: ENV,
    render: async () => ({ ok: false, kind: "busy", code: "render_busy" }) });
  expect(busy).toMatchObject({ kind: "wait", reason: "render_deferred" });
  expect((await getDocument(candidate.repo))?.pageMeta).not.toHaveProperty(RENDERED_PAGE_KEY);
  resetShellRenderBackoff();
  const failed = await ensureShellRender((await getDocument(candidate.repo))!, { deadlineAt: Date.now() + 60_000, env: ENV,
    render: async () => ({ ok: false, kind: "page", code: "page_http_503" }) });
  expect(failed).toMatchObject({ kind: "wait", reason: "render_wait" });
  const stored = await getDocument(candidate.repo);
  expect(stored?.pageMeta?.[RENDERED_PAGE_KEY]).toMatchObject({ ok: false, code: "page_http_503", attempts: 1 });
  const later = Date.now() + 11 * 60_000;
  const exhausted = await ensureShellRender(stored!, { deadlineAt: later + 60_000, env: ENV, now: () => later,
    render: async () => ({ ok: false, kind: "page", code: "page_http_503" }) });
  expect(exhausted).toMatchObject({ kind: "ready", state: { kind: "unavailable", attempts: SHELL_RENDER_ATTEMPTS } });
});

it("re-renders a stale render in place and keeps the same review input when the text is the same", async () => {
  const candidate = await seed("daelong/mochipet-rpg", "https://mochi.example", SHELL, { reason: "ambiguous" });
  await ensureShellRender((await getDocument(candidate.repo))!, { deadlineAt: Date.now() + 60_000, env: ENV, render: async () => ok(RENDERED) });
  const first = await getDocument(candidate.repo);
  const before = await loadReviewInput(candidate, first!, mergeWithDefaults({}));
  const later = Date.now() + SHELL_RENDER_MAX_AGE_MS + 60_000;
  expect(shellRenderState(first!, later)).toMatchObject({ kind: "due", stale: true });
  const step = await ensureShellRender(first!, { deadlineAt: later + 60_000, env: ENV, now: () => later, render: async () => ok(RENDERED) });
  expect(step).toMatchObject({ kind: "ready", state: { kind: "rendered" } });
  const second = await getDocument(candidate.repo);
  expect(second?.pageMeta?.[RENDERED_PAGE_KEY]).toMatchObject({ ok: true, at: new Date(later).toISOString() });
  expect((await loadReviewInput(candidate, second!, mergeWithDefaults({}))).inputHash).toBe(before.inputHash);
});

it("the runtime switch saved through the admin path turns rendering off without touching existing renders", async () => {
  const row = await readRuntimeSettingsRow();
  try {
    expect(await readShellRenderSwitch()).toBe("on");
    const saved = await saveRuntimeSettings({ "crawl-agent-review": { shellRender: 0 } }, ACTOR, { group: "jobs", expectedRevision: row.revision });
    expect(saved).toMatchObject({ ok: true });
    expect(await readShellRenderSwitch()).toBe("off");
    await seed("daelong/mochipet-rpg", "https://mochi.example", SHELL);
    expect(await countJsShellRequeue({ env: ENV })).toMatchObject({ renderSwitch: "off", renderConfigured: true, shell: 1 });
    await expect(applyJsShellRequeue({ limit: 10, actor: ACTOR, env: ENV })).rejects.toThrow("js_shell_requeue_render_switched_off");
    // 범위 밖 값은 저장 경로가 거절한다
    const current = await readRuntimeSettingsRow();
    expect(await saveRuntimeSettings({ "crawl-agent-review": { shellRender: 5 } }, ACTOR, { group: "jobs", expectedRevision: current.revision }))
      .toMatchObject({ ok: false });
  } finally {
    const current = await readRuntimeSettingsRow();
    await saveRuntimeSettings({ "crawl-agent-review": null }, ACTOR, { group: "jobs", expectedRevision: current.revision });
  }
  expect(await readShellRenderSwitch()).toBe("on");
});
