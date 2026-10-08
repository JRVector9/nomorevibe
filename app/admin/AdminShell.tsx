"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AdminNav, type NavBadges } from "./AdminNav";
import { AdminIcon } from "./components/AdminIcon";
import { ADMIN_THEME_SCRIPT, ThemeToggle } from "./components/ThemeToggle";
import { AdminToastProvider } from "./components/Toast";

/**
 * 서버가 그릴 때만 실행되는 인라인 스크립트(next 가이드 preventing-flash-before-hydration) — 클라이언트 이동에서는
 * text/plain 이라 다시 돌지 않고, 그때는 ThemeToggle 의 layout effect 가 같은 일을 한다.
 */
function InlineScript({ html }: { html: string }) {
  return <script type={typeof window === "undefined" ? "text/javascript" : "text/plain"} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Page bodies remain server components; this boundary only owns navigation.
 * account — 로그인한 관리자(사이드바 아래 로그아웃 옆에 보인다). badges — AdminNav 의 NavBadges(열쇠는 메뉴 href).
 */
export function AdminShell({ children, badges, account }: { children: React.ReactNode; badges?: NavBadges; account?: string | null }) {
  const pathname = usePathname();
  const [expandedOn, setExpandedOn] = useState<string | null>(null);
  // 761~1279px 의 접힌 메뉴를 펼쳤는가 — 페이지를 옮겨도 그대로 둔다
  const [railExpanded, setRailExpanded] = useState(false);
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
          <AdminNav current={pathname} badges={badges} />
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
      <div className="admin-content" id="admin-content" tabIndex={-1}>{children}</div>
    </div>
  </AdminToastProvider>;
}
