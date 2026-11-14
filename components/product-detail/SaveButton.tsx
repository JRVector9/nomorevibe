"use client";

import { useTranslations } from "@/lib/i18n/context";
import { useMemo, useSyncExternalStore } from "react";
import { Icon } from "@/components/home/icons";
import { parseSaved, savedSnapshot, subscribeSaved, toggleSaved } from "@/components/home/saved";
import { trackAttrs } from "@/lib/analytics/attrs";
export { savableProduct } from "./savable";

/** 홈 카드의 북마크와 같은 저장 목록에 넣고 뺀다 — 44px 원형 단추. 로그인 중이면 계정에도 쓴다. 저장할 수 없는 제품(listed=false)이면 그리지 않는다 */
export function SaveButton({ slug, name, listed = true }: { slug: string; name: string; listed?: boolean }) {
  const t = useTranslations("labels");
  const raw = useSyncExternalStore(subscribeSaved, savedSnapshot, () => "[]");
  const saved = useMemo(() => parseSaved(raw), [raw]);
  const on = saved.has(slug);

  function toggle() {
    toggleSaved(slug, !on);
  }

  if (!listed) return null;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={t(on ? "card.unsave" : "card.save", { name })}
      onClick={toggle}
      {...trackAttrs("product_save", { product_slug: slug, action: on ? "unsave" : "save" })}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full bg-bg-soft ${on ? "text-accent" : "text-fg"}`}
    >
      <Icon name="bookmark" size={18} />
    </button>
  );
}
