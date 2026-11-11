/**
 * OpenCode intro/audit task twins (0168) and their provider-literal repair (0175), generated from the last complete authored CLI predicates (0125).
 * Keep the old predicates byte-for-byte; only the provider literals change inside the added branch.
 *
 * 0168 copied the product_audit_cli / intro_check_cli branches and rewrote only the SQL text literal 'claude-cli'. The same branches also compare the
 * binding's JSON provider ((dispatch_binding)->'provider'='"claude-cli"'::jsonb), which stayed claude-cli, so the OpenCode twin required the provider to
 * be opencode-cli and claude-cli at once: no OpenCode audit or intro call could ever be dispatched (production 2026-11-09..11, 23514 at dispatch).
 * Every quoting of the provider token is now rewritten, and generation fails if any claude-cli literal is left in a twin.
 *
 * drizzle/0168_opencode_task_cli.sql is applied history and stays byte-for-byte as it is (its defective predicates are read here, never written).
 * This script writes lib/llm/opencode-task-binding-sql.ts (the corrected predicates — what the database holds after 0175) and
 * drizzle/0175_opencode_task_provider_literal.sql, which replaces the two defective 0168 rule rows in place (same ordinal) with exactly those predicates.
 * Run with `node --import tsx scripts/ops/generate-opencode-task-sql.ts`; no database or environment reads.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const OPENCODE_TASK_TAG = "0168_opencode_task_cli";
export const OPENCODE_TASK_FIX_TAG = "0175_opencode_task_provider_literal";
/** The only provider literal 0168 left behind: the JSON-quoted string compared with a jsonb provider field. */
export const OPENCODE_TASK_FIX_FROM = `'"claude-cli"'::jsonb`;
export const OPENCODE_TASK_FIX_TO = `'"opencode-cli"'::jsonb`;

