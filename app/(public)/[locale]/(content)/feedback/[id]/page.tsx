import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { getPublicSession } from "@/lib/domain/accounts/request-auth";
import { getFeedback } from "@/lib/domain/feedback/repository";
import { FeedbackItem } from "@/components/product-detail/FeedbackList";
import { getRequestLocale } from "@/lib/i18n/server";
import { getDictionary, getTranslator } from "@/lib/i18n/dictionary";
import { I18nProvider } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import { localizedAlternates, localizedOpenGraph } from "@/lib/i18n/metadata";
import { DEFAULT_SHARE_IMAGE, shareMetadata } from "@/lib/copy/share";

export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const [locale, { id }] = await Promise.all([getRequestLocale(), params]);
  const t = await getTranslator(locale, "auth");
  const title = t("feedback.metadataTitle");
  const share = shareMetadata({ title, description: t("feedback.heading"), image: { ...DEFAULT_SHARE_IMAGE, alt: title } });
  return { ...share, title, robots: { index: false, follow: false },
    ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? { alternates: localizedAlternates(locale, `/feedback/${id}`, []) } : {}),
    openGraph: { ...share.openGraph, ...localizedOpenGraph(locale, []) } };
}

export default async function FeedbackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const locale = await getRequestLocale();
  const [t, detail] = await Promise.all([
    getTranslator(locale, "auth"), getDictionary(locale, "detail"),
  ]);
  const [session, admin] = await Promise.all([getPublicSession(), currentAdmin()]);
  const feedback = await getFeedback(id, { userId: session?.user.id, admin: Boolean(admin) });
  if (!feedback) notFound();
  return <I18nProvider locale={locale} dictionaries={{ detail }} now={new Date().toISOString()}><main className="mx-auto max-w-3xl space-y-5 px-5 py-10">
    <Link prefetch={false} href={localePath(locale, `/p/${feedback.slug}`)} className="text-[14px] underline underline-offset-2">{t("feedback.backToProduct", { name: feedback.productName })}</Link>
    <h1 className="text-[22px] font-semibold">{t("feedback.heading")}</h1>
    <FeedbackItem feedback={feedback} />
  </main></I18nProvider>;
}
