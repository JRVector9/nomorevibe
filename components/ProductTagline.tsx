"use client";

import type { TaglineSource } from "@/lib/db/schema";
import type { ProductTranslationSelection } from "@/lib/domain/products/translation-policy";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { englishLang } from "@/lib/i18n/content-language";
import { IntroductionSource } from "./home/IntroductionSource";
import { trackAttrs } from "@/lib/analytics/attrs";
export { englishLang } from "@/lib/i18n/content-language";

/** Original text stays available; each locale chooses only a current translation. */
export function ProductTagline({ tagline, taglineKo, translation, source, className, showSource = true, original = "tooltip" }: {
  tagline: string;
  taglineKo?: string | null;
  translation?: ProductTranslationSelection;
  source?: TaglineSource | null;
  className?: string;
  showSource?: boolean;
  original?: "tooltip" | "toggle";
}) {
  const locale = useLocale();
  const t = useTranslations("labels");
  const korean = locale === "ko" ? taglineKo?.trim() || null : null;
  const translated = locale === "ko" ? Boolean(korean) : translation?.translated === true;
  const text = locale === "ko" ? korean ?? tagline : translation?.text ?? tagline;
  const lang = locale === "ko" ? korean ? "ko" : englishLang(tagline) : translation?.lang;
  const pending = locale !== "ko" && (translation?.pending ?? Boolean(tagline.trim()));
  const title = translated && original === "tooltip" ? t("content.originalText", { text: tagline }) : text;
  return (
    <>
      <p className={className} title={title} lang={lang}>{text}</p>
      {pending && <p className="card-intro-source">{t("content.pending")}</p>}
      {translated && translation?.provenance === "machine" && <p className="card-intro-source">{t("content.machineTranslation")}</p>}
      {showSource && <IntroductionSource source={source ?? undefined} />}
      {translated && original === "toggle" && (
        <details className="text-[13px] leading-[1.5] text-fg-2">
          <summary className="inline-flex min-h-8 cursor-pointer select-none items-center text-accent-ink hover:underline"
            {...trackAttrs("select_content", { content_type: "tagline", content_id: "original" })}>{t("content.original")}</summary>
          <p lang={locale === "ko" ? englishLang(tagline) : translation?.sourceLocale ?? undefined} className="m-0 mt-1 max-w-[720px] text-[15px] leading-[1.5] text-fg-2">{tagline}</p>
        </details>
      )}
    </>
  );
}
