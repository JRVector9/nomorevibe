import type { FirstReviewer } from "./agent-review";

/**
 * 감사가 지금 누구에게 묻는가(0112) — 브라우저도 쓰므로 DB·서버 모듈을 끌어오지 않는다(타입만).
 *
 * 감사는 시작할 때 1차 심사자(provider·model)를 굳힌다. 남은 항목을 다른 심사자로 묻기로 바꾸면(남은 감사 모델 바꾸기, product-audit.ts
 * switchAuditReviewer) 그 감사의 current_provider·current_model 이 채워지고, 잡은 그것으로 새 시도를 묻는다. 시작 때의 값은 기록으로 남는다.
 */

/** gpu3090 의 Qwen 을 게이트웨이 없이 v2 덧붙임으로 묻는 심사(qwen-direct-review.ts) — 감사에서만 쓰는 제공자 갈래다 */
export const QWEN_AUDIT_PROVIDER = "qwen-direct" as const;
/** 감사 심사자의 제공자 — 1차 심사자 셋과 Qwen 직접 심사 */
export type AuditProvider = FirstReviewer["provider"] | typeof QWEN_AUDIT_PROVIDER;
/** 감사 행의 provider 는 옛 값까지 담는 글자 칸이라 string 이다 — 새로 쓰는 current_provider 만 AuditProvider 로 좁힌다 */
export type AuditReviewer = { provider: string; model: string };
type ReviewerLike = AuditReviewer;

type CampaignReviewer = { provider: string; model: string; currentProvider?: string | null; currentModel?: string | null };

/** 지금 새 시도를 묻는 심사자 — 바꿨으면 current_*, 아니면 시작할 때 굳힌 것 */
export function auditReviewer(campaign: CampaignReviewer): AuditReviewer {
  return campaign.currentProvider && campaign.currentModel
    ? { provider: campaign.currentProvider, model: campaign.currentModel } : { provider: campaign.provider, model: campaign.model };
}

export function sameAuditReviewer(a: ReviewerLike | null | undefined, b: ReviewerLike | null | undefined): boolean {
  return Boolean(a && b && a.provider === b.provider && a.model === b.model);
}

/** 시작할 때와 다른 심사자로 묻고 있는가 — 감사 머리의 '모델 전환' 줄 */
export function auditReviewerSwitched(campaign: CampaignReviewer): boolean {
  return !sameAuditReviewer(auditReviewer(campaign), { provider: campaign.provider, model: campaign.model });
}

/** 화면 이름 — '[MLX] gpt-oss-120b' → 'gpt-oss-120b', Qwen 직접 심사 → 'qwen-v2'(덧붙임의 판) */
export function auditReviewerLabel(reviewer: ReviewerLike): string {
  return reviewer.provider === QWEN_AUDIT_PROVIDER ? "qwen-v2" : reviewer.model.replace(/^\[[^\]]*\]\s*/, "");
}
