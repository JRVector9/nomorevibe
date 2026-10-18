import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_NOW, brokenActionInputs } from "./fixtures/operations-actions";

/**
 * 조치 계약(운영센터 개편 v8 PR1) 중 기억에 닿는 것 — DB 없이 오늘 동작을 고정한다.
 *
 * - 24시간 변화: recordAttentionSample 이 관측 표 한 줄(attention:history)에 55분마다 한 번, 25시간치만 남긴다.
 * - 확인함 · 7일 숨김: acknowledgeAttention 이 쌓인 일 열쇠만 받아 작업 로그에 7일로 남긴다.
 * - 메뉴 긴급 배지: criticalActionCount 가 30초 들고, 5분까지는 지난 값을 주며 뒤에서 다시 센다. 센 뒤 시간별 수를 남긴다.
 *
 * 같은 동작의 실제 DB 판(동시 기록 한 줄·DB 시계 7일)은 tests/integration/operations-attention.test.ts 가 CI 에서 본다.
 */
const store = vi.hoisted(() => ({
  row: null as null | { key: string; value: unknown; observedAt: Date },
  audit: [] as Array<Record<string, unknown>>,
}));
const mocks = vi.hoisted(() => ({
  currentAdmin: vi.fn(), operationsData: vi.fn(), listJobStates: vi.fn(), readJobBatchMode: vi.fn(), getEvidenceStatusSummary: vi.fn(),
  downProductCount: vi.fn(), humanQueueOverview: vi.fn(), recentSecondReviewFailures: vi.fn(), pipelineThroughput: vi.fn(),
  modelHealth: vi.fn(), attentionCounts: vi.fn(), roleOverview: vi.fn(), listGitHubCollectorAccounts: vi.fn(), listGitHubCollectorApps: vi.fn(),
  takedownSummary: vi.fn(), modelServerHealth: vi.fn(), readSettingsApply: vi.fn(), getSettings: vi.fn(), pendingIntroRequestCount: vi.fn(),
}));

/** 관측 표 한 줄과 작업 로그만 흉내 낸다 — recordAttentionSample 의 잠금·다시 읽기·덮어쓰기 차례 그대로 */
vi.mock("@/lib/db", () => {
  const tx = {
    insert: () => ({ values: (value: { key: string; value: unknown; observedAt: Date }) => ({
      onConflictDoNothing: async () => { store.row ??= { ...value }; },
    }) }),
    select: () => ({ from: () => ({ where: () => ({ for: async () => (store.row ? [store.row] : []) }) }) }),
    update: () => ({ set: (patch: { value: unknown; observedAt: Date }) => ({ where: async () => { store.row = { ...store.row!, ...patch }; } }) }),
  };
  return { db: {
    transaction: async (run: (handle: typeof tx) => Promise<unknown>) => run(tx),
    insert: () => ({ values: async (row: Record<string, unknown>) => { store.audit.push(row); } }),
  } };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.currentAdmin }));
vi.mock("@/lib/operations/dr/web-gate", async (original) => ({ ...await original<object>(), webWriteAction: <T>(action: T) => action, assertWebWritable: async () => {} }));
vi.mock("@/lib/operations/admin-log", async (original) => ({ ...await original<object>(),
  adminAuditRow: async (actor: string, entry: { action: string; target: string; detail?: unknown }) => ({ actor, action: entry.action, target: entry.target, detail: entry.detail ?? {}, ok: true }) }));
vi.mock("@/lib/operations/admin", async (original) => ({ ...await original<object>(), operationsData: mocks.operationsData }));
vi.mock("@/lib/jobs/runner", async (original) => ({ ...await original<object>(), listJobStates: mocks.listJobStates }));
vi.mock("@/lib/jobs/batch-repository", async (original) => ({ ...await original<object>(), readJobBatchMode: mocks.readJobBatchMode }));
vi.mock("@/lib/domain/evidence/admin", async (original) => ({ ...await original<object>(), getEvidenceStatusSummary: mocks.getEvidenceStatusSummary }));
vi.mock("@/lib/domain/products/health", async (original) => ({ ...await original<object>(), downProductCount: mocks.downProductCount }));
vi.mock("@/lib/crawl/review-overview", async (original) => ({ ...await original<object>(), humanQueueOverview: mocks.humanQueueOverview }));
vi.mock("@/lib/crawl/second-review", async (original) => ({ ...await original<object>(), recentSecondReviewFailures: mocks.recentSecondReviewFailures }));
vi.mock("@/lib/operations/throughput", async (original) => ({ ...await original<object>(), pipelineThroughput: mocks.pipelineThroughput }));
vi.mock("@/lib/operations/dashboard", async (original) => ({ ...await original<object>(), modelHealth: mocks.modelHealth, attentionCounts: mocks.attentionCounts }));
vi.mock("@/lib/operations/roles", async (original) => ({ ...await original<object>(), roleOverview: mocks.roleOverview }));
vi.mock("@/lib/crawl/github-accounts", async (original) => ({ ...await original<object>(), listGitHubCollectorAccounts: mocks.listGitHubCollectorAccounts }));
vi.mock("@/lib/crawl/github-apps", async (original) => ({ ...await original<object>(), listGitHubCollectorApps: mocks.listGitHubCollectorApps }));
vi.mock("@/lib/domain/products/takedown", async (original) => ({ ...await original<object>(), takedownSummary: mocks.takedownSummary }));
vi.mock("@/lib/operations/model-servers", async (original) => ({ ...await original<object>(), modelServerHealth: mocks.modelServerHealth }));
vi.mock("@/lib/operations/settings-apply", async (original) => ({ ...await original<object>(), readSettingsApply: mocks.readSettingsApply }));
vi.mock("@/lib/crawl/settings", async (original) => ({ ...await original<object>(), getSettings: mocks.getSettings }));
vi.mock("@/lib/domain/products/intro-requests", async (original) => ({ ...await original<object>(), pendingIntroRequestCount: mocks.pendingIntroRequestCount }));

