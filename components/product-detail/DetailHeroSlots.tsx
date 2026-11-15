"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { ProductIcon } from "@/components/ProductIcon";
import { FillLine } from "@/components/cards/fill-line";
import { SourceLine } from "@/components/cards/views";
import { translatedCategory } from "@/components/home/i18n";
import { FollowButton } from "@/components/me/FollowButton";
import type { FollowLabels } from "@/components/me/follow-labels";
import type { DetailHero } from "@/lib/domain/products/detail-page-data";
import { isHealthCurrent } from "@/lib/domain/products/health-freshness";
import { englishLang } from "@/lib/i18n/content-language";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { localePath } from "@/lib/i18n/routing";
import { trackAttrs } from "@/lib/analytics/attrs";
import { useDetailExtras } from "./DetailExtras";
import { FeedbackSettingsMenu } from "./FeedbackSettingsMenu";
import { GithubStarButton } from "./GithubStarButton";
import { InstallPrompt } from "./InstallPrompt";
import { PreviewFigure } from "./PreviewFigure";
import { ReadmeLoader } from "./ReadmeLoader";
import { README_HEADING, README_SCROLL } from "./readme-style";
import { SaveButton } from "./SaveButton";
import { ShareButton } from "./ShareButton";
import { UnclaimedOwnerContact } from "./UnclaimedOwnerContact";

/**
 * 상세의 이름·요약 밖 칸(2026-11-15 공개 HTML 이름·요약만, 문서 4.2) — 서버 HTML 에는 h1 이름·요약·빵부스러기·JSON-LD 만 있고,
 * 머리의 아이콘·배지·출처 줄·메타 줄·단추와 소개·README 발췌·미리보기·운영자 상자는 같은 출처 API(/api/products/[slug]/details)
 * 한 번으로 받아 채운다(DetailExtras 의 자리들과 같은 받기). 받는 동안은 같은 크기의 빈 자리(글자 없음, aria-busy), 못 받으면 비운다.
 */
const Markdown = dynamic(() => import("./ReadmeMarkdown").then((module) => module.ReadmeMarkdown), { ssr: false });

/** 단추 — 모바일(390px)에서 네 개가 한 줄에 들도록 좁은 화면은 글자·여백을 조금 줄인다 */
const BUTTON = "inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-[14px] font-medium sm:px-5 sm:text-[15px]";
/** 홈 '지금 뜨는'과 같은 순위 — 20위 안일 때만 배지 */
const RISING_BADGE_MAX = 20;

function useHero(slug: string): { hero: DetailHero | null; done: boolean } {
  const { data, done } = useDetailExtras(slug);
  return { hero: data?.hero ?? null, done };
}

export function HeroIconSlot({ slug, name }: { slug: string; name: string }) {
  const { hero } = useHero(slug);
  const safeIcon = hero?.ogImage?.startsWith("/") ? hero.ogImage : null;
  // 아이콘 칸은 늘 80px — 받기 전에는 같은 크기의 바탕만
  return hero ? <ProductIcon name={name} ogImage={safeIcon} size={80} category={hero.category} /> : <span aria-hidden="true" className="block h-20 w-20" />;
}

export function HeroBadgesSlot({ slug }: { slug: string }) {
  const { hero } = useHero(slug);
  const t = useTranslations("detail");
  const locale = useLocale();
  if (!hero) return null;
  return <>
    {hero.risingRank !== null && hero.risingRank <= RISING_BADGE_MAX && (
      <Link prefetch={false} href={localePath(locale, "/#rising")} className="inline-flex h-7 items-center rounded-full bg-accent-soft px-[11px] text-[13px] font-semibold text-accent-ink">
        {t("hero.rising", { rank: formatNumber(hero.risingRank, locale) })}
      </Link>
    )}
    {hero.talkRank !== null && (
      <Link prefetch={false} href={localePath(locale, "/talk")} className="inline-flex h-7 items-center rounded-full bg-[var(--source-hn-soft)] px-[11px] text-[13px] font-semibold text-[var(--source-hn)]">
        {t("talk.pill", { rank: formatNumber(hero.talkRank, locale) })}
      </Link>
    )}
  </>;
}

