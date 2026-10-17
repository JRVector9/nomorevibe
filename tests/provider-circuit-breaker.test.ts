import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { SECOND_REVIEW_TRANSIENT_ERRORS } from '@/lib/crawl/second-review';
import { createProviderCircuits, observeProviderTransport, providerCircuitConfig, providerOutcome,
  withProviderOutcome } from '@/lib/llm/provider-circuit-breaker';

/*
 * PR06e provider circuit breaker 의 순수 경계 — 설정(기본 비활성·기본값 없음), 기술 장애만 세는 분류, 열림·half-open·닫힘,
 * 열린 동안 admission 0, 구조화 로그, 범위 밖 전송은 같은 Promise. DB·모델은 쓰지 않는다(실제 claim 은 integration).
 */
const enabled = { mode: 'enabled' as const, failures: 2, openMs: 1_000 };
function circuits(config = enabled) {
  const clock = { now: 0 }, logs: Record<string, unknown>[] = [];
  return { clock, logs, value: createProviderCircuits(config, { now: () => clock.now, log: (event, fields) => logs.push({ event, ...fields }) }) };
}

it('is disabled by default and has no thresholds unless every value is given explicitly', () => {
  expect(providerCircuitConfig({})).toEqual({ mode: 'disabled' });
  expect(providerCircuitConfig({ PROVIDER_CIRCUIT_BREAKER: '{"mode":"disabled"}' })).toEqual({ mode: 'disabled' });
  expect(providerCircuitConfig({ PROVIDER_CIRCUIT_BREAKER: JSON.stringify(enabled) })).toEqual(enabled);
  for (const raw of ['', 'null', '{"mode":"enabled"}', JSON.stringify({ mode: 'enabled', failures: 2 }), JSON.stringify({ ...enabled, failures: 0 }),
    JSON.stringify({ ...enabled, openMs: 999 }), JSON.stringify({ ...enabled, failures: 1.5 }), JSON.stringify({ ...enabled, extra: 1 }),
    JSON.stringify({ ...enabled, pad: 'x'.repeat(5_000) })]) {
    expect(() => providerCircuitConfig({ PROVIDER_CIRCUIT_BREAKER: raw }), raw.slice(0, 40)).toThrow('provider_circuit_breaker_invalid');
  }
  expect(() => createProviderCircuits({ ...enabled, failures: 0 })).toThrow();
});

it('counts only the existing provider-side technical codes, never judgment, input or cancellation results', () => {
  for (const error of [...SECOND_REVIEW_TRANSIENT_ERRORS, 'not_configured', 'auth', 'missing_cli', 'model_unavailable',
    'no_key', 'rate_limit', 'network', 'http_500', 'http_502', 'http_503', 'http_504']) expect(providerOutcome({ ok: false, error }), error).toBe('down');
  for (const error of ['invalid_output', 'input_too_large', 'output_too_large', 'max_turns', 'cancelled', 'cli_error', 'http_400',
    'http_409', 'http_5', 'http_5000', 'rejected:language', 'stale_source', undefined]) expect(providerOutcome({ ok: false, error }), String(error)).toBe('none');
  expect(providerOutcome({ ok: true })).toBe('up');
});

it('opens after consecutive technical failures, holds every admission while open, then admits exactly one half-open trial', () => {
  const { clock, logs, value } = circuits();
  const first = value.admit('ai1');
  if (!first.admitted) throw new Error('closed_must_admit');
  first.record({ ok: false, error: 'timeout' }); first.done();
  // 판정 오류는 연속 수를 늘리지도 끊지도 않는다
  const judged = value.admit('ai1');
  if (!judged.admitted) throw new Error('closed_must_admit');
  judged.record({ ok: false, error: 'invalid_output' }); judged.done();
  expect(logs).toEqual([]);
  const second = value.admit('ai1');
  if (!second.admitted) throw new Error('closed_must_admit');
  second.record({ ok: false, error: 'gateway_error' }); second.done();
  expect(logs).toEqual([{ event: 'provider_circuit.opened', key: 'ai1', failures: 2, error: 'gateway_error', openMs: 1_000 }]);
  clock.now = 999;
  expect(value.admit('ai1')).toEqual({ admitted: false, reason: 'provider_circuit_open' });
  // 다른 key 는 따로 센다(AI2 provider 마다)
  expect(value.admit('ai2:grok-cli')).toMatchObject({ admitted: true });
  clock.now = 1_000;
  const trial = value.admit('ai1');
  expect(trial).toMatchObject({ admitted: true });
  expect(value.admit('ai1')).toEqual({ admitted: false, reason: 'provider_circuit_open' });
  if (!trial.admitted) throw new Error('trial_must_admit');
  trial.record({ ok: true }); trial.done();
  expect(logs.slice(1)).toEqual([{ event: 'provider_circuit.half_open', key: 'ai1' }, { event: 'provider_circuit.closed', key: 'ai1' }]);
  expect(value.admit('ai1')).toMatchObject({ admitted: true });
});

