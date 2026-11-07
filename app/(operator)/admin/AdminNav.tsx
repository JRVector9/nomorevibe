import Link from "next/link";
import { Fragment } from "react";
import { takedownSignal } from "@/lib/domain/products/takedown-view";
import { AdminIcon, type AdminIconName } from "./components/AdminIcon";
import { WORKSPACE_GROUPS, resolveWorkspace, type WorkspaceId } from "./workspace-navigation";

type NavPage = { href: string; label: string; hint: string; icon: AdminIconName };

/** Legacy screen inventory retained for deep links and existing callers. Primary navigation uses WORKSPACE_GROUPS. */
export const NAV_GROUPS: readonly { title: string; pages: readonly NavPage[] }[] = [
  {
    title: "일하기",
    pages: [
      { href: "/admin/flow", label: "전체 흐름", hint: "발행 전 과정·병목·장애 대응", icon: "flow" },
      { href: "/admin/inbox", label: "오늘 할 일", hint: "지금 처리할 것", icon: "inbox" },
      { href: "/admin/status", label: "운영센터", hint: "서비스·작업 현황", icon: "pulse" },
      { href: "/admin/review", label: "심사 큐", hint: "후보 검토·승인", icon: "check" },
      // /admin/products 아래에 두지 않는다 — 아래에 두면 제품과 함께 선택된 것으로 보인다
      { href: "/admin/audit", label: "내릴 후보", hint: "요청·AI가 걸러낸 발행분", icon: "down" },
      { href: "/admin/requests", label: "문의 접수", hint: "받은 메일 수동 기록·처리", icon: "inbox" },
      { href: "/admin/maker-replies", label: "메이커 답장 검수", hint: "답장 공개·숨김·복원", icon: "file" },
      { href: "/admin/feedback", label: "피드백 검수", hint: "보류·공개 글 숨김·복원", icon: "file" },
      { href: "/admin/reactions", label: "써봤어요 검수", hint: "보류한 한 줄 공개·숨김", icon: "file" },
      { href: "/admin/translations", label: "공개 번역", hint: "언어별 실패·제한 재요청", icon: "file" },
      { href: "/admin/github-integrations", label: "GitHub 연동", hint: "전송 상태·재조회·수동 재전송", icon: "key" },
      { href: "/admin/products", label: "제품", hint: "목록·제품 근거", icon: "box" },
      { href: "/admin/talk", label: "SNS 화제", hint: "수집한 HN·X·Bluesky 글 전부·홈 1위·숨기기", icon: "news" },
    ],
  },
  {
    title: "설정·기록",
    pages: [
      { href: "/admin", label: "크롤 설정", hint: "수집 규칙·검색 신호", icon: "sliders" },
      { href: "/admin/models", label: "LLM 운영", hint: "대시보드·연결·한도·작업 배정", icon: "sliders" },
      { href: "/admin/models/limits", label: "실시간 한도", hint: "경로 한도·번역 묶음·틱 예산·장비 한도", icon: "sliders" },
      { href: "/admin/models/devices", label: "장비 한도", hint: "장비별 칸 수·역할 순서·빌려 쓰기", icon: "sliders" },
      { href: "/admin/models/helpers", label: "도우미·감시자", hint: "쉬는 장비가 1·2차 검수 돕기·섀도·자동 정지", icon: "sliders" },
      { href: "/admin/models/assignments", label: "모델 배정 표", hint: "단계 × 장비 × 모델 · 순위·모드·전송", icon: "sliders" },
      { href: "/admin/categories", label: "카테고리 기준", hint: "분류 정의·예시", icon: "tag" },
      { href: "/admin/evidence", label: "근거 수집 설정", hint: "출처·갱신 정책", icon: "file" },
      { href: "/admin/ranking", label: "랭킹 설정", hint: "집계·시즌 정책", icon: "bars" },
      { href: "/admin/news", label: "AI 소식", hint: "공식 피드·게시 승인", icon: "news" },
      { href: "/admin/github-accounts", label: "GitHub 수집 계정", hint: "토큰·한도 관리", icon: "key" },
      { href: "/admin/activity", label: "작업 로그", hint: "누가 무엇을 바꿨는지", icon: "clock" },
    ],
  },
];

