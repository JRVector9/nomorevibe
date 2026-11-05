"use client";

import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** A closed details element must not start its expensive server reader. */
export function DeferredReviewPanel({ panel, expanded, title, children }: {
  panel: "filters" | "management";
  expanded: boolean;
  title: string;
  children?: ReactNode;
}) {
  const router = useRouter(), pathname = usePathname(), searchParams = useSearchParams();
  return <details className="panel" data-review-panel={panel} open={expanded} onToggle={event => {
    const open = event.currentTarget.open;
    if (open === expanded) return;
    const query = new URLSearchParams(searchParams.toString());
    // Two panels can toggle before the first navigation commits its search params.
    // Preserve their current native open states rather than an older URL snapshot.
    const panels = event.currentTarget.closest("main")?.querySelectorAll<HTMLDetailsElement>("details[data-review-panel]");
    panels?.forEach(detail => {
      const key = detail.dataset.reviewPanel;
      if (key !== "filters" && key !== "management") return;
      if (detail.open) query.set(`review_${key}`, "1");
      else query.delete(`review_${key}`);
    });
    if (open) query.set(`review_${panel}`, "1");
    else query.delete(`review_${panel}`);
    const search = query.toString();
    router.replace(`${pathname}${search ? `?${search}` : ""}`, { scroll: false });
  }}><summary>{title}</summary>{expanded ? children : <p className="panel-body small muted" role="status">선택한 패널을 불러오는 중입니다.</p>}</details>;
}
