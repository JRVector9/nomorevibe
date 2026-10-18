import { dbErrorFields } from '@/lib/db/error-fields';
import { readGitHubCoreHeadroom } from '@/lib/crawl/github-headroom';
import { collectorScope } from '@/lib/crawl/github-secret';
import { recordJobDeferral } from '@/lib/jobs/deferral-observation';
import { itemOwnerSchema, type ItemOwner } from '@/lib/jobs/items/types';
import { logger } from '@/lib/observability/logger';
import type { HostAdmission } from '@/lib/operations/host-budget-runtime';
import { observe } from '@/lib/operations/observations';
import { interruptibleSleep, type RuntimeReport } from '@/scripts/worker';
import { abandonAgentRepositoryClaim, AGENT_SCAN_RECORD_CUTOFF_MS, claimAgentRepository, recordAgentRepositoryScan,
  type AgentScanIdleReason, type AgentScanLease, type AgentScanRecordOutcome } from './claims';
import type { AgentGitHubRequest, CollectResult } from './collect';
import { collectRepositoryAgentScan, getLatestRepositoryAgentScan } from './repository';

/**
 * 제작 근거 스캔 consumer(일꾼). M3 Dokploy 앱과 Oracle unit 이 같은 코드로 agent_repository_claims 큐를 나눠 맡는다.
 *
 * 한 바퀴: 공급자 대기(rate_limited·인증 대기의 retryAt) → GitHub 여유 관문(이 프로세스가 쓰는 자격의 core 남은 비율) → host 장부 admit
 * → claim(5번째마다 priority 를 무시하고 오래 기다린 것부터 — 뒤 순위가 굶지 않게) → 수집(collect 상한 그대로: 요청 12·20초·요청당 8초)
 * → 기록. claim·기록·포기의 권한·lock·시계는 claims.ts 가 정한다. 모드가 items 가 아니거나 설정이 꺼졌거나 탐지기 버전이 다르거나
 * 운영자가 agent-evidence-refresh 잡을 멈췄으면 claim 이 idle 을 돌려주고 여기서는 30초 쉰다(GitHub 를 부르지 않는다).
 *
 * 포기: 종료 신호·예산 소진·claim 뒤 60초(AGENT_SCAN_RECORD_CUTOFF_MS)가 지나면 쓰지 않고 푼다 — 시계·실패 수는 그대로다.
 * 수집·기록 중 예외는 같은 저장소가 큐 맨 앞에서 곧바로 다시 잡히지 않게 retry_after 를 15분 미뤄 푼다. 소유를 잃은 기록(lease_lost)은
 * 아무것도 쓰지 않았으므로 경고만 남기고 다음으로 간다.
 *
 * 쉬는 시간은 모두 60초 이하다 — 쉬기 전에 감독에게 idle 을 알려 progress 한도(90초) 안에 든다.
 */
export const AGENT_SCAN_JOB = 'agent-evidence-refresh';
export const AGENT_SCAN_CONCURRENCY_MAX = 4;
/** 이만큼의 claim 마다 한 번은 order 'due'(priority 무시) — 정기 도래(5)·오류 반복(6)도 앞으로 나아간다 */
export const AGENT_SCAN_DUE_EVERY = 5;
export const AGENT_SCAN_WAIT_MS = { empty: 10_000, mode: 30_000, quota: 60_000, host: 5_000, error: 30_000 } as const;
/** 처리 중 예외로 푼 저장소를 다시 잡기까지 */
export const AGENT_SCAN_ERROR_RETRY_MS = 15 * 60_000;
/** 공급자 한도가 다시 열릴 시각을 모를 때(잡의 retryAfter 와 같은 15분) */
const RATE_LIMIT_FALLBACK_MS = 15 * 60_000;
const OBSERVE_EVERY_MS = 60_000;
const DEFERRAL_NAME = 'agent-scan';

type IdleCounts = Record<Exclude<AgentScanIdleReason, 'empty'>, number>;
export type AgentScanConsumerStats = {
  claimed: number; recorded: Record<AgentScanRecordOutcome, number>; abandoned: number; leaseLost: number; errors: number;
  /** 새 claim 을 하지 않은 횟수: 여유 관문·host 장부·공급자 대기, claim 이 돌려준 idle 이유(empty 는 idleEmpty) */
  deferred: { quota: number; host: number; rateLimited: number } & IdleCounts;
  idleEmpty: number;
  /** 수집이 쓴 GitHub 요청 수(기록·포기 모두) */
  githubRequests: number;
};
export type AgentScanConsumerInput = {
  owner: ItemOwner; signal?: AbortSignal; once?: boolean; report?: RuntimeReport;
  /** 동시 스캔 수 C(1..4, 기본 1). 일꾼마다 claim 하나씩 */
  concurrency?: number;
  /** host 합계 장부(startHostBudget). 없으면 바로 claim 한다 */
  admit?: (job: string) => Promise<HostAdmission>;
  /** 시험용 GitHub. 없으면 githubRequest(이 프로세스의 수집 자격) */
  request?: AgentGitHubRequest;
  sleep?: typeof interruptibleSleep;
};

