"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AdminReviewEntry } from "@/lib/crawl/admin-review";
import { reconcileSnapshots } from "../components/selection";
import { useAdminToast } from "../components/Toast";
import { BulkDecision } from "./BulkDecision";
import { entryVersion } from "./contract";
import { causeLabel } from "./causes";
import { undoCandidateDecisions } from "./actions";
import { reviewShortcut } from "./shortcuts";
import type { DecidedResult } from "./ReviewDetail";
import { formatWait } from "@/lib/domain/products/takedown-view";
import { PrototypeReviewDetail } from "./PrototypeReviewDetail";

const states: Record<string, string> = { new: "규칙 판정 대기", needs_review: "사람·AI 검토", approved: "발행 대기", published: "발행 완료", rejected: "반려" };
export function PrototypeReviewConsole({ entries, reasons, focus, title, total, footer, now }: {
  entries: AdminReviewEntry[]; reasons: readonly { value: string; label: string }[]; focus?: number; title: string; total: number; footer?: ReactNode; now: number;
}) {
  const toast = useAdminToast();
  const [active, setActive] = useState(focus ?? entries[0]?.candidate.id ?? 0);
  const [checked, setChecked] = useState<Map<number, AdminReviewEntry>>(new Map());
  const current = entries.find(entry => entry.candidate.id === active);
  const selectable = useMemo(() => entries.filter(entry => !!entry.inputHash && !!entry.sourceRevisionHash && entry.candidate.state !== "published" && !entry.candidate.publishedSlug), [entries]);
  const selection = reconcileSnapshots(checked, selectable, entry => entry.candidate.id, entryVersion);
  const toggle = (entry: AdminReviewEntry) => setChecked(previous => {
    const next = new Map(previous);
    if (next.has(entry.candidate.id) && !selection.changed.has(entry.candidate.id)) next.delete(entry.candidate.id);
    else next.set(entry.candidate.id, entry);
    return next;
  });
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const key = reviewShortcut(event);
    if (key?.kind === "move") {
      event.preventDefault(); const index = entries.findIndex(entry => entry.candidate.id === active);
      const next = entries[Math.min(entries.length - 1, Math.max(0, index + key.delta))]; if (next) setActive(next.candidate.id);
    } else if (key?.kind === "toggle" && current && selectable.includes(current)) { event.preventDefault(); toggle(current); }
  });
  useEffect(() => { const listener = (event: KeyboardEvent) => onKey(event); window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, []);
  function decided(entry: AdminReviewEntry, result: DecidedResult) {
    const at = entries.indexOf(entry), next = entries[at + 1] ?? entries[at - 1];
    setActive(next?.candidate.id ?? 0); setChecked(previous => { const copy = new Map(previous); copy.delete(entry.candidate.id); return copy; });
    toast.show({ message: `${result.decision === "approve" ? "승인" : "반려"} · ${entry.name}`, link: { label: "기록 보기", href: `/admin/activity?target=${encodeURIComponent(result.repo)}` }, undo: { run: () => undoCandidateDecisions([{ repo: result.repo, attemptId: result.attemptId }]) } });
  }
  return <div id="review-list" className="grid detail" data-dirty={selection.send.length > 0 || undefined}>
    <section className="panel"><div className="panel-head"><h3>{title}</h3><span className="tag gray">전체 {total.toLocaleString("ko-KR")}건</span></div>
      <div className="table-scroll" role="region" aria-label="검수 후보 목록" tabIndex={0}><table style={{ minWidth: 570 }}><thead><tr><th className="col-check">선택</th><th>후보·유입</th><th>대기 사유·시간</th><th>판정</th></tr></thead><tbody>
        {entries.map(entry => <tr key={entry.candidate.id} className={active === entry.candidate.id ? "selected" : undefined}>
          <td className="col-check"><input type="checkbox" aria-label={`${entry.name} 선택`} checked={checked.has(entry.candidate.id) && !selection.changed.has(entry.candidate.id)} disabled={!selectable.includes(entry)} onChange={() => toggle(entry)} /></td>
          <td><button className="text-button name" onClick={() => setActive(entry.candidate.id)}>{entry.name}</button><p>{entry.candidate.repo}</p>{selection.changed.has(entry.candidate.id) && <span className="tag amber">원문 변경 · 다시 선택 필요</span>}</td>
          <td>{entry.bucket ? causeLabel(entry.bucket) : entry.candidate.reason ?? "—"}<p>{entry.candidate.judgedAt || entry.candidate.updatedAt ? `${formatWait(Math.max(0, (now - new Date(entry.candidate.judgedAt ?? entry.candidate.updatedAt).getTime()) / 3_600_000))} 대기` : "대기 —"}</p></td>
          <td><span className={`tag ${entry.candidate.state === "rejected" ? "red" : entry.candidate.state === "approved" || entry.candidate.state === "published" ? "green" : "amber"}`}>{states[entry.candidate.state] ?? entry.candidate.state}</span></td>
        </tr>)}
      </tbody></table></div>
      {!entries.length && <div className="empty"><b>조건에 맞는 후보가 없습니다.</b>단계나 검색 조건을 바꿔 확인하세요.</div>}
      <p className="table-note">이 페이지 {entries.length}건 · J/K 이동 · A 승인 / R 반려 준비 · 원본이 바뀐 선택은 일괄 처리에서 제외합니다.</p>
      <div className="panel-foot"><BulkDecision selected={selection.send} reasons={reasons} title="선택한 후보" onDone={() => setChecked(new Map())} /></div>{footer && <div className="panel-foot">{footer}</div>}
    </section>
    <section className="panel pad sticky-detail" aria-label="선택한 검수 후보" data-review-panel tabIndex={-1}>{current ? <PrototypeReviewDetail key={current.candidate.id} entry={current} reasons={reasons} onDecided={result => decided(current, result)} /> : <div className="empty"><b>{active ? "선택한 후보가 목록에서 빠졌습니다." : "후보를 선택하세요."}</b>다른 후보로 자동 변경하지 않습니다. 목록에서 다시 선택하세요.</div>}</section>
  </div>;
}