/** Split outer ORs only, preserving SQL quoted strings, nested CASE expressions and coalesce validators. */
export function outerSqlBranches(value: string): string[] {
  const text = value.trim(), outside: number[] = [];
  let depth = 0, quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      if (quoted && text[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (text[i] === "(") depth++;
    if (text[i] === ")") depth--;
    if (depth === 0) outside.push(i);
  }
  if (depth !== 0 || quoted) throw new Error("unbalanced_cli_predicate");
  if (text.startsWith("(") && text.endsWith(")") && outside.every(i => i === text.length - 1)) return outerSqlBranches(text.slice(1, -1));
  const splits = outside.filter(i => text.slice(i, i + 4) === " OR ");
  if (!splits.length) return [text];
  const parts: string[] = [];
  let start = 0;
  for (const split of splits) { parts.push(...outerSqlBranches(text.slice(start, split))); start = split + 4; }
  return [...parts, ...outerSqlBranches(text.slice(start))];
}

/** Any spelling of the provider token — 'claude-cli', '"claude-cli"'::jsonb, a JSON object literal, an ARRAY[...] member — without touching longer names. */
const CLAUDE_PROVIDER = /(?<![A-Za-z0-9_-])claude-cli(?![A-Za-z0-9_-])/g;
/** The OpenCode twin of a Claude CLI branch: every provider literal, however quoted, names opencode-cli; nothing claude-cli is left. */
export function opencodeTwin(branch: string): string {
  const twin = branch.replace(CLAUDE_PROVIDER, "opencode-cli");
  if (twin.includes("claude-cli")) throw new Error("opencode_twin_claude_literal_left");
  return twin;
}

export const OPENCODE_TASK_TARGETS = [
  { table: "model_capacity_requests", name: "model_capacity_requests_logical_check", symbol: "opencodeTaskLogicalSql", expected: 2,
    guard: "provider='opencode-cli' AND class='background' AND pool='reviewer' AND route_id IN ('product-audit','product-intro-check')" },
  { table: "model_capacity_requests", name: "model_capacity_requests_members_check", symbol: "opencodeTaskMembersSql", expected: 2,
    guard: "provider='opencode-cli' AND class='background' AND pool='reviewer' AND route_id='product-intro-check'" },
  { table: "model_capacity_requests", name: "model_capacity_requests_dispatch_check", symbol: "opencodeTaskDispatchSql", expected: 1,
    guard: "provider='opencode-cli' AND dispatch_binding->>'kind' IN ('intro_check_cli','product_audit_cli')" },
  { table: "model_capacity_events", name: "model_capacity_events_terminal_check", symbol: "opencodeTaskEventTerminalSql", expected: 1,
    guard: "evidence->'dispatch'->'binding'->>'provider'='opencode-cli' AND evidence->'dispatch'->'binding'->>'kind' IN ('intro_check_cli','product_audit_cli')" },
] as const;
export type OpencodeTaskRule = (typeof OPENCODE_TASK_TARGETS)[number] & { sql: string };

/** The four corrected twins from the 0125 baseline text. Pure: tests call it with the real or a synthetic baseline. */
export function generateOpencodeTaskRules(baseline: string): OpencodeTaskRule[] {
  return OPENCODE_TASK_TARGETS.map(target => {
    const statement = baseline.split("--> statement-breakpoint").find(sql => sql.includes(`ADD CONSTRAINT ${target.name} CHECK`));
    const predicate = statement && /CHECK \(([\s\S]*)\);\s*$/.exec(statement)?.[1];
    if (!predicate) throw new Error(`missing_cli_baseline:${target.name}`);
    const branches = outerSqlBranches(predicate).filter(branch => branch.includes("'claude-cli'") && (branch.includes("intro_check_cli") || branch.includes("product-intro-check") || branch.includes("product_audit_cli") || branch.includes("product-audit")));
    if (branches.length !== target.expected) throw new Error(`unexpected_cli_branch_count:${target.name}`);
    const added = branches.map(opencodeTwin);
    const sql = `coalesce((${target.guard}) AND (${added.map(branch => `(${branch})`).join(" OR ")}),false)`;
    if (sql.includes("claude-cli")) throw new Error(`opencode_twin_claude_literal_left:${target.name}`);
    if (sql.includes("$branch$") || sql.includes("$guard$") || sql.includes("$from$") || sql.includes("$to$")) throw new Error("cli_predicate_tag_collision");
    return { ...target, sql };
  });
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The predicates 0168 actually appended (applied history), read from its migration file by constraint name. */
export function applied0168Rules(migration: string): Record<string, string> {
  const rules: Record<string, string> = {};
  for (const match of migration.matchAll(/SELECT '(?:model_capacity_requests|model_capacity_events)', '([^']+)', COALESCE\(MAX\(ordinal\), 0\) \+ 1, \$branch\$([\s\S]*?)\$branch\$, '0168_opencode_task_cli'/g))
    rules[match[1]] = match[2];
  return rules;
}

/**
 * 0175 rows: each corrected twin compared with what 0168 applied. Only rows whose provider literal was left behind change, and the corrected text must be
 * exactly the applied text with the JSON provider literal replaced — the SQL replace() in 0175 then yields these predicates byte for byte.
 */
export function opencodeTaskFixRows(rules: readonly OpencodeTaskRule[], applied: Record<string, string>) {
  return rules.flatMap(rule => {
    const old = applied[rule.name];
    if (old === undefined) throw new Error(`missing_0168_rule:${rule.name}`);
    if (old === rule.sql) return [];
    if (old.replaceAll(OPENCODE_TASK_FIX_FROM, OPENCODE_TASK_FIX_TO) !== rule.sql) throw new Error(`opencode_task_fix_not_literal_only:${rule.name}`);
    return [{ table: rule.table, name: rule.name, oldHash: sha256(old), newHash: sha256(rule.sql), literals: old.split(OPENCODE_TASK_FIX_FROM).length - 1 }];
  });
}

export function opencodeTaskBindingModule(rules: readonly OpencodeTaskRule[]): string {
  return "/**\n * Generated by scripts/ops/generate-opencode-task-sql.ts. 0168 adds only OpenCode intro/audit twins; existing predicates stay intact.\n" +
    " * 0175 replaced the 0168 dispatch and event-terminal rows in place with these predicates (0168 had left the Claude CLI JSON provider literal in both).\n */\n" +
    rules.map(row => `export const ${row.symbol} = ${JSON.stringify(row.sql)};`).join("\n") + "\n";
}

export function opencodeTaskFixMigration(rows: ReturnType<typeof opencodeTaskFixRows>): string {
  const sources = `('${OPENCODE_TASK_TAG}','${OPENCODE_TASK_FIX_TAG}')`;
  const header = `-- 0175 (2026-11-11): repair the OpenCode intro/audit twins 0168 appended to the requests dispatch and events terminal ledger CHECKs.
-- 0168 (generated from 0125) rewrote only the SQL literal 'claude-cli' in the copied product_audit_cli / intro_check_cli branches, so each twin still
-- compared the JSON provider with ${OPENCODE_TASK_FIX_FROM} while its own guard required provider='opencode-cli': unsatisfiable. Since 2026-11-09 every
-- OpenCode product-audit reservation failed the reserved -> dispatched UPDATE with 23514 (model_capacity_requests_dispatch_check) and was withdrawn; the
-- events terminal twin would have rejected the dispatch_settled event the same way. The logical/members twins and the requests terminal CHECK
-- (provider-independent) carry no such literal and stay as they are.
-- This file replaces exactly those two rule rows in place (same table, constraint and ordinal; source becomes ${OPENCODE_TASK_FIX_TAG}) with the
-- applied text in which ${OPENCODE_TASK_FIX_FROM} becomes ${OPENCODE_TASK_FIX_TO} — byte for byte lib/llm/opencode-task-binding-sql.ts
-- (generated by scripts/ops/generate-opencode-task-sql.ts) — and rebuilds both guard functions. The preflight accepts only the exact applied 0168 text or
-- the exact repaired text (idempotent re-run) and the postflight pins the repaired hash, so a drifted rules table fails closed instead of journaling.
-- Locks: SHARE ROW EXCLUSIVE on the small model_capacity_check_rules table (5 s lock_timeout) and CREATE OR REPLACE FUNCTION of the two guard trigger
-- functions (same OIDs, triggers unchanged). No lock, scan or rewrite of model_capacity_requests/events; no ledger row, grant, index or column.
-- The repaired branches only widen what the guards accept (OpenCode intro/audit rows that no row could satisfy before), so it is safe while old code runs.
-- Note: from the moment it commits, the already deployed OpenCode audit/intro path can dispatch real calls on the M3 host.
SET LOCAL lock_timeout='5s';`;
  const values = (withNew: boolean) => rows.map(row => `('${row.table}','${row.name}','${row.oldHash}'${withNew ? `,'${row.newHash}'` : ""})`).join(",\n    ");
  const preflight = `DO $opencode_task_fix_preflight$
DECLARE target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ${values(true)}
  ) AS expected(table_name,constraint_name,old_hash,new_hash) LOOP
    IF (SELECT count(*) FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
        AND r.constraint_name=target.constraint_name AND r.source IN ${sources}) <> 1
      OR NOT EXISTS (SELECT 1 FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
        AND r.constraint_name=target.constraint_name AND r.source IN ${sources}
        AND encode(sha256(convert_to(r.predicate,'UTF8')),'hex') IN (target.old_hash,target.new_hash)) THEN
      RAISE EXCEPTION 'opencode_task_rule_baseline_unexpected: %',target.constraint_name USING ERRCODE='23514';
    END IF;
  END LOOP;
END $opencode_task_fix_preflight$;`;
  const update = `UPDATE model_capacity_check_rules r
   SET predicate = replace(r.predicate, $from$${OPENCODE_TASK_FIX_FROM}$from$, $to$${OPENCODE_TASK_FIX_TO}$to$), source = '${OPENCODE_TASK_FIX_TAG}'
  FROM (VALUES
    ${values(false)}
  ) AS target(table_name,constraint_name,old_hash)
 WHERE r.table_name = target.table_name AND r.constraint_name = target.constraint_name AND r.source = '${OPENCODE_TASK_TAG}'
   AND encode(sha256(convert_to(r.predicate,'UTF8')),'hex') = target.old_hash;`;
  const postflight = `DO $opencode_task_fix_postflight$
DECLARE target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ${values(true)}
  ) AS expected(table_name,constraint_name,old_hash,new_hash) LOOP
    IF (SELECT count(*) FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
        AND r.constraint_name=target.constraint_name AND r.source IN ${sources}) <> 1
      OR NOT EXISTS (SELECT 1 FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
        AND r.constraint_name=target.constraint_name AND r.source='${OPENCODE_TASK_FIX_TAG}'
        AND encode(sha256(convert_to(r.predicate,'UTF8')),'hex')=target.new_hash) THEN
      RAISE EXCEPTION 'opencode_task_rule_repair_unexpected: %',target.constraint_name USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM model_capacity_check_rules r WHERE r.source IN ${sources} AND position('claude-cli' IN r.predicate) > 0) THEN
    RAISE EXCEPTION 'opencode_task_rule_claude_literal_left' USING ERRCODE='23514';
  END IF;
END $opencode_task_fix_postflight$;`;
  return [header, "LOCK TABLE model_capacity_check_rules IN SHARE ROW EXCLUSIVE MODE;", preflight, update, postflight,
    "SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests');",
    "SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_events');"].join("\n--> statement-breakpoint\n") + "\n";
}

export function generateOpencodeTaskFiles(read: (path: string) => string) {
  const rules = generateOpencodeTaskRules(read("drizzle/0125_publication_classify_cli.sql"));
  const migration0168 = read(`drizzle/${OPENCODE_TASK_TAG}.sql`);
  const applied = applied0168Rules(migration0168);
  // The applied 0168 text is pinned by its own postflight hashes; re-check them so a moved file cannot silently change what 0175 expects.
  for (const [name, predicate] of Object.entries(applied))
    if (!migration0168.includes(`'${name}','${sha256(predicate)}')`)) throw new Error(`0168_rule_hash_mismatch:${name}`);
  const rows = opencodeTaskFixRows(rules, applied);
  if (rows.length !== 2 || rows.some(row => row.literals !== 2)) throw new Error("opencode_task_fix_unexpected_rows");
  return { rules, rows, bindingModule: opencodeTaskBindingModule(rules), migration: opencodeTaskFixMigration(rows) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL("../../", import.meta.url);
  const files = generateOpencodeTaskFiles(path => readFileSync(new URL(path, root), "utf8"));
  writeFileSync(new URL("lib/llm/opencode-task-binding-sql.ts", root), files.bindingModule);
  writeFileSync(new URL(`drizzle/${OPENCODE_TASK_FIX_TAG}.sql`, root), files.migration);
}
