import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentScanLease } from '@/lib/domain/evidence/agents/claims';
import type { CollectResult } from '@/lib/domain/evidence/agents/collect';

// E5 consumer 루프(lib/domain/evidence/agents/consumer.ts) 단위. claim·기록·포기·수집·관측은 가짜다 — 실제 DB 경로는
// tests/integration/agent-scan-consumer.test.ts 가 본다.
const mocks = vi.hoisted(() => ({ claim: vi.fn(), record: vi.fn(), abandon: vi.fn(), latest: vi.fn(), collect: vi.fn(),
  headroom: vi.fn(), deferral: vi.fn(), observe: vi.fn(), runtime: vi.fn(), sleep: vi.fn() }));
vi.mock('@/lib/domain/evidence/agents/claims', () => ({ AGENT_SCAN_RECORD_CUTOFF_MS: 60_000, claimAgentRepository: mocks.claim,
  recordAgentRepositoryScan: mocks.record, abandonAgentRepositoryClaim: mocks.abandon }));
vi.mock('@/lib/domain/evidence/agents/repository', () => ({ getLatestRepositoryAgentScan: mocks.latest, collectRepositoryAgentScan: mocks.collect }));
vi.mock('@/lib/crawl/github-headroom', () => ({ readGitHubCoreHeadroom: mocks.headroom }));
vi.mock('@/lib/jobs/deferral-observation', () => ({ recordJobDeferral: mocks.deferral }));
vi.mock('@/lib/operations/observations', () => ({ observe: mocks.observe }));
vi.mock('@/scripts/worker', () => ({ withRuntimeProcess: mocks.runtime, interruptibleSleep: mocks.sleep }));

const { AGENT_SCAN_ERROR_RETRY_MS, agentScanClaimOrder, runAgentScanConsumer } = await import('@/lib/domain/evidence/agents/consumer');
const { agentScanConcurrency, parseAgentScanConsumerArgs, runAgentScanConsumerProcess } = await import('@/scripts/agent-scan-consumer');

const owner = { instanceId: 'agent-scan-consumer-unit', bootId: 'f70bfcce-92d0-4ed8-a5db-bfd092d17950' };
const lease = (key: string): AgentScanLease => ({ repositoryKey: key, binding: { v: 1, repositoryKey: key, detectorVersion: '2026-09-14.1', scope: '' },
  bindingHash: 'a'.repeat(64), owner, token: '00000000-0000-4000-8000-000000000001', epoch: 1, controlEpoch: 2,
  claimedAt: '2026-10-19T00:00:00.000Z', leaseUntil: '2026-10-19T00:02:00.000Z', priority: 5, requiresDaily: false });
const result = (key: string, patch: Partial<CollectResult> = {}): CollectResult => ({ repositoryId: '7', repositoryKey: key, commitSha: 'c'.repeat(40),
  scope: '', state: 'complete', cursor: null, observations: [], requestCount: 3, fileCount: 0, errorCode: null, retryAt: null, ...patch });
