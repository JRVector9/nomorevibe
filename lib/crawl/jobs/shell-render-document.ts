import type { CrawlDocument } from "@/lib/db/schema";
import type { JobLease } from "@/lib/jobs/control";
import { JobLeaseLostError } from "@/lib/jobs/lease";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import { getDocument, setRenderedPage } from "@/lib/crawl/repository";
import { renderedPageFailure, renderedPageSuccess, shellFingerprint, shellRenderState, type ShellRenderState } from "@/lib/crawl/shell-render";
import { spamSignals } from "@/lib/crawl/spam-signals";
import { requestRender, screenRenderConfig, type RenderClientResult, type ScreenRenderConfig } from "@/lib/screen-review/render-client";
import { qwenBackoffMs } from "@/lib/crawl/qwen-endpoint-backoff";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";
import { jobKnob, type RuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { storedReviewEvidenceRequired } from "../review-replay-context";

/**
 * 1차 심사 직전에 JS 앱 껍데기를 화면 서버(m1-studio Chromium, lib/screen-review)로 한 번 그린다(lib/crawl/shell-render.ts).
 * README 붙이기(review-document.ts)와 같은 자리·같은 원본 판 대조다. 그린 글은 원본 옆(page_meta.renderedPage)에 남아 1차·2차·판가름·감사가 같이 본다.
 *
 * 비용: 한 건 그리기 실측 중앙값 약 5초(표본 33건, 2.8~14.7초), 화면 서버 상한 40초 + 주고받기. 이 프로세스에서 한 번에 하나씩 차례로 그린다 —
 * 화면 서버의 동시 그리기 상한(기본 2)을 화면 판별 줄(audit-screen-review)·소개 보조와 나눠 쓴다. 차례를 기다리다 틱 끝이 가까우면 다음 틱으로 미룬다.
 * 그린 뒤 이 틱에 모델을 부를 시간이 모자라면 1차 심사가 그 후보를 다음 틱으로 미룬다(그린 글은 남아 있어 다음 틱은 바로 심사한다).
 *
 * 그리지 않는 것(지금처럼 수집 본문으로 바로 심사): 스위치 끔(실시간 한도 jobs.crawl-agent-review.shellRender = 0)·화면 서버 설정 없음·재현 실행·
 * 스팸 의심(spamSignals — m1 에서 실행하지 않는다)·부르는 쪽의 규칙 관문(gate — 1차는 스팸 보류·규칙 거절·이미 등재·근거 보류처럼 모델을 부르지
 * 않을 후보를 먼저 거른다, 2026-11-21 983-A).
 *
 * 실패 셈(2026-11-21 983-B, PR #1020 리뷰 반영) — 후보 탓만 센다:
 *  - 페이지 탓(화면 서버가 그 페이지의 실패로 답함 — 막힘·닿지 않음·4xx/5xx·그릴 수 없는 주소·요청 상한…): 원본에 적고 10분 뒤 다시. 한 바퀴에 두 번이면
 *    수집 본문으로 심사하고(unavailable — 앞선 성공이 있으면 그 글), 그 바퀴의 첫 실패에서 24시간 뒤 새 바퀴로 다시 그린다(shell-render.ts).
 *  - 우리 쪽 사정(세지 않고 기록도 하지 않는다): 붐빔(429 — 15초 쉼)·틱 끝·워커 멈춤으로 취소·틱 끝 때문에 상한을 줄여 부른 뒤의 시간 초과
 *    (느린 페이지일 뿐 서버 탈이 아니다 — 물러나지 않고, 다음에는 온전한 상한을 줄 수 있는 틱에서 그린다)·서버 쪽 상한(40초) 초과(3번 이어지면 m1
 *    과부하로 보고 물러난다)·브라우저가 뜨지 않음(page_browser_failed)과 화면 서버 탈(닿지 않음·401/403·5xx·약속과 다른 답·온전한 상한의 시간 초과 —
 *    이 프로세스가 1분부터 두 배씩 15분까지 물러나고, 그동안 다른 후보는 부르지 않고 기다린다).
 *  - 기다림 상한: 우리 쪽 사정으로 한 껍데기를 기다리는 것은 이 프로세스가 처음 못 그린 때부터 SHELL_RENDER_WAIT_MAX_MS(1시간)까지다. 넘었으면
 *    그리기를 시도하지 않고 지금 원본으로 심사한다(시도 뒤에 보면 그 시도가 틱을 먹는다). 기다림 표는 프로세스 메모리다(재시작하면 다시 센다 — 크기 상한).
 *  - 그린 기록 쓰기가 실패하면(그린 글이 jsonb 에 들어가지 않는 등) 그 후보만 그리지 않은 것으로 보고 지금 원본으로 심사한다(record_failed).
 *    글은 화면 서버 답(render-client.ts)과 기록(shell-render.ts renderedPageSuccess)에서 jsonb 에 맞게 거른다(짝 없는 서로게이트·NUL).
 */
/** 온전한 그리기 상한 — 화면 서버 상한 40초(renderer.ts RENDER_DEFAULTS.deadlineMs) + 스크린숏을 실은 답을 받는 시간 */
export const SHELL_RENDER_REQUEST_MS = 50_000;
/** 그리기를 시작할 최소 남은 시간 — 이보다 적으면 이 틱은 그 후보를 기다리게 한다(세지 않는다) */
export const SHELL_RENDER_MIN_WINDOW_MS = 12_000;
/** 우리 쪽 사정으로 한 껍데기를 기다리는 상한 — 넘으면 지금 원본으로 심사한다 */
export const SHELL_RENDER_WAIT_MAX_MS = 60 * 60_000;
/** 화면 서버가 붐빔(429)이면 이 프로세스가 쉬는 시간 — 세지 않는다 */
export const SHELL_RENDER_BUSY_PAUSE_MS = 15_000;
/** 실시간 한도의 스위치 칸 — 1 켬 · 0 끔 */
export const SHELL_RENDER_SWITCH = { job: "crawl-agent-review", knob: "shellRender" } as const;
const WAITING_MAX_ENTRIES = 5_000;
const WAITING_ENTRY_TTL_MS = 24 * 3600_000;

/** 스위치 — 끄면 새로 그리지 않는다(이미 그린 글은 입력에 그대로 쓴다). 감사 화면 판별은 이 칸을 읽지 않는다 */
export function shellRenderEnabled(settings: RuntimeSettings = runtimeSettings()): boolean {
  return jobKnob(settings, SHELL_RENDER_SWITCH.job, SHELL_RENDER_SWITCH.knob) !== 0;
}

/**
 * 화면 서버 탈의 물러나기(failures = 연속 탈) — 붐빔은 failures 를 올리지 않고 retryAt 만 조금 미룬다.
 * timeouts: 서버 쪽 그리기 상한(40초) 초과가 이어진 수 — SHELL_RENDER_TIMEOUT_STREAK 번이면 m1 과부하로 보고 탈처럼 물러난다
 */
export const shellRenderBackoff = { failures: 0, retryAt: 0, timeouts: 0 };
/** 서버 쪽 시간 초과가 이만큼 이어지면(사이에 다른 답 없음) 탈로 본다 */
export const SHELL_RENDER_TIMEOUT_STREAK = 3;
/**
 * 우리 쪽 사정으로 기다리기 시작한 때 — 저장소 + 껍데기 지문마다. full: 틱 끝 때문에 줄인 상한에서 시간이 다 됐다 — 다음에는 온전한 상한을
 * 줄 수 있는 틱에서 그린다(모델은 그다음 틱)
 */
const waitingSince = new Map<string, { since: number; full: boolean }>();
let renderTail: Promise<unknown> = Promise.resolve();
export function resetShellRenderBackoff(): void {
  shellRenderBackoff.failures = 0;
  shellRenderBackoff.retryAt = 0;
  shellRenderBackoff.timeouts = 0;
  waitingSince.clear();
  renderTail = Promise.resolve();
}
/** 이 프로세스의 그리기를 한 줄로 세운다 */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = renderTail.then(work, work);
  renderTail = run.catch(() => undefined);
  return run;
}
const waitKey = (document: CrawlDocument) =>
  `${document.repo}\n${shellFingerprint(document.productUrl, typeof document.pageMeta?.textSample === "string" ? document.pageMeta.textSample : null)}`;
