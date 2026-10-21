"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AdminNav, type NavBadges } from "./AdminNav";
import { mergeBadges } from "./live-refresh";
import { AdminIcon } from "./components/AdminIcon";
import { CommandSearch } from "./components/CommandSearch";
import { LiveBar } from "./components/LiveBar";
import { ADMIN_THEME_SCRIPT, ThemeToggle } from "./components/ThemeToggle";
import { AdminToastProvider } from "./components/Toast";

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
 * 메뉴 배지 — 레이아웃이 그린 값(처음·자동 갱신·새로고침)과, 화면을 옮길 때마다 GET /admin/nav-badges 로 다시 받은 값.
 * 공유 레이아웃은 <Link> 이동에서 다시 그려지지 않는다(Next 문서 "layouts … do not rerender"). 받은 차례대로 합치고(mergeBadges),
 * 셀 수 없었던 칸은 전에 보이던 값을 둔다 — 다른 웹이 잰 시각끼리 견주지 않는다. 레이아웃이 새로 그리면 그 값부터 다시 합친다.
 * 첫 그리기에서는 부르지 않는다(레이아웃이 방금 셌다). 앞 요청은 다음 이동에서 끊는다.
 */
function useLiveBadges(pathname: string, layout: BadgeSet, renderedAt: string) {
  const [shown, setShown] = useState<{ from: string; badges: NavBadges }>(() => ({ from: renderedAt, badges: mergeBadges(undefined, layout) }));
  // 레이아웃이 다시 그렸다 — 그 값을 지금 보이는 것 위에 합친다(그리는 중에 맞추는 React 방식)
  if (shown.from !== renderedAt) setShown((prev) => ({ from: renderedAt, badges: mergeBadges(prev.badges, layout) }));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (pathname === "/admin/login") return;
    const controller = new AbortController();
    fetch("/admin/nav-badges", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<BadgeSet> : null)
      .then((body) => { if (body?.badges) setShown((prev) => ({ from: prev.from, badges: mergeBadges(prev.badges, body) })); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [pathname]);
  return shown.badges;
}

/**
 * Page bodies remain server components; this boundary only owns navigation.
 * account — 로그인한 관리자(사이드바 아래 로그아웃 옆에 보인다). badges — AdminNav 의 NavBadges(열쇠는 메뉴 href).
 * renderedAt — 레이아웃을 그린 서버 시각. 배지를 합칠 차례를 가르고, 화면이 그린 시각(PageStamp)이 오기 전 "마지막 갱신" 자리다.
 */
export function AdminShell({ children, badges, unknownBadges, account, renderedAt }: { children: React.ReactNode; badges?: NavBadges;
  /** 이번에 셀 수 없었던 배지 칸 — 전에 보이던 값을 둔다 */
  unknownBadges?: string[]; account?: string | null; renderedAt: string }) {
  const pathname = usePathname();
  const [expandedOn, setExpandedOn] = useState<string | null>(null);
  // 761~1279px 의 접힌 메뉴를 펼쳤는가 — 페이지를 옮겨도 그대로 둔다
  const [railExpanded, setRailExpanded] = useState(false);
  const liveBadges = useLiveBadges(pathname, { badges, unknown: unknownBadges }, renderedAt);
  if (pathname === "/admin/login") return <div className="admin-login-area">{children}</div>;
  const expanded = expandedOn === pathname;
  return <AdminToastProvider>
    <InlineScript html={ADMIN_THEME_SCRIPT} />
    <div className="admin-area" data-rail={railExpanded ? "expanded" : undefined}>
      <a className="admin-skip" href="#admin-content">본문으로 건너뛰기</a>
      <aside className="admin-sidebar" aria-label="관리자 사이드바">
        <div className="admin-brand-row"><Link href="/admin/status" className="admin-brand">
          <span className="admin-brand-full">NoMore<span>Vibe</span><small>ADMIN WORKSPACE</small></span>
          <span className="admin-brand-short" aria-hidden="true">N<span>V</span></span>
        </Link>
          <button type="button" className="admin-menu-toggle" aria-expanded={expanded} aria-controls="admin-sidebar-menu"
            onClick={() => setExpandedOn(expanded ? null : pathname)}>메뉴 {expanded ? "닫기" : "열기"}</button>
        </div>
        <button type="button" className="admin-rail-toggle" aria-expanded={railExpanded} aria-controls="admin-sidebar-menu"
          title={railExpanded ? "메뉴 이름 접기" : "메뉴 이름 펼치기"} onClick={() => setRailExpanded(!railExpanded)}>
          <AdminIcon name="panel" size={16} /><span className="admin-rail-label">{railExpanded ? "메뉴 이름 접기" : "메뉴 이름 펼치기"}</span>
        </button>
        <div id="admin-sidebar-menu" className={`admin-sidebar-menu${expanded ? " is-expanded" : ""}`}>
          {/* 전역 검색(⌘K, ADM-05) — 메뉴 맨 위. 단축키는 어느 화면에서든 듣는다 */}
          <CommandSearch />
          <AdminNav current={pathname} badges={liveBadges} />
          <div className="admin-sidebar-bottom">
            <ThemeToggle />
            {account && <div className="admin-account">
              <span className="admin-sidebar-label" title={account}>{account}</span>
              {/* 크롤 설정 머리의 로그아웃과 같은 경로 — POST 만 받는다 */}
              <form action="/api/auth/logout" method="post">
                <button type="submit" className="admin-sidebar-button" title="로그아웃"><AdminIcon name="logout" size={14} /><span className="admin-sidebar-label">로그아웃</span></button>
              </form>
            </div>}
            <Link href="/" className="admin-sidebar-button" title="공개 사이트로 이동"><AdminIcon name="external" size={14} /><span className="admin-sidebar-label">공개 사이트로 이동</span></Link>
            <p>수집과 발행은 독립 워커에서 실행됩니다.</p>
          </div>
        </div>
      </aside>
      <div className="admin-content" id="admin-content" tabIndex={-1}>
        <LiveBar fallbackAt={renderedAt} />
        {children}
      </div>
    </div>
  </AdminToastProvider>;
}
