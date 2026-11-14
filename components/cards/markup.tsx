import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/home/icons";
import { translatedCategory } from "@/components/home/i18n";
import type { TaglineSource } from "@/lib/db/schema";
import type { ProductActivity } from "@/lib/domain/products/activity";
import { listedRepositoryOwner } from "@/lib/domain/products/github-owner";
import type { StarObservation } from "@/lib/domain/products/star-change";
import type { StarGrowthItem } from "@/lib/domain/products/star-growth";
import type { ProductTranslationSelection } from "@/lib/domain/products/translation-policy";
import { trackAttrs } from "@/lib/analytics/attrs";
import type { TimeInput } from "@/lib/format/time";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import { localePath } from "@/lib/i18n/routing";
import { ActivityView, StarsCell, TaglineView, TileView, type Labels } from "./views";

/**
 * 카드·띠·순위 목록의 마크업(2026-11-14 공개 HTML 줄이기) — 서버 부품과 브라우저 부품이 같은 모양을 쓴다.
 *
 * 공개 목록은 서버가 이 마크업으로 글자만 그린다. 그러면 HTML 안 RSC 데이터에는 그려진 글자만 남고,
 * 제품 행(내부 id·저장소 주소·상태·관측 시각…)이 JSON 으로 다시 실리지 않는다. 누르는 곳(저장)만 작은 브라우저 부품이다.
 */

/** 카드가 읽는 칸 — 서버 부품은 목록 행을 그대로 넘겨도 된다(값이 브라우저로 넘어가지 않는다) */
export type CardProduct = StarObservation & {
  slug: string;
  name: string;
  tagline: string;
  taglineKo?: string | null;
  translation?: ProductTranslationSelection;
  taglineSource?: TaglineSource | null;
  category: string;
  accessMode?: "website" | "installable";
  ogImage: string | null;
  aiLevel?: number | null;
  repoUrl?: string | null;
  repoRenamedTo?: string | null;
  makerName?: string | null;
  builder?: string | null;
  builderClaim?: "reported" | "guessed";
  activity?: Pick<ProductActivity, "updatedAt" | "pushedAt">;
  health?: { down: boolean };
  starGrowth?: StarGrowthItem["starGrowth"];
  listedAt?: TimeInput;
  repoCreatedAt?: TimeInput;
  ownerType?: "User" | "Organization" | null;
};

export type CardContext = { locale: Locale; t: Labels; now: Date | string | number };

/** 저장 단추의 모양 — 누르는 일은 부르는 쪽(SaveToggle·ProjectCard)이 정한다 */
export function SaveButtonMarkup({ slug, name, saved, onClick, t }: { slug: string; name: string; saved: boolean; onClick?: () => void; t: Labels }) {
  return (
    <button
      type="button"
      className={`cover-saved${saved ? " active" : ""}`}
      aria-label={t(saved ? "card.unsave" : "card.save", { name })}
      aria-pressed={saved}
      onClick={onClick}
      {...trackAttrs("product_save", { product_slug: slug, action: saved ? "unsave" : "save" })}
    >
      <Icon name="bookmark" size={16} />
    </button>
  );
}

/**
 * 홈 카드 — 타일 · 이름 · @소유자 · 한 줄 소개 · 메타 한 줄("분야 · 최근 업데이트 n일 전" / ★ 증가).
 * 카드 하나가 링크 하나다(UX-30): 제목 링크가 ::after 로 카드 전체를 덮고, 커버 링크는 탭·읽기 도구에서 뺀다.
 * 저장 버튼과 소유자 링크만 그 위에 올려 따로 누른다. 메이커가 신고한 제작 도구만 소유자 옆에 붙는다.
 */
