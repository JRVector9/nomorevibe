import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";

// 미룬 이유 관측 defer:<job>(v8 PR4). 잡을 미룬 이유는 지금 로그에만 있다 — job:<name>(runner 가 덮어쓰고 검색 신선도·크롤러 활동이 읽는다)
// 과 따로 키 하나에, 잡마다 바뀔 때 또는 1분에 한 번만 쓴다. 읽기는 복제본 전용 실행기를 주입받아 이유·최근 1시간 횟수·DB 시각을 낸다.
const fake = vi.hoisted(() => ({
  calls: [] as string[],
  fenceActive: true,
  replay: vi.fn((): unknown => undefined),
  batch: vi.fn(async (): Promise<unknown> => null),
  execute: vi.fn(async (): Promise<unknown[]> => []),
}));
const sqlText = (query: unknown) => JSON.stringify((query as { queryChunks?: unknown }).queryChunks ?? query);
function chain(rows: unknown[]) {
  const self: Record<string, unknown> = {};
  for (const method of ["values", "set", "where", "onConflictDoNothing", "onConflictDoUpdate"]) self[method] = () => self;
  self.returning = async () => rows;
  self.then = (ok: (value: unknown[]) => unknown, bad?: (error: unknown) => unknown) => Promise.resolve(rows).then(ok, bad);
  return self;
}
const tx = {
  execute: vi.fn(async (query: unknown) => { fake.calls.push(sqlText(query).includes("operations_observations") ? "upsert" : "execute"); return []; }),
  insert: () => chain([]),
  update: () => chain([{ cursor: null, requestedVersion: 1, name: "crawl-fetch", pendingReady: false }]),
};
vi.mock("@/lib/db", () => ({
  db: {
    transaction: vi.fn(async (work: (value: unknown) => Promise<unknown>) => { fake.calls.push("tx"); return work(tx); }),
    update: () => chain([{ name: "crawl-fetch" }]),
    execute: fake.execute,
  },
  onPrimary: <T>(load: () => T) => load(),
}));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: fake.replay }));
vi.mock("@/lib/operations/dr/epoch", async original => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(),
  writerSiteActive: vi.fn(async () => { fake.calls.push("fence"); return fake.fenceActive; }) }));
vi.mock("@/lib/jobs/batch-repository", async original => ({ ...await original<typeof import("@/lib/jobs/batch-repository")>(),
  assertJobBatchAdmission: fake.batch, batchResultObservation: () => null }));
vi.mock("@/lib/jobs/control", async original => ({ ...await original<typeof import("@/lib/jobs/control")>(),
  assertJobLeaseAtWallTime: vi.fn(async () => {}) }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  fake.calls.length = 0;
  fake.fenceActive = true;
  fake.replay.mockReturnValue(undefined);
  fake.batch.mockReset();
  fake.batch.mockResolvedValue(null);
  fake.execute.mockReset();
  fake.execute.mockResolvedValue([]);
  tx.execute.mockClear();
});