const emptyStats = (): AgentScanConsumerStats => ({ claimed: 0, recorded: { complete: 0, partial: 0, failed: 0, cached: 0 }, abandoned: 0,
  leaseLost: 0, errors: 0, deferred: { quota: 0, host: 0, rateLimited: 0, mode: 0, disabled: 0, detector: 0, paused: 0, fenced: 0 }, idleEmpty: 0, githubRequests: 0 });
/** claim 순서: 1..(N-1)번째는 priority, N번째는 due */
export function agentScanClaimOrder(attempt: number): 'priority' | 'due' {
  return attempt % AGENT_SCAN_DUE_EVERY === AGENT_SCAN_DUE_EVERY - 1 ? 'due' : 'priority';
}
const errorCode = (error: unknown) => {
  const fields = dbErrorFields(error);
  return fields.code ?? (/^[a-z][a-z0-9_]{0,59}$/.test(fields.message) ? fields.message : fields.name);
};

export async function runAgentScanConsumer(input: AgentScanConsumerInput): Promise<AgentScanConsumerStats> {
  const owner = itemOwnerSchema.parse(input.owner), { signal, once, report } = input;
  const concurrency = input.concurrency ?? 1, sleep = input.sleep ?? interruptibleSleep;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > AGENT_SCAN_CONCURRENCY_MAX) throw new Error('invalid_agent_scan_concurrency');
  // 이 서버의 수집 자격(App 전용 Oracle 등). 값이 틀리면 첫 요청 전에 멈춘다 — 여유 관문도 같은 자격만 센다
  const scope = collectorScope();
  const stats = emptyStats(), bootedAt = Date.now();
  const running = new Map<number, number>();
  let pausedUntil = 0, attempts = 0, observedAt = 0, observing: Promise<void> | null = null;
  const last: { claimAt: number | null; recordAt: number | null; idle: string | null; error: string | null } = { claimAt: null, recordAt: null, idle: null, error: null };

  // 일꾼이 여럿이면 감독에게는 합쳐 알린다 — 도는 스캔이 있으면 가장 오래 돈 것의 시작(job_timeout 이 그것으로 잰다)
  const publish = () => {
    const started = [...running.values()];
    if (started.length) report?.('running', AGENT_SCAN_JOB, Math.min(...started));
    else report?.('idle');
  };
  const snapshot = () => ({ instanceId: owner.instanceId, bootId: owner.bootId, bootedAt, concurrency, release: process.env.RELEASE_TAG ?? 'unknown',
    ...structuredClone(stats), running: running.size, pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null,
    lastClaimAt: last.claimAt && new Date(last.claimAt).toISOString(), lastRecordAt: last.recordAt && new Date(last.recordAt).toISOString(),
    lastIdleReason: last.idle, lastErrorCode: last.error });
  // 관측(agent-scan:<instance>)은 1분에 한 번. 실패해도 일은 계속한다
  const observeNow = (force = false) => {
    if (observing || !force && Date.now() - observedAt < OBSERVE_EVERY_MS) return observing ?? Promise.resolve();
    observedAt = Date.now();
    observing = observe(`agent-scan:${owner.instanceId}`, snapshot())
      .catch(error => logger.warn('agent_scan.observation_failed', dbErrorFields(error))).finally(() => { observing = null; });
    return observing;
  };
  const deferred = (reason: string) => { void recordJobDeferral(DEFERRAL_NAME, reason); };
  const failed = (error: unknown, repositoryKey: string | null) => {
    stats.errors++; last.error = errorCode(error);
    logger.warn('agent_scan.failed', { repositoryKey, ...dbErrorFields(error) });
  };
  const wait = async (ms: number) => { publish(); await sleep(ms, signal); };
  const release = async (lease: AgentScanLease, retryAfterMs?: number) => {
    try {
      if (await abandonAgentRepositoryClaim(lease, retryAfterMs === undefined ? {} : { retryAfterMs })) stats.abandoned++;
    } catch (error) { logger.warn('agent_scan.abandon_failed', { repositoryKey: lease.repositoryKey, ...dbErrorFields(error) }); }
  };

  /** 맡은 저장소 하나. 예외는 이미 푼 뒤에 던진다 */
  const scan = async (lease: AgentScanLease, claimStartedAt: number) => {
    let result: CollectResult | null;
    try {
      const latest = await getLatestRepositoryAgentScan(lease.repositoryKey);
      // 캐시 판단은 claim 시각(DB 시계)으로 한다 — claim 도래(due_at)도 DB 시계라, host 시계가 늦으면 "아직 볼 때가 아님"(cached)을
      // 기록하고 지난 기한이 그대로 남아 같은 저장소를 쉬지 않고 다시 잡는다
      result = await collectRepositoryAgentScan({ repositoryKey: lease.repositoryKey, hasBudget: () => !signal?.aborted,
        ...(input.request ? { request: input.request } : {}), ...(signal ? { signal } : {}) }, latest, new Date(lease.claimedAt));
    } catch (error) { await release(lease, AGENT_SCAN_ERROR_RETRY_MS); throw error; }
    if (result) stats.githubRequests += result.requestCount;
    // 공급자 한도·인증 대기는 저장소 탓이 아니다 — 기록은 하고(시계는 claims.ts), 이 프로세스의 새 claim 을 그 시각까지 멈춘다
    if (result && (result.errorCode === 'rate_limited' || result.errorCode === 'unavailable' && result.retryAt))
      pausedUntil = Math.max(pausedUntil, result.retryAt?.getTime() ?? Date.now() + RATE_LIMIT_FALLBACK_MS);
    // 끊긴 요청은 transport(timeout)로 돌아온다 — 실패로 적지 않고 푼다. 60초가 지났으면 기록 TX 가 TTL 안에 끝난다는 보장이 없다
    if (signal?.aborted || result?.errorCode === 'budget_exhausted' || Date.now() - claimStartedAt > AGENT_SCAN_RECORD_CUTOFF_MS) {
      await release(lease); return;
    }
    try {
      const recorded = await recordAgentRepositoryScan(lease, result);
      stats.recorded[recorded.outcome]++; last.recordAt = Date.now();
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_scan_lease_lost') {
        stats.leaseLost++; logger.warn('agent_scan.lease_lost', { repositoryKey: lease.repositoryKey, epoch: lease.epoch, controlEpoch: lease.controlEpoch });
        return;
      }
      await release(lease, AGENT_SCAN_ERROR_RETRY_MS); throw error;
    }
  };

  /** 한 바퀴. 쉬어야 하면 그 시간(ms), 저장소 하나를 처리했으면 null */
  const step = async (slot: number): Promise<number | null> => {
    if (pausedUntil > Date.now()) {
      stats.deferred.rateLimited++; last.idle = 'rate_limited'; deferred('rate_limited');
      return Math.min(pausedUntil - Date.now(), AGENT_SCAN_WAIT_MS.quota);
    }
    const headroom = await readGitHubCoreHeadroom(Date.now(), scope);
    if (headroom?.low) {
      stats.deferred.quota++; last.idle = 'github_headroom_low'; deferred('github_headroom_low');
      logger.info('agent_scan.github_headroom_low', { remaining: headroom.remaining, limit: headroom.limit });
      return AGENT_SCAN_WAIT_MS.quota;
    }
    const host = input.admit ? await input.admit(AGENT_SCAN_JOB).catch(() => ({ admitted: false as const, reason: 'host_budget_unavailable' as const })) : null;
    if (host?.admitted === false) {
      stats.deferred.host++; last.idle = host.reason; deferred(host.reason);
      return AGENT_SCAN_WAIT_MS.host;
    }
    let repositoryKey: string | null = null;
    try {
      const claimStartedAt = Date.now();
      const claim = await claimAgentRepository({ owner, order: agentScanClaimOrder(attempts++) });
      if (claim.kind === 'idle') {
        if (claim.reason === 'empty') stats.idleEmpty++; else stats.deferred[claim.reason]++;
        last.idle = claim.reason;
        return claim.reason === 'empty' ? AGENT_SCAN_WAIT_MS.empty : AGENT_SCAN_WAIT_MS.mode;
      }
      stats.claimed++; last.claimAt = Date.now(); last.idle = null; repositoryKey = claim.lease.repositoryKey;
      running.set(slot, claimStartedAt); publish();
      try { await scan(claim.lease, claimStartedAt); } finally { running.delete(slot); publish(); }
      return null;
    } catch (error) {
      failed(error, repositoryKey);
      return AGENT_SCAN_WAIT_MS.error;
    } finally {
      if (host?.admitted) await host.release().catch(() => {});
    }
  };
  /** 일꾼 하나. once 면 처음 쉬게 되는 곳에서 끝난다 */
  const worker = async (slot: number) => {
    while (!signal?.aborted) {
      void observeNow();
      let pause: number | null;
      try { pause = await step(slot); } catch (error) { failed(error, null); pause = AGENT_SCAN_WAIT_MS.error; }
      if (pause === null) continue;
      if (once) return;
      await wait(pause);
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, (_, slot) => worker(slot)));
  } finally {
    publish();
    await observing;
    await observeNow(true);
  }
  return stats;
}