/** 살아 있는 기다림 칸(나이 상한 안) */
function waitingEntry(key: string, at: number) {
  const entry = waitingSince.get(key);
  return entry && at - entry.since < WAITING_ENTRY_TTL_MS ? entry : undefined;
}
/** 기다리기 시작한 때(처음이면 지금으로 적는다). 표는 크기·나이 상한 안에서만 자란다 */
function noteWaiting(key: string, at: number, full = false): number {
  const entry = waitingEntry(key, at);
  if (entry) { entry.full ||= full; return entry.since; }
  waitingSince.delete(key);
  while (waitingSince.size >= WAITING_MAX_ENTRIES) waitingSince.delete(waitingSince.keys().next().value!);
  waitingSince.set(key, { since: at, full });
  return at;
}
/** 실패한 원본 쓰기의 SQLSTATE(다섯 자)만 — 쿼리 글·값은 싣지 않는다 */
function writeErrorCode(error: unknown): string {
  for (let cause: unknown = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return `record_failed_${code}`;
  }
  return "record_failed";
}

/** 그리지 않고 지금 원본으로 심사하게 된 까닭 */
export type ShellRenderSkip = "switched_off" | "not_configured" | "replay" | "suspected_spam" | "wait_expired" | "pending_reservation" | "record_failed"
  | (string & {});
