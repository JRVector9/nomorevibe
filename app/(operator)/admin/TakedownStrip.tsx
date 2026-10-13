import Link from "next/link";
import { formatWait, isBurst, type TakedownSummary } from "@/lib/domain/products/takedown-view";

const n = (value: number) => value.toLocaleString("ko-KR");

/**
 * 내려달라는 요청 한 줄 — 심사 큐 머리에 둔다. 몇 건이 와도 높이는 한 줄이고, 목록과 버튼은 처리 화면
 * (내릴 후보 → 내려달라는 요청)에만 있다. 24시간을 넘긴 요청이 있으면 빨강(경보), 아니면 주황.
 */
export function TakedownStrip({ summary }: { summary: TakedownSummary | null }) {
  if (!summary || summary.pending === 0) return null;
  const overdue = summary.overdue > 0;
  const oldest = summary.oldestHours === null ? null : formatWait(summary.oldestHours);
  return (
    <div className="takedown-strip" data-tone={overdue ? "bad" : "warn"} role={overdue ? "alert" : "status"}>
      <span className="dash-dot" data-tone={overdue ? "bad" : "warn"} aria-hidden />
      <span>
        <b>내려달라는 요청 {n(summary.pending)}건</b>
        {overdue
          ? <> · 24시간 넘은 것 <b>{n(summary.overdue)}건</b>{oldest && `(최장 ${oldest})`}</>
          : <>{oldest && ` · 가장 오래된 것 ${oldest}`} · 24시간 안에 처리합니다</>}
        {isBurst(summary) && <> · 지난 1시간에 {n(summary.lastHour.requests)}건이 몰려 들어왔습니다</>}
      </span>
      <Link className="takedown-strip-go" href="/admin/audit?tab=requests">{overdue ? "지금 처리 →" : "요청 처리 →"}</Link>
    </div>
  );
}
