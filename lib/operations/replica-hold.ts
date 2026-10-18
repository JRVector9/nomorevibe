import { readReplicaOnly } from "@/lib/db";
import type { ReplicaOnlyUnavailable } from "@/lib/db/replica";
import { logger } from "@/lib/observability/logger";

/** 새 칸이 보류한 까닭 — 복제본 전용 읽기가 돌려준 것(lib/db/replica.ts)과, 복제본에서 읽다 던진 오류(문장 시간 초과 57014 등) */
export type ReplicaHoldReason = ReplicaOnlyUnavailable | "error";
export type ReplicaRead<T> = { ok: true; value: T } | { ok: false; reason: ReplicaHoldReason };

const HOLD_TEXT: Record<ReplicaHoldReason, string> = {
  no_replica: "복제본 설정이 없습니다", lagging: "복제본이 10초 넘게 밀렸습니다", down: "복제본에 연결되지 않습니다",
  conflict: "복제 적용과 부딪혀 취소됐습니다", readonly: "복제본에 쓰려 해 멈췄습니다", error: "읽다가 실패했습니다(시간 초과 등)",
};
/** 보류 까닭의 쉬운 말 */
export const replicaHoldText = (reason: ReplicaHoldReason) => HOLD_TEXT[reason];

/**
 * 운영센터 v8 새 칸의 읽기 — 복제본에서만 읽고(readReplicaOnly), 복제본 문제든 읽다 던진 오류든 던지지 않고 보류로 돌려준다.
 * 주 DB 로 넘기지 않는다. 오류는 event 로 남긴다.
 */
export async function readReplicaOrHold<T>(event: string, load: Parameters<typeof readReplicaOnly<T>>[0]): Promise<ReplicaRead<T>> {
  try {
    return await readReplicaOnly(load);
  } catch (error) {
    logger.warn(event, { error });
    return { ok: false, reason: "error" };
  }
}