/** 요약 아래의 번역 표시·원문 보기·출처 줄 — 요약 글 자체는 서버 HTML 에 있다 */
export function HeroTaglineNotes({ slug }: { slug: string }) {
  const { hero, done } = useHero(slug);
  const locale = useLocale();
  const labels = useTranslations("labels");
  if (!done) return <p className="card-intro-source m-0 text-[13px]"><FillLine width="9em" /></p>;
  if (!hero) return null;
  const translated = locale === "ko" ? Boolean(hero.taglineKo?.trim()) : hero.translation?.translated === true;
  const pending = locale !== "ko" && (hero.translation?.pending ?? Boolean(hero.tagline.trim()));
  return <>
    {pending && <p className="card-intro-source">{labels("content.pending")}</p>}
    {translated && hero.translation?.provenance === "machine" && <p className="card-intro-source">{labels("content.machineTranslation")}</p>}
    {translated && (
      <details className="text-[13px] leading-[1.5] text-fg-2">
        <summary className="inline-flex min-h-8 cursor-pointer select-none items-center text-accent-ink hover:underline"
          {...trackAttrs("select_content", { content_type: "tagline", content_id: "original" })}>{labels("content.original")}</summary>
        <p lang={locale === "ko" ? englishLang(hero.tagline) : hero.translation?.sourceLocale ?? undefined} className="m-0 mt-1 max-w-[720px] text-[15px] leading-[1.5] text-fg-2">{hero.tagline}</p>
      </details>
    )}
    {/* 지은 줄은 무엇을 보고 지었는지까지 밝힌다 — 메이커가 소개를 쓰면 이 표시는 사라진다 */}
    {hero.taglineSource !== "maker" && <SourceLine source={hero.taglineSource} t={labels} />}
  </>;
}

/** 오래된 확인은 온라인이라 하지 않고, 한 번 실패는 연속 실패 기준(down) 전까지 '불안정'이라 하지 않는다 */
function HealthStatus({ health, t, now, locale }: { health: DetailHero["health"]; t: Translator<"detail">; now: Date; locale: Locale }) {
  if (!health.checkedAt) return <span>{t("health.before")}</span>;
  if (!isHealthCurrent(health.checkedAt, now)) return <span>{t("health.recheck")}</span>;
  if (health.down) return <span className="text-down">{t("health.down")}</span>;
  if (health.lastCheckSucceeded === false) return <span className="text-down">{t("health.failed")}</span>;
  return (
    <span className="inline-flex items-center gap-1.5" title={health.latencyMs === null ? undefined : t("hero.latency", { ms: formatNumber(health.latencyMs, locale) })}>
      <i aria-hidden className="inline-block h-2 w-2 rounded-full bg-up" />
      {t("health.online")}
    </span>
  );
}

export type HeroFollowLabels = { product: FollowLabels; maker: FollowLabels } | null;

/** 메타 한 줄 — 분야 · ★ · 언어 · GitHub 주인 · 가동 상태 · 운영자 미확인 */
export function HeroMetaSlot({ slug, followLabels }: { slug: string; followLabels: HeroFollowLabels }) {
  const { hero, done } = useHero(slug);
  const t = useTranslations("detail");
  const labels = useTranslations("labels");
  const locale = useLocale();
  const now = useServerNow();
  const line = "flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px] text-fg-2 tabular-nums";
  if (!done) return <p className={line} aria-busy="true"><FillLine width="18em" /></p>;
  if (!hero) return null;
  const maker = hero.follow?.maker && followLabels ? { ...followLabels.maker, aria: followLabels.maker.aria.replace("\u0000", hero.follow.maker.login) } : null;
  return (
    <p className={line}>
      <span className="text-fg">{translatedCategory(hero.category, labels)}</span>
      {hero.githubStar ? <><span aria-hidden>·</span><GithubStarButton key={slug} slug={slug} stars={hero.stars} /></>
        : hero.stars !== null && <><span aria-hidden>·</span><span className="font-medium text-fg">★ {formatNumber(hero.stars, locale)}</span></>}
      {hero.languages.length > 0 && <><span aria-hidden>·</span><span>{hero.languages.join(" · ")}</span></>}
      {hero.owner && <><span aria-hidden>·</span><span>GitHub @{hero.owner.login}</span>
        {maker && hero.follow?.maker && <FollowButton target="maker" targetKey={hero.follow.maker.key} labels={maker} variant="inline" />}</>}
      <span aria-hidden>·</span>
      {hero.accessMode === "installable" ? <span>{t("hero.installable")}</span> : <HealthStatus health={hero.health} t={t} now={now} locale={locale} />}
      {hero.unclaimed && <><span aria-hidden>·</span><span title={t("hero.unclaimedHint")}>{t("hero.unclaimed")}</span></>}
    </p>
  );
}

