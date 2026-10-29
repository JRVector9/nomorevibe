import { sql, type SQL } from "drizzle-orm";
import type { CrawlCandidate, CrawlReviewAttempt, SecondReview } from "@/lib/db/schema";
import { sameReviewModel } from "./review-model-identity";

export const STALE_RECONCILE_LIMIT = 25;
export const STALE_RECONCILE_EXAMINE_LIMIT = 80;
export const SOURCE_REFRESH_COOLDOWN_MS = 24 * 3600_000;
/** Only demand closed by this controller is carried forward, without an age cutoff. */
export const STALE_REVIEW_OWNER = "stale-input-reconciler";

/** Wrap only after consuming the whole final page, never when the mutation budget stopped mid-page. */
export function staleReviewCursorAfterPage(ids: number[], visited: number, limit: number): number {
  return visited === ids.length && ids.length < limit ? 0 : ids[visited - 1];
}

/** 대기 표가 지금 입력과 어긋난 까닭 — 모두 해시·버전·상태의 비교다. 만든 지 오래됐다는 것은 까닭이 아니다. */
export type Ai2StaleReason =
  | "candidate_missing" | "candidate_state_changed" | "publication_changed" | "source_url_changed"
  | "input_unavailable" | "reviewer_removed" | "first_attempt_missing" | "first_attempt_replaced"
  | "prompt_version_changed" | "rules_version_changed" | "input_hash_changed" | "source_revision_changed"
  | "policy_changed" | "first_outcome_changed" | "generation_changed" | "binding_invalid";

export type Ai2StaleVerdict =
  | { kind: "inactive" }
  | { kind: "current" }
  /** 사람 결정·사람 대기 보류는 이 정리의 몫이 아니다(closeSettled·reopen·사람 화면이 맡는다) */
  | { kind: "protected"; reason: "not_automatic" | "human_hold" }
  /** 해시·버전·상태가 모두 같고 근거 유효기간만 지났다 — 닫지 않고 원본·스캔 갱신만 요청한다 */
  | { kind: "refresh_only"; reason: "evidence_expired" }
  | { kind: "stale"; reasons: Ai2StaleReason[] };

export type Ai2StaleContext = {
  candidate: Pick<CrawlCandidate, "id" | "repo" | "state" | "decidedBy" | "reason" | "publishedSlug" | "productUrl"> | null;
  documentUrl: string | null;
  /** 지금 다시 만든 입력. 만들 수 없으면 null */
  input: { inputHash: string; sourceRevisionHash: string; policyHash: string; validUntil: Date } | null;
  /** 표가 묶인 1차 판단(row.firstAttemptId) */
  first: Pick<CrawlReviewAttempt, "id" | "inputHash" | "sourceRevisionHash" | "policyHash" | "promptVersion"
    | "rulesVersion" | "model" | "outcome"> | null;
  /** 지금 1차 심사자의 가장 새 성공 판단 id — 표가 묶인 것보다 새것이면 1차 결과가 바뀌었다 */
  latestFirstId: number | null;
  /** secondReviewGeneration(row.firstAttemptId, input, row.trigger) — 입력이 없으면 null */
  expectedGenerationKey: string | null;
  reviewerConfigured: boolean;
  /** 실제 로더 검증(secondReviewInputMatches) 결과. true 면 다른 비교와 무관하게 현재 표다 */
  loaderAccepts: boolean;
  promptVersion: string;
  rulesVersion: string;
  now: Date;
};

type Ai2StaleRow = Pick<SecondReview, "status" | "trigger" | "publishedSlug" | "firstAttemptId" | "inputHash"
  | "generationKey" | "firstDecision" | "firstConfidence" | "firstModel">;

/**
 * 오래된 2차 대기 판별 규칙(2026-10-29). 입력(제품 원본·근거)과 1차 결과가 바뀌었는지를 해시·버전으로 비교한다.
 * 시간 경과는 닫는 까닭이 되지 않는다 — 비교가 모두 같고 유효기간만 지났으면 refresh_only 로 갱신만 요청한다.
 * 로더가 받는 표(loaderAccepts)는 언제나 current 다. 사람 결정·사람 대기 보류는 protected 로 남긴다.
 */
