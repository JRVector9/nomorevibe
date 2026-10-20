"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useLocale } from "@/lib/i18n/context";
import { localePath, safePublicReturnUrl } from "@/lib/i18n/routing";

/** 지금 보던 탭으로 돌아오는 로그인 링크 — 로그인은 새 문서로 가므로 누를 때의 주소(해시 포함)를 다시 담는다 */
export function MeLoginLink({ className, children }: { className?: string; children: React.ReactNode }) {
  const locale = useLocale();
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const href = (returnTo: string) => localePath(locale, `/login?returnTo=${encodeURIComponent(safePublicReturnUrl(returnTo, localePath(locale, "/me")))}`);
  return <a className={className} href={href(`${pathname}${query ? `?${query}` : ""}`)} onClick={(event) => {
    event.currentTarget.href = href(`${window.location.pathname}${window.location.search}${window.location.hash}`);
  }}>{children}</a>;
}
