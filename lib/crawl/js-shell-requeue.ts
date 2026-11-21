import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, operationsAudit, type CrawlDocument } from "@/lib/db/schema";
import { requestJob } from "@/lib/jobs/control";
import { resolveRuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { screenRenderConfig } from "@/lib/screen-review/render-client";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { pageTextShell, SHELL_RENDER_VERSION, SHELL_TEXT_MAX_CHARS, shellInputOf, shellRenderState, type ShellKind, type ShellRenderState } from "./shell-render";
import { ensureShellRender, shellRenderBackoff, shellRenderEnabled, type ShellRenderDeps } from "./jobs/shell-render-document";

/**
 * 이미 2차 갈림으로 보류된 JS 앱 껍데기를 다시 심사로 보내는 운영 도구(scripts/js-shell-review-requeue.ts, 2026-11-17 · 2026-11-21 보완).
 *
 * 대상: 자동 결정·미발행의 needs_review/second_review_split 중 원본 주소가 후보 주소와 같고 수집 본문이 껍데기(shell-render.ts pageTextShell)인 것.
 * 되돌리기는 다시 수집할 때와 같은 길이다(repository.ts saveFetchedDocument): state new · reason source_changed → 규칙 재판정 → 1차(그린 글을 본다) →
 * 2차. 1차가 판정 시각(candidateJudgedAt)을 대조하므로 옛 시도는 다시 쓰이지 않는다. 사람이 정한 후보·다른 사유의 보류는 건드리지 않는다.
 *
 * apply 는 기본으로 먼저 그린다(화면 서버 — reviewer 컨테이너처럼 SCREEN_RENDER_URL·SCREEN_RENDER_TOKEN 이 있는 곳에서 돌린다) — 그린 글이 뜻있는
 * 것만 되돌린다. 그린 글도 껍데기거나·다른 사이트로 넘어갔거나·그리지 못한 것은 되돌려도 같은 갈림으로 돌아오므로 남긴다. --no-render 는 그리지 않고
 * (1차가 그 자리에서 그린다) 이미 안 될 것(그린 글도 껍데기·다른 사이트·페이지 실패 소진)만 빼고 되돌린다.
 *
 * 상한(2026-11-21 983 점검 5): 한 번에 limit ≤ JS_SHELL_REQUEUE_MAX 건, 그리기 사이 intervalMs(기본 2초, 화면 서버 동시 2칸을 1차·화면 판별과 나눠
 * 쓴다), batch 건마다 한 커밋으로 되돌리고 커밋마다 operations_audit 한 줄(js-shell-review-requeue, 같은 runId)을 남긴다 — 도중에 멈춰도 되돌린
 * 몫은 감사에 남는다. 마지막 줄(final: true)은 되돌린 것이 없어도 남는다. 화면 서버 탈·붐빔이 이어지면(미룸 연속 RENDER_DEFER_STREAK_STOP 번)
 * 거기서 멈춘다. 실시간 한도의 그리기 스위치(jobs.crawl-agent-review.shellRender)가 꺼져 있으면 apply 를 거절한다 — 되돌려도 1차가 그리지 않는다.
 */
export const JS_SHELL_REQUEUE_ACTION = "js-shell-review-requeue";
export const JS_SHELL_REQUEUE_MAX = 1_000;
export const JS_SHELL_REQUEUE_BATCH_DEFAULT = 25;
export const JS_SHELL_REQUEUE_BATCH_MAX = 100;
export const JS_SHELL_REQUEUE_INTERVAL_DEFAULT_MS = 2_000;
export const JS_SHELL_REQUEUE_INTERVAL_MAX_MS = 60_000;
/** 화면 서버 쪽 사정(탈·붐빔)으로 미룬 것이 이만큼 이어지면 그 자리에서 멈춘다 */
export const RENDER_DEFER_STREAK_STOP = 3;

type Row = { id: number; repo: string; productUrl: string; document: CrawlDocument };
export type ShellHold = { id: number; repo: string; productUrl: string; kind: ShellKind; state: ShellRenderState["kind"] };
export type RenderSwitchState = "on" | "off" | "unreadable";

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

/** 실시간 한도의 그리기 스위치 — 30초 스냅숏이 아니라 저장 행을 바로 읽는다. 읽지 못하면 unreadable(apply 는 거절한다) */
export async function readShellRenderSwitch(): Promise<RenderSwitchState> {
  try {
    const { readRuntimeSettingsRow } = await import("@/lib/operations/runtime-settings");
    return shellRenderEnabled(resolveRuntimeSettings((await readRuntimeSettingsRow()).values).settings) ? "on" : "off";
  } catch {
    return "unreadable";
  }
}

const tally = <K extends string>(items: K[]) => items.reduce((map, key) => ({ ...map, [key]: (map[key] ?? 0) + 1 }), {} as Partial<Record<K, number>>);
/** 그리지 않고 되돌릴 때 뺄 것 — 이미 그렸는데 껍데기·다른 사이트였거나 페이지 실패를 다 쓴(쉼 24시간 안) 것은 같은 갈림으로 돌아온다 */
const hopeless = (state: ShellRenderState["kind"]) => state === "rendered_empty" || state === "rendered_offsite" || state === "unavailable";

/** count·dry-run 이 함께 싣는 상태 설명 — 출력만 보고 읽을 수 있게 */
const RENDER_STATE_LEGEND = {
  due: "아직 그리지 않음(또는 7일 지나 다시 그릴 때) — apply 가 그려 본다",
  rendered: "이미 뜻있게 그림 — apply 가 바로 되돌린다",
  rendered_empty: "그렸지만 그린 글도 껍데기 — 되돌리지 않는다",
  rendered_offsite: "JS 가 다른 사이트로 넘김 — 되돌리지 않는다",
  waiting: "페이지 실패 뒤 다시 그리기를 기다림(10분) — apply 는 실패로 센다",
  unavailable: "페이지 실패를 다 씀(24시간 쉼) — 되돌리지 않는다",
} as const;

/** 읽기만 한다 — 갈림 보류 수, 그중 껍데기 수(꼴별·그린 상태별), 스위치·화면 서버 설정 여부(값은 싣지 않는다) */
export async function countJsShellRequeue(options: { env?: Readonly<Record<string, string | undefined>>; readSwitch?: () => Promise<RenderSwitchState> } = {}) {
  const [{ splitHolds, holds }, renderSwitch] = await Promise.all([listShellSplitHolds(), (options.readSwitch ?? readShellRenderSwitch)()]);
  return { readOnly: true as const, splitHolds, shell: holds.length, byKind: tally(holds.map(hold => hold.kind)),
    byRenderState: tally(holds.map(hold => hold.state)), alreadyRendered: holds.filter(hold => hold.state === "rendered").length,
    requeueableWithoutRender: holds.filter(hold => !hopeless(hold.state)).length,
    renderSwitch, renderConfigured: screenRenderConfig(options.env ?? process.env) !== null, legend: RENDER_STATE_LEGEND };
}

const assertLimit = (limit: number) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > JS_SHELL_REQUEUE_MAX) throw new Error("js_shell_requeue_invalid_limit");
};

