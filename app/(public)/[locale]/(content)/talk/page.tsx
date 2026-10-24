import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata, ResolvingMetadata } from "next";
import { ProductIcon } from "@/components/ProductIcon";
import { ProductTagline } from "@/components/ProductTagline";
import type { LocalizedTalkEntry } from "@/components/social/TalkHero";
import { TalkSparkline } from "@/components/social/TalkSparkline";
import { discussionUrl, linkOnly, sourceChip, sourceClass, sourceList } from "@/components/social/talk-format";
import "@/components/social/talk.css";
import "@/app/(public)/[locale]/(content)/popular/popular.css";
import { canonicalAlternates } from "@/app/(public)/[locale]/(content)/page";
import { CONTACT_EMAIL, pageTitle } from "@/lib/copy/brand";
import { I18nProvider } from "@/lib/i18n/context";
import { getDictionary, getTranslator } from "@/lib/i18n/dictionary";
import { formatDate, formatDateTime, formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { localizedOpenGraph } from "@/lib/i18n/metadata";
import { localizeProductList } from "@/lib/i18n/products";
import { localePath } from "@/lib/i18n/routing";
import { getRequestLocale } from "@/lib/i18n/server";
import { logger } from "@/lib/observability/logger";
import { talkVisibility } from "@/lib/social/flags";
import { listTalk, type TalkBoard } from "@/lib/social/talk";
import type { TalkMode } from "@/lib/social/talk-score";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: PageProps<"/[locale]/talk">, parent: ResolvingMetadata): Promise<Metadata> {
  void props;
  const locale = await getRequestLocale();
  const t = await getTranslator(locale, "browse");
  const title = pageTitle(t("talk.pageTitle"));
  const description = t("talk.description");
  const { visible, preview } = await talkVisibility();
  return {
    title, description, alternates: canonicalAlternates("/talk", locale),
    // 공개 전 미리보기는 색인하지 않는다
    ...(visible && !preview ? {} : { robots: { index: false, follow: false } }),
    openGraph: { ...(await parent)?.openGraph, ...localizedOpenGraph(locale), title, description, url: localePath(locale, "/talk") },
  };
}

type SearchValue = string | string[] | undefined;
const firstValue = (value: SearchValue) => Array.isArray(value) ? value[0] : value;
const MODES: { key: TalkMode; label: "talk.modeNow" | "talk.modeWeek" }[] = [{ key: "now", label: "talk.modeNow" }, { key: "week", label: "talk.modeWeek" }];

/**
 * SNS에서 화제(C안) — 공개 제품 중 SNS 글에서 이야기된 것. 1위는 맨 위 카드로 크게, 나머지는 목록.
 * 공개 전(SNS_TALK_PUBLIC_ENABLED 꺼짐)에는 관리자에게만 미리보기로 열린다.
 */
