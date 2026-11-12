import { CHANGE_VERDICT_LABELS, CHANGE_VERDICT_TONES, type ChangeWatchSnapshot } from "@/lib/operations/change-watch";
import { StatusDot } from "../components/StatusDot";

/**
 * 기록의 「그 뒤」 칸 — 바꾼 것 지켜보기(조각 1c)가 이 줄(의 마지막 저장)을 담은 변경에 낸 판정과 바꾼 뒤 처리량(「첫 1시간 86건 → 지금 3건」).
 * 단계에 닿지 않는 변경(접수 전환·영향을 정할 수 없는 것)과 24시간이 지난 줄은 「—」. 작업 로그 화면의 ChangeAfter 와 같은 값이다.
 */
export async function LogAfter({ read, ids }: { read: Promise<ChangeWatchSnapshot | null>; ids: readonly number[] }) {
  const watch = await read;
  // 합친 줄은 마지막 저장의 판정을 본다(그 뒤의 상태가 지금 상태다)
  const row = [...ids].reverse().map(id => watch?.rows.find(entry => entry.ids.includes(id))).find(Boolean);
  if (!row || (row.measure === null && row.verdict !== "unused")) return <span className="lg-none">—</span>;
  const why = [row.reason, ...row.notes].filter(Boolean).join(" · ");
  return <span className="lg-after">
    <StatusDot state={CHANGE_VERDICT_TONES[row.verdict]} label={CHANGE_VERDICT_LABELS[row.verdict]} title={why || undefined} />
    <span className="lg-after-text" title={row.beforeText ? `${row.beforeText} → ${row.afterText}` : row.afterText}>{row.afterText}</span>
  </span>;
}