/** 단추 줄 — [제품 방문하기·저장소 열기][GitHub·설치 안내][공유][저장][팔로] */
export function HeroActionsSlot({ slug, name, followLabels }: { slug: string; name: string; followLabels: HeroFollowLabels }) {
  const { hero, done } = useHero(slug);
  const t = useTranslations("detail");
  const locale = useLocale();
  if (!done) return <div className="mt-2 flex flex-wrap items-center gap-2" aria-busy="true">
    {[136, 96, 72, 72].map((width) => <span key={width} aria-hidden="true" className="inline-block h-11 rounded-full bg-bg-soft" style={{ width }} />)}
  </div>;
  const installable = hero?.accessMode === "installable";
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* 저장소가 사라졌다고 확정되면(repoGone) 열리지 않는 저장소로 보내거나 설치하라고 하지 않는다 */}
        {!hero ? null : installable && hero.repoGone ? (
          <span className={`${BUTTON} bg-bg-soft text-down`}>{t("hero.repoGone")}</span>
        ) : installable ? (
          <>
            <a href={`/go/${slug}`} target="_blank" rel="nofollow noopener noreferrer" data-track-kind="repo" className={`${BUTTON} bg-accent-solid text-white hover:opacity-90`}>{t("hero.openRepo")}</a>
            <InstallPrompt url={hero.repoUrl ?? hero.url} slug={slug} />
          </>
        ) : (
          <>
            <a href={`/go/${slug}`} target="_blank" rel="nofollow noopener noreferrer" data-track-kind="site" className={`${BUTTON} bg-accent-solid text-white hover:opacity-90`}>{t("hero.visit")}</a>
            {hero.repoUrl && !hero.repoGone && <a href={hero.repoUrl} target="_blank" rel="noopener noreferrer" aria-label={t("hero.repoLabel")} className={`${BUTTON} bg-bg-soft text-fg`}>GitHub</a>}
          </>
        )}
        <ShareButton title={name} path={localePath(locale, `/p/${slug}`)} slug={slug} />
        <SaveButton slug={slug} name={name} listed={hero?.savable ?? false} />
        {hero?.follow && followLabels && <FollowButton target="product" targetKey={hero.follow.productKey} labels={followLabels.product} />}
      </div>
      {hero?.repoGone && <p className="text-[13px] text-fg-2">{t(installable ? "hero.goneInstallable" : "hero.goneDescription")}</p>}
    </>
  );
}

function Heading({ id, children }: { id: string; children: ReactNode }) {
  return <h2 className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-2"><span id={id}>{children}</span></h2>;
}

/**
 * 소개 — 설명이 한 줄 소개와 다를 때만 설명을, 그다음 README 발췌(전문은 README 상자가 불러온다), 메이커 프로필은 있을 때만.
 * 설명·README 발췌가 영어 원문이면 lang="en" 을 단다(A11Y-06).
 */
