import { sql } from "drizzle-orm";
import { db, onReplica } from "@/lib/db";
import { REVIEW_FRESH_MS } from "@/lib/crawl/agent-review-contract";
import { DELEGATED_HOLD_CAUSES, DELEGATED_MODEL_DECISIONS, type DelegatedHoldCause, type DelegatedModelDecision } from "@/lib/crawl/delegated-hold";
import { DEEPSEEK_MIN_CONFIDENCE, DEEPSEEK_REVIEW_PROVIDER } from "@/lib/crawl/deepseek-review-policy";
import { DELEGATED_APPROVE_MAX_EVIDENCE_HOURS, DELEGATED_REPO_CHECK_AFTER_HOURS, type DelegatedApprovalRoute } from "@/lib/crawl/human-review-repository";

/**
 * 사람 몫 위임 검수(human-deepseek-review)의 확신 문턱 미리보기 — 2026-11-10 운영자 요청: 하루치 원래 답을 모아 새 문턱을 고른다.
 *
 * 위임 시도의 model_outcome(0173 — 모델의 원래 결정·확신과 사람에게 남긴 까닭)을 읽어, 문턱 후보마다 승인·반려가 몇 건 적용됐을지 센다.
 * 읽기만 한다(복제본 우선·읽기 전용 TX·짧은 문장 시간 제한). 모델을 부르거나 문턱을 바꾸지 않는다.
 *
 * 문턱을 따르는 것은 지금 적용된 것(holdCause null)과 확신 부족(low_confidence)뿐이다. 모델 보류·승인 불가 사유·72시간 넘은 근거·
 * 저장소 바뀜·사라짐은 문턱과 상관없이 사람에게 남는다(delegated-model-outcome.ts delegatedThresholdHold 의 순서).
 * 확신 부족의 승인은 문턱을 지나도 근거 나이 길을 탄다(human-review-repository.ts delegatedApprovalRoute) — 시도 행의 started_at·valid_until 로
 * 같은 나이를 재서, 72시간 넘은 근거는 「원본 재수집으로 남음」(approveStale)으로 따로 세고, 24~72시간 근거는 저장소 확인을 거쳐야 발행되므로
 * approveRepoCheck 로 함께 보인다(확인에서 바뀜·사라짐이 나오면 적용되지 않는다 — 그만큼 위쪽 어림이다).
 * 옛 행(0173 전)과 실패·밀려남은 model_outcome 이 NULL 이라 세지 않는다. 문턱을 바꾼 뒤의 행이 섞이면 그 행은 그때 문턱의 까닭을 가진다.
 */
export const DELEGATE_THRESHOLD_CANDIDATES = [0.9, 0.85, 0.8, 0.75, 0.7] as const;
/** 확신 구간 — 운영 답의 대부분이 0.72~0.85 라 0.7~0.95 는 0.05 단위로 나눈다. 아래 끝을 포함한다. none = 확신 없음 */
export const CONFIDENCE_BUCKETS = ["none", "<0.50", "0.50-0.60", "0.60-0.70", "0.70-0.75", "0.75-0.80", "0.80-0.85", "0.85-0.90",
  "0.90-0.95", ">=0.95"] as const;
export type ConfidenceBucket = (typeof CONFIDENCE_BUCKETS)[number];
const BUCKET_FLOORS: readonly [number, ConfidenceBucket][] = [[0.95, ">=0.95"], [0.9, "0.90-0.95"], [0.85, "0.85-0.90"], [0.8, "0.80-0.85"],
  [0.75, "0.75-0.80"], [0.7, "0.70-0.75"], [0.6, "0.60-0.70"], [0.5, "0.50-0.60"]];
export function confidenceBucket(confidence: number | null): ConfidenceBucket {
  if (confidence === null) return "none";
  return BUCKET_FLOORS.find(([floor]) => confidence >= floor)?.[1] ?? "<0.50";
}

const ROUTES: readonly DelegatedApprovalRoute[] = ["publish", "check_repo", "refresh"];
/** SQL 집계 줄 — 원래 결정·확신·까닭·근거 나이 길마다 센 수 */
export type DelegateOutcomeRow = { decision: string; confidence: number | null; holdCause: string | null; route: string; n: number };
export type DelegateThresholdLine = {
  threshold: number;
  /** 적용될 승인(근거 72시간 이하). 24~72시간 근거는 저장소 확인을 거친다 */
  approve: number;
  /** approve 중 24~72시간 근거 — 저장소 확인에서 바뀜·사라짐이면 적용되지 않는다 */
  approveRepoCheck: number;
  /** 문턱은 지나지만 근거가 72시간을 넘어 원본 재수집으로 사람에게 남을 승인(held 에 들어 있다) */
  approveStale: number;
  reject: number;
  /** 사람에게 남을 것 — total - approve - reject */
  held: number;
};
export type DelegateThresholdPreview = {
  measuredAt: string;
  hours: number;
  /** 기록할 때의 문턱(DEEPSEEK_MIN_CONFIDENCE) */
  currentThreshold: number;
  /** model_outcome 이 있는 끝난 위임 시도 수 */
  total: number;
  /** 지금 기록된 끝 — applied(적용)와 남긴 까닭별 수 */
  ending: Record<"applied" | DelegatedHoldCause, number>;
  /** 모델의 원래 결정 × 확신 구간 */
  byDecision: Record<DelegatedModelDecision, Record<ConfidenceBucket, number>>;
  /** 원래 결정 × 남긴 까닭(applied 포함) */
  byDecisionEnding: Record<DelegatedModelDecision, Record<"applied" | DelegatedHoldCause, number>>;
  thresholds: DelegateThresholdLine[];
  /** 모양이 어긋나 버린 줄의 수(세지 않았다) */
  ignored: number;
};

