import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { createReplicaRouter } from "@/lib/db/replica";
import { evidenceProgress, readWorkerProgress, withProviderBackoff } from "@/lib/operations/worker-progress-query";
import { readTextStageProgress } from '@/lib/operations/text-stage-progress';
import { readModelCapacityControlObservation } from '@/lib/llm/capacity-repository';
import { readPublisherClassificationDrain } from '@/lib/operations/publisher-drain-progress';
import type { ThroughputStage } from '@/lib/operations/throughput-model';

/**
 * 배포 관문(readWorkerProgress → check-worker-progress·역할 워커 자동 재시작·장애 전환 감시)의 근거 읽기 고정.
 * 주 DB(`db`) 대신 SQL 을 받아 적는 가짜 트랜잭션을 두고, 같은 입력에서 관문이 내는 SQL·트랜잭션 설정·보고서를 본다.
 * tests/fixtures/worker-progress-gate.json 은 근거 읽기 실행기 주입(운영센터 v8 PR3) 전 코드로 뜬 값이다.
 */
const fixture = vi.hoisted(() => {
  const NOW = new Date("2026-10-01T00:00:00.000Z");
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
  const job = (name: string, extra: Record<string, unknown> = {}) => ({ name, nextScheduledAt: at(-1), notBefore: null,
    lockedAt: null, leaseToken: null, cursor: null, lastError: null, ...extra });
  return {
    NOW, at,
    // postgres.js 는 ::int 를 수로, numeric 나눗셈을 글자로 돌려준다
    rows: [
      { key: "evidence", waiting: 7, oldest: "125.5", completed: 3, progress: 3, errors: 1, deferred: 2, provider_errors: 1, error_age: "40.25" },
      // 저장 진행이 없어 재시도 보정(retryAfter → notBefore)이 판정을 가른다 — 보정이 있으면 backoff
      { key: "agent-evidence", waiting: 4, oldest: "-0.5", completed: 0, progress: 0, errors: 0, deferred: 1, provider_errors: 0, error_age: null },
      // 지난 retryAfter 는 보정하지 않는다 — 오래 기다린 대상이 있고 진행이 없어 no_progress
      { key: "ai-level", waiting: 3, oldest: "12", completed: 0, progress: 0, errors: 0, deferred: 0, provider_errors: 0, error_age: null },
    ],
    jobs: [
      job("product-evidence-refresh"),
      job("agent-evidence-refresh", { cursor: { retryAfter: at(30).toISOString(), providerFailure: {
        repositoryKey: "acme/tool", code: "rate_limited", firstFailureAt: at(-20).toISOString(), lastFailureAt: at(-5).toISOString(), failures: 3 } } }),
      job("ai-level-refresh", { cursor: { unseenIdleUntil: at(10).toISOString(), retryAfter: at(-1).toISOString() } }),
      // 재시도 보정은 개발 AI 근거·AI 제작 단계 커서에만 — 다른 잡의 retryAfter 는 그대로
      job("crawl-fetch", { cursor: { retryAfter: at(30).toISOString() } }),
    ],
    observations: ["scheduler", "crawler", "reviewer", "publisher", "maintenance", "text"]
      .map(role => ({ key: `service:${role}:test`, value: { status: "running" }, observedAt: NOW })),
    primary: { transactions: [] as Array<{ config: unknown; statements: SQL[] }> },
    // 응답 점검 분담(0104) 장부는 근거와 따로 읽는다 — 기본은 legacy(관문에 uptime 단계 없음)
    split: { mode: "legacy" as "legacy" | "claims" },
    capacity: { mode: 'disabled' as 'disabled' | 'open' | 'draining' | null },
    throughputStages: [] as ThroughputStage[],
  };
});

