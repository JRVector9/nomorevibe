"use client";

import Link from "next/link";
import { ProductTagline } from "@/components/ProductTagline";
import { StarMetric } from "@/components/StarMetric";
import { StarGrowthMetric } from "@/components/home/StarGrowthMetric";
import { ProjectTile } from "@/components/home/ProjectTile";
import { translatedCategory } from "./i18n";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import type { ProductListItem } from "@/lib/domain/products/view";
import type { StarGrowthItem } from "@/lib/domain/products/star-growth";
import { formatDate } from "@/lib/i18n/format";
import "./cards.css";

/**
 * 가로 띠의 작은 카드 — 썸네일 · 이름 한 줄 · 소개 한 줄 · 메타 한 줄("★ 990 +12 · 분야").
 *
 * 카드 하나가 링크 하나다(UX-30, ProjectCard 와 같다). 메타는 한 줄로 고정하고(UX-29) 활동 날짜·빈 집계는 싣지 않는다 —
 * 칸이 좁아 '최근 업데이트 n일 전'까지 넣으면 잘리고, '지금 뜨는' 띠에서 '0회' 같은 부정 신호가 됐다.
 * 신규 띠(listed)는 GitHub 저장소 생성일이 있으면 그 날을 붙인다.
 */
export function CompactCard({ product, trailing, priority = false, headingLevel = 3 }: {
  product: ProductListItem & { starGrowth?: StarGrowthItem["starGrowth"] };
  trailing: "category" | "listed";
  /** 화면 첫 줄의 띠('지금 뜨는') — 커버 그림을 먼저 받는다(PERF-03) */
  priority?: boolean;
  headingLevel?: 2 | 3;
}) {
  const locale = useLocale();
  const t = useTranslations("labels");
  const now = new Date();
  const href = localePath(locale, `/p/${product.slug}`);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className="compact-card">
      <Link prefetch={false} href={href} className="compact-visual" tabIndex={-1} aria-hidden="true">
        <ProjectTile slug={product.slug} name={product.name} ogImage={product.ogImage} size={44} installable={product.accessMode === "installable"}
          ai={product.aiLevel != null} category={product.category} priority={priority} />
      </Link>
      <div className="compact-body">
        <Heading className="compact-title"><Link prefetch={false} href={href} className="card-link">{product.name}</Link></Heading>
        <ProductTagline tagline={product.tagline} taglineKo={product.taglineKo} source={product.taglineSource} className="compact-tagline" />
        {/* 조각 사이 '·'는 CSS 가 넣는다(card-dots) */}
        <p className="card-meta card-meta-compact card-dots">
          {product.starGrowth ? <StarGrowthMetric value={product.starGrowth} /> : <StarMetric value={product} now={now} listedAt={product.listedAt} />}
          <span>{translatedCategory(product.category, t)}</span>
          {trailing === "listed" && <span title={t(product.repoCreatedAt ? "card.repositoryCreated" : "card.listedDate")}>{formatDate(product.repoCreatedAt ?? product.listedAt, now, locale)}</span>}
        </p>
      </div>
    </article>
  );
}