export function classifyAi2Vote(row: Ai2StaleRow, ctx: Ai2StaleContext): Ai2StaleVerdict {
  if (row.status !== "pending" && row.status !== "failed") return { kind: "inactive" };
  if (ctx.loaderAccepts) return { kind: "current" };
  const { candidate, input, first } = ctx;
  if (!candidate) return { kind: "stale", reasons: ["candidate_missing"] };
  if (!row.publishedSlug && candidate.decidedBy !== "auto") return { kind: "protected", reason: "not_automatic" };
  if (!row.publishedSlug && candidate.state === "needs_review" && candidate.reason === "second_review_split")
    return { kind: "protected", reason: "human_hold" };
  const reasons = new Set<Ai2StaleReason>();
  if (row.publishedSlug) {
    if (candidate.state !== "published" || candidate.publishedSlug !== row.publishedSlug) reasons.add("publication_changed");
  } else if (candidate.publishedSlug) reasons.add("publication_changed");
  else if (candidate.state !== (row.trigger === "ai_approved" ? "approved" : "needs_review")) reasons.add("candidate_state_changed");
  if (!ctx.documentUrl || ctx.documentUrl !== candidate.productUrl) reasons.add("source_url_changed");
  if (!ctx.reviewerConfigured) reasons.add("reviewer_removed");
  if (!input) reasons.add("input_unavailable");
  if (!row.publishedSlug) {
    if (!first) reasons.add("first_attempt_missing");
    else {
      if (ctx.latestFirstId !== null && ctx.latestFirstId !== first.id) reasons.add("first_attempt_replaced");
      if (first.promptVersion !== ctx.promptVersion) reasons.add("prompt_version_changed");
      if (first.rulesVersion !== ctx.rulesVersion) reasons.add("rules_version_changed");
      if (input && (first.inputHash !== input.inputHash || row.inputHash !== input.inputHash)) reasons.add("input_hash_changed");
      if (input && first.sourceRevisionHash !== input.sourceRevisionHash) reasons.add("source_revision_changed");
      if (input && first.policyHash !== input.policyHash) reasons.add("policy_changed");
      if (first.outcome?.decision !== row.firstDecision || (first.outcome?.confidence ?? null) !== (row.firstConfidence ?? null)
        || first.model !== row.firstModel) reasons.add("first_outcome_changed");
    }
  }
  if (ctx.expectedGenerationKey !== null && ctx.expectedGenerationKey !== row.generationKey) reasons.add("generation_changed");
  if (reasons.size) return { kind: "stale", reasons: [...reasons] };
  if (input && input.validUntil.getTime() <= ctx.now.getTime()) return { kind: "refresh_only", reason: "evidence_expired" };
  return { kind: "stale", reasons: ["binding_invalid"] };
}

type StaleProposal = { model?: string | null; publishedSlug?: string | null; generationKey?: string; inputHash: string };
type OpenVote = Pick<SecondReview, "model" | "publishedSlug" | "generationKey" | "inputHash" | "status">;

/**
 * 다시 넣을 행의 중복 방지(2026-10-29). 한 후보·공개 slug·모델에 살아 있는 표는 언제나 하나다.
 *  - 이미 같은 세대·입력·모델 행이 있으면(어떤 상태든) 넣지 않는다 — 유일 색인과 같은 기준, 같은 판단을 두 번 부르지 않는다
 *  - 같은 모델의 대기(pending·failed) 표가 남아 있으면 그 모델은 넣지 않는다 — 한 모델에 같은 후보가 두 번 배정되지 않는다
 *  - 제안 안에서도 모델마다 첫 행 하나만 남긴다([MLX] 접두 등 같은 모델의 다른 표기 포함)
 * open 에는 이번에 닫는 행을 넣지 않는다. 순서는 제안 순서(설정의 투표자 순서)를 그대로 둔다.
 */
export function admitStaleProposals<T extends StaleProposal>(proposed: T[], open: OpenVote[]): T[] {
  const admitted: T[] = [];
  for (const row of proposed) {
    const slug = row.publishedSlug ?? null;
    if (open.some(existing => existing.generationKey === row.generationKey && existing.inputHash === row.inputHash
      && sameReviewModel(existing.model, row.model))) continue;
    if (open.some(existing => existing.publishedSlug === slug && sameReviewModel(existing.model, row.model)
      && (existing.status === "pending" || existing.status === "failed"))) continue;
    if (admitted.some(kept => (kept.publishedSlug ?? null) === slug && sameReviewModel(kept.model, row.model))) continue;
    admitted.push(row);
  }
  return admitted;
}

export type StaleReconcileArgs = { apply: boolean; actor: string | null; limit: number; after: number };

