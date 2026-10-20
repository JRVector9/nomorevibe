"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath, stripLocale } from "@/lib/i18n/routing";
import { ME_TAB_PATHS, ME_TABS, type MeTab } from "@/lib/me/contract";

/** 마이페이지 탭 줄 — 탭마다 주소가 따로 있다. 내 프로젝트는 확인한 프로젝트가 있을 때만 맨 앞에 붙는다 */
export function MeTabs({ showProjects = false }: { showProjects?: boolean }) {
  const locale = useLocale();
  const t = useTranslations("me");
  const pathname = stripLocale(usePathname()).replace(/\/$/, "") || "/";
  const tabs = ME_TABS.filter((tab) => tab !== "projects" || showProjects);
  const active = (tab: MeTab) => pathname === ME_TAB_PATHS[tab];
  return (
    <nav className="me-tabs" aria-label={t("tabs.label")}>
      {tabs.map((tab) => (
        <Link key={tab} prefetch={false} href={localePath(locale, ME_TAB_PATHS[tab])} className="me-tab" aria-current={active(tab) ? "page" : undefined}>
          {t(`tabs.${tab}`)}
        </Link>
      ))}
    </nav>
  );
}
