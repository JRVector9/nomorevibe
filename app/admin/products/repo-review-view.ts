import type { ProductRepoReview } from "@/lib/db/schema";
import { formatListTime } from "@/lib/format/time";
import type { AdminProduct } from "./ProductRow";

/**
 * 2단계 판정 이유 — 2026-10-13 부터는 저장소를 다시 열어 본 결과(repo-review.ts)다.
 * 그 전 사이트 확인(코드 거르기·Qwen 네 질문)의 이유는 옛 판정 행을 보이려고 남긴다.
 */
const REASONS: Record<string, string> = {
  repo_gone: "저장소 없음 확인(github.com 404)",
  repo_alive: "저장소가 다시 열림",
  repo_moved: "저장소가 다른 주소로 옮겨 감",
  repo_link_alive: "사이트가 살아 있는 다른 저장소를 가리킴",
  repo_unparsable: "GitHub 저장소 주소 꼴이 아님",
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
const DECISIONS = { keep: "유지", delist_candidate: "내릴 후보", human: "사람 확인" } as const;

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
    ? `${review.operatorBy?.startsWith("auto:") ? "자동" : "운영자"} ${review.operatorDecision === "keep" ? "유지" : "내림"} · ${review.operatorBy ?? ""} · ${review.operatorAt ? date(review.operatorAt) : ""}`
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
