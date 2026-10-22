import { getRequestLocale } from "@/lib/i18n/server";
import { getTranslator,getDictionary } from "@/lib/i18n/dictionary";
import { I18nProvider } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import Link from "next/link";
import { CategoryLinks } from "./CategoryLinks";
import { TrackOnMount } from "@/components/analytics/TrackOnMount";

/** /c/<모르는 값> — 조용히 전체 목록을 보이지 않고 없다고 말한 뒤 고를 분야를 준다(UX-40) */
export default async function CategoryNotFound() {
  const locale=await getRequestLocale();
  const [t,dictionary]=await Promise.all([getTranslator(locale,"browse"),getDictionary(locale,"browse")]);
  return (
    <I18nProvider locale={locale} dictionaries={{browse:dictionary}}><main className="wrap" data-track-page-type="not_found">
      <TrackOnMount name="app_error" params={{ error_code: "category_not_found", page_type: "not_found" }} />
      <section className="feed" aria-labelledby="category-missing-title">
        <div className="empty-state">
          <h1 id="category-missing-title" className="row-title">{t("category.missingTitle")}</h1>
          <p>{t("category.missingHint")}</p>
          <CategoryLinks />
          <Link prefetch={false} href={localePath(locale,"/")} className="secondary">{t("nav.home")}</Link>
        </div>
      </section>
    </main></I18nProvider>
  );
}
