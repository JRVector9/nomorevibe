import { defineCatalog } from "@/lib/i18n/messages";
import type { globalError as KoreanGlobalError } from "@/messages/ko/global-error";

export const globalError = defineCatalog<typeof KoreanGlobalError>()({
  title: "錯誤",
  heading: "無法載入網站",
  description: "這可能是暫時的問題。請重試；若問題持續，請稍後再來。",
  retry: "重試",
  home: "返回首頁",
  reference: "錯誤編號 {digest}",
});
