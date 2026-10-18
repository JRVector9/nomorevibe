import type { ActionInputs, DerivedStatus } from "@/app/(operator)/admin/status/attention";
import { humanOverview } from "./human-queue";

/**
 * 조치 계약 테스트용 입력 — 운영센터 "조치할 일"(attention.tsx buildActions)의 모든 갈래를 한 번에 켠다.
 *
 * 숫자는 2026-10-08·10-18 운영 화면에서 본 값을 옮겼다(사람 확인 2,270·저장소 사라짐 141·근거 39,749 등).
 * 시각은 ACTION_NOW(13:38 KST) 기준이다 — 검색 점검 관측은 Date.now() 로 신선도를 재므로 테스트가 시계를 맞춘다.
 */
export const ACTION_NOW = new Date("2026-10-08T04:38:00.000Z");

const ago = (minutes: number) => new Date(ACTION_NOW.getTime() - minutes * 60_000);
const instance = (role: string, instanceId: string, value: Record<string, unknown>) =>
  ({ key: `service:${role}:${instanceId}`, role, instanceId, observedAt: ACTION_NOW.toISOString(), value });
const jobState = (name: string, over: Record<string, unknown> = {}) =>
  ({ name, lastError: null, lastRunAt: null, lastSuccessAt: null, nextScheduledAt: null, notBefore: null, ...over });

/** 검색 데이터 자동 점검 관측 — searchHealthAlerts 의 일곱 갈래가 모두 켜진다 */
const searchHealthObservation = {
  key: "job:product-search-health", observedAt: ago(5).toISOString(),
  value: { events: [{ event: "search_health.checked", counts: {
    total: 11_558, missing: 3, oldMissing: 2, mismatched: 0, unmarked: 1, copiesMismatched: 4, pendingGeneration: 10,
    pendingVerification: 6, oldestVerificationMinutes: 50.7, repeatedFailures: 3, exhausted: 5, generatedRecent: 0, verifiedRecent: 0,
    generationIdleMinutes: 45,
  } }] },
};

