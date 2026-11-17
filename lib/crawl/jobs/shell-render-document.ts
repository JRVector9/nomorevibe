import type { CrawlDocument } from "@/lib/db/schema";
import type { JobLease } from "@/lib/jobs/control";
import { getDocument, setRenderedPage } from "@/lib/crawl/repository";
import { renderedPageFailure, renderedPageSuccess, shellRenderState, type ShellRenderState } from "@/lib/crawl/shell-render";
import { requestRender, screenRenderConfig, type RenderClientResult, type ScreenRenderConfig } from "@/lib/screen-review/render-client";
import { qwenBackoffMs } from "@/lib/crawl/qwen-endpoint-backoff";
import { storedReviewEvidenceRequired } from "../review-replay-context";

/**
 * 1차 심사 직전에 JS 앱 껍데기를 화면 서버(m1-studio Chromium, lib/screen-review)로 한 번 그린다(lib/crawl/shell-render.ts).
 * README 붙이기(review-document.ts)와 같은 자리·같은 원본 판 대조다. 그린 글은 원본 옆(page_meta.renderedPage)에 남아 1차·2차·판가름·감사가 같이 본다.
 *
 * 비용: 한 건 그리기 실측 중앙값 약 5초(표본 33건, 2.8~14.7초), 화면 서버 상한 40초 + 주고받기. 이 프로세스에서 한 번에 하나씩 차례로 그린다 —
 * 화면 서버의 동시 그리기 상한(기본 2)을 화면 판별 줄(audit-screen-review)과 나눠 쓴다. 차례를 기다리다 틱 끝이 가까우면 다음 틱으로 미룬다.
 * 그린 뒤 이 틱에 모델을 부를 시간이 모자라면 1차 심사가 그 후보를 다음 틱으로 미룬다(그린 글은 남아 있어 다음 틱은 바로 심사한다).
 *
 * 실패는 지금 동작으로 떨어진다: 그리기 실패·시간 초과·화면 서버 탈·붐빔은 원본에 실패를 적고(횟수·다음 시도 시각) 10분 뒤 한 번 더 그린다. 두 번 실패하면
 * 수집 본문(껍데기)으로 심사한다 — 규칙대로 거절된다. 화면 서버 설정(SCREEN_RENDER_URL·SCREEN_RENDER_TOKEN)이 없으면 그리지 않고 지금처럼 심사한다.
 * 화면 서버 탈은 이 프로세스에서 1분부터 두 배씩 15분까지 물러나며, 그동안 그릴 차례인 후보는 부르지 않고 실패(render_backoff)로 센다.
 */
export const SHELL_RENDER_REQUEST_MS = 45_000;
/** 그리기를 시작할 최소 남은 시간 — 이보다 적으면 이 틱은 그 후보를 기다리게 한다(세지 않는다) */
export const SHELL_RENDER_MIN_WINDOW_MS = 12_000;

export const shellRenderBackoff = { failures: 0, retryAt: 0 };
let renderTail: Promise<unknown> = Promise.resolve();
export function resetShellRenderBackoff(): void {
  shellRenderBackoff.failures = 0;
  shellRenderBackoff.retryAt = 0;
  renderTail = Promise.resolve();
}
/** 이 프로세스의 그리기를 한 줄로 세운다 */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = renderTail.then(work, work);
  renderTail = run.catch(() => undefined);
  return run;
}

export type ShellRenderStep =
  /** 그대로 심사한다 — document 는 그린 기록이 붙었으면 새 원본 */
  | { kind: "ready"; document: CrawlDocument; state: ShellRenderState; rendered?: { ok: boolean; code?: string; renderMs: number } }
  /** 이 틱은 이 후보를 보내지 않는다(그리기 실패 뒤 기다림·틱 시간 부족) — 세지 않는다 */
  | { kind: "wait"; reason: "render_wait" | "render_window"; retryAt?: number };

