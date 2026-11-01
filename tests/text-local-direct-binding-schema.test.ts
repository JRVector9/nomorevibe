import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as binding from "@/lib/llm/gateway-local-direct-binding-sql";
import { gatewayLocalDirectDispatchSql } from "@/lib/llm/gateway-local-direct-sql";

/**
 * 0159(PR 3b-E text local-direct 기록): 0157 이 text 7경로의 dispatch 분기에서 행 열의 'abcllm' 만 바꿔 binding JSON 의 provider 는 '"abcllm"' 로 남았고,
 * terminal·events 의 text 분기는 생성에서 빠졌다 — 그래서 provider local-direct 인 text dispatch 가 어느 분기에도 닿지 않았다(사설 DB 로 확인).
 * 0159 는 0125 의 그 분기들에서 'abcllm' 과 '"abcllm"' 을 모두 local-direct 로 바꿔 세 CHECK 끝에 덧붙인다. 0157 과 같은 꼴(살아 있는 술어 전체 + OR 분기).
 */
const tag = "0159_text_local_direct_binding";
const TEXT_ROUTES = ["product-search-profile", "reason-translate", "product-translate", "product-tagline-ko", "crawl-tagline",
  "product-search-verify", "search-query-translate"] as const;
const TEXT_TERMINALS = ["text_profile_gateway_terminal", "reason_translation_gateway_terminal", "product_translation_gateway_terminal",
  "product_tagline_ko_gateway_terminal", "crawl_tagline_gateway_terminal", "search_verify_gateway_terminal", "websearch_query_gateway_terminal"] as const;
const targets = [
  { name: "model_capacity_requests_dispatch_check", table: "model_capacity_requests", constant: binding.textLocalDirectDispatchSql,
    kinds: ["text_profile_gateway", "reason_translation_gateway", "product_translation_gateway", "product_tagline_ko_gateway", "crawl_tagline_gateway",
      "search_verify_gateway", "websearch_query_gateway"] },
  { name: "model_capacity_requests_terminal_check", table: "model_capacity_requests", constant: binding.textLocalDirectTerminalSql, kinds: [...TEXT_TERMINALS] },
  { name: "model_capacity_events_terminal_check", table: "model_capacity_events", constant: binding.textLocalDirectEventTerminalSql, kinds: [...TEXT_TERMINALS] },
];

/** Split only outer ORs, leaving JSON strings, CASEs and coalesce validators intact (same splitter as the 0132/0157 history tests). */
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
function authoredBranches(name: string): string[] {
  const statement = readFileSync("drizzle/0125_publication_classify_cli.sql", "utf8").split("--> statement-breakpoint")
    .find(sql => sql.includes(`ADD CONSTRAINT ${name} CHECK`))!;
  return branches(/CHECK \(([\s\S]*)\);\s*$/.exec(statement)![1]);
}
const isAi2 = (branch: string) => /'second-review'|ai2_item_gateway|ai2_gateway_terminal/.test(branch);
const migration = () => readFileSync(`drizzle/${tag}.sql`, "utf8");
function migrationBranches() {
  return migration().split("--> statement-breakpoint").filter(sql => sql.includes("DO $$")).map(sql => ({
    name: /conname='([^']+)'/.exec(sql)![1], table: /conrelid='([^']+)'::regclass/.exec(sql)![1], branch: /\$ai2_local\$([\s\S]*?)\$ai2_local\$/.exec(sql)![1], sql,
  }));
}

it("registers one additive migration right after 0158 (release branch kinds, merged from main) at the agreed journal position", () => {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
  const entry = journal.entries.find(entry => entry.tag === tag);
  expect(entry).toMatchObject({ idx: 159, when: 1794086401070, tag, breakpoints: true });
  const provider = journal.entries.find(entry => entry.tag === "0157_ai1_provider_enum")!;
  expect(provider.when).toBeLessThan(entry!.when);
  const release = journal.entries.find(entry => entry.tag === "0158_release_branch_kinds")!;
  expect(release).toMatchObject({ idx: 158, when: 1794086401069 });
  expect(journal.entries.indexOf(entry!), "0159 sits right after 0158").toBe(journal.entries.indexOf(release) + 1);
  expect(journal.entries.at(-1)).toBe(entry);
  expect(journal.entries.filter(entry => entry.idx === 159 || entry.when === 1794086401070 || entry.tag === tag)).toHaveLength(1);
  expect(journal.entries.map(entry => entry.when)).toEqual([...journal.entries.map(entry => entry.when)].sort((a, b) => a - b));
});

it.each(targets)("$name appends the seven text-route branches with the row and the JSON provider both local-direct", ({ name, table, constant, kinds }) => {
  const added = migrationBranches().filter(entry => entry.name === name);
  expect(added).toHaveLength(1);
  expect(added[0].table).toBe(table);
  expect(added[0].branch, `${name}: the appended branch is the schema constant`).toBe(constant);
  expect(added[0].sql).toContain("substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate");
  expect(added[0].sql).toContain(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
  expect(added[0].sql).toContain(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK ((%s) OR (%s))`);
  // Exactly the 0125 text-route branches whose JSON carries the provider literal; AI1 compares the JSON provider to the row and AI2 was widened by 0132.
  const original = authoredBranches(name).filter(branch => branch.includes("'\"abcllm\"'") && !isAi2(branch));
  expect(original).toHaveLength(TEXT_ROUTES.length);
  expect(constant).toBe(original.map(branch => `(${branch.replaceAll("'abcllm'", "'local-direct'").replaceAll("'\"abcllm\"'", "'\"local-direct\"'")})`).join(" OR "));
  expect(constant).not.toContain("abcllm");
  expect(constant).not.toMatch(/'second-review'|ai2_item_gateway|ai2_gateway_terminal|ai1_legacy_gateway|ai1_item_gateway|cli|local_model_direct|publication_classify/);
  for (const kind of kinds) expect(constant, `${name}: ${kind}`).toContain(`'"${kind}"'`);
  const parts = branches(constant);
  expect(parts).toHaveLength(TEXT_ROUTES.length);
  for (const part of parts) {
    expect(part).toContain("'\"local-direct\"'::jsonb");
    if (name === "model_capacity_requests_dispatch_check") expect(part).toContain("provider='local-direct'");
  }
});

it("the 0157 dispatch twins stayed as stored: row local-direct, JSON still abcllm — which is why they never matched a text row", () => {
  const twins = branches(gatewayLocalDirectDispatchSql).filter(branch => !branch.includes("ai1_item_gateway"));
  expect(twins).toHaveLength(TEXT_ROUTES.length);
  for (const twin of twins) { expect(twin).toContain("provider='local-direct'"); expect(twin).toContain("'\"abcllm\"'::jsonb"); }
});

it("changes exactly three CHECKs without replacing SQL functions, triggers, indexes or ledger rows", () => {
  expect(migrationBranches().map(entry => entry.name)).toEqual(targets.map(target => target.name));
  const sql = migration();
  expect(sql.split("\n")[0]).toContain("0159 (PR 3b-E");
  expect(sql).not.toMatch(/\b(?:CREATE|REPLACE)\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
  expect(sql).not.toMatch(/\b(?:CREATE|DROP|ALTER)\s+(?:TRIGGER|INDEX|COLUMN)\b/i);
  expect(sql).not.toMatch(/^\s*(?:UPDATE|INSERT|DELETE|TRUNCATE)\b/im);
});
