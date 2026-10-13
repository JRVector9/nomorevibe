/**
 * 심사 큐 단축키(2026-10-08 UX 감사 ADM-10) — 키 한 번을 할 일 하나로 바꾼다. 화면(ReviewConsole·ReviewDetail)은
 * 이 함수가 돌려준 것만 처리하므로 키 규칙은 여기 한 곳에 있다.
 *
 * 글자 키는 event.code 로도 읽는다 — 한글 입력 상태에서는 J 가 'ㅓ'로 들어온다.
 */
export type ReviewShortcut =
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "toggle" }
  | { kind: "open" }
  | { kind: "page"; delta: 1 | -1 }
  | { kind: "help" }
  | { kind: "intent"; decision: "approve" | "reject" }
  | { kind: "reason"; index: number }
  | { kind: "submit" };

/** 단축키 표 — ? 로 여는 도움말이 그대로 그린다 */
export const SHORTCUT_TABLE: readonly [string, string][] = [
  ["J / K", "다음 줄 · 이전 줄"],
  ["Enter", "고른 줄의 근거와 결정 열기"],
  ["Space", "고른 줄을 일괄 처리에 싣기 · 빼기"],
  ["A / R", "승인 · 거부로 결정 준비"],
  ["1 ~ 5", "자주 쓰는 거부 사유 고르기"],
  ["⌘ / Ctrl + Enter", "보내고 다음 줄로"],
  ["N / P", "다음 쪽 · 이전 쪽"],
  ["?", "이 표 열기"],
];

/** 눌린 자리 — 브라우저의 Element 와 같은 모양만 본다(테스트는 DOM 없이 흉내 낸다) */
type TargetLike = { tagName?: string; type?: string; isContentEditable?: boolean; closest: (selector: string) => unknown };
type KeyLike = { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | TargetLike | null };

const LETTERS: Record<string, string> = { KeyJ: "j", KeyK: "k", KeyA: "a", KeyR: "r", KeyN: "n", KeyP: "p" };

function asTarget(target: KeyLike["target"]): TargetLike | null {
  return target && typeof (target as TargetLike).closest === "function" ? target as TargetLike : null;
}

/** 글을 쓰는 칸 — 여기서 누른 키는 단축키가 아니다(체크박스는 칸이 아니다) */
function isTyping(target: TargetLike): boolean {
  const tag = target.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !["checkbox", "radio", "button", "submit"].includes((target.type ?? "text").toLowerCase());
  return !!target.isContentEditable;
}

export function reviewShortcut(event: KeyLike): ReviewShortcut | null {
  const target = asTarget(event.target);
  // 확인 창·도움말 안의 키는 그 창의 것이다
  if (target?.closest("dialog")) return null;
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey) return { kind: "submit" };
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (target && isTyping(target)) return null;
  // Space·Enter 는 단추·링크·체크박스가 제 일을 해야 한다 — 줄이나 빈 곳에서만 받는다
  const onControl = !!target?.closest("a,button,summary,input,[role=button]");
  if (event.key === " ") return onControl ? null : { kind: "toggle" };
  if (event.key === "Enter") return !onControl && target?.closest("[data-review-row]") ? { kind: "open" } : null;
  if (event.key === "?") return { kind: "help" };
  if (/^[1-9]$/.test(event.key)) return { kind: "reason", index: Number(event.key) - 1 };
  const letter = event.key.length === 1 && /[a-z]/i.test(event.key) ? event.key.toLowerCase() : LETTERS[event.code ?? ""];
  switch (letter) {
    case "j": return { kind: "move", delta: 1 };
    case "k": return { kind: "move", delta: -1 };
    case "a": return { kind: "intent", decision: "approve" };
    case "r": return { kind: "intent", decision: "reject" };
    case "n": return { kind: "page", delta: 1 };
    case "p": return { kind: "page", delta: -1 };
    default: return null;
  }
}

/**
 * 상세 패널 안에서만 스크롤한다 — 패널이 스스로 스크롤되는 넓은 화면에서 A/R 이 페이지를 밀어 고른 줄이 위로 사라지던 것을
 * 막는다. 패널이 스크롤되지 않는 좁은 화면(표 아래에 붙는다)에서는 그 자리로 페이지를 옮긴다.
 */
export function revealInPanel(element: HTMLElement) {
  element.focus({ preventScroll: true });
  const panel = element.closest<HTMLElement>("[data-review-panel]");
  const scrolls = panel && panel.scrollHeight > panel.clientHeight && getComputedStyle(panel).overflowY !== "visible";
  if (!panel || !scrolls) { element.scrollIntoView({ block: "nearest" }); return; }
  const box = element.getBoundingClientRect(), frame = panel.getBoundingClientRect();
  if (box.top >= frame.top && box.bottom <= frame.bottom) return;
  panel.scrollTo({ top: Math.max(0, panel.scrollTop + box.top - frame.top - 16) });
}
