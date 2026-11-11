import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as committed from "@/lib/llm/opencode-task-binding-sql";
import { applied0168Rules, generateOpencodeTaskFiles, generateOpencodeTaskRules, OPENCODE_TASK_FIX_FROM, OPENCODE_TASK_FIX_TO,
  OPENCODE_TASK_TARGETS, opencodeTwin } from "@/scripts/ops/generate-opencode-task-sql";

/**
 * 0168 의 생성기는 OpenCode 소개·감사 가지를 만들며 SQL 글자 'claude-cli' 만 바꿨다 — 같은 가지의 JSON 글자 '"claude-cli"'::jsonb 는 남아 OpenCode 가지가
 * 성립할 수 없었다(2026-11-09 부터 운영의 OpenCode 감사 dispatch 가 모두 23514). 이 시험은 어떤 따옴표 꼴이든 OpenCode 가지에 claude-cli 가 남으면 실패한다.
 */
const read = (file: string) => readFileSync(file, "utf8");

it("rewrites every quoting of the provider token and fails closed on anything it cannot rewrite", () => {
  const branch = [
    "provider='claude-cli'", "(dispatch_binding)->'provider'='\"claude-cli\"'::jsonb", "evidence @> '{\"provider\":\"claude-cli\"}'::jsonb",
    "provider = ANY(ARRAY['claude-cli','grok-cli'])", "(transport->>'provider') IN ('claude-cli','grok-cli','codex-cli')",
  ].join(" AND ");
  const twin = opencodeTwin(branch);
  expect(twin).not.toContain("claude-cli");
  expect(twin).toBe(branch.replaceAll("claude-cli", "opencode-cli"));
  // the 0168 rewrite ('claude-cli' only) is exactly what this guards against
  expect(branch.replaceAll("'claude-cli'", "'opencode-cli'")).toContain(OPENCODE_TASK_FIX_FROM.slice(0, -"::jsonb".length));
  // a longer or differently spelled token is not silently kept
  expect(() => opencodeTwin("provider='claude-cli-beta'")).toThrow("opencode_twin_claude_literal_left");
  expect(() => opencodeTwin("model='xclaude-cli'")).toThrow("opencode_twin_claude_literal_left");
  expect(opencodeTwin("provider='grok-cli'")).toBe("provider='grok-cli'");
});

it("generates OpenCode twins with no claude-cli literal from a synthetic baseline holding the JSON-quoted provider", () => {
  const check = (name: string, body: string) => `ALTER TABLE x ADD CONSTRAINT ${name} CHECK (${body});`;
  const claude = (kind: string, route: string) =>
    `(provider='claude-cli' AND kind='${kind}' AND route_id='${route}' AND (dispatch_binding)->'provider'='"claude-cli"'::jsonb)`;
  const twoBranches = `${claude("product_audit_cli", "product-audit")} OR ${claude("intro_check_cli", "product-intro-check")} OR (provider='grok-cli')`;
  const baseline = OPENCODE_TASK_TARGETS.map(target =>
    check(target.name, target.expected === 2 ? twoBranches : `${claude("product_audit_cli", "product-audit")} OR (provider='grok-cli')`))
    .join("\n--> statement-breakpoint\n");
  for (const rule of generateOpencodeTaskRules(baseline)) {
    expect(rule.sql, rule.name).not.toContain("claude-cli");
    expect(rule.sql, rule.name).toContain(OPENCODE_TASK_FIX_TO);
  }
});

it("the committed constants are the generator output and no OpenCode branch keeps a claude-cli literal", () => {
  const files = generateOpencodeTaskFiles(read);
  expect(read("lib/llm/opencode-task-binding-sql.ts")).toBe(files.bindingModule);
  expect(files.rules.map(rule => [rule.symbol, rule.sql])).toEqual(Object.entries(committed).sort(([a], [b]) =>
    OPENCODE_TASK_TARGETS.findIndex(target => target.symbol === a) - OPENCODE_TASK_TARGETS.findIndex(target => target.symbol === b)));
  for (const [symbol, sql] of Object.entries(committed)) {
    expect(sql, symbol).not.toMatch(/claude-cli/);
    expect(sql.startsWith("coalesce((provider='opencode-cli'") || sql.startsWith("coalesce((evidence->'dispatch'->'binding'->>'provider'='opencode-cli'"), symbol).toBe(true);
  }
  // the binding-provider JSON comparison names opencode-cli in both product_audit_cli and intro_check_cli twins
  for (const sql of [committed.opencodeTaskDispatchSql, committed.opencodeTaskEventTerminalSql]) expect(sql.split(OPENCODE_TASK_FIX_TO)).toHaveLength(3);
});

it("0168 stays applied history: its file still holds the defective twins that 0175 repairs, and only those two", () => {
  const applied = applied0168Rules(read("drizzle/0168_opencode_task_cli.sql"));
  expect(Object.keys(applied).sort()).toEqual(OPENCODE_TASK_TARGETS.map(target => target.name).sort());
  expect(applied.model_capacity_requests_logical_check).toBe(committed.opencodeTaskLogicalSql);
  expect(applied.model_capacity_requests_members_check).toBe(committed.opencodeTaskMembersSql);
  for (const [name, fixed] of [["model_capacity_requests_dispatch_check", committed.opencodeTaskDispatchSql],
    ["model_capacity_events_terminal_check", committed.opencodeTaskEventTerminalSql]] as const) {
    expect(applied[name].split(OPENCODE_TASK_FIX_FROM), name).toHaveLength(3);
    expect(applied[name].replaceAll(OPENCODE_TASK_FIX_FROM, OPENCODE_TASK_FIX_TO), name).toBe(fixed);
  }
});
