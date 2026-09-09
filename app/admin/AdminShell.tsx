"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AdminNav } from "./AdminNav";

/** Page bodies remain server components; this boundary only owns navigation. */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [expandedOn, setExpandedOn] = useState<string | null>(null);
  if (pathname === "/admin/login") return <div className="admin-login-area">{children}</div>;
  const expanded = expandedOn === pathname;
  return <div className="admin-area">
    <aside className="admin-sidebar" aria-label="관리자 사이드바">
      <div className="admin-brand-row"><Link href="/admin/status" className="admin-brand">NoMore<span>Vibe</span><small>ADMIN WORKSPACE</small></Link>
        <button type="button" className="admin-menu-toggle" aria-expanded={expanded} aria-controls="admin-sidebar-menu"
          onClick={() => setExpandedOn(expanded ? null : pathname)}>메뉴 {expanded ? "닫기" : "열기"}</button>
      </div>
      <div id="admin-sidebar-menu" className={`admin-sidebar-menu${expanded ? " is-expanded" : ""}`}>
        <AdminNav current={pathname} />
        <div className="admin-sidebar-bottom"><Link href="/">공개 사이트로 이동 ↗</Link><p>수집과 발행은 독립 워커에서 실행됩니다.</p></div>
      </div>
    </aside>
    <div className="admin-content" id="admin-content">{children}</div>
  </div>;
}
