"use client";

import { useMemo, useSyncExternalStore } from "react";
import { parseSaved, persistSaved, savedSnapshot, subscribeSaved } from "./saved";

/**
 * 저장(북마크)한 제품 — 홈 목록(ProjectGrid)과 같은 저장소(localStorage)를 읽고 고친다.
 * 서버 그림과 첫 그림은 빈 목록이라 어긋나지 않고, 다른 탭에서 바꿔도 따라온다(subscribeSaved).
 */
export function useSavedSlugs(): [Set<string>, (slug: string) => void] {
  const raw = useSyncExternalStore(subscribeSaved, savedSnapshot, () => "[]");
  const saved = useMemo(() => parseSaved(raw), [raw]);
  const toggle = (slug: string) => {
    const next = new Set(saved);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    persistSaved(next);
  };
  return [saved, toggle];
}
