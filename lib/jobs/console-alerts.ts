import type { JobContext, JobOutcome } from "./runner";

/**
 * 휴대폰 알림(운영 콘솔 개편 조각 4b) — maintenance, 5분. 홈과 같은 읽기(readConsoleHome)로 할 일을 세고(buildConsoleTasks),
 * 알림 묶음(멈춤 · 평소와 다름)의 할 일을 알림 줄(console_alerts)과 견준다: 새로 생긴 것은 새 줄(조용한 시간이 아니면 바로 내보냄), 이어지는 것은 그 줄,
 * 10분 넘게 사라진 것은 닫는다(lib/operations/console-alerts.ts planConsoleAlerts). 웹 요청에서 보내지 않는다.
 * 실제 전송은 감시(monitor)가 내보낸 줄을 건강 파일에 적고 → 복구 게이트웨이 → Oracle watchdog 의 기존 Telegram 통로가 줄 id 마다 한 번 보낸다.
 * 알림이 꺼져 있으면 할 일을 읽지 않고 열린 줄만 닫는다. 쓰기는 이 잡의 lease 쓰기 관문 안에서만 한다.
 */
export async function sendConsoleAlerts(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const [store, { planConsoleAlerts }] = await Promise.all([import("@/lib/operations/console-alerts-store"), import("@/lib/operations/console-alerts")]);
  const { settings } = await store.readConsoleAlertSettings();
  const open = await store.readOpenConsoleAlerts();
  const nowMs = Date.now();
  if (!settings.enabled) {
    const plan = planConsoleAlerts({ open, board: { groups: [], kept: [] }, settings, nowMs });
    const applied = plan.close.length ? await store.applyConsoleAlertPlan(plan, ctx.lease) : { opened: 0, released: 0, closed: 0 };
    const pruned = await store.pruneConsoleAlerts(ctx.lease);
    ctx.log("console.alerts_tick", { enabled: false, ...applied, pruned });
    return { done: true, cursor: null };
  }
  if (!ctx.hasBudget() || ctx.signal?.aborted) return { done: true, cursor: null };
  // 할 일 읽기는 관리자 화면과 같은 모듈이다("server-only" 표시) — 워커에서는 그 표시만 서버 조건으로 푼다
  const { allowServerOnlyModules } = await import("./server-only-hook");
  await allowServerOnlyModules();
  const [{ readConsoleHome }, { buildConsoleTasks }] = await Promise.all([import("@/lib/operations/console-home-read"), import("@/lib/operations/console-tasks")]);
  const home = await readConsoleHome(false);
  const board = buildConsoleTasks(home.inputs);
  const plan = planConsoleAlerts({ open, board, settings, nowMs: Date.now() });
  const applied = await store.applyConsoleAlertPlan(plan, ctx.lease);
  const pruned = await store.pruneConsoleAlerts(ctx.lease);
  const unknown = board.groups.filter(group => group.notify && group.unknown.length).flatMap(group => group.unknown);
  ctx.log("console.alerts_tick", { enabled: true, ...applied, seen: plan.seen.length, missing: plan.missing.length, uncertain: plan.uncertain, pruned,
    ...(unknown.length ? { unknown } : {}) });
  // 알림 묶음을 셀 수 없는 틱은 성공이 아니다 — 운영센터 조치에 까닭이 보이게(열린 알림은 닫지 않았다)
  if (unknown.length) return { done: true, cursor: null, degraded: { code: "console_tasks_unknown", detail: `셀 수 없음 · ${unknown.slice(0, 4).join(" · ")}` } };
  return { done: true, cursor: null };
}
