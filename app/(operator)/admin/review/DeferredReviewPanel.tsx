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
  return <details className="panel" open={expanded} onToggle={event => {
    const open = event.currentTarget.open;
    if (open === expanded) return;
    const query = new URLSearchParams(searchParams.toString());
    if (open) query.set(`review_${panel}`, "1");
    else query.delete(`review_${panel}`);
    const search = query.toString();
    router.replace(`${pathname}${search ? `?${search}` : ""}`, { scroll: false });
  }}><summary>{title}</summary>{expanded ? children : <p className="panel-body small muted" role="status">선택한 패널을 불러오는 중입니다.</p>}</details>;
}
