/**
 * 상태 점(2026-10-08 UX 감사 ADM-31) — 색만으로 정상과 오류를 가르지 않는다. 모양(● ▲ ■ ○)과 글자를 늘 함께 낸다.
 *
 *   <StatusDot state="failed" />                         // ■ 실패
 *   <StatusDot state="delayed" label="12분 늦음" />       // ▲ 12분 늦음
 *   <StatusDot state="ok" label="crawler" title="마지막 실행 13:38" />
 */
export type StatusState = "ok" | "delayed" | "failed" | "idle";

export const STATUS_LABELS: Record<StatusState, string> = { ok: "정상", delayed: "지연", failed: "실패", idle: "대기" };

export function StatusDot({ state, label, title }: { state: StatusState; label?: string; title?: string }) {
  return (
    <span className="admin-status" data-state={state} title={title}>
      <span className="admin-status-mark" aria-hidden="true" />
      {label ?? STATUS_LABELS[state]}
      {/* 글자를 바꿔 달아도 상태 이름은 읽히게 */}
      {label && <span className="admin-vh"> ({STATUS_LABELS[state]})</span>}
    </span>
  );
}
