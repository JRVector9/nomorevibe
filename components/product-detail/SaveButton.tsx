"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Icon } from "@/components/home/icons";
import { parseSaved, persistSaved, savedSnapshot, subscribeSaved } from "@/components/home/saved";

/** 홈 카드의 북마크와 같은 저장 목록에 넣고 뺀다 — 44px 원형 단추 */
export function SaveButton({ slug, name }: { slug: string; name: string }) {
  const raw = useSyncExternalStore(subscribeSaved, savedSnapshot, () => "[]");
  const saved = useMemo(() => parseSaved(raw), [raw]);
  const on = saved.has(slug);

  function toggle() {
    const next = new Set(saved);
    if (on) next.delete(slug);
    else next.add(slug);
    persistSaved(next);
  }

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${name} ${on ? "저장 취소" : "저장"}`}
      onClick={toggle}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full bg-bg-soft ${on ? "text-accent" : "text-fg"}`}
    >
      <Icon name="bookmark" size={18} />
    </button>
  );
}
