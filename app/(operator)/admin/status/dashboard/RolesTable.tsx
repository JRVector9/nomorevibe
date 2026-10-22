import type { RoleOverview } from "@/lib/operations/roles";
import { ROLE_LABELS } from "@/lib/operations/contracts";
import { ScrollTable } from "../../components/ScrollTable";

import { READINESS_LABELS, webSummary, type WebStatus } from "../status-summary";

/**
 * 역할 · 주/예비 — 다섯 역할이 어느 쪽에서 돌고 있고 넘겨받을 준비가 됐는지.
 *
 * 2026-10-02 maintenance 역할이 mini 예비로 넘어간 채 몇 시간 돌았는데 화면 어디에도 없었다.
 * 예비가 일하면 주황, 관측이 끊기면 빨강으로 바로 보인다.
 * 역할은 사람이 읽는 이름으로 적고 코드(crawler 등)는 title 로만 둔다(ADM-28). 폰에서는 표만 옆으로 민다(ADM-30).
 */
/** 격리 남은 시간 "12분 30초"·"40초" */
const quarantineLeft = (seconds: number) => {
  const total = Math.ceil(seconds), minutes = Math.floor(total / 60), rest = total % 60;
  return minutes > 0 ? (rest ? `${minutes}분 ${rest}초` : `${minutes}분`) : `${rest}초`;
};

export function RolesTable({ roles, scheduler, web }: {
  roles: RoleOverview[] | null; scheduler: { freshReplicas: number; alarm: boolean } | null; web: WebStatus[];
}) {
  const webStatus = webSummary(web);
  return (
    <section id="roles" className="dash-card dash-4" aria-label="역할과 예비">
      <div className="dash-card-h"><h2>역할 · 주/예비</h2><small title="역할 담당(lease)은 45초마다 갱신, 워커 관측은 15초마다">담당 갱신 45초 · 관측 15초</small></div>
      <ScrollTable label="역할과 예비">
        <table className="dash-table dash-roles">
          <thead><tr><th>역할</th><th>일하는 쪽</th><th>주 · 예비 릴리스</th><th>담당 기한 · 차례</th></tr></thead>
          <tbody>
            {roles === null && <tr><td colSpan={4}>역할·예비 상태를 읽지 못했습니다.</td></tr>}
            {roles?.map((row) => {
              const tone = row.reason === "ready" ? "ok" : row.reason === "standby_active" || row.reason === "standby_missing" || row.reason === "release_mismatch" ? "warn" : "bad";
              const who = row.ownerKind === "standby" ? "mini 예비" : row.ownerKind === "primary" ? "M3 주" : "없음";
              return (
                <tr key={row.role} title={row.epoch !== null ? `${row.role} · 담당 차례(epoch) ${row.epoch}` : row.role}>
                  <td className="font-semibold">{ROLE_LABELS[row.role] ?? row.role}</td>
                  <td title={row.ownerInstanceId ?? "담당 미확인"}><span className="dash-pill" data-tone={tone}><span><span className="dash-dot" data-tone={tone} aria-hidden /> {who}</span>{row.reason !== "ready" && <span>· {READINESS_LABELS[row.reason]}</span>}</span><small className="block text-fg-3">담당 {row.ownerRelease?.slice(0, 7) ?? "미확인"}</small></td>
                  <td className="font-mono text-[13px]">{row.primaryRelease?.slice(0, 7) ?? "미관측"} · {row.standbyRelease?.slice(0, 7) ?? "미관측"}</td>
                  <td className="font-mono text-[13px]">{row.secondsUntilExpiry === null ? "미확인" : row.secondsUntilExpiry <= 0 ? "만료" : `${Math.ceil(row.secondsUntilExpiry)}초 남음`} · {row.epoch ?? "—"}
                    {/* 주 격리(5분에 세 번 넘게 재시작 → 15분) — 남은 시간이 지나야 주가 담당을 다시 잡는다 */}
                    {row.quarantineSeconds !== null && <small className="block text-warn" title="주가 5분 안에 세 번 넘게 다시 떠 15분 동안 담당을 다시 잡지 못합니다">주 격리 {quarantineLeft(row.quarantineSeconds)} 남음</small>}</td>
                </tr>
              );
            })}
            <tr>
              <td className="font-semibold" title="scheduler">{ROLE_LABELS.scheduler}</td>
              <td><span className="dash-pill" data-tone={!scheduler ? "warn" : scheduler.alarm ? "bad" : "ok"}><span className="dash-dot" data-tone={!scheduler ? "warn" : scheduler.alarm ? "bad" : "ok"} aria-hidden />{scheduler ? `${scheduler.freshReplicas}/2 복제` : "조회 미확인"}</span></td>
              <td className="font-mono text-[13px]">—</td>
              <td>—</td>
            </tr>
            {web.map((row) => {
              const missing = !row.observedAt;
              const tone = row.stale || missing ? "warn" : row.release && row.release !== "unknown" ? "ok" : "warn";
              return (
              <tr key={row.instance}>
                <td className="font-semibold" title={row.instance}>웹 · {row.instance.replace(/-web$/, "")}</td>
                <td><span className="dash-pill" data-tone={tone}><span className="dash-dot" data-tone={tone} aria-hidden />{missing ? "관측 없음" : row.stale ? "관측 지연" : row.release && row.release !== "unknown" ? "응답 관측" : "릴리스 미확인"}</span></td>
                <td className="font-mono text-[13px]">{row.release?.slice(0, 7) ?? "—"}</td>
                <td>—</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollTable>
      {!webStatus.ready && <p className="dash-note">{webStatus.label}</p>}
      <p className="dash-note">주·예비는 역할별로, 웹은 두 웹끼리 비교합니다. 웹과 워커의 릴리스는 별도 배포에서 다를 수 있습니다. 웹 두 관측 ID는 개별 복제본의 상태를 증명하지 않습니다.</p>
    </section>
  );
}
