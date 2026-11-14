"use client";

import { CompactRowMarkup } from "@/components/cards/markup";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import type { CompactCardItem } from "@/components/home/compact-item";
import "./cards.css";

/**
 * 가로 띠의 브라우저 부품판 — 상세 '같은 분야'(브라우저가 API 로 받은 값)가 쓴다.
 * 홈·없는 주소는 서버가 같은 마크업(CompactRowMarkup)으로 그린다(components/home/CompactRowServer.tsx).
 */
export function CompactRow(props: {
  id: string;
  title: string;
  note?: React.ReactNode;
  summary?: React.ReactNode;
  more?: { href: string; label: string };
  items: CompactCardItem[];
  trailing: "category" | "listed";
  priority?: boolean;
}) {
  const ctx = { locale: useLocale(), t: useTranslations("labels"), now: useServerNow() };
  return <CompactRowMarkup {...props} ctx={ctx} />;
}
