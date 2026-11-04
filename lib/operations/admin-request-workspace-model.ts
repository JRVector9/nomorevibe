import type { InboxItem, InboxSnapshot } from "./inbox";

export const REQUEST_WORKSPACE_TABS = ["open", "correction", "contact", "posts", "registration", "history"] as const;
export type RequestWorkspaceTab = typeof REQUEST_WORKSPACE_TABS[number];
export type RequestRead<T> = { ok: true; data: T } | { ok: false };

/** A state/offset-only URL used to be the contact screen. Keep that link contract. */
export function requestWorkspaceTab(params: Record<string, string | string[] | undefined>): RequestWorkspaceTab {
  if (typeof params.tab === "string" && (REQUEST_WORKSPACE_TABS as readonly string[]).includes(params.tab)) return params.tab as RequestWorkspaceTab;
  return params.tab === undefined && (params.state !== undefined || params.offset !== undefined) ? "contact" : "open";
}

export const REQUEST_QUEUE_SOURCES = [
  { key: "takedown", title: "내려달라는 요청", href: "/admin/requests?tab=correction#takedowns", action: "내림 요청 검토", note: "24시간 처리 약속이 있는 요청을 먼저 확인합니다." },
  { key: "introRequest", title: "소개 수정 요청", href: "/admin/requests?tab=correction#intro-requests", action: "소개 수정 검토", note: "소개 원문과 요청을 대조합니다. 요청만으로 공개 상태를 바꾸지 않습니다." },
  { key: "contact", title: "열린 문의", href: "/admin/requests?tab=contact", action: "문의 처리", note: "기존 메일함에서 수동 접수한 문의입니다. 개인정보는 문의 탭에서만 표시합니다." },
  { key: "feedback", title: "피드백 검수", href: "/admin/requests?tab=posts&kind=feedback", action: "피드백 검토", note: "공개 승인·숨김·복원은 원래 글의 상태를 유지합니다." },
  { key: "makerReply", title: "메이커 답장 검수", href: "/admin/requests?tab=posts&kind=replies", action: "답장 검토", note: "원문과 답장을 함께 확인합니다." },
] as const;

export type RequestQueueSection = {
  key: string; title: string; href: string; action: string; note: string;
  count: number | null; items: InboxItem[]; overdue: number | null;
};
export type RequestOverview = { observedAt: string | null; sections: RequestQueueSection[]; knownCount: number; failed: number };

/** User requests only: candidate review, audits and automatic processing are not added to the request badge. */
export function assembleRequestOverview(
  snapshot: InboxSnapshot | null,
  reactions: RequestRead<{ count: number; items: InboxItem[] }>,
): RequestOverview {
  const sections: RequestQueueSection[] = REQUEST_QUEUE_SOURCES.map(source => {
    const result = snapshot?.results[source.key];
    return { ...source, count: result?.ok ? result.data.count : null, items: result?.ok ? result.data.items : [],
      overdue: result?.ok ? result.data.overdue ?? 0 : null };
  });
  sections.push({ key: "reaction", title: "써봤어요 검수", href: "/admin/requests?tab=posts&kind=reactions", action: "한 줄 검토",
    note: "자동 검사가 보류한 사용자 한 줄입니다. 공개·숨김 결과를 원본에 기록합니다.",
    count: reactions.ok ? reactions.data.count : null, items: reactions.ok ? reactions.data.items : [], overdue: reactions.ok ? 0 : null });
  return { observedAt: snapshot?.fetchedAt ?? null, sections,
    knownCount: sections.reduce((sum, section) => sum + (section.count ?? 0), 0), failed: sections.filter(section => section.count === null).length };
}

export const REQUEST_HISTORY_ACTIONS = [
  "takedown-remove", "takedown-dismiss", "intro-request-edit", "intro-request-fixed", "intro-request-dismissed",
  "contact_request.create", "contact_request.update", "feedback.review", "maker_reply.review", "reaction.comment_review",
] as const;

export const REQUEST_HISTORY_LABELS: Record<string, string> = {
  "takedown-remove": "내림 요청 · 내림", "takedown-dismiss": "내림 요청 · 유지",
  "intro-request-edit": "소개 수정 반영", "intro-request-fixed": "소개 요청 처리", "intro-request-dismissed": "소개 요청 · 기존 유지",
  "contact_request.create": "문의 수동 접수", "contact_request.update": "문의 상태·메모 변경",
  "feedback.review": "피드백 공개·숨김", "maker_reply.review": "메이커 답장 공개·숨김", "reaction.comment_review": "써봤어요 검수",
};