const { ATTENTION_HISTORY_KEY, readAttentionHistory, recordAttentionSample } = await import("@/lib/operations/attention");
const { actionCounts, buildActions, criticalActionCount, deriveStatus, rememberCriticalCount } = await import("@/app/(operator)/admin/status/attention");
const { acknowledgeAttention } = await import("@/app/(operator)/admin/status/actions");
const { logger } = await import("@/lib/observability/logger");
const { default: AdminLayout } = await import("@/app/(operator)/admin/layout");

const at = (minutes: number) => new Date(ACTION_NOW.getTime() + minutes * 60_000);
/** 뒤에서 도는 세기가 끝날 때까지 — 타이머는 진짜다(시계만 가짜) */
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}
const samples = () => readAttentionHistory(store.row?.value);

/** 운영센터가 읽는 것 — 저장 진행(throughput)은 못 읽은 채(워커 진행 판단 없이)로 둔다 */
function serveInputs() {
  const inputs = brokenActionInputs();
  mocks.operationsData.mockReset().mockResolvedValue(inputs.ops);
  mocks.listJobStates.mockResolvedValue(inputs.jobStates);
  mocks.readJobBatchMode.mockResolvedValue(inputs.jobBatch);
  mocks.getEvidenceStatusSummary.mockResolvedValue(inputs.evidenceSummary);
  mocks.downProductCount.mockResolvedValue(inputs.downCount);
  mocks.humanQueueOverview.mockResolvedValue(inputs.overview);
  mocks.recentSecondReviewFailures.mockResolvedValue(inputs.secondFailures);
  mocks.pipelineThroughput.mockRejectedValue(new Error("throughput unavailable"));
  mocks.modelHealth.mockResolvedValue(inputs.models);
  mocks.attentionCounts.mockResolvedValue(inputs.attention);
  mocks.roleOverview.mockResolvedValue(inputs.roles);
  mocks.listGitHubCollectorAccounts.mockResolvedValue(inputs.accounts);
  mocks.listGitHubCollectorApps.mockResolvedValue(inputs.apps);
  mocks.takedownSummary.mockResolvedValue(inputs.takedowns);
  mocks.modelServerHealth.mockResolvedValue(inputs.modelServers);
  mocks.readSettingsApply.mockResolvedValue(inputs.settingsApply);
  mocks.getSettings.mockResolvedValue(inputs.settings);
  mocks.pendingIntroRequestCount.mockResolvedValue(0);
  const served = { ...inputs, throughput: null };
  return buildActions(served, deriveStatus(served));
}

// 조회 실패 경고(operations.*)는 화면 대신 여기서 센다
const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
beforeAll(() => {
  // 배지의 30초·5분과 기록의 55분·25시간은 Date.now() 로 잰다 — 시계만 고정한다
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  store.row = null;
  store.audit = [];
  vi.setSystemTime(ACTION_NOW);
  warn.mockClear();
  mocks.currentAdmin.mockResolvedValue({ login: "operator" });
});

describe("24시간 변화의 기록", () => {
  it("관측 표 한 줄에 55분마다 한 번 덧붙이고, 25시간 넘은 것은 버린다", async () => {
    expect(await recordAttentionSample({ review: 10 }, at(0))).toBe(true);
    expect(store.row?.key).toBe(ATTENTION_HISTORY_KEY);
    expect(ATTENTION_HISTORY_KEY).toBe("attention:history");
    expect(await recordAttentionSample({ review: 11 }, at(54.9))).toBe(false);
    expect(await recordAttentionSample({ review: 12 }, at(55))).toBe(true);
    expect(samples().map((sample) => sample.counts.review)).toEqual([10, 12]);
    // 첫 기록은 25시간 1분 전이라 버리고, 55분 기록은 24시간 6분 전이라 남긴다
    expect(await recordAttentionSample({ review: 13 }, at(25 * 60 + 1))).toBe(true);
    expect(samples()).toEqual([
      { at: at(55).toISOString(), counts: { review: 12 } },
      { at: at(25 * 60 + 1).toISOString(), counts: { review: 13 } },
    ]);
    expect(store.row?.observedAt).toEqual(at(25 * 60 + 1));
  });

  it("25시간까지는 남긴다 — 24시간 전 기준을 잡을 수 있게", async () => {
    await recordAttentionSample({ review: 1 }, at(0));
    await recordAttentionSample({ review: 2 }, at(25 * 60));
    expect(samples().map((sample) => sample.counts.review)).toEqual([1, 2]);
  });
});

