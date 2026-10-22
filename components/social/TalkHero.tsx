import Link from "next/link";
import { ProductIcon } from "@/components/ProductIcon";
import { ProductTagline } from "@/components/ProductTagline";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { localePath } from "@/lib/i18n/routing";
import type { TranslatedProduct } from "@/lib/i18n/products";
import type { TalkEntry, TalkPost, TalkProduct } from "@/lib/social/talk";
import { TALK_SAMPLE_TARGET } from "@/lib/social/talk-samples";
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
 * 홈 첫 화면 대표 구획(SNS 화제 C안) — 1위를 크게, 2~5위는 옆 목록.
 * 1위 자리는 관리자가 허용한 저장소만 오른다(lib/social/talk.ts homeTalkLineup). 허용된 것이 없으면 목록만 보인다.
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
  const firstPost = lead ? lead.posts.reduce((first, post) => post.postedAt < first.postedAt ? post : first, lead.posts[0]) : null;
  const sampled = Boolean(lead?.sample) || rest.some(entry => entry.sample);
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
      {!lead && !rest.length ? <p className="talk-empty" role="status">{t("talk.empty")}</p> : (
        <div className="talk-hero-grid">
          {lead && (
            <article className="talk-lead" aria-labelledby="talk-lead-title">
              <div className="talk-lead-top">
                <ProductIcon name={lead.product.name} ogImage={lead.product.ogImage} size={60} category={lead.product.category} />
                <div style={{ minWidth: 0 }}>
                  <p className="talk-lead-rank">{lead.sample ? <span className="talk-sample">{t("talk.sample")}</span> : t("talk.lead")}</p>
                  <h3 id="talk-lead-title">{lead.sample ? lead.product.name : <Link prefetch={false} href={href(lead.product.slug)}>{lead.product.name}</Link>}</h3>
                </div>
              </div>
              {lead.sample ? <p className="talk-lead-tagline talk-sample-text">{t("talk.sampleTagline")}</p> : (
                <ProductTagline className="talk-lead-tagline" tagline={lead.product.tagline} taglineKo={lead.product.taglineKo}
                  translation={lead.product.translation} source={lead.product.taglineSource} showSource={false} />
              )}
              <TalkChips posts={lead.posts} t={t} locale={locale} />
              {lead.starGrowth && (
                <div className="talk-lead-chart">
                  <div>
                    <b>{lead.starGrowth.delta >= 0 ? "+" : ""}{count(lead.starGrowth.delta)}</b>
                    <small>{t(lead.starGrowth.basis === "mention" ? "talk.starsAfterMention" : "talk.starsAfterObservation")}</small>
                  </div>
                  <TalkSparkline growth={lead.starGrowth} postedAt={firstPost?.postedAt}
                    label={`${count(lead.starGrowth.from)} → ${count(lead.starGrowth.to)}`} />
                </div>
              )}
              {!lead.sample && (
                <div className="talk-actions">
                  <Link prefetch={false} className="solid" href={href(lead.product.slug)}>{t("talk.details")}</Link>
                  {lead.posts[0] && <a href={discussionUrl(lead.posts[0])} target="_blank" rel="noopener">{t("talk.discussion")} ↗</a>}
                </div>
              )}
            </article>
          )}
          {rest.length > 0 && (
            <ol className="talk-list" aria-label={t("talk.list")}>
              {rest.map(entry => (
                <li key={entry.repositoryKey} className="talk-row">
                  <span className="talk-row-rank">{entry.rank}</span>
                  <ProductIcon name={entry.product.name} ogImage={entry.product.ogImage} size={40} category={entry.product.category} />
                  <span className="talk-row-name">
                    {entry.sample ? <span>{entry.product.name} <span className="talk-sample">{t("talk.sample")}</span></span>
                      : <Link prefetch={false} href={href(entry.product.slug)}>{entry.product.name}</Link>}
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
      {sampled && <p className="talk-sample-note" role="note">{t("talk.sampleNote", { count: count(TALK_SAMPLE_TARGET) })}</p>}
    </section>
  );
}
