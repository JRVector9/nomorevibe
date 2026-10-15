import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const hash = "a".repeat(64);
const at = (ms: number) => new Date(Date.UTC(2026, 9, 15) + ms).toISOString();
const identity = (model: string) => ({ provider: "abcllm", model, canonicalModel: model });
const template = {
  manifest: { version: 1, runId: "export-guard", revision: "8020dca", mode: "fixtures", cacheMode: "cold",
    referenceTime: at(0), startedAt: at(0), endedAt: at(1_800_000), inputPolicyHash: hash,
    fullReviewPolicyHash: hash, comparisonPolicyHash: hash, initialStateHash: hash,
    models: { first: identity("first"), second: [identity("second")], fallbacks: [] },
    inputs: [{ candidateId: 1, inputHash: hash, sourceRevisionHash: hash, readyAt: at(0), stratum: "new", reReview: false }],
    limits: { maxCalls: 100, maxTokens: 1_000_000, maxDurationMs: 1_800_000, concurrency: 4, perCallTokenUpperBound: 10_000 } },
  source: { kind: "fixture", scope: "as_of_snapshot_only", runId: "export-guard", exportedAt: at(1_800_000), fullReviewPolicyHash: hash },
  generations: [], readiness: [], calls: [], quality: null,
};
it.each([
  [{ TEST_DATABASE_URL: "postgres://test:test@service/nomorevibe_test" }, "local_test_database_required"],
  [{ TEST_DATABASE_URL: "postgres://test:test@localhost:55452/nomorevibe_test", PGHOST: "service" }, "database_override_rejected"],
  [{ TEST_DATABASE_URL: "postgres://test:test@localhost:55452/nomorevibe_test", DATABASE_URL: "postgres://test:test@service/production" }, "database_url_mismatch"],
  [{ TEST_DATABASE_URL: "postgres://test:test@localhost:55452/nomorevibe_test", READ_DATABASE_URL: "postgres://test:test@service/production" }, "replica_database_rejected"],
])("rejects unsafe export configuration before any DB import: %j", (overrides, expected) => {
  const directory = mkdtempSync(join(tmpdir(), "nomorevibe-capacity-export-"));
  try {
    const input = join(directory, "template.json"), output = join(directory, "out.json");
    writeFileSync(input, JSON.stringify(template));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL$|READ_DATABASE_URL$|TEST_DATABASE_URL$)/.test(key)));
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/export-pipeline-capacity.ts", input, output], {
      cwd: process.cwd(), encoding: "utf8", env: { ...env, NODE_ENV: "test", ...overrides }, timeout: 10_000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr.trim()).toBe(expected);
    expect(child.stdout).toBe("");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it("does not echo malformed artifact contents in export errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "nomorevibe-capacity-export-json-"));
  try {
    const input = join(directory, "template.json");
    writeFileSync(input, "private_fixture_canary");
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/export-pipeline-capacity.ts", input, join(directory, "out.json")], {
      encoding: "utf8", env: { ...process.env, TEST_DATABASE_URL: "postgres://test:test@127.0.0.1:55452/nomorevibe_test" }, timeout: 10_000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr.trim()).toBe("invalid_artifact_json");
    expect(child.stdout).toBe("");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
