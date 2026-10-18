import { db, readReplicaOnly } from "@/lib/db";
import { logger } from "@/lib/observability/logger";
import { statusRouteContracts, type ControlSnapshot, type ModelEnv, type RouteContract } from "./pipeline-control";
import { readControlSnapshot } from "./pipeline-control-repository";

/** 관리자 화면에 보이는 경로 계약·전환 진행 — at 은 readback 의 DB 시각이다 */
export type ModelRouteStatus = { at: string; routes: RouteContract[]; stages: ControlSnapshot["stages"];
  batch: ControlSnapshot["batch"]; capacity: ControlSnapshot["capacity"] };

/**
 * 운영 CLI status 와 같은 readback(readControlSnapshot)·같은 route 판정(statusRouteContracts)을 관리자 화면에도(ops-v8 PR8).
 * 새로 읽는 값이라 복제본에서만 읽는다 — 복제본이 없거나 밀렸거나 실패하면 null 이고 화면은 "보류"다. 주 DB 로 넘기지 않는다.
 */
export async function readModelRouteStatus(models: ModelEnv): Promise<ModelRouteStatus | null> {
  try {
    const snapshot = await readReplicaOnly(() => readControlSnapshot(db));
    if (!snapshot) return null;
    return { at: snapshot.now, routes: statusRouteContracts(snapshot, models), stages: snapshot.stages,
      batch: snapshot.batch, capacity: snapshot.capacity };
  } catch (error) {
    logger.warn("operations.model_routes_unavailable", { error });
    return null;
  }
}
