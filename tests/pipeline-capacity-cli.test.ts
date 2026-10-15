import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { expect, it } from "vitest";
import { formatCapacityCliError } from "@/lib/operations/pipeline-capacity-cli";

const canary = "private_capacity_canary_https://fixture.invalid/credential";
const localUrl = "postgres://fixture:fixture@127.0.0.1:55452/nomorevibe_test";
it("sanitizes schema details without echoing a valid JSON unknown-key canary", () => {
  const parsed = z.object({}).strict().safeParse({ [canary]: true });
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("expected_schema_error");
  expect(formatCapacityCliError(parsed.error)).toBe("invalid_capacity_artifact");
});

it.each([
  "invalid_artifact_json", "artifact_size_limit", "explicit_TEST_DATABASE_URL_required",
  "local_test_database_required", "database_override_rejected", "database_url_mismatch",
  "replica_database_rejected", "planned_token_budget_exceeded", "real_model_replay_unimplemented",
  "invalid_window", "snapshot_candidate_missing",
])("preserves the exact fixed diagnostic %s", code => {
  expect(formatCapacityCliError(new Error(code))).toBe(code);
});

it("never passes through unknown error details, causes or non-Error values", () => {
  const filesystem = Object.assign(new Error(`EACCES ${canary}`), { code: "EACCES", path: canary });
  const database = Object.assign(new Error(`Failed query: select ${canary}`), { name: "PostgresError", code: "28P01" });
  const wrapped = new Error("database_url_mismatch: " + canary, { cause: database });
  for (const value of [filesystem, database, wrapped, new Error(canary), new Error(" invalid_window"),
    new Error("invalid_window\n"), { message: "invalid_window" }, "invalid_window", null, undefined]) {
    expect(formatCapacityCliError(value)).toBe("capacity_operation_failed");
  }
});

function runCli(script: string, content: string, explicitDatabase = true) {
  const directory = mkdtempSync(join(tmpdir(), "nomorevibe-capacity-errors-"));
  try {
    const input = join(directory, "input.json");
    writeFileSync(input, content, { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(PG|DATABASE_URL$|READ_DATABASE_URL$|TEST_DATABASE_URL$|NODE_OPTIONS$)/.test(key)));
    const args = script === "measure-pipeline-capacity.ts" ? ["report", input] : [input, join(directory, "out.json")];
    return spawnSync(process.execPath, ["--import", "tsx", `scripts/${script}`, ...args], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
      env: { ...env, NODE_ENV: "test", ...(explicitDatabase ? { TEST_DATABASE_URL: localUrl } : {}) },
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

it.each(["measure-pipeline-capacity.ts", "export-pipeline-capacity.ts"])(
  "%s sanitizes a valid JSON schema error before any DB import", script => {
    const child = runCli(script, JSON.stringify({ [canary]: true }));
    expect(child.status).toBe(1);
    expect(child.stderr.trim()).toBe("invalid_capacity_artifact");
    expect(child.stdout).toBe("");
    expect(child.stderr).not.toContain(canary);
  });

it.each(["measure-pipeline-capacity.ts", "export-pipeline-capacity.ts"])(
  "%s preserves only the fixed malformed JSON code", script => {
    const child = runCli(script, canary);
    expect(child.status).toBe(1);
    expect(child.stderr.trim()).toBe("invalid_artifact_json");
    expect(child.stdout).toBe("");
  });

it("export keeps the explicit test database guard before parsing or importing DB", () => {
  const child = runCli("export-pipeline-capacity.ts", canary, false);
  expect(child.status).toBe(1);
  expect(child.stderr.trim()).toBe("explicit_TEST_DATABASE_URL_required");
  expect(child.stdout).toBe("");
});
