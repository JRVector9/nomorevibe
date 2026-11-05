import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { modelCapacityRequests } from "@/lib/db/operations-schema";
import { publicationClassifyLogicalSql } from "@/lib/llm/publication-classify-capacity-sql";
import { dispatchReleaseAddedKindsSql, dispatchReleaseEvidenceKindsSql, publicationClassifyReleaseLogicalSql, releaseKindsDispatchSql } from "@/lib/llm/dispatch-release-kinds-sql";
import { textLocalDirectDispatchSql } from "@/lib/llm/gateway-local-direct-binding-sql";
import { opencodeCliLogicalSql, opencodeCliDispatchSql } from "@/lib/llm/opencode-cli-binding-sql";

/**
 * 0158(2026-10-31): 종료 근거 회수(0096)의 kind 목록에 없던 publication_classify_cli(0125)·local_model_direct(0118)를 같은 회수 길에 올린다.
 * 0155·0157 과 같은 live rebuild — 살아 있는 술어 전체를 왼쪽에 두고 상수 가지 하나를 OR 로 덧붙인다. 실제 DB 적용과 회수는
 * tests/integration/release-branch-kinds.test.ts 가 본다.
 */
const tag = "0158_release_branch_kinds";
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
const migration = readFileSync(`drizzle/${tag}.sql`, "utf8");
const blocks = migration.split("--> statement-breakpoint").filter(sql => sql.includes("DO $$")).map(sql => ({
  name: /conname='([^']+)'/.exec(sql)![1], branch: /\$ai2_local\$([\s\S]*?)\$ai2_local\$/.exec(sql)![1], sql,
}));
const targets: Record<string, string> = { model_capacity_requests_logical_check: publicationClassifyReleaseLogicalSql,
  model_capacity_requests_members_check: publicationClassifyReleaseLogicalSql, model_capacity_requests_dispatch_check: releaseKindsDispatchSql };

it("registers 0158 right after 0157 with the next when and nothing else at that index", () => {
  const index = journal.entries.findIndex(entry => entry.tag === tag);
  expect(journal.entries[index]).toMatchObject({ idx: 158, when: 1794086401069, tag, breakpoints: true, version: "7" });
  expect(journal.entries[index - 1]).toMatchObject({ idx: 157, when: 1794086401068, tag: "0157_ai1_provider_enum" });
  expect(journal.entries.filter(entry => entry.idx === 158 || entry.tag === tag)).toHaveLength(1);
  expect(migration.split("\n")[0]).toContain("0158");
});

it("rebuilds exactly the three requests CHECKs from their live predicate plus the schema constant, in the 0157 form", () => {
  expect(blocks.map(block => block.name)).toEqual(Object.keys(targets));
  for (const block of blocks) {
    expect(block.branch, `${block.name}: the appended branch is the schema constant`).toBe(targets[block.name]);
    expect(block.sql).toContain("substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate");
    expect(block.sql).toContain(`FROM pg_constraint WHERE conrelid='model_capacity_requests'::regclass AND conname='${block.name}'`);
    expect(block.sql).toContain(`ALTER TABLE model_capacity_requests DROP CONSTRAINT ${block.name};`);
    expect(block.sql).toContain(`ADD CONSTRAINT ${block.name} CHECK ((%s) OR (%s))`);
  }
  expect(migration).not.toMatch(/\b(?:CREATE|REPLACE)\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
  expect(migration).not.toMatch(/\b(?:CREATE|DROP|ALTER)\s+(?:TRIGGER|INDEX|COLUMN)\b/i);
  expect(migration).not.toMatch(/^\s*(?:UPDATE|INSERT|DELETE|TRUNCATE)\b/im);
  expect(migration).not.toMatch(/model_capacity_requests_terminal_check|model_capacity_events/);
});

it("the dispatch branch is the 0096 release branch with only the kind list replaced by the two missing kinds", () => {
  const release = readFileSync("drizzle/0096_model_capacity_dispatch_release.sql", "utf8");
  const original = /coalesce\(\(\(state='withdrawn' AND dispatch_binding IS NOT NULL AND dispatch_binding_hash IS NOT NULL AND dispatched_at IS NOT NULL\)[^\n]*?\('process_group_exit','dr_call_drain'\)\)\),false\)/
    .exec(release)![0];
  const kinds = /\(dispatch_binding->>'kind' IN (\([^)]*\))\)/.exec(original)![1];
  expect(kinds).toContain("'grok_session_cli'"); expect(kinds).not.toMatch(/publication_classify_cli|local_model_direct/);
  expect(dispatchReleaseAddedKindsSql).toBe("('publication_classify_cli','local_model_direct')");
  expect(dispatchReleaseEvidenceKindsSql).toBe("('process_group_exit','dr_call_drain')");
  expect(releaseKindsDispatchSql).toBe(original.replace(kinds, dispatchReleaseAddedKindsSql));
  // Both kinds carry version 1, logicalWorkKey and model at the binding top level, which is all the 0096 shape reads from the binding.
  for (const key of ["'version'='1'::jsonb", "->>'logicalWorkKey'=logical_work_key", "->>'model'=model"]) expect(releaseKindsDispatchSql).toContain(key);
});

