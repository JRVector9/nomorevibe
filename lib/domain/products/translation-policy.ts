import { createHash } from "node:crypto";
import { isLocale, type Locale } from "@/lib/i18n/locales";
import type { ProductTranslation, ProductTranslationField, ProductTranslationLocale } from "@/lib/db/schema";
import { hasEnglishEvidence } from "@/lib/i18n/content-language";

export const PRODUCT_TRANSLATION_POLICY = "public-fields-v1";
export const PRODUCT_TRANSLATION_MAX_ATTEMPTS = 4;
export const PRODUCT_TRANSLATION_DEMAND_LIMIT = 80;
export type ProductTranslationSource = { id: number; name: string; tagline: string; description?: string };
export const translationSourceText = (source: ProductTranslationSource, field: ProductTranslationField): string =>
  field === "tagline" ? source.tagline : source.description ?? "";

export function productTranslationSourceHash(source: ProductTranslationSource, field: ProductTranslationField): string {
  if (!isProductTranslationField(field)) throw new Error("invalid_translation_field");
  return createHash("sha256").update(JSON.stringify([
    PRODUCT_TRANSLATION_POLICY, source.name, field, translationSourceText(source, field),
  ])).digest("hex");
}

export function isProductTranslationField(value: unknown): value is ProductTranslationField {
  return value === "tagline" || value === "description";
}

// Script evidence alone is insufficient for Chinese (Japanese also uses Han).
// Validation evidence only, never a script-conversion implementation.
const SCRIPT_PAIRS = ["软軟", "码碼", "数數", "据據", "户戶", "网網", "应應", "导導", "动動", "云雲", "开開", "关關", "务務", "创創", "项項",
  "简簡", "体體", "汉漢", "语語", "让讓", "时時", "间間", "为為", "门門", "学學", "习習", "译譯", "设設", "计計", "变變", "换換",
  "载載", "储儲", "认認", "证證", "标標", "识識", "话話", "这這", "个個", "页頁", "扩擴", "览覽", "图圖", "书書", "联聯", "络絡",
  "线線", "键鍵", "盘盤", "驱驅", "读讀", "写寫", "详詳", "细細", "录錄", "资資", "库庫", "发發", "浏瀏", "夹夾"];
const HANS = new RegExp(`[${SCRIPT_PAIRS.map((pair) => pair[0]).join("")}]`, "u");
const HANT = new RegExp(`[${SCRIPT_PAIRS.map((pair) => pair[1]).join("")}]`, "u");
const CHINESE_WORDS = /软件|軟體|代码|代碼|数据|數據|用户|用戶|应用|應用|支持|管理|工具|平台|文件|自动|自動|创建|建立/gu;

/** Conservative evidence only; ASCII, generic Han and short names remain unknown. */
export function detectTranslationSourceLocale(text: string): Locale | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length && words.filter((word) => /[가-힣]/u.test(word)).length * 2 >= words.length
    && (text.match(/[가-힣]/gu)?.length ?? 0) >= 3) return "ko";
  if (/[가-힣぀-ヿ]/u.test(text)) return null;
  if (/[㐀-䶿一-鿿]/u.test(text)) {
    if (new Set(text.match(CHINESE_WORDS) ?? []).size < 2) return null;
    if (HANS.test(text) && !HANT.test(text)) return "zh-Hans";
    if (HANT.test(text) && !HANS.test(text)) return "zh-Hant";
    return null;
  }
  return hasEnglishEvidence(text) ? "en" : null;
}

export type ProductTranslationSelection = {
  text: string; lang: Locale | undefined; translated: boolean; ready: boolean; pending: boolean;
  sourceHash: string; sourceLocale: Locale | null;
  provenance?: ProductTranslation["provenance"]["kind"];
};
export type ProductTranslationReadiness = Pick<ProductTranslation,
  "productId" | "locale" | "field" | "sourceHash" | "status" | "text" | "errorCode"> & {
    provenance?: ProductTranslation["provenance"];
  };

/** Pure rendering decision; Korean callers continue to use their current taglineKo path. */
export function selectProductTranslation(
  source: ProductTranslationSource, locale: Locale, field: ProductTranslationField, translation?: ProductTranslationReadiness | null,
): ProductTranslationSelection {
  if (!isLocale(locale)) throw new Error("invalid_translation_locale");
  const text = translationSourceText(source, field);
  const sourceHash = productTranslationSourceHash(source, field);
  const sourceLocale = detectTranslationSourceLocale(text);
  if (translation?.productId === source.id && translation.locale === locale && translation.field === field
    && translation.sourceHash === sourceHash && ["ready", "reviewed"].includes(translation.status)
    && translation.text && !translation.errorCode) {
    return { text: translation.text, lang: locale, translated: true, ready: true, pending: false, sourceHash, sourceLocale,
      provenance: translation.provenance?.kind };
  }
  const ready = !text.trim() || sourceLocale === locale;
  return { text, lang: sourceLocale ?? undefined, translated: false, ready, pending: !ready, sourceHash, sourceLocale };
}