describe("확인함 · 7일 숨김", () => {
  it("쌓인 일 열쇠는 작업 로그에 attention-ack 로 7일을 남기고, 다시 보이기는 attention-unack", async () => {
    expect(await acknowledgeAttention({ key: "evidence-backlog", hide: true, count: 39_749 })).toEqual({ message: "7일 동안 숨깁니다." });
    expect(await acknowledgeAttention({ key: "evidence-backlog", hide: false, count: 39_749 })).toEqual({ message: "다시 보입니다." });
    expect(store.audit).toEqual([
      { actor: "operator", action: "attention-ack", target: "evidence-backlog", detail: { count: 39_749, days: 7 }, ok: true },
      { actor: "operator", action: "attention-unack", target: "evidence-backlog", detail: { count: 39_749 }, ok: true },
    ]);
  });

  it("쌓인 일이 아닌 열쇠와 로그인하지 않은 요청은 아무것도 남기지 않는다", async () => {
    expect(await acknowledgeAttention({ key: "down", hide: true, count: 3 })).toEqual({ error: "숨길 수 있는 항목이 아닙니다." });
    mocks.currentAdmin.mockResolvedValue(null);
    expect(await acknowledgeAttention({ key: "review", hide: true, count: 3 })).toEqual({ error: "관리자 로그인이 필요합니다." });
    expect(store.audit).toEqual([]);
  });
});

describe("메뉴 긴급 배지", () => {
  it("처음엔 배지 없이 뒤에서 세고 시간별 수를 남긴다 · 30초 들고 · 5분까지는 지난 값을 주며 다시 센다 · 그 뒤는 배지 없음", async () => {
    const items = serveInputs();
    const expected = items.filter((item) => item.tone === "critical").length;
    expect(expected).toBe(13);

    // 프로세스가 막 떴을 때 — 기다리지 않고 배지 없이
    expect(await criticalActionCount()).toBeNull();
    await until(() => samples().length === 1);
    expect(samples()).toEqual([{ at: ACTION_NOW.toISOString(), counts: actionCounts(items) }]);
    expect(await criticalActionCount()).toBe(expected);
    vi.setSystemTime(at(29_999 / 60_000));
    expect(await criticalActionCount()).toBe(expected);
    expect(mocks.operationsData).toHaveBeenCalledTimes(1);

    // 30초가 지나면 지난 값을 주고 뒤에서 다시 센다 — 같은 때 여러 번 불러도 세기는 하나
    mocks.operationsData.mockRejectedValue(new Error("db down"));
    vi.setSystemTime(at(0.5));
    expect(await Promise.all([criticalActionCount(), criticalActionCount()])).toEqual([expected, expected]);
    const failures = () => warn.mock.calls.filter(([event]) => event === "operations.critical_count_failed").length;
    await until(() => failures() === 1);
    expect(mocks.operationsData).toHaveBeenCalledTimes(2);
    vi.setSystemTime(at(5 - 1 / 60_000));
    expect(await criticalActionCount()).toBe(expected);
    await until(() => failures() === 2);

    // 5분 넘게 다시 세지 못했으면 배지를 달지 않는다
    vi.setSystemTime(at(5));
    expect(await criticalActionCount()).toBeNull();
    // 뒤에서 도는 세기를 다음 테스트로 넘기지 않는다
    await until(() => failures() === 3);
  });

  it("운영센터가 그린 수(rememberCriticalCount)를 30초 동안 그대로 쓰고, 메뉴에는 '긴급 N건'으로 단다 — 0이면 배지 없음", async () => {
    const items = serveInputs();
    expect(rememberCriticalCount(items)).toBe(13);
    const layout = await AdminLayout({ children: null }) as unknown as { props: { badges?: Record<string, unknown> } };
    expect(layout.props.badges?.["/admin/status"]).toEqual({ label: "13", tone: "critical", title: "긴급 13건" });
    expect(mocks.operationsData).not.toHaveBeenCalled();
    rememberCriticalCount(items.filter((item) => item.tone !== "critical"));
    const calm = await AdminLayout({ children: null }) as unknown as { props: { badges?: Record<string, unknown> } };
    expect(calm.props.badges?.["/admin/status"]).toBeUndefined();
  });

  it("다시 센 뒤에도 시간별 수는 55분에 한 번만 남는다", async () => {
    const items = serveInputs();
    rememberCriticalCount(items);
    vi.setSystemTime(at(1));
    await criticalActionCount();
    await until(() => samples().length === 1);
    vi.setSystemTime(at(2));
    await criticalActionCount();
    await until(() => mocks.operationsData.mock.calls.length >= 2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(samples()).toHaveLength(1);
  });
});
