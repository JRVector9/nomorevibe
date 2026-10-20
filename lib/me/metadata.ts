import type { Metadata } from "next";
import { getTranslator } from "@/lib/i18n/dictionary";
import { getRequestLocale } from "@/lib/i18n/server";
import type { MeTab } from "./contract";

/** 마이페이지는 사람마다 다르다 — 색인하지 않는다 */
export async function meMetadata(tab: MeTab): Promise<Metadata> {
  const t = await getTranslator(await getRequestLocale(), "me");
  return { title: `${t(`tabs.${tab}`)} · ${t("page.title")}`, description: t("page.description"), robots: { index: false, follow: false } };
}
