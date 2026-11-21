import { RenderReadRecovery } from "@/components/errors/RenderReadRecovery";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata, ResolvingMetadata } from "next";
import {
  TalkCheckedAt, TalkEntryStat, TalkFeatureChart, TalkIcon, TalkPostLines, TalkSourceCount, TalkTimeline, TalkUnlisted,
} from "@/components/social/TalkFill";
import { TalkSummary } from "@/components/social/TalkHero";
import { sourceList } from "@/components/social/talk-format";
import "@/components/social/talk.css";
import "@/app/(public)/[locale]/(content)/popular/popular.css";
import { canonicalAlternates } from "@/app/(public)/[locale]/(content)/page";
import { CONTACT_EMAIL, pageTitle } from "@/lib/copy/brand";
import { I18nProvider } from "@/lib/i18n/context";
import { getDictionary, getTranslator } from "@/lib/i18n/dictionary";
import { localizedOpenGraph } from "@/lib/i18n/metadata";
import { localizeProductList } from "@/lib/i18n/products";
import { localePath } from "@/lib/i18n/routing";
import { getRequestLocale } from "@/lib/i18n/server";
import { logger } from "@/lib/observability/logger";
import { talkVisibility } from "@/lib/social/flags";
import { publicTeaser } from "@/lib/domain/products/public-teaser";
import { readTalkBoard } from "@/lib/social/home-talk";
import type { TalkBoard } from "@/lib/social/talk";
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
 *
 * 서버 HTML 에는 순위 자리·이름·요약·링크와 화면 문구만 그린다(2026-11-15 공개 HTML 이름·요약만). 표지·글(출처·제목·점수·댓글·링크·날짜)·
 * 스타·곡선·확인 시각·타임라인·공개 전 저장소 수는 TalkFill 의 자리들이 /api/talk-board?mode=<now|week> 를 한 번 받아 채운다(같은 읽기·같은 열쇠).
 */
export default async function TalkPage({ searchParams }: { searchParams: Promise<{ mode?: SearchValue }> }) {
  const { visible, preview } = await talkVisibility();
  if (!visible) notFound();
  const locale = await getRequestLocale();
  const [t, dictionary] = await Promise.all([getTranslator(locale, "browse"), getDictionary(locale, "browse")]);
  const mode: TalkMode = firstValue((await searchParams).mode) === "week" ? "week" : "now";
  const now = new Date();

  let board: TalkBoard | null = null;
  try {
    board = await readTalkBoard(mode, now);
  } catch (error) {
    logger.error("talk.list_failed", { error });
  }
  const localized = await localizeProductList((board?.entries ?? []).map(entry => entry.product), locale);
  const entries = (board?.entries ?? []).map((entry, index) => ({ rank: entry.rank, teaser: publicTeaser(localized[index], locale) }));
  const [lead, ...rest] = entries;
  // 출처 이름 목록은 화면 전체의 합 — 제품 하나의 값이 아니다
  const sources = [...new Set((board?.entries ?? []).flatMap(entry => entry.sources))];
  const href = (slug: string) => localePath(locale, `/p/${slug}`);

  return (
    <I18nProvider locale={locale} dictionaries={{ browse: dictionary }} now={now.toISOString()}><main className="wrap talk-page">
      {!board && <RenderReadRecovery key={now.toISOString()} />}
      <nav aria-label={t("nav.breadcrumb")} className="popular-crumbs">
        <Link prefetch={false} href={localePath(locale, "/")}>{t("nav.discover")}</Link><span aria-hidden="true">›</span><span aria-current="page">{t("talk.pageTitle")}</span>
      </nav>
      {preview && <p className="talk-preview" role="note">{t("talk.preview")}</p>}
      <div className="popular-heading">
        <h1>{t("talk.pageTitle")}</h1>
        <p>
          {t("talk.note", { sources: sourceList(sources) })}
          {board && <TalkCheckedAt mode={mode} />}
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
              {mode === "now" ? t("talk.lead") : t("talk.modeWeek")}<TalkSourceCount mode={mode} slug={lead.teaser.slug} />
            </p>
            <h2 id="talk-feature-title">
              <TalkIcon mode={mode} slug={lead.teaser.slug} name={lead.teaser.name} size={52} />
              <Link prefetch={false} href={href(lead.teaser.slug)}>{lead.teaser.name}</Link>
            </h2>
            <TalkSummary className="talk-lead-tagline" teaser={lead.teaser} />
            <TalkPostLines mode={mode} slug={lead.teaser.slug} />
            <div className="talk-actions">
              <Link prefetch={false} className="solid" href={href(lead.teaser.slug)}>{t("talk.details")}</Link>
            </div>
          </div>
          <TalkFeatureChart mode={mode} slug={lead.teaser.slug} />
        </section>
      )}

      <div className="talk-layout">
        <ol className="talk-entries" aria-label={t("talk.list")} data-track-list="entries">
          {rest.map(({ rank, teaser }) => (
            <li key={teaser.slug} className="talk-entry">
              <span className="talk-entry-rank">{rank}</span>
              <TalkIcon mode={mode} slug={teaser.slug} name={teaser.name} size={44} />
              <div style={{ minWidth: 0 }}>
                <div className="talk-entry-name">
                  <Link prefetch={false} href={href(teaser.slug)}>{teaser.name}</Link>
                </div>
                <TalkSummary className="talk-entry-tagline" teaser={teaser} />
                <TalkPostLines mode={mode} slug={teaser.slug} />
              </div>
              <TalkEntryStat mode={mode} slug={teaser.slug} />
            </li>
          ))}
        </ol>
        <aside className="talk-aside">
          {board && entries.length > 0 && <TalkTimeline mode={mode} />}
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
          {board && <TalkUnlisted mode={mode} />}
        </aside>
      </div>
    </main></I18nProvider>
  );
}
