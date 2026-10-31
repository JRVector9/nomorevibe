import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as branchesSql from "@/lib/llm/gateway-local-direct-sql";

/**
 * 0155(PR 3b-C 전송 통합): AI1(legacy·item)·text 7경로의 게이트웨이 kind 가 local-direct 엔진으로도 장부에 남는다.
 * 0132(AI2 item)와 같은 꼴 — 살아 있는 술어 전체를 왼쪽에 두고, 0125(마지막 전체 재진술)의 그 kind 들의 abcllm 분기를 provider 만 바꿔 덧붙인다.
 */
const tag = "0155_ai1_provider_enum";
const TEXT_ROUTES = ["product-search-profile", "reason-translate", "product-translate", "product-tagline-ko", "crawl-tagline",
  "product-search-verify", "search-query-translate"] as const;
const targets = [
  { name: "model_capacity_requests_logical_check", constant: branchesSql.gatewayLocalDirectLogicalSql,
    routes: ["crawl-agent-review", ...TEXT_ROUTES], kinds: [] as string[] },
  { name: "model_capacity_requests_members_check", constant: branchesSql.gatewayLocalDirectMembersSql,
    routes: TEXT_ROUTES.filter(route => route !== "product-search-profile"), kinds: [] as string[] },
  { name: "model_capacity_requests_dispatch_check", constant: branchesSql.gatewayLocalDirectDispatchSql,
    routes: ["crawl-agent-review", ...TEXT_ROUTES], kinds: ["ai1_item_gateway"] },
  { name: "model_capacity_requests_terminal_check", constant: branchesSql.gatewayLocalDirectTerminalSql,
    routes: ["crawl-agent-review"], kinds: ["ai1_item_gateway"] },
  { name: "model_capacity_events_terminal_check", constant: branchesSql.gatewayLocalDirectEventTerminalSql,
    routes: ["crawl-agent-review"], kinds: ["ai1_legacy_gateway", "ai1_item_gateway"] },
];

/** Split only outer ORs, leaving JSON strings, CASEs and coalesce validators intact (same splitter as the 0132 history test). */
function branches(value: string): string[] {
  const text = value.trim();
  const outside: number[] = [];
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
  if (text.startsWith("(") && text.endsWith(")") && outside.every(i => i === text.length - 1)) return branches(text.slice(1, -1));
  const splits = outside.filter(i => text.slice(i, i + 4) === " OR ");
  if (!splits.length) return [text];
  const result: string[] = [];
  let start = 0;
  for (const split of splits) { result.push(...branches(text.slice(start, split))); start = split + 4; }
  return [...result, ...branches(text.slice(start))];
}

/** The last full restatement of every capacity CHECK; later migrations only appended branches. */
function authoredBranches(name: string): string[] {
  const statement = readFileSync("drizzle/0125_publication_classify_cli.sql", "utf8").split("--> statement-breakpoint")
    .find(sql => sql.includes(`ADD CONSTRAINT ${name} CHECK`))!;
  return branches(/CHECK \(([\s\S]*)\);\s*$/.exec(statement)![1]);
}
const isAi2 = (branch: string) => branch.includes("'second-review'") || branch.includes("'ai2_item_gateway'");
const migration = () => readFileSync(`drizzle/${tag}.sql`, "utf8");
function migrationBranches() {
  return migration().split("--> statement-breakpoint").filter(sql => sql.includes("DO $$")).map(sql => ({
    name: /conname='([^']+)'/.exec(sql)![1], branch: /\$ai2_local\$([\s\S]*?)\$ai2_local\$/.exec(sql)![1], sql,
  }));
}

it("registers one additive migration after the device tables, flagged for renumbering at integration", () => {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
  const index = journal.entries.findIndex(entry => entry.tag === tag);
  expect(journal.entries[index]).toMatchObject({ idx: 155, when: 1794086401066, tag, breakpoints: true });
  // main 에 PR 2a(0154 capacity_helpers)가 먼저 들어가 그 뒤에 선다. 0155 번호는 #760·#761 과 겹쳐 통합 때 다시 매긴다.
  expect(journal.entries[index - 1]).toMatchObject({ idx: 154, tag: "0154_capacity_helpers" });
  expect(journal.entries[index - 2]).toMatchObject({ idx: 153, tag: "0153_model_capacity_devices" });
  expect(journal.entries.filter(entry => entry.idx === 155 || entry.tag === tag)).toHaveLength(1);
  expect(migration().split("\n")[0]).toContain("renumbered at integration");
});

it.each(targets)("$name appends exactly the original AI1/text abcllm branches with only the provider changed", ({ name, constant, routes, kinds }) => {
  const added = migrationBranches().filter(entry => entry.name === name);
  expect(added).toHaveLength(1);
  expect(added[0].branch, `${name}: the appended branch is the schema constant`).toBe(constant);
  expect(added[0].sql).toContain("substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate");
  expect(added[0].sql).toContain(`ADD CONSTRAINT ${name} CHECK ((%s) OR (%s))`);
  // Every non-AI2 abcllm branch of 0125 gets its local-direct twin; AI2 was widened by 0132 and stays as stored.
  const original = authoredBranches(name).filter(branch => branch.includes("'abcllm'") && !isAi2(branch));
  expect(original.length).toBeGreaterThan(0);
  expect(constant).toBe(original.map(branch => `(${branch.replaceAll("'abcllm'", "'local-direct'")})`).join(" OR "));
  expect(constant).not.toContain("'abcllm'");
  expect(constant).not.toMatch(/'second-review'|ai2_item_gateway|ai1_legacy_cli|ai1_item_cli|local_model_direct|publication_classify/);
  for (const route of routes) expect(constant, `${name}: ${route}`).toContain(`'${route}'`);
  for (const kind of kinds) expect(constant, `${name}: ${kind}`).toContain(`'${kind}'`);
  expect(original).toHaveLength(name === "model_capacity_events_terminal_check" ? 2 : name === "model_capacity_requests_terminal_check" ? 1 : routes.length);
});

it("changes exactly five CHECKs without replacing SQL functions, triggers, indexes or ledger rows", () => {
  expect(migrationBranches().map(entry => entry.name)).toEqual(targets.map(target => target.name));
  const sql = migration();
  expect(sql).not.toMatch(/\b(?:CREATE|REPLACE)\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
  expect(sql).not.toMatch(/\b(?:CREATE|DROP|ALTER)\s+(?:TRIGGER|INDEX|COLUMN)\b/i);
  expect(sql).not.toMatch(/^\s*(?:UPDATE|INSERT|DELETE|TRUNCATE)\b/im);
  // gateway_not_started (0149) is already provider-agnostic: its kind list covers every gateway kind and never names a provider.
  const notStarted = readFileSync("drizzle/0149_gateway_not_started_all_kinds.sql", "utf8");
  expect(notStarted).toContain("'ai1_item_gateway'");
  expect(/\$ai2_local\$([\s\S]*?)\$ai2_local\$/.exec(notStarted)![1]).not.toMatch(/provider/);
});
