"use client";

import { useEffect, useState } from "react";
import { reviveDetailExtras, type DetailExtras } from "@/lib/domain/products/detail-extras";
import { useLocale, useServerNow } from "@/lib/i18n/context";
import { FactsStrip } from "./FactsStrip";
import { InfoCard } from "./InfoCard";
import { LanguageBar } from "./LanguageBar";
import { RelatedRow } from "./RelatedRow";
import { UpdateTimeline } from "./UpdateTimeline";

/**
 * 상세의 부가 자료 자리(2026-11-14 공개 HTML 줄이기) — 서버 HTML 에는 자리만 두고 브라우저가 같은 출처 API 로 한 번 받아 채운다.
 * 자리 여럿(사실 칸·정보 카드·언어와 업데이트·같은 분야)이 한 번 받은 값을 함께 쓴다. 받는 동안은 글자 없는 자리(aria-busy)만,
 * 못 받으면 그 자리를 비운다 — 제목·소개·README 발췌는 서버 HTML 에 그대로 있다.
 */
type State = { slug: string; data: DetailExtras | null; done: boolean };

const loads = new Map<string, Promise<DetailExtras | null>>();

export function loadDetailExtras(slug: string, locale: string): Promise<DetailExtras | null> {
  const key = `${locale}:${slug}`;
  let load = loads.get(key);
  if (!load) {
    load = fetch(`/api/products/${encodeURIComponent(slug)}/details?locale=${encodeURIComponent(locale)}`, { headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? JSON.parse(await response.text(), reviveDetailExtras) as DetailExtras : null)
      .catch(() => null);
    // 실패는 담아 두지 않는다 — 다음에 이 상세를 열면 다시 받는다
    load.then((data) => { if (!data) loads.delete(key); });
    loads.set(key, load);
  }
  return load;
}

function useDetailExtras(slug: string): State {
  const locale = useLocale();
  const [state, setState] = useState<State>({ slug, data: null, done: false });
  useEffect(() => {
    let alive = true;
    loadDetailExtras(slug, locale).then((data) => { if (alive) setState({ slug, data, done: true }); });
    return () => { alive = false; };
  }, [slug, locale]);
  return state.slug === slug ? state : { slug, data: null, done: false };
}

/** 받는 동안의 자리 — 글자 없이 높이만(공개 화면 대기 문구 없음, aria-busy 로 상태를 알린다) */
function Pending({ height }: { height: string }) {
  return <div aria-busy="true" className={`${height} motion-safe:animate-pulse rounded-[12px] bg-bg-soft`} />;
}

export function DetailFactsSlot({ slug }: { slug: string }) {
  const { data, done } = useDetailExtras(slug);
  if (!done) return <Pending height="h-[132px]" />;
  return data ? <FactsStrip {...data.facts} /> : null;
}

export function DetailInfoSlot({ slug }: { slug: string }) {
  const { data, done } = useDetailExtras(slug);
  if (!done) return <Pending height="h-[220px]" />;
  return data ? <InfoCard {...data.info} /> : null;
}

/** 언어 구성과 업데이트 목록 — 본문 열에서 소개·README 다음 */
export function DetailActivitySlot({ slug }: { slug: string }) {
  const { data, done } = useDetailExtras(slug);
  const now = useServerNow();
  if (!done) return <Pending height="h-[96px]" />;
  if (!data) return null;
  return <>
    <LanguageBar repository={data.facts.repository} />
    <UpdateTimeline summary={data.timeline} now={now} />
  </>;
}

export function DetailRelatedSlot({ slug }: { slug: string }) {
  const { data } = useDetailExtras(slug);
  if (!data) return null;
  return <RelatedRow category={data.related.category} items={data.related.items} total={data.related.total} basis={data.related.basis} />;
}
