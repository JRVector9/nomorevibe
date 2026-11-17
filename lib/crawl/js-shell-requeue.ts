import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, operationsAudit, type CrawlDocument } from "@/lib/db/schema";
import { requestJob } from "@/lib/jobs/control";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { pageTextShell, SHELL_RENDER_VERSION, SHELL_TEXT_MAX_CHARS, shellInputOf, shellRenderState, type ShellKind, type ShellRenderState } from "./shell-render";
import { ensureShellRender, type ShellRenderDeps } from "./jobs/shell-render-document";

/**
 * 이미 2차 갈림으로 보류된 JS 앱 껍데기를 다시 심사로 보내는 운영 도구(scripts/js-shell-review-requeue.ts, 2026-11-17).
 *
 * 대상: 자동 결정·미발행의 needs_review/second_review_split 중 원본 주소가 후보 주소와 같고 수집 본문이 껍데기(shell-render.ts pageTextShell)인 것.
 * 되돌리기는 다시 수집할 때와 같은 길이다(repository.ts saveFetchedDocument): state new · reason source_changed → 규칙 재판정 → 1차(그린 글을 본다) →
 * 2차. 1차가 판정 시각(candidateJudgedAt)을 대조하므로 옛 시도는 다시 쓰이지 않는다. 사람이 정한 후보·다른 사유의 보류는 건드리지 않는다.
 *
 * apply 는 기본으로 먼저 그린다(화면 서버 — reviewer 컨테이너처럼 SCREEN_RENDER_URL·SCREEN_RENDER_TOKEN 이 있는 곳에서 돌린다) — 그린 글이 뜻있는
 * 것만 되돌린다. 그린 글도 껍데기거나 그리지 못한 것은 되돌려도 같은 갈림으로 돌아오므로 남긴다. --no-render 는 그리지 않고(1차가 그 자리에서 그린다)
 * 이미 그린 글이 껍데기·실패 소진인 것만 빼고 되돌린다. 결과 수는 operations_audit 한 줄(js-shell-review-requeue)에 남긴다.
 */
export const JS_SHELL_REQUEUE_ACTION = "js-shell-review-requeue";
export const JS_SHELL_REQUEUE_MAX = 1_000;

type Row = { id: number; repo: string; productUrl: string; document: CrawlDocument };
export type ShellHold = { id: number; repo: string; productUrl: string; kind: ShellKind; state: ShellRenderState["kind"] };

/** SQL 로 좁히고(사유·상태·주소·본문 300자 이하) TS 로 껍데기를 가른다 — 껍데기 판정이 심사 입력과 같은 함수다 */
export async function listShellSplitHolds(now = Date.now()): Promise<{ splitHolds: number; holds: ShellHold[]; rows: Map<number, Row> }> {
  const [total] = await db.select({ count: sql<number>`count(*)::int` }).from(crawlCandidates).where(and(eq(crawlCandidates.state, "needs_review"),
    eq(crawlCandidates.reason, "second_review_split"), eq(crawlCandidates.decidedBy, "auto"), isNull(crawlCandidates.publishedSlug)));
  const rows = await db.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, productUrl: crawlCandidates.productUrl, document: crawlDocuments })
    .from(crawlCandidates).innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(and(eq(crawlCandidates.state, "needs_review"), eq(crawlCandidates.reason, "second_review_split"), eq(crawlCandidates.decidedBy, "auto"),
      isNull(crawlCandidates.publishedSlug), isNotNull(crawlCandidates.productUrl),
      sql`${crawlDocuments.productUrl} IS NOT DISTINCT FROM ${crawlCandidates.productUrl}`,
      sql`char_length(btrim(coalesce(${crawlDocuments.pageMeta}->>'textSample', ''))) <= ${SHELL_TEXT_MAX_CHARS}`))
    .orderBy(asc(crawlCandidates.id));
  const holds: ShellHold[] = [];
  const byId = new Map<number, Row>();
  for (const row of rows) {
    const kind = pageTextShell(shellInputOf(row.document));
    if (!kind || !row.productUrl) continue;
    holds.push({ id: row.id, repo: row.repo, productUrl: row.productUrl, kind, state: shellRenderState(row.document, now).kind });
    byId.set(row.id, { id: row.id, repo: row.repo, productUrl: row.productUrl, document: row.document });
  }
  return { splitHolds: total?.count ?? 0, holds, rows: byId };
}

