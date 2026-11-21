import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import type { HomeNewsItem } from "@/lib/news/repository";

/**
 * 빌더를 위한 AI 소식 — 흥미가 낮아 맨 아래 13px 세 줄. now 는 '올해'를 정하는 서버 시각.
 *
 * 서버 부품이다(2026-11-15 공개 HTML 줄이기 2차) — 누르는 것은 링크뿐이라 소식 행(출처·회사·분류·색)을
 * 브라우저 부품 속성으로 넘기지 않고 보이는 글자로만 싣는다.
 */
export function NewsList({ news, now, locale, t }: { news: HomeNewsItem[]; now: Date; locale: Locale; t: Translator<"browse"> }) {
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
