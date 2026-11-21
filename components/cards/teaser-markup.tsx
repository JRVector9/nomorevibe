import Link from "next/link";
import type { ReactNode } from "react";
import { tileTint } from "@/components/ProductIcon";
import type { PublicTeaser } from "@/lib/domain/products/public-teaser";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import { localePath } from "@/lib/i18n/routing";
import type { Labels } from "./views";
import { FillLine } from "./fill-line";

/**
 * 카드의 이름·요약만 그린 모양(2026-11-15 공개 HTML 이름·요약만, 문서 4.1) — 서버 HTML 에 실리는 카드다.
 * 나머지 칸(표지·@소유자·분류·배지·스타·꼬리표)은 다 그린 카드(markup.tsx)와 같은 크기의 빈 자리(글자 없음)로 둔다 — 채워져도 밀리지 않게.
 * pending: 받는 중(빈 자리를 보이고 aria-busy), 아니면 받지 못한 것(빈 자리를 거둔다 — 이름·요약·링크만 남는다).
 */
type TeaserContext = { locale: Locale; t: Labels };


function Summary({ teaser, className }: { teaser: PublicTeaser; className: string }) {
  return <p className={className} title={teaser.summary} lang={teaser.lang}>{teaser.summary}</p>;
}

/** 표지 자리 — 다 그린 표지(TileView)와 같은 바탕색·비율 */
function TileHold({ slug, size }: { slug: string; size: 64 | 44 }) {
  return <span className={`project-tile tile-${tileTint(null, slug)} tile-${size}`} />;
}

function Rank({ rank, locale, t }: { rank: number; locale: Locale; t: Labels }) {
  return <span className="project-rank"><span aria-hidden="true">{formatNumber(rank, locale)}</span><span className="sr-only">{t("card.rank", { rank: formatNumber(rank, locale) })}</span></span>;
}

export function ProjectCardTeaser({ teaser, ctx, save, pending, headingLevel = 3, rank }: {
  teaser: PublicTeaser; ctx: TeaserContext; save: ReactNode; pending: boolean; headingLevel?: 2 | 3; rank?: number;
}) {
  const href = localePath(ctx.locale, `/p/${teaser.slug}`);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className="project-card" aria-busy={pending || undefined}>
      <Link prefetch={false} href={href} className="card-visual" tabIndex={-1} aria-hidden="true"><TileHold slug={teaser.slug} size={64} /></Link>
      <div className="project-body">
        <div className="project-title-row">
          <Heading className="project-title">
            {rank !== undefined && <Rank rank={rank} locale={ctx.locale} t={ctx.t} />}
            <Link prefetch={false} href={href} className="card-link">{teaser.name}</Link>
          </Heading>
          {save}
        </div>
        {pending && <p className="card-byline"><FillLine width="38%" /></p>}
        <Summary teaser={teaser} className="project-tagline" />
        {pending && <p className="card-intro-source"><FillLine width="30%" /></p>}
        <div className="card-meta">{pending && <span className="card-meta-text"><FillLine width="56%" /></span>}</div>
      </div>
    </article>
  );
}

export function CompactCardTeaser({ teaser, ctx, pending, headingLevel = 3 }: {
  teaser: PublicTeaser; ctx: TeaserContext; pending: boolean; headingLevel?: 2 | 3;
}) {
  const href = localePath(ctx.locale, `/p/${teaser.slug}`);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className="compact-card" aria-busy={pending || undefined}>
      <Link prefetch={false} href={href} className="compact-visual" tabIndex={-1} aria-hidden="true"><TileHold slug={teaser.slug} size={44} /></Link>
      <div className="compact-body">
        <Heading className="compact-title"><Link prefetch={false} href={href} className="card-link">{teaser.name}</Link></Heading>
        <Summary teaser={teaser} className="compact-tagline" />
        <p className="card-meta card-meta-compact">{pending && <FillLine width="60%" />}</p>
      </div>
    </article>
  );
}

export function PopularRowTeaser({ teaser, rank, ctx, save, pending }: {
  teaser: PublicTeaser; rank: number; ctx: TeaserContext; save: ReactNode; pending: boolean;
}) {
  const count = (n: number) => formatNumber(n, ctx.locale);
  const href = localePath(ctx.locale, `/p/${teaser.slug}`);
  return (
    <li className="popular-row" aria-busy={pending || undefined}>
      <span className="popular-rank"><span aria-hidden="true">{count(rank)}</span><span className="sr-only">{ctx.t("card.rank", { rank: count(rank) })}</span></span>
      <Link prefetch={false} href={href} className="popular-thumb" tabIndex={-1} aria-hidden="true">
        <TileHold slug={teaser.slug} size={44} />
        <span className="popular-thumb-rank">{count(rank)}</span>
      </Link>
      <div className="popular-row-body">
        <div className="popular-row-title"><h3><Link prefetch={false} href={href} className="card-link">{teaser.name}</Link></h3></div>
        <Summary teaser={teaser} className="popular-description" />
        <p className="popular-row-meta">{pending && <FillLine width="34%" />}</p>
      </div>
      <div className="popular-row-end">
        {pending && <span className="star-metric"><FillLine width="64px" /></span>}
        {save}
      </div>
    </li>
  );
}
