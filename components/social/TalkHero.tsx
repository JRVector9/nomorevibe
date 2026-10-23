import Link from "next/link";
import { ProductIcon } from "@/components/ProductIcon";
import { ProductTagline } from "@/components/ProductTagline";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { localePath } from "@/lib/i18n/routing";
import type { TranslatedProduct } from "@/lib/i18n/products";
import type { TalkEntry, TalkPost, TalkProduct } from "@/lib/social/talk";
import { TalkSparkline } from "./TalkSparkline";
import { discussionUrl, linkOnly, sourceChip, sourceClass, sourceList } from "./talk-format";
import "./talk.css";

export type LocalizedTalkEntry = Omit<TalkEntry, "product"> & { product: TranslatedProduct<TalkProduct> };

/** 출처마다 가장 큰 글 하나 — 칩 하나씩 */
export function leadPosts(posts: readonly TalkPost[]): TalkPost[] {
  const seen = new Set<string>();
  return posts.filter(post => !seen.has(post.source) && seen.add(post.source));
}

export function TalkChips({ posts, t, locale, short = false }: { posts: readonly TalkPost[]; t: Translator<"browse">; locale: Locale; short?: boolean }) {
  const count = (n: number) => formatNumber(n, locale);
  return (
    <span className="talk-srcs">
      {leadPosts(posts).map(post => (
        <span key={post.id} className={sourceClass(post.source)}>
          <b>{sourceChip(post)}</b>
          {short ? count(post.points) : t(linkOnly(post.source) ? "talk.xScore" : "talk.score", { points: count(post.points), comments: count(post.comments) })}
        </span>
      ))}
    </span>
  );
}

/**
 * 홈 첫 화면 대표 구획 — 허용된 대표가 있으면 우선하고, 없으면 이미 홈 목록에 보이는 첫 항목을 크게 그린다.
 * 표시 크기만 정하며 homeTalkLineup의 승인·제외 결정과 실제 화제 순위는 바꾸지 않는다.
 */
export function TalkHero({ lead, rest, sources, t, locale, preview }: {
  lead: LocalizedTalkEntry | null;
  rest: readonly LocalizedTalkEntry[];
  sources: TalkPost["source"][];
  t: Translator<"browse">;
  locale: Locale;
  preview: boolean;
}) {
  const count = (n: number) => formatNumber(n, locale);
  const href = (slug: string) => localePath(locale, `/p/${slug}`);
  const featured = lead ?? rest[0] ?? null;
  const rows = lead ? rest : rest.slice(1);
  const firstPost = featured ? featured.posts.reduce((first, post) => post.postedAt < first.postedAt ? post : first, featured.posts[0]) : null;
  return (
    <section id="talk" className="talk-hero" aria-labelledby="talk-title">
      {preview && <p className="talk-preview" role="note">{t("talk.preview")}</p>}
      <div className="row-head">
        <div>
          <h2 id="talk-title" className="row-title">{t("talk.title")}</h2>
          <p className="row-note">{t("talk.note", { sources: sourceList(sources) })}</p>
        </div>
        <Link prefetch={false} className="row-more" href={localePath(locale, "/talk")}>{t("nav.all")} ›</Link>
      </div>
      {!featured ? <p className="talk-empty" role="status">{t("talk.empty")}</p> : (
        <div className="talk-hero-grid">
          {featured && (
            <article className="talk-lead" aria-labelledby="talk-lead-title">
              <div className="talk-lead-top">
                <ProductIcon name={featured.product.name} ogImage={featured.product.ogImage} size={60} category={featured.product.category} />
                <div style={{ minWidth: 0 }}>
                  <p className="talk-lead-rank">{t("talk.rankNow", { rank: count(featured.rank) })}</p>
                  <h3 id="talk-lead-title"><Link prefetch={false} href={href(featured.product.slug)}>{featured.product.name}</Link></h3>
                </div>
              </div>
              <ProductTagline className="talk-lead-tagline" tagline={featured.product.tagline} taglineKo={featured.product.taglineKo}
                translation={featured.product.translation} source={featured.product.taglineSource} showSource={false} />
              <TalkChips posts={featured.posts} t={t} locale={locale} />
              {featured.starGrowth && (
                <div className="talk-lead-chart">
                  <div>
                    <b>{featured.starGrowth.delta >= 0 ? "+" : ""}{count(featured.starGrowth.delta)}</b>
                    <small>{t(featured.starGrowth.basis === "mention" ? "talk.starsAfterMention" : "talk.starsAfterObservation")}</small>
                  </div>
                  <TalkSparkline growth={featured.starGrowth} postedAt={firstPost?.postedAt}
                    label={`${count(featured.starGrowth.from)} → ${count(featured.starGrowth.to)}`} />
                </div>
              )}
              <div className="talk-actions">
                <Link prefetch={false} className="solid" href={href(featured.product.slug)}>{t("talk.details")}</Link>
                {featured.posts[0] && <a href={discussionUrl(featured.posts[0])} target="_blank" rel="noopener" data-track-product={featured.product.slug}>{t("talk.discussion")} ↗</a>}
              </div>
            </article>
          )}
          {rows.length > 0 && (
            <ol className="talk-list" aria-label={t("talk.list")}>
              {rows.map(entry => (
                <li key={entry.repositoryKey} className="talk-row">
                  <span className="talk-row-rank">{entry.rank}</span>
                  <ProductIcon name={entry.product.name} ogImage={entry.product.ogImage} size={40} category={entry.product.category} />
                  <span className="talk-row-name">
                    <Link prefetch={false} href={href(entry.product.slug)}>{entry.product.name}</Link>
                    <TalkChips posts={entry.posts} t={t} locale={locale} short />
                  </span>
                  <span className="talk-row-stars">
                    {entry.product.stars !== null && <>★ {count(entry.product.stars)}</>}
                    {entry.starGrowth && entry.starGrowth.delta > 0 && <> <span className="talk-grow">+{count(entry.starGrowth.delta)}</span></>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