/** scripts/reconcile-ai2-stale.ts 인자. 모르는 인자·범위 밖 값은 거부한다 — 운영에서 오타가 --apply 로 읽히지 않게 */
export function parseStaleReconcileArgs(argv: string[], max: number, fallbackLimit = STALE_RECONCILE_LIMIT): StaleReconcileArgs {
  const result: StaleReconcileArgs = { apply: false, actor: null, limit: fallbackLimit, after: 0 };
  const integer = (value: string | undefined, name: string, min: number, top: number) => {
    if (value === undefined || !/^\d+$/.test(value)) throw new Error(`invalid_${name}`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > top) throw new Error(`invalid_${name}`);
    return parsed;
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--apply") result.apply = true;
    else if (flag === "--dry-run") result.apply = false;
    else if (flag === "--actor") {
      const value = argv[++index]?.trim();
      if (!value || value.startsWith("--") || value.length > 120) throw new Error("invalid_actor");
      result.actor = value;
    } else if (flag === "--limit") result.limit = integer(argv[++index], "limit", 1, max);
    else if (flag === "--after") result.after = integer(argv[++index], "after", 0, Number.MAX_SAFE_INTEGER);
    else throw new Error(`unknown_argument:${flag}`);
  }
  if (argv.includes("--apply") && argv.includes("--dry-run")) throw new Error("conflicting_mode");
  if (result.apply && !result.actor) throw new Error("actor_required_for_apply");
  return result;
}

export type CapacityProbe = { state: string; reservedUntil: Date | string | null };
/** Unknown state or reservation time protects the existing owner. No capacity row is reclaimed here. */
export function capacityBlocksStaleReconcile(row: CapacityProbe, now: Date): boolean {
  if (row.state === "waiting" || row.state === "withdrawn" || row.state === "settled") return false;
  if (row.state === "reserved") {
    if (row.reservedUntil == null) return true;
    const until = row.reservedUntil instanceof Date ? row.reservedUntil : new Date(row.reservedUntil);
    return !Number.isFinite(until.getTime()) || until.getTime() > now.getTime();
  }
  return true;
}

export function protectingCapacityStateSql(cap: SQL): SQL {
  return sql`(${cap}.state IN ('dispatched', 'indeterminate')
    OR (${cap}.state = 'reserved' AND (${cap}.reserved_until IS NULL OR ${cap}.reserved_until > clock_timestamp()))
    OR coalesce(${cap}.state, '') NOT IN ('waiting', 'reserved', 'dispatched', 'indeterminate', 'withdrawn', 'settled'))`;
}

/** A second-review request with no readable candidate protects all AI2 candidates, never unrelated routes. */
export function staleReviewCapacityIdentitySql(cap: SQL, candidateId: SQL): SQL {
  return sql`(${cap}.logical_work_key LIKE 'ai2:' || (${candidateId})::text || ':%'
    OR (${cap}.route_id = 'second-review' AND (
      ${cap}.work_key LIKE 'ai2:' || (${candidateId})::text || ':%'
      OR (coalesce(${cap}.logical_work_key, '') !~ '^ai2:[1-9][0-9]*:[1-9][0-9]*$'
        AND coalesce(${cap}.work_key, '') !~ '^ai2:[1-9][0-9]*:[1-9][0-9]*:[a-f0-9]{64}$')
    )))`;
}

/** Filter terminal history once before candidate-dependent LIKE/regex checks.
 * Keep every reserved row: hints use wall time, while callbacks retain their existing JS tick time. */
function protectingCapacityRowsSql(): SQL {
  return sql`SELECT cap.state, cap.reserved_until, cap.logical_work_key, cap.work_key, cap.route_id
    FROM model_capacity_requests cap WHERE coalesce(cap.state, '') NOT IN ('waiting', 'withdrawn', 'settled')`;
}

export function protectingCapacityExistsSql(candidateId: SQL, source = sql`model_capacity_requests`): SQL {
  return sql`EXISTS (SELECT 1 FROM ${source} cap
    WHERE ${staleReviewCapacityIdentitySql(sql`cap`, candidateId)} AND ${protectingCapacityStateSql(sql`cap`)})`;
}

/** Recheck current protection inside the candidate transaction; hints grant no authority. */
export function staleReviewCapacityProbeSql(candidateId: number): SQL {
  return sql`WITH stale_review_protecting_capacity AS MATERIALIZED (${protectingCapacityRowsSql()})
    SELECT cap.state, cap.reserved_until FROM stale_review_protecting_capacity cap
    WHERE ${staleReviewCapacityIdentitySql(sql`cap`, sql`${candidateId}`)}`;
}

/** A replaced primary is still the demand owner until its unfinished fallback chain is superseded too. */
export function staleFallbackRootIds(votes: SecondReview[], stale: SecondReview[]): number[] {
  return votes.filter(root => root.fallbackForId === null && root.status === "resolved" && root.resolution === "fallback"
    && stale.some(child => child.fallbackForId === root.id && child.candidateId === root.candidateId
      && child.publishedSlug === root.publishedSlug && child.generationKey === root.generationKey && child.inputHash === root.inputHash)
    && !votes.some(child => child.fallbackForId === root.id && !stale.some(row => row.id === child.id)
      && !(child.status === "resolved" && ["superseded", "model_removed", "fallback"].includes(child.resolution ?? ""))))
    .map(root => root.id);
}

