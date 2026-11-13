/** Append Japanese native product-translation branches without changing historical dispatches or rules. */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { outerSqlBranches } from "./generate-opencode-task-sql";
import { gatewayLocalDirectLogicalSql, gatewayLocalDirectMembersSql } from "../../lib/llm/gateway-local-direct-sql";
import { textLocalDirectDispatchSql, textLocalDirectTerminalSql, textLocalDirectEventTerminalSql } from "../../lib/llm/gateway-local-direct-binding-sql";

export const JAPANESE_TRANSLATION_TAG = "0184_japanese_product_translation";
export const japaneseTranslationRules = [
  { table: "model_capacity_requests", name: "model_capacity_requests_logical_check", symbol: "japaneseProductLogicalSql", baseline: gatewayLocalDirectLogicalSql },
  { table: "model_capacity_requests", name: "model_capacity_requests_members_check", symbol: "japaneseProductMembersSql", baseline: gatewayLocalDirectMembersSql },
  { table: "model_capacity_requests", name: "model_capacity_requests_dispatch_check", symbol: "japaneseProductDispatchSql", baseline: textLocalDirectDispatchSql },
  { table: "model_capacity_requests", name: "model_capacity_requests_terminal_check", symbol: "japaneseProductTerminalSql", baseline: textLocalDirectTerminalSql },
  { table: "model_capacity_events", name: "model_capacity_events_terminal_check", symbol: "japaneseProductEventSql", baseline: textLocalDirectEventTerminalSql },
].map(({ baseline, ...target }) => {
  const branches = outerSqlBranches(baseline).filter(branch => branch.includes("product-translate"));
  if (branches.length !== 1) throw new Error(`unexpected_product_translation_branches:${target.name}`);
  // All four members of a mixed en/zh-Hans/ja batch must be accepted. Keep legacy rows valid too.
  const sql = branches[0].replaceAll("(en|zh-Hans|zh-Hant)", "(en|zh-Hans|zh-Hant|ja)")
    .replaceAll("('en','zh-Hans','zh-Hant')", "('en','zh-Hans','zh-Hant','ja')");
  if (sql === branches[0] || !sql.includes("local-direct") || sql.includes("sourceLocale")) {
    throw new Error(`unexpected_product_translation_sql:${target.name}`);
  }
  return { ...target, sql };
});

export function japaneseTranslationMigration(): string {
  return `-- Add ja while preserving existing translations, preferences and every historical ledger rule.\nSET LOCAL lock_timeout='5s';
--> statement-breakpoint
ALTER TABLE product_translations DROP CONSTRAINT product_translations_locale_check,
  ADD CONSTRAINT product_translations_locale_check CHECK (locale IN ('en','zh-Hans','zh-Hant','ja')),
  DROP CONSTRAINT product_translations_source_locale_check,
  ADD CONSTRAINT product_translations_source_locale_check CHECK (source_locale IS NULL OR source_locale IN ('ko','en','zh-Hans','zh-Hant','ja'));
--> statement-breakpoint
ALTER TABLE notification_settings DROP CONSTRAINT notification_settings_locale_check,
  ADD CONSTRAINT notification_settings_locale_check CHECK (locale IN ('ko','en','zh-Hans','zh-Hant','ja'));
--> statement-breakpoint
LOCK TABLE model_capacity_check_rules IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $preflight$
DECLARE target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ${japaneseTranslationRules.map(rule => `('${rule.table}','${rule.name}')`).join(",\n    ")}
  ) AS expected(table_name,constraint_name) LOOP
    IF NOT EXISTS (SELECT 1 FROM model_capacity_check_rules r
      WHERE r.table_name=target.table_name AND r.constraint_name=target.constraint_name AND r.source='0160_ledger_check_rules') THEN
      RAISE EXCEPTION 'japanese_translation_rule_baseline_missing: %',target.constraint_name;
    END IF;
  END LOOP;
END $preflight$;
--> statement-breakpoint
${japaneseTranslationRules.map(rule => `INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
SELECT '${rule.table}', '${rule.name}', coalesce(max(ordinal),0)+1, $branch$${rule.sql}$branch$, '${JAPANESE_TRANSLATION_TAG}'
FROM model_capacity_check_rules WHERE table_name='${rule.table}' AND constraint_name='${rule.name}'
HAVING count(*) > 0 AND count(*) FILTER (WHERE source='${JAPANESE_TRANSLATION_TAG}')=0;`).join("\n--> statement-breakpoint\n")}
--> statement-breakpoint
DO $postflight$
DECLARE target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ${japaneseTranslationRules.map(rule => `('${rule.table}','${rule.name}','${createHash("sha256").update(rule.sql).digest("hex")}')`).join(",\n    ")}
  ) AS expected(table_name,constraint_name,predicate_hash) LOOP
    IF (SELECT count(*) FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
      AND r.constraint_name=target.constraint_name AND r.source='${JAPANESE_TRANSLATION_TAG}') <> 1
      OR NOT EXISTS (SELECT 1 FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
        AND r.constraint_name=target.constraint_name AND r.source='${JAPANESE_TRANSLATION_TAG}'
        AND encode(sha256(convert_to(r.predicate,'UTF8')),'hex')=target.predicate_hash) THEN
      RAISE EXCEPTION 'japanese_translation_rule_unexpected: %',target.constraint_name;
    END IF;
  END LOOP;
END $postflight$;
--> statement-breakpoint
SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests');
--> statement-breakpoint
SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_events');
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL("../../", import.meta.url);
  writeFileSync(new URL("lib/llm/japanese-product-translation-sql.ts", root),
    "/** Generated by scripts/ops/generate-japanese-product-translation-sql.ts. */\n"
      + japaneseTranslationRules.map(rule => `export const ${rule.symbol} = ${JSON.stringify(rule.sql)};`).join("\n") + "\n");
  writeFileSync(new URL(`drizzle/${JAPANESE_TRANSLATION_TAG}.sql`, root), japaneseTranslationMigration());
}
