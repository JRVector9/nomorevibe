import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments, crawlFrontier,
  crawlReviewAttempts, jobs, secondReviews } from "@/lib/db/schema";
import { classificationReadyPredicate } from "@/lib/operations/categories";
import { judgementQueuePredicate } from "./repository";
import { reviewApprovalPredicate, reviewCandidatePredicate, starAutoApprovalPredicate } from "./agent-review-repository";
import { createReviewInput, REVIEW_FRESH_MS, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewPolicyHash } from "./agent-review-contract";
import { agentCoverageRevisionSql } from "@/lib/domain/evidence/agents/coverage";
import { firstReviewer } from "./agent-review";
import { README_SAMPLE_LIMIT } from "./readme";
import { firstReviewProviderPredicate, secondReviewInputMatches } from "./second-review-input";
import { MAX_SECOND_REVIEW_FAILURES, SECOND_REVIEW_RETRY_MS, SECOND_REVIEW_TRANSIENT_ERRORS, TRANSIENT_RETRY_MS } from "./second-review";
import type { CrawlSettings } from "./settings-schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";

export type AdmissionStage = { key: "fetch" | "judge" | "first" | "second" | "publish"; waiting: number; oldestMinutes: number | null };
export type DiscoveryAdmissionSnapshot = { recentNew: number; stages: AdmissionStage[]; secondWindowLimited: boolean;
  secondVoteWindowLimited?: boolean; secondObservationLimited?: boolean; secondUnvalidated?: number;
  secondUnvalidatedOldestMinutes?: number | null; timedOut?: boolean };
export type DiscoveryAdmission = { throttled: boolean; remainingNew: number };
// Initial safety thresholds, not a measured throughput target. Healthy queues retain the configured page budget.
export const DISCOVERY_PRESSURE_COUNT = 500;
export const DISCOVERY_PRESSURE_AGE_MINUTES = 5;
export const DISCOVERY_HARD_PRESSURE_COUNT = 1_000;
export const DISCOVERY_RESUME_COUNT = 250;
export const DISCOVERY_RESUME_AGE_MINUTES = 2;
export const DISCOVERY_NEW_WINDOW_MS = 5 * 60_000;
export const DISCOVERY_NEW_ALLOWANCE = 100;
const SECOND_WINDOW = 1_000;
const SNAPSHOT_MS = 3_000;

export class DiscoveryAdmissionDeadlineError extends Error {
  constructor() { super("discovery_admission_deadline"); }
}

