import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UptimeClaimTicket } from '@/lib/domain/products/uptime-claims';
import type { UptimeSplitPolicy } from '@/lib/domain/products/uptime-split-policy';

/*
 * U2 Oracle uptime consumer 루프(lib/jobs/products/uptime-consumer.ts)와 진입점(scripts/uptime-consumer.ts).
 * DB 함수(제어 읽기·claim·제출·되돌림)와 HTTP 는 가짜다. 시계는 가짜 타이머(performance 포함)로 돌려 pacing 을 정확히 잰다.
 * 실제 PostgreSQL 동시성·계정 권한·SIGTERM 은 tests/integration/uptime-consumer.test.ts.
 */
const io = vi.hoisted(() => ({ read: vi.fn(), claim: vi.fn(), submit: vi.fn(), release: vi.fn(), observe: vi.fn(), fetch: vi.fn(),
  runtime: vi.fn(), log: vi.fn(), skew: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: {}, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/domain/products/uptime-claims', async load => ({ ...await load<typeof import('@/lib/domain/products/uptime-claims')>(),
  readUptimeSplitControl: io.read, claimUptimeProducts: io.claim, submitUptimeResults: io.submit, releaseUptimeClaims: io.release,
  measureUptimeClockSkew: io.skew }));
vi.mock('@/lib/operations/observations', () => ({ observe: io.observe }));
vi.mock('@/lib/net/fetch', () => ({ FETCH_TIMEOUT_MS: 10_000, safeFetch: io.fetch }));
vi.mock('@/lib/observability/logger', () => ({ logger: { debug: io.log, info: io.log, warn: io.log, error: io.log } }));
// scripts/worker 는 무겁다 — 같은 모양의 interruptibleSleep(가짜 타이머에 묶인다)과 런타임만 둔다
vi.mock('@/scripts/worker', () => ({ withRuntimeProcess: io.runtime,
  interruptibleSleep: (ms: number, signal?: AbortSignal) => signal?.aborted ? Promise.resolve() : new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  }) }));

const { runUptimeConsumer, checkUptimeUrl, uptimeConsumerClaimLimit, uptimeConsumerInterval, UPTIME_CONSUMER_LEASE_MARGIN_MS } =
  await import('@/lib/jobs/products/uptime-consumer');
const { parseUptimeConsumerArgs, runUptimeConsumerProcess } = await import('@/scripts/uptime-consumer');

const ORACLE = 'uptime-consumer-oracle';
const owner = { instanceId: ORACLE, bootId: 'f70bfcce-92d0-4ed8-a5db-bfd092d17950' };
const breaker = { windowMinutes: 10, minChecks: 100, openRatio: 0.08, batchMin: 30, batchOpenRatio: 0.3, coolDownMinutes: 10,
  maxCoolDownMinutes: 60, probeSize: 30, probeCloseRatio: 0.05 };
function policy(probe: Partial<UptimeSplitPolicy['hosts'][number]> = {}, ttlMs = 180_000): UptimeSplitPolicy {
  return { version: 1, hosts: [{ host: 'm3', instanceId: 'u2-m3', region: 'kr-home', class: 'home' },
    { host: 'oracle-osaka-smoke', instanceId: ORACLE, region: 'ap-osaka-1', class: 'probe', maxPerHour: 3_600, batch: 5, concurrency: 3, ...probe }],
  claim: { ttlMs }, confirm: { affinityDays: 7 }, breaker };
}
const control = (changes: Record<string, unknown> = {}) => ({ mode: 'claims', epoch: 7, policy: policy(), policyHash: 'h', ...changes });
const ticket = (id: number, origin = `https://p${id}.example`): UptimeClaimTicket => ({ productId: id, slug: `p${id}`, url: `${origin}/x`,
  token: randomUUID(), epoch: 1, claimedAt: new Date(), leaseUntil: new Date(), confirmClass: null });