/** critical(빨강): 지금 막혔거나 약속을 넘김 · warn(주황): 사람이 처리할 것 · neutral(회색): 참고 수 */
export type NavBadgeTone = "critical" | "warn" | "neutral";
/**
 * 메뉴 옆 배지. label 은 보이는 짧은 글자("12", "요청 14"), title 은 마우스·화면 낭독기에 주는 설명("직접 판단 12건").
 * badges 의 열쇠는 메뉴 href 다 — 운영센터는 "/admin/status", 심사 큐는 "/admin/review".
 */
export type NavBadge = { label: string; tone: NavBadgeTone; title?: string };
export type NavBadges = Partial<Record<string, NavBadge>>;

/** 수가 0 이거나 모르면 배지를 달지 않는다 — layout.tsx 가 배지를 만들 때 쓴다 */
export function countBadge(count: number | null | undefined, tone: NavBadgeTone, title?: (count: string) => string): NavBadge | undefined {
  if (!count || count <= 0) return undefined;
  const label = count.toLocaleString("ko-KR");
  return { label, tone, title: title?.(label) };
}

/**
 * 내릴 후보 메뉴 배지 — 내려달라는 요청(24시간 넘은 것이 있으면 빨강, takedownSignal 과 같은 규칙)과 소개 수정 요청(주황, 약속 시간이 없다).
 * 보이는 글자는 짧게("요청 3 · 소개 2"), title 은 갈래와 수를 모두 적는다 — title 이 있으면 화면 낭독기는 보이는 글자 대신 title 만 읽는다.
 * 전에는 소개만 있을 때 title 이 "소개 수정 요청"(수 없음)이라 낭독·툴팁에서 수가 사라졌고, 요청이 있을 때는 title 이 없어 무슨 요청인지 몰랐다.
 */
export function auditBadge(takedowns: { pending: number; overdue: number } | null, introRequests: number,
  /**
   * 감사 거절 적체(0116) — 문턱(lib/crawl/audit-policy.ts AUDIT_BACKLOG_OVERDUE_DAYS, 7일)을 넘게 기다린 열린 거절의 수와 가장 오래 기다린 날.
   * 넘은 것이 없으면(0) 배지에 들지 않는다 — 하루 수백 건씩 들어오는 수로 걸면 배지가 늘 켜진다
   */
  auditBacklog: { overdue: number; oldestWaitDays: number | null } | null = null): NavBadge | undefined {
  const n = (value: number) => value.toLocaleString("ko-KR");
  const pending = takedowns && takedowns.pending > 0 ? takedowns : null;
  const intro = introRequests > 0 ? introRequests : 0;
  const backlog = auditBacklog && auditBacklog.overdue > 0 ? auditBacklog : null;
  if (!pending && !intro && !backlog) return undefined;
  const title = [pending && `내려달라는 요청 ${n(pending.pending)}건${pending.overdue > 0 ? `(24시간 넘음 ${n(pending.overdue)}건)` : ""}`,
    intro && `소개 수정 요청 ${n(intro)}건`,
    backlog && `감사 거절 7일 넘게 기다림 ${n(backlog.overdue)}건${backlog.oldestWaitDays !== null ? `(가장 오래 ${n(backlog.oldestWaitDays)}일)` : ""}`]
    .filter(Boolean).join(" · ");
  // 메뉴 배지는 합계 하나만 — "요청 2 · 소개 1"처럼 길면 메뉴 이름 칸이 한 글자 폭으로 줄어 세로로 쌓였다. 내역은 title(낭독 글자).
  // 감사 적체(수천 건)는 요청·소개가 없을 때만 글자가 된다 — 더하면 24시간 약속이 있는 요청 수가 그 안에 묻힌다. 적체는 빨강이 아니다
  const label = pending || intro ? n((pending?.pending ?? 0) + intro) : n(backlog!.overdue);
  return { label, tone: pending && takedownSignal(pending)?.tone === "bad" ? "critical" : "warn", title };
}

