import { buildHumanQueueOverview, type HumanQueueOverview } from "@/lib/crawl/human-queue";
import type { ReviewAiDecision } from "@/lib/crawl/admin-review";

/**
 * 화면 테스트용 "사람이 볼 것" — 실제 조립 함수(buildHumanQueueOverview)로 만든다.
 * 직접 판단 human 건은 사람만 가르는 사유, 확정만 agreed 건은 2표 일치·승인으로 둔다.
 */
export function humanOverview({ human = 0, agreed = 0, oldestDays = null, in24h = 0, stalled = 0, decided = 0, published = 0 }: {
  human?: number; agreed?: number; oldestDays?: number | null; in24h?: number; stalled?: number; decided?: number; published?: number;
} = {}): HumanQueueOverview {
  const humanIds = Array.from({ length: human }, (_, i) => i + 1);
  const agreedIds = Array.from({ length: agreed }, (_, i) => human + i + 1);
  const ids = new Map<ReviewAiDecision, number[]>([["approve", [...humanIds, ...agreedIds]], ["reject", []], ["needs_review", []], ["none", []]]);
  return buildHumanQueueOverview({
    aiDecisions: { counts: { approve: human + agreed, reject: 0, needs_review: 0, none: 0 }, ids },
    seconds: {
      counts: { unanimousReject: 0, unanimousApprove: 0, agreedReject: 0, agreedApprove: agreed, needsHuman: 0, published, pending: 0 },
      ids: { unanimous_reject: [], unanimous_approve: [], agreed_reject: [], agreed_approve: agreedIds, needs_human: [] },
    },
    humanOnly: humanIds,
    wait: human ? { oldestDays, stalled, in24h } : { oldestDays: null, stalled: 0, in24h: 0 },
    decided24h: { approve: decided, reject: 0 },
  });
}
