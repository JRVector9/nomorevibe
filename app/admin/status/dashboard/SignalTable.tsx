import Link from "next/link";
import type { SignalYield } from "@/lib/operations/dashboard";

const n = (value: number) => value.toLocaleString("ko-KR");

/**
 * 신호별 수율 · 7일 — 유입 → 발행, 그리고 흔적 게이트가 거른 수.
 *
 * 켜고 끌 근거가 되는 표다. 게이트 열은 requireEvidence 신호에서 `ai_evidence_not_found` 로 거절된 수다.
 */
export function SignalTable({ rows }: { rows: SignalYield[] }) {
  const shown = rows.slice(0, 9);
  return (
    <section className="dash-card dash-4" aria-label="신호별 수율">
      <div className="dash-card-h"><h2>신호별 수율 · 7일</h2><small><Link href="/admin">신호 설정 →</Link></small></div>
      {shown.length === 0 ? <p className="text-[13px] text-fg-3">최근 7일에 들어온 레포가 없습니다.</p> : (
        <div className="overflow-x-auto">
          <table className="dash-table">
            <thead><tr><th>신호</th><th className="num">유입</th><th className="num">발행</th><th>발행률</th><th>게이트</th></tr></thead>
            <tbody>
              {shown.map((row) => {
                const rate = row.enqueued > 0 ? row.published / row.enqueued : 0;
                return (
                  <tr key={row.signal}>
                    <td className="max-w-[150px] truncate" title={row.signal}>{row.signal}</td>
                    <td className="num">{n(row.enqueued)}</td>
                    <td className="num">{n(row.published)}</td>
                    <td><div className="dash-bar" title={`${Math.round(rate * 100)}%`}><i style={{ width: `${Math.round(rate * 100)}%` }} /></div></td>
                    <td>{row.requireEvidence
                      ? <span className="dash-pill" data-tone="acc">{row.gated > 0 ? `${n(row.gated)} 거름` : "켬"}</span>
                      : <span className="text-fg-3">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
