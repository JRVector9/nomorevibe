import type { TaglineSource } from "@/lib/db/schema";

const LABELS = {
  ai_page: "AI가 요약 · 페이지 글에서",
  ai_readme: "AI가 요약 · README에서",
  ai_both: "AI가 요약 · 페이지와 README에서",
  ai_fixed: "AI가 요약 · 검수에서 고쳐 썼습니다",
};

/** AI가 쓴 소개는 목록에서도 출처를 밝힌다. */
export function IntroductionSource({ source }: { source?: TaglineSource }) {
  if (!source || !(source in LABELS)) return null;
  return <p className="card-intro-source">{LABELS[source as keyof typeof LABELS]}</p>;
}
