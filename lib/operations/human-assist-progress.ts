import { sql } from "drizzle-orm";
import { db, onReplica } from "@/lib/db";

/**
 * 사람 확인 · AI 보조 카드의 「처리 현황」(2026-11-10 운영자 요청: 지금 작업이 얼마나 처리되는지 보이지 않는다).
 *
 * 카드마다 최근 5분·1시간·24시간에 AI가 끝낸 일을 결과별로 센다(5분은 2026-11-10 운영자 요청). 「현재 호출」이 장부의 전송 중 호출만 보여 주던 것과 달리,
 * 모델이 사람 대기열에서 무엇을 빼냈는지(결정)와 무엇을 사람에게 남겼는지를 가른다. 모델을 부르거나 쓰지 않는다 — 읽기만 한다.
 *  - 사람 몫 위임 검수(human-deepseek-review): crawl_review_attempts(kind=delegated, provider=m3-deepseek)의 끝난 시도.
 *    승인(발행으로 넘김)·반려는 결정이다. 72시간 넘은 근거로 승인을 미뤄 원본을 다시 받게 한 것과 저장소가 사라진 것은 「다시 받기」,
 *    확신 0.9 미만·판단 보류는 「사람에게 남김」이다(human-review-repository.ts recordHumanReview 와 같은 갈래).
 *  - 2차 갈림 재확인(split-confirm): gate_split_tiebreaks 의 DeepSeek 확인 끝(deepseek_completed_at). rejected 만 결정이다.
 *  - 2차 갈림 판가름(split-tiebreak): gate_split_tiebreaks 의 판가름 끝(completed_at). 거부 의견은 재확인으로 넘기고, 승인 의견·카탈로그·소수는 사람에게 남긴다.
 *  - 보류 재심사(held-qwen-retry): 감사 candidate-qwen-held-review 의 result(rejected·pipeline·held).
 */
export const HUMAN_ASSIST_TASKS = ["human-review", "split-confirm", "split-tiebreak", "held-review-retry"] as const;
export type HumanAssistTask = (typeof HUMAN_ASSIST_TASKS)[number];
export type HumanAssistOutcome = "approve" | "reject" | "forward" | "held" | "refresh" | "ineligible" | "failed";
export type HumanAssistWindow = Record<HumanAssistOutcome, number>;
/** 창 — 5분·1시간·24시간. 화면의 기간 단추와 같은 순서다 */
export const HUMAN_ASSIST_WINDOWS = ["five", "hour", "day"] as const;
export type HumanAssistWindowKey = (typeof HUMAN_ASSIST_WINDOWS)[number];
export const HUMAN_ASSIST_WINDOW_LABELS: Record<HumanAssistWindowKey, string> = { five: "최근 5분", hour: "최근 1시간", day: "최근 24시간" };
export type HumanAssistTaskProgress = { five: HumanAssistWindow; hour: HumanAssistWindow; day: HumanAssistWindow;
  /** 지금 이 작업을 기다리는 수. null = 이 작업은 세지 않는다 */
  waiting: number | null };
export type HumanAssistProgress = {
  measuredAt: string;
  tasks: Record<HumanAssistTask, HumanAssistTaskProgress>;
  /** 최근 24시간에 AI가 사람 대기열에서 빼낸 수(위임 승인·반려, 재확인 반려, 보류 재심사 반려·2차로 넘김) */
  decidedDay: number;
};
export type HumanAssistRow = { task: string; bucket: string; outcome: string; n: number };

const OUTCOMES: readonly HumanAssistOutcome[] = ["approve", "reject", "forward", "held", "refresh", "ineligible", "failed"];
const emptyWindow = (): HumanAssistWindow => Object.fromEntries(OUTCOMES.map(key => [key, 0])) as HumanAssistWindow;

/** SQL 집계 줄 → 카드별 창. 모르는 작업·결과·창 이름은 버린다(화면이 지어낸 수를 보이지 않게) */
export function summarizeHumanAssist(rows: readonly HumanAssistRow[], waiting: { humanReview: number | null; splitConfirm: number | null },
  measuredAt: string): HumanAssistProgress {
  const tasks = Object.fromEntries(HUMAN_ASSIST_TASKS.map(task => [task, { five: emptyWindow(), hour: emptyWindow(), day: emptyWindow(), waiting: null }])) as
    Record<HumanAssistTask, HumanAssistTaskProgress>;
  tasks["human-review"].waiting = waiting.humanReview;
  tasks["split-confirm"].waiting = waiting.splitConfirm;
  for (const row of rows) {
    if (!(HUMAN_ASSIST_TASKS as readonly string[]).includes(row.task) || !(OUTCOMES as readonly string[]).includes(row.outcome)) continue;
    if (!(HUMAN_ASSIST_WINDOWS as readonly string[]).includes(row.bucket)) continue;
    const count = Number(row.n);
    if (!Number.isFinite(count) || count < 0) continue;
    tasks[row.task as HumanAssistTask][row.bucket as HumanAssistWindowKey][row.outcome as HumanAssistOutcome] += count;
  }
  const day = (task: HumanAssistTask) => tasks[task].day;
  const decidedDay = day("human-review").approve + day("human-review").reject + day("split-confirm").reject
    + day("held-review-retry").reject + day("held-review-retry").forward;
  return { measuredAt, tasks, decidedDay };
}

