export const CATEGORIES = [
  "Productivity",
  "Dev",
  "Design",
  "Business",
  "Marketing",
  "Finance",
  "Commerce",
  "Education",
  "Health",
  "Media",
  "Games",
  "Social",
  "Data",
  "Security",
  "Lifestyle",
  "Sports",
  /**
   * 사람 자신이 내용인 것 — 이력·포트폴리오·개인 홈페이지·개인 블로그.
   *
   * 도구가 아니라서 다른 열일곱 중 어디에도 맞지 않는다. 없을 때는 소재를 따라 흩어졌다 —
   * wendyliga.com("A blog about technology, programming, and life")이 Media 로 발행됐다.
   */
  "Profile",
  "Other",
] as const;
export type Category = (typeof CATEGORIES)[number];
