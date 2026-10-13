"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";

import { LAUNCH_COMMAND } from "@/lib/domain/products/launch-command";

/** 등록 안내 — 한 줄 가로형. 명령 한 줄과 버튼 하나 */
export function LaunchBand() {
  const locale = useLocale();
  const t = useTranslations("browse");
  return (
    <section className="launch-band" aria-labelledby="launch-title">
      <div>
        <h2 id="launch-title" className="launch-title">{t("launch.titleLead")}<em>{t("launch.titleFocus")}</em>{t("launch.titleTail")}</h2>
        <p className="launch-note">{t("launch.note")}</p>
      </div>
      <div className="launch-actions">
        <code className="launch-command">{LAUNCH_COMMAND}</code>
        <Link className="primary" href={localePath(locale, "/launch")}>{t("launch.flow")}</Link>
      </div>
    </section>
  );
}
