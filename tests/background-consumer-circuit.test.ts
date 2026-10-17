import { expect, it } from 'vitest';
import { createProviderCircuits, observeProviderTransport } from '@/lib/llm/provider-circuit-breaker';
import { runWorker, type BackgroundConsumerLanes } from '@/scripts/worker';

/*
 * PR06e 배경 consumer 줄의 provider 회로 — 틱 안 gateway 전송 결과(실제 경로: agent-review-gateway 의 nativeFetch)가 그 줄의 회로에
 * 쌓이고, 열린 동안은 틱(=job claim)을 시작하지 않으며 host 장부도 묻지 않는다. 회로가 없으면 기존 줄 그대로다(tests/background-consumer.test.ts).
 */
const transport = (status: number) => observeProviderTransport(Promise.resolve({ status }), undefined);

it('holds a background lane while its circuit is open, without a tick, host admission or re-request, then closes on a passing trial', async () => {
  const clock = { now: 0 }, events: string[] = [], logs: unknown[] = [];
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 2, openMs: 30_000 }, { now: () => clock.now, log: event => events.push(event) });
  const statuses = [[503], [200, 429], [502], [200]];
  const consumer: BackgroundConsumerLanes = { names: ['product-tagline-ko'], open: async () => true, circuits,
    run: async name => {
      events.push(`run:${name}`);
      for (const status of statuses.shift() ?? []) await transport(status);
      return { status: 'completed', done: true };
    }, request: async name => { events.push(`request:${name}`); } };
  const tick = () => runWorker({ role: 'text', once: true }, { names: ['product-tagline-ko'], seen: async () => {}, pending: async () => ['product-tagline-ko'],
    run: async () => ({ status: 'completed' }), consumer, log: (event, fields) => { logs.push({ event, ...fields }); },
    admit: async name => { events.push(`admit:${name}`); return { admitted: true, release: async () => {} }; } });
  // 503 하나, 그다음 틱은 200 뒤 429 — 마지막 판정은 429 지만 200 이 연속을 끊었으므로 아직 닫힘(실패 1)
  await tick(); await tick();
  expect(events.filter(event => event.startsWith('provider_circuit'))).toEqual([]);
  await tick();
  expect(events.filter(event => event.startsWith('provider_circuit'))).toEqual(['provider_circuit.opened']);
  events.length = 0; logs.length = 0;
  await tick();
  expect(events).toEqual([]);
  expect(logs).toEqual([{ event: 'worker.job', role: 'text', name: 'product-tagline-ko', status: 'deferred', reason: 'provider_circuit_open', consumer: true }]);
  clock.now = 30_000;
  await tick();
  expect(events).toEqual(['provider_circuit.half_open', 'admit:product-tagline-ko', 'run:product-tagline-ko', 'provider_circuit.closed']);
});

it('releases a half-open trial when the host ledger defers the tick, so the next tick can try again', async () => {
  const clock = { now: 0 }, events: string[] = [];
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 1, openMs: 30_000 }, { now: () => clock.now, log: event => events.push(event) });
  let hostOpen = true;
  const consumer: BackgroundConsumerLanes = { names: ['crawl-tagline'], open: async () => true, circuits,
    run: async () => { events.push('run'); await transport(hostOpen ? 504 : 200); return { status: 'completed', done: true }; }, request: async () => {} };
  const tick = () => runWorker({ role: 'text', once: true }, { names: ['crawl-tagline'], seen: async () => {}, pending: async () => ['crawl-tagline'],
    run: async () => ({ status: 'completed' }), consumer,
    admit: async () => hostOpen ? { admitted: true, release: async () => {} } : { admitted: false, reason: 'host_pressure_cpu' } });
  await tick();
  clock.now = 30_000; hostOpen = false;
  await tick();
  expect(events).toEqual(['run', 'provider_circuit.opened', 'provider_circuit.half_open']);
  await tick();
  expect(events.slice(3)).toEqual([]);
  hostOpen = true;
  // 호스트가 미룬 시험은 판정 없이 풀렸으므로 다음 틱이 다시 시험이다. 504 면 다시 연다
  await tick();
  expect(events.slice(3)).toEqual(['run', 'provider_circuit.reopened']);
});
