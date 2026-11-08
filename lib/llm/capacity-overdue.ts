import { logger } from "@/lib/observability/logger";
import type { ModelCapacityDispatch } from "./capacity";

/**
 * 주인 스스로의 「전송 중」 정리(2026-11-08).
 *
 * 2026-11-07 19:25Z 키워드 검수(product-search-verify, supa) 호출 하나가 dispatched 로 5시간 남았다. 주인(m3-text)은 살아서 같은 잡을
 * 계속 돌렸고, 그 행에는 dispatch_started 뒤 어떤 사건도 없었다 — 호출 쪽이 정산·indeterminate 표시를 쓰지 못하고(정리 쓰기 실패,
 * 「전송 중」 커밋 응답 모름 등) 빠져나간 것이다. HTTP 기한(AbortSignal.timeout)은 그대로 동작했다(1,991건 모두 61초 안).
 * dispatched 는 장비 칸을 점유하고(indeterminate 는 점유가 아니다, capacity-devices) 배포 관문도 막는다 — supa 2칸 중 1칸이
 * 5시간 묶여 키워드 검수 처리량이 절반이 됐고, 배포 창 #864 가 DRAIN 에서 멈췄다.
 *
 * 그래서 이 프로세스가 커밋한 dispatch 를 기억해 두고, 호출 기한 + OVERDUE_GRACE_MS 가 지나도 행이 아직 dispatched 면
 * 주인 스스로 markModelDispatchIndeterminate(commit_unknown) 로 결과 미확정 검토에 넘긴다. 호출이 실패할 때 주인이 이미 하던 표시와
 * 같은 길이다(capacity-unsettled) — 환불·재전송·성공 기록은 없다. 늦게 끝난 호출의 정산은 indeterminate 행도 받는다.
 *
 * - 기한: binding 의 deadlineAt(키워드 검수), 없으면 추적 시각 + OVERDUE_DEFAULT_CALL_MS. 지금 HTTP 호출의 클라이언트 기한은
 *   길어야 90초다(등록부 기본값) — 넉넉한 상한이다.
 * - CLI 실행기(*_cli binding)는 넣지 않는다: 별도 실행기가 경계 종료 근거를 남긴다(capacity-repository trackOwnDispatch).
 * - 「전송 중」 커밋 TX 안에서 넣는다(커밋 응답을 못 받은 행도 잡으려고). 되돌려진 TX 의 행은 정리 때 dispatched 가 아니어서 빠진다.
 * - 정리는 먼저 잠금 없이 상태만 읽는다(PK IN). 아직 dispatched 이고 주인·binding hash 가 같은 행만 표시 TX 를 연다 —
 *   정상 정산된 호출(거의 전부)에 장부 잠금을 더하지 않는다. 표시가 실패하면 다음 회차에 다시 본다.
 */
export const OVERDUE_GRACE_MS = 120_000;
export const OVERDUE_DEFAULT_CALL_MS = 600_000;
export const OVERDUE_SWEEP_MS = 30_000;
const SWEEP_LIMIT = 100;
const MAX_TRACKED = 20_000;

type Tracked = { dispatch: ModelCapacityDispatch; routeId: string; bindingHash: string | null; overdueAt: number };
export type OverdueSweep = { due: number; marked: number; dropped: number; failed: number };
const tracked = new Map<string, Tracked>();
let timer: ReturnType<typeof setInterval> | null = null;
let sweeping: Promise<OverdueSweep> | null = null;

function deadlineOf(dispatch: ModelCapacityDispatch): number | null {
  const binding = (dispatch as { binding?: unknown }).binding;
  const value = binding && typeof binding === "object" ? (binding as { deadlineAt?: unknown }).deadlineAt : undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 「전송 중」 전환 TX 안에서 부른다(capacity-repository event). 던지지 않는다. */
export function trackOverdueDispatch(dispatch: ModelCapacityDispatch, routeId: string, now = Date.now()): void {
  const requestId = dispatch?.requestId;
  if (typeof requestId !== "string" || !dispatch.owner) return;
  const hash = (dispatch as { bindingHash?: unknown }).bindingHash;
  const overdueAt = (deadlineOf(dispatch) ?? now + OVERDUE_DEFAULT_CALL_MS) + OVERDUE_GRACE_MS;
  tracked.delete(requestId);
  if (tracked.size >= MAX_TRACKED) {
    // Map 은 넣은 순서다 — 가장 오래된 것을 버린다(그 행은 프로세스 종료 뒤 owner-gone 경로가 본다)
    const oldest = tracked.keys().next().value;
    if (oldest !== undefined) tracked.delete(oldest);
    logger.warn("model_capacity.overdue_tracking_full", { dropped: oldest ?? null });
  }
  tracked.set(requestId, { dispatch, routeId, bindingHash: typeof hash === "string" ? hash : null, overdueAt });
  if (!timer) {
    timer = setInterval(() => {
      void sweepOverdueDispatches().catch(error => logger.warn("model_capacity.overdue_sweep_failed",
        { error: error instanceof Error ? error.message : String(error) }));
    }, OVERDUE_SWEEP_MS);
    timer.unref?.();
  }
}

/** 기한이 지난 추적분을 한 번 본다. 겹쳐 부르면 진행 중인 회차를 돌려준다. */
export function sweepOverdueDispatches(now = Date.now()): Promise<OverdueSweep> {
  sweeping ??= sweep(now).finally(() => { sweeping = null; });
  return sweeping;
}

async function sweep(now: number): Promise<OverdueSweep> {
  const due = [...tracked.values()].filter(entry => entry.overdueAt <= now).slice(0, SWEEP_LIMIT);
  const result: OverdueSweep = { due: due.length, marked: 0, dropped: 0, failed: 0 };
  if (!due.length) return result;
  const { readModelDispatchStates, markModelDispatchIndeterminate } = await import("./capacity-repository");
  let rows: Awaited<ReturnType<typeof readModelDispatchStates>>;
  try { rows = await readModelDispatchStates(due.map(entry => entry.dispatch.requestId)); }
  catch (error) {
    result.failed = due.length;
    logger.warn("model_capacity.overdue_read_failed", { due: due.length, error: error instanceof Error ? error.message : String(error) });
    return result;
  }
  const forget = (entry: Tracked) => { if (tracked.get(entry.dispatch.requestId) === entry) tracked.delete(entry.dispatch.requestId); };
  for (const entry of due) {
    const { requestId, owner } = entry.dispatch, row = rows.get(requestId);
    if (!row || row.state !== "dispatched" || row.ownerInstanceId !== owner.instanceId || row.ownerBootId !== owner.bootId
      || (row.dispatchBindingHash ?? null) !== entry.bindingHash) {
      forget(entry); result.dropped++; continue;
    }
    try {
      const marked = await markModelDispatchIndeterminate(entry.dispatch, "commit_unknown");
      forget(entry);
      if (!marked) { result.dropped++; continue; }
      result.marked++;
      logger.warn("model_capacity.overdue_dispatch_marked", { requestId, routeId: entry.routeId,
        overdueMs: Math.max(0, now - entry.overdueAt) + OVERDUE_GRACE_MS });
    } catch (error) {
      result.failed++;
      logger.warn("model_capacity.overdue_mark_failed", { requestId, routeId: entry.routeId,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function overdueTrackedForTest(): ReadonlyMap<string, Readonly<Tracked>> { return tracked; }
export function resetOverdueDispatchesForTest(): void {
  tracked.clear();
  if (timer) clearInterval(timer);
  timer = null; sweeping = null;
}
