import type { DecisionReason } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import * as crawl from "./repository";

/**
 * 사람이 후보를 가르는 경로.
 *
 * 심사는 '자동 판정 + 예외만'이다. 규칙이 가르지 못한 것(needs_review)만 여기로 오고,
 * 사람이 내린 결정은 decidedBy로 구분해 남는다 — 사람이 뒤집은 건수가 규칙 품질의 지표다.
 */

/** 사람이 거부할 때 고를 수 있는 사유. 규칙이 쓰는 코드와 같은 것을 쓴다 */
export const REVIEW_REJECT_REASONS = [
  { value: "personal_site", label: "개인 사이트·블로그" },
  { value: "not_a_product", label: "배포된 서비스가 아님" },
  { value: "large_oss", label: "대형 오픈소스" },
] as const satisfies readonly { value: DecisionReason; label: string }[];

export type ReviewDecision = "approve" | "reject";

export type ReviewResult = { ok: true } | { ok: false; message: string };

export async function decideCandidate(input: {
  repo: string;
  decision: ReviewDecision;
  /** 거부일 때만 쓴다 */
  reason?: string;
  admin: string;
}): Promise<ReviewResult> {
  const candidate = await crawl.getCandidate(input.repo);
  if (!candidate) return { ok: false, message: "후보를 찾을 수 없습니다" };

  // 이미 발행된 것을 심사로 되돌리면 products와 어긋난다
  if (candidate.state === "published") {
    return { ok: false, message: "이미 발행된 후보입니다" };
  }

  const reason = resolveReason(input.decision, input.reason);
  if (!reason) return { ok: false, message: "알 수 없는 거부 사유입니다" };

  /**
   * productUrl과 signals를 그대로 다시 넣는다. recordJudgement는 행을 통째로 덮어쓰므로
   * 넘기지 않으면 자동 판정이 남긴 근거가 사라진다 — 나중에 "왜 이렇게 갈렸지"에 답할 수 없다.
   */
  await crawl.recordJudgement({
    repo: input.repo,
    productUrl: candidate.productUrl,
    state: input.decision === "approve" ? "approved" : "rejected",
    reason,
    decidedBy: "admin",
    signals: candidate.signals ?? undefined,
  });

  logger.info("crawl.reviewed", {
    repo: input.repo,
    decision: input.decision,
    reason,
    admin: input.admin,
    // 규칙이 뭐라고 했는지 함께 남긴다. 사람이 뒤집은 방향이 규칙을 고치는 근거다
    autoReason: candidate.reason,
  });
  return { ok: true };
}

function resolveReason(decision: ReviewDecision, raw: string | undefined): DecisionReason | null {
  if (decision === "approve") return "passed";
  const allowed = REVIEW_REJECT_REASONS.find((r) => r.value === raw);
  return allowed ? allowed.value : null;
}
