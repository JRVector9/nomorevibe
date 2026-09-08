"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import {
  HOME_FIRST_PAGE,
  HOME_PAGE_SIZE,
  hrefWith,
  type BrowseState,
} from "@/components/home/browse-state";
import { Icon } from "@/components/home/icons";
import { ProjectCard } from "@/components/home/ProjectCard";
import { parseSaved, persistSaved, savedSnapshot, subscribeSaved } from "@/components/home/saved";
import type { HomeCardProduct } from "@/components/home/types";

export function ProjectGrid({
  products,
  browseState,
  initialOnlySaved = false,
}: {
  products: HomeCardProduct[];
  browseState: BrowseState;
  initialOnlySaved?: boolean;
}) {
  const raw = useSyncExternalStore(subscribeSaved, savedSnapshot, () => "[]");
  const saved = useMemo(() => parseSaved(raw), [raw]);
  const onlySaved = initialOnlySaved;
  const [localLimit, setLocalLimit] = useState(HOME_FIRST_PAGE);
  const limit = onlySaved ? localLimit : (browseState.shown ?? HOME_FIRST_PAGE);

  function toggleSave(slug: string) {
    const next = new Set(saved);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    persistSaved(next);
  }

  const rows = onlySaved ? products.filter((product) => saved.has(product.slug)) : products;
  const visible = rows.slice(0, limit);

  if (rows.length === 0) {
    return (
      <div className="projects-grid">
        <div className="empty-state">
          <Icon name="bookmark" size={29} />
          <h3>아직 저장한 프로젝트가 없습니다.</h3>
          <p>관심 있는 프로젝트의 북마크를 눌러 모아보세요.</p>
          <Link className="secondary" href={hrefWith(browseState)}>
            전체 프로젝트 보기
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      {onlySaved && (
        <div className="saved-banner">
          이 브라우저에 저장한 프로젝트 {rows.length}개
          <Link className="text-button" href={hrefWith(browseState)}>
            전체 보기
          </Link>
        </div>
      )}
      <div className="projects-grid" id="project-grid" role="tabpanel" aria-label="프로젝트 목록">
        {visible.map((product) => (
          <ProjectCard
            key={product.slug}
            product={product}
            saved={saved.has(product.slug)}
            onToggleSave={toggleSave}
            browseState={browseState}
          />
        ))}
      </div>
      {limit < rows.length && (
        onlySaved ? (
          <button type="button" className="more-btn" onClick={() => setLocalLimit((current) => current + HOME_PAGE_SIZE)}>
            프로젝트 더 보기 ({Math.min(limit, rows.length)} / {rows.length})
          </button>
        ) : (
          <Link
            className="more-btn"
            href={hrefWith(browseState, { shown: Math.min(limit + HOME_PAGE_SIZE, rows.length) })}
            scroll={false}
          >
            프로젝트 더 보기 ({Math.min(limit, rows.length)} / {rows.length})
          </Link>
        )
      )}
    </>
  );
}