export function ProjectCardMarkup({ product, ctx, save, priority = false, headingLevel = 3, rank, children }: {
  product: CardProduct;
  ctx: CardContext;
  save: ReactNode;
  priority?: boolean;
  headingLevel?: 2 | 3;
  rank?: number;
  children?: ReactNode;
}) {
  const { locale, t, now } = ctx;
  const owner = listedRepositoryOwner(product.repoUrl ?? null, product.repoRenamedTo);
  const maker = owner ? `@${owner.login}` : product.makerName ? `@${product.makerName.replace(/^@/, "")}` : null;
  const builder = product.builder && product.builderClaim === "reported" ? product.builder : null;
  const href = localePath(locale, `/p/${product.slug}`);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className="project-card">
      <Link prefetch={false} href={href} className="card-visual" tabIndex={-1} aria-hidden="true">
        <TileView slug={product.slug} name={product.name} ogImage={product.ogImage} size={64} installable={product.accessMode === "installable"}
          ai={product.aiLevel != null} category={product.category} priority={priority} t={t} />
      </Link>
      <div className="project-body">
        <div className="project-title-row">
          <Heading className="project-title">
            {rank !== undefined && <span className="project-rank"><span aria-hidden="true">{formatNumber(rank, locale)}</span><span className="sr-only">{t("card.rank", { rank: formatNumber(rank, locale) })}</span></span>}
            <Link prefetch={false} href={href} className="card-link">{product.name}</Link>
          </Heading>
          {save}
        </div>
        {(maker || builder) && (
          <p className="card-byline card-dots">
            {maker && (owner
              ? <a className="card-owner" href={owner.profileUrl} target="_blank" rel="noopener noreferrer" title={t("card.owner")}><span>{maker}</span></a>
              : <span>{maker}</span>)}
            {builder && <span>{builder}</span>}
          </p>
        )}
        <TaglineView translation={product.translation} tagline={product.tagline} taglineKo={product.taglineKo} source={product.taglineSource} className="project-tagline" locale={locale} t={t} />
        <div className="card-meta">
          {/* 조각 사이 '·'는 CSS 가 넣는다(card-dots) — 빠진 조각 옆에 점만 남지 않게 */}
          <span className="card-meta-text card-dots">
            <span>{translatedCategory(product.category, t)}</span>
            <ActivityView activity={product.activity} now={now} locale={locale} t={t} />
            {product.health?.down && <span className="meta-down">{t("card.down")}</span>}
          </span>
          <StarsCell product={product} now={now} listedAt={product.listedAt} locale={locale} t={t} />
        </div>
        {children}
      </div>
    </article>
  );
}

/**
 * 가로 띠의 작은 카드 — 썸네일 · 이름 한 줄 · 소개 한 줄 · 메타 한 줄("★ 990 +12 · 분야").
 * 메타는 한 줄로 고정하고(UX-29) 활동 날짜·빈 집계는 싣지 않는다. 신규 띠(listed)는 GitHub 저장소 생성일이 있으면 그 날을 붙인다.
 */
export function CompactCardMarkup({ product, trailing, ctx, priority = false, headingLevel = 3 }: {
  product: CardProduct;
  trailing: "category" | "listed";
  ctx: CardContext;
  priority?: boolean;
  headingLevel?: 2 | 3;
}) {
  const { locale, t, now } = ctx;
  const href = localePath(locale, `/p/${product.slug}`);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const listed = product.repoCreatedAt ?? product.listedAt;
  return (
    <article className="compact-card">
      <Link prefetch={false} href={href} className="compact-visual" tabIndex={-1} aria-hidden="true">
        <TileView slug={product.slug} name={product.name} ogImage={product.ogImage} size={44} installable={product.accessMode === "installable"}
          ai={product.aiLevel != null} category={product.category} priority={priority} t={t} />
      </Link>
      <div className="compact-body">
        <Heading className="compact-title"><Link prefetch={false} href={href} className="card-link">{product.name}</Link></Heading>
        <TaglineView translation={product.translation} tagline={product.tagline} taglineKo={product.taglineKo} source={product.taglineSource} className="compact-tagline" locale={locale} t={t} />
        {/* 조각 사이 '·'는 CSS 가 넣는다(card-dots) */}
        <p className="card-meta card-meta-compact card-dots">
          <StarsCell product={product} now={now} listedAt={product.listedAt} locale={locale} t={t} />
          <span>{translatedCategory(product.category, t)}</span>
          {trailing === "listed" && listed && <span title={t(product.repoCreatedAt ? "card.repositoryCreated" : "card.listedDate")}>{formatDate(listed, now, locale)}</span>}
        </p>
      </div>
    </article>
  );
}