const claimed = (key: string) => ({ kind: 'claimed', lease: lease(key) });
const idle = (reason: string) => ({ kind: 'idle', reason });
/** n 번째 쉬기에서 멈춘다. 쉬기 시간을 모은다 */
function stopAfter(n: number) {
  const controller = new AbortController(), waits: number[] = [];
  mocks.sleep.mockImplementation(async (ms: number) => { waits.push(ms); if (waits.length >= n) controller.abort(); });
  return { signal: controller.signal, waits, controller };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.headroom.mockResolvedValue(null); mocks.observe.mockResolvedValue(undefined); mocks.deferral.mockResolvedValue(undefined);
  mocks.latest.mockResolvedValue(null); mocks.abandon.mockResolvedValue(true);
  mocks.collect.mockImplementation(async (input: { repositoryKey: string }) => result(input.repositoryKey));
  mocks.record.mockImplementation(async () => ({ outcome: 'complete', scanId: 1, failureStreak: 0, dueAt: '2026-10-20T00:00:00.000Z', retryAfter: null }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it('waits without GitHub while the claim is idle: 30 seconds for mode/settings/detector/fence, 10 for an empty queue', async () => {
  mocks.claim.mockResolvedValueOnce(idle('mode')).mockResolvedValueOnce(idle('disabled')).mockResolvedValueOnce(idle('detector'))
    .mockResolvedValueOnce(idle('fenced')).mockResolvedValueOnce(idle('empty'));
  const { signal, waits } = stopAfter(5), report = vi.fn();
  const stats = await runAgentScanConsumer({ owner, signal, report });
  expect(waits).toEqual([30_000, 30_000, 30_000, 30_000, 10_000]);
  expect(stats.deferred).toMatchObject({ mode: 1, disabled: 1, detector: 1, fenced: 1 }); expect(stats.idleEmpty).toBe(1);
  expect(mocks.collect).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  // 쉬기 전에 감독에게 idle 을 알린다(progress 90초 안)
  expect(report.mock.calls.filter(([state]) => state === 'idle').length).toBeGreaterThanOrEqual(5);
  // 관측 한 줄(agent-scan:<instance>)은 시작과 끝에 남는다
  expect(mocks.observe).toHaveBeenCalledWith('agent-scan:agent-scan-consumer-unit', expect.objectContaining({ instanceId: owner.instanceId,
    concurrency: 1, lastIdleReason: 'empty' }));
});

it('with once stops at the first idle instead of sleeping (legacy mode never scans)', async () => {
  mocks.claim.mockResolvedValueOnce(idle('mode'));
  const stats = await runAgentScanConsumer({ owner, once: true });
  expect(stats).toMatchObject({ claimed: 0, deferred: { mode: 1 } });
  expect(mocks.sleep).not.toHaveBeenCalled(); expect(mocks.claim).toHaveBeenCalledOnce();
});

it('takes every fifth claim in due order so lower priorities are not starved', async () => {
  expect([0, 1, 2, 3, 4, 5, 9, 14].map(agentScanClaimOrder)).toEqual(['priority', 'priority', 'priority', 'priority', 'due', 'priority', 'due', 'due']);
  let n = 0;
  mocks.claim.mockImplementation(async () => n++ < 10 ? claimed(`acme/r${n}`) : idle('empty'));
  const stats = await runAgentScanConsumer({ owner, once: true });
  expect(mocks.claim.mock.calls.map(([input]) => input.order)).toEqual([...Array(4).fill('priority'), 'due', ...Array(4).fill('priority'), 'due', 'priority']);
  expect(stats).toMatchObject({ claimed: 10, recorded: { complete: 10 }, abandoned: 0, githubRequests: 30 });
  expect(mocks.claim.mock.calls[0][0].owner).toEqual(owner);
});

it('records each claimed repository with its own collection and reports the running scan to the supervisor', async () => {
  mocks.claim.mockResolvedValueOnce(claimed('acme/one')).mockResolvedValueOnce(idle('empty'));
  const report = vi.fn();
  await runAgentScanConsumer({ owner, once: true, report });
  expect(mocks.latest).toHaveBeenCalledWith('acme/one');
  const [input, latest, now] = mocks.collect.mock.calls[0];
  expect(input).toMatchObject({ repositoryKey: 'acme/one' }); expect(input.hasBudget()).toBe(true);
  // 캐시 판단 시각은 claim 시각(DB 시계)이다 — host 시계가 아니다
  expect(latest).toBeNull(); expect(now).toEqual(new Date(lease('acme/one').claimedAt));
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith(lease('acme/one'), result('acme/one'));
  expect(report).toHaveBeenCalledWith('running', 'agent-evidence-refresh', expect.any(Number));
  expect(report.mock.calls.at(-1)).toEqual(['idle']);
});

it('defers new claims while GitHub headroom is low or the host ledger refuses, without claiming', async () => {
  mocks.headroom.mockResolvedValueOnce({ remaining: 100, limit: 10_000, low: true }).mockResolvedValue({ remaining: 9_000, limit: 10_000, low: false });
  const admit = vi.fn().mockResolvedValue({ admitted: true, release: async () => {} }).mockResolvedValueOnce({ admitted: false, reason: 'host_slot_unconfirmed' });
  mocks.claim.mockResolvedValue(idle('empty'));
  const { signal, waits } = stopAfter(3);
  const stats = await runAgentScanConsumer({ owner, signal, admit });
  expect(waits).toEqual([60_000, 5_000, 10_000]);
  expect(stats.deferred).toMatchObject({ quota: 1, host: 1 }); expect(mocks.claim).toHaveBeenCalledOnce();
  expect(mocks.deferral.mock.calls).toEqual([['agent-scan', 'github_headroom_low'], ['agent-scan', 'host_slot_unconfirmed']]);
});

it('releases the host admission after each claim attempt', async () => {
  const release = vi.fn().mockResolvedValue(undefined), admit = vi.fn().mockResolvedValue({ admitted: true, release });
  mocks.claim.mockResolvedValueOnce(claimed('acme/one')).mockResolvedValueOnce(idle('empty'));
  await runAgentScanConsumer({ owner, once: true, admit });
  expect(admit).toHaveBeenCalledWith('agent-evidence-refresh'); expect(release).toHaveBeenCalledTimes(2);
});

it('pauses the whole process until a provider rate-limit reset after recording the scan', async () => {
  const retryAt = new Date(Date.now() + 45_000);
  mocks.claim.mockResolvedValueOnce(claimed('acme/limited')).mockResolvedValue(claimed('acme/next'));
  mocks.collect.mockResolvedValueOnce(result('acme/limited', { state: 'failed', errorCode: 'rate_limited', retryAt, repositoryId: null, commitSha: null }));
  mocks.record.mockResolvedValueOnce({ outcome: 'failed', scanId: null, failureStreak: 0, dueAt: '2026-10-19T00:00:00.000Z', retryAfter: retryAt.toISOString() });
  const { signal, waits } = stopAfter(1);
  const stats = await runAgentScanConsumer({ owner, signal });
  expect(mocks.record).toHaveBeenCalledOnce(); expect(mocks.claim).toHaveBeenCalledOnce();
  expect(waits[0]).toBeGreaterThan(40_000); expect(waits[0]).toBeLessThanOrEqual(45_000);
  expect(stats.deferred.rateLimited).toBe(1); expect(mocks.deferral).toHaveBeenCalledWith('agent-scan', 'rate_limited');
});

it('abandons without recording when shutdown interrupts a scan, and stops claiming', async () => {
  const controller = new AbortController();
  mocks.claim.mockResolvedValue(claimed('acme/one'));
  mocks.collect.mockImplementationOnce(async (input: { hasBudget: () => boolean; signal: AbortSignal }) => {
    controller.abort(); expect(input.signal.aborted).toBe(true); expect(input.hasBudget()).toBe(false);
    return result('acme/one', { state: 'partial', errorCode: 'timeout' });
  });
  const stats = await runAgentScanConsumer({ owner, signal: controller.signal });
  expect(mocks.record).not.toHaveBeenCalled();
  expect(mocks.abandon).toHaveBeenCalledExactlyOnceWith(lease('acme/one'), {});
  expect(stats).toMatchObject({ claimed: 1, abandoned: 1, errors: 0 }); expect(mocks.claim).toHaveBeenCalledOnce();
});

it('abandons a budget-exhausted collection and anything past the 60 second record cutoff', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  mocks.claim.mockResolvedValueOnce(claimed('acme/budget')).mockResolvedValueOnce(claimed('acme/slow')).mockResolvedValue(idle('empty'));
  mocks.collect.mockResolvedValueOnce(result('acme/budget', { errorCode: 'budget_exhausted' }))
    .mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 60_001); return result('acme/slow'); });
  const stats = await runAgentScanConsumer({ owner, once: true });
  expect(mocks.record).not.toHaveBeenCalled();
  expect(mocks.abandon.mock.calls).toEqual([[lease('acme/budget'), {}], [lease('acme/slow'), {}]]);
  expect(stats).toMatchObject({ claimed: 2, abandoned: 2 });
});

