/**
 * 0193: 0184 가 local-direct 에만 더한 일본어(ja) 제품 번역 가지 다섯을 provider='abcllm' 으로도 더한다.
 *
 * 왜(2026-11-21 운영 사고): 운영 장부의 product-translate 행은 전부 provider='abcllm' 로 남는다(2026-11-21 읽기 전용 확인 — local-direct 행은 없다).
 * abcllm 의 product-translate 가지는 0125 가 쓴 그대로 0160 행 안에 있고 en|zh-Hans|zh-Hant 만 받는다. 0184 는 local-direct 쌍둥이
 * (0157·0161)에만 ja 를 넣어, ja 가 든 첫 묶음이 대기열 맨 앞에 오자 INSERT 가 23514(model_capacity_requests_logical_check)로 틱마다 실패했다.
 *
 * 어떻게: 0184 의 다섯 가지(코드 baseline 에서 나온 값)에서 provider 글자 둘(행 열 provider='…', binding JSON '"…"'::jsonb)만 abcllm 으로 되돌린다.
 * 0157·0161 이 「0125 의 abcllm 가지에서 provider 만 바꾼 것」이었으므로, 되돌린 값은 0125 의 abcllm product-translate 가지에 ja 만 더한 것과
 * 글자까지 같다(tests/public-translation-languages.test.ts 가 0125 원문과 대조한다). 옛 rules 행은 고치지도 지우지도 않고 다음 ordinal 로만 넣는다.
 *
 * 0184 생성기를 고치지 않고 따로 둔 까닭: 0184 의 migration·상수 파일은 운영에 적용된 바이트로 고정돼 있다(배포 gate 가 해시를 본다).
 * 같은 스크립트가 두 migration 을 쓰면 다시 돌릴 때 0184 를 건드릴 수 있다 — 이 스크립트는 0184 의 규칙을 읽기만 한다.
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { JAPANESE_TRANSLATION_TAG, japaneseTranslationRules } from "./generate-japanese-product-translation-sql";

export const JAPANESE_ABCLLM_TRANSLATION_TAG = "0193_japanese_abcllm_product_translation";
/** 0184 가지에 들어 있는 provider 글자 — 행 열 비교와 binding JSON 비교 두 꼴뿐이다. */
const PROVIDER_LITERALS = [
  ["provider='local-direct'", "provider='abcllm'"],
  [`'provider'='"local-direct"'::jsonb`, `'provider'='"abcllm"'::jsonb`],
] as const;
const count = (text: string, part: string) => text.split(part).length - 1;

export const japaneseAbcllmTranslationRules = japaneseTranslationRules.map(rule => {
  const sql = PROVIDER_LITERALS.reduce((value, [from, to]) => value.replaceAll(from, to), rule.sql);
  // provider 글자만 바뀌어야 한다: 남은 local-direct 가 없고, 바뀐 수가 원래 수와 같고, 길이 차이가 그 수만큼이다. ja 목록은 0184 그대로다.
  const swapped = count(rule.sql, "local-direct");
  if (swapped < 1 || rule.sql.includes("abcllm") || sql.includes("local-direct") || count(sql, "abcllm") !== swapped
    || sql.length !== rule.sql.length - swapped * ("local-direct".length - "abcllm".length)
    || !/\(en\|zh-Hans\|zh-Hant\|ja\)|\('en','zh-Hans','zh-Hant','ja'\)/.test(sql) || sql.includes("sourceLocale") || sql.includes("$branch$")) {
    throw new Error(`unexpected_abcllm_product_translation_sql:${rule.name}`);
  }
  return { table: rule.table, name: rule.name, symbol: rule.symbol.replace(/^japaneseProduct/, "japaneseAbcllmProduct"), sql };
});