/** 세지 않는 기다림의 까닭 — render_wait 만 페이지 실패 뒤의 정해진 기다림이고 나머지는 우리 쪽 사정이다 */
export type ShellRenderWaitReason = "render_wait" | "render_window" | "render_deferred";

export type ShellRenderStep =
  /** 그대로 심사한다 — document 는 그린 기록이 붙었으면 새 원본. skipped: 그려야 했지만 그리지 않은 까닭 */
  | { kind: "ready"; document: CrawlDocument; state: ShellRenderState; rendered?: { ok: boolean; code?: string; renderMs: number }; skipped?: ShellRenderSkip;
    code?: string }
  /** 이 틱은 이 후보를 보내지 않는다 — 세지 않는다(건너뜀 상한 밖). code: 우리 쪽 사정의 고정 코드 */
  | { kind: "wait"; reason: ShellRenderWaitReason; retryAt?: number; code?: string };

export type ShellRenderDeps = {
  env?: Readonly<Record<string, string | undefined>>;
  request?: typeof fetch;
  /** 시험: 화면 서버 대신 */
  render?: (url: string, options: { config: ScreenRenderConfig; timeoutMs: number; signal?: AbortSignal }) => Promise<RenderClientResult>;
  now?: () => number;
  /** 스위치를 부르는 쪽이 이미 읽었다(재심사 도구 — DB 행에서). 없으면 이 프로세스의 실시간 한도 스냅숏 */
  enabled?: boolean;
};

/**
 * 원본이 껍데기면 그려서 붙인다. 던지지 않는다(lease 잃음·DR 쓰기 막힘·gate 의 오류만 던진다). 그린 기록 쓰기가 실패하면(그린 글이 jsonb 에
 * 들어가지 않는 등) 그 후보만 그리지 않은 것으로 보고 지금 원본으로 심사한다(record_failed) — 한 페이지가 틱 전체를 멈추지 않게(PR #1020 리뷰 BLOCKER).
 * deadlineAt: 그리기를 반드시 끝내야 하는 시각(틱 끝).
 * modelDeadlineAt: 그린 뒤 같은 틱에 모델을 부르려면 그리기를 끝내야 하는 시각(틱 끝 − 모델 상한 − 여유). 그 안에 SHELL_RENDER_MIN_WINDOW_MS 가
 *   남으면 그 안으로 줄여 그린다. 남지 않으면 틱 끝까지 온전한 상한(50초)을 줄 수 있을 때만 그린다(모델은 다음 틱 — 그린 글은 남는다).
 *   줄인 상한에서 시간이 다 된 껍데기는 다음에 온전한 상한을 줄 수 있는 틱에서 그린다.
 * gate: 그리기 직전에 부르는 규칙 관문 — 까닭을 돌려주면 그리지 않는다(ready · skipped).
 * skip: 부르는 쪽이 그리지 말라고 한 까닭(1차가 앞 틱에서 줄에 세운 후보 — 예약을 쥔 채 그리지 않는다).
 * waitMaxMs: 우리 쪽 사정으로 기다릴 상한(기본 1시간) — 넘었으면 그리기를 시도하기 전에 지금 원본으로 보낸다. 재심사 도구는 Infinity.
 */
