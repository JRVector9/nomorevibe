import type { AdminModelsObservation } from "./admin-models-observation";
import { deviceDisplayMap, helperRouteOf, routeDisplayLabel, type DisplayConnection } from "./llm-display";

/**
 * 「보조 모델」(/admin/models/helpers) 의 보조 작업 경로 표 — LLM 보조 작업 경로(local-assist-<작업>-<백엔드>)를 경로 × 장비 한 줄씩 모은다.
 * DB 를 읽지 않는 순수 함수다. 입력은 대시보드·칸 배분과 같은 장부 관측(readAdminModelsObservation({ throughput: false }))과 AI 연결이다.
 *
 * 마지막 사용 = 장부 관측의 lastSuccessAt — 최근 24시간 안 마지막 「성공」 정산이다(관측 읽기가 settled_at 24시간 창만 본다).
 * 24시간보다 오래된 사용은 새 장부 읽기 없이는 알 수 없다: model_capacity_requests 에 (route_id, settled_at) 색인이 없어
 * 경로별 max(settled_at) 은 그 경로의 모든 행(또는 전 경로의 정산 색인 구간)을 훑는다 — 그래서 「24시간 안 없음」으로 적고 지어내지 않는다.
 */

export type HelperRouteLevel = "ok" | "warn" | "bad" | "idle";
export type HelperRouteRow = Readonly<{
  routeId: string; deviceId: string;
  /** 작업 이름(routeDisplayLabel 에서 「보조 · 」를 뗀 것 — 표 제목이 이미 「보조 작업」이다) */
  label: string;
  /** 장비의 보이는 이름(연결 이름 — llm-display deviceDisplay). 장비 id 는 title 에만 */
  server: string;
  models: readonly string[];
  /** 최근 24시간 안 마지막 성공 정산 시각(ISO). null = 24시간 안 없음 */
  lastSuccessAt: string | null;
  held: number; waiting: number; indeterminate: number; succeeded1h: number; failed1h: number;
  /** 지금 정책(검증된 policy routes)에 이 경로 → 장비가 있는가 */
  inPolicy: boolean;
  level: HelperRouteLevel; status: string;
}>;
export type HelperRoutesView = Readonly<{
  readable: boolean; observedAt: string | null; rows: readonly HelperRouteRow[];
  /** 「쉼」(24시간 안 정산·점유·대기 없음) 줄 수 */
  idle: number;
  /** 전 경로의 마지막 성공(24시간 안) */
  lastSuccessAt: string | null;
  error: string | null;
}>;

const fmt = (value: number) => value.toLocaleString("ko-KR");
const readable = (observation: AdminModelsObservation) => !observation.error && !!observation.observedAt;
const later = (a: string | null, b: string | null) => !a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a;

/** 줄 상태 — 실패만 > 미확정 > 대기 > 실행 중 > 24시간 안 사용 > 쉼. 색만으로 가르지 않게 글자를 함께 준다 */
function statusOf(row: Pick<HelperRouteRow, "held" | "waiting" | "indeterminate" | "succeeded1h" | "failed1h" | "lastSuccessAt">): { level: HelperRouteLevel; status: string } {
  if (row.failed1h > 0 && row.succeeded1h === 0) return { level: "bad", status: `실패만 ${fmt(row.failed1h)}건(1시간)` };
  if (row.indeterminate > 0) return { level: "warn", status: `미확정 ${fmt(row.indeterminate)}건` };
  if (row.waiting > 0) return { level: "warn", status: `대기 ${fmt(row.waiting)}` };
  if (row.held > 0) return { level: "ok", status: `실행 중 ${fmt(row.held)}` };
  if (row.lastSuccessAt) return { level: "ok", status: "쓰는 중" };
  return { level: "idle", status: "쉼" };
}

export function buildHelperRoutesView(input: Readonly<{ observation: AdminModelsObservation; connections: readonly DisplayConnection[] | null }>): HelperRoutesView {
  const { observation } = input;
  if (!readable(observation)) return { readable: false, observedAt: null, rows: [], idle: 0, lastSuccessAt: null,
    error: "장부(운영 DB)를 읽지 못해 보조 작업 경로를 보이지 못합니다 — 0건으로 보지 마세요." };
  const names = deviceDisplayMap(input.connections, observation);
  const policy = new Set((observation.configuredRoutes ?? []).map(route => `${route.routeId}\u0000${route.groupId}`));
  type Acc = { routeId: string; deviceId: string; models: Set<string>; lastSuccessAt: string | null; held: number; waiting: number; indeterminate: number;
    succeeded1h: number; failed1h: number };
  const byKey = new Map<string, Acc>();
  for (const row of observation.rows) {
    if (!helperRouteOf(row.routeId)) continue;
    const key = `${row.routeId}\u0000${row.groupId}`;
    const acc = byKey.get(key) ?? { routeId: row.routeId, deviceId: row.groupId, models: new Set<string>(), lastSuccessAt: null, held: 0, waiting: 0, indeterminate: 0,
      succeeded1h: 0, failed1h: 0 };
    acc.models.add(row.model);
    acc.lastSuccessAt = later(acc.lastSuccessAt, row.lastSuccessAt);
    // 점유 = 예약 + 보냄 + 결과 미확정 점유(유지 시간 안의 미확인, 2026-11-10 — 입장과 같은 규칙)
    acc.held += row.reserved + row.dispatched + (row.heldUnknown ?? 0); acc.waiting += row.waiting; acc.indeterminate += row.indeterminate;
    acc.succeeded1h += row.succeeded1h; acc.failed1h += row.failed1h;
    byKey.set(key, acc);
  }
  const rows = [...byKey.entries()].map(([key, acc]): HelperRouteRow => {
    const base = { routeId: acc.routeId, deviceId: acc.deviceId, label: routeDisplayLabel(acc.routeId).replace(/^보조 · /, ""),
      server: names.get(acc.deviceId)?.name ?? acc.deviceId, models: [...acc.models].sort(), lastSuccessAt: acc.lastSuccessAt, held: acc.held, waiting: acc.waiting,
      indeterminate: acc.indeterminate, succeeded1h: acc.succeeded1h, failed1h: acc.failed1h, inPolicy: policy.has(key) };
    return { ...base, ...statusOf(base) };
  }).sort((a, b) => a.server.localeCompare(b.server, "ko") || a.label.localeCompare(b.label, "ko") || a.routeId.localeCompare(b.routeId));
  return { readable: true, observedAt: observation.observedAt, rows, idle: rows.filter(row => row.level === "idle").length,
    lastSuccessAt: rows.reduce<string | null>((last, row) => later(last, row.lastSuccessAt), null), error: null };
}
