import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { modelCapacityRequests, modelCapacityEvents } from "@/lib/db/operations-schema";

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: { idx: number; tag: string }[];
};
const migrations = journal.entries.map(entry => ({
  ...entry,
  statements: readFileSync(`drizzle/${entry.tag}.sql`, "utf8").split("--> statement-breakpoint"),
}));
const checks = [
  ...getTableConfig(modelCapacityRequests).checks.filter(check => /_(logical|dispatch|terminal)_check$/.test(check.name)),
  ...getTableConfig(modelCapacityEvents).checks.filter(check => check.name === "model_capacity_events_terminal_check"),
];

function checkHistory(name: string) {
  // Each additive migration replaces these CHECKs. Compare the final schema with the
  // last replacement for that constraint, even when the latest migration changes other tables.
  const pattern = new RegExp(`ADD CONSTRAINT\\s+"?${name}"?\\s+CHECK\\s*\\(([\\s\\S]*)\\);\\s*$`);
  return migrations.flatMap(migration => migration.statements.flatMap(statement => {
    const match = pattern.exec(statement);
    return match ? [{ idx: migration.idx, tag: migration.tag, expression: match[1] }] : [];
  }));
}

it("현재 Drizzle의 네 CHECK는 각각 마지막으로 교체한 journal migration과 같다", () => {
  expect(checks).toHaveLength(4);
  for (const check of checks) {
    const latest = checkHistory(check.name).at(-1);
    expect(latest, check.name).toBeDefined();
    const expression = new PgDialect().sqlToQuery(check.value).sql;
    expect(latest!.expression === expression, `${check.name}: ${latest!.tag}`).toBe(true);
    expect(expression).toMatch(/local_model|local-direct/);
    expect(expression).toMatch(/cli|abcllm/);
  }
});

it("0118은 기존 네 CHECK 분기를 보존하고 typed direct 분기를 덧붙인다", () => {
  expect(journal.entries.filter(entry => entry.idx === 118))
    .toEqual([expect.objectContaining({ tag: "0118_local_model_capacity_terminal" })]);
  for (const check of checks) {
    const history = checkHistory(check.name);
    const previous = history.filter(entry => entry.idx < 118).at(-1);
    const direct = history.find(entry => entry.idx === 118);
    expect(previous, `${check.name}: prior constraint`).toBeDefined();
    expect(direct, `${check.name}: 0118 constraint`).toBeDefined();
    expect(direct!.expression.includes(previous!.expression), `${check.name}: prior branches preserved`).toBe(true);
    expect(direct!.expression).toMatch(/local_model|local-direct/);
    expect(direct!.expression.length).toBeGreaterThan(previous!.expression.length);
  }
});
