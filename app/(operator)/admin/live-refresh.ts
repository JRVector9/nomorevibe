import { formatDetailTime } from "@/lib/format/time";
import { OPS_FRESH_COOKIE, OPS_FRESH_SECONDS } from "./status/fresh";

/**
 * 관리자 화면 자동 갱신의 규칙 — 모든 관리자 화면 머리의 갱신 줄(LiveBar)과 시험이 함께 쓴다. DOM 전역은 넘겨받는다.
 *
 * 전에는 운영센터만 10초마다 다시 읽었고, 크롤 설정·심사 큐·오늘 할 일은 열어 둔 동안 숫자가 그대로였다.
 * 메뉴 배지는 공유 레이아웃이 그려 화면을 옮겨도 다시 그려지지 않았다.
 */

/** 화면마다 다시 읽는 간격과, 마지막 조작(누르기·키) 뒤 기다리는 시간 */
export type RefreshPolicy = { intervalMs: number; idleMs: number };

export function refreshPolicy(pathname: string): RefreshPolicy {
  const under = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  // 운영센터 — 워커 관측 15초에 맞춘 지금 그대로(10초). 조작 중에도 읽는다(전과 같다)
  if (under("/admin/status")) return { intervalMs: 10_000, idleMs: 0 };
  // 심사 큐 — 갈래 셈이 보류 후보를 모두 다시 판정해 무겁고, 결정하는 화면이다. 손을 뗀 지 1분 지나야 다시 읽는다
  if (under("/admin/review")) return { intervalMs: 30_000, idleMs: 60_000 };
  // 크롤 설정 — 2차 표 모델 목록을 게이트웨이에 묻는다. 30초
  if (pathname === "/admin") return { intervalMs: 30_000, idleMs: 15_000 };
  // 오늘 할 일 — 칸 열네 개를 주 DB 에서 센다(사람 몫·조치 수). 30초·손 뗀 지 1분
  if (under("/admin/inbox")) return { intervalMs: 30_000, idleMs: 60_000 };
  // 나머지 목록 — 누르려던 줄이 다시 그려지며 밀리지 않게, 15초 동안 조작이 없을 때만
  return { intervalMs: 15_000, idleMs: 15_000 };
}

/** 이번 차례를 건너뛰는 까닭. null 이면 읽는다. stuck 은 다시 읽기가 오래 끝나지 않아 기다리는 것 */
export type PauseReason = "hidden" | "editing" | "unsaved" | "active" | "stuck";

export const PAUSE_LABELS: Record<PauseReason, string> = {
  hidden: "창이 가려져 쉼",
  editing: "입력 중이라 잠시 멈춤",
  unsaved: "저장하지 않은 변경·열린 확인 창이 있어 멈춤",
  active: "조작 중이라 잠시 멈춤",
  stuck: "다시 읽기가 오래 걸려 끝나기를 기다리는 중",
};

/**
 * 저장하지 않은 변경이 있는가 — 화면이 직접 알리는 [data-dirty](설정 폼·감사 보류·일괄 선택·준비한 결정 등)와
 * 열린 확인 창(ConfirmAction, dialog.admin-confirm[open]). 창 아래 화면이 다시 그려지면 확인한 대상·상태가 바뀔 수 있다.
 */
export const UNSAVED_SELECTOR = "[data-dirty], dialog.admin-confirm[open]";
export function hasUnsaved(root: Pick<ParentNode, "querySelector"> | null | undefined): boolean {
  return !!root?.querySelector(UNSAVED_SELECTOR);
}

export function pauseReason(input: { visible: boolean; editing: boolean; unsaved: boolean; idleForMs: number; idleMs: number }): PauseReason | null {
  if (!input.visible) return "hidden";
  if (input.unsaved) return "unsaved";
  if (input.editing) return "editing";
  if (input.idleMs > 0 && input.idleForMs < input.idleMs) return "active";
  return null;
}

/**
 * 글자를 넣는 칸인가 — 고르기 상자(select)·체크·단추는 아니다. 고른 뒤에도 포커스가 남아 갱신이 오래 멈추고,
 * 폼 안에서 바꾼 값은 "손댄 폼"(저장하지 않은 변경)으로 따로 막는다.
 */
const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image", "hidden"]);
export function isTextEntry(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return !NOT_TEXT.has(((element as HTMLInputElement).type || "text").toLowerCase());
  return (element as HTMLElement).isContentEditable === true;
}

