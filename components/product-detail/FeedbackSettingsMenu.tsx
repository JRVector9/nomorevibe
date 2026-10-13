"use client";

import { useLocale, useTranslations } from "@/lib/i18n/context";
import Link from "next/link";
import { localePath } from "@/lib/i18n/routing";

export function FeedbackSettingsMenu({ slug }: { slug: string }) {
  const t = useTranslations("detail");
  const locale = useLocale();
  return (
    <details className="relative shrink-0">
      <summary aria-label={t("settings.menu")} className="flex min-h-11 w-11 cursor-pointer list-none items-center justify-center rounded text-[18px] text-fg-2 hover:text-fg [&::-webkit-details-marker]:hidden">···</summary>
      <div className="absolute right-0 top-full z-10 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-bg-card p-2 shadow-sm">
        <Link prefetch={false} href={localePath(locale, `/p/${encodeURIComponent(slug)}/github`)} className="flex min-h-11 items-center rounded px-3 text-[13px] hover:bg-bg-soft">{t("settings.title")}</Link>
      </div>
    </details>
  );
}
