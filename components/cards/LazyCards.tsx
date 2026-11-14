"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProductCardsResponse } from "@/app/api/product-cards/route";
import Link from "next/link";
import { CompactCard } from "@/components/home/CompactCard";
import { CompactRow } from "@/components/home/CompactRow";
import { ProjectCard } from "@/components/home/ProjectCard";
import { useSavedSlugs } from "@/components/home/useSavedSlugs";
import { useLocale, useTranslations } from "@/lib/i18n/context";

/**
 * 첫 화면에 보이지 않는 카드(2026-11-14 공개 HTML 줄이기) — 서버 HTML 에 싣지 않고 열 때 같은 출처 API(/api/product-cards)로 받는다.
 * 받는 동안은 글자 없는 자리(aria-busy)만 둔다(공개 화면 대기 문구 없음).
 */
type Items = ProductCardsResponse["items"];
const loads = new Map<string, Promise<Items | null>>();

function loadCards(query: string): Promise<Items | null> {
  let load = loads.get(query);
  if (!load) {
    load = fetch(`/api/product-cards?${query}`, { headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? (await response.json() as ProductCardsResponse).items : null)
      .catch(() => null);
    load.then((items) => { if (!items) loads.delete(query); });
    loads.set(query, load);
  }
  return load;
}

/** query 가 null 이면 아직 받지 않는다 */
function useCards(query: string | null): { items: Items | null; done: boolean } {
  const [state, setState] = useState<{ query: string | null; items: Items | null; done: boolean }>({ query, items: null, done: false });
  useEffect(() => {
    if (query === null) return;
    let alive = true;
    loadCards(query).then((items) => { if (alive) setState({ query, items, done: true }); });
    return () => { alive = false; };
  }, [query]);
  return query !== null && state.query === query ? state : { items: null, done: false };
}

/** 홈 '많이 쓰이는 프로젝트'의 다른 구간 — 탭을 처음 고를 때 받는다 */
export function LazyRankedPanel({ tier, personal }: { tier: string; personal: boolean }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const [saved, toggle] = useSavedSlugs();
  const { items, done } = useCards(new URLSearchParams({ list: "popular", tier, ...(personal ? { personal: "1" } : {}), locale }).toString());
  if (!done) return <div aria-busy="true" className="projects-grid" style={{ minHeight: 180 }} />;
  if (!items?.length) return <p className="popular-empty">{t(items ? "popular.empty" : "error.load")}</p>;
  return (
    <div className="projects-grid">
      {items.map((product) => <ProjectCard key={product.slug} product={product} rank={product.rank} saved={saved.has(product.slug)} onToggleSave={toggle} />)}
    </div>
  );
}

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
 * JS 없이도 '모두 보기'(서버가 그린 전체 목록)로 간다.
 */
export function LazyCompactRow({ id, title, note, more, list, trailing }: {
  id: string; title: string; note?: ReactNode; more: { href: string; label: string }; list: string; trailing: "category" | "listed";
}) {
  const locale = useLocale();
  const [ref, near] = useNearViewport<HTMLElement>();
  const { items, done } = useCards(near ? new URLSearchParams({ list, locale }).toString() : null);
  // 받아 보니 비었으면 서버 띠와 같이 구획째 그리지 않는다
  if (done && !items?.length) return null;
  return (
    <section ref={ref} id={id} className="row-section" aria-labelledby={`${id}-title`}>
      <div className="row-head">
        <div>
          <h2 id={`${id}-title`} className="row-title">{title}</h2>
          {note && <p className="row-note">{note}</p>}
        </div>
        <Link prefetch={false} className="row-more" href={more.href}>{more.label} ›</Link>
      </div>
      {items?.length ? <div className="compact-grid">{items.map((product) => <CompactCard key={product.slug} product={product} trailing={trailing} />)}</div>
        : <div aria-busy="true" className="compact-grid" style={{ minHeight: 120 }} />}
    </section>
  );
}

/** 없는 주소 화면의 '지금 뜨는' — 이 화면은 모든 공개 화면의 RSC 데이터에 404 경계로 실려, 카드를 열 때 받는다 */
export function NotFoundRising({ title, more }: { title: string; more: { href: string; label: string } }) {
  const locale = useLocale();
  const { items } = useCards(new URLSearchParams({ list: "rising", locale }).toString());
  if (!items?.length) return null;
  return <CompactRow id="rising" title={title} items={items} trailing="category" more={more} />;
}
