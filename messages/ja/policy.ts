import { defineCatalog } from "@/lib/i18n/messages";
import type { policy as Schema } from "@/messages/ko/policy";
import { policy as english } from "@/messages/en/policy";

/** Product content is Japanese; untranslated support/account/policy copy explicitly falls back to English. */
export const policy = defineCatalog<typeof Schema>()({
  ...english,
});
