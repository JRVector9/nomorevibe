"use client";

import { useEffect, useEffectEvent, useRef } from "react";

/** Load once per downward scroll, never because the previous request finished while the sentinel stayed visible. */
export function AsyncScrollBoundary({ hasMore, loading, error, onLoad, label = "다음 30개" }: {
  hasMore: boolean; loading: boolean; error: string | null; onLoad: () => void; label?: string;
}) {
  const boundary = useRef<HTMLDivElement>(null), armed = useRef(false);
  const request = useEffectEvent(() => {
    if (!armed.current || loading || !hasMore || error) return;
    armed.current = false;
    onLoad();
  });
  useEffect(() => {
    const node = boundary.current;
    if (!node) return;
    const scrollRoot = node.closest<HTMLElement>(".table-scroll");
    const positions = new WeakMap<Element, number>();
    if (document.scrollingElement) positions.set(document.scrollingElement, window.scrollY);
    if (scrollRoot) positions.set(scrollRoot, scrollRoot.scrollTop);
    const visible = () => {
      const box = node.getBoundingClientRect(), clip = scrollRoot?.getBoundingClientRect();
      const top = Math.max(0, clip ? clip.top + scrollRoot!.clientTop : 0);
      const bottom = Math.min(window.innerHeight, clip ? clip.top + scrollRoot!.clientTop + scrollRoot!.clientHeight : window.innerHeight);
      return bottom > top && box.top < bottom && box.bottom > top;
    };
    const scroll = (event: Event) => {
      const target = event.target instanceof HTMLElement ? event.target : document.scrollingElement;
      // An unrelated table/side panel must not arm this list's next page.
      if (!target || !target.contains(node)) return;
      const top = target.scrollTop, previous = positions.get(target) ?? top;
      positions.set(target, top);
      if (top > previous) { armed.current = true; if (visible()) request(); }
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(items => {
      if (items.some(item => item.isIntersecting) && visible()) request();
    }, { root: scrollRoot });
    observer?.observe(node);
    window.addEventListener("scroll", scroll, { capture: true, passive: true });
    return () => { observer?.disconnect(); window.removeEventListener("scroll", scroll, true); };
  }, []);
  return <div ref={boundary} className="panel-foot" data-scroll-boundary>
    <div className="flex between" aria-live="polite">
      <span className="small muted" role="status">{loading ? `${label}를 읽는 중…` : error || (hasMore ? "아래로 스크롤하면 다음 목록을 불러옵니다." : "목록을 모두 확인했습니다.")}</span>
      {hasMore && <button type="button" className="button small" disabled={loading} onClick={() => { armed.current = false; onLoad(); }}>{error ? "다시 시도" : `${label} 불러오기`}</button>}
    </div>
  </div>;
}
