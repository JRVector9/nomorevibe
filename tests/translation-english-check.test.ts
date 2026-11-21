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

  // Synthetic refusals/meta answers (reviewer corpus E plus earlier cases); the source is Korean, so none can be exempt.
  it.each([
    "I cannot translate this text", "I can't translate this.", "I'm unable to translate this.", "Sorry, I am unable to translate the input.",
    "Sorry I can't help with that", "The text is already in English.", "The provided text is already in English.", "This is already English",
    "Already English.", "No translation needed", "No translation required.", "Translation not needed", "There is nothing to translate",
    "This is a product name and should not be translated.", "This text cannot be translated", "As an AI language model, I cannot help",
    "Sure, here it is", "Here is the translation: Document organizer", "As requested, here is the English version", "English: Document organizer",
    "Same as the original.", "(no change)", "Unchanged", "Not applicable", "[Untranslated]", "Untranslated", "Note: this is a proper noun",
    "I don't know.", "Original text kept as is", "The input appears to be Korean.", "Please provide the text to translate.", "TODO",
    "Lorem ipsum dolor sit amet", "N/A", "None",
  ])("rejects a refusal or meta answer: %s", (text) => {
    expect(checkProductTranslation(text, source, "en", "tagline")).toEqual({ ok: false, reason: "boilerplate" });
  });

  it.each([
    "A dictionary of words that cannot be translated", "Multilingual keyboard with no translation needed", "I am an AI that writes haiku",
    "Sorry! board game score keeper", "Okay, let's plan your week", "Sure, a todo app, but offline", "Translate memes that can't be translated",
    "Unfortunately, it works", "Of course, another weather app", "None of your business: a private journal", "Translate the untranslatable",
  ])("keeps an ordinary tagline that only mentions translation or opens like a reply: %s", (text) => {
    expect(checkProductTranslation(text, source, "en", "tagline")).toEqual({ ok: true, text });
  });

  it("lets an English source that itself contains a refusal phrase be echoed", () => {
    const tagline = "Sure, here is a todo app";
    expect(checkProductTranslation(tagline, source, "en", "tagline")).toEqual({ ok: false, reason: "boilerplate" });
    expect(checkProductTranslation(tagline, { ...source, tagline }, "en", "tagline")).toEqual({ ok: true, text: tagline, sourceNative: true });
  });

  // The other-language rule for CHANGED answers is a heuristic: a known-word list plus "under a third of the words are English".
  it.each(["Kalkulator zakat", "Skripsi informatika", "Kumpulan resep masakan", "Calculadora de propinas",
    "Gestion budgétaire", "Organizador de documentos", "Hangul matchumbeop geomsagi"])(
    "rejects a short changed answer with too few English words: %s", (text) => {
      expect(checkProductTranslation(text, source, "en", "tagline")).toMatchObject({ ok: false });
    });

  it("documents the limit: short foreign answers built from English-looking words still pass as changed results", () => {
    for (const text of ["Cardápio digital", "Not defteri", "Trabajo práctico final", "Hesap makinesi app"]) {
      expect(checkProductTranslation(text, source, "en", "tagline")).toEqual({ ok: true, text });
      // …but never as an already-English source.
      expect(checkProductTranslation(text, { ...source, tagline: text }, "en", "tagline").ok).toBe(false);
    }
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

// Synthetic stand-ins for the production shape (Latin-script sources failing rejected:english_uncertain, source_locale NULL).
describe("already-English sources the model returns unchanged", () => {
  it.each([
    ["GraphScope", "Genome contact map viewer and curation suite"],
    ["Mingle CRM", "Keep track of meetups, contacts and follow-ups"],
    ["Hue Kit", "Color picker"], ["Lumen", "The lumen mono repo"], ["jarlet", "Jarlet will help you handle jar files"],
    ["Pokédex", "Pokémon card tracker"], ["Málaga Bus", "A client for Málaga bus times"], ["Shelf", "Self-hosted ebook library 📚"],
  ])("%s: %s becomes source_native", (name, tagline) => {
    const product = { id: 7, name, tagline };
    expect(detectTranslationSourceLocale(tagline)).toBeNull(); // still demanded: shared source detection is unchanged
    expect(checkProductTranslation(tagline, product, "en", "tagline")).toEqual({ ok: true, text: tagline, sourceNative: true });
  });

  it("treats dropped emoji or punctuation as unchanged, so the stricter source rule applies", () => {
    const tagline = "Self-hosted ebook library 📚";
    expect(checkProductTranslation("Self hosted ebook library.", { id: 7, name: "Shelf", tagline }, "en", "tagline"))
      .toEqual({ ok: true, text: tagline, sourceNative: true });
    expect(checkProductTranslation("Kalkulator zakat", { id: 7, name: "Zzz", tagline: "Kalkulator zakat 🚀" }, "en", "tagline"))
      .toEqual({ ok: false, reason: "english_uncertain" });
  });

  it("needs positive English evidence: a name plus one word, or unknown words alone, stay english_uncertain", () => {
    for (const tagline of ["Neovim config", "Zorbex platform", "Clanker", "Fizzbuzz quux"]) {
      expect(checkProductTranslation(tagline, { id: 7, name: "Zzz", tagline }, "en", "tagline")).toEqual({ ok: false, reason: "english_uncertain" });
    }
  });

  it.each([
    "Kumpulan catatan kuliah", "Proyecto final de la materia", "Gestion de projets", "Contraseñas seguras", "Programación",
    "Tugas akhir sistem informasi", "Projeto de sistema para loja",
    // words outside every hand list (reviewer corpus): rejected for lack of English words, not for foreign ones
    "Kumpulan resep masakan", "Trabajo práctico final", "Skripsi informatika", "Cardápio digital", "Gestion budgétaire", "Not defteri",
    "Organizador de documentos", "Haushaltsbuch App", "Mietrechner", "Bap mukja", "Hangul matchumbeop geomsagi", "Gyeongbokgung tour gaideu",
    "Kalkulator zakat", "Website portofolio pribadi", "Bot WhatsApp otomatis", "Generator faktur PDF", "Einfacher Passwort-Generator",
    "Enkel budgetapp", "Rekap nilai siswa", "Calculadora propinas",
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
    const product = { id: 7, name: "Hue Kit", tagline: "Color picker" };
    const row = { productId: 7, locale: "en" as const, field: "tagline" as const, sourceHash: productTranslationSourceHash(product, "tagline"),
      status: "ready" as const, text: "Color picker", errorCode: null, provenance: { kind: "source_native" as const, source: "maker", policy: "public-fields-v1" } };
    expect(selectProductTranslation(product, "en", "tagline")).toMatchObject({ ready: false, pending: true });
    expect(selectProductTranslation(product, "en", "tagline", row)).toEqual({ text: "Color picker", lang: "en", translated: false, ready: true,
      pending: false, sourceHash: row.sourceHash, sourceLocale: "en", provenance: "source_native" });
    // SEO readiness rows carry no provenance; ready is still true.
    const { provenance: _drop, ...readiness } = row; void _drop;
    expect(selectProductTranslation(product, "en", "tagline", { ...readiness, text: "present" }).ready).toBe(true);
    // A stale row (source changed) is ignored.
    expect(selectProductTranslation({ ...product, tagline: "Color pickers" }, "en", "tagline", row)).toMatchObject({ ready: false, pending: true });
  });
});

describe("English result evidence", () => {
  const zero = { english: 0, foreign: 0, ambiguous: 0, accented: 0, known: 0, content: 0, unknown: 0, names: 0 };
  it("ignores acronyms and inner capitals, treats other capitalised unknown words as names, and loanwords as English", () => {
    expect(englishResultEvidence("DES and DOS tools")).toEqual({ ...zero, english: 1, known: 2, content: 1 });
    expect(englishResultEvidence("Guide to Las Vegas")).toEqual({ ...zero, english: 1, known: 2, content: 1, names: 2 });
    expect(englishResultEvidence("Los tools")).toEqual({ ...zero, foreign: 1, known: 1, content: 1 });
    expect(englishResultEvidence("café résumé naïve")).toEqual({ ...zero, known: 3, content: 3 });
    expect(englishResultEvidence("Kraków Łódź")).toEqual({ ...zero, foreign: 1, accented: 1 });
    expect(englishResultEvidence("I")).toEqual({ ...zero, known: 1 });
    expect(englishResultEvidence("WhatsApp bot, PDF export, SYSTEM status")).toEqual({ ...zero, known: 4, content: 4 });
    expect(englishResultEvidence("zorbex quux")).toEqual({ ...zero, unknown: 2 });
  });

  it("derives regular inflections and prefixes from lexicon base forms", () => {
    for (const word of ["listings", "tracking", "easily", "unused", "predictions", "self-hosted", "rides", "untracked", "planner"]) {
      expect(englishResultEvidence(word).known, word).toBeGreaterThan(0);
    }
    for (const word of ["otomatis", "pribadi", "kalkulator", "haushaltsbuch", "mukja"]) {
      expect(englishResultEvidence(word).known, word).toBe(0);
    }
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
