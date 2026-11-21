/** Read-only JSON status for an external worker monitor. */
import { readWorkerProgress, workerProgressReadFailure } from "../lib/operations/worker-progress-query";

async function main() {
  try {
    const report = await readWorkerProgress();
    console.log(JSON.stringify(report));
    process.exitCode = report.overall === "alarm" ? 2 : report.overall === "unknown" ? 1 : 0;
  } catch (error) {
    // 원인은 조각 이름과 SQLSTATE·오류 이름만(2026-11-21). 판정은 그대로 unknown 이다
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), overall: "unknown", readFailures: [workerProgressReadFailure(error)] }));
    process.exitCode = 1;
  } finally {
    const client = (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient;
    await client?.end({ timeout: 5 }).catch(() => {});
  }
}

void main();
