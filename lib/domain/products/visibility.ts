import type { Category } from "./categories";

/**
 * 기본 공개 목록에서 빼는 분야(2026-10-09 운영자 결정 D2, UX-22).
 *
 * 개인 프로필은 실명 개인의 포트폴리오라, 본인이 등록·클레임하기 전에는 기본 목록·분야 칩·검색에 싣지 않는다
 * (지우지 않고, 상세는 noindex 를 지킨다 — indexing.ts). 목록 조건(데이터)과 분야 칩(화면)이 이 한 곳을 본다.
 */
export const HIDDEN_BY_DEFAULT_CATEGORIES: readonly Category[] = ["Profile"];

export const hiddenByDefault = (category: string | null | undefined): boolean =>
  category !== null && category !== undefined && (HIDDEN_BY_DEFAULT_CATEGORIES as readonly string[]).includes(category);