export function DetailIntroSlot({ slug }: { slug: string }) {
  const { data, done } = useDetailExtras(slug);
  const t = useTranslations("detail");
  const labels = useTranslations("labels");
  if (!done) return <div aria-busy="true" className="h-[160px] motion-safe:animate-pulse rounded-[12px] bg-bg-soft" />;
  const intro = data?.intro;
  if (!intro) return null;
  const { description, descriptionTranslation: selected, profile, readmeExcerpt: excerpt, repo } = intro;
  const hasProfile = profile && (profile.problem || profile.targetUsers || profile.privacySummary
    || profile.keyFeatures.length > 0 || profile.useCases.length > 0 || profile.longDescriptionMarkdown);
  return (
    <div className="flex flex-col gap-9">
      <section aria-labelledby="intro-title" className="flex flex-col gap-3">
        <Heading id="intro-title">{t("intro.title")}</Heading>
        {description
          ? <p lang={intro.descriptionLang} className="m-0 max-w-[720px] whitespace-pre-line text-[17px] leading-[1.6] text-fg">{description}</p>
          : !excerpt && (
            <p className="m-0 max-w-[720px] text-[14px] leading-[1.5] text-fg-2">
              {t("intro.onlyTagline")}
              {repo && <> {t("intro.moreReadme")} <a href={repo} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline underline-offset-2">{t("intro.readmeLink")} ↗</a></>}
            </p>
          )}
        {selected?.machine && <p className="m-0 text-[13px] text-fg-2">{labels("content.machineTranslation")}</p>}
        {selected?.pending && <p role="status" className="m-0 text-[13px] text-fg-2">{labels("content.pending")}</p>}
        {selected?.translated && selected.original && <details className="text-[13px] text-fg-2"><summary className="min-h-11 cursor-pointer">{labels("content.original")}</summary><p lang={selected.sourceLocale ?? englishLang(selected.original)} className="whitespace-pre-line">{selected.original}</p></details>}
        {/* 출처 줄은 메이커가 준 소개에만(「메이커 제공·미검증」) */}
        {intro.makerSource && <p className="m-0 text-[13px] text-fg-2">{t("source.maker")}</p>}
      </section>
      {repo && !intro.repoGone && (
        <section aria-labelledby="readme-title" className="flex flex-col gap-3">
          <h2 id="readme-title" className={README_HEADING}>README</h2>
          <ReadmeLoader slug={slug} fallbackUrl={`${repo}#readme`}>
            {excerpt && <blockquote data-readme-excerpt="" role="region" aria-label={t("readme.excerpt")} tabIndex={0} lang={englishLang(excerpt)}
              className={`m-0 whitespace-pre-wrap ${README_SCROLL}`}>{excerpt}</blockquote>}
          </ReadmeLoader>
        </section>
      )}
      {profile && hasProfile && (
        <section aria-labelledby="profile-title" className="flex flex-col gap-4">
          <Heading id="profile-title">{t("intro.profile")}</Heading>
          {(profile.problem || profile.targetUsers || profile.privacySummary) && (
            <dl className="m-0 grid gap-4 sm:grid-cols-2">
              {profile.problem && <div><dt className="text-[13px] font-semibold text-fg">{t("intro.problem")}</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.problem}</dd></div>}
              {profile.targetUsers && <div><dt className="text-[13px] font-semibold text-fg">{t("intro.users")}</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.targetUsers}</dd></div>}
              {profile.privacySummary && <div className="sm:col-span-2"><dt className="text-[13px] font-semibold text-fg">{t("intro.privacy")}</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.privacySummary}</dd></div>}
            </dl>
          )}
          {(profile.keyFeatures.length > 0 || profile.useCases.length > 0) && (
            <div className="grid gap-6 sm:grid-cols-2">
              {profile.keyFeatures.length > 0 && <div><h3 className="m-0 text-[14px] font-semibold text-fg">{t("intro.features")}</h3><ul className="m-0 mt-2 list-disc space-y-1.5 pl-5 text-[14px] leading-6 text-fg-2">{profile.keyFeatures.map((item) => <li key={item}>{item}</li>)}</ul></div>}
              {profile.useCases.length > 0 && <div><h3 className="m-0 text-[14px] font-semibold text-fg">{t("intro.useCases")}</h3><ul className="m-0 mt-2 list-disc space-y-1.5 pl-5 text-[14px] leading-6 text-fg-2">{profile.useCases.map((item) => <li key={item}>{item}</li>)}</ul></div>}
            </div>
          )}
          {profile.longDescriptionMarkdown && (
            <div className="space-y-3 text-[15px] leading-7 text-fg-2 [&_h2]:mt-5 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-fg [&_li]:ml-5 [&_li]:list-disc [&_p]:my-3">
              <Markdown markdown={profile.longDescriptionMarkdown} sourceUrl={repo ?? ""} repositoryRootUrl={repo ? `${repo}/blob/HEAD/` : ""} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** 오른쪽 열의 미리보기 그림 — 넓은 그림이 있을 때만 */
export function DetailPreviewSlot({ slug, name }: { slug: string; name: string }) {
  const { data } = useDetailExtras(slug);
  if (!data?.media) return null;
  return <PreviewFigure product={{ name, ogImage: data.media.ogImage }} media={data.media.items} />;
}

/** 운영자 상자·검증 전 안내 — 주인 없는 GitHub 저장소 제품, 검증 전 제품만 */
export function DetailAsideSlot({ slug }: { slug: string }) {
  const { data } = useDetailExtras(slug);
  const t = useTranslations("detail");
  const aside = data?.aside;
  if (!aside) return null;
  return <>
    {aside.ownerContact && <UnclaimedOwnerContact productId={aside.ownerContact.productId} slug={slug} installable={aside.ownerContact.installable}
      authEnabled={aside.ownerContact.authEnabled} githubEnabled={aside.ownerContact.githubEnabled} />}
    {aside.unverified && (
      <section className="rounded-[12px] border border-line bg-bg-card p-5">
        <h2 className="text-[15px] font-extrabold text-fg">{t("page.unlisted")}</h2>
        <p className="mt-2 text-[13px] leading-6 text-fg-2">{t("page.verify", { command: "/nomorevibe verify" })}</p>
      </section>
    )}
  </>;
}

/** 피드백 설정 메뉴 — GitHub 저장소 제품만 */
export function FeedbackSettingsSlot({ slug }: { slug: string }) {
  const { hero } = useHero(slug);
  return hero?.feedbackSettings ? <FeedbackSettingsMenu slug={slug} /> : null;
}
