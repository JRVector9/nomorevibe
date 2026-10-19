import { expect, it } from 'vitest';
import type { ThroughputSnapshot } from '@/lib/operations/throughput-model';
import { buildWorkerProgress } from '@/lib/operations/worker-progress-query';

// 리뷰 P3(agent-scan 10): items 에서 consumer 가 모두 공급자 대기(rate_limited·인증 대기)로 쉬면 legacy 의 잡 커서 retryAfter 처럼 backoff 다.
// 마지막 대상이 스캔 행 없는 저장소면 claim 행에 실패 코드가 남지 않아(공급자 대기는 실패로 세지 않는다) 5분 뒤 no_progress 경보가 났다.
const now = new Date('2026-10-19T06:00:00Z');
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1_000);
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
const running = (key: string, at = ago(5)) => ({ key, value: { status: 'running' }, observedAt: at });
const consumer = (instance: string, pausedUntil: string | null, at = ago(20)) => ({ key: `agent-scan:${instance}`, value: { instanceId: instance, pausedUntil }, observedAt: at });
const roles = ['scheduler', 'crawler', 'reviewer', 'publisher', 'maintenance', 'text'].map(role => running(`service:${role}:m3-${role}`));
const stage = { key: 'agent-evidence' as const, enabled: true, waiting: 3, oldestMinutes: 12, completed5m: 0, progress5m: 0, errors5m: 0, deferred: 0,
  providerErrors: 0, providerErrorMinutes: null };
function agentStage(observations: { key: string; value: Record<string, unknown>; observedAt: Date }[], mode: 'items' | 'legacy' = 'items') {
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [] } as unknown as ThroughputSnapshot,
    [{ name: 'agent-evidence-refresh', nextScheduledAt: null, notBefore: null }], [...roles, ...observations], now,
    { mode: 'legacy', writerContractVersion: 0 }, [stage], { mode, drainingFrom: null });
  return report.stages.find(row => row.stage === 'agent-evidence')!;
}

it('treats every live consumer waiting on the provider as backoff instead of a stalled stage', () => {
  const alive = [running('service:crawler:agent-scan-consumer-m3'), running('service:crawler:agent-scan-consumer-oracle')];
  expect(agentStage(alive)).toMatchObject({ reason: 'no_progress', alarm: true, restartEligible: false });
  // 고치기 전: 두 consumer 가 모두 한도 대기여도 no_progress 경보였다
  expect(agentStage([...alive, consumer('agent-scan-consumer-m3', later(10)), consumer('agent-scan-consumer-oracle', later(4))]))
    .toMatchObject({ reason: 'backoff', alarm: false, restartEligible: false });
  // 한 consumer 라도 일할 수 있으면(대기 아님) 진행이 없는 것은 그대로 경보다
  expect(agentStage([...alive, consumer('agent-scan-consumer-m3', later(10)), consumer('agent-scan-consumer-oracle', null)])).toMatchObject({ reason: 'no_progress' });
  // 2분 넘게 갱신되지 않은 대기 관측(멈춘 consumer)은 근거가 아니다. 지난 재개 시각도 아니다
  expect(agentStage([...alive, consumer('agent-scan-consumer-m3', later(10), ago(180))])).toMatchObject({ reason: 'no_progress' });
  expect(agentStage([...alive, consumer('agent-scan-consumer-m3', ago(1).toISOString())])).toMatchObject({ reason: 'no_progress' });
  // legacy 는 잡 커서의 retryAfter 를 쓴다 — consumer 관측을 보지 않는다
  expect(agentStage([consumer('agent-scan-consumer-m3', later(10))], 'legacy')).toMatchObject({ reason: 'no_progress', restartEligible: true });
});
