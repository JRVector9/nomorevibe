import type { RoleOverview } from "@/lib/operations/roles";
import type { ModelHealth } from "@/lib/operations/dashboard";
import { FAILOVER_ROLES } from "@/lib/operations/failover-readiness";
import { webSummary, type WebStatus, type CollectorQuotaStatus } from "../status-summary";

/**
 * 머리말 상태 칩 — 한 줄로 "지금 괜찮은가".
 *
 * 워커 주 n/5 · 예비 n/5 · 스케줄러 n/2 · 웹 릴리스 일치 · 모델 n/m · GitHub 한도. 이상이 있으면 그 칩만 색이 바뀐다.
 */
export function StatusChips({ roles, scheduler, web, models, quota, now }: {
  roles: RoleOverview[] | null; scheduler: { freshReplicas: number; alarm: boolean } | null;
  web: WebStatus[]; models: ModelHealth[] | null;
  quota: CollectorQuotaStatus | null;
  /** 서버가 읽은 시각 — 초기화 시각을 "14:35 (42분 후)"로 */
  now: string;
}) {
  const expectedRoles = FAILOVER_ROLES.flatMap((name) => {
    const row = roles?.find((item) => item.role === name);
    return row ? [row] : [];
  });
  const primaryOk = expectedRoles.filter((row) => row.ownerKind === "primary" && row.reason === "ready").length;
  const standbyActive = expectedRoles.filter((row) => row.reason === "standby_active").length;
  const standbyPresent = expectedRoles.filter((row) => row.standbyRelease !== null).length;
  const webStatus = webSummary(web);
  const modelsOk = models?.filter((row) => row.calls1h === 0 || (row.failed1h / row.calls1h < 0.1 && !(row.key === "second" && row.agreement1h !== null && row.agreement1h < 0.7))).length ?? 0;
  const freshQuota = quota?.sources.filter((row) => !row.stale && row.quota) ?? [];
  const quotaWarn = quota?.readFailed || freshQuota.length !== quota?.sources.length || freshQuota.some((row) => row.quota!.limit > 0 && row.quota!.remaining / row.quota!.limit < 0.1);
  const chip = (tone: "ok" | "warn" | "bad" | undefined, text: string, key: string) => (
    <span key={key} className="dash-pill" data-tone={tone}><span className="dash-dot" data-tone={tone} aria-hidden />{text}</span>
  );
  return (
    <div className="dash-chips" aria-label="서비스 상태 요약" title={`저장된 관측 · ${now} 기준`}>
      {chip(roles === null ? "warn" : primaryOk === FAILOVER_ROLES.length ? "ok" : standbyActive > 0 ? "warn" : "bad", roles === null ? "워커 주 미확인" : `워커 주 ${primaryOk}/${FAILOVER_ROLES.length}${standbyActive ? ` · 예비가 일함 ${standbyActive}` : ""}`, "primary")}
      {chip(standbyPresent === FAILOVER_ROLES.length ? "ok" : "warn", roles === null ? "예비 미확인" : `예비 ${standbyPresent}/${FAILOVER_ROLES.length} 관측`, "standby")}
      {chip(!scheduler ? "warn" : scheduler.alarm ? "bad" : "ok", scheduler ? `스케줄러 ${scheduler.freshReplicas}/2` : "스케줄러 미확인", "scheduler")}
      {chip(webStatus.tone, webStatus.label, "web")}
      {chip(models?.length && modelsOk === models.length ? "ok" : "warn", models === null ? "모델 미확인" : models.length === 0 ? "모델 관측 없음" : `모델 ${modelsOk}/${models.length} 정상`, "models")}
      {quota && chip(quotaWarn ? "warn" : undefined, quota.readFailed ? "GitHub core 일부 조회 실패" : quota.sources.length ? `GitHub core 최신 ${freshQuota.length}/${quota.sources.length}` : "GitHub core 관측 없음", "quota")}
    </div>
  );
}
