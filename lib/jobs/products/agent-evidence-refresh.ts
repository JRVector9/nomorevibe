import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates } from '@/lib/db/schema';
import { AGENT_DETECTOR_VERSION } from '@/lib/domain/evidence/agents/types';
import { getSettings } from '@/lib/crawl/settings';
import { attachRepositoryAgentScan, refreshRepositoryAgentEvidence } from '@/lib/domain/evidence/agents/repository';
import type { AgentGitHubRequest } from '@/lib/domain/evidence/agents/collect';
import type { JobContext, JobOutcome } from '@/lib/jobs/runner';
import { requeueAfterAdminEvidenceRefresh } from '@/lib/crawl/admin-review';
import { requestJob } from '@/lib/jobs/control';

export type AgentEvidenceRefreshCursor = { afterRepository?: string; retryAfter?: string };
export function prioritizeAgentRefreshDemand(duePartial: string[], repositories: string[]) {
  const resumed = new Set(duePartial.slice(0, 3));
  return [...resumed].map(repositoryKey => ({ repositoryKey, advanceCursor: false }))
    .concat(repositories.filter(key => !resumed.has(key)).map(repositoryKey => ({ repositoryKey, advanceCursor: true })));
}
export async function refreshAgentEvidenceJob(ctx: JobContext<AgentEvidenceRefreshCursor>, dependencies: { request?: AgentGitHubRequest } = {}): Promise<JobOutcome<AgentEvidenceRefreshCursor>> {
  const deadlineAt = Date.now() + 20_000;
  const settings = await getSettings();
  if (!settings.agentEvidence.enabled) { ctx.log('agent_evidence.disabled'); return { done: true }; }
  if (ctx.cursor?.retryAfter && new Date(ctx.cursor.retryAfter).getTime() > Date.now()) return { done: false, cursor: ctx.cursor };
  let afterRepository = ctx.cursor?.afterRepository ?? '';
  // Merge product and candidate demand. Only public GitHub owner/repo identities enter the collector.
  const demand = sql`
      SELECT lower(regexp_replace(repo_url, '^https://github.com/([^/]+/[^/#?]+?)([.]git)?/?$', '\\1')) AS repository_key
      FROM products WHERE status != 'banned' AND repo_url ~ '^https://github.com/[^/]+/[^/#?]+/?$'
      UNION
      SELECT lower(repo) AS repository_key FROM crawl_candidates WHERE state IN ('new', 'needs_review', 'approved')
  `;
  const partial = await db.execute<{ repository_key: string }>(sql`
    SELECT latest.repository_key FROM (
      SELECT DISTINCT ON (repository_key) repository_key, state, next_attempt_at, cursor
      FROM agent_repository_scans WHERE scope = '' AND detector_version = ${AGENT_DETECTOR_VERSION}
      ORDER BY repository_key, started_at DESC, id DESC
    ) latest JOIN (${demand}) demand USING (repository_key)
    WHERE latest.state IN ('partial', 'complete') AND latest.next_attempt_at <= now()
      AND (jsonb_array_length(coalesce(latest.cursor->'pendingTrees', '[]'::jsonb)) > 0
        OR jsonb_array_length(coalesce(latest.cursor->'pendingBlobs', '[]'::jsonb)) > 0
        OR jsonb_array_length(coalesce(latest.cursor->'pendingCommits', '[]'::jsonb)) > 0)
    ORDER BY latest.next_attempt_at, latest.repository_key LIMIT 3
  `);
  /**
   * 일반 대기는 최신 스캔이 다시 볼 때가 된 레포만 고른다 (스캔이 없거나 next_attempt_at 이 지났다).
   *
   * 조건 없이 10개를 고르면 신선한 레포가 슬롯을 차지하고, refresh 안에서야 캐시임을 알고
   * 근거를 읽어 돌아 나온다 — 10개 모두 신선하면 틱이 한 일 없이 끝나고 뒤의 레포는 차례를
   * 기다린다. "최신"은 refresh 의 캐시 판단(getLatestRepositoryAgentScan)과 같은 기준이다.
   */
  const rows = await db.execute<{ repository_key: string }>(sql`
    SELECT repository_key FROM (${demand}) demand
    WHERE repository_key > ${afterRepository} AND NOT EXISTS (
      SELECT 1 FROM (${latestScan(sql`demand.repository_key`)}) latest WHERE latest.next_attempt_at > now()
    )
    ORDER BY repository_key LIMIT 10
  `);
  const work = prioritizeAgentRefreshDemand(partial.map(row => row.repository_key), rows.map(row => row.repository_key));
  const collect = async (): Promise<JobOutcome<AgentEvidenceRefreshCursor>> => {
    for (const row of work) {
      if (!ctx.hasBudget() || Date.now() > deadlineAt - 8_000) return { done: false, cursor: { afterRepository } };
      const repositoryKey = row.repositoryKey;
      try {
        const result = await refreshRepositoryAgentEvidence({ repositoryKey, hasBudget: ctx.hasBudget, request: dependencies.request, deadlineAt });
        if (result.errorCode === 'budget_exhausted') {
          ctx.log('agent_evidence.deferred', { repositoryKey, scanId: result.scan?.id ?? null, state: 'pending', errorCode: result.errorCode });
          const cursor = { afterRepository };
          await ctx.save(cursor);
          return { done: false, cursor };
        }
        ctx.log('agent_evidence.scanned', { repositoryKey, scanId: result.scan?.id ?? null, state: result.scan?.state ?? 'failed', observations: result.observations.length, cached: result.cached, errorCode: result.errorCode });
        if (result.scan?.state === 'complete' && !result.errorCode) {
          if (!result.cached) await requeueAfterAdminEvidenceRefresh(repositoryKey);
          await db.update(crawlCandidates).set({ state: 'new', updatedAt: new Date() }).where(and(sql`lower(${crawlCandidates.repo}) = ${repositoryKey}`, eq(crawlCandidates.state, 'needs_review'), eq(crawlCandidates.reason, 'ai_evidence_pending'), eq(crawlCandidates.decidedBy, 'auto')));
        }
        if (result.errorCode === 'rate_limited') {
          const retryAfter = result.retryAt ?? result.scan?.nextAttemptAt ?? new Date(Date.now() + 15 * 60_000);
          const cursor = { afterRepository, retryAfter: retryAfter.toISOString() };
          await ctx.save(cursor); return { done: false, cursor };
        }
      } catch (error) {
        ctx.log('agent_evidence.failed', { repositoryKey, errorCode: error instanceof Error ? error.name : 'unknown' });
      }
      if (row.advanceCursor) afterRepository = repositoryKey;
      await ctx.save({ afterRepository });
    }
    return rows.length < 10 ? { done: true } : { done: false, cursor: { afterRepository } };
  };
  const outcome = await collect();
  // 제품 연결은 스캔과 따로 돈다. 앞에서 예산이 끊겨도 매 틱 돌아 굶지 않는다 (GitHub를 쓰지 않는다)
  await attachPendingScans(ctx);
  await releaseEvidencePendingCandidates(settings.agentEvidence.detectorVersion);
  return outcome;
}

