import { describe, expect, it } from "vitest";
import { checkProductTranslation, detectTranslationSourceLocale, selectProductTranslation } from "@/lib/domain/products/translation-policy";
import { englishLang, hasEnglishEvidence } from "@/lib/i18n/content-language";
import samples from "./fixtures/translation-english-before3.json";

// Saved Qwen3.8-27B-4bit responses, main a9c53498. No model calls.
// /tmp/xaegis/m1apc/before3.items.jsonl; i/j retain the original batch/member.
const uncertain = samples.filter((row) => row.reason === "english_uncertain");
const source = { id: 1, name: "Acme", tagline: "제품 소개를 번역합니다" };

describe("English product translation result validation", () => {
  it("contains all 23 reported false rejections and the other 44 English members", () => {
    expect(uncertain).toHaveLength(23);
    expect(samples).toHaveLength(67);
  });

  it.each(uncertain)("accepts saved English output $i/$j: $name", (row) => {
    expect(checkProductTranslation(row.out, { id: 0, name: row.name, tagline: row.src }, "en", "tagline"))
      .toEqual({ ok: true, text: row.out });
  });

  it.each(samples.filter((row) => row.ok))("keeps prior acceptance $i/$j: $name", (row) => {
    expect(checkProductTranslation(row.out, { id: 0, name: row.name, tagline: row.src }, "en", "tagline").ok).toBe(true);
  });

  it.each(["한", "漢", "かな", "カナ", "한", "ㄱ", "𠀀", "Привет", "مرحبا"])("rejects mixed non-Latin prose: %s", (text) => {
    expect(checkProductTranslation(`A useful tool for your projects ${text}`, source, "en", "tagline"))
      .toEqual({ ok: false, reason: "not_english" });
  });

  it("rejects unchanged Korean, even with whitespace changes", () => {
    for (const text of [source.tagline, `  ${source.tagline}  `]) {
      expect(checkProductTranslation(text, source, "en", "tagline"))
        .toEqual({ ok: false, reason: "not_english" });
    }
  });

  it("requires changed text for the Latin fallback, but preserves known English originals", () => {
    for (const text of ["Project notes", "  PROJECT   NOTES  "]) {
      expect(checkProductTranslation(text, { ...source, tagline: "Project notes" }, "en", "tagline"))
        .toEqual({ ok: false, reason: "english_uncertain" });
    }
    const text = "A tool for your projects";
    expect(checkProductTranslation(text, { ...source, tagline: text }, "en", "tagline").ok).toBe(true);
  });

  it("documents that changed Spanish/German Latin prose passes this script guard", () => {
    for (const text of ["Gestiona tus proyectos con facilidad", "Verwalten Sie Ihre Projekte einfach", "Organiza tus notas y café"]) {
      expect(checkProductTranslation(text, source, "en", "tagline").ok).toBe(true);
      expect(detectTranslationSourceLocale(text)).toBeNull();
      expect(checkProductTranslation(text, { ...source, tagline: text }, "en", "tagline").ok).toBe(false);
    }
  });

  it("keeps empty, numeric-only, markup, token and quantity checks", () => {
    for (const [text, reason] of [["", "empty"], ["123", "number_changed"], ["<b>Hello</b>", "markup"]]) {
      expect(checkProductTranslation(text, source, "en", "tagline")).toEqual({ ok: false, reason });
    }
    expect(checkProductTranslation("!!!", source, "en", "tagline")).toEqual({ ok: false, reason: "not_english" });
    expect(checkProductTranslation("Client library", { ...source, tagline: "API 클라이언트" }, "en", "tagline"))
      .toEqual({ ok: false, reason: "term_lost" });
    expect(checkProductTranslation("Manage 4 tasks", { ...source, tagline: "작업 3개 관리" }, "en", "tagline"))
      .toEqual({ ok: false, reason: "number_changed" });
  });

  it("applies the result guard to descriptions as well", () => {
    expect(checkProductTranslation("Riichi mahjong tournament management and score calculator", { ...source, description: source.tagline }, "en", "description").ok).toBe(true);
    expect(checkProductTranslation("Project notes 한", { ...source, description: source.tagline }, "en", "description").ok).toBe(false);
  });
});

describe("source language detection remains conservative", () => {
  it.each([
    ["A very experimental Nintendo Switch 2 emulator", null],
    ["C99 client library for Ollama, a port of ollama‑python", null],
    ["Riichi mahjong tournament management and score calculator", null],
    ["Code source", null], ["Gestion de projets", null],
    ["A tool for your projects", "en"], ["Manage meetings", "en"],
    ["한국어 제품 소개입니다", "ko"], ["文書を整理するツールです", "ja"],
    ["软件支持用户管理", "zh-Hans"], ["軟體支持用戶管理", "zh-Hant"], ["管理工具", null],
  ] as const)("keeps %s as %s", (text, locale) => {
    expect(detectTranslationSourceLocale(text)).toBe(locale);
    expect(hasEnglishEvidence(text)).toBe(locale === "en");
    expect(englishLang(text)).toBe(locale === "en" ? "en" : undefined);
    const selected = selectProductTranslation({ ...source, tagline: text }, "en", "tagline");
    expect(selected.sourceLocale).toBe(locale);
    expect(selected.ready).toBe(locale === "en");
  });
});
