/**
 * 로컬에서 작업을 한 틱 돌린다.
 *   npm run job heartbeat
 *
 * 스케줄러 없이 손으로 확인하거나, 수집기처럼 오래 걸리는 작업을 개발 중에
 * 반복 실행할 때 쓴다.
 */
import { basename } from 'node:path';
import { withRuntimeProcess } from './worker';

async function main() {
  await withRuntimeProcess('manual', async (signal, report) => {
    const { JOB_NAMES, isJobName } = await import('@/lib/jobs/catalog');
    const name = process.argv[2];
    if (!name || !isJobName(name) || process.argv.length !== 3) {
      console.error("사용법: npm run job <작업이름>");
      console.error(`사용 가능: ${JOB_NAMES.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const [{ JOBS }, { runJob, getJobState }, { requestJob }] = await Promise.all([
      import('@/lib/jobs/registry'), import('@/lib/jobs/runner'), import('@/lib/jobs/control'),
    ]);
    if (signal.aborted) return;
    report('running', name);
    await requestJob(name);
    if (signal.aborted) return;
    const result = await runJob(name, JOBS[name], { requestedOnly: true, signal });
    const state = await getJobState(name);
    report('idle');
    console.log("결과:", result);
    console.log("커서:", state?.cursor ?? null);
    if (state?.lastError) console.log("마지막 실패:", state.lastError);
    if (result.status === "failed") process.exitCode = 1;
  });
}

if (process.argv[1] && /^run-job\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void main().catch(() => {
    console.error('job failed; check database/environment configuration');
    process.exitCode = 1;
  });
}
