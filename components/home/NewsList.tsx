import type { HomeNewsItem } from "@/lib/news/repository";

function postedOn(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit" }).format(at).replace("-", ".");
}

/** 빌더를 위한 AI 소식 — 흥미가 낮아 맨 아래 13px 세 줄 */
export function NewsList({ news }: { news: HomeNewsItem[] }) {
  if (news.length === 0) return null;
  return (
    <section id="news" className="news-band" aria-labelledby="news-title">
      <div className="wrap">
        <div className="row-head">
          <h2 id="news-title" className="row-title row-title-sm">빌더를 위한 AI 소식</h2>
          <span className="row-note">회사 공식 피드 · 회사마다 최신 1건</span>
        </div>
        <ul className="news-list">
          {news.map((item) => (
            <li key={item.url}>
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="news-row">
                <span className="news-source">{item.source}</span>
                <span className="news-title">{item.title}</span>
                <span className="news-date">{postedOn(item.publishedAt)} ↗</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
