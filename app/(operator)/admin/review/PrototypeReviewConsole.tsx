"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AdminReviewEntry } from "@/lib/crawl/admin-review";
import { reconcileSnapshots } from "../components/selection";
import { useAdminToast } from "../components/Toast";
import { BulkDecision } from "./BulkDecision";
import { RejectedRerun } from "./RejectedRerun";
import { entryVersion } from "./contract";
import { causeLabel } from "./causes";
import { undoCandidateDecisions } from "./actions";
import { reviewShortcut } from "./shortcuts";
import type { DecidedResult } from "./ReviewDetail";
import { formatWait } from "@/lib/domain/products/takedown-view";
import { PrototypeReviewDetail } from "./PrototypeReviewDetail";
import { AsyncScrollBoundary } from "../components/AsyncScrollBoundary";

const states: Record<string, string> = { new: "규칙 판정 대기", needs_review: "사람·AI 검토", approved: "발행 대기", published: "발행 완료", rejected: "반려" };
export function PrototypeReviewConsole({ entries: initialEntries, reasons, focus, title, total, footer, now, focusedEntry = null, nextCursor = null, scrollQuery = "" }: {
  entries: AdminReviewEntry[]; reasons: readonly { value: string; label: string }[]; focus?: number; title: string; total: number; footer?: ReactNode; now: number; focusedEntry?: AdminReviewEntry | null; nextCursor?: string | null; scrollQuery?: string;
}) {
  const toast = useAdminToast();
  const [page, setPage] = useState({ initial: initialEntries, entries: initialEntries, cursor: nextCursor });
  const entries = page.initial === initialEntries ? page.entries : initialEntries;
  const cursor = page.initial === initialEntries ? page.cursor : nextCursor;
  const [pendingFor, setPendingFor] = useState<AdminReviewEntry[] | null>(null);
  const [failed, setFailed] = useState<{ initial: AdminReviewEntry[]; message: string } | null>(null);
  const loading = pendingFor === initialEntries, error = failed?.initial === initialEntries ? failed.message : null;
  const request = useRef<AbortController | null>(null), busy = useRef(false);
  const [activeSnapshot, setActiveSnapshot] = useState({ initial: initialEntries, entry: focusedEntry ?? initialEntries[0] ?? null });
  useEffect(() => () => { request.current?.abort(); request.current = null; busy.current = false; }, [initialEntries]);
  async function loadMore() {
    if (busy.current || !cursor) return;
    busy.current = true;
    const controller = new AbortController(); request.current = controller;
    setPendingFor(initialEntries); setFailed(null);
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    try {
      const params = new URLSearchParams(scrollQuery); params.set("cursor", cursor);
      const response = await fetch(`/admin/review/scroll?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (!response.ok || response.redirected || !response.headers.get("content-type")?.includes("application/json")) throw new Error("다음 목록을 읽지 못했습니다. 로그인 상태를 확인하고 다시 시도하세요.");
      const data = await response.json();
      if (!Array.isArray(data.entries) || data.entries.length > 30 || (data.nextCursor !== null && typeof data.nextCursor !== "string") || data.nextCursor === cursor) throw new Error("목록 응답을 확인하지 못했습니다. 새로고침해 다시 확인하세요.");
      const added = data.entries.map((entry: AdminReviewEntry) => ({ ...entry, candidate: { ...entry.candidate,
        updatedAt: new Date(entry.candidate.updatedAt), judgedAt: entry.candidate.judgedAt ? new Date(entry.candidate.judgedAt) : null,
        decidedAt: entry.candidate.decidedAt ? new Date(entry.candidate.decidedAt) : null } }));
      if (controller.signal.aborted) return;
      setPage(previous => {
        const rows = new Map((previous.initial === initialEntries ? previous.entries : initialEntries).map(entry => [entry.candidate.id, entry]));
        for (const entry of added) rows.set(entry.candidate.id, entry);
        return { initial: initialEntries, entries: [...rows.values()], cursor: data.nextCursor };
      });
    } catch (failure) {
      if (!controller.signal.aborted || timedOut) setFailed({ initial: initialEntries, message: timedOut ? "다음 목록 응답이 늦어졌습니다. 다시 시도하세요." : failure instanceof Error ? failure.message : "다음 목록을 읽지 못했습니다." });
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) { request.current = null; busy.current = false; setPendingFor(null); }
    }
  }
  function activate(entry: AdminReviewEntry) { setActive(entry.candidate.id); setActiveSnapshot({ initial: initialEntries, entry }); }
  const [active, setActive] = useState(focus ?? entries[0]?.candidate.id ?? 0);
  const [checked, setChecked] = useState<Map<number, AdminReviewEntry>>(new Map());
  const current = entries.find(entry => entry.candidate.id === active) ?? (focusedEntry?.candidate.id === active ? focusedEntry : null) ?? (activeSnapshot.initial === initialEntries && activeSnapshot.entry?.candidate.id === active ? activeSnapshot.entry : null);
  const selectable = useMemo(() => entries.filter(entry => !!entry.inputHash && !!entry.sourceRevisionHash && entry.candidate.state !== "published" && !entry.candidate.publishedSlug), [entries]);
  const selection = reconcileSnapshots(checked, selectable, entry => entry.candidate.id, entryVersion);
  const toggle = (entry: AdminReviewEntry) => setChecked(previous => {
    const next = new Map(previous);
    if (next.has(entry.candidate.id) && !selection.changed.has(entry.candidate.id)) next.delete(entry.candidate.id);
    else next.set(entry.candidate.id, entry);
    return next;
  });
  const allLoadedSelected = selectable.length > 0 && selectable.every(entry => checked.has(entry.candidate.id) && !selection.changed.has(entry.candidate.id));
  const rerunTargets = selection.send
    .filter((entry): entry is AdminReviewEntry & { inputHash: string; sourceRevisionHash: string; candidateRevisionHash: string } =>
      entry.candidate.state === "rejected" && !!entry.inputHash && !!entry.sourceRevisionHash && !!entry.candidateRevisionHash)
    .map(entry => ({
      repo: entry.candidate.repo,
      inputHash: entry.inputHash,
      sourceRevisionHash: entry.sourceRevisionHash,
      candidateRevisionHash: entry.candidateRevisionHash,
    }));
  function toggleAllLoaded() {
    setChecked(() => {
      if (allLoadedSelected) return new Map<number, AdminReviewEntry>();
      return new Map(selectable.map(entry => [entry.candidate.id, entry] as const));
    });
  }
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const key = reviewShortcut(event);
    if (key?.kind === "move") {
      event.preventDefault(); const index = entries.findIndex(entry => entry.candidate.id === active);
      const next = entries[Math.min(entries.length - 1, Math.max(0, index + key.delta))]; if (next) activate(next);
    } else if (key?.kind === "toggle" && current && selectable.includes(current)) { event.preventDefault(); toggle(current); }
  });
  useEffect(() => { const listener = (event: KeyboardEvent) => onKey(event); window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, []);
  function decided(entry: AdminReviewEntry, result: DecidedResult) {
    const at = entries.indexOf(entry), next = entries[at + 1] ?? entries[at - 1];
    setActive(next?.candidate.id ?? 0); setActiveSnapshot({ initial: initialEntries, entry: next ?? null }); setChecked(previous => { const copy = new Map(previous); copy.delete(entry.candidate.id); return copy; });
    toast.show({ message: `${result.decision === "approve" ? "승인" : "반려"} · ${entry.name}`, link: { label: "기록 보기", href: `/admin/activity?target=${encodeURIComponent(result.repo)}` }, undo: { run: () => undoCandidateDecisions([{ repo: result.repo, attemptId: result.attemptId }]) } });
  }
  return <div id="review-list" className="grid detail" data-dirty={selection.send.length > 0 || undefined} data-admin-scroll-active={loading || entries.length > initialEntries.length || undefined}>
    <section className="panel"><div className="panel-head"><h3>{title}</h3><span className="tag gray">전체 {total.toLocaleString("ko-KR")}건</span></div>
      <div className="table-scroll" role="region" aria-label="검수 후보 목록" tabIndex={0}><table style={{ minWidth: 570 }}><thead><tr><th className="col-check">선택</th><th>후보·유입</th><th>대기 사유·시간</th><th>판정</th></tr></thead><tbody>
        {entries.map(entry => <tr key={entry.candidate.id} className={active === entry.candidate.id ? "selected" : undefined}>
          <td className="col-check"><input type="checkbox" aria-label={`${entry.name} 선택`} checked={checked.has(entry.candidate.id) && !selection.changed.has(entry.candidate.id)} disabled={!selectable.includes(entry)} onChange={() => toggle(entry)} /></td>
          <td><button className="text-button name" onClick={() => activate(entry)}>{entry.name}</button><p>{entry.candidate.repo}</p>{selection.changed.has(entry.candidate.id) && <span className="tag amber">원문 변경 · 다시 선택 필요</span>}</td>
          <td>{entry.bucket ? causeLabel(entry.bucket) : entry.candidate.reason ?? "—"}<p>{entry.candidate.judgedAt || entry.candidate.updatedAt ? `${formatWait(Math.max(0, (now - new Date(entry.candidate.judgedAt ?? entry.candidate.updatedAt).getTime()) / 3_600_000))} 대기` : "대기 —"}</p></td>
          <td><span className={`tag ${entry.candidate.state === "rejected" ? "red" : entry.candidate.state === "approved" || entry.candidate.state === "published" ? "green" : "amber"}`}>{states[entry.candidate.state] ?? entry.candidate.state}</span></td>
        </tr>)}
      </tbody></table>
      <AsyncScrollBoundary hasMore={!!cursor} loading={loading} error={error} onLoad={() => { void loadMore(); }} />
      </div>
      {!entries.length && <div className="empty"><b>조건에 맞는 후보가 없습니다.</b>단계나 검색 조건을 바꿔 확인하세요.</div>}
      {entries.length > initialEntries.length && <p className="table-note">추가 목록을 확인하는 동안 자동 갱신은 잠시 쉽니다. 새로고침하면 최근 30개부터 다시 확인합니다.</p>}
      <p className="table-note">선택 {selection.send.length}건 · 불러온 {entries.length}건 · J/K 이동 · A 승인 / R 반려 준비 · 원본이 바뀐 선택은 일괄 처리에서 제외합니다.</p>
      <div className="panel-foot"><BulkDecision selected={selection.send} reasons={reasons} title="선택한 후보" onDone={() => setChecked(new Map())} /><button type="button" className="text-button" onClick={toggleAllLoaded} disabled={!selectable.length} aria-pressed={allLoadedSelected}>현재 목록 전체 선택 (불러온 {entries.length}건)</button><RejectedRerun targets={rerunTargets} /></div>{footer && <div className="panel-foot">{footer}</div>}
    </section>
    <section className="panel pad sticky-detail" aria-label="선택한 검수 후보" data-review-panel tabIndex={-1}>{current ? <PrototypeReviewDetail key={current.candidate.id} entry={current} reasons={reasons} onDecided={result => decided(current, result)} /> : <div className="empty"><b>{active ? "선택한 후보가 목록에서 빠졌습니다." : "후보를 선택하세요."}</b>다른 후보로 자동 변경하지 않습니다. 목록에서 다시 선택하세요.</div>}</section>
  </div>;
}
