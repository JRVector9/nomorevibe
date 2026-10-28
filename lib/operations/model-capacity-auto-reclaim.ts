import { z } from "zod";
import { deadlineLadderSchema, deadlineLadderViolation, worstGenerationMs } from "@/lib/llm/deadline-ladder";
import type { ReclaimPolicyWithReference } from "./dr/reclaim";

/**
 * 자동 회수 선언(MODEL_CAPACITY_AUTO_RECLAIM, JSON 배열). provider budget마다 3단계에서 실측·강제를 확인한 기한 사다리와
 * 생성 상한을 적는다. 검증을 통과한 budget만 기존 `releaseEvidencedDispatches`(local_call_ended·process_group_exit + provider_bound
 * 기한) 판정으로 자동 해제한다. 선언이 없거나 틀리면 아무것도 풀지 않는다 — TTL·정책 불일치 무시·SQL 초기화를 대신하지 않는다.
 *
 * 근거: 클라이언트 기한이 지나 로컬 종료가 기록됐고, 그 뒤 안쪽 상한(gateway가 끊고 엔진이 멈추는 시각)+skew 가 지났다면
 * 엔진은 이미 끊겼다. 기존 판정은 로컬 종료 시각 + hardDeadlineMs + skew 를 쓰므로 이 선언에서 hardDeadlineMs = gatewayMs 다.
 */
const label = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const AUTO_RECLAIM_SKEW_MS = 10_000;
export const autoReclaimDeclarationSchema = z.object({
  providerBudgetId: label,
  ladder: deadlineLadderSchema,
  generation: z.object({ maxOutputTokens: z.number().int().min(1).max(262_144),
    minDecodeTokensPerSec: z.number().positive().max(100_000), maxPrefillMs: z.number().int().min(0).max(3_600_000) }).strict(),
  /** 실측·강제 확인 기록(문서 경로·감사 번호). 해제 이벤트의 reference 로 남는다. */
  reference: z.string().min(1).max(400).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value), "invalid_reference"),
}).strict();
export type AutoReclaimDeclaration = z.infer<typeof autoReclaimDeclarationSchema>;
export type AutoReclaimRejection = Readonly<{ index: number; providerBudgetId: string | null; reason: string }>;

export function autoReclaimPolicies(raw: string | undefined): { policies: Map<string, ReclaimPolicyWithReference>; rejected: AutoReclaimRejection[] } {
  const policies = new Map<string, ReclaimPolicyWithReference>(), rejected: AutoReclaimRejection[] = [];
  if (!raw?.trim()) return { policies, rejected };
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return { policies, rejected: [{ index: -1, providerBudgetId: null, reason: "invalid_json" }] }; }
  if (!Array.isArray(list) || list.length > 32) return { policies, rejected: [{ index: -1, providerBudgetId: null, reason: "invalid_list" }] };
  const seen = new Set<string>();
  list.forEach((item, index) => {
    const parsed = autoReclaimDeclarationSchema.safeParse(item);
    const budget = typeof (item as { providerBudgetId?: unknown })?.providerBudgetId === "string" ? (item as { providerBudgetId: string }).providerBudgetId : null;
    const reject = (reason: string) => rejected.push({ index, providerBudgetId: budget, reason });
    if (!parsed.success) return reject("invalid_declaration");
    const value = parsed.data;
    if (seen.has(value.providerBudgetId)) return reject("duplicate_budget");
    seen.add(value.providerBudgetId);
    const order = deadlineLadderViolation(value.ladder);
    if (order) return reject(order);
    // max_tokens 로 묶인 최악 생성 시간이 엔진 상한 안이어야 정상 생성이 상한에 걸려 '모름'이 되지 않는다.
    if (worstGenerationMs(value.generation) > value.ladder.engineMs) return reject("generation_exceeds_engine_bound");
    const hardDeadlineMs = Math.max(value.ladder.engineMs, value.ladder.relayMs ?? 0, value.ladder.gatewayMs);
    policies.set(value.providerBudgetId, { termination: "provider_bound", hardDeadlineMs, skewBoundMs: AUTO_RECLAIM_SKEW_MS,
      reference: value.reference });
  });
  if (rejected.length) policies.clear(); // 일부만 틀린 선언은 운영자 확인 전까지 전부 쓰지 않는다
  return { policies, rejected };
}

/** 해제까지 최대 시간(로컬 종료 기준): 사람이 개입하지 않고 5분 안에 풀리는지 선언 단계에서 확인한다. */
export const autoReclaimLatestReleaseMs = (declaration: AutoReclaimDeclaration) =>
  declaration.ladder.clientMs + Math.max(declaration.ladder.engineMs, declaration.ladder.relayMs ?? 0, declaration.ladder.gatewayMs) + AUTO_RECLAIM_SKEW_MS;
