import { publicationApiLogicalSql, publicationApiDispatchSql, publicationApiEventSql } from "@/lib/llm/publication-classify-api-sql";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { aiConnections, modelCapacityEvents, modelCapacityRequests } from "@/lib/db/operations-schema";
import { opencodeCliLogicalSql, opencodeCliDispatchSql, opencodeCliEventTerminalSql } from "@/lib/llm/opencode-cli-binding-sql";
import { cliExecutorEvidenceShape } from "@/lib/llm/cli-executor-boundary-contract";
import { cliExecutorIndeterminateEvidenceShape } from "@/lib/llm/cli-executor-indeterminate-boundary-contract";
import { cliExecutorRemovedEvidenceShape } from "@/lib/llm/cli-executor-removed-boundary-contract";
import { cliExecutorIndeterminateRemovedEvidenceShape } from "@/lib/llm/cli-executor-indeterminate-removed-boundary-contract";
import { z } from "zod";

const tag = "0163_opencode_review_cli", migration = readFileSync(`drizzle/${tag}.sql`, "utf8");
const targets = [
  ["model_capacity_requests", "model_capacity_requests_logical_check", opencodeCliLogicalSql],
  ["model_capacity_requests", "model_capacity_requests_dispatch_check", opencodeCliDispatchSql],
  ["model_capacity_events", "model_capacity_events_terminal_check", opencodeCliEventTerminalSql],
] as const;

it("appends the next monotonic migration and only three new guarded ledger branches", () => {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
  const index = journal.entries.findIndex(entry => entry.tag === tag), entry = journal.entries[index];
  expect(entry).toMatchObject({ idx: 163, when: 1794086401074, tag });
  expect(journal.entries[index - 1]).toMatchObject({ idx: 162, tag: "0162_ai_task_model_ranks" });
  expect(entry.when).toBeGreaterThan(journal.entries[index - 1].when);
  const added = [...migration.matchAll(/SELECT '(model_capacity_requests|model_capacity_events)', '([^']+)', COALESCE\(MAX\(ordinal\), 0\) \+ 1, \$branch\$([\s\S]*?)\$branch\$/g)];
  expect(added.map(match => match.slice(1))).toEqual(targets.map(row => [...row]));
  expect(migration.match(/COUNT\(\*\) FILTER \(WHERE source = '0163_opencode_review_cli'\) = 0/g)).toHaveLength(3);
  expect(migration).toContain("SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests')");
  expect(migration).toContain("SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_events')");
  const code = migration.split("\n").filter(line => !line.startsWith("--")).join("\n");
  expect(code).not.toMatch(/(?:UPDATE|DELETE|TRUNCATE)\s|INSERT INTO model_capacity_(?:requests|events)\b|CREATE (?:TABLE|INDEX|TRIGGER|FUNCTION)|GRANT /);
  expect(code).not.toMatch(/ALTER TABLE model_capacity_(?:requests|events)/);
});

it.each(targets)("%s / %s keeps the complete predecessor and appends the exact OpenCode branch", (table, name, branch) => {
  const checks = getTableConfig(table === "model_capacity_requests" ? modelCapacityRequests : modelCapacityEvents).checks;
  const expression = new PgDialect().sqlToQuery(checks.find(check => check.name === name)!.value).sql;
  const publication = name === "model_capacity_requests_logical_check" ? publicationApiLogicalSql
    : name === "model_capacity_requests_dispatch_check" ? publicationApiDispatchSql : publicationApiEventSql;
  const tail = `) OR (${publication})`;
  expect(expression.startsWith("(") && expression.endsWith(tail), `${name}: 0166 additive tail present`).toBe(true);
  const predecessor = expression.slice(1, -tail.length);
  expect(predecessor.endsWith(`) OR (${branch})`)).toBe(true);
  expect(branch).toContain("'opencode-cli'");
  expect(branch.includes("crawl-agent-review")).toBe(true);
  expect(branch.includes("second-review")).toBe(true);
  if (name !== "model_capacity_requests_logical_check") {
    for (const kind of ["ai1_legacy_cli", "ai1_item_cli", "ai2_item_cli"]) expect(branch).toContain(`'${kind}'`);
    for (const guard of ["argvHash", "envPolicyHash", "cliContractHash", "totalTokenBound", "chargedTokens", "requestedVersion", "sourceRevisionHash", "stageEpoch", "itemEpoch"]) expect(branch).toContain(guard);
  }
});

it("widens only the connection tool list and preserves CLI-only null/model guards", () => {
  const check = getTableConfig(aiConnections).checks.find(check => check.name === "ai_connections_cli_check")!;
  const sql = new PgDialect().sqlToQuery(check.value).sql;
  expect(sql).toContain("IN ('claude','codex','grok','opencode')");
  for (const key of ["base_url", "api_key_ciphertext", "models", "models_read_at", "models_error"]) expect(sql).toContain(`"ai_connections"."${key}" IS NULL`);
  expect(sql).toContain('cardinality("ai_connections"."cli_models") BETWEEN 1 AND CASE WHEN "ai_connections"."cli_tool" = \'opencode\' THEN 512 ELSE 32 END');
  expect(migration).toContain('cardinality(cli_models) BETWEEN 1 AND 32');
  expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
});

it("keeps classification-only physical recovery SQL shapes and migration bytes unchanged", () => {
  const cases = [
    ["0134_cli_executor_boundary_exit", "cli-executor-boundary-sql", cliExecutorEvidenceShape, "10e81479e0db9fe62f4143dd071a922fb2d18c8c8e114e26decb62f1a174a4ae"],
    ["0135_cli_executor_removed_boundary_exit", "cli-executor-removed-boundary-sql", cliExecutorRemovedEvidenceShape, "ec14294629630cb22292d07ff1d6473d328e21dc861daa4c0d0f039d0d9dd731"],
    ["0136_cli_executor_indeterminate_boundary_exit", "cli-executor-indeterminate-boundary-sql", cliExecutorIndeterminateEvidenceShape, "ed81165ef2d7f9289e0fe61d570f002598f0ffdafc070648712fda40f258e90c"],
    ["0137_cli_executor_indeterminate_removed_boundary_exit", "cli-executor-indeterminate-removed-boundary-sql", cliExecutorIndeterminateRemovedEvidenceShape, null],
  ] as const;
  for (const [file, template, shape, hash] of cases) {
    const original = readFileSync(`drizzle/${file}.sql`, "utf8");
    expect(original).toBe(readFileSync(`scripts/ops/${template}.template.sql`, "utf8").replace("__EVIDENCE_SHAPE__", JSON.stringify(z.toJSONSchema(shape))));
    if (hash) expect(createHash("sha256").update(original).digest("hex")).toBe(hash);
  }
});
