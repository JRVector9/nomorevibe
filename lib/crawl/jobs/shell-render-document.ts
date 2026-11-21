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
 *  - 우리 쪽 사정(세지 않고 기록도 하지 않는다): 틱에 그릴 시간이 없음·틱 끝·워커 멈춤으로 취소(이 둘은 기다림 시계도 열지 않는다)·붐빔(429 — 15초 쉼)·
 *    틱 끝 때문에 상한을 줄여 부른 뒤의 시간 초과(느린 페이지 하나로는 물러나지 않고, 다음에는 온전한 상한을 줄 수 있는 틱에서 그린다)·서버 쪽 상한
 *    (40초) 초과 — 이 두 시간 초과가 서로 다른 껍데기 3개에서 이어지면 m1 이 멈췄거나 과부하로 보고 물러난다·브라우저가 뜨지 않음(page_browser_failed)과
 *    화면 서버 탈(닿지 않음·401/403·5xx·약속과 다른 답·온전한 상한의 시간 초과 — 이 프로세스가 1분부터 두 배씩 15분까지 물러나고, 그동안 다른 후보는
 *    부르지 않고 기다린다)·원본 쓰기의 일시 오류.
 *  - 기다림 상한: 화면 서버 쪽 사정으로 한 껍데기를 기다리는 것은 이 프로세스가 그 사정으로 처음 못 그린 때부터 SHELL_RENDER_WAIT_MAX_MS(1시간)까지다.
 *    넘은 뒤에는 한 번 더 시도해 보고(상한이 모델 시간 안이라 틱을 먹지 않는다) 또 서버 쪽 사정이면 지금 원본으로 심사한다. 물러나는 중이면 시도하지
 *    않고 바로 보낸다. 기다림 표는 프로세스 메모리다(재시작하면 다시 센다 — 크기·나이 상한).
 *  - 그린 기록 쓰기가 데이터·한도 오류(22xxx·54xxx)로 실패하면 그 후보만 그리지 않은 것으로 보고 지금 원본으로 심사한다(record_failed). 그 밖의 쓰기
 *    실패는 일시 오류로 보고 그 후보만 미룬다(record_deferred). 글은 화면 서버 답(render-client.ts)과 기록(shell-render.ts renderedPageSuccess)에서
 *    jsonb 에 맞게 거른다(짝 없는 서로게이트·NUL).
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
 * timeouts: 서로 다른 껍데기에서 시간 초과(서버 쪽 40초 초과·틱 끝 때문에 줄인 상한의 초과)가 이어진 수 — SHELL_RENDER_TIMEOUT_STREAK 개면
 * m1 이 멈췄거나 과부하로 보고 탈처럼 물러난다(이미 물러난 적이 있고 그 뒤 성공이 없으면 한 번에). 후보의 시도로는 세지 않는다
 */
export const shellRenderBackoff = { failures: 0, retryAt: 0, timeouts: 0 };
/** 서로 다른 껍데기의 시간 초과가 이만큼 이어지면(사이에 다른 답 없음) 탈로 본다 */
export const SHELL_RENDER_TIMEOUT_STREAK = 3;
const timeoutKeys = new Set<string>();
/**
 * 우리 쪽 사정으로 기다리는 껍데기 — 저장소 + 껍데기 지문마다.
 *  - since: 기다림 시계(1시간 상한)를 연 때. 화면 서버 쪽 사정(물러남·탈·붐빔·시간 초과·원본 쓰기의 일시 오류)으로 미룰 때만 연다 —
 *    틱에 그릴 시간이 없었을 뿐(render_window)·취소는 열지 않는다(PR #1020 다시 보기 MAJOR-2: 그것으로 열면 늦게 돌아온 껍데기가 m1 이 멀쩡해도
 *    그려지지 않았다).
 *  - full: 틱 끝 때문에 줄인 상한에서 시간이 다 됐다 — 다음에는 온전한 상한을 줄 수 있는 틱에서 그린다(모델은 그다음 틱).
 *  - created: 칸의 나이(WAITING_ENTRY_TTL_MS 뒤에는 새로 센다).
 */
