import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { modelCapacityRequests, modelCapacityEvents } from "@/lib/db/operations-schema";

it("0118은 Drizzle의 네 CHECK와 같고 기존 분기에 새로운 direct 분기만 덧붙인다", () => {
  const migration = readFileSync("drizzle/0118_local_model_capacity_terminal.sql", "utf8");
  const checks = [
    ...getTableConfig(modelCapacityRequests).checks.filter(check => /_(logical|dispatch|terminal)_check$/.test(check.name)),
    ...getTableConfig(modelCapacityEvents).checks.filter(check => check.name === "model_capacity_events_terminal_check"),
  ];
  expect(checks).toHaveLength(4);
  for (const check of checks) {
    const expression = new PgDialect().sqlToQuery(check.value).sql;
    expect(migration).toContain(`ADD CONSTRAINT "${check.name}" CHECK (${expression});`);
    expect(expression).toMatch(/local_model|local-direct/);
    expect(expression).toMatch(/cli|abcllm/);
  }
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  expect(journal.entries.at(-1)).toMatchObject({ idx: 118, tag: "0118_local_model_capacity_terminal" });
});
