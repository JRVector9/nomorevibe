import type { TaglineSource } from "@/lib/db/schema";

/** AI 가 소개를 무엇을 보고 지었는지 */
const ORIGINS = {
  ai_page: "페이지 글에서",
  ai_readme: "README에서",
  ai_both: "페이지와 README에서",
};

/**
 * AI가 쓴 소개는 목록에서도 출처를 밝힌다 — 보이는 글이 AI 가 쓴 것일 때만 붙는다(메이커가 쓴 원문에는 붙지 않는다).
 * korean: 보이는 줄이 AI 가 원문을 한국어로 옮긴 것(ProductTagline). 원문도 AI 가 지었으면 무엇을 보고 지었는지 함께 적는다.
 */
export function IntroductionSource({ source, korean = false }: { source?: TaglineSource; korean?: boolean }) {
  const origin = source && source in ORIGINS ? ORIGINS[source as keyof typeof ORIGINS] : null;
  const label = korean ? `AI가 한국어로 요약${origin ? ` · ${origin}` : ""}`
    : origin ? `AI가 요약 · ${origin}`
    : source === "ai_fixed" ? "AI가 요약 · 검수에서 고쳐 썼습니다"
    : source === "editor" ? "운영진이 고쳐 썼습니다"
    : null;
  return label ? <p className="card-intro-source">{label}</p> : null;
}