describe("recorder: bounded writes", () => {
  async function recorder() {
    const { createJobDeferralRecorder } = await import("@/lib/jobs/deferral-observation");
    let now = 0;
    const writes: unknown[] = [];
    const write = vi.fn(async (input: unknown) => { writes.push(input); });
    const record = createJobDeferralRecorder({ write, now: () => now });
    return { record, write, writes, at: (ms: number) => { now = ms; } };
  }

  it("writes a job's first deferral at once, then at most once a minute while the reason repeats, carrying the counts", async () => {
    const r = await recorder();
    await r.record("second-review", "stage_blocked");
    for (const ms of [5_000, 30_000, 59_999]) { r.at(ms); await r.record("second-review", "stage_blocked"); }
    r.at(60_000);
    await r.record("second-review", "stage_blocked");
    expect(r.writes).toEqual([
      { key: "defer:second-review", reason: "stage_blocked", counts: { stage_blocked: 1 } },
      { key: "defer:second-review", reason: "stage_blocked", counts: { stage_blocked: 4 } },
    ]);
  });

  it("writes a changed reason at once with every count gathered since the last write", async () => {
    const r = await recorder();
    await r.record("crawl-agent-review", "model_capacity");
    r.at(2_000); await r.record("crawl-agent-review", "model_capacity");
    r.at(3_000); await r.record("crawl-agent-review", "host_pressure_cpu");
    expect(r.writes.at(-1)).toEqual({ key: "defer:crawl-agent-review", reason: "host_pressure_cpu",
      counts: { model_capacity: 1, host_pressure_cpu: 1 } });
    expect(r.write).toHaveBeenCalledTimes(2);
  });

  it("throttles each job separately", async () => {
    const r = await recorder();
    await r.record("crawl-fetch", "http_origin_permit");
    await r.record("product-site-evidence-refresh", "source_buffer");
    await r.record("crawl-fetch", "http_origin_permit");
    expect(r.writes.map(write => (write as { key: string }).key)).toEqual(["defer:crawl-fetch", "defer:product-site-evidence-refresh"]);
  });

  it("never throws: a failed write keeps its counts for the next allowed write and still counts as an attempt", async () => {
    const r = await recorder();
    r.write.mockRejectedValueOnce(Object.assign(new Error("connection lost"), { code: "57P01" }));
    await expect(r.record("crawl-publish", "batch_blocked")).resolves.toBeUndefined();
    r.at(1_000); await r.record("crawl-publish", "batch_blocked");
    expect(r.write).toHaveBeenCalledTimes(1);
    r.at(60_000); await r.record("crawl-publish", "batch_blocked");
    expect(r.writes.at(-1)).toEqual({ key: "defer:crawl-publish", reason: "batch_blocked", counts: { batch_blocked: 3 } });
  });

  it("folds a deferral that arrives while the job's write is in flight into the next write", async () => {
    const r = await recorder();
    let finish!: () => void;
    r.write.mockImplementationOnce(async input => { r.writes.push(input); await new Promise<void>(resolve => { finish = resolve; }); });
    const first = r.record("product-translate", "host_translation_busy");
    r.at(1_000); await r.record("product-translate", "model_capacity");
    finish(); await first;
    expect(r.write).toHaveBeenCalledTimes(1);
    r.at(2_000); await r.record("product-translate", "stage_blocked");
    expect(r.writes.at(-1)).toEqual({ key: "defer:product-translate", reason: "stage_blocked",
      counts: { model_capacity: 1, stage_blocked: 1 } });
  });

  it("drops names that do not fit the key column and reasons that are not plain codes", async () => {
    const r = await recorder();
    await r.record("x".repeat(80), "model_capacity");
    await r.record("crawl-fetch", "Model Capacity!");
    await r.record("crawl-fetch", "");
    expect(r.write).not.toHaveBeenCalled();
  });
});

describe("write: fence first, nothing on a fenced site or in a replay scope", () => {
  it("takes the DR writer fence before the single observation upsert", async () => {
    const { writeJobDeferral } = await import("@/lib/jobs/deferral-observation");
    await writeJobDeferral({ key: "defer:crawl-fetch", reason: "http_origin_permit", counts: { http_origin_permit: 2 } });
    expect(fake.calls).toEqual(["tx", "fence", "upsert"]);
    const query = sqlText(tx.execute.mock.calls[0][0]);
    expect(query).toContain("defer:crawl-fetch");
    expect(query).toContain(JSON.stringify(JSON.stringify({ http_origin_permit: 2 })));
    // 덮어쓰지 않고 합친다: 지난 1시간(분 단위) 묶음만 남기고 같은 분·이유는 더한다
    expect(query).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    expect(query).toContain("interval '60 minutes'");
  });

  it("writes nothing on a fenced site", async () => {
    const { writeJobDeferral } = await import("@/lib/jobs/deferral-observation");
    fake.fenceActive = false;
    await writeJobDeferral({ key: "defer:crawl-fetch", reason: "http_origin_permit", counts: { http_origin_permit: 1 } });
    expect(fake.calls).toEqual(["tx", "fence"]);
  });

  it("opens no transaction in a verified replay scope", async () => {
    const { writeJobDeferral } = await import("@/lib/jobs/deferral-observation");
    fake.replay.mockReturnValue({});
    await writeJobDeferral({ key: "defer:second-review", reason: "stage_blocked", counts: { stage_blocked: 1 } });
    expect(fake.calls).toEqual([]);
  });
});

