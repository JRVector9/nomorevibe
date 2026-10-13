"use client";

import Link from "next/link";
import { ProductTagline } from "@/components/ProductTagline";
import { StarMetric } from "@/components/StarMetric";
import { StarGrowthMetric } from "@/components/home/StarGrowthMetric";
import type { BrowseState } from "@/components/home/browse-state";
import { Icon } from "@/components/home/icons";
import { ProjectTile } from "@/components/home/ProjectTile";
import type { HomeCardProduct } from "@/components/home/types";
import { listedRepositoryOwner } from "@/lib/domain/products/github-owner";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import { translatedCategory } from "./i18n";
import { formatNumber } from "@/lib/i18n/format";
import type { TimeInput } from "@/lib/format/time";
import { ProductActivityRow } from "./ProductActivityRow";
import "./cards.css";

/**
 * 홈 카드 — 타일 · 이름 · @소유자 · 한 줄 소개 · 메타 한 줄("분야 · 최근 업데이트 n일 전" / ★ 증가).
 *
 * 카드 하나가 링크 하나다(UX-30): 제목 링크가 ::after 로 카드 전체를 덮고, 커버 링크는 탭·읽기 도구에서 뺀다.
 * 저장 버튼과 소유자 링크만 그 위에 올려 따로 누른다.
 * 미클레임·저장소·관심 수는 방문자에게 뜻이 없어 뺐다(상세에서 밝힌다). 메이커가 신고한 제작 도구만
 * 소유자 옆에 붙는다 — 수집기 추정값은 공개 뷰모델에서 이미 null 이다(view.ts toListItem).
 */
export function ProjectCard({ product, saved, onToggleSave, now, priority = false, headingLevel = 3, rank }: {
  product: HomeCardProduct & { listedAt?: TimeInput };
  saved: boolean;
  onToggleSave: (slug: string) => void;
  browseState?: BrowseState;
  /** 서버가 읽은 시각 — 넘기면 서버와 브라우저가 같은 'n일 전'을 그린다. 없으면 지금 */
  now?: Date | string | number;
  /** 목록 첫 줄 — 커버 그림을 먼저 받는다(PERF-03) */
  priority?: boolean;
  /** 카드 제목의 단계 — 목록 제목이 h1 인 검색·분야 화면은 h2 라야 단계를 건너뛰지 않는다(A11Y-05). 크기는 class 가 정한다 */
  headingLevel?: 2 | 3;
  /** 순위 목록(홈 '많이 쓰이는 프로젝트'·/popular 카드 보기)의 자리 — 제목 앞에 숫자로 */
  rank?: number;
}) {
  const locale = useLocale();
  const t = useTranslations("labels");
  const owner = listedRepositoryOwner(product.repoUrl, product.repoRenamedTo);
  const maker = owner ? `@${owner.login}` : product.makerName ? `@${product.makerName.replace(/^@/, "")}` : null;
  const builder = product.builder && product.builderClaim === "reported" ? product.builder : null;
  const at = now ?? new Date();
  const href = localePath(locale, `/p/${product.slug}`);
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <article className="project-card">
      <Link prefetch={false} href={href} className="card-visual" tabIndex={-1} aria-hidden="true">
        <ProjectTile slug={product.slug} name={product.name} ogImage={product.ogImage} size={64} installable={product.accessMode === "installable"}
          ai={product.aiLevel != null} category={product.category} priority={priority} />
      </Link>
      <div className="project-body">
        <div className="project-title-row">
          <Heading className="project-title">
            {rank !== undefined && <span className="project-rank"><span aria-hidden="true">{formatNumber(rank, locale)}</span><span className="sr-only">{t("card.rank", { rank: formatNumber(rank, locale) })}</span></span>}
            <Link prefetch={false} href={href} className="card-link">{product.name}</Link>
          </Heading>
          <button
            type="button"
            className={`cover-saved${saved ? " active" : ""}`}
            aria-label={t(saved ? "card.unsave" : "card.save", { name: product.name })}
            aria-pressed={saved}
            onClick={() => onToggleSave(product.slug)}
          >
            <Icon name="bookmark" size={16} />
          </button>
        </div>
        {(maker || builder) && (
          <p className="card-byline card-dots">
            {maker && (owner
              ? <a className="card-owner" href={owner.profileUrl} target="_blank" rel="noopener noreferrer" title={t("card.owner")}><span>{maker}</span></a>
              : <span>{maker}</span>)}
            {builder && <span>{builder}</span>}
          </p>
        )}
        <ProductTagline translation={product.translation} tagline={product.tagline} taglineKo={product.taglineKo} source={product.taglineSource} className="project-tagline" />
        <div className="card-meta">
          {/* 조각 사이 '·'는 CSS 가 넣는다(card-dots) — 빠진 조각 옆에 점만 남지 않게 */}
          <span className="card-meta-text card-dots">
            <span>{translatedCategory(product.category, t)}</span>
            <ProductActivityRow activity={product.activity} now={at} />
            {product.health?.down && <span className="meta-down">{t("card.down")}</span>}
          </span>
          {product.starGrowth ? <StarGrowthMetric value={product.starGrowth} /> : <StarMetric value={product} now={at} listedAt={product.listedAt} />}
        </div>
      </div>
    </article>
  );
}
