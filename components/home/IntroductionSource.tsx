"use client";

import type { TaglineSource } from "@/lib/db/schema";
import { useTranslations } from "@/lib/i18n/context";

/** The original writer's provenance is separate from the language of the display. */
export function IntroductionSource({ source }: { source?: TaglineSource }) {
  const t = useTranslations("labels");
  const label = source === "ai_page" ? t("source.ai_page")
    : source === "ai_readme" ? t("source.ai_readme")
    : source === "ai_both" ? t("source.ai_both")
    : source === "ai_fixed" ? t("source.ai_fixed")
    : source === "editor" ? t("source.editor") : null;
  return label ? <p className="card-intro-source">{label}</p> : null;
}
