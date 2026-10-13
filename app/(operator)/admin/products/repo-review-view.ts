import type { ProductRepoReview } from "@/lib/db/schema";
import { formatListTime } from "@/lib/format/time";
import type { AdminProduct } from "./ProductRow";

/** 2단계 판정 이유 — 코드 거르기(repo-review.ts preFilter)와 모델 */
const REASONS: Record<string, string> = {
  model: "AI 판단",
  deployment_gone: "배포 없음(호스팅 오류 페이지)",
  platform_login: "호스팅 로그인 화면으로 넘어감",
  parked: "판매·주차 도메인",
  site_down: "사흘 넘게 응답 없음",
  recently_down: "지금 응답 없음",
  blocked_or_auth: "막힘·로그인·봇 확인",
  thin_page: "글이 거의 없음",
  no_evidence: "제품 이름도 없는 짧은 페이지",
  invalid_output: "AI 답이 두 번 깨짐",
};
const DECISIONS = { keep: "AI: 유지", delist_candidate: "AI: 내릴 후보", human: "AI: 사람 확인" } as const;

/** 네 질문 중 걸린 것만 — 모두 괜찮으면 그렇다고 */
function answersSummary(review: ProductRepoReview): string | null {
  const answers = review.answers;
  if (!answers) return null;
  const flags = [!answers.same_product && "다른 제품", answers.parked && "주차·오류 페이지", answers.shutdown && "종료 공지",
    answers.no_content && "내용 없음"].filter(Boolean);
  return flags.length ? flags.join(" · ") : "네 질문 모두 정상";
}

/**
 * 어드민 줄에 실을 2단계 판정 — 운영자를 기다리는지(open)는 repo-reviews.ts repoReviewOpen 과 같은 규칙이다.
 * now 는 서버가 목록을 읽은 시각이다(lib/format/time 목록 표기 "13:38 (3분 전)"·"10/7 21:15").
 */
export function repoReviewView(review: ProductRepoReview, now: Date = new Date()): NonNullable<AdminProduct["repoReview"]> {
  const date = (value: Date) => formatListTime(value, now);
  const operator = review.operatorDecision
    ? `운영자 ${review.operatorDecision === "keep" ? "유지" : "내림"} · ${review.operatorBy ?? ""} · ${review.operatorAt ? date(review.operatorAt) : ""}`
    : null;
  return {
    decision: DECISIONS[review.decision] ?? review.decision,
    reason: [REASONS[review.reason] ?? review.reason, answersSummary(review)].filter(Boolean).join(" · "),
    page: [review.pageHttpStatus === 0 ? "연결 안 됨" : review.pageHttpStatus, review.finalUrl, review.pageTitle && `“${review.pageTitle}”`]
      .filter((part) => part !== null && part !== undefined && part !== "").join(" · "),
    reviewedAt: date(review.reviewedAt),
    operator,
    open: review.decision !== "keep" && (!review.operatorAt || review.operatorAt < review.reviewedAt),
  };
}