/** 읽기만 한다 — apply 가 고를 차례 그대로 앞의 limit 건과, 그리지 않고 되돌릴 때 빠질지 */
export async function dryRunJsShellRequeue(input: { limit: number; env?: Readonly<Record<string, string | undefined>>; readSwitch?: () => Promise<RenderSwitchState> }) {
  assertLimit(input.limit);
  const counts = await countJsShellRequeue(input);
  const { holds } = await listShellSplitHolds();
  const sample = holds.slice(0, input.limit).map(hold => ({ ...hold, noRenderApply: hopeless(hold.state) ? "skip" as const : "requeue" as const }));
  return { ...counts, wouldExamine: sample.length, sample,
    applyBounds: { maxLimit: JS_SHELL_REQUEUE_MAX, batchDefault: JS_SHELL_REQUEUE_BATCH_DEFAULT, batchMax: JS_SHELL_REQUEUE_BATCH_MAX,
      intervalDefaultMs: JS_SHELL_REQUEUE_INTERVAL_DEFAULT_MS, intervalMaxMs: JS_SHELL_REQUEUE_INTERVAL_MAX_MS, stopAfterDeferredStreak: RENDER_DEFER_STREAK_STOP } };
}

type ApplyCounts = { examined: number; rendered: number; renderedEmpty: number; renderedOffsite: number; renderFailed: number; renderDeferred: number;
  skipped: number; requeued: number };

/**
 * 되돌린다. render(기본 켬)면 차례대로 그려 뜻있게 그린 것만, 아니면 이미 안 될 것만 빼고. 후보는 쓰는 순간에도 그 보류 그대로인지 다시 본다.
 * batch 건마다 한 커밋·감사 한 줄. 화면 서버가 이어서 못 그리면(미룸 연속) 멈추고 stoppedEarly 를 돌려준다.
 */
