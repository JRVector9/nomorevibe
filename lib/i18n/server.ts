import "server-only";
import { headers } from "next/headers";
import { DEFAULT_LOCALE, isLocale, PUBLIC_LOCALE_HEADER, type Locale } from "./locales";

/** Server Components only. Actions and Route Handlers validate an explicit locale. */
export async function getRequestLocale(): Promise<Locale> {
  const value = (await headers()).get(PUBLIC_LOCALE_HEADER);
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
