/* eslint-disable @next/next/no-img-element -- 내부에 저장한 썸네일의 원본 비율과 크기를 그대로 쓴다 */
import type { ReactNode } from "react";
import type { TaglineSource } from "@/lib/db/schema";
import type { ProductActivity } from "@/lib/domain/products/activity";
import { starChange, type StarObservation } from "@/lib/domain/products/star-change";
import type { StarGrowthItem } from "@/lib/domain/products/star-growth";
import type { ProductTranslationSelection } from "@/lib/domain/products/translation-policy";
import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
import { ogVariantSrc, ogVariantSrcSet } from "@/lib/domain/products/og-variants";
import { ProductIcon, tileTint } from "@/components/ProductIcon";
import { trackAttrs } from "@/lib/analytics/attrs";
import { englishLang } from "@/lib/i18n/content-language";
import { formatDate, formatDateTime, formatNumber, formatRelativeTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { toDate, type TimeInput } from "@/lib/format/time";

/**
 * 카드 조각의 순수 그림(2026-11-14 공개 HTML 줄이기).
 *
 * 훅을 쓰지 않고 언어·번역기·시각을 인자로 받는다 — 같은 마크업을 서버 부품(목록·카드를 서버에서 글자로 그림)과
 * 브라우저 부품(마이페이지·상세 관련 목록처럼 브라우저가 받은 값으로 그림)이 함께 쓴다.
 * 서버 부품이 그리면 제품 값은 글자로만 실리고, 쓰지 않는 칸(내부 id·저장소 주소·관측 시각…)은 RSC 데이터에 실리지 않는다.
 */

export type Labels = Translator<"labels">;

/** 쓴 사람(출처) 줄 — 메이커가 쓴 줄은 밝히지 않는다 */
export function introductionSourceLabel(source: TaglineSource | null | undefined, t: Labels): string | null {
  return source === "ai_page" ? t("source.ai_page")
    : source === "ai_readme" ? t("source.ai_readme")
      : source === "ai_both" ? t("source.ai_both")
        : source === "ai_fixed" ? t("source.ai_fixed")
          : source === "editor" ? t("source.editor") : null;
}

export function SourceLine({ source, t }: { source?: TaglineSource | null; t: Labels }) {
  const label = introductionSourceLabel(source, t);
  return label ? <p className="card-intro-source">{label}</p> : null;
}

export type TaglineInput = {
  tagline: string;
  taglineKo?: string | null;
  translation?: ProductTranslationSelection;
  source?: TaglineSource | null;
};

/** Original text stays available; each locale chooses only a current translation. */
export function TaglineView({ tagline, taglineKo, translation, source, className, showSource = true, original = "tooltip", locale, t }: TaglineInput & {
  className?: string;
  showSource?: boolean;
  original?: "tooltip" | "toggle";
  locale: Locale;
  t: Labels;
}) {
  const korean = locale === "ko" ? taglineKo?.trim() || null : null;
  const translated = locale === "ko" ? Boolean(korean) : translation?.translated === true;
  const text = locale === "ko" ? korean ?? tagline : translation?.text ?? tagline;
  const lang = locale === "ko" ? korean ? "ko" : englishLang(tagline) : translation?.lang;
  const pending = locale !== "ko" && (translation?.pending ?? Boolean(tagline.trim()));
  const title = translated && original === "tooltip" ? t("content.originalText", { text: tagline }) : text;
  return (
    <>
      <p className={className} title={title} lang={lang}>{text}</p>
      {pending && <p className="card-intro-source">{t("content.pending")}</p>}
      {translated && translation?.provenance === "machine" && <p className="card-intro-source">{t("content.machineTranslation")}</p>}
      {showSource && <SourceLine source={source} t={t} />}
      {translated && original === "toggle" && (
        <details className="text-[13px] leading-[1.5] text-fg-2">
          <summary className="inline-flex min-h-8 cursor-pointer select-none items-center text-accent-ink hover:underline"
            {...trackAttrs("select_content", { content_type: "tagline", content_id: "original" })}>{t("content.original")}</summary>
          <p lang={locale === "ko" ? englishLang(tagline) : translation?.sourceLocale ?? undefined} className="m-0 mt-1 max-w-[720px] text-[15px] leading-[1.5] text-fg-2">{tagline}</p>
        </details>
      )}
    </>
  );
}

/** 스타 0인 카드에 '새 프로젝트'를 붙이는 기간 — 등록한 지 이만큼 안이면 새로 올라온 것이다 */
const NEW_PROJECT_DAYS = 30;

/**
 * 스타 수와 직전 확인 대비 증감. 증감이 0이면 적지 않는다('±0'은 멈춘 것처럼 읽힌다 — UX-29).
 * 스타 0은 별을 숨긴다 — 등록 시각(listedAt)을 넘기면 최근 등록이면 '새 프로젝트'를 대신 보인다.
 */
export function StarMetricView({ value, now, listedAt, locale, t }: {
  value: StarObservation; now: Date | string | number; listedAt?: TimeInput; locale: Locale; t: Labels;
}) {
  const count = (n: number) => formatNumber(n, locale);
  const time = (at: TimeInput) => at ? formatDateTime(at, now, locale) : t("stars.before");
  if (value.stars === null || value.stars === undefined) return null;
  if (value.stars === 0) {
    const listed = toDate(listedAt);
    const base = toDate(now);
    const recent = listed && base && base.getTime() - listed.getTime() <= NEW_PROJECT_DAYS * 86_400_000;
    return recent ? <span className="star-metric" title={t("card.registered", { date: formatDate(listed, base, locale) })}>{t("card.new")}</span> : null;
  }
  const delta = starChange(value);
  const label = !delta ? null : delta > 0 ? `+${count(delta)}` : `−${count(Math.abs(delta))}`;
  const detail = label === null ? "" : t("stars.delta", { delta: label, before: time(value.starsPreviousAt), after: time(value.starsAt) });
  const measured = value.starsAt ? ` · ${time(value.starsAt)}` : "";
  return <span className="star-metric" title={`${t("stars.github")}${measured}${detail ? ` · ${detail}` : ""}`}>
    <span aria-label={t("stars.label", { count: count(value.stars) })}>★ {count(value.stars)}</span>
    {label !== null && <small className={delta! > 0 ? "star-change-up" : "star-change-down"} aria-label={detail}>{label}</small>}
  </span>;
}

/** 직전 8시간 회차 대비 증가량을 먼저, 총 스타 수를 보조로 표시한다. */
export function StarGrowthView({ value, locale, t }: { value: StarGrowthItem["starGrowth"]; locale: Locale; t: Labels }) {
  const count = (n: number) => formatNumber(n, locale);
  const detail = t("stars.growthDetail", { gain: count(value.gain), stars: count(value.stars), before: formatDateTime(value.baselineObservedAt, value.observedAt, locale), baseline: count(value.baselineStars), after: formatDateTime(value.observedAt, value.observedAt, locale) });
  return (
    <span className="star-metric star-growth-metric" tabIndex={0} role="img" title={detail} aria-label={detail} style={{ position: "relative", zIndex: 1 }}>
      <strong className="star-change-up" aria-hidden="true">{t("stars.growth8h", { count: count(value.gain) })}</strong>
      <small aria-hidden="true">★ {count(value.stars)}</small>
    </span>
  );
}

/**
 * 카드 메타 줄의 활동 — 공개 업데이트와 코드 업데이트 중 늦은 쪽 하나만 "최근 업데이트 3일 전"으로(UX-29).
 * 어느 쪽 시각인지와 정확한 시각은 툴팁에 둔다. 수집되지 않은 값은 그리지 않는다.
 */
export function ActivityView({ activity, now, locale, t }: { activity?: Pick<ProductActivity, "updatedAt" | "pushedAt">; now: Date | string | number; locale: Locale; t: Labels }) {
  // 둘 다 toISOString() 글자라 글자 순서가 시각 순서다
  const at = [activity?.updatedAt, activity?.pushedAt].filter((value): value is string => Boolean(value)).sort().at(-1);
  if (!at) return null;
  const ago = formatRelativeTime(at, now, locale);
  // 브라우저 시계가 서버보다 늦으면 '3분 후'가 나온다 — 방금으로 본다
  const label = new Date(at).getTime() >= new Date(now).getTime() - 60_000 ? t("card.updatedNow") : t("card.updated", { time: ago });
  const title = t(at === activity?.pushedAt ? "card.codeUpdateTime" : "card.updateTime", { time: formatDateTime(at, now, locale) });
  // 서버가 그린 'n분 전'과 브라우저의 지금이 몇 초 어긋날 수 있다 — 그 차이로 hydration 경고를 내지 않는다
  return <time dateTime={at} title={title} suppressHydrationWarning>{label}</time>;
}

/** 칸 폭 — 큰 카드는 home.css .projects-grid(최소 300px, 본문 1056px 에 세 칸), 작은 카드는 .compact-grid(최소 188px, 좁은 화면은 74%) */
const TILE_SIZES = {
  64: "(max-width: 652px) 100vw, (max-width: 1004px) 50vw, 340px",
  44: "(max-width: 640px) 75vw, 220px",
} as const;
const TILE_WIDTHS = [320, 640] as const;

/**
 * 카드 커버 — 대표 이미지·README 그림은 전체 폭으로 자르지 않고, 아이콘은 옅은 바탕 가운데로,
 * 아이콘이 없으면 분야 색 모노그램을 가운데 둔다(UX-32). 바탕색은 slug 로 정해 같은 제품은 늘 같은 색이다.
 * 그림은 칸 폭에 맞는 사본을 브라우저가 고른다(PERF-04). 목록 첫 줄(priority)은 바로 받는다(PERF-03).
 */
export function TileView({ slug, name, ogImage, size, installable = false, ai = false, category, priority = false, t }: {
  slug: string;
  name: string;
  ogImage: string | null;
  size: 64 | 44;
  installable?: boolean;
  /** AI 로 만든 근거가 있다(1·2·3단계 어느 것이든) — 커버 오른쪽 위 'AI' 배지 */
  ai?: boolean;
  category?: string;
  priority?: boolean;
  t: Labels;
}) {
  const internalImage = ogImage?.startsWith("/") && !ogImage.startsWith("//") ? ogImage : null;
  const presentation = thumbnailPresentation(internalImage);
  const preview = internalImage && (presentation.kind === "og" || presentation.kind === "repository_image");
  return (
    <span className={`project-tile tile-${tileTint(null, slug)} tile-${size}`}>
      {preview ? (
        <img
          src={ogVariantSrc(internalImage, 640)!}
          srcSet={ogVariantSrcSet(internalImage, TILE_WIDTHS) ?? undefined}
          sizes={TILE_SIZES[size]}
          alt={t(presentation.kind === "repository_image" ? "card.readmeImage" : "card.preview", { name })}
          width={presentation.width}
          height={presentation.height}
          className={`tile-preview${presentation.kind === "repository_image" ? " tile-preview-readme" : ""}`}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : undefined}
        />
      ) : (
        <span className="tile-icon"><ProductIcon name={name} ogImage={internalImage} size={size === 64 ? 96 : 64} category={category} loading={priority ? "eager" : "lazy"} /></span>
      )}
      {installable && <span className="tile-flag">{t("card.installable")}</span>}
      {ai && <span className="tile-flag tile-flag-ai">AI</span>}
    </span>
  );
}

/** 별 칸 — 8시간 증가가 있으면 그것만, 없으면 스타 관측 넷 */
export function StarsCell({ product, now, listedAt, locale, t }: {
  product: StarObservation & { starGrowth?: StarGrowthItem["starGrowth"] }; now: Date | string | number; listedAt?: TimeInput; locale: Locale; t: Labels;
}): ReactNode {
  return product.starGrowth ? <StarGrowthView value={product.starGrowth} locale={locale} t={t} />
    : <StarMetricView value={product} now={now} listedAt={listedAt} locale={locale} t={t} />;
}
