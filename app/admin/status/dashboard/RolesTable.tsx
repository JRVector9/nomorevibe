import { SHARED_IMAGE_ROLES, type RoleOverview } from "@/lib/operations/roles";
import { ROLE_LABELS } from "@/lib/operations/contracts";
import { ScrollTable } from "../../components/ScrollTable";

const REASON: Record<string, string> = {
  ready: "정상", primary_missing: "주 관측 없음", standby_missing: "예비 관측 없음", lease_missing: "담당 기록 없음",
  lease_expired: "담당 기한 지남", owner_mismatch: "주인 불일치", release_mismatch: "릴리스 불일치",
  primary_quarantined: "주 격리 중", standby_active: "예비가 일함",
};

/**
 * 역할 · 주/예비 — 다섯 역할이 어느 쪽에서 돌고 있고 넘겨받을 준비가 됐는지.
 *
 * 2026-10-02 maintenance 역할이 mini 예비로 넘어간 채 몇 시간 돌았는데 화면 어디에도 없었다.
 * 예비가 일하면 주황, 관측이 끊기면 빨강으로 바로 보인다.
 * 역할은 사람이 읽는 이름으로 적고 코드(crawler 등)는 title 로만 둔다(ADM-28). 폰에서는 표만 옆으로 민다(ADM-30).
 */
export function RolesTable({ roles, scheduler, web }: {
  roles: RoleOverview[]; scheduler: { freshReplicas: number; alarm: boolean }; web: { instance: string; release: string | null; stale?: boolean }[];
}) {
  // maintenance·text 는 git 빌드라 릴리스가 달라도 정상 — 공통 이미지 역할과 웹만 센다
  const releases = new Set([...roles.filter((row) => SHARED_IMAGE_ROLES.has(row.role)).map((row) => row.ownerRelease).filter(Boolean), ...web.map((row) => row.release).filter(Boolean)]);
  return (
    <section id="roles" className="dash-card dash-4" aria-label="역할과 예비">
      <div className="dash-card-h"><h2>역할 · 주/예비</h2><small title="역할 담당(lease)은 45초마다 갱신, 워커 관측은 15초마다">담당 갱신 45초 · 관측 15초</small></div>
      <ScrollTable label="역할과 예비">
        <table className="dash-table dash-roles">
          <thead><tr><th>역할</th><th>일하는 쪽</th><th>릴리스</th></tr></thead>
          <tbody>
            {roles.map((row) => {
              const tone = row.reason === "ready" ? "ok" : row.reason === "standby_active" || row.reason === "release_mismatch" ? "warn" : "bad";
              const who = row.ownerKind === "standby" ? "mini 예비" : row.ownerKind === "primary" ? "M3 주" : "없음";
              return (
                <tr key={row.role} title={row.epoch !== null ? `${row.role} · 담당 차례(epoch) ${row.epoch}` : row.role}>
                  <td className="font-semibold">{ROLE_LABELS[row.role] ?? row.role}</td>
                  <td><span className="dash-pill" data-tone={tone}><span><span className="dash-dot" data-tone={tone} aria-hidden /> {who}</span>{row.reason !== "ready" && <span>· {REASON[row.reason] ?? row.reason}</span>}</span></td>
                  <td className="font-mono text-[13px]">{row.ownerRelease?.slice(0, 7) ?? "—"}</td>
                </tr>
              );
            })}
            <tr>
              <td className="font-semibold" title="scheduler">{ROLE_LABELS.scheduler}</td>
              <td><span className="dash-pill" data-tone={scheduler.alarm ? "bad" : "ok"}><span className="dash-dot" data-tone={scheduler.alarm ? "bad" : "ok"} aria-hidden />{scheduler.freshReplicas}/2 복제</span></td>
              <td className="font-mono text-[13px]">—</td>
            </tr>
            {web.map((row) => {
              const tone = row.stale ? "bad" : row.release ? "ok" : "warn";
              return (
              <tr key={row.instance}>
                <td className="font-semibold" title={row.instance}>웹 · {row.instance.replace(/-web$/, "")}</td>
                <td><span className="dash-pill" data-tone={tone}><span className="dash-dot" data-tone={tone} aria-hidden />{row.stale ? "관측 지연" : row.release ? "응답" : "관측 없음"}</span></td>
                <td className="font-mono text-[13px]">{row.release?.slice(0, 7) ?? "—"}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollTable>
      {releases.size > 1 && <p className="dash-note">공통 이미지 릴리스가 {releases.size}가지입니다 — 릴리스 도구로 8개 앱을 같은 SHA 로 맞춥니다.</p>}
    </section>
  );
}
