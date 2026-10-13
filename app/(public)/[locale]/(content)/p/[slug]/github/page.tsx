import { I18nProvider } from "@/lib/i18n/context";
import { getDictionary, getTranslator } from "@/lib/i18n/dictionary";
import { getRequestLocale } from "@/lib/i18n/server";
import { localePath } from "@/lib/i18n/routing";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DetailLoginLink } from "@/components/product-detail/DetailLoginLink";
import { GithubIntegrationSettings } from "@/components/product-detail/GithubIntegrationSettings";
import { getPublicSession } from "@/lib/domain/accounts/request-auth";
import { productFeedbackEnabled, publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { findBySlug } from "@/lib/domain/products/repository";
import { parseGithubRepository } from "@/lib/github/repositories";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export async function generateMetadata() { const t = await getTranslator(await getRequestLocale(), "detail"); return { title: t("settings.title"), robots: { index: false, follow: false } }; }
type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

async function MakerSettings({ slug, searchParams }: { slug: string; searchParams: Props["searchParams"] }) {
  const locale = await getRequestLocale();
  const t = await getTranslator(locale, "detail");
  const installationPending = (await searchParams).pending === "1";
  const session = await getPublicSession();
  if (!session) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(await searchParams)) {
      if (typeof value === "string") query.append(key, value);
      else if (Array.isArray(value)) for (const entry of value) query.append(key, entry);
    }
    return <p className="mt-6 text-[14px] leading-6">{t("settings.loginNote")} {" "}<DetailLoginLink path={`/p/${encodeURIComponent(slug)}/github`} query={query.size ? `?${query}` : ""}>{t("settings.login")}</DetailLoginLink></p>;
  }
  return <GithubIntegrationSettings slug={slug} csrfToken={session.csrfToken} installationPending={installationPending} />;
}

export default async function GithubSettingsPage({ params, searchParams }: Props) {
  if (!publicUserAuthEnabled() || !productFeedbackEnabled()) notFound();
  const locale = await getRequestLocale();
  const [t, dictionary] = await Promise.all([getTranslator(locale, "detail"), getDictionary(locale, "detail")]);
  const { slug } = await params;
  const product = await findBySlug(slug);
  if (!product || product.status === "banned") notFound();
  const repository = parseGithubRepository(product.repoUrl ?? "");
  return <I18nProvider locale={locale} dictionaries={{ detail: dictionary }}><main className="mx-auto max-w-2xl px-5 py-12 text-fg">
    <Link prefetch={false} href={localePath(locale, `/p/${encodeURIComponent(slug)}`)} className="text-[14px] underline underline-offset-2">{t("settings.back", { name: product.name })}</Link>
    <h1 className="mt-6 text-2xl font-semibold">{t("settings.title")}</h1>
    {repository ? <>
      <p className="mt-3 text-[14px] leading-6">{t("settings.repository")} <a href={repository.htmlUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{repository.fullName}</a></p>
      <Suspense fallback={<p className="mt-6 text-[14px]">{t("settings.checkingSession")}</p>}><MakerSettings slug={slug} searchParams={searchParams} /></Suspense>
    </> : <p className="mt-6 text-[14px] leading-6">{t("settings.noRepository")}</p>}
  </main></I18nProvider>;
}
