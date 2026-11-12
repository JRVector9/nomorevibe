import Link from "next/link";
import { formatListTime } from "@/lib/format/time";
import type { ModelUnifiedRead } from "@/lib/operations/model-unified-read";
import { llmHistoryHref } from "@/lib/operations/llm-ops-history";
import { actionLabel, targetLabel } from "../../activity/labels";
import { summaryLine } from "../../activity/summary";
import { UnifiedOperationsControls } from "./UnifiedOperationsControls";

type Data = Pick<ModelUnifiedRead, "now" | "assist" | "concurrency" | "importPreview" | "retired" | "retiredReadable" | "retiredError" | "changes">;
export type UnifiedRecentChange = { id: number; at: string; title: string; detail: string; ok: boolean };

export function UnifiedOperations({ data, readOnly, recent, openImport = false }: { data: Data; readOnly: boolean; recent?: readonly UnifiedRecentChange[]; openImport?: boolean }) {
  const { assist, concurrency, retired, retiredReadable, retiredError, importPreview, changes } = data;
  const rows: readonly UnifiedRecentChange[] = recent ?? changes.rows.map(row => ({ id: row.id, at: new Date(row.createdAt).toISOString(),
    title: `${targetLabel(row.target).text} · ${actionLabel(row.action)}`, detail: `${row.ok ? summaryLine(row) : row.error ?? "저장 거절"} · ${row.actor}`, ok: row.ok }));
  return <div id="operations" className="mu-lower">
    <section aria-labelledby="operations-title">
      <div className="mu-section-head"><h2 id="operations-title">운영 설정</h2><span>필요할 때 열기</span></div>
      <UnifiedOperationsControls data={{ assist, concurrency, retired, retiredReadable, retiredError, importPreview }} readOnly={readOnly} openImport={openImport} />
    </section>
    <section id="audit" aria-labelledby="history-title">
      <div className="mu-section-head"><h2 id="history-title">최근 변경</h2><Link prefetch={false} href={llmHistoryHref()}>기록 전체 →</Link></div>
      <div className="mu-recent">
        {changes.error ? <p role="alert" className="mu-empty">최근 변경을 읽지 못했습니다.</p> : rows.length ? rows.slice(0, 3).map(row => <div key={row.id} className="mu-recent-row">
          <time dateTime={row.at} title={formatListTime(row.at, new Date(data.now))}>{new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(row.at))}</time>
          <div><strong data-ok={row.ok}>{row.title}</strong><p>{row.detail}</p></div>
        </div>) : <p className="mu-empty">아직 변경 기록이 없습니다.</p>}
      </div>
      <div className="mu-mini-foot"><span>홈의 변경 기록과 같은 배정 내역</span><span>최근 {Math.min(rows.length, 3)}건</span></div>
    </section>
  </div>;
}