function databaseReadTimedOut(error: unknown): boolean {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    if ("code" in current && (current.code === "57014" || current.code === "55P03" || current.code === "DB_POOL_WAIT_TIMEOUT")) return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

export function discoveryAdmission(snapshot: DiscoveryAdmissionSnapshot, previouslyThrottled: boolean): DiscoveryAdmission {
  const unknownWindow = snapshot.secondVoteWindowLimited || (snapshot.secondWindowLimited && !snapshot.secondObservationLimited);
  const throttled = snapshot.timedOut || unknownWindow || snapshot.stages.some(observed => {
    const stage = observed.key === "second" ? { ...observed, waiting: observed.waiting + (snapshot.secondUnvalidated ?? 0),
      oldestMinutes: Math.max(observed.oldestMinutes ?? 0, snapshot.secondUnvalidatedOldestMinutes ?? 0) } : observed;
    return previouslyThrottled
    ? stage.waiting >= DISCOVERY_PRESSURE_COUNT || (stage.waiting > DISCOVERY_RESUME_COUNT && (stage.oldestMinutes ?? 0) > DISCOVERY_RESUME_AGE_MINUTES)
    : stage.waiting >= DISCOVERY_HARD_PRESSURE_COUNT || (stage.waiting >= DISCOVERY_PRESSURE_COUNT && (stage.oldestMinutes ?? 0) >= DISCOVERY_PRESSURE_AGE_MINUTES);
  });
  return { throttled: Boolean(throttled), remainingNew: snapshot.timedOut || unknownWindow ? 1
    : throttled ? Math.max(1, DISCOVERY_NEW_ALLOWANCE - snapshot.recentNew) : Infinity };
}

type ReadState = { expired: boolean; partial: DiscoveryAdmissionSnapshot };
const emptyReadState = (): ReadState => ({ expired: false, partial: { recentNew: 0, stages: [], secondWindowLimited: false } });
const incompleteRead = (state: ReadState): DiscoveryAdmissionSnapshot => ({ ...state.partial,
  stages: state.partial.stages.map(stage => ({ ...stage })), secondWindowLimited: true, timedOut: true });

/** Plain reads and pure semantic checks only. The caller owns transaction settlement. */
async function readAdmissionRows(tx: ProductTransaction, settings: CrawlSettings, now: Date, deadlineAt: number,
  state: ReadState): Promise<DiscoveryAdmissionSnapshot> {
  const checkDeadline = () => { if (state.expired || Date.now() >= deadlineAt) throw new DiscoveryAdmissionDeadlineError(); };
  const at = sql`${now.toISOString()}::timestamp`;
  const available = (name: string) => sql`not exists(select 1 from ${jobs} where ${jobs.name} = ${name} and ${jobs.notBefore} > ${at})`;
  const age = (column: SQL) => sql`extract(epoch from (${at} - min(${column}))) / 60`;
  const reviewer = firstReviewer(settings);
  const modelName = (model: SQL) => sql`regexp_replace(lower(trim(${model})), '^\\[mlx\\][[:space:]]*', '', 'i')`;
  const voterMatches = (provider: SQL, model: SQL, pool: CrawlSettings["secondReview"]["voters"]) => sql`exists(
    select 1 from jsonb_array_elements(${JSON.stringify(pool)}::jsonb) voter
    where voter->>'provider'=${provider} and ${modelName(sql`voter->>'model'`)}=${modelName(model)})`;
  const newer = alias(crawlReviewAttempts, "admission_newer_first");
  const root = alias(secondReviews, "admission_root_vote");
  const readyAt = sql`greatest(${secondReviews.createdAt}, case when ${secondReviews.errorCode} is not null then ${secondReviews.reviewedAt}
    + (case when ${inArray(secondReviews.errorCode, SECOND_REVIEW_TRANSIENT_ERRORS)} then ${TRANSIENT_RETRY_MS}
      else ${SECOND_REVIEW_RETRY_MS} end)::integer * interval '1 millisecond' end)`;
    checkDeadline();
    // Reuse one absolute deadline. Awaited reads get only the remaining statement/lock
    // budget; SET LOCAL works with PgBouncer and preserves the session on cancellation.
    const read = async <T>(query: () => PromiseLike<T>): Promise<T> => {
      checkDeadline();
      const remaining = Math.max(1, Math.floor(deadlineAt - Date.now() - 50));
      await tx.execute(sql`select set_config(name, (case when setting::bigint = 0 then ${remaining}
        else least(setting::bigint, ${remaining}) end)::text || 'ms', true)
        from pg_settings where name in ('statement_timeout', 'lock_timeout')`);
      checkDeadline();
      const value = await query();
      checkDeadline();
      return value;
    };
    await read(() => tx.execute(sql`set local jit = off`));
    const [recent] = await read(() => tx.select({ count: sql<number>`count(*)::int` }).from(crawlFrontier).where(and(
      sql`${crawlFrontier.discoveredAt} > ${at} - ${DISCOVERY_NEW_WINDOW_MS} * interval '1 millisecond' and ${crawlFrontier.discoveredAt} <= ${at}`,
      isNull(crawlFrontier.aliasOf), sql`${crawlFrontier.signal} not in ('review-source-refresh', 'star-auto-source-refresh', 'admin-evidence-refresh')`,
    )));
    state.partial.recentNew = Number(recent?.count ?? 0);
    const stages = await read(() => tx.execute<{ key: AdmissionStage["key"]; waiting: number; oldest: number | null }>(sql`
      select 'fetch' as key, count(*)::int as waiting, ${age(sql`greatest(${crawlFrontier.discoveredAt}, ${crawlFrontier.nextAttemptAt})`)} as oldest
      from ${crawlFrontier} where ${crawlFrontier.state} in ('pending', 'fetching') and ${crawlFrontier.nextAttemptAt} <= ${at}
        and ${available("crawl-fetch")}
      union all select 'judge', count(*)::int, ${age(sql`greatest(${crawlDocuments.fetchedAt}, ${crawlCandidates.updatedAt})`)}
      from ${crawlDocuments} left join ${crawlCandidates} on ${crawlDocuments.repo} = ${crawlCandidates.repo}
      where (${judgementQueuePredicate()}) and ${available("crawl-judge")}
      union all select 'first', count(*)::int, ${age(sql`greatest(${crawlDocuments.fetchedAt}, ${crawlCandidates.updatedAt},
        (select max(a.retry_after) from crawl_review_attempts a where a.candidate_id=${crawlCandidates.id}
          and a.provider=${reviewer?.provider ?? ""} and a.model=${reviewer?.model ?? ""} and a.retry_after <= ${at}))`)}
      from ${crawlCandidates} join ${crawlDocuments} on ${crawlCandidates.repo}=${crawlDocuments.repo}
      where ${reviewCandidatePredicate(settings, { readyOnly: true })} and ${reviewer !== null} and ${available("crawl-agent-review")}
      union all select 'publish', count(*)::int, ${age(sql`greatest(${crawlCandidates.updatedAt}, ${crawlDocuments.fetchedAt},
        (select max(a.completed_at) from crawl_review_attempts a where a.candidate_id=${crawlCandidates.id}),
        (select max(s.reviewed_at) from second_reviews s where s.candidate_id=${crawlCandidates.id}),
        (select max(greatest(cd.updated_at, cd.retry_at)) from category_decisions cd where cd.repo=${crawlCandidates.repo}))`)}
      from ${crawlCandidates} join ${crawlDocuments} on ${crawlCandidates.repo}=${crawlDocuments.repo}
      where ${crawlCandidates.state}='approved' and ${reviewApprovalPredicate(settings)}
        and (${classificationReadyPredicate()} or ${starAutoApprovalPredicate(settings)}) and ${available("crawl-publish")}
    `));
    const result: DiscoveryAdmissionSnapshot = { recentNew: Number(recent?.count ?? 0), secondWindowLimited: false,
      secondVoteWindowLimited: false, secondObservationLimited: false, secondUnvalidated: 0, secondUnvalidatedOldestMinutes: null, timedOut: false,
      stages: stages.map(row => ({ key: row.key, waiting: Number(row.waiting), oldestMinutes: row.oldest === null ? null : Math.max(0, Number(row.oldest)) })) };
    state.partial = result;
    const second: AdmissionStage = { key: "second", waiting: 0, oldestMinutes: null };
    result.stages.push(second);
    if (!settings.secondReview.enabled) return result;
    // Filter cheap worker predicates before the bounded semantic check. Bulk source reads
    // avoid per-vote settings/document/scan queries even when a stale queue is large.
    const rows = await read(() => tx.select({ vote: secondReviews, candidate: crawlCandidates, document: crawlDocuments,
      first: crawlReviewAttempts, root, readyAt: sql<Date>`${readyAt}`.mapWith(crawlDocuments.fetchedAt) })
      .from(secondReviews).innerJoin(crawlCandidates, eq(crawlCandidates.id, secondReviews.candidateId))
      .innerJoin(crawlDocuments, eq(crawlDocuments.repo, secondReviews.repo))
      .innerJoin(crawlReviewAttempts, eq(crawlReviewAttempts.id, secondReviews.firstAttemptId))
      .leftJoin(root, eq(root.id, secondReviews.fallbackForId)).where(and(
        isNull(secondReviews.publishedSlug), eq(crawlCandidates.decidedBy, "auto"),
        or(and(eq(secondReviews.trigger, "ai_approved"), eq(crawlCandidates.state, "approved")),
          and(sql`${secondReviews.trigger} <> 'ai_approved'`, eq(crawlCandidates.state, "needs_review"))),
        or(eq(secondReviews.status, "pending"), and(eq(secondReviews.status, "failed"), sql`${secondReviews.failureCount} < ${MAX_SECOND_REVIEW_FAILURES}`)),
        sql`${readyAt} <= ${at}`, available("second-review"),
        eq(crawlReviewAttempts.kind, "automatic"), eq(crawlReviewAttempts.state, "succeeded"), firstReviewProviderPredicate(settings),
        // Reject known obsolete inputs before LIMIT; only genuinely uncertain current
        // inputs may consume the bounded semantic/observation window below.
        eq(crawlReviewAttempts.policyHash, reviewPolicyHash(settings)), eq(crawlReviewAttempts.promptVersion, REVIEW_PROMPT_VERSION),
        eq(crawlReviewAttempts.rulesVersion, REVIEW_RULES_VERSION), sql`${crawlReviewAttempts.validUntil} > ${at}`,
        sql`${crawlReviewAttempts.outcome}->>'decision'=${secondReviews.firstDecision} and ${crawlReviewAttempts.model}=${secondReviews.firstModel}`,
        sql`case when ${secondReviews.fallbackForId} is null then
          ${voterMatches(sql`${secondReviews.provider}`, sql`${secondReviews.model}`, settings.secondReview.voters)}
          and ${modelName(sql`${secondReviews.firstModel}`)}<>${modelName(sql`${secondReviews.model}`)}
          else ${voterMatches(sql`${secondReviews.provider}`, sql`${secondReviews.model}`, settings.secondReview.fallbacks ?? [])}
            and ${root.fallbackForId} is null and ${root.candidateId}=${secondReviews.candidateId}
            and ${root.generationKey}=${secondReviews.generationKey} and ${root.inputHash}=${secondReviews.inputHash}
            and ${root.status}='resolved' and ${root.resolution}='fallback'
            and ${voterMatches(sql`${root.provider}`, sql`${root.model}`, settings.secondReview.voters)} end`,
        sql`(${crawlReviewAttempts.source}->>'candidateJudgedAt')::timestamp is not distinct from date_trunc('milliseconds', ${crawlCandidates.judgedAt})
          and ${crawlReviewAttempts.source}->>'detectorVersion'=${settings.agentEvidence.detectorVersion}
          and exists(select 1 from crawl_documents admission_doc
            left join lateral(select scan.* from agent_repository_scans scan
              where scan.repository_key=lower(${crawlCandidates.repo}) and scan.scope=''
              order by scan.started_at desc, scan.id desc limit 1) admission_scan on true
            where admission_doc.id=${crawlDocuments.id}
              and admission_doc.id::text=${crawlReviewAttempts.source}->>'documentId'
              and date_trunc('milliseconds', admission_doc.fetched_at)=(${crawlReviewAttempts.source}->>'documentFetchedAt')::timestamp
              and admission_doc.fetched_at > ${at} - ${REVIEW_FRESH_MS} * interval '1 millisecond'
              and admission_doc.product_url is not distinct from ${crawlCandidates.productUrl}
              and admission_doc.product_url is not distinct from ${crawlReviewAttempts.source}->>'productUrl'
              and coalesce(${crawlReviewAttempts.snapshot}->'product'->>'readme', '')=btrim(left(
                case when jsonb_typeof(admission_doc.page_meta->'readmeSample')='string' then admission_doc.page_meta->>'readmeSample' else '' end,
                ${README_SAMPLE_LIMIT}), ${'\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'})
              and admission_scan.id::text is not distinct from ${crawlReviewAttempts.source}->>'scanId'
              and admission_scan.commit_sha is not distinct from ${crawlReviewAttempts.source}->>'scanSha'
              and date_trunc('milliseconds', admission_scan.started_at) is not distinct from (${crawlReviewAttempts.source}->>'scanStartedAt')::timestamp
              and date_trunc('milliseconds', admission_scan.completed_at) is not distinct from (${crawlReviewAttempts.source}->>'scanCompletedAt')::timestamp
              and admission_scan.state is not distinct from ${crawlReviewAttempts.source}->>'scanState'
              and ${agentCoverageRevisionSql(sql`admission_scan.coverage`, sql`admission_scan.cursor`)}=coalesce(${crawlReviewAttempts.source}->'scanCoverage', '{}'::jsonb)
              and admission_scan.last_error_code is not distinct from ${crawlReviewAttempts.source}->>'scanError'
              and (admission_scan.completed_at is null or admission_scan.completed_at > ${at} - ${REVIEW_FRESH_MS} * interval '1 millisecond'))`,
        sql`not exists(select 1 from ${crawlReviewAttempts} admission_newer_first where ${newer.candidateId}=${crawlCandidates.id}
          and ${newer.kind}='automatic' and ${newer.state}='succeeded' and ${firstReviewProviderPredicate(settings, newer)}
          and ${newer.id} > ${crawlReviewAttempts.id}
          and (${secondReviews.trigger}<>'ai_approved' or (${newer.provider}=${crawlReviewAttempts.provider} and ${newer.model}=${crawlReviewAttempts.model})))`,
      )).orderBy(readyAt, asc(secondReviews.id)).limit(SECOND_WINDOW + 1));
    result.secondWindowLimited = rows.length > SECOND_WINDOW;
    result.secondVoteWindowLimited = result.secondWindowLimited;
    const window = rows.slice(0, SECOND_WINDOW);
    if (!window.length) return result;
    const repos = [...new Set(window.map(row => row.candidate.repo.toLowerCase()))];
    const scans = await read(() => tx.selectDistinctOn([agentRepositoryScans.repositoryKey]).from(agentRepositoryScans)
      .where(and(inArray(agentRepositoryScans.repositoryKey, repos), eq(agentRepositoryScans.scope, "")))
      .orderBy(agentRepositoryScans.repositoryKey, desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)));
    const scanIds = scans.map(scan => scan.id);
    // A source with unusually many observations is omitted from this admission lower bound.
    const observations = scanIds.length ? await read(() => tx.execute<Pick<typeof agentRepositoryObservations.$inferSelect, "id" | "scanId" | "facts"> & { total: number }>(sql`
      select id, scan_id as "scanId", facts, total from (select id, scan_id, facts,
        count(*) over(partition by scan_id)::int as total, row_number() over(partition by scan_id order by id) as position
        from ${agentRepositoryObservations} where scan_id in (${sql.join(scanIds.map(id => sql`${id}`), sql`, `)})) sampled where position <= 64
    `)) : [];
    const scanByRepo = new Map(scans.map(scan => [scan.repositoryKey, scan]));
    const evidenceByScan = new Map<number, (Pick<typeof agentRepositoryObservations.$inferSelect, "id" | "scanId" | "facts"> & { total: number })[]>();
    for (const observation of observations) {
      checkDeadline();
      const list = evidenceByScan.get(observation.scanId) ?? [];
      list.push(observation);
      evidenceByScan.set(observation.scanId, list);
    }
    const inputByCandidate = new Map<number, ReturnType<typeof createReviewInput>>();
    for (const row of window) {
      checkDeadline();
      const scan = scanByRepo.get(row.candidate.repo.toLowerCase()) ?? null;
      const evidence = scan ? evidenceByScan.get(scan.id) ?? [] : [];
      if (evidence.some(observation => observation.total > 64)) {
        result.secondWindowLimited = result.secondObservationLimited = true;
        result.secondUnvalidated = (result.secondUnvalidated ?? 0) + 1;
        result.secondUnvalidatedOldestMinutes = Math.max(result.secondUnvalidatedOldestMinutes ?? 0,
          Math.max(0, (now.getTime() - row.readyAt.getTime()) / 60_000));
        continue;
      }
      let input = inputByCandidate.get(row.candidate.id);
      if (!input) {
        input = createReviewInput(row.candidate, row.document, settings, { scan,
          observations: evidence.map(observation => ({ id: `observation:${observation.id}`, observation: observation.facts })) }, now);
        inputByCandidate.set(row.candidate.id, input);
      }
      checkDeadline();
      if (!secondReviewInputMatches(row.vote, { ...row, settings, input }, now)) continue;
      second.waiting++;
      const minutes = Math.max(0, (now.getTime() - row.readyAt.getTime()) / 60_000);
      second.oldestMinutes = Math.max(second.oldestMinutes ?? 0, minutes);
    }
    checkDeadline();
    return result;
}

