"use client";

import { useEffect, useState } from "react";
import type { BrowseCountsResponse, MethodCountsResponse } from "@/app/api/browse-counts/route";
export { browseCountsQuery } from "./browse-state";

/**
 * 공개 수·분야별 수·AI 수(2026-11-15 공개 HTML 이름·요약만) — 서버 HTML 에 싣지 않고 화면 JS 가 /api/browse-counts 로 한 번 받는다.
 * 같은 조건의 소개 줄·거르기 줄·집계 창이 한 번 받은 값을 함께 쓴다. 받는 동안은 undefined, 실패하면 null 이다.
 */
const loads = new Map<string, Promise<unknown>>();

function load<T>(query: string): Promise<T | null> {
  let promise = loads.get(query) as Promise<T | null> | undefined;
  if (!promise) {
    promise = fetch(`/api/browse-counts?${query}`, { headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? await response.json() as T : null)
      .catch(() => null);
    promise.then((value) => { if (!value) loads.delete(query); });
    loads.set(query, promise);
  }
  return promise;
}

function useLoaded<T>(query: string | null): T | null | undefined {
  const [state, setState] = useState<{ query: string | null; value: T | null | undefined }>({ query, value: undefined });
  useEffect(() => {
    if (query === null) return;
    let alive = true;
    void load<T>(query).then((value) => { if (alive) setState({ query, value }); });
    return () => { alive = false; };
  }, [query]);
  return query !== null && state.query === query ? state.value : undefined;
}

/** query 가 null 이면 받지 않는다(검색 화면은 알약 수를 숨긴다) */
export function useBrowseCounts(query: string | null): BrowseCountsResponse | null | undefined {
  return useLoaded<BrowseCountsResponse>(query);
}

/** 다른 수 묶음(part=popular 등) — 주소 값 그대로 */
export function useCountsQuery<T>(query: string | null): T | null | undefined {
  return useLoaded<T>(query);
}

export function useMethodCounts(enabled: boolean): MethodCountsResponse | null | undefined {
  return useLoaded<MethodCountsResponse>(enabled ? "part=method" : null);
}
