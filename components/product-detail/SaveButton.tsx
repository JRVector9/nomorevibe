"use client";

import { useTranslations } from "@/lib/i18n/context";
import { useMemo, useSyncExternalStore } from "react";
import { Icon } from "@/components/home/icons";
import { parseSaved, savedSnapshot, subscribeSaved, toggleSaved } from "@/components/home/saved";
import { hiddenByDefault } from "@/lib/domain/products/visibility";
import { trackAttrs } from "@/lib/analytics/attrs";

/**
 * 저장할 수 있는 제품인가 — 계정 저장(lib/me/saved.ts savedPublic)과 같은 공개 조건: 검증·시드 제품이고, 개인 프로필은 주인이 있을 때만.
 * 상세는 검증 전·주인 없는 프로필도 열린다. 거기서 저장하면 계정이 받지 않고 저장 탭에도 카드가 없다
 */
export function savableProduct(product: { status: string; category: string | null }, unclaimed: boolean): boolean {
  return (product.status === "verified" || product.status === "seeded") && !(hiddenByDefault(product.category) && unclaimed);
}

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
