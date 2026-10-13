import "server-only";
import { isLocale, type Locale } from "./locales";
import { createTranslator, type Dictionary, type Namespace, type Translator } from "./messages";

const loaders = {
  ko: { common: () => import("@/messages/ko/common").then((module) => module.common), labels: () => import("@/messages/ko/labels").then((module) => module.labels), browse: () => import("@/messages/ko/browse").then((module) => module.browse), detail: () => import("@/messages/ko/detail").then((module) => module.detail) },
  en: { common: () => import("@/messages/en/common").then((module) => module.common), labels: () => import("@/messages/en/labels").then((module) => module.labels), browse: () => import("@/messages/en/browse").then((module) => module.browse), detail: () => import("@/messages/en/detail").then((module) => module.detail) },
  "zh-Hans": { common: () => import("@/messages/zh-Hans/common").then((module) => module.common), labels: () => import("@/messages/zh-Hans/labels").then((module) => module.labels), browse: () => import("@/messages/zh-Hans/browse").then((module) => module.browse), detail: () => import("@/messages/zh-Hans/detail").then((module) => module.detail) },
  "zh-Hant": { common: () => import("@/messages/zh-Hant/common").then((module) => module.common), labels: () => import("@/messages/zh-Hant/labels").then((module) => module.labels), browse: () => import("@/messages/zh-Hant/browse").then((module) => module.browse), detail: () => import("@/messages/zh-Hant/detail").then((module) => module.detail) },
} satisfies Record<Locale, { [N in Namespace]: () => Promise<Dictionary[N]> }>;

/** Load just one requested locale and namespace on the server. */
export async function getDictionary<N extends Namespace>(locale: Locale, namespace: N): Promise<Dictionary[N]> {
  if (!isLocale(locale)) throw new Error("Unsupported locale");
  return loaders[locale][namespace]();
}

export async function getTranslator<N extends Namespace>(locale: Locale, namespace: N): Promise<Translator<N>> {
  return createTranslator(namespace, await getDictionary(locale, namespace));
}