it('frees an inconclusive trial for the next item without closing or reopening', () => {
  const { clock, logs, value } = circuits({ ...enabled, failures: 1 });
  const fail = (key: string, error: string) => { const held = value.admit(key); if (!held.admitted) throw new Error('must_admit'); held.record({ ok: false, error }); held.done(); };
  fail('ai1', 'rate_limited');
  clock.now = 1_000;
  const skipped = value.admit('ai1');
  if (!skipped.admitted) throw new Error('trial_must_admit');
  skipped.record({ ok: false, error: 'cancelled' }); skipped.done();
  expect(value.admit('ai1')).toMatchObject({ admitted: true });
  // 위 시험이 판정 없이 끝났으니 다음 항목이 시험이다 — 실패하면 다시 연다
  const again = value.admit('ai1');
  expect(again).toEqual({ admitted: false, reason: 'provider_circuit_open' });
  expect(logs.map(row => row.event)).toEqual(['provider_circuit.opened', 'provider_circuit.half_open']);
});

it('reopens from a failing trial and ignores late results from units admitted before it opened', () => {
  const { clock, logs, value } = circuits({ ...enabled, failures: 1 });
  const early = value.admit('text');
  const opener = value.admit('text');
  if (!early.admitted || !opener.admitted) throw new Error('must_admit');
  opener.record({ ok: false, error: 'network' }); opener.done();
  early.record({ ok: true }); early.done();
  expect(value.admit('text')).toEqual({ admitted: false, reason: 'provider_circuit_open' });
  clock.now = 1_000;
  const trial = value.admit('text');
  if (!trial.admitted) throw new Error('trial_must_admit');
  trial.record({ ok: false, error: 'http_503' }); trial.record({ ok: true }); trial.done();
  expect(value.admit('text')).toEqual({ admitted: false, reason: 'provider_circuit_open' });
  expect(logs).toEqual([{ event: 'provider_circuit.opened', key: 'text', failures: 1, error: 'network', openMs: 1_000 },
    { event: 'provider_circuit.half_open', key: 'text' }, { event: 'provider_circuit.reopened', key: 'text', error: 'http_503', openMs: 1_000 }]);
});

it('reports gateway transport outcomes only inside an outcome scope and returns the same promise outside it', async () => {
  const statuses = [200, 503, 429, 404, 400];
  const server = createServer((_request, response) => { response.statusCode = statuses.shift() ?? 200; response.end('{}'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    const outside = fetch(url);
    expect(observeProviderTransport(outside, undefined)).toBe(outside);
    await (await outside).text();
    const seen: unknown[] = [];
    await withProviderOutcome(result => seen.push(result), async () => {
      for (let index = 0; index < 4; index++) await (await observeProviderTransport(fetch(url), undefined)).text();
      await expect(observeProviderTransport(fetch('http://127.0.0.1:9/'), undefined)).rejects.toThrow();
      const cancelled = AbortSignal.abort();
      await expect(observeProviderTransport(fetch(url, { signal: cancelled }), cancelled)).rejects.toThrow();
      const deadline = AbortSignal.timeout(1);
      await new Promise(resolve => setTimeout(resolve, 20));
      await expect(observeProviderTransport(fetch(url, { signal: deadline }), deadline)).rejects.toThrow();
    });
    expect(seen).toEqual([{ ok: false, error: 'http_503' }, { ok: false, error: 'rate_limit' }, { ok: false, error: 'model_unavailable' },
      { ok: false, error: 'http_400' }, { ok: false, error: 'network' }, { ok: false, error: 'cancelled' }, { ok: false, error: 'timeout' }]);
  } finally { await new Promise(done => server.close(done)); }
});