const carriedDemandSql = (s: SQL) => sql`(${s}.status = 'resolved' AND ${s}.resolution = 'superseded'
  AND ${s}.resolved_by = ${STALE_REVIEW_OWNER} AND ${s}.fallback_for_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM second_reviews taken
    WHERE taken.candidate_id = ${s}.candidate_id AND taken.published_slug IS NOT DISTINCT FROM ${s}.published_slug
      AND regexp_replace(lower(trim(taken.model)), '^[[]mlx[]][[:space:]]*', '', 'i')
        = regexp_replace(lower(trim(${s}.model)), '^[[]mlx[]][[:space:]]*', '', 'i')
      AND NOT (taken.status = 'resolved' AND coalesce(taken.resolution, '') IN ('superseded', 'model_removed'))))`;

/** Existing pending/failed fallback votes count as demand. Old unrelated superseded samples do not. */
export function staleSecondReviewScanDemand(detectorVersion: string, enabled = true): SQL {
  if (!enabled) return sql`(SELECT NULL::text AS repository_key WHERE false)`;
  return sql`(
    SELECT DISTINCT lower(c.repo) AS repository_key
    FROM second_reviews s JOIN crawl_candidates c ON c.id = s.candidate_id
    LEFT JOIN products p ON p.slug = c.published_slug
    LEFT JOIN LATERAL (SELECT scan.* FROM agent_repository_scans scan
      WHERE scan.repository_key = lower(c.repo) AND scan.scope = ''
      ORDER BY scan.started_at DESC, scan.id DESC LIMIT 1) latest ON true
    WHERE (s.status IN ('pending', 'failed') OR ${carriedDemandSql(sql`s`)})
      AND ((s.published_slug IS NOT NULL AND s.trigger IN ('risk', 'sample')
        AND c.state = 'published' AND c.published_slug = s.published_slug
        AND c.decided_by IS NOT NULL AND c.decided_by <> 'admin' AND p.status IN ('seeded', 'verified'))
        OR (s.published_slug IS NULL AND c.published_slug IS NULL AND c.decided_by = 'auto'
          AND c.reason IS DISTINCT FROM 'second_review_split'
          AND ((s.trigger = 'ai_approved' AND c.state = 'approved')
            OR (s.trigger IN ('ai_decided', 'ai_held') AND c.state = 'needs_review'))))
      AND (latest.id IS NULL OR latest.completed_at IS NULL
        OR latest.completed_at <= clock_timestamp() - interval '24 hours'
        OR latest.detector_version IS DISTINCT FROM ${detectorVersion}
        OR latest.last_error_code IS NOT NULL OR latest.state IS DISTINCT FROM 'complete')
  )`;
}

/**
 * Examine every active input shape, including policy-only changes and fallback children.
 * A job-owned candidate-ID cursor survives ticks and restarts; a valid prefix cannot starve later demand.
 * Owned closed demand also reaches the callback for an explicit no-longer-required outcome.
 */
export function staleSecondReviewHintSql(afterCandidateId: number, limit: number): SQL {
  return sql`WITH stale_review_protecting_capacity AS MATERIALIZED (${protectingCapacityRowsSql()})
    SELECT DISTINCT s.candidate_id FROM second_reviews s
    JOIN crawl_candidates c ON c.id = s.candidate_id
    WHERE s.candidate_id > ${afterCandidateId}
      AND ((s.status IN ('pending', 'failed') AND (
        (s.published_slug IS NOT NULL AND c.state = 'published' AND c.published_slug = s.published_slug
          AND c.decided_by IS NOT NULL AND c.decided_by <> 'admin')
        -- 관문 표(ai_approved)는 후보가 갈림 보류가 아닌 needs_review 로 내려가도 대기로 남는다(2026-10-27 운영 138985).
        -- closeSettled 는 그 상태를 사람 대기로 보아 닫지 않으므로 여기서 집어 입력 비교로 정리한다.
        OR (s.published_slug IS NULL AND c.published_slug IS NULL AND c.decided_by = 'auto'
          AND c.reason IS DISTINCT FROM 'second_review_split'
          AND ((s.trigger = 'ai_approved' AND c.state IN ('approved', 'needs_review'))
            OR (s.trigger IN ('ai_decided', 'ai_held') AND c.state = 'needs_review')))))
        OR ${carriedDemandSql(sql`s`)})
      AND NOT ${protectingCapacityExistsSql(sql`s.candidate_id`, sql`stale_review_protecting_capacity`)}
    ORDER BY s.candidate_id LIMIT ${limit}`;
}
