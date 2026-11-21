import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { modelCapacityEvents, modelCapacityRequests } from "@/lib/db/operations-schema";
import * as generated from "@/lib/llm/japanese-abcllm-product-translation-sql";
import * as localDirect from "@/lib/llm/japanese-product-translation-sql";
import { JAPANESE_ABCLLM_TRANSLATION_TAG, japaneseAbcllmTranslationMigration, japaneseAbcllmTranslationRules } from "../scripts/ops/generate-japanese-abcllm-product-translation-sql";
import { japaneseTranslationRules } from "../scripts/ops/generate-japanese-product-translation-sql";
import { outerSqlBranches } from "../scripts/ops/generate-opencode-task-sql";

/**
 * 0193(2026-11-21 운영 사고): 0184 는 일본어(ja) 제품 번역 가지를 local-direct 에만 더했는데 운영 장부의 product-translate 행은 전부 provider='abcllm' 이다.
 * ja 가 든 첫 묶음이 대기열 맨 앞에 오자 INSERT 가 23514(model_capacity_requests_logical_check)로 틱마다 실패했다.
 * 0193 은 0184 의 다섯 가지에서 provider 글자만 abcllm 으로 되돌린 가지(= 0125 의 abcllm product-translate 가지 + ja)를 다음 ordinal 로 넣는다.
 * 실제 DB 왕복(예약→dispatch→정산, 다섯 행이 저마다 필요한지)은 tests/integration/product-translation-model-capacity.test.ts 가 본다.
 */
const tag = "0193_japanese_abcllm_product_translation";
const migration = readFileSync(`drizzle/${tag}.sql`, "utf8");
const statements = migration.split("--> statement-breakpoint");
const names = ["model_capacity_requests_logical_check", "model_capacity_requests_members_check", "model_capacity_requests_dispatch_check",
  "model_capacity_requests_terminal_check", "model_capacity_events_terminal_check"];
const withoutJa = (sql: string) => sql.replaceAll("(en|zh-Hans|zh-Hant|ja)", "(en|zh-Hans|zh-Hant)").replaceAll("('en','zh-Hans','zh-Hant','ja')", "('en','zh-Hans','zh-Hant')");
/** The last full restatement of every capacity CHECK (0125); the abcllm product-translate acceptance has not been restated since. */
function authoredBranches(name: string): string[] {
  const statement = readFileSync("drizzle/0125_publication_classify_cli.sql", "utf8").split("--> statement-breakpoint")
    .find(sql => sql.includes(`ADD CONSTRAINT ${name} CHECK`))!;
  return outerSqlBranches(/CHECK \(([\s\S]*)\);\s*$/.exec(statement)![1]);
}

it("registers 0193 right after 0192 with a larger when, once", () => {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
  const index = journal.entries.findIndex(entry => entry.tag === tag);
  expect(JAPANESE_ABCLLM_TRANSLATION_TAG).toBe(tag);
  expect(journal.entries[index]).toMatchObject({ idx: 193, when: 1795219200002, tag, breakpoints: true, version: "7" });
  expect(journal.entries[index - 1]).toMatchObject({ idx: 192, when: 1795219200001, tag: "0192_online_missing_indexes" });
  expect(journal.entries.filter(entry => entry.idx === 193 || entry.tag === tag)).toHaveLength(1);
  expect(journal.entries.slice(index + 1).every(next => next.idx > 193 && next.when > journal.entries[index].when)).toBe(true);
});

it("keeps the generated constants and the migration file byte-identical to the generator", () => {
  expect(japaneseAbcllmTranslationRules.map(rule => rule.name)).toEqual(names);
  for (const rule of japaneseAbcllmTranslationRules) expect(generated[rule.symbol as keyof typeof generated], rule.symbol).toBe(rule.sql);
  expect(Object.keys(generated).sort()).toEqual(japaneseAbcllmTranslationRules.map(rule => rule.symbol).sort());
  expect(migration).toBe(japaneseAbcllmTranslationMigration());
});