/** 켜고 끈 것을 기억하는 열쇠(브라우저 저장소) — 저장소가 막혀 있으면 켜짐으로 시작하고 기억만 못 한다 */
export const LIVE_STORAGE_KEY = "nmv-admin-live-refresh";
type Store = Pick<Storage, "getItem" | "setItem">;

export function readLivePreference(storage: () => Store | null | undefined): boolean {
  try { return storage()?.getItem(LIVE_STORAGE_KEY) !== "off"; } catch { return true; }
}

export function writeLivePreference(storage: () => Store | null | undefined, live: boolean): void {
  try { storage()?.setItem(LIVE_STORAGE_KEY, live ? "on" : "off"); } catch { /* 기억만 못 한다 */ }
}

/** 수동 새로고침의 5초 쿠키 — 관리자 화면 모두에서(Path=/admin) 서버가 60초 캐시를 건너뛴다(fresh.ts) */
export function freshCookie(): string {
  return `${OPS_FRESH_COOKIE}=1; Max-Age=${OPS_FRESH_SECONDS}; Path=/admin; SameSite=Strict`;
}

/** "마지막 갱신 13:38:20" — 한국 시각 시:분:초 */
export function clockLabel(value: string | null | undefined): string {
  return formatDetailTime(value).split(" ")[1] ?? "—";
}

/** 다시 읽기가 이만큼 끝나지 않으면 막힌 것으로 보고 한 번만 다시 부른다(느린 조각 하나가 갱신을 영영 막지 않게) */
export const BUSY_LIMIT_MS = 60_000;

/**
 * 자동 갱신의 차례 — 언제 다시 읽을지만 정한다(화면·라우터는 LiveBar 가 잇는다). 시험이 시계를 넘겨 확인한다.
 * - 조작(누르기·키·바퀴·스크롤)은 input() 으로 알린다 — 화면마다 정한 시간 동안 쉰다.
 * - 다시 읽는 중에는 또 부르지 않는다. 1분 넘게 끝나지 않으면 한 번만 다시 부르고, 그 뒤에는 끝날 때까지(settled) 쉰다 —
 *   막힌 렌더 위에 렌더를 끝없이 겹치지 않는다.
 * - 수동 새로고침은 이 차례와 따로다(LiveBar 의 다른 transition) — 자동 갱신이 도는 중에도 누를 수 있다.
 */
export function createRefreshScheduler(now: () => number = () => Date.now()) {
  let lastInput = -Infinity;
  let started: number | null = null;
  let retried = false;
  return {
    input() { lastInput = now(); },
    tick(state: { visible: boolean; editing: boolean; unsaved: boolean; idleMs: number; manualBusy?: boolean }): { refresh: boolean; paused: PauseReason | null } {
      const reason = pauseReason({ ...state, idleForMs: now() - lastInput });
      if (reason) return { refresh: false, paused: reason };
      if (state.manualBusy) return { refresh: false, paused: null };
      if (started !== null) {
        const stuck = now() - started >= BUSY_LIMIT_MS;
        if (!stuck) return { refresh: false, paused: null };
        if (retried) return { refresh: false, paused: "stuck" };
        retried = true;
      }
      started = now();
      return { refresh: true, paused: null };
    },
    /** 창 복귀·뒤로 가기처럼 조작 시간과 상관없이 곧바로 읽을 때 — 다시 읽는 중이면 겹치지 않는다 */
    now(): boolean {
      if (started !== null && now() - started < BUSY_LIMIT_MS) return false;
      started = now();
      return true;
    },
    settled() { started = null; retried = false; },
  };
}
export type RefreshScheduler = ReturnType<typeof createRefreshScheduler>;

/**
 * 메뉴 배지를 합친다 — 새로 받은 값(next)이 "셀 수 없었다"(unknown)고 한 칸은 전에 보이던 값을 둔다.
 * 처음 프로세스가 떴거나 뒤에서 다시 세는 중인 칸이 깜빡이며 사라지지 않게. 나머지는 새 값(없으면 배지 없음)이다.
 */
export function mergeBadges<B>(previous: Partial<Record<string, B>> | undefined, next: { badges?: Partial<Record<string, B>>; unknown?: readonly string[] }):
  Partial<Record<string, B>> {
  const merged: Partial<Record<string, B>> = { ...(next.badges ?? {}) };
  for (const key of next.unknown ?? []) if (previous?.[key] !== undefined) merged[key] = previous[key];
  return merged;
}