const MARKUP = /<\/?[a-z][^>]*>|```|\]\(\s*(?:javascript|data):|\bon\w+\s*=/i;
const BOILERPLATE = /^(?:translation|translated text|here is|as an ai|i cannot|翻译|翻譯|译文|譯文)\s*[:：]|i'?m sorry/i;
const URL = /https?:\/\/[^\s<>"\])]+/g;
const QUOTE = /"[^"\n]{2,}"|“[^”\n]{2,}”|「[^」\n]{2,}」/g;
const NUMBERS = /[+\-−＋－]?\p{Nd}+(?:[.,]\p{Nd}+)*/gu;
// Semantic vocabulary is checked separately from script; 軟件/數據庫 alone is not a reviewed Hant translation.
const WRONG_TERMS: Record<ProductTranslationLocale, readonly string[]> = {
  en: [],
  "zh-Hans": ["軟體", "軟件", "程式碼", "資料庫", "伺服器", "瀏覽器", "檔案", "匯出"],
  "zh-Hant": ["软件", "軟件", "代码", "數據庫", "数据库", "服務器", "服务器", "浏览器", "文件夹", "文件夾", "导出"],
};

function tokensPreserved(source: string, output: string, pattern: RegExp): boolean {
  const counts = (text: string) => {
    const result = new Map<string, number>();
    for (const value of text.match(pattern) ?? []) {
      result.set(value, (result.get(value) ?? 0) + 1);
    }
    return result;
  };
  const original = counts(source), translated = counts(output);
  return original.size === translated.size && [...original].every(([token, count]) => translated.get(token) === count);
}

export type ProductTranslationCheck = { ok: true; text: string } | { ok: false; reason: string };
export function checkProductTranslation(
  output: string, source: ProductTranslationSource, locale: ProductTranslationLocale, field: ProductTranslationField,
): ProductTranslationCheck {
  if (!isLocale(locale) || (locale as Locale) === "ko" || !isProductTranslationField(field)) return { ok: false, reason: "invalid_target" };
  const text = output.trim();
  const original = translationSourceText(source, field);
  if (!text) return { ok: false, reason: "empty" };
  if ([...text].length > (field === "tagline" ? 360 : 8_000)) return { ok: false, reason: "too_long" };
  if (field === "tagline" && /[\r\n]/.test(text)) return { ok: false, reason: "multiline" };
  if (MARKUP.test(text) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return { ok: false, reason: "markup" };
  if (BOILERPLATE.test(text)) return { ok: false, reason: "boilerplate" };
  if (source.name.trim().length >= 2 && original.includes(source.name) && !text.includes(source.name)) return { ok: false, reason: "name_lost" };
  const names = original.match(/\b(?:[A-Z]{2,}[A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/g) ?? [];
  if (names.some((name) => !text.includes(name))) return { ok: false, reason: "term_lost" };
  if (!tokensPreserved(original, text, NUMBERS)) return { ok: false, reason: "number_changed" };
  if (!tokensPreserved(original, text, URL) || !tokensPreserved(original, text, QUOTE)) return { ok: false, reason: "citation_changed" };
  const prose = text.replaceAll(source.name, "").replace(URL, "").replace(QUOTE, "");
  if (locale === "en") {
    if (!/[A-Za-z]{2,}/.test(prose) || /[가-힣㐀-䶿一-鿿぀-ヿ]/u.test(prose)) return { ok: false, reason: "not_english" };
    if (detectTranslationSourceLocale(prose) !== "en") return { ok: false, reason: "english_uncertain" };
  } else {
    if ((prose.match(/[㐀-䶿一-鿿]/gu)?.length ?? 0) < 2 || /[가-힣぀-ヿ]/u.test(prose)) return { ok: false, reason: "not_chinese" };
    if ((locale === "zh-Hans" ? HANT : HANS).test(prose)) return { ok: false, reason: "wrong_script" };
    if (WRONG_TERMS[locale].some((term) => prose.includes(term))) return { ok: false, reason: "wrong_term" };
  }
  return { ok: true, text };
}