export async function ensureShellRender(document: CrawlDocument, options: { lease?: JobLease; deadlineAt: number; modelDeadlineAt?: number;
  signal?: AbortSignal; gate?: () => Promise<string | null>; skip?: ShellRenderSkip; waitMaxMs?: number } & ShellRenderDeps): Promise<ShellRenderStep> {
  const now = options.now ?? Date.now;
  const state = shellRenderState(document, now());
  if (state.kind !== "due" && state.kind !== "waiting") return { kind: "ready", document, state };
  const ready = (skipped: ShellRenderSkip, code?: string): ShellRenderStep => ({ kind: "ready", document, state, skipped, ...(code ? { code } : {}) });
  if (options.skip) return ready(options.skip);
  if (!(options.enabled ?? shellRenderEnabled())) return ready("switched_off");
  const config = screenRenderConfig(options.env ?? process.env);
  // 화면 서버가 없다·재현 실행이다 — 지금처럼 수집 본문으로 심사한다
  if (!config) return ready("not_configured");
  if (storedReviewEvidenceRequired()) return ready("replay");
  // 스팸·악성 배포 의심은 m1 의 Chromium 에서 실행하지 않는다 — 규칙이 사람에게 넘긴다(agent-review-preparation.ts)
  if (spamSignals(document).flagged) return ready("suspected_spam");
  if (state.kind === "waiting") return { kind: "wait", reason: "render_wait", retryAt: state.retryAfter };
  const gated = options.gate ? await options.gate() : null;
  if (gated) return ready(gated);
  const key = waitKey(document);
  const waitMaxMs = options.waitMaxMs ?? SHELL_RENDER_WAIT_MAX_MS;
  // 기다림 상한은 그리기를 시도하기 전에 본다 — 시도 뒤에 보면 그 시도가 틱을 먹어 모델을 부를 시간이 남지 않는다(CLI 40초 틱, 리뷰 MAJOR)
  const waiting = waitingEntry(key, now());
  if (waiting && now() - waiting.since >= waitMaxMs) return ready("wait_expired", "wait_limit");
  // 우리 쪽 사정 — 세지 않고 적지 않는다. 기다림 상한을 넘었으면 지금 원본으로 심사한다
  const deferred = (reason: Exclude<ShellRenderWaitReason, "render_wait">, code: string, retryAt?: number, full = false): ShellRenderStep => {
    const since = noteWaiting(key, now(), full);
    if (now() - since >= waitMaxMs) return ready("wait_expired", code);
    return { kind: "wait", reason, code, ...(retryAt ? { retryAt } : {}) };
  };
  const record = async (outcome: Parameters<typeof setRenderedPage>[1], renderMs: number, code?: string): Promise<ShellRenderStep> => {
    waitingSince.delete(key);
    let saved: CrawlDocument | undefined;
    try {
      saved = await setRenderedPage(document, outcome, options.lease) ?? await getDocument(document.repo);
    } catch (error) {
      // lease 를 잃었거나 이 자리가 쓰기를 막혔다 — 틱이 멈춰야 한다. 그 밖(그 페이지의 글이 DB 에 들어가지 않음 등)은 그 후보만 그리지 않은 것으로
      if (error instanceof JobLeaseLostError || error instanceof DrWriterFencedError) throw error;
      return ready("record_failed", writeErrorCode(error));
    }
    // 그리는 사이 원본이 다시 수집되어 사라졌다 — 다음 틱이 새 원본을 본다
    if (!saved) return { kind: "wait", reason: "render_wait" };
    const next = shellRenderState(saved, now());
    if (next.kind === "waiting") return { kind: "wait", reason: "render_wait", retryAt: next.retryAfter, ...(code ? { code } : {}) };
    if (next.kind === "due") return { kind: "wait", reason: "render_wait" };
    return { kind: "ready", document: saved, state: next, rendered: { ok: outcome.ok, ...(code ? { code } : {}), renderMs } };
  };
  type Rendered = { result: RenderClientResult; renderMs: number; timeoutMs: number } | "backoff" | "window";
  const outcome = await exclusive(async (): Promise<Rendered> => {
    if (shellRenderBackoff.retryAt > now()) return "backoff";
    if (options.signal?.aborted) return "window";
    const left = (at: number) => at - now();
    const full = left(options.deadlineAt) >= SHELL_RENDER_REQUEST_MS ? SHELL_RENDER_REQUEST_MS : 0;
    const preferred = left(options.modelDeadlineAt ?? options.deadlineAt);
    const short = preferred >= SHELL_RENDER_MIN_WINDOW_MS ? Math.min(SHELL_RENDER_REQUEST_MS, preferred) : 0;
    // 줄인 상한에서 시간이 다 된 껍데기는 온전한 상한을 줄 수 있으면 그것으로(모델은 다음 틱), 줄 수 없는 틱(CLI 40초)이면 줄여서라도
    const timeoutMs = waitingEntry(key, now())?.full ? full || short : short || full;
    if (!timeoutMs) return "window";
    const started = now();
    try {
      return { result: await (options.render ?? ((url, rest) => requestRender(url, { ...rest, request: options.request })))(document.productUrl!,
        { config, timeoutMs, signal: options.signal }), renderMs: now() - started, timeoutMs };
    } catch {
      return { result: { ok: false, kind: "outage", code: "render_unreachable" }, renderMs: now() - started, timeoutMs };
    }
  });
  if (outcome === "window") return deferred("render_window", "render_window");
  if (outcome === "backoff") return deferred("render_deferred", "render_backoff", shellRenderBackoff.retryAt);
  const { result, renderMs, timeoutMs } = outcome;
  const outage = (code: string) => {
    shellRenderBackoff.failures += 1;
    shellRenderBackoff.retryAt = now() + qwenBackoffMs(shellRenderBackoff.failures);
    return deferred("render_deferred", code, shellRenderBackoff.retryAt);
  };
  if (result.ok) {
    shellRenderBackoff.failures = 0;
    shellRenderBackoff.retryAt = 0;
    shellRenderBackoff.timeouts = 0;
    return record(renderedPageSuccess(document, { text: result.text, textLength: result.textLength, finalUrl: result.finalUrl, status: result.status }, now()),
      renderMs);
  }
  if (result.kind === "page") {
    // 브라우저가 뜨지 않음 — 그 페이지가 아니라 m1 의 일이다(리뷰 MINOR). 탈로 본다
    if (result.code === "page_browser_failed") return outage(result.code);
    // 서버 쪽 그리기 상한(40초) 초과 — 느린 페이지일 수도, m1 과부하일 수도 있다. 후보 탓으로 세지 않는다. 이어지면 과부하로 보고 물러난다
    if (result.code === "page_timeout") {
      shellRenderBackoff.timeouts += 1;
      if (shellRenderBackoff.timeouts >= SHELL_RENDER_TIMEOUT_STREAK) { shellRenderBackoff.timeouts = 0; return outage(result.code); }
      return deferred("render_deferred", result.code);
    }
    // 그 페이지의 실패 — 서버는 살아 있다(연속 탈 수를 푼다). 후보의 시도로 센다
    shellRenderBackoff.failures = 0;
    shellRenderBackoff.timeouts = 0;
    return record(renderedPageFailure(document, result.code, now()), renderMs, result.code);
  }
  // 취소(틱 끝·워커 멈춤)는 그 후보 탓이 아니다 — 적지 않고 다음 틱에
  if (result.code === "render_cancelled") return deferred("render_window", result.code);
  if (result.kind === "busy") {
    shellRenderBackoff.retryAt = Math.max(shellRenderBackoff.retryAt, now() + SHELL_RENDER_BUSY_PAUSE_MS);
    return deferred("render_deferred", result.code, shellRenderBackoff.retryAt);
  }
  // 틱 끝 때문에 줄인 상한의 시간 초과 — 느린 페이지일 수 있다. 서버 탈로 보지 않는다(물러나지 않는다). 다음에는 온전한 상한으로 그린다
  if (result.code === "render_timeout" && timeoutMs < SHELL_RENDER_REQUEST_MS) return deferred("render_window", "render_timeout_shortened", undefined, true);
  return outage(result.code);
}
