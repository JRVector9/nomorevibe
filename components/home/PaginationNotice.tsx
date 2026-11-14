import Link from "next/link";
import { getTranslator } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/locales";
import { paginationRestartHref, type PaginationParams } from "@/lib/web/public-pagination";

/** No list query is needed for this state. The owning page supplies noindex metadata. */
export async function PaginationNotice({ path, params, locale }: {
  path: string; params: PaginationParams; locale: Locale;
}) {
  const t = await getTranslator(locale, "browse");
  return <main className="wrap">
    <section className="feed" aria-labelledby="pagination-limit-title">
      <div className="empty-state">
        <h1 id="pagination-limit-title" className="row-title">{t("pagination.title")}</h1>
        <p>{t("pagination.hint")}</p>
        <Link prefetch={false} href={paginationRestartHref(path, params)}
          className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-full border border-line px-5 font-semibold text-accent-ink underline underline-offset-4">
          {t("pagination.restart")}
        </Link>
      </div>
    </section>
  </main>;
}