/** 읽을 수 있는 것은 다 읽었고 거의 모든 것이 나쁜 상태 */
export function brokenActionInputs(): ActionInputs {
  return {
    settings: {},
    settingsApply: { savedVersion: "v2", roles: [], allApplied: false, attention: {
      key: "settings-apply", tone: "hold", count: 2, title: "설정을 저장했는데 워커 2개가 아직 옛 판으로 돕니다", detail: "후보 심사 · 제품 발행", href: "/admin#apply",
    } },
    ops: {
      fetchedAt: ACTION_NOW.toISOString(), dbLatencyMs: 1, audit: [],
      held: 5, heldNextRetryAt: new Date(ACTION_NOW.getTime() + 41 * 60_000).toISOString(),
      observations: [searchHealthObservation],
      serviceInstances: [
        instance("app", "m3-web", { release: "web-b" }), instance("app", "mini-web", { release: "web-a" }),
        instance("connect-agent", "m3", {
          config: { primary: { model: "gpt-5.5" }, fallback: { model: "sonnet" } },
          accounts: { codex: { result: "access_denied", checkedAt: ago(60).toISOString() }, claude: { result: "success" } },
          classifyReady: true, configReady: false, configVersion: 2,
        }),
        instance("publisher", "m3", { restartCount1h: 2 }), instance("text", "m3", { restartCount1h: 1 }), instance("crawler", "m3", { restartCount1h: 0 }),
      ],
    },
    jobStates: [
      jobState("product-evidence-refresh", { lastError: "boom" }), jobState("uptime-ping", { lastError: "boom" }),
      // 사람이 멈춘 잡 — notBefore 가 1년 넘게 뒤
      jobState("product-intro-check", { notBefore: new Date(ACTION_NOW.getTime() + 400 * 86_400_000) }),
    ],
    jobBatch: null,
    evidenceSummary: { due: 39_749, stale: 0, failed: 0, oldestDueHours: 200 },
    downCount: 3,
    overview: humanOverview({ human: 2_270, agreed: 12, oldestDays: 20, in24h: 40, stalled: 300, decided: 30, published: 4 }),
    secondFailures: [
      { model: "[MLX] qwen3.6", errorCode: "timeout", count: 4 },
      { model: null, errorCode: "model_unavailable", count: 1 },
    ],
    throughput: { measuredAt: ACTION_NOW.toISOString(), stages: [{ key: "first", label: "AI 1차 심사" }] },
    models: [
      { key: "second", label: "2차 투표", model: "[MLX] Qwen3.8-27B-NVFP4", calls1h: 34, failed1h: 8, avgSeconds: 11.6, agreement1h: 0.85, lastSuccessAt: null },
      // 호출이 10번이 안 되면 실패율을 따지지 않는다
      { key: "first", label: "1차 심사", model: "gpt-oss-120b", calls1h: 5, failed1h: 5, avgSeconds: 3, agreement1h: null, lastSuccessAt: null },
    ],
    attention: {
      auditRejectsOpen: 7, healthOverdue: 172, healthTargetPerHour: 6_796, introNeedsEditor: 9,
      auditCampaign: { id: 3, promptVersion: "2026-09-19.3", current: false, unanswered: 5_176 }, cdnPurgesPending: 2,
      repoGone: { installable: 0, website: 141 }, spamAutoBans: { day: 50, banned: 257 },
      repoHealth: { tracked: 1_000, checked24h: 40, states: {} },
      repoReview: { pending: 0, delistCandidates: 44, human: 97, kept: 0, oldestHours: 206 },
    },
    roles: {
      roles: [
        { role: "crawler", reason: "ready", ownerInstanceId: "m3", epoch: 1 },
        { role: "reviewer", reason: "lease_expired", ownerInstanceId: "m3", epoch: 7 },
        { role: "publisher", reason: "release_mismatch", ownerInstanceId: "m3", epoch: 2 },
        { role: "maintenance", reason: "standby_active", ownerInstanceId: "mini", epoch: 3 },
      ],
      scheduler: { freshReplicas: 1, alarm: false },
    },
    accounts: [{ enabled: true, login: "first", quotaObservedAt: ago(1),
      coreQuota: { remaining: 120, used: 4_880, limit: 5_000, reset: ACTION_NOW.getTime() / 1000 + 3_600 } }],
    apps: [],
    takedowns: { pending: 3, overdue: 1, oldestHours: 30, lastHour: { requests: 0 } },
    modelServers: [{ name: "embedding", ok: false, error: "ECONNREFUSED" }, { name: "rerank", ok: true, error: null }],
  } as unknown as ActionInputs;
}

/**
 * 워커 진행 판단(buildWorkerProgress)의 경보 — 그 판단은 worker-progress 테스트가 맡고, 여기서는 buildActions 가 받는 모양만 둔다.
 */
export function brokenWorkerProgress(): NonNullable<DerivedStatus["workerProgress"]> {
  return {
    liveness: [
      { role: "publisher", alarm: true, reason: "restart_loop" },
      { role: "text", alarm: true, reason: "missing" },
      { role: "crawler", alarm: false, reason: "fresh" },
    ],
    scheduler: { role: "scheduler", reason: "scheduler_missed", alarm: true, overdueJobs: ["uptime-ping", "crawl-seed"] },
    stages: [{ role: "reviewer", stage: "first", alarm: true, reason: "no_progress" }],
  } as unknown as NonNullable<DerivedStatus["workerProgress"]>;
}

/** 어느 집계도 읽지 못한 상태 — 관측도 없다 */
export function unreadableActionInputs(): ActionInputs {
  return {
    ...brokenActionInputs(),
    settingsApply: null,
    ops: { fetchedAt: ACTION_NOW.toISOString(), dbLatencyMs: 1, audit: [], held: 0, heldNextRetryAt: null, observations: [], serviceInstances: [] },
    jobStates: [],
    evidenceSummary: { due: 0, stale: 0, failed: 0, oldestDueHours: null },
    downCount: 0,
    overview: humanOverview(),
    secondFailures: [],
    throughput: null, models: null, attention: null, roles: null, accounts: null, apps: null, takedowns: null, modelServers: null,
  } as unknown as ActionInputs;
}
