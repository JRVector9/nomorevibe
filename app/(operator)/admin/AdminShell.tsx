"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AdminNav, type NavBadges } from "./AdminNav";
import { adminRouteKey, createNavigationGuard, mergeBadges } from "./live-refresh";
import { CommandSearch } from "./components/CommandSearch";
import { LiveBar } from "./components/LiveBar";
import { ADMIN_THEME_SCRIPT, ThemeToggle } from "./components/ThemeToggle";
import { AdminToastProvider } from "./components/Toast";
import { resolveWorkspace } from "./workspace-navigation";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import "./prototype.css";

/**
 * 서버가 그릴 때만 실행되는 인라인 스크립트(next 가이드 preventing-flash-before-hydration) — 클라이언트 이동에서는
 * text/plain 이라 다시 돌지 않고, 그때는 ThemeToggle 의 layout effect 가 같은 일을 한다.
 */
function InlineScript({ html }: { html: string }) {
  return <script type={typeof window === "undefined" ? "text/javascript" : "text/plain"} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 메뉴 배지 한 벌 — unknown 은 이번에 셀 수 없었던 칸(배지 없음과 다르다: 전에 보이던 값을 둔다) */
export type BadgeSet = { badges?: NavBadges; unknown?: string[] };

/**
 * 메뉴 배지 — 서버 레이아웃이 넘긴 선택 값(있으면)과, 인증된 화면이 뜬 뒤 GET /admin/nav-badges 로 읽은 값.
 * 공유 레이아웃은 <Link> 이동에서 다시 그려지지 않는다(Next 문서 "layouts … do not rerender"). 받은 차례대로 합치고(mergeBadges),
 * 셀 수 없었던 칸은 전에 보이던 값을 둔다 — 다른 웹이 잰 시각끼리 견주지 않는다. 레이아웃이 새로 그리면 그 값부터 다시 합친다.
 * 인증된 첫 그리기·화면 이동(routeKey)·레이아웃 재렌더(renderedAt)에 한 번씩 부르고, 로그인 화면과 비인증 화면에서는 부르지 않는다.
 * 앞 요청은 다음 이동이나 재렌더에서 끊는다.
 */
function useLiveBadges(pathname: string, layout: BadgeSet, renderedAt: string, authenticated: boolean) {
  const [shown, setShown] = useState<{ from: string; badges: NavBadges }>(() => ({ from: renderedAt, badges: mergeBadges(undefined, layout) }));
  // 레이아웃이 다시 그렸다 — 선택 배지 값을 넘겼을 때만 그 값을 지금 보이는 것 위에 합친다(넘기지 않았으면 아래에서 새로 읽는다)
  if (shown.from !== renderedAt) setShown((prev) => ({
    from: renderedAt,
    badges: layout.badges === undefined && layout.unknown === undefined ? prev.badges : mergeBadges(prev.badges, layout),
  }));
  useEffect(() => {
    if (!authenticated || pathname.split("?")[0] === "/admin/login") return;
    const controller = new AbortController();
    fetch("/admin/nav-badges", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<BadgeSet> : null)
      .then((body) => {
        if (!controller.signal.aborted && body?.badges) setShown((prev) => prev.from === renderedAt
          ? { from: prev.from, badges: mergeBadges(prev.badges, body) }
          : prev);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [authenticated, pathname, renderedAt]);
  return shown.badges;
}

/**
 * Page bodies remain server components; this boundary only owns navigation.
 * account — 로그인한 관리자(사이드바 아래 로그아웃 옆에 보인다). badges — AdminNav 의 NavBadges(열쇠는 메뉴 href).
 * renderedAt — 레이아웃을 그린 서버 시각. 배지를 합칠 차례를 가르고, 화면이 그린 시각(PageStamp)이 오기 전 "마지막 갱신" 자리다.
 */
function AdminWorkspaceShell({ children, badges, unknownBadges, account, renderedAt, analyticsUrl }: { children: React.ReactNode; badges?: NavBadges;
  /** 이번에 셀 수 없었던 배지 칸 — 전에 보이던 값을 둔다 */
  unknownBadges?: string[]; account?: string | null; renderedAt: string;
  /** GA_PROPERTY_URL(analytics.google.com 일 때만) — 방문·여정·전환은 GA 에서 본다. 없으면 링크를 그리지 않는다 */
  analyticsUrl?: string | null }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const routeKey = adminRouteKey(pathname, search);
  const [navigation] = useState(() => createNavigationGuard());
  const navigationPending = useCallback(() => navigation.pending(), [navigation]);
  const onNavigate = (href: string) => {
    const target = new URL(href, window.location.href);
    const key = adminRouteKey(target.pathname, target.search);
    navigation.begin(routeKey, key);
  };
  useEffect(() => { navigation.committed(routeKey); }, [navigation, routeKey]);
  const location = resolveWorkspace(pathname, new URLSearchParams(search));
  const [expandedOn, setExpandedOn] = useState<string | null>(null);
  // 761~1279px 의 접힌 메뉴를 펼쳤는가 — 페이지를 옮겨도 그대로 둔다
  const liveBadges = useLiveBadges(routeKey, { badges, unknown: unknownBadges }, renderedAt, Boolean(account));
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setExpandedOn(null); };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, []);
  if (pathname === "/admin/login") return <div className="admin-login-area">{children}</div>;
  const expanded = expandedOn === routeKey;
  const initials = (account || "관리자").slice(0, 2).toUpperCase();
  return <AdminToastProvider>
    <InlineScript html={ADMIN_THEME_SCRIPT} />
    <div className="admin-prototype admin-area" data-rail="expanded" data-workspace={location.workspace.id} data-admin-detail={location.detail ?? undefined}>
      <a className="skip admin-skip" href="#admin-content">본문으로 이동</a>
      <div className="app-shell">
        <aside className={`sidebar${expanded ? " open" : ""}`} id="admin-sidebar-menu" aria-label="관리자 사이드바">
          <Link href="/admin/flow" className="brand" onNavigate={() => onNavigate("/admin/flow")}>NoMore<span>Vibe</span><small>OPERATOR WORKSPACE</small></Link>
          <CommandSearch appearance="prototype" />
          <AdminNav current={pathname} search={search} badges={liveBadges} onNavigate={onNavigate} />
          <div className="sidebar-bottom">
            <Link href="/admin/settings?tab=history" onNavigate={() => onNavigate("/admin/settings?tab=history")}>▧ &nbsp; 전체 운영 기록</Link>
            {analyticsUrl ? <a href={analyticsUrl} target="_blank" rel="noopener noreferrer">↗ &nbsp; 방문·전환 분석</a>
              : <Link href="/">↗ &nbsp; 공개 사이트로 이동</Link>}
            <div className="account"><span className="avatar">{initials}</span><span><b>{account || "관리자"}</b><small>운영 관리자 · KST</small></span><ThemeToggle compact /></div>
            <form action="/api/auth/logout" method="post"><button type="submit" className="logout">로그아웃</button></form>
          </div>
        </aside>
        <button type="button" className="sidebar-backdrop" onClick={() => setExpandedOn(null)} tabIndex={-1} aria-label="메뉴 닫기" />
        <div className="main-shell" id="admin-content" tabIndex={-1}>
          <header className="topbar">
            <div className="top-left"><button type="button" className="mobile-menu icon-button admin-menu-toggle" aria-label="메뉴 열기" aria-expanded={expanded}
              aria-controls="admin-sidebar-menu" onClick={() => setExpandedOn(expanded ? null : routeKey)}>☰</button><span id="breadcrumb">운영 / {location.workspace.label}</span></div>
            <div className="top-tools"><LiveBar fallbackAt={renderedAt} appearance="prototype" navigationPending={navigationPending} /><span className="top-avatar">{initials}</span></div>
          </header>
          <div id="page" tabIndex={-1}>
            <WorkspaceTabs location={location} onNavigate={onNavigate} />
            <div className="admin-workspace-view">{children}</div>
          </div>
          <footer className="app-footer"><span>NO MORE VIBE / ADMIN WORKSPACE</span><span>실제 운영 원본 · 관측 시각 KST</span></footer>
        </div>
      </div>
    </div>
  </AdminToastProvider>;
}

/** URL hooks are kept below Suspense so login and any prerendered route keep a valid boundary. */
export function AdminShell(props: Parameters<typeof AdminWorkspaceShell>[0]) {
  return <Suspense fallback={<div className="admin-shell-pending">{props.children}</div>}>
    <AdminWorkspaceShell {...props} />
  </Suspense>;
}
