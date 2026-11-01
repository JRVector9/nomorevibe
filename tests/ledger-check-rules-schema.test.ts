import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { modelCapacityCheckRules, modelCapacityEvents, modelCapacityRequests } from "@/lib/db/operations-schema";
import { LEDGER_RULE_CHECKS } from "./integration/ledger-check-defs";

/**
 * 0160(2026-11-01): live rebuild 로 자란 장부 CHECK 여섯 개를 글자 그대로 model_capacity_check_rules 행 + BEFORE 트리거로 옮긴다.
 * 실제 DB 적용·판정 동일성·속도는 tests/integration/ledger-check-rules.test.ts 가 본다. 여기서는 journal·파일 모양·Drizzle 표 선언만 본다.
 */
const tag = "0160_ledger_check_rules";
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
const migration = readFileSync(`drizzle/${tag}.sql`, "utf8");
const statements = migration.split("--> statement-breakpoint");
const moved = [...LEDGER_RULE_CHECKS.model_capacity_requests, ...LEDGER_RULE_CHECKS.model_capacity_events];

it("registers 0160 immediately before 0161 and right after 0158, with a strictly increasing when", () => {
  const index = journal.entries.findIndex(entry => entry.tag === tag);
  expect(journal.entries[index]).toMatchObject({ idx: 160, when: 1794086401071, tag, breakpoints: true, version: "7" });
  expect(journal.entries[index - 1]).toMatchObject({ idx: 158, when: 1794086401069, tag: "0158_release_branch_kinds" });
  expect(journal.entries[index + 1]).toMatchObject({ idx: 161, when: 1794086401072, tag: "0161_text_local_direct_binding", breakpoints: true, version: "7" });
  expect(journal.entries.at(-1)?.tag).toBe("0161_text_local_direct_binding");
  expect(journal.entries.filter(entry => entry.idx === 159)).toEqual([]);
  for (let i = 1; i < journal.entries.length; i++) expect(journal.entries[i].when, `when strictly increases at ${journal.entries[i].tag}`).toBeGreaterThan(journal.entries[i - 1].when);
  expect(migration.split("\n")[0]).toContain("0160");
  // 0160 이 쓰일 때 이 브랜치는 아직 0159 로 예약돼 있었다. 그 문장은 0160 파일에 남고, 실제 가지는 0161 이다.
  expect(migration).toContain("0159 는 아직 병합되지 않은 PR #772");
});

it("creates the rules table, the rebuild function, one trigger per table, moves exactly the six composed CHECKs and touches no ledger row", () => {
  expect(statements.some(sql => /CREATE TABLE model_capacity_check_rules \(/.test(sql))).toBe(true);
  expect(statements.some(sql => /CREATE FUNCTION nmv_model_capacity_check_guard_rebuild\(tbl text\) RETURNS void LANGUAGE plpgsql/.test(sql))).toBe(true);
  const move = statements.find(sql => sql.includes("DO $$") && sql.includes("pg_get_expr(conbin, conrelid)"))!;
  for (const name of moved) expect(move, `${name}: moved`).toContain(`'${name}'`);
  expect(move).toContain("INSERT INTO model_capacity_check_rules(table_name, constraint_name, ordinal, predicate, source) VALUES (tbl, n, 1, expression, '0160_ledger_check_rules')");
  expect(move).toContain("PERFORM nmv_model_capacity_check_guard_rebuild(tbl)");
  expect(move).toContain("CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION %I()");
  expect(move).toContain("tbl || '_zz_check_guard'");
  expect(move).toContain("ALTER TABLE %I DROP CONSTRAINT %I");
  expect(move).toContain("IF moved <> 6 THEN RAISE EXCEPTION");
  // The rebuild keeps CHECK semantics: alphabetical constraint order, OR over ordinals with short-circuit on TRUE, RAISE only on FALSE, 23514 with the original names.
  const rebuild = statements.find(sql => sql.includes("CREATE FUNCTION nmv_model_capacity_check_guard_rebuild"))!;
  expect(rebuild).toContain("ORDER BY constraint_name, ordinal");
  expect(rebuild).toContain("IF ok IS NOT TRUE THEN SELECT (%s) INTO leaf FROM (SELECT (NEW).*) AS %I; ok := ok OR leaf; END IF;");
  expect(rebuild).toContain("IF ok IS FALSE THEN RAISE EXCEPTION USING ERRCODE = ''23514'', CONSTRAINT = %L, TABLE = %L, SCHEMA = ''public'', MESSAGE = %L");
  expect(rebuild).toContain("SET plan_cache_mode = force_generic_plan");
  const code = migration.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n"); // 주석(되돌리기 안내)은 빼고 문장만
  expect(code).not.toMatch(/^\s*(?:UPDATE|DELETE|TRUNCATE)\b/im);
  expect(code).not.toMatch(/INSERT INTO model_capacity_(?:requests|events)\b/);
  expect(code).not.toMatch(/ADD CONSTRAINT/);
});

it("Drizzle declares the rules table as the migration creates it and still carries the six predicates as the TypeScript source of truth", () => {
  const config = getTableConfig(modelCapacityCheckRules);
  expect(config.name).toBe("model_capacity_check_rules");
  expect(config.columns.map(column => column.name)).toEqual(["table_name", "constraint_name", "ordinal", "predicate", "source", "created_at"]);
  expect(config.primaryKeys.map(key => key.getName())).toEqual(["model_capacity_check_rules_pk"]);
  expect(config.checks.map(check => check.name).sort()).toEqual(["model_capacity_check_rules_ordinal_check", "model_capacity_check_rules_predicate_check",
    "model_capacity_check_rules_source_check", "model_capacity_check_rules_table_check"]);
  const create = statements.find(sql => sql.includes("CREATE TABLE model_capacity_check_rules"))!;
  for (const name of [...config.checks.map(check => check.name), "model_capacity_check_rules_pk"]) expect(create).toContain(`CONSTRAINT ${name}`);
  const requests = getTableConfig(modelCapacityRequests).checks.map(check => check.name), events = getTableConfig(modelCapacityEvents).checks.map(check => check.name);
  for (const name of LEDGER_RULE_CHECKS.model_capacity_requests) expect(requests).toContain(name);
  for (const name of LEDGER_RULE_CHECKS.model_capacity_events) expect(events).toContain(name);
});