export async function applyJsShellRequeue(input: { limit: number; actor: string; render?: boolean; intervalMs?: number; batch?: number;
  env?: Readonly<Record<string, string | undefined>>; renderDeps?: Omit<ShellRenderDeps, "env" | "enabled">; readSwitch?: () => Promise<RenderSwitchState>;
  sleep?: (ms: number) => Promise<void> }) {
  assertLimit(input.limit);
  if (!/^[\w.@:-]{1,120}$/.test(input.actor)) throw new Error("js_shell_requeue_invalid_actor");
  const batch = input.batch ?? JS_SHELL_REQUEUE_BATCH_DEFAULT;
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > JS_SHELL_REQUEUE_BATCH_MAX) throw new Error("js_shell_requeue_invalid_batch");
  const intervalMs = input.intervalMs ?? JS_SHELL_REQUEUE_INTERVAL_DEFAULT_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > JS_SHELL_REQUEUE_INTERVAL_MAX_MS) throw new Error("js_shell_requeue_invalid_interval");
  const render = input.render ?? true;
  const env = input.env ?? process.env;
  // 스위치가 꺼져 있으면 되돌려도 1차가 그리지 않아 같은 갈림으로 돌아온다
  const renderSwitch = await (input.readSwitch ?? readShellRenderSwitch)();
  if (renderSwitch !== "on") throw new Error(renderSwitch === "off" ? "js_shell_requeue_render_switched_off" : "js_shell_requeue_switch_unreadable");
  if (render && !screenRenderConfig(env)) throw new Error("js_shell_requeue_render_not_configured");
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const runId = randomUUID().slice(0, 8);
  const { holds, rows } = await listShellSplitHolds();
  const picked = holds.slice(0, input.limit);
  const counts: ApplyCounts = { examined: 0, rendered: 0, renderedEmpty: 0, renderedOffsite: 0, renderFailed: 0, renderDeferred: 0, skipped: 0, requeued: 0 };
  const skippedBy: Record<string, number> = {};
  let ready: number[] = [], part = 0, deferStreak = 0, stoppedEarly: string | null = null;

  const commit = async (final: boolean) => {
    const ids = ready;
    ready = [];
    part += 1;
    await db.transaction(async tx => {
      await lockPipelineInputStages(tx);
      const now = new Date();
      const updated = ids.length ? await tx.update(crawlCandidates).set({ state: "new", reason: "source_changed", decidedAt: null, updatedAt: now,
        signals: sql`coalesce(${crawlCandidates.signals}, '{}'::jsonb) || ${JSON.stringify({ shellRenderRequeue: { at: now.toISOString(), actor: input.actor,
          runId, version: SHELL_RENDER_VERSION } })}::jsonb` })
        .where(and(inArray(crawlCandidates.id, ids), eq(crawlCandidates.state, "needs_review"), eq(crawlCandidates.reason, "second_review_split"),
          eq(crawlCandidates.decidedBy, "auto"), isNull(crawlCandidates.publishedSlug)))
        .returning({ id: crawlCandidates.id }) : [];
      counts.requeued += updated.length;
      await tx.insert(operationsAudit).values({ actor: input.actor, actorKind: "local", action: JS_SHELL_REQUEUE_ACTION, target: "crawl_candidates",
        detail: { runId, part, final, partRequeued: updated.length, partIds: ids.length, ...counts, ...(Object.keys(skippedBy).length ? { skippedBy } : {}),
          ...(stoppedEarly ? { stoppedEarly } : {}), render, limit: input.limit, batch, intervalMs, version: SHELL_RENDER_VERSION } });
      if (updated.length) await requestJob("crawl-judge", tx);
    });
  };

  for (const [index, hold] of picked.entries()) {
    counts.examined += 1;
    if (!render) {
      if (hopeless(hold.state)) counts.skipped++; else ready.push(hold.id);
    } else {
      if (index && intervalMs) await sleep(intervalMs);
      const step = await ensureShellRender(rows.get(hold.id)!.document, { deadlineAt: Date.now() + 60_000, env, enabled: true,
        waitMaxMs: Number.POSITIVE_INFINITY, ...input.renderDeps });
      const deferred = step.kind === "wait" && step.reason !== "render_wait";
      deferStreak = deferred ? deferStreak + 1 : 0;
      if (step.kind === "wait") { if (deferred) counts.renderDeferred++; else counts.renderFailed++; }
      else if (step.skipped) { counts.skipped++; skippedBy[step.skipped] = (skippedBy[step.skipped] ?? 0) + 1; }
      else if (step.state.kind === "rendered") { counts.rendered++; ready.push(hold.id); }
      else if (step.state.kind === "rendered_empty") counts.renderedEmpty++;
      else if (step.state.kind === "rendered_offsite") counts.renderedOffsite++;
      else counts.renderFailed++;
      if (deferStreak >= RENDER_DEFER_STREAK_STOP) {
        stoppedEarly = shellRenderBackoff.failures ? "render_server_unavailable" : "render_server_busy";
        break;
      }
    }
    if (ready.length >= batch) await commit(false);
  }
  await commit(true);
  return { runId, ...counts, ...(Object.keys(skippedBy).length ? { skippedBy } : {}), ...(stoppedEarly ? { stoppedEarly } : {}), render, batch, intervalMs,
    parts: part };
}