describe("reader: replica-only, reason · last hour · DB time", () => {
  const at = "2026-10-18T08:44:16.123Z";
  const rows = [
    { key: "defer:second-review", value: { reason: "stage_blocked", at: "2026-10-18T08:44:01.000Z", counts: {
      "2026-10-18T08:44Z|stage_blocked": 12, "2026-10-18T07:45Z|stage_blocked": 30, "2026-10-18T07:45Z|model_capacity": 2,
      // 1시간 밖(07:44 는 60분째 앞) · 모양이 틀린 칸은 세지 않는다
      "2026-10-18T07:44Z|stage_blocked": 99, "garbage": 5, "2026-10-18T08:00Z|stage_blocked": -1, "2026-10-18T08:01Z|x y": 1 } } },
    { key: "defer:crawl-fetch", value: { reason: "http_origin_permit", at: "2026-10-18T06:00:00.000Z",
      counts: { "2026-10-18T06:00Z|http_origin_permit": 3 } } },
    { key: "defer:broken", value: { reason: 7, at: "2026-10-18T08:00:00.000Z", counts: {} } },
    { key: "job:second-review", value: { reason: "stage_blocked", at, counts: {} } },
  ];

  it("summarizes each job against the DB clock, newest first", async () => {
    const { summarizeJobDeferrals } = await import("@/lib/jobs/deferral-observation");
    expect(summarizeJobDeferrals(at, rows)).toEqual([
      { job: "second-review", reason: "stage_blocked", lastDeferredAt: "2026-10-18T08:44:01.000Z", lastHour: 44,
        lastHourByReason: { stage_blocked: 42, model_capacity: 2 } },
      { job: "crawl-fetch", reason: "http_origin_permit", lastDeferredAt: "2026-10-18T06:00:00.000Z", lastHour: 0, lastHourByReason: {} },
    ]);
  });

  it("reads defer:* rows with the DB clock inside the injected replica-only scope", async () => {
    const { readJobDeferrals } = await import("@/lib/jobs/deferral-observation");
    fake.execute.mockResolvedValue([{ at, rows }]);
    let scoped = 0;
    const read = await readJobDeferrals(load => { scoped++; return load(); });
    expect(scoped).toBe(1);
    expect(read).toMatchObject({ state: "ready", at, jobs: [{ job: "second-review", lastHour: 44 }, { job: "crawl-fetch", lastHour: 0 }] });
    const query = sqlText((fake.execute.mock.calls[0] as unknown[])[0]);
    expect(query).toContain("defer:%");
    expect(query).toContain("clock_timestamp()");
  });

  it("is held (보류) when the replica is unavailable or the read fails — never falls back to the primary", async () => {
    const { readJobDeferrals } = await import("@/lib/jobs/deferral-observation");
    expect(await readJobDeferrals(async () => null)).toEqual({ state: "held", reason: "replica_unavailable" });
    expect(fake.execute).not.toHaveBeenCalled();
    expect(await readJobDeferrals(async () => { throw new Error("canceling statement due to conflict with recovery"); }))
      .toEqual({ state: "held", reason: "read_failed" });
    fake.execute.mockResolvedValue([]);
    expect(await readJobDeferrals(load => load())).toEqual({ state: "held", reason: "read_failed" });
  });
});

