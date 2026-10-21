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
  // 나머지 목록 — 누르려던 줄이 다시 그려지며 밀리지 않게, 15초 동안 조작이 없을 때만
  return { intervalMs: 15_000, idleMs: 15_000 };
}

/** 이번 차례를 건너뛰는 까닭. null 이면 읽는다 */
export type PauseReason = "hidden" | "editing" | "unsaved" | "active";

export const PAUSE_LABELS: Record<PauseReason, string> = {
  hidden: "창이 가려져 쉼",
  editing: "입력 중이라 잠시 멈춤",
  unsaved: "저장하지 않은 변경이 있어 멈춤",
  active: "조작 중이라 잠시 멈춤",
};

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

/** 두 ISO 시각 중 늦은 것 — 레이아웃이 그린 시각과 화면을 옮긴 뒤 배지를 다시 받은 시각 중 */
export function laterOf(a: string, b: string | null | undefined): string {
  return b && Date.parse(b) > Date.parse(a) ? b : a;
}

/** 다시 읽기가 이만큼 끝나지 않으면 막힌 것으로 보고 다음 차례에 다시 부른다(느린 조각 하나가 갱신을 영영 막지 않게) */
export const BUSY_LIMIT_MS = 60_000;
