/** Read-only JSON status for an external worker monitor. */
import { readWorkerProgress } from "../lib/operations/worker-progress-query";

async function main() {
  try {
    const report = await readWorkerProgress();
    console.log(JSON.stringify(report));
    process.exitCode = report.overall === "alarm" ? 2 : report.overall === "unknown" ? 1 : 0;
  } catch {
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), overall: "unknown" }));
    process.exitCode = 1;
  } finally {
    const client = (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient;
    await client?.end({ timeout: 5 }).catch(() => {});
  }
}

void main();
