"use client";

import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/locales";
import type { Dictionary } from "@/lib/i18n/messages";
import { browse } from "@/messages/ko/browse";

const KOREAN = { browse };

/**
 * 홈·목록의 사전(browse). 한국어는 이 JS 조각에 함께 실린다 — 홈 HTML 마다 28KB 사전을 다시 싣지 않는다.
 * 다른 언어는 서버가 고른 사전을 넘긴다.
 */
export function BrowseMessages({ locale, messages, now, children }: {
  locale: Locale;
  /** 한국어면 null — 이 조각의 사전을 쓴다 */
  messages: Dictionary["browse"] | null;
  now?: string;
  children: ReactNode;
}) {
  const dictionaries = locale === "ko" ? KOREAN : messages ? { browse: messages } : null;
  if (!dictionaries) throw new Error(`Missing browse messages: ${locale}`);
  return <I18nProvider locale={locale} dictionaries={dictionaries} now={now}>{children}</I18nProvider>;
}
