import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/home/icons";
import { logger } from "@/lib/observability/logger";
import { listPublicNews, publicNewsCountsByVendor, type PublicNewsItem } from "@/lib/news/repository";
import { NEWS_SOURCES, NEWS_VENDORS, type NewsSection } from "@/lib/news/sources";
import { foldReleases, groupByDay, parseNewsFilter } from "@/lib/news/view";
import { siteOrigin } from "@/lib/site";
import "./news.css";

export const dynamic = "force-dynamic";

/**
 * 피드 리더가 두 피드를 스스로 찾게 한다. metadataBase 가 없어 상대 경로는 빌드를 막는다(app/layout.tsx).
 */
export const metadata: Metadata = {
  title: "AI 소식 — NoMoreVibe",
  description: "AI 회사가 직접 낸 발표와 코딩 도구 릴리스를 공식 피드에서 모았습니다.",
  alternates: {
    types: {
      "application/rss+xml": `${siteOrigin()}/news/feed.xml`,
      "application/feed+json": `${siteOrigin()}/news/feed.json`,
    },
  },
};

const PAGE_SIZE = 40;
const SECTIONS: { key: NewsSection | undefined; label: string }[] = [
  { key: undefined, label: "전체" },
  { key: "news", label: "공식 발표" },
  { key: "release", label: "도구 릴리스" },
];

type Props = { searchParams: Promise<{ company?: string; kind?: string; page?: string }> };

/** 거르기를 유지한 채 한 값만 바꾼 주소 */
function hrefWith(current: { company?: string; kind?: string }, change: { company?: string; kind?: string; page?: number }) {
  const next = new URLSearchParams();
  const company = "company" in change ? change.company : current.company;
  const kind = "kind" in change ? change.kind : current.kind;
  if (kind) next.set("kind", kind);
  if (company) next.set("company", company);
  if (change.page && change.page > 1) next.set("page", String(change.page));
  const query = next.toString();
  return query ? `/news?${query}` : "/news";
}

function releaseVersions(item: PublicNewsItem, more: PublicNewsItem[]): string {
  return more.map((entry) => entry.title.replace(`${item.source} `, "")).join(", ");
}

