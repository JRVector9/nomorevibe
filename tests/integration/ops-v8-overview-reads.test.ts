import { randomUUID } from "node:crypto";
import { like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { TEST_DATABASE_URL, ensureSchema } from "./setup";

/**
 * 운영센터 개편 v8 PR5 의 새 숫자를 실제 PostgreSQL 에서 — 들어오는 곳 나눔(이번 시 신호별)과 보강 근거 판정(복제본 실행기),
 * 그리고 복제본이 없거나 복제본 안에서 던진 오류가 "보류"가 되는지. 테스트 DB 를 복제본 자리(READ_DATABASE_URL)에 넘긴다
 * (db-replica.test.ts 와 같은 fixture). 이 파일이 심은 프론티어 행(v8split-<tag>/*)만 지운다.
 */
const globalForDb = globalThis as unknown as { readDb?: unknown };
const tag = randomUUID().slice(0, 8);
const signal = { github: `v8-gh-${tag}`, other: `v8-other-${tag}`, before: `v8-before-${tag}` };
const setReplica = (url: string | undefined) => {
  if (url) process.env.READ_DATABASE_URL = url; else delete process.env.READ_DATABASE_URL;
  globalForDb.readDb = undefined;
};

const { db } = await import("@/lib/db");
const { crawlFrontier } = await import("@/lib/db/schema");
const { readEvidenceVerdicts, readSourceSplit } = await import("@/lib/operations/flow-reads");
const { replicaCache } = await import("@/lib/operations/replica-cache");
const { evidenceProgress } = await import("@/lib/operations/worker-progress-query");
const { sourceSummary } = await import("@/app/(operator)/admin/status/flow-model");

const dbNow = async () => (await db.execute<{ at: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`))[0].at;

beforeAll(async () => {
  ensureSchema();
  setReplica(TEST_DATABASE_URL);
  // 정시 직전이면 넘어갈 때까지 기다린다 — 심은 "이번 시" 행이 읽는 사이에 지난 시가 되지 않게
  const [{ left }] = await db.execute<{ left: number }>(sql`SELECT (3600 - extract(epoch FROM (clock_timestamp() AT TIME ZONE 'UTC')
    - date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC')))::float8 AS left`);
  if (left < 20) await new Promise((resolve) => setTimeout(resolve, (left + 1) * 1000));
  // 이번 시 시작(DB 시계) 그대로 — 경계 행은 들어가고(>=), 1분 전 행은 지난 시다
  await db.execute(sql`INSERT INTO crawl_frontier (repo, signal, discovered_at)
    SELECT r.repo, r.signal, date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC') + r.offset_s * interval '1 second'
    FROM (VALUES (${`v8split-${tag}/a`}, ${signal.github}, 0), (${`v8split-${tag}/b`}, ${signal.github}, 0),
      (${`v8split-${tag}/c`}, ${signal.other}, 0), (${`v8split-${tag}/d`}, 'Show HN', 0),
      (${`v8split-${tag}/e`}, ${signal.before}, -60)) AS r(repo, signal, offset_s)`);
});
afterAll(async () => {
  setReplica(undefined);
  await db.delete(crawlFrontier).where(like(crawlFrontier.repo, `v8split-${tag}/%`));
});

describe("들어오는 곳 나눔(복제본 · 이번 시 · DB 시계)", () => {
  it("이번 시 신호별 수를 DB 기준 시각과 함께 센다 — 지난 시 행은 빼고, 설정의 검색 신호만 GitHub 이다", async () => {
    const before = await dbNow();
    const read = await readSourceSplit();
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(read.value.at)).toBeGreaterThanOrEqual(Date.parse(before));
    const mine = read.value.signals.filter((row) => row.signal.endsWith(tag));
    expect(mine).toEqual([{ signal: signal.github, count: 2 }, { signal: signal.other, count: 1 }]);
    expect(read.value.signals.find((row) => row.signal === "Show HN")?.count).toBeGreaterThanOrEqual(1);
    const settings = { discover: { ...DEFAULT_CRAWL_SETTINGS.discover, queries: [{ ...DEFAULT_CRAWL_SETTINGS.discover.queries[0], label: signal.github }] } };
    const summary = sourceSummary(read, settings);
    expect(summary.counts?.github).toBe(2);
    expect(summary.counts?.showHn).toBeGreaterThanOrEqual(1);
    expect(summary.counts?.other).toBeGreaterThanOrEqual(1);
  });

  it("복제본이 없으면 보류다(주 DB 로 넘기지 않는다)", async () => {
    setReplica(undefined);
    try {
      // 다른 시(열쇠)라 캐시를 타지 않는다
      expect(await readSourceSplit(new Date(Date.now() + 3 * 3_600_000))).toEqual({ ok: false, reason: "no_replica" });
    } finally { setReplica(TEST_DATABASE_URL); }
  });
});

describe("보강 근거 판정(배포 관문과 같은 SQL, 복제본 실행기)", () => {
  const input = (days: number) => ({ settings: { ...DEFAULT_CRAWL_SETTINGS, agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, backgroundRefreshDays: days } },
    jobs: [], observations: [], batch: null, now: new Date(), fresh: false });

  it("세 단계를 DB 시각으로 판정하고, 대기 수는 같은 시각의 관문 읽기(주 DB)와 같다", async () => {
    const read = await readEvidenceVerdicts(input(1));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.stages.map((row) => row.stage)).toEqual(["evidence", "agent-evidence", "ai-level"]);
    const gate = await evidenceProgress(db, input(1).settings, new Date(read.value.at), false, null);
    expect(read.value.stages.map((row) => row.waiting)).toEqual(gate.map((row) => row.waiting));
  });

  it("복제본이 없으면 보류", async () => {
    setReplica(undefined);
    try {
      expect(await readEvidenceVerdicts(input(2))).toEqual({ ok: false, reason: "no_replica" });
    } finally { setReplica(TEST_DATABASE_URL); }
  });
});

describe("복제본 안에서 던진 오류", () => {
  it("실제 PostgreSQL 오류(없는 표)는 던지지 않고 보류(error)다", async () => {
    const read = replicaCache<{ at: string }>({ event: "test.v8_error", ttlMs: 20_000, bypass: true });
    expect(await read("missing", async (replica) => {
      await replica.execute(sql`SELECT * FROM v8_no_such_table`);
      return { at: await dbNow() };
    })).toEqual({ ok: false, reason: "error" });
  });
});
