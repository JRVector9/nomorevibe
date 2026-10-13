import { defineCatalog } from "@/lib/i18n/messages";
import type { globalError as KoreanGlobalError } from "@/messages/ko/global-error";

export const globalError = defineCatalog<typeof KoreanGlobalError>()({
  title: "错误",
  heading: "无法加载网站",
  description: "这可能是暂时的问题。请重试；如果问题持续，请稍后再来。",
  retry: "重试",
  home: "返回首页",
  reference: "错误编号 {digest}",
});
