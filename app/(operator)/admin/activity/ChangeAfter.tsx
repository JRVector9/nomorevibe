import Link from "next/link";
import { CHANGE_VERDICT_LABELS, CHANGE_VERDICT_TONES, type ChangeWatchSnapshot } from "@/lib/operations/change-watch";
import type { DeskUndo } from "@/lib/operations/operator-desk-model";
import { StatusDot } from "../components/StatusDot";

/**
 * 작업 로그의 「그 뒤」 칸(운영 콘솔 개편 조각 1c, 시안 「화면 6 기록」) — 지켜보기(lib/operations/change-watch)가 이 줄을 담은 변경에 낸 판정과
 * 바꾼 뒤의 처리량(「첫 1시간 86건 → 지금 3건」). 되돌리기는 새 쓰기 경로 없이 기존 「최근 바뀐 설정」의 되돌리는 곳(그 설정 화면)으로 잇는다.
 * 지켜보기 값은 표 둘레를 막지 않게 칸마다 Suspense 로 받는다(같은 읽기 하나를 나눠 쓴다).
 */
export async function ChangeAfter({ read, id, undo }: { read: Promise<ChangeWatchSnapshot | null>; id: number; undo: DeskUndo | null }) {
  const watch = await read;
  const row = watch?.rows.find(entry => entry.ids.includes(id));
  if (!row) return <span className="flex flex-col gap-0.5">
    <span className="text-fg-3" title={watch ? "이 줄은 지켜보기를 센 뒤에 생겼습니다 — 다음 갱신에서 셉니다" : "지켜보기를 읽지 못했습니다"}>{watch ? "세는 중" : "—"}</span>
    <UndoLink undo={undo} /></span>;
  const why = [row.reason, ...row.notes].filter(Boolean).join(" · ");
  const measured = row.measure !== null || row.verdict === "unused";
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {measured
        ? <><StatusDot state={CHANGE_VERDICT_TONES[row.verdict]} label={CHANGE_VERDICT_LABELS[row.verdict]} title={why || undefined} />
          <span className="truncate tabular-nums text-fg-2" title={row.beforeText ? `${row.beforeText} → ${row.afterText}` : row.afterText}>{row.afterText}</span></>
        : <span className="text-fg-3" title={why || undefined}>—</span>}
      <UndoLink undo={row.undo ?? undo} />
    </span>
  );
}

/** 되돌리는 곳 — 「최근 바뀐 설정」(operator-desk-model CHANGE_UNDO)이 아는 화면만. 되돌릴 수 없는 것은 그 안내를 글로 둔다 */
export function UndoLink({ undo }: { undo: DeskUndo | null }) {
  if (!undo) return null;
  if (!undo.href) return <span className="truncate text-fg-3" title={undo.text}>되돌릴 수 없음</span>;
  return <Link prefetch={false} href={undo.href} className="truncate text-accent hover:underline" title={undo.text}>되돌리러 가기</Link>;
}
