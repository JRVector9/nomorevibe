import type { ReadinessReason } from "@/lib/operations/failover-readiness";
import type { CoreQuota } from "@/lib/crawl/github-secret";

export const EXPECTED_WEB_INSTANCES = ["m3-web", "mini-web"] as const;
export type WebStatus = { instance: string; release: string | null; stale?: boolean; observedAt?: string | null };
export type CollectorQuotaStatus = { sources: Array<{ label: string; quota: CoreQuota | null; observedAt: string | null; stale: boolean }>; readFailed: boolean };

export const READINESS_LABELS: Record<ReadinessReason, string> = {
  ready: "정상", primary_missing: "주 관측 없음", standby_missing: "예비 관측 없음", lease_missing: "담당 기록 없음",
  lease_expired: "담당 기한 지남", owner_mismatch: "담당 일치 확인 실패", release_mismatch: "주·예비 릴리스 불일치",
  primary_quarantined: "주 격리 중", standby_active: "예비가 일함",
};

export function webSummary(rows: WebStatus[]) {
  const expected = EXPECTED_WEB_INSTANCES.map((id) => rows.find((row) => row.instance === id));
  const fresh = expected.filter((row) => row?.observedAt && !row.stale).length;
  if (expected.some((row) => !row?.observedAt)) return { tone: "warn" as const, ready: false, label: `웹 관측 ${fresh}/2 · 누락` };
  if (fresh !== 2) return { tone: "warn" as const, ready: false, label: `웹 관측 ${fresh}/2 · 지연` };
  if (expected.some((row) => !row?.release || row.release === "unknown")) return { tone: "warn" as const, ready: false, label: "웹 릴리스 미확인" };
  if (expected[0]!.release !== expected[1]!.release) return { tone: "warn" as const, ready: false, label: "두 웹 릴리스 불일치" };
  return { tone: "ok" as const, ready: true, label: "웹 m3·mini 같은 릴리스" };
}
