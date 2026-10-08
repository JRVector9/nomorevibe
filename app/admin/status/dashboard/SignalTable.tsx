import Link from "next/link";
import type { SignalYield } from "@/lib/operations/dashboard";
import { ScrollTable } from "../../components/ScrollTable";

const n = (value: number) => value.toLocaleString("ko-KR");

/**
 * 신호별 수율 · 7일 — 유입 → 발행, 그리고 흔적 게이트가 거른 수.
 *
 * 켜고 끌 근거가 되는 표다. 게이트 열은 requireEvidence 신호에서 `ai_evidence_not_found` 로 거절된 수다.
 * 운영센터에서 신호별 수율은 이 카드 하나다 — 접힌 상세 지표에 있던 옛 표는 뺐다(ADM-16).
 * 숫자 칸은 줄을 바꾸지 않는다(1440px 에서 "75,341"이 한 글자씩 세로로 쌓였다, ADM-17). 신호 이름은 말줄임·title.
 */
export function SignalTable({ rows }: { rows: SignalYield[] }) {
  const shown = rows.slice(0, 9);
  return (
    <section className="dash-card dash-4" aria-label="신호별 수율">
      <div className="dash-card-h"><h2>신호별 수율 · 7일</h2><small><Link href="/admin">신호 설정 →</Link></small></div>
      {shown.length === 0 ? <p className="text-[13px] text-fg-3">최근 7일에 들어온 레포가 없습니다.</p> : (
        <ScrollTable label="신호별 수율">
          <table className="dash-table dash-signals">
            <thead><tr><th>신호</th><th className="num">유입</th><th className="num">발행</th><th>발행률</th><th>게이트</th></tr></thead>
            <tbody>
              {shown.map((row) => {
                const rate = row.enqueued > 0 ? row.published / row.enqueued : 0;
                return (
                  <tr key={row.signal}>
                    <td title={row.signal}><span className="dash-signal-name">{row.signal}</span></td>
                    <td className="num">{n(row.enqueued)}</td>
                    <td className="num">{n(row.published)}</td>
                    <td><div className="dash-bar" title={`${Math.round(rate * 100)}%`}><i style={{ width: `${Math.round(rate * 100)}%` }} /></div></td>
                    <td className="whitespace-nowrap">{row.requireEvidence
                      ? <span className="dash-pill" data-tone="acc">{row.gated > 0 ? `${n(row.gated)} 거름` : "켬"}</span>
                      : <span className="text-fg-3">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollTable>
      )}
    </section>
  );
}
