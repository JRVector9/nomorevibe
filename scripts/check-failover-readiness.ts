/** One-shot read-only status for operators and an external monitor. */
import { readMonitorStatus, exitCodeFor } from '../lib/operations/failover-monitor';

async function main() {
  try {
    const report = await readMonitorStatus();
    console.log(JSON.stringify(report));
    process.exitCode = exitCodeFor(report.overall);
  } catch {
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), overall: 'unknown' }));
    process.exitCode = 1;
  } finally {
    const client = (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient;
    await client?.end({ timeout: 5 }).catch(() => {});
  }
}

void main();