/** 홈의 가로 띠 — '지금 뜨는'·'이번 주 새로 나온'·상세의 '같은 분야'·없는 주소의 '지금 뜨는'이 같은 모양을 쓴다 */
export function CompactRowMarkup({ id, title, note, summary, more, items, trailing, priority = false, ctx }: {
  id: string;
  title: string;
  note?: ReactNode;
  summary?: ReactNode;
  more?: { href: string; label: string };
  items: CardProduct[];
  trailing: "category" | "listed";
  /** 화면 첫 띠 — 앞 세 장의 그림을 늦추지 않고 먼저 받는다(PERF-03) */
  priority?: boolean;
  ctx: CardContext;
}) {
  if (items.length === 0 && !summary) return null;
  return (
    <section id={id} className="row-section" aria-labelledby={`${id}-title`}>
      <div className="row-head">
        <div>
          <h2 id={`${id}-title`} className="row-title">{title}</h2>
          {note && <p className="row-note">{note}</p>}
        </div>
        {more && <Link prefetch={false} className="row-more" href={localePath(ctx.locale, more.href)}>{more.label} ›</Link>}
      </div>
      {summary}
      {items.length > 0 && <div className="compact-grid">
        {items.map((product, index) => <CompactCardMarkup key={product.slug} product={product} trailing={trailing} priority={priority && index < 3} ctx={ctx} />)}
      </div>}
    </section>
  );
}

/**
 * 순위 목록 한 줄(/popular·/rising 목록 보기) — 순위 · 커버 · 이름 · @소유자 · 소개 · 분야·계정 · ★와 증감 · 저장.
 * 줄 하나가 링크 하나다(UX-30): 이름 링크가 줄 전체를 덮고, 소유자 링크와 저장만 따로 누른다.
 */
export function PopularRowMarkup({ product, rank, ctx, save }: { product: CardProduct; rank: number; ctx: CardContext; save: ReactNode }) {
  const { locale, t, now } = ctx;
  const count = (n: number) => formatNumber(n, locale);
  const href = localePath(locale, `/p/${product.slug}`);
  const owner = listedRepositoryOwner(product.repoUrl ?? null, product.repoRenamedTo);
  const account = product.ownerType === "User" ? t("card.personal") : product.ownerType === "Organization" ? t("card.organization") : null;
  return (
    <li className="popular-row">
      <span className="popular-rank"><span aria-hidden="true">{count(rank)}</span><span className="sr-only">{t("card.rank", { rank: count(rank) })}</span></span>
      <Link prefetch={false} href={href} className="popular-thumb" tabIndex={-1} aria-hidden="true">
        <TileView slug={product.slug} name={product.name} ogImage={product.ogImage} size={44} installable={product.accessMode === "installable"}
          ai={product.aiLevel != null} category={product.category} t={t} />
        <span className="popular-thumb-rank">{count(rank)}</span>
      </Link>
      <div className="popular-row-body">
        <div className="popular-row-title">
          <h3><Link prefetch={false} href={href} className="card-link">{product.name}</Link></h3>
          {owner && <a className="card-owner" href={owner.profileUrl} target="_blank" rel="noopener noreferrer" title={t("card.owner")}><span>@{owner.login}</span></a>}
        </div>
        <TaglineView translation={product.translation} tagline={product.tagline} taglineKo={product.taglineKo} source={product.taglineSource} className="popular-description" showSource={false} locale={locale} t={t} />
        <p className="popular-row-meta card-dots">
          <span>{translatedCategory(product.category, t)}</span>
          {account && <span>{account}</span>}
        </p>
      </div>
      <div className="popular-row-end">
        <StarsCell product={product} now={now} locale={locale} t={t} />
        {save}
      </div>
    </li>
  );
}
