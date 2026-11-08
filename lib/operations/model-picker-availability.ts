import type { ModelCapacityMode } from "@/lib/llm/capacity";
import type { ModelCapacityRouteState } from "@/lib/llm/capacity-devices";

/** Observation only. Selecting a model neither reserves a slot nor authorizes execution. */
export type ModelPickerModelActivity = Readonly<{
  model: string; reserved: number; expiredReserved: number; running: number; waiting: number; indeterminate: number;
}>;
export type ModelPickerConnectionAvailability = Readonly<{
  connectionId: string; deviceId: string; enabled: boolean; deviceEnabled: boolean | null;
  source: "table" | "policy_fallback" | null;
  limit: number | null; occupied: number | null; free: number | null;
  reserved: number; expiredReserved: number; running: number; waiting: number; indeterminate: number;
  models: readonly ModelPickerModelActivity[];
  /** 경로 몫(0169, step 2): 이 장비의 경로마다 점유·대기·보장·상한, 유휴 보장 빌려주기. 장비 상태를 못 읽었으면 없다. 관측일 뿐이다. */
  routes?: readonly ModelCapacityRouteState[]; lendIdle?: boolean;
}>;
export type ModelPickerAvailability = Readonly<{
  observedAt: string; mode: ModelCapacityMode;
  connections: readonly ModelPickerConnectionAvailability[];
}>;

export function modelPickerActivityText(connection: ModelPickerConnectionAvailability, activity: readonly ModelPickerModelActivity[], mode: ModelCapacityMode): string {
  const running = activity.reduce((sum, row) => sum + row.running, 0);
  const reserved = activity.reduce((sum, row) => sum + row.reserved, 0);
  const waiting = activity.reduce((sum, row) => sum + row.waiting, 0);
  const expired = activity.reduce((sum, row) => sum + row.expiredReserved, 0);
  const unknown = activity.reduce((sum, row) => sum + row.indeterminate, 0);
  const controlStatus = !connection.enabled ? "연결 꺼짐" : connection.deviceEnabled === false ? "장비 설정 꺼짐"
    : mode === "draining" ? "접수 중지" : mode === "disabled" ? "슬롯 제어 꺼짐"
    : null;
  const status = running ? `실행 ${running}` : reserved ? `예약 ${reserved}` : waiting ? `대기 ${waiting}` : "미실행";
  const capacity = connection.free === null || connection.limit === null ? "공유 슬롯 확인 못함" : `공유 여유 ${connection.free}/${connection.limit}`;
  return [controlStatus, status, running && reserved ? `예약 ${reserved}` : "", (running || reserved) && waiting ? `대기 ${waiting}` : "",
    expired ? `만료 정리 대기 ${expired}` : "", unknown ? `미확정 ${unknown}` : "", capacity,
    connection.source === "policy_fallback" ? "정책 대체 한도" : ""].filter(Boolean).join(" · ");
}
