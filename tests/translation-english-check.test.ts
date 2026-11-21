import { describe, expect, it } from "vitest";
import { checkProductTranslation, detectTranslationSourceLocale, productTranslationSourceHash, selectProductTranslation } from "@/lib/domain/products/translation-policy";
import { englishResultEvidence } from "@/lib/domain/products/translation-english";
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

  it("treats an unchanged Latin result as the already-English source, stored as the exact source text", () => {
    for (const text of ["Project notes", "  PROJECT   NOTES  ", "Project notes.", "Ｐｒｏｊｅｃｔ notes"]) {
      expect(checkProductTranslation(text, { ...source, tagline: "Project notes" }, "en", "tagline"))
        .toEqual({ ok: true, text: "Project notes", sourceNative: true });
    }
    const text = "A tool for your projects";
    expect(checkProductTranslation(text, { ...source, tagline: ` ${text} ` }, "en", "tagline")).toEqual({ ok: true, text, sourceNative: true });
    // A changed English result stays a machine translation.
    expect(checkProductTranslation("Project notebook", { ...source, tagline: "Project notes" }, "en", "tagline"))
      .toEqual({ ok: true, text: "Project notebook" });
  });

  it("rejects clearly non-English Latin results, changed or unchanged", () => {
    for (const text of ["Gestiona tus proyectos con facilidad", "Verwalten Sie Ihre Projekte einfach", "Organiza tus notas y café",
      "Herramienta para organizar documentos", "Aplikasi kasir sederhana berbasis web", "Basit bir not uygulaması",
      "Jednoduchá aplikace pro správu úkolů", "Outil de gestion des projets avec votre équipe"]) {
      expect(checkProductTranslation(text, source, "en", "tagline")).toEqual({ ok: false, reason: "not_english" });
      expect(detectTranslationSourceLocale(text)).toBeNull();
      expect(checkProductTranslation(text, { ...source, tagline: text }, "en", "tagline")).toEqual({ ok: false, reason: "not_english" });
    }
  });

  it("rejects a romanised Korean answer instead of a translation", () => {
    for (const text of ["Munseoreul jeongrihago timgwa gongyuhaneun dogu", "Iljeongeul gwallihaneun aeb"]) {
      expect(checkProductTranslation(text, { ...source, tagline: "문서를 정리하고 팀과 공유하는 도구" }, "en", "tagline"))
        .toEqual({ ok: false, reason: "not_english" });
    }
  });

  it.each([
    "I cannot translate this text", "I can't translate this.", "Sorry, I am unable to translate the input.",
    "The text is already in English.", "This is already English", "No translation needed", "As an AI language model, I cannot help",
    "Sure, here it is", "N/A", "None", "This text cannot be translated",
  ])("rejects a refusal or meta answer: %s", (text) => {
    expect(checkProductTranslation(text, source, "en", "tagline")).toEqual({ ok: false, reason: "boilerplate" });
  });

  it("lets an English source that itself contains a refusal phrase be echoed", () => {
    const tagline = "A dictionary of untranslatable words";
    expect(checkProductTranslation(tagline, { ...source, tagline }, "en", "tagline")).toEqual({ ok: true, text: tagline, sourceNative: true });
  });

  it("keeps English results with names or idioms that share foreign words", () => {
    for (const text of ["Los Angeles and Las Vegas transit times", "Das Keyboard macro editor", "Roll a die and keep score",
      "Plot x and y coordinates", "We've built a tool for you", "Pokémon card tracker", "Client for Mercado Libre", "A de facto standard linter"]) {
      expect(checkProductTranslation(text, source, "en", "tagline")).toEqual({ ok: true, text });
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

// 2026-11-21 production sample of Latin-script sources failing rejected:english_uncertain (source_locale NULL).
describe("already-English sources the model returns unchanged", () => {
  it.each([
    ["OpenPretext", "A modern, web-based Hi-C contact map viewer and genome assembly curation tool"],
    ["Networking CRM", "Track and follow up on networking contacts and events"],
    ["Box Shadow", "Box shadow"], ["NiiVue", "The niivue mono repo"], ["pycookie", "Pycookie will help you handle cookies"],
    ["Pokédex", "Pokémon card tracker"], ["Málaga Bus", "A client for Málaga bus times"],
  ])("%s: %s becomes source_native", (name, tagline) => {
    const product = { id: 7, name, tagline };
    expect(detectTranslationSourceLocale(tagline)).toBeNull(); // still demanded: shared source detection is unchanged
    expect(checkProductTranslation(tagline, product, "en", "tagline")).toEqual({ ok: true, text: tagline, sourceNative: true });
  });

  it.each([
    "Kumpulan catatan kuliah", "Proyecto final de la materia", "Gestion de projets", "Contraseñas seguras", "Programación",
    "Tugas akhir sistem informasi", "Projeto de sistema para loja",
  ])("does not accept an unchanged non-English source as English: %s", (tagline) => {
    const result = checkProductTranslation(tagline, { id: 7, name: "Zzz", tagline }, "en", "tagline");
    expect(result.ok).toBe(false);
    expect(["english_uncertain", "not_english"]).toContain(!result.ok && result.reason);
  });

  it("rejects an unchanged Hebrew, Cyrillic or Greek source as not English", () => {
    for (const tagline of ["כלי לניהול משימות", "Инструмент для заметок", "Εργαλείο σημειώσεων"]) {
      expect(checkProductTranslation(tagline, { id: 7, name: "Zzz", tagline }, "en", "tagline")).toEqual({ ok: false, reason: "not_english" });
    }
  });

  it("renders a stored source_native row as the source itself: ready, untranslated, English", () => {
    const product = { id: 7, name: "Box Shadow", tagline: "Box shadow" };
    const row = { productId: 7, locale: "en" as const, field: "tagline" as const, sourceHash: productTranslationSourceHash(product, "tagline"),
      status: "ready" as const, text: "Box shadow", errorCode: null, provenance: { kind: "source_native" as const, source: "maker", policy: "public-fields-v1" } };
    expect(selectProductTranslation(product, "en", "tagline")).toMatchObject({ ready: false, pending: true });
    expect(selectProductTranslation(product, "en", "tagline", row)).toEqual({ text: "Box shadow", lang: "en", translated: false, ready: true,
      pending: false, sourceHash: row.sourceHash, sourceLocale: "en", provenance: "source_native" });
    // SEO readiness rows carry no provenance; ready is still true.
    const { provenance: _drop, ...readiness } = row; void _drop;
    expect(selectProductTranslation(product, "en", "tagline", { ...readiness, text: "present" }).ready).toBe(true);
    // A stale row (source changed) is ignored.
    expect(selectProductTranslation({ ...product, tagline: "Box shadows" }, "en", "tagline", row)).toMatchObject({ ready: false, pending: true });
  });
});

describe("English result evidence", () => {
  it("ignores acronyms and capitalised names, and counts loanwords as neutral", () => {
    expect(englishResultEvidence("DES and DOS tools")).toEqual({ english: 1, foreign: 0, ambiguous: 0, accented: 0 });
    expect(englishResultEvidence("Guide to Las Vegas")).toEqual({ english: 1, foreign: 0, ambiguous: 0, accented: 0 });
    expect(englishResultEvidence("Los tools")).toEqual({ english: 0, foreign: 1, ambiguous: 0, accented: 0 });
    expect(englishResultEvidence("café résumé naïve")).toEqual({ english: 0, foreign: 0, ambiguous: 0, accented: 0 });
    expect(englishResultEvidence("Kraków Łódź")).toEqual({ english: 0, foreign: 1, ambiguous: 0, accented: 1 });
    expect(englishResultEvidence("I")).toEqual({ english: 0, foreign: 0, ambiguous: 0, accented: 0 });
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
