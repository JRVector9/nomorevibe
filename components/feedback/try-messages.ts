import type { Dictionary } from "@/lib/i18n/messages";

/** 상세 써보기 판(TryPanel·ReactionFields)이 쓰는 me 사전의 열쇠 머리 */
export const TRY_PANEL_PREFIXES = ["try.", "verdict.", "tag."] as const;

/**
 * 써보기 판에 넘길 me 사전 몫 — 상세 HTML 은 엣지에 4분 남는 화면이라 마이페이지 사전 전체(약 480줄)를 싣지 않는다.
 * 판이 쓰지 않는 열쇠는 빠진다(tests/try-messages.test.ts 가 판의 열쇠가 모두 남는지 본다)
 */
export function tryPanelMessages(me: Dictionary["me"]): Dictionary["me"] {
  return Object.fromEntries(Object.entries(me).filter(([key]) => TRY_PANEL_PREFIXES.some((prefix) => key.startsWith(prefix)))) as Dictionary["me"];
}
