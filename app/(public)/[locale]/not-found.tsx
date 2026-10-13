import type { Metadata } from "next";
import { PublicNotFound } from "@/components/home/PublicNotFound";
import { PublicShell } from "@/components/home/PublicShell";
import { getRequestLocale } from "@/lib/i18n/server";
import { BRAND } from "@/lib/copy/brand";

export const metadata: Metadata = { title: BRAND };

export default async function NotFound() {
  const locale = await getRequestLocale();
  return PublicShell({ locale, children: await PublicNotFound({ locale }) });
}
