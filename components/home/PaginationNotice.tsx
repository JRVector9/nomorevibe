import Link from "next/link";
import "server-only";
import type { Locale } from "@/lib/i18n/locales";
import { paginationRestartHref, type PaginationParams } from "@/lib/web/public-pagination";

// This state is rendered only on the server. Keep its copy out of the shared client browse dictionary.
const COPY = {
  ko: { title: "목록 탐색 범위를 벗어났습니다", hint: "더 많은 프로젝트를 찾으려면 검색어나 분야를 좁혀 주세요.", restart: "첫 쪽으로 돌아가기" },
  en: { title: "You have reached the browsing limit", hint: "Narrow your search or choose a category to find more projects.", restart: "Back to the first page" },
  ja: { title: "一覧の閲覧範囲を超えています", hint: "検索語やカテゴリを絞り込んで、他のプロジェクトを探してください。", restart: "最初のページに戻る" },
  "zh-Hans": { title: "已超出列表浏览范围", hint: "请缩小搜索范围或选择分类，查找更多项目。", restart: "返回第一页" },
  "zh-Hant": { title: "已超出清單瀏覽範圍", hint: "請縮小搜尋範圍或選擇分類，尋找更多專案。", restart: "返回第一頁" },
} satisfies Record<Locale, { title: string; hint: string; restart: string }>;

/** No list query is needed for this state. The owning page supplies noindex metadata. */
export function PaginationNotice({ path, params, locale }: {
  path: string; params: PaginationParams; locale: Locale;
}) {
  const copy = COPY[locale];
  return <main className="wrap">
    <section className="feed" aria-labelledby="pagination-limit-title">
      <div className="empty-state">
        <h1 id="pagination-limit-title" className="row-title">{copy.title}</h1>
        <p>{copy.hint}</p>
        <Link prefetch={false} href={paginationRestartHref(path, params)}
          className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-full border border-line px-5 font-semibold text-accent-ink underline underline-offset-4">
          {copy.restart}
        </Link>
      </div>
    </section>
  </main>;
}
