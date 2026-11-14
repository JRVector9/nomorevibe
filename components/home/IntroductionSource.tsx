"use client";

import type { TaglineSource } from "@/lib/db/schema";
import { useTranslations } from "@/lib/i18n/context";
import { SourceLine } from "@/components/cards/views";

/** The original writer's provenance is separate from the language of the display. */
export function IntroductionSource({ source }: { source?: TaglineSource }) {
  return <SourceLine source={source} t={useTranslations("labels")} />;
}
