/** 목록·필터에 쓰는 한국어 이름. DB 값은 영문 키 그대로 둔다. */
export const CATEGORY_LABELS = {
  Productivity: "생산성",
  Dev: "개발 도구",
  Design: "디자인",
  Finance: "금융",
  Other: "기타",
} as const;

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category;
}
