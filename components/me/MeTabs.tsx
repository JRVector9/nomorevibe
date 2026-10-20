"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath, stripLocale } from "@/lib/i18n/routing";
import { ME_TAB_PATHS, ME_TABS, type MeTab } from "@/lib/me/contract";

/**
 * 마이페이지 탭 줄 — 탭마다 주소가 따로 있다. 내 프로젝트는 확인한 프로젝트가 있을 때만 맨 앞에 붙는다.
 * 숫자(counts)는 로그인했을 때만 붙고, 알림은 안 읽은 수만 빨간 표시로. 왼쪽·오른쪽 화살표로 옆 탭에 초점을 옮긴다.
 */
export function MeTabs({ showProjects = false, counts }: { showProjects?: boolean; counts?: Partial<Record<MeTab, number>> }) {
  const locale = useLocale();
  const t = useTranslations("me");
  const pathname = stripLocale(usePathname()).replace(/\/$/, "") || "/";
  const nav = useRef<HTMLElement>(null);
  const tabs = ME_TABS.filter((tab) => tab !== "projects" || showProjects);
  const active = (tab: MeTab) => pathname === ME_TAB_PATHS[tab];

  // 휴대폰에서 탭 줄은 옆으로 민다 — 지금 탭이 보이게 줄만 옮긴다(페이지는 움직이지 않는다)
  useEffect(() => {
    const row = nav.current;
    const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !current) return;
    if (current.offsetLeft < row.scrollLeft || current.offsetLeft + current.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = current.offsetLeft - 16;
    }
  }, [pathname]);

  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    const links = [...(nav.current?.querySelectorAll<HTMLAnchorElement>("a.me-tab") ?? [])];
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + links.length) % links.length;
    links[next].focus();
  }

  return (
    <nav ref={nav} className="me-tabs" aria-label={t("tabs.label")} onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const count = counts?.[tab];
        return (
          <Link key={tab} prefetch={false} href={localePath(locale, ME_TAB_PATHS[tab])} className="me-tab" aria-current={active(tab) ? "page" : undefined}>
            {t(`tabs.${tab}`)}
            {count !== undefined && (tab === "alerts"
              ? count > 0 && <span className="me-tc me-tc-hot"><span className="sr-only">{t("tabs.unread", { count })}</span><span aria-hidden="true">{formatNumber(count, locale)}</span></span>
              : <span className="me-tc">{formatNumber(count, locale)}</span>)}
          </Link>
        );
      })}
    </nav>
  );
}
