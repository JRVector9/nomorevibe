"use client";

import type { ReactNode } from "react";
import { useLocale } from "@/lib/i18n/context";
import { localePath, stripLocale } from "@/lib/i18n/routing";

/** The hash is only available in the browser; retain it when starting authentication. */
export function DetailLoginLink({ path, query = "", children }: { path: string; query?: string; children: ReactNode }) {
  const locale = useLocale();
  const publicPath = localePath(locale, path);
  const loginHref = (returnTo: string) => localePath(locale, `/login?returnTo=${encodeURIComponent(returnTo)}`);
  return <a href={loginHref(`${publicPath}${query}`)} className="underline underline-offset-2" onClick={(event) => {
    const current = new URL(window.location.href);
    if (stripLocale(current.pathname) === path) {
      event.currentTarget.href = loginHref(`${publicPath}${current.search}${current.hash}`);
    }
  }}>{children}</a>;
}
