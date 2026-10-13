import { defineCatalog } from "@/lib/i18n/messages";
import type { globalError as KoreanGlobalError } from "@/messages/ko/global-error";

export const globalError = defineCatalog<typeof KoreanGlobalError>()({
  title: "Error",
  heading: "We couldn't load the site",
  description: "This may be a temporary issue. Try again, or come back in a little while if it continues.",
  retry: "Try again",
  home: "Go to home",
  reference: "Error reference {digest}",
});
