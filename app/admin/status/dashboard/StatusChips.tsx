import type { RoleOverview } from "@/lib/operations/roles";
import type { ModelHealth } from "@/lib/operations/dashboard";

/**
 * 머리말 상태 칩 — 한 줄로 "지금 괜찮은가".
 *
 * 워커 주 n/5 · 예비 n/5 · 스케줄러 n/2 · 웹 릴리스 일치 · 모델 n/m · GitHub 한도. 이상이 있으면 그 칩만 색이 바뀐다.
 */
export function StatusChips({ roles, scheduler, web, models, quota }: {
  roles: RoleOverview[]; scheduler: { freshReplicas: number; alarm: boolean };
  web: { instance: string; release: string | null }[]; models: ModelHealth[];
  quota: { remaining: number; limit: number; resetAt: string | null } | null;
}) {
  const primaryOk = roles.filter((row) => row.ownerKind === "primary" && row.reason === "ready").length;
  const standbyActive = roles.filter((row) => row.reason === "standby_active").length;
  const standbyPresent = roles.filter((row) => row.standbyRelease !== null).length;
  const webReleases = new Set(web.map((row) => row.release ?? "?"));
  const modelsOk = models.filter((row) => row.calls1h === 0 || (row.failed1h / row.calls1h < 0.1 && !(row.key === "second" && row.agreement1h !== null && row.agreement1h < 0.7))).length;
  const quotaTone = quota && quota.limit > 0 ? (quota.remaining / quota.limit < 0.1 ? "bad" : quota.remaining / quota.limit < 0.25 ? "warn" : undefined) : undefined;
  const chip = (tone: "ok" | "warn" | "bad" | undefined, text: string, key: string) => (
    <span key={key} className="dash-pill" data-tone={tone}><span className="dash-dot" data-tone={tone} aria-hidden />{text}</span>
  );
  return (
    <div className="dash-chips" aria-label="서비스 상태 요약">
      {chip(primaryOk === roles.length ? "ok" : standbyActive > 0 ? "warn" : "bad", `워커 주 ${primaryOk}/${roles.length}${standbyActive ? ` · 예비가 일함 ${standbyActive}` : ""}`, "primary")}
      {chip(standbyPresent === roles.length ? "ok" : "warn", `예비 ${standbyPresent}/${roles.length} 대기`, "standby")}
      {chip(scheduler.alarm ? "bad" : "ok", `스케줄러 ${scheduler.freshReplicas}/2`, "scheduler")}
      {chip(web.length === 0 ? "warn" : webReleases.size === 1 ? "ok" : "warn", web.length === 0 ? "웹 관측 없음" : webReleases.size === 1 ? "웹 m3·mini 같은 릴리스" : "웹 릴리스 불일치", "web")}
      {chip(modelsOk === models.length ? "ok" : "warn", `모델 ${modelsOk}/${models.length} 정상`, "models")}
      {quota && chip(quotaTone, `GitHub 한도 ${quota.remaining.toLocaleString("ko-KR")}/${quota.limit.toLocaleString("ko-KR")}${quota.resetAt ? ` · ${new Date(quota.resetAt).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false })} 초기화` : ""}`, "quota")}
    </div>
  );
}