const claimed = (claims: UptimeClaimTicket[], changes: Record<string, unknown> = {}) =>
  ({ kind: 'claimed', controlEpoch: 7, host: 'oracle-osaka-smoke', hostClass: 'probe', breaker: 'closed', claims, ...changes });
const ok = (status = 200) => ({ startedAt: new Date(Date.now() - 50), observedAt: new Date(), kind: 'http' as const, status, latencyMs: 50, elapsedMs: 50 });
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const ids = (list: { productId: number }[]) => list.map(item => item.productId).sort((a, b) => a - b);

/** 가짜 시계를 조금씩 밀며 끝날 때까지 돌린다 */
async function drive<T>(work: Promise<T>, stepMs = 100, limitMs = 60 * 60_000): Promise<T> {
  let state: { done: false } | { done: true; value?: T; error?: unknown } = { done: false };
  work.then(value => { state = { done: true, value }; }, error => { state = { done: true, error }; });
  for (let elapsed = 0; !state.done && elapsed < limitMs; elapsed += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  const settled = state as { done: boolean; value?: T; error?: unknown };
  if (!settled.done) throw new Error('not_settled');
  if (settled.error) throw settled.error;
  return settled.value as T;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  io.read.mockResolvedValue(control());
  io.submit.mockImplementation(async ({ results }) => ({ kind: 'submitted', controlEpoch: 7, accepted: ids(results), lost: [] }));
  io.release.mockImplementation(async ({ claims }) => ({ kind: 'released', released: ids(claims) }));
  io.observe.mockResolvedValue(undefined);
  io.skew.mockResolvedValue(0);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it('claims no more than the lease can start, paces starts evenly and caps concurrent checks', async () => {
  expect(uptimeConsumerInterval(1_000)).toBe(3_600);
  expect(UPTIME_CONSUMER_LEASE_MARGIN_MS).toBe(20_000);
  // 1,000/h·TTL 180초면 160초 안에 45건 시작 가능 → 정책 batch 40 / 60초 간격이면 3 / 최소 TTL 30초·간격 60초여도 1
  expect(uptimeConsumerClaimLimit(40, 180_000, 3_600)).toBe(40);
  expect(uptimeConsumerClaimLimit(40, 180_000, 60_000)).toBe(3);
  expect(uptimeConsumerClaimLimit(40, 30_000, 3_600)).toBe(3);
  expect(uptimeConsumerClaimLimit(40, 30_000, 60_000)).toBe(1);

  const tickets = [1, 2, 3, 4, 5].map(id => ticket(id));
  io.claim.mockResolvedValueOnce(claimed(tickets));
  const starts: number[] = [];
  let inFlight = 0, peak = 0;
  const check = vi.fn(async () => {
    starts.push(performance.now()); inFlight++; peak = Math.max(peak, inFlight);
    await wait(2_500); inFlight--; return ok();
  });
  const summary = await drive(runUptimeConsumer({ owner, once: true, check }));
  expect(io.claim).toHaveBeenCalledExactlyOnceWith({ owner, limit: 5 });
  // 3600/h = 1초 간격. 확인 2.5초 × 동시 3 이 간격을 따라간다
  expect(starts.slice(1).map((at, index) => Math.round(at - starts[index]))).toEqual([1_000, 1_000, 1_000, 1_000]);
  expect(peak).toBe(3);
  expect(summary).toEqual({ batches: 1, claimed: 5, checked: 5, accepted: 5, lost: 0, released: 0 });
  // 25건이 안 되면 5초 주기로 묶어 낸다 — 같은 제품을 두 번 내지 않는다
  expect(io.submit.mock.calls.flatMap(([input]) => ids(input.results))).toEqual([1, 2, 3, 4, 5]);
  expect(io.release).not.toHaveBeenCalled();
  const [result] = io.submit.mock.calls[0][0].results;
  expect(result).toMatchObject({ productId: 1, token: tickets[0].token, epoch: 1, kind: 'http', status: 200, latencyMs: 50 });
});

it('keeps one site in one lane and the pace across batches without a burst', async () => {
  io.read.mockResolvedValue(control({ policy: policy({ concurrency: 4 }) }));
  const events: string[] = [], starts: number[] = [];
  const check = vi.fn(async (item: UptimeClaimTicket) => {
    starts.push(performance.now()); events.push(`start:${item.productId}`);
    await wait(1_500); events.push(`end:${item.productId}`); return ok();
  });
  const abort = new AbortController();
  io.claim.mockImplementationOnce(async () => claimed([ticket(1, 'https://same.example'), ticket(2, 'https://same.example'), ticket(3)]))
    .mockImplementationOnce(async () => claimed([ticket(4)])).mockImplementation(async () => { abort.abort(); return claimed([]); });
  await drive(runUptimeConsumer({ owner, signal: abort.signal, check }));
  // 같은 origin 은 한 줄: 1 이 끝난 뒤 2 가 시작한다(동시 4 여도)
  expect(events.indexOf('end:1')).toBeLessThan(events.indexOf('start:2'));
  // 묶음이 바뀌어도 간격(1초)을 지킨다
  for (const [index, at] of starts.slice(1).entries()) expect(at - starts[index]).toBeGreaterThanOrEqual(1_000);
  expect(io.claim).toHaveBeenCalledTimes(3);
});

it('never starts a ticket past the lease margin and gives it back unopened', async () => {
  // 최소 TTL 30초·1초 간격 → 10초 안에만 시작한다. 확인이 6초씩 걸리고 동시 1 이면 셋째(12초)는 열지 않는다
  io.read.mockResolvedValue(control({ policy: policy({ concurrency: 1 }, 30_000) }));
  const tickets = [ticket(1), ticket(2), ticket(3)];
  io.claim.mockResolvedValueOnce(claimed(tickets));
  const check = vi.fn(async () => { await wait(6_000); return ok(); });
  const summary = await drive(runUptimeConsumer({ owner, once: true, check }));
  expect(io.claim).toHaveBeenCalledExactlyOnceWith({ owner, limit: 5 });
  expect(check).toHaveBeenCalledTimes(2);
  expect(io.submit.mock.calls.flatMap(([input]) => ids(input.results))).toEqual([1, 2]);
  expect(io.release).toHaveBeenCalledExactlyOnceWith({ owner, claims: [tickets[2]] });
  expect(summary).toMatchObject({ checked: 2, accepted: 2, released: 1 });
});

it('on abort stops new checks, submits the one in flight and releases the unstarted claims', async () => {
  const tickets = [ticket(1), ticket(2), ticket(3)], abort = new AbortController(), report = vi.fn();
  io.claim.mockResolvedValueOnce(claimed(tickets));
  const check = vi.fn(async () => { abort.abort(); await wait(700); return ok(); });
  const summary = await drive(runUptimeConsumer({ owner, signal: abort.signal, report, check }));
  expect(check).toHaveBeenCalledOnce();
  expect(io.submit).toHaveBeenCalledOnce();
  expect(ids(io.submit.mock.calls[0][0].results)).toEqual([1]);
  expect(io.release).toHaveBeenCalledExactlyOnceWith({ owner, claims: [tickets[1], tickets[2]] });
  expect(summary).toEqual({ batches: 1, claimed: 3, checked: 1, accepted: 1, lost: 0, released: 2 });
  // 제출·되돌림이 끝난 뒤 마지막 관측을 stopped 로 남긴다
  expect(io.observe.mock.calls.at(-1)).toEqual([`uptime-consumer:${ORACLE}`, expect.objectContaining({ state: 'stopped',
    bootId: owner.bootId, claimed5m: 3, checked5m: 1, accepted5m: 1, released5m: 2 })]);
  expect(io.read).toHaveBeenCalledOnce();
});

it('drops the batch when a submit reveals a new control epoch and re-reads before claiming again', async () => {
  io.read.mockResolvedValue(control({ policy: policy({ concurrency: 1 }) }));
  const tickets = [ticket(1), ticket(2), ticket(3), ticket(4)], abort = new AbortController();
  io.claim.mockResolvedValueOnce(claimed(tickets));
  // 5초 주기 제출에서 epoch 이 바뀐 것을 안다(제출은 전부 lost)
  io.submit.mockImplementationOnce(async ({ results }) => ({ kind: 'submitted', controlEpoch: 8, accepted: [], lost: ids(results) }));
  const check = vi.fn(async () => { await wait(3_000); return ok(); });
  io.read.mockResolvedValueOnce(control({ policy: policy({ concurrency: 1 }) }))
    .mockImplementation(async () => { abort.abort(); return control({ mode: 'legacy', epoch: 8, policy: null, policyHash: null }); });
  const summary = await drive(runUptimeConsumer({ owner, signal: abort.signal, check }));
  // 0초·3초에 시작 → 5초 제출이 거절되면 진행 중이던 둘째 결과(6초)는 버리고 더 열지 않는다
  expect(check).toHaveBeenCalledTimes(2);
  expect(io.submit).toHaveBeenCalledOnce();
  expect(ids(io.submit.mock.calls[0][0].results)).toEqual([1]);
  expect(io.release).toHaveBeenCalledExactlyOnceWith({ owner, claims: tickets });
  expect(summary).toMatchObject({ checked: 2, accepted: 0, lost: 1, released: 4 });
  expect(io.claim).toHaveBeenCalledOnce();
});

it('notices an epoch change from the control row while nothing is pending and discards the in-flight result', async () => {
  io.read.mockResolvedValueOnce(control()).mockResolvedValue(control({ epoch: 8 }));
  const tickets = [ticket(1), ticket(2)];
  io.claim.mockResolvedValueOnce(claimed(tickets));
  const check = vi.fn(async () => { await wait(6_000); return ok(); });
  const summary = await drive(runUptimeConsumer({ owner, once: true, check }));
  expect(io.submit).not.toHaveBeenCalled();
  expect(io.release).toHaveBeenCalledExactlyOnceWith({ owner, claims: tickets });
  expect(summary).toMatchObject({ checked: 2, accepted: 0, released: 2 });
});

it('treats a blocked submit (legacy, fenced) as lost and releases the rest', async () => {
  const tickets = [ticket(1), ticket(2)];
  io.claim.mockResolvedValueOnce(claimed(tickets));
  io.submit.mockResolvedValueOnce({ kind: 'blocked', reason: 'mode_legacy', controlEpoch: 8 });
  const summary = await drive(runUptimeConsumer({ owner, once: true, check: async () => ok() }));
  expect(summary).toMatchObject({ checked: 2, accepted: 0, lost: 2, released: 2 });
});

it('stops claiming while its breaker is open and stays alive with idle heartbeats', async () => {
  const abort = new AbortController(), report = vi.fn();
  io.claim.mockResolvedValueOnce({ kind: 'blocked', reason: 'breaker_open', controlEpoch: 7 })
    .mockImplementationOnce(async () => { abort.abort(); return { kind: 'blocked', reason: 'breaker_open', controlEpoch: 7 }; });
  const check = vi.fn();
  await drive(runUptimeConsumer({ owner, signal: abort.signal, report, check }));
  expect(check).not.toHaveBeenCalled();
  expect(io.claim).toHaveBeenCalledTimes(2);
  // 다음 claim 은 쉼(10초) 뒤다 — 감독 진행 기한 90초보다 짧다
  expect(report.mock.calls.filter(([state]) => state === 'idle').length).toBeGreaterThanOrEqual(2);
  expect(io.observe.mock.calls.at(-1)?.[1]).toMatchObject({ state: 'stopped', reason: 'breaker_open', breaker: 'open' });
});

it.each([
  ['legacy mode', control({ mode: 'legacy', policy: null, policyHash: null }), {}, 'mode_legacy'],
  ['an instance missing from the policy', control({ policy: { ...policy(), hosts: [policy().hosts[0]] } }), {}, 'source_unconfigured'],
  ['a home entry without pacing', control({ policy: { ...policy(), hosts: [policy().hosts[0],
    { host: 'm3', instanceId: ORACLE, region: 'kr-home', class: 'home' }] } }), {}, 'pacing_unconfigured'],
  ['a home entry with pacing (home results are applied by the home job, never submitted)', control({ policy: { ...policy(), hosts: [policy().hosts[0],
    { host: 'm3', instanceId: ORACLE, region: 'kr-home', class: 'home', maxPerHour: 1000, batch: 40, concurrency: 4 }] } }), {}, 'home_unsupported'],
  ['a policy that moved this instance to another host', control(), { physicalHost: 'm3' }, 'host_mismatch'],
])('does not claim under %s', async (_name, value, extra, reason) => {
  io.read.mockResolvedValue(value);
  const summary = await drive(runUptimeConsumer({ owner, once: true, ...extra }));
  expect(io.claim).not.toHaveBeenCalled();
  expect(summary.batches).toBe(0);
  expect(io.observe.mock.calls.at(-1)?.[1]).toMatchObject({ state: 'stopped', reason });
});

it('rests without claiming while this host clock is more than 20 s off the DB clock, and reports the measured skew', async () => {
  const abort = new AbortController(), report = vi.fn(), check = vi.fn();
  io.skew.mockResolvedValueOnce(-60_000).mockImplementationOnce(async () => { abort.abort(); return 25_000; });
  await drive(runUptimeConsumer({ owner, signal: abort.signal, report, check }));
  expect(io.claim).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
  expect(io.observe.mock.calls.at(-1)?.[1]).toMatchObject({ state: 'stopped', reason: 'clock_skew', clockSkewMs: 25_000 });
  // 20초 안이면 그대로 claim 한다
  io.skew.mockResolvedValue(19_000);
  io.claim.mockResolvedValueOnce(claimed([ticket(1)]));
  expect(await drive(runUptimeConsumer({ owner, once: true, check: async () => ok() }))).toMatchObject({ claimed: 1, accepted: 1 });
});

it('releases a batch claimed under a newer control epoch than the one it paced for', async () => {
  const tickets = [ticket(1)];
  io.claim.mockResolvedValueOnce(claimed(tickets, { controlEpoch: 8 }));
  const check = vi.fn();
  await drive(runUptimeConsumer({ owner, once: true, check }));
  expect(check).not.toHaveBeenCalled();
  expect(io.release).toHaveBeenCalledExactlyOnceWith({ owner, claims: tickets });
});

it('waits for the pace before claiming so a slow cap never spends the lease waiting', async () => {
  // 60/h = 1분 간격. 첫 묶음 1건 뒤 다음 claim 은 1분 뒤에야 보낸다(그동안 30초마다 idle 보고)
  io.read.mockResolvedValue(control({ policy: policy({ maxPerHour: 60 }) }));
  const abort = new AbortController(), report = vi.fn(), claims: number[] = [];
  io.claim.mockImplementation(async () => {
    claims.push(performance.now());
    if (claims.length === 2) abort.abort();
    return claimed([ticket(claims.length)]);
  });
  await drive(runUptimeConsumer({ owner, signal: abort.signal, report, check: async () => ok() }));
  expect(io.claim.mock.calls[0][0]).toEqual({ owner, limit: 3 });
  expect(claims[1] - claims[0]).toBeGreaterThanOrEqual(60_000);
});

it('checks without reading the body and maps nonstandard or missing responses to unknown', async () => {
  vi.useRealTimers();
  const cancel = vi.fn(async () => {}), getReader = vi.fn();
  io.fetch.mockResolvedValueOnce({ finalUrl: 'https://a.example/', response: { status: 403, body: { cancel, getReader } } });
  expect(await checkUptimeUrl('https://a.example/')).toMatchObject({ kind: 'http', status: 403, latencyMs: expect.any(Number) });
  expect(cancel).toHaveBeenCalledOnce(); expect(getReader).not.toHaveBeenCalled();
  expect(io.fetch).toHaveBeenCalledWith('https://a.example/', 'background');
  io.fetch.mockResolvedValueOnce({ finalUrl: 'https://b.example/', response: { status: 999, body: { cancel, getReader } } });
  expect(await checkUptimeUrl('https://b.example/')).toMatchObject({ kind: 'unknown', status: 0, latencyMs: null });
  io.fetch.mockResolvedValueOnce(null);
  const missing = await checkUptimeUrl('https://c.example/');
  expect(missing).toMatchObject({ kind: 'unknown', status: 0, latencyMs: null });
  expect(missing.observedAt.getTime()).toBeGreaterThanOrEqual(missing.startedAt.getTime());
});

const env = { UPTIME_CONSUMER_VERSION: '1', SERVICE_INSTANCE_ID: ORACLE, PHYSICAL_HOST: 'oracle-osaka-smoke', HTTP_ORIGIN_PERMITS: '0' };
it('stays off by default and refuses shared HTTP permits, host ledger enforcement and other instances before any runtime', async () => {
  vi.useRealTimers();
  expect(parseUptimeConsumerArgs(['--once'])).toEqual({ once: true });
  for (const args of [['--once', '--once'], ['--role=maintenance']]) expect(() => parseUptimeConsumerArgs(args)).toThrow();
  expect(await runUptimeConsumerProcess([], {})).toEqual({ state: 'disabled' });
  await expect(runUptimeConsumerProcess([], { ...env, UPTIME_CONSUMER_VERSION: '2' })).rejects.toThrow('invalid_uptime_consumer_version');
  await expect(runUptimeConsumerProcess([], { ...env, HTTP_ORIGIN_PERMITS: '1' })).rejects.toThrow('uptime_consumer_http_permits_unsupported');
  await expect(runUptimeConsumerProcess([], { ...env, HOST_BUDGET_ENFORCEMENT: JSON.stringify({ mode: 'enabled', pressure: {
    maxLoadPerCpu: 4, maxHostRssBytes: 1, maxEventLoopDelayMs: 1, maxHeartbeatGapMs: 30_000 } }) })).rejects.toThrow('host_budget_entry_unsupported');
  for (const id of ['oracle-uptime-1', 'uptime-consumer-', 'ai1-consumer-oracle'])
    await expect(runUptimeConsumerProcess([], { ...env, SERVICE_INSTANCE_ID: id })).rejects.toThrow('invalid_item_consumer_service_instance');
  expect(io.runtime).not.toHaveBeenCalled();
});

it('runs one maintenance-parent runtime with a fresh boot owner and the physical host', async () => {
  vi.useRealTimers();
  io.read.mockResolvedValue(control({ mode: 'legacy', policy: null, policyHash: null }));
  io.runtime.mockImplementation(async (_role, run) => run(new AbortController().signal, vi.fn()));
  const result = await runUptimeConsumerProcess(['--once'], env);
  expect(io.runtime).toHaveBeenCalledExactlyOnceWith('maintenance', expect.any(Function));
  expect(result).toEqual({ state: 'stopped', batches: 0, claimed: 0, checked: 0, accepted: 0, lost: 0, released: 0 });
  expect(io.observe).toHaveBeenLastCalledWith(`uptime-consumer:${ORACLE}`, expect.objectContaining({ state: 'stopped', reason: 'mode_legacy',
    bootId: expect.stringMatching(/^[0-9a-f-]{36}$/) }));
});
