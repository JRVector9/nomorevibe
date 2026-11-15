"use client";

import { useEffect, useState } from "react";

/**
 * 다 그린 카드 마크업(markup.tsx·views.tsx — 표지·스타·활동 그리기)은 첫 로드 JS 에 넣지 않는다(PERF-06, 2026-11-15).
 * 서버 HTML 의 카드는 이름·요약 모양(teaser-markup.tsx)이라 첫 그림에는 필요 없고, 채울 값을 받을 즈음 함께 받는다 —
 * 값과 마크업이 둘 다 오기 전에는 이름·요약 모양을 그대로 둬 자리가 바뀌지 않는다.
 */
type MarkupModule = typeof import("./markup");
let loaded: MarkupModule | null = null;
let loading: Promise<MarkupModule> | null = null;

export function loadMarkup(): Promise<MarkupModule> {
  loading ??= import("./markup").then((module) => (loaded = module));
  return loading;
}

export function useMarkup(): MarkupModule | null {
  const [module, setModule] = useState<MarkupModule | null>(loaded);
  useEffect(() => {
    if (module) return;
    let alive = true;
    void loadMarkup().then((value) => { if (alive) setModule(value); });
    return () => { alive = false; };
  }, [module]);
  return module;
}
