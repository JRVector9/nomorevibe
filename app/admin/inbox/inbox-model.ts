import type { InboxKey, InboxSectionData, InboxSectionResult } from "@/lib/operations/inbox";
import { ACTION_LINKS } from "../status/action-links";

/**
 * "오늘 할 일" 받은편지함의 칸 이름·차례·합계(2026-10-08 UX 감사 ADM-07). DB 를 읽지 않는다 —
 * 읽기는 lib/operations/inbox.ts 가 한다. 수는 모두 각 처리 화면이 쓰는 함수에서 오므로 그 화면의 숫자와 같다.
 */

/** 감사 탭을 바로 연다 — /admin/audit 은 기다리는 요청이 있으면 요청 탭을 먼저 연다 */
export const AUDIT_TAB_HREF = "/admin/audit?tab=audit";

/**
 * 칸의 차례 — 급한 것부터. 내려달라는 요청은 24시간 안에 처리한다고 상세 페이지에 약속했으므로 맨 위,
 * 그다음 심사(직접 판단 → 확정만), 감사, 제품 목록의 거르기들.
 */
export const INBOX_KEYS = ["takedown", "human", "agreed", "audit", "down", "intro", "repoGone", "spam"] as const satisfies readonly InboxKey[];

/** 칸마다 이름, 할 일 한 줄, 처리하는 화면 */
export const INBOX_SECTIONS: Record<InboxKey, { title: string; hint: string; href: string; action: string }> = {
  takedown: { title: "내려달라는 요청", hint: "제품 주인이 내려 달라고 한 것 — 24시간 안에 내리거나 사유를 남겨 둡니다.",
    href: ACTION_LINKS.takedowns, action: "요청 처리" },
  human: { title: "직접 판단", hint: "AI가 결론을 내지 못한 후보 — 직접 승인하거나 거부합니다.",
    href: ACTION_LINKS.reviewHuman, action: "심사 큐에서 판단" },
  agreed: { title: "확정만 하면 됨", hint: "두 모델이 같은 결론을 낸 후보 — 보고 확정만 누릅니다.",
    href: ACTION_LINKS.reviewAgreed, action: "심사 큐에서 확정" },
  audit: { title: "감사 거절", hint: "공개된 제품을 AI가 다시 보고 내리자고 한 것 — 열어 보고 내리거나 유지합니다.",
    href: AUDIT_TAB_HREF, action: "내릴 후보에서 처리" },
  down: { title: "응답 없음", hint: "연속으로 열리지 않아 공개 목록에서 빠진 제품 — 끝난 서비스인지 보고 정합니다.",
    href: ACTION_LINKS.productsDown, action: "제품 목록에서 보기" },
  intro: { title: "소개 확인", hint: "소개 검수가 근거로는 무엇인지 알 수 없다고 한 제품 — 페이지를 보고 소개를 고치거나 내립니다.",
    href: ACTION_LINKS.productsIntro, action: "제품 목록에서 보기" },
  repoGone: { title: "저장소 사라짐", hint: "GitHub 저장소가 없거나 빈 채로 하루 넘게 이어진 공개 제품 — 유지할지 내릴지 정합니다.",
    href: ACTION_LINKS.productsRepoGone, action: "제품 목록에서 보기" },
  spam: { title: "스팸 자동 차단 확인", hint: "지난 24시간에 스팸 재검사가 자동으로 내린 것 — 잘못 내려간 것은 차단을 풉니다.",
    href: ACTION_LINKS.productsSpamBanned, action: "제품 목록에서 보기" },
};

export type InboxSection = (typeof INBOX_SECTIONS)[InboxKey] & {
  key: InboxKey;
  state: "work" | "empty" | "failed";
  /** critical(빨강): 약속을 넘김 · warn(주황): 사람이 처리할 것 */
  tone: "critical" | "warn";
  data: InboxSectionData | null;
};

export type Inbox = {
  /** 할 일이 있거나 못 읽은 칸 — 급한 차례대로 */
  sections: InboxSection[];
  /** 비어 있는 칸 — 아래에 이름만 모은다 */
  clear: InboxSection[];
  /** 남은 일 — 읽은 칸의 수를 더한 것 */
  remaining: number;
  /** 못 읽은 칸의 수 — 있으면 남은 일은 remaining 보다 많을 수 있다 */
  failed: number;
  /** 최근 24시간에 처리한 것. 하나도 못 읽으면 null */
  done: number | null;
};

/**
 * 칸을 차례대로 세우고 합을 낸다.
 *
 * 할 일이 있는 칸과 못 읽은 칸은 정해진 차례 그대로 위에 둔다 — 못 읽은 칸을 아래로 내리면 거기 쌓인 일이
 * 안 보인다. 빈 칸만 아래로 모은다. 내려달라는 요청이 24시간을 넘겼으면 빨강이다.
 * done 은 처리 수의 조각들(심사 결정, 요청 처리) — 못 읽은 조각(null)은 빼고 더한다.
 */
export function assembleInbox(results: Record<InboxKey, InboxSectionResult>, done: readonly (number | null)[]): Inbox {
  const all = INBOX_KEYS.map((key): InboxSection => {
    const result = results[key];
    const data = result.ok ? result.data : null;
    return {
      key, ...INBOX_SECTIONS[key], data,
      state: !data ? "failed" : data.count > 0 ? "work" : "empty",
      tone: key === "takedown" && (data?.overdue ?? 0) > 0 ? "critical" : "warn",
    };
  });
  const known = done.filter((value): value is number => value !== null);
  return {
    sections: all.filter((section) => section.state !== "empty"),
    clear: all.filter((section) => section.state === "empty"),
    remaining: all.reduce((sum, section) => sum + (section.data?.count ?? 0), 0),
    failed: all.filter((section) => section.state === "failed").length,
    done: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
  };
}