export default async function NewsPage({ searchParams }: Props) {
  const params = await searchParams;
  const filter = parseNewsFilter(params);
  const current = {
    company: NEWS_VENDORS.find((entry) => entry.name === filter.vendor)?.slug,
    kind: filter.section,
  };
  const page = Math.max(1, Math.min(50, Number.parseInt(params.page ?? "1", 10) || 1));

  let items: PublicNewsItem[] = [];
  let hasMore = false;
  let counts = new Map<string, number>();
  let unavailable = false;
  try {
    [{ items, hasMore }, counts] = await Promise.all([
      listPublicNews(filter, PAGE_SIZE, (page - 1) * PAGE_SIZE),
      publicNewsCountsByVendor(filter.section),
    ]);
  } catch (error) {
    logger.error("news.page_failed", { error });
    unavailable = true;
  }
  const days = groupByDay(foldReleases(items));
  const origin = siteOrigin();
  const feedQuery = hrefWith(current, {}).replace("/news", "");

  return (
    <main className="wrap news-page">
      <header className="news-hero">
        <div>
          <h1>AI 소식</h1>
          <p>
            AI 회사가 직접 낸 발표와 코딩 도구 릴리스를 공식 피드 {NEWS_SOURCES.length}곳에서 한 시간마다 모읍니다.
            기사를 다시 쓰지 않습니다 — 제목을 누르면 원문으로 갑니다.
          </p>
        </div>
        <div className="news-subscribe" aria-label="구독">
          <a href={`/news/feed.xml${feedQuery}`}>RSS</a>
          <a href={`/news/feed.json${feedQuery}`}>JSON Feed</a>
        </div>
      </header>

      <nav className="news-tabs" aria-label="종류">
        {SECTIONS.map((section) => (
          <Link key={section.label} href={hrefWith(current, { kind: section.key })} aria-current={current.kind === section.key ? "page" : undefined}>
            {section.label}
          </Link>
        ))}
      </nav>

      <nav className="news-vendors" aria-label="회사">
        <Link href={hrefWith(current, { company: undefined })} aria-current={!current.company ? "page" : undefined}>모든 회사</Link>
        {NEWS_VENDORS.filter((vendor) => counts.get(vendor.name)).map((vendor) => (
          <Link key={vendor.slug} href={hrefWith(current, { company: vendor.slug })} aria-current={current.company === vendor.slug ? "page" : undefined}>
            {vendor.name} <span>{counts.get(vendor.name)?.toLocaleString("ko-KR")}</span>
          </Link>
        ))}
      </nav>

      <div className="news-layout">
        <section className="news-feed" aria-label="소식 목록">
          {unavailable && <p className="news-empty">지금은 소식을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.</p>}
          {!unavailable && days.length === 0 && <p className="news-empty">이 조건의 소식이 아직 없습니다.</p>}
          {days.map((day) => (
            <section key={day.day} className="news-day" aria-labelledby={`day-${day.day}`}>
              <h2 id={`day-${day.day}`}>{day.label}</h2>
              <ol>
                {day.rows.map(({ item, more }) => (
                  <li key={item.id}>
                    <a className="news-item" href={item.url} target="_blank" rel="noopener noreferrer">
                      <div className="news-type">
                        <span className={`mini-source ${item.tone}`}>{item.vendor.charAt(0).toUpperCase()}</span>
                        {item.source}
                        <span>·</span>
                        {item.label}
                      </div>
                      <h3>{item.title}</h3>
                      {item.section === "news" && item.summary && <p className="news-summary">{item.summary}</p>}
                      {more.length > 0 && (
                        <p className="news-more">같은 날 {more.length}건 더 · {releaseVersions(item, more)}</p>
                      )}
                      <div className="news-meta">
                        <span>{new URL(item.url).hostname}</span>
                        <span>원문 <Icon name="arrow-up-right" size={10} /></span>
                      </div>
                    </a>
                  </li>
                ))}
              </ol>
            </section>
          ))}

          {(page > 1 || hasMore) && (
            <nav className="news-pages" aria-label="쪽">
              {page > 1 ? <Link href={hrefWith(current, { page: page - 1 })}>← 최신</Link> : <span />}
              <span>{page}쪽</span>
              {hasMore ? <Link href={hrefWith(current, { page: page + 1 })}>이전 소식 →</Link> : <span />}
            </nav>
          )}
        </section>

        <aside className="news-side">
          <section className="aside-card">
            <div className="aside-title">
              <h2>받아 가기</h2>
              <span className="source-pill">공개</span>
            </div>
            <p className="aside-sub">피드 리더나 직접 만든 도구에서 그대로 받아 가세요. 위에서 고른 거르기가 주소에 붙습니다.</p>
            <dl className="news-feeds">
              <dt>RSS</dt>
              <dd><code>{`${origin}/news/feed.xml${feedQuery}`}</code></dd>
              <dt>JSON Feed</dt>
              <dd><code>{`${origin}/news/feed.json${feedQuery}`}</code></dd>
              <dt>거르기</dt>
              <dd><code>?kind=news</code> 공식 발표만 · <code>?kind=release</code> 릴리스만 · <code>?company=openai</code></dd>
            </dl>
          </section>
          <section className="aside-card">
            <div className="aside-title">
              <h2>출처 {NEWS_SOURCES.length}곳</h2>
            </div>
            <p className="aside-sub">회사가 직접 운영하는 피드만 씁니다.</p>
            <ul className="news-sources">
              {NEWS_SOURCES.map((source) => (
                <li key={source.key}>
                  <span className={`mini-source ${source.tone}`}>{source.vendor.charAt(0).toUpperCase()}</span>
                  {source.name}
                  <small>{source.section === "news" ? "발표" : "릴리스"}</small>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </main>
  );
}
