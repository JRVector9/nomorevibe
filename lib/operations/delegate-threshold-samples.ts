import { sql } from "drizzle-orm";
import { db, onReplica } from "@/lib/db";
import { DEEPSEEK_MIN_CONFIDENCE, DEEPSEEK_REVIEW_PROVIDER } from "@/lib/crawl/deepseek-review-policy";
import { DELEGATE_THRESHOLD_CANDIDATES } from "./delegate-threshold-preview";

/**
 * 문턱을 내리기 전에 그 구간의 거절 표본 보기(운영 콘솔 개편 조각 3b, 시안 「흐름 5」 4번) — 사람 몫 위임 검수가 반려 의견을 냈지만
 * 확신이 지금 문턱(DEEPSEEK_MIN_CONFIDENCE) 아래라 사람에게 남긴 것 중, 확신이 [lower, 지금 문턱) 인 것. 문턱을 lower 로 내리면 새로 반려될 후보들이다.
 * readDelegateThresholdPreview 와 같은 조건(kind·provider·끝난 시도·원래 답 model_outcome, 기간)이고 그 안에서 남긴 까닭이 확신 부족인 반려 의견만 본다.
 * 후보마다 마지막 시도 하나, 무작위 limit 건. 읽기만 한다(복제본 우선·읽기 전용 TX·짧은 문장 시간 제한).
 */
export type DelegateRejectSample = { candidateId: number; repo: string; confidence: number; reason: string | null; at: string; state: string };
export type DelegateRejectSamples = { lower: number; upper: number; hours: number; total: number; samples: DelegateRejectSample[] };

/** 화면이 받는 문턱 — 미리보기의 후보 문턱 중 지금 문턱보다 낮은 것만 */
export function rejectSampleThreshold(value: unknown): number | null {
  const number = typeof value === "string" && /^0\.\d{1,2}$/.test(value) ? Number(value) : NaN;
  return (DELEGATE_THRESHOLD_CANDIDATES as readonly number[]).includes(number) && number < DEEPSEEK_MIN_CONFIDENCE ? number : null;
}

export async function readDelegateRejectSamples(lower: number, options: { hours?: number; limit?: number } = {}): Promise<DelegateRejectSamples> {
  const hours = options.hours ?? 24, limit = options.limit ?? 10, upper = DEEPSEEK_MIN_CONFIDENCE;
  if (rejectSampleThreshold(String(lower)) === null) throw new Error("delegate_reject_samples_invalid_threshold");
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 24 * 7 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("delegate_reject_samples_invalid_window");
  }
  return onReplica(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL jit = off`);
    const rows = await tx.execute<{ candidate_id: number; repo: string; confidence: string; reason: string | null; at: string; state: string; total: number }>(sql`
      SELECT s.*, count(*) OVER ()::int AS total FROM (
        SELECT DISTINCT ON (a.candidate_id) a.candidate_id, c.repo, (a.model_outcome->>'confidence')::float8 AS confidence,
          coalesce(a.outcome->>'reason', a.reason) AS reason, to_char(a.completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, c.state::text AS state
        FROM crawl_review_attempts a JOIN crawl_candidates c ON c.id = a.candidate_id
        WHERE a.kind = 'delegated' AND a.provider = ${DEEPSEEK_REVIEW_PROVIDER} AND a.state = 'succeeded' AND a.model_outcome IS NOT NULL
          AND a.model_outcome->>'decision' = 'reject' AND a.model_outcome->>'holdCause' = 'low_confidence'
          AND jsonb_typeof(a.model_outcome->'confidence') = 'number'
          AND (a.model_outcome->>'confidence')::numeric >= ${lower}::numeric AND (a.model_outcome->>'confidence')::numeric < ${upper}::numeric
          AND a.completed_at > now() - make_interval(hours => ${hours}::int)
        ORDER BY a.candidate_id, a.id DESC
      ) s ORDER BY random() LIMIT ${limit}`);
    const list = [...rows];
    return { lower, upper, hours, total: list[0] ? Number(list[0].total) : 0,
      samples: list.map(row => ({ candidateId: Number(row.candidate_id), repo: row.repo, confidence: Number(row.confidence), reason: row.reason,
        at: row.at, state: row.state })) };
  }, { accessMode: "read only", isolationLevel: "repeatable read" }));
}