/**
 * 근거가 갖춰졌는데도 "근거 대기"로 멈춰 있는 후보를 판정으로 되돌린다.
 *
 * 스캔이 끝나면 위 루프가 곧바로 후보를 되돌리지만, 그 update가 일시 오류로 실패하면 catch가
 * 삼킨다. 스캔의 다음 시도는 하루 뒤라 due 선별이 그 레포를 다시 고르지 않아, 후보가 하루
 * 동안 멈췄다(codex가 재현). 그래서 스캔과 떼어 매 틱 쓴다 — 멈춘 원인이 무엇이든 여기서 풀린다.
 *
 * **판정이 "근거 있음"으로 볼 때만** 푼다 — 판정(loadAgentJudgeInput)과 같은 조건이다: 설정의
 * 탐지기 버전, 오류 없음, 24시간 안에 완료. 낡은 스캔으로 풀면 판정이 다시 "근거 대기"로
 * 보류하고, 이것이 또 풀어 매 틱 돈다. 탐지기 버전도 코드 상수가 아니라 판정이 쓰는 설정값을 쓴다.
 */
async function releaseEvidencePendingCandidates(detectorVersion: string) {
  const released = await db.execute<{ id: number }>(sql`
    UPDATE crawl_candidates SET state = 'new', updated_at = now()
    WHERE id IN (
      SELECT candidate.id FROM crawl_candidates candidate
      CROSS JOIN LATERAL (
        SELECT scan.state, scan.last_error_code, scan.completed_at FROM agent_repository_scans scan
        WHERE scan.repository_key = lower(candidate.repo) AND scan.scope = '' AND scan.detector_version = ${detectorVersion}
        ORDER BY scan.started_at DESC, scan.id DESC LIMIT 1
      ) latest
      WHERE candidate.state = 'needs_review' AND candidate.reason = 'ai_evidence_pending' AND candidate.decided_by = 'auto'
        AND latest.state = 'complete' AND latest.last_error_code IS NULL
        AND latest.completed_at <= now() AND latest.completed_at > now() - interval '24 hours'
      LIMIT 50
    )
    RETURNING id
  `);
  // 푼 것은 곧바로 판정한다 — 스케줄(5분)을 기다리지 않는다
  if (released.length > 0) await requestJob("crawl-judge");
}

