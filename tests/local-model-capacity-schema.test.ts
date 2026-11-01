import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { modelCapacityRequests, modelCapacityEvents } from "@/lib/db/operations-schema";
import { operatorReviewEventSql } from "@/lib/llm/operator-review-sql";
import { gatewayLocalDirectMembersSql } from "@/lib/llm/gateway-local-direct-sql";
import { publicationClassifyReleaseLogicalSql } from "@/lib/llm/dispatch-release-kinds-sql";

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
  const history: { idx: number; tag: string; expression: string }[] = [];
  for (const migration of migrations) for (const statement of migration.statements) {
    const match = pattern.exec(statement);
    if (match) history.push({ idx: migration.idx, tag: migration.tag, expression: match[1] });
    // 0126 preserves pg_get_constraintdef's entire predecessor with a format template.
    // Read the affected names and actual template; do not treat the dynamic migration as an absent replacement.
    const names = /FOREACH n IN ARRAY ARRAY\[([^\]]+)\] LOOP/.exec(statement)?.[1];
    const template = /EXECUTE format\('ALTER TABLE model_capacity_requests ADD CONSTRAINT %I CHECK \(([\s\S]*?)\)',n,old_predicate\);/.exec(statement)?.[1];
    if (names?.split(",").map(value => value.trim().replaceAll("'", "")).includes(name) && template) {
      expect(statement).toContain("substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate");
      const previous = history.at(-1);
      expect(previous, `${name}: dynamic predecessor`).toBeDefined();
      expect(template.match(/%s/g)).toHaveLength(1);
      // A callback preserves SQL regex endings such as $' literally in the replacement.
      history.push({ idx: migration.idx, tag: migration.tag, expression: template.replace("%s", () => previous!.expression) });
    }
    const eventSuffix = /EXECUTE 'ALTER TABLE model_capacity_events ADD CONSTRAINT model_capacity_events_kind_check CHECK \(\('\s*\|\|\s*old_predicate\s*\|\|\s*'([\s\S]*?)';/.exec(statement)?.[1];
    if (name === "model_capacity_events_kind_check" && eventSuffix) {
      expect(statement).toContain("substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate");
      const previous = history.at(-1);
      expect(previous, `${name}: dynamic predecessor`).toBeDefined();
      history.push({ idx: migration.idx, tag: migration.tag,
        expression: `(${previous!.expression}${eventSuffix.slice(0, -1).replaceAll("''", "'")}` });
    }
    const ai2Name = /conname='([^']+)'/.exec(statement)?.[1];
    const ai2Branch = /\$ai2_local\$([\s\S]*?)\$ai2_local\$/.exec(statement)?.[1];
    if (ai2Name === name && ai2Branch) {
      const previous = history.at(-1);
      expect(previous, `${name}: AI2 direct predecessor`).toBeDefined();
      expect(statement).toContain("substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate");
      expect(statement).toContain(`ADD CONSTRAINT ${name} CHECK ((%s) OR (%s))`);
      history.push({ idx: migration.idx, tag: migration.tag,
        expression: `(${previous!.expression}) OR (${ai2Branch})` });
    }
    // 0161 stores only the new branch as the next rules ordinal. The TypeScript check() still composes (previous) OR (branch).
    const rule = /SELECT '(?:model_capacity_requests|model_capacity_events)', '([^']+)', COALESCE\(MAX\(ordinal\), 0\) \+ 1, \$branch\$([\s\S]*?)\$branch\$/.exec(statement);
    if (rule && rule[1] === name) {
      const previous = history.at(-1);
      expect(previous, `${name}: rules predecessor`).toBeDefined();
      expect(statement).toContain("INSERT INTO model_capacity_check_rules");
      expect(statement).toContain("COUNT(*) FILTER (WHERE source = '0161_text_local_direct_binding') = 0");
      history.push({ idx: migration.idx, tag: migration.tag, expression: `(${previous!.expression}) OR (${rule[2]})` });
    }
  }
  return history;
}

it("현재 Drizzle의 네 CHECK는 각각 마지막으로 교체한 journal migration과 같다", () => {
  expect(checks).toHaveLength(4);
  for (const check of checks) {
    const history = checkHistory(check.name);
    const latest = history.at(-1);
    const legacy = history.filter(entry => entry.idx < 118).at(-1);
    expect(latest, check.name).toBeDefined();
    expect(legacy, `${check.name}: legacy constraint`).toBeDefined();
    const expression = new PgDialect().sqlToQuery(check.value).sql;
    expect(latest!.expression === expression, `${check.name}: ${latest!.tag}`).toBe(true);
    expect(expression.includes(legacy!.expression), `${check.name}: legacy CLI/gateway branches preserved`).toBe(true);
    expect(expression).toMatch(/local_model|local-direct/);
    expect(expression).toMatch(/cli|abcllm/);
  }
});

