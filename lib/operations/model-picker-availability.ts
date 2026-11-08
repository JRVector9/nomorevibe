import type { ModelCapacityMode } from "@/lib/llm/capacity";

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
}>;
export type ModelPickerAvailability = Readonly<{
  observedAt: string; mode: ModelCapacityMode;
  connections: readonly ModelPickerConnectionAvailability[];
}>;

/** 관측 한 조각 — warn 은 사람이 볼 것(꺼짐·접수 중지·미확정·만료 정리·여유 0·슬롯 확인 못함). 화면이 조각마다 따로 그린다. */
export type ModelPickerActivityPart = Readonly<{ text: string; tone: "warn" | null }>;

export function modelPickerActivityParts(connection: ModelPickerConnectionAvailability, activity: readonly ModelPickerModelActivity[], mode: ModelCapacityMode): ModelPickerActivityPart[] {
  const running = activity.reduce((sum, row) => sum + row.running, 0);
  const reserved = activity.reduce((sum, row) => sum + row.reserved, 0);
  const waiting = activity.reduce((sum, row) => sum + row.waiting, 0);
  const expired = activity.reduce((sum, row) => sum + row.expiredReserved, 0);
  const unknown = activity.reduce((sum, row) => sum + row.indeterminate, 0);
  const controlStatus = !connection.enabled ? "연결 꺼짐" : connection.deviceEnabled === false ? "장비 설정 꺼짐"
    : mode === "draining" ? "접수 중지" : mode === "disabled" ? "슬롯 제어 꺼짐"
    : null;
  const status = running ? `실행 ${running}` : reserved ? `예약 ${reserved}` : waiting ? `대기 ${waiting}` : "미실행";
  const capacityKnown = connection.free !== null && connection.limit !== null;
  const capacity = capacityKnown ? `공유 여유 ${connection.free}/${connection.limit}` : "공유 슬롯 확인 못함";
  const parts: [string, "warn" | null][] = [[controlStatus ?? "", "warn"], [status, null], [running && reserved ? `예약 ${reserved}` : "", null],
    [(running || reserved) && waiting ? `대기 ${waiting}` : "", null], [expired ? `만료 정리 대기 ${expired}` : "", "warn"], [unknown ? `미확정 ${unknown}` : "", "warn"],
    [capacity, !capacityKnown || connection.free === 0 ? "warn" : null], [connection.source === "policy_fallback" ? "정책 대체 한도" : "", null]];
  return parts.filter(([text]) => text).map(([text, tone]) => ({ text, tone }));
}

export function modelPickerActivityText(connection: ModelPickerConnectionAvailability, activity: readonly ModelPickerModelActivity[], mode: ModelCapacityMode): string {
  return modelPickerActivityParts(connection, activity, mode).map(part => part.text).join(" · ");
}