/** A mutable caller must await this body, then commit/roll back its own transaction; never race it. */
export function readDiscoveryAdmissionInTransaction(tx: ProductTransaction, settings: CrawlSettings, now: Date,
  deadlineAt: number): Promise<DiscoveryAdmissionSnapshot> {
  return readAdmissionRows(tx, settings, now, deadlineAt, emptyReadState());
}

/** One bounded, read-only snapshot per seed tick. Preserve its existing telemetry deadline. */
export async function readDiscoveryAdmission(settings: CrawlSettings, now = new Date()): Promise<DiscoveryAdmissionSnapshot> {
  const deadlineAt = Date.now() + SNAPSHOT_MS;
  const state = emptyReadState();
  const checkDeadline = () => { if (state.expired || Date.now() >= deadlineAt) throw new DiscoveryAdmissionDeadlineError(); };
  const operation = withDbDeadline(deadlineAt, () => db.transaction(async tx => {
    checkDeadline();
    await tx.execute(sql`set local statement_timeout = '3s'`);
    checkDeadline();
    return readAdmissionRows(tx, settings, now, deadlineAt, state);
  }, { accessMode: "read only", isolationLevel: "repeatable read" })).catch(error => {
    if (error instanceof DiscoveryAdmissionDeadlineError || databaseReadTimedOut(error) || state.expired || Date.now() >= deadlineAt) return incompleteRead(state);
    throw error;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DiscoveryAdmissionSnapshot>(resolve => {
    timer = setTimeout(() => { state.expired = true; resolve(incompleteRead(state)); }, Math.max(0, deadlineAt - Date.now()));
    timer.unref?.();
  });
  try {
    // Only read-only work races. A sent statement still settles under the remaining server budget.
    return await Promise.race([operation, timeout]);
  } finally { clearTimeout(timer); }
}