it.each(japaneseAbcllmTranslationRules)("$name: the branch is the 0125 abcllm product-translate branch with only ja added, and the 0184 branch with only the provider changed", rule => {
  // ① 0184(local-direct) 가지와는 provider 글자만 다르다 — 행 열과 binding JSON 두 꼴
  const twin = japaneseTranslationRules.find(entry => entry.name === rule.name)!;
  expect(twin.table).toBe(rule.table);
  expect(localDirect[twin.symbol as keyof typeof localDirect]).toBe(twin.sql);
  expect(rule.sql.replaceAll("provider='abcllm'", "provider='local-direct'").replaceAll(`'provider'='"abcllm"'::jsonb`, `'provider'='"local-direct"'::jsonb`)).toBe(twin.sql);
  expect(rule.sql).not.toContain("local-direct");
  // ② 운영이 지금까지 써 온 abcllm 가지(0125 원문, 0160 행 안에 그대로 있다)와는 ja 만 다르다
  const original = authoredBranches(rule.name).filter(branch => branch === withoutJa(rule.sql));
  expect(original, `${rule.name}: exactly one authored 0125 branch`).toHaveLength(1);
  expect(original[0]).toContain("abcllm");
  expect(original[0]).toMatch(/product-translate|product_translation_gateway/);
  expect(withoutJa(rule.sql)).not.toBe(rule.sql);
  // 다른 text 경로·원문 언어 목록은 건드리지 않는다
  expect(rule.sql).not.toMatch(/sourceLocale|search-query-translate|reason-translate|product-tagline-ko|crawl-tagline|second-review/);
  if (rule.name.endsWith("_logical_check") || rule.name.endsWith("_members_check")) {
    expect(rule.sql).toContain("route_id='product-translate' AND provider='abcllm'");
    expect(rule.sql.match(/\(en\|zh-Hans\|zh-Hant\|ja\):\(tagline\|description\)\$/g)).toHaveLength(4);
  } else {
    expect(rule.sql).toContain(`'provider'='"abcllm"'::jsonb`);
    expect(rule.sql.match(/->>'locale' IN \('en','zh-Hans','zh-Hant','ja'\)/g)).toHaveLength(4);
  }
});

it("only appends five rules rows under a rules-table lock, with preflight, hash postflight and both guard rebuilds", () => {
  expect(statements[0].split("\n").at(-2)).toBe("SET LOCAL lock_timeout='5s';");
  expect(statements[1].trim()).toBe("LOCK TABLE model_capacity_check_rules IN SHARE ROW EXCLUSIVE MODE;");
  const preflight = statements.find(sql => sql.includes("DO $preflight$"))!;
  expect(preflight).toContain("r.source='0160_ledger_check_rules'");
  expect(preflight).toContain("r.source='0184_japanese_product_translation') <> 1");
  const inserts = statements.filter(sql => sql.includes("INSERT INTO model_capacity_check_rules"));
  expect(inserts).toHaveLength(5);
  const postflight = statements.find(sql => sql.includes("DO $postflight$"))!;
  expect(statements.indexOf(preflight)).toBeLessThan(statements.indexOf(inserts[0]));
  expect(statements.indexOf(postflight)).toBeGreaterThan(statements.indexOf(inserts[4]));
  japaneseAbcllmTranslationRules.forEach((rule, index) => {
    // 다시 실행해도 행이 늘지 않는다: 이 source 의 행이 이미 있으면 건너뛴다
    expect(inserts[index].trim()).toBe(`INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
SELECT '${rule.table}', '${rule.name}', coalesce(max(ordinal),0)+1, $branch$${rule.sql}$branch$, '${tag}'
FROM model_capacity_check_rules WHERE table_name='${rule.table}' AND constraint_name='${rule.name}'
HAVING count(*) > 0 AND COUNT(*) FILTER (WHERE source = '${tag}') = 0;`);
    expect(preflight).toContain(`('${rule.table}','${rule.name}')`);
    expect(postflight).toContain(`('${rule.table}','${rule.name}','${createHash("sha256").update(rule.sql).digest("hex")}')`);
  });
  expect(postflight).toContain(`r.source='${tag}') <> 1`);
  expect(postflight).toContain("encode(sha256(convert_to(r.predicate,'UTF8')),'hex')=target.predicate_hash");
  expect(statements.slice(-2).map(sql => sql.trim())).toEqual(["SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests');",
    "SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_events');"]);
  // 옛 rules 행·장부 행·표 정의를 건드리는 문장이 없다(주석 제외)
  const code = migration.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
  expect(code).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/);
  expect(code).not.toMatch(/INSERT INTO model_capacity_(?:requests|events)\b/);
});

it("Drizzle carries each 0193 branch as the newest OR tail, right after the 0184 local-direct tail", () => {
  for (const rule of japaneseAbcllmTranslationRules) {
    const table = rule.table === "model_capacity_events" ? modelCapacityEvents : modelCapacityRequests;
    const check = getTableConfig(table).checks.find(check => check.name === rule.name)!;
    const expression = new PgDialect().sqlToQuery(check.value).sql;
    const tail = `) OR (${rule.sql})`, twin = `) OR (${japaneseTranslationRules.find(entry => entry.name === rule.name)!.sql})`;
    expect(expression.startsWith("(") && expression.endsWith(tail), `${rule.name}: 0193 tail`).toBe(true);
    const previous = expression.slice(1, -tail.length);
    expect(previous.startsWith("(") && previous.endsWith(twin), `${rule.name}: 0184 tail before it`).toBe(true);
  }
});
