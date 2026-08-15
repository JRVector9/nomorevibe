/**
 * 로컬에서 작업을 한 틱 돌린다.
 *   npm run job heartbeat
 *
 * 스케줄러 없이 손으로 확인하거나, 수집기처럼 오래 걸리는 작업을 개발 중에
 * 반복 실행할 때 쓴다.
 */
import { JOBS, JOB_NAMES } from "@/lib/jobs/registry";
import { runJob, getJobState } from "@/lib/jobs/runner";

async function main() {
  const name = process.argv[2];

  if (!name || !JOBS[name]) {
    console.error("사용법: npm run job <작업이름>");
    console.error(`사용 가능: ${JOB_NAMES.join(", ")}`);
    process.exit(1);
  }

  const result = await runJob(name, JOBS[name]);
  const state = await getJobState(name);

  console.log("결과:", result);
  console.log("커서:", state?.cursor ?? null);
  if (state?.lastError) console.log("마지막 실패:", state.lastError);

  process.exit(result.status === "failed" ? 1 : 0);
}

void main();
