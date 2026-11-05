"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatWait } from "@/lib/domain/products/takedown-view";
import type { RequestFeedPage, RequestFeedRow } from "@/lib/operations/admin-request-workspace-feed-model";
import { AsyncScrollBoundary } from "../components/AsyncScrollBoundary";

export function RequestFeedList({ initial, query, selectedKey, posts }: { initial: RequestFeedPage; query: string; selectedKey?: string; posts: boolean }) {
  const [page, setPage] = useState({ initial, items: initial.items, cursor: initial.nextCursor });
  const items = page.initial === initial ? page.items : initial.items, cursor = page.initial === initial ? page.cursor : initial.nextCursor;
  const [pendingFor, setPendingFor] = useState<RequestFeedPage | null>(null), [failure, setFailure] = useState<{ initial: RequestFeedPage; message: string } | null>(null);
  const loading = pendingFor === initial, error = failure?.initial === initial ? failure.message : initial.failed.length ? "일부 유형의 요청을 확인하지 못했습니다. 새로고침해 다시 확인하세요." : null;
  const busy = useRef(false), request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; busy.current = false; }, [initial]);
  const link = (key: string) => { const params = new URLSearchParams(query); params.set("id", key); return `/admin/requests?${params}`; };
  async function loadMore() {
    if (busy.current || !cursor) return;
    busy.current = true;
    const controller = new AbortController(); request.current = controller;
    setPendingFor(initial); setFailure(null);
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    try {
      const params = new URLSearchParams(query); params.set("cursor", cursor);
      const response = await fetch(`/admin/requests/scroll?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (!response.ok || response.redirected || !response.headers.get("content-type")?.includes("application/json")) throw new Error("다음 요청을 읽지 못했습니다. 로그인 상태를 확인하고 다시 시도하세요.");
      const data: RequestFeedPage = await response.json();
      if (!Array.isArray(data.items) || data.items.length > 30 || !Array.isArray(data.failed) || data.failed.length || (data.nextCursor !== null && typeof data.nextCursor !== "string") || data.nextCursor === cursor) throw new Error("목록 응답을 확인하지 못했습니다. 새로고침해 다시 확인하세요.");
      if (controller.signal.aborted) return;
      setPage(previous => {
        const rows = new Map((previous.initial === initial ? previous.items : initial.items).map(row => [row.key, row]));
        for (const row of data.items) rows.set(row.key, row);
        return { initial, items: [...rows.values()], cursor: data.nextCursor };
      });
    } catch (problem) {
      if (!controller.signal.aborted || timedOut) setFailure({ initial, message: timedOut ? "다음 요청의 응답이 늦어졌습니다. 다시 시도하세요." : problem instanceof Error ? problem.message : "다음 요청을 읽지 못했습니다." });
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) { request.current = null; busy.current = false; setPendingFor(null); }
    }
  }
  const row = (item: RequestFeedRow) => <tr className={selectedKey === item.key ? "selected" : undefined} key={item.key}><td><Link className="text-button name" scroll={false} prefetch={false} href={link(item.key)}>{item.name}</Link><p className="request-type">{item.key} · {item.type}</p></td><td><span className={`tag ${item.status === "공개" || item.status === "해결" ? "green" : "amber"}`}>{item.status}</span></td><td>{posts ? <span className="request-excerpt">{item.excerpt ?? "원문은 선택한 요청에서 확인"}</span> : <>{formatWait(item.waitHours)}{item.kind === "takedown" && <p><span className={`tag ${item.waitHours >= 24 ? "red" : "amber"}`}>{item.waitHours >= 24 ? "24시간 초과" : `24시간까지 ${formatWait(Math.max(0, 24 - item.waitHours))}`}</span></p>}</>}</td><td><Link className="button small" scroll={false} prefetch={false} href={link(item.key)}>검토</Link><p>{item.next}</p></td></tr>;
  return <section className="panel" data-admin-scroll-active={loading || items.length > 30 ? "true" : undefined}>
    <div className="table-scroll" tabIndex={0} role="region" aria-label="요청 목록"><table style={{ minWidth: 570 }}><thead><tr><th>{posts ? "유형·프로젝트" : "요청·프로젝트"}</th><th>현재 상태</th><th>{posts ? "원문" : "대기·기한"}</th><th>다음 행동</th></tr></thead><tbody>{items.map(row)}</tbody></table><AsyncScrollBoundary hasMore={!!cursor} loading={loading} error={error} onLoad={() => { void loadMore(); }} /></div>
    {!items.length && <div className="empty"><b>{initial.failed.length ? "확인할 수 있는 요청이 없습니다." : "이 조건에 해당하는 요청이 없습니다."}</b>{initial.failed.length ? "조회 실패를 0건으로 처리하지 않습니다." : "처리 기록에서 완료 결과를 확인하세요."}</div>}
    <p className="table-note">최근 요청부터 {items.length}건 표시 · 검색은 전체 해당 요청에 적용됩니다. 문의 원문과 회신 주소는 선택한 요청에서 확인합니다.</p>
    {items.length > 30 && <p className="table-note">추가 목록을 확인하는 동안 자동 갱신은 잠시 쉽니다. 새로고침하면 최근 30개부터 다시 확인합니다.</p>}
  </section>;
}
