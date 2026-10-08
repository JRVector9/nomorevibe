import type { AdminLogRow } from "@/lib/operations/admin-log";

/**
 * 작업 로그 한 줄의 내용 요약 — 화면은 한 줄로 두고 펼쳐서 보며(2026-10-08 UX 감사 ADM-32), 내보내기도 같은 줄을 싣는다.
 * 원시 JSON(ids: [143580,…])을 그대로 보이지 않는다 — 여러 건을 바꾼 줄은 "237건 · 이유"로 줄인다(ADM-21).
 */

type Row = Pick<AdminLogRow, "detail" | "ip" | "userAgent">;

/** 브라우저 밖(스크립트·워커)에서 남긴 줄 — 접속 주소도 브라우저도 없다. 옛 스크립트 줄은 처리 방식까지 비어 있다 */
export const isScriptRow = (row: Pick<AdminLogRow, "ip" | "userAgent">) => !row.ip && !row.userAgent;

/** 값 하나를 한 줄로 — 목록은 "N개"로, 길면 자른다 */
function brief(value: unknown): string {
  if (Array.isArray(value)) return `${value.length.toLocaleString("ko-KR")}개`;
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "없음";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** 여러 건을 한 번에 바꾼 줄의 건수 — 스크립트마다 이름이 다르다(count·requeued·applied, 아니면 ids·slugs 의 길이) */
function bulkCount(detail: Record<string, unknown>): number | null {
  for (const key of ["count", "requeued", "applied", "changed"]) if (typeof detail[key] === "number") return detail[key] as number;
  for (const key of ["ids", "slugs"]) if (Array.isArray(detail[key])) return (detail[key] as unknown[]).length;
  return null;
}

/** 왜 — 스크립트가 남긴 사유, 메모, 아니면 무엇에서 무엇으로 */
function why(detail: Record<string, unknown>): string | null {
  for (const key of ["reason", "note"]) if (typeof detail[key] === "string" && detail[key]) return brief(detail[key]);
  if (typeof detail.from === "string" && typeof detail.to === "string") return `${detail.from} → ${detail.to}`;
  return null;
}

/** 펼쳤을 때의 줄 — 설정은 바뀐 경로만, 나머지는 값이 있는 항목만 */
export function summaryLines(row: Row): string[] {
  const detail = row.detail ?? {};
  if (Array.isArray(detail.changes)) {
    const changes = detail.changes as { path: string; before: unknown; after: unknown }[];
    if (!changes.length) return ["바뀐 값 없음"];
    const lines = changes.slice(0, 4).map((change) => `${change.path}: ${brief(change.before)} → ${brief(change.after)}`);
    return changes.length > 4 ? [...lines, `외 ${changes.length - 4}개`] : lines;
  }
  return Object.entries(detail).filter(([, value]) => value !== null && value !== "" && value !== undefined)
    .map(([key, value]) => `${key}: ${brief(value)}`);
}

/** 한 줄 요약 */
export function summaryLine(row: Row): string {
  const detail = row.detail ?? {};
  const count = bulkCount(detail);
  if (count !== null && !Array.isArray(detail.changes)) {
    const reason = why(detail);
    return `${count.toLocaleString("ko-KR")}건${reason ? ` · ${reason}` : ""}`;
  }
  const lines = summaryLines(row);
  if (!lines.length) return "—";
  return lines.length > 2 ? `${lines.slice(0, 2).join(" · ")} 외 ${lines.length - 2}개` : lines.join(" · ");
}