export default async function TalkPage({ searchParams }: { searchParams: Promise<{ mode?: SearchValue }> }) {
  const { visible, preview } = await talkVisibility();
  if (!visible) notFound();
  const locale = await getRequestLocale();
  const [t, dictionary] = await Promise.all([getTranslator(locale, "browse"), getDictionary(locale, "browse")]);
  const mode: TalkMode = firstValue((await searchParams).mode) === "week" ? "week" : "now";
  const now = new Date();
  const count = (n: number) => formatNumber(n, locale);

  let board: TalkBoard | null = null;
  try {
    board = await listTalk({ mode, now });
  } catch (error) {
    logger.error("talk.list_failed", { error });
  }
  const localized = await localizeProductList((board?.entries ?? []).map(entry => entry.product), locale);
  const entries: LocalizedTalkEntry[] = (board?.entries ?? []).map((entry, index) => ({ ...entry, product: localized[index] }));
  const [lead, ...rest] = entries;
  const sources = [...new Set(entries.flatMap(entry => entry.sources))];
  const recent = entries.flatMap(entry => entry.posts.map(post => ({ post, entry })))
    .sort((a, b) => b.post.postedAt.getTime() - a.post.postedAt.getTime()).slice(0, 6);
  const href = (slug: string) => localePath(locale, `/p/${slug}`);
  const firstPosted = lead ? new Date(Math.min(...lead.posts.map(post => post.postedAt.getTime()))) : null;

  return (
    <I18nProvider locale={locale} dictionaries={{ browse: dictionary }} now={now.toISOString()}><main className="wrap talk-page">
      <nav aria-label={t("nav.breadcrumb")} className="popular-crumbs">
        <Link prefetch={false} href={localePath(locale, "/")}>{t("nav.discover")}</Link><span aria-hidden="true">›</span><span aria-current="page">{t("talk.pageTitle")}</span>
      </nav>
      {preview && <p className="talk-preview" role="note">{t("talk.preview")}</p>}
      <div className="popular-heading">
        <h1>{t("talk.pageTitle")}</h1>
        <p>
          {t("talk.note", { sources: sourceList(sources) })}
          {board?.checkedAt && <> · {t("talk.checkedAt", { time: formatDateTime(board.checkedAt, now, locale) })}</>}
        </p>
      </div>
      <nav className="tabs tabs-sm" aria-label={t("talk.list")} data-track-filter="mode">
        {MODES.map(option => (
          <Link prefetch={false} key={option.key} href={localePath(locale, option.key === "now" ? "/talk" : "/talk?mode=week")} data-track-value={option.key}
            className={`tab${mode === option.key ? " active" : ""}`} aria-current={mode === option.key ? "page" : undefined}>{t(option.label)}</Link>
        ))}
      </nav>

      {!board ? <p className="talk-empty" role="status">{t("error.list")}</p> : !lead ? <p className="talk-empty" role="status">{t("talk.empty")}</p> : (
        <section className="talk-feature" aria-labelledby="talk-feature-title">
          <div className="talk-feature-main">
            <p className="talk-lead-rank">
              {mode === "now" ? t("talk.lead") : t("talk.modeWeek")} · {t("talk.sourceCount", { count: count(lead.sources.length) })}
            </p>
            <h2 id="talk-feature-title">
              <ProductIcon name={lead.product.name} ogImage={lead.product.ogImage} size={52} category={lead.product.category} />
              <Link prefetch={false} href={href(lead.product.slug)}>{lead.product.name}</Link>
            </h2>
            <ProductTagline className="talk-lead-tagline" tagline={lead.product.tagline} taglineKo={lead.product.taglineKo}
              translation={lead.product.translation} source={lead.product.taglineSource} showSource={false} />
            <PostLines entry={lead} t={t} locale={locale} now={now} />
            <div className="talk-actions">
              <Link prefetch={false} className="solid" href={href(lead.product.slug)}>{t("talk.details")}</Link>
            </div>
          </div>
          <div className="talk-feature-chart">
            <span className="talk-stat">{t(lead.starGrowth?.basis === "observation" ? "talk.starsAfterObservation" : "talk.starsAfterMention")}</span>
            {lead.starGrowth ? <>
              <b>{lead.starGrowth.delta >= 0 ? "+" : ""}{count(lead.starGrowth.delta)}</b>
              <TalkSparkline className="talk-spark-lg" width={520} height={110} growth={lead.starGrowth} postedAt={firstPosted ?? undefined}
                label={`${count(lead.starGrowth.from)} → ${count(lead.starGrowth.to)}`} />
              <span className="talk-caption">
                <span>{formatDate(lead.starGrowth.fromAt, now, locale)} {count(lead.starGrowth.from)}</span>
                <span>{formatDate(lead.starGrowth.toAt, now, locale)} {count(lead.starGrowth.to)}</span>
              </span>
            </> : <b className="talk-stat">{lead.product.stars !== null ? `★ ${count(lead.product.stars)}` : "—"}</b>}
          </div>
        </section>
      )}

      <div className="talk-layout">
        <ol className="talk-entries" aria-label={t("talk.list")} data-track-list="entries">
          {rest.map(entry => (
            <li key={entry.repositoryKey} className="talk-entry">
              <span className="talk-entry-rank">{entry.rank}</span>
              <ProductIcon name={entry.product.name} ogImage={entry.product.ogImage} size={44} category={entry.product.category} />
              <div style={{ minWidth: 0 }}>
                <div className="talk-entry-name">
                  <Link prefetch={false} href={href(entry.product.slug)}>{entry.product.name}</Link>
                </div>
                <ProductTagline className="talk-entry-tagline" tagline={entry.product.tagline} taglineKo={entry.product.taglineKo}
                  translation={entry.product.translation} source={entry.product.taglineSource} showSource={false} />
                <PostLines entry={entry} t={t} locale={locale} now={now} />
              </div>
              <div className="talk-stat">
                <span>{t("talk.stars")}</span>
                <b>{entry.product.stars !== null ? count(entry.product.stars) : "—"}</b>
                {entry.starGrowth ? <span className="talk-grow">+{count(entry.starGrowth.delta)}</span> : <span>{t("talk.outOfRange")}</span>}
              </div>
            </li>
          ))}
        </ol>
        <aside className="talk-aside">
          {recent.length > 0 && (
            <section className="talk-box" aria-labelledby="talk-timeline-title">
              <h2 id="talk-timeline-title">{t("talk.timeline")}</h2>
              <ol className="talk-timeline">
                {recent.map(({ post, entry }) => (
                  <li key={post.id}>
                    <span>{formatDate(post.postedAt, now, locale)}</span>
                    <span><b>{entry.product.name}</b> {sourceChip(post, true)} {t(linkOnly(post.source) ? "talk.xScore" : "talk.score", { points: count(post.points), comments: count(post.comments) })}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
          <section className="talk-box" aria-labelledby="talk-method-title">
            <h2 id="talk-method-title">{t("talk.methodTitle")}</h2>
            <ul>
              <li>{t("talk.methodThreshold")}</li>
              <li>{t("talk.methodBest")}</li>
              <li>{t("talk.methodDecay")}</li>
              <li>{t("talk.methodWindow")}</li>
              <li>{t("talk.methodRemoved")}</li>
              <li>{t("talk.methodX")}</li>
              <li>{t("talk.methodBluesky")}</li>
              <li>{t("talk.methodRequest", { email: CONTACT_EMAIL })}</li>
              <li>{t("talk.methodSeparate")}</li>
            </ul>
          </section>
          {board && board.unlisted.active + board.unlisted.unknown > 0 && (
            <p className="talk-unlisted">{t("talk.unlisted", { count: count(board.unlisted.active + board.unlisted.unknown), active: count(board.unlisted.active) })}</p>
          )}
        </aside>
      </div>
    </main></I18nProvider>
  );
}

/** 글 한 줄씩 — 출처 칩·제목·게시일·원문 토론 */
function PostLines({ entry, t, locale, now }: { entry: LocalizedTalkEntry; t: Translator<"browse">; locale: Locale; now: Date }) {
  const count = (n: number) => formatNumber(n, locale);
  return (
    <div className="talk-lines" data-track-product={entry.product.slug}>
      {entry.posts.slice(0, 3).map(post => {
        // X·Bluesky 게시물은 본문을 옮기지 않는다 — 반응 수와 링크만
        const reactions = linkOnly(post.source), x = post.source === "x";
        return (
          <div key={post.id} className="talk-line">
            <span className={sourceClass(post.source)}><b>{sourceChip(post)}</b> {t(reactions ? "talk.xScore" : "talk.score", { points: count(post.points), comments: count(post.comments) })}</span>
            {post.kind === "show" && <span className="talk-maker">{t("talk.byMaker")}</span>}
            {reactions ? <span className="talk-line-title">{t(x ? "talk.xPost" : "talk.bskyPost")}</span> : <span className="talk-line-title" lang="en">{post.title}</span>}
            <span>{formatDate(post.postedAt, now, locale)}</span>
            <a className="talk-link" href={discussionUrl(post)} target="_blank" rel="noopener">{t(reactions ? (x ? "talk.viewOnX" : "talk.viewOnBluesky") : "talk.discussion")} ↗</a>
          </div>
        );
      })}
    </div>
  );
}