const BADGE_SOURCES: Readonly<Record<WorkspaceId, readonly string[]>> = {
  home: ["/admin/status"],
  review: ["/admin/review"],
  requests: ["/admin/audit", "/admin/requests", "/admin/feedback", "/admin/maker-replies", "/admin/reactions"],
  projects: ["/admin/audit", "/admin/products", "/admin/translations"],
  models: ["/admin/models", "/admin/models/tasks", "/admin/models/devices", "/admin/models/contracts"],
  content: ["/admin/talk", "/admin/news", "/admin/ranking"],
  settings: ["/admin/github-accounts", "/admin/github-integrations"],
};
const TONE_RANK: Record<NavBadgeTone, number> = { neutral: 0, warn: 1, critical: 2 };
const LEGACY_LABELS = Object.fromEntries(NAV_GROUPS.flatMap(group => group.pages.map(page => [page.href, page.label])));

/** The legacy audit badge contains request counts and an optional audit backlog; keep their workspace ownership separate. */
function scopedAuditBadge(id: WorkspaceId, badge: NavBadge): NavBadge | undefined {
  const title = badge.title ?? "";
  // Older callers can provide a request badge without a description. Preserve that alarm in the request inbox.
  if (!title) return id === "requests" ? badge : undefined;
  const parts = title.split(" · ");
  const requests = parts.filter(part => /내려달라는 요청|소개 수정 요청/.test(part));
  const audits = parts.filter(part => /감사 거절/.test(part));
  if (id === "requests") return requests.length ? { ...badge, title: requests.join(" · ") } : undefined;
  if (id === "projects") {
    if (!audits.length) return undefined;
    // The original label counts requests when both kinds exist. Do not present it as an audit count.
    return requests.length ? { label: "확인", tone: "warn", title: audits.join(" · ") } : badge;
  }
  return badge;
}

/**
 * A single source keeps its count. Multiple sources show the number of affected places, not a sum of overlapping
 * alerts, projects, requests or model calls. Screen-reader text preserves every source and its own unit.
 */
export function workspaceBadge(id: WorkspaceId, badges: NavBadges): NavBadge | undefined {
  const rows = [...new Set(BADGE_SOURCES[id])].flatMap(href => {
    const original = badges[href];
    const badge = original && (href === "/admin/audit" ? scopedAuditBadge(id, original) : original);
    return badge ? [{ href, badge }] : [];
  });
  if (!rows.length) return undefined;
  if (rows.length === 1) return rows[0].badge;
  return {
    label: `${rows.length}곳`,
    tone: rows.reduce<NavBadgeTone>((tone, row) => TONE_RANK[row.badge.tone] > TONE_RANK[tone] ? row.badge.tone : tone, "neutral"),
    title: rows.map(({ href, badge }) => `${LEGACY_LABELS[href] ?? href}: ${badge.title ?? badge.label}`).join(" · "),
  };
}

export function AdminNav({ current, search = "", badges = {}, onNavigate }: { current: string; search?: string; badges?: NavBadges; onNavigate?: (href: string) => void }) {
  const active = resolveWorkspace(current, new URLSearchParams(search)).workspace.id;
  return <nav aria-label="관리자 메뉴" className="prototype-navigation">
    {WORKSPACE_GROUPS.map((group, index) => <Fragment key={group.title}>
      <p className="nav-label" id={`admin-nav-group-${index}`}>{group.title}</p>
      {group.pages.map(page => {
        const badge = workspaceBadge(page.id, badges);
        return <Link key={page.id} href={page.href} aria-current={page.id === active ? "page" : undefined} prefetch={false} title={page.label}
          onNavigate={onNavigate ? () => onNavigate(page.href) : undefined}>
          <span className="nav-icon" aria-hidden="true"><AdminIcon name={page.icon} /></span><span>{page.label}</span>
          {badge && <b className="nav-badge" data-tone={badge.tone} title={badge.title}>
            {badge.title ? <><span aria-hidden="true">{badge.label}</span><span className="admin-vh">{badge.title}</span></> : badge.label}
          </b>}
        </Link>;
      })}
    </Fragment>)}
  </nav>;
}
