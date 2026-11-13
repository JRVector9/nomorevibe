import { defineCatalog } from "@/lib/i18n/messages";
import type { globalError as Schema } from "@/messages/ko/global-error";

/** The root failure slice stays small because every locale ships to the browser. */
export const globalError = defineCatalog<typeof Schema>()({
  "title": "エラー",
  "heading": "読み込めませんでした",
  "description": "しばらくして再試行してください。",
  "retry": "再試行",
  "home": "ホームへ",
  "reference": "参照番号 {digest}",
});
