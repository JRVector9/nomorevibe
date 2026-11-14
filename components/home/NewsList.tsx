import { formatDate } from "@/lib/i18n/format";
import { KOREAN_BROWSE_I18N, type BrowseI18n } from "@/lib/i18n/browse-i18n";
import type { HomeNewsItem } from "@/lib/news/repository";

/** 빌더를 위한 AI 소식 — 흥미가 낮아 맨 아래 13px 세 줄. now 는 '올해'를 정하는 서버 시각 */
export function NewsList({ news, now, i18n = KOREAN_BROWSE_I18N }: { news: HomeNewsItem[]; now: Date; i18n?: BrowseI18n }) {
  const { locale, t } = i18n;
  if (news.length === 0) return null;
  return (
    <section id="news" className="news-band" aria-labelledby="news-title">
      <div className="wrap">
        <div className="row-head">
          <h2 id="news-title" className="row-title row-title-sm">{t("news.title")}</h2>
          <span className="row-note">{t("news.note")}</span>
        </div>
        <ul className="news-list">
          {news.map((item) => (
            <li key={item.url}>
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="news-row">
                <span className="news-source">{item.source}</span>
                <span className="news-title">{item.title}</span>
                <span className="news-date">{formatDate(item.publishedAt, now, locale)} ↗</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