it("event kind CHECK는 0126·0127·0134·0135 전체를 보존하고 0136 indeterminate CLI 회수 … 0151 operator_review 까지 한 가지씩만 추가한다", () => {
  const name = "model_capacity_events_kind_check", history = checkHistory(name);
  const previous = history.find(entry => entry.idx === 126)!, waiting = history.find(entry => entry.idx === 127)!, cli = history.find(entry => entry.idx === 134)!, removed = history.find(entry => entry.idx === 135)!, unknown = history.find(entry => entry.idx === 136)!, latest = history.at(-1)!;
  const check = getTableConfig(modelCapacityEvents).checks.find(check => check.name === name)!;
  const expression = new PgDialect().sqlToQuery(check.value).sql;
  expect(latest.tag).toBe("0151_indeterminate_no_hold");
  expect(expression).toBe(latest.expression);
  expect(waiting.expression).toBe(`(${previous.expression}) OR coalesce(kind='wait_cancelled' AND from_state='waiting' AND to_state='withdrawn' AND reason IS NULL AND evidence IS NULL,false)`);
  expect(cli.expression).toBe(`(${waiting.expression}) OR coalesce(kind='dispatch_released' AND from_state='dispatched' AND to_state='withdrawn' AND reason IS NULL AND nmv_cli_executor_release_valid(evidence) AND evidence->>'requestId'=request_id::text AND evidence->'plan'->'request'->'epoch'=to_jsonb(epoch) AND evidence->'plan'->'request'->'revision'=to_jsonb(revision) AND evidence->'plan'->'request'->>'policyHash'=policy_hash,false)`);
  expect(removed.expression).toBe(`(${cli.expression}) OR nmv_cli_executor_removed_event_valid(to_jsonb(model_capacity_events))`);
  expect(unknown.expression).toBe(`(${removed.expression}) OR nmv_cli_executor_indeterminate_event_valid(to_jsonb(model_capacity_events))`);
  const removedUnknown = history.find(entry => entry.idx === 137)!;
  expect(removedUnknown.expression).toBe(`(${unknown.expression}) OR nmv_cli_executor_indeterminate_removed_event_valid(to_jsonb(model_capacity_events))`);
  const replaced = history.find(entry => entry.idx === 143)!;
  expect(replaced.expression).toBe(`(${removedUnknown.expression}) OR nmv_replaced_provider_event_valid(to_jsonb(model_capacity_events))`);
  const replacedPath = history.find(entry => entry.idx === 145)!;
  expect(replacedPath.expression).toBe(`(${replaced.expression}) OR nmv_replaced_path_event_valid(to_jsonb(model_capacity_events))`);
  expect(expression).toBe(`(${replacedPath.expression}) OR (${operatorReviewEventSql})`);
  expect(previous.expression).toContain("nmv_provider_boundary_release_valid(evidence)");
});

it("member CHECK는 0125·0126·0134·0135 전체와 0136의 exact predecessor 확장, 0157 의 text local-direct 분기, 0158 의 publication_classify 회수 분기를 모두 보존한다", () => {
  const check = getTableConfig(modelCapacityRequests).checks.find(check => check.name === "model_capacity_requests_members_check")!;
  const history = checkHistory(check.name);
  const latest = history.at(-1)!;
  const publication = history.find(entry => entry.idx === 125)!;
  const provider = history.find(entry => entry.idx === 126)!;
  const cli = history.find(entry => entry.idx === 134)!;
  const removed = history.find(entry => entry.idx === 135)!;
  const unknown = history.find(entry => entry.idx === 136)!;
  const previous = history.filter(entry => entry.idx < 125).at(-1)!;
  const expression = new PgDialect().sqlToQuery(check.value).sql;
  expect(latest.tag).toBe("0158_release_branch_kinds");
  expect(expression === latest.expression, check.name).toBe(true);
  expect(publication.expression.startsWith(`(${previous.expression}) OR coalesce((`)).toBe(true);
  expect(provider.expression).toBe(`(${publication.expression}) OR nmv_provider_boundary_request_valid(to_jsonb(model_capacity_requests))`);
  expect(cli.expression).toBe(`(${provider.expression}) OR nmv_cli_executor_request_valid(to_jsonb(model_capacity_requests))`);
  expect(removed.expression).toBe(`(${cli.expression}) OR nmv_cli_executor_removed_request_valid(to_jsonb(model_capacity_requests))`);
  expect(unknown.expression).toBe(`(${removed.expression}) OR nmv_cli_executor_indeterminate_request_valid(to_jsonb(model_capacity_requests))`);
  const removedUnknown = history.find(entry => entry.idx === 137)!;
  expect(removedUnknown.expression).toBe(`(${unknown.expression}) OR nmv_cli_executor_indeterminate_removed_request_valid(to_jsonb(model_capacity_requests))`);
  const replaced = history.find(entry => entry.idx === 143)!;
  expect(replaced.expression).toBe(`(${removedUnknown.expression}) OR nmv_replaced_provider_request_valid(to_jsonb(model_capacity_requests))`);
  const replacedPath = history.find(entry => entry.idx === 145)!;
  expect(replacedPath.expression).toBe(`(${replaced.expression}) OR nmv_replaced_path_request_valid(to_jsonb(model_capacity_requests))`);
  // 0157 (PR 3b-C): the six text-route member branches again with provider local-direct, appended to the whole predecessor.
  const localDirect = history.find(entry => entry.idx === 157)!;
  expect(localDirect.expression).toBe(`(${replacedPath.expression}) OR (${gatewayLocalDirectMembersSql})`);
  // 0158: the publication_classify withdrawn branch (process_group_exit·dr_call_drain release) appended to the whole 0157 predecessor.
  expect(expression).toBe(`(${localDirect.expression}) OR (${publicationClassifyReleaseLogicalSql})`);
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
