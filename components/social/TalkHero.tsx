import Link from "next/link";
import { publicTeaser, type PublicTeaser } from "@/lib/domain/products/public-teaser";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { localePath } from "@/lib/i18n/routing";
import type { TranslatedProduct } from "@/lib/i18n/products";
import type { TalkEntry, TalkPost, TalkProduct } from "@/lib/social/talk";
import { TalkIcon, TalkLeadDiscussion, TalkLeadFacts, TalkRowChips, TalkRowStars } from "./TalkFill";
import { sourceList } from "./talk-format";
import "./talk.css";

export type LocalizedTalkEntry = Omit<TalkEntry, "product"> & { product: TranslatedProduct<TalkProduct> };

/** 이름 아래 한 줄 요약 — 서버가 그 언어로 고른 값(public-teaser.ts) */
export function TalkSummary({ teaser, className }: { teaser: PublicTeaser; className: string }) {
  return <p className={className} lang={teaser.lang}>{teaser.summary}</p>;
}

/**
 * 홈 첫 화면 대표 구획 — 허용된 대표가 있으면 우선하고, 없으면 이미 홈 목록에 보이는 첫 항목을 크게 그린다.
 * 표시 크기만 정하며 homeTalkLineup의 승인·제외 결정과 실제 화제 순위는 바꾸지 않는다.
 *
 * 서버 HTML 에는 순위 자리·이름·요약·링크만 그린다(2026-11-15 공개 HTML 이름·요약만). 표지·출처 칩·점수·스타·곡선·원문 토론 링크는
 * TalkFill 의 자리들이 /api/talk-board?mode=home 을 한 번 받아 채운다 — 자리 속성은 slug·이름뿐이다.
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
  const hero = featured ? publicTeaser(featured.product, locale) : null;
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
      {!featured || !hero ? <p className="talk-empty" role="status">{t("talk.empty")}</p> : (
        <div className="talk-hero-grid">
          <article className="talk-lead" aria-labelledby="talk-lead-title">
            <div className="talk-lead-top">
              <TalkIcon mode="home" slug={hero.slug} name={hero.name} size={60} />
              <div style={{ minWidth: 0 }}>
                <p className="talk-lead-rank">{t("talk.rankNow", { rank: count(featured.rank) })}</p>
                <h3 id="talk-lead-title"><Link prefetch={false} href={href(hero.slug)}>{hero.name}</Link></h3>
              </div>
            </div>
            <TalkSummary className="talk-lead-tagline" teaser={hero} />
            <TalkLeadFacts mode="home" slug={hero.slug} />
            <div className="talk-actions">
              <Link prefetch={false} className="solid" href={href(hero.slug)}>{t("talk.details")}</Link>
              <TalkLeadDiscussion mode="home" slug={hero.slug} />
            </div>
          </article>
          {rows.length > 0 && (
            <ol className="talk-list" aria-label={t("talk.list")}>
              {rows.map(entry => {
                const { slug, name } = entry.product;
                return (
                  <li key={slug} className="talk-row">
                    <span className="talk-row-rank">{entry.rank}</span>
                    <TalkIcon mode="home" slug={slug} name={name} size={40} />
                    <span className="talk-row-name">
                      <Link prefetch={false} href={href(slug)}>{name}</Link>
                      <TalkRowChips mode="home" slug={slug} />
                    </span>
                    <TalkRowStars mode="home" slug={slug} />
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
