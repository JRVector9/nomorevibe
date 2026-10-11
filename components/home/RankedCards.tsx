"use client";

import { ProjectCard } from "@/components/home/ProjectCard";
import type { RankedCardProduct } from "@/components/home/popular-cards";
import { useSavedSlugs } from "@/components/home/useSavedSlugs";

/**
 * 자리가 붙은 카드 격자 — 발견하기 카드(ProjectCard)를 그대로 쓰고 제목 앞에 순위를 단다.
 * 홈 '많이 쓰이는 프로젝트'(구간마다 상위 3)와 /popular 카드 보기가 함께 쓴다. 저장은 홈 목록과 같은 저장소다.
 */
export function RankedCards({ items, now, headingLevel = 3 }: {
  items: RankedCardProduct[];
  /** 서버가 읽은 시각(ISO) — '새 프로젝트' 같은 글자가 서버와 브라우저에서 같게 */
  now: string;
  headingLevel?: 2 | 3;
}) {
  const [saved, toggle] = useSavedSlugs();
  return (
    <div className="projects-grid">
      {items.map((product) => (
        <ProjectCard key={product.slug} product={product} rank={product.rank} saved={saved.has(product.slug)} onToggleSave={toggle}
          now={now} headingLevel={headingLevel} />
      ))}
    </div>
  );
}
