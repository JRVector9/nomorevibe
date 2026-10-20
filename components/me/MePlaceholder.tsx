import { getTranslator } from "@/lib/i18n/dictionary";
import { getRequestLocale } from "@/lib/i18n/server";

/** 아직 구현하지 않은 탭 자리 */
export async function MePlaceholder() {
  const t = await getTranslator(await getRequestLocale(), "me");
  return <p className="me-placeholder" role="status">{t("placeholder")}</p>;
}
