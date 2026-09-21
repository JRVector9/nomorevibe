import { spawnSync } from "node:child_process";
import { assertLocalTestDatabase } from "./test-database";

if (process.argv.length !== 3 || process.argv[2] !== "--mode=fixtures") throw new Error("Usage: tsx scripts/verify-review-pipeline-speed.ts --mode=fixtures");
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("explicit_TEST_DATABASE_URL_required");
assertLocalTestDatabase(testUrl);
const suites = [
  ["tests/review-pipeline-equivalence.test.ts", "tests/installable-projects.test.ts", "tests/agent-review-job.test.ts", "tests/text-worker-isolation.test.ts"],
  ["--config", "vitest.integration.config.ts", "tests/integration/review-handoffs.test.ts", "tests/integration/review-draining.test.ts", "tests/integration/text-result-fencing.test.ts", "tests/integration/review-publication-gate.test.ts", "tests/integration/publication-change.test.ts", "tests/integration/second-review.test.ts"],
];
for (const suite of suites) {
  const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...suite], {
    stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl, TEST_DATABASE_URL: testUrl },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(JSON.stringify({ mode: "fixtures", baseline: "af50608", passed: true, productionSpeedup: null }));