/** 레포 하나의 최신 스캔 (refresh 의 캐시 판단과 같은 기준: 이 탐지기 버전, 전체 범위, 가장 늦게 시작한 것) */
function latestScan(repositoryKey: SQL) {
  return sql`
    SELECT scan.id, scan.repository_key, scan.state, scan.last_error_code, scan.next_attempt_at FROM agent_repository_scans scan
    WHERE scan.repository_key = ${repositoryKey} AND scan.scope = '' AND scan.detector_version = ${AGENT_DETECTOR_VERSION}
    ORDER BY scan.started_at DESC, scan.id DESC LIMIT 1
  `;
}

/**
 * 최신 스캔이 완료됐는데 제품의 레포 근거가 아직 그 스캔을 가리키지 않는 제품에 붙인다.
 *
 * 스캔이 끝난 직후의 제품도, 근거가 이미 있는 레포에 나중에 올라온 제품도 여기서 붙는다.
 * 일반 대기가 신선한 레포를 다시 보지 않으므로, 이것이 없으면 새 제품은 다음 스캔(하루 뒤)까지
 * 근거를 받지 못한다. 고르는 조건은 attachRepositoryAgentScan 이 붙이는 조건을 그대로 따른다 —
 * 붙인 뒤에는 다시 골리지 않아야 매 틱 같은 제품을 되붙이지 않는다.
 */
async function attachPendingScans(ctx: JobContext<AgentEvidenceRefreshCursor>) {
  // 일반 대기의 제품 쪽 수요와 같은 식으로 repo_url 에서 레포를 뽑는다
  const productRepositoryKey = sql`lower(regexp_replace(product.repo_url, '^https://github.com/([^/]+/[^/#?]+?)([.]git)?/?$', '\\1'))`;
  // 제품마다 붙일 수 있는 레포 근거(보이는 레포 링크 + 그 근거 행) 중 최신 스캔을 가리키는 것이 있는가.
  // 없으면 NULL(붙일 곳이 없다), 있는데 아무것도 안 가리키면 false(붙일 차례다).
  // EXISTS·NOT EXISTS 두 번으로 쓰면 플래너가 링크×근거 조인을 통째로 들고 제품마다 훑는다 —
  // 제품 5,000개에서 0.7초였다. 제품별 인덱스 조회 한 번으로 묶으면 0.06초다.
  const pending = await db.execute<{ id: number; slug: string; scan_id: number }>(sql`
    SELECT product.id, product.slug, latest.id AS scan_id FROM products product
    CROSS JOIN LATERAL (${latestScan(productRepositoryKey)}) latest
    CROSS JOIN LATERAL (
      SELECT bool_or((source.normalized_facts->>'agentScanId') IS NOT DISTINCT FROM latest.id::text) AS attached
      FROM product_links link
      JOIN product_evidence_sources source ON source.slug = link.slug AND source.kind = 'repository' AND source.source_key = link.normalized_key
      WHERE link.slug = product.slug AND link.kind = 'repository' AND link.visible
        AND (lower(link.normalized_key) IN (latest.repository_key, 'github:' || latest.repository_key)
          OR lower(regexp_replace(link.url, '/$', '')) = 'https://github.com/' || latest.repository_key)
    ) sources
    WHERE product.status != 'banned' AND product.repo_url ~ '^https://github.com/[^/]+/[^/#?]+/?$'
      AND latest.state = 'complete' AND latest.last_error_code IS NULL AND sources.attached IS FALSE
    ORDER BY product.id LIMIT 10
  `);
  for (const row of pending) {
    try {
      await attachRepositoryAgentScan({ productSlug: row.slug, productId: row.id, scanId: row.scan_id });
    } catch (error) {
      ctx.log('agent_evidence.attach_failed', { productId: row.id, scanId: row.scan_id, errorCode: error instanceof Error ? error.name : 'unknown' });
    }
  }
}