const tally = <K extends string>(items: K[]) => items.reduce((map, key) => ({ ...map, [key]: (map[key] ?? 0) + 1 }), {} as Partial<Record<K, number>>);
/** 그리지 않고 되돌릴 때 뺄 것 — 이미 그렸는데 껍데기였거나 실패를 다 쓴 것은 같은 갈림으로 돌아온다 */
const hopeless = (state: ShellRenderState["kind"]) => state === "rendered_empty" || state === "unavailable";

/** 읽기만 한다 — 갈림 보류 수, 그중 껍데기 수(꼴별·그린 상태별) */
export async function countJsShellRequeue() {
  const { splitHolds, holds } = await listShellSplitHolds();
  return { splitHolds, shell: holds.length, byKind: tally(holds.map(hold => hold.kind)), byRenderState: tally(holds.map(hold => hold.state)),
    requeueableWithoutRender: holds.filter(hold => !hopeless(hold.state)).length };
}

/** 읽기만 한다 — apply 가 고를 차례 그대로 앞의 limit 건을 보여 준다 */
export async function dryRunJsShellRequeue(input: { limit: number }) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > JS_SHELL_REQUEUE_MAX) throw new Error("js_shell_requeue_invalid_limit");
  const counts = await countJsShellRequeue();
  const { holds } = await listShellSplitHolds();
  return { ...counts, wouldExamine: Math.min(input.limit, holds.length), sample: holds.slice(0, input.limit) };
}

/**
 * 되돌린다. render(기본 켬)면 차례대로 그려 뜻있게 그린 것만, 아니면 이미 안 될 것만 빼고. 후보는 쓰는 순간에도 그 보류 그대로인지 다시 본다.
 */
export async function applyJsShellRequeue(input: { limit: number; actor: string; render?: boolean; intervalMs?: number;
  env?: Readonly<Record<string, string | undefined>>; renderDeps?: Omit<ShellRenderDeps, "env"> }) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > JS_SHELL_REQUEUE_MAX) throw new Error("js_shell_requeue_invalid_limit");
  if (!/^[\w.@:-]{1,120}$/.test(input.actor)) throw new Error("js_shell_requeue_invalid_actor");
  const render = input.render ?? true;
  const env = input.env ?? process.env;
  if (render && !(env.SCREEN_RENDER_URL?.trim() && (env.SCREEN_RENDER_TOKEN?.trim().length ?? 0) >= 32)) throw new Error("js_shell_requeue_render_not_configured");
  const { holds, rows } = await listShellSplitHolds();
  const picked = holds.slice(0, input.limit);
  const counts = { examined: picked.length, rendered: 0, renderedEmpty: 0, renderFailed: 0, skipped: 0 };
  const ready: number[] = [];
  for (const [index, hold] of picked.entries()) {
    if (!render) {
      if (hopeless(hold.state)) counts.skipped++; else ready.push(hold.id);
      continue;
    }
    if (index && input.intervalMs) await new Promise(resolve => setTimeout(resolve, input.intervalMs));
    const step = await ensureShellRender(rows.get(hold.id)!.document, { deadlineAt: Date.now() + 60_000, env, ...input.renderDeps });
    const state = step.kind === "ready" ? step.state.kind : "waiting";
    if (state === "rendered") { counts.rendered++; ready.push(hold.id); }
    else if (state === "rendered_empty") counts.renderedEmpty++;
    else counts.renderFailed++;
  }
  const requeued = await db.transaction(async tx => {
    await lockPipelineInputStages(tx);
    const now = new Date();
    const updated = ready.length ? await tx.update(crawlCandidates).set({ state: "new", reason: "source_changed", decidedAt: null, updatedAt: now,
      signals: sql`coalesce(${crawlCandidates.signals}, '{}'::jsonb) || ${JSON.stringify({ shellRenderRequeue: { at: now.toISOString(), actor: input.actor,
        version: SHELL_RENDER_VERSION } })}::jsonb` })
      .where(and(inArray(crawlCandidates.id, ready), eq(crawlCandidates.state, "needs_review"), eq(crawlCandidates.reason, "second_review_split"),
        eq(crawlCandidates.decidedBy, "auto"), isNull(crawlCandidates.publishedSlug)))
      .returning({ id: crawlCandidates.id }) : [];
    await tx.insert(operationsAudit).values({ actor: input.actor, actorKind: "local", action: JS_SHELL_REQUEUE_ACTION, target: "crawl_candidates",
      detail: { ...counts, requeued: updated.length, render, limit: input.limit, version: SHELL_RENDER_VERSION } });
    if (updated.length) await requestJob("crawl-judge", tx);
    return updated.length;
  });
  return { ...counts, requeued, render };
}