it("the logical/members branch is the 0125 publication_classify identity plus withdrawn and the release evidence kinds", () => {
  const identity = publicationClassifyLogicalSql.replace(/\s+/g, " ");
  for (const clause of ["class='background' AND pool='reviewer' AND route_id='crawl-publish-classify' AND provider IN ('claude-cli','codex-cli')",
    "nmv_publication_classify_keys_valid(logical_member_keys)",
    "logical_work_key='bg:publication-classify:' || encode(sha256(convert_to(array_to_json(logical_member_keys)::text,'UTF8')),'hex')"]) {
    expect(identity).toContain(clause); expect(publicationClassifyReleaseLogicalSql).toContain(clause);
  }
  expect(publicationClassifyReleaseLogicalSql).toContain("(dispatch_binding->>'kind'='publication_classify_cli')");
  expect(publicationClassifyReleaseLogicalSql).toContain(`(state='withdrawn' AND terminal_evidence->>'kind' IN ${dispatchReleaseEvidenceKindsSql})`);
  expect(publicationClassifyReleaseLogicalSql).not.toContain("cli_model_terminal");
  expect(publicationClassifyReleaseLogicalSql.startsWith("coalesce(((") && publicationClassifyReleaseLogicalSql.endsWith("),false)")).toBe(true);
});

it("Drizzle composes the same three CHECKs as (previous) OR (branch) with the constants last (under 0161's text local-direct tail on the dispatch CHECK)", () => {
  const checks = getTableConfig(modelCapacityRequests).checks;
  for (const [name, branch] of Object.entries(targets)) {
    let expression = new PgDialect().sqlToQuery(checks.find(check => check.name === name)!.value).sql;
    const opencode = name === "model_capacity_requests_dispatch_check" ? opencodeCliDispatchSql
      : name === "model_capacity_requests_logical_check" ? opencodeCliLogicalSql : null;
    if (opencode) {
      const tail = `) OR (${opencode})`;
      expect(expression.startsWith("(") && expression.endsWith(tail), `${name}: 0163 additive tail present`).toBe(true);
      expression = expression.slice(1, -tail.length);
    }
    if (name === "model_capacity_requests_dispatch_check") {
      // 0161 stores the text local-direct branch as the next rules ordinal. The TypeScript check() still ends with (0158 predicate) OR (text branches): strip that wrap first.
      const textTail = `) OR (${textLocalDirectDispatchSql})`;
      expect(expression.startsWith("(") && expression.endsWith(textTail), `${name}: 0161 tail present`).toBe(true);
      expression = expression.slice(1, -textTail.length);
    }
    const suffix = `) OR (${branch})`;
    expect(expression.startsWith("(") && expression.endsWith(suffix), `${name}: composed last`).toBe(true);
    expect(expression.slice(1, -suffix.length), `${name}: the predecessor still contains 0157's local-direct branch`).toContain("'local-direct'");
  }
  expect(new PgDialect().sqlToQuery(checks.find(check => check.name === "model_capacity_requests_terminal_check")!.value).sql).not.toContain(dispatchReleaseAddedKindsSql);
});