type Log = Array<{ config: unknown; statements: SQL[] }>;
/** 트랜잭션마다 받은 SQL 을 적고, 모든 문장에 근거 fixture 행을 돌려준다(SET LOCAL 결과는 쓰지 않는다) */
function recordingExecutor(log: Log) {
  return {
    transaction: async (load: (tx: { execute: (query: SQL) => Promise<unknown> }) => Promise<unknown>, config?: unknown) => {
      const entry = { config, statements: [] as SQL[] };
      log.push(entry);
      return load({ execute: async (query: SQL) => { entry.statements.push(query); return fixture.rows; } });
    },
  };
}

vi.mock("@/lib/db", () => ({ db: { ...recordingExecutor(fixture.primary.transactions),
  // 관문의 관측 읽기는 미룬 이유(defer:<job>) 줄을 빼고 읽는다(운영센터 v8 PR4) — 조건만 붙고 결과는 같다
  select: () => ({ from: (table: unknown) => ({ where: async () => {
    const { pipelineStageModes } = await import('@/lib/db/schema');
    return table === pipelineStageModes ? ['ai1', 'ai2'].map(stage => ({ stage, mode: 'legacy', drainingFrom: null })) : fixture.observations;
  } }) }) } }));
vi.mock('@/lib/llm/capacity-repository', () => ({ readModelCapacityControlObservation: vi.fn(async () => {
  if (!fixture.capacity.mode) throw new Error('model_capacity_control_missing');
  return { mode: fixture.capacity.mode };
}) }));
vi.mock('@/lib/operations/publisher-drain-progress', () => ({ readPublisherClassificationDrain: vi.fn(async () => false) }));
vi.mock("@/lib/crawl/settings", async () => {
  const { DEFAULT_CRAWL_SETTINGS } = await import("@/lib/crawl/settings-schema");
  return { getSettings: async () => ({ ...DEFAULT_CRAWL_SETTINGS, agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enabled: true } }) };
});
vi.mock("@/lib/jobs/runner", () => ({ listJobStates: async () => fixture.jobs }));
vi.mock("@/lib/jobs/batch-repository", () => ({ readJobBatchMode: async () => ({ mode: "legacy", writerContractVersion: 0 }) }));
// 제작 근거 스캔 모드는 legacy — 관문 SQL·보고서가 claim 기반(E3) 전과 같아야 한다. items 쪽은 tests/integration/agent-scan-controller.test.ts
vi.mock("@/lib/domain/evidence/agents/claim-control", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/domain/evidence/agents/claim-control")>(),
  readAgentScanMode: async () => ({ mode: "legacy", drainingFrom: null }) }));
vi.mock("@/lib/operations/throughput", () => ({ pipelineThroughput: async () => ({ measuredAt: fixture.NOW.toISOString(), stages: fixture.throughputStages }) }));
// Text queues have their own DB-backed regression; this golden fixture isolates the original evidence reader.
vi.mock('@/lib/operations/text-stage-progress', () => ({ readTextStageProgress: vi.fn(async () => []) }));
vi.mock("@/lib/operations/uptime-split-repository", async () => {
  const { uptimeSplitStageInput } = await import("@/lib/operations/uptime-split");
  return { readUptimeSplitStage: async () => fixture.split.mode === "legacy" ? null : uptimeSplitStageInput({ at: fixture.NOW.toISOString(),
    control: { mode: "claims", epoch: 2, policy: null, policyHash: null }, uptimeControl: { observationsEnabled: false, gateEnabled: false },
    queue: { due: 6, dueOldestMinutes: 9, claimed: 2, submitted: 0, submittedOldestMinutes: null, confirm: 0, confirmOldestMinutes: null,
      applied5m: 40, missingRows: 0 }, breakers: [], outcomes1h: {}, applied1h: {} }) };
});

const dialect = new PgDialect();
const plain = (log: Log) => log.map(entry => ({ config: entry.config ?? null,
  statements: entry.statements.map(statement => dialect.sqlToQuery(statement)) }));
const golden = JSON.parse(readFileSync(new URL("./fixtures/worker-progress-gate.json", import.meta.url), "utf8"));
const settings = { ...DEFAULT_CRAWL_SETTINGS, agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enabled: true } };
const failure = { repositoryKey: "acme/tool", code: "rate_limited" as const, firstFailureAt: fixture.at(-20).toISOString(),
  lastFailureAt: fixture.at(-5).toISOString(), failures: 3 };
