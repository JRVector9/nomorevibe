import { defineCatalog } from "@/lib/i18n/messages";
import type { globalError as Schema } from "@/messages/ko/global-error";
import { globalError as english } from "@/messages/en/global-error";

/** Product content is Japanese; untranslated support/account/policy copy explicitly falls back to English. */
export const globalError = defineCatalog<typeof Schema>()({
  ...english,
  "title": "エラー",
  "heading": "サイトを読み込めませんでした",
  "description": "一時的な問題の可能性があります。再試行するか、しばらくしてからアクセスしてください。",
  "retry": "再試行",
  "home": "ホームへ",
  "reference": "エラー参照番号 {digest}",
});
