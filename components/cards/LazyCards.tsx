"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ProductCardsResponse } from "@/app/api/product-cards/route";
import { CompactCard } from "@/components/home/CompactCard";
import { CompactRow } from "@/components/home/CompactRow";
import { ProjectCard } from "@/components/home/ProjectCard";
import { useSavedSlugs } from "@/components/home/useSavedSlugs";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { useCardList } from "./CardEnrich";
import { PopularRowMarkup, ProjectCardMarkup } from "./markup";
import { SaveToggle } from "./SaveToggle";

/**
 * 첫 화면에 보이지 않는 카드(2026-11-14 공개 HTML 줄이기) — 서버 HTML 에 싣지 않고 열 때 같은 출처 API(/api/product-cards)로 받는다.
 * 이 파일(카드 그리기 코드)은 첫 로드 JS 에 넣지 않는다 — lazy-slots.tsx 가 필요할 때 불러온다.
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

/** 홈 첫 화면 아래 가로 띠의 카드 — 비었으면 부르는 쪽에 알려 구획째 숨긴다(lazy-slots.tsx LazyCompactRow) */
export function LazyCompactCards({ list, trailing, onEmpty }: { list: string; trailing: "category" | "listed"; onEmpty: () => void }) {
  const locale = useLocale();
  const { items, done } = useCards(new URLSearchParams({ list, locale }).toString());
  const empty = done && !items?.length;
  useEffect(() => { if (empty) onEmpty(); }, [empty, onEmpty]);
  if (!items?.length) return empty ? null : <div aria-busy="true" className="compact-grid" style={{ minHeight: 120 }} />;
  return <div className="compact-grid">{items.map((product) => <CompactCard key={product.slug} product={product} trailing={trailing} />)}</div>;
}

/** 없는 주소 화면의 '지금 뜨는' — 이 화면은 모든 공개 화면의 RSC 데이터에 404 경계로 실려, 카드를 열 때 받는다 */
export function NotFoundRising({ title, more }: { title: string; more: { href: string; label: string } }) {
  const locale = useLocale();
  const { items } = useCards(new URLSearchParams({ list: "rising", locale }).toString());
  if (!items?.length) return null;
  return <CompactRow id="rising" title={title} items={items} trailing="category" more={more} />;
}

/**
 * /popular 한 쪽의 뒷줄 — 서버가 그린 앞줄과 같은 마크업(PopularRowMarkup·ProjectCardMarkup)이라 모양이 같다.
 * 받는 동안은 부르는 쪽이 준 자리(hold)를 그대로 두고, 못 받으면 자리를 거둔다(앞줄과 쪽 넘기기는 남는다).
 */
export function LazyPopularRows({ fillFrom, skip, view, now, hold }: { fillFrom: string; skip: number; view: "list" | "cards"; now: string; hold: ReactNode }) {
  const locale = useLocale();
  const t = useTranslations("labels");
  // 서버가 이름·요약으로 그린 앞줄을 채운 같은 응답(CardEnrich)을 쓴다 — 한 쪽에 한 번 받는다
  const list = useCardList(fillFrom);
  if (list === undefined) return hold;
  const items = list?.slice(skip);
  if (!items?.length) return null;
  const ctx = { locale, t, now };
  return (
    <>
      {items.map((product) => {
        const rank = product.rank ?? 0;
        const save = <SaveToggle slug={product.slug} name={product.name} />;
        return view === "list"
          ? <PopularRowMarkup key={product.slug} product={product} rank={rank} ctx={ctx} save={save} />
          : <ProjectCardMarkup key={product.slug} product={product} rank={rank} ctx={ctx} save={save} />;
      })}
    </>
  );
}