const waitingSince = new Map<string, { since?: number; full: boolean; created: number }>();
let renderTail: Promise<unknown> = Promise.resolve();
export function resetShellRenderBackoff(): void {
  shellRenderBackoff.failures = 0;
  shellRenderBackoff.retryAt = 0;
  shellRenderBackoff.timeouts = 0;
  timeoutKeys.clear();
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
  return entry && at - entry.created < WAITING_ENTRY_TTL_MS ? entry : undefined;
}
/** 기다림 칸을 적는다. clock 이면 시계를 연다(이미 열렸으면 그대로). 시계를 연 때를 돌려준다(열리지 않았으면 undefined). 표는 크기·나이 상한 안에서만 자란다 */
function noteWaiting(key: string, at: number, mark: { clock: boolean; full?: boolean }): number | undefined {
  let entry = waitingEntry(key, at);
  if (!entry) {
    waitingSince.delete(key);
    while (waitingSince.size >= WAITING_MAX_ENTRIES) waitingSince.delete(waitingSince.keys().next().value!);
    entry = { full: false, created: at };
    waitingSince.set(key, entry);
  }
  if (mark.clock) entry.since ??= at;
  if (mark.full) entry.full = true;
  return entry.since;
}
/** 시간 초과 하나를 센다 — 서로 다른 껍데기가 SHELL_RENDER_TIMEOUT_STREAK 개 이어졌거나 이미 물러난 뒤 성공이 없으면 true(탈로 본다) */
function noteServerTimeout(key: string): boolean {
  timeoutKeys.add(key);
  shellRenderBackoff.timeouts = timeoutKeys.size;
  if (timeoutKeys.size < SHELL_RENDER_TIMEOUT_STREAK && shellRenderBackoff.failures === 0) return false;
  clearServerTimeouts();
  return true;
}
function clearServerTimeouts(): void {
  timeoutKeys.clear();
  shellRenderBackoff.timeouts = 0;
}
/** 실패한 원본 쓰기의 SQLSTATE(다섯 자)만 — 쿼리 글·값은 싣지 않는다 */
function writeErrorState(error: unknown): string | null {
  for (let cause: unknown = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}
/** 그 글이 DB 에 들어가지 않는 오류 — 데이터(22xxx)·한도(54xxx). 다시 해도 같으므로 그 후보는 그리지 않은 것으로 심사한다 */
const permanentWriteError = (state: string | null) => state !== null && /^(22|54)/.test(state);

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
 * 원본이 껍데기면 그려서 붙인다. 던지지 않는다(lease 잃음·DR 쓰기 막힘·gate 의 오류만 던진다) — 한 페이지가 틱 전체를 멈추지 않게(PR #1020 리뷰 BLOCKER).
 * 그린 기록 쓰기가 데이터·한도 오류(22xxx·54xxx — 그 글이 jsonb 에 들어가지 않음)로 실패하면 그 후보만 그리지 않은 것으로 보고 지금 원본으로 심사한다
 * (record_failed_<SQLSTATE>). 그 밖의 쓰기 실패(잠금 시간 초과 55P03·직렬화 40001·교착 40P01·연결 오류 등)는 일시 오류로 보고 그 후보만 다음 틱으로
 * 미룬다(record_deferred_<SQLSTATE> — 기다림 시계를 연다. 1시간이 지나도 이어지면 지금 원본으로 심사).
 * deadlineAt: 그리기를 반드시 끝내야 하는 시각(틱 끝).
 * modelDeadlineAt: 그린 뒤 같은 틱에 모델을 부르려면 그리기를 끝내야 하는 시각(틱 끝 − 모델 상한 − 여유). 그 안에 SHELL_RENDER_MIN_WINDOW_MS 가
 *   남으면 그 안으로 줄여 그린다. 남지 않으면 틱 끝까지 온전한 상한(50초)을 줄 수 있을 때만 그린다(모델은 다음 틱 — 그린 글은 남는다).
 *   줄인 상한에서 시간이 다 된 껍데기는 다음에 온전한 상한을 줄 수 있는 틱에서 그린다.
 * gate: 그리기 직전에 부르는 규칙 관문 — 까닭을 돌려주면 그리지 않는다(ready · skipped).
 * skip: 부르는 쪽이 그리지 말라고 한 까닭(1차가 앞 틱에서 줄에 세운 후보 — 예약을 쥔 채 그리지 않는다).
 * waitMaxMs: 화면 서버 쪽 사정으로 기다릴 상한(기본 1시간, 시계를 연 때부터). 넘었으면 그리기를 다시 시도해 보고(모델 시간 안의 상한이라 틱을 먹지
 *   않는다), 또 서버 쪽 사정이면 지금 원본으로 보낸다. 서버가 지금 나쁘다고 알려졌으면(물러나는 중) 시도하지 않고 바로 보낸다. 재심사 도구는 Infinity.
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
  const expired = (at: number) => { const since = waitingEntry(key, at)?.since; return since !== undefined && at - since >= waitMaxMs; };
  // 기다림 시계가 다 됐고 서버가 지금도 나쁘다고 알려졌으면(물러나는 중) 시도하지 않고 지금 원본으로 — 시도해 봐야 미룸뿐이다.
  // 서버가 나쁘다고 알려지지 않았으면 한 번 더 시도한다: 상한이 모델 시간 안이라 틱을 먹지 않는다(PR #1020 다시 보기 MAJOR-2)
  if (shellRenderBackoff.retryAt > now() && expired(now())) return ready("wait_expired", "wait_limit");
  // 우리 쪽 사정 — 세지 않고 적지 않는다. clock 이면(화면 서버 쪽 사정) 기다림 시계를 열고, 상한을 넘었으면 지금 원본으로 심사한다
  const deferred = (reason: Exclude<ShellRenderWaitReason, "render_wait">, code: string,
    mark: { clock: boolean; retryAt?: number; full?: boolean }): ShellRenderStep => {
    noteWaiting(key, now(), mark);
    if (expired(now())) return ready("wait_expired", code);
    return { kind: "wait", reason, code, ...(mark.retryAt ? { retryAt: mark.retryAt } : {}) };
  };
  const record = async (outcome: Parameters<typeof setRenderedPage>[1], renderMs: number, code?: string): Promise<ShellRenderStep> => {
    let saved: CrawlDocument | undefined;
    try {
      saved = await setRenderedPage(document, outcome, options.lease) ?? await getDocument(document.repo);
    } catch (error) {
      // lease 를 잃었거나 이 자리가 쓰기를 막혔다 — 틱이 멈춰야 한다
      if (error instanceof JobLeaseLostError || error instanceof DrWriterFencedError) throw error;
      const state = writeErrorState(error);
      // 그 글이 DB 에 들어가지 않는다 — 다시 해도 같다. 그 후보만 그리지 않은 것으로 지금 원본으로 심사한다
      if (permanentWriteError(state)) return ready("record_failed", `record_failed_${state}`);
      // 일시 오류(잠금 시간 초과·직렬화·교착·연결…) — 그릴 수 있는 후보를 껍데기로 심사하지 않는다. 그 후보만 다음 틱에
      return deferred("render_deferred", `record_deferred_${state ?? "unknown"}`, { clock: true });
    }
    waitingSince.delete(key);
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
  // 틱에 그릴 시간이 없었을 뿐이다 — 서버 사정이 아니므로 기다림 시계를 열지 않는다
  if (outcome === "window") return deferred("render_window", "render_window", { clock: false });
  if (outcome === "backoff") return deferred("render_deferred", "render_backoff", { clock: true, retryAt: shellRenderBackoff.retryAt });
  const { result, renderMs, timeoutMs } = outcome;
  const outage = (code: string) => {
    shellRenderBackoff.failures += 1;
    shellRenderBackoff.retryAt = now() + qwenBackoffMs(shellRenderBackoff.failures);
    return deferred("render_deferred", code, { clock: true, retryAt: shellRenderBackoff.retryAt });
  };
  if (result.ok) {
    shellRenderBackoff.failures = 0;
    shellRenderBackoff.retryAt = 0;
    clearServerTimeouts();
    return record(renderedPageSuccess(document, { text: result.text, textLength: result.textLength, finalUrl: result.finalUrl, status: result.status }, now()),
      renderMs);
  }
  if (result.kind === "page") {
    // 브라우저가 뜨지 않음 — 그 페이지가 아니라 m1 의 일이다(리뷰 MINOR). 탈로 본다
    if (result.code === "page_browser_failed") return outage(result.code);
    // 서버 쪽 그리기 상한(40초) 초과 — 느린 페이지일 수도, m1 과부하일 수도 있다. 후보 탓으로 세지 않는다. 이어지면 과부하로 보고 물러난다
    if (result.code === "page_timeout") return noteServerTimeout(key) ? outage(result.code) : deferred("render_deferred", result.code, { clock: true });
    // 그 페이지의 실패 — 서버는 살아 있다(연속 탈 수를 푼다). 후보의 시도로 센다
    shellRenderBackoff.failures = 0;
    clearServerTimeouts();
    return record(renderedPageFailure(document, result.code, now()), renderMs, result.code);
  }
  // 취소(틱 끝·워커 멈춤)는 그 후보 탓도 서버 탓도 아니다 — 적지 않고 다음 틱에(시계를 열지 않는다)
  if (result.code === "render_cancelled") return deferred("render_window", result.code, { clock: false });
  if (result.kind === "busy") {
    clearServerTimeouts();
    shellRenderBackoff.retryAt = Math.max(shellRenderBackoff.retryAt, now() + SHELL_RENDER_BUSY_PAUSE_MS);
    return deferred("render_deferred", result.code, { clock: true, retryAt: shellRenderBackoff.retryAt });
  }
  // 틱 끝 때문에 줄인 상한의 시간 초과 — 느린 페이지 하나로는 물러나지 않는다(다음에는 온전한 상한으로 그린다). 서로 다른 껍데기에서 이어지면
  // 화면 서버가 멈춘 것으로 보고 물러난다 — CLI 40초 틱은 늘 줄인 상한이라 이것이 아니면 멈춘 서버에 매 틱 상한만큼을 잃는다(다시 보기 MINOR-A)
  if (result.code === "render_timeout" && timeoutMs < SHELL_RENDER_REQUEST_MS) return noteServerTimeout(key) ? outage("render_timeout_shortened")
    : deferred("render_window", "render_timeout_shortened", { clock: true, full: true });
  return outage(result.code);
}