/** 한 창(5분 ⊂ 1시간 ⊂ 24시간)마다 같은 결과 갈래를 센다 — 행은 bucket 셋(five·hour·day)으로 나온다 */
const progressSql = sql`
  WITH delegated AS (
    SELECT 'human-review'::text AS task, completed_at AS at, CASE
      WHEN state = 'failed' THEN 'failed'
      WHEN state = 'succeeded' AND outcome->>'decision' = 'approve' THEN 'approve'
      WHEN state = 'succeeded' AND outcome->>'decision' = 'reject' THEN 'reject'
      WHEN state = 'succeeded' AND reason IN ('stale_evidence_refresh', 'repo_deleted') THEN 'refresh'
      WHEN state = 'succeeded' THEN 'held' END AS outcome
    FROM crawl_review_attempts
    WHERE kind = 'delegated' AND provider = 'm3-deepseek' AND completed_at > now() - interval '24 hours'
  ), confirm AS (
    SELECT 'split-confirm'::text, deepseek_completed_at, CASE
      WHEN applied = 'rejected' THEN 'reject'
      WHEN applied = 'held_deepseek_error' OR deepseek_state = 'failed' THEN 'failed'
      WHEN applied LIKE 'held%' THEN 'held' END
    FROM gate_split_tiebreaks WHERE deepseek_completed_at > now() - interval '24 hours'
  ), tiebreak AS (
    SELECT 'split-tiebreak'::text, completed_at, CASE
      WHEN state = 'failed' THEN 'failed'
      WHEN state = 'ineligible' THEN 'ineligible'
      WHEN state = 'succeeded' AND applied IN ('kept_human', 'held_catalog', 'held_minority') THEN 'held'
      WHEN state = 'succeeded' AND applied IS NOT NULL AND applied NOT IN ('superseded', 'switch_off') THEN 'forward' END
    FROM gate_split_tiebreaks WHERE completed_at > now() - interval '24 hours'
  ), held AS (
    SELECT 'held-review-retry'::text, created_at, CASE detail->>'result'
      WHEN 'rejected' THEN 'reject' WHEN 'pipeline' THEN 'forward' WHEN 'held' THEN 'held' END
    FROM operations_audit WHERE action = 'candidate-qwen-held-review' AND created_at > now() - interval '24 hours'
  ), done AS (
    SELECT * FROM delegated UNION ALL SELECT * FROM confirm UNION ALL SELECT * FROM tiebreak UNION ALL SELECT * FROM held
  )
  SELECT task, 'day' AS bucket, outcome, count(*)::int AS n FROM done WHERE outcome IS NOT NULL GROUP BY 1, 3
  UNION ALL
  SELECT task, 'hour', outcome, count(*)::int FROM done WHERE outcome IS NOT NULL AND at > now() - interval '1 hour' GROUP BY 1, 3
  UNION ALL
  SELECT task, 'five', outcome, count(*)::int FROM done WHERE outcome IS NOT NULL AND at > now() - interval '5 minutes' GROUP BY 1, 3`;

/**
 * 위임 검수가 아직 판단을 남기지 않은 사람 몫 후보 — 자동 판정 보류(decided_by=auto)이고 2차 대기가 없으며 위임 판단(succeeded) 기록이 없다.
 * 위임 잡의 고르기(humanReviewRepos)는 원본이 바뀐 후보를 다시 집으므로, 이 수는 「한 번도 판단을 남기지 않은 것」의 하한이다.
 */
const waitingSql = sql`
  SELECT
    (SELECT count(*)::int FROM crawl_candidates c
      WHERE c.state = 'needs_review' AND c.decided_by = 'auto' AND c.published_slug IS NULL
        AND NOT EXISTS (SELECT 1 FROM second_reviews s WHERE s.candidate_id = c.id AND s.status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM crawl_review_attempts a WHERE a.candidate_id = c.id AND a.kind = 'delegated'
          AND a.provider = 'm3-deepseek' AND a.state = 'succeeded')) AS human_review,
    (SELECT count(*)::int FROM gate_split_tiebreaks WHERE applied = 'awaiting_deepseek') AS split_confirm,
    to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS measured_at`;

export async function readHumanAssistProgress(): Promise<HumanAssistProgress> {
  return onReplica(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL jit = off`);
    const rows = await tx.execute<HumanAssistRow>(progressSql);
    const [waiting] = await tx.execute<{ human_review: number; split_confirm: number; measured_at: string }>(waitingSql);
    if (!waiting) throw new Error("human_assist_progress_unreadable");
    return summarizeHumanAssist([...rows], { humanReview: Number(waiting.human_review), splitConfirm: Number(waiting.split_confirm) },
      waiting.measured_at);
  }, { accessMode: "read only", isolationLevel: "repeatable read" }));
}