it('backs a repository off for 15 minutes when collection or recording throws, but only warns on a lost lease', async () => {
  mocks.claim.mockResolvedValueOnce(claimed('acme/bad')).mockResolvedValueOnce(claimed('acme/throws')).mockResolvedValueOnce(claimed('acme/lost'))
    .mockResolvedValue(idle('empty'));
  mocks.record.mockRejectedValueOnce(new Error('invalid agent observation'));
  mocks.collect.mockImplementation(async (input: { repositoryKey: string }) => {
    // 저장소 탓 예외(응답 모양이 깨진 저장소 등). 자격 없음·DB 오류는 아래 테스트처럼 consumer 전체가 쉰다
    if (input.repositoryKey === 'acme/throws') throw new TypeError('unexpected tree entry');
    return result(input.repositoryKey);
  });
  const { signal, waits } = stopAfter(3);
  mocks.record.mockRejectedValueOnce(new Error('agent_scan_lease_lost'));
  const stats = await runAgentScanConsumer({ owner, signal });
  expect(mocks.abandon.mock.calls).toEqual([[lease('acme/bad'), { retryAfterMs: AGENT_SCAN_ERROR_RETRY_MS }],
    [lease('acme/throws'), { retryAfterMs: AGENT_SCAN_ERROR_RETRY_MS }]]);
  expect(AGENT_SCAN_ERROR_RETRY_MS).toBe(15 * 60_000);
  // 예외 뒤에는 30초 쉬고, 소유를 잃은 기록 뒤에는 쉬지 않고 다음 claim 으로 간다
  expect(waits).toEqual([30_000, 30_000, 10_000]);
  expect(stats).toMatchObject({ claimed: 3, errors: 2, leaseLost: 1, abandoned: 2 });
});

