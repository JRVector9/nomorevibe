import type { CapacityDevicesAdminView } from "@/lib/operations/admin-capacity-devices";
import type { CapacityUnknownReport } from "@/lib/operations/model-capacity-unknowns";

/**
 * 고급 설정(/admin/models/advanced, PR 5) 그리기 시험의 저장소 읽기 값 — 실제 로더가 돌려주는 모양 그대로(숫자를 지어내지 않는다).
 * 단계 × 모델 표는 admin-models-redesign 의 장부 관측을 쓰고, 여기는 장비·장부 경보·작업 실행 기록만 둔다.
 */
export const advancedNow = "2026-10-29T07:00:00.000Z";

export const advancedDevices: CapacityDevicesAdminView = { mode: "open", epoch: 7, revision: 14, policyVerified: true, controlError: null, rowsError: null, statesError: null,
  lendingCount: 0, issues: [], audit: [],
  devices: [{ deviceId: "gpu3090", source: "table", enabled: true, version: 12, updatedBy: "jr", updatedAt: advancedNow,
    settings: { limitSlots: 4, secondaryCap: 2, idleMs: 60_000, reserveSlots: 0, physicalLimit: 4, note: null },
    defaults: { limitSlots: 4, secondaryCap: 4, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, note: null }, policyRoutes: ["crawl-agent-review"],
    roles: [{ routeId: "crawl-agent-review", rank: 1, label: "1차 검수", inPolicy: true }],
    live: { source: "table", limitSlots: 4, active: 1, primaryBusy: false, secondaryActive: 0, secondaryBound: 2, lending: false, waiting: 0, waitingPrimary: 0 }, issues: [] }] };

export const advancedUnknowns: CapacityUnknownReport = { status: "review", truncated: false, requests: [], count: 1, oldestAgeSeconds: 1200, stuckDispatched: 0, alarmReasons: [] };

export const advancedJobs = { error: null, rows: [{ name: "held-qwen-retry", intervalMs: 60_000, registered: true, nextInSeconds: 30, lastRunAgoSeconds: 20,
  lastSuccessAgoSeconds: 20, runs: 3, lastError: null }] };