describe("runner: reports its own deferrals without changing the result", () => {
  it("reports a deferred outcome and a typed capacity refusal with the same reason the result carries", async () => {
    const { runJob } = await import("@/lib/jobs/runner");
    const onDeferred = vi.fn(async () => {});
    expect(await runJob("second-review", async () => ({ done: false, deferred: "stage_blocked" }), { onDeferred }))
      .toMatchObject({ status: "deferred", reason: "stage_blocked" });
    expect(await runJob("crawl-agent-review", async () => { throw new ModelCapacityDeferredError("queue_full"); }, { onDeferred }))
      .toMatchObject({ status: "deferred", reason: "model_capacity" });
    expect(onDeferred.mock.calls).toEqual([["stage_blocked"], ["model_capacity"]]);
  });

  it("reports a batch-blocked claim as batch_blocked and still returns the same skipped result", async () => {
    const { runJob } = await import("@/lib/jobs/runner");
    const { JobBatchBlockedError } = await import("@/lib/jobs/batch-repository");
    const onDeferred = vi.fn(async () => {});
    const handler = vi.fn(async () => ({ done: true }));
    fake.batch.mockRejectedValue(new JobBatchBlockedError());
    expect(await runJob("crawl-publish", handler, { onDeferred })).toEqual({ status: "skipped", reason: "stopping" });
    expect(onDeferred.mock.calls).toEqual([["batch_blocked"]]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not report completed runs, and a failing reporter changes nothing", async () => {
    const { runJob } = await import("@/lib/jobs/runner");
    const onDeferred = vi.fn(async () => { throw new Error("observation write failed"); });
    expect(await runJob("crawl-fetch", async () => ({ done: true }), { onDeferred })).toMatchObject({ status: "completed", done: true });
    expect(onDeferred).not.toHaveBeenCalled();
    expect(await runJob("crawl-fetch", async () => ({ done: false, deferred: "source_buffer" }), { onDeferred }))
      .toMatchObject({ status: "deferred", reason: "source_buffer" });
    expect(onDeferred).toHaveBeenCalledOnce();
  });
});

describe("worker: reports admission deferrals made before any claim", () => {
  it("reports the host-budget reason of a lane job and of a background consumer job", async () => {
    const { runWorker } = await import("@/scripts/worker");
    const deferred = vi.fn(async () => {});
    const run = vi.fn(async () => ({ status: "completed", done: true }));
    await runWorker({ role: "text", once: true }, {
      names: ["product-translate", "crawl-tagline"], seen: async () => {}, pending: async () => ["product-translate", "crawl-tagline"], run,
      admit: async name => name === "product-translate" ? { admitted: false, reason: "host_translation_busy" }
        : { admitted: false, reason: "host_pressure_cpu" },
      consumer: { names: ["crawl-tagline"], open: async () => true, run, request: async () => {} },
      deferred,
    });
    expect(run).not.toHaveBeenCalled();
    expect(deferred.mock.calls.sort()).toEqual([["crawl-tagline", "host_pressure_cpu"], ["product-translate", "host_translation_busy"]]);
  });

  it("does not report admitted jobs, and a failing reporter is not a poll failure", async () => {
    const { runWorker } = await import("@/scripts/worker");
    const deferred = vi.fn(async () => { throw new Error("observation write failed"); });
    const log = vi.fn();
    const result = await runWorker({ role: "text", once: true }, {
      names: ["product-translate", "crawl-tagline"], seen: async () => {}, pending: async () => ["product-translate", "crawl-tagline"],
      run: async () => ({ status: "completed", done: true }),
      admit: async name => name === "product-translate" ? { admitted: false, reason: "host_translation_busy" }
        : { admitted: true, release: async () => {} },
      deferred, log,
    });
    expect(deferred.mock.calls).toEqual([["product-translate", "host_translation_busy"]]);
    expect(result.failures).toBe(0);
    expect(log.mock.calls.map(([event]) => event)).not.toContain("worker.poll_failed");
  });
});