const endings = () => Object.fromEntries(["applied", ...DELEGATED_HOLD_CAUSES].map(key => [key, 0])) as Record<"applied" | DelegatedHoldCause, number>;
const buckets = () => Object.fromEntries(CONFIDENCE_BUCKETS.map(key => [key, 0])) as Record<ConfidenceBucket, number>;

/** 집계 줄 → 미리보기. 모르는 결정·까닭·길이나 잘못된 수는 버리고 ignored 에 센다(지어낸 수를 보이지 않게) */
export function summarizeDelegateThreshold(rows: readonly DelegateOutcomeRow[], options: { hours: number; measuredAt: string;
  thresholds?: readonly number[]; currentThreshold?: number }): DelegateThresholdPreview {
  const decisions = Object.fromEntries(DELEGATED_MODEL_DECISIONS.map(key => [key, buckets()])) as DelegateThresholdPreview["byDecision"];
  const decisionEndings = Object.fromEntries(DELEGATED_MODEL_DECISIONS.map(key => [key, endings()])) as DelegateThresholdPreview["byDecisionEnding"];
  const thresholds = (options.thresholds ?? DELEGATE_THRESHOLD_CANDIDATES).map(threshold =>
    ({ threshold, approve: 0, approveRepoCheck: 0, approveStale: 0, reject: 0, held: 0 }));
  const ending = endings();
  let total = 0, ignored = 0;
  for (const row of rows) {
    const n = Number(row.n);
    const confidence = row.confidence === null ? null : Number(row.confidence);
    if (!Number.isSafeInteger(n) || n < 0 || confidence !== null && !Number.isFinite(confidence)
      || !(DELEGATED_MODEL_DECISIONS as readonly string[]).includes(row.decision)
      || row.holdCause !== null && !(DELEGATED_HOLD_CAUSES as readonly string[]).includes(row.holdCause)
      || !(ROUTES as readonly string[]).includes(row.route)) { ignored += Number.isSafeInteger(n) && n > 0 ? n : 0; continue; }
    const decision = row.decision as DelegatedModelDecision, cause = (row.holdCause ?? "applied") as "applied" | DelegatedHoldCause;
    total += n;
    ending[cause] += n;
    decisions[decision][confidenceBucket(confidence)] += n;
    decisionEndings[decision][cause] += n;
    // 문턱을 따르는 것만 — 적용된 것과 확신 부족. 모델 보류는 결정이 needs_review 라 어느 문턱에서도 남는다
    if (decision === "needs_review" || cause !== "applied" && cause !== "low_confidence") continue;
    for (const line of thresholds) {
      if ((confidence ?? 0) < line.threshold) continue;
      if (decision === "reject") { line.reject += n; continue; }
      // 적용된 승인은 이미 근거 나이 길을 지났다. 확신 부족의 승인만 그 길을 미리 잰다
      if (cause === "low_confidence" && row.route === "refresh") { line.approveStale += n; continue; }
      line.approve += n;
      if (row.route === "check_repo") line.approveRepoCheck += n;
    }
  }
  for (const line of thresholds) line.held = total - line.approve - line.reject;
  return { measuredAt: options.measuredAt, hours: options.hours, currentThreshold: options.currentThreshold ?? DEEPSEEK_MIN_CONFIDENCE,
    total, ending, byDecision: decisions, byDecisionEnding: decisionEndings, thresholds, ignored };
}

/** 근거 나이(시간, 소수 첫째 자리) — reviewEvidenceAgeHours(input, attempt.startedAt) 와 같은 셈: started_at - (valid_until - 24시간) */
const evidenceAgeSql = sql`round((extract(epoch FROM a.started_at - a.valid_until) + ${REVIEW_FRESH_MS / 1000}::numeric) / 360) / 10`;
const routeSql = sql`CASE WHEN ${evidenceAgeSql} > ${DELEGATED_APPROVE_MAX_EVIDENCE_HOURS}::numeric THEN 'refresh'
  WHEN ${evidenceAgeSql} > ${DELEGATED_REPO_CHECK_AFTER_HOURS}::numeric THEN 'check_repo' ELSE 'publish' END`;

export const DELEGATE_THRESHOLD_MAX_HOURS = 24 * 7;

export async function readDelegateThresholdPreview(hours = 24): Promise<DelegateThresholdPreview> {
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > DELEGATE_THRESHOLD_MAX_HOURS) throw new Error("delegate_threshold_preview_invalid_hours");
  return onReplica(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL jit = off`);
    const rows = await tx.execute<{ decision: string; confidence: string | null; hold_cause: string | null; route: string; n: number }>(sql`
      SELECT a.model_outcome->>'decision' AS decision, a.model_outcome->>'confidence' AS confidence,
        a.model_outcome->>'holdCause' AS hold_cause, ${routeSql} AS route, count(*)::int AS n
      FROM crawl_review_attempts a
      WHERE a.kind = 'delegated' AND a.provider = ${DEEPSEEK_REVIEW_PROVIDER} AND a.state = 'succeeded' AND a.model_outcome IS NOT NULL
        AND a.completed_at > now() - make_interval(hours => ${hours}::int)
      GROUP BY 1, 2, 3, 4`);
    const [clock] = await tx.execute<{ measured_at: string }>(
      sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS measured_at`);
    if (!clock) throw new Error("delegate_threshold_preview_unreadable");
    return summarizeDelegateThreshold([...rows].map(row => ({ decision: row.decision, confidence: row.confidence === null ? null : Number(row.confidence),
      holdCause: row.hold_cause, route: row.route, n: Number(row.n) })), { hours, measuredAt: clock.measured_at });
  }, { accessMode: "read only", isolationLevel: "repeatable read" }));
}
