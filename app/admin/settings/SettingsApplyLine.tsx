import { StatusDot, type StatusState } from "../components/StatusDot";
import { shortSettingsVersion } from "@/lib/crawl/settings-version";
import { formatListTime } from "@/lib/format/time";
import type { RoleSettingsApply, SettingsApply } from "@/lib/operations/settings-apply";

/** 역할 한 칸 — "프로젝트 수집 v3f9a2c 13:41 (2분 전) 확인", "후보 심사 v1b2c3d 대기" */
function roleText(role: RoleSettingsApply, now: Date): { state: StatusState; label: string } {
  const version = role.reportedVersion ? shortSettingsVersion(role.reportedVersion) : "";
  switch (role.state) {
    case "applied": return { state: "ok", label: `${role.label} ${version} ${formatListTime(role.observedAt, now)} 확인` };
    case "waiting": return { state: role.lagging ? "delayed" : "idle", label: `${role.label} ${version} 대기` };
    case "unknown": return { state: "idle", label: `${role.label} 확인 안 됨` };
    case "inactive": return { state: "idle", label: `${role.label} 관측 없음` };
  }
}

/**
 * 설정 화면 머리의 적용 확인 — 저장한 판을 워커 역할마다 읽었는지(ADM-19).
 * 모두 같은 판이면 초록 체크 하나, 아니면 역할마다 상태를 늘어놓는다. 10분 넘게 옛 판이면 운영센터 조치할 일에도 오른다.
 */
export function SettingsApplyLine({ apply, now }: { apply: SettingsApply; now: Date }) {
  return (
    <p id="apply" className="flex scroll-mt-6 flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-fg-2">
      <span className="font-semibold">저장 판 <span className="font-mono">{shortSettingsVersion(apply.savedVersion)}</span></span>
      {apply.allApplied && <StatusDot state="ok" label="모든 워커가 이 판으로 돕니다" />}
      {apply.roles.map((role) => {
        const view = roleText(role, now);
        return (
          <span key={role.role} title={`${role.role}${role.state === "unknown" ? " — 판을 싣지 않는 옛 워커" : ""}`}>
            <StatusDot state={view.state} label={view.label} />
          </span>
        );
      })}
    </p>
  );
}
