"use client";

import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/locales";
import type { Dictionary } from "@/lib/i18n/messages";
import { detail } from "@/messages/ko/detail";

const KOREAN = { detail };

/**
 * 제품 상세의 사전(detail). 한국어는 이 JS 조각에 함께 실린다 — 상세마다 HTML 에 35KB 사전을 다시 싣지 않는다.
 * 다른 언어는 서버가 고른 사전을 넘긴다.
 */
export function DetailMessages({ locale, messages, now, children }: {
  locale: Locale;
  /** 한국어면 null — 이 조각의 사전을 쓴다 */
  messages: Dictionary["detail"] | null;
  now?: string;
  children: ReactNode;
}) {
  const dictionaries = locale === "ko" ? KOREAN : messages ? { detail: messages } : null;
  if (!dictionaries) throw new Error(`Missing detail messages: ${locale}`);
  return <I18nProvider locale={locale} dictionaries={dictionaries} now={now}>{children}</I18nProvider>;
}
