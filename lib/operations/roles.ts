import { classifyFailoverReadiness, FAILOVER_ROLES, type ReadinessReason, type ReadinessSnapshot } from "./failover-readiness";
import { db } from "@/lib/db";
import { operationsObservations, roleLeases } from "@/lib/db/schema";
import { like, or, sql } from "drizzle-orm";

/**
 * 역할마다 지금 lease 를 쥔 쪽과 그 릴리스 — 운영센터 "역할 · 주/예비" 표.
 *
 * failover-readiness 는 판정(ready/standby_active…)만 돌려준다. 표에는 누가·어느 릴리스로·몇 번째
 * epoch 로 일하는지도 있어야 "예비가 일함"을 보고 바로 조치할 수 있다. 같은 관측을 한 번 읽어 둘 다 만든다.
 */
export type RoleOverview = {
  role: string; reason: ReadinessReason; ownerInstanceId: string | null; ownerKind: string | null;
  ownerRelease: string | null; epoch: number | null; secondsUntilExpiry: number | null;
  primaryRelease: string | null; standbyRelease: string | null;
};

/** 공통 이미지로 함께 올리는 역할 — 릴리스가 웹과 같아야 한다. maintenance·text 는 git 빌드라 따로 간다. */
export const SHARED_IMAGE_ROLES = new Set(["crawler", "reviewer", "publisher"]);

export async function roleOverview(): Promise<{ roles: RoleOverview[]; scheduler: { freshReplicas: number; alarm: boolean } }> {
  const [leases, observations] = await Promise.all([
    db.select({ role: roleLeases.role, ownerInstanceId: roleLeases.ownerInstanceId, ownerBootId: roleLeases.ownerBootId,
      ownerKind: roleLeases.ownerKind, ownerRelease: roleLeases.ownerRelease, epoch: roleLeases.epoch,
      secondsUntilExpiry: sql<number>`extract(epoch from (${roleLeases.leaseUntil} - localtimestamp))::double precision`,
      quarantineSeconds: sql<number | null>`extract(epoch from (${roleLeases.quarantineUntil} - localtimestamp))::double precision`,
    }).from(roleLeases),
    db.select({ key: operationsObservations.key, value: operationsObservations.value,
      ageSeconds: sql<number>`extract(epoch from (localtimestamp - ${operationsObservations.observedAt}))::double precision`,
    }).from(operationsObservations).where(or(like(operationsObservations.key, "candidate:%"), like(operationsObservations.key, "service:scheduler:%"))),
  ]);
  const candidates: ReadinessSnapshot["candidates"] = [];
  const schedulers: ReadinessSnapshot["schedulers"] = [];
  for (const row of observations) {
    const candidate = /^candidate:([^:]+):([^:]+)$/.exec(row.key);
    const value = row.value as Record<string, unknown>;
    if (candidate) {
      candidates.push({ role: candidate[1], instanceId: candidate[2],
        kind: typeof value.kind === "string" ? value.kind : "", phase: typeof value.phase === "string" ? value.phase : "",
        release: typeof value.release === "string" ? value.release : "", bootId: typeof value.bootId === "string" ? value.bootId : "",
        ageSeconds: row.ageSeconds, epoch: typeof value.epoch === "number" ? value.epoch : null });
      continue;
    }
    const scheduler = /^service:scheduler:([^:]+)$/.exec(row.key);
    if (scheduler) schedulers.push({ instanceId: scheduler[1], status: typeof value.status === "string" ? value.status : "",
      release: typeof value.release === "string" ? value.release : "", ageSeconds: row.ageSeconds });
  }
  const report = classifyFailoverReadiness({ leases, candidates, schedulers });
  const roles = FAILOVER_ROLES.map((role) => {
    const lease = leases.find((row) => row.role === role);
    const fresh = (kind: string) => candidates.find((row) => row.role === role && row.kind === kind && row.ageSeconds <= 60);
    return {
      role, reason: report.roles.find((row) => row.role === role)?.reason ?? "primary_missing",
      ownerInstanceId: lease?.ownerInstanceId ?? null, ownerKind: lease?.ownerKind ?? null, ownerRelease: lease?.ownerRelease ?? null,
      epoch: lease?.epoch ?? null, secondsUntilExpiry: lease?.secondsUntilExpiry ?? null,
      primaryRelease: fresh("primary")?.release ?? null, standbyRelease: fresh("standby")?.release ?? null,
    };
  });
  return { roles, scheduler: { freshReplicas: report.scheduler.freshReplicas, alarm: report.scheduler.alarm } };
}
