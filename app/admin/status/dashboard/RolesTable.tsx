import type { RoleOverview } from "@/lib/operations/roles";

const REASON: Record<string, string> = {
  ready: "정상", primary_missing: "주 관측 없음", standby_missing: "예비 관측 없음", lease_missing: "lease 없음",
  lease_expired: "lease 만료", owner_mismatch: "주인 불일치", release_mismatch: "릴리스 불일치",
  primary_quarantined: "주 격리 중", standby_active: "예비가 일함",
};

/**
 * 역할 · 주/예비 — 다섯 역할이 어느 쪽에서 돌고 있고 넘겨받을 준비가 됐는지.
 *
 * 2026-10-02 maintenance 역할이 mini 예비로 넘어간 채 몇 시간 돌았는데 화면 어디에도 없었다.
 * 예비가 일하면 주황, 관측이 끊기면 빨강으로 바로 보인다.
 */
export function RolesTable({ roles, scheduler, web }: {
  roles: RoleOverview[]; scheduler: { freshReplicas: number; alarm: boolean }; web: { instance: string; release: string | null }[];
}) {
  const releases = new Set([...roles.map((row) => row.ownerRelease).filter(Boolean), ...web.map((row) => row.release).filter(Boolean)]);
  return (
    <section id="roles" className="dash-card dash-4" aria-label="역할과 예비">
      <div className="dash-card-h"><h2>역할 · 주/예비</h2><small>lease 45초 · 관측 15초</small></div>
      <div className="overflow-x-auto">
        <table className="dash-table dash-roles">
          <thead><tr><th>역할</th><th>일하는 쪽</th><th>릴리스</th></tr></thead>
          <tbody>
            {roles.map((row) => {
              const tone = row.reason === "ready" ? "ok" : row.reason === "standby_active" || row.reason === "release_mismatch" ? "warn" : "bad";
              const who = row.ownerKind === "standby" ? "mini 예비" : row.ownerKind === "primary" ? "M3 주" : "없음";
              return (
                <tr key={row.role} title={row.epoch !== null ? `lease epoch ${row.epoch}` : undefined}>
                  <td className="font-semibold">{row.role}</td>
                  <td><span className="dash-pill" data-tone={tone}><span><span className="dash-dot" data-tone={tone} aria-hidden /> {who}</span>{row.reason !== "ready" && <span>· {REASON[row.reason] ?? row.reason}</span>}</span></td>
                  <td className="font-mono text-[13px]">{row.ownerRelease?.slice(0, 7) ?? "—"}</td>
                </tr>
              );
            })}
            <tr>
              <td className="font-semibold">scheduler</td>
              <td><span className="dash-pill" data-tone={scheduler.alarm ? "bad" : "ok"}><span className="dash-dot" data-tone={scheduler.alarm ? "bad" : "ok"} aria-hidden />{scheduler.freshReplicas}/2 복제</span></td>
              <td className="font-mono text-[13px]">—</td>
            </tr>
            {web.map((row) => (
              <tr key={row.instance}>
                <td className="font-semibold">web · {row.instance}</td>
                <td><span className="dash-pill" data-tone={row.release ? "ok" : "warn"}><span className="dash-dot" data-tone={row.release ? "ok" : "warn"} aria-hidden />{row.release ? "응답" : "관측 없음"}</span></td>
                <td className="font-mono text-[13px]">{row.release?.slice(0, 7) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {releases.size > 1 && <p className="dash-note">릴리스가 {releases.size}가지입니다 — 주·예비 릴리스 절차(runbook 4)로 맞춥니다.</p>}
    </section>
  );
}
