import { getRequestLocale } from "@/lib/i18n/server";
import { getTranslator } from "@/lib/i18n/dictionary";
import { localePath } from "@/lib/i18n/routing";
import Link from "next/link";
import { CategoryLinks } from "./CategoryLinks";
import { TrackOnMount } from "@/components/analytics/TrackOnMount";

/** /c/<모르는 값> — 조용히 전체 목록을 보이지 않고 없다고 말한 뒤 고를 분야를 준다(UX-40) */
export default async function CategoryNotFound() {
  const locale=await getRequestLocale();
  // 이 화면은 모든 분야 화면의 RSC 데이터에 404 경계로 실린다 — 분야 알약은 서버가 글자로 그리고 목록 사전은 넘기지 않는다
  const [t,labels]=await Promise.all([getTranslator(locale,"browse"),getTranslator(locale,"labels")]);
  return (
    <main className="wrap" data-track-page-type="not_found">
      <TrackOnMount name="app_error" params={{ error_code: "category_not_found", page_type: "not_found" }} />
      <section className="feed" aria-labelledby="category-missing-title">
        <div className="empty-state">
          <h1 id="category-missing-title" className="row-title">{t("category.missingTitle")}</h1>
          <p>{t("category.missingHint")}</p>
          <CategoryLinks locale={locale} t={t} labels={labels} />
          <Link prefetch={false} href={localePath(locale,"/")} className="secondary">{t("nav.home")}</Link>
        </div>
      </section>
    </main>
  );
}
