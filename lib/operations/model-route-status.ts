import { statusRouteContracts, type ControlSnapshot, type ModelEnv, type RouteContract } from "./pipeline-control";
import { readControlSnapshot } from "./pipeline-control-repository";
import { readReplicaOrHold, type ReplicaRead } from "./replica-hold";

/** 관리자 화면에 보이는 경로 계약·전환 진행 — at 은 readback 의 DB 시각이다 */
export type ModelRouteStatus = { at: string; routes: RouteContract[]; stages: ControlSnapshot["stages"];
  batch: ControlSnapshot["batch"]; capacity: ControlSnapshot["capacity"] };

/**
 * 운영 CLI status 와 같은 readback(readControlSnapshot)·같은 route 판정(statusRouteContracts)을 관리자 화면에도(ops-v8 PR8).
 * 새로 읽는 값이라 복제본에서만 읽는다 — 복제본을 못 쓰거나 읽다 실패하면(시간 초과 등) 까닭과 함께 보류다. 주 DB 로 넘기지 않는다.
 */
export async function readModelRouteStatus(models: ModelEnv): Promise<ReplicaRead<ModelRouteStatus>> {
  const read = await readReplicaOrHold("operations.model_routes_unavailable", replica => readControlSnapshot(replica));
  if (!read.ok) return read;
  const snapshot = read.value;
  return { ok: true, value: { at: snapshot.now, routes: statusRouteContracts(snapshot, models), stages: snapshot.stages,
    batch: snapshot.batch, capacity: snapshot.capacity } };
}