/** fixture 행을 관문이 쓰는 단계 입력으로 옮긴 값 — 수 변환·음수 나이 0·AI 단계 오류 수 없음 */
const expectedStages = [
  { key: "evidence", enabled: true, waiting: 7, oldestMinutes: 125.5, completed5m: 3, progress5m: 3, errors5m: 1,
    deferred: 2, providerErrors: 1, providerErrorMinutes: 40.25 },
  { key: "agent-evidence", enabled: true, waiting: 4, oldestMinutes: 0, completed5m: 0, progress5m: 0, errors5m: 0,
    deferred: 1, providerErrors: 0, providerErrorMinutes: null },
  { key: "ai-level", enabled: true, waiting: 3, oldestMinutes: 12, completed5m: 0, progress5m: 0, errors5m: null,
    deferred: 0, providerErrors: 0, providerErrorMinutes: null },
];

describe("배포 관문 근거 읽기", () => {
  it('propagates a failed publisher drain read instead of suppressing the monitor alarm', async () => {
    fixture.capacity.mode = 'draining';
    vi.mocked(readPublisherClassificationDrain).mockRejectedValueOnce(new Error('publisher_observation_unavailable'));
    try { await expect(readWorkerProgress(fixture.NOW)).rejects.toThrow('publisher_observation_unavailable'); }
    finally { fixture.capacity.mode = 'disabled'; }
  });
  it('reads global capacity drain on primary and holds eligible first-review demand', async () => {
    vi.mocked(readModelCapacityControlObservation).mockClear();
    fixture.capacity.mode = 'draining';
    fixture.throughputStages = [{ key: 'first', enabled: true, waiting: 220, oldestMinutes: 239,
      completed1m: 0, completed5m: 0, progress5m: 0, errors5m: 0, label: 'AI1', unit: '건',
      queueNote: '', detail: '', status: 'stalled' }];
    try {
      const report = await readWorkerProgress(fixture.NOW, { includeText: false });
      expect(readModelCapacityControlObservation).toHaveBeenCalledExactlyOnceWith();
      expect(report.stages.find(stage => stage.stage === 'first')).toMatchObject({ held: true, reason: 'backoff', alarm: false, restartEligible: false });
    } finally { fixture.capacity.mode = 'disabled'; fixture.throughputStages = []; }
  });

  it('refuses missing model-capacity control instead of granting restart authority', async () => {
    fixture.capacity.mode = null;
    try { await expect(readWorkerProgress(fixture.NOW)).rejects.toThrow('model_capacity_control_missing'); }
    finally { fixture.capacity.mode = 'disabled'; }
  });

  it.each(['model_capacity_control_invalid', 'model_capacity_policy_hash_mismatch', 'database_unavailable'])(
    'propagates validated control failure %s without reporting intentional waiting', async code => {
      const failure = new Error(code);
      vi.mocked(readModelCapacityControlObservation).mockRejectedValueOnce(failure);
      await expect(readWorkerProgress(fixture.NOW)).rejects.toBe(failure);
    },
  );

  it('lets role-local recovery skip the extra read-only text queries while the default monitor includes them', async () => {
    vi.mocked(readTextStageProgress).mockClear();
    await readWorkerProgress(fixture.NOW, { includeText: false });
    expect(readTextStageProgress).not.toHaveBeenCalled();
    await readWorkerProgress(fixture.NOW);
    expect(readTextStageProgress).toHaveBeenCalledOnce();
  });

  it("주 DB 에서 같은 SQL·같은 설정으로 읽고 같은 보고서를 낸다", async () => {
    fixture.primary.transactions.length = 0;
    const report = JSON.parse(JSON.stringify(await readWorkerProgress(fixture.NOW)));
    expect({ transactions: plain(fixture.primary.transactions), report }).toEqual(golden);
  });

  it("split claims 모드면 근거 읽기는 그대로 두고 응답 점검(maintenance) 단계만 더한다", async () => {
    fixture.primary.transactions.length = 0;
    fixture.split.mode = "claims";
    try {
      const report = JSON.parse(JSON.stringify(await readWorkerProgress(fixture.NOW)));
      expect(plain(fixture.primary.transactions)).toEqual(golden.transactions);
      expect(report.stages.slice(0, golden.report.stages.length)).toEqual(golden.report.stages);
      expect(report.stages.slice(golden.report.stages.length)).toEqual([{ role: "maintenance", stage: "uptime", reason: "progressing",
        alarm: false, restartEligible: false, manualAttention: 0, job: "uptime-ping", lane: "uptime-ping", waiting: 6, oldestMinutes: 9,
        completed5m: 40, progress5m: 40, errors5m: null, held: false }]);
    } finally { fixture.split.mode = "legacy"; }
  });

  it("주입한 실행기에도 관문과 같은 SQL·설정을 보내고, 주 DB 는 건드리지 않는다", async () => {
    fixture.primary.transactions.length = 0;
    const injected: Log = [];
    const stages = await evidenceProgress(recordingExecutor(injected) as never, settings, fixture.NOW, true, failure);
    expect(plain(injected)).toEqual(golden.transactions);
    expect(fixture.primary.transactions).toEqual([]);
    expect(stages).toEqual(expectedStages);
  });

  it("복제본 전용 읽기에 넘기면 복제본 실행기로만 읽고, 밀리면 읽지 않고 보류한다", async () => {
    const replicaLog: Log = [];
    const replica = recordingExecutor(replicaLog);
    const router = (lag: number) => createReplicaRouter({ replica: () => replica, scope: (_db, load) => load(),
      lagSeconds: async () => lag, warn: () => {} });
    fixture.primary.transactions.length = 0;
    expect(await router(0).readOnly(exec => evidenceProgress(exec as never, settings, fixture.NOW, true, failure)))
      .toEqual({ ok: true, value: expectedStages });
    expect(plain(replicaLog)).toEqual(golden.transactions);
    replicaLog.length = 0;
    expect(await router(11).readOnly(exec => evidenceProgress(exec as never, settings, fixture.NOW, true, failure)))
      .toEqual({ ok: false, reason: "lagging" });
    expect(replicaLog).toEqual([]);
    expect(fixture.primary.transactions).toEqual([]);
  });
});

