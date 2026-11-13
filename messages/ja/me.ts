import { defineCatalog } from "@/lib/i18n/messages";
import type { me as Schema } from "@/messages/ko/me";
import { me as english } from "@/messages/en/me";

/** Product content is Japanese; untranslated support/account/policy copy explicitly falls back to English. */
export const me = defineCatalog<typeof Schema>()({
  ...english,
});
