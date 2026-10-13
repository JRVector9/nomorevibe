import "server-only";
import { isLocale, type Locale } from "./locales";
import { createTranslator, type Dictionary, type Namespace, type Translator } from "./messages";

const loaders = {
  ko: { common: () => import("@/messages/ko/common").then((module) => module.common) },
  en: { common: () => import("@/messages/en/common").then((module) => module.common) },
  "zh-Hans": { common: () => import("@/messages/zh-Hans/common").then((module) => module.common) },
  "zh-Hant": { common: () => import("@/messages/zh-Hant/common").then((module) => module.common) },
} satisfies Record<Locale, { [N in Namespace]: () => Promise<Dictionary[N]> }>;

/** Load just one requested locale and namespace on the server. */
export async function getDictionary<N extends Namespace>(locale: Locale, namespace: N): Promise<Dictionary[N]> {
  if (!isLocale(locale)) throw new Error("Unsupported locale");
  return loaders[locale][namespace]();
}

export async function getTranslator<N extends Namespace>(locale: Locale, namespace: N): Promise<Translator<N>> {
  return createTranslator(namespace, await getDictionary(locale, namespace));
}
