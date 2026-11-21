export const QUERY_SOURCE_LOCALES = ["ko", "zh-Hans", "zh-Hant", "ja", "han"] as const;
export type QuerySourceLocale = (typeof QUERY_SOURCE_LOCALES)[number];
export type LegacyQuerySourceLocale = Extract<QuerySourceLocale, "ko" | "zh-Hans" | "zh-Hant">;

/** Preserve the original search policy for existing callers and cache entries. */
export function legacyQuerySourceLocale(text: string): LegacyQuerySourceLocale | null {
  if (/[가-힣]/.test(text)) return "ko";
  if (/[぀-ヿ]/u.test(text)) return null;
  const simplified = /软件|代码|数据库|文件夹|浏览器|网页|导出|开源|人工智能|图像识别|语音识别|自动化/.test(text);
  const traditional = /軟體|程式碼|資料庫|資料夾|瀏覽器|網頁|匯出|開源|人工智慧|圖像辨識|語音辨識/.test(text);
  return simplified && !traditional ? "zh-Hans" : traditional && !simplified ? "zh-Hant" : null;
}

/** The query supplies the language evidence, independently of the interface locale. */
export function multilingualQuerySourceLocale(text: string): QuerySourceLocale | null {
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
  const unambiguous = legacyQuerySourceLocale(text);
  if (unambiguous) return unambiguous;
  return /\p{Script=Han}/u.test(text) ? "han" : null;
}

/** The Chinese/Japanese keyword prompt is versioned separately from the Korean prompt. */
export const MULTILINGUAL_QUERY_PROMPT_VERSION = 2;
export function usesMultilingualQueryPrompt({ sourceLocale, promptVersion }: { sourceLocale: QuerySourceLocale; promptVersion: number }): boolean {
  return sourceLocale !== "ko" && promptVersion === MULTILINGUAL_QUERY_PROMPT_VERSION;
}