describe("근거 재시도 보정(withProviderBackoff)", () => {
  const job = (name: string, notBefore: Date | null, cursor: unknown) => ({ name, notBefore, cursor });
  const later = fixture.at(30), sooner = fixture.at(10);

  it("개발 AI 근거·AI 제작 단계 커서의 미래 retryAfter 가 notBefore 보다 늦으면 notBefore 로 올린다", () => {
    const jobs = [job("agent-evidence-refresh", null, { retryAfter: later.toISOString() }),
      job("ai-level-refresh", sooner, { retryAfter: later.toISOString() })];
    expect(withProviderBackoff(jobs, fixture.NOW).map(row => row.notBefore)).toEqual([later, later]);
    // 입력은 그대로 둔다
    expect(jobs.map(row => row.notBefore)).toEqual([null, sooner]);
  });

  it("지난·더 이른·읽을 수 없는 retryAfter 와 다른 잡은 그대로 둔다", () => {
    const jobs = [
      job("agent-evidence-refresh", null, { retryAfter: fixture.at(-1).toISOString() }),
      job("agent-evidence-refresh", later, { retryAfter: sooner.toISOString() }),
      job("ai-level-refresh", null, { retryAfter: "not-a-date" }),
      job("ai-level-refresh", null, { retryAfter: later.getTime() }),
      job("ai-level-refresh", null, null),
      job("product-evidence-refresh", null, { retryAfter: later.toISOString() }),
      job("crawl-fetch", null, { retryAfter: later.toISOString() }),
    ];
    const result = withProviderBackoff(jobs, fixture.NOW);
    result.forEach((row, index) => expect(row).toBe(jobs[index]));
  });
});
