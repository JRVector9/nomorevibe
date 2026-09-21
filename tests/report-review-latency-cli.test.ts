import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("runs the documented offline report command in this package's module format", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmv-latency-cli-"));
  try {
    const file = join(directory, "fixture.jsonl");
    writeFileSync(file, [
      JSON.stringify({ event: "review.pipeline", version: 1, stage: "first", kind: "model_start", callId: "one" }),
      JSON.stringify({ event: "review.pipeline", version: 1, stage: "first", kind: "model_end", callId: "one", durationMs: 10000, ok: true }),
      "invalid", JSON.stringify({ event: "unrelated" }),
    ].join("\n"));
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/report-review-latency.ts", file], {
      encoding: "utf8", timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.first).toMatchObject({ calls: 1, modelMs: { p50: 10000 } });
    expect(report.second.modelMs.p50).toBeNull();
    expect(report.invalidLines).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
