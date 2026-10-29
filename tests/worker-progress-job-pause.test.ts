import { expect, it } from 'vitest';
import { buildWorkerProgress } from '@/lib/operations/worker-progress-query';
import { TEXT_PROGRESS_STAGE_JOBS, type ProgressStageInput } from '@/lib/operations/worker-progress';

// 배포 관문(monitor_gate)은 check-worker-progress 의 overall 만 본다. 관리자 job-pause(controlAdminJob)는
// jobs.not_before 를 지금+100년으로 미룬다 — 그 행 모양 그대로 넣어 정체 경보가 'paused' 로 바뀌는지 고정한다.
const now = new Date('2026-10-29T06:00:00Z');
const adminPaused = new Date(now.getTime() + 100 * 365 * 24 * 60 * 60_000);
const observations = ['scheduler', 'crawler', 'reviewer', 'publisher', 'maintenance', 'text'].map(role => ({
  key: `service:${role}:fixture`, value: { status: 'running' }, observedAt: now,
}));
const keys = Object.keys(TEXT_PROGRESS_STAGE_JOBS) as Array<keyof typeof TEXT_PROGRESS_STAGE_JOBS>;
// 운영 모양: 대기 있음·최근 5분 완료 0·오래된 실패 기록, 잡에는 마지막 오류가 남아 있다
const stalled = (key: ProgressStageInput['key']): ProgressStageInput => ({ key, enabled: true, waiting: 40, oldestMinutes: 900,
  completed5m: 0, progress5m: 0, errors5m: 0, deferred: 3, providerErrors: 5, providerErrorMinutes: 900 });
const job = (name: string, notBefore: Date | null) => ({ name, notBefore, nextScheduledAt: new Date(now.getTime() + 30_000),
  lastError: 'model_capacity_deferred' });
const report = (paused: readonly string[]) => buildWorkerProgress({ measuredAt: now.toISOString(), stages: [] },
  keys.map(key => job(TEXT_PROGRESS_STAGE_JOBS[key], paused.includes(TEXT_PROGRESS_STAGE_JOBS[key]) ? adminPaused : null)),
  observations, now, { mode: 'legacy', writerContractVersion: 0 }, keys.map(stalled), null, [], 'open');

it('alarms on every stalled text stage before any job is paused', () => {
  const result = report([]);
  expect(result.overall).toBe('alarm');
  for (const stage of result.stages) expect(stage).toMatchObject({ alarm: true, restartEligible: false });
});

it.each(keys)('treats an administrator-paused %s job as paused, not stalled', key => {
  const result = report([TEXT_PROGRESS_STAGE_JOBS[key]]);
  expect(result.stages.find(stage => stage.stage === key)).toMatchObject({
    job: TEXT_PROGRESS_STAGE_JOBS[key], reason: 'paused', alarm: false, restartEligible: false, waiting: 40, completed5m: 0,
  });
  // 멈추지 않은 다른 단계의 정체 경보는 그대로 남는다
  expect(result.stages.filter(stage => stage.stage !== key).every(stage => stage.alarm)).toBe(true);
  expect(result.overall).toBe('alarm');
});

it('passes the progress gate only when every stalled stage is paused', () => {
  const result = report(keys.map(key => TEXT_PROGRESS_STAGE_JOBS[key]));
  expect(result.stages.every(stage => stage.reason === 'paused' && !stage.alarm)).toBe(true);
  expect(result.overall).toBe('ok');
});

it('does not treat a short retry delay as a pause', () => {
  const retry = new Date(now.getTime() + 10 * 60_000);
  const result = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [] },
    [job('product-translate', retry)], observations, now, { mode: 'legacy', writerContractVersion: 0 },
    [stalled('product-translate')], null, [], 'open');
  expect(result.stages[0]).toMatchObject({ reason: 'upstream_stalled', alarm: true });
});
