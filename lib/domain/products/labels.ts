import type { Category } from "./schema";

/** 목록·필터에 쓰는 한국어 이름. DB 값은 영문 키 그대로 둔다. */
export const CATEGORY_LABELS = {
  Productivity: "생산성",
  Dev: "개발 도구",
  Design: "디자인",
  Business: "비즈니스",
  Marketing: "마케팅",
  Finance: "금융",
  Commerce: "커머스",
  Education: "교육",
  Health: "건강",
  Media: "미디어",
  Games: "게임",
  Social: "소셜",
  Data: "데이터",
  Security: "보안",
  Lifestyle: "라이프스타일",
  Sports: "스포츠·피트니스",
  Other: "기타",
} as const satisfies Record<Category, string>;

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category;
}
