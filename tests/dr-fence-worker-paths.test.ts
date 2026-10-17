import { beforeEach, expect, it, vi } from "vitest";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";

// PR15e: PR15c 가 남긴 fence 미연결 지점 — item lease claim, runJob 의 ACK·완료 TX, lease 를 든 withJobLeaseWrite.
// 모두 fence SHARE 가 그 TX 의 첫 lock 이고(claimItemLease 는 호출자 TX 가 이미 잡은 fence 의 재확인), fenced 면 아무것도 쓰지 않는다.
// 실제 DB 의 무변경·lock 순서·40P01 변이는 tests/integration/dr-web-fence.test.ts 가 본다.
const fake = vi.hoisted(() => ({ transaction: vi.fn(), update: vi.fn(), replay: vi.fn((): unknown => undefined), batch: vi.fn(),
  calls: [] as string[], fences: [] as unknown[][] }));
vi.mock("@/lib/db", () => ({ db: { transaction: fake.transaction, update: fake.update }, onPrimary: <T>(load: () => T) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: fake.replay }));
vi.mock("@/lib/jobs/batch-repository", async original => ({ ...await original<typeof import("@/lib/jobs/batch-repository")>(),
  assertJobBatchAdmission: fake.batch, batchResultObservation: () => null }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const lineage = "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11", boot = "0a6bd6a3-6c2a-4f6e-9a39-2d6f7b0e5c21";
const activeRow = { lineage_id: lineage, writer_epoch: 1, state: "active", reason: null, fenced_db: null, promotion_id: null };
const fencedRow = { lineage_id: lineage, writer_epoch: 1, state: "fenced", reason: "operator_fence", promotion_id: null,
  fenced_db: { systemIdentifier: "7000000000000000001", databaseOid: "16384", databaseName: "nomorevibe" } };
const sqlText = (query: unknown) => JSON.stringify((query as { queryChunks?: unknown }).queryChunks ?? query);
const tableName = (table: object) => String(Reflect.get(table, Symbol.for("drizzle:Name")));

/** 한 TX 의 SQL 접근을 순서대로 적는다. fence 는 execute(dr_writer_fence … FOR SHARE), 나머지 lock 은 select…for(). */
function fakeTx(label: string, fence: unknown[], stage?: Record<string, unknown>) {
  const mark = (value: string) => fake.calls.push(`${label}:${value}`);
  /** select 는 read:<표>(lock 없음)·<mode>:<표>(행 lock), insert/update 는 <동작>:<표> 로 적는다. stage·jobs 밖의 행 lock 은 거기서 멈춘다. */
  const chain = (name: string, rows: unknown[], select: boolean) => {
    const self: Record<string, unknown> = {};
    for (const method of ["values", "set", "where", "orderBy", "onConflictDoNothing", "onConflictDoUpdate"]) self[method] = () => self;
    self.returning = async () => { mark(name); return rows; };
    self.limit = async () => { mark(`read:${name}`); return rows; };
    self.for = async (lock: string) => {
      mark(`${lock}:${name}`);
      if (name !== "pipeline_stage_modes" && name !== "jobs") throw new Error(`${name}_locked`);
      return rows;
    };
    self.then = (ok: (value: unknown[]) => unknown, bad?: (error: unknown) => unknown) => {
      mark(select ? `read:${name}` : name);
      return Promise.resolve(rows).then(ok, bad);
    };
    return self;
  };
  return {
    execute: vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes("dr_writer_fence")) { mark("fence"); return fence; }
      if (text.includes("pg_locks")) { mark("stage-context"); return [{ tx_id: "77", lock_count: 1, top_only: true }]; }
      if (text.includes("pg_try_advisory_xact_lock")) { mark("advisory"); return [{ locked: true }]; }
      mark("execute");
      return [];
    }),
    select: vi.fn(() => ({ from: (table: object) => {
      const name = tableName(table);
      return chain(name, name === "pipeline_stage_modes" ? [stage] : name === "jobs" ? [{ name: "news-refresh" }] : [], true);
    } })),
    insert: vi.fn((table: object) => chain(`insert:${tableName(table)}`, [], false)),
    update: vi.fn((table: object) => chain(`update:${tableName(table)}`,
      [{ cursor: null, requestedVersion: 1, name: "news-refresh", pendingReady: false }], false)),
  };
}
function queueTransactions() {
  let n = 0;
  fake.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(fakeTx(`tx${++n}`, fake.fences.shift() ?? [activeRow])));
  fake.update.mockImplementation(() => ({ set: (values: Record<string, unknown>) => ({ where: () => {
    fake.calls.push(values.workerSeenAt ? "heartbeat" : "failure-write");
    return { returning: async () => [{ name: "news-refresh" }], then: (ok: (value: unknown[]) => unknown) => Promise.resolve([]).then(ok) };
  } }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.calls.length = 0;
  fake.fences = [];
  fake.replay.mockReturnValue(undefined);
  fake.batch.mockResolvedValue(null);
  queueTransactions();
});

const fetchStage = { stage: "fetch", mode: "items", drainingFrom: null, writerContractVersion: 1, epoch: 1, updatedAt: new Date(), txId: "77" };
const binding = { stage: "fetch" as const, frontierId: 7, repo: "pr15e/fetch", claim: { attempts: 1, nextAttemptAt: "2026-10-17T00:10:00.000Z" } };
const owner = { instanceId: "pr15e-items", bootId: boot };

it("claimItemLease: a fenced site hands out no item lease — the fence is re-checked before the advisory and item row locks", async () => {
  const items = await import("@/lib/jobs/items/repository");
  let tx = fakeTx("c", [fencedRow], fetchStage);
  let guard = await items.lockItemStage(tx as never, "fetch");
  expect(await items.claimItemLease(tx as never, guard, binding, owner, 60_000)).toBeNull();
  expect(fake.calls).toEqual(["c:share:pipeline_stage_modes", "c:stage-context", "c:read:pipeline_stage_modes", "c:fence"]);
  expect(tx.insert).not.toHaveBeenCalled(); expect(tx.update).not.toHaveBeenCalled();
  // active: 같은 재확인 뒤 기존 advisory → item 행 lock 순서 그대로(여기서는 item 행 lock 에서 멈춘다)
  fake.calls.length = 0;
  tx = fakeTx("a", [activeRow], fetchStage);
  guard = await items.lockItemStage(tx as never, "fetch");
  await expect(items.claimItemLease(tx as never, guard, binding, owner, 60_000)).rejects.toThrow("pipeline_item_leases_locked");
  expect(fake.calls.slice(3)).toEqual(["a:fence", "a:advisory", "a:update:pipeline_item_leases"]);
  // stage 가 items 가 아니면 fence 를 보기 전에 기존대로 null(호출자 TX 의 lock 집합 불변)
  fake.calls.length = 0;
  tx = fakeTx("l", [fencedRow], { ...fetchStage, mode: "legacy" });
  guard = await items.lockItemStage(tx as never, "fetch");
  expect(await items.claimItemLease(tx as never, guard, binding, owner, 60_000)).toBeNull();
  expect(fake.calls).not.toContain("l:fence");
});

it("claimItemLease: a verified replay scope keeps its fixed profile (no fence grant), like the skipped batch admission", async () => {
  const items = await import("@/lib/jobs/items/repository");
  fake.replay.mockReturnValue({});
  const tx = fakeTx("r", [fencedRow], fetchStage);
  const guard = await items.lockItemStage(tx as never, "fetch");
  await expect(items.claimItemLease(tx as never, guard, binding, owner, 60_000)).rejects.toThrow("pipeline_item_leases_locked");
  expect(fake.calls).not.toContain("r:fence");
});

it("claimFetchItem: the fence is the claim TX's first lock; a fenced site takes no stage/domain lock and stops scanning", async () => {
  const { claimFetchItem } = await import("@/lib/crawl/repository");
  fake.fences = [[fencedRow]];
  expect(await claimFetchItem({ owner, ttlMs: 60_000 })).toBeNull();
  expect(fake.calls).toEqual(["tx1:fence"]);
  expect(fake.transaction).toHaveBeenCalledOnce();
  // active: fence 다음에야 기존 stage SHARE 가 온다(이 stage 는 legacy 라 거기서 끝난다)
  fake.calls.length = 0;
  fake.transaction.mockImplementationOnce(async (work: (tx: unknown) => Promise<unknown>) => work(fakeTx("tx2", [activeRow], { ...fetchStage, mode: "legacy" })));
  expect(await claimFetchItem({ owner, ttlMs: 60_000 })).toBeNull();
  expect(fake.calls).toEqual(["tx2:fence", "tx2:share:pipeline_stage_modes", "tx2:stage-context", "tx2:read:pipeline_stage_modes"]);
});

it("runJob: the ACK TX takes the fence first; a fence seen at ACK commits nothing (no ACK, no observation, no failure write)", async () => {
  const { runJob } = await import("@/lib/jobs/runner");
  const handler = vi.fn(async () => ({ done: true }));
  fake.fences = [[activeRow], [fencedRow]];
  expect(await runJob("news-refresh", handler)).toEqual({ status: "skipped", reason: "stopping" });
  expect(handler).toHaveBeenCalledOnce();
  expect(fake.calls).toEqual(["tx1:fence", "tx1:insert:jobs", "tx1:update:jobs", "tx2:fence"]);
  // active: fence → jobs ACK → 관측 기록(기존 순서 그대로)
  fake.calls.length = 0;
  fake.fences = [[activeRow], [activeRow]];
  queueTransactions();
  expect(await runJob("news-refresh", handler)).toMatchObject({ status: "completed", done: true });
  expect(fake.calls).toEqual(["tx1:fence", "tx1:insert:jobs", "tx1:update:jobs", "tx2:fence", "tx2:update:jobs", "tx2:insert:operations_observations"]);
});

it("runJob: a deferred result's release TX also takes the fence first and writes nothing on a fenced site", async () => {
  const { runJob } = await import("@/lib/jobs/runner");
  fake.fences = [[activeRow], [fencedRow]];
  expect(await runJob("news-refresh", async () => { throw new HttpOriginPermitError("unavailable"); }))
    .toEqual({ status: "skipped", reason: "stopping" });
  expect(fake.calls).toEqual(["tx1:fence", "tx1:insert:jobs", "tx1:update:jobs", "tx2:fence"]);
  fake.calls.length = 0;
  fake.fences = [[activeRow], [activeRow]];
  queueTransactions();
  expect(await runJob("news-refresh", async () => { throw new HttpOriginPermitError("unavailable"); }))
    .toMatchObject({ status: "deferred", reason: "http_origin_permit" });
  expect(fake.calls.slice(3, 5)).toEqual(["tx2:fence", "tx2:update:jobs"]);
});

it("runJob: a handler write refused by the fence stops the run without the failure write", async () => {
  const { runJob } = await import("@/lib/jobs/runner");
  fake.fences = [[activeRow]];
  expect(await runJob("news-refresh", async () => { throw new DrWriterFencedError("site_fenced"); }))
    .toEqual({ status: "skipped", reason: "stopping" });
  expect(fake.calls).toEqual(["tx1:fence", "tx1:insert:jobs", "tx1:update:jobs"]);
});

it("runJob: a verified replay scope's ACK keeps its fixed profile (no fence), like its claim", async () => {
  const { runJob } = await import("@/lib/jobs/runner");
  fake.replay.mockReturnValue({});
  fake.fences = [[fencedRow], [fencedRow]];
  expect(await runJob("second-review", async () => ({ done: true }))).toMatchObject({ status: "completed" });
  expect(fake.calls.filter(call => call.endsWith(":fence"))).toEqual([]);
});

it("withJobLeaseWrite: a worker write (lease) takes the fence first; lease-less calls and replay do not", async () => {
  const { withJobLeaseWrite } = await import("@/lib/jobs/control");
  const lease = { name: "news-refresh", token: "6a1f2b3c-0000-4000-8000-000000000001", requestedVersion: 1 };
  const write = vi.fn(async () => { fake.calls.push("write"); return 1; });
  fake.fences = [[fencedRow]];
  await expect(withJobLeaseWrite(lease, write)).rejects.toBeInstanceOf(DrWriterFencedError);
  expect(write).not.toHaveBeenCalled();
  expect(fake.calls).toEqual(["tx1:fence"]);
  fake.calls.length = 0;
  fake.fences = [[activeRow]];
  expect(await withJobLeaseWrite(lease, write)).toBe(1);
  expect(fake.calls).toEqual(["tx2:fence", "write", "tx2:share:jobs"]);
  fake.calls.length = 0;
  fake.fences = [[fencedRow]];
  expect(await withJobLeaseWrite(undefined, write)).toBe(1);
  expect(fake.calls).toEqual(["write"]);
  fake.calls.length = 0;
  fake.replay.mockReturnValue({});
  fake.fences = [[fencedRow]];
  expect(await withJobLeaseWrite(lease, write)).toBe(1);
  expect(fake.calls).toEqual(["write", "tx4:share:jobs"]);
});
