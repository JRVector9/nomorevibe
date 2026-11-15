"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { CardFill, ProductCardsResponse } from "@/app/api/product-cards/route";
import { useLocale } from "@/lib/i18n/context";

/**
 * 카드 채우기(2026-11-15 공개 HTML 이름·요약만, 문서 4.1) — 서버 HTML 의 카드에는 이름·요약·링크와 같은 크기의 빈 자리만 있다.
 * 화면에 있는 카드가 slug 를 여기에 맡기면, 같은 순간에 모인 slug 를 **한 번에** `/api/product-cards?slugs=a,b,…`(최대 60개)로 받아
 * 빈 자리(표지·@소유자·분류·배지·스타·꼬리표)를 채운다. 실패하거나 없는 slug 는 빈 자리를 거둔다(null). 대기 문구는 두지 않는다.
 *
 * 목록의 맥락 값(8시간 증가·많이 쓰이는 순위 줄)은 slug 만으로 다시 셀 수 없어 그 목록의 API(source, 예: list=rising)를 한 번 받아 채운다 —
 * 같은 목록의 서버 밖 뒷줄(LazyPopularRows)도 같은 응답을 쓴다.
 */
export const MAX_SLUGS = 60;

type Entry = CardFill | null;
type ListItems = ProductCardsResponse["items"];

const entries = new Map<string, Entry>();
const lists = new Map<string, Promise<ListItems | null>>();
const listItems = new Map<string, ListItems | null>();
const listeners = new Set<() => void>();
/** 아직 보내지 않은 slug — 언어마다 */
const queued = new Map<string, Set<string>>();
const requested = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

const slugKey = (locale: string, slug: string) => `slugs|${locale}|${slug}`;
const listKey = (locale: string, source: string) => `${locale}|${source}`;
const listEntryKey = (locale: string, source: string, slug: string) => `list|${listKey(locale, source)}|${slug}`;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function fetchItems(query: string): Promise<ListItems | null> {
  try {
    const response = await fetch(`/api/product-cards?${query}`, { headers: { accept: "application/json" } });
    return response.ok ? (await response.json() as ProductCardsResponse).items : null;
  } catch {
    return null;
  }
}

/** 모인 slug 를 60개씩 끊어 보낸다 — 한 화면의 카드는 대개 한 번이다 */
function flush() {
  timer = null;
  const batches = [...queued.entries()];
  queued.clear();
  for (const [locale, set] of batches) {
    const slugs = [...set];
    for (let index = 0; index < slugs.length; index += MAX_SLUGS) {
      const chunk = slugs.slice(index, index + MAX_SLUGS);
      void fetchItems(new URLSearchParams({ slugs: chunk.join(","), locale }).toString()).then((items) => {
        const found = new Map((items ?? []).map((item) => [item.slug, item as CardFill]));
        for (const slug of chunk) {
          entries.set(slugKey(locale, slug), found.get(slug) ?? null);
          // 실패한 것은 다음에 그 카드가 다시 그려질 때 한 번 더 받는다
          if (!items) requested.delete(slugKey(locale, slug));
        }
        notify();
      });
    }
  }
}

function requestSlug(slug: string, locale: string) {
  const key = slugKey(locale, slug);
  if (requested.has(key)) return;
  requested.add(key);
  const set = queued.get(locale) ?? new Set<string>();
  set.add(slug);
  queued.set(locale, set);
  // 같은 커밋(hydration)에서 붙은 카드의 effect 가 모두 돈 뒤 한 번에 보낸다
  timer ??= setTimeout(flush, 0);
}

/** 목록 API 를 한 번만 받는다 — 카드 채우기와 뒷줄 그리기가 함께 쓴다 */
export function loadCardList(source: string, locale: string): Promise<ListItems | null> {
  const key = listKey(locale, source);
  let load = lists.get(key);
  if (!load) {
    load = fetchItems(`${source}&${new URLSearchParams({ locale })}`).then((items) => {
      listItems.set(key, items);
      for (const item of items ?? []) entries.set(listEntryKey(locale, source, item.slug), item);
      if (!items) lists.delete(key);
      notify();
      return items;
    });
    lists.set(key, load);
  }
  return load;
}

/** 받은 목록(없으면 undefined) — 받는 동안은 undefined, 실패는 null */
export function useCardList(source: string | null): ListItems | null | undefined {
  const locale = useLocale();
  useEffect(() => { if (source !== null) void loadCardList(source, locale); }, [source, locale]);
  return useSyncExternalStore(subscribe,
    () => source === null ? undefined : listItems.get(listKey(locale, source)),
    () => undefined);
}

/**
 * 카드 하나의 채울 값 — undefined: 받는 중(빈 자리), null: 없음·실패(빈 자리를 거둔다), 값: 다 그린다.
 * source 를 주면 그 목록 API 의 값으로 채운다(목록 맥락의 증가·순위).
 */
export function useCardFill(slug: string, source?: string): Entry | undefined {
  const locale = useLocale();
  useEffect(() => {
    if (source) void loadCardList(source, locale);
    else requestSlug(slug, locale);
  }, [slug, source, locale]);
  return useSyncExternalStore(subscribe, () => {
    if (!source) return entries.get(slugKey(locale, slug));
    const found = entries.get(listEntryKey(locale, source, slug));
    if (found) return found;
    return listItems.has(listKey(locale, source)) ? null : undefined;
  }, () => undefined);
}

/** 시험용 — 모듈 상태를 비운다 */
export function resetCardFills() {
  entries.clear(); lists.clear(); listItems.clear(); queued.clear(); requested.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}
