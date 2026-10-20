"use client";

import { useMemo, useSyncExternalStore } from "react";
import { parseSaved, savedAccountServerSnapshot, savedAccountSnapshot, savedSnapshot, subscribeSaved, subscribeSavedAccount, toggleSaved } from "./saved";

/**
 * 저장(북마크)한 제품 — 홈 목록(ProjectGrid)과 같은 저장소(localStorage)를 읽고 고친다.
 * 서버 그림과 첫 그림은 빈 목록이라 어긋나지 않고, 다른 탭에서 바꿔도 따라온다(subscribeSaved).
 * 로그인 중이면 바꿈이 계정에도 간다(toggleSaved).
 */
export function useSavedSlugs(): [Set<string>, (slug: string) => void] {
  const raw = useSyncExternalStore(subscribeSaved, savedSnapshot, () => "[]");
  const saved = useMemo(() => parseSaved(raw), [raw]);
  return [saved, (slug: string) => void toggleSaved(slug, !saved.has(slug))];
}

/** 계정 동기화 상태 — 합치기 묻기·머리 책갈피 점이 쓴다 */
export function useSavedAccount() {
  return useSyncExternalStore(subscribeSavedAccount, savedAccountSnapshot, savedAccountServerSnapshot);
}

/** 저장 수 — 로그인 중이면 계정의 수, 아니면 이 브라우저의 수 */
export function useSavedCount(): number {
  const [saved] = useSavedSlugs();
  const account = useSavedAccount();
  return account.status === "user" && account.serverCount !== null ? account.serverCount : saved.size;
}
