import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { NextRequest } from "next/server";
import { LOCALES, PRODUCT_TRANSLATION_LOCALES, isActiveTranslationLocale } from "@/lib/i18n/locales";
import { localePath, switchLocale } from "@/lib/i18n/routing";
import { localizedAlternates, productReadyLocales } from "@/lib/i18n/metadata";
import { getDictionary } from "@/lib/i18n/dictionary";
import { checkProductTranslation, detectTranslationSourceLocale } from "@/lib/domain/products/translation-policy";
import { productTranslationGatewayWire } from "@/lib/crawl/translate";
import { japaneseTranslationMigration, japaneseTranslationRules } from "../scripts/ops/generate-japanese-product-translation-sql";
import * as generated from "@/lib/llm/japanese-product-translation-sql";
import { proxy } from "../proxy";

it("offers one Chinese script and Japanese, while excluding archived demand from active targets", () => {
  expect(LOCALES).toEqual(["ko", "en", "zh-Hans", "ja"]);
  expect(PRODUCT_TRANSLATION_LOCALES).toEqual(["en", "zh-Hans", "ja"]);
  expect(isActiveTranslationLocale("zh-Hant")).toBe(false);
  expect(isActiveTranslationLocale("ja")).toBe(true);
});

it("keeps path, query, hash and safe login return paths when switching to Japanese", () => {
  expect(switchLocale("/zh-Hant/p/notes?q=api#about", "ja")).toBe("/ja/p/notes?q=api#about");
  expect(localePath("zh-Hant", "/p/notes?q=api#about")).toBe("/zh-Hans/p/notes?q=api#about");
  expect(switchLocale("/en/login?returnTo=%2Fen%2Fme%2Faccount", "ja"))
    .toBe("/ja/login?returnTo=%2Fja%2Fme%2Faccount");
});

it("redirects retired public URLs with their query and keeps prefixed admin/machine paths isolated", async () => {
  const moved = await proxy(new NextRequest("https://nomorevibe.com/zh-Hant/p/notes?tab=about"));
  expect(moved.status).toBe(308);
  expect(moved.headers.get("location")).toBe("https://nomorevibe.com/zh-Hans/p/notes?tab=about");
  const admin = await proxy(new NextRequest("https://nomorevibe.com/zh-Hant/admin/models"));
  expect(admin.status).toBe(404);
  const machine = await proxy(new NextRequest("https://nomorevibe.com/zh-Hant/api/products"));
  expect(machine.headers.get("location")).toBeNull();
  const japanese = await proxy(new NextRequest("https://nomorevibe.com/ja/p/notes"));
  expect(japanese.headers.get("x-middleware-request-x-nmv-public-locale")).toBe("ja");
});

it("loads Japanese primary copy and the explicit English support fallback with complete keys", async () => {
  expect((await getDictionary("ja", "common"))["language.label"]).toBe("言語");
  expect((await getDictionary("ja", "labels"))["content.pending"]).toBe("翻訳待ち");
  expect(await getDictionary("ja", "policy")).toEqual(await getDictionary("en", "policy"));
});

const source = { id: 1, name: "Doc", tagline: "Doc manages 3 API projects" };
it("validates Japanese separately from Chinese and preserves names, quantities and source tokens", () => {
  expect(checkProductTranslation("Docで3件のAPIプロジェクトを管理します", source, "ja", "tagline").ok).toBe(true);
  expect(checkProductTranslation("Doc管理3个API项目", source, "ja", "tagline")).toEqual({ ok: false, reason: "not_japanese" });
  expect(checkProductTranslation("Doc으로3개의API프로젝트를관리합니다", source, "ja", "tagline").ok).toBe(false);
  expect(checkProductTranslation("Docで4件のAPIプロジェクトを管理します", source, "ja", "tagline")).toEqual({ ok: false, reason: "number_changed" });
  expect(checkProductTranslation("3件のAPIプロジェクトを管理します", source, "ja", "tagline")).toEqual({ ok: false, reason: "name_lost" });
  expect(checkProductTranslation("Docで3件のプロジェクトを管理します", source, "ja", "tagline")).toEqual({ ok: false, reason: "term_lost" });
  expect(checkProductTranslation("Docで3件のAPIプロジェクトを管理します", source, "zh-Hans", "tagline").ok).toBe(false);
  expect(detectTranslationSourceLocale("文書を整理するツールです")).toBe("ja");
  expect(detectTranslationSourceLocale("管理工具")).toBeNull();
});

it("adds Japanese instructions only to a batch that asks for Japanese", () => {
  const item = { name: source.name, locale: "ja" as const, field: "tagline" as const, text: source.tagline };
  const wire = JSON.parse(productTranslationGatewayWire([item], "Qwen/Qwen3.8-27B"));
  expect(wire.messages[0].content).toContain("For ja, translate into natural Japanese");
  expect(JSON.parse(wire.messages[1].content)[0]).toMatchObject(item);
});

it("advertises active languages only and keeps Japanese products unindexed until their fields are ready", () => {
  const languages = localizedAlternates("ja", "/p/doc").languages!;
  expect(languages).toHaveProperty("ja");
  expect(languages).not.toHaveProperty("zh-Hant");
  expect(productReadyLocales(source, [])).not.toContain("ja");
});

it("generates only product native branches, preserving historic rules and all source restrictions", () => {
  expect(japaneseTranslationRules).toHaveLength(5);
  for (const rule of japaneseTranslationRules) {
    expect(generated[rule.symbol as keyof typeof generated]).toBe(rule.sql);
    expect(rule.sql).toContain("local-direct");
    expect(rule.sql).toContain("ja");
    expect(rule.sql).not.toMatch(/sourceLocale|search-query-translate|reason-translate/);
  }
  const migration = japaneseTranslationMigration();
  expect(readFileSync("drizzle/0184_japanese_product_translation.sql", "utf8")).toBe(migration);
  expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/);
  expect(migration).not.toContain("ALTER TABLE model_capacity_requests");
});
