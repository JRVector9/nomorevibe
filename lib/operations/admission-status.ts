import "server-only";
import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { sharedStore } from "@/lib/cache/shared";
import { admissionStatusFrom, type AdmissionStatus } from "./admission-headline";
import { sharedLoader } from "./shared-cache";

/**
 * 머리줄의 접수 상태(운영 콘솔 개편 조각 4b, 시안 흐름 6) — 어느 관리자 화면에서든 「접수 열림/중단 · 언제부터 · 누가」.
 * 읽기만 한다: 모델 접수 행(model_capacity_control id=1)과, 접수를 바꾼 마지막 작업 로그 한 줄(pipeline-control-capacity-mode — 운영 실행기·제어 CLI 가 남긴다).
 * 그 줄의 모드가 지금 모드와 같을 때만 「누가·언제부터」를 그 줄에서 쓴다(다르면 행이 바뀐 때만 — 누가는 모름).
 * 메뉴 배지와 같은 GET /admin/nav-badges 가 화면을 옮길 때마다 부르므로 웹들이 10초 나눠 쓴다. 실패는 던진다(부르는 쪽이 「셀 수 없음」으로 둔다).
 */
const cache = sharedLoader<AdmissionStatus>({ namespace: "admin:admission-status", ttlMs: 10_000, staleMs: 60_000, store: sharedStore });

async function loadAdmissionStatus(): Promise<AdmissionStatus> {
  return withDbDeadline(Date.now() + 2_000, () => onPrimary(async () => {
    const [row] = await db.execute<{ mode: string; updated_at: Date | string | null; actor: string | null; at: Date | string | null; last_mode: string | null }>(sql`
      SELECT c.mode, c.updated_at, a.actor, a.created_at AS at, a.last_mode
        FROM model_capacity_control c
        LEFT JOIN LATERAL (
          SELECT actor, created_at, detail->'after'->>'mode' AS last_mode FROM operations_audit
           WHERE action = 'pipeline-control-capacity-mode' AND ok ORDER BY id DESC LIMIT 1) a ON true
       WHERE c.id = 1`);
    const status = admissionStatusFrom(row ?? null);
    if (!status) throw new Error("admission_status_unreadable");
    return status;
  }));
}

export function readAdmissionStatus(fresh = false): Promise<AdmissionStatus> {
  return cache("v1", loadAdmissionStatus, fresh);
}