export type ShellRenderDeps = {
  env?: Readonly<Record<string, string | undefined>>;
  request?: typeof fetch;
  /** 시험: 화면 서버 대신 */
  render?: (url: string, options: { config: ScreenRenderConfig; timeoutMs: number; signal?: AbortSignal }) => Promise<RenderClientResult>;
  now?: () => number;
};

/**
 * 원본이 껍데기면 그려서 붙인다. 던지지 않는다(원본 쓰기의 DB 오류·lease 잃음만 던진다).
 * deadlineAt: 그리기를 끝내야 하는 시각(틱 끝) — 그리기 상한을 그 안으로 줄인다.
 */
export async function ensureShellRender(document: CrawlDocument, options: { lease?: JobLease; deadlineAt: number; signal?: AbortSignal } & ShellRenderDeps):
  Promise<ShellRenderStep> {
  const now = options.now ?? Date.now;
  const state = shellRenderState(document, now());
  if (state.kind !== "due" && state.kind !== "waiting") return { kind: "ready", document, state };
  const config = screenRenderConfig(options.env ?? process.env);
  // 화면 서버가 없다·재현 실행이다 — 지금처럼 수집 본문으로 심사한다
  if (!config || storedReviewEvidenceRequired()) return { kind: "ready", document, state };
  if (state.kind === "waiting") return { kind: "wait", reason: "render_wait", retryAt: state.retryAfter };
  const record = async (outcome: Parameters<typeof setRenderedPage>[1], renderMs: number, code?: string): Promise<ShellRenderStep> => {
    const saved = await setRenderedPage(document, outcome, options.lease) ?? await getDocument(document.repo);
    // 그리는 사이 원본이 다시 수집되어 사라졌다 — 다음 틱이 새 원본을 본다
    if (!saved) return { kind: "wait", reason: "render_wait" };
    const next = shellRenderState(saved, now());
    if (next.kind === "waiting") return { kind: "wait", reason: "render_wait", retryAt: next.retryAfter };
    if (next.kind === "due") return { kind: "wait", reason: "render_wait" };
    return { kind: "ready", document: saved, state: next, rendered: { ok: outcome.ok, ...(code ? { code } : {}), renderMs } };
  };
  type Rendered = { result: RenderClientResult; renderMs: number } | "backoff" | "window";
  const outcome = await exclusive(async (): Promise<Rendered> => {
    if (shellRenderBackoff.retryAt > now()) return "backoff";
    const timeoutMs = Math.min(SHELL_RENDER_REQUEST_MS, options.deadlineAt - now());
    if (timeoutMs < SHELL_RENDER_MIN_WINDOW_MS || options.signal?.aborted) return "window";
    const started = now();
    try {
      return { result: await (options.render ?? ((url, rest) => requestRender(url, { ...rest, request: options.request })))(document.productUrl!,
        { config, timeoutMs, signal: options.signal }), renderMs: now() - started };
    } catch {
      return { result: { ok: false, kind: "outage", code: "render_unreachable" }, renderMs: now() - started };
    }
  });
  if (outcome === "window") return { kind: "wait", reason: "render_window" };
  if (outcome === "backoff") return record(renderedPageFailure(document, "render_backoff", now()), 0, "render_backoff");
  const { result, renderMs } = outcome;
  if (!result.ok) {
    if (result.kind === "outage") {
      shellRenderBackoff.failures += 1;
      shellRenderBackoff.retryAt = now() + qwenBackoffMs(shellRenderBackoff.failures);
    }
    // 취소(틱 끝·워커 멈춤)는 그 후보 탓이 아니다 — 적지 않고 다음 틱에
    if (result.code === "render_cancelled") return { kind: "wait", reason: "render_window" };
    return record(renderedPageFailure(document, result.code, now()), renderMs, result.code);
  }
  shellRenderBackoff.failures = 0;
  shellRenderBackoff.retryAt = 0;
  return record(renderedPageSuccess(document, { text: result.text, textLength: result.textLength, finalUrl: result.finalUrl, status: result.status }, now()),
    renderMs);
}