export function japaneseAbcllmTranslationMigration(): string {
  const targets = (extra: (rule: (typeof japaneseAbcllmTranslationRules)[number]) => string = () => "") =>
    japaneseAbcllmTranslationRules.map(rule => `('${rule.table}','${rule.name}'${extra(rule)})`).join(",\n    ");
  return `-- 0193 (2026-11-21): product-translate 의 일본어(ja) 구성원을 provider='abcllm' 장부 행에서도 받는다 — 0184 는 local-direct 가지에만 ja 를 더했다.
-- 운영 장부의 product-translate 행은 전부 provider='abcllm' 이라 ja 가 든 묶음의 INSERT 가 23514(model_capacity_requests_logical_check)로 실패했다(2026-11-21 00:44Z~).
-- 0184 의 다섯 가지에서 provider 글자만 abcllm 으로 되돌린 가지(= 0125 의 abcllm product-translate 가지 + ja)를 다음 ordinal 로 넣는다.
-- 옛 rules 행·장부 행·제약·인덱스·권한은 그대로다. 다시 실행해도 행이 늘지 않는다. 생성: scripts/ops/generate-japanese-abcllm-product-translation-sql.ts
SET LOCAL lock_timeout='5s';
--> statement-breakpoint
LOCK TABLE model_capacity_check_rules IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $preflight$
DECLARE target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ${targets()}
  ) AS expected(table_name,constraint_name) LOOP
    IF NOT EXISTS (SELECT 1 FROM model_capacity_check_rules r
      WHERE r.table_name=target.table_name AND r.constraint_name=target.constraint_name AND r.source='0160_ledger_check_rules') THEN
      RAISE EXCEPTION 'japanese_abcllm_translation_rule_baseline_missing: %',target.constraint_name;
    END IF;
    IF (SELECT count(*) FROM model_capacity_check_rules r
      WHERE r.table_name=target.table_name AND r.constraint_name=target.constraint_name AND r.source='${JAPANESE_TRANSLATION_TAG}') <> 1 THEN
      RAISE EXCEPTION 'japanese_abcllm_translation_rule_local_direct_twin_missing: %',target.constraint_name;
    END IF;
  END LOOP;
END $preflight$;
--> statement-breakpoint
${japaneseAbcllmTranslationRules.map(rule => `INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
SELECT '${rule.table}', '${rule.name}', coalesce(max(ordinal),0)+1, $branch$${rule.sql}$branch$, '${JAPANESE_ABCLLM_TRANSLATION_TAG}'
FROM model_capacity_check_rules WHERE table_name='${rule.table}' AND constraint_name='${rule.name}'
HAVING count(*) > 0 AND COUNT(*) FILTER (WHERE source = '${JAPANESE_ABCLLM_TRANSLATION_TAG}') = 0;`).join("\n--> statement-breakpoint\n")}
--> statement-breakpoint
DO $postflight$
DECLARE target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ${targets(rule => `,'${createHash("sha256").update(rule.sql).digest("hex")}'`)}
  ) AS expected(table_name,constraint_name,predicate_hash) LOOP
    IF (SELECT count(*) FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
      AND r.constraint_name=target.constraint_name AND r.source='${JAPANESE_ABCLLM_TRANSLATION_TAG}') <> 1
      OR NOT EXISTS (SELECT 1 FROM model_capacity_check_rules r WHERE r.table_name=target.table_name
        AND r.constraint_name=target.constraint_name AND r.source='${JAPANESE_ABCLLM_TRANSLATION_TAG}'
        AND encode(sha256(convert_to(r.predicate,'UTF8')),'hex')=target.predicate_hash) THEN
      RAISE EXCEPTION 'japanese_abcllm_translation_rule_unexpected: %',target.constraint_name;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM model_capacity_check_rules r WHERE r.source='${JAPANESE_ABCLLM_TRANSLATION_TAG}') <> ${japaneseAbcllmTranslationRules.length} THEN
    RAISE EXCEPTION 'japanese_abcllm_translation_rule_count_unexpected';
  END IF;
END $postflight$;
--> statement-breakpoint
SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_requests');
--> statement-breakpoint
SELECT nmv_model_capacity_check_guard_rebuild('model_capacity_events');
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = new URL("../../", import.meta.url);
  writeFileSync(new URL("lib/llm/japanese-abcllm-product-translation-sql.ts", root),
    "/** Generated by scripts/ops/generate-japanese-abcllm-product-translation-sql.ts. */\n"
      + japaneseAbcllmTranslationRules.map(rule => `export const ${rule.symbol} = ${JSON.stringify(rule.sql)};`).join("\n") + "\n");
  writeFileSync(new URL(`drizzle/${JAPANESE_ABCLLM_TRANSLATION_TAG}.sql`, root), japaneseAbcllmTranslationMigration());
}
