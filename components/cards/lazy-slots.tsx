"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 첫 화면 밖 카드의 자리(2026-11-14 공개 HTML 줄이기) — 카드 그리기 코드(LazyCards.tsx)는 자리가 쓰일 때 불러온다.
 * 없는 주소 화면은 모든 공개 화면에 404 경계로 실리므로, 여기서 카드 코드를 바로 가져오면 모든 화면의 첫 로드 JS 가 커진다.
 */
const placeholder = (minHeight: number, className: string) => function Placeholder() {
  return <div aria-busy="true" className={className} style={{ minHeight }} />;
};

export const LazyRankedPanelSlot = dynamic(() => import("./LazyCards").then((module) => module.LazyRankedPanel),
  { ssr: false, loading: placeholder(180, "projects-grid") });
export const NotFoundRisingSlot = dynamic(() => import("./LazyCards").then((module) => module.NotFoundRising), { ssr: false });
const LazyCompactCards = dynamic(() => import("./LazyCards").then((module) => module.LazyCompactCards),
  { ssr: false, loading: placeholder(120, "compact-grid") });

/** 화면 가까이 오면 true — 첫 화면 아래 구획은 그때 받는다(IntersectionObserver 가 없으면 바로) */
function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (near || !node) return;
    if (typeof IntersectionObserver === "undefined") { queueMicrotask(() => setNear(true)); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setNear(true); }, { rootMargin: "600px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near];
}

/**
 * 홈 첫 화면 아래의 가로 띠('이번 주 새로 나온') — 제목·설명·모두 보기는 서버 HTML 에 두고, 카드는 화면 가까이 오면 받는다.
 * JS 없이도 '모두 보기'(서버가 그린 전체 목록)로 간다. 받아 보니 비었으면 서버 띠처럼 구획째 그리지 않는다.
 */
export function LazyCompactRow({ id, title, note, more, list, trailing }: {
  id: string; title: string; note?: ReactNode; more: { href: string; label: string }; list: string; trailing: "category" | "listed";
}) {
  const [ref, near] = useNearViewport<HTMLElement>();
  const [empty, setEmpty] = useState(false);
  const onEmpty = useCallback(() => setEmpty(true), []);
  if (empty) return null;
  return (
    <section ref={ref} id={id} className="row-section" aria-labelledby={`${id}-title`}>
      <div className="row-head">
        <div>
          <h2 id={`${id}-title`} className="row-title">{title}</h2>
          {note && <p className="row-note">{note}</p>}
        </div>
        <Link prefetch={false} className="row-more" href={more.href}>{more.label} ›</Link>
      </div>
      {near ? <LazyCompactCards list={list} trailing={trailing} onEmpty={onEmpty} />
        : <div aria-busy="true" className="compact-grid" style={{ minHeight: 120 }} />}
    </section>
  );
}
