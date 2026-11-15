"use client";

import { useEffect, useId, useReducer } from "react";
import { reviveDetailExtras } from "@/lib/domain/products/detail-extras";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber, formatDate } from "@/lib/i18n/format";
import { TIMELINE_LIMIT, type TimelineAllResponse, type TimelineSummary, type TimelineUpdate } from "./client-data";
import { safeExternalUrl } from "./format";

/**
 * 업데이트 — 출처를 섞어 처음에는 최신 세 줄(날짜 · 제목 · 출처)만 표시한다.
 * 세 줄과 건수(전체·최근 30일)는 서버가 정해 넘긴다(client-data.ts timelineSummary) — 나머지 업데이트는 처음 HTML·부가 자료에 싣지 않는다.
 * 세 건보다 많으면 '전체'를 눌러 같은 출처 API(/api/products/[slug]/timeline)로 모두 받아 펼치고, '접기'로 세 줄로 돌아간다
 * (2026-11-15 사람 결정: 많아도 다 보인다). 한 번 받은 목록은 접었다 다시 펴도 다시 받지 않는다.
 * 줄마다 위쪽 선 하나 — 선은 줄이 있는 만큼만 긋고 마지막 줄 아래에는 긋지 않는다(빈 띠를 두 선이 감싸 빈 칸처럼 보였다).
 * now 는 서버가 읽은 시각이다 — 날짜의 '올해'를 서버·브라우저가 같게 낸다.
 */
export function UpdateTimeline({ slug, summary: { rows, total, recent }, now }: { slug: string; summary: TimelineSummary; now: Date }) {
  const [state, dispatch] = useReducer(timelineReducer, TIMELINE_CLOSED);
  const listId = useId();
  useEffect(() => {
    if (!state.pending) return;
    let alive = true;
    loadAllUpdates(slug).then((all) => { if (alive) dispatch({ type: "loaded", rows: all }); });
    return () => { alive = false; };
  }, [state.pending, slug]);
  return <UpdateTimelineView rows={rows} total={total} recent={recent} now={now} listId={listId} state={state} onToggle={() => dispatch({ type: "toggle" })} />;
}

export type TimelineState = { expanded: boolean; all: TimelineUpdate[] | null; pending: boolean; failed: boolean };
export type TimelineEvent = { type: "toggle" } | { type: "loaded"; rows: TimelineUpdate[] | null };
export const TIMELINE_CLOSED: TimelineState = { expanded: false, all: null, pending: false, failed: false };

/** '전체'·'접기' — 받는 중에는 다시 눌러도 그대로, 받은 목록이 있으면 다시 받지 않고 편다, 못 받으면 접힌 채 알린다 */
export function timelineReducer(state: TimelineState, event: TimelineEvent): TimelineState {
  if (event.type === "loaded") {
    if (!state.pending) return state;
    return event.rows ? { expanded: true, all: event.rows, pending: false, failed: false } : { ...state, pending: false, failed: true };
  }
  if (state.pending) return state;
  if (state.expanded) return { ...state, expanded: false };
  if (state.all) return { ...state, expanded: true, failed: false };
  return { ...state, pending: true, failed: false };
}

const loads = new Map<string, Promise<TimelineUpdate[] | null>>();

/** 보이는 업데이트 모두 — 같은 제품을 한 번만 받는다(겹친 요청도 하나로). 실패는 담아 두지 않는다 — 다시 누르면 다시 받는다 */
export function loadAllUpdates(slug: string): Promise<TimelineUpdate[] | null> {
  let load = loads.get(slug);
  if (!load) {
    load = fetch(`/api/products/${encodeURIComponent(slug)}/timeline`, { headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? (JSON.parse(await response.text(), reviveDetailExtras) as TimelineAllResponse).rows : null)
      .catch(() => null);
    load.then((all) => { if (!all) loads.delete(slug); });
    loads.set(slug, load);
  }
  return load;
}

export function UpdateTimelineView({ rows, total, recent, now, listId, state, onToggle }: {
  rows: TimelineUpdate[]; total: number; recent: number; now: Date; listId: string; state: TimelineState; onToggle?: () => void;
}) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const shown = state.expanded && state.all ? state.all : rows;
  // 해가 다른 날짜("2025년 10월 8일")가 보이면 날짜 칸을 넓힌다 — 줄마다 같은 너비라야 제목이 한 줄로 맞는다
  const year = new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" });
  const wide = locale !== "ko" || shown.some((update) => year.format(update.publishedAt ?? update.observedAt) !== year.format(now));

  return (
    <section aria-labelledby="updates-title" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="updates-title" className="m-0 flex items-baseline gap-2 text-[13px] font-semibold tracking-[0.02em] text-fg-2">
          {t("updates.title")}
          <span className="font-normal tabular-nums">
            {recent > 0 ? t("updates.recent", { count: formatNumber(recent, locale) }) : t("updates.count", { count: formatNumber(total, locale) })}
          </span>
        </h2>
        {/* 누르는 자리는 44px, 머리 줄 높이는 글자 한 줄 그대로(-my-3). 받는 동안은 글자 대신 목록의 aria-busy 와 옅은 깜빡임(공개 화면 대기 문구 없음) */}
        {total > TIMELINE_LIMIT && (
          <button type="button" aria-expanded={state.expanded} aria-controls={listId} onClick={onToggle}
            className={`-my-3 inline-flex min-h-11 items-center rounded-sm text-[13px] text-fg-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink ${state.pending ? "cursor-wait motion-safe:animate-pulse" : "cursor-pointer"}`}>
            {state.expanded ? t("action.collapse") : t("updates.showAll")}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="m-0 text-[14px] text-fg-2">{t("updates.empty")}</p>
      ) : (
        <ol id={listId} aria-busy={state.pending || undefined} className="m-0 flex list-none flex-col p-0">
          {shown.map((update) => {
            const sourceUrl = safeExternalUrl(update.canonicalUrl);
            const date = update.publishedAt ?? update.observedAt;
            return (
              <li key={update.id} className={`grid ${wide ? "grid-cols-[112px_minmax(0,1fr)_auto]" : "grid-cols-[64px_minmax(0,1fr)_auto]"} items-center gap-3.5 border-t border-line py-[9px]`}>
                <time dateTime={date.toISOString()} className="text-[13px] text-fg-2 tabular-nums">{formatDate(date, now, locale)}</time>
                {sourceUrl
                  ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="truncate text-[13px] text-fg hover:underline">{update.title}</a>
                  : <span className="truncate text-[13px] text-fg">{update.title}</span>}
                <span className="whitespace-nowrap text-[13px] text-fg-2">
                  {update.sourceKind === "github_release" ? t("updates.release") : t(update.sourceKind === "maker" ? "updates.maker" : "updates.automatic")}{sourceUrl ? " ↗" : ""}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {state.failed && <p role="alert" className="m-0 text-[13px] text-fg-2">{t("updates.loadFailed")}</p>}
    </section>
  );
}