it('pauses the whole consumer on missing credentials or a database outage without backing the repository off', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const controller = new AbortController(), waits: number[] = [];
  // 쉬는 만큼 시계를 민다. 다섯 번째 쉬기에서 멈춘다
  mocks.sleep.mockImplementation(async (ms: number) => { waits.push(ms); vi.setSystemTime(Date.now() + ms); if (waits.length >= 5) controller.abort(); });
  mocks.claim.mockResolvedValueOnce(claimed('acme/creds')).mockResolvedValueOnce(claimed('acme/db')).mockResolvedValue(idle('empty'));
  mocks.collect.mockRejectedValueOnce(new Error('GitHub 수집 토큰이 없습니다 — 인증된 토큰이 필요합니다'));
  mocks.record.mockRejectedValueOnce(Object.assign(new Error('Failed query: update ...'), { cause: Object.assign(new Error('terminating connection'), { code: '57P01' }) }));
  const stats = await runAgentScanConsumer({ owner, signal: controller.signal });
  // 저장소를 미루지 않고 그대로 푼다(실패 수·retry_after 그대로) — 고치기 전: 저장소마다 15분씩 밀렸다
  expect(mocks.abandon.mock.calls).toEqual([[lease('acme/creds'), {}], [lease('acme/db'), {}]]);
  // 자격 없음 → 60초 쉼(그동안 claim 없음) → DB 오류 → 60초 쉼 → 다시 claim
  expect(waits).toEqual([60_000, 60_000, 10_000, 10_000, 10_000]);
  expect(mocks.claim).toHaveBeenCalledTimes(5);
  expect(stats).toMatchObject({ claimed: 2, errors: 2, abandoned: 2, deferred: { systemic: 0 } });
  expect(mocks.observe).toHaveBeenLastCalledWith('agent-scan:agent-scan-consumer-unit', expect.objectContaining({ pausedUntil: null, lastErrorCode: '57P01' }));
});

it('classifies only credential and database-wide failures as systemic', async () => {
  const { agentScanSystemicError } = await import('@/lib/domain/evidence/agents/consumer');
  const coded = (code: string) => Object.assign(new Error('Failed query: select ...'), { cause: Object.assign(new Error('x'), { code }) });
  for (const error of [coded('57P01'), coded('08006'), coded('40P01'), coded('55P03'), coded('42P01'), coded('42501'), coded('ECONNREFUSED'),
    new Error('github_collector_secret_missing'), new Error('github_collector_scope_invalid:GITHUB_COLLECTOR_SOURCES'),
    new Error('GitHub 수집 토큰이 없습니다 — 인증된 토큰이 필요합니다')]) expect(agentScanSystemicError(error)).toBe(true);
  for (const error of [new Error('invalid agent observation'), new TypeError('unexpected tree entry'), coded('23505'), coded('22P02'),
    new Error('agent_scan_record_invalid')]) expect(agentScanSystemicError(error)).toBe(false);
});

it('holds every worker while the consumer is paused for a systemic error', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const controller = new AbortController(), waits: number[] = [];
  mocks.sleep.mockImplementation(async (ms: number) => { waits.push(ms); if (waits.length >= 3) controller.abort(); });
  mocks.claim.mockResolvedValueOnce(claimed('acme/creds')).mockResolvedValueOnce(claimed('acme/next')).mockResolvedValue(idle('empty'));
  mocks.collect.mockRejectedValueOnce(new Error('github_collector_secret_missing'));
  const stats = await runAgentScanConsumer({ owner, signal: controller.signal });
  // 시계가 그대로라 첫 쉼 뒤에도 정지 시각 전이다 — 새 claim 없이 남은 시간만큼 쉰다
  expect(mocks.claim).toHaveBeenCalledOnce();
  expect(waits).toEqual([60_000, 60_000, 60_000]);
  expect(stats.deferred.systemic).toBe(2);
  expect(mocks.deferral).toHaveBeenCalledWith('agent-scan', 'systemic_error');
});

