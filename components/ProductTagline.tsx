"use client";

import type { TaglineSource } from "@/lib/db/schema";
import type { ProductTranslationSelection } from "@/lib/domain/products/translation-policy";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { TaglineView } from "@/components/cards/views";
export { englishLang } from "@/lib/i18n/content-language";

/** Original text stays available; each locale chooses only a current translation. 서버 부품은 components/cards/views.tsx TaglineView 를 바로 쓴다 */
export function ProductTagline(props: {
  tagline: string;
  taglineKo?: string | null;
  translation?: ProductTranslationSelection;
  source?: TaglineSource | null;
  className?: string;
  showSource?: boolean;
  original?: "tooltip" | "toggle";
}) {
  return <TaglineView {...props} locale={useLocale()} t={useTranslations("labels")} />;
}