it('keeps scanning with C workers and refuses a concurrency outside 1..4', async () => {
  let n = 0, inFlight = 0, peak = 0;
  mocks.claim.mockImplementation(async () => n++ < 6 ? claimed(`acme/r${n}`) : idle('empty'));
  mocks.collect.mockImplementation(async (input: { repositoryKey: string }) => {
    inFlight++; peak = Math.max(peak, inFlight); await new Promise(resolve => setTimeout(resolve, 5)); inFlight--; return result(input.repositoryKey);
  });
  const stats = await runAgentScanConsumer({ owner, once: true, concurrency: 3 });
  expect(peak).toBe(3); expect(stats).toMatchObject({ claimed: 6, recorded: { complete: 6 } });
  for (const concurrency of [0, 5, 1.5]) await expect(runAgentScanConsumer({ owner, once: true, concurrency })).rejects.toThrow('invalid_agent_scan_concurrency');
});

it('gates headroom on the credentials this process uses', async () => {
  vi.stubEnv('GITHUB_COLLECTOR_SOURCES', 'apps'); vi.stubEnv('GITHUB_COLLECTOR_APP_INSTALLATIONS', '42');
  mocks.claim.mockResolvedValue(idle('empty'));
  await runAgentScanConsumer({ owner, once: true });
  const scope = mocks.headroom.mock.calls[0][1];
  expect([...scope.sources]).toEqual(['apps']); expect(scope.onlyInstallations).toEqual([42]);
  vi.stubEnv('GITHUB_COLLECTOR_SOURCES', 'apps,typo');
  await expect(runAgentScanConsumer({ owner, once: true })).rejects.toThrow('github_collector_scope_invalid:GITHUB_COLLECTOR_SOURCES');
});

it('the entry point is off by default and checks version, concurrency, instance and collector scope before the runtime', async () => {
  expect(parseAgentScanConsumerArgs(['--once'])).toEqual({ once: true });
  for (const args of [['--once', '--once'], ['--role=crawler'], ['x']]) expect(() => parseAgentScanConsumerArgs(args)).toThrow();
  expect(await runAgentScanConsumerProcess([], {})).toEqual({ state: 'disabled' });
  expect(agentScanConcurrency({})).toBe(1); expect(agentScanConcurrency({ AGENT_SCAN_CONCURRENCY: '4' })).toBe(4);
  for (const value of ['0', '5', '01', ' 2', '']) expect(() => agentScanConcurrency({ AGENT_SCAN_CONCURRENCY: value })).toThrow('invalid_agent_scan_concurrency');
  const env = { AGENT_SCAN_CONSUMER_VERSION: '1', SERVICE_INSTANCE_ID: 'agent-scan-consumer-m3' };
  for (const [patch, error] of [[{ AGENT_SCAN_CONSUMER_VERSION: '2' }, 'invalid_agent_scan_consumer_version'],
    [{ AGENT_SCAN_CONCURRENCY: '9' }, 'invalid_agent_scan_concurrency'],
    [{ SERVICE_INSTANCE_ID: 'crawler-m3' }, 'invalid_item_consumer_service_instance'],
    [{ SERVICE_INSTANCE_ID: 'ai1-consumer-m3' }, 'invalid_item_consumer_service_instance'],
    [{ GITHUB_COLLECTOR_SOURCES: 'pat' }, 'github_collector_scope_invalid:GITHUB_COLLECTOR_SOURCES']] as const)
    await expect(runAgentScanConsumerProcess([], { ...env, ...patch })).rejects.toThrow(error);
  expect(mocks.runtime).not.toHaveBeenCalled();
  mocks.runtime.mockImplementation(async (_role, run) => run(new AbortController().signal, vi.fn()));
  mocks.claim.mockResolvedValue(idle('mode'));
  expect(await runAgentScanConsumerProcess(['--once'], { ...env, AGENT_SCAN_CONCURRENCY: '2' })).toMatchObject({ state: 'stopped', deferred: { mode: 2 } });
  expect(mocks.runtime).toHaveBeenCalledExactlyOnceWith('crawler', expect.any(Function));
  expect(mocks.claim.mock.calls[0][0].owner.instanceId).toBe('agent-scan-consumer-m3');
});
